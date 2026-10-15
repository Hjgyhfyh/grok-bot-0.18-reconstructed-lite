import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// Содержимое присланных файлов не доходило до модели. Движок чтения документов
// был готов, `buildAttachmentDocumentsNote` складывал текст каждого файла в
// блок «## File N: имя», а `attachments.readDocuments` возвращал этот блок — но
// никто его не вызывал. `prompt-collector-glue.ts` звал `buildAttachedFilesNote`,
// который принимает только пути и размеры, и prompt уходил в DeepSeek со
// списком файлов без единого байта их содержимого. Заведующая просила «свести
// четыре файла в один отчёт» и получала выдуманный ответ или отказ.
//
// Тесты ниже собирают промпт тем же кодом, что и живой ход, и читают его
// текст. Если содержимое снова перестанет доходить, тесты упадут на файлах
// `mart.docx`, `plany.xlsx` и `zapis.txt`, а не на вызовах движка.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const AGENT_ID = "b1f0c0de-0000-4000-8000-00000000abcd";

let reportTools;   // source/packages/report-tools — чем бот пишет отчёты
let service;       // attachments-service — метод readDocuments боевого хоста
let glueModule;    // prompt-collector-glue — чтение и сборка текста хода
let composerModel; // frontend model — лимит вложений и отбор файлов
let desktopModule; // frontend desktop — сообщения об отказе прикрепления
let sandboxRoot;   // корень данных, который читает хост
let attachmentsDir;
let attachments;

const MARKDOWN = [
  "Протокол заседания",
  "",
  "## Планы на квартал",
  "",
  "Абзац с числом 42 и словом «библиотека».",
  "",
  "- Club Omega",
  "",
  "| № | Мероприятие | Срок |",
  "|---|---|---|",
  "| 1 | Заседание клуба «Омега» | 12.03.2026 |",
].join("\n");

const requireBanner = {
  js: 'import { createRequire as __dbbotCreateRequire } from "node:module";\nconst require = __dbbotCreateRequire(import.meta.url);',
};

const bundle = async (entry, out) => {
  const outfile = path.join(buildDir, out);
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    banner: requireBanner,
  });
  return await import(pathToFileURL(outfile).href);
};

let buildDir;

before(async () => {
  buildDir = await mkdtemp(path.join(os.tmpdir(), "dbbot-attachment-prompt-"));
  sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "dbbot-attachment-sandbox-"));
  // Хост читает и пишет вложения только под своим корнем данных. Подменяем его
  // на временную папку, чтобы тест не трогал данные пользователя.
  process.env.SAND_DATA_ROOT = sandboxRoot;

  reportTools = await bundle(path.join("source", "packages", "report-tools", "index.ts"), "report-tools.mjs");
  service = await bundle(path.join("source", "host", "extensions", "attachments", "attachments-service.ts"), "attachments-service.mjs");
  glueModule = await bundle(path.join("source", "host", "runner", "prompt-collector-glue.ts"), "prompt-collector-glue.mjs");
  composerModel = await bundle(path.join("frontend", "src", "recovered", "features", "conversation", "workspace", "model.ts"), "composer-model.mjs");
  desktopModule = await bundle(path.join("frontend", "src", "recovered", "features", "conversation", "workspace", "desktop.ts"), "composer-desktop.mjs");

  attachmentsDir = path.join(sandboxRoot, "agents", AGENT_ID, "attachments");
  await mkdir(attachmentsDir, { recursive: true });
  await writeFile(path.join(attachmentsDir, "mart.docx"), await reportTools.blocksToDocx(reportTools.reportBlocks(MARKDOWN)));
  await writeFile(path.join(attachmentsDir, "plany.xlsx"), buildXlsx(reportTools));
  await writeFile(path.join(attachmentsDir, "zapis.txt"), "Протокол заседания: кворум есть.", "utf8");
  await writeFile(path.join(attachmentsDir, "photo.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  attachments = ["mart.docx", "plany.xlsx", "zapis.txt", "photo.png"].map((name) => path.join(attachmentsDir, name));
});

after(async () => {
  if (buildDir !== undefined) await rm(buildDir, { recursive: true, force: true });
  if (sandboxRoot !== undefined) await rm(sandboxRoot, { recursive: true, force: true });
});

