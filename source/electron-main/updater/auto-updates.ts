// Автообновление DB Bot Lite.
//
// Пользователь нетехнический: обновление должно приезжать само, без кнопок и
// без вопросов. Поэтому здесь три независимые части:
//
//   1. Проверка. Раз в сутки спрашиваем GitHub Releases, есть ли новая версия.
//   2. Скачивание. Идёт в фоне, пока пользователь работает.
//   3. Установка. Происходит при закрытии программы.
//
// Три нестандартных решения, которые нужно понимать до правки:
//
// * electron-updater умеет ставить обновление через NSIS (`Update.exe` и
//   `installer\*.7z` рядом с программой). Здесь папка собирается скриптом
//   `scripts\package-windows-lite.mjs` из голого дистрибутива Electron, и этих
//   двух файлов в ней нет и быть не может. Поэтому наследуется `AppUpdater`
//   (он отвечает за провайдера, версии, токен приватного репозитория и
//   сравнение версий), а скачивание и установка написаны здесь.
// * Распаковка идёт в главном процессе сразу после скачивания, а не при
//   закрытии: в закрытом виде файлы заняты самой программой.
// * Установку делает отдельный процесс PowerShell. Он ждёт выхода программы по
//   номеру процесса и только потом меняет файлы.
//
// Выключается всё одной переменной: `DB_BOT_AUTO_UPDATE=0`.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { AppUpdater, UPDATE_DOWNLOADED } from "electron-updater";
// `DownloadUpdateOptions` есть в `electron-updater`, но не в его корневом
// списке экспортов: тип лежит в модуле базового класса.
import type { DownloadUpdateOptions } from "electron-updater/out/AppUpdater.js";
import type { UpdateInfo } from "builder-util-runtime";

import { buildApplyScript } from "./apply-script.js";
import { extractZipFile } from "./zip-archive.js";

/** Как часто проверяется наличие новой версии. Требование пользователя: раз в сутки. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
/** Первая проверка откладывается, чтобы не мешать появлению окна. */
export const INITIAL_UPDATE_CHECK_DELAY_MS = 45_000;
/** Случайный разброс, чтобы все копии программы не проверяли в одну секунду. */
export const UPDATE_CHECK_JITTER_MS = 30 * 60_000;

const STAGING_ROOT_NAME = "db-bot-updates";
const PENDING_MARKER = "pending-update.json";
const LOG_NAME = "db-bot-update.log";

export interface AutomaticUpdateInput {
  readonly app: {
    readonly isPackaged: boolean;
    readonly on: (event: "before-quit", listener: () => void) => void;
    readonly quit: () => void;
  };
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly appVersion?: string;
}

export interface StagedUpdate {
  readonly version: string;
  readonly stagingDirectory: string;
}

interface PendingMarker {
  readonly version: string;
}

/**
 * Каталог, где лежит распакованная новая сборка.
 *
 * Он намеренно вне каталога программы: копирование поверх работающей копии
 * невозможно, пока та запущена, а распаковывать нужно уже сейчас.
 */
export function resolveStagingRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.TEMP ?? env.TMP ?? tmpdir();
  return path.join(base, STAGING_ROOT_NAME);
}

/**
 * Токен для приватного репозитория. Для публичного он не нужен, и тогда
 * проверка идёт без заголовка `Authorization`.
 */
export function resolveGitHubToken(env: NodeJS.ProcessEnv): string | null {
  for (const name of ["DB_BOT_UPDATE_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = env[name]?.trim();
    if (value != null && value.length > 0) return value.startsWith("token ") || value.startsWith("Bearer ") ? value : `token ${value}`;
  }
  return null;
}

/** Поток, который считает байты и раз в процент сообщает о прогрессе. */
function createProgressCounter(onProgress: (percent: number, transferred: number) => void): Transform {
  let transferred = 0;
  let lastPercent = -1;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      transferred += chunk.length;
      const percent = Math.floor((transferred / (50 * 1024 * 1024)) * 100);
      if (percent !== lastPercent) {
        lastPercent = percent;
        onProgress(percent, transferred);
      }
      callback(null, chunk);
    },
  });
}

async function sha512Base64(file: string): Promise<string> {
  const hash = createHash("sha512");
  await pipeline(createReadStream(file), hash);
  return hash.digest("base64");
}

async function downloadArchive(input: {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly destination: string;
  readonly isCancelled: () => boolean;
  readonly onProgress: (percent: number, transferred: number) => void;
}): Promise<void> {
  const response = await fetch(input.url, { headers: input.headers, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`сервер релиза ответил ${response.status} на ${input.url}`);
  }
  if (response.body == null) throw new Error("сервер релиза не прислал тело ответа");
  await mkdir(path.dirname(input.destination), { recursive: true });
  const handle = await open(input.destination, "w");
  try {
    await pipeline(
      response.body,
      createProgressCounter(input.onProgress),
      handle.createWriteStream({ autoClose: false }),
    );
  } finally {
    await handle.close();
  }
  if (input.isCancelled()) throw new Error("загрузка отменена");
}

