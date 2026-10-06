import { join } from "node:path";

import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, streamText, tool, type CoreMessage, type LanguageModelV1, type ToolSet } from "ai";

import { BasePromptBuilder, BasePromptExecutor } from "../../../packages/chat-inference/base.js";
import type { Context } from "../../../packages/context/core.js";
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

function recordRoutedUsage(usage: UsageRecord): void {
  new SandSettingsStore(join(getSandRootDir(), "settings.json")).recordInferenceUsage(SAND_INFERENCE_PROVIDER, usage);
}

/**
 * The endpoint the user configured, re-validated on every turn. `isSandInferenceCustomEndpoint`
 * accepts only the official DeepSeek host, so a hand-edited `settings.json` cannot point a turn
 * at OpenRouter or anywhere else.
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
    // Preparing the request is separated from sending it, and the send happens exactly once.
    //
    // The two used to be one statement: `return await fetch(...)` sat INSIDE the `try` below, so
    // the catch could not tell "this body is not JSON" from "the socket died". A transport
    // failure — no network, a closed connection, a proxy that dropped the stream before the
    // headers — was read as the first, and the whole chat completion was sent to DeepSeek a
    // second time, with no pause, no counter and no `Retry-After`. The provider had already
    // accepted and already billed the first body, so one dropped connection cost the user twice
    // for one answer, and the error that escaped was the SECOND attempt's, not the real one.
    //
    // `maxRetries: 0` below is what makes that a defect rather than a belt: retries belong to
    // `stream-attempt.ts`, which has the ladder, the backoff and the attempt counter.
    let outgoing: RequestInit | undefined = init;
    if (typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as Loose;
        if (body.thinking === undefined) {
          body.thinking = { type: isDeepSeekThinkingEnabled(env) ? "enabled" : "disabled" };
          outgoing = { ...init, body: JSON.stringify(body) };
        }
      } catch { /* not the JSON body of a chat completion — send it untouched */ }
    }
    return await fetch(input, outgoing);
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
 * The cache read count the provider actually reported, or 0 when it reported none.
 *
 * `@ai-sdk/openai` 1.3.24 does parse `usage.prompt_tokens_details.cached_tokens` off the
 * stream, but AI SDK v4's `result.usage` has no field to put it in: the usage object
 * carries only `promptTokens`, `completionTokens` and `totalTokens`, and the cached count
 * is parked at `result.providerMetadata.openai.cachedPromptTokens`. The executor below built
 * its usage record from `result.usage` alone and therefore wrote a hardcoded
 * `cacheReadTokens: 0`, which is what the usage panel displayed forever.
 *
 * `cache_write_tokens` has no OpenAI-compatible equivalent at all — automatic prompt caching
 * reports reads only — so `cacheWriteTokens` stays 0 by fact, not by omission.
 */
function cachedPromptTokens(providerMetadata: unknown): number {
  if (typeof providerMetadata !== "object" || providerMetadata == null) return 0;
  const openai: unknown = (providerMetadata as { openai?: unknown }).openai;
  if (typeof openai !== "object" || openai == null) return 0;
  const value: unknown = (openai as { cachedPromptTokens?: unknown }).cachedPromptTokens;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Кортеж, который `zod-to-json-schema` отдаёт в форме черновика-7
 * (`items: [{…}, {…}]` по позициям), DeepSeek не принимает: провайдер требует
 * один объект-схему и отвергает весь запрос, а в запросе лежат ВСЕ инструменты
 * хода. Один такой инструмент — и не отвечает ни один.
 *
 * Позиционный `items` переписывается в обычную форму: объект-схема с
 * свойствами `"0"`, `"1"`, … и точной длиной. Это и есть стандартный способ
 * выразить кортеж в JSON Schema, и DeepSeek такую форму принимает.
 */
function normalizePositionalItems(node: unknown, depth: number): unknown {
  if (depth > 12 || typeof node !== "object" || node == null || Array.isArray(node)) return node;
  const record = node as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record };
  const properties = record.properties;
  if (typeof properties === "object" && properties != null && !Array.isArray(properties)) {
    const rewritten: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(properties)) rewritten[name] = normalizePositionalItems(child, depth + 1);
    next.properties = rewritten;
  }
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    const branch = record[key];
    if (Array.isArray(branch)) next[key] = branch.map((child) => normalizePositionalItems(child, depth + 1));
  }
  for (const key of ["items", "additionalProperties", "$defs", "definitions"]) {
    const child = record[key];
    if (Array.isArray(child)) {
      // Позиционный кортеж: `items` — массив схем по позициям.
      const positional: Record<string, unknown> = {};
      const required: string[] = [];
      child.forEach((entry, index) => {
        const name = String(index);
        positional[name] = normalizePositionalItems(entry, depth + 1);
        required.push(name);
      });
      next.items = {
        type: "object",
        properties: positional,
        required,
        minItems: child.length,
        maxItems: child.length,
      };
      continue;
    }
    if (typeof child === "object" && child != null) next[key] = normalizePositionalItems(child, depth + 1);
  }
  return next;
}

