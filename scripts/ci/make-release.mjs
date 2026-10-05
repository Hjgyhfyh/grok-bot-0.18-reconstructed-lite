#!/usr/bin/env node
// Сборка релиза DB Bot Lite: архив обновления и `latest.yml`.
//
// Формат `latest.yml` читает electron-updater: он идёт в релиз GitHub, и по
// нему провайдер находит архив, сверяет контрольную сумму и скачивает.
//
// Имя архива — без пробелов и заглавных букв по непонятной причине:
// `GitHubProvider.resolveFiles` заменяет пробелы на дефисы перед сборкой
// адреса, и имя с пробелом искалось бы как другое.
//
// Запуск: node scripts/ci/make-release.mjs <версия-без-v>
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildZip } from "../lib/zip-writer.mjs";
import { repoRoot } from "../lib/config.mjs";
import { resolveReleaseVersion } from "./set-release-version.mjs";

const APP_DIR_NAME = "DB Bot";
const EXECUTABLE_NAME = "DB Bot.exe";

const scriptPath = fileURLToPath(import.meta.url);

/** Рекурсивный обход каталога в порядке, который не меняется от запуска к запуску. */
async function collectFiles(root, current = root) {
  const found = [];
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) found.push(...await collectFiles(root, target));
    else if (entry.isFile()) found.push(path.relative(root, target).split(path.sep).join("/"));
  }
  return found;
}

function assertVersion(value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`Версия релиза должна быть SemVer без префикса v, получено: ${String(value)}`);
  }
  return value;
}
export async function makeRelease(version) {
  const appDirectory = path.join(repoRoot, "dist", APP_DIR_NAME);
  const executable = path.join(appDirectory, EXECUTABLE_NAME);
  await stat(executable).catch(() => {
    throw new Error(`Нет собранного пакета: ${executable}. Сначала выполни npm run package:win`);
  });

  const relativeFiles = await collectFiles(appDirectory);
  if (relativeFiles.length === 0) throw new Error(`Каталог пакета пуст: ${appDirectory}`);
  const entries = [];
  for (const relative of relativeFiles) {
    entries.push({ name: relative, data: await readFile(path.join(appDirectory, relative)) });
  }

  const archiveName = `db-bot-${version}-win32-x64.zip`;
  const outputDirectory = path.join(repoRoot, "release");
  await mkdir(outputDirectory, { recursive: true });
  const archivePath = path.join(outputDirectory, archiveName);
  const archive = buildZip(entries);
  await writeFile(archivePath, archive);

  const sha512 = createHash("sha512").update(archive).digest("base64");
  const releaseDate = new Date().toISOString();
  // YAML пишется вручную и без BOM: electron-updater читает файл js-yaml,
  // а лишние пробелы и кавычки меняют разбор имени файла.
  const latestYml = [
    `version: ${version}`,
    "files:",
    `  - url: ${archiveName}`,
    `    sha512: ${sha512}`,
    `    size: ${archive.length}`,
    `path: ${archiveName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    "",
  ].join("\n");
  const latestPath = path.join(outputDirectory, "latest.yml");
  await writeFile(latestPath, latestYml, "utf8");

  return {
    version,
    archiveName,
    archivePath,
    archiveBytes: archive.length,
    fileCount: relativeFiles.length,
    latestPath,
    sha512,
  };
}

if (process.argv[1] != null && path.resolve(process.argv[1]) === scriptPath) {
  const version = assertVersion(resolveReleaseVersion({ argv: process.argv.slice(2), env: process.env }));
  const result = await makeRelease(version);
  console.log(`Архив:      ${result.archivePath}`);
  console.log(`Файлов:     ${result.fileCount}`);
  console.log(`Размер:     ${(result.archiveBytes / 1048576).toFixed(1)} МБ`);
  console.log(`sha512:     ${result.sha512}`);
  console.log(`Манифест:   ${result.latestPath}`);
}
