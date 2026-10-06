/*
 * Защита от злоупотреблений при чтении вложений: потолки zip и пиковая память.
 *
 * Что было раньше. `source/packages/report-tools/zip.ts` распаковывает каждую
 * часть без ограничений, поэтому пришлось завести отдельный `readGuardedZipEntries`
 * с тремя потолками (число частей, размер одной части, суммарный распакованный
 * объём) и потолком `maxOutputLength` у `inflateRawSync`. Написать эти потолки
 * мало: заведующая работает на компьютере с 8 ГБ ОПЕРАТИВНОЙ ПАМЯТИ, и вложение
 * на 100 КБ не должно его повесить. Этого никто не проверял — был только код.
 *
 * Что доказывают тесты ниже:
 *   1. каждый из трёх потолков действительно срабатывает на настоящем zip;
 *   2. потолок `maxOutputLength` действительно держит, когда центральный каталог
 *      врёт о размере части (вредоносный архив устроен именно так);
 *   3. zip-бомба из 1000 частей по 10 МБ нулей обрывается, а не съедает память;
 *   4. НЕ ОБХОДЯТСЯ ли потолки — в частности потолок на одну часть для метода
 *      «без сжатия» (method 0), где `inflateRawSync` не вызывается вовсе;
 *   5. сколько на самом деле памяти съедает разбор вложения 10 / 50 / 100 МБ.
 *
 * Память измеряется честно: сценарий крутится в отдельном процессе Node, у него
 * спрашивается `process.resourceUsage().maxRSS` — это пиковый RSS всего процесса,
 * а не приблизительная оценка. Процесс запускается с `--max-old-space-size=1024`,
 * то есть куча зажата 1 ГБ вместо 8 ГБ: если разбор в это укладывается, то на
 * целевой машине с 8 ГБ запас есть с большим краем.
 *
 * Все zip в тестах собираются вручную: нужно уметь солгать в центральном каталоге
 * о размере части. Ни один файл проекта не меняется.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MB = 1024 * 1024;
const EIGHT_GB_BUDGET = 8 * 1024 * 1024 * 1024;

let buildDir;
let runnerPath;
let zipReaderPath;
let textPath;
let limitsPath;
let zipReader;
let limits;

/*
 * ───────────────────────────── сборка модулей ─────────────────────────────
 */

const requireBanner = {
  js: 'import { createRequire as __dbbotCreateRequire } from "node:module";\nconst require = __dbbotCreateRequire(import.meta.url);',
};

