/**
 * Единственный провайдер DB Bot Lite — официальный DeepSeek API. Здесь проверяется то, о чём
 * не говорит остальной набор: как этот маршрут ведёт себя, когда провайдер не отвечает,
 * отказывает или отвечает слишком медленно, и куда при этом попадает ключ API.
 *
 * Четыре тревоги, которые этот набор закрывает:
 *
 *  1. `deepSeekFetch` (`provider-session.ts:100`) — обёртка, которая внедряет `thinking` в тело
 *     запроса. `return await fetch(...)` стоит ВНУТРИ `try`, а `catch` рядом же отправляет тот
 *     же запрос ещё раз. Любая транспортная ошибка (нет сети, соединение закрыто, прокси
 *     оборвал поток до заголовков) превращает один запрос логики в два запроса DeepSeek:
 *     без паузы, без счётчика, без учёта в лестнице повторов, и наружу уходит ошибка ВТОРОЙ
 *     попытки, а настоящая первая теряется. Рядом стоит `maxRetries: 0` с комментарием
 *     «повторы принадлежат stream-attempt.ts» — этот повтор её обходит.
 *
 *  2. `getInferenceApiKeyStatus` (`main-edge.ts:169`) спрашивает про ключ только в настройках и
 *     в переменной окружения, но не в системном хранилище секретов, откуда ключ берёт
 *     `secretDeepSeekApiKey` — тот же файл, соседняя функция. Путь через хранилище секретов
 *     документирован в `deepseek-credential.ts` («лаунчер пишет секреты в box-secrets.json,
 *     потому что process.env не переживает прыжок в рабочий процесс агента»). Значит панель
 *     настроек показывает «Не задан ключ DeepSeek API» ровно в той конфигурации, в которой
 *     приложение работает, и пользователю показывают неправду.
 *
 *  3. Именование новой беседы (`node-agent-coordinator/inference-router.ts:200`) уходит в
 *     DeepSeek без сигнала отмены и без какого-либо срока. `stream-attempt.ts` держит первый
 *     токен под дедлайном 150 с, список моделей — под 5 с, а этот запрос не ограничен ничем:
 *     если провайдер принял соединение и не отвечает, очередь `queues` по этому агенту стоит,
 *     и все следующие попытки наименовать беседу выстраиваются за ней — молча, без счётчика и
 *     без сообщения.
 *
 *  4. Ключ не должен попадать в тексты, которые читает человек: в заметку в `store.db`, в
 *     сообщение об ошибке, в лог. Здесь это сторожевые проверки — они ничего не находят и
 *     должны продолжать ничего не находить. Сканер сначала доказывает, что он вообще умеет
 *     находить ключи, и только потом утверждает, что в исходниках их нет.
 *
 * Ни один тест здесь не обращается к настоящему api.deepseek.com: `baseURL` в
 * `provider-session.ts` зашит константой, а единственный адрес, который код согласен
 * нарисовать, подменяется на локальный сервер через `globalThis.fetch`.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Загрузка живого кода
// ---------------------------------------------------------------------------

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "dbbot-qa-gaps11-"));
  const files = [];
  for (const entry of entries) {
    const name = `${entry.at(-1).replace(/\.ts$/, "")}.mjs`;
    const outfile = path.join(directory, name);
    await build({
      entryPoints: [path.join(repoRoot, "source", ...entry)],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
    files.push([name, outfile]);
  }
  const loaded = {};
  for (const [name, file] of files) loaded[name] = await import(`${pathToFileURL(file).href}?${Date.now()}`);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "extensions", "inference", "provider-session.ts"],
  ["host", "extensions", "inference", "deepseek-credential.ts"],
  ["node-agent-coordinator", "inference-router.ts"],
  ["shared", "node", "settings", "sand-settings-store.ts"],
  ["electron-main", "main-edge.ts"],
]);

const { deepSeekFetch } = loaded["provider-session.mjs"];
const { findDeepSeekApiKey, readDeepSeekApiKey, deepSeekApiKeyStatus } = loaded["deepseek-credential.mjs"];
const { createCoordinatorInferenceRouter } = loaded["inference-router.mjs"];
const { SandSettingsStore } = loaded["sand-settings-store.mjs"];
const { createMainEdgeHandlers } = loaded["main-edge.mjs"];

test.after(() => dispose());

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

// ---------------------------------------------------------------------------
// 1. deepSeekFetch: одна логическая попытка — два запроса к провайдеру
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Потолок ожидания. Таймер всегда снимается, иначе незавершившийся промис держит событийный
 * цикл и весь файл тестов висит после своего последнего утверждения.
 */
