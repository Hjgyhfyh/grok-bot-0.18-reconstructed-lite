/**
 * Проверка заполнения образца — `fillDocument` из
 * `source/packages/report-tools/fill-sample.ts`, тот самый путь, по которому
 * помощник вписывает данные в бланк .rtf/.docx/.odt.
 *
 * Почему здесь нужен отдельный набор. Оформление чужого документа — это
 * обещание пользователю: заведующая библиотеки присылает бланк и ждёт на выходе
 * тот же бланк с вписанными данными. Ни сборка, ни упаковка, ни типизатор такое
 * обещание не проверяют — оно может нарушиться тихо, и единственный способ это
 * заметить — сравнить образец ДО и ПО.
 *
 * Набор состоит из двух групп.
 *
 * 1. Зелёные проверки: оформление (шрифты, кегли, ширины колонок, рамки),
 *    колонтитул, кириллица, одинаковые и вложенные метки, неприкосновенность
 *    исходного файла образца и стресс из 100 заполнений. Они нужны, чтобы
 *    починка дефектов ниже не сломала то, что работает.
 *
 * 2. Красные проверки: найденные дефекты. Каждая падает и доказывает, что
 *    обещание пользователю нарушается — либо данные теряются, либо оформление
 *    меняется, либо отчёт об успехе неправдив.
 *
 * Образцы собираются прямо здесь, в памяти: ни одного файла-фикстуры в
 * `tests/qa-fixtures/` не создаётся, поэтому ничего не остаётся после прогона.
 * Всё, что пишется на диск, живёт во временном каталоге `os.tmpdir()` и
 * удаляется в `after`.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// ───────────────────────── загрузка модуля ─────────────────────────

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let tools;
let bundleDir;

before(async () => {
  bundleDir = await mkdtemp(path.join(os.tmpdir(), "dbbot-qa1-bundle-"));
  const outfile = path.join(bundleDir, "report-tools.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source", "packages", "report-tools", "index.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  tools = await import(pathToFileURL(outfile).href);
});

after(async () => {
  if (bundleDir !== undefined) await rm(bundleDir, { recursive: true, force: true });
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ───────────────────────── образцы ─────────────────────────

const SECTION_ROW_PREFIX = "\\trowd\\trgaph108\\trleft-108\\trqc\\clvertalc\\clbrdrt\\brdrs\\clbrdrl\\brdrs\\clbrdrb\\brdrs\\clbrdrr\\brdrs\\cellx1200\\cellx3600\\cellx5400";

/** Кириллица в виде `\uN?` — ровно так её пишет Word. */
const rtfUnicode = (text) => {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0);
    out += code < 128 ? ch : `\\u${code > 32767 ? code - 65536 : code}?`;
  }
  return out;
};

/**
 * RTF-образец: три шрифта в шапке, три кегля, таблица с фиксированными
 * ширинами колонок и рамками, строка-раздел и строки-примеры.
 *
 * `cyrillic` решает, чем записана русская буква: `rtfUnicode` — escape-последовательностью
 * `\uN?` (Word), а `identity` оставляет букву как есть (её потом кодируют в cp1251).
 */
function rtfSample({
  footer = "",
  head = "за 2025 год\\par",
  sections = ["3.1.2"],
  cyrillic = rtfUnicode,
} = {}) {
  const lines = [
    "{\\rtf1\\ansi\\ansicpg1251\\deff0",
    "{\\fonttbl{\\f0 Times New Roman;}{\\f1 Arial;}{\\f2 Calibri;}}",
    "{\\colortbl;\\red0\\green0\\blue0;\\red255\\green0\\blue0;}",
    "{\\stylesheet{\\s0\\snext0 Normal;}}",
    "\\viewkind4\\uc1\\pard\\f0\\fs24\\b " + cyrillic("ОТЧЁТ") + "\\b0 " + cyrillic(head),
  ];
  lines.push(`${SECTION_ROW_PREFIX}`);
  lines.push(`{\\f2\\fs18\\b ${cyrillic("№ п/п")}}\\cell {\\f2\\fs18\\b ${cyrillic("Мероприятие")}}\\cell {\\f2\\fs18\\b ${cyrillic("Срок")}}\\cell\\row`);
  for (const number of sections) {
    lines.push(SECTION_ROW_PREFIX);
    lines.push(`${number}\\cell ${cyrillic(`Раздел ${number}`)}\\cell ${cyrillic("Дата проведения")}\\cell\\row`);
    lines.push(SECTION_ROW_PREFIX);
    lines.push(`\\cell ${cyrillic("Название мероприятия")}\\cell 01.01.2026\\cell\\row`);
  }
  if (footer.length > 0) lines.push(cyrillic(footer));
  lines.push("}");
  return lines.join("\n");
}

