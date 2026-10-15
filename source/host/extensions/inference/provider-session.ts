import { join } from "node:path";

import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, streamText, tool, type CoreMessage, type LanguageModelV1, type ToolSet } from "ai";

import { BasePromptBuilder, BasePromptExecutor } from "../../../packages/chat-inference/base.js";
import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_CONTEXT_WINDOW,
  DEEPSEEK_MAX_OUTPUT_TOKENS,
  SAND_INFERENCE_PROVIDER,
  defaultSandInferenceCustomEndpoint,
  isSandInferenceCustomEndpoint,
  type SandInferenceCustomEndpoint,
  type SandInferenceProvider,
} from "../../../shared/inference-router.js";
import { getSandRootDir } from "../../host-paths.js";
import { SandSettingsStore } from "../../../shared/node/settings/sand-settings-store.js";
import { readDeepSeekApiKey } from "./deepseek-credential.js";
import type { LabelMessage, PromptExecutor } from "./sand-labeling.js";

type Loose = Record<string, any>;
interface ProviderMessage extends LabelMessage { role: string; content: string | readonly unknown[] }
type UsageRecord = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
type DeepSeekToolExecutor = (tool: Loose, args: unknown, toolCallId: string) => Promise<unknown>;

/**
 * What DB Bot Lite's agent is. No Cursor, no cloud agent, no second account: it runs on the
 * user's own Windows machine and reaches the user only through its tools.
 */
const DB_BOT_ROUTER_SYSTEM_PROMPT = [
  "You are DB Bot, a local desktop assistant for one library librarian.",
  "You run entirely on this Windows computer. There is no remote machine, no virtual box, no cloud agent and no second account.",
  "Everything the tools of this request offer is already connected and works on this computer. Use them instead of asking the user to reconnect anything.",
  "Never ask for an API key for an already-connected service. Answer the user in Russian, in plain words, after the tool calls are done.",
].join("\n");

/**
 * Adds one turn's token counts to the persisted router ledger.
 *
 * Token accounting is telemetry, and telemetry must never be able to fail a turn. The
 * executor attaches this with `void extendedUsage.then(onUsage)`, which has no rejection
 * handler: anything `recordInferenceUsage` threw became an unhandled promise rejection on a
 * turn that had already answered the user. Node's default is to terminate the process on an
 * unhandled rejection, so one unwritable settings file could take the host — or the forked
 * coordinator, which is plain Node — down mid-conversation.
 *
 * What it throws is real: `SandSettingsStore.persist` finishes in `renameSync`, and Windows
 * fails that with `EPERM` when another process holds `settings.json`. The coordinator
 * (`node-agent-coordinator/inference-router.ts`) and the desktop are two processes writing that
 * same file, so this is an ordinary event, not a broken disk. A count that cannot be written is
 * a missing number, and a missing number is never worth a finished turn or a dead process.
 */
function recordRoutedUsage(usage: UsageRecord): void {
  try { new SandSettingsStore(join(getSandRootDir(), "settings.json")).recordInferenceUsage(SAND_INFERENCE_PROVIDER, usage); } catch {}
}

/** Matches `SAND_ENDPOINT_SECRET_GUARD_MIN` in `inference-endpoint-models.ts`. */
const ROUTED_CREDENTIAL_GUARD_MIN = 8;
const ROUTED_CREDENTIAL_PLACEHOLDER = "[redacted]";

/**
 * Removes the DeepSeek credential from a provider failure, in place, and returns the same
 * error object.
 *
 * An endpoint is free to answer a rejected request by repeating the key it was sent — a 401
 * answered `{"error":{"message":"invalid key <key>"}}` was measured producing a turn error whose
 * `message` was that whole sentence, credential included, and that text is what reaches the chat
 * and the logs. The model-list path already refuses to hand the credential back in any field
 * (`inference-endpoint-models.ts`, `leaksSecret`); the turn path needs the same guard.
 *
 * Only the credential substring is replaced, and the same error object is kept, because
 * `isRetryableProviderError` classifies on `message`, `name`, `retryable` and `isRetryable`.
 * Rewriting the message wholesale, or throwing a fresh `Error`, would turn a retryable 500 or a
 * transient `ECONNRESET` into a dead end.
 */
