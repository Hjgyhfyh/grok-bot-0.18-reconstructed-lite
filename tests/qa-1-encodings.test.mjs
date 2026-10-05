/**
 * Определение кодировки вложений: `source/host/extensions/attachments/document/plain-text.ts`
 * (jschardet + iconv-lite) и путь до пользователя в `document/text.ts`.
 *
 * Почему это важно. Заведующая библиотеки получает выгрузки и протоколы, которые
 * приходят из разных программ. Половина её файлов — в windows-1251, часть — в
 * UTF-8 с BOM, часть — в UTF-16 и в cp866. Кодировку определяет код. Если он
 * ошибётся, в модель уходит не документ, а «Ôîíä», и модель рассуждает о
 * мусоре. Проверить надо ровно то, что делает код: определение по BOM, по
 * настоящему UTF-8, по `jschardet` и запасной путь через windows-1251 — на
 * файлах разного размера, потому что запасной путь срабатывает по числу байт
 * в диапазоне 0xC0..0xFF, а не по признаку «это русский текст».
 *
 * Файл ловит четыре класса дефектов:
 *   1. короткие кириллические файлы не доходят до windows-1251 и читаются
 *      как windows-1252 или как греческий текст;
 *   2. файл в UTF-16 не доходит до декодера вовсе: `sniffFormat` называет его
 *      двоичным раньше, чем `decodeTextBytes` успевает посмотреть на BOM;
 *   3. UTF-16 без BOM не определяется нигде, даже внутри архива;
 *   4. символ BOM остаётся в тексте, если он попал в середину файла.
 *
 * Отдельно проверяется то, что определение вызывается один раз на файл, а не
 * на строку: 500 файлов по 40 строк дают ровно 500 вызовов определения.
 *
 * Тесты, которые падают, — это находки. Каждая из них описана в
 * `_qa/1-encodings.md`: имя теста, вывод и что это значит для пользователя.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import iconv from "iconv-lite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let engine;      // document/text.ts — путь до пользователя
let plain;       // document/plain-text.ts — сама функция определения
let counted;     // та же функция, но с настоящим счётчиком вызовов jschardet
let buildDir;

// `iconv-lite` тянет за собой `safer-buffer`, а тот зовёт `require("buffer")`.
// В боевой сборке выход CJS и `require` есть; в тесте формат ESM, поэтому
// `require` объявляется явно, иначе модуль не грузится вовсе.
const requireBanner = {
  js: 'import { createRequire as __dbbotCreateRequire } from "node:module";\nconst require = __dbbotCreateRequire(import.meta.url);',
};

before(async () => {
  buildDir = await mkdtemp(path.join(os.tmpdir(), "dbbot-qa1-encodings-"));
  const bundle = async (entry, out, extra = {}) => {
    const outfile = path.join(buildDir, out);
    await build({ entryPoints: [path.join(repoRoot, entry)], outfile, bundle: true, format: "esm", platform: "node", target: "node22", banner: requireBanner, ...extra });
    return await import(pathToFileURL(outfile).href);
  };
  engine = await bundle(path.join("source", "host", "extensions", "attachments", "document", "text.ts"), "document-text.mjs");
  plain = await bundle(path.join("source", "host", "extensions", "attachments", "document", "plain-text.ts"), "plain-text.mjs");

  // Тот же модуль, но `jschardet` заменён на счётчик. Так доказывается, что
  // определение кодировки вызывается один раз на файл: пересчитывать вызовы
  // вручную по коду нельзя — вызовов нет в сигнатуре.
  const shim = path.join(buildDir, "jschardet-count.mjs");
  const realJschardet = createRequire(import.meta.url).resolve("jschardet");
  await writeFile(shim, [
    `import real from ${JSON.stringify(realJschardet)};`,
    "globalThis.__qaDetectCalls = 0;",
    "globalThis.__qaDetectBytes = 0;",
    "export function detect(input) {",
    "  globalThis.__qaDetectCalls += 1;",
    "  globalThis.__qaDetectBytes += input.length;",
    "  return real.detect(input);",
    "}",
    "export default { detect };",
    "",
  ].join("\n"), "utf8");
  counted = await bundle(path.join("source", "host", "extensions", "attachments", "document", "plain-text.ts"), "plain-text-counted.mjs", { alias: { jschardet: shim } });
});

after(async () => {
  if (buildDir !== undefined) await rm(buildDir, { recursive: true, force: true });
});

// ───────────────────────── образцы ─────────────────────────

/** Байты так, как их записала бы программа-источник. */
const bytesOf = (text, encoding) => new Uint8Array(iconv.encode(text, encoding));

