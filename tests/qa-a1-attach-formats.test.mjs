import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { deflateSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import iconv from "iconv-lite";

/**
 * Приём вложений любого формата: определение по расширению И по сигнатуре.
 *
 * Задача заведующей — библиотека присылает `.rtf`, `.docx`, `.odt`, `.xlsx`,
 * `.csv`, `.pdf`, `.zip` и фотографии, и бот должен показать содержимое этих
 * файлов модели, а не только имя и размер. Раньше читать было нечем: белый
 * список из ~90 текстовых расширений отбрасывал всё остальное, и модель не
 * видела ни байта содержимого. Список расширений убрали, решение отдали
 * содержимому файла, и с этого момента определение формата стало главным
 * местом, где можно ошибиться: одно неверное движение в определителе —
 * и файл либо молча отказывает, либо в модель уходит его исходник.
 *
 * Файл проверяет семь вещей, и каждая стоит отдельного теста:
 *
 *  1. сигнатуру — `PK`, `%PDF`, `{\rtf`, `D0CF11E0` — распознают все четыре;
 *  2. содержимое важнее имени: `.foo`, имя без расширения и `report.docx.txt`
 *     читаются как docx;
 *  3. пустой файл (0 байт) и файл из одних пробелов дают объяснение по-русски;
 *  4. запретный список запрещает ровно то, что прочитать нечем, и не
 *     запрещает ничего из того, что библиотека присылает;
 *  5. настоящий пример каждого библиотечного формата доходит до текста;
 *  6. 200 вложений подряд не копят буфер;
 *  7. отказ, который видит человек, называет файл его именем, а не путём на
 *     диске, и не требует двух разных действий подряд.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NUL = /\u0000/;

let engine;      // source/host/extensions/attachments/document/text.ts
let formats;     // source/shared/media/attachment-formats.ts
let legacy;      // source/host/extensions/attachments/document/legacy-office.ts
let tools;       // source/packages/report-tools — чем бот пишет отчёты
let noteBuilder; // source/host/extensions/attachments/documents-note.ts
let buildDir;

// `iconv-lite` тянет за собой `safer-buffer`, а тот зовёт `require("buffer")`.
const requireBanner = {
  js: 'import { createRequire as __dbbotCreateRequire } from "node:module";\nconst require = __dbbotCreateRequire(import.meta.url);',
};

before(async () => {
  buildDir = await mkdtemp(path.join(os.tmpdir(), "dbbot-qa-a1-attach-"));
  const bundle = async (entry, out) => {
    const outfile = path.join(buildDir, out);
    await build({ entryPoints: [path.join(repoRoot, entry)], outfile, bundle: true, format: "esm", platform: "node", target: "node22", banner: requireBanner });
    return await import(pathToFileURL(outfile).href);
  };
  engine = await bundle(path.join("source", "host", "extensions", "attachments", "document", "text.ts"), "document-text.mjs");
  formats = await bundle(path.join("source", "shared", "media", "attachment-formats.ts"), "attachment-formats.mjs");
  legacy = await bundle(path.join("source", "host", "extensions", "attachments", "document", "legacy-office.ts"), "legacy-office.mjs");
  tools = await bundle(path.join("source", "packages", "report-tools", "index.ts"), "report-tools.mjs");
  noteBuilder = await bundle(path.join("source", "host", "extensions", "attachments", "documents-note.ts"), "documents-note.mjs");
});

after(async () => {
  if (buildDir !== undefined) await rm(buildDir, { recursive: true, force: true });
});

const encoder = new TextEncoder();
const extract = (name, bytes, limits) => engine.extractAttachmentText(name, bytes, limits);

// ───────────────────────── образцы файлов ─────────────────────────

const REPORT_MARKDOWN = [
  "# Протокол заседания",
  "",
  "Заседание клуба «Омега» состоялось 12.03.2026.",
  "",
  "- принято решение обновить фонд",
  "- назначена дата книжной выставки",
].join("\n");

const reportBlocks = () => tools.reportBlocks(REPORT_MARKDOWN);
const realDocx = () => tools.blocksToDocx(reportBlocks());
const realOdt = () => tools.blocksToOdt(reportBlocks());
const realRtf = () => new Uint8Array(Buffer.from(tools.blocksToRtf(reportBlocks()), "latin1"));

/** Настоящая книга Excel: `xl/workbook.xml`, `sharedStrings.xml` и лист. */
function realXlsx() {
  const strings = ["Мероприятие", "Срок", "Книжная выставка", "05.04.2026"];
  const rows = [
    { row: 1, cells: [{ col: "A", v: 0 }, { col: "B", v: 1 }] },
    { row: 2, cells: [{ col: "A", v: 2 }, { col: "B", v: 3 }] },
  ];
  const worksheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
    .map(({ row, cells }) => `<row r="${row}">${cells.map((cell) => `<c r="${cell.col}${row}" t="s"><v>${cell.v}</v></c>`).join("")}</row>`)
    .join("")}</sheetData></worksheet>`;
  const sharedStrings = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">${strings
    .map((value) => `<si><t xml:space="preserve">${value}</t></si>`)
    .join("")}</sst>`;
  return tools.writeZip([
    { name: "xl/workbook.xml", data: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Планы" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: "xl/sharedStrings.xml", data: encoder.encode(sharedStrings) },
    { name: "xl/worksheets/sheet1.xml", data: encoder.encode(worksheet) },
  ]);
}

/** Настоящая таблица LibreOffice: zip с `mimetype` и `content.xml`. */
function realOds() {
  const content = '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet><table:table table:name="Список">'
    + "<table:table-row><table:table-cell><text:p>Книга</text:p></table:table-cell><table:table-cell><text:p>Штук</text:p></table:table-cell></table:table-row>"
    + "<table:table-row><table:table-cell><text:p>Справочник юного читателя</text:p></table:table-cell><table:table-cell><text:p>120</text:p></table:table-cell></table:table-row>"
    + "</table:table></office:spreadsheet></office:body></office:document-content>";
  return tools.writeZip([
    { name: "mimetype", data: encoder.encode("application/vnd.oasis.opendocument.spreadsheet") },
    { name: "META-INF/manifest.xml", data: encoder.encode('<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>') },
    { name: "content.xml", data: encoder.encode(content) },
  ]);
}

/** Цифровой PDF: `FlateDecode` — так пишут Word, LibreOffice и сканеры. */
function realPdf(pages = 1, leadingBytes = "") {
  const pageIds = Array.from({ length: pages }, (_, index) => `${3 + index} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds}] /Count ${pages} >>`,
  ];
  for (let index = 0; index < pages; index += 1) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${4 + pages} 0 R >> >> /Contents ${3 + pages + index} 0 R >>`);
  }
  const content = "BT /F1 12 Tf 72 700 Td (Book fair 2026) Tj 0 -20 Td (Library report) Tj ET";
  const compressed = deflateSync(Buffer.from(content, "latin1"));
  objects.push(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n${compressed.toString("latin1")}\nendstream`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  let pdf = `${leadingBytes}%PDF-1.4\n`;
  for (const [index, body] of objects.entries()) pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

/** Настоящий PNG, собранный байт за байтом: `IHDR`, `IDAT` с настоящей CRC, `IEND`. */
function realPng() {
  const width = 8;
  const height = 8;
  const scanlines = Buffer.alloc(height * (1 + width * 3));
  for (let row = 0; row < height; row += 1) {
    const at = row * (1 + width * 3);
    scanlines[at] = 0;
    for (let column = 0; column < width; column += 1) {
      scanlines[at + 1 + column * 3] = 0x33;
      scanlines[at + 2 + column * 3] = 0x66;
      scanlines[at + 3 + column * 3] = 0xff;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(tools.crc32(body) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]));
}

/** RTF с русским текстом через `\uN` — так пишет сам бот. */
function rtfWithWord(text) {
  const body = [...text].map((char) => `\\u${char.codePointAt(0)}?`).join("");
  return `{\\rtf1\\ansi\\ansicpg1251\\deff0{\\fonttbl{\\f0 Times;}}\\f0 ${body}\\par }`;
}

/** Составной файл Office: сигнатура `D0CF11E0` плюс текст в UTF-16LE, как пишет Word 97–2003. */
function compoundFileWithWord(text, at = 1024) {
  const file = new Uint8Array(8192);
  file.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  file.set(Buffer.from(text, "utf16le"), at);
  return file;
}

/** Таблица в UTF-16LE с BOM — так её сохраняет Excel через «Текст Unicode». */
const utf16leWithBom = (text) => new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));

