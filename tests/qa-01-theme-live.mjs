/**
 * Общие инструменты проверки тем QA-01. Не тест сам по себе.
 *
 * Здесь три вещи, которых нет в остальном наборе тестов:
 *   1. подъём собранного `dist\DB Bot\DB Bot.exe` с отдельным каталогом данных;
 *   2. разговор с живым рендерером по CDP;
 *   3. чтение пикселей из PNG-снимка экрана и расчёт контраста по WCAG.
 *
 * Файлы живут отдельно от `tests/qa-fixtures/`: там уже завёлся другой агент,
 * и общие файлы оттуда исчезли.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(process.env.DDB_REPO ?? ".");
export const APP_EXECUTABLE = path.join(REPO_ROOT, "dist", "DB Bot", "DB Bot.exe");
export const THEMES = ["light-white", "milk", "smoke", "sky"];
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

export async function findFreePort(preferred) {
  for (let port = preferred; port < preferred + 90; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error("Свободный порт не найден");
}

async function listTargets(port, deadline, wantPage = false) {
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        if (!wantPage) return targets;
        if (targets.some((t) => t.type === "page" && t.webSocketDebuggerUrl)) return targets;
        last = new Error(`целей ${targets.length}, окна рендерера ещё нет`);
      } else last = new Error(`HTTP ${response.status}`);
    } catch (error) {
      last = error;
    }
    await sleep(500);
  }
  throw new Error(`CDP на порту ${port} не ответил: ${last?.message ?? "нет данных"}`);
}

export class Cdp {
  #socket;
  #next = 1;
  #pending = new Map();
  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const entry = this.#pending.get(message.id);
      if (entry == null) return;
      this.#pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else if (message.result?.exceptionDetails) entry.reject(new Error(JSON.stringify(message.result.exceptionDetails)));
      else entry.resolve(message.result ?? null);
    });
  }
  static async open(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`WebSocket ${url} не открылся`)), { once: true });
    });
    return new Cdp(socket);
  }
  send(method, params) {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} не ответил за 40 секунд`));
      }, 40_000);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const raw = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return raw?.result?.value ?? null;
  }
  close() { try { this.#socket.close(); } catch { /* уже закрыт */ } }
}

