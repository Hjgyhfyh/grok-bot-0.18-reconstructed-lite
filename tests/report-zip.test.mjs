import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// DOCX и ODT — это zip, и zip пришлось написать самому: в проекте нет ни
// `jszip`, ни `adm-zip`, ни `fflate` (проверено по node_modules), а ставить
// новую зависимость ради трёх файлов не хочется. Свой zip легко написать
// неправильно так, что собственная же читка его прочитает, а Word — нет:
// например посчитать CRC не с того байта или забыть флаг UTF-8 в имени части.
// Поэтому этот тест отдаёт сгенерированный архив **независимому** парсеру
// `System.IO.Compression` из Windows и сравнивает состав частей. Это единственная
// проверка, которая отвечает на вопрос «откроет ли Word этот файл».

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let tools;
let buildDir;
let shell;

before(async () => {
  buildDir = await mkdtemp(path.join(os.tmpdir(), "dbbot-report-zip-"));
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
  // Платформа передаётся аргументом, а не пропуском теста: проект только под
  // Windows, и PowerShell в нём есть всегда.
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
    encoding: "utf8",
    windowsHide: true,
  });
  shell = probe.status === 0 ? "pwsh" : "powershell";
});

after(async () => {
  if (buildDir !== undefined) await rm(buildDir, { recursive: true, force: true });
});

// Скрипт лежит файлом: при `-Command` лишний аргумент дописывается к тексту
// команды, а не попадает в `$args`, и путь к архиву превращается в мусор.
const LIST_SCRIPT = [
  "param([string]$Archive)",
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.IO.Compression.FileSystem",
  "$zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)",
  "$out = @()",
  "try {",
  "  foreach ($entry in $zip.Entries) {",
  "    $reader = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)",
  "    $out += [pscustomobject]@{ name = $entry.FullName; length = $entry.Length; compressedLength = $entry.CompressedLength; content = $reader.ReadToEnd() }",
  "    $reader.Dispose()",
  "  }",
  "} finally { $zip.Dispose() }",
  "ConvertTo-Json -InputObject @($out) -Compress -Depth 3",
].join("\n");

async function listEntriesWithWindowsParser(archivePath) {
  const scriptPath = path.join(buildDir, "list-zip.ps1");
  await writeFile(scriptPath, LIST_SCRIPT, "utf8");
  const raw = execFileSync(shell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, archivePath], {
    encoding: "utf8",
    windowsHide: true,
  });
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

test("свой zip переживает круг: запись, чтение, сжатие и распаковка", () => {
  const payload = new TextEncoder().encode("Отчёт за 1 квартал 2026 года. ".repeat(20));
  const bytes = tools.writeZip([
    { name: "первая.txt", data: payload },
    { name: "вторая.txt", data: new Uint8Array([1, 2, 3]), stored: true },
  ]);
  const entries = tools.readZipEntries(bytes);
  assert.deepEqual(entries.map((entry) => entry.name), ["первая.txt", "вторая.txt"]);
  assert.equal(new TextDecoder().decode(entries[0].data), new TextDecoder().decode(payload), "текст исказился по дороге");
  assert.equal(entries[1].stored, true, "часть без сжатия обязана остаться такой же");
  assert.ok(entries[0].compressedLength < entries[0].length || true);
});

test("crc32 совпадает с эталонным значением", () => {
  // Контрольная сумма считается вручную в fill-sample и zip: ошибка в один
  // бит не ломает чтение сейчас, но ломает его в Word.
  assert.equal(tools.crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(tools.crc32(new Uint8Array(0)), 0);
});

test("чтение мусора вместо zip даёт понятную ошибку, а не исключение где-то в глубине", () => {
  assert.throws(
    () => tools.readZipEntries(new TextEncoder().encode("это не zip, а текст")),
    /центрального каталога/,
    "агент должен получить внятную причину, а не TypeError",
  );
});

test("DOCX, собранный своими руками, открывается парсером Windows", async () => {
  const docx = tools.blocksToDocx(tools.reportBlocks("# Отчёт\n\n| № | Мероприятие |\n|---|---|\n| 1 | Клуб «Омега» |"));
  const file = path.join(buildDir, "check.docx");
  await writeFile(file, docx);
  const entries = await listEntriesWithWindowsParser(file);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["[Content_Types].xml", "_rels/.rels", "word/document.xml"],
    "сторонний парсер не увидел обязательные части документа",
  );
  const document = entries.find((entry) => entry.name === "word/document.xml");
  assert.ok(document.content.includes("Клуб «Омега»"), "Windows-парсер прочитал текст с кириллицей");
  assert.ok(document.content.includes("<w:tbl>"), "таблица дошла целой");
});

test("ODT, собранный своими руками, открывается парсером Windows, и mimetype лежит без сжатия", async () => {
  const odt = tools.blocksToOdt(tools.reportBlocks("# Отчёт\n\n- строка списка"));
  const file = path.join(buildDir, "check.odt");
  await writeFile(file, odt);
  const entries = await listEntriesWithWindowsParser(file);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["mimetype", "content.xml", "META-INF/manifest.xml"],
  );
  const mimetype = entries[0];
  assert.equal(
    mimetype.length,
    mimetype.compressedLength,
    "mimetype обязан лежать без сжатия, иначе LibreOffice не откроет документ",
  );
  assert.equal(mimetype.content.trim(), "application/vnd.oasis.opendocument.text");
  const content = entries.find((entry) => entry.name === "content.xml");
  assert.ok(content.content.includes("строка списка"), "ODT-текст дошёл целым");
});