function redactRoutedCredential(error: unknown, credential: string): unknown {
  const secret = credential.trim();
  if (secret.length < ROUTED_CREDENTIAL_GUARD_MIN || typeof error !== "object" || error == null) return error;
  const record = error as { message?: unknown; responseBody?: unknown };
  for (const field of ["message", "responseBody"] as const) {
    const value = record[field];
    if (typeof value !== "string" || !value.includes(secret)) continue;
    try { record[field] = value.split(secret).join(ROUTED_CREDENTIAL_PLACEHOLDER); } catch { /* a frozen error keeps its own text */ }
  }
  return error;
}

/** Every part passes through untouched; only an `{ type: "error" }` part is scrubbed. */
async function* redactRoutedCredentialStream(source: AsyncIterable<Loose>, credential: string): AsyncIterable<Loose> {
  for await (const part of source) {
    yield part != null && typeof part === "object" && part.type === "error"
      ? { ...part, error: redactRoutedCredential(part.error, credential) }
      : part;
  }
}

/**
 * The model the user configured, re-validated on every turn. `isSandInferenceCustomEndpoint`
 * accepts only the official DeepSeek host, so a hand-edited `settings.json` cannot point a turn
 * at OpenRouter or anywhere else — the base URL on the wire is always `DEEPSEEK_BASE_URL`.
 */
function deepSeekEndpoint(): SandInferenceCustomEndpoint {
  const stored: unknown = new SandSettingsStore(join(getSandRootDir(), "settings.json")).getInferenceCustomEndpoint();
  if (isSandInferenceCustomEndpoint(stored)) return stored;
  return defaultSandInferenceCustomEndpoint();
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value != null &&
    typeof (value as AbortSignal).aborted === "boolean" &&
    typeof (value as AbortSignal).addEventListener === "function";
}

/**
 * The turn context is the abort authority of a turn: `stream-attempt.ts` derives the
 * per-attempt context from `ctx.withCancel()`, so `ctx.signal` is exactly the signal the
 * first-token-stall deadline and the user's cancel abort. Reading it here is what lets
 * `streamText` kill its socket instead of leaving it open until the process exits.
 */
function contextAbortSignal(ctx: unknown): AbortSignal | undefined {
  if (ctx == null || typeof ctx !== "object") return undefined;
  const signal = (ctx as { signal?: unknown }).signal;
  return isAbortSignal(signal) ? signal : undefined;
}

/** Per-call controls the runner threads down to `streamText`. */
export interface RoutedStreamCallOptions {
  /**
   * Cancels the provider socket. The runner always supplies the turn context's signal; a
   * caller without a turn context (labeling, routing probes) may omit it.
   */
  readonly abortSignal?: AbortSignal;
}

function resolveAbortSignal(ctx: unknown, options?: RoutedStreamCallOptions): AbortSignal | undefined {
  return options?.abortSignal ?? contextAbortSignal(ctx);
}

/** `SAND_DEEPSEEK_THINKING=1` turns the reasoning mode on. It is off by default. */
export function isDeepSeekThinkingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SAND_DEEPSEEK_THINKING?.trim() === "1";
}

/**
 * Thinking mode is DeepSeek's own default, and `@ai-sdk/openai` 1.3.24 has no `extraBody`
 * setting, so the flag is injected into the request body on the way out.
 *
 * Measured against the live API with the project's own tool set: a second turn that omits
 * `reasoning_content` is accepted (HTTP 200) both with thinking left on and with it off, and
 * an explicit `{"type":"disabled"}` is accepted too. So this is a cost and latency choice,
 * not a correctness gate. Off by default because the agent already pays for a long system
 * prompt on every turn, and `temperature` is ignored while thinking is on.
 */
export function deepSeekFetch(env: NodeJS.ProcessEnv = process.env): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as Loose;
        if (body.thinking === undefined) {
          body.thinking = { type: isDeepSeekThinkingEnabled(env) ? "enabled" : "disabled" };
          return await fetch(input, { ...init, body: JSON.stringify(body) });
        }
      } catch { /* not the JSON body of a chat completion — send it untouched */ }
    }
    return await fetch(input, init);
  };
}

