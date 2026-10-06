/**
 * Ключ локального шлюза, который программа поднимает сама.
 *
 * Откуда взялось это решение. Раньше ключ приходил из
 * `scripts/start-grokbot.ps1`: лаунчер генерировал токен, клал его в
 * `launcher-gateway-token.txt` и выставлял `SAND_GATEWAY_TOKEN` и
 * `SAND_HOST_GATEWAY_TOKEN`. Лаунчера в поставке нет, а заведующая
 * библиотекой PowerShell не запускает, поэтому переменная окружения оставалась
 * пустой, и весь путь до ответа модели обрывался.
 *
 * Здесь то же поведение перенесено внутрь приложения:
 *   * 32 байта из `crypto.randomBytes` — тот же источник, что у лаунчера
 *     (`RandomNumberGenerator` поверх системного CSPRNG);
 *   * base64url — значение переживает заголовок `Authorization` без изменений;
 *   * токен читается, а не выдумывается, при каждом старте, поэтому перезапуск
 *     не оставляет программу с ключом, который никто не принимает;
 *   * значение никогда не попадает в журнал, в сообщение пользователю и в
 *     строку запуска: наружу уходят только длина и признак «создан заново».
 *
 * Права на файл — те же, что у лаунчера: только текущий пользователь, SYSTEM и
 * администраторы, наследование выключено. Один bearer-токен открывает ~124
 * команды шлюза, включая `setBoxSecrets` и `deleteAgents`, поэтому «файл виден
 * всем пользователям компьютера» здесь недопустимо.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Имя файла в корне данных. Лаунчер писал `launcher-gateway-token.txt`; здесь своё. */
export const LOCAL_GATEWAY_TOKEN_FILENAME = "db-bot-gateway-token.txt";
/** 32 байта в base64url дают ровно 43 символа. */
export const LOCAL_GATEWAY_TOKEN_BYTES = 32;
/**
 * Всё, что короче, — обрезанный или дописанный руками файл. Принимать такое
 * значение как ключ бессмысленно: следующий запрос получит 401, и виноват будет
 * файл, а не сеть. Порог взят у лаунчера.
 */
export const LOCAL_GATEWAY_TOKEN_MIN_LENGTH = 32;
/** SID текущего пользователя, SYSTEM и администраторов — как в лаунчере. */
export const LOCAL_GATEWAY_ALLOWED_SIDS = Object.freeze(["S-1-5-18", "S-1-5-32-544"] as const);

/** Свежий ключ. Никогда не пишется в исходники и не печатается. */
export function newLocalGatewayToken(): string {
  return randomBytes(LOCAL_GATEWAY_TOKEN_BYTES).toString("base64url");
}

export function isUsableGatewayToken(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length >= LOCAL_GATEWAY_TOKEN_MIN_LENGTH;
}

/** Читает сохранённый ключ. Любая неудача — «ключа нет», а не исключение. */
export function readStoredGatewayToken(path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const value = raw.replace(/^\uFEFF/, "").trim();
  return isUsableGatewayToken(value) ? value : null;
}

/** SID текущего пользователя. `whoami` — базовая программа Windows, дешевле PowerShell. */
export function readCurrentUserSid(readText: (command: string, args: readonly string[]) => string): string | null {
  let output: string;
  try {
    output = readText("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
  } catch {
    return null;
  }
  const match = /"S-1-\d+(?:-\d+)+"/.exec(output);
  return match?.[0].replace(/"/g, "") ?? null;
}

export interface RestrictSecretFileOptions {
  readonly platform?: NodeJS.Platform;
  readonly currentSid?: string | null;
  readonly run?: (command: string, args: readonly string[]) => void;
}

/**
 * Оставляет файлу права «только я, SYSTEM, администраторы», наследование off.
 *
 * Лучшее усилие, а не гарантия: отказ сузить права не должен помешать запуску
 * программы, потому что отказ от запуска хуже широких прав на файле, у которых
 * и так есть свои права. Поэтому исключение глотается, а вызывающий получает
 * `false`.
 */
export function restrictSecretFileToCurrentUser(
  path: string,
  options: RestrictSecretFileOptions = {},
): boolean {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    try {
      chmodSync(path, 0o600);
      return true;
    } catch {
      return false;
    }
  }
  const run = options.run ?? ((command: string, args: readonly string[]): void => {
    execFileSync(command, [...args], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
  });
  try {
    const sid = options.currentSid ?? readCurrentUserSid((command, args) => runWithCapture(command, args));
    if (sid == null) return false;
    const grants = [sid, ...LOCAL_GATEWAY_ALLOWED_SIDS].map(value => `*${value}:(F)`);
    run("icacls.exe", [path, "/inheritance:r", "/grant:r", ...grants]);
    return true;
  } catch {
    return false;
  }
}

function runWithCapture(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
}

export interface ResolvedLocalGatewayToken {
  readonly token: string;
  readonly path: string;
  /** `true` — ключ только что создан. В журнал попадает этот флаг, а не значение. */
  readonly created: boolean;
  /** `false` — права сузить не удалось. Это не повод отказывать в запуске. */
  readonly aclRestricted: boolean;
}

export interface ResolveLocalGatewayTokenOptions {
  readonly platform?: NodeJS.Platform;
  readonly currentSid?: string | null;
  readonly run?: (command: string, args: readonly string[]) => void;
}

/**
 * Ключ для текущего корня данных: сохранённый, если он пригоден, иначе новый.
 *
 * Создание идёт через `flag: "wx"`: два экземпляра, стартовавшие одновременно,
 * не перетирают ключ друг друга — побеждает тот, кто записал первым, и оба
 * затем читают один и тот же файл.
 */
export function resolveLocalGatewayToken(
  root: string,
  options: ResolveLocalGatewayTokenOptions = {},
): ResolvedLocalGatewayToken {
  const path = join(root, LOCAL_GATEWAY_TOKEN_FILENAME);
  const stored = readStoredGatewayToken(path);
  if (stored != null) {
    const aclRestricted = restrictSecretFileToCurrentUser(path, {
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.currentSid === undefined ? {} : { currentSid: options.currentSid }),
      ...(options.run === undefined ? {} : { run: options.run }),
    });
    return { token: stored, path, created: false, aclRestricted };
  }
  const token = newLocalGatewayToken();
  mkdirSync(dirname(path), { recursive: true });
  const writeOnce = (value: string): boolean => {
    try {
      writeFileSync(path, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  };
  if (!writeOnce(token)) {
    // Файл появился между чтением и записью: это ключ параллельного экземпляра.
    const raced = readStoredGatewayToken(path);
    if (raced == null) throw new Error(`Не удалось сохранить ключ локального шлюза: ${path}`);
    return {
      token: raced,
      path,
      created: false,
      aclRestricted: restrictSecretFileToCurrentUser(path, {
        ...(options.platform === undefined ? {} : { platform: options.platform }),
        ...(options.currentSid === undefined ? {} : { currentSid: options.currentSid }),
        ...(options.run === undefined ? {} : { run: options.run }),
      }),
    };
  }
  const aclRestricted = restrictSecretFileToCurrentUser(path, {
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.currentSid === undefined ? {} : { currentSid: options.currentSid }),
    ...(options.run === undefined ? {} : { run: options.run }),
  });
  return { token, path, created: true, aclRestricted };
}