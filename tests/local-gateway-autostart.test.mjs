import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Пользователь запускал `DB Bot.exe` двойным кликом, и программа не работала:
 * «Не удаётся связаться с компьютером», вечное «Reconnecting», ответа модели
 * нет. Причин было пять, и все пять молчали.
 *
 * 1. `SAND_HOST_GATEWAY_URL` ставил только лаунчер `scripts/start-grokbot.ps1`,
 *    которого в поставке нет. Хост и координатор поднимались, но мост к
 *    компьютеру не знал адреса. Теперь главный процесс Electron сам поднимает
 *    локальный шлюз и выставляет переменные ДО инициализации служб.
 * 2. Ключ лежал в файле без проверки прав. Теперь ключ случайный, на 32 байта,
 *    и доступ к файлу сужается до текущего пользователя.
 * 3. Точка входа `box-exec-daemon` лежит внутри `app.asar`, где нет настоящего
 *    каталога. `spawn` с таким `cwd` падал с ENOENT, у процесса не было pid, и
 *    хост умирал строкой «did not receive a pid» — без слова про asar.
 * 4. Точка входа координатора была и в `scripts/build-from-source.mjs`, и в
 *    самом модуле. Координатор собирался дважды, оба состава бились за одни и те
 *    же три порта, и процесс завершался с кодом 0 без единой строки в журнал.
 * 5. Схема инструмента `Task` уходила к DeepSeek без `type: "object"`, и
 *    провайдер отвергал весь запрос: ход проходил, ответа не было.
 *
 * Тесты ниже читают исходники и собранную сцену: сцена — потому что поломки
 * 3 и 4 живут между сборкой и запуском, и статическая проверка их не видит.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(repoRoot, relative), "utf8");

