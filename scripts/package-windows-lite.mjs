// Упаковщик Windows для DB Bot Lite.
//
// Основа пакета — обычный дистрибутив Electron из `node_modules/electron/dist`,
// а не пиннед рантайм 0.18 из `.cache/runtime`, которого в проекте больше нет.
// Скрипт ничего не скачивает: все исходники уже собраны в `.build/app.asar`
// командой `npm run build`.
//
// Чего скрипт НЕ делает намеренно:
//   * не читает `src/app/dist` (папка удалена, объекты были в Git LFS);
//   * не ходит в сеть и не трогает `research-archives`;
//   * не подписывает исполняемый файл (Authenticode на локальной машине не нужен,
//     а подпись сломала бы копирование готового PE-образа).
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { listPackage } from "@electron/asar";

import { builtAsar, builtAsarUnpacked, isWindowsRuntimeHost, outputDir, repoRoot } from "./lib/config.mjs";
import { listArchiveFiles } from "./lib/asar-paths.mjs";
import { resolvePackagedAppArtifacts } from "./lib/packaged-app.mjs";

// Имя каталога и исполняемого файла задаёт `productName` в `.build/app/package.json`:
// «DB Bot». Это ровно то, что ожидает `AGENTS.md` (раздел 10) и ярлык запуска.
const APP_DIR_NAME = "DB Bot";
const EXECUTABLE_NAME = "DB Bot.exe";
const outputApp = path.join(outputDir, APP_DIR_NAME);

// electron-updater читает `resources\app-update.yml` сам, без участия приложения.
// Файл нужен уже на этапе сборки пакета: иначе автообновление молча выключено.
const UPDATE_PROVIDER = "github";
const UPDATE_OWNER = "Hjgyhfyh";
const UPDATE_REPO = "grok-bot-0.18-reconstructed-lite";

// ---------------------------------------------------------------------------
// Уменьшение пакета.
//
// Упаковщик раскладывает рядом с программой весь дистрибутив Electron, а
// пользователю нужна его малая часть. Ниже список того, что убирается и почему.
// Перечень вынесен в константы, а не зашит в вызовы, чтобы список ответа на
// вопрос «что вырезали» был прочитываем целиком.
// ---------------------------------------------------------------------------

/**
 * Языки интерфейса Chromium. Русский обязателен: пользователь работает по-русски.
 * Английский оставлен запасным — в сообщениях Electron и в crashpad есть
 * английские строки, которые не переведены.
 */
const KEPT_LOCALES = Object.freeze(["ru.pak", "en-US.pak"]);

/**
 * Файлы, которые не нужны при программном рендере.
 *
 * `dxcompiler.dll` и `dxil.dll` — компилятор HLSL в DXIL для D3D12. Его
 * трогает только WebGPU, а он выключен флагом `WebGPU` в
 * `collectWeakMachineSwitches`. `LICENSES.chromium.html` — текст лицензий,
 * 19 МБ, которые никто не открывает.
 */
const REMOVED_FILES = Object.freeze(["LICENSES.chromium.html", "dxcompiler.dll", "dxil.dll"]);

/**
 * Файлы, без которых Electron не запустится. Список проверяется ПОСЛЕ
 * урезания: молча удалённый не тот файл проявился бы только на компьютере
 * пользователя.
 */
const REQUIRED_FILES = Object.freeze([
  "icudtl.dat",
  "resources.pak",
  "snapshot_blob.bin",
  "v8_context_snapshot.bin",
  "libEGL.dll",
  "libGLESv2.dll",
  "d3dcompiler_47.dll",
  "ffmpeg.dll",
  "chrome_100_percent.pak",
  "chrome_200_percent.pak",
]);

const electronDist = path.join(repoRoot, "node_modules", "electron", "dist");

/**
 * Убирает из пакета то, что программе не нужно.
 *
 * Проверка `resolved.startsWith(root)` обязательна: пути строятся из строк,
 * и уехавший на один уровень вверх `rm` удалил бы что-то за пределами пакета.
 */
