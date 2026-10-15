# Wire note: trim remote/cloud agent infrastructure (wave B)

Branch: `lite/waveb-trim-cloud`. This file lists every edit needed OUTSIDE the
paths this agent owns. Owned paths were already deleted or adapted on the
branch; the files below are someone else's (or shared) and must be edited by
whoever applies this note.

Porting source: `git fetch origin archive/wave-3`, then
`git diff main origin/archive/wave-3 -- <file>` or
`git show origin/archive/wave-3:<file>`.

IMPORTANT — merge the intent, don't blind-copy: `archive/wave-3` predates
several unrelated `main` fixes and also carries sibling wave-B features
(report tools, attachments-in-prompt, DeepSeek inference, auto-updates,
telemetry opt-in). For each file below, apply ONLY the hunks listed under
"apply"; anything under "skip" is either another agent's scope (cross-referenced)
or an unrelated wave-3 change that must not land.

## Deleted on this branch (owned)

- `source/host/cloud-agents/**`
- `source/host/extensions/cloud-agents/**`
- `source/host/extensions/box-lifecycle/**`
- `source/host/box/box-windows.ts` (X11 fork-window accessor +
  `touchSandMonitorBusyLease`; `ShellAccessor` moved to `box-capabilities.ts`)
- `source/host/box/shared-desktop-sand-box.ts` (`applySharedDesktop` wrapper)
- `source/electron-main/box/egress-tunnel-wiring.ts`
- `source/electron-main/box/local-docker-host-connector.ts`
  (`createSettingsRoutedHostConnector`, `getLocalDockerStatus`,
  `startLocalDockerBox`, `stopLocalDockerBox`)
- `source/electron-main/vnc/**`
- `source/packages/local-exec/computer-use/**`
- `source/shared/node/egress-tunnel/**` (`BoxConnectionInfo`,
  `EgressTunnelController`, `createEgressConnectionObserver` lives elsewhere —
  see below)
- `source/box-exec-daemon/shell-output-text.ts`

## Adapted on this branch (owned, already done)

- `source/host/box/box-capabilities.ts` — now exports `ShellAccessor`
  (`get(resource: typeof shellExecutorResource): ShellExecutor`), relocated
  verbatim from deleted `box-windows.ts`.
- `source/host/box/box-factory.ts` — `createSandBox` returns
  `new LoopbackSandBox(options)` directly; `applySharedDesktop` removed;
  `formatSandBoxStartupSummary` emits "loopback (in-box)" text.
- `source/host/box/loopback-sand-box.ts` — fork-window machinery removed
  (`maxWindows`, `ensureWindow`, `releaseWindow`, `hibernate`,
  `windowConnections`, `SAND_BOX_FORK_*` imports).
- `source/host/box/production.ts` — `sharedDesktop` option is accepted and
  ignored; `createProductionBoxInner` always returns
  `createStandaloneProductionBoxInner(loopback, a => generated.withNoMonitorComputerUse(a))`;
  `ShellAccessor` imported from `./box-capabilities.js`.
- `source/host/box/generated-production.ts` — `ShellAccessor` import retargeted
  to `./box-capabilities.js`.
- `source/electron-main/box/box-host-connector.ts` — `BrokeredHostConnector`
  builds the broker client lazily (first use), exactly as wave-3, so startup no
  longer dies on `CURSOR_BACKEND_DISABLED_MESSAGE` when `SAND_BACKEND_URL` is
  empty.

`SAND_BOX_WORKSPACE_ROOT` already lives in `source/host/box/box-transfer.ts`
on `main` — the retargeted imports below are one-line changes.

`createEgressConnectionObserver` lives in
`source/electron-main/box/remote-connector-egress.ts` (owned, kept) — nothing
to relocate. `GatewayConnection` comes from
`source/electron-main/box/gateway-descriptor-cache.ts` (owned, kept).

---

## Edits by file

### source/host/extensions/extension-ids.generated.ts

Apply: drop `BoxLifecycle: "box-lifecycle"` and `CloudAgents: "cloud-agents"`
from the `HostExtensions` map (keep alphabetical line wrap as in wave-3):
```ts
export const HostExtensions = {
  ActionAudit: "action-audit", Attachments: "attachments", Auth: "auth", AutoReview: "auto-review",
  Automations: "automations", BoxStoreSync: "box-store-sync",
  BrowserUa: "browser-ua", CodebaseTelemetry: "codebase-telemetry",
  ...
```

