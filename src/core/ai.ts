/**
 * Чистое ядро AI-клиента (OpenAI-compatible / OmniRoute).
 *
 * Никаких fetch/DOM/invoke — только типы, построение запроса, парсинг SSE,
 * классификация и редактирование ошибок. Порты (fetch, clock) живут в
 * src/services/ai.ts; тесты под node:test инжектируют свои.
 */
import type { RuKey } from "../i18n/ru";

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Причина сбоя/отказа. Часть значений — результат классификации HTTP-ответа,
 * часть — ошибки до/после запроса (из референса: insecure-url, missing-credential,
 * network-error).
 */
export type AiErrorKind =
  | "unauthorized"       // 401/403 — ключ отклонён
  | "rate-limit"         // 429 / insufficient_quota — дневной лимит или перегруз
  | "upstream"           // 5xx — сервер/провайдер недоступен
  | "timeout"            // наш дедлайн или 408/504
  | "network-error"      // DNS/REFUSED/RESET/TLS — fetch бросил TypeError
  | "missing-credential" // ключ пуст
  | "insecure-url"       // http на не-loopback/не-LAN адрес, или адрес не парсится
  | "invalid-response"   // 200, но тело — не ожидаемый JSON/SSE
  | "empty-reply"        // стрим завершился без единой дельты
  | "unknown";

/** Типизированная ошибка клиента. UI показывает карточку по kind, не по message. */
export class AiError extends Error {
  readonly kind: AiErrorKind;
  /** HTTP-статус, если был ответ (мелкий серый код на карточке). */
  readonly status?: number;
  /** Сервер попросил подождать (Retry-After, мс, ≤30с). */
  readonly retryAfterMs?: number;
  readonly cause?: unknown;

  constructor(kind: AiErrorKind, message: string, opts?: { status?: number; retryAfterMs?: number; cause?: unknown }) {
    super(message);
    this.name = "AiError";
    this.kind = kind;
    this.status = opts?.status;
    this.retryAfterMs = opts?.retryAfterMs;
    this.cause = opts?.cause;
  }
}

// ---------------------------------------------------------------------------
// Построение запроса
// ---------------------------------------------------------------------------

export interface ChatBodyOptions {
  maxTokens?: number;
  stream?: boolean;
}

/** Тело POST /chat/completions. */
export function buildChatBody(
  model: string,
  messages: ChatMessage[],
  opts?: ChatBodyOptions,
): { model: string; messages: ChatMessage[]; max_tokens: number; stream: boolean } {
  return {
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: opts?.maxTokens ?? 2048,
    stream: opts?.stream ?? true,
  };
}

/**
 * Нормализует baseUrl: обрезает пробелы и хвостовые слэши, гарантирует путь /vN.
 * "127.0.0.1:20128" → "http://127.0.0.1:20128/v1"; ".../" → ".../v1" и т.п.
 * Бросает TypeError на непарсибельном вводе — ловить как insecure-url.
 */
export function normalizeBaseUrl(raw: string): string {
  let s = String(raw ?? "").trim();
  if (s === "") throw new TypeError("empty base url");
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) s = `http://${s}`;
  const u = new URL(s);
  // у special-схем pathname никогда не пустой: "" записывается как "/"
  const p = u.pathname.replace(/\/+$/, "");
  u.pathname = /\/v\d+$/i.test(p) ? p : `${p}/v1`;
  u.search = "";
  u.hash = "";
  return u.toString().replace(/\/+$/, "");
}

/**
 * Разрешён ли http:// для этого хоста: loopback (localhost/127.x/::1) или
 * приватный LAN (RFC1918, link-local, .local/.lan, имя без точек).
 * В lite сознательно разрешён http для приватных адресов, см. фичи-док §4.
 */
function isHttpAllowedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(h) ||
    /^10(?:\.\d{1,3}){3}$/.test(h) ||
    /^192\.168(?:\.\d{1,3}){2}$/.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(h) ||
    /^169\.254(?:\.\d{1,3}){2}$/.test(h) ||
    /^fe80:/.test(h) ||
    h.endsWith(".local") ||
    h.endsWith(".lan") ||
    h.endsWith(".internal") ||
    // имя без точек и не IPv6 — почти наверняка хост в локальной сети
    (h !== "" && !h.includes(".") && !h.includes(":"))
  );
}

/**
 * Проверка адреса сервера. https — всегда ок; http — только loopback/LAN.
 */
export function validateBaseUrl(raw: string): { ok: true; url: string } | { ok: false; reason: AiErrorKind } {
  let url: string;
  try {
    url = normalizeBaseUrl(raw);
  } catch {
    return { ok: false, reason: "insecure-url" };
  }
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return { ok: true, url };
    if (u.protocol === "http:" && isHttpAllowedHost(u.hostname)) return { ok: true, url };
    return { ok: false, reason: "insecure-url" };
  } catch {
    return { ok: false, reason: "insecure-url" };
  }
}

// ---------------------------------------------------------------------------
// Классификация ошибок
// ---------------------------------------------------------------------------

/**
 * HTTP-статус + тело → причина. Тело смотрим на характерные маркеры
 * OpenAI-ошибок (insufficient_quota, invalid_api_key и т.п.) — 400 с
 * «quota» это по сути rate-limit, 400 «api key» — unauthorized.
 */
export function classifyHttpError(status: number, body?: unknown): AiErrorKind {
  const text =
    body == null
      ? ""
      : typeof body === "string"
        ? body.toLowerCase()
        : (() => {
            try {
              return JSON.stringify(body).toLowerCase();
            } catch {
              return "";
            }
          })();

  const looksAuth =
    /invalid_api_key|incorrect api key|invalid (api )?key|unauthorized|authentication|access denied|доступ запрещ/.test(text);
  const looksQuota = /insufficient_quota|rate[_ -]?limit|too many requests|quota|лимит/.test(text);

  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429 || (status >= 400 && status < 500 && looksQuota)) return "rate-limit";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500 && status <= 599) return "upstream";
  if (status >= 400 && status < 500 && looksAuth) return "unauthorized";
  return "unknown";
}

/** Заголовок Retry-After: число секунд или HTTP-date. Мс или null. */
export function parseRetryAfter(value: string | null | undefined, nowMs = Date.now()): number | null {
  if (value == null || value === "") return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const ts = Date.parse(value);
  if (Number.isFinite(ts)) return Math.max(0, ts - nowMs);
  return null;
}

const RETRYABLE_KINDS: Record<AiErrorKind, true | undefined> = {
  "rate-limit": true,
  upstream: true,
  timeout: true,
  "network-error": true,
  "empty-reply": true,
  unknown: true,
  unauthorized: undefined,
  "missing-credential": undefined,
  "insecure-url": undefined,
  "invalid-response": undefined,
};

/**
 * Стоит ли повторить. `attempt` — число УЖЕ провалившихся попыток (0..);
 * повторяем пока attempt < 3 (итого максимум 4 обращения к сети).
 * Пользовательский AbortError — никогда.
 */
export function shouldRetry(err: unknown, attempt: number): boolean {
  if (attempt >= 3) return false;
  if (isAbortError(err)) return false;
  if (err instanceof AiError) {
    if (err.status != null && [401, 403, 404, 422].includes(err.status)) return false;
    return RETRYABLE_KINDS[err.kind] === true;
  }
  // Чужая ошибка (TypeError fetch и т.п.) — считаем сетевой, пробуем ещё.
  return true;
}

const BACKOFF_TABLE = [1000, 3000, 8000] as const;
const RETRY_AFTER_CAP_MS = 30_000;