/** Кириллица → Windows-1251. Так пишут WordPad, старые Word и «Блокнот» в ANSI. */
const CP1251 = {
  А: 0xc0, Б: 0xc1, В: 0xc2, Г: 0xc3, Д: 0xc4, Е: 0xc5, Ж: 0xc6, З: 0xc7,
  И: 0xc8, Й: 0xc9, К: 0xca, Л: 0xcb, М: 0xcc, Н: 0xcd, О: 0xce, П: 0xcf,
  Р: 0xd0, С: 0xd1, Т: 0xd2, У: 0xd3, Ф: 0xd4, Х: 0xd5, Ц: 0xd6, Ч: 0xd7,
  Ш: 0xd8, Щ: 0xd9, Ъ: 0xda, Ы: 0xdb, Ь: 0xdc, Э: 0xdd, Ю: 0xde, Я: 0xdf,
  а: 0xe0, б: 0xe1, в: 0xe2, г: 0xe3, д: 0xe4, е: 0xe5, ж: 0xe6, з: 0xe7,
  и: 0xe8, й: 0xe9, к: 0xea, л: 0xeb, м: 0xec, н: 0xed, о: 0xee, п: 0xef,
  р: 0xf0, с: 0xf1, т: 0xf2, у: 0xf3, ф: 0xf4, х: 0xf5, ц: 0xf6, ч: 0xf7,
  ш: 0xf8, щ: 0xf9, ъ: 0xfa, ы: 0xfb, ь: 0xfc, э: 0xfd, ю: 0xfe, я: 0xff,
  "№": 0xb9, "«": 0xab, "»": 0xbb, "—": 0x97, ё: 0xb8, Ё: 0xa8, й: 0xa8,
};

function toCp1251(text) {
  const bytes = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x80) bytes.push(code);
    else if (CP1251[ch] !== undefined) bytes.push(CP1251[ch]);
    else throw new Error(`в тестовой таблице нет кода для «${ch}»`);
  }
  return Uint8Array.from(bytes);
}

const docxCell = (text, extraProps = "") =>
  `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr><w:p><w:r><w:rPr>`
  + `<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>${extraProps}`
  + `<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>`
  + `<w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:tc>`;

const docxRow = (cells, props = "") =>
  `<w:tr>${props === "" ? "" : `<w:trPr>${props}</w:trPr>`}${cells.join("")}</w:tr>`;

const DOCX_BORDERS = '<w:tblBorders>'
  + '<w:top w:val="single" w:sz="4" w:space="0" w:color="808080"/>'
  + '<w:left w:val="single" w:sz="4" w:space="0" w:color="808080"/>'
  + '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="808080"/>'
  + '<w:right w:val="single" w:sz="4" w:space="0" w:color="808080"/>'
  + "</w:tblBorders>";

const DOCX_GRID = '<w:tblGrid><w:gridCol w:w="1200"/><w:gridCol w:w="3600"/><w:gridCol w:w="5400"/></w:tblGrid>';

function docxZip(body, extraParts = []) {
  return tools.writeZip([
    { name: "[Content_Types].xml", data: encoder.encode("<Types/>") },
    { name: "_rels/.rels", data: encoder.encode("<Relationships/>") },
    { name: "word/styles.xml", data: encoder.encode('<w:styles><w:style w:styleId="a3"/></w:styles>') },
    ...extraParts,
    {
      name: "word/document.xml",
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
        + body
        + "</w:body></w:document>",
      ),
    },
  ]);
}