async function withCeiling(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve("таймаут"), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Заменяет `globalThis.fetch` на счётчик, который каждый раз бросает заданную ошибку,
 * и возвращает её обратно. Ошибка, которая вышла наружу, сравнивается с той, что брошена
 * именно на первой попытке: если наружу ушла вторая, первая — настоящая — потеряна.
 */
async function withCountingFetch(errors, run) {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    const error = errors[Math.min(calls, errors.length - 1)];
    calls += 1;
    throw error;
  };
  try {
    // `calls` читается после прогона: порядок вычисления свойств в литерале объекта иначе
    // зафиксировал бы счётчик до того, как fetch вообще позвали.
    const outcome = await run();
    return { calls, outcome };
  } finally {
    globalThis.fetch = realFetch;
  }
}

function chatRequest() {
  return {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-qa-gaps11-transport" },
    body: JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: "привет" }], stream: true }),
  };
}

test("прерванное соединение не отправляет запрос провайдеру второй раз молча", async () => {
  const first = new TypeError("fetch failed");
  first.cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  const second = new TypeError("fetch failed");
  second.cause = Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" });

  const escapedHolder = { value: null };
  const { calls } = await withCountingFetch([first, second], async () => {
    try {
      await deepSeekFetch({})(`${DEEPSEEK_BASE_URL}/chat/completions`, chatRequest());
    } catch (error) {
      escapedHolder.value = error;
    }
    return null;
  });
  const escaped = escapedHolder.value;

  assert.equal(
    escaped != null,
    true,
    "оборванное соединение не дало ни одной ошибки наружу, вызывающий код решит, что запрос прошёл",
  );
  // Ошибка наружу обязана быть ПЕРВОЙ. Раньше здесь стояло `second`, и это было не «строже»,
  // а наоборот: при одном запросе наружу может уйти только `first`, поэтому ожидание `second`
  // кодировало сам дефект — «наружу уходит ошибка второй попытки» — и было невыполнимо вместе
  // с `calls === 1` ни при каком коде. Свои же слова теста это подтверждали: комментарий над
  // `withCountingFetch` обещает сравнение с ошибкой ПЕРВОЙ попытки, а текст этого утверждения
  // («первая, настоящая причина потеряна») описывает ровно тот случай, когда ушла вторая.
  assert.equal(
    escaped,
    first,
    `наружу ушла не та ошибка: от провайдера пришло «${String(first.cause?.message)}», а пользователь увидит «${String(escaped?.cause?.message ?? escaped?.message)}» — первая, настоящая причина потеряна`,
  );
  assert.equal(
    calls,
    1,
    `одна неудачная попытка превратилась в ${calls} запроса к DeepSeek: повтор идёт без паузы, без счётчика и мимо лестницы повторов stream-attempt.ts, поэтому один сбой связи оплачивается дважды`,
  );
});

/**
 * Тот же повтор, но через настоящий путь приложения: `createProviderPromptSession` и настоящий
 * `ai` 4.3.17 против локального сервера, который принимает тело запроса и закрывает соединение,
 * не ответив ни заголовком. Это самый частый вид «сеть отвалилась» на домашнем интернете.
 * Провайдер уже получил запрос и уже начал его считать — второй запрос это оплачивает дважды.
 */
