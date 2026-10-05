/**
 * Разбор текста из PDF — свой разбор на `node:zlib`
 * (`source/host/extensions/attachments/document/pdf.ts`).
 *
 * Файл тестов закрывает обе стороны обещания модуля: цифровые PDF читаются,
 * а всё, что прочитать нельзя, получает честный отказ по-русски. Проверяются
 * потоки `FlateDecode` и цепочка `ASCIIHexDecode`, объекты внутри `/ObjStm`,
 * шрифты `/ToUnicode` (`bfchar` и `bfrange`), `Identity-H`, кириллица,
 * операторы `Tj`, `TJ`, `'` и `"`, страницы в нестандартном порядке,
 * запароленный файл и скан без текстового слоя.
 *
 * Главный вопрос набора — не «читается ли вообще», а «что происходит с
 * мусором». Пользователь один, компьютер слабый (8 ГБ), а файл присылают
 * откуда угодно. Поэтому отдельно проверяется: случайные байты с заголовком
 * `%PDF`, обрезанный файл, битый поток, zip-бомба внутри PDF, вложенные
 * массивы и пятьдесят файлов подряд, включая десять мегабайт.
 *
 * Ожидания написаны не по коду, а по тому, что обещано заведующей: страницы
 * идут в том порядке, в котором их перечисляет каталог документа; текст
 * страницы не пропадает из-за того, как он записан; файл, который не
 * разобрался, говорит об этом прямо, а не выдаёт себя за скан.
 *
 * Время и память меряются явно: тесты с замером обязаны оставаться быстрыми,
 * иначе на слабой машине проверка сама станет дефектом. Всё, что тестируется
 * на зацикливание, ограничено `safetyCeiling`.
 */

import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pdfModule;   // source/host/extensions/attachments/document/pdf.ts — сам разбор
let engine;      // source/host/extensions/attachments/document/text.ts — что видит пользователь
let buildDir;

/** `iconv-lite` внутри движка тянет `require("buffer")`; в ESM-сборке его нет. */
const requireBanner = {
  js: 'import { createRequire as __dbbotCreateRequire } from "node:module";\nconst require = __dbbotCreateRequire(import.meta.url);',
};

before(async () => {
  buildDir = await mkdtemp(path.join(os.tmpdir(), "dbbot-qa1-pdf-"));
  const bundle = async (entry, out) => {
    const outfile = path.join(buildDir, out);
    await build({
      entryPoints: [path.join(repoRoot, entry)], outfile,
      bundle: true, format: "esm", platform: "node", target: "node22", banner: requireBanner,
    });
    return await import(pathToFileURL(outfile).href);
  };
  pdfModule = await bundle(path.join("source", "host", "extensions", "attachments", "document", "pdf.ts"), "pdf.mjs");
  engine = await bundle(path.join("source", "host", "extensions", "attachments", "document", "text.ts"), "document-text.mjs");
});

after(async () => {
  if (buildDir !== undefined) await rm(buildDir, { recursive: true, force: true });
});

const pdfBytesToText = (bytes) => pdfModule.pdfBytesToText(bytes);
const extract = (name, bytes) => engine.extractAttachmentText(name, bytes);

// ───────────────────────── корпус PDF ─────────────────────────

const LATIN = (text) => Buffer.from(text, "latin1");
const STREAM = (body, filter = "") => `<< /Length ${body.length}${filter} >>\nstream\n${body}\nendstream`;
const HELVETICA = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

/** Собирает PDF из готовых объектов `[номер, тело]`, в файле — в порядке массива. */
function assemble(objects) {
  let out = "%PDF-1.7\n";
  for (const [num, body] of objects) out += `${num} 0 obj\n${body}\nendobj\n`;
  out += `trailer\n<< /Size ${objects.length + 2} /Root 1 0 R >>\n%%EOF\n`;
  return new Uint8Array(LATIN(out));
}

