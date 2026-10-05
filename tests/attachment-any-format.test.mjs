import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import iconv from "iconv-lite";

// Извлечение текста из вложений появилось только сейчас. До этого
// `readAttachmentText` спрашивал белый список `TEXT_PREVIEWABLE_EXTENSIONS`, и
// всё, чего в нём не было — `.docx`, `.odt`, `.rtf`, `.pdf`, `.xlsx`, а также
// любой незнакомый файл, — объявлялось двоичным. В модель уходили только пути и
// размеры, ни байта содержимого. Заведующая библиотеки просила «свести четыре
// файла в один отчёт» и получала отказ. Тесты ниже доказывают обратное на
// настоящих файлах: `.docx` и `.odt` собираются тем же кодом, которым бот
// пишет отчёты (`blocksToDocx` / `blocksToOdt`), и прочитаны обратно.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let tools;       // source/packages/report-tools — чем бот пишет отчёты
let engine;      // source/host/extensions/attachments/document — чем бот их читает
let noteBuilder; // блок, который уходит в промпт
let formats;     // политика расширений
let limits;      // лимиты приёма
let previewKind; // вид карточки
let buildDir;

// `iconv-lite` тянет за собой `safer-buffer`, а тот зовёт `require("buffer")`.
// В боевой сборке выход — CJS, и `require` есть; в тесте формат ESM, поэтому
// `require` объявляется явно, иначе модуль не грузится вовсе.
const requireBanner = {
  js: 'import { createRequire as __dbbotCreateRequire } from "node:module";\nconst require = __dbbotCreateRequire(import.meta.url);',
};

before(async () => {
  buildDir = await mkdtemp(path.join(os.tmpdir(), "dbbot-attachment-any-format-"));
  const bundle = async (entry, out) => {
    const outfile = path.join(buildDir, out);
    await build({ entryPoints: [path.join(repoRoot, entry)], outfile, bundle: true, format: "esm", platform: "node", target: "node22", banner: requireBanner });
    return await import(pathToFileURL(outfile).href);
  };
  tools = await bundle(path.join("source", "packages", "report-tools", "index.ts"), "report-tools.mjs");
  engine = await bundle(path.join("source", "host", "extensions", "attachments", "document", "text.ts"), "document-text.mjs");
  noteBuilder = await bundle(path.join("source", "host", "extensions", "attachments", "documents-note.ts"), "documents-note.mjs");
  formats = await bundle(path.join("source", "shared", "media", "attachment-formats.ts"), "attachment-formats.mjs");
  limits = await bundle(path.join("source", "shared", "media", "attachment-limits.ts"), "attachment-limits.mjs");
  previewKind = await bundle(path.join("source", "shared", "media", "file-preview-kind.ts"), "file-preview-kind.mjs");
});

after(async () => {
  if (buildDir !== undefined) await rm(buildDir, { recursive: true, force: true });
});

const MARKDOWN = [
  "Отчёт за первый квартал",
  "",
  "## Квартальные итоги",
  "",
  "Абзац с числом 42 и словом «библиотека».",
  "",
  "- Club Omega",
  "- Книжная выставка",
  "",
  "| № | Мероприятие | Срок |",
  "|---|---|---|",
  "| 1 | Заседание клуба «Омега» | 12.03.2026 |",
  "| 2 | День рождения фонда | 05.04.2026 |",
].join("\n");

const blocks = () => tools.reportBlocks(MARKDOWN);

