// Тест ловит ровно ту поломку, из-за которой просмотр PDF отдавал 404, а сборка
// шесть лет печатала «Renderer runtime assets missing (LFS-only): 26».
//
// Что было: папка `src/app/dist` жила только в Git LFS и была удалена вместе с
// байтами. Рендерер продолжал ссылаться на имена файлов из неё. Манифест
// `frontend/manifests/renderer-runtime-assets.json` перечислял эти имена, но
// проверка сравнивала их с каталогом, которого нет, и просто писала «26» в
// отчёт. Ничто не падало: ни сборка, ни тесты, ни упаковка. Ассеты пропадали
// молча, и первым человек узнавал об этом по 404 в сети приложения.
//
// Что доказывает тест:
//  1. Каждый ассет, объявленный в манифесте, назван строковым литералом в
//     исходнике рендерера — «объявлен, но не используется» поймать нельзя.
//  2. Каждый литерал в `rendererRuntimeAssetUrl()` объявлен в манифесте.
//  3. Источник каждого ассета физически существует в `node_modules`, версия
//     пакета совпадает, размер и sha256 совпадают.
//  4. Собранный рендерер не ссылается на псевдоним `/upstream/assets/` и на
//     имя ассета, которого рядом с чанком нет.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildProductionRenderer } from "../scripts/renderer-production-build.mjs";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "frontend", "manifests", "renderer-runtime-assets.json");
const rendererSourceRoot = path.join(repoRoot, "frontend", "src");

const UPSTREAM_ASSET_ALIAS = "/upstream/assets/";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function walkFiles(root, predicate) {
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && predicate(full)) found.push(full);
    }
  };
  visit(root);
  return found;
}

function rendererSourceText() {
  return walkFiles(rendererSourceRoot, file => /\.[cm]?tsx?$/.test(file))
    .map(file => readFileSync(file, "utf8"))
    .join("\n");
}

test("каждый ассет рендерера назван в исходнике, а каждый литерал объявлен в манифесте", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const source = rendererSourceText();
  const declared = manifest.assets.map(asset => asset.file);

  const unreferenced = declared.filter(file => !source.includes(`"${file}"`));
  assert.deepEqual(
    unreferenced,
    [],
    `манифест объявляет ассеты, которых нет в исходнике: ${unreferenced.join(", ")}`,
  );

  const literals = [...source.matchAll(/rendererRuntimeAssetUrl\("([^"]+)"\)/g)].map(match => match[1]);
  const undeclared = [...new Set(literals)].filter(file => !declared.includes(file));
  assert.deepEqual(
    undeclared,
    [],
    `исходник ссылается на ассеты, которых нет в манифесте: ${undeclared.join(", ")}`,
  );

  // Счётчик не должен быть нулевым: иначе проверка ничего не искала.
  assert.ok(declared.length >= 7, `в манифесте всего ${declared.length} ассетов — набор слишком мал, чтобы проверка что-то искала`);
});

test("источник каждого ассета существует в node_modules и совпадает по версии, размеру и sha256", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const asset of manifest.assets) {
    const packageRoot = path.join(repoRoot, "node_modules", asset.package);
    const packageManifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    assert.equal(
      packageManifest.version,
      asset.packageVersion,
      `версия пакета ${asset.package} разошлась с манифестом ассета ${asset.file}`,
    );
    const source = path.join(packageRoot, asset.source);
    assert.ok(statSync(source).isFile(), `источник ассета ${asset.file} не найден: ${asset.package}/${asset.source}`);
    const sourceBytes = readFileSync(source);
    const emitted = asset.mode === "json-module"
      ? Buffer.from(`export default ${sourceBytes.toString("utf8").trim()};\n`, "utf8")
      : sourceBytes;
    assert.equal(emitted.byteLength, asset.bytes, `размер ассета ${asset.file} разошёлся`);
    assert.equal(sha256(emitted), asset.sha256, `sha256 ассета ${asset.file} разошёлся`);
  }
});

test("собранный рендерер ссылается только на файлы, которые лежат рядом с ним", async () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const stageRoot = await mkdtemp(path.join(os.tmpdir(), "dbbot-renderer-assets-"));
  try {
    // Рендерер собирается настоящим, а не выдуманным: иначе тест проверял бы
    // пустой каталог и проходил бы при любой поломке.
    const renderer = await buildProductionRenderer({ outputRoot: stageRoot });
    assert.deepEqual(
      renderer.provenance.missingRuntimeAssets,
      [],
      `сборка потеряла runtime-ассеты: ${renderer.provenance.missingRuntimeAssets.join(", ")}`,
    );

    const rendererRoot = renderer.rendererRoot;
    const emitted = walkFiles(rendererRoot, file => /\.(?:html|js|css)$/.test(file));
    assert.ok(emitted.length > 0, "рендерер не собрался: в каталоге нет ни одного файла");

    const aliases = [];
    const dangling = [];
    const referenced = new Set();
    for (const file of emitted) {
      const text = readFileSync(file, "utf8");
      if (text.includes(UPSTREAM_ASSET_ALIAS)) aliases.push(path.relative(rendererRoot, file));
      for (const asset of manifest.assets) {
        if (!text.includes(`"${asset.file}"`)) continue;
        referenced.add(asset.file);
        if (!statSync(path.join(path.dirname(file), asset.file), { throwIfNoEntry: false })?.isFile()) {
          dangling.push(`${path.relative(rendererRoot, file)} -> ${asset.file}`);
        }
      }
    }
    assert.deepEqual(aliases, [], `готовый рендерер ссылается на псевдоним ${UPSTREAM_ASSET_ALIAS}`);
    assert.deepEqual(dangling, [], `готовый рендерер ссылается на отсутствующие ассеты: ${dangling.join(", ")}`);
    assert.deepEqual(
      manifest.assets.map(asset => asset.file).filter(file => !referenced.has(file)),
      [],
      "скопированные ассеты рендерера никем не запрошены",
    );
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
});