async function trimPackage(root, { keptLocales }) {
  const rootResolved = path.resolve(root);
  const assertInside = (target) => {
    const resolved = path.resolve(target);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      throw new Error(`Отказ удалять файл вне пакета: ${resolved}`);
    }
    return resolved;
  };

  const localesDir = path.join(rootResolved, "locales");
  let removedLocales = 0;
  if (await exists(localesDir)) {
    for (const name of await readdir(localesDir)) {
      if (keptLocales.includes(name)) continue;
      await rm(assertInside(path.join(localesDir, name)), { force: true });
      removedLocales += 1;
    }
  }

  let removedFiles = 0;
  for (const name of REMOVED_FILES) {
    const target = assertInside(path.join(rootResolved, name));
    if (!(await exists(target))) continue;
    await rm(target, { force: true });
    removedFiles += 1;
  }

  const missing = [];
  for (const name of REQUIRED_FILES) {
    if (!(await exists(path.join(rootResolved, name)))) missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(`После урезания пакета нет обязательных файлов: ${missing.join(", ")}`);
  }
  return { removedLocales, removedFiles };
}

if (!isWindowsRuntimeHost) {
  throw new Error("Пакет для Windows собирается только на Windows.");
}

/**
 * Удаляет каталог, который может быть ещё открыт запущенным приложением.
 *
 * EBUSY и EPERM на Windows означают, что файл кто-то держит: у работающего
 * `dist\DB Bot\DB Bot.exe` открыты дескрипторы на exe, DLL и `resources\app.asar`.
 * Повтор делает «сначала закрой приложение» вместо «закрой приложение и угадай момент».
 */
const REMOVAL_RETRYABLE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
async function removeTree(directory, attempts = 20) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!REMOVAL_RETRYABLE_CODES.has(error?.code) || attempt >= attempts) throw error;
      // 150 мс с удвоением: примерно 8 секунд ожидания на попытку.
      await new Promise((resolve) => setTimeout(resolve, Math.min(150 * 2 ** (attempt - 1), 1_000)));
    }
  }
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function directoryBytes(root) {
  let total = 0;
  let files = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await directoryBytes(target);
      total += nested.bytes;
      files += nested.files;
    } else if (entry.isFile()) {
      total += (await stat(target)).size;
      files += 1;
    }
  }
  return { bytes: total, files };
}

// 1. Всё, что нужно скопировать, должно существовать до начала раскладки:
//    иначе потраченные минуты копирования заканчиваются ошибкой в самом конце.
const sourceExecutable = path.join(electronDist, "electron.exe");
if (!(await exists(sourceExecutable))) {
  throw new Error(
    `Нет бинаря Electron: ${sourceExecutable}\n`
    + "Запусти один раз: node node_modules/electron/install.js"
  );
}
if (!(await exists(builtAsar))) {
  throw new Error(`Нет собранного приложения: ${builtAsar}\nСначала выполни: npm run build`);
}

// 2. Чистая копия официального дистрибутива Electron. `dereference: false`
//    сохраняет раскладку как в оригинале, `preserveTimestamps` не даёт сбить
//    временные метки нативных модулей.
await mkdir(outputDir, { recursive: true });
await removeTree(outputApp);
await cp(electronDist, outputApp, { recursive: true, dereference: false, preserveTimestamps: true });

// 3. Переименование исполняемого файла. Windows хранит имя в PE-ресурсах, но
//    Electron запускает файл по пути, поэтому достаточно переименовать копию
//    внутри пакета; подпись не трогаем — её в официальном дистрибутиве нет.
//    Источник в `node_modules` обязан остаться на месте: `rename` переносит файл,
//    и после него `require('electron')` и повторная упаковка падают без файла.
const targetExecutable = path.join(outputApp, EXECUTABLE_NAME);
await cp(sourceExecutable, targetExecutable, { preserveTimestamps: true });
await rm(path.join(outputApp, "electron.exe"), { force: true });

