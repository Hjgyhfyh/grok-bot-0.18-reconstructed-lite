#!/usr/bin/env node
/**
 * DB Bot Lite — сборка приложения только из исходников.
 *
 * Это единственный рабочий путь сборки. Он не читает `src/app/dist/**`,
 * `research-archives/**`, `.cache/**` и не ходит в сеть: каждый бандл
 * получается esbuild-ом из `source/**`, рендерер — vite-ом из `frontend/**`.
 *
 * Прежняя «fidelity»-сборка брала оригинальный минифицированный бандл и
 * патчила его байты. Её объекты лежали в Git LFS, сервер их больше не
 * отдаёт, поэтому она мертва. Скрипты, которые её обслуживали, остались на
 * месте и не удалены, но новый путь их не вызывает.
 *
 * Что собирается в `.build/app`:
 *   package.json                      — переписан из `src/app/package.json`
 *   dist/electron-main/main.cjs       — `source/electron-main/main.ts`
 *   dist/host/host-main.cjs           — `source/host/main.ts`
 *   dist/local-exec-daemon/main.cjs   — `source/local-exec-daemon/main.ts`
 *   dist/electron-preload/preload.cjs — `source/electron-preload/preload.ts`
 *   dist/renderer/**                  — `frontend/src/main.tsx` через vite
 *   dist/agent-isolation (host/…)     — воркеры `source/host/agent-isolation`
 *   node_modules/**                   — только те пакеты, которые реально
 *                                       остались внешними в собранных бандлах
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { builtinModules } from "node:module";
import { build as esbuild } from "esbuild";

import { packStagedAppWithIntegrity } from "./lib/asar-integrity.mjs";
import { builtAsar, builtAsarUnpacked, repoRoot, sourceAppDir, stagedAppDir } from "./lib/config.mjs";
import { electronMainExternalRuntimePackageSpecs, requiredElectronMainProductionBindings } from "./electron-main-production-activation.mjs";
import { hostProductionBindingInventorySpecs, requiredHostProductionBindings } from "./host-production-activation.mjs";
import { buildProductionRenderer, rendererProductionEntrypoint, rendererProductionOutput } from "./renderer-production-build.mjs";

const scriptPath = fileURLToPath(import.meta.url);

export const defaultElectronMainBindingManifestPath = path.join(
  repoRoot,
  "manifests/reconstruction/electron-main-production-bindings-manifest.json",
);

/** Куда пишется отчёт о том, что именно собрано и из чего. */
export const fromSourceBuildManifest = "dist/from-source-build.json";

const builtinSet = new Set(builtinModules.flatMap(name => [
  name,
  name.replace(/^node:/, ""),
  `node:${name.replace(/^node:/, "")}`,
]));

/**
 * Префикс, который ставится в начало бандля основного процесса.
 *
 * Раньше здесь стоял `applyReconstructedUpdaterGuard` из `scripts/lib/build-asar.mjs`:
 * он безусловно выставлял `SAND_DISABLE_UPDATES=1`. Для Lite это неверно —
 * пользователь требует, чтобы обновления приезжали сами, а с этим флагом
 * выключался и штатный апдейтер, и новый `source/electron-main/updater/**`.
 *
 * Что осталось и почему:
 *   * Sentry и телеметрия наружу не уходят никогда (`AGENTS.md` §3). Это
 *     два фоновых таймера в главном процессе, а не только запрет на сеть.
 *   * `DB_BOT_DISABLE_RECONSTRUCTED_UPDATES` выключает сервис обновлений
 *     исходного Grok Bot: он опрашивает чужую ленту `api2.cursor.sh` и
 *     поднимает локальный HTTP-сервер Squirrel. Своего апдейтера Lite он не
 *     касается — тот читает `DB_BOT_AUTO_UPDATE`.
 */
export const liteServiceGuard = [
  "// DB Bot Lite guard: no external telemetry, no upstream update feed.",
  "process.env.SAND_DISABLE_SENTRY ??= \"1\";",
  "process.env.SAND_DISABLE_TELEMETRY ??= \"1\";",
  "process.env.DB_BOT_DISABLE_RECONSTRUCTED_UPDATES ??= \"1\";",
  ""
].join("\n");

