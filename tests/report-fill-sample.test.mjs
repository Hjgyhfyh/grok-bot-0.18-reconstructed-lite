import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// `fill_sample` — единственный путь, где сохраняется оформление настоящего
// документа: строки не пересоздаются, а вписываются в чужой файл. Именно
// поэтому сломаться он может тихо: документ остаётся «похожим на отчёт», но
// строки данных молча не вставились, шапка не заменилась или скобки RTF
// разъехались по группам. До этого переноса кода в проекте не было вовсе, и
// никто не проверял ни баланс скобок, ни то, что в образце вообще нашлись
// разделы. Тест проверяет именно это на всех трёх форматах.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let tools;
let buildDir;

before(async () => {
  buildDir = await mkdtemp(path.join(os.tmpdir(), "dbbot-report-fill-"));
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

const encoder = new TextEncoder();
const MARKDOWN = [  "| 3.1.2 | Работа с подростками | Дата проведения |",
  "|  | Клуб «Омега» | 12.03.2026 |",
].join("\n");

function rtfSample() {
  return [
    "{\\rtf1\\ansi\\ansicpg1251\\deff0{\\fonttbl{\\f0 Times New Roman;}}\\f0\\fs22",
    "ОТЧЕТ за 2026 год",
    "\\trowd\\trgaph108\\trleft-108\\cellx2000\\cellx4000\\cellx6000",
    "{\\b № п/п}\\cell {\\b Мероприятие}\\cell {\\b Срок}\\cell",
    "\\row",
    "\\trowd\\trgaph108\\trleft-108\\cellx2000\\cellx4000\\cellx6000",
    "3.1.2\\cell Работа с подростками\\cell Дата проведения\\cell",
    "\\row",
    "\\trowd\\trgaph108\\trleft-108\\cellx2000\\cellx4000\\cellx6000",
    "\\cell Название\\cell Дата\\cell",
    "\\row",
    "}",
  ].join("\n");
}

function docxSample() {
  const cell = (text, bold) =>
    `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr><w:p><w:r><w:rPr>${bold ? "<w:b/>" : ""}<w:sz w:val="24"/></w:rPr>`
    + `<w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:tc>`;
  const row = (cells, withProperties) =>
    `<w:tr>${withProperties ? '<w:trPr><w:trHeight w:val="500"/></w:trPr>' : ""}${cells}</w:tr>`;
  const document =
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
    + "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:tbl><w:tblPr>"
    + '<w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="808080"/></w:tblBorders>'
    + "</w:tblPr>"
    + row(cell("№ п/п", true) + cell("Мероприятие", true) + cell("Срок", true), true)
    + row(cell("3.1.2") + cell("Работа с подростками") + cell("Дата проведения"), false)
    + row(cell("") + cell("Название") + cell("Дата"), false)
    + "</w:tbl></w:body></w:document>";
  return tools.writeZip([
    { name: "[Content_Types].xml", data: encoder.encode("<Types/>") },
    { name: "_rels/.rels", data: encoder.encode("<Relationships/>") },
    { name: "word/styles.xml", data: encoder.encode('<w:styles><w:style w:styleId="Osnovnoy"/></w:styles>') },
    { name: "word/document.xml", data: encoder.encode(document) },
  ]);
}

function odtSample() {
  const cell = (text) =>
    `<table:table-cell table:style-name="Cell"><text:p>${text}</text:p></table:table-cell>`;
  const row = (cells) => `<table:table-row>${cells}</table:table-row>`;
  const content =
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
    + "<office:document-content xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\""
    + " xmlns:table=\"urn:oasis:names:tc:opendocument:xmlns:table:1.0\""
    + " xmlns:text=\"urn:oasis:names:tc:opendocument:xmlns:text:1.0\" office:version=\"1.2\">"
    + "<office:body><office:text><table:table table:name=\"Form\">"
    + row(cell("№ п/п") + cell("Мероприятие") + cell("Срок"))
    + row(cell("3.1.2") + cell("Работа с подростками") + cell("Дата проведения"))
    + row(cell("") + cell("Название") + cell("Дата"))
    + "</table:table></office:text></office:body></office:document-content>";
  return tools.writeZip([
    { name: "mimetype", data: encoder.encode("application/vnd.oasis.opendocument.text"), stored: true },
    { name: "content.xml", data: encoder.encode(content) },
    { name: "styles.xml", data: encoder.encode("<office:document-styles/>") },
  ]);
}

function fill(sampleName, bytes, markdown = MARKDOWN, replacements = []) {
  return tools.fillDocument({ sampleName, sampleBytes: bytes, markdown, replacements });
}

test("формат образца определяется по расширению, а не по содержимому", () => {
  assert.equal(tools.formatOf("C:\\Отчёты\\ОБРАЗЕЦ.RTF"), "rtf");
  assert.equal(tools.formatOf("образец.docx"), "docx");
  assert.equal(tools.formatOf("образец.odt"), "odt");
  assert.equal(tools.formatOf("отчёт.txt"), null, "для .txt заполнение образца невозможно");
  assert.equal(tools.formatOf("образец"), null);
});

test("RTF-образец: строки вставлены, скобки не разъехались, оформление осталось", () => {
  const { bytes, report } = fill("образец.rtf", encoder.encode(rtfSample()), MARKDOWN, [["2026 год", "2027 год"]]);
  const output = new TextDecoder().decode(bytes);

  assert.deepEqual(report.applied, [["3.1.2 Работа с подростками", 1]], "раздел отчёта не попал в образец");
  assert.deepEqual([...report.notFound], [], "раздел не найден — отчёт собран не полностью");
  assert.equal(report.removedRows, 1, "строка-пример «Название / Дата» обязана исчезнуть из итога");
  assert.equal(report.replacements, 1, "замена периода в шапке не выполнена");
  assert.equal(tools.braceBalance(output), 0, "скобки RTF разъехались — документ не откроется");

  const text = tools.rtfText(tools.tokenizeRtf(output));
  assert.ok(text.includes("Клуб «Омега»"), "строка данных не вставилась в образец");
  assert.ok(!text.includes("Название"), "строка-пример осталась в итоговом отчёте");
  assert.ok(text.includes("2027 год"), "период в шапке не заменился");
  assert.ok(!text.includes("2026 год"), "старый период остался в шапке");
  assert.ok(output.includes("\\cellx2000\\cellx4000\\cellx6000"), "ширины колонок образца потерялись");
  // В образце было три строки: шапка, раздел и строка-пример. Пример удалили,
  // строку данных вставили — строк по-прежнему три.
  assert.equal(output.match(/\\trowd/g).length, 3, "в документе должно быть 3 строки: шапка, раздел и строка данных");
});

test("DOCX-образец: текст ячеек меняется, а стили и форматирование остаются", () => {
  const { bytes, report } = fill("образец.docx", docxSample());
  const entries = tools.readZipEntries(bytes);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["[Content_Types].xml", "_rels/.rels", "word/styles.xml", "word/document.xml"],
    "части образца обязаны пережить пересборку архива",
  );
  assert.equal(
    new TextDecoder().decode(entries[2].data),
    '<w:styles><w:style w:styleId="Osnovnoy"/></w:styles>',
    "word/styles.xml переписан вместо копирования — оформление образца потеряно",
  );
  const document = new TextDecoder().decode(entries[3].data);
  assert.ok(document.includes("Клуб «Омега»"), "строка данных не вставилась в документ");
  assert.ok(!document.includes("Название"), "строка-пример осталась в итоговом документе");
  assert.ok(document.includes('<w:sz w:val="24"/>'), "кегль ячейки образца потерялся при клонировании строки");
  assert.ok(document.includes("<w:trPr><w:trHeight w:val=\"500\"/></w:trPr>"), "свойства строк таблицы должны сохраниться");
  assert.equal(report.applied.length, 1);
  assert.equal(report.notFound.length, 0);
});

test("ODT-образец: content.xml переписывается, остальные части копируются", () => {
  const { bytes, report } = fill("образец.odt", odtSample());
  const entries = tools.readZipEntries(bytes);
  assert.equal(entries[0].name, "mimetype");
  assert.equal(entries[0].stored, true, "mimetype обязан остаться первым и без сжатия");
  assert.equal(entries[2].name, "styles.xml");
  const content = new TextDecoder().decode(entries[1].data);
  assert.ok(content.includes("Клуб «Омега»"), "строка данных не вставилась в ODT");
  assert.ok(!content.includes("Название"), "строка-пример осталась в ODT");
  assert.ok(content.includes('table:style-name="Cell"'), "стиль ячейки образца потерялся");
  assert.equal(report.applied.length, 1);
});

test("замена в шапке работает и для DOCX, и не трогает тело таблицы", () => {
  const withHeader = docxSample();
  const { bytes } = tools.fillDocument({
    sampleName: "образец.docx",
    sampleBytes: withHeader,
    markdown: MARKDOWN,
    replacements: [["Название", "Заменено в шапке"]],
  });
  const document = new TextDecoder().decode(tools.readZipEntries(bytes).at(-1).data);
  assert.ok(!document.includes("Заменено в шапке"), "строка «Название» живёт в таблице, а не в шапке: заменять её нельзя");
});

test("раздел, которого нет в образце, попадает в отчёт как ненайденный, а не теряется молча", () => {
  const markdown = ["| 9.9.9 | Совершенно другой раздел | Дата |", "|  | Строка | 01.01.2026 |"].join("\n");
  const { bytes, report } = fill("образец.docx", docxSample(), markdown);
  assert.deepEqual([...report.notFound], ["9.9.9 Совершенно другой раздел"], "агент должен узнать о ненайденном разделе");
  assert.equal(report.applied.length, 0);
  const document = new TextDecoder().decode(tools.readZipEntries(bytes).at(-1).data);
  assert.ok(!document.includes("Строка"), "данные ненайденного раздела вставлены быть не должны");
});

test("ошибки называют причину по-русски, а не роняют инструмент с TypeError", () => {
  assert.throws(
    () => fill("отчёт.txt", encoder.encode("просто текст")),
    /нужен rtf\/docx\/odt/,
    "пользователь должен понять, что образец не тот",
  );
  assert.throws(() => fill("образец.rtf", encoder.encode("{\\rtf1\\ansi текст без таблиц}")), /в образце не найдено таблиц/);
  assert.throws(
    () => fill("образец.docx", docxSample(), "просто абзац без таблицы"),
    /не найдено ни одной таблицы-раздела/,
    "в отчёте нет ни одного раздела — заполнять нечего",
  );
});

test("образец без нужной части zip объясняет, чего не хватает", () => {
  const empty = tools.writeZip([{ name: "mimetype", data: encoder.encode("x") }]);
  assert.throws(
    () => fill("образец.docx", empty),
    /в образце нет части word\/document.xml/,
    "агент должен знать, что это не тот документ",
  );
});
