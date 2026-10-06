import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { requiredElectronMainProductionBindings } from "../scripts/electron-main-production-activation.mjs";
import {
  bundleBanner,
  electronMainEntrySource,
  fromSourceBundles,
  startupFailureDialogDelayMs,
} from "../scripts/build-from-source.mjs";

/**
 * Плашка «DB Bot не запустился» появлялась на ЛЮБОМ отклонённом обещании.
 *
 * Её поставили, когда приложение при старте молча проглатывало ошибки: в
 * упакованном Electron на Windows process.stderr — заглушка, ошибка загрузки
 * модуля исчезает без следа, и снаружи это выглядит как «процесс жив, окна нет».
 * Оказалось, что баннер ловит и `unhandledRejection`, а фоновая служба
 * отклоняет обещания и после нормальной работы. Пользователь, который не мог
 * воспроизвести сбой, получал окно «EPERM: operation not permitted, mkdir …»
 * посреди обычной работы, и пугался.
 *
 * Тесты ниже гоняют НАСТОЯЩИЙ баннер, который esbuild ставит в начало бандля:
 * исходник берётся у `bundleBanner()`, выполняется в `node:vm` с подменёнными
 * `require` и `process`, и журнал пишется на настоящий диск в `os.tmpdir()`.
 * Так проверяется поведение того кода, который попадёт в сборку, а не
 * пересказ о нём.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(repoRoot, relative), "utf8");

/** Ждёт появления события, но не дольше потолка: тест обязан упасть, а не зависнуть. */
async function waitUntil(predicate, ceilingMs = 3_000) {
  const deadline = Date.now() + ceilingMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  throw new Error(`Условие не наступило за ${ceilingMs} мс`);
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Запускает баннер в отдельном контексте и возвращает то, чем можно управлять:
 * показанные окна, поднятые обработчики и каталог журнала.
 *
 * `markWindowCreated()` повторяет то, что делает точка входа главного процесса:
 * вызывает `__dbBotStartup.markReady()`, когда Electron создал окно.
 */
function runBanner({ startupDialog, label = "source/electron-main/main.ts" } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "dbbot-startup-dialog-"));
  const shown = [];
  const handlers = new Map();
  const context = vm.createContext({
    __filename: path.join(root, "main.cjs"),
    clearTimeout,
    process: {
      cwd: () => root,
      env: { SAND_DATA_ROOT: root, DB_BOT_STARTUP_DIALOG_DELAY_MS: "20" },
      on: (event, listener) => { handlers.set(event, listener); },
    },
    require: (specifier) => {
      if (specifier === "node:fs") return fs;
      if (specifier === "node:path") return path;
      if (specifier === "node:url") return { pathToFileURL: (value) => ({ href: `file:///${value}` }) };
      if (specifier === "electron") {
        return { dialog: { showErrorBox: (title, content) => { shown.push({ title, content }); } } };
      }
      throw new Error(`Баннер не должен требовать ${specifier}`);
    },
    setTimeout,
  });
  vm.runInContext(bundleBanner(label, { startupDialog }), context, { filename: "bundle-banner.cjs" });
  return {
    context,
    root,
    shown,
    logFile: path.join(root, "db-bot-start-error.log"),
    readLog: () => (existsSync(path.join(root, "db-bot-start-error.log"))
      ? readFileSync(path.join(root, "db-bot-start-error.log"), "utf8")
      : ""),
    raise: (event, error) => {
      const handler = handlers.get(event);
      assert.ok(typeof handler === "function", `баннер обязан слушать ${event}, иначе ошибка уйдёт в никуда`);
      handler(error);
    },
    markWindowCreated: () => {
      assert.ok(typeof context.__dbBotStartup?.markReady === "function",
        "точка входа главного процесса обязана уметь отметить, что окно создано");
      context.__dbBotStartup.markReady();
    },
    cleanup: () => { rmSync(root, { force: true, recursive: true }); },
  };
}

const permissionError = () => Object.assign(
  new Error("EPERM: operation not permitted, mkdir 'D:\\ТЕСТЫ\\DeepSeek-Harness\\data'"),
  { code: "EPERM" },
);

test("отклонённое обещание после появления окна пишется в журнал и не поднимает плашку", async (t) => {
  const banner = runBanner({ startupDialog: true });
  t.after(banner.cleanup);

  banner.markWindowCreated();
  banner.raise("unhandledRejection", permissionError());
  // Ждём с запасом: плашка появилась бы через отложенное решение, а не сразу.
  await wait(200);

  assert.equal(banner.shown.length, 0,
    "работающее приложение не должно пугать пользователя ошибкой фоновой службы");
  assert.match(banner.readLog(), /unhandledRejection: .*EPERM/,
    "журнал остаётся единственным местом, где видна фоновая ошибка");
});