### source/host/extensions/registry.ts

Apply: in `HOST_EXTENSION_ORDER` delete the `HostExtensions.BoxLifecycle` entry
(after `HostExtensions.Settings`) and the `HostExtensions.CloudAgents` entry
(after `HostExtensions.BoxStoreSync`). Exact target line is the wave-3 version:
`git show origin/archive/wave-3:source/host/extensions/registry.ts`.

### source/host/host-production-extensions.ts

Apply:
- delete `import { boxLifecycleExtension } from "./extensions/box-lifecycle/extension.js";` (~line 11)
- delete `import { cloudAgentsExtension } from "./extensions/cloud-agents/extension.js";` (~line 14)
- delete map entries `[HostExtensions.BoxLifecycle]: bind(boxLifecycleExtension),` and `[HostExtensions.CloudAgents]: bind(cloudAgentsExtension),` in `createRecoveredProductionExtensionRegistry`.

### source/host/extensions/forever-box/extension.ts

Apply the wave-3 edit (one-line function, anchor `createForeverBoxExtension`):
- `dependencies: [HostExtensions.BoxLifecycle, ...]` → drop
  `HostExtensions.BoxLifecycle` from the array.
- `lifecycleClient = context.deps[HostExtensions.BoxLifecycle] as {...}` →
  `lifecycleClient = context.deps[HostExtensions.BoxLifecycle] as {...} | undefined`
  — wave-3 keeps reading the dep but treats it as optional:
  `lifecycleClient = context.deps[HostExtensions.BoxLifecycle] as { recreateInBox(...): Promise<{ started: boolean; reason?: string }>; fetchImageUpdateAvailable(signal: AbortSignal): Promise<boolean | undefined> } | undefined`.
  Exact text: `git show origin/archive/wave-3:source/host/extensions/forever-box/extension.ts` — copy the `createForeverBoxExtension` line verbatim.
- `sharedDesktop: context.host.standaloneBoxExecDaemon !== true` stays (the
  option is accepted-and-ignored on the new `production.ts`).

### source/host/extensions/forever-box/forever-box-service.ts

Apply (anchors; copy verbatim from
`git show origin/archive/wave-3:source/host/extensions/forever-box/forever-box-service.ts`):
- Add constants near the top:
  ```ts
  const LOCAL_BOX_NO_REMOTE_REASON = "no-remote-box";
  const LOCAL_BOX_RECREATE_MESSAGE = "This computer runs on your own machine. There is no remote copy to update or reset, so nothing was changed.";
  ```
- Make `lifecycleClient` optional in the options interface (`lifecycleClient?:`).
- In `recreate(...)`: after `requestRecreate`, add
  `if (!result.started && result.reason === LOCAL_BOX_NO_REMOTE_REASON) throw new SandForeverBoxError(LOCAL_BOX_RECREATE_MESSAGE);`
- Split out `requestRecreate(options)` which does the flush wait then returns
  `{ started: false, reason: LOCAL_BOX_NO_REMOTE_REASON }` when
  `this.options.lifecycleClient == null`, else `lifecycle.recreateInBox(options)`.
- In `refreshImageUpdateAvailable`, after the `isInBox` check add:
  `if (this.options.lifecycleClient == null) { this.reportImageCheck({ trigger, outcome: "skipped", durationMs: this.elapsedSince(startedAt), skipReason: LOCAL_BOX_NO_REMOTE_REASON }); return { outcome: "skipped" }; }`
  and change the later use to `this.options.lifecycleClient!.fetchImageUpdateAvailable(signal)`.

### source/host/runner/remote-box-resources.ts

Apply:
- line ~38: delete the whole import
  `import { touchSandMonitorBusyLease, type ShellAccessor } from "../box/box-windows.js";`
  (`ShellAccessor` is only used by the removed call).
- in `createRemoteBoxResourceAccessor`, delete the call block (~lines 261-264):
  ```ts
  await touchSandMonitorBusyLease(
    context,
    connection.remoteAccessor as ShellAccessor,
    windowIndex,
  );
  ```
  Keep the preceding `getOrCreateNavigationProbe()?.captureBaseline(...)` call —
  wave-3 keeps it.

### source/host/runner/prompt-collector-glue.ts