const RUNNER = String.raw`
// Сценарии памяти крутятся здесь, в отдельном процессе: пиковый RSS главного
// процесса тестов иначе смешался бы с esbuild и с раннером самого набора.
import { pathToFileURL } from "node:url";
import { deflateRawSync } from "node:zlib";

const ZIP_READER_PATH = process.argv[2];
const TEXT_PATH = process.argv[3];
const SCENARIO = process.argv[4];

let peakRss = 0;
let readArmed = false;
let readBaseline = 0;
let readPeak = 0;
const sampler = setInterval(() => {
  const rss = process.memoryUsage().rss;
  if (rss > peakRss) peakRss = rss;
  if (readArmed && rss > readPeak) readPeak = rss;
}, 2);
sampler.unref();

/**
 * Замер идёт только вокруг ЧТЕНИЯ. Сборка zip — это нагрузка самого теста, а не
 * продукта: бот никогда не собирает архив из частей. Без такой рамки в цифру
 * попадает память на deflateRawSync и на Buffer.concat, и измеренный пик
 * говорил бы о наборе теста, а не о приложении.
 */
function armRead() {
  const rss = process.memoryUsage().rss;
  readBaseline = rss;
  readPeak = rss;
  readArmed = true;
  return rss;
}

function disarmRead() {
  const rss = process.memoryUsage().rss;
  if (rss > readPeak) readPeak = rss;
  readArmed = false;
  return {
    readBaselineMb: MB_(readBaseline),
    readPeakMb: MB_(readPeak),
    readDeltaMb: MB_(readPeak - readBaseline),
  };
}

const zr = await import(pathToFileURL(ZIP_READER_PATH).href);
const doc = await import(pathToFileURL(TEXT_PATH).href);

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Сборка zip руками. Поля declaredUncompressed / declaredCompressed позволяют
 * солгать в центральном каталоге — ровно так и устроен вредоносный архив.
 */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const method = entry.method ?? 8;
    const payload = entry.data;
    const compressed = method === 0 ? payload : deflateRawSync(payload, { level: 9 });
    const sum = crc32(payload);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(entry.declaredCompressed ?? compressed.length, 20);
    central.writeUInt32LE(entry.declaredUncompressed ?? payload.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, centralDir, end]));
}

const zeros = (bytes) => Buffer.alloc(bytes, 0);
const ascii = (bytes) => Buffer.alloc(bytes, 0x41);
const MB_ = (bytes) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

function readZip(zipBytes) {
  armRead();
  const started = Date.now();
  let result;
  try {
    const entries = zr.readGuardedZipEntries(zipBytes);
    result = {
      ok: true,
      entries: entries.length,
      inflatedBytes: entries.reduce((sum, e) => sum + e.data.byteLength, 0),
    };
  } catch (error) {
    result = { ok: false, errorName: error?.name ?? null, message: String(error?.message ?? error) };
  }
  result.ms = Date.now() - started;
  return Object.assign(result, disarmRead());
}

function readDocument(name, zipBytes) {
  armRead();
  const started = Date.now();
  const result = doc.extractAttachmentText(name, zipBytes);
  return Object.assign({
    status: result.status,
    format: result.format,
    textChars: result.text.length,
    truncated: result.truncated,
    notice: String(result.notice ?? "").slice(0, 200),
    ms: Date.now() - started,
  }, disarmRead());
}

const out = { scenario: SCENARIO, maxEntryBytes: zr.DEFAULT_ZIP_READ_LIMITS.maxEntryBytes, maxTotalBytes: zr.DEFAULT_ZIP_READ_LIMITS.maxTotalBytes, maxEntries: zr.DEFAULT_ZIP_READ_LIMITS.maxEntries };

switch (SCENARIO) {
  // ── Честная бомба: 1000 частей по 10 МБ нулей, суммарно 10 ГБ ────────────
  case "bomb-1000x10mb": {
    const one = deflateRawSync(zeros(10 * 1024 * 1024), { level: 9 });
    const entries = Array.from({ length: 1000 }, (_, i) => ({
      name: "part" + i + ".bin",
      method: 8,
      data: zeros(1),
      declaredUncompressed: 10 * 1024 * 1024,
      declaredCompressed: one.length,
    }));
    const zip = buildZip(entries);
    out.zipBytes = zip.byteLength;
    out.declaredTotalGb = 10;
    Object.assign(out, readZip(zip));
    break;
  }
  // ── Врёт каталог: deflate-часть на 200 МБ, заявлено 1 байт ────────────────
  case "deflated-lie-200mb": {
    const zip = buildZip([{ name: "word/document.xml", method: 8, data: zeros(200 * 1024 * 1024), declaredUncompressed: 1 }]);
    out.zipBytes = zip.byteLength;
    Object.assign(out, readZip(zip));
    break;
  }
  // ── Тот же обман, но метод 0: maxOutputLength не вызывается вовсе ─────────
  case "stored-lie-90mb": {
    const zip = buildZip([{ name: "photo.jpg", method: 0, data: zeros(90 * 1024 * 1024), declaredUncompressed: 1 }]);
    out.zipBytes = zip.byteLength;
    Object.assign(out, readZip(zip));
    break;
  }
  // ── 1000 частей, каждая честно заявлена по 90 КБ: потолок на число частей ──
  case "entries-2001": {
    const zip = buildZip(Array.from({ length: 2001 }, (_, i) => ({ name: "f" + i + ".txt", method: 8, data: Buffer.from("привет", "utf8") })));
    out.zipBytes = zip.byteLength;
    Object.assign(out, readZip(zip));
    break;
  }
  // ── Три части по 40 МБ: суммарный потолок 96 МБ обязан обрубить ──────────
  case "three-40mb": {
    const payload = zeros(40 * 1024 * 1024);
    const zip = buildZip([
      { name: "a.bin", method: 8, data: payload },
      { name: "b.bin", method: 8, data: payload },
      { name: "c.bin", method: 8, data: payload },
    ]);
    out.zipBytes = zip.byteLength;
    Object.assign(out, readZip(zip));
    break;
  }
  // ── Две части по 48 МБ: ровно под потолок, чтение обязано пройти ─────────
  case "two-48mb": {
    const payload = zeros(48 * 1024 * 1024);
    const zip = buildZip([
      { name: "word/document.xml", method: 8, data: payload },
      { name: "word/footnotes.xml", method: 8, data: payload },
    ]);
    out.zipBytes = zip.byteLength;
    Object.assign(out, readZip(zip));
    break;
  }
  // ── Текстовое вложение 10 / 50 / 100 МБ ─────────────────────────────────
  case "text-10mb":
  case "text-50mb":
  case "text-100mb": {
    const sizeMb = Number.parseInt(SCENARIO.slice(5), 10);
    const bytes = ascii(sizeMb * 1024 * 1024);
    out.inputBytes = bytes.byteLength;
    Object.assign(out, readDocument("report.txt", new Uint8Array(bytes)));
    break;
  }
  // ── zip на 95 МБ и на 99 МБ частей без сжатия ──────────────────────────
  // 95 МБ распакованных данных проходят суммарный потолок 96 МБ. 99 МБ —
//  // тоже укладываются в лимит документа 100 МБ, который приложение обещает
  //  // заведующей словами «документ или архив — до 100 МБ».
  case "zip-stored-95mb":
  case "zip-stored-99mb": {
    const targetMb = Number.parseInt(SCENARIO.slice(11), 10);
    const chunk = 11 * 1024 * 1024;
    const entries = [];
    for (let made = 0; made + chunk <= targetMb * 1024 * 1024; made += chunk) {
      entries.push({ name: "photo" + entries.length + ".jpg", method: 0, data: zeros(chunk) });
    }
    const zip = buildZip(entries);
    out.zipBytes = zip.byteLength;
    out.partsMb = entries.length * 11;
    Object.assign(out, readDocument("photos.zip", zip));
    break;
  }
  // ── Настоящий .docx: word/document.xml на 47 МБ ──────────────────────────
  case "docx-47mb": {
    const unit = Buffer.from("<w:document><w:body><w:p><w:r><w:t>", "utf8");
    const xml = Buffer.concat([unit, Buffer.alloc(47 * 1024 * 1024, 0x41), Buffer.from("</w:t></w:r></w:p></w:body></w:document>", "utf8")]);
    const zip = buildZip([{ name: "word/document.xml", method: 8, data: xml }]);
    out.zipBytes = zip.byteLength;
    out.xmlBytes = xml.length;
    Object.assign(out, readDocument("report.docx", zip));
    break;
  }
  // ── Архив, внутри которого office-файл на пределе потолка ────────────────
  case "archive-nesting": {
    const inner = buildZip([{ name: "word/document.xml", method: 8, data: zeros(48 * 1024 * 1024) }]);
    const outer = buildZip([{ name: "inner.docx", method: 8, data: inner }]);
    out.zipBytes = outer.byteLength;
    Object.assign(out, readDocument("bundle.zip", outer));
    break;
  }
  // ── Две части по 49 МБ без сжатия, обе заявлены как 1 байт ──────────────
  // Каждая часть на 1 МБ больше потолка maxEntryBytes (48 МБ). Настоящий код
  // обязан отказать на первой же части. Входной файл при этом 98 МБ — он
  // укладывается в лимит документа в 100 МБ, то есть это не выдуманный вход.
  case "stored-49mb-x2": {
    const zip = buildZip([
      { name: "a.bin", method: 0, data: zeros(49 * 1024 * 1024), declaredUncompressed: 1 },
      { name: "b.bin", method: 0, data: zeros(49 * 1024 * 1024), declaredUncompressed: 1 },
    ]);
    out.zipBytes = zip.byteLength;
    Object.assign(out, readZip(zip));
    break;
  }
  // ── Тот же обман, но через настоящий путь документа .docx ───────────────
  case "docx-stored-lie": {
    const zip = buildZip([
      { name: "[Content_Types].xml", method: 8, data: Buffer.from("<Types/>", "utf8") },
      { name: "word/document.xml", method: 0, data: zeros(60 * 1024 * 1024), declaredUncompressed: 1 },
    ]);
    out.zipBytes = zip.byteLength;
    Object.assign(out, readDocument("report.docx", zip));
    break;
  }
  // ── HTML внутри архива: markupToText делит строку на миллионы кусков ──────
  // archive.ts для html/xml/svg внутри zip зовёт markupToText. Он делает
  // одиннадцать replace подряд, потом split по /\s+/, потом filter, потом join.
  // На строке из одних слов это миллионы мелких строк в массиве.
  case "archive-html-48mb": {
    const words = Buffer.alloc(48 * 1024 * 1024, 0x61);
    for (let i = 0; i < words.length; i += 5) words[i] = 0x20;
    const zip = buildZip([{ name: "page.html", method: 8, data: words }]);
    out.zipBytes = zip.byteLength;
    out.partBytes = words.length;
    Object.assign(out, readDocument("bundle.zip", zip));
    break;
  }
  // ── То же, но часть без сжатия и с врущим размером: берёт обход потолка ───
  case "archive-html-stored": {
    const words = Buffer.alloc(95 * 1024 * 1024, 0x61);
    for (let i = 0; i < words.length; i += 5) words[i] = 0x20;
    const zip = buildZip([{ name: "page.html", method: 0, data: words, declaredUncompressed: 1 }]);
    out.zipBytes = zip.byteLength;
    out.partBytes = words.length;
    Object.assign(out, readDocument("bundle.zip", zip));
    break;
  }
  // ── Тот же html, но присланный напрямую, без архива ─────────────────────
// Самый обычный путь: заведующая просто прикрепляет файл. Для .html лимит
// документа не действует, attachmentByteLimitForName даёт 25 МБ.
  case "html-direct-25mb": {
    const words = Buffer.alloc(25 * 1024 * 1024, 0x61);
    for (let i = 0; i < words.length; i += 5) words[i] = 0x20;
    out.zipBytes = words.length;
    out.partBytes = words.length;
    Object.assign(out, readDocument("page.html", new Uint8Array(words)));
    break;
  }
  // ── Две части по 48 МБ: ровно под суммарный потолок 96 МБ ──────────────
  case "archive-html-2x48": {
    const words = Buffer.alloc(48 * 1024 * 1024, 0x61);
    for (let i = 0; i < words.length; i += 5) words[i] = 0x20;
    const zip = buildZip([
      { name: "one.html", method: 8, data: words },
      { name: "two.html", method: 8, data: words },
    ]);
    out.zipBytes = zip.byteLength;
    out.partBytes = words.length;
    Object.assign(out, readDocument("bundle.zip", zip));
    break;
  }
  default:
    out.error = "unknown scenario";
}

clearInterval(sampler);
const rss = process.memoryUsage().rss;
if (rss > peakRss) peakRss = rss;
out.peakRss = peakRss;
out.peakRssMb = MB_(peakRss);
out.resourceMaxRssKb = process.resourceUsage().maxRSS;
out.heapUsedMb = MB_(process.memoryUsage().heapUsed);
process.stdout.write(JSON.stringify(out));
`;

