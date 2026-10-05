// QA-1: собирает список всех внешних адресов, которые есть внутри упакованного
// app.asar. Нужен, чтобы доказать, куда программа физически может пойти.
//
// Скрипт ничего не меняет в пакете: читает `dist\DB Bot\resources\app.asar`
// через `@electron/asar` и печатает уникальные хосты из строковых литералов
// исходников главного процесса, preload, хоста и рендерера.
//
// Запуск: node scripts/qa-1-asar-hosts.mjs [--out=tests/qa-fixtures/qa-1-asar-hosts.json]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import * as asar from "@electron/asar";

import { repoRoot } from "./lib/config.mjs";
import { toArchiveRelative } from "./lib/asar-paths.mjs";

const argument = (name, fallback) => {
  const found = process.argv.find(value => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const asarPath = path.join(repoRoot, "dist", "DB Bot", "resources", "app.asar");
const outFile = path.resolve(argument("out", path.join(repoRoot, "tests", "qa-fixtures", "qa-1-asar-hosts.json")));

const entries = [];
for (const file of asar.listPackage(asarPath)) {
  if (file.endsWith("/")) continue;
  entries.push(file);
}

const hostPattern = /\b(?:https?|wss?):\/\/([A-Za-z0-9._~%-]+)(?::\d+)?/g;
const byHost = new Map();

const add = (host, entry, sample) => {
  const key = host.toLowerCase();
  const bucket = byHost.get(key) ?? { host: key, entries: new Set(), samples: new Set() };
  bucket.entries.add(entry);
  if (sample.length > 0) bucket.samples.add(sample.slice(0, 160));
  byHost.set(key, bucket);
};

const interesting = /^(?:dist[\\/](?:electron-main|electron-preload|host|local-exec-daemon|box-exec-daemon|node-agent-coordinator)[\\/].*\.cjs|package\.json)$/;
const normalizeEntry = entry => entry.replace(/\\/g, "/").replace(/^\/+/, "");

let unreadable = 0;
for (const entry of entries) {
  if (!interesting.test(normalizeEntry(entry))) continue;
  let text;
  try {
    // `listPackage` отдаёт POSIX-путь, а `extractFile` на Windows требует
    // разделитель этой платформы. Без перевода на строке ниже стоял POSIX-путь,
    // `extractFile` отвечал «was not found in this archive», а `catch` глотал
    // это молча: отчёт печатал «Хостов: 0» и выглядел как «внутри пакета никого
    // нет», хотя файлы не были прочитаны ни один.
    text = asar.extractFile(asarPath, toArchiveRelative(entry)).toString("utf8");
  } catch {
    unreadable += 1;
    continue;
  }
  for (const match of text.matchAll(hostPattern)) {
    const start = Math.max(0, match.index - 40);
    add(match[1], entry, text.slice(start, match.index + match[0].length + 40).replace(/\s+/g, " "));
  }
}

const result = {
  asarPath,
  scannedEntries: entries.filter(entry => interesting.test(normalizeEntry(entry))),
  // Непрочитанные файлы — это и есть главный вывод отчёта. Их ненулевое число
  // означает, что список хостов неполон и опираться на него нельзя.
  unreadableEntries: unreadable,
  hosts: [...byHost.values()]
    .map(bucket => ({ host: bucket.host, entries: [...bucket.entries], samples: [...bucket.samples].slice(0, 4) }))
    .sort((left, right) => left.host.localeCompare(right.host)),
};

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(result, null, 2), "utf8");

console.log(`Просканировано файлов: ${result.scannedEntries.length}`);
console.log(`Не прочитано: ${unreadable}`);
console.log(`Хостов: ${result.hosts.length}`);
if (unreadable > 0) {
  console.log("ВНИМАНИЕ: часть файлов пакета не прочитана, список хостов неполон.");
}
for (const row of result.hosts) {
  console.log(`  ${row.host}  (${row.entries.length} файлов)`);
}
console.log(`Журнал: ${outFile}`);
console.log(`app.asar размер: ${readFileSync(asarPath).length}`);