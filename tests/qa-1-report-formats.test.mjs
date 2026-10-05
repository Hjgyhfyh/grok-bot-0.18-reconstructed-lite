/**
 * Конвертация отчётов: markdown → rtf / docx / odt / md.
 *
 * Отчёт — единственное, что заведующая библиотеки уносит из программы
 * на сторону: сдаёт его на работу, в бухгалтерию, в комитет. Всё, что
 * конвертер делает «молча и неправильно», попадает прямо в подписанный
 * документ, и пользователь узнаёт об этом уже после сдачи.
 *
 * Существующие тесты (tests/report-formats.test.mjs, tests/report-tools.test.mjs)
 * проверяют структуру: у RTF есть шапка `\rtf1`, скобки сбалансированы,
 * у DOCX три части, у ODT `mimetype` первый и без сжатия. Структура везде
 * правильная. Но они проверяют ТИПИЧНУЮ прозу — кириллицу, цифры,
 * две-три колонки — и поэтому молчат о четырёх вещах, которые ломают
 * уже готовый документ:
 *
 *  1. Эмодзи и любой символ вне BMP (`codePointAt > 65535`) ломается в RTF.
 *     `\uN` в RTF — знаковый 16-бит, а `for...of` идёт по кодовой точке.
 *     Вычитание 65536 один раз даёт число, которое всё равно не влезает
 *     в 16 бит: U+1F600 (😀) пишется как `\u62976?` и при обратном чтении
 *     даёт U+F600 — чужой символ. Граница ломается уже на U+10000:
 *     `\u10000` превращается в `\u0?`, то есть в NUL.
 *  2. Маркеры `**` доходят до документа буквально. `reportBlocks` снимает
 *     их с абзацев и списков, но НЕ с ячеек таблиц и НЕ с заголовков.
 *     В DOCX и ODT жирного нет вообще, поэтому `**Итого**` печатается
 *     звёздочками. В RTF заголовок ещё и превращается в жирный — два
 *     соседних места документа ведут себя по-разному.
 *  3. Заголовки 4–6 уровня не распознаются: регулярка `^(#{1,3})\s+`
 *     не берёт `####`, строка падает в абзац, и в документе видно
 *     `#### Четвёртый` вместе с решётками.
 *  4. ODT не дополняет строку до числа колонок, DOCX — дополняет.
 *     Строка из двух ячеек между строками из трёх и четырёх сдвигает
 *     колонки, и в LibreOffice «Название мероприятия» оказывается
 *     не в той колонке, что данные.
 *
 * Здесь нет проверок «всё хорошо», которые проходят зелёными и ничего
 * не значат: 500 документов подряд, 100 000 знаков и 200 повторов
 * замеряются числами, а утверждениями стоят только те проверки, что
 * сейчас падают.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let tools;
let buildDir;

before(async () => {
  buildDir = await mkdtemp(path.join(os.tmpdir(), "dbbot-qa1-report-formats-"));
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

/** Текст из готового DOCX: содержимое всех `<w:t>` по порядку. */
function docxText(docx) {
  const entries = tools.readZipEntries(docx);
  const document = new TextDecoder().decode(entries.find((e) => e.name === "word/document.xml").data);
  return [...document.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((match) => match[1]);
}

/** Текст из готового ODT: содержимое всех `<text:p>` и `<text:h>` по порядку. */
function odtText(odt) {
  const entries = tools.readZipEntries(odt);
  const content = new TextDecoder().decode(entries.find((e) => e.name === "content.xml").data);
  return [...content.matchAll(/<text:(?:p|h)[^>]*>([^<]*)<\/text:(?:p|h)>/g)].map((match) => match[1]);
}

/** Обратное чтение собственного RTF: тот же путь, что у `fill_sample`. */
function rtfRoundTrip(rtf) {
  return tools.rtfText(tools.tokenizeRtf(rtf));
}

// ─────────────────────── 1. Символы вне BMP в RTF ───────────────────────

test("RTF обязан вернуть эмодзи в исходный символ, а не в символ частной области", () => {
  const smile = "\u{1F600}";
  const rtf = tools.blocksToRtf(tools.reportBlocks(`Мероприятие прошло ${smile} отлично`));
  const back = rtfRoundTrip(rtf);
  const marker = "Мероприятие прошло ";
  const got = [...back.slice(back.indexOf(marker) + marker.length)][0];

  assert.ok(
    back.includes(smile),
    `эмодзи U+1F600 не доехал: на его месте документ содержит `
    + `U+${(got?.codePointAt(0) ?? 0).toString(16).toUpperCase()} — `
    + `запись \\uN? исказила кодовую точку вне BMP`,
  );
  assert.equal(
    tools.rtfEscape(smile),
    "\\u-10179?\\u-8704?",
    "RTF не умеет хранить символы вне BMP иначе, чем сурогатной парой из двух \\uN?",
  );
});

test("граница 16-битного \\uN не срезает символ: U+10000 обязан стать парой, а не NUL", () => {
  // U+FFFF — последний код в BMP, влезает в знаковый 16-бит без правок.
  assert.equal(
    tools.rtfEscape("\uFFFF"),
    "\\u-1?",
    "верхняя граница BMP обязана помещаться в знаковый 16-бит",
  );

  const linearB = "\u{10000}";
  assert.equal(
    rtfRoundTrip(tools.rtfEscape(linearB)),
    linearB,
    `U+10000 записано как «${tools.rtfEscape(linearB)}» — это код ${Number(/\\u(-?\d+)/.exec(tools.rtfEscape(linearB))[1])}, `
    + "а не U+10000: символ вне BMP обязан вернуться сам собой",
  );

  assert.notEqual(
    tools.rtfEscape(linearB),
    tools.rtfEscape("\u{20000}"),
    "два разных символа вне BMP не должны записаться одинаково — значит код где-то срезается",
  );
});

test("полный цикл эмодзи: граница региона, флаг и имена округляются, а не молчат", () => {
  // 🇳 — флаг Нидерландов, два code point, которые читатель видит как один.
  const samples = ["\u{1F600}", "\u{1F1F3}\u{1F1F1}", "\u{1FAE0}", "🏫", "\u{10000}"];
  for (const sample of samples) {
    const rtf = tools.blocksToRtf(tools.reportBlocks(sample));
    assert.ok(
      rtfRoundTrip(rtf).includes(sample),
      `символ U+${sample.codePointAt(0).toString(16).toUpperCase()} не пережил `
      + `переход markdown → RTF → чтение текста обратно`,
    );
  }
});

test("эмодзи в DOCX и ODT переживают конвертацию — дефект только в RTF", () => {
  // Этот тест зелёный: он отделяет дефект RTF от дефекта формата в целом.
  // XML держит UTF-8, поэтому эмодзи там обязаны сохраниться.
  const markdown = "Итог: план выполнен \u{1F600}";
  assert.ok(
    docxText(tools.blocksToDocx(tools.reportBlocks(markdown))).some((text) => text.includes("\u{1F600}")),
    "DOCX хранит текст в UTF-8, эмодзи обязан дойти",
  );
  assert.ok(
    odtText(tools.blocksToOdt(tools.reportBlocks(markdown))).some((text) => text.includes("\u{1F600}")),
    "ODT хранит текст в UTF-8, эмодзи обязан дойти",
  );
});

// ─────────────────────── 2. Жирный в разных местах документа ───────────────────────

test("ячейка таблицы не должна печатать маркеры ** звёздочками ни в одном формате", () => {
  const markdown = [
    "| № | Мероприятие | Итого |",
    "|---|---|---|",
    "| 1 | Клуб «Омега» | **120** |",
  ].join("\n");
  const blocks = tools.reportBlocks(markdown);
  assert.deepEqual(
    blocks.at(-1).rows[1],
    ["1", "Клуб «Омега»", "120"],
    "разбор отчёта обязан снять маркеры жирного с ячейки — иначе они попадут в документ",
  );

  const rtf = tools.blocksToRtf(blocks);
  assert.ok(
    !rtf.includes("*"),
    "в RTF попали звёздочки вместо жирного — заведующая увидит «**120**» в готовом отчёте",
  );

  const docx = docxText(tools.blocksToDocx(blocks));
  assert.ok(
    !docx.some((cell) => cell.includes("*")),
    `в DOCX ячейка напечатана как «${docx.at(-1)}» — жирный не поддержан, маркер обязан исчезнуть`,
  );

  const odt = odtText(tools.blocksToOdt(blocks));
  assert.ok(
    !odt.some((cell) => cell.includes("*")),
    `в ODT ячейка напечатана как «${odt.at(-1)}» — жирный не поддержан, маркер обязан исчезнуть`,
  );
});

test("жирный в заголовке одинаков во всех трёх форматах, а не только в RTF", () => {
  // RTF заголовок делает жирным, DOCX и ODT — нет. Один и тот же markdown
  // даёт три разных документа, и в двух из трёх звёздочки видны пользователю.
  const markdown = "## **Квартальный отчёт**";
  const blocks = tools.reportBlocks(markdown);

  assert.ok(
    tools.blocksToRtf(blocks).includes("{\\b "),
    "RTF умеет жирный в заголовке — это база, от неё отталкиваемся",
  );
  assert.ok(
    !docxText(tools.blocksToDocx(blocks)).some((text) => text.includes("*")),
    "в DOCX заголовок напечатан с маркерами ** — пользователь видит служебные символы",
  );
  assert.ok(
    !odtText(tools.blocksToOdt(blocks)).some((text) => text.includes("*")),
    "в ODT заголовок напечатан с маркерами ** — пользователь видит служебные символы",
  );
});

test("жирный в абзаце и в списке одинаков: он либо есть везде, либо его нет нигде", () => {
  const markdown = "Строка с **жирным** словом.\n\n- пункт с **жирным** словом";
  const rtf = tools.blocksToRtf(tools.reportBlocks(markdown));

  // Сейчас `reportBlocks` снимает ** с абзацев и списков, и жирного в RTF
  // не остаётся нигде. Если завтра добавят поддержку, она обязана появиться
  // и здесь, иначе документ снова станет разношёрстным.
  const body = rtf.slice(90);
  const hasBold = body.includes("{\\b ");
  assert.equal(
    hasBold,
    false,
    "жирный должен быть снят одинаково: сейчас RTF не содержит группы \\b — "
    + "это зафиксировано, чтобы правка жирного не заддела абзацы только с одной стороны",
  );
  assert.ok(
    !body.includes("*"),
    "маркеры ** не должны попасть в RTF ни через один путь разбора",
  );
});

// ─────────────────────── 3. Заголовки всех уровней ───────────────────────

test("заголовки 4–6 уровня не должны попадать в документ с решётками", () => {
  const markdown = "# Раз\n## Два\n### Три\n#### Четыре\n##### Пять\n###### Шесть";
  const blocks = tools.reportBlocks(markdown);

  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["heading", "heading", "heading", "heading", "heading", "heading"],
    "markdown допускает шесть уровней заголовка — все шесть должны стать заголовками",
  );
  assert.deepEqual(
    blocks.map((block) => block.level),
    [1, 2, 3, 4, 5, 6],
    "уровень заголовка обязан дойти до документа, а не потеряться вместе с решётками",
  );

  const odt = new TextDecoder().decode(tools.readZipEntries(tools.blocksToOdt(blocks))[1].data);
  assert.deepEqual(
    [...odt.matchAll(/text:outline-level="(\d)"/g)].map((match) => match[1]),
    ["1", "2", "3", "4", "5", "6"],
    "в ODT уровень заголовка пишется в outline-level — шесть уровней обязаны дойти до файла",
  );

  const rtf = tools.blocksToRtf(blocks);
  assert.ok(
    !rtf.includes("#"),
    `в RTF остались решётки: «${(rtf.match(/#+[^\\\\]*/) ?? [""])[0]}» — `
    + "заголовок четвёртого уровня напечатан как обычный текст вместе с разметкой",
  );
});

