# Wire notes — DeepSeek-only inference (`lite/waveb-deepseek`)

Owner of these notes: the `source/host/extensions/inference/**` port.
This branch replaces the multi-provider router in that directory with the
DeepSeek-only implementation from `archive/wave-3`. Everything below is a
required edit to a file this branch does **not** own. Each entry gives the
anchor, the new code, and why. Where the wave-3 diff is large, the note points
at the reference instead of inlining it: `git show origin/archive/wave-3:<path>`
or `git diff origin/main origin/archive/wave-3 -- <path>`.

`tsc -p source/tsconfig.json` on this branch currently reports exactly the
errors these edits resolve:

- `inference/deepseek-credential.ts`: `DEEPSEEK_API_KEY_ENV`,
  `DEEPSEEK_MISSING_KEY_MESSAGE`, `getInferenceApiKey` missing.
- `inference/provider-session.ts`: `DEEPSEEK_BASE_URL`, `DEEPSEEK_CONTEXT_WINDOW`,
  `DEEPSEEK_MAX_OUTPUT_TOKENS`, `SAND_INFERENCE_PROVIDER`,
  `defaultSandInferenceCustomEndpoint` missing.
- `transcript/turn-runtime.ts`: imports the deleted `custom-model-demotion.js`.
- `node-agent-coordinator/inference-router.ts`: passes `sessionId`, which the
  DeepSeek-only `runRoutedProviderText` signature no longer takes.

---

## 1. `source/shared/inference-router.ts` — REQUIRED (compile)

**Why:** `provider-session.ts` and `deepseek-credential.ts` import DeepSeek
constants and the single-provider names that only exist on wave-3, where this
file declares `SAND_INFERENCE_PROVIDERS = ["deepseek"]`. The current file still
declares the five-provider union (`cursor`, `claude-code`, `codex`, `openrouter`,
`custom`) and an `isSandInferenceCustomEndpoint` that accepts any https host —
under it a hand-edited `settings.json` could still route a turn anywhere.

**Edit:** replace the file with the wave-3 version:

```
git show origin/archive/wave-3:source/shared/inference-router.ts > source/shared/inference-router.ts
```

Symbols this branch's code consumes from it: `SAND_INFERENCE_PROVIDERS`,
`SandInferenceProvider`, `SAND_INFERENCE_PROVIDER`, `DEEPSEEK_BASE_URL`,
`DEEPSEEK_API_HOSTNAME`, `DEEPSEEK_API_KEY_ENV`, `DEEPSEEK_DEFAULT_MODEL_ID`,
`DEEPSEEK_REASONING_MODEL_ID`, `DEEPSEEK_MODEL_IDS`, `DEEPSEEK_CONTEXT_WINDOW`,
`DEEPSEEK_MAX_OUTPUT_TOKENS`, `DEEPSEEK_MISSING_KEY_MESSAGE`,
`SandInferenceCustomEndpoint`, `isSandInferenceCustomEndpoint`,
`normalizeSandInferenceCustomEndpoint`, `defaultSandInferenceCustomEndpoint`,
`isSandInferenceProvider`, `SandInferenceRouterUsage`,
`SandInferenceRouterUsageProvider`, `emptySandInferenceRouterUsage`.

Dropping the other providers also deletes `SAND_ACCOUNT_BACKED_INFERENCE_PROVIDER`,
`SAND_FALLBACK_INFERENCE_PROVIDER`, `ServedSandInferenceProvider`,
`isServedSandInferenceProvider`, `resolveServedInferenceProvider`,
`isSandEndpointModelId`, `sandInferenceFallbackModelId`,
`SandInferenceCustomModelDemotion*`, `activeCustomModelDemotion`,
`normalizeSandInferenceWriteEndpoint`, `SandInferenceWriteEndpoint` — every
importer of those must be updated (settings store, electron-main, turn-runtime;
see below). If this file is owned by another wave-b agent, only the export list
above is a hard requirement of this branch.

## 2. `source/shared/node/settings/sand-settings-store.ts` — REQUIRED (compile)

**Why:** `deepseek-credential.ts` calls `getInferenceApiKey()`, which exists only
on wave-3. The same edit carries the `deepseek-only` migration that rewrites a
stale `inferenceProvider`/`inferenceCustomEndpoint` left by an older build.

**Edit:** apply the wave-3 version of this file, or cherry-pick these pieces:

```ts
// top-level constants
export const SAND_DEEPSEEK_ONLY_MIGRATION_ID = "deepseek-only";
// and append it to SAND_SETTINGS_MIGRATION_IDS

// SandStoredSettings gains:
  /** The DeepSeek API key. Stored in the user's own settings file; never compiled into the sources. */
  inferenceApiKey?: string;

// in parseSettings, after the inferenceCustomEndpoint line:
  if (typeof raw.inferenceApiKey === "string" && raw.inferenceApiKey.trim().length > 0) result.inferenceApiKey = raw.inferenceApiKey.trim();

// in applyPendingMigrations, after the local-inference-provider block:
    // DeepSeek is the only provider left. A file written by an earlier build still carries
    // `inferenceProvider: "cursor" | "openrouter" | ...` and, with it, an endpoint pointing at
    // that provider's host. Both are rewritten so no old route survives the upgrade.
    if (!done.has(SAND_DEEPSEEK_ONLY_MIGRATION_ID)) { pending.push(SAND_DEEPSEEK_ONLY_MIGRATION_ID); next = { ...next, inferenceProvider: SAND_INFERENCE_PROVIDER, inferenceCustomEndpoint: defaultSandInferenceCustomEndpoint() }; }

// methods on SandSettingsStore:
  /** The DeepSeek API key, or `undefined` when the user has not entered one yet. */
  getInferenceApiKey(): string | undefined { return this.load().inferenceApiKey; }
  setInferenceApiKey(value: string | undefined): void { this.update((s) => { const { inferenceApiKey: _old, ...rest } = s; const trimmed = value?.trim(); return trimmed == null || trimmed.length === 0 ? rest : { ...rest, inferenceApiKey: trimmed }; }); }
```

The wave-3 file also simplifies `getInferenceProvider` to
`return this.load().inferenceProvider ?? SAND_INFERENCE_PROVIDER` and drops the
demotion accessors; `recordInferenceUsage` stays signature-compatible.
Reference: `git diff origin/main origin/archive/wave-3 -- source/shared/node/settings/sand-settings-store.ts`.
Note "inferenceApiKey" must also be added to the persisted-keys whitelist near
`"inferenceProvider", "inferenceRouterUsage", "inferenceCustomEndpoint"`.

## 3. `source/host/runner/turn-run-shell.ts` — REQUIRED (behavior)

**Why:** on `main` this file still branches on `getInferenceProvider()` and calls
`createProviderPromptSession(inferenceProvider)`. It compiles against the new
signature (the parameter is now optional and ignored), but the dead branch and
its `routerSettings` read should go — wave-3 replaced the whole block.

**Edit:** replace lines ~186–205 (the `inferenceProvider` read and both ternaries)
with:

```ts
  // DeepSeek is the only route, so there is nothing to choose between: one call builds both
  // the turn session and the summarization session.
  const agent = createProviderPromptSession() as unknown as TurnAgentPromptSession;
  const summarizationSession = createProviderPromptSession() as unknown as SummarizationPromptSession;
  const summarization = summarizationSession;
```

Then drop the now-unused `SandSettingsStore`/`getSandRootDir`/`join` imports if
nothing else in the file uses them. Reference:
`git diff origin/main origin/archive/wave-3 -- source/host/runner/turn-run-shell.ts`.

## 4. `source/node-agent-coordinator/inference-router.ts` — REQUIRED (compile)

**Why:** `runRoutedProviderText` no longer accepts `sessionId` (that option fed
the OpenCode `x-opencode-session` header on the deleted `custom` route), and the
`Exclude<SandInferenceProvider, "cursor">` type goes away with the union.

**Edit:** apply the wave-3 diff
(`git diff origin/main origin/archive/wave-3 -- source/node-agent-coordinator/inference-router.ts`):
`provider` becomes plain `SandInferenceProvider`; the transcript parser's
provider allowlist becomes `["deepseek"]`; the `{ sessionId: agentId }` argument
to `runRoutedProviderText` is deleted; the `provider !== "cursor"` guards on the
transcript-tail and sendPrompt routes are removed; and a stale stored provider
is declined via `!SAND_INFERENCE_PROVIDERS.includes(provider)` before naming a
conversation.

## 5. `source/shared/node/cursor-backend/cursor-inference.ts` — REQUIRED (behavior)

**Why:** `createCursorInferencePromptSession` is the last path that could build a
Cursor gRPC inference session. Wave-3 makes it throw instead of dialing
`api2.cursor.sh`, and guards `createSandBackendTransport` the same way.

