/**
 * Отсутствие ключа модели обязано быть названо точной причиной, а не отправлено пользователю
 * как «ход оборвался, отправьте сообщение снова».
 *
 * Что ломалось. `readDeepSeekApiKey()` (`host/extensions/inference/deepseek-credential.ts:51`)
 * — единственный источник ключа в этой сборке, и когда ключа нет, он бросает
 * `DEEPSEEK_MISSING_KEY_MESSAGE`: «Не задан ключ DeepSeek API. Открой Настройки → DeepSeek …».
 * Этот отказ летит через `deepSeekExecutor` (`provider-session.ts:303`) к абоненту сессии,
 * ретушается абонентом хода и попадает в `describeProviderTurnFailure` (`turn-runtime.ts:832`).
 *
 * Там стоял `isMissingProviderCredential` — проверка по словам: ключ упомянут
 * (`/API[_ -]?KEY/i`) И рядом есть слово отсутствия (`/\b(missing|needs|need|required|absent|not set|not configured)\b/i`).
 * Обе половины написаны по-английски, потому что писались под `OPENAI_COMPATIBLE_API_KEY is missing`
 * из Cursor-ветки. Русское сообщение проходит первую половину (в нём есть `DEEPSEEK_API_KEY`)
 * и проваливает вторую: «не задан» — это не `not set`. Поэтому проверка давала `false`, и ход
 * уезжал в безымянную ветку `else` последней строки функции:
 *
 *   «Этот ход оборвался, ответ от помощника не получен. Сбой случился раньше, чем помощник
 *    успел ответить, и эта сборка не может назвать причину. Отправьте сообщение снова — обычно помогает.»
 *
 * Это ровно то, чего нельзя говорить про отсутствие учётных данных: ключа не станет и от
 * повторного сообщения. Пользователь, у которого ключ не задан, читал «сборка не может назвать
 * причину» про причину, которая лежит в том же процессе, и «отправьте снова» вместо «впишите ключ».
 * Повторял сообщение и получал тот же отказ — так же, как модель повторяла `WebSearch` в
 * `web-search-credential-error.test.mjs`, только в этой сборке до сети дело не доходит вовсе.
 *
 * Почему это не заметили. Тест рядом (`qa-gaps11-deepseek-provider.test.mjs:403`) проверяет,
 * что отказ без ключа уходит на РУССКОКОМ, и на этом успокаивается: «сообщение на русском» он и
 * считал достаточным. Русскоязычность отказа и способ, которым `turn-runtime` его читает, — два
 * разных свойства; второе никто не проверял.
 *
 * Что тест доказывает теперь. Ошибка поднимается НАСТОЯЩИМ `readDeepSeekApiKey()` на пустом
 * хранилище секретов, а не собирается руками, и сразу идёт в настоящий
 * `describeProviderTurnFailure`. Ни одно слово ключа в ответ не попадает: сравнивается
 * присутствие, а не значение.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "dbbot-nokey-"));
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
  ["host", "extensions", "transcript", "turn-runtime.ts"],
  ["host", "extensions", "inference", "deepseek-credential.ts"],
]);
const { describeProviderTurnFailure, isMissingProviderCredential } = loaded["turn-runtime.mjs"];
const { readDeepSeekApiKey, deepSeekApiKeyStatus } = loaded["deepseek-credential.mjs"];

test.after(() => dispose());

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
}

/**
 * Настоящий отказ «ключа нет»: пустой каталог данных, никакой переменной окружения.
 * Возвращает брошенный `Error`, а не текст, — так тест не может разойтись с продуктом.
 */