/** Поднимает приложение и ждёт, пока интерфейс действительно отрисуется. */
export async function launchApp(userDataDir, preferredPort) {
  const port = await findFreePort(preferredPort);
  const child = spawn(APP_EXECUTABLE, [`--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SAND_USER_DATA_DIR: userDataDir }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", () => {});
  const targets = await listTargets(port, Date.now() + 120_000, true);
  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (page == null) {
    child.kill();
    throw new Error("Целей CDP нет: ни одного окна рендерера не создано");
  }
  const cdp = await Cdp.open(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable", {});
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    try {
      const value = await cdp.evaluate("(async()=>({n: document.documentElement.outerHTML.length}))()");
      if (value != null && value.n > 0) break;
    } catch { /* окно ещё не отвечает */ }
    await sleep(1000);
  }
  return { child, cdp, port };
}

export async function stopApp(child) {
  if (child == null || child.exitCode !== null) return;
  const done = new Promise((resolve) => child.once("close", resolve));
  try { process.kill(child.pid); } catch { /* уже мёртв */ }
  const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* всё */ } }, 8000);
  await done;
  clearTimeout(timer);
}

export function freshUserDataDir() {
  return mkdtempSync(path.join(os.tmpdir(), "dbbot-qa-theme-"));
}

/**
 * Пары «фон — текст», которые надо измерить на настоящем рендере.
 * Ключ — смысл пары, значение — CSS-выражения из токенов темы.
 */
export const CONTRAST_PAIRS = [
  { id: "primary-on-base", what: "основной текст на холсте", bg: "var(--sand-bg-base)", fg: "var(--sand-text-primary)" },
  { id: "secondary-on-base", what: "второстепенный текст на холсте", bg: "var(--sand-bg-base)", fg: "var(--sand-text-secondary)" },
  { id: "tertiary-on-base", what: "третичный текст на холсте", bg: "var(--sand-bg-base)", fg: "var(--sand-text-tertiary)" },
  { id: "secondary-on-subtle", what: "второстепенный текст на боковой панели", bg: "var(--sand-bg-subtle)", fg: "var(--sand-text-secondary)" },
  { id: "primary-on-subtle", what: "основной текст на боковой панели", bg: "var(--sand-bg-subtle)", fg: "var(--sand-text-primary)" },
  { id: "primary-on-selected", what: "текст выделенной строки", bg: "var(--sand-fill-ghost-selected)", fg: "var(--sand-text-primary)" },
  { id: "secondary-on-selected", what: "второстепенный текст выделенной строки", bg: "var(--sand-fill-ghost-selected)", fg: "var(--sand-text-secondary)" },
  { id: "primary-on-elevated", what: "основной текст на карточке", bg: "var(--sand-bg-elevated)", fg: "var(--sand-text-primary)" },
  { id: "secondary-on-elevated", what: "второстепенный текст на карточке", bg: "var(--sand-bg-elevated)", fg: "var(--sand-text-secondary)" },
  { id: "primary-on-hover", what: "текст наведённой строки", bg: "var(--sand-fill-ghost-hover)", fg: "var(--sand-text-primary)" },
  { id: "accent-on-base", what: "синяя ссылка на холсте", bg: "var(--sand-bg-base)", fg: "var(--sand-text-accent)" },
  { id: "danger-on-base", what: "красный текст статуса на холсте", bg: "var(--sand-bg-base)", fg: "var(--sand-text-danger)" },
  { id: "success-on-base", what: "зелёный текст статуса на холсте", bg: "var(--sand-bg-base)", fg: "var(--sand-text-success)" },
  { id: "warning-on-base", what: "жёлтый текст статуса на холсте", bg: "var(--sand-bg-base)", fg: "var(--sand-text-warning)" },
  { id: "on-accent", what: "белый текст на синей кнопке", bg: "var(--sand-fill-accent)", fg: "var(--sand-text-on-primary)" }
];

/**
 * Разворачивает поверх интерфейса полосу из плашек: непрозрачный холст темы,
 * поверх него — фон пары, поверх фона — цвет текста пары. Браузер сам смешивает
 * полупрозрачные токены. Пиксели этой полосы и есть измерение.
 */
export const buildStrip = (pairs) => `(async () => {
  const old = document.getElementById("qa-theme-strip");
  if (old) old.remove();
  const strip = document.createElement("div");
  strip.id = "qa-theme-strip";
  strip.style.cssText = "position:fixed;inset:0;z-index:2147483647;overflow:hidden";
  const boxes = [];
  ${JSON.stringify(pairs)}.forEach((pair, index) => {
    const row = document.createElement("div");
    row.style.cssText = "height:24px;background:var(--sand-bg-base);position:relative";
    const plate = document.createElement("div");
    plate.style.cssText = "position:absolute;left:0;top:0;width:400px;height:24px;background:" + pair.bg;
    const plain = document.createElement("div");
    plain.style.cssText = "position:absolute;left:0;top:0;width:100px;height:24px";
    const chip = document.createElement("div");
    chip.style.cssText = "position:absolute;left:110px;top:0;width:100px;height:24px;background:" + pair.fg;
    plate.appendChild(plain);
    plate.appendChild(chip);
    row.appendChild(plate);
    strip.appendChild(row);
    boxes.push({ id: pair.id, top: index * 24 + 4, height: 16 });
  });
  document.body.appendChild(strip);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { boxes, viewport: { w: innerWidth, h: innerHeight } };
})()`;

export const REMOVE_STRIP = `(async () => {
  const el = document.getElementById("qa-theme-strip");
  if (el) el.remove();
  return true;
})()`;

/** Состояние документа, из которого видно, какая тема применена и что в токенах. */
export const READ_THEME = `(async () => {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const names = [
    "--sand-bg-base","--sand-bg-subtle","--sand-bg-elevated",
    "--sand-text-primary","--sand-text-secondary","--sand-text-tertiary","--sand-text-disabled","--sand-text-on-primary",
    "--sand-text-accent","--sand-text-success","--sand-text-warning","--sand-text-danger",
    "--sand-fill-ghost-selected","--sand-fill-ghost-hover","--sand-fill-accent","--sand-fill-accent-hover",
    "--sand-fill-secondary","--sand-fill-elevated","--sand-border-default",
    "--cursor-text-primary","--cursor-text-secondary","--cursor-text-tertiary","--cursor-text-accent",
    "--cursor-bg-editor","--cursor-bg-chrome"
  ];
  const tokens = {};
  for (const n of names) tokens[n] = cs.getPropertyValue(n).trim();
  const mediaDark = [];
  for (const sheet of document.styleSheets) {
    let rules = null;
    try { rules = sheet.cssRules; } catch { rules = null; }
    if (rules == null) continue;
    const scan = (list) => {
      for (const rule of list) {
        if (rule.media != null) {
          const text = rule.conditionText || rule.media.mediaText || "";
          if (/prefers-color-scheme\\s*:\\s*dark/i.test(text)) mediaDark.push(text);
        }
        if (rule.cssRules != null) scan(rule.cssRules);
      }
    };
    scan(rules);
  }
  return {
    dataTheme: root.dataset.theme,
    colorScheme: root.style.colorScheme,
    computedColorScheme: cs.colorScheme,
    tokens,
    mediaDark,
    styleSheets: document.styleSheets.length,
    darkAttributeNodes: document.querySelectorAll('[data-theme="dark"],[data-theme="midnight"],[data-color-mode="dark"],.theme-dark').length
  };
})()`;

/**
 * Распаковка PNG. Chromium отдаёт 8-битный RGB/RGBA без перемежения, поэтому
 * достаточно разобрать IHDR, склеить IDAT и снять фильтры scanline.
 */
export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("Это не PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`Бит на канал ${data[8]} не поддерживается`);
      const colour = data[9];
      if (colour === 2) channels = 3;
      else if (colour === 6) channels = 4;
      else throw new Error(`Тип цвета PNG ${colour} не поддерживается`);
      if (data[12] !== 0) throw new Error("Перемеженный PNG не поддерживается");
    } else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 3);
  let source = 0;
  let previous = Buffer.alloc(stride);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[source++];
    const line = Buffer.from(raw.subarray(source, source + stride));
    source += stride;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? line[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      if (filter === 1) line[i] = (line[i] + left) & 0xff;
      else if (filter === 2) line[i] = (line[i] + up) & 0xff;
      else if (filter === 3) line[i] = (line[i] + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const best = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        line[i] = (line[i] + best) & 0xff;
      }
    }
    for (let x = 0; x < width; x += 1) {
      pixels[(row * width + x) * 3] = line[x * channels];
      pixels[(row * width + x) * 3 + 1] = line[x * channels + 1];
      pixels[(row * width + x) * 3 + 2] = line[x * channels + 2];
    }
    previous = line;
  }
  return { width, height, pixels };
}

/** Средний цвет прямоугольника снимка. */
export function samplePixel(image, x0, y0, x1, y1) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const index = (y * image.width + x) * 3;
      r += image.pixels[index];
      g += image.pixels[index + 1];
      b += image.pixels[index + 2];
      n += 1;
    }
  }
  if (n === 0) throw new Error("Пустой прямоугольник снимка");
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

export function readStripPixels(image, boxes) {
  const out = {};
  for (const box of boxes) {
    out[box.id] = {
      bg: samplePixel(image, 20, box.top, 80, box.top + box.height),
      fg: samplePixel(image, 130, box.top, 190, box.top + box.height)
    };
  }
  return out;
}

/** Относительная яркость по WCAG 2.1. */
export function relativeLuminance([r, g, b]) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Контрастное отношение по WCAG 2.1. */
export function contrastRatio(fg, bg) {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export const toHex = ([r, g, b]) => `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;

export const parseHex = (hex) => {
  const body = hex.slice(1);
  return [parseInt(body.slice(0, 2), 16), parseInt(body.slice(2, 4), 16), parseInt(body.slice(4, 6), 16)];
};

/** Полный обмер одной темы на живом рендере: состояние, снимок, пиксели. */
export async function measureTheme(cdp, theme, outDir) {
  const applied = await cdp.evaluate(`(async()=>await window.desktop.theme.set(${JSON.stringify(theme)}))()`);
  await sleep(1200);
  const read = await cdp.evaluate(READ_THEME);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(outDir, `${theme}.png`), Buffer.from(shot.data, "base64"));
  const strip = await cdp.evaluate(buildStrip(CONTRAST_PAIRS));
  await sleep(250);
  const stripShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(outDir, `${theme}-strip.png`), Buffer.from(stripShot.data, "base64"));
  await cdp.evaluate(REMOVE_STRIP);
  const pixels = readStripPixels(decodePng(Buffer.from(stripShot.data, "base64")), strip.boxes);
  const ratios = {};
  for (const pair of CONTRAST_PAIRS) {
    ratios[pair.id] = Math.round(contrastRatio(pixels[pair.id].fg, pixels[pair.id].bg) * 100) / 100;
  }
  return { applied, read, pixels, ratios };
}

export { readFileSync, mkdtempSync, writeFileSync, os, path, fileURLToPath };