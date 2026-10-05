import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

// Демон локальных команд держит единственную границу — свой корень.
// `createLocalExecPermissionsService` в `source/local-exec-daemon/production-executor.ts`
// отвечает за неё для `Read`, `LS`, записи и рабочего каталога `Shell`, и до
// этого её граница проверялась только тем, что корень не совпадает с профилем
// пользователя (`local-exec-root-is-not-the-user-profile.test.mjs`). Что именно
// за пределами корня остаётся доступным, никто не проверял.
//
// Проверка нужна ещё по одной причине. Вложения пользователя лежат в
// `<корень данных>/agents/<uuid>/attachments/`, а корень демона —
// `<корень данных>/box-workspace`. Это соседние папки, а не вложенные, поэтому
// исходный путь вложения от демона закрыт, и агент читает только копию,
// положенную в `/workspace/uploads` (`host/extensions/attachments/box-staging.ts`).
// Пока это не заявлено в тесте, следующий инженер решит, что вложение потеряно,
// и «починит» это расширением корня до всего диска.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadExecutor() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "dbbot-local-exec-guard-"));
  const outfile = path.join(directory, "production-executor.cjs");
  await build({
    entryPoints: [path.join(repoRoot, "source", "local-exec-daemon", "production-executor.ts")],
    outfile,
    bundle: true,
    // CommonJS: связка `iconv-lite` тянет `safer-buffer`, а тот делает
    // `require("buffer")` в рантайме. В ESM-пакете такой вызов превращается в
    // «Dynamic require of "buffer" is not supported», и модуль не грузится.
    format: "cjs",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  return { module: createRequire(import.meta.url)(outfile), dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const loaded = await loadExecutor();
test.after(() => loaded.dispose());
const { createLocalExecPermissionsService } = loaded.module;

// Кириллица в пути — не украшение. Заведующая работает на русском компьютере,
// её профиль и рабочий корень названы по-русски, и проверка на латинском
// временном каталоге ничего не говорит о том, работает ли демон у неё.
const sandRoot = mkdtempSync(path.join(os.tmpdir(), "Проверка Бота-"));
test.after(() => rmSync(sandRoot, { recursive: true, force: true }));

const workspaceRoot = path.join(sandRoot, "box-workspace");
const attachmentsDir = path.join(sandRoot, "agents", "0f3a5c1e-7b42-4a19-9f0d-2c6b8e51a7d3", "attachments");
mkdirSync(path.join(workspaceRoot, "Заявки"), { recursive: true });
mkdirSync(attachmentsDir, { recursive: true });
writeFileSync(path.join(workspaceRoot, "Заявки", "протокол.txt"), "Принято решение обновить фонд", "utf8");
writeFileSync(path.join(attachmentsDir, "протокол.txt"), "Принято решение обновить фонд", "utf8");
writeFileSync(path.join(sandRoot, "box-secrets.json"), "{}", "utf8");
writeFileSync(path.join(sandRoot, "settings.json"), JSON.stringify({ localToolPermission: "always" }), "utf8");

const service = createLocalExecPermissionsService({
  root: workspaceRoot,
  env: { SAND_DATA_ROOT: sandRoot },
});

test("проверка границы не проходит на пустом корне — корень и файлы на месте", () => {
  assert.ok(service.escapesRoot === undefined ? false : typeof service.escapesRoot === "function", "сервис не отдал escapesRoot: проверка ниже ничего не значит");
  assert.equal(service.escapesRoot(path.join(workspaceRoot, "Заявки", "протокол.txt")), false, "корень на месте, а файл внутри него объявлен выходом за границу");
});

test("агент читает рабочий корень, в том числе файл с кириллицей в имени", async () => {
  assert.equal(
    await service.shouldBlockRead(path.join(workspaceRoot, "Заявки", "протокол.txt")),
    false,
    "русский путь внутри корня отклонён: на машине заведующей весь рабочий корень назван по-русски, и у агента не будет ни Read, ни LS",
  );
  assert.equal(
    await service.shouldBlockRead("Заявки\\протокол.txt"),
    false,
    "относительный путь внутри корня отклонён: агент почти всегда передаёт путь относительно корня",
  );
});

test("агент не доходит до Program Files и до корня диска", async () => {
  assert.equal(await service.shouldBlockRead("C:\\Program Files\\"), true, "чтение Program Files разрешено демону, который работает от имени пользователя");
  assert.equal(await service.shouldBlockRead("C:\\"), true, "корень диска C:\\ доступен агенту — это обход всей песочницы через ..");
  const drive = process.env.SystemDrive ?? "C:";
  assert.equal(await service.shouldBlockRead(`${drive}\\`), true, `корень диска ${drive} доступен агенту`);
});

test("агент не доходит до папки с ключом и до настроек хоста", async () => {
  assert.equal(await service.shouldBlockRead(path.join(sandRoot, "box-secrets.json")), true, "файл с секретами хоста доступен агенту");
  assert.equal(await service.shouldBlockRead(path.join(sandRoot, "settings.json")), true, "файл настроек хоста доступен агенту");
  assert.equal(await service.shouldBlockRead(path.join(sandRoot, "..", "..", "Пользователи")), true, "выход вверх из корня прошёл: граница держится только на одном уровне");
});

test("агент читает приложенный файл по копии в рабочем корне, а не по исходному пути", async () => {
  // `box-staging.ts` кладёт вложение в `/workspace/uploads/<имя>` и показывает
  // агенту именно этот путь. Исходный путь в `<корень данных>/agents/…` обязан
  // оставаться закрытым: если открыть и его, демон перестанет различать «свою»
  // папку и «чужие», и правило «корень — это всё, что агенту видно» перестанет
  // быть проверяемым. Закрытость исходного пути и есть то, что делает копию
  // в uploads единственным верным ответом.
  assert.equal(
    await service.shouldBlockRead(path.join(attachmentsDir, "протокол.txt")),
    true,
    "исходный путь вложения открыт демону, хотя рабочий корень ему не принадлежит",
  );
  assert.equal(
    await service.shouldBlockRead(path.join(workspaceRoot, "uploads", "протокол.txt")),
    false,
    "копия вложения внутри рабочего корня отклонена: агент не прочитает ни одного приложенного файла",
  );
});

test("Shell не запускается с рабочим каталогом за пределами корня", async () => {
  const decision = await service.shouldBlockShellCommand(null, "type file.txt", { workingDirectory: path.join(sandRoot, "agents") });
  assert.equal(decision.kind, "block", "Shell стартовал с каталогом агентов: список папок и содержимое вложений доступны без всякой проверки путей");
  const allowed = await service.shouldBlockShellCommand(null, "dir", { workingDirectory: workspaceRoot });
  assert.equal(allowed.kind, "allow", "Shell отказан внутри собственного корня — у агента не остаётся команды вообще");
});

test("запись за пределы корня закрыта так же, как чтение", async () => {
  assert.equal(
    await service.shouldBlockWrite(null, path.join(sandRoot, "settings.json"), "x"),
    true,
    "агент может переписать настройки хоста, в том числе отключить себе ограничения",
  );
  assert.equal(await service.shouldBlockWrite(null, path.join(workspaceRoot, "Заявки", "новый.txt"), "x"), false, "запись внутри корня запрещена — агент не может сохранить результат работы");
});

test("настройка localToolPermission: never закрывает демон целиком, даже внутри корня", async () => {
  // Настройка читается из `<SAND_DATA_ROOT>/settings.json`, поэтому корень
  // закрытого демона — это отдельный каталог данных.
  const closedSandRoot = mkdtempSync(path.join(os.tmpdir(), "Проверка Бота-never-"));
  test.after(() => rmSync(closedSandRoot, { recursive: true, force: true }));
  writeFileSync(path.join(closedSandRoot, "settings.json"), JSON.stringify({ localToolPermission: "never" }), "utf8");
  const closed = createLocalExecPermissionsService({ root: closedSandRoot, env: { SAND_DATA_ROOT: closedSandRoot } });
  const decision = await closed.shouldBlockShellCommand(null, "dir", { workingDirectory: closedSandRoot });
  assert.equal(
    decision.kind,
    "block",
    "при localToolPermission=never команда внутри корня всё равно разрешена: переключатель в панели настроек не влияет на демон",
  );
  assert.equal(await closed.shouldBlockMcp(null), true, "при localToolPermission=never MCP остаётся включён");
});