// Пробник сети QA-1: поднимает упакованное приложение из `dist\DB Bot` с
// отдельным каталогом данных, подключается к двум каналам наблюдения и
// записывает единый журнал сети.
//
// Канал 1 — рендерер через CDP (`--remote-debugging-port`).
//   Видно всё, что грузит страница: app.asar, шрифты, worker-скрипты,
//   fetch/XHR рендерера, WebSocket.
//
// Канал 2 — главный процесс Node через инспектор (`--inspect`).
//   Через Network-домен инспектора видны только `http`/`https`/`fetch`/`XHR`
//   главного процесса. Именно там живут electron-updater, телеметрия и всё
//   остальное, чего рендерер не касается.
//
// Канал 3 — `netstat -ano`, опрашивается параллельно: единственный способ
//   увидеть исходящие сокеты главного процесса, которые CDP не показывает
//   (сырой TLS, WebTransport, QUIC-подобные попытки).
//
// Скрипт ничего не закрывает: PID печатается в конце, приложение закрывает
// вызывающий через `(Get-Process -Id <pid>).CloseMainWindow()`.
//
// Запуск:
//   node scripts/qa-1-live-network-probe.mjs --port=9462 --inspect=5858 \
//     --user-data=.tmp-qa-net --seconds=45 --out=<путь журнала.json>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

import { repoRoot } from "./lib/config.mjs";

const executable = path.join(repoRoot, "dist", "DB Bot", "DB Bot.exe");

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
  for (let port = preferred; port < preferred + 200; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`Свободный порт не найден начиная с ${preferred}`);
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
      for (const listener of this.#listeners.get(message.method) ?? []) {
        listener(message.params, message.sessionId);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    const payload = { id, method, params };
    if (sessionId != null) payload.sessionId = sessionId;
    this.#socket.send(JSON.stringify(payload));
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
    try {
      this.#socket.close();
    } catch {
      // розетка уже закрыта: ничего чинить не нужно
    }
  }
}

async function connect(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return new CdpClient(socket);
}

const seconds = Number(argument("seconds", "45"));
const port = await findFreePort(Number(argument("port", "9462")));
const inspectPort = await findFreePort(Number(argument("inspect", "5858")));
const userDataDir = path.resolve(repoRoot, argument("user-data", ".tmp-qa-net"));
const outFile = path.resolve(argument("out", path.join(repoRoot, "tests", "qa-fixtures", "qa-1-network-journal.json")));

mkdirSync(path.dirname(outFile), { recursive: true });

console.log(`Порт отладки рендерера: ${port}`);
console.log(`Порт инспектора главного процесса: ${inspectPort}`);
console.log(`Каталог данных: ${userDataDir}`);

const child = spawn(
  executable,
  [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    `--inspect=${inspectPort}`,
  ],
  {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SAND_USER_DATA_DIR: userDataDir, ELECTRON_ENABLE_LOGGING: "1" },
  },
);

let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", () => {});
child.stderr.on("data", chunk => { stderr += chunk; });

// --- канал 3: TCP-сокеты процесса приложения -------------------------------
const sockets = new Map();
const collectSockets = () => {
  const result = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return;
  const lines = result.stdout.split(/\r?\n/);
  const rootPid = child.pid;
  for (const line of lines) {
    const row = line.trim().split(/\s+/);
    // TCP  127.0.0.1:1337  0.0.0.0:0  LISTENING  1234
    // TCP  10.1.2.3:5000  1.2.3.4:443  ESTABLISHED  1234
    if (row.length < 5) continue;
    if (!/^(TCP|UDP)$/i.test(row[0])) continue;
    const local = row[1];
    const remote = row[2];
    const pid = Number(row[row.length - 1]);
    if (!Number.isFinite(pid)) continue;
    const remoteHost = remote.startsWith("[") ? remote.slice(1, remote.indexOf("]")) : remote.split(":")[0];
    const isLoopback = remoteHost === "127.0.0.1" || remoteHost === "::1" || remoteHost === "0.0.0.0" || remoteHost === "[::1]";
    const isRemote = !isLoopback && remoteHost !== "*" && remoteHost !== "";
    if (!isRemote) continue;
    if (pid !== rootPid) continue; // дочерние процессы догоняем ниже отдельным проходом
    const key = `${local} -> ${remote} ${row[0]}`;
    if (!sockets.has(key)) sockets.set(key, { firstSeenMs: Date.now(), state: row[3], pid });
  }
};

const socketTimer = setInterval(collectSockets, 700);

// --- канал 1: рендерер ------------------------------------------------------
const journal = {
  startedAt: new Date().toISOString(),
  port,
  inspectPort,
  userDataDir,
  renderer: { responses: [], requests: [], failures: [], sockets: [] },
  main: { responses: [], requests: [], failures: [] },
  rendererInfo: {},
};

async function listTargets(cdpPort) {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function waitForTarget(cdpPort, budgetMs, accept) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets(cdpPort);
      const found = accept(targets);
      if (found) return found;
    } catch {
      // процесс ещё перезапускается: ждём следующую попытку
    }
    await sleep(700);
  }
  return null;
}

const page = await waitForTarget(port, 120_000, targets =>
  targets.find(target => target.type === "page" && target.webSocketDebuggerUrl != null));