/**
 * Ожидаемый текст для однобайтовой кодировки. Код, который не умеет такой
 * символ, при записи ставит на его место «?», и сравнивать с исходником
 * бессмысленно: сравниваем с тем, что кодировка физически может сохранить.
 */
const asEncodingKeeps = (text, encoding) => iconv.decode(iconv.encode(text, encoding), encoding);

const withBom = (bom, text, encoding) => {
  const body = Buffer.from(iconv.encode(text, encoding));
  return new Uint8Array(Buffer.concat([Buffer.from(bom), body]));
};

const PROTOCOL = [
  "Протокол заседания попечительского совета",
  "Дата: 12.03.2026, начало в 18:00",
  "Присутствовали: 7 человек из 9",
  "1. Слушали отчёт заведующей о работе библиотеки за 2025 год.",
  "2. Фонд пополнился на 1842 экземпляра, читателей было 6300 за год.",
  "3. Книжная выставка «Волшебное слово» собрала 1200 посетителей.",
  "4. Постановили: утвердить план мероприятий на 2026 год.",
  "5. Закрыть заседание в 19:40.",
].join("\n");

const GERMAN = "Grüße aus der Kinderbibliothek. Die Ausleihe ist montags bis freitags geöffnet. Bitte beachten Sie die Öffnungszeiten während der Ferien.";
const FRENCH = "La bibliothèque pour enfants ouvre le mardi. Les ouvrages sont à rendre avant le 15 mars; étude du soir et prêt. École et vacances.";

// ───────────────────────── zip для проверки пути через архив ─────────────────────────

let crcTable = null;
function crc32(buffer) {
  if (crcTable === null) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Минимальный zip: только чтение частей, время входа не важно. */
function writeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(checksum, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += local.length + name.length + data.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, end]);
}

// ───────────────────────── что работает ─────────────────────────

test("текст в UTF-8 с BOM читается без самого символа BOM в начале", () => {
  const bytes = withBom([0xef, 0xbb, 0xbf], PROTOCOL, "utf8");
  const result = plain.decodeTextBytes(bytes);
  assert.equal(result.text, PROTOCOL, "символ BOM попал в текст, и модель увидит невидимую букву перед документом");
  assert.equal(result.encoding, "utf-8", "файл с BOM должен объявляться как UTF-8");
  assert.notEqual(result.text.charCodeAt(0), 0xfeff, "первым символом остался невидимый U+FEFF, и модель увидит документ с лишней буквой в начале");
});

test("текст в UTF-8 без BOM читается как есть, включая эмодзи и четырёхбайтовые символы", () => {
  const source = "Привет из библиотеки 📚 — «Омега» club, 4 ��байта: 𝔘𝔫𝔦𝔠𝔬𝔡𝔢";
  const bytes = bytesOf(source, "utf8");
  const result = plain.decodeTextBytes(bytes);
  assert.equal(result.encoding, "utf-8", "настоящий UTF-8 обязан определяться как UTF-8, а не по догадке jschardet");
  assert.equal(result.text, source, "русский текст в UTF-8 без BOM прочитан с потерями");
});

