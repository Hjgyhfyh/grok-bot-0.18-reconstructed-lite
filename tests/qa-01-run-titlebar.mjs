/**
 * Разовая проверка: тема переживает перезапуск, а полоса заголовка окна,
 * которую рисует Windows, совпадает с фоном интерфейса после переключения.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  THEMES, sleep, launchApp, stopApp, freshUserDataDir,
  decodePng, samplePixel, toHex, contrastRatio, parseHex
} from "./qa-01-theme-live.mjs";
import { grabScreen } from "./qa-01-grab-screen.mjs";

const outDir = path.resolve(process.env.DDB_QA_OUT ?? "tests/qa-01-measurements/titlebar");
mkdirSync(outDir, { recursive: true });
const userDataDir = freshUserDataDir();
const report = { userDataDir, outDir, steps: [] };

const GEOM = `(async()=>({x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight}))()`;
const STATE = `(async()=>({get: await window.desktop.theme.get(), dataTheme: document.documentElement.dataset.theme, bg: getComputedStyle(document.documentElement).getPropertyValue('--sand-bg-base').trim()}))()`;

/** Ждёт, пока React смонтирован и тема действительно легла в документ. */
async function waitThemeReady(cdp, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await cdp.evaluate(STATE);
      if (value != null && typeof value.dataTheme === "string" && value.dataTheme.length > 0) return value;
    } catch { /* окно ещё не отвечает */ }
    await sleep(700);
  }
  throw new Error("Тема не легла в документ за отведённое время");
}

async function applyTheme(cdp, theme) {
  const deadline = Date.now() + 20000;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.evaluate(`(async()=>{ const s = await window.desktop.theme.set(${JSON.stringify(theme)}); return {s, t: document.documentElement.dataset.theme, bg: getComputedStyle(document.documentElement).getPropertyValue('--sand-bg-base').trim()}; })()`);
    if (last != null && last.t === theme) return last;
    await sleep(500);
  }
  throw new Error(`Тема ${theme} не применилась: документ остался на ${last?.t ?? "?"}`);
}

// Первый запуск: тема по умолчанию «Белый», затем переключаем на «Небо» без перезапуска.
let run = await launchApp(userDataDir, 9480);
const boot1 = await waitThemeReady(run.cdp);
const geom = await run.cdp.evaluate(GEOM);
report.steps.push({ step: "boot-1", geom, state: boot1 });
report.steps.push({ step: "switch-live", result: await applyTheme(run.cdp, "sky") });
await sleep(600);
report.steps.push({ step: "before-close", state: await run.cdp.evaluate(STATE) });
run.cdp.close();
await stopApp(run.child);
await sleep(2000);
report.steps.push({ step: "closed" });

// Второй запуск с тем же каталогом данных: тема обязана пережить перезапуск.
run = await launchApp(userDataDir, 9490);
const boot2 = await waitThemeReady(run.cdp);
report.steps.push({ step: "boot-2", state: boot2 });

for (const theme of THEMES) {
  const applied = await applyTheme(run.cdp, theme);
  await sleep(1200);
  const file = path.join(outDir, `screen-${theme}.png`);
  const entry = { step: `titlebar-${theme}`, ui: applied.bg, applied: applied.t, file };
  try {
    await grabScreen({ x: geom.x, y: geom.y, w: geom.w, h: 40, out: file });
    const image = decodePng(readFileSync(file));
    const midX = image.width >> 1;
    entry.size = { width: image.width, height: image.height };
    entry.rows = [];
    for (let y = 2; y < Math.min(image.height, 16); y += 3) {
      const pixel = samplePixel(image, midX - 30, y, midX + 30, y + 2);
      entry.rows.push({ y, hex: toHex(pixel), rgb: pixel });
    }
    const top = entry.rows[0].rgb;
    entry.contrastTitlebarToUi = Math.round(contrastRatio(top, parseHex(applied.bg)) * 100) / 100;
  } catch (error) {
    entry.error = error.message;
  }
  report.steps.push(entry);
}

writeFileSync(path.join(outDir, "result.json"), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
await stopApp(run.child);
process.exit(0);