/** Минимальный `.xlsx`: `writeZip` из report-tools, настоящий состав частей. */
function buildXlsx(tools) {
  const encoder = new TextEncoder();
  const shared = ["№", "Мероприятие", "Срок", "1", "Заседание клуба «Омега»", "12.03.2026"];
  const sheetRows = [
    { row: 1, cells: [{ col: "A", v: 0 }, { col: "B", v: 1 }, { col: "C", v: 2 }] },
    { row: 2, cells: [{ col: "A", v: 3 }, { col: "B", v: 4 }, { col: "C", v: 5 }] },
  ];
  const worksheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows
    .map(({ row, cells }) => `<row r="${row}">${cells.map((cell) => `<c r="${cell.col}${row}" t="s"><v>${cell.v}</v></c>`).join("")}</row>`)
    .join("")}</sheetData></worksheet>`;
  const sharedStrings = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
    .map((value) => `<si><t xml:space="preserve">${value}</t></si>`)
    .join("")}</sst>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Планы" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  return tools.writeZip([
    { name: "xl/workbook.xml", data: encoder.encode(workbook) },
    { name: "xl/sharedStrings.xml", data: encoder.encode(sharedStrings) },
    { name: "xl/worksheets/sheet1.xml", data: encoder.encode(worksheet) },
  ]);
}

/** Хост в том виде, в каком его собирает `host-runner-composition.ts`. */
function hostFor(readCalls) {
  const attachmentsApi = service.createAttachmentsService({ auth: {}, ctx: {}, box: {} });
  return {
    isSubagentRunner: false,
    remoteBoxHasDesktop: false,
    resolveBoxId: () => AGENT_ID,
    getConversationId: () => AGENT_ID,
    getRemoteBoxAvailable: () => false,
    async readAttachmentDocuments(paths) {
      readCalls.push([...paths]);
      const read = await attachmentsApi.readDocuments({ paths, agentId: AGENT_ID });
      return read?.note ?? "";
    },
  };
}

const promptOf = (assembly) => assembly.action.action.value.userMessage.text;

const attachedSizes = () => new Map([
  [path.join(attachmentsDir, "mart.docx"), 4096],
  [path.join(attachmentsDir, "plany.xlsx"), 2048],
  [path.join(attachmentsDir, "zapis.txt"), 64],
  [path.join(attachmentsDir, "photo.png"), 8],
]);

test("текст хода содержит содержимое docx, xlsx и txt под именами файлов", async () => {
  const readCalls = [];
  const glue = glueModule.createPromptCollectorGlue(hostFor(readCalls));
  const assembly = await glue.assembleTurnAction({
    trimmedPrompt: "Сведи эти файлы в один отчёт.",
    options: { attachedFilePaths: attachments, attachedFileSizes: attachedSizes() },
    compactionEpoch: () => 0,
  });
  const text = promptOf(assembly);

  assert.match(text, /Сведи эти файлы в один отчёт\./, "текст пользователя должен остаться в начале промпта");
  assert.match(text, /## File 1: mart\.docx/, "первый файл не назван в блоке с содержимым");
  assert.match(text, /## File 2: plany\.xlsx/, "второй файл не назван в блоке с содержимым");
  assert.match(text, /## File 3: zapis\.txt/, "третий файл не назван в блоке с содержимым");
  assert.match(text, /Протокол заседания\n/, "содержимое docx не попало в промпт");
  assert.match(text, /Абзац с числом 42 и словом «библиотека»\./, "абзац из docx не попал в промпт");
  assert.match(text, /Заседание клуба «Омега»/, "ячейка из xlsx не попала в промпт");
  assert.match(text, /кворум есть/, "текст из txt не попал в промпт");
  assert.equal(readCalls.length, 1, "содержимое должно читаться один раз за ход, а не по разу на файл");
});

test("содержимое файлов стоит под тем же заголовком, что и сам файл", async () => {
  const glue = glueModule.createPromptCollectorGlue(hostFor([]));
  const assembly = await glue.assembleTurnAction({
    trimmedPrompt: "Что в файлах?",
    options: { attachedFilePaths: attachments, attachedFileSizes: attachedSizes() },
    compactionEpoch: () => 0,
  });
  const text = promptOf(assembly);

  for (const [filename, content] of [
    ["mart.docx", "Абзац с числом 42"],
    ["plany.xlsx", "12.03.2026"],
    ["zapis.txt", "кворум есть"],
  ]) {
    const header = `## File ${["mart.docx", "plany.xlsx", "zapis.txt"].indexOf(filename) + 1}: ${filename}`;
    const headerAt = text.indexOf(header);
    assert.ok(headerAt >= 0, `в промпте нет заголовка ${header}`);
    const block = text.slice(headerAt, headerAt + 400);
    assert.ok(
      block.includes(content),
      `под заголовком «${header}» нет содержимого файла: модель получила имя без текста`,
    );
  }
});

