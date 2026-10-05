// Обход №3: пропускает онбординг через флаг `hasSeenOnboarding` и обходит
// экраны, которые иначе недостижимы из-за экрана настройки.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { AUDIT_EXPRESSION, launchLiveApp, repoRoot, sleep, writeSignedInProfile } from "./qa-ui1-cdp.mjs";

const SHOTS = path.join(repoRoot, ".tmp-qa-ui1-shots");
const userDataDir = path.join(repoRoot, ".tmp-qa-ui1-walk3");
rmSync(userDataDir, { recursive: true, force: true });
writeSignedInProfile(userDataDir);
mkdirSync(path.join(userDataDir, "sand-data"), { recursive: true });
writeFileSync(path.join(userDataDir, "sand-data", "settings.json"), JSON.stringify({
  version: 1,
  mcpBoxServers: [],
  autoUpdateWhenIdleOptIn: false,
  egressTunnelEnabled: false,
  webauthnProxyEnabled: true,
  mcpCustomInstructions: {},
  mcpCustomInstructionsByServerId: {},
  mcpDisabledToolsByServerId: {},
  conciergeConsent: "unset",
  settingsMigrations: ["downgrade-persisted-max-fast", "local-inference-provider", "deepseek-only"],
  hasSeenOnboarding: true
}, null, 2), "utf8");

const app = await launchLiveApp({ userDataDir, preferredPort: 9475 });
const cdp = app.client;
mkdirSync(SHOTS, { recursive: true });

const step = async name => {
  await sleep(1200);
  const audit = await cdp.eval(AUDIT_EXPRESSION);
  await cdp.screenshot(path.join(SHOTS, `${name}.png`));
  console.log(`\n### ${name}`);
  console.log(`текст=${audit.textLength} попаданий=${audit.distinctHitElements} диалогов=${audit.dialogCount} заокном=${audit.offscreen.length} перекрыто=${audit.blocked.length} обрезано=${audit.clippedCount}`);
  for (const row of audit.offscreen.slice(0, 5)) console.log(`   ЗА ОКНОМ ${JSON.stringify(row)}`);
  for (const row of audit.blocked.slice(0, 6)) console.log(`   ПЕРЕКРЫТО ${JSON.stringify(row)}`);
  for (const row of audit.clipped.slice(0, 4)) console.log(`   ОБРЕЗАНО ${JSON.stringify(row)}`);
  console.log(`   ТЕКСТ ${(await cdp.eval(`(document.body.innerText ?? "").replace(/\\s+/g," ").slice(0, 600)`))}`);
  return audit;
};