/**
 * Приводит схему инструмента к тому, что DeepSeek понимает: JSON Schema
 * верхнего уровня с `type: "object"` и без позиционных кортежей.
 *
 * Инструменты приносят схему в обёртке StandardSchema — `{ _type, jsonSchema,
 * validate }`. На провод уходит поле `jsonSchema`, и если передать обёртку
 * целиком, провайдер видит `type: null`, отвергает ВЕСЬ запрос («Invalid schema
 * for function 'Task'»), и ход не даёт ответа вообще. Вдобавок модель получила
 * бы схему, у которой все параметры спрятаны за обёрткой.
 *
 * Поэтому обёртка разворачивается, кортежи переписываются, а у схемы без типа
 * тип дописывается. Всё остальное остаётся как есть, и спуск ограничен глубиной:
 * значение не может ссылаться на само себя.
 */
export function normalizeToolParameters(schema: unknown, depth = 0): unknown {
  if (depth > 4 || typeof schema !== "object" || schema == null || Array.isArray(schema)) return schema;
  const record = schema as Record<string, unknown>;
  const inner = record.jsonSchema;
  if (typeof inner === "object" && inner != null && !Array.isArray(inner)) {
    return normalizeToolParameters(inner, depth + 1);
  }
  const typed = typeof record.type === "string" ? record : { ...record, type: "object" };
  return normalizePositionalItems(typed, 0);
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
      parameters: jsonSchema(normalizeToolParameters(parameters)),
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
 */
function deepSeekExecutor(messages: readonly ProviderMessage[], invocationId: string, definitions?: readonly Loose[], executeTool?: DeepSeekToolExecutor, onUsage?: (usage: UsageRecord) => void, ctx?: unknown, options?: RoutedStreamCallOptions) {
  const endpoint = deepSeekEndpoint();
  const model: LanguageModelV1 = createOpenAI({
    apiKey: readDeepSeekApiKey(),
    baseURL: DEEPSEEK_BASE_URL,
    // `strict` is the only mode that puts `stream_options: { include_usage: true }` on the
    // wire (`@ai-sdk/openai` 1.3.24 sends it under a strict guard). Without it the provider
    // returns no usage frame and `result.usage` resolves with nothing to report.
    compatibility: "strict",
    name: "deepseek",
    fetch: deepSeekFetch(),
  }).chat(endpoint.modelId as any);
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
  const extendedUsage = Promise.all([result.usage, result.providerMetadata]).then(([value, providerMetadata]) => ({ inputTokens: value.promptTokens, outputTokens: value.completionTokens, cacheReadTokens: cachedPromptTokens(providerMetadata), cacheWriteTokens: 0, maxTokens: resolveRoutedContextWindow(endpoint.modelId) }));
  if (onUsage != null) void extendedUsage.then(onUsage);
  return { fullStream: result.fullStream, response: result.response, usage: result.usage, extendedUsage, providerMetadata: result.providerMetadata, invocationId: Promise.resolve(invocationId) };
}

class ProviderPromptExecutor extends BasePromptExecutor<ProviderMessage> {
  constructor(initialMessages?: readonly ProviderMessage[], readonly onUsage?: (usage: UsageRecord) => void) { super(new BasePromptBuilder(initialMessages)); }
  stream(ctx: unknown, invocationId = crypto.randomUUID(), definitions?: readonly Loose[], options?: RoutedStreamCallOptions) {
    return deepSeekExecutor(this.getMessages(), invocationId, definitions, undefined, this.onUsage, ctx, options);
  }
}

export function createProviderPromptSession(_provider?: SandInferenceProvider): { getModelId(): string; getExecutor(state?: unknown): PromptExecutor } {
  const modelId = deepSeekEndpoint().modelId;
  return { getModelId: () => modelId, getExecutor: state => new ProviderPromptExecutor(Array.isArray(state) ? state as ProviderMessage[] : undefined, usage => recordRoutedUsage(usage)) };
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
  let failure: { readonly error: unknown } | null = null;
  for await (const event of result.fullStream) {
    if (event.type === "text-delta" && typeof event.textDelta === "string") {
      text += event.textDelta;
      options?.onTextDelta?.(event.textDelta, text);
    } else if (event.type === "error") {
      failure ??= { error: event.error };
    }
  }
  // `result.response` is one of the SDK's delayed promises, and AI SDK v4 resolves those only on
  // the success path. A stream that ended with an `error` part — a dropped connection, a
  // cancelled socket, a refusal — leaves it pending for good, so the `await` below used to turn
  // one failed turn into a caller that waits forever: the turn had already failed, its socket
  // had already been closed, and the loop that came back was never going to end. That is what
  // kept a naming request standing in its queue after its own deadline had killed it.
  if (failure != null) {
    throw failure.error instanceof Error ? failure.error : new Error(`DeepSeek answered with an error: ${String(failure.error)}`);
  }
  await result.response;
  return text;
}