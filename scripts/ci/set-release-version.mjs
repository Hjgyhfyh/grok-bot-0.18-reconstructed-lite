#!/usr/bin/env node
// Проставляет версию релиза в `src/app/package.json`.
//
// Откуда берётся версия приложения: `scripts/build-from-source.mjs` пишет
// `.build/app/package.json` из `src/app/package.json`. То есть тег `v1.0.1`
// без этого шага дал бы релиз, который electron-updater посчитал бы старым:
// подписанная сборка и манифест говорили бы о разных версиях.
//
// Скрипт меняет только поле `version` и только в рабочем дереве CI.
//
// Запуск: node scripts/ci/set-release-version.mjs 1.0.1
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { repoRoot } from "../lib/config.mjs";

const scriptPath = fileURLToPath(import.meta.url);

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * Достаёт версию из тега или аргумента.
 *
 * Источники проверяются по очереди: аргумент, `DB_BOT_RELEASE_VERSION`,
 * `GITHUB_REF_NAME`, `GITHUB_REF`. Префикс `v` отбрасывается, потому что
 * electron-updater сравнивает версии semver, а `v1.0.1` такой версией не
 * является.
 */
export function resolveReleaseVersion({ argv = [], env = {} } = {}) {
  const raw = argv[0] ?? env.DB_BOT_RELEASE_VERSION ?? env.GITHUB_REF_NAME ?? env.GITHUB_REF ?? "";
  const withoutRefPrefix = String(raw).replace(/^refs\/tags\//, "").replace(/^v/, "");
  if (!SEMVER.test(withoutRefPrefix)) {
    throw new Error(`Не удалось определить версию релиза из "${String(raw)}". Ожидается тег вида v1.2.3`);
  }
  return withoutRefPrefix;
}

export async function applyReleaseVersion(version) {
  const manifestPath = path.join(repoRoot, "src", "app", "package.json");
  const original = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(original);
  const previous = manifest.version;
  manifest.version = version;
  // JSON.stringify с двумя пробелами — формат, который уже использует
  // build-from-source.mjs. BOM не пишется: файл читается через JSON.parse.
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifestPath, previous, version };
}

if (process.argv[1] != null && path.resolve(process.argv[1]) === scriptPath) {
  const version = resolveReleaseVersion({ argv: process.argv.slice(2), env: process.env });
  const result = await applyReleaseVersion(version);
  console.log(`Версия приложения: ${result.previous} -> ${result.version} (${result.manifestPath})`);
}
