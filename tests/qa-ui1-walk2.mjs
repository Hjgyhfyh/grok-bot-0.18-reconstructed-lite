// Обход №2: доходит до конца онбординга и только потом обходит экраны.
// Первый обход показал, что окно онбординга закрывает весь интерфейс —
// пока его не завершить, ни Ctrl+K, ни «Настройки», ни «Расширения» не сработают.
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { AUDIT_EXPRESSION, launchLiveApp, repoRoot, sleep, writeSignedInProfile } from "./qa-ui1-cdp.mjs";

const SHOTS = path.join(repoRoot, ".tmp-qa-ui1-shots");
const userDataDir = path.join(repoRoot, ".tmp-qa-ui1-walk2");
rmSync(userDataDir, { recursive: true, force: true });
writeSignedInProfile(userDataDir);

const app = await launchLiveApp({ userDataDir, preferredPort: 9473 });
const cdp = app.client;
mkdirSync(SHOTS, { recursive: true });

const step = async (name, { log = true } = {}) => {
  await sleep(1200);
  const audit = await cdp.eval(AUDIT_EXPRESSION);
  await cdp.screenshot(path.join(SHOTS, `${name}.png`));
  console.log(`\n### ${name}`);
  console.log(`текст=${audit.textLength} попаданий=${audit.distinctHitElements} диалогов=${audit.dialogCount} заокном=${audit.offscreen.length} перекрыто=${audit.blocked.length} обрезано=${audit.clippedCount}`);
  for (const row of audit.offscreen.slice(0, 4)) console.log(`   ЗА ОКНОМ ${JSON.stringify(row)}`);
  for (const row of audit.blocked.slice(0, 5)) console.log(`   ПЕРЕКРЫТО ${JSON.stringify(row)}`);
  if (log) console.log(`   ТЕКСТ ${(await cdp.eval(`(document.body.innerText ?? "").replace(/\\s+/g," ").slice(0, 700)`))}`);
  return audit;
};

const clickButtonWithText = async (text) => {
  const index = await cdp.eval(`Array.from(document.querySelectorAll("button")).findIndex(n => (n.innerText ?? "").trim() === ${JSON.stringify(text)})`);
  if (index < 0) return false;
  await cdp.clickSelector("button", { index });
  await sleep(1800);
  return true;
};

await sleep(12_000);

// Онбординг: «Далее», пока не появится форма создания.
for (let attempt = 0; attempt < 8; attempt += 1) {
  const done = await cdp.eval(`(() => {
    const t = document.body.innerText ?? "";
    return t.includes("Создайте первого помощника");
  })()`);
  if (done) break;
  if (!await clickButtonWithText("Далее")) { console.log("[онбординг] кнопки «Далее» нет"); break; }
  console.log(`[онбординг] «Далее» ${attempt + 1}`);
}
await step("20-onboarding-create");

// Имя и «Начать».
const inputs = await cdp.eval(`Array.from(document.querySelectorAll("input,textarea")).map(n => ({ cls: (n.className||"").slice(0,50), aria: n.getAttribute("aria-label"), ph: n.getAttribute("placeholder"), value: n.value }))`);
console.log(`\n[поля онбординга] ${JSON.stringify(inputs)}`);

const nameIndex = await cdp.eval(`Array.from(document.querySelectorAll("input,textarea")).findIndex(n => (n.getAttribute("aria-label") ?? "").includes("мя") || (n.getAttribute("placeholder") ?? "") !== "")`);
if (nameIndex >= 0) {
  const box = await cdp.boxOf("input,textarea", nameIndex);
  if (box) {
    await cdp.clickAt((box.left + box.right) / 2, (box.top + box.bottom) / 2);
    await cdp.typeText("Проверка QA-1");
  }
}
await clickButtonWithText("Начать");
await sleep(4000);
await step("21-after-start");
console.log(`\n[после «Начать»] ошибки консоли: ${app.consoleErrors.length}`);
for (const e of app.consoleErrors.slice(0, 10)) console.log(`   [${e.type}] ${String(e.text).slice(0, 200)}`);

// Палитра команд.
await cdp.pressKeyCombo("Control", "k", { code: "KeyK", keyCode: 75 });
await step("22-command-palette");

await cdp.key("Escape", { code: "Escape", keyCode: 27 });
await sleep(700);

// Настройки.
await cdp.pressKeyCombo("Control", ",", { code: "Comma", keyCode: 188 });
await step("23-settings");

for (const label of ["Провайдер", "Расход", "Обновления", "Общие"]) {
  const index = await cdp.eval(`Array.from(document.querySelectorAll(".sand-settings-nav__item")).findIndex(n => (n.innerText ?? "").trim() === ${JSON.stringify(label)})`);
  console.log(`\n[настройки] «${label}» индекс=${index}`);
  if (index < 0) continue;
  await cdp.clickSelector(".sand-settings-nav__item", { index });
  await step(`24-settings-${label}`);
}

await cdp.key("Escape", { code: "Escape", keyCode: 27 });
await sleep(900);

// Меню аккаунта и «О программе».
await cdp.clickSelector('button[aria-label="Аккаунт"]');
await sleep(1200);
await step("25-account-menu");
const accountItems = await cdp.eval(`Array.from(document.querySelectorAll("button,[role=menuitem],a")).map(n => ({ t: (n.innerText ?? "").trim().slice(0,40), c: (typeof n.className === "string" ? n.className : "").slice(0,40) })).filter(x => x.t.length > 0)`);
console.log(`\n[меню аккаунта] ${JSON.stringify(accountItems)}`);
const aboutIndex = await cdp.eval(`Array.from(document.querySelectorAll("button,[role=menuitem],a")).findIndex(n => (n.innerText ?? "").trim() === "О программе")`);
if (aboutIndex >= 0) {
  await cdp.clickSelector("button,[role=menuitem],a", { index: aboutIndex });
  await step("26-about");
  await cdp.key("Escape", { code: "Escape", keyCode: 27 });
  await sleep(900);
}

await app.close();
console.log("\nЗакрыто.");