Apply ONLY the import retarget:
```ts
-import { SAND_BOX_WORKSPACE_ROOT } from "../cloud-agents/cloud-agent-images.js";
-import { downloadBoxFiles, type TransferBox } from "../box/box-transfer.js";
+import { downloadBoxFiles, SAND_BOX_WORKSPACE_ROOT, type TransferBox } from "../box/box-transfer.js";
```
Skip: wave-3 also adds `attachmentFormatOf`, `readAttachmentDocuments`,
`documentPathsForPrompt`, `buildAttachedDocumentsNote` — that is the
waveb-attachments feature (see its wire note, not this one).

### source/host/runner/tools/turn-toolset.ts

Apply ONLY the cloud hunks (the report-tools hunks in the same diff belong to
`docs/lite/wire-report-tools.md` — apply both sets, they do not overlap):
- `import { SAND_BOX_WORKSPACE_ROOT } from "../../cloud-agents/cloud-agent-images.js";`
  → `import { SAND_BOX_WORKSPACE_ROOT } from "../../box/box-transfer.js";`
- delete `import { createCloudAgentTool, type CloudAgentToolDeps } from "../../cloud-agents/cloud-agent-tool.js";` (~line 110)
- in `SAND_FORCED_STATIC_TOOL_NAMES` (~line 164) delete the
  `CLOUD_AGENT: "Launch and manage Cursor cloud coding agents for repository work."` entry.
- `ToolFactoryContext`: delete `readonly cloudAgent: string;` (~line 953).
- `TurnToolFactories`: delete `cloudAgent?(): TurnTool;` (~line 968 region).
- delete `interface TurnCloudAgentToolFactoryInput` (~line 1103).
- `TurnToolsetFactoryInputs`: delete `readonly cloudAgent?: TurnCloudAgentToolFactoryInput;`.
- `TurnToolsetHostFactoryProvider`: delete `readonly createCloudAgentToolInputs?: (...) => TurnCloudAgentToolFactoryInput;`.
- delete `export function createTurnCloudAgentToolFactory(...)` (~line 1494).
- `createTurnToolsetFactories`: drop `"cloudAgent"` from the keyof union
  (`| "mcpManagement" | "cloudAgent"` → `| "mcpManagement"`) and delete the
  `...(input.cloudAgent === undefined ? {} : { cloudAgent: createTurnCloudAgentToolFactory(input.cloudAgent) })` spread (~line 1601).
- `createTurnToolsetFactoriesForTurn`: delete the
  `...(provider.createCloudAgentToolInputs === undefined ? {} : { cloudAgent: provider.createCloudAgentToolInputs(turn, props) })` spread (~line 1696).
- `TurnToolsetHost` interface: delete `cloudAgentsDisabledByTeam(): boolean;` (~line 1715).
- `buildTurnTools`: delete the cloud-agent tool block (~line 1901):
  ```ts
  && !host.cloudAgentsDisabledByTeam()
  const cloudAgent = factories.cloudAgent?.();
  if (cloudAgent !== undefined) tools.push(cloudAgent);
  ```
  (see wave-3 hunk `@@ -1901,14 +1923,6 @@`).

### source/host/runner/turn-agent-composition.ts

Apply:
- delete `import type { CloudAgentToolDeps } from "../cloud-agents/cloud-agent-tool.js";` and the `import type { BackgroundWatchesHost } from "./background-work.js";` line IF it becomes unused (wave-3 deletes both — check other uses).
- delete the whole block `export type TurnCloudAgentTool` through
  `createTurnCloudAgentFactory` (~lines 829-888 on main): `TurnCloudAgentTool`,
  `TurnCloudAgentReviewAction`, `TurnCloudAgentWatch`, `TurnCloudAgentWatcher`,
  `TurnCloudAgentProjectionInput`, `TurnCloudAgentProjection`,
  `createTurnCloudAgentProjection`, `createTurnCloudAgentFactory`.
- hunk `@@ -1446,25` and `@@ -1492,10`: wave-3 removes cloud-agent projection
  plumbing inside `createTurnSubagentLaunchReviewer` region — copy the wave-3
  hunk (`git diff main origin/archive/wave-3 -- source/host/runner/turn-agent-composition.ts`).

### source/host/runner-production-bridge.ts

