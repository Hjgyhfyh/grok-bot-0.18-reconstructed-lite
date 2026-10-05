/**
 * Свой zip в `source/packages/report-tools/zip.ts`: проверка записи, чтения и
 * того, что собранные `.docx` и `.odt` действительно открываются.
 *
 * Почему отдельный файл. Свой zip легко написать так, что его читает только
 * сам же этот же код: посчитать CRC не с того байта, забыть флаг UTF-8 в имени
 * части, положить `mimetype` в ODT вторым. Тогда тест зелёный, а Word говорит
 * «файл повреждён». Поэтому здесь два независимых свидетеля:
 *
 *   1. `walkCentralDirectory` ниже — разбор архива на голых байтах, написанный
 *      по спецификации, без единой строки кода продукта. Он же пересчитывает
 *      CRC32 каждой части и сравнивает с тем, что записано в архиве.
 *   2. `python` со стандартным `zipfile` — третья сторона, которая проверяет
 *      CRC методом `testzip()` и разбирает XML внутри частей.
 *
 * Что проверяется и почему это важно:
 *
 *   - круг «записал → прочитал» должен сойтись побайтово. Отчёт — это файл,
 *     который заведующая отдаёт директору; потеря байта в имени части или в
 *     таблице означает «Word не открывает файл»;
 *   - подкаталоги (`word/document.xml`), кириллица в именах и часть нулевой
 *     длины — обычные случаи для реального образца;
 *   - ODT: часть `mimetype` обязана идти первой и без сжатия, иначе
 *     LibreOffice отказывается открывать документ;
 *   - DOCX: обязательны `[Content_Types].xml`, `_rels/.rels`, `word/document.xml`;
 *   - повреждённый архив, неверная контрольная сумма, обрезанная часть и
 *     архив-бомба. Здесь ждутся отказы, а не тихая выдача мусора.
 *
 * Инструментов проверки ровно два: сборка esbuild и, если он есть в системе,
 * `python`. Отсутствие `python` — не повод молчать: тест с ним помечается
 * пропущенным с текстом причины, остальные проверки от него не зависят.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_SIGNATURE = 0x06054b50;
const ZIP64_MARKER = 0xffff;

/** Потолок из `source/host/extensions/attachments/document/zip-reader.ts`. */
const PROJECT_UNCOMPRESSED_CEILING = 96 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let tools;
let buildDir;
let pythonPath;

before(async () => {
  buildDir = await mkdtemp(path.join(os.tmpdir(), "dbbot-qa1-zip-codec-"));
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
  // Наличие python проверяется, а не предполагается: без него часть проверок
  // просто не будет независимой, и об этом честно сказано в пропуске.
  for (const candidate of [
    process.env.DSH_PYTHON,
    "C:/Users/lesab/AppData/Local/Programs/Python/Python312/python.exe",
    "python",
  ].filter(Boolean)) {
    if (!existsSync(candidate) && !candidate.includes("/") && !candidate.includes("\\")) continue;
    try {
      execFileSync(candidate, ["-c", "import zipfile"], { stdio: "ignore", windowsHide: true });
      pythonPath = candidate;
      break;
    } catch {
      // кандидат не подошёл — пробуем следующий
    }
  }
});

after(async () => {
  if (buildDir !== undefined) await rm(buildDir, { recursive: true, force: true });
});

// ───────────────────────── независимый разбор zip ─────────────────────────