test("оборванное соединение на настоящем маршруте не отправляет запрос провайдеру дважды", async () => {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), "dbbot-qa-gaps11-e2e-"));
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(
    path.join(dataRoot, "settings.json"),
    JSON.stringify({
      version: 1,
      settingsMigrations: ["downgrade-persisted-max-fast", "local-inference-provider", "deepseek-only"],
      inferenceCustomEndpoint: { baseUrl: DEEPSEEK_BASE_URL, modelId: "qa-transport-probe" },
    }, null, 2),
    "utf8",
  );
  const previousRoot = process.env.SAND_DATA_ROOT;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.SAND_DATA_ROOT = dataRoot;
  process.env.DEEPSEEK_API_KEY = "sk-qa-gaps11-e2e";

  const arrived = [];
  let server;
  const serverReady = new Promise((resolve) => {
    server = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        arrived.push(Date.now());
        // Тело принято целиком, ответ не отправлен — соединение просто рвётся.
        res.socket.destroy();
      });
    });
    server.listen(0, "127.0.0.1", resolve);
  });
  await serverReady;
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => realFetch(String(input?.url ?? input).replace(DEEPSEEK_BASE_URL, base), init);

  try {
    const executor = loaded["provider-session.mjs"].createProviderPromptSession("deepseek").getExecutor();
    executor.appendMessages([{ role: "user", content: "привет" }]);
    const result = executor.stream({}, "invocation-qa-transport");
    // Форма, которую уже использует `routed-provider-transport.test.mjs`: часть ошибок SDK
    // отдаёт как `error`-часть потока, часть — бросает прямо из `for await`. Учитываются оба.
    let thrown = null;
    const errorParts = [];
    const drain = (async () => {
      try {
        for await (const part of result.fullStream) {
          if (part.type === "error") errorParts.push(part.error);
        }
      } catch (error) {
        thrown = error;
      }
    })();
    await withCeiling(drain, 20_000);
    await sleep(300);

    assert.ok(
      thrown != null || errorParts.length > 0,
      "оборванное соединение не дало ни ошибки, ни ответа: маршрут завис, и это отдельная беда",
    );
    assert.equal(
      arrived.length,
      1,
      `провайдер получил ${arrived.length} запроса на одну попытку: тело первого уже ушло и уже оплачено, второй запрос — это вторая оплата за тот же вопрос, причём без паузы и без учёта в лестнице повторов`,
    );
  } finally {
    globalThis.fetch = realFetch;
    server.closeAllConnections?.();
    server.close();
    if (previousRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousRoot;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("тело, которое не разобралось как JSON, уходит один раз и без thinking", async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    sent.push(init?.body);
    return new Response("ok", { status: 200 });
  };
  try {
    await deepSeekFetch({})(new URL(`${DEEPSEEK_BASE_URL}/models`), { method: "GET" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent.length, 1, "запрос без тела JSON ушёл дважды, хотя повторять тут нечего");
  assert.equal(sent[0], undefined, "в запрос без тела был подставлен несуществующий body");
});

test("один успешный ответ провайдера — это ровно один запрос, и thinking в нём есть", async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  };
  try {
    await deepSeekFetch({})(new URL(`${DEEPSEEK_BASE_URL}/chat/completions`), chatRequest());
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent.length, 1, "успешный запрос отправлен дважды");
  assert.deepEqual(
    sent[0].thinking,
    { type: "disabled" },
    "thinking не доехал до тела запроса, поэтому режим размышления выбирается SDK, а не этой обёрткой",
  );
});

// ---------------------------------------------------------------------------
// 2. Панель настроек vs. хранилище секретов
// ---------------------------------------------------------------------------

function stubSettingsFile(dataRoot) {
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(
    path.join(dataRoot, "settings.json"),
    JSON.stringify({
      version: 1,
      settingsMigrations: ["downgrade-persisted-max-fast", "local-inference-provider", "deepseek-only"],
    }, null, 2),
    "utf8",
  );
  return new SandSettingsStore(path.join(dataRoot, "settings.json"));
}

const SECRET_STORE_KEY = "sk-qa-gaps11-secret-store-only-key";

