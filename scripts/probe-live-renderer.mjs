// Доказательство запуска: поднимает `dist\DB Bot\DB Bot.exe`, подключается к
// живому рендереру через CDP и спрашивает у него содержимое страницы.
//
// Скрипт НЕ закрывает приложение. Он печатает PID, а закрывать надо через
// `.CloseMainWindow()`: `Stop-Process` не даёт Electron корректно завершиться
// и оставляет за собой файлы, заблокированные для следующей упаковки.
//
// Запуск: node scripts/probe-live-renderer.mjs [--port=9341]
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

import { repoRoot } from "./lib/config.mjs";

const outputApp = path.join(repoRoot, "dist", "DB Bot");
const executable = path.join(outputApp, "DB Bot.exe");
const userDataDir = path.join(repoRoot, ".tmp-probe-userdata");

// Отчёт пишется в файл, а не только в stdout: PowerShell 5.1 буферизует вывод
// конвейера до конца команды, а приложение здесь живёт долго и экран нужно
// показать сразу после опроса, не дожидаясь его закрытия.
const reportPath = path.join(repoRoot, ".probe-report.txt");
const report = [];
const say = line => {
  report.push(line);
  console.log(line);
};

// Каждое выражение оборачивается в async IIFE: вычислитель CDP не ждёт голый
// `await`, и без обёртки результат всегда `undefined`.
const PROBE_EXPRESSION = `(async () => {
  const root = document.getElementById('root');
  return {
    title: document.title,
    rootChildren: root ? root.childElementCount : null,
    rootExists: Boolean(root),
    bodyText: document.body ? document.body.innerText.slice(0, 600) : null,
    html: document.documentElement ? document.documentElement.outerHTML.length : 0,
    url: location.href,
    desktopBridge: typeof window.desktop
  };
})()`;

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

async function listTargets(port, deadline) {
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(1000);
  }
  throw new Error(`CDP на порту ${port} не ответил: ${lastError?.message ?? "нет данных"}`);
}

// Опрос идёт непрерывно с третьей секунды: главный процесс может несколько раз
// перезапуститься (миграция каталога данных, вытеснение старого демона), и
// одноразовая проверка через 15 секунд ничего не скажет о том, была ли минута,
// когда окно уже существовало.
async function pollForPages(port, budgetMs) {
  const startedAt = Date.now();
  const seen = [];
  const deadline = startedAt + budgetMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const pages = targets.filter(entry => entry.type === "page" && entry.webSocketDebuggerUrl);
        if (pages.length > 0) return { pages, elapsedMs: Date.now() - startedAt, timeline: seen };
        seen.push(`${Math.round((Date.now() - startedAt) / 1000)} с: целей ${targets.length}, окон нет`);
      } else {
        seen.push(`${Math.round((Date.now() - startedAt) / 1000)} с: HTTP ${response.status}`);
      }
    } catch (error) {
      const detail = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? "неизвестно";
      seen.push(`${Math.round((Date.now() - startedAt) / 1000)} с: CDP недоступен (${detail})`);
    }
    await sleep(2000);
  }
  return { pages: [], elapsedMs: Date.now() - startedAt, timeline: seen };
}

function evaluate(webSocketUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Runtime.evaluate не ответил за 30 секунд"));
    }, 30_000);
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`Не удалось открыть WebSocket ${webSocketUrl}`));
    });
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true }
      }));
    });
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error) reject(new Error(`CDP ответил ошибкой: ${JSON.stringify(message.error)}`));
      else if (message.result?.exceptionDetails) {
        reject(new Error(`Исключение в странице: ${JSON.stringify(message.result.exceptionDetails)}`));
      } else resolve(message.result?.result?.value ?? null);
    });
  });
}

/**
 * Опрашивает страницу, пока интерфейс не отрисуется.
 *
 * Зачем повторять. CDP отдаёт цель `page` в момент создания окна, а React
 * монтируется позже: между этими событиями `document.documentElement.
 * outerHTML` пуст. Раньше это не мешало — окно появлялось на 8-й секунде и
 * успевало наполниться. После мер для слабой машины окно появляется на 2-й,
 * и одна проверка сразу после `Runtime.evaluate` ловит пустую страницу и
 * объявляет неработающей работающую программу.
 *
 * Возвращает последний ответ: каким бы он ни был, он честный — на выходе
 * видно, сколько попыток понадобилось.
 */
