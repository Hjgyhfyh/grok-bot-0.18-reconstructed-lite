import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// Мост между рендерером и главным процессом держался на трёх согласованных
// списках: `MAIN_METHOD_TABLE` в `source/shared/rpc/main.ts`, литерал
// `handlers` в `source/electron-main/main-edge.ts` и обёртки `edge("…")` в
// `source/electron-preload/preload.ts`. Ни один список не проверялся целиком,
// а рассинхрон между ними выглядел как «сломанная настройка»:
//
//   * метод есть в таблице, но обработчика нет — `serveEdge` регистрирует
//     `ipcMain.handle` по таблице, вызов уходит в пустоту;
//   * обработчик есть, а записи в таблице нет — он молча никогда не
//     обслуживается, и мёртвый код годами выглядит как живой;
//   * `preload.ts` зовёт `edge("НетВТаблице", …)` — `bridgeRpcEdge` строит
//     обёртки только по таблице, поэтому `mainEdge[method]` равно `undefined`
//     и `edge` падает с `TypeError`, который рендерер читает как
//     «network-error», а не как «unsupported»;
//   * тип аргументов в таблице разошёлся с тем, что реально отправляет
//     preload: `args: "object"` при вызове без полезной нагрузке теряет всё
//     содержимое запроса молча.
//
// Первый из этих классов уже стоил проекту выбора модели (§0 AGENTS.md):
// `listInferenceRouterModels` отсутствовал в таблице, `bridgeRpcEdge` не
// построил обёртку, и вызов падал `TypeError` — при этом захардкоженный
// список из 33 моделей делал ползунок безупречным на вид. Тест ниже
// проверяет все три списка разом и объёмом, а не точечно.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadSource() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "dbbot-rpc-surface-"));
  const entries = [
    ["shared", "rpc", "main.ts"],
    ["electron-main", "main-edge.ts"],
    ["electron-preload", "preload.ts"],
  ];
  const built = [];
  for (const entry of entries) {
    const outfile = path.join(directory, `${entry.at(-1).replace(/\.ts$/, "")}.mjs`);
    await build({
      entryPoints: [path.join(repoRoot, "source", ...entry)],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
    built.push(outfile);
  }
  const loaded = [];
  for (const file of built) loaded.push(await import(`${pathToFileURL(file).href}?${Date.now()}`));
  return { modules: Object.fromEntries(loaded.map((m, i) => [["rpc-main", "main-edge", "preload"][i], m])), dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

/**
 * Заглушка вместо настоящих зависимостей главного процесса. Любое касание
 * возвращает функцию, которая бросает именованную ошибку: так тест отличает
 * обработчик, который отвечает сам (заглушка `unserved` бросает
 * `EdgeCallFailure` сразу и синхронно), от обработчика, который дошёл до
 * настоящего кода и упал там. Ни один сетевой запрос при этом не уходит:
 * `unserved` бросает до `await`, а отложенный промис гасится.
 */
const DEPS_TOUCHED = "deps-touched";
function depsStub() {
  const callable = new Proxy(function stub() { throw new Error(DEPS_TOUCHED); }, {
    get(target, property) {
      if (property === "then") return undefined;
      if (property === Symbol.toPrimitive || property === "toString") return () => "depsStub";
      return callable;
    },
    apply() { throw new Error(DEPS_TOUCHED); },
  });
  return new Proxy({}, {
    get(_target, property) {
      if (property === "platform") return "win32";
      if (property === "delay") return async () => {};
      if (property === "detectTimeZone") return () => "Europe/Moscow";
      return callable;
    },
  });
}

/** Классифицирует обработчики main-edge: `served` отвечает сам, `unserved` бросает заглушку. */
function classifyHandlers(handlers, unservedCode) {
  const served = new Set();
  const unserved = new Set();
  for (const [name, run] of Object.entries(handlers)) {
    let rejectedSynchronously = false;
    let returned;
    try {
      returned = run({});
    } catch (error) {
      if (error?.code === unservedCode) unserved.add(name);
      else served.add(name);
      rejectedSynchronously = true;
    }
    if (!rejectedSynchronously) {
      served.add(name);
      if (returned != null && typeof returned.then === "function") returned.then(() => {}, () => {});
    }
  }
  return { served, unserved };
}

/**
 * Обходит мост, который отдаёт рендереру preload, и зовёт каждую его функцию.
 * `mainEdge` — записывающая заглушка: она видит имя метода именно в тот момент,
 * когда preload до него дошёл, то есть доказывает достижимость, а не наличие
 * строчки в исходнике.
 */
function collectPreloadEdgeCalls(createDesktopPreloadBridge) {
  const calls = new Set();
  const mainEdge = new Proxy({}, {
    get(_target, property) {
      if (property === "subscribe") return () => () => {};
      if (typeof property !== "string") return undefined;
      return (...args) => { calls.add(property); return Promise.resolve({ ok: true, echoed: args }); };
    },
  });
  const ipc = {
    invoke: async () => null,
    sendSync: () => null,
    send: () => {},
    on: () => {},
    off: () => {},
  };
  const bridge = createDesktopPreloadBridge({
    ipc,
    webFrame: { getZoomFactor: () => 1 },
    mainEdge,
    platform: "win32",
    env: {},
    initialState: { experimentSnapshot: null, themeState: null, egressTunnelEnabled: false, webauthnProxyEnabled: false, egressTunnelStatus: null },
  });
  const seen = new Set();
  const walk = (value, depth) => {
    if (depth > 4 || value == null || typeof value !== "object" && typeof value !== "function") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (typeof value === "function") {
      try { const result = value(); if (result != null && typeof result.then === "function") result.then(() => {}, () => {}); } catch { /* функция требует аргумент — имя метода уже записано до вызова */ }
      return;
    }
    for (const entry of Object.values(value)) walk(entry, depth + 1);
  };
  walk(bridge, 0);
  return { calls, bridge };
}

const source = await loadSource();
const { dispose } = source;
test.after(() => dispose());

const { MAIN_METHOD_TABLE } = source.modules["rpc-main"];
const { createMainEdgeHandlers, MAIN_EDGE_UNSERVED } = source.modules["main-edge"];
const { createDesktopPreloadBridge } = source.modules["preload"];

const tableNames = Object.keys(MAIN_METHOD_TABLE);
const handlers = createMainEdgeHandlers(depsStub());
const { served, unserved } = classifyHandlers(handlers, MAIN_EDGE_UNSERVED);
const { calls: preloadCalls } = collectPreloadEdgeCalls(createDesktopPreloadBridge);

test("в MAIN_METHOD_TABLE больше ста тридцати методов — проверка не проходит на пустом месте", () => {
  // Нулевой счётчик здесь означал бы, что проверка ничего не нашла и ничего
  // не доказывает. Порог ниже взят с запасом от фактических 126.
  assert.ok(
    tableNames.length >= 100,
    `в таблице ${tableNames.length} методов, а проверка рассчитана на мост из сотни с лишним: файл разобран не тот или таблица схлопнулась`,
  );
  assert.ok(
    preloadCalls.size >= 50,
    `preload дошёл только до ${preloadCalls.size} методов моста: обход перестал работать и проверка молча согласится с любой поломкой`,
  );
  assert.ok(
    served.size >= 50,
    `настоящих обработчиков ${served.size}: классификатор перестал отличать заглушку от работы, и проверка ничего не доказывает`,
  );
});

test("каждому методу MAIN_METHOD_TABLE отвечает обработчик в main-edge", () => {
  const withoutHandler = tableNames.filter(name => !served.has(name) && !unserved.has(name));
  assert.deepEqual(
    withoutHandler,
    [],
    `методы таблицы без обработчика: ${withoutHandler.join(", ")}. serveEdge регистрирует ipcMain.handle по таблице, поэтому вызов из preload уходит в пустоту и рендерер получает «unsupported» на живом методе`,
  );
});

test("ни один обработчик main-edge не остаётся без записи в таблице — мёртвого кода в мосте нет", () => {
  const orphans = Object.keys(handlers).filter(name => !Object.hasOwn(MAIN_METHOD_TABLE, name));
  assert.deepEqual(
    orphans,
    [],
    `обработчики без записи в таблице: ${orphans.join(", ")}. serveEdge регистрирует только ключи таблицы, поэтому эти обработчики никогда не вызываются и читаются как живая функция`,
  );
});

test("каждый метод, до которого доходит preload, есть в MAIN_METHOD_TABLE", () => {
  const missing = [...preloadCalls].filter(name => !Object.hasOwn(MAIN_METHOD_TABLE, name));
  assert.deepEqual(
    missing,
    [],
    `preload зовёт edge() для методов без записи в таблице: ${missing.join(", ")}. bridgeRpcEdge строит обёртки только по таблице, поэтому mainEdge[метод] равно undefined и edge() падает с TypeError, который рендерер читает как network-error`,
  );
});

test("обёртка preload не бьётся о заглушку unserved: до неё доходит только настоящий обработчик", () => {
  // 41 метод таблицы помечен `unserved` и едет по своему каналу `ipc.invoke`
  // (`sand:secrets-list`, `sand:mcp-list`, `sand:report-*`). Так и должно быть.
  // Ошибка — наоборот: если такой метод попал в обёртку preload, рендерер
  // получит жёсткий отказ вместо работы.
  const stubWrapped = [...preloadCalls].filter(name => unserved.has(name));
  assert.deepEqual(
    stubWrapped,
    [],
    `preload оборачивает заглушки unserved: ${stubWrapped.join(", ")}. Каждый вызов такого метода кончается отказом main/unserved-method, а не результатом`,
  );
  assert.ok(
    unserved.size >= 20,
    `заглушек unserved всего ${unserved.size}: классификатор перестал их видеть, и проверка пропустила бы заглушку, дошедшую до preload`,
  );
});

test("объявленный тип аргументов совпадает с тем, что реально отправляет preload", () => {
  const preloadSource = readFileSync(path.join(repoRoot, "source", "electron-preload", "preload.ts"), "utf8");
  const disagreements = [];
  for (const call of preloadSource.matchAll(/\bedge\(\s*"([A-Za-z0-9_]+)"\s*(,)?/g)) {
    const [, name, comma] = call;
    const declared = MAIN_METHOD_TABLE[name]?.args;
    if (declared === undefined) { disagreements.push(`${name}: нет в таблице`); continue; }
    const carriesPayload = comma === ",";
    if (declared === "none" && carriesPayload) disagreements.push(`${name}: объявлено args=none, а preload шлёт полезную нагрузку — bridgeRpcEdge её отбросит`);
    if (declared === "object" && !carriesPayload) disagreements.push(`${name}: объявлено args=object, а preload зовёт без аргументов — обработчик получит пустой объект и потеряет запрос молча`);
  }
  assert.deepEqual(
    disagreements,
    [],
    `тип аргументов разошёлся с preload: ${disagreements.join("; ")}`,
  );
});

test("у каждого метода таблицы объявлен тип аргументов", () => {
  const undeclared = tableNames.filter(name => {
    const row = MAIN_METHOD_TABLE[name];
    return row == null || (row.args !== "none" && row.args !== "object");
  });
  assert.deepEqual(
    undeclared,
    [],
    `методы без объявленного типа аргументов: ${undeclared.join(", ")}. bridgeRpcEdge по такой строке строит обёртку, которая игнорирует аргументы, и рендерер отправляет запрос в никуда`,
  );
});