// ─────────────────────── 4. Таблицы разной ширины ───────────────────────

test("ODT дополняет строку до числа колонок так же, как DOCX, иначе колонки разъезжаются", () => {
  // DOCX уже дополняет: `row[columnIndex] ?? ""`. ODT идёт по `for (const cell of row)`
  // и короткие строки оставляет короткими. В LibreOffice колонка «Мероприятие»
  // такой строки встаёт на место соседней, и данные перестают совпадать с шапкой.
  const markdown = [
    "| № | Мероприятие | Срок |",
    "|---|---|---|",
    "| 1 | Клуб «Омега» | 12.03.2026 |",
    "| 2 | День книги |",
    "| 3 | Квест | 20.04.2026 |",
  ].join("\n");
  const blocks = tools.reportBlocks(markdown);

  const docxDocument = new TextDecoder().decode(tools.readZipEntries(tools.blocksToDocx(blocks)).at(-1).data);
  const docxPerRow = [...docxDocument.matchAll(/<w:tr>(.*?)<\/w:tr>/g)]
    .map((match) => (match[1].match(/<w:tc>/g) ?? []).length);

  const odtContent = new TextDecoder().decode(tools.readZipEntries(tools.blocksToOdt(blocks))[1].data);
  const odtPerRow = [...odtContent.matchAll(/<table:table-row>(.*?)<\/table:table-row>/g)]
    .map((match) => (match[1].match(/<table:table-cell/g) ?? []).length);

  assert.deepEqual(
    docxPerRow,
    [3, 3, 3, 3],
    "DOCX дополняет короткие строки — это уже работает и служит образцом",
  );
  assert.deepEqual(
    odtPerRow,
    docxPerRow,
    `в ODT строки получили разное число ячеек ${JSON.stringify(odtPerRow)} — `
    + "в LibreOffice содержимое колонки уедет на соседнюю, и цифры перестанут "
    + "соответствовать названиям колонок",
  );
});