Apply:
- delete `import type { CloudAgentApi, CloudAgentToolContext, CloudAgentToolDeps } from "./cloud-agents/cloud-agent-tool.js";` and `import type { BackgroundWatchesHost } from "./runner/background-work.js";` (only if unused afterwards).
- `ProductionTurnToolsetHostInput`: delete `readonly cloudAgentsDisabledByTeam: () => boolean;`.
- `createProductionTurnToolsetHost`: delete `cloudAgentsDisabledByTeam: input.cloudAgentsDisabledByTeam,`.
- `ProductionTurnHostDependencies`: delete the whole `readonly cloudAgent?: {...}` member.

### source/host/host-runner-composition.ts

Apply (anchors — all hunks are in the wave-3 diff
`git diff main origin/archive/wave-3 -- source/host/host-runner-composition.ts`;
apply ONLY hunks touching the symbols below):
- imports: delete `CloudAgentApi, CloudAgentToolContext, CloudAgentToolDeps`
  import (~line 35), `TurnCloudAgentToolFactoryInput` from the
  turn-toolset import list, and the whole
  `import { buildSandCloudAgentRiskTarget, ..., SAND_CLOUD_AGENT_CLASSIFIER_ERROR_REASON } from "./runner/sand-cloud-agent-auto-review.js";` (~line 147).
- delete `function isCloudAgentApi(api: DynamicApi): api is CloudAgentApi` (~line 1081).
- delete `interface RunnerCloudWatchOwner` and `function createRunnerCloudWatch(...)` (~lines 1093-1150).
- delete `const cloudAgents = extensions.api("cloud-agents");` (~line 1251).
- delete `resolveCloudAgentTitle` and `awaitCloudAgent` consts (~line 1567).
- delete the `...(awaitCloudAgent === undefined ? {} : { cloudAgentWatcher: { awaitCompletion: ... } })` spread (~line 1808).
- delete `resolveCloudAgentTitle,` from the deps object (~line 1885).
- delete the whole `cloudAgent` deps block starting
  `const watchCloudAgent = createRunnerCloudWatch(builtRunner); const cloudAgent = (() => {`
  through its closing `})()` (~lines 2138-2256), INCLUDING the
  `const uploadFile = method(remoteBox, "uploadFile"); const downloadFile = method(remoteBox, "downloadFile");`
  lines at the top of that hunk ONLY IF they are used exclusively by the cloud
  block — check other uses of `uploadFile`/`downloadFile` in the function before
  deleting (wave-3 deletes them; verify).
- delete `...(cloudAgent === undefined ? {} : { cloudAgent }),`.
- delete `const cloudAgent = dependencies.cloudAgent;` (~line 2464).
- delete the `createCloudAgentToolInputs` provider block (~line 2639,
  `...(!isSharedRoomTurn && cloudAgent !== undefined ? { createCloudAgentToolInputs: ... } : {})`).
- in the `autoReviewModes` fallback literal (~line 2787) delete
  `cloudAgent: "off",`. NOTE: `SandAutoReviewModes.cloudAgent` is still a
  required field in `runner/sand-auto-review.ts` (wave-3 keeps it — the surface
  enum is shared with the classifier). If `tsc` complains about the literal,
  keep `cloudAgent: "off"` — it is dead weight but type-correct. Wave-3 removed
  it, so the field is probably optional there; reconcile with whichever the
  merged type demands.
- delete `cloudAgentsDisabledByTeam: () => method(experiments, "isCloudAgentsDisabledByTeam")?.() ?? false,` (~line 2825) from the toolset host input.
- The `TS7006` errors at lines 1140, 2154, 2185 resolve once the cloud block and
  `createRunnerCloudWatch` are gone.

Skip in this file (sibling scopes): `resolveReportSkillsDir` import,
`createReportToolInputs`, `readAttachmentDocuments` /
`readAttachmentDocumentsNote` hunks — those are waveb-report-tools and
waveb-attachments edits.

### source/host/gateway-protocol.ts

Apply: delete `getCloudAgentInfo: (api, body) => api.getCloudAgentInfo(parseCommandArgs(body)),` (~line 112).

### source/host/host-gateway-api.ts

