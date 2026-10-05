// Доказательство сети: поднимает собранное приложение, подключается к живому
// рендереру через CDP, записывает все ответы Network и открывает в нём тестовый
// PDF тем же путём, каким это делает просмотрщик.
//
// Скрипт ничего не закрывает: PID печатается в конце, закрывать надо через
// `(Get-Process -Id <pid>).CloseMainWindow()`.
//
// Запуск: node scripts/probe-renderer-network.mjs [--port=9431]
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

import { repoRoot } from "./lib/config.mjs";

const executable = path.join(repoRoot, "dist", "DB Bot", "DB Bot.exe");
const userDataDir = path.join(repoRoot, ".tmp-probe-userdata");
const pdfPath = path.join(repoRoot, "tests", "fixtures", "probe-preview.pdf");

const argument = (name, fallback) => {
  const found = process.argv.find(value => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isPortFree(port) {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

async function findFreePort(preferred) {
  for (let port = preferred; port < preferred + 50; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`Свободный порт не найден начиная с ${preferred}`);
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function waitForPage(port, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets(port);
      const pages = targets.filter(target => target.type === "page" && target.webSocketDebuggerUrl != null);
      if (pages.length > 0) return pages;
    } catch {
      // главный процесс ещё перезапускается: ждём следующую попытку
    }
    await sleep(1000);
  }
  throw new Error(`CDP на порту ${port} не показал ни одной страницы`);
}

class CdpClient {
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
        if (message.error) entry?.reject(new Error(message.error.message));
        else entry?.resolve(message.result);
        return;
      }
      for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params);
    });
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`CDP ${method} не ответил`));
      }, 120_000);
    });
  }

  on(method, listener) {
    const list = this.#listeners.get(method) ?? [];
    list.push(listener);
    this.#listeners.set(method, list);
  }

  close() {
    this.#socket.close();
  }
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails != null) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

const port = await findFreePort(Number(argument("port", "9431")));
console.log(`Порт отладки: ${port}`);