/** Одна страница со шрифтом `F1` и потоком содержимого. */
function onePage(content, options = {}) {
  return assemble([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${options.resources ?? "/Resources << /Font << /F1 5 0 R >> >>"} /Contents 4 0 R >>`],
    [4, STREAM(options.raw ?? content, options.filter ?? "")],
    [5, options.font ?? HELVETICA],
    ...(options.extra ?? []),
  ]);
}

/** Содержимое одной страницы, обёрнутое в готовый PDF. */
function withPage(content, options) {
  return onePage(content, options);
}

/** Страницы `pageTexts` в порядке `order` внутри файла, а в `Kids` — по номерам. */
function multiPage(pageTexts, { objectOrder = null, kidsOrder = null } = {}) {
  const count = pageTexts.length;
  const pageNums = pageTexts.map((_, index) => 3 + index);
  const streamBase = 3 + count;
  const fontNum = streamBase + count;
  const kids = (kidsOrder ?? pageNums).map((num) => `${num} 0 R`).join(" ");
  const objects = [
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, `<< /Type /Pages /Kids [${kids}] /Count ${count} >>`],
    ...pageTexts.map((text, index) => [
      pageNums[index],
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${streamBase + index} 0 R >>`,
    ]),
    ...pageTexts.map((text, index) => [streamBase + index, STREAM(text)]),
    [fontNum, HELVETICA],
  ];
  const byNum = new Map(objects);
  const order = objectOrder ?? objects.map(([num]) => num);
  return assemble(order.map((num) => [num, byNum.get(num)]));
}

/** Случайные байты с правильной сигнатурой PDF — что присылают при обрыве загрузки. */
function junkPdf(size = 256 * 1024, seed = 37) {
  const bytes = new Uint8Array(size);
  bytes.set(LATIN("%PDF-1.7"), 0);
  for (let index = 5; index < size; index += 1) bytes[index] = (index * seed + 11) % 251;
  return bytes;
}

const CyrillicCMap = (pairs) => `1 begincmap\n2 beginbfchar\n${pairs}\nendbfchar\nendcmap`;

const megabytes = (bytes) => bytes / (1024 * 1024);

// ───────────────────────── что обещано и работает ─────────────────────────

test("цифровой PDF без сжатия читается: Tj, одинарная и двойная кавычки дают строки по одной", () => {
  const result = pdfBytesToText(withPage("BT /F1 12 Tf 72 700 Td (Library report) Tj 0 -20 Td (Book fair 2026) Tj ET"));
  assert.equal(result.text, "Library report\nBook fair 2026", "строки страницы должны идти в порядке содержимого потока");
  assert.equal(result.pageCount, 1, "страница посчитана, хотя текст разобран верно");
  assert.equal(result.encrypted, false, "файл без словаря Encrypt не должен считаться запароленным");

  const quoted = pdfBytesToText(withPage("BT /F1 12 Tf (First line) Tj (Second line) ' (Third line) ' 0 0 Tw (Fourth) \" ET"));
  assert.equal(quoted.text, "First line\nSecond line\nThird line\nFourth", "апостроф и двойная кавычка должны начинать новую строку");
});

test("поток FlateDecode распаковывается, и цепочка ASCIIHexDecode + FlateDecode тоже", () => {
  const packed = deflateSync(LATIN("BT /F1 12 Tf 72 700 Td (Compressed report) Tj ET"));
  const flate = pdfBytesToText(withPage("", { raw: packed.toString("latin1"), filter: " /Filter /FlateDecode" }));
  assert.equal(flate.text, "Compressed report", "поток FlateDecode не распаковался");

  const chained = pdfBytesToText(withPage("", {
    raw: packed.toString("hex"),
    filter: " /Filter [/ASCIIHexDecode /FlateDecode]",
  }));
  assert.equal(chained.text, "Compressed report", "цепочка фильтров разбирается не в том порядке или теряется");
});

test("объекты, упакованные в /ObjStm, достаются, и страница из них читается", () => {
  const inners = [
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 20 0 R >>"],
  ];
  let header = "";
  let body = "";
  for (const [num, text] of inners) {
    header += `${num} ${body.length} `;
    body += `${text}\n`;
  }
  const packed = deflateSync(LATIN(header + body));
  const file = assemble([
    [5, HELVETICA],
    [10, `<< /Type /ObjStm /N ${inners.length} /First ${header.length} /Length ${packed.length} /Filter /FlateDecode >>\nstream\n${packed.toString("latin1")}\nendstream`],
    [20, STREAM("BT /F1 12 Tf (Text from object stream) Tj ET")],
  ]);
  const result = pdfBytesToText(file);
  assert.equal(result.text, "Text from object stream", "объекты из /ObjStm не развернулись, страница потерялась");
});