// ───────────────────────── 1. сигнатуры ─────────────────────────

test("четыре сигнатуры, на которые опирается определитель, узнаются все", () => {
  assert.equal(engine.sniffFormat(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])), "zip-ooxml", "PK не узнан как zip — весь офисный разбор не запустится");
  assert.equal(engine.sniffFormat(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])), "pdf", "%PDF не узнан как pdf — скан отчёта уйдёт в модель исходником");
  assert.equal(engine.sniffFormat(new Uint8Array([0x7b, 0x5c, 0x72, 0x74, 0x66])), "rtf", "сигнатура RTF не узнана");
  assert.equal(engine.sniffFormat(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), "ole", "сигнатура старого Office не узнана");
});

test("файл .foo с содержимым docx, файл без расширения и report.docx.txt читаются как docx", () => {
  const bytes = realDocx();
  const odd = extract("protokol.foo", bytes);
  const nameless = extract("protokol", bytes);
  const doubled = extract("report.docx.txt", bytes);
  for (const result of [odd, nameless, doubled]) {
    assert.equal(result.status, "text", "содержимое определилось не по сигнатуре, а по имени — файл молча потерян");
    assert.equal(result.format, "docx", "формат определён по расширению, а не по сигнатуре: имя солгало");
    assert.match(result.text, /Протокол заседания/, "текст документа не извлечён");
  }
  assert.equal(doubled.text, odd.text, "двойное расширение изменило результат чтения");
});

