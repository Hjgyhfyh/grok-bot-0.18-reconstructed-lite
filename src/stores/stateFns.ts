import type { ProjectCard } from "../services/tauri";
import type { RuKey } from "../i18n/ru";
import { computeStatus } from "../core/scanner";

/**
 * Чистые функции состояния: модель ошибок-карточек, нормализация карточек
 * проектов, обрезка истории чата. Без invoke/DOM/React — годится для node:test.
 * Тексты ошибок здесь НЕ живут: UiError несёт только kind/code/action —
 * строки экраны берут из i18n по errorCardKeysFor().
 */

/** Карточки ошибок из copy-дока §7 — один kind на карточку. */
export type ErrorKind =
  | "no-key"
  | "network"
  | "auth"
  | "rate"
  | "server"
  | "timeout"
  | "folder-not-found"
  | "folder-denied"
  | "revert"
  | "empty"
  | "mic"
  | "generic";

/** Что делает главная кнопка карточки. */
export type ErrorAction = "retry" | "open-settings" | "pick-folder" | "none";

export interface UiError {
  kind: ErrorKind;
  /** Мелкий серый код (только 401/403/429/5xx — copy-док §7). */
  code?: string | null;
  action: ErrorAction;
}

const ERROR_ACTIONS: Record<ErrorKind, ErrorAction> = {
  "no-key": "open-settings",
  network: "retry",
  auth: "open-settings",
  rate: "retry",
  server: "retry",
  timeout: "retry",
  "folder-not-found": "pick-folder",
  "folder-denied": "pick-folder",
  revert: "retry",
  empty: "none",
  mic: "none",
  generic: "retry",
};

const ERROR_CARD_KEYS: Record<ErrorKind, { titleKey: RuKey; bodyKey: RuKey; actionKey: RuKey }> = {
  "no-key": { titleKey: "errNoKeyTitle", bodyKey: "errNoKeyBody", actionKey: "errNoKeyAction" },
  network: { titleKey: "errNetworkTitle", bodyKey: "errNetworkBody", actionKey: "retry" },
  auth: { titleKey: "errAuthTitle", bodyKey: "errAuthBody", actionKey: "errNoKeyAction" },
  rate: { titleKey: "errRateTitle", bodyKey: "errRateBody", actionKey: "retry" },
  server: { titleKey: "errServerTitle", bodyKey: "errServerBody", actionKey: "retry" },
  timeout: { titleKey: "errTimeoutTitle", bodyKey: "errTimeoutBody", actionKey: "retry" },
  "folder-not-found": { titleKey: "errFolderTitle", bodyKey: "errFolderBody", actionKey: "pickFolder" },
  "folder-denied": { titleKey: "errFolderDeniedTitle", bodyKey: "errFolderDeniedBody", actionKey: "pickOtherFolder" },
  revert: { titleKey: "errRevertTitle", bodyKey: "errRevertBody", actionKey: "retry" },
  empty: { titleKey: "errEmptyReplyTitle", bodyKey: "errEmptyReplyBody", actionKey: "dismiss" },
  mic: { titleKey: "errMicTitle", bodyKey: "errMicBody", actionKey: "dismiss" },
  generic: { titleKey: "errGenericTitle", bodyKey: "errGenericBody", actionKey: "retry" },
};

export function uiError(kind: ErrorKind, code?: string | number | null): UiError {
  return { kind, code: code == null ? null : String(code), action: ERROR_ACTIONS[kind] };
}

export function isUiError(v: unknown): v is UiError {
  if (typeof v !== "object" || v === null) return false;
  if (!("kind" in v) || !("action" in v)) return false;
  const kind = v.kind;
  return typeof kind === "string" && kind in ERROR_ACTIONS;
}

/** Триплет ключей словаря ru.ts для карточки ошибки. */
export function errorCardKeys(err: UiError): { titleKey: RuKey; bodyKey: RuKey; actionKey: RuKey } {
  return ERROR_CARD_KEYS[err.kind];
}

/** Вырезает секреты (API-ключ) из текста, который увидит пользователь. */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join("***");
  }
  return out;
}

/** kind из core/ai.ts (AiError.kind) → ErrorKind карточки. */
const AI_KIND_MAP: Record<string, ErrorKind> = {
  "missing-credential": "no-key",
  unauthorized: "auth",
  "rate-limit": "rate",
  upstream: "server",
  timeout: "timeout",
  "network-error": "network",
  "insecure-url": "generic",
  "invalid-response": "generic",
  "empty-reply": "empty",
  unknown: "generic",
};

/**
 * AiError из services/ai имеет shape {kind: AiErrorKind, status?} — ловим его
 * по форме (без instanceof: core/ai может жить в другом модульном графе).
 */
function uiFromAiShape(e: object): UiError | null {
  if (!("kind" in e)) return null;
  const kind = e.kind;
  if (typeof kind !== "string" || !(kind in AI_KIND_MAP)) return null;
  const status = "status" in e && typeof e.status === "number" ? e.status : null;
  return uiError(AI_KIND_MAP[kind], status);
}