test("Identity-H с /ToUnicode в bfchar даёт кириллицу, а в bfrange — тот же результат", () => {
  const simple = onePage("BT /F1 12 Tf 72 700 Td <00c000c100c2> Tj ET", {
    font: "<< /Type /Font /Subtype /Type0 /BaseFont /X-Identity /Encoding /Identity-H /ToUnicode 6 0 R >>",
    extra: [[6, STREAM(CyrillicCMap("<00c0> <0416>\n<00c1> <0430>\n<00c2> <0431>"))]],
  });
  assert.equal(pdfBytesToText(simple).text, "Жаб", "bfchar из Identity-H не подставился");

  const ranged = onePage("BT /F1 12 Tf 72 700 Td <00c000c100c2> Tj ET", {
    font: "<< /Type /Font /Subtype /Type0 /BaseFont /X-Identity /Encoding /Identity-H /ToUnicode 6 0 R >>",
    extra: [[6, STREAM("1 begincmap\n2 beginbfrange\n<00c0> <00c2> <0416>\nendbfrange\nendcmap")]],
  });
  assert.equal(pdfBytesToText(ranged).text, "ЖЗИ", "bfrange из Identity-H не подставился: 0416, 0417 и 0418 — это Ж, З и И");
});

test("простой шрифт с /ToUnicode даёт кириллицу, а страница с двумя потоками содержимого читается целиком", () => {
  const file = onePage("BT /F1 12 Tf 72 700 Td <c0c1> Tj ET", {
    font: "<< /Type /Font /Subtype /TrueType /BaseFont /Arial /FirstChar 0 /LastChar 255 /ToUnicode 6 0 R >>",
    extra: [[6, STREAM(CyrillicCMap("<c0> <0416>\n<c1> <0430>"))]],
  });
  assert.equal(pdfBytesToText(file).text, "Жа", "простой шрифт с ToUnicode не подставил кириллицу");

  const twoStreams = assemble([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents [4 0 R 5 0 R] >>"],
    [4, STREAM("BT /F1 12 Tf (First half) Tj ET")],
    [5, STREAM("BT /F1 12 Tf (Second half) Tj ET")],
    [6, HELVETICA],
  ]);
  assert.equal(pdfBytesToText(twoStreams).text, "First half\nSecond half", "второй поток из /Contents пропал");
});

test("скан без текстового слоя получает честный отказ по-русски, а не пустой ответ", () => {
  const result = extract("skan.pdf", withPage("q 612 0 0 792 0 0 cm /Im0 Do Q"));
  assert.equal(result.status, "empty", "скан без текстового слоя должен быть назван пустым, а не прочитанным");
  assert.equal(result.text, "", "из скана нечего выдумывать");
  assert.match(result.notice, /^Файл skan\.pdf — это PDF из сканированных страниц/, "пользователю не сказали прямо, что текстового слоя нет");
  assert.match(result.notice, /пришлите его в Word или в виде фотографий/i, "в отказе нет подсказки, как прислать файл заново");
});

test("зашифрованный PDF получает честный отказ по-русски, а не пустой текст и не стектрейс", () => {
  const plain = withPage("BT /F1 12 Tf (secret) Tj ET");
  const encrypted = LATIN(Buffer.from(plain).toString("latin1")
    .replace("trailer", "9 0 obj\n<< /Filter /Standard /V 2 /R 3 /Length 128 /O <00> /U <00> /P -44 >>\nendobj\ntrailer")
    .replace("/Root 1 0 R", "/Root 1 0 R /Encrypt 9 0 R"));

  const parsed = pdfBytesToText(encrypted);
  assert.equal(parsed.encrypted, true, "файл со словарём /Encrypt должен быть помечен как зашифрованный");
  assert.equal(parsed.text, "", "из зашифрованного файла нельзя отдавать мусор вместо текста");

  const result = extract("протокол.pdf", encrypted);
  assert.equal(result.status, "unreadable", "зашифрованный файл должен быть назван нечитаемым, а не пустым");
  assert.match(result.notice, /^Файл протокол\.pdf защищён паролем/, "пользователю не сказали, что снимать пароль");
  assert.match(result.notice, /пришлите его в Word/i, "в отказе нет подсказки, как прислать файл заново");
});