before(async () => {
  buildDir = await mkdtemp(path.join(os.tmpdir(), "dbbot-qa-limits-abuse-1-"));
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
    return outfile;
  };
  zipReaderPath = await bundle(path.join("source", "host", "extensions", "attachments", "document", "zip-reader.ts"), "zip-reader.mjs");
  textPath = await bundle(path.join("source", "host", "extensions", "attachments", "document", "text.ts"), "document-text.mjs");
  limitsPath = await bundle(path.join("source", "shared", "media", "attachment-limits.ts"), "attachment-limits.mjs");
  runnerPath = path.join(buildDir, "runner.mjs");
  await writeFile(runnerPath, RUNNER, "utf8");
});

after(async () => {
  if (buildDir !== undefined) await rm(buildDir, { recursive: true, force: true });
});

/** Гоняет сценарий в отдельном процессе с кучей, зажатой до 1 ГБ. */
function runScenario(name, { heapMb = 1024 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${heapMb}`, runnerPath, zipReaderPath, textPath, name], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      if (code !== 0) return resolve({ name, code, stderr: stderr.slice(0, 3000), stdout: stdout.slice(0, 3000) });
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ name, code, parseError: true, stdout: stdout.slice(0, 3000), stderr: stderr.slice(0, 3000) });
      }
    });
  });
}

const mb = (bytes) => `${Math.round((bytes / MB) * 10) / 10} МБ`;
const describeScenario = (r) => `сценарий=${r.name ?? r.scenario} код=${r.code} пик=${r.peakRssMb ?? "?"} МБ\n  ${JSON.stringify(r).slice(0, 900)}`;

// ───────────────────────── 1. объявленные потолки ─────────────────────────

test("потолки объявлены так, что 8 ГБ ОПЕРАТИВНОЙ ПАМЯТИ остаются целы", async () => {
  zipReader = await import(pathToFileURL(zipReaderPath).href);
  limits = await import(pathToFileURL(limitsPath).href);
  const l = zipReader.DEFAULT_ZIP_READ_LIMITS;
  assert.ok(l.maxEntries > 0 && l.maxEntryBytes > 0 && l.maxTotalBytes > 0, "три потолка объявлены, а не заданы нулём");
  assert.ok(l.maxTotalBytes <= 512 * MB, `суммарный потолок распаковки ${mb(l.maxTotalBytes)} должен быть заметно меньше 8 ГБ, иначе zip-бомба заберёт всю память машины`);
  assert.ok(
    l.maxTotalBytes >= limits.DOCUMENT_BYTE_LIMIT / 4,
    `суммарный потолок распаковки ${mb(l.maxTotalBytes)} не должен быть меньше четверти лимита документа ${mb(limits.DOCUMENT_BYTE_LIMIT)}, иначе обычный документ перестанет открываться`,
  );
});

// ───────────────────────── 2. бомба 1000 × 10 МБ ─────────────────────────

test("zip-бомба из 1000 частей по 10 МБ обрывается и не съедает память", async () => {
  const r = await runScenario("bomb-1000x10mb");
  assert.equal(r.code, undefined, `процесс чтения бомбы умер: ${r.stderr}`);
  assert.equal(r.ok, false, `архив, объявляющий 10 ГБ распакованных данных, обязан быть отвергнут, а код его прочитал: ${describeScenario(r)}`);
  assert.match(r.message, /частей|распаковывается|МБ/, `отказ должен называть сработавший потолок, а не просто «плохой архив»: ${r.message}`);
  assert.ok(r.peakRss < EIGHT_GB_BUDGET / 4, `чтение бомбы заняло ${mb(r.peakRss)} пиковой памяти при объявленных ${r.declaredTotalGb} ГБ распакованных данных`);
});

// ───────────────────────── 3. maxOutputLength ────────────────────────────

test("потолок maxOutputLength держит, когда каталог врёт о размере deflate-части", async () => {
  const r = await runScenario("deflated-lie-200mb");
  assert.equal(r.ok, false, `часть на 200 МБ с заявленным размером 1 байт обязана быть отвергнута потолком maxOutputLength, а код её принял: ${describeScenario(r)}`);
  assert.ok(r.readDeltaMb * MB <= r.maxEntryBytes * 2, `потолок maxOutputLength не сработал: чтение подняло память на ${mb(r.readDeltaMb * MB)} при потолке на часть ${mb(r.maxEntryBytes)} — часть на 200 МБ ушла в память целиком`);
});

// ───────────────────────── 4. обход потолка на метод 0 ────────────────────

test("часть без сжатия не проходит мимо потолка на размер части", async () => {
  const r = await runScenario("stored-lie-90mb");
  assert.equal(
    r.ok,
    false,
    `потолок на одну часть (${mb(r.maxEntryBytes)}) можно обойти: для метода 0 inflateRawSync не вызывается, проверка идёт только по заявленному в каталоге размере. Часть на 90 МБ с заявленным размером 1 байт прошла как ${describeScenario(r)}`,
  );
});

// ───────────────────────── 5. остальные потолки ──────────────────────────

test("суммарный потолок обрывает архив раньше, чем распакуется всё", async () => {
  const r = await runScenario("three-40mb");
  assert.equal(r.ok, false, `три части по 40 МБ при потолке ${mb(r.maxTotalBytes)} обязаны быть отвергнуты: ${describeScenario(r)}`);
});

test("потолок на число частей срабатывает на 2001 части", async () => {
  const r = await runScenario("entries-2001");
  assert.equal(r.ok, false, `архив из 2001 части при потолке ${r.maxEntries} обязан быть отвергнут: ${describeScenario(r)}`);
});

test("две части по 48 МБ проходят потолки и занимают ровно обещанное", async () => {
  const r = await runScenario("two-48mb");
  assert.equal(r.ok, true, `две части по 48 МБ — это ровно под потолок ${mb(r.maxTotalBytes)}, отказ здесь был бы ошибкой: ${describeScenario(r)}`);
  assert.equal(r.inflatedBytes, 96 * MB, "обе части должны попасть в память целиком — это граница, на которой потолок ещё держит");
});

// ───────────────────────── 6. стресс по размеру вложения ─────────────────

test("разбор вложения 10 МБ не выходит за разумные пределы", async () => {
  const r = await runScenario("text-10mb");
  assert.equal(r.code, undefined, `разбор 10 МБ упал: ${r.stderr}`);
  assert.ok(r.readDeltaMb * MB < 512 * MB, `разбор вложения 10 МБ поднял память на ${mb(r.readDeltaMb * MB)} — это в ${(r.readDeltaMb / 10).toFixed(1)} раза больше самого файла`);
});

test("разбор вложения 50 МБ не выходит за разумные пределы", async () => {
  const r = await runScenario("text-50mb");
  assert.equal(r.code, undefined, `разбор 50 МБ упал: ${r.stderr}`);
  assert.ok(r.readDeltaMb * MB < 768 * MB, `разбор вложения 50 МБ поднял память на ${mb(r.readDeltaMb * MB)}`);
});

test("разбор вложения 100 МБ — ровно лимит документа — не уводит машину в обмен", async () => {
  const r = await runScenario("text-100mb");
  assert.equal(r.code, undefined, `разбор 100 МБ упал: ${r.stderr}`);
  assert.equal(r.status, "text", `100 МБ — это ровно лимит документа, файл обязан читаться: ${describeScenario(r)}`);
  assert.ok(r.readDeltaMb * MB < 1024 * MB, `разбор документа на лимите в 100 МБ поднял память на ${mb(r.readDeltaMb * MB)}. У заведующей 8 ГБ и Electron держит три процесса`);
});

test("архив на 95 МБ читается целиком", async () => {
  const r = await runScenario("zip-stored-95mb");
  assert.equal(r.code, undefined, `разбор zip в 95 МБ упал: ${r.stderr}`);
  assert.notEqual(r.status, "unreadable", `архив на ${mb(r.partsMb ?? 0)} распакованных данных укладывается в суммарный потолок ${mb(r.maxTotalBytes ?? 0)} и обязан читаться: ${describeScenario(r)}`);
  assert.ok(r.readDeltaMb * MB < 1024 * MB, `разбор zip в 95 МБ поднял память на ${mb(r.readDeltaMb * MB)}`);
});

test("архив на 99 МБ не отвергается, хотя обещан лимит документа 100 МБ", async () => {
  const r = await runScenario("zip-stored-99mb");
  assert.equal(r.code, undefined, `разбор zip в 99 МБ упал: ${r.stderr}`);
  assert.notEqual(
    r.status,
    "unreadable",
    `архив на ${mb(r.zipBytes)} укладывается в лимит документа 100 МБ, который приложение называет заведующей словами «документ или архив — до 100 МБ», а код его отверг: ${describeScenario(r)}`,
  );
});

test("настоящий .docx с частью на 47 МБ читается в куче, зажатой до 1 ГБ", async () => {
  const r = await runScenario("docx-47mb");
  assert.equal(r.code, undefined, `разбор .docx на пределе упал: ${r.stderr}`);
  assert.equal(r.status, "text", `docx с word/document.xml на ${mb(r.xmlBytes)} должен читаться: ${describeScenario(r)}`);
  assert.ok(r.readDeltaMb * MB < 1024 * MB, `разбор .docx с частью на ${mb(r.xmlBytes)} поднял память на ${mb(r.readDeltaMb * MB)} при куче 1 ГБ`);
});

test("разбор .docx не стоит в два с половиной раза дороже самой части", async () => {
  const r = await runScenario("docx-47mb");
  const budget = r.xmlBytes * 2.5;
  assert.ok(
    r.readDeltaMb * MB <= budget,
    `разбор .docx с одной частью на ${mb(r.xmlBytes)} поднял память на ${mb(r.readDeltaMb * MB)} — в ${(r.readDeltaMb / (r.xmlBytes / MB)).toFixed(1)} раза больше самой части. Часть разворачивается дважды подряд (officeZipFormatOf, потом docxZipToText), потом декодируется в строку, и tidyExtractedText делает ещё шесть полных копий. Потолки zip считают байты данных, а не память процесса: ${describeScenario(r)}`,
  );
});

test("вложенный office-файл внутри архива не размножает память", async () => {
  const r = await runScenario("archive-nesting");
  assert.equal(r.code, undefined, `разбор вложенного архива упал: ${r.stderr}`);
  assert.ok(r.readDeltaMb * MB < 512 * MB, `архив с офисным файлом на 48 МБ внутри поднял память на ${mb(r.readDeltaMb * MB)}. Внутренний office-файл разворачивается дважды подряд, и каждая копия живёт одновременно с внешним архивом: ${describeScenario(r)}`);
});

test("суммарный потолок не даёт материализовать больше, чем сам потолок", async () => {
  const r = await runScenario("stored-49mb-x2");
  const budget = (r.maxTotalBytes + r.maxEntryBytes) * (1.1 * MB);
  assert.ok(
    r.readDeltaMb * MB <= budget,
    `архив из двух частей по 49 МБ поднял память на ${mb(r.readDeltaMb * MB)} при расчётном потолке ${mb(budget)}. Суммарный потолок проверяется ПОСЛЕ того, как очередная часть уже выделена, поэтому в памяти успевает оказаться суммарный потолок плюс ещё одна целиком развёрнутая часть: ${describeScenario(r)}`,
  );
});

test("настоящий .docx с врущённым размером части не читается в обход потолка", async () => {
  const r = await runScenario("docx-stored-lie");
  assert.equal(r.code, undefined, `разбор .docx с врущим размером части упал: ${r.stderr}`);
  assert.notEqual(
    r.status,
    "text",
    `word/document.xml на 60 МБ заявлена в каталоге как 1 байт и прошла через потолок maxEntryBytes (${mb(r.maxEntryBytes)}): ${describeScenario(r)}`,
  );
});

// ───────────────────────── 7. таблица замеров ────────────────────────────
// Тест ничего не проверяет: он собирает все замеры в одном месте, чтобы отчёт
// опирался на числа, а не на память об авторе. Падать он не должен.

// ── 8. HTML внутри архива: markupToText на строке в десятки мегабайт ─────
// Через split по пробелу строка в 48 МБ превращается в десятки миллионов
// мелких строк. Если этот путь уходит за 1 ГБ, на машине заведующей с 8 ГБ
// это уже зависание, а не «медленно».

test("html на 48 МБ внутри архива не размножает память в разы", async () => {
  const r = await runScenario("archive-html-48mb");
  assert.equal(r.code, undefined, `разбор html в 48 МБ упал или умер: ${String(r.stderr).slice(0, 800)}`);
  assert.ok(
    r.peakRssMb < 2 * 1024,
    `html на ${mb(r.partBytes)} внутри архива поднял память процесса до ${r.peakRssMb} МБ при куче, зажатой до 1 ГБ. markupToText делит строку на куски по /\s+/, и на тексте из одних слов это десятки миллионов мелких строк: ${describeScenario(r)}`,
  );
});

test("html без сжатия с врущим размером не доводит процесс до 8 ГБ", async () => {
  const r = await runScenario("archive-html-stored", { heapMb: 3072 });
  assert.equal(r.code, undefined, `разбор html в 95 МБ упал или умер: ${String(r.stderr).slice(0, 800)}`);
  assert.ok(
    r.peakRssMb < 3 * 1024,
    `html на ${mb(r.partBytes)} без сжатия, с врущим размером части, поднял память до ${r.peakRssMb} МБ. Сюда складываются две вещи сразу: обход потолка на размер части и разбиение markupToText на миллионы кусков: ${describeScenario(r)}`,
  );
});

test("html на 25 МБ, присланный напрямую, не стоит в три раза дороже себя", async () => {
  const r = await runScenario("html-direct-25mb");
  assert.equal(r.code, undefined, `разбор html в 25 МБ упал или умер: ${String(r.stderr).slice(0, 800)}`);
  // Замеряется разница памяти вокруг чтения, а не весь RSS процесса. Сам раннер
  // с двумя собранными модулями занимает около 130 МБ ещё до вложения, поэтому
  // «пик не больше трёх размеров файла» не выполнимо никогда: 25 МБ × 3 — это
  // 75 МБ, а пустой процесс Node с этими модулями уже больше. Остальные тесты
  // набора меряют так же (`readDeltaMb`).
  assert.ok(
    r.readDeltaMb * MB <= r.partBytes * 3,
    `обычный файл ${mb(r.partBytes)} без всякой злонамеренности поднял память на ${mb(r.readDeltaMb * MB)} — это в ${(r.readDeltaMb / (r.partBytes / MB)).toFixed(1)} раза больше самого файла: ${describeScenario(r)}`,
  );
});

test("две html-части по 48 МБ под суммарным потолком не съедают гигабайт", async () => {
  const r = await runScenario("archive-html-2x48", { heapMb: 4096 });
  assert.equal(r.code, undefined, `разбор двух html-частей упал или умер: ${String(r.stderr).slice(0, 800)}`);
  // Меряется прирост памяти вокруг чтения, а не RSS всего процесса, — так же, как
  // в «html на 25 МБ, присланный напрямую» и во всех остальных тестах этого файла.
  // Здесь стоял `peakRssMb` с тем же самым потолком, и он был единственным, кто
  // считал в потолок стартовый вес раннера: пустой Node с двумя собранными модулями
  // занимает около 130 МБ ещё до вложения, и на машине с 8 ГБ при 1158 тестах наплыве
  // эти 130 МБ складывались с задержками соседних процессов. RSS всего процесса
  // прыгал до 308 МБ при потолке 288 МБ, хотя само чтение стоило втрое меньше.
  // Прирост отсчитывается от снимка, снятого прямо перед чтением, и не зависит ни
  // от чужих процессов, ни от того, на какой миллисекунде сборщик мусора вернул
  // страницы операционной системе.
  const budget = (r.partBytes * 2) * 3;
  assert.ok(
    r.readDeltaMb * MB <= budget,
    `архив с двумя html-частями по ${mb(r.partBytes)} — ровно под суммарный потолок 96 МБ — поднял память на ${mb(r.readDeltaMb * MB)} при потолке ${mb(budget)}. Суммарный потолок держит байты, но не память процесса: ${describeScenario(r)}`,
  );
});

test("таблица замеров памяти собрана", async (t) => {
  const scenarios = [
    "bomb-1000x10mb", "deflated-lie-200mb", "stored-lie-90mb", "stored-49mb-x2",
    "docx-stored-lie", "three-40mb", "two-48mb", "entries-2001",
    "text-10mb", "text-50mb", "text-100mb", "zip-stored-95mb", "zip-stored-99mb",
    "docx-47mb", "archive-nesting", "archive-html-48mb", "archive-html-stored",
    "html-direct-25mb", "archive-html-2x48",
  ];
  const rows = [];
  for (const name of scenarios) {
    const r = await runScenario(name);
    rows.push({
      сценарий: name,
      вход_МБ: mb(r.zipBytes ?? r.inputBytes ?? 0),
      код: r.code ?? 0,
      статус: r.status ?? (r.ok === false ? "ОТКАЗ: " + String(r.message ?? "").slice(0, 70) : "прочитан"),
      в_память_МБ: mb(r.inflatedBytes ?? 0),
      прирост_на_чтение_МБ: r.readDeltaMb ?? null,
      пик_RSS_весь_процесс_МБ: r.peakRssMb ?? null,
      мс: r.ms ?? null,
    });
  }
  t.diagnostic(JSON.stringify(rows, null, 1));
  assert.ok(rows.length === scenarios.length, "замеры собраны");
});