/** DOCX-образец: таблица с рамками, сеткой, шириной ячеек и строками разной высоты. */
function docxSample({ head = "", sections = ["3.1.2"], tail = "", extraParts = [] } = {}) {
  const rows = [
    docxRow([docxCell("№ п/п", "<w:b/>"), docxCell("Мероприятие", "<w:b/>"), docxCell("Срок", "<w:b/>")],
      '<w:trHeight w:val="567"/>'),
  ];
  for (const number of sections) {
    rows.push(docxRow([docxCell(number), docxCell(`Раздел ${number}`), docxCell("Дата проведения")]));
    rows.push(docxRow([docxCell(""), docxCell("Название мероприятия"), docxCell("01.01.2026")],
      '<w:trHeight w:val="340"/>'));
  }
  return docxZip(
    (head === "" ? "" : `<w:p>${head}</w:p>`)
    + `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblLayout w:type="fixed"/>${DOCX_BORDERS}</w:tblPr>${DOCX_GRID}`
    + rows.join("")
    + "</w:tbl>"
    + tail,
    extraParts,
  );
}

const docxText = (bytes, part = "word/document.xml") =>
  decoder.decode(tools.readZipEntries(bytes).find((entry) => entry.name === part).data);

const docxRun = (text, props = "") =>
  `<w:r><w:rPr>${props}<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr>`
  + `<w:t xml:space="preserve">${text}</w:t></w:r>`;

const rtfTextOf = (bytes) => tools.rtfText(tools.tokenizeRtf(decoder.decode(bytes)));

/** Отпечаток оформления RTF: всё, что описывает вид документа. */
function rtfLook(source) {
  const times = (pattern) => (source.match(pattern) ?? []).length;
  return {
    fontTable: source.match(/\{\\fonttbl[^}]*\}[^}]*\}/)?.[0] ?? "",
    colorTable: source.includes("{\\colortbl"),
    styleSheet: source.includes("{\\stylesheet"),
    fonts: (source.match(/\\f[0-9]\b/g) ?? []).length,
    sizes: (source.match(/\\fs[0-9]+/g) ?? []).join(","),
    columnWidths: (source.match(/\\cellx[0-9]+/g) ?? []).join(","),
    cellBorders: times(/\\clbrd[trbl]/g),
    borderStyles: times(/\\brdrs/g),
    rowAlignment: source.includes("\\trqc"),
    verticalAlign: source.includes("\\clvertalc"),
  };
}

// ═════════════════════ 1. ОФОРМЛЕНИЕ ДОЛЖНО ОСТАТЬСЯ ═════════════════════

test("RTF-образец: шрифты, кегли, ширины колонок и рамки после заполнения те же, что до", () => {
  const before = rtfSample();
  const { bytes, report } = tools.fillDocument({
    sampleName: "ОБРАЗЕЦ.rtf",
    sampleBytes: encoder.encode(before),
    markdown: "| 3.1.2 | Работа с подростками | Дата |\n|  | Клуб «Омега» | 12.03.2026 |",
    replacements: [["ОТЧЁТ", "ОТЧЁТ"], ["за 2025 год", "за 2026 год"]],
  });
  const after = rtfLook(decoder.decode(bytes));

  assert.deepEqual(after, rtfLook(before), "оформление образца изменилось — главное обещание инструмента нарушено");
  assert.ok(after.columnWidths.includes("\\cellx1200,\\cellx3600,\\cellx5400"), "ширины колонок потеряны");
  assert.ok(decoder.decode(bytes).includes("\\u1054?"), "строка данных не вставлена — сравнивать оформление не на чем");
  assert.equal(report.applied.length, 1, "раздел не попал в образец — сравнивать тут нечего");
});