/** Минимальный `.xlsx`: `writeZip` из report-tools, настоящий состав частей. */
function buildXlsx() {
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

const PDF_FONT = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

/** Минимальный цифровой PDF: одна страница, один шрифт, `Tj` с `WinAnsiEncoding`. */
function buildPdf() {
  const content = "BT /F1 12 Tf 72 700 Td (Library report) Tj 0 -20 Td (Book fair 2026) Tj ET";
  return assemblePdf(content, "");
}

/** Тот же PDF, но поток сжат `FlateDecode` — так пишут Word и LibreOffice. */
function buildFlatePdf() {
  const content = deflateSync(Buffer.from("BT /F1 12 Tf 72 700 Td (Compressed report) Tj ET", "latin1"));
  return assemblePdf(content.toString("latin1"), " /Filter /FlateDecode");
}

function assemblePdf(stream, extraFilter) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length}${extraFilter} >>\nstream\n${stream}\nendstream`,
    PDF_FONT,
  ];
  let pdf = "%PDF-1.4\n";
  for (const [index, body] of objects.entries()) pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

/** `\uN` из русских букв: в RTF после каждой идёт `uc` символов запасного представления. */
function rtfUnicode(text) {
  return [...text].map((char) => `\\u${char.codePointAt(0)}?`).join("");
}

/** `\'hh` из байта в кодовой странице 1251 — так пишет Word. */
function rtfCyrillic1251(text) {
  return iconv
    .encode(text, "win1251")
    .toString("latin1")
    .replace(/[^\x20-\x7e]/g, (char) => `\\'${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

const extract = (name, bytes, extractLimits) => engine.extractAttachmentText(name, bytes, extractLimits);

test("docx, собранный кодом отчётов, читается обратно в тот же текст", () => {
  const bytes = tools.blocksToDocx(blocks());
  const result = extract("otchet.docx", bytes);
  assert.equal(result.status, "text", "docx должен читаться как текст, а не отбрасываться");
  assert.match(result.text, /Отчёт за первый квартал/, "заголовок отчёта не дошёл до текста");
  assert.match(result.text, /Абзац с числом 42/, "абзац потерялся при разборе word/document.xml");
  assert.match(result.text, /Заседание клуба «Омега»/, "текст таблицы не извлёкся");
  assert.match(result.text, /Книжная выставка/, "элемент списка не извлёкся");
  assert.match(result.text, /№\tМероприятие\tСрок/, "строка таблицы рассыпалась на по одной ячейке на строку — из неё нельзя понять, где что лежит");
  assert.equal(result.truncated, false, "маленький отчёт не должен помечаться обрезанным");
});

test("odt, собранный кодом отчётов, читается обратно в тот же текст", () => {
  const bytes = tools.blocksToOdt(blocks());
  const result = extract("otchet.odt", bytes);
  assert.equal(result.status, "text", "odt должен читаться как текст");
  assert.match(result.text, /Отчёт за первый квартал/, "заголовок не дошёл из content.xml");
  assert.match(result.text, /12\.03\.2026/, "ячейка таблицы не извлеклась");
  assert.match(result.text, /№\tМероприятие\tСрок/, "строка таблицы рассыпалась на по одной ячейке на строку");
  assert.match(result.text, /Квартальные итоги/, "подзаголовок text:h не извлёкся");
});

test("таблица xlsx читается в строки через табуляцию", () => {
  const result = extract("plany.xlsx", buildXlsx());
  assert.equal(result.status, "text", "xlsx должен читаться как текст");
  assert.match(result.text, /Планы/, "имя листа из xl/workbook.xml не показано");
  assert.match(result.text, /№\tМероприятие\tСрок/, "строка заголовка не разделена табуляцией");
  assert.match(result.text, /1\tЗаседание клуба «Омега»\t12\.03\.2026/, "данные из sharedStrings не подставились");
});

test("rtf читается, а группы-определения и запасные символы в текст не попадают", () => {
  const rtf = `{\\rtf1\\ansi\\ansicpg1251\\deff0{\\fonttbl{\\f0 Times;}}\\f0 ${rtfUnicode("Привет")}\\par `
    + `${rtfCyrillic1251("Мелкий")} ${rtfUnicode("Отчёт")}\\tab 12.03.2026\\par }`;
  const result = extract("otchet.rtf", new TextEncoder().encode(rtf));
  assert.equal(result.status, "text", "rtf должен читаться как текст");
  assert.match(result.text, /Привет/, "эскейп \\uN разобран неверно: после него идёт запасной символ, его надо пропустить");
  assert.match(result.text, /Мелкий/, "эскейп \\'hh в кодовой странице 1251 разобран неверно");
  assert.match(result.text, /Отчёт/, "буква ё в \\uN разобралась неверно");
  assert.match(result.text, /12\.03\.2026/, "содержимое после \\tab потеряно");
  assert.doesNotMatch(result.text, /Times/, "группа \\fonttbl попала в текст документа");
  assert.doesNotMatch(result.text, /\?/, "запасной символ после \\uN попал в текст");
});

test("pdf читается в обоих видах: без сжатия и с FlateDecode", () => {
  const plain = extract("otchet.pdf", buildPdf());
  assert.equal(plain.status, "text", "цифровой PDF должен читаться");
  assert.match(plain.text, /Library report/, "текст первой строки PDF не извлечён");
  assert.match(plain.text, /Book fair 2026/, "перенос строки в PDF потерян");

  const flate = extract("otchet.pdf", buildFlatePdf());
  assert.equal(flate.status, "text", "PDF со сжатым потоком должен читаться");
  assert.match(flate.text, /Compressed report/, "поток FlateDecode не распаковался");
});

test("файл без расширения и файл с незнакомым расширением читаются так же, как docx", () => {
  const bytes = tools.blocksToDocx(blocks());
  const nameless = extract("отчёт", bytes);
  const odd = extract("protokol.foo", bytes);
  assert.equal(nameless.status, "text", "файл без расширения не должен отбрасываться по имени");
  assert.equal(odd.status, "text", "незнакомое расширение не должно отбрасываться по имени");
  assert.match(nameless.text, /Отчёт за первый квартал/, "содержимое определилось по сигнатуре zip");
  assert.equal(odd.text, nameless.text, "по содержимому оба файла прочитались одинаково");
});

test("текст в windows-1251 читается русскими буквами, а не «РњРѕРјРјРѕ»", () => {
  const source = "Отчёт библиотеки: книжная выставка.";
  const bytes = new Uint8Array(iconv.encode(source, "win1251"));
  const result = extract("zapis.txt", bytes);
  assert.equal(result.status, "text", "текст должен читаться");
  assert.equal(result.text.trim(), source, "кодировка windows-1251 определилась неверно");
  assert.doesNotMatch(result.text, /Р/, "русский текст не должен превратиться в latin-1 мусор");
});

test("архив zip отдаёт список частей и текст того, что внутри", () => {
  const encoder = new TextEncoder();
  const bytes = tools.writeZip([
    { name: "протокол.txt", data: encoder.encode("Заседание 12.03.2026") },
    { name: "фото/скан.jpg", data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]) },
  ]);
  const result = extract("arhiv.zip", bytes);
  assert.equal(result.status, "text", "zip должен читаться частично");
  assert.match(result.text, /протокол\.txt/, "список частей архива не показан");
  assert.match(result.text, /Заседание 12\.03\.2026/, "текст из файла внутри архива не извлечён");
});

test("архив-бомба не разворачивается и объясняет это по-русски", () => {
  const payload = new Uint8Array(8 * 1024 * 1024).fill(0x41);
  const bytes = tools.writeZip([{ name: "bomb.txt", data: payload }]);
  const result = extract("bomb.zip", bytes, { ...engine.DEFAULT_DOCUMENT_LIMITS, zip: { maxEntries: 10, maxEntryBytes: 1024, maxTotalBytes: 2048 } });
  assert.equal(result.status, "unreadable", "разворачивание архива-бомбы должно быть отменено до распаковки");
  assert.match(result.notice, /разворачивать|распаковывать/i, "пользователю не сказали, что архив не развернули");
  assert.match(result.notice, /^Не смог прочитать файл bomb\.zip/, "отказ должен звучать так же, как остальные отказы");
  assert.match(result.notice, /Пришлите его в Word или в виде таблицы\./, "в отказе нет подсказки, как прислать файл заново");
});

test("то, что прочитать нечем, получает отказ с названием формата по-русски", () => {
  const rar = new Uint8Array(64).fill(0);
  rar.set([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
  const result = extract("otzyv.rar", rar);
  assert.equal(result.status, "unsupported", "rar без библиотеки должен честно отказать");
  assert.equal(result.text, "", "отказ не должен возвращать выдуманный текст");
  assert.match(result.notice, /^Не смог прочитать файл otzyv\.rar/, "нет требуемой формулировки отказа");
  assert.match(result.notice, /в формате архив/, "в отказе не названо, что это за формат");
  assert.match(result.notice, /Пришлите его в Word или в виде таблицы\./, "нет подсказки, как прислать файл заново");
});

test("четыре файла целиком попадают в блок промпта вместе с именами", () => {
  const encoder = new TextEncoder();
  const files = [
    { filename: "mart.docx", bytes: tools.blocksToDocx(blocks()), expect: "Отчёт за первый квартал" },
    { filename: "aprel.odt", bytes: tools.blocksToOdt(blocks()), expect: "Квартальные итоги" },
    { filename: "plan.xlsx", bytes: buildXlsx(), expect: "Заседание клуба «Омега»" },
    { filename: "zapis.txt", bytes: encoder.encode("Протокол заседания"), expect: "Протокол заседания" },
  ];
  const items = files.map((file) => ({
    filename: file.filename,
    path: `C:\\attachments\\${file.filename}`,
    bytes: file.bytes.byteLength,
    result: extract(file.filename, file.bytes),
  }));
  const note = noteBuilder.buildAttachmentDocumentsNote(items);
  for (const file of files) {
    assert.match(note, new RegExp(`## File \\d+: ${file.filename.replace(".", "\\.")}`), `файл ${file.filename} не назван в блоке`);
    assert.match(note, new RegExp(file.expect), `содержимое ${file.filename} не попало в блок`);
  }
  assert.equal((note.match(/^## File \d+:/gm) ?? []).length, 4, "в блоке должно быть ровно четыре файла, а не один");
  assert.match(note, /Use ALL of the files together/, "в блоке нет указания сводить все файлы");
});

test("четыре файла делят общий бюджет, но ни один не пропадает из блока молча", () => {
  const long = "я".repeat(5_000);
  const items = ["a.txt", "b.txt", "c.txt", "d.txt"].map((name) => ({
    filename: name,
    path: `C:\\attachments\\${name}`,
    bytes: long.length,
    result: extract(name, new TextEncoder().encode(long)),
  }));
  const note = noteBuilder.buildAttachmentDocumentsNote(items, { totalCharBudget: 600 });
  assert.equal((note.match(/^## File \d+:/gm) ?? []).length, 4, "после обрезки бюджетом файл не должен исчезнуть из блока");
  assert.match(note, /truncated/, "обрезка должна быть помечена, а не сделана молча");
});

test("лимит приёма у документа выше, чем у фотографии, и считается по-русски", () => {
  const { attachmentByteLimitForName, describeAttachmentByteLimitRu, ATTACHMENT_COUNT_LIMIT } = limits;
  assert.ok(
    attachmentByteLimitForName("otchet.pdf") > attachmentByteLimitForName("photo.png"),
    "PDF должен приниматься крупнее фотографии, иначе скан отчёта не пройдёт",
  );
  assert.equal(attachmentByteLimitForName("clip.mp4"), 200 * 1024 * 1024, "видео не должно потерять свою полосу");
  assert.match(describeAttachmentByteLimitRu("otchet.docx"), /100 МБ/, "пользователю показывают старую цифру 25 МБ");
  assert.ok(ATTACHMENT_COUNT_LIMIT >= 8, "лимит в 6 файлов не позволял прикрепить рабочую пачку из 4+ файлов и тихо терял лишние");
});

test("вид карточки отдаёт байты для odt, rtf, doc и архива, а не только для docx", () => {
  const { getFilePreviewKind, previewKindNeedsBytes } = previewKind;
  for (const name of ["otchet.odt", "otchet.rtf", "otchet.doc", "arhiv.zip"]) {
    const kind = getFilePreviewKind(name);
    assert.equal(previewKindNeedsBytes(kind), true, `для ${name} байты не отдаются — вид ${kind} ничего не покажет`);
  }
  assert.equal(formats.attachmentFormatOf("otchet.odt"), "odt", "odt не опознан как документ LibreOffice");
  assert.equal(formats.isAttachmentReadableExtension("foo"), true, "незнакомое расширение должно быть разрешено");
  assert.equal(formats.isAttachmentReadableExtension("7z"), true, "7z заведующая присылает — он должен приниматься");
  assert.equal(formats.isAttachmentReadableExtension("dll"), false, "исполняемый файл прочитать нечем — его можно запретить");
});