test("панель настроек не отрицает ключ, который приложение на самом деле использует", async () => {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), "dbbot-qa-gaps11-edge-"));
  const settingsStore = stubSettingsFile(dataRoot);
  const seen = [];
  let server;
  let serverUrl;
  server = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "deepseek-flash", name: "DeepSeek Flash" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverUrl = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => realFetch(String(input?.url ?? input).replace(DEEPSEEK_BASE_URL, serverUrl), init);

  const handlers = createMainEdgeHandlers({
    settingsStore,
    // Ровно то состояние, которое описывает `deepseek-credential.ts`: лаунчер положил ключ в
    // системное хранилище, переменной окружения нет, в settings.json его нет.
    getInferenceApiKey: () => settingsStore.getInferenceApiKey() ?? null,
    readCustomEndpointApiKey: async (name) => (name === "DEEPSEEK_API_KEY" ? SECRET_STORE_KEY : null),
    readHostSettingsFromBox: async () => ({}),
    syncHostSettingsToBox: async (value) => value,
  });

  try {
    const models = await handlers.getAvailableModels({});
    assert.equal(
      models.status,
      "ok",
      `ключ из хранилища секретов не сработал: ${JSON.stringify(models)}`,
    );
    assert.equal(
      seen[0]?.authorization,
      `Bearer ${SECRET_STORE_KEY}`,
      "запрос к провайдеру ушёл без ключа, и проверка статуса ниже ничего бы не доказывала",
    );

    const status = await handlers.getInferenceApiKeyStatus({});
    assert.equal(
      status.configured,
      true,
      "приложение только что успешно авторизовалось ключом из хранилища секретов, а панель сообщает, что ключа нет",
    );
    assert.equal(
      status.message,
      null,
      `пользователю показано «${status.message}», хотя ключ есть и работает`,
    );

    const router = await handlers.getInferenceRouter({});
    assert.equal(
      router.apiKeyConfigured,
      true,
      "экран настроек по соседнему методу тоже говорит, что ключа нет, хотя запрос с ключом проходит",
    );
  } finally {
    globalThis.fetch = realFetch;
    server.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("настоящее отсутствие ключа по-прежнему объясняется по-русски", () => {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), "dbbot-qa-gaps11-nokey-"));
  stubSettingsFile(dataRoot);
  const previous = process.env.SAND_DATA_ROOT;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.SAND_DATA_ROOT = dataRoot;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const status = deepSeekApiKeyStatus();
    assert.equal(status.configured, false, "ключа нет, а статус говорит, что он есть");
    assert.match(status.message, /[\u0400-\u04ff]/u, `сообщение не на русском: ${status.message}`);
    assert.match(status.message, /DeepSeek/, "сообщение не называет, чего именно не хватает");
    assert.match(status.message, /DEEPSEEK_API_KEY/, "сообщение не называет, где задать ключ");
    assert.throws(() => readDeepSeekApiKey(), /[\u0400-\u04ff]/u, "отказ без ключа ушёл на английском");
  } finally {
    if (previous === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previous;
    if (previousKey !== undefined) process.env.DEEPSEEK_API_KEY = previousKey;
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("приоритет хранилищ: переменная окружения, потом settings.json, потом box-secrets.json", () => {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), "dbbot-qa-gaps11-order-"));
  stubSettingsFile(dataRoot);
  writeFileSync(
    path.join(dataRoot, "box-secrets.json"),
    JSON.stringify({ version: 1, secrets: { DEEPSEEK_API_KEY: "sk-qa-gaps11-from-box" } }, null, 2),
    "utf8",
  );
  const store = new SandSettingsStore(path.join(dataRoot, "settings.json"));
  const previousRoot = process.env.SAND_DATA_ROOT;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.SAND_DATA_ROOT = dataRoot;
  try {
    delete process.env.DEEPSEEK_API_KEY;
    assert.deepEqual(
      findDeepSeekApiKey(),
      { key: "sk-qa-gaps11-from-box", source: "box-secrets" },
      "с единственным источником — box-secrets.json — ключ не найден вовсе",
    );

    store.setInferenceApiKey("sk-qa-gaps11-from-settings");
    assert.deepEqual(
      findDeepSeekApiKey(),
      { key: "sk-qa-gaps11-from-settings", source: "settings" },
      "settings.json не перебил box-secrets.json, хотя объявлен выше него",
    );

    process.env.DEEPSEEK_API_KEY = "sk-qa-gaps11-from-env";
    assert.deepEqual(
      findDeepSeekApiKey(),
      { key: "sk-qa-gaps11-from-env", source: "env" },
      "переменная окружения не перебила файл, хотя объявлена первой",
    );
    assert.equal(readDeepSeekApiKey(), "sk-qa-gaps11-from-env", "подпись запроса пошла не тем ключом");
  } finally {
    if (previousRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousRoot;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Именование беседы не ограничено ничем и встаёт навсегда
// ---------------------------------------------------------------------------

let namingServer;
let namingServerUrl;
const namingReceived = [];

function startNamingServer() {
  namingServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = {}; }
      namingReceived.push({ at: Date.now(), model: body.model });
      // Провайдер принял соединение и не отвечает: сеть «есть», модель «думает».
      res.writeHead(200, { "content-type": "text/event-stream" });
    });
  });
  return new Promise((resolve) => {
    namingServer.listen(0, "127.0.0.1", () => {
      namingServerUrl = `http://127.0.0.1:${namingServer.address().port}/v1`;
      resolve();
    });
  });
}