test("файл, который начинается не с %PDF, отказывается по-русски через PdfTextError", () => {
  assert.throws(
    () => pdfBytesToText(new Uint8Array(LATIN("MZ на самом деле это exe"))),
    (error) => error instanceof pdfModule.PdfTextError && /%PDF/.test(error.message),
    "не-PDF должен отказывать своим типом ошибки с русским объяснением, а не RangeError и не пустым текстом",
  );
  assert.throws(
    () => pdfBytesToText(new Uint8Array(0)),
    (error) => error instanceof pdfModule.PdfTextError,
    "пустой файл должен отказывать PdfTextError, а не падать иначе",
  );
});

test("мусор, обрезанный файл и битый поток не роняют разбор и не выдают стектрейс", () => {
  const good = withPage("BT /F1 12 Tf 72 700 Td (Hello world of the library) Tj ET");

  const packed = deflateSync(LATIN("BT /F1 12 Tf (Broken stream) Tj ET"));
  const corrupt = Buffer.from(packed);
  for (let index = 5; index < corrupt.length; index += 5) corrupt[index] = (corrupt[index] + 97) % 256;

  const cases = [
    ["мусор с заголовком %PDF", junkPdf()],
    ["мусор без заголовка", junkPdf(64 * 1024, 91)],
    ["файл, обрезанный наполовину", good.slice(0, Math.floor(good.byteLength / 2))],
    ["файл, обрезанный до ста байт", good.slice(0, 100)],
    ["один заголовок", good.slice(0, 9)],
    ["битый поток FlateDecode", withPage("", { raw: corrupt.toString("latin1"), filter: " /Filter /FlateDecode" })],
    ["FlateDecode из мусора", withPage("", { raw: "AAAAAAAAAAAA", filter: " /Filter /FlateDecode" })],
    ["фильтр LZWDecode", withPage("", { raw: "AAAAAAAAAAAA", filter: " /Filter /LZWDecode" })],
    ["фильтр RunLengthDecode", withPage("", { raw: "AAAAAAAAAAAA", filter: " /Filter /RunLengthDecode" })],
    ["картинка DCTDecode", withPage("BT /F1 12 Tf (Text) Tj ET", { raw: "\xff\xd8\xff\xe0\x00\x10\xff\xd9", filter: " /Filter /DCTDecode" })],
    ["заголовок с нулевым Length", onePage("", { raw: "", filter: " /Filter /FlateDecode" })],
  ];

  for (const [label, bytes] of cases) {
    let result;
    assert.doesNotThrow(() => { result = pdfBytesToText(bytes); }, `${label}: разбор упал необработанным исключением`);
    assert.equal(typeof result.text, "string", `${label}: разбор не вернул строку`);
    assert.ok(!/\/[A-Za-z]+\(|at Object\.|\.ts:\d+/.test(result.text), `${label}: в текст попал стектрейс`);
    const shown = extract("файл.pdf", bytes);
    assert.ok(
      shown.status === "text" || shown.status === "empty" || shown.status === "unsupported" || shown.status === "unreadable" || shown.status === "partial",
      `${label}: неизвестный статус ${shown.status}`,
    );
    assert.ok(shown.notice.length === 0 || /Не смог прочитать файл|— это PDF из сканированных страниц|защищён паролем/.test(shown.notice),
      `${label}: отказ пользователю неизвестной формулировки «${shown.notice}»`);
  }
});

// ───────────────────────── находки: то, что обещано, но не сделано ─────────────────────────

test("текст внутри TJ-массива не теряется: так пишет большинство редакторов", () => {
  const kerned = pdfBytesToText(withPage("BT /F1 12 Tf 72 700 Td [(Book fair) -250 (2026) -250 (Nuvo)] TJ ET"));
  assert.match(kerned.text, /Book fair/, "TJ-массив потерял текст: в нём строки разделены отрицательными числами кернинга");

  const single = pdfBytesToText(withPage("BT /F1 12 Tf [(Library report)] TJ ET"));
  assert.equal(single.text, "Library report", "даже TJ-массив из одного элемента должен давать текст");

  const mixed = pdfBytesToText(withPage("BT /F1 12 Tf (Intro) Tj [(Body) -20 (text)] TJ 0 -20 Td (Tail) Tj ET"));
  assert.equal(mixed.text, "Intro\nBody text\nTail", "TJ не должен стирать ни соседние Tj, ни конец строки");

  const shown = extract("отчёт.pdf", withPage("BT /F1 12 Tf [(Заседание) -300 (правления)] TJ ET"));
  assert.equal(shown.status, "text", "PDF с TJ обязан читаться как текст, а не как файл без текстового слоя");
});

test("страницы идут в порядке /Kids, а не в порядке, в котором объекты попали в файл", () => {
  const texts = ["BT /F1 12 Tf (PAGE-ONE) Tj ET", "BT /F1 12 Tf (PAGE-TWO) Tj ET", "BT /F1 12 Tf (PAGE-THREE) Tj ET"];

  const asListed = multiPage(texts);
  assert.equal(pdfBytesToText(asListed).text, "PAGE-ONE\n\nPAGE-TWO\n\nPAGE-THREE", "контроль: в файле порядок страниц совпадает с /Kids");

  // Тот же документ, но объекты страниц лежат в файле в обратном порядке.
  const shuffled = multiPage(texts, { objectOrder: [1, 2, 5, 4, 3, 6, 7, 8, 9] });
  const result = pdfBytesToText(shuffled);
  assert.equal(result.text, "PAGE-ONE\n\nPAGE-TWO\n\nPAGE-THREE", "страницы вышли в порядке объектов в файле, а не в порядке каталога /Kids — документ перепутан");
});

test("слово /Encrypt в тексте страницы не превращает обычный файл в запароленный", () => {
  const file = withPage("BT /F1 12 Tf 72 700 Td (Never /Encrypt the archive) Tj 0 -20 Td (How to /Encrypt a PDF) Tj ET");
  const result = pdfBytesToText(file);
  assert.equal(result.encrypted, false, "поиск /Encrypt идёт по всему файлу, включая текст страницы — обычный документ объявлен запароленным");
  assert.match(result.text, /Never/, "текст страницы потерян из-за ложного «защищён паролем»");

  const shown = extract("инструкция.pdf", file);
  assert.notEqual(shown.status, "unreadable", "пользователю сказали, что файл защищён паролем, хотя пароля нет");
  assert.doesNotMatch(shown.notice, /защищён паролем/, "отказ «защищён паролем» на файле без /Encrypt в словаре");
});

test("вложенный словарь в /Resources до /Font не ломает шрифт страницы", () => {
  const options = {
    font: "<< /Type /Font /Subtype /TrueType /BaseFont /Arial /FirstChar 0 /LastChar 255 /ToUnicode 6 0 R >>",
    extra: [[6, STREAM(CyrillicCMap("<c0> <0416>\n<c1> <0430>"))], [7, STREAM("binary")], [8, STREAM("binary")]],
  };
  const content = "BT /F1 12 Tf 72 700 Td <c0c1> Tj ET";

  const fontFirst = pdfBytesToText(onePage(content, {
    ...options,
    resources: "/Resources << /Font << /F1 5 0 R >> /XObject << /Im0 7 0 R >> >>",
  }));
  assert.equal(fontFirst.text, "Жа", "контроль: /Font первым в /Resources — кириллица читается");

  const xObjectFirst = pdfBytesToText(onePage(content, {
    ...options,
    resources: "/Resources << /XObject << /Im0 8 0 R >> /Font << /F1 5 0 R >> >>",
  }));
  assert.equal(xObjectFirst.text, "Жа", "шрифты страницы потеряны: /Resources разбирается ленивым <<…>>, который обрывается на первом вложенном словаре до /Font");
});

test("глубоко вложенные массивы в потоке страницы не роняют разбор посторонним исключением", () => {
  const nested = withPage(`BT /F1 12 Tf ${"[".repeat(20_000)} ET`);
  assert.doesNotThrow(
    () => pdfBytesToText(nested),
    "tokenizeContent разбирает вложенный массив рекурсией без предела и роняет разбор RangeError вместо PdfTextError",
  );

  const shown = extract("протокол.pdf", nested);
  assert.notEqual(shown.status, "unsupported", "пользователь получает отказ «не смог прочитать» без единого слова о причине");
});

test("zip-бомба внутри PDF не разворачивается на полгигабайта памяти", () => {
  const payload = `BT /F1 12 Tf ${"(".repeat(20 * 1024 * 1024)}`;
  const packed = deflateSync(LATIN(payload));
  const file = onePage("", { raw: packed.toString("latin1"), filter: " /Filter /FlateDecode" });
  assert.ok(file.byteLength < 200 * 1024, `бомба должна весить меньше 200 КБ, а весит ${file.byteLength}`);

  const before = process.memoryUsage().rss;
  const started = Date.now();
  const result = pdfBytesToText(file);
  const grew = process.memoryUsage().rss - before;

  assert.ok(
    Date.now() - started < 20_000,
    `разбор бомбы занял ${Date.now() - started} мс — на слабой машине это зависание окна`,
  );
  assert.ok(
    grew < 200 * 1024 * 1024,
    `файл в ${Math.round(file.byteLength / 1024)} КБ развернулся в память на ${Math.round(megabytes(grew))} МБ: MAX_INFLATED_BYTES допускает 96 МБ байт, а tokenizeContent строит по одному элементу массива на байт`,
  );
  assert.equal(result.text, "", "из бомбы текст выдумывать нельзя");
});

test("испорченный PDF говорит, что он испорчен, а не выдаёт себя за скан без текстового слоя", () => {
  const good = withPage("BT /F1 12 Tf 72 700 Td (Hello world of the library) Tj ET");
  const packed = deflateSync(LATIN("BT /F1 12 Tf (Broken stream) Tj ET"));
  const corrupt = Buffer.from(packed);
  for (let index = 5; index < corrupt.length; index += 5) corrupt[index] = (corrupt[index] + 97) % 256;

  const cases = [
    ["обрезанный наполовину", good.slice(0, Math.floor(good.byteLength / 2))],
    ["мусор с заголовком", junkPdf()],
    ["битый поток FlateDecode", onePage("", { raw: corrupt.toString("latin1"), filter: " /Filter /FlateDecode" })],
  ];

  for (const [label, bytes] of cases) {
    const shown = extract("протокол.pdf", bytes);
    assert.doesNotMatch(
      shown.notice,
      /это PDF из сканированных страниц/,
      `${label}: пользователю сказали «это PDF из сканированных страниц, текста в нём нет» — откуда вывод, если файла с текстовым слоем не существует`,
    );
    assert.match(
      shown.notice,
      /Не смог прочитать файл|поврежд|испорч|не удалось/i,
      `${label}: нужен отказ «не смог прочитать», а получено «${shown.notice}»`,
    );
  }
});

test("PDF, у которого заголовок не на первом байте, читается как PDF, а не уходит в модель сырым текстом", () => {
  const good = withPage("BT /F1 12 Tf 72 700 Td (Library report) Tj ET");
  const prefixes = [
    ["BOM UTF-8", [0xef, 0xbb, 0xbf]],
    ["перевод строки и пробел", LATIN("\n ")],
    ["печатный мусор", LATIN("JUNKJUNKJ")],
  ];
  for (const [label, prefix] of prefixes) {
    const bytes = new Uint8Array(good.byteLength + prefix.length);
    bytes.set(prefix, 0);
    bytes.set(good, prefix.length);
    const shown = extract("otchet.pdf", bytes);
    assert.doesNotMatch(shown.text, /%PDF-1\.7/, `${label}: в модель ушёл сырой исходник PDF вместо текста документа`);
    assert.equal(shown.text.trim(), "Library report", `${label}: текст документа не извлечён, получено «${shown.text.slice(0, 60)}»`);
  }
});

test("слово endobj в тексте страницы не съедает страницу и следующие за ней объекты", () => {
  const file = onePage("BT /F1 12 Tf 72 700 Td (The word endobj appears here) Tj 5 0 obj << /Dummy 1 >> endobj BT /F1 12 Tf 72 680 Td (AFTER) Tj ET");
  const result = pdfBytesToText(file);
  assert.match(result.text, /appears here/, "текст до слова endobj потерян: разбор объектов обрывается по первому найденному endobj");
  assert.match(result.text, /AFTER/, "хвост страницы после endobj потерян вместе со всеми объектами файла");
});

test("комментарий % с незакрытой скобкой не съедает остаток потока страницы", () => {
  const file = onePage("BT /F1 12 Tf % (примечание редактора\n 72 700 Td (Visible text) Tj ET");
  const result = pdfBytesToText(file);
  assert.match(result.text, /Visible text/, "комментарий без закрывающей скобки увёл разбор строки в строку до конца потока");
});

// ───────────────────────── стресс ─────────────────────────

test("пятьдесят PDF подряд, включая десять мегабайт, разбираются за разумное время и без утечек", () => {
  const parts = [];
  for (let index = 0; index < 150_000; index += 1) {
    parts.push(`BT /F1 12 Tf 72 ${700 - (index % 700)} Td (Big line ${index} of the annual report) Tj ET`);
  }
  const corpus = [
    withPage("BT /F1 12 Tf 72 700 Td (Doc A) Tj ET"),
    withPage("", { raw: deflateSync(LATIN("BT /F1 12 Tf (Doc B) Tj ET")).toString("latin1"), filter: " /Filter /FlateDecode" }),
    withPage("q 612 0 0 792 0 0 cm /Im0 Do Q"),
    withPage("BT /F1 12 Tf (Never /Encrypt this) Tj ET"),
    withPage("BT /F1 12 Tf [(Kerned) -300 (text)] TJ ET"),
    withPage(`BT /F1 12 Tf ${"[".repeat(800)} ET`),
    junkPdf(4096),
    onePage(parts.join("\n")),
  ];
  const bigSize = corpus[corpus.length - 1].byteLength;
  assert.ok(bigSize > 8 * 1024 * 1024, `в корпусе должен быть PDF крупнее 8 МБ, а он ${megabytes(bigSize).toFixed(2)} МБ`);

  global.gc?.();
  const before = process.memoryUsage().rss;
  const started = Date.now();
  let unhandled = 0;
  for (let index = 0; index < 50; index += 1) {
    const bytes = corpus[index % corpus.length];
    try { pdfBytesToText(bytes); } catch { unhandled += 1; }
  }
  const elapsed = Date.now() - started;
  const grew = process.memoryUsage().rss - before;

  assert.equal(unhandled, 0, `${unhandled} из 50 файлов упали необработанным исключением`);
  assert.ok(elapsed < 60_000, `пятьдесят файлов разбирались ${elapsed} мс — это слишком долго для одного сообщения`);
  assert.ok(grew < 1024 * 1024 * 1024, `пятьдесят файлов заняли ${Math.round(grew / megabytes(1))} МБ памяти — на машине с 8 ГБ это опасно`);
});

test("десятимегабайтный PDF разбирается за секунды и укладывается в разумную память", () => {
  const parts = [];
  for (let index = 0; index < 160_000; index += 1) {
    parts.push(`BT /F1 12 Tf 72 ${700 - (index % 700)} Td (Line ${index} of the library annual report 2026) Tj ET`);
  }
  const file = withPage(parts.join("\n"));
  const sizeMb = megabytes(file.byteLength);
  assert.ok(sizeMb > 10, `PDF должен быть крупнее 10 МБ, а он ${sizeMb.toFixed(2)} МБ`);

  global.gc?.();
  const before = process.memoryUsage().rss;
  const started = Date.now();
  const result = pdfBytesToText(file);
  const elapsed = Date.now() - started;
  const grew = process.memoryUsage().rss - before;

  assert.match(result.text, /Line 159999 of the library annual report/, "последняя строка большого PDF потеряна");
  assert.ok(elapsed < 30_000, `десять мегабайт разбирались ${elapsed} мс — разбор синхронный, окно приложения стоит`);
  assert.ok(grew < 2 * 1024 * 1024 * 1024, `${sizeMb.toFixed(1)} МБ PDF заняли ${Math.round(grew / megabytes(1))} МБ памяти`);
});

test("зашифрованный и пустой PDF не проходят по очереди вместе с нормальными: один плохой файл не должен ломать разбор следующих", () => {
  const good = withPage("BT /F1 12 Tf 72 700 Td (After the bad file) Tj ET");
  const encrypted = LATIN(Buffer.from(good).toString("latin1")
    .replace("trailer", "9 0 obj\n<< /Filter /Standard /V 2 /R 3 /Length 128 /O <00> /U <00> /P -44 >>\nendobj\ntrailer")
    .replace("/Root 1 0 R", "/Root 1 0 R /Encrypt 9 0 R"));
  const junk = junkPdf(1024 * 1024);

  for (let round = 0; round < 10; round += 1) {
    assert.equal(pdfBytesToText(encrypted).encrypted, true, `раунд ${round}: зашифрованный файл перестал определяться`);
    assert.doesNotThrow(() => pdfBytesToText(junk), `раунд ${round}: мусор уронил разбор`);
    assert.equal(pdfBytesToText(good).text, "After the bad file", `раунд ${round}: нормальный файл после плохих прочитан неверно`);
  }
});