async function evaluateWhenRendered(webSocketUrl, expression, attempts = 20) {
  let last = null;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      last = await evaluate(webSocketUrl, expression);
    } catch (error) {
      lastError = error;
    }
    if (last != null && typeof last.html === "number" && last.html > 0) {
      return { attempt, value: last };
    }
    await sleep(1000);
  }
  if (last == null && lastError != null) throw lastError;
  return { attempt: attempts, value: last };
}

const port = await findFreePort(Number(argument("port", "9341")));
say(`Порт отладки: ${port}`);
say(`Запуск:       ${executable}`);

const child = spawn(executable, [
  `--user-data-dir=${userDataDir}`,
  `--remote-debugging-port=${port}`
], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
  // Chromium читает `--user-data-dir` сам, но главный процесс приложения
  // переопределяет `userData` через `bootstrapDesktopUserData`. Пока там не
  // сработает изоляция, каталог данных общий с уже запущенным экземпляром, а
  // блокировка одиночного экземпляра не достаётся новому процессу: он молча
  // живёт без окна. `SAND_USER_DATA_DIR` — тот же путь, который читает
  // `resolveSandUserDataDir`, поэтому он задаётся вместе с флагом.
  env: {
    ...process.env,
    SAND_USER_DATA_DIR: userDataDir,
    ELECTRON_ENABLE_LOGGING: "1",
    ELECTRON_ENABLE_STACK_DUMPING: "1"
  }
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", chunk => { stdout += chunk; });
child.stderr.on("data", chunk => { stderr += chunk; });
child.on("error", error => { stderr += `${error.stack ?? error}\n`; });
child.on("close", (code, signal) => {
  say(`Процесс завершился сам: code=${code} signal=${signal}`);
});

say(`PID:          ${child.pid}`);
const poll = await pollForPages(port, 90_000);

say("");
say("Хроника опроса:");
for (const line of [...new Set(poll.timeline)].slice(-12)) say(`  ${line}`);

if (poll.pages.length > 0) {
  say("");
  say(`Окно найдено через ${Math.round(poll.elapsedMs / 1000)} с. Все цели:`);
  for (const target of await listTargets(port, Date.now() + 10_000)) {
    say(`  [${target.type}] ${target.title} <- ${target.url}`);
  }
} else {
  say("");
  say("ЦЕЛЕЙ CDP НЕТ: ни одного окна рендерера не создано.");
}

for (const target of poll.pages) {
  say("");
  say(`--- Runtime.evaluate: ${target.url}`);
  try {
    const probed = await evaluateWhenRendered(target.webSocketDebuggerUrl, PROBE_EXPRESSION);
    say(`Интерфейс отрисован с ${probed.attempt}-й попытки (1 попытка в секунду).`);
    say(JSON.stringify(probed.value, null, 2));
  } catch (error) {
    say(`ОШИБКА ВЫЧИСЛЕНИЯ: ${error.message}`);
  }
}

say("");
say(`Приложение живо после опроса: ${child.exitCode === null ? "да" : "нет"}`);

// Приложение может упасть или закрыть окно позже опроса. Код выхода и
// финальный текст stderr — самая ценная часть отчёта, поэтому ждём собственного
// завершения, а не своего таймера.
let exitCode = null;
let exitSignal = null;
const exitedAtMs = Date.now();
await new Promise(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
  child.once("close", (code, signal) => {
    exitCode = code;
    exitSignal = signal;
    resolve();
  });
  setTimeout(resolve, 30_000);
});

say(`Завершилось через ${Math.round((Date.now() - exitedAtMs) / 1000)} с после опроса: code=${exitCode} signal=${exitSignal}`);
say(`--- stdout ---\n${stdout.trim() || "(пусто)"}`);
say(`--- stderr ---\n${stderr.trim() || "(пусто)"}`);

if (child.exitCode === null && child.signalCode === null) {
  say(`Приложение всё ещё работает. ЗАКРОЙ ЧЕРЕЗ: (Get-Process -Id ${child.pid}).CloseMainWindow()`);
}
say(`PROBE_PID=${child.pid}`);

writeFileSync(reportPath, report.join("\n"), "utf8");
// Приложение остаётся жить, а скрипт обязан закончиться: иначе `node` держит
// цикл события открытым на ручках дочернего процесса и команда не возвращает
// управление на минуты.
child.unref();
process.exit(0);