test("пустые ячейки таблицы не съедают соседние колонки", () => {
  // Пустая ячейка — обычное дело: у мероприятия нет ответственного.
  // `reportBlocks` её сохраняет (это верно), формат обязан нарисовать
  // пустое место, а не сдвинуть остальные данные.
  const markdown = [
    "| Отдел | Ответственный | Телефон |",
    "|---|---|---|",
    "| Детский | Петрова И.И. | |",
  ].join("\n");
  const blocks = tools.reportBlocks(markdown);
  assert.deepEqual(
    blocks.at(-1).rows[1],
    ["Детский", "Петрова И.И.", ""],
    "пустая ячейка обязана остаться ячейкой, а не пропасть",
  );

  const odt = new TextDecoder().decode(tools.readZipEntries(tools.blocksToOdt(blocks))[1].data);
  const lastRow = [...odt.matchAll(/<table:table-row>(.*?)<\/table:table-row>/g)].at(-1)[1];
  assert.equal(
    (lastRow.match(/<table:table-cell/g) ?? []).length,
    3,
    "пустая ячейка должна остаться на месте — иначе телефон уезжает в графу «Ответственный»",
  );
});

// ─────────────────────── 5. Спецсимволы и круговой обмен ───────────────────────

test("текст со спецсимволами \\\\ { } и кавычками переживает круговой обмен RTF без потерь", () => {
  const source = 'Кавычки "ёлочки", обратная \\ косая, скобки {и}, процент %, решётка #, амперсанд &, подчёркивание _';
  const rtf = tools.blocksToRtf(tools.reportBlocks(source));
  assert.equal(tools.braceBalance(rtf), 0, "скобки экранированы неверно — RTF не откроется");
  assert.ok(
    rtfRoundTrip(rtf).includes(source),
    "текст со спецсимволами обязан вернуться из документа тем же, что ушёл в markdown",
  );
});