// ───────────────────────── 2. пустые файлы ─────────────────────────

test("файл в 0 байт получает внятное объяснение по-русски", () => {
  const result = extract("pusto.txt", new Uint8Array(0));
  assert.equal(result.status, "unreadable", "пустой файл не должен выглядеть прочитанным");
  assert.match(result.notice, /пустой/, "пользователю не сказали, что файл пустой — он решит, что бот сломался");
  assert.match(result.notice, /пришлите его заново/i, "в объяснении нет подсказки, что делать");
});

test("файл из одних пробелов и переводов строк тоже объясняется по-русски", () => {
  const result = extract("pusto.txt", new Uint8Array([32, 32, 10, 32, 13, 10, 9, 32]));
  assert.equal(result.status, "empty", "файл без единого слова не должен считаться прочитанным текстом");
  const note = noteBuilder.buildAttachmentDocumentsNote([
    { filename: "pusto.txt", path: "pusto.txt", bytes: 8, result },
  ]);
  assert.match(note, /NOT READABLE\. \S/, "модель получит строку «NOT READABLE.» без причины и не сможет объяснить пользователю, что произошло");
});

// ───────────────────────── 3. запретный список ─────────────────────────

test("запрещено ровно то, что прочитать нечем, и не запрещено ничего из библиотечного", () => {
  const { isAttachmentReadableExtension, UNREADABLE_ATTACHMENT_EXTENSIONS } = formats;
  for (const extension of ["exe", "dll", "msi", "sys", "iso", "img", "bin", "dat"]) {
    assert.equal(isAttachmentReadableExtension(extension), false, `${extension} читать нечем, но он разрешён — лишний тракт на файл`);
  }
  for (const extension of ["rtf", "doc", "docx", "odt", "ods", "odp", "xls", "xlsx", "pdf", "csv", "txt", "zip", "7z", "rar", "jpg", "jpeg", "png", "heic"]) {
    assert.equal(isAttachmentReadableExtension(extension), true, `${extension} запрещён по имени, хотя библиотека присылает такие файлы`);
  }
  assert.equal(isAttachmentReadableExtension(null), true, "файл без расширения не запрещён");
  assert.equal(isAttachmentReadableExtension(""), true, "пустое расширение не запрещено");
  assert.ok(UNREADABLE_ATTACHMENT_EXTENSIONS.size < 60, `запретный список разросся до ${UNREADABLE_ATTACHMENT_EXTENSIONS.size} расширений — значит, в него попало лишнее`);
});