/**
 * Минификация бандлов.
 *
 * Причина: у пользователя 8 ГБ RAM, а V8 на старте разбирает весь бандл.
 * Минификация срезает примерно четверть объёма, и столько же не достаётся до
 * кучи. `keepNames` оставлен специально: проект проверяет имена функций, и
 * без него минификатор переименует их.
 *
 * `drop: console` не включается: `console.error` в упакованном Electron на
 * Windows уходит в заглушку process.stderr, но `scripts/verify.mjs` и
 * диагностика читают вывод, и молчащий бандл хуже большого.
 */
const nodeBuildOptions = Object.freeze({
  minify: true,
  keepNames: true,
  legalComments: "none",
});

const normalize = value => value.split(path.sep).join("/");

/**
 * Единственная точка, где проверяется, что модуль биндинга лежит в `source/`.
 * В прежней сборке рядом стояла проверка «не `src/app/dist`»; она выкинута
 * вместе с payload, и этот барьер закрывает ту же дыру с другой стороны.
 */
function assertReviewedSourceModule(absolute, label) {
  const relative = normalize(path.relative(repoRoot, absolute));
  if (relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`Binding module escapes the repository: ${label} -> ${relative}`);
  }
  if (relative !== "source" && !relative.startsWith("source/")) {
    throw new Error(`Binding module must live under reviewed source/: ${label} -> ${relative}`);
  }
  return absolute;
}

// ---------------------------------------------------------------------------
// Точки входа: бандл нельзя получить, просто скомпилировав `main.ts`, потому что
// это библиотека. Запуск создаётся здесь — теми же provider-ами, что и раньше,
// только без сверки байтов с удалённым артефактом.
// ---------------------------------------------------------------------------

function bindingExpression(bindings, key) {
  const index = bindings.findIndex(binding => binding.path === key);
  if (index < 0) throw new Error(`Binding lookup failed: ${key}`);
  return bindings[index].access === "call" ? `binding${index}()` : `binding${index}`;
}

function bindingImports(bindings) {
  return bindings.map((binding, index) => (binding.export === "default"
    ? `import binding${index} from ${JSON.stringify(binding.module)};`
    : `import { ${binding.export} as binding${index} } from ${JSON.stringify(binding.module)};`));
}

/**
 * Манифест биндингов Electron-main. Проверяется всё, кроме байтовых якорей в
 * оригинальном `main.cjs`: самого `main.cjs` в репозитории больше нет.
 */
