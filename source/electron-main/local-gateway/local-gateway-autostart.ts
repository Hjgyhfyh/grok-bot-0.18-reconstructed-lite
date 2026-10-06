/**
 * Локальный шлюз, который программа поднимает сама.
 *
 * Задача: приложение обязано полностью работать после двойного клика по
 * `DB Bot.exe`. Раньше это требовало `scripts/start-grokbot.ps1`, который
 * поднимал `host-main.cjs`, выбирал порт, генерировал токен и выставлял
 * `SAND_HOST_GATEWAY_URL` / `SAND_HOST_GATEWAY_TOKEN` в окружении. Лаунчера в
 * поставке нет, поэтому переменная была пустой, и
 * `production-account-authorization.ts` строил `descriptorKey(new URL(""))`.
 *
 * Здесь то же самое, но внутри главного процесса Electron и до того, как
 * сервисы прочитают переменную. Порядок, ради которого всё и затевалось:
 *
 *   1. `startElectronMain` — `bootstrapBeforeSingleInstance`/`bootstrapAfterSingleInstance`
 *      решают, где лежит корень данных, и кладут его в `SAND_DATA_ROOT`.
 *   2. `initializeServices` — ПЕРВЫМ шагом вызывает `ensureLocalGateway`.
 *   3. Дальше читают переменную: `createRemoteHostConnector` (строка 639),
 *      `wrapRemoteHostConnectorWithDevBoxPlane`, `createProductionAccountAuthorization`
 *      и, наконец, форк координатора, который наследует `process.env`.
 *
 * Шлюз живёт вместе с окном и умирает вместе с программой. На 8 ГБ это важно:
 * висящий `host-main.cjs` тянет за собой SQLite и демон выполнения команд.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { getGatewayDiscoveryPath, getSandRootDir } from "../../host/host-paths.js";
import { isGatewayDiscoveryInfo } from "../../host/host-discovery.js";
import { resolveLocalGatewayToken } from "./local-gateway-token.js";

/** Куда главный процесс и координатор смотрят за шлюзом. */
export const LOCAL_GATEWAY_URL_ENV = "SAND_HOST_GATEWAY_URL";
export const LOCAL_GATEWAY_TOKEN_ENV = "SAND_HOST_GATEWAY_TOKEN";
export const HOST_BIND_ENV = "SAND_GATEWAY_BIND_HOST";
export const HOST_AUTH_TOKEN_ENV = "SAND_GATEWAY_TOKEN";
export const LOCAL_GATEWAY_HOST_LOG_FILENAME = "host.log";
/** Сколько ждём, пока хост поднимет шлюз. Машина пользователя слабая — запас большой. */
export const LOCAL_GATEWAY_START_TIMEOUT_MS = 120_000;
export const LOCAL_GATEWAY_POLL_MS = 250;
export const LOCAL_GATEWAY_STOP_TIMEOUT_MS = 8_000;

/**
 * `dist/electron-main/main.cjs` лежит рядом с `dist/host/host-main.cjs`.
 * Путь внутри `app.asar` остаётся настоящим путём: Electron читает архив
 * прозрачно, и `statSync`/`access` по нему отвечают.
 */
export function resolveLocalHostEntryPath(moduleDir: string): string {
  return join(moduleDir, "..", "host", "host-main.cjs");
}

export interface LocalGatewayHandle {
  readonly url: string;
  /** Ключ наружу не отдаётся: подписчику он не нужен, а в журнале ему не место. */
  readonly adopted: boolean;
  readonly pid: number | undefined;
  stop(): Promise<void>;
}

export class LocalGatewayStartupError extends Error {
  constructor(readonly logPath: string, message: string) {
    super(message);
    this.name = "LocalGatewayStartupError";
  }
}

export interface EnsureLocalGatewayOptions {
  readonly moduleDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly rootDir?: string;
  readonly startTimeoutMs?: number;
  readonly now?: () => number;
  readonly delay?: (ms: number) => Promise<void>;
  readonly probeHealth?: (url: string) => Promise<boolean>;
  readonly spawnHost?: (entryPath: string, options: { readonly env: NodeJS.ProcessEnv; readonly cwd: string; readonly logPath: string }) => ChildProcess;
  readonly killTree?: (pid: number) => void;
}

function defaultProbeHealth(url: string): Promise<boolean> {
  return fetch(`${url}/health`, { signal: AbortSignal.timeout(3_000) })
    .then(response => response.ok)
    .catch(() => false);
}