test("запрет по имени не перекрывает чтение по содержимому для разрешённого расширения", () => {
  const result = extract("otchet.csv", realDocx());
  assert.equal(result.status, "text", "docx под именем .csv не прочитан — имя сильнее содержимого");
  assert.match(result.text, /Протокол заседания/, "текст не извлечён");
});

// ───────────────────────── 4. настоящие форматы ─────────────────────────

test("настоящий rtf отчёта доходит до текста без управляющих слов", () => {
  const result = extract("otchet.rtf", realRtf());
  assert.equal(result.status, "text", "rtf не прочитан");
  assert.match(result.text, /Протокол заседания/, "текст rtf не извлечён");
  assert.doesNotMatch(result.text, /\\rtf1|\\u\d|\\par/, "в модель ушли управляющие слова RTF вместо текста");
});

test("настоящий rtf с BOM читается как текст, а не как разметка", () => {
  const withBom = new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(rtfWithWord("Привет"), "latin1")]));
  const result = extract("otchet.rtf", withBom);
  assert.equal(result.status, "text", "rtf с BOM должен читаться так же, как без BOM");
  assert.match(result.text, /Привет/, "текст документа не извлечён");
  assert.doesNotMatch(result.text, /\\rtf1|\\u\d/, "в модель ушла разметка RTF вместо текста документа");
});

test("настоящий docx, odt, ods, xlsx и csv доходят до текста", () => {
  const docx = extract("protokol.docx", realDocx());
  assert.match(docx.text, /Протокол заседания/, "docx: текст не извлечён");

  const odt = extract("protokol.odt", realOdt());
  assert.match(odt.text, /назначена дата книжной выставки/, "odt: текст не извлечён");

  const ods = extract("spisok.ods", realOds());
  assert.equal(ods.status, "text", "ods: таблица LibreOffice не прочитана");
  assert.match(ods.text, /Справочник юного читателя\t120/, "ods: строка таблицы не разделилась табуляцией");

  const xlsx = extract("plany.xlsx", realXlsx());
  assert.equal(xlsx.status, "text", "xlsx: книга Excel не прочитана");
  assert.match(xlsx.text, /Планы/, "xlsx: имя листа не показано");
  assert.match(xlsx.text, /Книжная выставка\t05\.04\.2026/, "xlsx: строка таблицы не разделилась табуляцией");

  const csv = extract("plan.csv", new Uint8Array(iconv.encode("Наименование;Количество\r\nКниги;120\r\n", "win1251")));
  assert.equal(csv.status, "text", "csv в windows-1251 не прочитан");
  assert.match(csv.text, /Книги;120/, "csv: текст исказился или потерялся");
});

test("настоящий pdf доходит до текста и при ведущих байтах перед заголовком", () => {
  const clean = extract("skan.pdf", realPdf(3));
  assert.equal(clean.status, "text", "цифровой pdf не прочитан");
  assert.match(clean.text, /Book fair 2026/, "текст pdf не извлечён");
  assert.doesNotMatch(clean.text, /%PDF|endobj/, "в модель ушёл исходник pdf вместо текста документа");

  // Спецификация pdf допускает до 1024 байт перед заголовком: так выглядит
  // файл, пересобранный склейкой или пересланный почтой. Раньше такой файл
  // уходил в модель сырым текстом целиком — и этот тест проверял именно это
  // поведение («обратная проверка»), вопреки соседнему набору
  // `tests/qa-1-pdf-parser.test.mjs`, где то же самое требовало текста.
  // Теперь ожидание одно: файл читается как PDF.
  const prefixed = extract("skan.pdf", realPdf(200, "\n"));
  assert.equal(prefixed.status, "text", "pdf с мусором перед заголовком не прочитан как PDF");
  assert.match(prefixed.text, /Book fair 2026/, "текст pdf с ведущими байтами потерян");
  assert.doesNotMatch(prefixed.text, /%PDF|endobj|BT \/F1/, "в модель ушёл исходник pdf вместо текста документа");
});