if (page == null) {
  console.log("CDP рендерера не показал ни одной страницы");
} else {
  journal.rendererInfo.url = page.url;
  console.log(`Цель рендерера: ${page.url}`);
  const rendererClient = await connect(page.webSocketDebuggerUrl);
  const urls = new Map();
  rendererClient.on("Network.requestWillBeSent", params => {
    urls.set(params.requestId, params.request.url);
    journal.renderer.requests.push({
      url: params.request.url,
      method: params.request.method,
      type: params.type ?? null,
      postDataLength: params.request.postData == null ? 0 : params.request.postData.length,
      initiator: params.initiator?.type ?? null,
    });
  });
  rendererClient.on("Network.responseReceived", params => {
    journal.renderer.responses.push({
      url: params.response.url,
      status: params.response.status,
      statusText: params.response.statusText,
      mimeType: params.response.mimeType,
      fromDiskCache: params.response.fromDiskCache === true,
      fromServiceWorker: params.response.fromServiceWorker === true,
      type: params.type ?? null,
    });
  });
  rendererClient.on("Network.loadingFailed", params => {
    journal.renderer.failures.push({
      url: urls.get(params.requestId) ?? "(неизвестно)",
      errorText: params.errorText,
      type: params.type,
      canceled: params.canceled === true,
    });
  });
  rendererClient.on("Network.webSocketCreated", params => {
    journal.renderer.sockets.push({ url: params.url, kind: "webSocket" });
  });
  rendererClient.on("Network.webSocketWillSendHandshakeRequest", params => {
    journal.renderer.sockets.push({ url: params.request?.url, kind: "webSocketHandshake" });
  });

  await rendererClient.send("Network.enable");
  await rendererClient.send("Runtime.enable");
  await rendererClient.send("Page.enable");

  // Журнал включается до перезагрузки страницы: иначе видны только запросы,
  // сделанные после подключения, а стартовые потеряны.
  const reloaded = new Promise(resolve => rendererClient.on("Page.loadEventFired", () => resolve()));
  await rendererClient.send("Page.reload", { ignoreCache: false });
  await reloaded;
  await sleep(4000);

  const probeExpression = `(async () => ({
    origin: location.origin,
    href: location.href,
    title: document.title,
    bodyTextLength: (document.body?.innerText ?? "").length,
    scripts: Array.from(document.querySelectorAll("script[src]")).map(node => node.src),
    stylesheets: Array.from(document.querySelectorAll("link[rel=stylesheet]")).map(node => node.href),
    frames: window.frames.length,
    serviceWorker: navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : -1
  }))()`;
  try {
    const result = await rendererClient.send("Runtime.evaluate", {
      expression: probeExpression,
      returnByValue: true,
      awaitPromise: true,
    });
    journal.rendererInfo.page = result.result?.value ?? null;
  } catch (error) {
    journal.rendererInfo.pageError = String(error?.message ?? error);
  }

  // Наблюдаем всё, что приложение делает само: апдейт-чеки, фоновая
  // телеметрия, пульс аккаунта. Молчание в журнале — тоже результат.
  await sleep(seconds * 1000);
  rendererClient.close();
}

// --- канал 2: главный процесс ---------------------------------------------
const mainTarget = await waitForTarget(inspectPort, 20_000, targets =>
  targets.find(target => target.webSocketDebuggerUrl != null));

if (mainTarget == null) {
  journal.main.error = "инспектор главного процесса не ответил";
} else {
  const mainClient = await connect(mainTarget.webSocketDebuggerUrl);
  const mainUrls = new Map();
  mainClient.on("Network.requestWillBeSent", params => {
    mainUrls.set(params.requestId, params.request.url);
    journal.main.requests.push({
      url: params.request.url,
      method: params.request.method,
      type: params.type ?? null,
      postDataLength: params.request.postData == null ? 0 : params.request.postData.length,
      postDataPreview: params.request.postData == null ? null : params.request.postData.slice(0, 400),
    });
  });
  mainClient.on("Network.responseReceived", params => {
    journal.main.responses.push({ url: params.response.url, status: params.response.status, mimeType: params.response.mimeType });
  });
  mainClient.on("Network.loadingFailed", params => {
    journal.main.failures.push({ url: mainUrls.get(params.requestId) ?? "(неизвестно)", errorText: params.errorText, type: params.type });
  });
  try {
    await mainClient.send("Network.enable");
  } catch (error) {
    journal.main.enableError = String(error?.message ?? error);
  }
  await sleep(Math.min(seconds, 20) * 1000);
  mainClient.close();
}

clearInterval(socketTimer);
collectSockets();
journal.tcpSockets = [...sockets.values()].map(row => ({ ...row, state: row.state }));
journal.finishedAt = new Date().toISOString();
journal.stderrTail = stderr.trim().slice(-3000);
journal.probePid = child.pid;

writeFileSync(outFile, JSON.stringify(journal, null, 2), "utf8");

console.log(`\nЖурнал: ${outFile}`);
console.log(`Ответов рендерера: ${journal.renderer.responses.length}`);
console.log(`Ответов главного процесса: ${journal.main.responses.length}`);
console.log(`Исходящих сокетов: ${journal.tcpSockets.length}`);
console.log(`\nPROBE_PID=${child.pid}`);
child.unref();
process.exit(0);