Apply ONLY hunk `@@ -1278`: delete the `getCloudAgentInfo` handler:
```ts
-    // `POST /api/getCloudAgentInfo {}` and `{"includeFiles":true}` answered ...
-    getCloudAgentInfo: (args: any) =>
-      method(deps.extensions.api("cloud-agents"), "getInfo")(
-        requireText(args, "bcId", "getCloudAgentInfo"), ...
```
SKIP every other hunk in the wave-3 diff of this file — they revert unrelated
`main` fixes (`requireOneOf`, `SAND_LOCAL_TOOL_RESOLUTIONS`,
`SAND_AUTO_REVIEW_RESOLUTIONS`, careful delete bookkeeping in `deleteAgents`,
conversation-cache changes). wave-3's file predates those fixes.
Also check: does `GatewayApi`'s interface declare `getCloudAgentInfo`? If the
method is declared on the api interface in this file or a sibling, delete the
declaration too (wave-3's file has no `getCloudAgentInfo` — grep wave-3 for it:
`git show origin/archive/wave-3:source/host/host-gateway-api.ts | grep -n getCloudAgentInfo` → nothing).

### source/host/runner/sand-cloud-agent-auto-review.ts

Recommend DELETING this file: after the host-runner-composition edits nothing
imports it (its only importer was the removed block). wave-3 kept it but unused;
deleting is cleaner and keeps the auto-review surface honest. Not owned —
confirm with the integrator before deleting. If kept, it must still compile:
it imports only from sibling runner files and packages — verify no import of
`../cloud-agents/*` remains (check `git grep cloud-agents -- source/host/runner/sand-cloud-agent-auto-review.ts`).

### source/box-exec-daemon/server.ts

Apply ONLY the decoder-removal hunks (anchors below). SKIP the hunks that revert
`withShellTextEnv`, `windowsVerbatimArguments`, and `killProcessTree` — those are
newer `main` fixes wave-3 predates and must stay.

- imports (~line 14-20): delete
  `import { createShellOutputDecoder, resolveConsoleCodePageLabel } from "./shell-output-text.js";`
- `BoxExecRuntime`: delete `#consoleCodePageLabel` field + the
  `consoleCodePageLabel?: string` ctor param (~lines 570-578).
- in the spawn/output wiring (~lines 745-768): replace
  `const stdoutDecoder = createShellOutputDecoder(this.#consoleCodePageLabel); const stderrDecoder = ...`
  and the `child.stdout.on("data", ...)`/`stderr` handlers with wave-3's
  `child.stdout.on("data", data => { events.push({ case: "stdout", data: String(data) }); notify(); });` (same for stderr), and simplify the `close` handler to
  `child.once("close", (code, childSignal) => { exitCode = code ?? 1; exitSignal = childSignal ?? ""; done = true; notify(); });`
  (drops the decoder flush loop).
- in `run()` (~lines 1178-1205 region): delete the per-channel decoder setup if
  present there too (wave-3 hunk `@@ -1205,28 +1178,6 @@`).
- in `startBoxExecDaemon` (~line 1246): drop the `resolveConsoleCodePageLabel(...)`
  argument passed to the `BoxExecRuntime` constructor (wave-3 hunk
  `@@ -1359,7 +1246,7 @@`).
- NOTE: removing the decoder means non-UTF8 console output is lossy again —
  acceptable for Lite, but if the encoding fix is wanted, `shell-output-text.ts`
  must be un-deleted instead (it is owned; flag to integrator). The two
  `box-exec-daemon` tests below encode that trade-off.

### source/electron-main/main-edge.ts

Apply (anchors; skip ALL inference/DeepSeek hunks — waveb-deepseek scope):
- delete `import { getLocalDockerStatus, startLocalDockerBox, stopLocalDockerBox } from "./box/local-docker-host-connector.js";`
- add after the theme-unavailable constants (verbatim from wave-3):
  ```ts
  const LOCAL_BOX_RUNTIME = "remote" as const;
  const LOCAL_BOX_RUNTIME_STATUS = Object.freeze({
    available: true, running: true, ready: true,
    containerName: "", image: "",
    detail: "The agent's computer is this computer. There is no virtual machine and no remote box.",
  });
  ```
  and
  ```ts
  const EGRESS_TUNNEL_OFF_STATUS = Object.freeze({ state: "off", relayedStreams: 0, activeStreams: 0 });
  ```
  (keep the existing `MAIN_EDGE_EGRESS_TUNNEL_UNAVAILABLE` export — wave-3 keeps it).