const child = spawn(executable, [`--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, SAND_USER_DATA_DIR: userDataDir, ELECTRON_ENABLE_LOGGING: "1" },
});

let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", () => {});
child.stderr.on("data", chunk => { stderr += chunk; });

const pages = await waitForPage(port, 120_000);
const page = pages.find(target => /app\.asar|renderer/.test(target.url)) ?? pages[0];
console.log(`Цель: ${page.url}`);

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
const client = new CdpClient(socket);

const responses = [];
const failures = [];
const requestUrls = new Map();
client.on("Network.requestWillBeSent", params => { requestUrls.set(params.requestId, params.request.url); });
client.on("Network.responseReceived", params => {
  responses.push({ status: params.response.status, url: params.response.url });
});
client.on("Network.loadingFailed", params => {
  failures.push({ url: requestUrls.get(params.requestId) ?? "(неизвестно)", errorText: params.errorText, type: params.type });
});
await client.send("Network.enable");
await client.send("Runtime.enable");
await client.send("Page.enable");

// Журнал включается до перезагрузки страницы: иначе видны только запросы,
// сделанные после подключения, а стартовые потеряны.
const reloaded = new Promise(resolve => {
  client.on("Page.loadEventFired", () => resolve());
});
await client.send("Page.reload", { ignoreCache: false });
await reloaded;
await sleep(6000);

console.log("\nСеть при старте рендерера:");

const pdfExpression = `(async () => {
  const scripts = Array.from(document.querySelectorAll("script[src]")).map(node => node.src);
  const base = scripts[scripts.length - 1];
  const worker = new URL("pdf.worker.min-qwK7q_zL.mjs", base).href;
  const runtimeUrl = new URL("pdf-WLgSwHwh.js", base).href;
  const workerStatus = (await fetch(worker)).status;
  const moduleStatus = (await fetch(runtimeUrl)).status;
  const pdfjs = await import(runtimeUrl);
  // Ровно то, что делает loadShippedPdfRuntime перед getDocument.
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const bytes = new Uint8Array(await (await fetch(${JSON.stringify(pdfPath.replace(/\\/g, "\\\\"))})).arrayBuffer());
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, disableAutoFetch: true }).promise;
  const page1 = await doc.getPage(1);
  const viewport = page1.getViewport({ scale: 1 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page1.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
  const painted = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data.some(value => value !== 0);
  const pageText = await (await doc.getPage(1)).getTextContent();
  return {
    base,
    workerStatus,
    moduleStatus,
    numPages: doc.numPages,
    canvas: canvas.width + "x" + canvas.height,
    painted,
    textLayer: typeof pdfjs.TextLayer,
    pageText: pageText.items.map(item => item.str).join(" ").slice(0, 80),
    version: pdfjs.version
  };
})()`;

let pdf;
try {
  pdf = await evaluate(client, pdfExpression);
} catch (error) {
  pdf = { error: String(error?.message ?? error) };
}
console.log("\nПроверка PDF:");
console.log(JSON.stringify(pdf, null, 2));

const emojiExpression = `(async () => {
  const base = ${JSON.stringify(pdf?.base ?? "")};
  const names = ["compact-C8-lyxgK.js", "messages-ByIkiGdI.js", "iamcal-CEyh6ide.js", "emojibase-Bc-csq5x.js", "katex-DHMw6HUq.js"];
  const out = {};
  for (const name of names) {
    const url = new URL(name, base).href;
    const status = (await fetch(url)).status;
    const module = await import(url);
    const value = module.default;
    out[name] = {
      status,
      shape: Array.isArray(value) ? "array:" + value.length : Object.keys(value ?? {}).slice(0, 6).join(","),
      exports: Object.keys(module)
    };
  }
  out["katex.renderToString"] = (await import(new URL("katex-DHMw6HUq.js", base).href)).renderToString("a^2+b^2", { displayMode: false }).slice(0, 40);
  return out;
})()`;

let emoji;
try {
  emoji = await evaluate(client, emojiExpression);
} catch (error) {
  emoji = { error: String(error?.message ?? error) };
}
console.log("\nПроверка наборов эмодзи и формул:");
console.log(JSON.stringify(emoji, null, 2));

await sleep(2500);
const startup = responses.filter(row => !/probe-preview\.pdf|pdf-WLgSwHwh|pdf\.worker|katex-DHMw6HUq|compact-|messages-|iamcal-|emojibase-/.test(row.url));
const table = [...startup].sort((left, right) => left.url.localeCompare(right.url));
console.log(`\nСеть при старте: ${table.length} ответов`);
for (const row of table) console.log(`  ${String(row.status).padStart(3)}  ${row.url}`);
console.log(`\nСеть после загрузки ассетов по требованию:`);
for (const row of responses.filter(row => !startup.includes(row) && !/probe-preview\.pdf/.test(row.url))) {
  console.log(`  ${String(row.status).padStart(3)}  ${row.url}`);
}
console.log(`\nСеть после открытия PDF:`);
for (const row of responses.filter(row => /probe-preview\.pdf/.test(row.url))) {
  console.log(`  ${String(row.status).padStart(3)}  ${row.url}`);
}
console.log(`\nНезагруженных запросов (Network.loadingFailed): ${failures.length}`);
for (const row of failures) console.log(`  ${row.errorText} ${row.type} ${row.url}`);

const bad = responses.filter(row => row.status >= 400);
console.log(`\nОтветов 4xx/5xx: ${bad.length}`);
for (const row of bad) console.log(`  ${row.status} ${row.url}`);

client.close();
console.log(`\nPROBE_PID=${child.pid}`);
if (stderr.trim()) console.log(`--- stderr (хвост) ---\n${stderr.trim().slice(-2000)}`);
child.unref();
process.exit(0);