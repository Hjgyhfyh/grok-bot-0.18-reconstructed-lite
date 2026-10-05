/**
 * Экран «Провайдер» — единственное место, где заведующая библиотеки задаёт ключ
 * DeepSeek. Показывать ему «не задан ключ», когда приложение этим же ключом
 * работает, хуже, чем не показывать ничего: пользователь вставляет ключ во второй
 * раз и не понимает, зачем.
 *
 * Так и вышло. `getInferenceApiKeyStatus` отвечал «ключа нет», заглядывая только в
 * `settings.json` и в переменную окружения, а все запросы к DeepSeek подписывались
 * функцией `secretDeepSeekApiKey` из того же файла, которая берёт ключ ещё и из
 * системного хранилища секретов (`box-secrets.json`). Лаунчер кладёт ключ именно
 * туда — `process.env` не переживает прыжок в рабочий процесс агента, — то есть
 * ровно в той конфигурации, которой пользуются каждый день, панель говорила «ключа
 * нет» и предлагала вставить ключ повторно.
 *
 * Тест закрывает три вещи:
 *   1. ответ панели и ответ соседнего метода `getInferenceRouter` считаются тем же
 *      читателем, что и запрос к провайдеру, во всех трёх хранилищах;
 *   2. когда ключа действительно нет, панель честно говорит об этом по-русски и не
 *      выдумывает наличие ключа;
 *   3. подсказка про ключ ведёт в раздел настроек, который реально есть: раньше в
 *      ней было «Открой Настройки → DeepSeek», а раздела с таким названием в
 *      навигации нет, он называется «Провайдер».
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = mkdtempSync(path.join(os.tmpdir(), "dbbot-settings-key-build-"));
test.after(() => rmSync(buildDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: path.join(buildDir, outfile),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  return import(`${pathToFileURL(path.join(buildDir, outfile)).href}?${Date.now()}`);
}

const { createMainEdgeHandlers } = await bundle("source/electron-main/main-edge.ts", "main-edge.mjs");
const { SandSettingsStore } = await bundle("source/shared/node/settings/sand-settings-store.ts", "settings-store.mjs");

/** Настройки на настоящих файлах: пустой `settings.json` проходит те же миграции, что и у пользователя. */
function freshStore() {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), "dbbot-settings-key-data-"));
  writeFileSync(
    path.join(dataRoot, "settings.json"),
    JSON.stringify({ version: 1, settingsMigrations: ["downgrade-persisted-max-fast", "local-inference-provider", "deepseek-only"] }, null, 2),
    "utf8",
  );
  return { dataRoot, store: new SandSettingsStore(path.join(dataRoot, "settings.json")) };
}

/**
 * Ровно то состояние, которое описывает `deepseek-credential.ts`: лаунчер положил
 * ключ в системное хранилище, переменной окружения нет, в `settings.json` его нет.
 */