test("DOCX-образец: шрифт, кегль, сетка, ширины ячеек и высота строк после заполнения те же, что до", () => {
  const before = docxSample();
  const { bytes } = tools.fillDocument({
    sampleName: "ОБРАЗЕЦ.docx",
    sampleBytes: before,
    markdown: "| 3.1.2 | Работа с подростками | Дата |\n|  | Клуб «Омега» | 12.03.2026 |",
    replacements: [],
  });
  const after = docxText(bytes);
  for (const fragment of [
    '<w:gridCol w:w="1200"/><w:gridCol w:w="3600"/><w:gridCol w:w="5400"/>',
    '<w:tcW w:w="2000" w:type="dxa"/>',
    '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>',
    '<w:sz w:val="24"/><w:szCs w:val="24"/>',
    '<w:trHeight w:val="567"/>',
    '<w:trHeight w:val="340"/>',
    '<w:top w:val="single" w:sz="4" w:space="0" w:color="808080"/>',
    '<w:tblLayout w:type="fixed"/>',
  ]) {
    const inBefore = docxText(before).includes(fragment);
    assert.equal(after.includes(fragment), inBefore, `оформление образца изменилось: ${fragment}`);
  }
  assert.equal(
    decoder.decode(tools.readZipEntries(bytes).find((e) => e.name === "word/styles.xml").data),
    '<w:styles><w:style w:styleId="a3"/></w:styles>',
    "word/styles.xml переписан вместо копирования — шрифты образца потеряны",
  );
});

test("DOCX-образец с колонтитулом: footer1.xml переносится в готовый документ без правок", () => {
  const footer = '<w:ftr><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:sz w:val="18"/></w:rPr>'
    + '<w:t xml:space="preserve">МБУК «Центральная городская библиотека» — стр. 1</w:t></w:r></w:p></w:ftr>';
  const { bytes } = tools.fillDocument({
    sampleName: "ОБРАЗЕЦ.docx",
    sampleBytes: docxSample({ extraParts: [{ name: "word/footer1.xml", data: encoder.encode(footer) }] }),
    markdown: "| 3.1.2 | Работа с подростками | Дата |\n|  | Клуб «Омега» | 12.03.2026 |",
    replacements: [],
  });
  const entries = tools.readZipEntries(bytes);
  assert.ok(entries.some((entry) => entry.name === "word/footer1.xml"), "колонтитул исчез из готового документа");
  assert.equal(docxText(bytes, "word/footer1.xml"), footer, "колонтитул образца переписан — оформление страницы изменилось");
});

test("кириллица из отчёта попадает в RTF как \\uN? и читается обратно без потерь", () => {
  const { bytes } = tools.fillDocument({
    sampleName: "ОБРАЗЕЦ.rtf",
    sampleBytes: encoder.encode(rtfSample()),
    markdown: "| 3.1.2 | Работа с подростками | Дата |\n|  | Клуб «Омега» № 7 | 12.03.2026 |",
    replacements: [],
  });
  const source = decoder.decode(bytes);
  assert.ok(!/[Ѐ-ӿ]/.test(source), "кириллица записана прямо в RTF байтами UTF-8 — Word прочитает её как мусор");
  assert.ok(rtfTextOf(bytes).includes("Клуб «Омега» № 7"), "кириллица из отчёта не читается обратно");
});

test("шапка с двумя одинаковыми метками меняет обе, а не только первую", () => {
  const docx = docxSample({ head: `${docxRun("ФИО: ")}${docxRun("{{name}}", "<w:b/>")}${docxRun(" и ещё раз {{name}}")}` });
  const { bytes, report } = tools.fillDocument({
    sampleName: "ОБРАЗЕЦ.docx",
    sampleBytes: docx,
    markdown: "| 3.1.2 | Работа с подростками | Дата |\n|  | Клуб «Омега» | 12.03.2026 |",
    replacements: [["{{name}}", "Петров"]],
  });
  const head = docxText(bytes).split("<w:tbl")[0];
  const headText = head.replace(/<[^>]+>/g, "");
  assert.ok(!headText.includes("{{name}}"), "вторая метка осталась в шапке — документ уехал в учреждение с «{{name}}»");
  assert.ok(headText.includes("ФИО: Петров") && headText.includes("ещё раз Петров"), `замена не сработала: ${headText}`);
  assert.equal(report.replacements, 1, "считается число пар, а не вхождений — так и задумано");

  const rtf = encoder.encode(rtfSample({ head: "ФИО: {{name}} и ещё раз {{name}}\\par" }));
  const rtfFilled = tools.fillDocument({
    sampleName: "ОБРАЗЕЦ.rtf",
    sampleBytes: rtf,
    markdown: "| 3.1.2 | Работа с подростками | Дата |\n|  | Клуб «Омега» | 12.03.2026 |",
    replacements: [["{{name}}", "Петров"]],
  });
  assert.ok(!rtfTextOf(rtfFilled.bytes).includes("{{name}}"), "в RTF вторая метка осталась в шапке");
});