test("файл в UTF-16LE с BOM читается посимвольно, когда доходит до декодера", () => {
  const bytes = withBom([0xff, 0xfe], PROTOCOL, "utf16-le");
  const result = plain.decodeTextBytes(bytes);
  assert.equal(result.text, PROTOCOL, "UTF-16LE с BOM прочитан неверно");
  assert.equal(result.encoding, "utf-16le", "файл с BOM UTF-16LE должен объявляться как utf-16le");
});

test("файл в UTF-16BE с BOM читается посимвольно, когда доходит до декодера", () => {
  const bytes = withBom([0xfe, 0xff], PROTOCOL, "utf16-be");
  const result = plain.decodeTextBytes(bytes);
  assert.equal(result.text, PROTOCOL, "UTF-16BE с BOM прочитан неверно");
  assert.equal(result.encoding, "utf-16be", "файл с BOM UTF-16BE должен объявляться как utf-16be");
});

test("немецкий текст в windows-1252 не превращается в кириллицу", () => {
  const expected = asEncodingKeeps(GERMAN, "win1252");
  const result = plain.decodeTextBytes(bytesOf(expected, "win1252"));
  assert.equal(result.text, expected, "немецкий текст прочитан не тем текстом, который лежит в файле");
  assert.doesNotMatch(result.text, /[Ѐ-ӿ]/, "буквы windows-1252 превратились в кириллицу: латиница подменяется русской");
});

test("французский текст в latin-1 читается как есть", () => {
  const expected = asEncodingKeeps(FRENCH, "latin1");
  const result = plain.decodeTextBytes(bytesOf(expected, "latin1"));
  assert.equal(result.text, expected, "французский текст в latin-1 прочитан неверно");
});

test("русский текст в KOI8-R читается как есть", () => {
  const expected = asEncodingKeeps(PROTOCOL, "koi8-r");
  const result = plain.decodeTextBytes(bytesOf(expected, "koi8-r"));
  assert.equal(result.text, expected, "русский текст в KOI8-R прочитан неверно");
});

test("протокол в windows-1251 целиком доходит до текста русскими буквами", () => {
  const expected = asEncodingKeeps(PROTOCOL, "win1251");
  const result = plain.decodeTextBytes(bytesOf(expected, "win1251"));
  assert.equal(result.encoding, "win1251", "длинный русский протокол должен определяться как windows-1251");
  assert.equal(result.text, expected, "длинный русский протокол прочитан неверно");
});

test("протокол в cp866 целиком доходит до текста русскими буквами", () => {
  const expected = asEncodingKeeps(PROTOCOL, "cp866");
  const result = plain.decodeTextBytes(bytesOf(expected, "cp866"));
  assert.equal(result.text, expected, "русский протокол в cp866 прочитан неверно");
});

test("файл с заведомо кривой последовательностью байт не роняет чтение", () => {
  const broken = new Uint8Array([
    0x41, 0xff, 0xfe, 0x43, // выдуманная сигнатура внутри текста
    0xe0, 0x80, 0x41, // обрезанный в начале многобайтовый символ
    0xc3, // одинокий старший байт
    0x00, 0x41, // нулевой байт посреди файла
    0xff, 0xfe, 0xff, 0xfe,
  ]);
  let result = null;
  assert.doesNotThrow(() => { result = plain.decodeTextBytes(broken); }, "испорченный файл уронил чтение вложения вместо того, чтобы вернуть хоть что-то");
  assert.equal(typeof result.text, "string", "испорченный файл вернул не текст");
  assert.ok(result.text.length > 0, "испорченный файл вернул пустую строку, и пользователю нечего показать");
  assert.ok(result.encoding.length > 0, "кодировка испорченного файла не названа, и неизвестно, чем его читать");
});