const findIndex = async (selector, predicate) => cdp.eval(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).findIndex(n => (${predicate}))`);
const clickByIndex = async (selector, index) => cdp.clickSelector(selector, { index });

await sleep(14_000);
await step("30-shell");

// Палитра команд.
await cdp.pressKeyCombo("Control", "k", { code: "KeyK", keyCode: 75 });
await step("31-command-palette");
const paletteEntries = await cdp.eval(`Array.from(document.querySelectorAll(".sand-command-palette [role=option], .sand-command-palette button")).map(n => (n.innerText ?? "").trim().replace(/\\s+/g," ").slice(0,50))`);
console.log(`\n[палитра] пункты: ${JSON.stringify(paletteEntries)}`);

// Печатаем запрос в палитре.
const paletteBox = await cdp.boxOf(".sand-command-palette input, .sand-command-palette textarea");
if (paletteBox) {
  await cdp.clickAt((paletteBox.left + paletteBox.right) / 2, (paletteBox.top + paletteBox.bottom) / 2);
  await cdp.typeText("Настройки");
  await step("32-command-palette-query");
  const filtered = await cdp.eval(`Array.from(document.querySelectorAll(".sand-command-palette [role=option]")).map(n => (n.innerText ?? "").trim().replace(/\\s+/g," ").slice(0,60))`);
  console.log(`\n[палитра «Настройки»] ${JSON.stringify(filtered)}`);
  await cdp.pressKeyCombo("Control", "a", { code: "KeyA", keyCode: 65 });
  await cdp.key("Backspace", { code: "Backspace", keyCode: 8 });
  await sleep(500);
}
await cdp.key("Escape", { code: "Escape", keyCode: 27 });
await sleep(900);
console.log(`\n[после Escape] диалогов: ${await cdp.eval(`document.querySelectorAll("[role=dialog]").length`)}`);

// Настройки Ctrl+, и все четыре раздела.
await cdp.pressKeyCombo("Control", ",", { code: "Comma", keyCode: 188 });
await step("33-settings-general");
const navItems = await cdp.eval(`Array.from(document.querySelectorAll(".sand-settings-nav__item")).map(n => ({ t: (n.innerText ?? "").trim(), cur: n.getAttribute("aria-current") }))`);
console.log(`\n[настройки] разделы: ${JSON.stringify(navItems)}`);

for (const label of ["Провайдер", "Расход", "Обновления"]) {
  const index = await findIndex(".sand-settings-nav__item", `(n.innerText ?? "").trim() === ${JSON.stringify(label)}`);
  console.log(`\n[настройки] «${label}» индекс=${index}`);
  if (index < 0) continue;
  await clickByIndex(".sand-settings-nav__item", index);
  await step(`34-settings-${label}`);
  const controls = await cdp.eval(`Array.from(document.querySelectorAll(".sand-settings-panel input, .sand-settings-panel button, .sand-settings-panel select, .sand-settings-panel a")).map(n => ({ tag: n.tagName.toLowerCase(), t: (n.innerText ?? n.value ?? "").trim().slice(0,40), type: n.getAttribute("type"), dis: n.disabled === true }))`);
  console.log(`[настройки «${label}»] элементы: ${JSON.stringify(controls)}`);
}

// Переключение между разделами по стрелкам/Enter — проверяем клавиатуру.
await cdp.key("Escape", { code: "Escape", keyCode: 27 });
await sleep(900);
console.log(`\n[после Escape] диалогов: ${await cdp.eval(`document.querySelectorAll("[role=dialog]").length`)}`);

// Меню аккаунта.
await cdp.clickSelector('button[aria-label="Аккаунт"]');
await step("35-account-menu");
const menuItems = await cdp.eval(`Array.from(document.querySelectorAll("button,[role=menuitem],a")).map(n => ({ t: (n.innerText ?? "").trim().replace(/\\s+/g," ").slice(0,40), c: (typeof n.className === "string" ? n.className : "").slice(0,40) })).filter(x => x.t.length > 0)`);
console.log(`\n[меню аккаунта] ${JSON.stringify(menuItems)}`);

const aboutIndex = await findIndex("button,[role=menuitem],a", `(n.innerText ?? "").trim() === "О программе"`);
console.log(`[меню аккаунта] «О программе» индекс=${aboutIndex}`);
if (aboutIndex >= 0) {
  await clickByIndex("button,[role=menuitem],a", aboutIndex);
  await step("36-about");
  await cdp.key("Escape", { code: "Escape", keyCode: 27 });
  await sleep(900);
  console.log(`[после Escape] диалогов: ${await cdp.eval(`document.querySelectorAll("[role=dialog]").length`)}`);
}

// Расширения.
await cdp.clickSelector('button[aria-label="Расширения"], .sand-agents-sidebar__plugins', { timeoutMs: 4000 }).catch(async () => {
  const idx = await findIndex("button", `(n.innerText ?? "").trim() === "Расширения"`);
  if (idx >= 0) await clickByIndex("button", idx);
});
await step("37-plugins");
await cdp.key("Escape", { code: "Escape", keyCode: 27 });
await sleep(900);

// Свернуть панель Ctrl+B.
await cdp.pressKeyCombo("Control", "b", { code: "KeyB", keyCode: 66 });
await step("38-sidebar-collapsed");
await cdp.pressKeyCombo("Control", "b", { code: "KeyB", keyCode: 66 });
await sleep(800);

// Поиск Ctrl+Shift+F.
await cdp.pressKeyCombo("Control", "f", { code: "KeyF", keyCode: 70 });
await step("39-search");
await cdp.key("Escape", { code: "Escape", keyCode: 27 });
await sleep(800);

console.log(`\n--- ошибки консоли (${app.consoleErrors.length}) ---`);
for (const e of app.consoleErrors.slice(0, 40)) console.log(`  [${e.type}] ${String(e.text).slice(0, 240)}`);
console.log(`--- исключения (${app.exceptions.length}) ---`);
for (const e of app.exceptions.slice(0, 20)) console.log(`  ${String(e.text).slice(0, 400)}`);
console.log(`--- упавшие запросы (${app.failedRequests.length}) ---`);
for (const e of app.failedRequests.slice(0, 20)) console.log(`  ${e.errorText} ${e.type}`);

await app.close();
console.log("\nЗакрыто.");