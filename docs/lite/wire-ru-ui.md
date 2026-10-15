# Wire notes — lite/waveb-ru-ui (Russian-first UI port)

This branch ported `frontend/src/**` (non-CSS, non-theme) from `archive/wave-3`.
The edits below are outside my owned paths and are required for the ported UI to work.
Each entry gives the file, the anchor/old code, the new code, and why.
Reference implementations for most of these exist on `archive/wave-3` — inspect with
`git show archive/wave-3:<path>`.

Sibling agent note: `waveb-deepseek` already ported the inference host stack to
DeepSeek-only on `lite/waveb-deepseek`, and a theme agent owns
`runtime-theme-token-installer.ts` + CSS. Items 1–3 below likely land on their
branches — keep the exact shapes listed here or the renderer will not compile/run.

## 1. Theme: four light variants (theme agent)

### `frontend/src/recovered/features/runtime-theme-token-installer.ts`
Must export, matching `archive/wave-3` verbatim:
- `type RuntimeThemeVariant = "light-white" | "milk" | "smoke" | "sky"`
- `RUNTIME_THEME_CLASS: Readonly<Record<RuntimeThemeVariant, string>>` —
  `"light-white"→"light-white"`, `milk→"milk"`, `smoke→"smoke"`, `sky→"sky"`
- `RUNTIME_THEME_VARIANTS`, `DEFAULT_RUNTIME_THEME_VARIANT = "light-white"`,
  `RUNTIME_THEME_LABELS`, `isRuntimeThemeVariant`, `ThemeDocument`
- `createRuntimeThemeInstaller(document: ThemeDocument, initial: RuntimeThemeVariant)`
  returning `{ update(variant): void; dispose(): void }`

Consumers that now fail typecheck without this:
`frontend/src/production/ProductionRenderer.tsx`,
`frontend/src/recovered/features/window-chrome/model.ts`.

### `source/shared/desktop.ts`
- Old: `SAND_THEME_PREFERENCES = ["system", "light", "dark"]`,
  `DEFAULT_SAND_THEME_PREFERENCE = "system"`
- New (per wave-3): `SAND_THEME_PREFERENCES = ["light-white", "milk", "smoke", "sky"]`,
  `DEFAULT_SAND_THEME_PREFERENCE = "light-white"`, plus `SAND_THEME_LABELS`
  (`light-white: "Белый"`, `milk: "Молочный"`, `smoke: "Дымчатый"`, `sky: "Небо"`).

### `source/electron-main/prefs/theme-controller.ts`
Port wave-3: `SandResolvedTheme = SandThemePreference`,
`WINDOW_BACKGROUND_BY_THEME` gets the four light hexes
(`#FFFFFF / #FBF7F1 / #F2F4F6 / #EFF5FD`), `themeSource` is pinned to `"light"`,
export `themeLabel(theme)`.

### `source/electron-preload/preload.ts` + `source/electron-main` theme handlers
`bridge.theme.initial.{preference,resolved}`, `bridge.theme.set(...)`,
`bridge.theme.onChanged(...)` must carry the four variant strings end to end —
the renderer's `ThemePreference` type is now `"light-white" | "milk" | "smoke" | "sky"`.

## 2. Inference provider: DeepSeek-only (waveb-deepseek likely owns)

### `source/shared/inference-router.ts`
Port wave-3: `SAND_INFERENCE_PROVIDERS = ["deepseek"]`,
`SAND_INFERENCE_PROVIDER`, `DEEPSEEK_BASE_URL = "https://api.deepseek.com"`,
`DEEPSEEK_API_HOSTNAME`, `DEEPSEEK_API_KEY_ENV`, endpoint
normalize/default helpers, and the DeepSeek API-key storage helpers
(`storedDeepSeekApiKey`, `secretDeepSeekApiKey`, `DEEPSEEK_MISSING_KEY_HINT`).

### `source/shared/rpc/main.ts` — `MAIN_METHOD_TABLE`
Add (wave-3 lines ~68–69):
```ts
getInferenceApiKeyStatus: { args: "none" },
setInferenceApiKey: { args: "object" },
```

### `source/electron-preload/preload.ts` — `agent` literal
Add (wave-3 lines ~264–265):
```ts
getInferenceApiKeyStatus: () => edge("getInferenceApiKeyStatus"),
setInferenceApiKey: (apiKey: string) => edge("setInferenceApiKey", { apiKey }),
```

### `source/electron-main/main-edge.ts` — `createMainEdgeHandlers`
Add handlers `getInferenceApiKeyStatus` and `setInferenceApiKey`
(wave-3 lines ~169–170; they need `deps.getInferenceApiKey` /
`deps.setInferenceApiKey` on `MainEdgeDeps`), and add
`apiKeyConfigured: storedDeepSeekApiKey(deps) != null` to the
`getInferenceRouter`/`setInferenceRouter` responses (wave-3 lines ~171, ~179+).
The renderer's `RouterSettingsPanel` reads `endpoint.modelId`,
`apiKeyConfigured`, and `status.message`.

## 3. Attachment limits (`source/`)

### `source/shared/media/attachment-limits.ts`
Required by `frontend/src/recovered/features/conversation/workspace/model.ts`:
- Add `export const ATTACHMENT_COUNT_LIMIT = 20;`

Recommended: port the whole wave-3 file (also adds `DOCUMENT_BYTE_LIMIT`,
`ATTACHMENT_TEXT_CHAR_LIMIT`, `ATTACHMENT_TEXT_TOTAL_CHAR_LIMIT`,
`nameLooksLikeDocument`, `describeAttachmentByteLimitRu`, and a Russian
`formatAttachmentTooLargeNotice`). That version needs the new sibling file
`source/shared/media/attachment-formats.ts` — copy it verbatim from
`archive/wave-3` (its only external dep is `attachmentExtension` from
`attachment-open-policy.ts`, which is identical on both trees).
`frontend/src/recovered/features/conversation/workspace/desktop.ts` imports
`formatAttachmentTooLargeNotice`; main's version still produces an English
sentence — swap in the wave-3 Russian one.

## 4. App identity

### `package.json`
`name` (and `productName` if present) drives `deps.appName`, which is the
window `title` in `source/electron-main/main.ts:300`. Wave-3 uses
`"db-bot-lite"`. Until this changes, the OS window still says the old name
while every in-app string says "DB Bot".

## Deliberate adaptations (not wire notes)

- `frontend/src/recovered/runtime/coordinator-source.ts`: kept
  `getCloudAgentInfo: "cloud_agents"` in `TELEMETRY_DOMAIN_BY_METHOD`.
  Wave-3 deleted it together with the coordinator method itself; on `main`
  the method still exists in `COORDINATOR_METHOD_TABLE` and is still used by
  `cloud-agent-provider.ts`, so the map entry must stay until the method is
  actually removed.
- `PLUGIN_AUTH_PROMPT` in `plugins/overlay/github-auth.ts` stays English on
  purpose: it is the agent-facing instruction prompt, not UI copy.
- `AUTO_REVIEW_STALE_MESSAGE` stays English: it is string-matched against the
  host's error message; changing it silently breaks stale-request detection.