// 4. Пути `resources\app.asar` и `resources\app.asar.unpacked` берём из живой
//    библиотеки упаковки, а не из констант: она знает про форму Windows-каталога.
const { asarPath: packagedAsar, unpackedPath: packagedUnpacked } = resolvePackagedAppArtifacts(outputApp);

// `default_app.asar` — заглушка Electron, которая открывается, когда рядом нет
// `app.asar`. Пока он лежит, Electron может выбрать его вместо нашего архива.
const defaultAppAsar = path.join(path.dirname(packagedAsar), "default_app.asar");
if (await exists(defaultAppAsar)) {
  await rm(defaultAppAsar, { force: true });
  console.log(`Удалён заглушечный ${path.basename(defaultAppAsar)}`);
}

// 5. Собранное приложение. `.unpacked` появляется только если сборка вынесла
//    нативные модули наружу; если его нет, старый каталог из прошлой сборки
//    удаляется, чтобы Electron не читал остатки.
await cp(builtAsar, packagedAsar);
if (await exists(builtAsarUnpacked)) {
  await cp(builtAsarUnpacked, packagedUnpacked, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true
  });
  console.log(`Скопирован ${path.basename(builtAsarUnpacked)}`);
} else {
  await rm(packagedUnpacked, { recursive: true, force: true });
  console.log(`${path.basename(builtAsarUnpacked)} отсутствует: сборка не вынесла нативные модули наружу`);
}

// 6. Урезание пакета. Порядок важен: идёт после раскладки и до проверки
//    обязательных файлов, чтобы проверка видела уже итоговый пакет.
const keptLocales = (process.env.DB_BOT_PACK_KEEP_LOCALES ?? KEPT_LOCALES.join(","))
  .split(",")
  .map(name => name.trim())
  .filter(name => name.length > 0);
const trimmed = await trimPackage(outputApp, { keptLocales });
console.log(`Убрано языков: ${trimmed.removedLocales}, убрано лишних файлов: ${trimmed.removedFiles}`);

// 7. Конфигурация автообновления. electron-updater ожидает YAML без BOM.
const updateConfig = [
  `provider: ${UPDATE_PROVIDER}`,
  `owner: ${UPDATE_OWNER}`,
  `repo: ${UPDATE_REPO}`,
  ""
].join("\n");
await writeFile(path.join(path.dirname(packagedAsar), "app-update.yml"), updateConfig, "utf8");

// 8. Проверка собранного пакета. Пустой архив или архив без `package.json`
//    — это «упаковалось, но запускаться нечему», и это надо увидеть сразу.
const archiveFiles = listArchiveFiles(packagedAsar, listPackage);
if (archiveFiles.length === 0) throw new Error(`Архив ${packagedAsar} пуст`);
if (!archiveFiles.includes("package.json")) {
  throw new Error(`В архиве ${packagedAsar} нет package.json — Electron не найдёт точку входа`);
}
const manifest = JSON.parse(await readFile(path.join(repoRoot, ".build", "app", "package.json"), "utf8"));
const executableBytes = (await stat(targetExecutable)).size;
const totals = await directoryBytes(outputApp);

console.log("");
console.log(`Пакет:            ${outputApp}`);
console.log(`Исполняемый файл: ${targetExecutable} (${(executableBytes / 1024 / 1024).toFixed(1)} МБ)`);
console.log(`Точка входа:      ${manifest.main}`);
console.log(`app.asar:         ${(archiveFiles.length)} файлов, ${((await stat(packagedAsar)).size / 1024 / 1024).toFixed(1)} МБ`);
console.log(`app-update.yml:   ${UPDATE_PROVIDER}/${UPDATE_OWNER}/${UPDATE_REPO}`);
console.log(`Всего:            ${totals.files} файлов, ${(totals.bytes / 1024 / 1024).toFixed(1)} МБ`);