function handlersWith({ store, secretStoreKey, envKey }) {
  const previousEnv = process.env.DEEPSEEK_API_KEY;
  if (envKey == null) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = envKey;
  const handlers = createMainEdgeHandlers({
    settingsStore: store,
    getInferenceApiKey: () => store.getInferenceApiKey() ?? null,
    readCustomEndpointApiKey: async (name) => (name === "DEEPSEEK_API_KEY" ? secretStoreKey ?? null : null),
    readHostSettingsFromBox: async () => ({}),
    syncHostSettingsToBox: async (value) => value,
  });
  return {
    handlers,
    restore() {
      if (previousEnv === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previousEnv;
    },
  };
}

test("панель настроек признаёт ключ оттуда, откуда приложение его берёт", async () => {
  const cases = [
    { where: "хранилище секретов", settingsKey: undefined, secretStoreKey: "sk-iz-box-secrets", envKey: undefined },
    { where: "settings.json", settingsKey: "sk-iz-settings", secretStoreKey: undefined, envKey: undefined },
    { where: "переменная окружения", settingsKey: undefined, secretStoreKey: undefined, envKey: "sk-iz-env" },
  ];
  for (const scenario of cases) {
    const { dataRoot, store } = freshStore();
    if (scenario.settingsKey != null) store.setInferenceApiKey(scenario.settingsKey);
    const { handlers, restore } = handlersWith({ store, secretStoreKey: scenario.secretStoreKey, envKey: scenario.envKey });
    try {
      const status = await handlers.getInferenceApiKeyStatus({});
      assert.equal(
        status.configured,
        true,
        `ключ лежит в ${scenario.where}, приложение им подписывает запросы, а панель сообщает, что ключа нет`,
      );
      assert.equal(status.message, null, `панель ругается на ключ из ${scenario.where}: «${status.message}»`);
      assert.equal(
        (await handlers.getInferenceRouter({})).apiKeyConfigured,
        true,
        `«Провайдер» по соседнему методу тоже отрицает ключ из ${scenario.where}, и пользователь верит обоим ответам`,
      );
    } finally {
      restore();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  }
});

test("когда ключа действительно нет, панель говорит об этом по-русски и не выдумывает наличие", async () => {
  const { dataRoot, store } = freshStore();
  const { handlers, restore } = handlersWith({ store, secretStoreKey: undefined, envKey: undefined });
  try {
    const status = await handlers.getInferenceApiKeyStatus({});
    assert.equal(status.configured, false, "ключа нет, а панель говорит, что он есть, и пользователь ищет проблему не там");
    assert.match(status.message, /[\u0400-\u04ff]/u, `сообщение не на русском: ${status.message}`);
    assert.match(status.message, /DeepSeek/, `сообщение не называет, чего именно не хватает: ${status.message}`);
    assert.match(status.message, /DEEPSEEK_API_KEY/, `сообщение не называет, где задать ключ: ${status.message}`);
    assert.equal(
      (await handlers.getInferenceRouter({})).apiKeyConfigured,
      false,
      "«Провайдер» обещает ключ, которого нет, и объяснить отказ потом будет нечем",
    );
  } finally {
    restore();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("подсказка про ключ ведёт в раздел настроек, который есть в навигации", async () => {
  // Разделы берём из исходника навигации, а не из памяти о них.
  const navigation = readFileSync(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/view.tsx"),"utf8");
  const sectionLabels = [...navigation.matchAll(/label: "([^"]+)", icon:/g)].map((match) => match[1]);
  assert.ok(sectionLabels.includes("Провайдер"), `в навигации настроек нет раздела «Провайдер»: ${JSON.stringify(sectionLabels)}`);

  const { dataRoot, store } = freshStore();
  const { handlers, restore } = handlersWith({ store, secretStoreKey: undefined, envKey: undefined });
  try {
    const { message } = await handlers.getInferenceApiKeyStatus({});
    assert.equal(
      sectionLabels.find((label) => new RegExp(`Настройки\\s*→\\s*${label}`, "u").test(message ?? "")),
      "Провайдер",
      `подсказка про ключ отправляет пользователя в раздел, которого нет: «${message}»`,
    );
  } finally {
    restore();
    rmSync(dataRoot, { recursive: true, force: true });
  }

  // Тот же текст продублирован в панели запасным вариантом: если основной процесс
  // промолчит, пользователь всё равно должен увидеть верный путь.
  const panelSource = readFileSync(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/panels.tsx"),"utf8");
  const fallback = /apiKeyMessage \?\? "([^"]+)"/.exec(panelSource)?.[1];
  assert.ok(fallback != null, "в панели нет запасного текста про отсутствующий ключ, и при молчании главного процесса строка останется пустой");
  assert.equal(
    sectionLabels.find((label) => fallback.includes(`Настройки → ${label}`)),
    "Провайдер",
    `запасная подсказка в панели отправляет в раздел, которого нет: «${fallback}»`,
  );
});

test("панель пишет «Ключ сохранён» только когда главный процесс так ответил", async () => {
  const source = readFileSync(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/panels.tsx"),"utf8");
  assert.match(
    source,
    /apiKeyConfigured\s*\?\s*"Ключ сохранён/,
    "панель показывает «Ключ сохранён» независимо от ответа главного процесса, и пользователю показывают несуществующий ключ",
  );
  assert.match(
    source,
    /placeholder=\{apiKeyConfigured \? [^}]*:[^}]*\}/,
    "поле ввода не подсказывает, что ключ уже сохранён, и пользователь вставит его повторно без причины",
  );
});