test("метка с вложенными скобками заменяется вместе со скобками, лишних скобок не остаётся", () => {
  const docx = docxSample({ head: docxRun("Читатель: {{name}}, адрес: {адрес}") });
  const { bytes } = tools.fillDocument({
    sampleName: "ОБРАЗЕЦ.docx",
    sampleBytes: docx,
    markdown: "| 3.1.2 | Работа с подростками | Дата |\n|  | Клуб «Омега» | 12.03.2026 |",
    replacements: [["{{name}}", "Петров"], ["{адрес}", "ул. Ленина, 5"]],
  });
  const head = docxText(bytes).split("<w:tbl")[0];
  assert.ok(head.includes("Читатель: Петров, адрес: ул. Ленина, 5"), `шапка заполнена неверно: ${head}`);
  assert.ok(!head.includes("{") && !head.includes("}"), "в шапке остались осколки шаблонных скобок");
});

test("замена, которой нет в образце, не ломает документ: скобки RTF остаются сбалансированными", () => {
  const { bytes, report } = tools.fillDocument({
    sampleName: "ОБРАЗЕЦ.rtf",
    sampleBytes: encoder.encode(rtfSample()),
    markdown: "| 3.1.2 | Работа с подростками | Дата |\n|  | Клуб «Омега» | 12.03.2026 |",
    replacements: [["Библиотека № 7", "Библиотека № 12"]],
  });
  const source = decoder.decode(bytes);
  assert.equal(tools.braceBalance(source), 0, "замена, которой не было, разъехала скобки RTF");
  assert.equal(report.applied.length, 1, "строка данных всё равно должна была вставиться");
});

// ═════════════════════ 2. ИСХОДНЫЙ ОБРАЗЕЦ ═════════════════════

let dataRoot;
let skillsDir;

before(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "dbbot-qa1-data-"));
  skillsDir = path.join(dataRoot, "skills");
  await mkdir(skillsDir, { recursive: true });
});

after(async () => {
  if (dataRoot !== undefined) await rm(dataRoot, { recursive: true, force: true });
});

const fillTool = () => tools.createReportTools({ dataRoot, skillsDir }).find((tool) => tool.name === "fill_sample");

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

const TOOL_MARKDOWN = [
  "| 3.1.2 | Работа с подростками | Дата |",
  "|  | Клуб «Омега» | 12.03.2026 |",
  "|  | Дворец культуры | 20.03.2026 |",
].join("\n");

test("файл образца на диске не меняется после успешного заполнения", async () => {
  const samplePath = path.join(dataRoot, "ОБРАЗЕЦ-неприкосновенный.rtf");
  const original = encoder.encode(rtfSample({ footer: "{\\footer Колонтитул\\par}" }));
  await writeFile(samplePath, original);

  const message = await fillTool().execute({
    sample_path: samplePath,
    title: "Проверка образца",
    markdown: TOOL_MARKDOWN,
    replacements: [["за 2025 год", "за 2026 год"]],
  });

  assert.ok(message.includes("шрифты и таблицы сохранены"), "инструмент не отчитался об успешном заполнении");
  assert.equal(digest(await readFile(samplePath)), digest(original), "исходный образец переписан — следующий отчёт поедет по изменённой форме");
});

