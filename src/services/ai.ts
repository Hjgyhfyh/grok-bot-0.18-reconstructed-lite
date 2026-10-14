import { AI_API_KEY, AI_BASE_URL, AI_MODEL } from "../config";
import {
  AiError,
  backoffMs,
  buildChatBody,
  classifyHttpError,
  createSseParser,
  errorCardFor,
  isAbortError,
  parseRetryAfter,
  redactKey,
  shouldRetry,
  validateBaseUrl,
} from "../core/ai";
import type { ChatMessage } from "../core/ai";

export type { ChatMessage };
export { AiError, errorCardFor, isAbortError };
export type { AiErrorKind, ErrorCardKeys, SseParser } from "../core/ai";

/**
 * Тонкий адаптер над src/core/ai.ts: fetch, таймауты, ретраи.
 * Вся логика разбора/классификации — в core; здесь только порты.
 */

// Promise.withResolvers — ES2024; наша lib ES2020 его не знает, объявляем сами.
// Рантаймы (Chromium 119+/WebView2, Node 22 в тестах) поддерживают.
declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    };
  }
}

// ---------------------------------------------------------------------------
// Настройки
// ---------------------------------------------------------------------------

export interface AiSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const BUILT_IN: AiSettings = { baseUrl: AI_BASE_URL, apiKey: AI_API_KEY, model: AI_MODEL };

// CONTRACT: StoresHooks владеет stores/settingsStore. Пока она живого стора не
// отдала, читаем дефолты из config.ts; стор регистрирует себя через
// setAiSettingsProvider(() => ({ apiKey, baseUrl, model })) — поля могут быть
// частичными, недостающие добираем из BUILT_IN.
let settingsProvider: (() => Partial<AiSettings>) | null = null;

export function setAiSettingsProvider(provider: (() => Partial<AiSettings>) | null): void {
  settingsProvider = provider;
}

/** Текущие настройки: пользовательские поверх зашитых дефолтов. */
export function getAiSettings(overrides?: Partial<AiSettings>): AiSettings {
  const fromStore = settingsProvider?.() ?? {};
  return {
    baseUrl: overrides?.baseUrl ?? fromStore.baseUrl ?? BUILT_IN.baseUrl,
    apiKey: overrides?.apiKey ?? fromStore.apiKey ?? BUILT_IN.apiKey,
    model: overrides?.model ?? fromStore.model ?? BUILT_IN.model,
  };
}

// ---------------------------------------------------------------------------
// Abort helpers
// ---------------------------------------------------------------------------

interface BoundSignal {
  signal: AbortSignal;
  timedOut: () => boolean;
  done: () => void;
}

function abortError(): Error {
  const e = new Error("Aborted");
  e.name = "AbortError";
  return e;
}

/** Объединяет внешний signal и таймаут timeoutMs в один AbortSignal. */
function bindSignal(user: AbortSignal | undefined, timeoutMs: number): BoundSignal {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(abortError()), timeoutMs);
  let timedOut = false;
  const mark = () => {
    timedOut = true;
  };
  ctl.signal.addEventListener(
    "abort",
    () => {
      // отличить наш таймаут от пользовательской отмены: таймер сработал —
      // значит это мы
      if (!user?.aborted) mark();
    },
    { once: true },
  );
  const onUser = () => ctl.abort(user?.reason);
  if (user) {
    if (user.aborted) ctl.abort(user.reason);
    else user.addEventListener("abort", onUser, { once: true });
  }
  return {
    signal: ctl.signal,
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer);
      user?.removeEventListener("abort", onUser);
    },
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    reject(abortError());
    return promise;
  }
  const onAbort = () => {
    clearTimeout(t);
    reject(abortError());
  };
  const t = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}

// ---------------------------------------------------------------------------
// Маппинг исключений fetch → AiError
// ---------------------------------------------------------------------------

function mapFetchError(e: unknown, timedOut: boolean, key: string): AiError | Error {
  if (timedOut) {
    return new AiError("timeout", "request timed out", { cause: e });
  }
  if (isAbortError(e)) return e instanceof Error ? e : abortError(); // отмена — не карточка
  const detail = redactKey(e instanceof Error ? e.message : String(e), key);
  return new AiError("network-error", detail, { cause: e });
}

async function raiseForStatus(res: Response, key: string): Promise<void> {
  if (res.ok) return;
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* тело может быть недоступно — не страшно */
  }
  const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
  const kind = classifyHttpError(res.status, body);
  throw new AiError(kind, redactKey(`HTTP ${res.status}: ${body.slice(0, 200)}`, key), {
    status: res.status,
    retryAfterMs: retryAfterMs ?? undefined,
  });
}

// ---------------------------------------------------------------------------
// sendChat — стриминг дельт
// ---------------------------------------------------------------------------

export interface SendChatOptions {
  /** Пользовательская отмена (кнопка «Стоп»). */
  signal?: AbortSignal;
  /** Дедлайн одной попытки, мс. По умолчанию 90с (reasoning-модели отвечают долго). */
  timeoutMs?: number;
  maxTokens?: number;
  /** Переопределить настройки (форма «Настройки» до сохранения). */
  overrides?: Partial<AiSettings>;
}

const CHAT_TIMEOUT_MS = 90_000;
/**
 * Стриминг-чат: POST {base}/chat/completions со stream:true, отдаёт текстовые
 * дельты по мере прихода. Ретраи (1с/3с/8с) только ДО первой отданной дельты —
 * после начала стрима повтор невозможен, ошибка летит наружу.
 *
 * Пустой ответ (стрим закрылся без дельт) — AiError('empty-reply').
 * Пользовательская отмена — AbortError (не AiError), ловить по isAbortError.
 */