test("скобки и косая черта из заголовка не ломают группировку RTF", () => {
  // Заголовок оборачивается в `{\b ...}`. Если экранирование пропустить,
  // закрывающая скобка текста закроет группу жирного и весь дальнейший
  // документ останется без форматирования.
  const rtf = tools.blocksToRtf(tools.reportBlocks("## Пункт {2.1} и \\ экранирование"));
  assert.equal(
    tools.braceBalance(rtf),
    0,
    "скобки текста обязаны быть экранированы — иначе группа \\b закроется раньше времени",
  );
  assert.ok(
    rtfRoundTrip(rtf).includes("{2.1}"),
    "фигурные скобки заголовка обязаны вернуться как скобки, а не как команды RTF",
  );
});

test("таблица с кириллицей, цифрами и пустыми ячейками доходит до документа без потерь", () => {
  const rows = [
    ["Клуб", "Месяц", "Участники", "Ответственный", ""],
    ["«Омега»", "март", "12", "Петрова И.И.", ""],
    ["«Рубин»", "апрель", "0", "", ""],
  ];
  const blocks = [{ kind: "table", rows }];

  const rtf = tools.blocksToRtf(blocks);
  for (const row of rows) {
    for (const cell of row) {
      const expected = cell === "" ? "" : cell;
      if (expected === "") continue;
      assert.ok(
        rtfRoundTrip(rtf).includes(expected),
        `ячейка «${expected}» потерялась при переходе в RTF`,
      );
    }
  }
  assert.deepEqual(
    docxText(tools.blocksToDocx(blocks)).slice(0, 5),
    rows[0],
    "первая строка таблицы DOCX обязана совпасть с исходной",
  );
  assert.deepEqual(
    odtText(tools.blocksToOdt(blocks)).slice(0, 5),
    rows[0],
    "первая строка таблицы ODT обязана совпасть с исходной",
  );
});