test("медленный провайдер не оставляет очередь наименования висеть навсегда", async () => {
  const namingDataRoot = mkdtempSync(path.join(os.tmpdir(), "dbbot-qa-gaps11-naming-"));
  stubSettingsFile(namingDataRoot);
  writeFileSync(
    path.join(namingDataRoot, "settings.json"),
    JSON.stringify({
      version: 1,
      settingsMigrations: ["downgrade-persisted-max-fast", "local-inference-provider", "deepseek-only"],
      inferenceCustomEndpoint: { baseUrl: DEEPSEEK_BASE_URL, modelId: "qa-naming-probe" },
    }, null, 2),
    "utf8",
  );
  const previousRoot = process.env.SAND_DATA_ROOT;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.SAND_DATA_ROOT = namingDataRoot;
  process.env.DEEPSEEK_API_KEY = "sk-qa-gaps11-naming";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => realFetch(String(input?.url ?? input).replace(DEEPSEEK_BASE_URL, namingServerUrl.replace(/\/v1$/, "")), init);

  try {
    await startNamingServer();
    const router = createCoordinatorInferenceRouter({
      dataDir: namingDataRoot,
      postEvent: () => {},
      dispatchRemote: async (method) => (method === "listAgents" ? [{ id: "agent-1", name: "Библиотека", description: "" }] : undefined),
    });

    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "Первое сообщение" });
    const firstArrivedAt = Date.now();
    while (namingReceived.length < 1 && Date.now() - firstArrivedAt < 8_000) await sleep(50);
    assert.equal(namingReceived.length, 1, "запрос на наименование вообще не ушёл к провайдеру");

    // Второе сообщение приходит, когда первое наименование ещё висит. Если у первого есть
    // какой-то срок, очередь к этому моменту освободится и второй запрос дойдёт.
    await sleep(2_000);
    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "Второе сообщение" });
    await sleep(1_500);

    assert.equal(
      namingReceived.length,
      2,
      `после зависшего на ${namingReceived.length} запрос(ах) второе сообщение перестало доходить до провайдера: очередь наименования встала за первым запросом, у которого нет ни своего срока, ни отмены, — имя беседы не появится, пока HTTP-стек не сдастся сам (в Node это около пяти минут), и никакого сообщения об этом пользователь не увидит`,
    );
  } finally {
    globalThis.fetch = realFetch;
    namingServer?.closeAllConnections?.();
    namingServer?.close();
    if (previousRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousRoot;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
    rmSync(namingDataRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Сторож: ключа нет в исходниках и в файлах данных пользователя
// ---------------------------------------------------------------------------

/** Реальный вид ключа DeepSeek: `sk-` и дальше не меньше 32 шестнадцатеричных символов. */
const KEY_SHAPE = /\bsk-[0-9a-f]{32,}\b/giu;
/** Более широкое семейство, которым пользуются тесты проекта, — чтобы сканер себя проверил. */
const LOOSE_KEY_SHAPE = /\bsk-[A-Za-z0-9_-]{16,}\b/giu;

const SCAN_SKIP = new Set(["node_modules", "dist", ".build", ".git", ".cache", ".tmp-probe-userdata", "research-archives", "tests"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SCAN_SKIP.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const file = path.join(dir, entry.name);
    let size = 0;
    try { size = statSync(file).size; } catch { continue; }
    if (size > 4_000_000) continue;
    out.push(file);
  }
  return out;
}

test("сканер сам умеет находить ключи, и в исходниках их нет", () => {
  const files = walk(repoRoot);
  assert.ok(files.length > 200, `сканер обошёл ${files.length} файлов — слишком мало, чтобы говорить о репозитории`);

  // Самопроверка: на заведомо ключевой строке сканер обязан сработать.
  const selfCheck = 'const k = "sk-0123456789abcdef0123456789abcdef";';
  assert.equal(KEY_SHAPE.test(selfCheck), true, "сканер не узнаёт настоящий вид ключа DeepSeek");
  assert.equal(LOOSE_KEY_SHAPE.test(selfCheck), true, "широкий сканер тоже не узнаёт вид ключа");

  const hits = [];
  for (const file of files) {
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    if (!LOOSE_KEY_SHAPE.test(text)) continue;
    LOOSE_KEY_SHAPE.lastIndex = 0;
    if (KEY_SHAPE.test(text)) hits.push(path.relative(repoRoot, file));
    LOOSE_KEY_SHAPE.lastIndex = 0;
  }
  assert.deepEqual(hits, [], `в исходниках лежит настоящий ключ DeepSeek: ${hits.join(", ")}`);
});

test("в папке данных пользователя ключ не попадает в журналы и в базу агента", () => {
  const home = os.homedir();
  const roots = [path.join(home, ".dbbot"), path.join(home, ".grokbot")].filter((dir) => existsSync(dir));
  if (roots.length === 0) {
    // Папки нет — это тоже результат: у пользователя приложение ещё не запускалось.
    return;
  }
  const suspect = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      const relative = path.relative(root, file).toLowerCase();
      const isJournalOrLog = relative.includes("log") || relative.endsWith(".db") || relative.endsWith(".db-wal") || relative.endsWith(".jsonl");
      if (!isJournalOrLog) continue;
      let text = "";
      try { text = readFileSync(file); } catch { continue; }
      const asText = typeof text === "string" ? text : Buffer.from(text).toString("latin1");
      if (KEY_SHAPE.test(asText)) suspect.push(path.relative(root, file));
      KEY_SHAPE.lastIndex = 0;
    }
  }
  assert.deepEqual(suspect, [], `ключ API найден в файлах, которые читает человек: ${suspect.join(", ")}`);
});