/** Пауза перед повтором: 1с / 3с / 8с. Retry-After сервера чтим (потолок 30с). */
export function backoffMs(attempt: number, retryAfterMs?: number | null): number {
  const base = BACKOFF_TABLE[Math.min(Math.max(0, attempt), BACKOFF_TABLE.length - 1)];
  if (retryAfterMs != null && retryAfterMs > 0) {
    return Math.max(base, Math.min(retryAfterMs, RETRY_AFTER_CAP_MS));
  }
  return base;
}

/** Пользовательская отмена? (проверяем name — среда может быть не браузер). */
export function isAbortError(err: unknown): boolean {
  if (err instanceof AiError) return false;
  if (!err || typeof err !== "object" || !("name" in err)) return false;
  const name = err.name;
  return name === "AbortError" || name === "TimeoutError";
}

/** Вырезает API-ключ из текста ошибки/тела ответа перед показом пользователю. */
export function redactKey(text: string | null | undefined, key: string | null | undefined): string {
  const s = String(text ?? "");
  if (!key || key.length < 4) return s;
  let out = s.split(key).join("***");
  try {
    const enc = encodeURIComponent(key);
    if (enc !== key && enc.length >= 4) out = out.split(enc).join("***");
  } catch {
    /* encodeURIComponent не должен падать — страховка */
  }
  return out;
}

// ---------------------------------------------------------------------------
// SSE-парсер
// ---------------------------------------------------------------------------

export type SseChunk = string | Uint8Array | ArrayBuffer | ArrayBufferView;

/**
 * Инкрементальный парсер SSE-стрима OpenAI. Терпим к обрывам на любой границе
 * (байт, строка, multi-byte UTF-8): незавершённый хвост хранится до следующего
 * feed() или finish().
 *
 *   const p = createSseParser();
 *   for (const chunk of chunks) deltas.push(...p.feed(chunk));
 *   deltas.push(...p.finish());
 */
export interface SseParser {
  feed(chunk: SseChunk): string[];
  /** Завершить поток: сбросить декодер и добить последнюю строку без \n. */
  finish(): string[];
}

interface ChatChunkChoice {
  delta?: { content?: unknown; reasoning_content?: unknown };
  message?: { content?: unknown };
}

function extractDelta(jsonText: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null; // битая data-строка — пропускаем, не падаем
  }
  if (!data || typeof data !== "object" || !("choices" in data)) return null;
  const choices = data.choices;
  if (!Array.isArray(choices)) return null;
  let out = "";
  for (const raw of choices) {
    if (!raw || typeof raw !== "object") continue;
    const ch = raw as ChatChunkChoice;
    if (typeof ch.delta?.content === "string") out += ch.delta.content;
    // ответ без стрима, пришедший в SSE-обёртке
    if (typeof ch.message?.content === "string") out += ch.message.content;
  }
  return out === "" ? null : out;
}

export function createSseParser(): SseParser {
  const decoder = new TextDecoder("utf-8");
  let tail = ""; // незавершённая строка
  let dataLines: string[] = []; // data-строки текущего события
  let terminated = false; // получили [DONE]

  function dispatch(out: string[]): void {
    if (dataLines.length === 0) return;
    const lines = dataLines;
    dataLines = [];
    if (terminated) return;
    const payload = lines.join("\n");
    if (payload.trim() === "[DONE]") {
      terminated = true;
      return;
    }
    const d = extractDelta(payload);
    if (d != null) {
      out.push(d);
      return;
    }
    // Проставщик забыл пустые строки между событиями: по спеке data-строки
    // склеиваются в одно поле, но для OpenAI-потока каждая строка — свой JSON.
    // Склеенный JSON не распарсился → пробуем каждую строку отдельно.
    for (const l of lines) {
      if (l.trim() === "[DONE]") {
        terminated = true;
        return;
      }
      const dl = extractDelta(l);
      if (dl != null) out.push(dl);
    }
  }

  function line(rawLine: string, out: string[]): void {
    if (rawLine === "") {
      dispatch(out);
      return;
    }
    if (rawLine.startsWith(":")) return; // комментарий/keepalive
    const colon = rawLine.indexOf(":");
    if (colon < 0) return; // поле без значения — игнорим
    const field = rawLine.slice(0, colon);
    let value = rawLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    // event:/id:/retry: игнорируем
  }

  function feed(chunk: SseChunk): string[] {
    let text: string;
    if (typeof chunk === "string") {
      text = chunk;
    } else {
      const bytes =
        chunk instanceof ArrayBuffer
          ? new Uint8Array(chunk)
          : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      text = decoder.decode(bytes, { stream: true });
    }
    const buf = tail + text;
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === "\n") {
        let l = buf.slice(start, i);
        if (l.endsWith("\r")) l = l.slice(0, -1);
        line(l, out);
        start = i + 1;
      }
    }
    tail = buf.slice(start);
    return out;
  }

  function finish(): string[] {
    const out: string[] = [];
    const flushed = decoder.decode();
    if (flushed) tail += flushed;
    if (tail !== "") {
      let l = tail;
      if (l.endsWith("\r")) l = l.slice(0, -1);
      tail = "";
      line(l, out);
    }
    dispatch(out); // поток оборвался без завершающей пустой строки
    return out;
  }

  return { feed, finish };
}