function asBuffer(bytes) {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Разбор центрального каталога по спецификации, кодом продукта не пользуемся.
 * Возвращает части в том порядке, в каком они записаны в архиве.
 */
function walkCentralDirectory(bytes) {
  const buf = asBuffer(bytes);
  let endOffset = -1;
  for (let offset = buf.length - 22; offset >= Math.max(0, buf.length - 22 - 0xffff); offset -= 1) {
    if (buf.readUInt32LE(offset) === END_OF_CENTRAL_SIGNATURE) { endOffset = offset; break; }
  }
  assert.notEqual(endOffset, -1, "в архиве нет записи конца центрального каталога");
  const count = buf.readUInt16LE(endOffset + 10);
  let position = buf.readUInt32LE(endOffset + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(
      buf.readUInt32LE(position),
      CENTRAL_HEADER_SIGNATURE,
      `запись ${index} центрального каталога повреждена`,
    );
    const nameLength = buf.readUInt16LE(position + 28);
    entries.push({
      name: decoder.decode(buf.subarray(position + 46, position + 46 + nameLength)),
      flags: buf.readUInt16LE(position + 8),
      method: buf.readUInt16LE(position + 10),
      crc: buf.readUInt32LE(position + 16),
      compressedSize: buf.readUInt32LE(position + 20),
      size: buf.readUInt32LE(position + 24),
      localOffset: buf.readUInt32LE(position + 42),
    });
    position += 46 + nameLength + buf.readUInt16LE(position + 30) + buf.readUInt16LE(position + 32);
  }
  return entries;
}

/** Сырые байты части по записи центрального каталога. */
function rawPart(bytes, entry) {
  const buf = asBuffer(bytes);
  assert.equal(
    buf.readUInt32LE(entry.localOffset),
    LOCAL_HEADER_SIGNATURE,
    `у части «${entry.name}» нет локального заголовка по смещению ${entry.localOffset}`,
  );
  const start = entry.localOffset + 30 + buf.readUInt16LE(entry.localOffset + 26) + buf.readUInt16LE(entry.localOffset + 28);
  return buf.subarray(start, start + entry.compressedSize);
}

/** Распакованные байты части по записи центрального каталога. */
function partBytes(bytes, entry) {
  const raw = rawPart(bytes, entry);
  return entry.method === 0 ? raw : inflateForCheck(raw);
}

/** Побайтовое сравнение: `assert.deepEqual` на 50 МБ нечитаем в отчёте. */
function sameBytes(actual, expected) {
  const a = asBuffer(actual);
  const b = asBuffer(expected);
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/** Минимальная проверка XML: один корень, парность тегов. */
function assertWellFormedXml(text, label) {
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, "");
  const stack = [];
  let roots = 0;
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/g;
  let match;
  while ((match = tag.exec(withoutComments)) !== null) {
    const [, closing, name, , selfClosing] = match;
    if (closing === "/") {
      assert.equal(stack.pop(), name, `в ${label} тег ${name} закрыт не тем, что открыт`);
      continue;
    }
    if (selfClosing === "/") continue;
    if (stack.length === 0) roots += 1;
    stack.push(name);
  }
  assert.deepEqual(stack, [], `в ${label} остались незакрытые теги`);
  assert.equal(roots, 1, `в ${label} корней должно быть ровно одно, а их ${roots}`);
}

// ───────────────────────────── зелёные проверки ─────────────────────────────

test("свой zip переживает круг «записал → прочитал» и отдаёт байты без искажений", () => {
  const binary = new Uint8Array(64 * 1024);
  let seed = 987654321;
  for (let index = 0; index < binary.length; index += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    binary[index] = seed & 0xff;
  }
  const text = encoder.encode("Отчёт за 1 квартал 2026 года. ".repeat(64));
  const stored = encoder.encode("MIMETYPE-подобная строка без сжатия");
  const entries = [
    { name: "word/document.xml", data: binary },
    { name: "Папка/Отчёт за 2026 год.txt", data: text },
    { name: "пусто.txt", data: new Uint8Array(0) },
    { name: "пусто-без-сжатия.txt", data: new Uint8Array(0), stored: true },
    { name: "непусто-без-сжатия.bin", data: stored, stored: true },
  ];
  const read = tools.readZipEntries(tools.writeZip(entries));
  assert.deepEqual(read.map((item) => item.name), entries.map((item) => item.name), "порядок или написание имён частей исказились");
  for (let index = 0; index < entries.length; index += 1) {
    assert.ok(sameBytes(read[index].data, entries[index].data), `часть «${entries[index].name}» вернулась другой, чем записана`);
  }
  assert.equal(read[4].stored, true, "часть без сжатия обязана остаться такой же");
  assert.equal(read[0].stored, false, "часть со сжатием обязана остаться сжатой");
});

test("часть нулевой длины не ломает архив и не исчезает из него", () => {
  const archive = tools.writeZip([
    { name: "mimetype", data: encoder.encode("application/vnd.oasis.opendocument.text"), stored: true },
    { name: "пусто.txt", data: new Uint8Array(0) },
    { name: "непусто.txt", data: encoder.encode("данные") },
  ]);
  const read = tools.readZipEntries(archive);
  assert.deepEqual(
    read.map((item) => `${item.name}:${item.data.length}`),
    ["mimetype:39", "пусто.txt:0", "непусто.txt:12"],
    "часть нулевой длины пропала или сдвинула соседей",
  );
  const central = walkCentralDirectory(archive);
  assert.equal(central[1].size, 0, "в центральном каталоге часть нулевой длины должна иметь размер 0");
  assert.equal(central[1].crc, tools.crc32(new Uint8Array(0)), "CRC пустой части обязан совпадать с эталонным нулём");
});

test("имя на кириллице доходит до независимого разбора байт в байт", () => {
  const names = ["ПАПКА/Отчёт за 2026 год.txt", "word/document.xml", "документы/Приказ № 5.docx"];
  const archive = tools.writeZip(names.map((name) => ({ name, data: encoder.encode(name) })));
  const central = walkCentralDirectory(archive);
  assert.deepEqual(central.map((item) => item.name), names, "независимый разбор прочитал имя иначе, чем оно записано");
  for (const item of central) {
    assert.equal(item.flags & 0x800, 0x800, `в имени «${item.name}» не выставлен бит UTF-8: Word и LibreOffice искажут кириллицу`);
  }
});

test("файл в 50 МБ проходит круг без потерь", () => {
  const big = new Uint8Array(50 * 1024 * 1024);
  let seed = 12345;
  for (let index = 0; index < big.length; index += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    big[index] = seed & 0xff;
  }
  const archive = tools.writeZip([{ name: "word/media/photo.png", data: big }]);
  const back = tools.readZipEntries(archive)[0].data;
  assert.equal(back.length, big.length, "распакованный объём не совпал с исходным");
  assert.ok(sameBytes(back, big), "в файле на 50 МБ после круга записи и чтения хоть один байт не совпал");
});

test("собранный .docx содержит обязательные части, и CRC каждой сходится", () => {
  const docx = tools.blocksToDocx(tools.reportBlocks("# Отчёт\n\n| № | Мероприятие |\n|---|---|\n| 1 | Клуб «Омега» |"));
  const central = walkCentralDirectory(docx);
  assert.deepEqual(
    central.map((item) => item.name),
    ["[Content_Types].xml", "_rels/.rels", "word/document.xml"],
    "Word не откроет документ без этих трёх частей",
  );
  for (const item of central) {
    const raw = rawPart(docx, item);
    const plain = item.method === 0 ? raw : inflateForCheck(raw);
    assert.equal(item.crc, tools.crc32(plain), `в части «${item.name}» записана неверная контрольная сумма`);
    assert.equal(item.size, plain.length, `в части «${item.name}» записан неверный размер`);
    assert.equal(item.compressedSize, raw.length, `в части «${item.name}» записан неверный сжатый размер`);
  }
  const byName = Object.fromEntries(central.map((item) => [item.name, item]));
  const contentTypes = decoder.decode(partBytes(docx, byName["[Content_Types].xml"]));
  assert.ok(
    contentTypes.includes('PartName="/word/document.xml"'),
    "без объявления word/document.xml в [Content_Types].xml Word считает пакет пустым",
  );
  const rels = decoder.decode(partBytes(docx, byName["_rels/.rels"]));
  assert.ok(rels.includes('Target="word/document.xml"'), "без связи с word/document.xml в _rels/.rels документ пустой");
  const document = decoder.decode(partBytes(docx, byName["word/document.xml"]));
  assert.ok(document.includes("Клуб «Омега»"), "текст отчёта не дошёл до word/document.xml");
  assertWellFormedXml(document, "word/document.xml");
});

test("собранный .odt кладёт mimetype первым и без сжатия — иначе LibreOffice его не откроет", () => {
  const odt = tools.blocksToOdt(tools.reportBlocks("# Отчёт\n\n- пункт\n\n| А | Б |\n|---|---|\n| 1 | 2 |"));
  const buffer = asBuffer(odt);
  assert.equal(buffer.readUInt32LE(0), LOCAL_HEADER_SIGNATURE, "первой должна идти локальная запись части");
  assert.equal(decoder.decode(buffer.subarray(30, 38)), "mimetype", "первой частью ODT обязан быть mimetype");
  assert.equal(buffer.readUInt16LE(8), 0, "mimetype обязан лежать без сжатия, иначе LibreOffice не откроет документ");
  assert.equal(buffer.readUInt16LE(28), 0, "у первой записи не должно быть extra-поля: ODF требует mimetype ровно с 38-го байта");
  assert.equal(
    decoder.decode(buffer.subarray(38, 38 + buffer.readUInt32LE(18))),
    "application/vnd.oasis.opendocument.text",
    "содержимое mimetype записано неверно",
  );
  const central = walkCentralDirectory(odt);
  assert.deepEqual(central.map((item) => item.name), ["mimetype", "content.xml", "META-INF/manifest.xml"], "состав ODT нарушен");
  for (const item of central) {
    const raw = rawPart(odt, item);
    const plain = item.method === 0 ? raw : inflateForCheck(raw);
    assert.equal(item.crc, tools.crc32(plain), `в части «${item.name}» записана неверная контрольная сумма`);
  }
  const content = decoder.decode(partBytes(odt, central[1]));
  assertWellFormedXml(content, "content.xml");
});

test("сторонний разбор python подтверждает контрольные суммы и разбирает XML внутри docx и odt", (t) => {
  if (pythonPath === undefined) {
    t.skip("python со стандартным zipfile в системе не найден — независимая проверка не выполнена");
    return;
  }
  const script = path.join(buildDir, "verify.py");
  const docxPath = path.join(buildDir, "python-check.docx");
  const odtPath = path.join(buildDir, "python-check.odt");
  return Promise.all([
    writeFile(script, [
      "import sys, zipfile, xml.etree.ElementTree as ET",
      "for p in sys.argv[1:]:",
      "    zf = zipfile.ZipFile(p)",
      "    bad = zf.testzip()",
      "    if bad is not None:",
      "        print('CRC_FAIL ' + bad); sys.exit(3)",
      "    for n in zf.namelist():",
      "        if n.endswith('.xml') or n.endswith('.rels'):",
      "            ET.fromstring(zf.read(n))",
      "    if p.endswith('.odt'):",
      "        first = zf.infolist()[0]",
      "        assert first.filename == 'mimetype', first.filename",
      "        assert first.compress_type == 0, first.compress_type",
      "        assert zf.read('mimetype').decode() == 'application/vnd.oasis.opendocument.text'",
      "    print('OK')",
    ].join("\n"), "utf8"),
    writeFile(docxPath, tools.blocksToDocx(tools.reportBlocks("# Отчёт\n\n| № | Мероприятие |\n|---|---|\n| 1 | Клуб «Омега» |"))),
    writeFile(odtPath, tools.blocksToOdt(tools.reportBlocks("# Отчёт\n\n- пункт\n"))),
  ]).then(() => {
    const out = execFileSync(pythonPath, [script, docxPath, odtPath], { encoding: "utf8", windowsHide: true });
    assert.deepEqual(
      out.trim().split(/\r?\n/),
      ["OK", "OK"],
      "python не подтвердил CRC или разбор XML в собранных документах",
    );
  });
});

// ───────────────────────────── падающие проверки ─────────────────────────────

test("битый байт в данных части обязан приводить к отказу, а не к тихой выдаче мусора", () => {
  const original = encoder.encode("Отчёт за 2026 год");
  const archive = tools.writeZip([{ name: "word/document.xml", data: original, stored: true }]);
  const buffer = asBuffer(archive);
  const dataStart = 30 + buffer.readUInt16LE(26);
  const broken = Uint8Array.from(archive);
  broken[dataStart + original.length - 3] ^= 0x01; // портим букву в слове «год»

  const entry = walkCentralDirectory(broken)[0];
  assert.notEqual(
    tools.crc32(rawPart(broken, entry)),
    entry.crc,
    "правка теста: контрольная сумма должна разойтись с архивом, иначе проверка ничего не доказывает",
  );
  assert.throws(
    () => tools.readZipEntries(broken),
    (error) => error instanceof Error && /crc|контрольн|поврежд|checksum/i.test(error.message),
    `битый байт в данных должен приводить к отказу с внятной причиной, а получено: ${
      (() => { try { tools.readZipEntries(broken); return "тихо прочитано"; } catch (e) { return e.message; } })()
    }`,
  );
});

test("fillDocument не должен собирать отчёт из образца с заведомо неверной контрольной суммой", () => {
  const sample = tools.writeZip([
    { name: "[Content_Types].xml", data: encoder.encode("types") },
    { name: "_rels/.rels", data: encoder.encode("rels") },
    {
      name: "word/document.xml",
      data: encoder.encode(
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        + "<w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t xml:space=\"preserve\">Клуб</w:t></w:r></w:p></w:tc></w:tr>"
        + "<w:tr><w:tc><w:p><w:r><w:t xml:space=\"preserve\">Пример</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"
        + '<w:p><w:r><w:t xml:space="preserve">шапка</w:t></w:r></w:p></w:body></w:document>',
      ),
    },
  ]);
  const centralOffset = asBuffer(sample).readUInt32LE(asBuffer(sample).length - 22 + 16);
  const tampered = Uint8Array.from(sample);
  // Портим CRC именно у word/document.xml: третья запись центрального каталога.
  let position = centralOffset;
  let target = -1;
  for (let index = 0; index < 3; index += 1) {
    const nameLength = asBuffer(tampered).readUInt16LE(position + 28);
    if (decoder.decode(asBuffer(tampered).subarray(position + 46, position + 46 + nameLength)) === "word/document.xml") {
      target = position + 16;
      break;
    }
    position += 46 + nameLength + asBuffer(tampered).readUInt16LE(position + 30) + asBuffer(tampered).readUInt16LE(position + 32);
  }
  assert.notEqual(target, -1, "правка теста: запись word/document.xml не найдена в центральном каталоге");
  new DataView(tampered.buffer).setUint32(target, 0xdeadbeef, true);

  const outcome = (() => {
    try {
      return { result: tools.fillDocument({ sampleName: "form.docx", sampleBytes: tampered, markdown: "## Клубы\n\n| № | Клуб |\n|---|---|\n| 1 | Омега |\n", replacements: [] }) };
    } catch (error) {
      return { error };
    }
  })();
  assert.ok(
    outcome.error !== undefined || outcome.result.report.warnings.length > 0,
    "образец с неверной контрольной суммой Word не откроет, а бот молча собрал из него готовый отчёт и ни разу не предупредил",
  );
});

test("часть без сжатия не должна съедать соседние части, если в каталоге завышена её длина", () => {
  const first = encoder.encode("<w:document>содержимое первой части</w:document>");
  const second = encoder.encode("<styles>содержимое второй части</styles>");
  const archive = tools.writeZip([
    { name: "word/document.xml", data: first, stored: true },
    { name: "word/styles.xml", data: second, stored: true },
  ]);
  const buffer = asBuffer(archive);
  const centralOffset = buffer.readUInt32LE(buffer.length - 22 + 16);
  const greedy = Uint8Array.from(archive);
  // Первая запись каталога объявляет больше байт, чем лежит в архиве до
  // начала второй части: читать надо либо отказ, либо ровно свою часть.
  const secondLocalOffset = buffer.readUInt32LE(
    centralOffset + 46 + buffer.readUInt16LE(centralOffset + 28) + 42,
  );
  new DataView(greedy.buffer).setUint32(centralOffset + 20, secondLocalOffset + 5, true);
  new DataView(greedy.buffer).setUint32(centralOffset + 24, secondLocalOffset + 5, true);

  const read = tools.readZipEntries(greedy);
  const document = read.find((item) => item.name === "word/document.xml");
  assert.ok(
    sameBytes(document.data, first),
    `часть «word/document.xml» вернулась с чужими байтами соседней части (${document.data.length} байт вместо ${first.length}): такой .docx Word назовёт повреждённым`,
  );
  const styles = read.find((item) => item.name === "word/styles.xml");
  assert.ok(sameBytes(styles.data, second), "соседняя часть тоже исказилась — чтение сдвинулось");
});

test("сбитое смещение локального заголовка обязано приводить к отказу, а не к тихой пустой части", () => {
  const archive = tools.writeZip([{ name: "word/document.xml", data: encoder.encode("данные"), stored: true }]);
  const centralOffset = asBuffer(archive).readUInt32LE(asBuffer(archive).length - 22 + 16);
  const tampered = Uint8Array.from(archive);
  new DataView(tampered.buffer).setUint32(centralOffset + 42, 7, true);
  assert.throws(
    () => tools.readZipEntries(tampered),
    (error) => error instanceof Error && /поврежд|смещен|заголовок|сбит/i.test(error.message),
    "часть с неверным смещением локального заголовка обязана быть отвергнута, а не прочитана как пустая",
  );
});

test("архив-бомба не должен распаковываться целиком: чтение обязано упираться в потолок", () => {
  // 20 частей по 10 МБ нулей сжимаются примерно в 2 МБ. Если потолка нет,
  // вызывающий получит 200 МБ в памяти на машине с 8 ГБ ОЗУ.
  const part = new Uint8Array(10 * 1024 * 1024);
  const entries = Array.from({ length: 20 }, (unused, index) => ({ name: `part${index}.bin`, data: part }));
  const archive = tools.writeZip(entries);
  assert.ok(
    archive.length < 8 * 1024 * 1024,
    "правка теста: бомба должна быть маленькой в архиве и большой после распаковки",
  );

  const outcome = (() => {
    try {
      return { entries: tools.readZipEntries(archive) };
    } catch (error) {
      return { error };
    }
  })();
  const total = outcome.error !== undefined
    ? 0
    : outcome.entries.reduce((sum, item) => sum + item.data.length, 0);
  assert.ok(
    outcome.error !== undefined || total <= PROJECT_UNCOMPRESSED_CEILING,
    `архив в ${archive.length} байт распаковался в ${Math.round(total / 1048576)} МБ без отказа: `
    + `проектный потолок ${Math.round(PROJECT_UNCOMPRESSED_CEILING / 1048576)} МБ не сработал`,
  );
});

test("запись конца каталога как у zip64 обязана давать внятную ошибку, а не RangeError из DataView", () => {
  const archive = tools.writeZip([{ name: "word/document.xml", data: encoder.encode("данные") }]);
  const tampered = Uint8Array.from(archive);
  const end = asBuffer(tampered).length - 22;
  const view = new DataView(tampered.buffer);
  view.setUint16(end + 8, ZIP64_MARKER, true);
  view.setUint16(end + 10, ZIP64_MARKER, true);
  view.setUint32(end + 16, 0xffffffff, true);

  let thrown;
  try {
    tools.readZipEntries(tampered);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown !== undefined, "правка теста: архив должен быть отвергнут, иначе проверка ничего не доказывает");
  assert.ok(
    !(thrown instanceof RangeError) && !/outside the bounds|is not a function/i.test(thrown.message),
    `на архиве с маркерами zip64 пользователю уходит служебное сообщение «${thrown.message}» вместо причины`,
  );
});

/** Распаковка для независимой проверки — тем же zlib, но вне кода продукта. */
function inflateForCheck(raw) {
  return new Uint8Array(inflateRawSync(raw));
}