test("тот же файл UTF-16 внутри zip читается, хотя напрямую отказывает", () => {
  // Здесь важно сравнение: байты одни и те же, различается только путь.
  const direct = engine.extractAttachmentText("протокол.txt", withBom([0xff, 0xfe], PROTOCOL, "utf16-le"));
  const zipped = engine.extractAttachmentText("архив.zip", new Uint8Array(writeZip([
    { name: "протокол.txt", data: withBom([0xff, 0xfe], PROTOCOL, "utf16-le") },
  ])));
  assert.equal(zipped.status, "text", "файл UTF-16 внутри zip обязан читаться: там до декодера доходит байт за байтом");
  assert.ok(zipped.text.includes(PROTOCOL.split("\n")[0]), "текст файла UTF-16 из архива не извлечён");
  assert.equal(direct.status, "text", "тот же файл UTF-16, присланный напрямую, должен читаться так же, как из архива — сейчас он отказывает");
});

test("определение кодировки вызывается ровно один раз на файл, а не на строку", () => {
  const line = "Отчёт заведующей детской библиотекой за 2025 год по фонду и читателям";
  const body = Array.from({ length: 40 }, (_unused, index) => `${index + 1}. ${line}`).join("\n");
  const files = Array.from({ length: 500 }, (_unused, index) => bytesOf(`${body}\nНомер ${index}.`, "win1251"));
  globalThis.__qaDetectCalls = 0;
  globalThis.__qaDetectBytes = 0;
  for (const file of files) counted.decodeTextBytes(file);
  assert.equal(globalThis.__qaDetectCalls, 500, `определение вызвано ${globalThis.__qaDetectCalls} раз на 500 файлов по 40 строк — значит, оно идёт не по файлу`);
  assert.ok(
    globalThis.__qaDetectBytes <= 500 * 64 * 1024,
    `в определение ушло ${globalThis.__qaDetectBytes} байт, а файл целиком читать нельзя: выборка должна ограничиваться 64 КБ`,
  );
});

test("500 файлов разных кодировок читаются за разумное время и без знаков замены", () => {
  const encodings = ["utf8", "win1251", "cp866", "koi8-r", "iso88595", "win1252", "latin1"];
  const source = `${PROTOCOL}\nНомер документа: 42. Город: Новоуральск. Сумма: 1842.`;
  const files = encodings.map((encoding) => ({
    encoding,
    expected: asEncodingKeeps(source, encoding),
    bytes: bytesOf(asEncodingKeeps(source, encoding), encoding),
  }));
  const repeated = Array.from({ length: 72 }, () => files).flat(); // 504 файла
  const started = performance.now();
  let withReplacement = 0;
  let empty = 0;
  for (const file of repeated) {
    const result = plain.decodeTextBytes(file.bytes);
    if (result.text.includes("\uFFFD")) withReplacement += 1;
    if (result.text.trim().length === 0) empty += 1;
  }
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 15_000, `${repeated.length} файлов прочитаны за ${Math.round(elapsed)} мс — на слабом компьютере заведующей это причина ждать ответа, а не отправлять вложение`);
  assert.equal(withReplacement, 0, `${withReplacement} файлов прочитаны со знаком замены U+FFFD — модель получит текст с дырками вместо букв`);
  assert.equal(empty, 0, `${empty} файлов прочитаны пустыми, хотя внутри есть текст`);
});

// ───────────────────────── находки ─────────────────────────

test("короткая русская строка в windows-1251 не читается как windows-1252", () => {
  // «Фонд» — четыре буквы, восемь байт. Так выглядит заголовок таблицы,
  // подпись к файлу или короткая заметка из почты.
  const result = plain.decodeTextBytes(bytesOf("Фонд", "win1251"));
  assert.equal(result.text, "Фонд", `windows-1251 определилась как ${result.encoding}, и русский текст превратился в «${result.text}»`);
  assert.equal(result.encoding, "win1251", "короткий русский текст обязан определяться как windows-1251");
});