/**
 * Одношаговый разбор чанка для простых случаев: создаёт парсер, кормит чанк
 * и добивает хвост. Для потока из нескольких чанков используйте createSseParser —
 * иначе строка, разрезанная между чанками, потеряется.
 */
export function parseSseChunk(chunk: SseChunk): string[] {
  const p = createSseParser();
  const out = p.feed(chunk);
  out.push(...p.finish());
  return out;
}

// ---------------------------------------------------------------------------
// Карточка ошибки → ключи словаря ru.ts
// ---------------------------------------------------------------------------

export interface ErrorCardKeys {
  titleKey: RuKey;
  bodyKey: RuKey;
  /** Ключ кнопки действия. */
  actionKey: RuKey;
  /** Мелкий серый код (только 401/403/429/5xx — см. copy-док). */
  code?: number;
}

const SMALL_CODE_STATUSES: Record<number, true | undefined> = {
  401: true,
  403: true,
  429: true,
  500: true,
  501: true,
  502: true,
  503: true,
  504: true,
  505: true,
};

/**
 * kind → какая карточка из copy-дока. Возвращает КЛЮЧИ ru.ts —
 * строки резолвятся через t() на уровне экрана (core остаётся чистым).
 */
export function errorCardFor(err: unknown): ErrorCardKeys {
  const kind: AiErrorKind = err instanceof AiError ? err.kind : "network-error";
  const status = err instanceof AiError ? err.status : undefined;
  const code = status != null && SMALL_CODE_STATUSES[status] === true ? status : undefined;
  switch (kind) {
    case "missing-credential":
      return { titleKey: "errNoKeyTitle", bodyKey: "errNoKeyBody", actionKey: "errNoKeyAction" };
    case "unauthorized":
      return { titleKey: "errAuthTitle", bodyKey: "errAuthBody", actionKey: "errNoKeyAction", code };
    case "rate-limit":
      return { titleKey: "errRateTitle", bodyKey: "errRateBody", actionKey: "retry", code };
    case "upstream":
      return { titleKey: "errServerTitle", bodyKey: "errServerBody", actionKey: "retry", code };
    case "timeout":
      return { titleKey: "errTimeoutTitle", bodyKey: "errTimeoutBody", actionKey: "retry" };
    case "empty-reply":
      return { titleKey: "errEmptyReplyTitle", bodyKey: "errEmptyReplyBody", actionKey: "dismiss" };
    case "network-error":
    case "insecure-url":
      return { titleKey: "errNetworkTitle", bodyKey: "errNetworkBody", actionKey: "retry" };
    case "invalid-response":
    case "unknown":
    default:
      return { titleKey: "errGenericTitle", bodyKey: "errGenericBody", actionKey: "retry", code };
  }
}
