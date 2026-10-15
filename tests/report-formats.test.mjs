import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import iconv from "iconv-lite";

// `save_report` и `fill_sample` пишут документы без Word, LibreOffice и
// pandoc: RTF собирается строками, DOCX и ODT вручную упаковываются в zip.
// До этого конвертеров в проекте не было вообще, поэтому ни один файл отчёта
// нельзя было ни создать, ни проверить: агент мог обещать пользователю готовый
// отчёт и не записать ни байта. Ни один тест не открывал результат работы этих
// функций. Теперь тест доказывает структуру каждого формата: у RTF есть
// обязательная шапка `\rtf1` и сбалансированные скобки, у DOCX и ODT —
// настоящий zip, который читается по центральному каталогу, причём у ODT
// `mimetype` обязан идти первым и без сжатия (иначе LibreOffice не откроет).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let tools;
let buildDir;

before(async () => {
  buildDir = await mkdtemp(path.join(os.tmpdir(), "dbbot-report-formats-"));
  const output = path.join(buildDir, "report-tools.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source", "packages", "report-tools", "index.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  tools = await import(pathToFileURL(output).href);
});

after(async () => {
  if (buildDir !== undefined) await rm(buildDir, { recursive: true, force: true });
});

const MARKDOWN = [
  "ОТЧЕТ",
  "",
  "## Квартал",
  "",
  "Текст абзаца с **жирным** словом.",
  "",
  "- первая строка списка",
  "- вторая строка списка",
  "",
  "| № | Мероприятие | Срок |",
  "|---|---|---|",
  "| 1 | Клуб «Омега» | 12.03.2026 |",
].join("\n");

test("markdown отчёта разбирается на заголовки, абзацы, списки и таблицу", () => {
  const blocks = tools.reportBlocks(MARKDOWN);
  const kinds = blocks.map((block) => block.kind);
  // «ОТЧЕТ» без решётки — обычный абзац, это так же и в Graphite Lite.
  assert.deepEqual(
    kinds,
    ["paragraph", "heading", "paragraph", "bullet", "bullet", "table"],
    "структура отчёта разобралась не так, как её ждёт заведующая",
  );
  const table = blocks.at(-1);
  assert.equal(table.rows.length, 2, "строка-разделитель не должна попасть в таблицу");
  assert.deepEqual(table.rows[0], ["№", "Мероприятие", "Срок"]);
  assert.equal(blocks[2].text, "Текст абзаца с жирным словом.", "маркеры ** убираются из абзаца");
});

test("таблица по табуляции распознаётся так же, как таблица по вертикальной черте", () => {
  const blocks = tools.reportBlocks("№\tМероприятие\tСрок\n1\tКлуб\t12.03.2026");
  assert.equal(blocks.length, 1, "две строки с табами должны собраться в одну таблицу");
  assert.equal(blocks[0].kind, "table");
  assert.equal(blocks[0].rows.length, 2);
});

test("кириллица в RTF пишется как \\uN?, а коды выше 32767 — со знаком минус", () => {
  assert.equal(
    tools.rtfEscape("Привет"),
    "\\u1055?\\u1088?\\u1080?\\u1074?\\u1077?\\u1090?",
    "каждый не-ASCII символ получает \\uN? — это не зависит от code page получателя",
  );
  assert.equal(tools.rtfEscape("ё"), "\\u1105?", "буква ё помещается в знаковый 16-бит без изменения");
  // Полноширинная «A» = 65313: выше 32767, поэтому знак минус обязателен.
  assert.equal(tools.rtfEscape("\uFF21"), "\\u-223?", "код выше 32767 обязан стать отрицательным");
  assert.equal(tools.rtfEscape("A"), "A", "ASCII пишется как есть");
  assert.equal(tools.rtfEscape("\\{"), "\\\\\\{", "обратная косая черта и скобки экранируются");
});

test("жирный внутри строки превращается в группу \\b, а пустые куски не дублируются", () => {
  assert.equal(
    tools.rtfInline("**bold**"),
    "{\\b bold}",
    "нечётный кусок между двумя ** оборачивается в группу жирного",
  );
  assert.equal(tools.rtfInline("**жирно**"), "{\\b \\u1078?\\u1080?\\u1088?\\u1085?\\u1086?}");
  assert.equal(tools.rtfInline("**a**b**c**"), "{\\b a}b{\\b c}", "маркеры не должны попасть в текст");
});

test("RTF начинается с \\rtf1, заканчивается скобкой и сбалансирован по группам", () => {
  const rtf = tools.blocksToRtf(tools.reportBlocks(MARKDOWN));
  assert.ok(rtf.startsWith("{\\rtf1\\ansi\\ansicpg1251"), "без шапки \\rtf1 Word не откроет файл");
  assert.ok(rtf.endsWith("}"), "документ RTF обязан закрываться одной скобкой");
  assert.equal(tools.braceBalance(rtf), 0, "скобки RTF разъехались — файл не откроется");
  assert.ok(rtf.includes("\\tab "), "таблица в RTF склеивается через \\tab");
  assert.ok(rtf.includes("{\\b "), "первая строка таблицы печатается жирной");
});

test("таблица в RTF остаётся читаемой: \\trowd в ней нет намеренно", () => {
  const rtf = tools.blocksToRtf(tools.reportBlocks(MARKDOWN));
  assert.ok(!rtf.includes("\\trowd"), "псевдотаблица не объявляет строки Word — так RTF открывается везде");
});

test("простой конвертер markdownToRtf тоже даёт сбалансированный документ", () => {
  const rtf = tools.markdownToRtf(MARKDOWN);
  assert.ok(rtf.startsWith("{\\rtf1"));
  assert.equal(tools.braceBalance(rtf), 0, "скобки простого конвертера разъехались");
});

test("DOCX — настоящий zip с тремя обязательными частями", () => {
  const docx = tools.blocksToDocx(tools.reportBlocks(MARKDOWN));
  assert.equal(Buffer.from(docx.subarray(0, 2)).toString("latin1"), "PK", "docx обязан начинаться с сигнатуры zip");
  const entries = tools.readZipEntries(docx);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["[Content_Types].xml", "_rels/.rels", "word/document.xml"],
    "Word открывает документ только когда объявлены ровно эти три части",
  );
  const document = new TextDecoder().decode(entries.at(-1).data);
  assert.ok(document.startsWith("<?xml"), "часть document.xml обязана начинаться с XML-заголовка");
  assert.ok(document.includes('<w:pgSz w:w="11906" w:h="16838"/>'), "страница A4 в twips");
  assert.ok(document.includes("<w:tbl>"), "таблица в DOCX настоящая, с рамками");
  assert.ok(document.includes('<w:insideV w:val="single"'), "у таблицы шесть границ, включая внутренние");
  assert.ok(document.includes("Клуб «Омега»"), "текст таблицы попадает в документ как есть");
});