- `MainEdgeDeps`: delete `readonly readEgressTunnelController: () => UnknownRecord | null;` and
  `readonly emitEgressTunnelChanged: (enabled: boolean) => void;`.
- delete the `function egressController(deps)` helper (~line 77).
- handlers: replace
  `getBoxRuntime`/`setBoxRuntime` bodies with wave-3's stubs:
  `getBoxRuntime: async () => ({ mode: LOCAL_BOX_RUNTIME, status: LOCAL_BOX_RUNTIME_STATUS })`,
  `setBoxRuntime: async (raw) => { const mode = req(raw).mode; invariant(isSandBoxRuntime(mode), "Unknown box runtime."); return { mode: LOCAL_BOX_RUNTIME, status: LOCAL_BOX_RUNTIME_STATUS }; }`
- replace the three egress handlers:
  `getEgressTunnelEnabled: () => false, setEgressTunnelEnabled: () => false, getEgressTunnelStatus: () => EGRESS_TUNNEL_OFF_STATUS,`
  (delete the `invoke(deps.boxToggleStore, "getEgressTunnelEnabled")` /
  `egressController(deps)` bodies).
- `openCloudAgent` handler stays (wave-3 keeps it; the renderer may still call it).

### source/electron-main/main.ts  (weak-machine / GPU-off startup)

Apply (this is the GPU-off / low-memory block the task asks for — copy verbatim
from `git show origin/archive/wave-3:source/electron-main/main.ts`):
- `ElectronMainApp.commandLine`: `appendSwitch: (name: string) => void` →
  `appendSwitch: (name: string, value?: string) => void`.
- `MainBrowserWindowOptions.webPreferences`: add `readonly spellcheck: false;`.
- add the whole `// Слабый компьютер` section:
  `WEAK_MACHINE_MAX_OLD_SPACE_MB = 1536`, `WEAK_MACHINE_MAX_SEMI_SPACE_MB = 4`,
  `WEAK_MACHINE_DISABLED_FEATURES = ["CalculateNativeWinOcclusion","BackForwardCache","MediaRouter","WebGPU"].join(",")`,
  `interface WeakMachineSwitch`, `collectWeakMachineSwitches(env)`
  (honors `DB_BOT_DISABLE_WEAK_SWITCHES=1` and `DB_BOT_GPU_MODE=hardware`),
  `applyWeakMachineSwitches({app, env})` which calls
  `disableHardwareAcceleration()` when `disable-gpu` is in the list.
- in `startElectronMain`: replace
  `deps.app.disableHardwareAcceleration(); deps.app.commandLine.appendSwitch("no-sandbox"); deps.app.commandLine.appendSwitch("disable-gpu");`
  with
  `deps.app.commandLine.appendSwitch("no-sandbox"); applyWeakMachineSwitches({ app: deps.app, env });`
- in window creation `webPreferences`: add `spellcheck: false`.

SKIP in this file: the `import { startAutomaticUpdates }` and the
`void startAutomaticUpdates({...})` call hunks — separate wave-3 feature, not
the trim (auto-updates are wired elsewhere if needed).

NOTE: `services.configureVncTrust?.()` and
`services.hardenVncWebviewAttach?.(window.webContents)` stay — the services
type in this file still declares them optional; the implementation stops
providing them (see main-production-services below). wave-3 keeps those call
sites unchanged.

### source/electron-main/main-production-services.ts

Apply (anchors; skip the `SAND_DISABLE_TELEMETRY`→`SAND_ENABLE_TELEMETRY` flip
and the `fetchSandAvailableModels`→`SAND_CURSOR_MODEL_CATALOG_DISABLED_MESSAGE`
hunk — telemetry opt-in and DeepSeek are separate wave-3 changes):
- imports: delete
  `import { createSettingsRoutedHostConnector } from "./box/local-docker-host-connector.js";`,
  `import { createEgressTunnelWiring } from "./box/egress-tunnel-wiring.js";`,
  `import type { BoxConnectionInfo } from "../shared/node/egress-tunnel/box-connection.js";`,
  `import type { EgressTunnelController } from "../shared/node/egress-tunnel/egress-tunnel-controller.js";`,
  `import { registerElectronProductionVncTrust, type ElectronProductionVncTrustDeps } from "./vnc/vnc-trust.js";`
  and add `import type { GatewayConnection } from "./box/gateway-descriptor-cache.js";`.
  (`createEgressConnectionObserver` is already imported from
  `./box/remote-connector-egress.js`, which survives.)
