// Общий инструментарий агента QA-1 для живой проверки упакованного приложения
// через Chrome DevTools Protocol.
//
// Зачем он отдельный от `scripts/probe-live-renderer.mjs`. Тот скрипт отвечает
// на вопрос «жив ли рендерер» и печатает снимок состояния. Здесь нужно больше:
// настоящие клики мышью по координатам (а не `element.click()` из страницы),
// сбор ошибок консоли, снимки экрана и проверка перекрытий. Именно настоящий
// клик мышью отличает «кнопка работает» от «кнопка нарисована, но поверх неё
// лежит невидимый слой, который съедает клик».
//
// Модуль ничего не чинит: он только запускает, опрашивает и закрывает.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..");
export const executable = path.join(repoRoot, "dist", "DB Bot", "DB Bot.exe");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isPortFree(port) {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

export async function findFreePort(preferred) {
  for (let port = preferred; port < preferred + 60; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`Свободный порт не найден начиная с ${preferred}`);
}

/** Клиент одного CDP-соединения: запрос-ответ плюс подписки на события. */
export class Cdp {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id != null) {
        const entry = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (entry == null) return;
        if (message.error) entry.reject(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? null)})`));
        else entry.resolve(message.result);
        return;
      }
      for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params);
    });
  }

  static async connect(webSocketUrl, timeoutMs = 20_000) {
    const socket = new WebSocket(webSocketUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`WebSocket ${webSocketUrl} не открылся`)), timeoutMs);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`WebSocket ${webSocketUrl} отклонён`)); }, { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`CDP ${method} не ответил за 60 с`));
      }, 60_000);
    });
  }

  on(method, listener) {
    const list = this.#listeners.get(method) ?? [];
    list.push(listener);
    this.#listeners.set(method, list);
  }

  close() {
    try { this.#socket.close(); } catch { /* уже закрыт */ }
  }

  /** Вычисляет выражение в странице. Ошибки страницы становятся ошибками здесь. */
  async eval(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    });
    if (result.exceptionDetails != null) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "исключение в странице");
    }
    return result.result?.value;
  }

  /** Настоящий клик мышью в точке окна. Так находят перекрытые кнопки. */
  async clickAt(x, y) {
    const base = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, buttons: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...base, buttons: 0 });
    await sleep(40);
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await sleep(40);
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, buttons: 0 });
  }

  /** Клик по центру элемента, найденного выражением-селектором в странице. */
  async clickSelector(selector, { index = 0, timeoutMs = 8000 } = {}) {
    const box = await this.waitForBox(selector, { index, timeoutMs });
    if (box == null) throw new Error(`Элемент для клика не найден: ${selector} [${index}]`);
    await this.clickAt((box.left + box.right) / 2, (box.top + box.bottom) / 2);
    return box;
  }

  /** Ищет прямоугольник элемента и ждёт его появления. null — элемента нет. */
  async waitForBox(selector, { index = 0, timeoutMs = 8000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await this.boxOf(selector, index);
      if (last != null && last.width > 0 && last.height > 0) return last;
      await sleep(150);
    }
    return null;
  }

  boxOf(selector, index = 0) {
    return this.eval(`(() => {
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      const node = nodes[${index}];
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    })()`);
  }

  async screenshot(file) {
    const shot = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    return file;
  }

  async key(text, { code, keyCode } = {}) {
    const common = { key: text, code: code ?? text, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...common });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
  }

  async pressKeyCombo(modifier, key, { code, keyCode } = {}) {
    const common = { key: modifier, code: modifier, windowsVirtualKeyCode: modifier === "Control" ? 17 : 91, nativeVirtualKeyCode: modifier === "Control" ? 17 : 91 };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...common });
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: code ?? key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: code ?? key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
  }

  async typeText(text) {
    for (const char of text) {
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", text: char, key: char });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: char });
      await sleep(10);
    }
  }
}

export async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`CDP /json/list ответил HTTP ${response.status}`);
  return response.json();
}

/**
 * Поднимает `dist\DB Bot\DB Bot.exe` и подключается к его рендереру.
 *
 * `userDataDir` обязан быть уникальным на каждый запуск: программа перекрывает
 * `--user-data-dir` через `bootstrapDesktopUserData`, экземпляр без
 * `SAND_USER_DATA_DIR` молча живёт без окна.
 */
export async function launchLiveApp({
  userDataDir,
  preferredPort = 9461,
  readyTimeoutMs = 120_000,
  execPath = executable
} = {}) {
  const port = await findFreePort(preferredPort);
  const child = spawn(execPath, [`--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SAND_USER_DATA_DIR: userDataDir, ELECTRON_ENABLE_LOGGING: "1" }
  });
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.on("data", chunk => { stdout += chunk; });

  const deadline = Date.now() + readyTimeoutMs;
  let pages = [];
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Приложение завершилось само с кодом ${child.exitCode}. stderr: ${stderr.slice(-2000)}`);
    }
    try {
      const targets = await listTargets(port);
      pages = targets.filter(target => target.type === "page" && target.webSocketDebuggerUrl != null);
      if (pages.length > 0) break;
    } catch { /* главный процесс ещё перезапускается */ }
    await sleep(1000);
  }
  if (pages.length === 0) {
    child.kill();
    throw new Error(`CDP на порту ${port} не показал ни одной страницы за ${Math.round(readyTimeoutMs / 1000)} с`);
  }
  const page = pages.find(target => /app\.asar|renderer|index\.html/.test(target.url)) ?? pages[0];
  const client = await Cdp.connect(page.webSocketDebuggerUrl);

  const consoleErrors = [];
  const exceptions = [];
  const failedRequests = [];
  client.on("Runtime.consoleAPICalled", params => {
    if (params.type !== "error" && params.type !== "warning") return;
    consoleErrors.push({
      type: params.type,
      text: (params.args ?? []).map(arg => arg.value ?? arg.description ?? arg.unserializableValue ?? "").join(" ").slice(0, 400),
      stack: params.stackTrace?.callFrames?.[0]?.url ?? null
    });
  });
  client.on("Runtime.exceptionThrown", params => {
    exceptions.push({
      text: params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "неизвестное исключение",
      url: params.exceptionDetails?.url ?? null
    });
  });
  client.on("Log.entryAdded", params => {
    const entry = params.entry;
    if (entry.level === "error") consoleErrors.push({ type: "log.error", text: String(entry.text).slice(0, 400), stack: entry.url ?? null });
  });
  client.on("Network.loadingFailed", params => {
    failedRequests.push({ errorText: params.errorText, type: params.type });
  });

  await client.send("Runtime.enable");
  await client.send("Log.enable");
  await client.send("Page.enable");
  await client.send("Network.enable");
  await client.send("DOM.enable");

  return {
    port, pid: child.pid, child, client, page,
    pageUrl: page.url,
    consoleErrors, exceptions, failedRequests,
    get stderr() { return stderr; },
    get stdout() { return stdout; },
    /** Закрывает приложение через CloseMainWindow, а не Stop-Process. */
    async close() {
      client.close();
      if (child.exitCode !== null || child.signalCode !== null) return;
      const pid = child.pid;
      const finished = new Promise(resolve => child.once("close", () => resolve(true)));
      try {
        const { execFileSync } = await import("node:child_process");
        execFileSync("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-Command",
          `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow() }`
        ], { stdio: "ignore", timeout: 30_000 });
      } catch { /* PowerShell может быть недоступен — ждём выхода ниже */ }
      const raced = await Promise.race([finished, sleep(20_000).then(() => false)]);
      if (!raced && child.exitCode === null) {
        // CloseMainWindow не сработал (окно без главного окна, но процесс жив).
        // Это тоже результат проверки, а не повод убивать процесс насильно.
        throw new Error(`CloseMainWindow не завершил процесс ${pid}; exitCode=${child.exitCode}`);
      }
    }
  };
}

/**
 * Геометрический аудит текущего экрана.
 *
 * Зачем он вместо «посмотреть глазами на снимок». Снимок отвечает на вопрос
 * «красиво ли», а этот аудит — на вопрос «сломано ли»: что вылезает за окно,
 * что нажатием не нажать, что обрезано без многоточия, где экран пустой.
 * Каждая проверка возвращает конкретный элемент, а не число.
 */
export const AUDIT_EXPRESSION = `(() => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const visible = el => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.display === "contents") return false;
    if (Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const describe = el => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      cls: (typeof el.className === "string" ? el.className : "").slice(0, 70),
      aria: el.getAttribute("aria-label"),
      text: (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 48),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]
    };
  };
  const interactive = Array.from(document.querySelectorAll(
    "button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=menuitem], [role=tab], [role=option]"
  )).filter(visible);
  const offscreen = interactive.filter(el => {
    const r = el.getBoundingClientRect();
    return r.right > vw + 1 || r.bottom > vh + 1 || r.left < -1 || r.top < -1;
  }).map(describe);
  const blocked = interactive.filter(el => {
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    if (x < 0 || y < 0 || x >= vw || y >= vh) return false;
    const hit = document.elementFromPoint(x, y);
    if (hit == null) return false;
    if (el === hit || el.contains(hit)) return false;
    if (hit.contains(el)) return false;
    const cs = getComputedStyle(hit);
    if (cs.pointerEvents === "none") return false;
    return true;
  }).map(describe);
  const clipped = Array.from(document.querySelectorAll("button, label, span, h1, h2, h3, p, a, li, td, div"))
    .filter(el => el.childElementCount === 0 && visible(el))
    .filter(el => {
      const cs = getComputedStyle(el);
      if (cs.textOverflow === "ellipsis") return false;
      if (cs.overflow === "visible" && cs.overflowX === "visible" && cs.overflowY === "visible") return false;
      return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
    }).map(el => ({ ...describe(el), scroll: [el.scrollWidth, el.scrollHeight, el.clientWidth, el.clientHeight] }));
  let distinctHits = 0;
  const seen = new Set();
  for (let gx = 0; gx < 26; gx += 1) for (let gy = 0; gy < 19; gy += 1) {
    const el = document.elementFromPoint(Math.round((gx + 0.5) * vw / 26), Math.round((gy + 0.5) * vh / 19));
    if (el != null) seen.add(el);
  }
  distinctHits = seen.size;
  const textLength = (document.body.innerText ?? "").replace(/\\s+/g, " ").trim().length;
  return {
    viewport: [vw, vh],
    textLength,
    distinctHitElements: distinctHits,
    offscreen,
    blocked,
    clippedCount: clipped.length,
    clipped: clipped.slice(0, 12),
    dialogCount: document.querySelectorAll("[role=dialog]").length
  };
})()`;

export { sleep };

/**
 * Готовит каталог данных, в котором приложение считает пользователя вошедшим.
 *
 * Зачем. `SandCursorAuthService.getStatus` читает `sand-secrets.json` из
 * каталога данных и понимает префикс `plaintext:v1:` (миграция старого
 * формата). Достаточно положить туда поддельный JWT — состояние становится
 * `logged-in`, и открываются экраны, которые иначе закрыты экраном входа.
 *
 * Чем это НЕ является: доказательством, что программа работает с настоящей
 * учётной записью. Обращения к сети Cursor после этого честно падают, и это
 * надо отделять от дефектов интерфейса.
 */
export function writeSignedInProfile(userDataDir, { sub = "qa1-local-probe-user", email = "qa1@example.invalid" } = {}) {
  mkdirSync(userDataDir, { recursive: true });
  const jwt = payload => `${Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${"A".repeat(86)}`;
  const exp = 4_000_000_000;
  const map = {
    "cursor-access-token": `plaintext:v1:${Buffer.from(jwt({ sub, email, exp }), "utf8").toString("base64")}`,
    "cursor-refresh-token": `plaintext:v1:${Buffer.from(jwt({ sub, exp }), "utf8").toString("base64")}`
  };
  writeFileSync(path.join(userDataDir, "sand-secrets.json"), JSON.stringify(map, null, 2), "utf8");
  return userDataDir;
}