test("короткая русская строка в windows-1251 не превращается в греческий текст", () => {
  // Здесь определение не ошибается «в никуда», а ошибается уверенно:
  // jschardet отдаёт ISO-8859-7 с уверенностью 0.99.
  const source = "Тюмень 2026 2025";
  const result = plain.decodeTextBytes(bytesOf(source, "win1251"));
  assert.equal(result.text, source, `windows-1251 с русским текстом прочитана как ${result.encoding}: «${result.text}»`);
  assert.doesNotMatch(result.text, /[\u0370-\u03FF\uFFFD]/, "русские буквы превратились в греческие, а модель получит текст, которого нет в файле");
});

test("короткая русская строка в cp866 не читается как windows-1252", () => {
  // Шапка модуля обещает: «четверть — в cp866». Это значит, что боюсь, что
  // для коротких файлов это обещание не выполняется.
  const expected = asEncodingKeeps("Фонд", "cp866");
  const result = plain.decodeTextBytes(bytesOf(expected, "cp866"));
  assert.equal(result.text, expected, `cp866 определилась как ${result.encoding}: «${result.text}»`);
});

test("короткая русская строка в ISO-8859-5 не читается как windows-1252", () => {
  const expected = asEncodingKeeps("Фонд", "iso88595");
  const result = plain.decodeTextBytes(bytesOf(expected, "iso88595"));
  assert.equal(result.text, expected, `ISO-8859-5 определилась как ${result.encoding}: «${result.text}»`);
});

test("короткий файл .txt в windows-1251 доходит до модели русскими буквами", () => {
  // Тот же случай, но целиком: так его видит заведующая библиотеки.
  const source = "Фонд";
  const result = engine.extractAttachmentText("fond.txt", bytesOf(source, "win1251"));
  assert.equal(result.status, "text", "короткий текстовый файл обязан читаться, а не отказывать");
  assert.equal(result.text.trim(), source, `в модель ушло «${result.text}» вместо «${source}»`);
});

test("файл UTF-16 с BOM, присланный напрямую, читается, а не отказывает", () => {
  // Windows и Word пишут UTF-16 с BOM. Дальше `sniffFormat` считает такой
  // файл двоичным из-за нулевых байтов и отказывает раньше, чем декодер
  // посмотрит на BOM, — хотя декодер этот случай обрабатывает.
  const source = "Библиотека работает";
  const result = engine.extractAttachmentText("протокол.txt", withBom([0xff, 0xfe], source, "utf16-le"));
  assert.equal(result.status, "text", `файл UTF-16 с BOM отказан вместо чтения: ${result.notice}`);
  assert.equal(result.text.trim(), source, "текст файла UTF-16 не дошёл до модели");
});

test("файл UTF-16 без BOM внутри zip не читается мусором с управляющими символами", () => {
  // Так сохраняет «Блокнот» Windows 10 в режиме «UTF-16 LE»: без метки.
  const source = "Библиотека работает";
  const archive = new Uint8Array(writeZip([{ name: "протокол.txt", data: bytesOf(source, "utf16-le") }]));
  const result = engine.extractAttachmentText("архив.zip", archive);
  assert.ok(result.text.includes(source), `вместо текста в модель ушло «${result.text.slice(0, 60)}»`);
  assert.doesNotMatch(result.text, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/, "в тексте управляющие символы: это не текст, а мусор из байтов");
});

test("символ BOM в середине файла не попадает в текст", () => {
  // Склейка двух выгрузок (`copy a.csv + b.csv` в Windows) даёт ровно это.
  const source = "НачалоКонец";
  const bytes = Buffer.concat([
    Buffer.from(iconv.encode("Начало", "utf8")),
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(iconv.encode("Конец", "utf8")),
  ]);
  const result = plain.decodeTextBytes(new Uint8Array(bytes));
  assert.equal(result.text, source, `в тексте остался невидимый символ: ${JSON.stringify(result.text)}`);
});