function defaultSpawnHost(
  entryPath: string,
  options: { readonly env: NodeJS.ProcessEnv; readonly cwd: string; readonly logPath: string },
): ChildProcess {
  return spawn(process.execPath, [entryPath], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function defaultKillTree(pid: number): void {
  // `/T` обязателен: хост запускает демон выполнения команд своим процессом, и
  // убийство только родителя оставило бы `box-exec-daemon/main.cjs` висеть и
  // держать папку помощника.
  execFileKill(pid);
}

function execFileKill(pid: number): void {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  try {
    execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10_000,
    });
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Процесс уже мёртв: останавливать нечего.
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPublishedGateway(path: string): { port: number; pid: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!isGatewayDiscoveryInfo(parsed)) return null;
  return { port: parsed.port, pid: parsed.pid };
}

/** Последние строки журнала хоста: в сообщении пользователю нужна причина, а не «ошибка». */
export function readHostLogTail(path: string, lines = 12): string {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  return raw.split(/\r?\n/).filter(entry => entry.trim().length > 0).slice(-lines).join("\n").slice(-2_000);
}

/**
 * Поднимает локальный шлюз и выставляет переменные окружения.
 *
 * Возвращает `adopted: true`, если шлюз уже поднят кем-то ещё (лаунчер, второй
 * экземпляр) — тогда переменная берётся из окружения как есть, а `stop()` ничего
 * не делает: чужой процесс не наш.
 */
export async function ensureLocalGateway(
  options: EnsureLocalGatewayOptions,
): Promise<LocalGatewayHandle> {
  const env = options.env ?? process.env;
  const root = options.rootDir ?? getSandRootDir();
  const logPath = join(root, LOCAL_GATEWAY_HOST_LOG_FILENAME);
  const now = options.now ?? (() => Date.now());
  const delay = options.delay ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const probeHealth = options.probeHealth ?? defaultProbeHealth;

  const configured = env[LOCAL_GATEWAY_URL_ENV]?.trim();
  if (configured != null && configured.length > 0) {
    // Кто-то уже настроил адрес: лаунчер или разработчик. Молча перебивать его
    // своим процессом нельзя, но и молча мимо пройти нельзя — если по этому
    // адресу никто не отвечает, пользователь увидит «не связаться с компьютером».
    const alive = await probeHealth(configured);
    if (alive) {
      return {
        url: configured,
        adopted: true,
        pid: undefined,
        stop: async () => {},
      };
    }
    throw new LocalGatewayStartupError(
      logPath,
      `В переменной ${LOCAL_GATEWAY_URL_ENV} указан адрес ${configured}, но по нему никто не отвечает.`,
    );
  }

  const entryPath = resolveLocalHostEntryPath(options.moduleDir);
  mkdirSync(root, { recursive: true });
  const spawnHost = options.spawnHost ?? defaultSpawnHost;
  const killTree = options.killTree ?? defaultKillTree;

  const secret = resolveLocalGatewayToken(root, {
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });
  appendFileSync(
    logPath,
    `[запуск] локальный шлюз: точка входа=${entryPath}, корень данных=${root}, ` +
      `ключ ${secret.created ? "создан заново" : "взят сохранённый"}, права файла ${secret.aclRestricted ? "сужены" : "оставлены как были"}\n`,
    "utf8",
  );

  // `gateway.json` пишет хост. Запись мёртвого процесса только сбила бы ожидание.
  const discoveryPath = options.rootDir === undefined ? getGatewayDiscoveryPath() : join(root, "gateway.json");
  const published = readPublishedGateway(discoveryPath);
  if (published != null && !isProcessAlive(published.pid)) {
    try {
      rmSync(discoveryPath, { force: true });
    } catch {
      // Не удалось убрать: хост перезапишет файл сам, ожидание идёт по pid.
    }
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    // `process.execPath` уElectron — это `DB Bot.exe`. Без этой переменной
    // запустился бы второй Electron вместо Node, и хост молча не поднялся бы.
    ELECTRON_RUN_AS_NODE: "1",
    [HOST_BIND_ENV]: "127.0.0.1",
    [HOST_AUTH_TOKEN_ENV]: secret.token,
    // Хост наследует `SAND_DATA_ROOT`/`SAND_USER_DATA_DIR`, которые startup уже
    // settlement-нул: свой корень у него не нужен и был бы вторым источником правды.
    SAND_DISABLE_TELEMETRY: "1",
    SAND_DISABLE_ANALYTICS: "1",
    SAND_DISABLE_SENTRY: "1",
    SAND_CONVERSATION_GC: "1",
    SAND_RETIRE_LEGACY_STORE_BLOBS: "1",
  };
  delete childEnv[LOCAL_GATEWAY_URL_ENV];
  delete childEnv[LOCAL_GATEWAY_TOKEN_ENV];

  const child = spawnHost(entryPath, { env: childEnv, cwd: root, logPath });
  const pid = child.pid;
  const writeToLog = (prefix: string) => (chunk: unknown): void => {
    try {
      appendFileSync(logPath, prefix + String(chunk), "utf8");
    } catch {
      // Журнал удобен, но не обязателен: его отсутствие не должно ронять запуск.
    }
  };
  child.stdout?.on("data", writeToLog(""));
  child.stderr?.on("data", writeToLog("[ошибка] "));
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.once("exit", (code, signal) => {
    exit = { code, signal };
    appendFileSync(logPath, `[запуск] локальный шлюз завершился: код=${code} сигнал=${signal}\n`, "utf8");
  });
  child.once("error", error => {
    exit = { code: null, signal: null };
    appendFileSync(logPath, `[запуск] локальный шлюз не запустился: ${String(error)}\n`, "utf8");
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (pid === undefined) return;
    if (exit != null) return;
    killTree(pid);
    const deadline = now() + LOCAL_GATEWAY_STOP_TIMEOUT_MS;
    while (now() < deadline && exit == null) await delay(100);
    try {
      rmSync(discoveryPath, { force: true });
    } catch {
      // Файл уберёт следующий запуск.
    }
  };
  // Страховка на выход процесса: `before-quit` не успевает при жёстком закрытии.
  process.once("exit", () => {
    if (pid !== undefined && exit == null) killTree(pid);
  });

  const deadline = now() + (options.startTimeoutMs ?? LOCAL_GATEWAY_START_TIMEOUT_MS);
  let url: string | null = null;
  while (now() < deadline) {
    if (exit != null) {
      throw new LocalGatewayStartupError(
        logPath,
        `Локальный шлюз завершился, не начав работу (код ${exit.code}). ${readHostLogTail(logPath)}`.trim(),
      );
    }
    const gateway = readPublishedGateway(discoveryPath);
    if (gateway != null && (pid === undefined || gateway.pid === pid)) {
      const candidate = `http://127.0.0.1:${gateway.port}`;
      if (await probeHealth(candidate)) {
        url = candidate;
        break;
      }
    }
    await delay(LOCAL_GATEWAY_POLL_MS);
  }
  if (url == null) {
    await stop();
    throw new LocalGatewayStartupError(
      logPath,
      `Локальный шлюз не ответил за отведённое время. ${readHostLogTail(logPath)}`.trim(),
    );
  }

  // Секрет кладётся в окружение ПОСЛЕ того, как шлюз признан живым, и до того,
  // как его прочитает первый потребитель в `initializeServices`.
  env[LOCAL_GATEWAY_URL_ENV] = url;
  env[LOCAL_GATEWAY_TOKEN_ENV] = secret.token;
  appendFileSync(logPath, `[запуск] локальный шлюз готов: ${url}, pid=${pid}\n`, "utf8");
  return { url, adopted: false, pid, stop };
}

/**
 * Что сказать пользователю, когда шлюз не поднялся.
 *
 * Молчаливый отказ здесь стоил больше всего: без текста «не удалось связаться с
 * компьютером» и вечного `Reconnecting` нельзя понять, что делать. Поэтому
 * сообщение называет причину, место, где лежит журнал, и два конкретных шага.
 */
export function describeLocalGatewayStartupFailure(error: unknown): { title: string; body: string } {
  const logPath = error instanceof LocalGatewayStartupError ? error.logPath : join(getSandRootDir(), LOCAL_GATEWAY_HOST_LOG_FILENAME);
  const detail = error instanceof Error ? error.message : String(error);
  return {
    title: "DB Bot не смог запустить помощника",
    body: [
      "Помощник работает на этом же компьютере, но программа не смогла его запустить.",
      "",
      `Причина: ${detail}`,
      "",
      "Что можно сделать:",
      "1. Закройте программу и откройте её снова — чаще всего этого достаточно.",
      "2. Если не помогло, перезагрузите компьютер и снова откройте DB Bot.",
      "",
      `Подробности записаны в файл: ${logPath}`,
      "",
      "Если повторяется, скажите об этом тому, кто устанавливал программу, и передайте этот файл.",
    ].join("\n"),
  };
}

export interface BootstrapLocalGatewayResult {
  readonly handle: LocalGatewayHandle | null;
  readonly error: unknown;
}

/**
 * Обёртка для места вызова: поднимает шлюз, а при отказе показывает понятное
 * окно и НЕ роняет запуск.
 *
 * Окно показывается только в упакованной сборке: разработчику с исходниками
 * достаточно строки в консоли, а пользователю, который запустил `DB Bot.exe`
 * двойным кликом, окно — единственный способ узнать, что произошло. После окна
 * программа всё равно доходит до окна интерфейса: так пользователь может открыть
 * настройки, а не смотреть на пустой экран.
 */
export async function bootstrapLocalGatewayForDesktop(
  options: EnsureLocalGatewayOptions & {
    readonly isPackaged: boolean;
    readonly reportFailure?: (leg: string, error: unknown) => void;
    readonly showError?: (title: string, body: string) => void;
  },
): Promise<BootstrapLocalGatewayResult> {
  const showError = options.showError ?? ((title: string, body: string) => {
    try {
      const { dialog } = require("electron") as typeof import("electron");
      dialog.showErrorBox(title, body);
    } catch {
      // Без Electron (тест, отладка) сообщение уходит в консоль ниже.
    }
  });
  try {
    const handle = await ensureLocalGateway(options);
    console.log(`[db-bot] локальный шлюз поднят: ${handle.url}${handle.adopted ? " (уже был запущен)" : ""}`);
    return { handle, error: null };
  } catch (error) {
    const described = describeLocalGatewayStartupFailure(error);
    // В журнал уходит причина и путь, но НЕ ключ: он туда не попадает.
    console.error(`[db-bot] ${described.title}\n${described.body}`);
    options.reportFailure?.("start", error);
    if (options.isPackaged) showError(described.title, described.body);
    return { handle: null, error };
  }
}