test("таблица и заметка в UTF-16LE, которые пишет Excel, доходят до текста", () => {
  const csv = extract("plan.csv", utf16leWithBom("Наименование;Количество\r\nКниги;120\r\n"));
  assert.equal(csv.status, "text", "таблица в UTF-16LE отказана, хотя в коде есть готовый разбор UTF-16 с BOM");
  assert.match(csv.text, /Книги;120/, "текст таблицы не извлечён");

  const note = extract("zapis.txt", utf16leWithBom("Протокол заседания директоров библиотеки.\r\n"));
  assert.equal(note.status, "text", "заметка в UTF-16LE отказана — самый частый экспорт Excel на русской Windows");
  assert.match(note.text, /Протокол заседания директоров/, "текст заметки не извлечён");
});

test("старый документ Word 97–2003 читается по сигнатуре D0CF11E0", () => {
  const sentence = "Протокол заседания директоров библиотеки. Принято решение обновить фонд.";
  const result = extract("protokol.doc", compoundFileWithWord(sentence));
  assert.notEqual(result.status, "unsupported", "старый .doc с текстом признан нечитаемым");
  assert.match(result.text, /Принято решение обновить фонд/, "текст старого .doc не извлечён");
});

test("старый документ Word не отдаёт нулевые байты вместо текста", () => {
  const sentence = "Протокол заседания директоров библиотеки. Принято решение обновить фонд.";
  const file = compoundFileWithWord(sentence);
  file.set(Buffer.from("SummaryInformation", "latin1"), 4096);
  const salvaged = legacy.salvageLegacyOfficeText(file, "protokol.doc");
  assert.notEqual(salvaged, null, "разбор старого .doc не нашёл в файле ничего");
  assert.match(salvaged, /Принято решение обновить фонд/, "текст документа не извлечён, найдено только то, что случайно оказалось в cp1251");
  assert.doesNotMatch(salvaged, NUL, `в «текст» попали нулевые байты (${(salvaged.match(NUL) ?? []).length} шт.) — это двоичный мусор, а не документ`);
});

// ───────────────────────── 5. фото и zip ─────────────────────────

test("фотография принимается и объясняется по-русски, а не отказывается", () => {
  const photo = realPng();
  const result = extract("foto.png", photo);
  assert.equal(result.status, "empty", "фотография не должна ни читаться как текст, ни отказываться");
  assert.match(result.notice, /изображение/, "пользователю не сказали, что это фотография и текста из неё не будет");
  assert.match(result.notice, /Пришлите его в Word, в Excel или в виде таблицы/, "в объяснении нет подсказки, что делать");
});

test("zip с протоколом и вложенным docx отдаёт и список частей, и текст", () => {
  const zip = tools.writeZip([
    { name: "вложение/отчёт.docx", data: realDocx() },
    { name: "заметка.txt", data: encoder.encode("Клуба Омега 12.03.2026") },
  ]);
  const result = extract("paket.zip", zip);
  assert.equal(result.status, "text", "zip не прочитан");
  assert.match(result.text, /вложение\/отчёт\.docx/, "список частей архива не показан");
  assert.match(result.text, /Протокол заседания/, "текст из вложенного docx не извлечён");
  assert.match(result.text, /Клуба Омега 12\.03\.2026/, "текст из txt внутри архива не извлечён");
});

// ───────────────────────── 6. память и время ─────────────────────────

test("документ Word с большой фотографией внутри не распаковывается ради текста", () => {
  const documentXml = encoder.encode('<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Текст отчёта</w:t></w:r></w:p></w:body></w:document>');
  const thin = tools.writeZip([{ name: "word/document.xml", data: documentXml }]);
  const fat = tools.writeZip([
    { name: "word/document.xml", data: documentXml },
    { name: "word/media/image1.png", data: new Uint8Array(40 * 1024 * 1024).fill(0x5a) },
  ]);
  const timeOf = (bytes) => {
    const started = process.hrtime.bigint();
    extract("otchet.docx", bytes);
    return Number(process.hrtime.bigint() - started) / 1e6;
  };
  timeOf(thin);
  timeOf(fat);
  const thinMs = timeOf(thin);
  const fatMs = timeOf(fat);
  assert.equal(extract("otchet.docx", thin).text, extract("otchet.docx", fat).text, "документы должны давать одинаковый текст — разница только в фотографии");
  assert.ok(fatMs <= thinMs * 4 + 5, `один и тот же текст из .docx в ${fat.length} байт читается ${fatMs.toFixed(1)} мс, а из .docx в ${thin.length} байт — ${thinMs.toFixed(1)} мс: архив распаковывается целиком, включая фотографию на 40 МБ, которая в модель не идёт`);
});