export async function readElectronMainBindingTable({
  manifestPath = process.env.GROK_BOT_ELECTRON_MAIN_BINDINGS_MANIFEST?.trim() || defaultElectronMainBindingManifestPath,
} = {}) {
  const absolute = path.resolve(repoRoot, manifestPath);
  const bytes = await readFile(absolute);
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.bindings)) {
    throw new Error("Electron-main binding manifest must use schemaVersion 1 and a bindings array");
  }
  const byPath = new Map();
  for (const binding of manifest.bindings) {
    if (typeof binding?.path !== "string" || typeof binding.export !== "string" || typeof binding.module !== "string") {
      throw new Error(`Malformed Electron-main binding entry: ${JSON.stringify(binding)}`);
    }
    if (binding.access !== "value" && binding.access !== "call") {
      throw new Error(`Electron-main binding ${binding.path} has an unknown access kind: ${binding.access}`);
    }
    if (byPath.has(binding.path)) throw new Error(`Duplicated Electron-main binding: ${binding.path}`);
    byPath.set(binding.path, {
      path: binding.path,
      access: binding.access,
      export: binding.export,
      module: assertReviewedSourceModule(
        path.resolve(path.dirname(absolute), binding.module),
        binding.path,
      ),
    });
  }
  const missing = requiredElectronMainProductionBindings.filter(name => !byPath.has(name));
  const unexpected = [...byPath.keys()].filter(name => !requiredElectronMainProductionBindings.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Electron-main binding manifest coverage drifted; missing=${missing.join(",") || "none"}, unexpected=${unexpected.join(",") || "none"}`,
    );
  }
  return {
    manifestPath: normalize(path.relative(repoRoot, absolute)),
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
    bindings: requiredElectronMainProductionBindings.map(name => byPath.get(name)),
  };
}

/** Таблица биндингов хоста берётся из инвентаря активации, минуя якоря артефакта. */
export function readHostBindingTable() {
  const byPath = new Map();
  for (const spec of hostProductionBindingInventorySpecs) {
    if (spec.binding == null) continue;
    byPath.set(spec.path, {
      path: spec.path,
      access: spec.binding.access,
      export: spec.binding.export,
      module: assertReviewedSourceModule(
        path.resolve(repoRoot, spec.binding.module),
        spec.path,
      ),
    });
  }
  const missing = requiredHostProductionBindings.filter(name => !byPath.has(name));
  if (missing.length > 0) {
    throw new Error(`Host production bindings are unbound: ${missing.join(",")}`);
  }
  return {
    manifestPath: "scripts/host-production-activation.mjs#hostProductionBindingInventorySpecs",
    bindings: requiredHostProductionBindings.map(name => byPath.get(name)),
  };
}

export function electronMainEntrySource(bindings) {
  const adapterKeys = requiredElectronMainProductionBindings
    .filter(name => name.startsWith("adapters."))
    .map(name => name.slice("adapters.".length));
  return `${bindingImports(bindings).join("\n")}
import { app, safeStorage, ipcMain, BrowserWindow, Menu, shell, screen } from "electron";
import { startElectronMainProduction } from "./source/electron-main/main.ts";
import { createElectronProductionNativeBindings } from "./source/electron-main/main-production-services.ts";
import { createElectronProductionAvatarImagesBinding, createElectronProductionImageContextMenuBinding } from "./source/electron-main/adapters/avatar-images.ts";
import { createElectronProductionCursorAccountBinding } from "./source/electron-main/adapters/account-edge.ts";
import { composeElectronProductionCoordinatorBindings, createElectronProductionServiceFactories } from "./source/electron-main/production-adapters.ts";

const coordinatorBindings = composeElectronProductionCoordinatorBindings(
  ${bindingExpression(bindings, "adapters.coordinator")},
  ${bindingExpression(bindings, "adapters.ipc")},
);
const adapters = {
  // These two edge objects are constructed by the immutable post-context root,
  // not by the manifest slots. They receive the live root context when
  // createElectronProductionServiceFactories invokes them.
  avatarImages: createElectronProductionAvatarImagesBinding(),
  imageContextMenu: createElectronProductionImageContextMenuBinding(),
  cursorAccount: createElectronProductionCursorAccountBinding(),
${adapterKeys.filter(name => name !== "coordinator" && name !== "ipc").map(name => `  ${name}: ${bindingExpression(bindings, `adapters.${name}`)},`).join("\n")}
  ...coordinatorBindings,
};

try {
  startElectronMainProduction({
    native: createElectronProductionNativeBindings({ app, safeStorage, ipcMain, BrowserWindow, Menu, shell, screen }),
    moduleDir: __dirname,
    startup: ${bindingExpression(bindings, "startup")},
    services: createElectronProductionServiceFactories(adapters),
    parseAllowedExternalUrl: ${bindingExpression(bindings, "parseAllowedExternalUrl")},
    reportFailure: ${bindingExpression(bindings, "reportFailure")},
  });
} catch (error) {
  process.stderr.write("[db-bot-main] fatal composition failure: " + String(error) + "\\n");
  process.exitCode = 1;
}
`;
}

export function hostEntrySource(bindings) {
  const extensionHostKeys = ["boxGenerated", "convertCloudAgentConversationToTrace"];
  const extensionBindingKeys = requiredHostProductionBindings
    .filter(name => name.startsWith("extensionBindings."))
    .map(name => name.slice("extensionBindings.".length));
  return `${bindingImports(bindings).join("\n")}
import { startProductionHost } from "./source/host/main.ts";
import { bindRecoveredProductionExtensions } from "./source/host/host-production-extensions.ts";

const ports = {
  executeBoxCopyInFromEnv: ${bindingExpression(bindings, "ports.executeBoxCopyInFromEnv")},
  extensionHost: {
${extensionHostKeys.map(name => `    ${name}: ${bindingExpression(bindings, `ports.extensionHost.${name}`)},`).join("\n")}
  },
  runnerContext: ${bindingExpression(bindings, "ports.runnerContext")},
  createTranscriptMirror: ${bindingExpression(bindings, "ports.createTranscriptMirror")},
};
const extensionBindings = {
${extensionBindingKeys.map(name => `  ${name}: ${bindingExpression(bindings, `extensionBindings.${name}`)},`).join("\n")}
};

void startProductionHost(bindRecoveredProductionExtensions(ports, extensionBindings)).catch((error) => {
  process.stderr.write("[sand-host] fatal: " + String(error) + "\\n");
  process.exitCode = 1;
});
`;
}

/**
 * `local-exec-daemon/main.ts` запускает себя сам, но через `import.meta.url`,
 * а esbuild в CJS подставляет туда заглушку. Явная запись делает запуск
 * детерминированным и не зависит от того, как именно вызвали бандл.
 */
const localExecDaemonEntry = `
import { runLocalExecDaemonEntrypoint } from "./source/local-exec-daemon/main.ts";

void runLocalExecDaemonEntrypoint();
`;

const coordinatorEntry = `
import { composeCoordinator } from "./source/node-agent-coordinator/main.ts";

void composeCoordinator().catch((error) => {
  process.stderr.write(\`node-agent-coordinator: composition failure: \${String(error)}\\n\`);
  process.exit(1);
});
`;

// ---------------------------------------------------------------------------
// Таблица бандлов. Порядок не важен для результата, но держим его явным.
// ---------------------------------------------------------------------------

export const fromSourceBundles = Object.freeze([
  { runtime: "electron-main", output: "dist/electron-main/main.cjs", kind: "electron-main", external: ["electron"] },
  { runtime: "host", output: "dist/host/host-main.cjs", kind: "host", external: [] },
  { runtime: "electron-dev-controls", output: "dist/electron-dev-controls/main.cjs", entry: "source/electron-dev-controls/main.ts", external: ["electron"] },
  { runtime: "primary-preload", output: "dist/electron-preload/preload.cjs", entry: "source/electron-preload/runtime/primary.ts", external: ["electron"], source: "source/electron-preload/preload.ts" },
  { runtime: "dev-controls-preload", output: "dist/electron-preload/preload-dev-controls.cjs", entry: "source/electron-preload/runtime/dev-controls.ts", external: ["electron"] },
  { runtime: "webview-preload", output: "dist/electron-preload/preload-webview.cjs", entry: "source/electron-preload/runtime/webview.ts", external: ["electron"] },
  { runtime: "vnc-preload", output: "dist/electron-preload/preload-vnc.cjs", entry: "source/electron-preload/runtime/vnc.ts", external: ["electron"] },
  { runtime: "node-agent-coordinator", output: "dist/node-agent-coordinator/main.cjs", kind: "coordinator", external: [] },
  { runtime: "box-exec-daemon", output: "dist/box-exec-daemon/main.cjs", entry: "source/box-exec-daemon/cli.ts", external: [] },
  { runtime: "local-exec-daemon", output: "dist/local-exec-daemon/main.cjs", kind: "local-exec-daemon", external: [] },
  { runtime: "host-agent-store-worker", output: "dist/host/agent-isolation/agent-store-worker.cjs", entry: "source/host/agent-isolation/agent-store-worker.ts", external: [] },
  { runtime: "host-transcript-mirror-worker", output: "dist/host/agent-isolation/transcript-mirror-worker.cjs", entry: "source/host/agent-isolation/transcript-mirror-worker.ts", external: [] },
  { runtime: "host-box-store-vacuum-worker", output: "dist/host/extensions/box-store-sync/box-store-vacuum-worker.cjs", entry: "source/host/extensions/box-store-sync/box-store-vacuum-worker.ts", external: [] },
  { runtime: "host-search-index-worker", output: "dist/host/extensions/content-search/search-index-worker.cjs", entry: "source/host/extensions/content-search/search-index-worker.ts", external: [] },
]);

// ---------------------------------------------------------------------------

async function walkFiles(root, current = root) {
  const found = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) found.push(...await walkFiles(root, target));
    else if (entry.isFile()) found.push(normalize(path.relative(root, target)));
  }
  return found.sort();
}

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function bundleBanner(label) {
  return [
    'const __cleanImportMetaUrl = require("node:url").pathToFileURL(__filename).href;',
    `// Deterministic from-source bundle: ${label}`,
    "// Баннер идёт ДО всех require, которые esbuild ставит в начало бандла.",
    "// В упакованном Electron на Windows process.stderr — заглушка: ошибка загрузки",
    "// модуля исчезает без следа, и снаружи это выглядит как «процесс жив, окна нет».",
    "const __dbBotFatal = (kind) => (error) => {",
    "  try {",
    "    const fs = require(\"node:fs\");",
    "    const nodePath = require(\"node:path\");",
    "    const detail = String((error && (error.stack || error.message)) || error);",
    "    const root = process.env.SAND_DATA_ROOT || process.env.APPDATA || process.cwd();",
    "    const file = nodePath.join(root, \"db-bot-start-error.log\");",
    "    fs.mkdirSync(root, { recursive: true });",
    "    fs.appendFileSync(file, `[${new Date().toISOString()}] ${kind}: ${detail}\\n`);",
    "    try {",
    "      require(\"electron\").dialog.showErrorBox(",
    "        \"DB Bot не запустился\",",
    "        `Не удалось запустить программу.\\n\\n${String((error && error.message) || error)}\\n\\nПодробности записаны в файл: ${file}`,",
    "      );",
    "    } catch {}",
    "  } catch {}",
    "};",
    "process.on(\"uncaughtException\", __dbBotFatal(\"uncaughtException\"));",
    "process.on(\"unhandledRejection\", __dbBotFatal(\"unhandledRejection\"));",
  ].join("\n");
}

async function runEsbuild({ outfile, stdin, entryPoints, external, label }) {
  await mkdir(path.dirname(outfile), { recursive: true });
  const result = await esbuild({
    absWorkingDir: repoRoot,
    // `supports-color` приходит транзитивно из `debug` и в упакованном
    // приложении всё равно ничего не проверяет: stdout в Electron на Windows
    // заглушка. Подмена описана в `scripts/lib/stubs/supports-color.cjs`.
    alias: { "supports-color": path.join(repoRoot, "scripts/lib/stubs/supports-color.cjs") },
    banner: { js: bundleBanner(label) },
    bundle: true,
    define: { "import.meta.url": "__cleanImportMetaUrl" },
    entryPoints: entryPoints?.map(entry => path.join(repoRoot, entry)),
    external,
    format: "cjs",
    ...nodeBuildOptions,
    logLevel: "silent",
    metafile: true,
    outfile,
    platform: "node",
    sourcemap: false,
    stdin,
    target: "node22",
  });
  const inputs = Object.keys(result.metafile.inputs)
    .map(input => normalize(path.relative(repoRoot, path.resolve(repoRoot, input))))
    .sort();
  const externals = [...new Set(
    Object.values(result.metafile.outputs).flatMap(output => output.imports.map(item => item.path)),
  )].sort();
  return { outfile, inputs, externals };
}

/** Внешние spec-ификаторы, которые реально должен достать рантайм. */
function runtimePackageSpecifiers(externals) {
  return externals.filter(specifier => (
    !specifier.startsWith("node:")
    && !builtinSet.has(specifier)
    && specifier !== "electron"
    && !specifier.startsWith(".")
    && !path.isAbsolute(specifier)
  ));
}

/**
 * Копирует в сцену ровно те пакеты, чьи версии и целостность зафиксированы в
 * `package-lock.json`. Произвольный список «на всякий случай» здесь означал бы
 * сцену на сотни мегабайт, из которой рантайм читает три пакета.
 *
 * Кладётся не только то, что бандл импортирует напрямую, но и всё транзитивное
 * замыкание этих пакетов. Иначе `require("undici")` на верхнем уровне падает с
 * `Cannot find module '@fastify/busboy'`: приложение стартует, ошибка уходит в
 * process.stderr, а в упакованном Electron на Windows stderr — заглушка, и
 * симптом выглядит как «процесс жив, а окна нет».
 */
export async function stageRuntimePackages(stageRoot, packageNames) {
  const lock = JSON.parse(await readFile(path.join(repoRoot, "package-lock.json"), "utf8"));
  const lockPackages = lock.packages ?? {};

  /** Ищет lock-путь для `name`, видимого из пакета, лежащего в `fromPath`. */
  const resolveLockPath = (fromPath, name) => {
    for (let scope = fromPath; ; scope = path.posix.dirname(scope)) {
      if (scope === "node_modules" || scope === "." || scope === "") break;
      const candidate = `${scope}/node_modules/${name}`;
      if (lockPackages[candidate] != null) return candidate;
    }
    const top = `node_modules/${name}`;
    return lockPackages[top] != null ? top : null;
  };

  const wanted = new Map();
  const queue = [];
  for (const name of packageNames) {
    const lockPath = resolveLockPath("", name);
    if (lockPath != null) queue.push(lockPath);
  }
  while (queue.length > 0) {
    const lockPath = queue.shift();
    if (wanted.has(lockPath)) continue;
    const record = lockPackages[lockPath];
    if (record?.version == null) continue;
    wanted.set(lockPath, record);
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const dependency of Object.keys(record[field] ?? {})) {
        const dependencyPath = resolveLockPath(lockPath, dependency);
        if (dependencyPath != null && !wanted.has(dependencyPath)) queue.push(dependencyPath);
      }
    }
  }

  const staged = [];
  for (const [lockPath, record] of [...wanted].sort(([a], [b]) => a.localeCompare(b))) {
    const name = lockPath.slice(lockPath.lastIndexOf("node_modules/") + "node_modules/".length);
    const source = path.join(repoRoot, lockPath);
    if (!existsSync(source)) {
      if (record.optional === true) continue;
      throw new Error(`Runtime package ${name} is in the lockfile but not installed; run npm ci first`);
    }
    const destination = path.join(stageRoot, lockPath);
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, dereference: false, preserveTimestamps: true });
    staged.push({ name, version: record.version, path: lockPath, integrity: record.integrity ?? null });
  }
  return staged;
}