- `ProductionServiceContext`: `connectorEgress` type arg `BoxConnectionInfo` →
  `GatewayConnection`; delete `readonly requireEgressTunnelController: () => EgressTunnelController;`
  and `readonly createVncTrust: (...) => ReturnType<typeof registerElectronProductionVncTrust>;`.
- `createEgressConnectionObserver<BoxConnectionInfo>()` → `<GatewayConnection>()`.
- `ProductionClientPauseControl` type alias + `createSandClientPauseControl<BoxConnectionInfo,...>` →
  `GatewayConnection`.
- the big `let` declaration: drop `egressTunnelController` and `vncTrust`
  variables.
- `createRemoteHostConnector` call: remove the
  `createSettingsRoutedHostConnector(... , requireValue(settings, "settings").settingsStore)` wrapper —
  call `createRemoteHostConnector(...)` directly (wave-3 hunk `@@ -644,12`).
- context assembly: delete `requireEgressTunnelController: () => requireValue(egressTunnelController, "egress-tunnel"),`.
- delete the `createVncTrust: (routeHostInput) => {...}` context member (~hunk `@@ -738,22`).
- service wiring (~hunk `@@ -807,11`): delete
  `vncTrust = requireValue(context, "context").createVncTrust(options.routeHostInput);`
  and change `getVncTokenInfo: (host) => vncTrust?.getTokenInfo(host)` →
  `getVncTokenInfo: () => undefined`.
- delete the `egressTunnelController = createEgressTunnelWiring({...})` block (~line 824).
- service fields (~hunk `@@ -863,10`): delete `configureVncTrust:` and
  `hardenVncWebviewAttach:` entries from the returned service object (the
  `onWindowCreated` field stays).
- the three `TS7006` errors (lines ~746, ~753, ~826) resolve once the VNC/egress
  code is gone.

### source/electron-main/prefs/settings-ipc.ts

Apply wave-3 verbatim (whole file; it is one function):
```ts
const EGRESS_TUNNEL_OFF_STATUS = Object.freeze({ state: "off", relayedStreams: 0, activeStreams: 0 });
export function registerSettingsIpc(deps: { readonly ipcMain: SyncIpc; readonly settingsStore: { getWebauthnProxyEnabled(): unknown }; readonly themeController: { getState(): unknown } }): void {
  deps.ipcMain.on("sand:theme-get-sync", (event) => { event.returnValue = deps.themeController.getState(); });
  deps.ipcMain.on("sand:egress-tunnel-get-sync", (event) => { event.returnValue = false; });
  deps.ipcMain.on("sand:egress-tunnel-status-get-sync", (event) => { event.returnValue = EGRESS_TUNNEL_OFF_STATUS; });
  deps.ipcMain.on("sand:webauthn-proxy-get-sync", (event) => { event.returnValue = deps.settingsStore.getWebauthnProxyEnabled(); });
}
```
(drops `egressTunnelController` dep + `getEgressTunnelEnabled` store call;
channels stay registered because `production-ipc-contract.ts` lists them and
`preload.ts` calls them at construction — no changes needed in either.)

### source/electron-main/adapters/ipc.ts

Apply hunk `@@ -58`: delete `egressTunnelController: context.requireEgressTunnelController(),`
from the `registerSettingsIpc({...})` call and update the doc comment to
`/** Settings registration. The egress-tunnel channel stays, and always answers "off". */`.

### source/electron-main/adapters/main-rpc.ts

Apply:
- delete the `readEgressTunnelController: () => {...}` property (~lines 81-92 region).
- delete `emitEgressTunnelChanged: (enabled) => context.requireMainEdge().emit("egress-tunnel-changed", enabled),`.
Skip: `getInferenceApiKey`/`setInferenceApiKey` Pick members and impl (deepseek scope).

### source/electron-main/adapters/coordinator-gateway.ts

Apply:
- `import type { BoxConnectionInfo } from "../../shared/node/egress-tunnel/box-connection.js";` →
  `import type { GatewayConnection } from "../box/gateway-descriptor-cache.js";`