/** Любой exception → UiError, без утечки ключа и stacktrace. */
export function errorFromException(e: unknown, apiKey?: string): UiError {
  if (isUiError(e)) return e;
  if (e && typeof e === "object") {
    const fromAi = uiFromAiShape(e);
    if (fromAi) return fromAi;
  }
  const raw = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  const msg = redactSecrets(raw, [apiKey]).toLowerCase();
  if (msg.includes("abort")) return uiError("generic");
  if (/timeout|timed out|stall|долго/.test(msg)) return uiError("timeout");
  if (/eacces|access denied|отказано в доступе|permission/.test(msg)) {
    return uiError("folder-denied");
  }
  if (/enoent|not found|не найден|не существует/.test(msg)) {
    return uiError("folder-not-found");
  }
  if (/failed to fetch|networkerror|econnrefused|econnreset|enotfound|fetch/.test(msg)) {
    return uiError("network");
  }
  return uiError("generic");
}

/** Ошибка invoke сканирования / ScanError.reason → folder-* карточки. */
export function classifyFolderError(e: unknown): UiError {
  if (typeof e === "string") {
    const s = e.toLowerCase();
    if (/not_found|not found|не найден|enoent/.test(s)) return uiError("folder-not-found");
    if (/denied|eacces|отказано/.test(s)) return uiError("folder-denied");
  }
  const err = errorFromException(e);
  if (err.kind === "generic") return err;
  if (err.kind === "folder-not-found" || err.kind === "folder-denied") return err;
  return err;
}

// ---------------------------------------------------------------------------
// Карточки проектов
// ---------------------------------------------------------------------------

/** Поля с провода могут прийти snake_case ИЛИ camelCase — нормализуем оба. */
function readNum(obj: Record<string, unknown>, snake: string, camel: string): number {
  const v = snake in obj ? obj[snake] : camel in obj ? obj[camel] : 0;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

const VALID_STATUS: Record<string, true> = {
  clean: true, dirty: true, stale: true, crashed: true,
};

/**
 * Wire-карточка из invoke → каноническая ProjectCard (snake_case поля,
 * last_activity в секундах) со статусом, перепроверенным computeStatus(core):
 * backend-статус сохраняет crashed/dirty, «stale» выводится по часам фронта.
 */
export function normalizeProjectCard(raw: unknown, nowMs: number): ProjectCard | null {
  if (typeof raw !== "object" || raw === null) return null;
  // Граница IPC: объект подтверждён, каждое поле ниже валидируется typeof'ом.
  const r = raw as Record<string, unknown>;
  const path = typeof r.path === "string" ? r.path : "";
  if (!path) return null;
  const name = typeof r.name === "string" && r.name ? r.name : path.split(/[\\/]/).pop() ?? path;
  const wireStatus = typeof r.status === "string" && r.status in VALID_STATUS ? r.status : "clean";
  const lastActivitySec = readNum(r, "last_activity", "lastActivity");
  const lastActivityMs = lastActivitySec > 1e12 ? lastActivitySec : lastActivitySec * 1000;
  const status = computeStatus(
    { hasErrorMarkers: wireStatus === "crashed", hasUnsavedChanges: false },
    wireStatus === "dirty" ? "dirty" : "clean",
    lastActivityMs,
    nowMs,
  );
  return {
    path,
    name,
    status,
    last_activity: Math.floor(lastActivityMs / 1000),
    file_count: readNum(r, "file_count", "fileCount"),
    is_git_repo:
      ("is_git_repo" in r ? r.is_git_repo : "isGitRepo" in r ? r.isGitRepo : false) === true,
  };
}

export function normalizeProjects(raw: unknown, nowMs: number): ProjectCard[] {
  if (!Array.isArray(raw)) return [];
  const out: ProjectCard[] = [];
  for (const item of raw) {
    const card = normalizeProjectCard(item, nowMs);
    if (card) out.push(card);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Чат
// ---------------------------------------------------------------------------

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  at: number;
}

export interface ChatMessageLike {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Бюджет истории в запросе (контекст проекта ~30k идёт отдельным user-msg). */
export const HISTORY_BUDGET_CHARS = 12_000;

/**
 * История под бюджет: с конца, пока влезает; стримящиеся/пустые не идут.
 */
export function trimHistory(
  messages: readonly UiMessage[],
  budget: number = HISTORY_BUDGET_CHARS,
): ChatMessageLike[] {
  const done = messages.filter((m) => !m.streaming && m.content.trim().length > 0);
  const picked: UiMessage[] = [];
  let used = 0;
  for (let i = done.length - 1; i >= 0; i--) {
    const len = done[i].content.length;
    if (used + len > budget && picked.length > 0) break;
    used += len;
    picked.unshift(done[i]);
  }
  return picked.map((m) => ({ role: m.role, content: m.content }));
}

/** Последний текст пользователя — для кнопки «Попробовать снова». */
export function lastUserText(messages: readonly UiMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && !m.streaming && m.content.trim()) return m.content;
  }
  return null;
}