test("файл образца остаётся целым, даже когда заполнение падает на середине", async () => {
  const samplePath = path.join(dataRoot, "ОБРАЗЕЦ-с-падением.docx");
  const original = docxSample({ head: docxRun("Отчёт за 2025 год") });
  await writeFile(samplePath, original);
  const before = digest(await readFile(samplePath));

  await assert.rejects(
    () => fillTool().execute({
      sample_path: samplePath,
      title: "Упадёт",
      markdown: "просто абзац без таблицы",
      replacements: [["за 2025 год", "за 2026 год"]],
    }),
    "заполнение обязано упасть на отчёте без единой таблицы",
  );

  assert.equal(digest(await readFile(samplePath)), before, "после падения образец остался битым — чинить его больше нечем");
  assert.deepEqual(
    (await readFile(samplePath)).byteLength,
    original.byteLength,
    "размер образца изменился после неудачного заполнения",
  );
});

test("100 образцов подряд: заполнение укладывается в разумное время и не течёт памятью", async () => {
  const samplePath = path.join(dataRoot, "ОБРАЗЕЦ-стресс.rtf");
  const original = encoder.encode(rtfSample({ sections: ["1.1", "2.1", "3.1", "4.1", "5.1", "6.1"] }));
  await writeFile(samplePath, original);
  const sampleHash = digest(await readFile(samplePath));
  const markdown = ["1.1", "2.1", "3.1", "4.1", "5.1", "6.1"]
    .flatMap((number) => [
      `| ${number} | Мероприятие № ${number} | Дата |`,
      `|  | Клуб «Омега» ${number} | 12.03.2026 |`,
      `|  | Дворец культуры ${number} | 20.03.2026 |`,
    ])
    .join("\n");

  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const started = process.hrtime.bigint();
  for (let index = 0; index < 100; index += 1) {
    await fillTool().execute({
      sample_path: samplePath,
      title: `Стресс ${index}`,
      markdown,
      replacements: [["за 2025 год", "за 2026 год"]],
    });
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const heapGrowthMb = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);

  assert.ok(elapsedMs < 20_000, `100 заполнений заняли ${elapsedMs.toFixed(0)} мс — на слабом компьютере пользователь будет ждать вечно`);
  assert.ok(heapGrowthMb < 150, `за 100 заполнений куча выросла на ${heapGrowthMb.toFixed(0)} МБ — образцы обрабатываются без освобождения памяти`);
  assert.equal(digest(await readFile(samplePath)), sampleHash, "после 100 заполнений исходный образец изменился");
});

// ═════════════════════ 3. ДЕФЕКТЫ ═════════════════════

test("ДЕФЕКТ 1 (КРИТИЧНО): RTF в Windows-1251 после заполнения превращается в «�» — весь русский текст потерян", () => {
  // Модуль сам объявляет поддержку `\ansicpg1251` и держит таблицу CP1251_HIGH
  // для чтения `\'d0`-escape'ов, то есть про ANSI-RTF знает. Но байты файла он
  // читает через `new TextDecoder()` — а тот по умолчанию UTF-8. Образец, сохранённый
  // в Windows-1251 (WordPad, старый Word, «Блокнот» в ANSI), проходит сквозь
  // подстановку U+FFFD на каждый русский символ.
  const sample = toCp1251(rtfSample({ sections: ["3.1.2"], cyrillic: (text) => text }));
  const { bytes, report } = tools.fillDocument({
    sampleName: "ОБРАЗЕЦ.rtf",
    sampleBytes: sample,
    markdown: "| 3.1.2 | Работа с подростками | Дата |\n|  | Клуб «Омега» | 12.03.2026 |",
    replacements: [["за 2025 год", "за 2026 год"]],
  });
  const source = decoder.decode(bytes);
  const text = rtfTextOf(bytes);

  assert.equal(
    (source.match(/�/g) ?? []).length,
    0,
    `в готовом документе ${(source.match(/�/g) ?? []).length} символов «�» вместо русского текста — заведующая отправит в учреждение документ, который не прочитать`,
  );
  assert.ok(text.includes("ОТЧЁТ"), `шапка образца потеряна: ${JSON.stringify(text.slice(0, 80))}`);
  assert.equal(report.replacements, 1, "замена года в ANSI-образце не выполнена, а инструмент об этом не сказал");
});

