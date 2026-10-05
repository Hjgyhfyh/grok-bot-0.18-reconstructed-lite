/**
 * DB Bot Lite has exactly one model provider: the official DeepSeek API.
 *
 * The array below is the single source of truth for the backend. Cursor, Claude Code,
 * Codex and OpenRouter were four parallel request paths into the same executor; they are
 * gone, so a value read from an older `settings.json` is simply not a provider any more
 * and `isSandInferenceProvider` rejects it.
 */
export const SAND_INFERENCE_PROVIDERS = ["deepseek"] as const;
export type SandInferenceProvider = (typeof SAND_INFERENCE_PROVIDERS)[number];

/** The only provider there is. Kept as a name so call sites never repeat the literal. */
export const SAND_INFERENCE_PROVIDER: SandInferenceProvider = "deepseek";

/** Official DeepSeek API. OpenAI-compatible, so `https://api.deepseek.com/v1` works too. */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_API_HOSTNAME = "api.deepseek.com";

/** Env var read first, before the settings file. The key itself is never a literal here. */
export const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";

/** `deepseek-flash` is the only current model that accepts images, and the agent sends them. */
export const DEEPSEEK_DEFAULT_MODEL_ID = "deepseek-flash";
/** The reasoning model. Text in, text out. */
export const DEEPSEEK_REASONING_MODEL_ID = "deepseek-v4-pro";
export const DEEPSEEK_MODEL_IDS: readonly string[] = [DEEPSEEK_DEFAULT_MODEL_ID, DEEPSEEK_REASONING_MODEL_ID];

/** Both current models report a 1048576 token context window on `GET /models`. */
export const DEEPSEEK_CONTEXT_WINDOW = 1_048_576;
/**
 * The API's own default for `max_tokens` is 8K, which truncates a long tool result.
 * 32K leaves room for a full answer without asking for the whole 384K ceiling.
 */
export const DEEPSEEK_MAX_OUTPUT_TOKENS = 32_000;

export const DEEPSEEK_MISSING_KEY_MESSAGE =
  "Не задан ключ DeepSeek API. Открой Настройки → DeepSeek и вставь ключ вида sk-… " +
  "или задай переменную окружения DEEPSEEK_API_KEY.";

/** A DeepSeek endpoint as the user configured it. Never carries credentials. */
export interface SandInferenceCustomEndpoint {
  readonly baseUrl: string;
  readonly modelId: string;
}

/**
 * A DeepSeek endpoint is valid only when it points at the official host. This is what
 * hard-disables OpenRouter and every other OpenAI-compatible service: their URLs fail
 * here, so they can never be written to `settings.json` or reached by a turn.
 */
export function isSandInferenceCustomEndpoint(value: unknown): value is SandInferenceCustomEndpoint {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return false;
  const record = value as { baseUrl?: unknown; modelId?: unknown };
  if (typeof record.baseUrl !== "string" || typeof record.modelId !== "string") return false;
  if (record.modelId.trim().length === 0) return false;
  let url: URL;
  try { url = new URL(record.baseUrl.trim()); } catch { return false; }
  if (url.protocol !== "https:") return false;
  if (url.username.length > 0 || url.password.length > 0) return false;
  return url.hostname.toLowerCase() === DEEPSEEK_API_HOSTNAME;
}

/** Trims an already-valid endpoint, or returns `undefined` so callers can silently drop junk. */
export function normalizeSandInferenceCustomEndpoint(value: unknown): SandInferenceCustomEndpoint | undefined {
  if (!isSandInferenceCustomEndpoint(value)) return undefined;
  const record = value as { readonly baseUrl: string; readonly modelId: string };
  return { baseUrl: record.baseUrl.trim(), modelId: record.modelId.trim() };
}

/** The endpoint used when `settings.json` names no model: the official host, the default model. */
export function defaultSandInferenceCustomEndpoint(): SandInferenceCustomEndpoint {
  return { baseUrl: DEEPSEEK_BASE_URL, modelId: DEEPSEEK_DEFAULT_MODEL_ID };
}

export interface SandInferenceRouterUsageProvider {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly lastUsedAt: string | null;
}

export interface SandInferenceRouterUsage {
  readonly schemaVersion: 1;
  readonly providers: Record<SandInferenceProvider, SandInferenceRouterUsageProvider>;
}

export function isSandInferenceProvider(value: unknown): value is SandInferenceProvider {
  return typeof value === "string" && (SAND_INFERENCE_PROVIDERS as readonly string[]).includes(value);
}

export function emptySandInferenceRouterUsage(): SandInferenceRouterUsage {
  const empty = (): SandInferenceRouterUsageProvider => ({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, lastUsedAt: null });
  return { schemaVersion: 1, providers: { deepseek: empty() } };
}