test("живой путь хода (assembleGeneratedTurnAction) тоже несёт содержимое файлов", async () => {
  const glue = glueModule.createPromptCollectorGlue(hostFor([]));
  const assembly = await glue.assembleGeneratedTurnAction({
    runCtx: {},
    trimmedPrompt: "Сведи эти файлы в один отчёт.",
    options: { attachedFilePaths: attachments, attachedFileSizes: attachedSizes() },
    compactionEpoch: () => 0,
  });
  const text = promptOf(assembly);

  assert.match(text, /## File 1: mart\.docx/, "живой путь хода потерял блок с содержимым");
  assert.match(text, /Абзац с числом 42 и словом «библиотека»\./, "живой путь хода не отдал содержимое docx модели");
  assert.match(text, /Use ALL of the files together/, "в промпте нет указания сводить все файлы");
});

test("фотография в промпте не превращается в отказ «прочитать нечем»", async () => {
  const readCalls = [];
  const glue = glueModule.createPromptCollectorGlue(hostFor(readCalls));
  const assembly = await glue.assembleTurnAction({
    trimmedPrompt: "Что на фото?",
    options: { attachedFilePaths: attachments, attachedFileSizes: attachedSizes() },
    compactionEpoch: () => 0,
  });
  const text = promptOf(assembly);

  assert.equal(readCalls.length, 1, "содержимое вложений должно читаться один раз за ход");
  assert.equal(readCalls[0].some((filePath) => filePath.endsWith("photo.png")), false, "фотографию не надо читать движком документов — модель видит её вложением");
  assert.doesNotMatch(text, /## File \d+: photo\.png/, "фотография не должна попадать в блок содержимого как нечитаемый документ");
});

test("ход без вложений не меняется: ни одного лишнего блока", async () => {
  const glue = glueModule.createPromptCollectorGlue(hostFor([]));
  const assembly = await glue.assembleTurnAction({
    trimmedPrompt: "Просто вопрос.",
    options: {},
    compactionEpoch: () => 0,
  });
  assert.equal(promptOf(assembly), "Просто вопрос.", "без вложений промпт должен остаться ровно тем, что написал пользователь");
});

test("читающий движок не сломался: метод readDocuments читает файл с диска", async () => {
  const attachmentsApi = service.createAttachmentsService({ auth: {}, ctx: {}, box: {} });
  const read = await attachmentsApi.readDocuments({
    paths: [path.join(attachmentsDir, "mart.docx")],
    agentId: AGENT_ID,
  });
  assert.ok(read != null, "метод readDocuments вернул null на файле из папки вложений агента");
  assert.match(read.note, /## File 1: mart\.docx/, "метод не назвал файл в своём блоке");
  assert.match(read.note, /Абзац с числом 42/, "метод не прочитал docx с диска");
});

test("Composer держит двадцать файлов, а лишние показывает по-русски", () => {
  const { COMPOSER_ATTACHMENT_LIMIT, selectComposerFiles, describeDroppedComposerFiles } = composerModel;
  assert.equal(COMPOSER_ATTACHMENT_LIMIT, 20, "Composer режет список до шести файлов, а хост принимает двадцать");

  const many = Array.from({ length: 24 }, (_, index) => ({ name: `файл-${index + 1}.pdf` }));
  const selection = selectComposerFiles(many, 0);
  assert.equal(selection.accepted.length, 20, "Composer должен принять двадцать файлов, а не шесть");
  assert.equal(selection.dropped.length, 4, "четыре лишних файла должны быть названы, а не выброшены молча");

  const notice = describeDroppedComposerFiles(selection.dropped);
  assert.match(notice, /не прикреплены файлы/i, "пользователю не сказали, что часть файлов не прикрепилась");
  assert.match(notice, /«файл-21\.pdf»/, "в сообщении нет имени файла, который не прикрепился");
  assert.match(notice, /не больше 20/, "в сообщении нет предела, до которого можно прикрепить файлы");
  assert.doesNotMatch(notice, /[a-z]{4,}/, "в сообщении осталась английская фраза — интерфейс русский");
  assert.equal(describeDroppedComposerFiles([]), "", "когда все файлы влезли, жаловаться не на что");
});

test("отказ прикрепления объясняется по-русски и с настоящим лимитом для документа", () => {
  const { formatStageAttachmentFailureNotice } = desktopModule;
  const tooLarge = formatStageAttachmentFailureNotice([{ name: "otchet.docx", reason: "too-large" }]);
  assert.match(tooLarge, /100 МБ/, "показывают старую цифру 25 МБ вместо лимита документа");
  assert.doesNotMatch(tooLarge, /too large|max 25 MB/, "остался английский текст об отказе");
  assert.match(
    formatStageAttachmentFailureNotice([{ name: "pusto.txt", reason: "empty" }]),
    /пустой/,
    "про пустой файл по-прежнему не сказано",
  );
  const many = formatStageAttachmentFailureNotice([
    { name: "otchet.docx", reason: "too-large" },
    { name: "klip.mp4", reason: "too-large" },
  ]);
  assert.match(many, /200 МБ/, "для видео лимит должен называться отдельно");
  assert.equal(formatStageAttachmentFailureNotice([]), null, "без отказов сообщения быть не должно");
});