- delete `import { createSettingsRoutedHostConnector } from "../box/local-docker-host-connector.js";`
- in both binding blocks: `createSettingsRoutedHostConnector(createRemoteHostConnector(...), context.settings.settingsStore)` →
  `createRemoteHostConnector(...)`, and `BoxConnectionInfo` → `GatewayConnection`
  in the `connect()` annotations/casts.

### source/electron-main/dev/dev-box-recreate-plane.ts

Apply: `BoxConnectionInfo` import → `GatewayConnection` from
`../box/gateway-descriptor-cache.js`; `connect(): Promise<BoxConnectionInfo>` →
`Promise<GatewayConnection>`.

### source/electron-main/coordinator/production-provider.ts

Apply: same `BoxConnectionInfo`→`GatewayConnection` import swap and the
`baseConnector.connect() as BoxConnectionInfo` cast → `as GatewayConnection` (~line 356).

### source/electron-main/production-ipc-contract.ts

No change. Channels stay registered (stubs answer "off").

### source/electron-preload/preload.ts

No change needed — wave-3 keeps every wrapper (`egressTunnel`,
`reportVncSession`, `onVncUserPresence`, `openCloudAgent`) since the sync IPC
channels and edge methods all still exist and now answer "off"/stub values.

---

## Tests and scripts (do not fix on this branch — listed for the merge)

Tests that import deleted modules or exercise removed surfaces:

- `tests/box-exec-daemon-command-line-fidelity.test.mjs` — imports
  `shell-output-text.js` (~line 53). Options: delete the decoder-specific
  cases, or keep the file if `shell-output-text.ts` is un-deleted (see
  server.ts note).
- `tests/box-exec-daemon-child-text-encoding.test.mjs` — same dependency.
- Cloud/VNC/computerUse-flavored tests whose expectations reference deleted
  dirs (grep hits): `forever-box-recreate-honesty`, `local-box-connection`,
  `honest-toolset-prompt`, `prompt-matches-real-tools`,
  `routed-provider-self-description`, `router-bridge-round-trip`,
  `settings-file-write-integrity`, `stopped-exec-stream-must-not-leave-the-command-running`,
  `subagent-configs-and-limits`, `parent-stop-must-stop-every-subagent`,
  `publication-packaging`, `turn-*` tests mentioning cloud agent tools.
  Most only need expectation updates (tool lists no longer contain
  CLOUD_AGENT, etc.) — check each against wave-3's tests dir if it has
  counterparts: `git ls-tree -r origin/archive/wave-3 --name-only tests/`.
- `scripts/host-production-activation.mjs` and
  `manifests/reconstruction/runner-parity-audit.json` reference
  `applySharedDesktop`, `ports.extensionHost.boxGenerated`,
  `convertCloudAgentConversationToTrace`, `cloud-agents` specifiers as audit
  anchors. wave-3 left them unchanged (they are evidence manifests, not
  compiled code) — update anchors in a follow-up if the audit is re-run.

## Current tsc errors (all out-of-scope, each mapped above)

```
source/box-exec-daemon/server.ts(20) — ./shell-output-text.js
source/electron-main/adapters/coordinator-gateway.ts(12,13) — egress-tunnel/box-connection.js, local-docker-host-connector.js
source/electron-main/coordinator/production-provider.ts(46) — box-connection.js
source/electron-main/dev/dev-box-recreate-plane.ts(10) — box-connection.js
source/electron-main/main-edge.ts(13) — local-docker-host-connector.js
source/electron-main/main-production-services.ts(8,14,15,16,46) — local-docker, egress-tunnel-wiring, box-connection, egress-tunnel-controller, vnc-trust
source/electron-main/main-production-services.ts(746,753,826) — implicit any (resolve with the removals)
source/host/host-production-extensions.ts(11,14) — box-lifecycle, cloud-agents extensions
source/host/host-runner-composition.ts(38) + TS7006/TS7031 at 1140,2154,2185 — cloud-agent-tool.js + downstream
source/host/runner-production-bridge.ts(87) — cloud-agent-tool.js
source/host/runner/prompt-collector-glue.ts(16) — cloud-agent-images.js
source/host/runner/remote-box-resources.ts(38) — box-windows.js
source/host/runner/tools/turn-toolset.ts(33,110) — cloud-agent-images.js, cloud-agent-tool.js
source/host/runner/turn-agent-composition.ts(38) — cloud-agent-tool.js
```
No errors inside the owned paths.
