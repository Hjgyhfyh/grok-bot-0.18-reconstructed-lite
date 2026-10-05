#!/usr/bin/env node
// Проверка конвейера релиза без запуска приложения.
//
// Что проверяется:
//   1. `.github/workflows/release.yml` разбирается и содержит нужные шаги;
//   2. версия релиза достаётся из тега и без него;
//   3. архив, который уедет пользователю, читается тем же распаковщиком,
//      которым пользуется приложение;
//   4. `make-release.mjs` собирает архив и манифест из готового пакета.
//
// Требует собранного пакета: сначала `npm run build`, потом `npm run package:win`.
//
// Запуск: node scripts/ci/selfcheck.mjs
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import jsYaml from "js-yaml";
import { build as esbuild } from "esbuild";

import { buildZip, crc32 } from "../lib/zip-writer.mjs";
import { makeRelease } from "./make-release.mjs";
import { resolveReleaseVersion } from "./set-release-version.mjs";
import { repoRoot } from "../lib/config.mjs";

const checks = [];
const check = (name, ok, meaning) => checks.push({ name, ok: Boolean(ok), meaning });

const workflow = jsYaml.load(await readFile(path.join(repoRoot, ".github/workflows/release.yml"), "utf8"));
const jobs = workflow.jobs ?? {};
const stepNames = (jobs.release?.steps ?? []).map(step => step.name);
const serializedSteps = JSON.stringify(jobs.release?.steps ?? []);
check("workflow.yml разбирается", typeof jobs.release === "object", "файл не сломан");
check("сборка привязана к тегу", Array.isArray(workflow.on?.push?.tags), "запуск только по тегу v*");
check("есть contents: write", workflow.permissions?.contents === "write", "релиз создать можно");
check("runs-on windows-latest", jobs.release?.["runs-on"] === "windows-latest", "сборка под Windows");
check("шаг установки Electron есть", stepNames.includes("Установка Electron без install.js"), "install.js не вызывается");
check("postinstall подключён явно", stepNames.includes("Сторонние правки") && serializedSteps.includes("--ignore-scripts"), "npm ci его пропускает, шаг возвращает");
check("публикация релиза есть", stepNames.includes("Публикация релиза"), "релиз создаётся");

check("версия из GITHUB_REF_NAME=v1.0.1", resolveReleaseVersion({ argv: [], env: { GITHUB_REF_NAME: "v1.0.1" } }) === "1.0.1", "префикс v отброшен");
check("версия из GITHUB_REF=refs/tags/v2.3.4", resolveReleaseVersion({ argv: [], env: { GITHUB_REF: "refs/tags/v2.3.4" } }) === "2.3.4", "полная ссылка на тег разобрана");
let rejectedEmptyVersion = false;
try { resolveReleaseVersion({ argv: [], env: {} }); } catch { rejectedEmptyVersion = true; }
check("пустая версия отвергнута", rejectedEmptyVersion, "собирать релиз без версии нельзя");

const workdir = await mkdtemp(path.join(tmpdir(), "dbbot-ci-"));
const sample = Buffer.from("Привет, DB Bot. ".repeat(500), "utf8");
const nested = Buffer.from([0, 1, 2, 250, 251, 252]);
const archive = buildZip([
  { name: "root.txt", data: sample },
  { name: "nested/deep.bin", data: nested },
]);
const archivePath = path.join(workdir, "probe.zip");
await mkdir(path.join(workdir, "payload"), { recursive: true });
await writeFile(archivePath, archive);

// Распаковщик лежит в TypeScript и попадает в программу через esbuild.
// Здесь он собирается тем же esbuild, что и в сборке приложения, и читает
// архив, написанный скриптом релиза. Это и есть проверка согласованности
// двух сторон: что уедет пользователю, тем он и распакует.
const readerPath = path.join(workdir, "zip-reader.mjs");
await esbuild({
  absWorkingDir: repoRoot,
  entryPoints: [path.join(repoRoot, "source/electron-main/updater/zip-archive.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: readerPath,
  logLevel: "silent",
});
const { extractZipFile } = await import(pathToFileURL(readerPath).href);
const report = await extractZipFile(archivePath, path.join(workdir, "payload"));
check("распаковка вернула 2 файла", report.files === 2, `получено ${report.files}`);
check("содержимое совпало побайтово", (await readFile(path.join(workdir, "payload", "root.txt"))).equals(sample), "тот же код читает то, что написал");
check("вложенный путь сохранён", (await readFile(path.join(workdir, "payload", "nested", "deep.bin"))).equals(nested), "слэши в имени записи");
check("crc32 пустого буфера равен нулю", crc32(Buffer.alloc(0)) === 0, "контрольная сумма считается верно");
await rm(workdir, { recursive: true, force: true });

const release = await makeRelease("9.9.9");
const manifest = await readFile(release.latestPath, "utf8");
check("архив обновления не пустой", (await stat(release.archivePath)).size > 1_000_000, "архив собран из пакета");
check("latest.yml ссылается на архив", manifest.includes(`- url: ${release.archiveName}`), "имя в манифесте совпадает с именем файла");
check("имя архива без пробелов", !release.archiveName.includes(" "), "GitHubProvider не переписывает пробелы на дефисы");
check("в latest.yml есть sha512", /sha512: \S{88}/.test(manifest), "контрольная сумма для сверки загрузки");
await rm(path.join(repoRoot, "release"), { recursive: true, force: true });

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed += 1;
  console.log(`${item.ok ? "✔" : "✖"} ${item.name} — ${item.meaning}`);
}
console.log(`\nПроверок: ${checks.length}, провалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