test("ДЕФЕКТ 2 (КРИТИЧНО): колонки отчёта, которых нет в образце, теряются молча", () => {
  // У бланка две колонки, а отчёт собран на пять: дата, ответственный, количество.
  // `cloneRow` идёт по ячейкам образца и берёт `newCells[index] ?? ""`,
  // поэтому всё лишнее просто некуда деть — и пропадает без следа.
  const docx = docxSample({ head: docxRun("Отчёт за 2025 год") });
  const { bytes, report } = tools.fillDocument({
    sampleName: "ОБРАЗЕЦ.docx",
    sampleBytes: docx,
    markdown: [
      "| 3.1.2 | Работа с подростками | Дата проведения | Ответственный | Количество |",
      "|  | Клуб «Омега» | 12.03.2026 | Иванова А. П. | 15 |",
    ].join("\n"),
    replacements: [],
  });
  const document = docxText(bytes);

  assert.ok(document.includes("12.03.2026"), "дата проведения пропала из документа — по ней считают отчётность");
  assert.ok(document.includes("Иванова А. П."), "ответственный пропал из документа");
  assert.ok(document.includes(">15<"), "количество мероприятий пропало из документа");
  assert.equal(report.applied.length, 1, "раздел в отчёте есть");
  assert.deepEqual([...report.warnings], [], "о расхождении колонок отчёта и образца пользователю не сказали");
});

test("ДЕФЕКТ 3 (ВАЖНО): метка шапки в DOCX, разорванная Word на прогоны, не заменяется и об этом не сообщается", () => {
  // Word режет «ФИО» на два прога, как только внутри слова меняется начертание
  // или срабатывает правописание. `applyXmlHeaderReplacement` ищетold-текст
  // внутри одного `<w:t>`, поэтому не находит его вообще.
  const split = docxSample({
    head: docxRun("Ф.И.О.: ") + docxRun("Ф", "<w:b/>") + docxRun("И", "<w:i/>") + docxRun("О"),
  });
  const whole = docxSample({ head: docxRun("Ф.И.О.: ФИО") });

  const splitResult = tools.fillDocument({
    sampleName: "ОБРАЗЕЦ.docx",
    sampleBytes: split,
    markdown: "| 3.1.2 | Работа с подростками | Дата |\n|  | Клуб «Омега» | 12.03.2026 |",
    replacements: [["ФИО", "Иванова А. П."]],
  });
  const head = docxText(splitResult.bytes).split("<w:tbl")[0];
  const headText = head.replace(/<[^>]+>/g, "");

  assert.equal(splitResult.report.replacements, 1, "замена ФИО в шапке не выполнена");
  assert.ok(headText.includes("Ф.И.О.: Иванова А. П."), `в шапке осталась метка: ${headText}`);

  const wholeResult = tools.fillDocument({
    sampleName: "ОБРАЗЕЦ.docx",
    sampleBytes: whole,
    markdown: "| 3.1.2 | Работа с подростками | Дата |\n|  | Клуб «Омега» | 12.03.2026 |",
    replacements: [["ФИО", "Иванова А. П."]],
  });
  assert.equal(wholeResult.report.replacements, 1, "цельная метка меняется — дефект именно в разрыве на прогоны");
});

test("ДЕФЕКТ 4 (ВАЖНО): при удалении ненужной последней строки RTF-образец теряет колонтитул", () => {
  // `balancedFragment` доводит конец строки таблицы до ближайшей скобки,
  // возвращающей баланс, — а это уже `}` группы `{\footer ...}` после таблицы.
  // Отчёт не покрывает последний раздел образца → строка удаляется → колонтитул
  // уезжает вместе с ней, и `removedRows` об этом не говорит.
  const sample = rtfSample({
    footer: "{\\footer \\pard\\plain\\f0\\fs20 Колонтитул: МБУК, стр. 1\\par}",
    sections: ["3.1.2", "3.2.4"],
  });
  const { bytes, report } = tools.fillDocument({
    sampleName: "ОБРАЗЕЦ.rtf",
    sampleBytes: encoder.encode(sample),
    markdown: "| 3.1.2 | Работа с подростками | Дата |\n|  | Клуб «Омега» | 12.03.2026 |",
    replacements: [],
  });
  const source = decoder.decode(bytes);

  assert.ok(source.includes("{\\footer"), "колонтитул образца исчез из готового документа — на каждой странице пропала подпись");
  assert.ok(rtfTextOf(bytes).includes("МБУК"), "текст колонтитула потерян");
  assert.equal(report.removedRows, 3, "удалены строка-раздел 3.2.4, её строка-пример и строка-пример раздела 3.1.2");
  assert.deepEqual([...report.notFound], [], "все разделы отчёта нашлись в образце — дело не в поиске разделов");
});