export async function* sendChat(
  messages: ChatMessage[],
  options?: SendChatOptions,
): AsyncIterable<string> {
  const cfg = getAiSettings(options?.overrides);
  const check = validateBaseUrl(cfg.baseUrl);
  if (!check.ok) throw new AiError(check.reason, `bad base url: ${cfg.baseUrl}`);
  if (!cfg.apiKey) throw new AiError("missing-credential", "api key is empty");

  const url = `${check.url}/chat/completions`;
  const body = JSON.stringify(buildChatBody(cfg.model, messages, { maxTokens: options?.maxTokens, stream: true }));
  let delivered = false;

  for (let attempt = 0; ; attempt++) {
    try {
      for await (const delta of attemptOnce(url, body, cfg.apiKey, options)) {
        if (!delivered) delivered = true;
        yield delta;
      }
      if (!delivered) throw new AiError("empty-reply", "stream ended without deltas");
      return;
    } catch (e) {
      if (delivered) throw e; // стрим уже отдавал данные — повторять нельзя
      if (shouldRetry(e, attempt)) {
        const wait = backoffMs(attempt, e instanceof AiError ? e.retryAfterMs : undefined);
        try {
          await sleep(wait, options?.signal);
        } catch (se) {
          throw se;
        }
        continue;
      }
      throw e;
    }
  }
}

/** Одна попытка: fetch + чтение SSE (или JSON-ответа, если сервер проигнорировал stream). */
async function* attemptOnce(
  url: string,
  body: string,
  key: string,
  options?: SendChatOptions,
): AsyncGenerator<string, void> {
  const bound = bindSignal(options?.signal, options?.timeoutMs ?? CHAT_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          Accept: "text/event-stream",
        },
        body,
        signal: bound.signal,
      });
    } catch (e) {
      throw mapFetchError(e, bound.timedOut(), key);
    }

    await raiseForStatus(res, key);

    const ct = res.headers.get("content-type") ?? "";
    if (res.body != null && !ct.includes("application/json")) {
      const parser = createSseParser();
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read().catch((e: unknown) => {
            throw mapFetchError(e, bound.timedOut(), key);
          });
          if (done) break;
          for (const d of parser.feed(value)) yield d;
        }
        for (const d of parser.finish()) yield d;
      } finally {
        reader.releaseLock();
      }
      return;
    }

    // Нестримовый JSON-ответ (сервер проигнорировал stream или гейтвей буферизует)
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      throw mapFetchError(e, bound.timedOut(), key);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new AiError("invalid-response", `non-JSON body: ${redactKey(text.slice(0, 200), key)}`);
    }
    const content =
      data && typeof data === "object" && "choices" in data && Array.isArray(data.choices)
        ? data.choices
            .map((ch: unknown) =>
              ch && typeof ch === "object" && "message" in ch && ch.message && typeof ch.message === "object" && "content" in ch.message
                ? ch.message.content
                : null,
            )
            .filter((c): c is string => typeof c === "string")
            .join("")
        : null;
    if (content == null) {
      throw new AiError("invalid-response", `unexpected body: ${redactKey(text.slice(0, 200), key)}`);
    }
    yield content;
  } finally {
    bound.done();
  }
}

// ---------------------------------------------------------------------------
// checkConnection — кнопка «Проверить соединение»
// ---------------------------------------------------------------------------

const CHECK_TIMEOUT_MS = 5_000;
const MODELS_LIMIT = 2000;

export type ConnectionResult =
  | { ok: true; latencyMs: number; models: string[] }
  | { ok: false; latencyMs: number; error: AiError };

/**
 * GET {base}/models с Bearer, таймаут 5с. Возвращает список id моделей
 * (≤2000) и латентность. Никогда не бросает — результат всегда типизирован.
 */
export async function checkConnection(overrides?: Partial<AiSettings>): Promise<ConnectionResult> {
  const cfg = getAiSettings(overrides);
  const started = Date.now();

  const check = validateBaseUrl(cfg.baseUrl);
  if (!check.ok) {
    return { ok: false, latencyMs: Date.now() - started, error: new AiError(check.reason, `bad base url: ${cfg.baseUrl}`) };
  }
  if (!cfg.apiKey) {
    return { ok: false, latencyMs: Date.now() - started, error: new AiError("missing-credential", "api key is empty") };
  }

  const bound = bindSignal(undefined, CHECK_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(`${check.url}/models`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        signal: bound.signal,
      });
    } catch (e) {
      const mapped = mapFetchError(e, bound.timedOut(), cfg.apiKey);
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: mapped instanceof AiError ? mapped : new AiError("unknown", String(mapped)),
      };
    }
    try {
      await raiseForStatus(res, cfg.apiKey);
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - started, error: e instanceof AiError ? e : new AiError("unknown", String(e)) };
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: new AiError("invalid-response", "GET /models returned non-JSON"),
      };
    }
    const models: string[] = [];
    if (data && typeof data === "object" && "data" in data && Array.isArray(data.data)) {
      for (const m of data.data) {
        const id =
          typeof m === "string"
            ? m
            : m && typeof m === "object" && "id" in m && typeof m.id === "string"
              ? m.id
              : null;
        if (id !== null && id !== "") models.push(id);
        if (models.length >= MODELS_LIMIT) break;
      }
    }
    return { ok: true, latencyMs: Date.now() - started, models };
  } finally {
    bound.done();
  }
}