function realMissingKeyError() {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), "dbbot-nokey-real-"));
  stubSettingsFile(dataRoot);
  const previousRoot = process.env.SAND_DATA_ROOT;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.SAND_DATA_ROOT = dataRoot;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const status = deepSeekApiKeyStatus();
    assert.equal(status.configured, false, "подготовка провалилась: ключ нашёлся, тест проверяет не то состояние");
    try {
      readDeepSeekApiKey();
      assert.fail("подготовка провалилась: readDeepSeekApiKey() вернул ключ вместо отказа");
    } catch (error) {
      return error;
    }
  } finally {
    if (previousRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousRoot;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

test("настоящее отсутствие ключа опознано как отсутствие ключа", () => {
  const raised = realMissingKeyError();

  assert.equal(
    isMissingProviderCredential(raised),
    true,
    "ошибка, которую приложение бросает без ключа, не опознана: turn-runtime уводит такой ход в безымянную ветку и говорит «сборка не может назвать причину»",
  );
});

test("пользователю назван ключ, а не предложено повторить сообщение", () => {
  const raised = realMissingKeyError();
  const notice = describeProviderTurnFailure(raised);

  assert.ok(notice != null, `ход с отказом обязан оставить заметку: ${String(raised)}`);
  assert.match(
    notice.text,
    /не задан ключ/i,
    `причина названа неверно, пользователь уходит чинить не то: ${notice.text}`,
  );
  // Терминальность здесь — это не отсутствие слов «снова»: правильная фраза тоже просит
  // отправить сообщение после того, как ключ вписан. Терминальность — это «сначала почините
  // вот это», а не «повторите и, может, выйдет». Обе безымянные и временные ветки кончаются
  // одной и той же фразой, и её отсутствие — проверка.
  assert.equal(
    /Отправьте сообщение снова\s*—\s*обычно помогает/i.test(notice.text),
    false,
    `на отсутствие ключа сказано «повторите, обычно помогает», а ключа не станет и от повтора: ${notice.text}`,
  );
  assert.equal(
    /не может назвать причину/i.test(notice.text),
    false,
    "сборка отказалась назвать причину, хотя причина — отсутствие ключа — известна ей насквозь",
  );
  assert.match(
    notice.text,
    /[Мм]одель/i,
    `правильная фраза показывает, где чинить: ${notice.text}`,
  );
});

test("заметка о ходе никогда не печатает сам ключ", () => {
  // Значение ключа здесь проверяется только на присутствие и никогда не печатается.
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), "dbbot-nokey-value-"));
  stubSettingsFile(dataRoot);
  const previousRoot = process.env.SAND_DATA_ROOT;
  process.env.SAND_DATA_ROOT = dataRoot;
  process.env.DEEPSEEK_API_KEY = "sk-nokey-guard-7f3a9c21-do-not-print";
  try {
    assert.equal(typeof readDeepSeekApiKey(), "string", "подготовка провалилась: ключ не прочитан");
    const notice = describeProviderTurnFailure(
      Object.assign(new Error("provider call failed"), {
        statusCode: 500,
        requestBodyValues: { apiKey: "sk-nokey-guard-7f3a9c21-do-not-print" },
      }),
    );
    assert.ok(notice != null, "отказ провайдера должен оставить заметку");
    assert.equal(
      notice.text.includes("sk-nokey-guard-7f3a9c21-do-not-print"),
      false,
      "тело запроса с ключом попало в текст, который читает человек",
    );
  } finally {
    if (previousRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousRoot;
    delete process.env.DEEPSEEK_API_KEY;
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("отказ с HTTP-статусом остался на своей фразе и не стал «нет ключа»", () => {
  // Контроль: 401 — это ключ, который отвергли, а не ключ, которого нет. Смысл другой.
  const refused = Object.assign(new Error("Incorrect API key provided"), { statusCode: 401 });
  const notice = describeProviderTurnFailure(refused);

  assert.ok(notice != null, "отказ 401 должен оставить заметку");
  assert.match(notice.text, /401/, `отказ 401 должен называть свой код: ${notice.text}`);
  assert.equal(
    isMissingProviderCredential(refused),
    false,
    "отказ с HTTP-статусом нельзя читать как отсутствие ключа: код пришёл, ключ просто отвергли",
  );
});

test("английская формулировка, под которую проверка писалась, по-прежнему опознана", () => {
  assert.equal(
    isMissingProviderCredential(new Error("OPENAI_COMPATIBLE_API_KEY is missing")),
    true,
    "починка русской половины сломала английскую: обе обязаны опознаваться",
  );
});