test("главный процесс поднимает локальный шлюз до инициализации служб, а не ищет готовый", () => {
  const autostart = read("source/electron-main/local-gateway/local-gateway-autostart.ts");
  const services = read("source/electron-main/main-production-services.ts");

  assert.match(autostart, /SAND_HOST_GATEWAY_URL/,
    "поднятый шлюз обязан назвать себя в переменной, которую читает мост к компьютеру");
  assert.match(autostart, /LOCAL_GATEWAY_URL_ENV = "SAND_HOST_GATEWAY_URL"/,
    "имя переменной шлюза разошлось с тем, что читает мост к компьютеру");
  assert.match(autostart, /ELECTRON_RUN_AS_NODE: "1"/,
    "хост запускается тем же файлом, что и окно, и без этой переменной он не станет Node");
  assert.match(autostart, /delete childEnv\[LOCAL_GATEWAY_URL_ENV\]/,
    "дочерний хост не должен наследовать адрес шлюза: он поднимает свой");
  assert.match(autostart, /delete childEnv\[LOCAL_GATEWAY_TOKEN_ENV\]/,
    "ключ шлюза не должен доезжать до хоста копией окружения, только в SAND_GATEWAY_TOKEN");

  const servicesAt = services.indexOf("bootstrapLocalGatewayForDesktop(");
  const foundationAt = services.indexOf("initializeFoundation()");
  const windowAt = services.search(/createWindow\(/);
  assert.ok(servicesAt > 0 && foundationAt > 0,
    "поднятие шлюза и основание инициализации должны находиться в коде сборки служб");
  assert.ok(servicesAt > foundationAt,
    "шлюз поднимается после основания, иначе фундамент останется без него");
  assert.ok(windowAt < 0 || windowAt > servicesAt,
    "окно открывается раньше шлюза, и переменная не успевает дойти до потребителей");
});

test("ключ шлюза случайный, не зашитый в исходники и с правами только текущего пользователя", () => {
  const token = read("source/electron-main/local-gateway/local-gateway-token.ts");
  const launcher = read("scripts/start-grokbot.ps1");

  assert.match(token, /randomBytes\(LOCAL_GATEWAY_TOKEN_BYTES\)/,
    "ключ должен рождаться случайно, а не читаться из исходника");
  assert.match(token, /flag: "wx"/,
    "запись должна идти с признаком «создать», иначе два запуска затирают ключ друг друга");
  assert.match(token, /icacls\.exe/,
    "права на файл с ключом должны сужаться до текущего пользователя");
  assert.match(launcher, /icacls|RandomNumberGenerator/,
    "подход лаунчера должен быть переиспользован, а не выдуман заново");
  assert.doesNotMatch(
    token,
    /=\s*"(?:[A-Za-z0-9_-]{40,})"/,
    "в модуле ключа не должно быть ни одного готового секрета в строке",
  );
  assert.doesNotMatch(
    token,
    /LOCAL_GATEWAY_TOKEN_FILENAME\s*=\s*"launcher-gateway-token\./,
    "имя файла ключа не должно совпадать с файлом лаунчера, иначе старая и новая правка столкнутся",
  );
});

test("запуск box-exec-daemon перебирает рабочий каталог, потому что каталога внутри архива нет", () => {
  const daemon = read("source/host/box/exec-daemon-process.ts");

  assert.match(daemon, /resolveBoxExecDaemonCwdCandidates/,
    "рабочий каталог демона должен выбираться попыткой запуска, а не проверкой каталога");
  assert.doesNotMatch(daemon, /statSync\(candidate\)/,
    "statSync внутри asar отвечает «каталог есть» даже когда его нет на диске");
  assert.match(daemon, /child\.once\("error"/,
    "настоящая причина отказа запуска терялась в проверке pid до события error");
  assert.match(daemon, /throw new Error\(`box exec-daemon не запустился/,
    "отказ должен называть точку входа и настоящую причину запуска");
  assert.doesNotMatch(daemon, /throw new Error\(`box exec-daemon child did not receive a pid/,
    "сообщение без причины и без команды только скрывало отказ");
});

test("координатор собирается один раз: точка входа живёт в сборке, а не в модуле", () => {
  const main = read("source/node-agent-coordinator/main.ts");
  const build = read("scripts/build-from-source.mjs");

  assert.doesNotMatch(main, /import\.meta\.url === pathToFileURL/,
    "модуль координатора снова запускает себя сам и собирается дважды");
  assert.match(build, /void composeCoordinator\(\)/,
    "единственная точка входа координатора обязана остаться в сборке");
  const calls = (main.match(/composeCoordinator\(/g) ?? []).length;
  assert.equal(calls, 1,
    "в модуле координатора должно быть ровно одно упоминание состава, без автозапуска");
});

test("отказ команды шлюза называет и команду, и причину, иначе отказ не ищется", () => {
  const dispatcher = read("source/node-agent-coordinator/gateway/gateway-request-dispatcher.ts");
  const gatewayServer = read("source/host/gateway-server.ts");

  assert.match(dispatcher, /failureFor\(error, method\)/,
    "отказ должен называть команду, иначе в интерфейсе остаётся код без следа");
  assert.match(gatewayServer, /команда \$\{method\} не выполнена/,
    "журнал хоста должен писать, какая команда не выполнилась, и с чем");
});

test("схема инструмента приходит к провайдеру развёрнутой и без позиционных кортежей", () => {
  const providers = read("source/host/extensions/inference/provider-session.ts");

  assert.match(providers, /parameters: jsonSchema\(normalizeToolParameters\(parameters\)\)/,
    "схема инструмента уходит к провайдеру как есть, и ход падает на первом же `Task`");
  assert.match(providers, /function normalizeToolParameters\(schema: unknown, depth = 0\)/,
    "в файле нет нормализации схемы инструмента");
  assert.match(providers, /typeof record\.type === "string" \? record/,
    "нормализация не должна переписывать схему, у которой тип уже есть");
  assert.match(providers, /function normalizePositionalItems\(/,
    "позиционный кортеж в `items` DeepSeek не принимает, а один такой инструмент отменяет весь ход");
});

test("сборка не строит клиентов службы Cursor: нет адреса — нет и клиента", () => {
  const guarded = [
    "source/host/extensions/auto-review/sand-backend-smart-mode-classifier-exec.ts",
    "source/host/extensions/attachments/generate-image-service.ts",
    "source/host/extensions/inference/sand-labeling.ts",
  ];
  for (const file of guarded) {
    const source = read(file);
    assert.match(source, /getSandInferenceBackendUrl\(\)\.length === 0/,
      `${file} строит клиент Cursor без проверки адреса и роняет ход`);
  }
  const production = read("source/host/extensions/inference/production.ts");
  assert.match(production, /SAND_WEB_SEARCH_UNAVAILABLE_MESSAGE/,
    "отказ веб-поиска должен быть понятным и по-русски, а не служебным кодом");
  assert.doesNotMatch(production, /return undefined;/,
    "инструмент веба объявлен по наличию функции, и `undefined` роняет ход «service is not bound»");
});

test("сообщения об отказе хода по-русски: их читает человек, а не инженер", () => {
  const runtime = read("source/host/extensions/transcript/turn-runtime.ts");
  const start = runtime.indexOf("export function describeProviderTurnFailure(");
  const end = runtime.indexOf("export function describeEmptyDeliveryNotice(");
  assert.ok(start > 0 && end > start,
    "в модуле хода нет функции, которая описывает отказ по-русски");
  const notices = runtime.slice(start, end);
  assert.doesNotMatch(notices, /"The (model provider|agent|connection|backend)/,
    "пользователю показывают английский отказ чужой программы");
  assert.match(notices, /title = "Для модели не задан ключ\.";/,
    "отказ должен говорить по-русски и подсказывать, что делать");
});

test("журнал координатора переживает отказ хоста: в нём есть причина, а не только факт запуска", () => {
  const provider = read("source/electron-main/coordinator/production-provider.ts");
  const runtime = read("source/host/extensions/transcript/turn-runtime.ts");

  assert.match(provider, /stdio: "pipe"/,
    "без перехвата потоков координатор умирает молча");
  assert.match(provider, /координатор завершился, код=/,
    "код выхода координатора должен попадать в журнал");
  assert.match(runtime, /ход не ответил/,
    "ход, который не ответил, обязан оставить в журнале хоста свою причину");
});

test("живая сцена указывает на ту же точку входа, что и упаковка", () => {
  const scenePath = path.join(repoRoot, ".build", "app", "package.json");
  if (!existsSync(scenePath)) {
    // Сцены нет: сборка ещё не запускалась. Проверять тут нечего.
    return;
  }
  const scene = JSON.parse(readFileSync(scenePath, "utf8"));
  assert.equal(scene.main, "dist/electron-main/main.cjs",
    "точка входа сцены разошлась с той, что запускает упаковка");
  for (const bundle of [
    path.join("dist", "host", "host-main.cjs"),
    path.join("dist", "box-exec-daemon", "main.cjs"),
    path.join("dist", "node-agent-coordinator", "main.cjs"),
  ]) {
    assert.ok(existsSync(path.join(repoRoot, ".build", "app", bundle)),
      `в сцене нет ${bundle}: главный процесс не сможет ни поднять шлюз, ни форкнуть координатора`);
  }
});