/**
 * `src/app/package.json` описывает оригинальную сборку: там тридцать пакетов
 * `workspace:*`, которых в этом репозитории нет, и нет ни одного, что
 * понадобится собранному бандлу. Оставляем только реально установленные.
 */
export async function buildStagedPackageJson(stageRoot, { runtimePackages = [] } = {}) {
  const source = JSON.parse(await readFile(path.join(sourceAppDir, "package.json"), "utf8"));
  const kept = {};
  const dropped = [];
  for (const [name, version] of Object.entries(source.dependencies ?? {})) {
    if (typeof version !== "string" || version.startsWith("workspace:") || version.startsWith("file:")) {
      dropped.push({ name, version, reason: version.startsWith("workspace:") ? "workspace-protocol" : "local-path" });
      continue;
    }
    if (!existsSync(path.join(repoRoot, "node_modules", name))) {
      dropped.push({ name, version, reason: "not-installed" });
      continue;
    }
    kept[name] = version;
  }
  for (const staged of runtimePackages) kept[staged.name] = staged.version;
  const manifest = {
    name: "db-bot",
    productName: "DB Bot",
    version: source.version,
    description: "DB Bot Lite — настольный помощник на DeepSeek для одного пользователя.",
    private: true,
    type: "module",
    main: "dist/electron-main/main.cjs",
    dependencies: kept,
    sandTrack: source.sandTrack ?? "stable",
  };
  await writeFile(path.join(stageRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, dropped };
}

export async function buildFromSource({
  stageRoot = stagedAppDir,
  archivePath = builtAsar,
  unpackedRoot = builtAsarUnpacked,
  pack = true,
} = {}) {
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageRoot, { recursive: true });

  const electronMainTable = await readElectronMainBindingTable();
  const hostTable = readHostBindingTable();

  const runtimePackages = [];
  const bundleRecords = [];
  for (const bundle of fromSourceBundles) {
    const outfile = path.join(stageRoot, bundle.output);
    const external = [...bundle.external];
    let stdin;
    let label;
    if (bundle.kind === "electron-main") {
      external.push(...electronMainExternalRuntimePackageSpecs.map(spec => spec.name));
      stdin = {
        contents: electronMainEntrySource(electronMainTable.bindings),
        loader: "ts",
        resolveDir: repoRoot,
        sourcefile: "scripts/build-entry/from-source-electron-main.ts",
      };
      label = "source/electron-main/main.ts";
    } else if (bundle.kind === "host") {
      stdin = {
        contents: hostEntrySource(hostTable.bindings),
        loader: "ts",
        resolveDir: repoRoot,
        sourcefile: "scripts/build-entry/from-source-host.ts",
      };
      label = "source/host/main.ts";
    } else if (bundle.kind === "local-exec-daemon") {
      stdin = { contents: localExecDaemonEntry, loader: "ts", resolveDir: repoRoot, sourcefile: "scripts/build-entry/from-source-local-exec-daemon.ts" };
      label = "source/local-exec-daemon/main.ts";
    } else if (bundle.kind === "coordinator") {
      stdin = { contents: coordinatorEntry, loader: "ts", resolveDir: repoRoot, sourcefile: "scripts/build-entry/from-source-coordinator.ts" };
      label = "source/node-agent-coordinator/main.ts";
    } else {
      label = bundle.entry;
    }
    const built = await runEsbuild({
      outfile,
      stdin,
      entryPoints: stdin == null ? [bundle.entry] : null,
      external,
      label,
    });
    if (bundle.kind === "electron-main") {
      const bundled = await readFile(outfile, "utf8");
      await writeFile(outfile, bundled.startsWith(liteServiceGuard) ? bundled : `${liteServiceGuard}${bundled}`);
    }
    const leaked = built.inputs.filter(input => input.startsWith("src/app/") || input.startsWith("dist/") || input.startsWith(".build/"));
    if (leaked.length > 0) {
      throw new Error(`${bundle.runtime} bundle reaches staged or artifact inputs: ${leaked.join(", ")}`);
    }
    const unexpected = built.externals.filter(specifier => (
      !specifier.startsWith(".")
      && !path.isAbsolute(specifier)
      && !builtinSet.has(specifier)
      && !external.includes(specifier)
    ));
    if (unexpected.length > 0) {
      throw new Error(`${bundle.runtime} bundle has undeclared external imports: ${unexpected.join(", ")}`);
    }
    runtimePackages.push(...runtimePackageSpecifiers(built.externals));
    bundleRecords.push({
      runtime: bundle.runtime,
      path: bundle.output,
      source: bundle.source ?? bundle.entry ?? label,
      bytes: (await stat(outfile)).size,
      sha256: sha256(await readFile(outfile)),
      inputCount: built.inputs.length,
      externals: built.externals.filter(specifier => !builtinSet.has(specifier)),
    });
    console.log(`  ${bundle.output} (${bundleRecords.at(-1).bytes} bytes)`);
  }

  const stagedPackages = await stageRuntimePackages(stageRoot, new Set(runtimePackages));
  const { manifest, dropped } = await buildStagedPackageJson(stageRoot, { runtimePackages: stagedPackages });

  console.log(`Renderer: ${rendererProductionEntrypoint} -> ${rendererProductionOutput}`);
  const renderer = await buildProductionRenderer({ outputRoot: stageRoot });

  // Отчётные скиллы — содержимое, а не код: без них в установленной программе
  // skill_list честно ответит «скиллов нет», и агент не сможет собрать отчёт.
  const stagedSkills = path.join(stageRoot, "skills");
  await rm(stagedSkills, { recursive: true, force: true });
  await cp(path.join(repoRoot, "skills"), stagedSkills, { recursive: true, preserveTimestamps: true });
  const skillFiles = (await walkFiles(stagedSkills)).map(relative => `skills/${relative}`);
  console.log(`Report skills staged: ${skillFiles.length} files`);

  const files = await walkFiles(stageRoot);
  const outputs = [];
  for (const relative of files) {
    if (relative === fromSourceBuildManifest) continue;
    const bytes = await readFile(path.join(stageRoot, relative));
    outputs.push({ path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  const report = {
    schemaVersion: 1,
    mode: "from-source",
    appVersion: manifest.version,
    productName: manifest.productName,
    electronMain: {
      manifestPath: electronMainTable.manifestPath,
      manifestSha256: electronMainTable.manifestSha256,
      bindings: electronMainTable.bindings.map(({ path: bindingPath, export: bindingExport, access }) => ({ path: bindingPath, export: bindingExport, access })),
    },
    host: {
      manifestPath: hostTable.manifestPath,
      bindings: hostTable.bindings.map(({ path: bindingPath, export: bindingExport, access }) => ({ path: bindingPath, export: bindingExport, access })),
    },
    runtimePackages: stagedPackages,
    droppedAppDependencies: dropped,
    bundles: bundleRecords,
    renderer: {
      entrypoint: renderer.provenance.entrypoint,
      outputCount: renderer.outputs.length,
      missingRuntimeAssets: renderer.provenance.missingRuntimeAssets,
      bootstrapArtifactAvailable: renderer.provenance.evidence.bootstrap.artifactAvailable,
    },
    // Чего в сборке нет и почему. Пустой список означал бы, что отчёт молчит
    // об осознанно пропущенном содержимом.
    knownGaps: [
      {
        path: "dist/native",
        status: "absent-by-design",
        detail: "Sand-webauthn signer и tree-sitter нативники жили только в LFS-объектах 0.18. Не копируются и не восстанавливаются.",
        impact: "Анализ shell-команд деградирует до parsingFailed (shell-parser.ts ловит это сам); на запуск и сборку не влияет.",
      },
      {
        path: "dist/deps",
        status: "absent-by-design",
        detail: "tree-sitter/tree-sitter-bash грузятся из распакованной полезной нагрузки Electron. Их .node собраны под ABI Electron, из node_modules их брать нельзя.",
        impact: "См. dist/native: только анализ shell-команд.",
      },
      {
        path: "dist/renderer/assets (часть)",
        status: "missing-by-loss",
        detail: renderer.provenance.missingRuntimeAssets.join(", "),
        impact: "Иконки и вспомогательные чанки (compact, messages, iamcal, emojibase, xlsx) вернутся как 404. PDF-ссылка переписана на ./pdf-WLgSwHwh.js, но vite из frontend/ такого чанка не выпускает: чистый фронтенд не импортирует pdfjs-dist, а хранит только строку пути. Открытие PDF не заработает, пока владелец frontend/ не добавит настоящий импорт.",
      },
    ],
    outputs,
  };
  const manifestPath = path.join(stageRoot, fromSourceBuildManifest);
  await writeFile(manifestPath, `${JSON.stringify(report, null, 2)}\n`);

  if (pack) {
    await packStagedAppWithIntegrity({ stageRoot, archivePath, unpackedRoot });
    console.log(`ASAR ready: ${archivePath}`);
  }

  console.log(`Staged application: ${stageRoot} (${outputs.length + 1} files)`);
  console.log(`Renderer runtime assets missing (LFS-only): ${renderer.provenance.missingRuntimeAssets.length}`);
  return { stageRoot, archivePath, unpackedRoot, report, manifestPath, renderer };
}

if (process.argv[1] != null && path.resolve(process.argv[1]) === scriptPath) {
  const pack = !process.argv.slice(2).includes("--no-pack");
  await buildFromSource({ pack });
}