test("DOCX экранирует специальные символы XML, иначе файл не распарсится", () => {
  const docx = tools.blocksToDocx(tools.reportBlocks("Строка с & и < и >."));
  const document = new TextDecoder().decode(tools.readZipEntries(docx).at(-1).data);
  assert.ok(document.includes("&amp;"), "ampersand должен быть экранирован");
  assert.ok(document.includes("&lt;"), "открывающая угловая скобка должна быть экранирована");
  assert.ok(!document.includes("с & и < и >"), "сырых & и < в тексте быть не должно");
});

test("ширины колонок DOCX пропорциональны длине текста и не меньше 400 twips", () => {
  const widths = tools.columnWidths([["№", "Очень длинная подпись раздела"], ["1", "x"]], 9026);
  assert.equal(widths.length, 2);
  assert.ok(widths[1] > widths[0], "длинная ячейка должна быть шире короткой");
  assert.ok(widths.every((width) => width >= 400), "узкая колонка Word переверстает по-своему");
  assert.ok(widths.reduce((sum, width) => sum + width, 0) <= 9026, "сумма не должна превышать ширину полосы");
});

test("ODT — zip, у которого mimetype записан первым и без сжатия", () => {
  const odt = tools.blocksToOdt(tools.reportBlocks(MARKDOWN));
  const entries = tools.readZipEntries(odt);
  assert.equal(entries[0].name, "mimetype", "ODF требует, чтобы mimetype шёл первым");
  assert.equal(entries[0].stored, true, "mimetype обязан лежать без сжатия, иначе LibreOffice не откроет файл");
  assert.equal(
    new TextDecoder().decode(entries[0].data),
    "application/vnd.oasis.opendocument.text",
  );
  assert.deepEqual(entries.map((entry) => entry.name), ["mimetype", "content.xml", "META-INF/manifest.xml"]);
  const content = new TextDecoder().decode(entries[1].data);
  assert.ok(content.includes('<text:h text:outline-level="2">'), "уровень заголовка markdown идёт в outline-level");
  assert.ok(content.includes('<table:table table:name="ReportTable"'), "таблица ODT использует автоматический стиль");
  assert.ok(content.includes("Клуб «Омега»"));
});

test("верхняя половина cp1251 в RTF декодируется верно, а не по памяти", () => {
  // Таблица из 128 символов задана кодовыми точками, но если в ней опечатка,
  // русский текст из чужого образца молча превратится в мусор. iconv-lite —
  // независимая реализация cp1251, с ней и сверяем.
  const hex = Array.from(
    { length: 128 },
    (_, index) => `\\'${(0x80 + index).toString(16).padStart(2, "0")}`,
  ).join("");
  const decoded = [...tools.rtfText(tools.tokenizeRtf(hex))];
  const bytes = Array.from({ length: 128 }, (_, index) => 0x80 + index);
  const expected = [...iconv.decode(Buffer.from(bytes), "cp1251")];
  // iconv-lite подменяет управляющий байт 0x98 знаком замены, поэтому его
  // сверяем отдельно: по cp1251 это U+0098.
  const skip = bytes.indexOf(0x98);
  assert.equal(
    decoded.filter((_, index) => index !== skip).join(""),
    expected.filter((_, index) => index !== skip).join(""),
    "таблица cp1251 разошлась с настоящей кодировкой",
  );
  assert.equal(decoded[skip], String.fromCodePoint(0x98), "байт 0x98 обязан декодироваться в U+0098");
});

test("помощники XML не ломают текст и снимают теги", () => {
  assert.equal(tools.xmlEscape("a & b"), "a &amp; b");
  assert.equal(tools.xmlUnescape("a &amp; b"), "a & b", "разэкранирование обязано быть обратным к экранированию");
  assert.equal(tools.stripXmlTags("<text:span>текст</text:span>"), "текст");
  assert.equal(tools.xmlEscapeText('"'), '"', "в тексте ячейки кавычки не экранируются — так же, как в образце");
});