async function readPendingMarker(stagingRoot: string): Promise<PendingMarker | null> {
  try {
    const raw = await readFile(path.join(stagingRoot, PENDING_MARKER), "utf8");
    const parsed = JSON.parse(raw) as PendingMarker;
    return typeof parsed?.version === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function writePendingMarker(stagingRoot: string, marker: PendingMarker): Promise<void> {
  await mkdir(stagingRoot, { recursive: true });
  await writeFile(path.join(stagingRoot, PENDING_MARKER), `${JSON.stringify(marker)}\n`, "utf8");
}

/**
 * electron-updater со всеми его провайдерами и сравнением версий, но со своей
 * установкой: `Update.exe` в этой сборке нет (см. шапку файла).
 */
export class DbBotFolderUpdater extends AppUpdater {
  private staged: StagedUpdate | null = null;

  constructor(private readonly write: (message: string) => void) {
    super(null);
    this.autoDownload = true;
    // Установку делает наш собственный обработчик закрытия программы:
    // базовый класс ждёт `Update.exe`, которого в пакете нет.
    this.autoInstallOnAppQuit = false;
    this.allowPrerelease = false;
    this.allowDowngrade = false;
  }

  /** Отдаёт наружу распакованную сборку, если она уже готова. */
  getStaged(): StagedUpdate | null {
    return this.staged;
  }

  setStaged(staged: StagedUpdate | null): void {
    this.staged = staged;
  }

  protected async doDownloadUpdate(request: DownloadUpdateOptions): Promise<string[]> {
    const { info, provider } = request.updateInfoAndProvider;
    const files = provider.resolveFiles(info);
    const artifact = files.find(file => file.url.pathname.toLowerCase().endsWith(".zip"));
    if (artifact == null) {
      throw new Error(`в релизе ${info.version} нет архива .zip: ${files.map(file => file.url.pathname).join(", ")}`);
    }
    const stagingRoot = resolveStagingRoot();
    const versionRoot = path.join(stagingRoot, `v${info.version}`);
    const stagingDirectory = path.join(versionRoot, "app");
    const archivePath = path.join(versionRoot, "payload.zip");
    await rm(versionRoot, { recursive: true, force: true });
    await mkdir(versionRoot, { recursive: true });

    this.write(`обновление ${info.version}: скачивание началось`);
    await downloadArchive({
      url: artifact.url.href,
      headers: normalizeHeaders(request.requestHeaders),
      destination: archivePath,
      isCancelled: () => request.cancellationToken?.cancelled === true,
      onProgress: (percent, transferred) => {
        this.emit("download-progress", {
          percent,
          transferred,
          total: 0,
          delta: 0,
          bytesPerSecond: 0,
        });
      },
    });

    const expected = artifact.info.sha512;
    if (expected != null && (await sha512Base64(archivePath)) !== expected) {
      throw new Error(`контрольная сумма архива ${info.version} не совпала`);
    }
    const report = await extractZipFile(archivePath, stagingDirectory);
    await rm(archivePath, { force: true });
    await writePendingMarker(stagingRoot, { version: info.version });
    this.staged = { version: info.version, stagingDirectory };
    this.write(
      `обновление ${info.version}: распаковано ${report.files} файлов, ${Math.round(report.bytes / 1048576)} МБ. `
      + "Установится при закрытии программы.",
    );
    this.dispatchUpdateDownloaded({ ...(info as UpdateInfo), downloadedFile: stagingDirectory });
    return [stagingDirectory];
  }

  quitAndInstall(): void {
    // Сюда попадать не должны: `autoInstallOnAppQuit` выключен, а ручной вызов
    // делает `installStagedUpdate`. Оставляю явную запись, чтобы «молчаливый»
    // вызов был виден в журнале, а не выглядел успешной установкой.
    this.write("quitAndInstall() вызван напрямую: установка идёт через обработчик закрытия программы");
  }
}

function normalizeHeaders(headers: Record<string, string | string[] | number | undefined> | null): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value == null) continue;
    result[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return result;
}

/**
 * Запуск установки. Отдельный процесс нужен потому, что в момент закрытия
 * программа держит открытыми собственный `.exe` и `resources\app.asar`.
 */
export function spawnApplyScript(input: {
  readonly staged: StagedUpdate;
  readonly appDirectory: string;
  readonly executableName: string;
  readonly processId: number;
  readonly logFile: string;
  readonly stagingRoot: string;
}): void {
  const scriptPath = path.join(input.stagingRoot, `apply-${input.staged.version}-${input.processId}.ps1`);
  writeFileSync(
    scriptPath,
    buildApplyScript({
      appDirectory: input.appDirectory,
      stagedDirectory: input.staged.stagingDirectory,
      executableName: input.executableName,
      processId: input.processId,
      logFile: input.logFile,
      version: input.staged.version,
    }),
    "utf8",
  );
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", scriptPath],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
}

/**
 * Точка входа. Вызывается из `main.ts` сразу после `whenReady`, параллельно
 * сбору сервисов. Все ошибки гасятся и пишутся в журнал: обновление не должно
 * уметь сломать запуск программы.
 */
export async function startAutomaticUpdates(input: AutomaticUpdateInput): Promise<void> {
  const logFile = path.join(resolveStagingRoot(input.env), LOG_NAME);
  const write = (message: string): void => {
    const line = `[db-bot-update] ${new Date().toISOString()} ${message}`;
    try {
      appendFileSync(logFile, `${line}\n`, "utf8");
    } catch {
      // Журнал — вспомогательное средство. Отсутствие записи не повод отказывать.
    }
  };
  try {
    await runAutomaticUpdates(input, write, logFile);
  } catch (error) {
    write(`автообновление не запустилось: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runAutomaticUpdates(
  input: AutomaticUpdateInput,
  write: (message: string) => void,
  logFile: string,
): Promise<void> {
  const { app, env, platform } = input;
  if (env.DB_BOT_AUTO_UPDATE === "0") {
    write("выключено переменной DB_BOT_AUTO_UPDATE=0");
    return;
  }
  if (platform !== "win32") {
    write(`платформа ${platform}: автообновление настроено только для Windows`);
    return;
  }
  if (!app.isPackaged) {
    write("запуск из исходников: обновления не проверяются");
    return;
  }

  const stagingRoot = resolveStagingRoot(env);
  await mkdir(stagingRoot, { recursive: true });
  const appDirectory = path.dirname(process.execPath);
  const executableName = path.basename(process.execPath);
  const updater = new DbBotFolderUpdater(write);

  const token = resolveGitHubToken(env);
  if (token != null) updater.addAuthHeader(token);

  updater.on("error", (error: Error) => write(`ошибка: ${error.message}`));
  updater.on("update-available", (info: UpdateInfo) => write(`доступна версия ${info.version}`));
  updater.on("update-not-available", () => write("новых версий нет"));
  updater.on(UPDATE_DOWNLOADED, (event: UpdateInfo) => write(`версия ${event.version} скачана`));

  // Незавершённая загрузка с прошлого раза ставится при ближайшем закрытии.
  const pending = await readPendingMarker(stagingRoot);
  if (pending != null) {
    const stagingDirectory = path.join(stagingRoot, `v${pending.version}`, "app");
    if (await directoryExists(stagingDirectory)) {
      updater.setStaged({ version: pending.version, stagingDirectory });
      write(`найдена неустановленная версия ${pending.version}: будет поставлена при закрытии`);
    } else {
      await rm(path.join(stagingRoot, `v${pending.version}`), { recursive: true, force: true });
      await rm(path.join(stagingRoot, PENDING_MARKER), { force: true });
    }
  }

  let installStarted = false;
  app.on("before-quit", () => {
    if (installStarted) return;
    const staged = updater.getStaged();
    if (staged == null) return;
    installStarted = true;
    write(`установка версии ${staged.version} при закрытии программы`);
    try {
      spawnApplyScript({
        staged,
        appDirectory,
        executableName,
        processId: process.pid,
        logFile,
        stagingRoot,
      });
    } catch (error) {
      write(`не удалось запустить установку: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  const check = async (): Promise<void> => {
    try {
      await updater.checkForUpdates();
    } catch (error) {
      write(`проверка не удалась: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const scheduleNext = (delay: number): void => {
    const timer = setTimeout(() => { void check().finally(() => scheduleNext(jitter(UPDATE_CHECK_INTERVAL_MS))); }, delay);
    // Проверка обновлений не должна удерживать процесс от выхода.
    timer.unref?.();
  };

  write(`проверка обновлений запущена, версия ${input.appVersion ?? "неизвестна"}, токен ${token == null ? "не задан" : "задан"}`);
  scheduleNext(INITIAL_UPDATE_CHECK_DELAY_MS + Math.floor(jitter(UPDATE_CHECK_JITTER_MS)));
}

async function directoryExists(target: string): Promise<boolean> {
  try {
    await readdir(target);
    return true;
  } catch {
    return false;
  }
}

/** Равномерный разброс: минус 10 % и плюс 10 % от интервала. */
function jitter(interval: number): number {
  const spread = Math.floor(interval * 0.1);
  return interval - spread + Math.floor(Math.random() * spread * 2);
}