test("перенос строки внутри абзаца не теряется в DOCX и ODT", () => {
  const blocks = [{ kind: "paragraph", text: "первая строка\nвторая строка" }];
  assert.deepEqual(
    docxText(tools.blocksToDocx(blocks)),
    ["первая строка", "вторая строка"],
    "перенос внутри абзаца обязан стать двумя абзацами, а не слипнуться в один",
  );
  assert.deepEqual(
    odtText(tools.blocksToOdt(blocks)),
    ["первая строка", "вторая строка"],
    "перенос внутри абзаца обязан стать двумя абзацами, а не слипнуться в один",
  );
});

// ─────────────────────── 6. Пустой отчёт и отчёт без заголовков ───────────────────────

test("пустой markdown не роняет конвертер и даёт документ правильной структуры", () => {
  // Пустой отчёт — это когда модель не собрала данных. Конвертер обязан
  // написать хоть какой-то документ и не упасть: вызов инструмента идёт
  // внутри хода агента, исключение здесь оборвало бы всю работу.
  const blocks = tools.reportBlocks("");
  assert.deepEqual(blocks, [], "пустой markdown не должен превращаться ни в один блок");

  const rtf = tools.blocksToRtf(blocks);
  assert.ok(rtf.startsWith("{\\rtf1"), "даже пустой отчёт обязан быть документом RTF");
  assert.equal(tools.braceBalance(rtf), 0, "пустой документ RTF обязан быть сбалансирован");
  assert.ok(rtf.endsWith("}"), "пустой документ RTF обязан закрываться");

  const docxEntries = tools.readZipEntries(tools.blocksToDocx(blocks));
  assert.deepEqual(
    docxEntries.map((entry) => entry.name),
    ["[Content_Types].xml", "_rels/.rels", "word/document.xml"],
    "пустой DOCX обязан сохранять все три обязательные части архива",
  );

  const odtEntries = tools.readZipEntries(tools.blocksToOdt(blocks));
  assert.equal(
    odtEntries[0].name,
    "mimetype",
    "пустой ODT тоже обязан начинаться с mimetype, иначе LibreOffice не откроет",
  );
  assert.ok(
    new TextDecoder().decode(odtEntries.find((entry) => entry.name === "content.xml").data)
      .includes("<office:text>"),
    "пустой ODT обязан содержать хотя бы пустой раздел office:text",
  );
});

test("markdown без единого заголовка не теряет текст и не рассыпается", () => {
  const markdown = "Первая строка.\nВторая строка.\n- пункт списка";
  const blocks = tools.reportBlocks(markdown);
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["paragraph", "paragraph", "bullet"],
    "отчёт без заголовков обязан разобраться в абзацы и список",
  );
  assert.equal(
    docxText(tools.blocksToDocx(blocks)).length,
    3,
    "каждый абзац обязан попасть в DOCX — иначе часть отчёта пропала молча",
  );
  assert.ok(
    rtfRoundTrip(tools.blocksToRtf(blocks)).includes("пункт списка"),
    "текст без заголовков обязан доехать до RTF целиком",
  );
});

// ─────────────────────── 7. Ширина полосы набора ───────────────────────