test("ДЕФЕКТ 5 (ВАЖНО): замена, которой в образце нет, не попадает в отчёт — помощник рапортует «готово»", async () => {
  const samplePath = path.join(dataRoot, "ОБРАЗЕЦ-шапка.docx");
  await writeFile(samplePath, docxSample({ head: docxRun("Отчёт за 2025 год, библиотека № 9") }));

  const message = await fillTool().execute({
    sample_path: samplePath,
    title: "Проверка шапки",
    markdown: TOOL_MARKDOWN,
    replacements: [["за 2025 год", "за 2026 год"], ["Библиотека № 7", "Библиотека № 12"]],
  });

  assert.ok(
    message.includes("Библиотека № 7") || message.includes("не найдена") || message.includes("не заменена"),
    `помощнику не сказали, что пара «Библиотека № 7 → Библиотека № 12» не нашлась. Он пишет пользователю «готово»: ${message}`,
  );
});

test("ДЕФЕКТ 6 (ВАЖНО): год в колонтитуле DOCX остаётся старым, а инструмент отчитывается об успешной замене", async () => {
  const footer = '<w:ftr><w:p><w:r><w:t xml:space="preserve">Отчёт за 2025 год — стр. 1</w:t></w:r></w:p></w:ftr>';
  const samplePath = path.join(dataRoot, "ОБРАЗЕЦ-с-колонтитулом.docx");
  await writeFile(samplePath, docxSample({
    head: docxRun("Отчёт за 2025 год"),
    extraParts: [{ name: "word/footer1.xml", data: encoder.encode(footer) }],
  }));

  const message = await fillTool().execute({
    sample_path: samplePath,
    title: "Проверка колонтитула",
    markdown: TOOL_MARKDOWN,
    replacements: [["за 2025 год", "за 2026 год"]],
  });
  const documentPath = path.join(dataRoot, "Отчёты", "Проверка колонтитула.docx");
  const entries = tools.readZipEntries(await readFile(documentPath));
  const allText = entries.map((entry) => decoder.decode(entry.data)).join("\n");

  assert.ok(!allText.includes("2025 год"), "в готовом документе остался 2025 год — колонтитул печатается на каждой странице");
  assert.ok(message.includes("замен в шапке: 1"), `инструмент отчитался: ${message}`);
});

test("ДЕФЕКТ 7 (ВАЖНО): шапка под таблицей (подпись и ФИО) не заполняется — замена ищется только выше первой таблицы", () => {
  // Многие бланки Word подписываются ПОД таблицей: «Составил: ____».
  // `applyXmlHeaderReplacement` режет документ по первой `<w:tbl` и до подписи
  // не доходит вовсе.
  const docx = docxSample({
    head: docxRun("Отчёт за 2025 год"),
    tail: `<w:p>${docxRun("Составил: ____________________", "<w:b/>")}${docxRun("ФИО")}</w:p>`,
  });
  const { bytes, report } = tools.fillDocument({
    sampleName: "ОБРАЗЕЦ.docx",
    sampleBytes: docx,
    markdown: "| 3.1.2 | Работа с подростками | Дата |\n|  | Клуб «Омега» | 12.03.2026 |",
    replacements: [["ФИО", "Иванова А. П."], ["2025", "2026"]],
  });
  const tail = docxText(bytes).split("</w:tbl>")[1] ?? "";

  assert.equal(report.replacements, 2, "обе замены должны были выполниться — и подпись под таблицей в том числе");
  assert.ok(tail.includes("Составил: ____________________Иванова А. П."), `подпись под таблицей не заполнена: ${tail.replace(/<[^>]+>/g, "|")}`);
});