/**
 * The context window of the model, reported to the agent as `extendedUsage.maxTokens`.
 *
 * Every consumer treats a non-positive `maxTokens` as "unknown": background summarization
 * returns an undefined trigger threshold, the token-overage block is skipped, and
 * `conversation-state.ts` never records a window for the model, so the conversation is never
 * compacted. A hardcoded `0` therefore disabled all three at once, silently.
 */
export const DEFAULT_ROUTED_CONTEXT_WINDOW = DEEPSEEK_CONTEXT_WINDOW;
export function resolveRoutedContextWindow(modelId: string, env: NodeJS.ProcessEnv = process.env): number {
  const override = Number.parseInt(env.SAND_ROUTED_CONTEXT_WINDOW?.trim() ?? "", 10);
  if (Number.isFinite(override) && override > 0) return override;
  // `deepseek-flash` and `deepseek-v4-pro` both report 1048576 on `GET /models`.
  return DEEPSEEK_CONTEXT_WINDOW;
}

/**
 * `ai` 4.3.17 silently defaults `temperature` to 0 for every `streamText` call, so a request's
 * sampling was decided by an SDK default nobody in this repository had read. The value is now
 * stated at the call site and can be changed without touching the SDK: `SAND_ROUTED_TEMPERATURE=0.7`.
 * Omitting the parameter is not possible — the SDK re-applies its own 0 — so there is no
 * `unset` mode here on purpose.
 */