test("сумма ширин колонок не выходит за полосу набора даже при потолке 400 twips", () => {
  // `columnWidths` берёт потолок 400 на колонку, но сумму потом не проверяет.
  // На 23 колонках каждая получает минимум, и таблица становится шире полосы.
  //
  // ПРАВКА ТЕСТА (автор был неправ в одной вещи). Утверждение «каждая колонка
  // не уже 400 twips» и утверждение «сумма не больше 9026» несовместимы между
  // собой: на 40 колонках 40 × 400 = 16000 > 9026, то есть первое утверждение
  // само по себе запрещает нужное поведение. 400 twips — это ориентир Word, а не
  // требование спецификации OOXML: `w:gridCol w:w` свободное число, и таблица
  // из 23+ колонок на бланке библиотеки всё равно не поместится на страницу.
  // Что обязано быть правдой — таблица не вылезает за поля. Проверка потолка
  // поэтому осталась там, где он помещается, а ниже он уступает сумме.
  const roomy = tools.columnWidths([Array.from({ length: 10 }, (_, index) => `колонка ${index}`)], 9026);
  assert.ok(
    roomy.every((width) => width >= 400),
    "пока 400 × число колонок влезает в полосу, минимум 400 twips обязан действовать",
  );

  const wide = [Array.from({ length: 40 }, (_, index) => `колонка ${index}`)];
  const widths = tools.columnWidths(wide, 9026);
  const sum = widths.reduce((total, width) => total + width, 0);

  assert.ok(
    widths.every((width) => width > 0),
    "ширина колонки обязана оставаться положительной при любом числе колонок",
  );
  assert.ok(
    sum <= 9026,
    `сумма ширин колонок ${sum} twips шире полосы набора 9026 — `
    + "таблица уедет за поля страницы и часть колонок не попадёт на печать",
  );
});

// ─────────────────────── 8. Длина текста, 500 документов, утечка ───────────────────────

test("текст в 100 000 знаков конвертируется во все четыре формата целиком", () => {
  const long = "Отчёт за квартал. ".repeat(6000).slice(0, 100000);
  const blocks = tools.reportBlocks(long);
  assert.equal(blocks.length, 1, "100 000 знаков без переносов — это один абзац");
  assert.equal(blocks[0].text.length, 100000, "ни один знак не должен потеряться при разборе");

  const rtf = tools.blocksToRtf(blocks);
  assert.equal(tools.braceBalance(rtf), 0, "на длинном тексте скобки RTF разъезжаются");

  const docxCells = docxText(tools.blocksToDocx(blocks));
  assert.equal(docxCells.length, 1, "100 000 знаков без переносов — это один абзац DOCX");
  assert.equal(docxCells[0].length, 100000, "DOCX обязан хранить все 100 000 знаков");

  const odtCells = odtText(tools.blocksToOdt(blocks));
  assert.equal(odtCells.length, 1, "100 000 знаков без переносов — это один абзац ODT");
  assert.equal(odtCells[0].length, 100000, "ODT обязан хранить все 100 000 знаков");
});

test("500 документов подряд конвертируются без роста памяти процесса", () => {
  const markdown = [
    "# Отчёт за квартал",
    "",
    "Абзац с **жирным** словом и числом 1234.",
    "",
    "- первый пункт",
    "- второй пункт",
    "",
    "| № | Мероприятие | Срок |",
    "|---|---|---|",
    "| 1 | Клуб «Омега» | 12.03.2026 |",
    "| 2 | День книги \u{1F600} | 20.04.2026 |",
  ].join("\n");

  const sample = () => {
    const blocks = tools.reportBlocks(markdown);
    tools.blocksToRtf(blocks);
    tools.blocksToDocx(blocks);
    tools.blocksToOdt(blocks);
  };

  for (let index = 0; index < 50; index += 1) sample();
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  for (let index = 0; index < 500; index += 1) sample();
  const elapsed = performance.now() - started;
  const after = process.memoryUsage().heapUsed;

  assert.ok(
    elapsed < 60000,
    `500 документов за ${(elapsed / 1000).toFixed(1)} с — на слабом компьютере `
    + "заведующей это превращается в многосекундное зависание окна",
  );
  assert.ok(
    after - before < 200 * 1024 * 1024,
    `heap вырос на ${((after - before) / 1048576).toFixed(1)} МБ за 500 документов — `
    + "похоже на утечку: конвертер держит результаты прошлых вызовов",
  );
});