test("двести вложений подряд: ни один не отказан и буфер не копится", () => {
  const photo = realPng();
  const samples = [
    ["protokol.docx", realDocx()],
    ["protokol.odt", realOdt()],
    ["spisok.ods", realOds()],
    ["plany.xlsx", realXlsx()],
    ["otchet.rtf", realRtf()],
    ["plan.csv", new Uint8Array(iconv.encode("Наименование;Количество\r\nКниги;120\r\n", "win1251"))],
    ["skan.pdf", realPdf(2)],
    ["paket.zip", tools.writeZip([{ name: "заметка.txt", data: encoder.encode("Клуба Омега 12.03.2026") }])],
    ["foto.png", photo],
  ];
  const before = process.memoryUsage().heapUsed;
  const started = process.hrtime.bigint();
  const refused = [];
  for (let index = 0; index < 200; index += 1) {
    for (const [name, bytes] of samples) {
      const result = extract(`${index}-${name}`, bytes);
      if (result.status === "unsupported") refused.push(`${index}-${name}`);
    }
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const heapAfter = process.memoryUsage().heapUsed;
  assert.deepEqual(refused, [], `при повторной обработке отказали вложения, которые раньше читались: ${refused.slice(0, 5).join(", ")}`);
  assert.ok(heapAfter - before < 128 * 1024 * 1024, `за ${samples.length * 200} вложений куча выросла на ${Math.round((heapAfter - before) / 1048576)} МБ — буфер копится и память утекает`);
  assert.ok(elapsedMs < 60_000, `${samples.length * 200} вложений читались ${Math.round(elapsedMs)} мс — это слишком долго для пачки файлов`);
});

// ───────────────────────── 7. что видит человек ─────────────────────────

test("отказ называет файл его именем, а не путём на диске", () => {
  // Образец — старый документ Word, из которого нечего вытащить: раньше здесь
  // лежал читаемый csv, и тест проверял только текст отказа на файле, который
  // отказом не заканчивается.
  const fullPath = "C:\\Users\\lesab\\AppData\\Roaming\\dbbot\\agents\\0f3a5c1e-7b42-4a19-9f0d-2c6b8e51a7d3\\attachments\\protokol.doc";
  const result = extract(fullPath, compoundFileWithWord(""));
  assert.equal(result.status, "unsupported", `старый документ без текста должен отказывать, а не читаться: статус ${result.status}`);
  assert.match(result.notice, /^Не смог прочитать файл protokol\.doc\b/, "заведующая видит в отказе служебный путь с идентификатором агента, а не имя своего файла");
  assert.doesNotMatch(result.notice, /agents\\|attachments\\|[0-9a-f]{8}-[0-9a-f]{4}-/, "в сообщении пользователю протекла внутренняя папка и идентификатор агента");
});

test("отказ на русском звучит грамматически и не просит двух разных вещей сразу", () => {
  // Проверяется на файлах, которые правда отказываются: после починки разбора
  // читаемый csv и старый Word с текстом больше не отказ, и проверять на них
  // формулировку отказа бессмысленно — `notice` там пуст.
  const refusals = [
    ["protokol.doc", compoundFileWithWord("")],
    ["paket.rar", new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])],
    ["sklad.7z", new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])],
  ];
  for (const [name, bytes] of refusals) {
    const notice = extract(name, bytes).notice;
    assert.match(notice, /Не смог прочитать файл/, `${name}: отказ должен называть файл и формат`);
    assert.doesNotMatch(
      notice,
      /в формате (таблица в текене|старый документ|неизвестный формат|архив|документ PDF|текстовый файл|файл JSON|страница|изображение|аудио или видео)( |\.)/,
      `название формата вставлено без согласования: «${notice}» по-русски не читается`,
    );
    assert.equal((notice.match(/Пришлите его/g) ?? []).length, 1, `в одном отказе два разных совета подряд: «${notice}»`);
  }
});