test("ошибка до появления окна поднимает плашку один раз и объясняет сбой словами", async (t) => {
  const banner = runBanner({ startupDialog: true });
  t.after(banner.cleanup);

  banner.raise("uncaughtException", permissionError());
  banner.raise("unhandledRejection", new Error("host bootstrap failed"));
  await waitUntil(() => banner.shown.length > 0);
  await wait(200);

  assert.equal(banner.shown.length, 1,
    "вторая ошибка подряд не должна превращаться в ещё одно окно поверх первого");
  const [{ title, content }] = banner.shown;
  assert.equal(title, "DB Bot не запустился", "заголовок окна должен называть программу и сбой");
  assert.match(content, /Программа не смогла открыть окно\./,
    "пользователь должен читать следствие, а не системный код");
  assert.match(content, /Windows не дал программе доступ к файлу или папке\./,
    "EPERM обязан быть переведён словами: именно его пользователь видел и не понимал");
  assert.match(content, /Что делать:/, "окно обязано говорить, что делать человеку");
  assert.ok(content.includes(banner.logFile),
    "пользователю нужен путь к файлу с подробностями, а не только текст ошибки");
  assert.match(content, /Сообщение для разработчика: EPERM/,
    "исходный текст ошибки разработчику потерять нельзя");
  assert.ok(content.length < 1200,
    "окно читают не глядя: стена текста в окне хуже, чем короткая фраза и файл");
  const log = banner.readLog();
  assert.match(log, /uncaughtException: .*EPERM/, "обе ошибки обязаны попасть в журнал");
  assert.match(log, /unhandledRejection: .*host bootstrap failed/,
    "ошибка, не получившая плашки, всё равно обязана остаться в журнале");
});

test("ошибка случилась, но окно успело открыться — плашка не показывается", async (t) => {
  const banner = runBanner({ startupDialog: true });
  t.after(banner.cleanup);

  banner.raise("unhandledRejection", permissionError());
  banner.markWindowCreated();
  await wait(200);

  assert.equal(banner.shown.length, 0,
    "ошибка за долю секунды до окна — это ещё не «программа не запустилась»");
  assert.match(banner.readLog(), /unhandledRejection: .*EPERM/,
    "журнал не должен зависеть от того, показали мы плашку или нет");
});

test("процесс без своего окна пишет журнал и никогда не показывает плашку", async (t) => {
  const banner = runBanner({ startupDialog: false, label: "source/host/main.ts" });
  t.after(banner.cleanup);

  banner.raise("unhandledRejection", permissionError());
  await wait(200);

  assert.equal(banner.shown.length, 0,
    "хост, демоны и воркеры не имеют окна, и их сбой не означает, что не открылась программа");
  assert.match(banner.readLog(), /unhandledRejection: .*EPERM/,
    "журнал фонового процесса писать обязаны независимо от наличия плашки");
});

test("готовость отмечает создание окна, а плашку получает только главный процесс", () => {
  const bindings = requiredElectronMainProductionBindings.map((name) => ({
    path: name,
    export: "default",
    access: "call",
    module: "./stub.ts",
  }));
  const entry = electronMainEntrySource(bindings);

  assert.match(entry, /app\.on\("browser-window-created", \(\) => globalThis\.__dbBotStartup\?\.markReady\(\)\);/,
    "главный процесс обязан сказать баннеру, что окно создано, иначе плашка всплывёт на фоновой ошибке");
  assert.equal(entry.split("markReady()").length - 1, 1,
    "отметка готовности должна быть ровно одна: две означали бы гонку с первым окном");
  assert.ok(entry.indexOf("browser-window-created") < entry.indexOf("startElectronMainProduction({"),
    "слушатель обязан встать до старта, иначе окно может создаться раньше подписки");

  const script = read("scripts/build-from-source.mjs");
  assert.match(script, /startupDialog: bundle\.kind === "electron-main"/,
    "право показывать плашку получает ровно один бандль из таблицы");

  const mainBundles = fromSourceBundles.filter((bundle) => bundle.kind === "electron-main");
  assert.equal(mainBundles.length, 1, "главный процесс в таблице ровно один");
  assert.ok(fromSourceBundles.length > mainBundles.length,
    "остальные бандлы обязаны существовать: иначе проверка «только главный» ничего не исключает");

  assert.ok(startupFailureDialogDelayMs >= 2000,
    "решение о плашке обязано быть отложено: ошибка приходит раньше, чем появится окно");
  assert.match(bundleBanner("x", { startupDialog: true }), /DB_BOT_STARTUP_DIALOG_DELAY_MS/,
    "задержка должна быть настраиваемой, иначе проверку придётся ждать восемь секунд");
});