**Edit:** apply
`git diff origin/main origin/archive/wave-3 -- source/shared/node/cursor-backend/cursor-inference.ts`:
add `CURSOR_BACKEND_DISABLED_MESSAGE` ("Cursor backend отключён: задай
SAND_BACKEND_URL, чтобы включить обращения к нему."), throw it from
`createCursorInferencePromptSession`, and throw it from
`createSandBackendTransport` when `getSandInferenceBackendUrl()` is empty.
The `createProviderPromptSession(routedProvider)` dispatch inside
`createCursorInferencePromptSession` is removed with the rest of the body.

## 6. `source/host/extensions/transcript/turn-runtime.ts` — REQUIRED (compile)

**Why:** it imports `applyCustomModelDemotionForFailure` from the deleted
`inference/custom-model-demotion.ts`. The demotion machinery only existed to
move a broken custom endpoint onto its spare model; DeepSeek has no spare and
no demotion.

**Edit (minimal):**
- Delete `import { applyCustomModelDemotionForFailure } from "../inference/custom-model-demotion.js";`
  and the now-unused imports `join`, `SandSettingsStore`, `getSandRootDir`,
  `type SandInferenceCustomModelDemotion`.
- Delete the `customModelDemotionSentence` export (~lines 275–296).
- In the turn-failure block (~line 826), delete the
  `const demotion = await applyCustomModelDemotionForFailure(...)` call and the
  `...(demotion.recorded && demotion.demotion !== undefined ? { text: ... } : {})`
  spread on the notice.

**Wave-3 went further** in the same file: it removed the
`provider-refusal-reason.ts` imports and inlined the 400/422 fallback text, and
moved the HTTP-status walk back into `providerHttpStatusOf`. That part is
optional for this port but keeps the file consistent with wave-3; see
`git diff origin/main origin/archive/wave-3 -- source/host/extensions/transcript/turn-runtime.ts`.
If `provider-refusal-reason.ts` ends up with no remaining importer, it can be
deleted too.

## 7. Tests — REQUIRED (suite)

These `tests/*.test.mjs` reference deleted files or the removed provider routes.
Wave-3 disposition:

- **Deleted by wave-3:** `account-backed-provider-cannot-be-selected`,
  `codex-direct-responses`, `custom-endpoint-catalogue-demotion`,
  `custom-endpoint-fallback-model`, `provider-refusal-cause-sentence`,
  `routed-mcp-tool-round-trip`, `routed-provider-failure-settles`,
  `router-bridge-round-trip`, `router-model-probe-host-escape`,
  `router-usage-cache-read-write-rows`, `router-usage-cross-process-ledger`,
  `router-usage-multi-step-cache-read`, `router-usage-record-failure-isolation`.
- **Adapted by wave-3** (fetch them at that ref):
  `custom-endpoint-tool-serialisation`, `inference-router-transcript`,
  `routed-provider-cache-usage`, `routed-provider-dispatch`,
  `routed-provider-self-description`, `routed-provider-transport`,
  `router-model-picker`, `router-settings`,
  `fresh-mcp-routed-action-names-its-field`, `router-renderer-panel-render`.
- `publication-packaging.test.mjs` reads `codex-direct-responses.ts` and greps
  provider-session source — take the wave-3 version.
- `opencode-session-header.test.mjs` covers the deleted custom-endpoint header —
  wave-3 removed the feature, so the test goes with it.

Note: this branch **kept** two upstream fixes wave-3 lacked — the usage-ledger
write is wrapped in `try/catch` (Windows `EPERM` on `settings.json`) and
`cacheReadTokens` is summed per-step via `result.steps`. If the deleted
`router-usage-*` tests are wanted back, they must be re-pointed at the DeepSeek
executor (model id `deepseek-flash`, key env `DEEPSEEK_API_KEY`); do not restore
them verbatim, they exercise the removed custom/openrouter routes.

## 8. Settings panel / model list (informational — likely another agent's path)

Wave-3 pointed the renderer's model list at the live DeepSeek catalogue:
`source/electron-main/main-edge.ts` calls
`listSandEndpointModels({ baseUrl: DEEPSEEK_BASE_URL, apiKey })` for both
`getAvailableModels` and `listInferenceRouterModels`, exposes
`getInferenceApiKeyStatus`, and stores the key under `DEEPSEEK_API_KEY` via
`storedCustomEndpointApiKey`/`secretDeepSeekApiKey` helpers; `preload.ts` and
`shared/rpc/main.ts` gained the matching bridge method.
`source/host/extensions/inference/deepseek-credential.ts` already exports
`deepSeekApiKeyStatus()` for reuse there. Reference:
`git diff origin/main origin/archive/wave-3 -- source/electron-main/main-edge.ts source/electron-main/models/cursor-model-catalog.ts source/electron-preload/preload.ts source/shared/rpc/main.ts`.

## Deliberately not changed here

- Credential **verification** logic is untouched: `deepseek-credential.ts` only
  resolves a key (env → `settings.json` → `box-secrets.json`) and throws the
  Russian missing-key message; it never validates the key against the network.
- The abort-signal, `maxRetries: 0`, temperature and `maxTokens` plumbing is
  wave-3's, extended with upstream's per-step cache accounting and the
  `{ type: "error" }` part rethrow in `runRoutedProviderText`.