export function resolveRoutedTemperature(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseFloat(env.SAND_ROUTED_TEMPERATURE?.trim() ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * How many output tokens one turn may take. DeepSeek's own default is 8K, which cuts a long
 * tool result short; `SAND_DEEPSEEK_MAX_TOKENS` overrides this.
 */
export function resolveDeepSeekMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  const override = Number.parseInt(env.SAND_DEEPSEEK_MAX_TOKENS?.trim() ?? "", 10);
  if (Number.isFinite(override) && override > 0) return override;
  return DEEPSEEK_MAX_OUTPUT_TOKENS;
}

/**
 * `maxRetries: 0` is deliberate. The SDK default of 2 sleeps between attempts *inside* one
 * `streamText` call, so a 429 or a 500 turned into a silent seven-second pause and then a
 * single "Failed after 3 attempts". Retries belong to `stream-attempt.ts`, which already
 * has the ladder, the backoff, the server-paced `Retry-After` and the retry counter.
 */
function routedStreamTextParams(ctx: unknown, options?: RoutedStreamCallOptions): { readonly abortSignal?: AbortSignal; readonly maxRetries: number; readonly temperature: number; readonly maxTokens: number } {
  const abortSignal = resolveAbortSignal(ctx, options);
  return {
    ...(abortSignal === undefined ? {} : { abortSignal }),
    maxRetries: 0,
    temperature: resolveRoutedTemperature(),
    maxTokens: resolveDeepSeekMaxTokens(),
  };
}

/**
 * The cache read count the provider actually reported on one step, or 0 when it reported none.
 *
 * `@ai-sdk/openai` 1.3.24 does parse `usage.prompt_tokens_details.cached_tokens` off the
 * stream, but AI SDK v4's `result.usage` has no field to put it in: the usage object
 * carries only `promptTokens`, `completionTokens` and `totalTokens`, and the cached count
 * is parked at `providerMetadata.openai.cachedPromptTokens`. The executor below once built
 * its usage record from `result.usage` alone and therefore wrote a hardcoded
 * `cacheReadTokens: 0`, which is what the usage panel displayed forever.
 *
 * `cache_write_tokens` has no OpenAI-compatible equivalent at all — automatic prompt caching
 * reports reads only — so `cacheWriteTokens` stays 0 by fact, not by omission.
 */
function stepCachedPromptTokens(providerMetadata: unknown): number {
  if (typeof providerMetadata !== "object" || providerMetadata == null) return 0;
  const openai: unknown = (providerMetadata as { openai?: unknown }).openai;
  if (typeof openai !== "object" || openai == null) return 0;
  const value: unknown = (openai as { cachedPromptTokens?: unknown }).cachedPromptTokens;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The cache read count for a whole turn: the sum over every step of the turn.
 *
 * `result.providerMetadata` looks like the obvious source and is wrong for a turn that takes
 * more than one step. `ai` 4.3.17 accumulates `streamText`'s `result.usage` across steps
 * (`addLanguageModelUsage`) but resolves `result.providerMetadata` with the LAST step only
 * (`providerMetadataPromise.resolve(lastStep.experimental_providerMetadata)`). The executor
 * below passes `maxSteps: 8` whenever a tool is supplied, so a tool-calling turn sums its
 * input and output counts over every step while reading the cache count from one of them —
 * the ledger reported a cache hit far below what the provider measured, and it contradicted
 * its own input total. Measured on a two-step turn whose steps reported 500 and 900 cached
 * prompt tokens: the ledger held `inputTokens: 2100, cacheReadTokens: 900` where the provider
 * had reported 1400.
 *
 * `result.steps` is the only source that carries each step's own provider metadata.
 */
function cachedPromptTokens(steps: unknown): number {
  if (!Array.isArray(steps)) return 0;
  let total = 0;
  for (const step of steps) {
    const providerMetadata: unknown = typeof step === "object" && step != null
      ? (step as { experimental_providerMetadata?: unknown }).experimental_providerMetadata
      : undefined;
    total += stepCachedPromptTokens(providerMetadata);
  }
  return total;
}

function toToolSet(definitions: readonly Loose[] | undefined, executeTool?: DeepSeekToolExecutor): ToolSet | undefined {
  if (definitions == null || definitions.length === 0) return undefined;
  const tools: ToolSet = {};
  for (const definition of definitions) {
    if (typeof definition.name !== "string" || definition.name.length === 0) continue;
    const parameters = definition.inputSchema ?? definition.parameters;
    if (parameters == null) continue;
    const routedTool: any = {
      ...(typeof definition.description === "string" ? { description: definition.description } : {}),
      parameters: jsonSchema(parameters),
    };
    if (executeTool != null) routedTool.execute = async (args: unknown, options: { toolCallId: string }) => await executeTool(definition, args, options.toolCallId);
    tools[definition.name] = tool(routedTool);
  }
  return Object.keys(tools).length === 0 ? undefined : tools;
}

/**
 * The one and only request path: an OpenAI-compatible `POST /chat/completions` against
 * `https://api.deepseek.com`, spoken by `@ai-sdk/openai` as a protocol client. That package
 * is not an OpenAI account and never reaches `api.openai.com` here — `baseURL` is fixed to
 * the DeepSeek constant below and nothing in this file can override it.
 *
 * The model comes from the caller: the prompt session resolves the configured endpoint once
 * and hands its `modelId` down, so the model the transcript names through `getModelId()` and
 * the model in the POST body are the same string rather than two reads of the same file.
 * `runRoutedProviderText` resolves it itself for a one-off call.
 */
function deepSeekExecutor(messages: readonly ProviderMessage[], invocationId: string, definitions?: readonly Loose[], executeTool?: DeepSeekToolExecutor, onUsage?: (usage: UsageRecord) => void, ctx?: unknown, options?: RoutedStreamCallOptions, modelId: string = deepSeekEndpoint().modelId) {
  const credential = readDeepSeekApiKey();
  const model: LanguageModelV1 = createOpenAI({
    apiKey: credential,
    baseURL: DEEPSEEK_BASE_URL,
    // `strict` is the only mode that puts `stream_options: { include_usage: true }` on the
    // wire (`@ai-sdk/openai` 1.3.24 sends it under a strict guard). Without it the provider
    // returns no usage frame and `result.usage` resolves with nothing to report.
    compatibility: "strict",
    name: "deepseek",
    fetch: deepSeekFetch(),
  }).chat(modelId as any);
  const tools = toToolSet(definitions, executeTool);
  const result = streamText({
    model,
    system: DB_BOT_ROUTER_SYSTEM_PROMPT,
    messages: messages as CoreMessage[],
    ...(tools === undefined ? {} : { tools }),
    // DeepSeek streams `tool-call` arguments as they arrive instead of in one block at the end.
    toolCallStreaming: true,
    maxSteps: tools === undefined ? 1 : 8,
    ...routedStreamTextParams(ctx, options),
  });
  const extendedUsage = Promise.all([result.usage, result.steps]).then(([value, steps]) => ({ inputTokens: value.promptTokens, outputTokens: value.completionTokens, cacheReadTokens: cachedPromptTokens(steps), cacheWriteTokens: 0, maxTokens: resolveRoutedContextWindow(modelId) }));
  if (onUsage != null) void extendedUsage.then(onUsage);
  return { fullStream: redactRoutedCredentialStream(result.fullStream, credential), response: result.response, usage: result.usage, extendedUsage, providerMetadata: result.providerMetadata, invocationId: Promise.resolve(invocationId) };
}

class ProviderPromptExecutor extends BasePromptExecutor<ProviderMessage> {
  constructor(initialMessages: readonly ProviderMessage[] | undefined, readonly modelId: string, readonly onUsage?: (usage: UsageRecord) => void) { super(new BasePromptBuilder(initialMessages)); }
  stream(ctx: unknown, invocationId = crypto.randomUUID(), definitions?: readonly Loose[], options?: RoutedStreamCallOptions) {
    return deepSeekExecutor(this.getMessages(), invocationId, definitions, undefined, this.onUsage, ctx, options, this.modelId);
  }
}

export function createProviderPromptSession(_provider?: SandInferenceProvider): { getModelId(): string; getExecutor(state?: unknown): PromptExecutor } {
  // One resolution, one answer. The endpoint is read once here, so `getModelId()` and every
  // executor this session builds name the same model a mid-turn settings edit cannot split.
  const modelId = deepSeekEndpoint().modelId;
  return { getModelId: () => modelId, getExecutor: state => new ProviderPromptExecutor(Array.isArray(state) ? state as ProviderMessage[] : undefined, modelId, usage => recordRoutedUsage(usage)) };
}

export async function runRoutedProviderText(_provider: SandInferenceProvider | undefined, messages: readonly ProviderMessage[], options?: {
  readonly tools?: readonly Loose[];
  readonly executeTool?: DeepSeekToolExecutor;
  readonly onTextDelta?: (delta: string, accumulated: string) => void;
  /** Cancels the provider socket; without it the request outlives its caller. */
  readonly abortSignal?: AbortSignal;
}): Promise<string> {
  const invocationId = crypto.randomUUID();
  const onUsage = (usage: UsageRecord) => recordRoutedUsage(usage);
  const callOptions = options?.abortSignal === undefined ? undefined : { abortSignal: options.abortSignal };
  const result = deepSeekExecutor(messages, invocationId, options?.tools, options?.executeTool, onUsage, undefined, callOptions);
  let text = "";
  // `result.response` is an AI SDK DelayedPromise that only settles in the stream's normal
  // `flush`. A provider error ends `fullStream` with one `{ type: "error" }` part before that
  // point, so the `await` below never returned and every routed failure became a promise that
  // stays pending for the life of the host process — no error, no reply, no timeout. Measured on
  // this route: a refused connection and a 401 both stayed pending past 20s, and the coordinator's
  // naming queue for that agent then never drained again, because it chains each attempt onto the
  // pending one. The same trap is already documented and worked around for the agent turn path in
  // `tool-stream-executor.ts`; this route did not learn it.
  //
  // So the error part is carried out of the loop and rethrown here. Anything that is not a
  // `text-delta` still passes through untouched.
  let failure: unknown;
  for await (const event of result.fullStream) {
    const part = event as { type?: unknown; error?: unknown; textDelta?: unknown };
    if (part.type === "error") { failure ??= part.error; continue; }
    if (part.type === "text-delta" && typeof part.textDelta === "string") {
      text += part.textDelta;
      options?.onTextDelta?.(part.textDelta, text);
    }
  }
  if (failure != null) throw failure instanceof Error ? failure : new Error(String(failure));
  await result.response;
  return text;
}
