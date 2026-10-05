// Обход живого интерфейса упакованной программы: настоящие клики мышью по
// координатам, клавиатура, снимки экрана и геометрический аудит на каждом экране.
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { AUDIT_EXPRESSION, launchLiveApp, repoRoot, sleep, writeSignedInProfile } from "./qa-ui1-cdp.mjs";

const SHOTS = path.join(repoRoot, ".tmp-qa-ui1-shots");
const userDataDir = path.join(repoRoot, ".tmp-qa-ui1-walk");
rmSync(userDataDir, { recursive: true, force: true });
writeSignedInProfile(userDataDir);

const app = await launchLiveApp({ userDataDir, preferredPort: 9471 });
const cdp = app.client;
mkdirSync(SHOTS, { recursive: true });

const step = async (name, action) => {
  if (action) await action();
  await sleep(1500);
  const audit = await cdp.eval(AUDIT_EXPRESSION);
  await cdp.screenshot(path.join(SHOTS, `${name}.png`));
  console.log(`\n### ${name}`);
  console.log(`текст=${audit.textLength} попаданий=${audit.distinctHitElements} диалогов=${audit.dialogCount}`);
  console.log(`за окном: ${audit.offscreen.length}`);
  for (const row of audit.offscreen.slice(0, 6)) console.log(`   ${JSON.stringify(row)}`);
  console.log(`перекрыто: ${audit.blocked.length}`);
  for (const row of audit.blocked.slice(0, 8)) console.log(`   ${JSON.stringify(row)}`);
  console.log(`обрезано без многоточия: ${audit.clippedCount}`);
  for (const row of audit.clipped.slice(0, 5)) console.log(`   ${JSON.stringify(row)}`);
  return audit;
};

const bodyText = async () => (await cdp.eval(`(document.body.innerText ?? "").replace(/\\s+/g," ").slice(0, 900)`));

await sleep(12_000);

// 1. Первый экран после входа.
await step("10-after-signin");

// 2. Первый экран без входа: закрываем профиль и открываем заново позже.
//    Пока — закрываем онбординг кнопкой «Далее», если она есть.
for (let attempt = 0; attempt < 6; attempt += 1) {
  const box = await cdp.waitForBox("button", { timeoutMs: 1000 });
  const hasNext = await cdp.eval(`(() => {
    const b = Array.from(document.querySelectorAll("button")).find(n => (n.innerText ?? "").trim() === "Далее");
    if (!b) return false;
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  })()`);
  if (!hasNext) break;
  await cdp.clickSelector("button", { index: await cdp.eval(`Array.from(document.querySelectorAll("button")).findIndex(n => (n.innerText ?? "").trim() === "Далее")`) });
  await sleep(2000);
  console.log(`\n[онбординг] нажато «Далее» ${attempt + 1}; текст: ${(await bodyText()).slice(0, 160)}`);
}
await step("11-after-onboarding");

// 3. Палитра команд Ctrl+K.
await cdp.pressKeyCombo("Control", "k", { code: "KeyK", keyCode: 75 });
await step("12-command-palette");
console.log(`текст окна: ${await bodyText()}`);

// 4. Закрываем палитру Escape.
await cdp.key("Escape", { code: "Escape", keyCode: 27 });
await sleep(800);

// 5. Настройки через Ctrl+,.
await cdp.pressKeyCombo("Control", ",", { code: "Comma", keyCode: 188 });
await step("13-settings-general");
console.log(`текст окна: ${await bodyText()}`);

for (const [index, label] of [["Провайдер"], ["Расход"], ["Обновления"]].entries()) {
  const navIndex = index[0] + 1;
  await cdp.eval(`(() => {
    const items = Array.from(document.querySelectorAll(".sand-settings-nav__item"));
    const node = items.find(n => (n.innerText ?? "").trim() === ${JSON.stringify(label[0])});
    if (node == null) return false;
    const r = node.getBoundingClientRect();
    return r.width > 0;
  })()`);
  const found = await cdp.eval(`Array.from(document.querySelectorAll(".sand-settings-nav__item")).findIndex(n => (n.innerText ?? "").trim() === ${JSON.stringify(label[0])})`);
  if (found < 0) { console.log(`\n[настройки] раздел «${label[0]}» НЕ НАЙДЕН в меню`); continue; }
  await cdp.clickSelector(".sand-settings-nav__item", { index: found });
  await step(`14-settings-${label[0]}`);
  console.log(`текст окна: ${await bodyText()}`);
  void navIndex;
}

// 6. Закрываем настройки Escape.
await cdp.key("Escape", { code: "Escape", keyCode: 27 });
await sleep(900);
console.log(`\n[после Escape] диалогов: ${await cdp.eval(`document.querySelectorAll("[role=dialog]").length`)}`);

// 7. Меню аккаунта.
await cdp.clickSelector('button[aria-label="Аккаунт"]');
await step("15-account-menu");
console.log(`текст окна: ${await bodyText()}`);

// 8. О программе из меню аккаунта.
const aboutIndex = await cdp.eval(`Array.from(document.querySelectorAll("button,[role=menuitem],a")).findIndex(n => (n.innerText ?? "").trim() === "О программе")`);
console.log(`\n[меню аккаунта] индекс «О программе» = ${aboutIndex}`);
if (aboutIndex >= 0) {
  await cdp.clickSelector("button,[role=menuitem],a", { index: aboutIndex });
  await step("16-about");
  console.log(`текст окна: ${await bodyText()}`);
  await cdp.key("Escape", { code: "Escape", keyCode: 27 });
  await sleep(800);
}

// 9. Расширения (плагины) через Ctrl+Shift+M.
await cdp.pressKeyCombo("Control", "m", { code: "KeyM", keyCode: 77, });
await sleep(200);
await step("17-plugins");
console.log(`текст окна: ${await bodyText()}`);
await cdp.key("Escape", { code: "Escape", keyCode: 27 });
await sleep(800);

// 10. Свернуть/раскрыть панель Ctrl+B.
await cdp.pressKeyCombo("Control", "b", { code: "KeyB", keyCode: 66 });
await step("18-sidebar-collapsed");
await cdp.pressKeyCombo("Control", "b", { code: "KeyB", keyCode: 66 });
await sleep(600);

// 11. Кнопка «Новый диалог».
await cdp.clickSelector('button[aria-label="Новый"]');
await sleep(2500);
await step("19-new-dialog");
console.log(`текст окна: ${await bodyText()}`);

console.log(`\n--- ошибки консоли (${app.consoleErrors.length}) ---`);
for (const e of app.consoleErrors.slice(0, 40)) console.log(`  [${e.type}] ${String(e.text).slice(0, 240)}`);
console.log(`--- исключения (${app.exceptions.length}) ---`);
for (const e of app.exceptions.slice(0, 20)) console.log(`  ${String(e.text).slice(0, 400)}`);
console.log(`--- упавшие запросы (${app.failedRequests.length}) ---`);
for (const e of app.failedRequests.slice(0, 20)) console.log(`  ${e.errorText} ${e.type}`);

await app.close();
console.log("Закрыто.");