# Wire notes — main report agent ("Отчётный")

Branch: `lite/waveb-main-agent`. Owner paths: `source/host/agents/**`,
`source/shared/agents/**`, `source/host/agent-isolation/**`, this file.

## What this branch already contains (verified)

- `source/shared/agents/main-agent.ts` — `SAND_MAIN_AGENT_ID`
  (`00000000-0000-4000-8000-000000000001`, a fixed uuid so every guard names it
  without a lookup), the seeded Russian profile/instructions constants,
  `SAND_MAIN_AGENT_PURPOSE = "main-agent"` (added to `SAND_AGENT_PURPOSES` in
  `agents.ts`), and `isSandMainAgentId`.
- `source/host/agents/main-agent.ts` — `ensureSandMainAgent(agentsRootDir)`
  (idempotent seed + heal), `isSandProtectedAgentId` /
  `isSandProtectedAgentDir` (the delete-path predicate: fixed id OR
  `"undeletable": true` in `settings.json`), `SandMainAgentSeedError`,
  `SandAgentProtectedError`.
- `source/host/agents/settings-file.ts` — `SandAgentSettings` gained
  `undeletable: boolean` (default `false`); `writeSandSettingsFile` merges it
  like the other flags.
- `source/host/agents/agent-clone.ts` — `cloneAgentDir` now clears
  `undeletable` on the copy: a duplicate of the main agent is a new ordinary
  agent the user can delete.

Verified on this branch with an esbuild-bundled harness against a temp agents
root: `ensureSandMainAgent` produces `profile.json`, `settings.json`
(`undeletable: true`), `instructions.md` and a `store.db` whose KV carries
`agentId`, `origin: "user"`, `purpose: "main-agent"`, seeded metadata; the real
`listAgents` in `session-roster.ts` returns the row (a non-default name
satisfies `hasIdentity`); a second call heals the flag and a missing
`instructions.md` without clobbering an edited `profile.json`; the protection
predicates answer correctly. `tsc -p source/tsconfig.json` is clean.

## Required edits outside owned paths

### 1. Seed call — `source/host/extensions/session/extension.ts`

In `sessionExtension.start`, immediately after the store is constructed:

Anchor (existing line):

```ts
store=context.createStore?.(resolveUserTimeZone)??new SandAgentSessionStore(context.rootDir,resolveUserTimeZone);
```

Add right after it (the file is dense; keep the same formatting style):

```ts
try{ensureSandMainAgent(store.rootDir)}catch(error){context.host.log(`main agent seed failed: ${error instanceof Error?error.message:String(error)}`)}
```

plus the import:

```ts
import { ensureSandMainAgent } from "../../agents/main-agent.js";
```

Why here: the session store's `rootDir` is the agents root
(`~/.grokbot/agents`), and `start` runs before the first roster read, cap
check or `reclaimDanglingAgentDirs` — so the seeded directory (which has a
real `store.db`) is a full citizen from first boot and the reclaim pass skips
it like any other agent. `ensureSandMainAgent` is synchronous and idempotent;
it throws `SandMainAgentSeedError`, hence the try/catch — a seed failure must
not kill the host, only log.

### 2. Delete-path guard — `source/host/extensions/transcript/agent-lifecycle.ts`

This is the single choke point: the `deleteAgents` coordinator command,
`deleteAgent` (it delegates into `deleteAgents`), the dev wiring
(`sand:dev-agents-delete-many`), the loopback gateway and `shared-rooms`
duplicate-room cleanup all funnel through `AgentLifecycle.deleteAgents`.

Imports to add:

```ts
import { isSandProtectedAgentDir, SandAgentProtectedError } from "../../agents/main-agent.js";
```

In `deleteAgents`, anchor:

```ts
    const ids = new Set<string>();
    for (const id of agentIds) ids.add(this.requireAgentId(id, "deleteAgents"));
    if (ids.size === 0) return { transcript: getTranscript() };
```

replace with:

```ts
    const ids = new Set<string>();
    for (const id of agentIds) ids.add(this.requireAgentId(id, "deleteAgents"));
    if (ids.size === 0) return { transcript: getTranscript() };
    // Protected agents leave the request here, before anything builds a path,
    // marks `deletedAgentIds` or opens a handle. The dir check (not the id
    // alone) is what reads the `undeletable` settings flag.
    const protectedAgentIds = [...ids].filter((id) =>
      isSandProtectedAgentDir(this.tm.sessionStore.getAgentDir(id)),
    );
    for (const id of protectedAgentIds) ids.delete(id);
    if (ids.size === 0) throw new SandAgentProtectedError(protectedAgentIds);
```

then in the report assembly near the end of the same method, anchor:

```ts
    const report =
      missing.length === 0 && alreadyDeleted.length === 0
        ? {}
        : {
```

replace with (so callers learn which ids were refused):

```ts
    const report = {
      ...(protectedAgentIds.length === 0
        ? {}
        : { protectedAgentIds }),
      ...(missing.length === 0 && alreadyDeleted.length === 0
        ? {}
        : {
```

Note for the implementer: `SandAgentProtectedError` is a plain `Error`, so
`statusForCommandError` answers `500` today. If a `409`/`403` is wanted, add a
branch for `SandAgentProtectedError` wherever `SandAgentNotFoundError` is
mapped (check `statusForCommandError`'s home — grep shows it referenced in
`agent-lifecycle.ts`, `automation-runtime.ts`, `workflow-commands.ts`).
Not strictly required: the important part is the delete never runs.

### 3. Roster: flag on summaries + first position

`source/host/extensions/session/session-summaries.ts`:

- In `minimalAgentSummary`'s returned literal add `isProtected:false` (keep
  the field present on the fallback shape too).
- In `buildSummary`'s returned literal add:

```ts
isProtected: isSandMainAgentId(extras?.agentId ?? args.dirName) || settings.undeletable,
```

with `import { isSandMainAgentId } from "../../../shared/agents/main-agent.js";`
(verify the relative depth — this file already imports
`../../runner/system-prompt-assembly.js`, so `../../../shared/...` is correct:
`source/host/extensions/session` → `source/shared`).

`source/host/extensions/session/session-roster.ts` — `listAgents` currently
ends:

```ts
return summaries.filter((value):value is Record<string,unknown>=>value!=null).sort((a,b)=>Number(b.updatedAt??0)-Number(a.updatedAt??0))
```

replace the sort with (main agent first, everyone else by recency):

```ts
return summaries.filter((value):value is Record<string,unknown>=>value!=null).sort((a,b)=>Number(isSandMainAgentId(b.id))-Number(isSandMainAgentId(a.id))||Number(b.updatedAt??0)-Number(a.updatedAt??0))
```

with `import { isSandMainAgentId } from "../../../shared/agents/main-agent.js";`.

Bonus worth knowing: `SAND_MAIN_AGENT_ID` sorts first alphabetically too, so
`createFallbackSession`'s `listAgentIds()[0]` picks the report agent — no
edit needed there.

### 4. Renderer: hide the Delete affordance for the protected agent

Two surfaces, pick per owner:

- **Dev/source build** (`frontend/src/production/`): in `model.ts`
  `projectRendererAgents` add `isProtected: value.isProtected === true` to the
  mapped object and the field to `RendererAgent` (`raw` already carries it
  unfiltered for the dist build). Then in `ProductionRenderer.tsx`, the delete
  entry point is
  `onRequestDeleteAgent={(agent) => setDeleteAgent({...})}` (~line 3449): the
  clean fix is inside `ConversationSidebar`'s `AgentRowActions` call —
  `agentRowActions({... includeDelete: onRequestDelete != null && !agent.isProtected ...})`
  — so the menu simply has no Delete item; also withhold
  `onRequestDeleteAgent` if that is simpler at the call site.
- **Shipped renderer** (`src/app/dist`, checksum-pinned): the same check must
  go through `scripts/lib/router-renderer-patch.mjs` (`COMPONENT_SOURCE` /
  a `replaceExactlyOnce` transformation). The dist row's raw summary already
  exposes `isProtected` once edit 3 lands, so the predicate can be
  `agent.raw?.isProtected === true || agent.id === "00000000-0000-4000-8000-000000000001"`.
  Owned by the renderer-patch owner — flag this to them.

Optional product decision: `hiddenFromSidebar` still works on the main agent
(a hidden agent is not a deleted one). If the main agent should also be
un-hideable, extend the same UI gate to `hide-from-sidebar`; backend-wise
nothing forbids hiding today.

### 5. RPC/coordinator — no separate edit needed

`deleteAgents` in `source/shared/rpc/coordinator.ts` /
`coordinator-main.ts` and `main-production-services.ts` all delegate to the
lifecycle method guarded in edit 2. Confirm once wired: a `deleteAgents` call
containing only `SAND_MAIN_AGENT_ID` must reject and leave
`~/.grokbot/agents/00000000-0000-4000-8000-000000000001/` on disk; a mixed
request deletes the rest and reports `protectedAgentIds`.

### 6. Tests to add (tests/ is outside owned paths)

Suggested files, following the repo's conventions (block-comment prologue in
past tense, sentence names, `assert/strict` with a meaning string, esbuild
bundle loaders):

- `tests/main-agent-seed.test.mjs` — seed into a `mkdtemp` agents root:
  asserts `profile.json`/`settings.json`/`instructions.md`/`store.db` exist,
  `store.db` KV (`agentId`, `origin`, `purpose`), `undeletable` reads back
  true, second call heals a cleared flag + missing `instructions.md` without
  touching an edited `profile.json`, and `cloneAgentDir` clears
  `undeletable` on the clone.
- `tests/main-agent-delete-guard.test.mjs` — drive `deleteAgents` (and the
  `deleteAgent` singular) with `SAND_MAIN_AGENT_ID`: expect a throw, the
  directory intact, and no `deletedAgentIds` mark left behind (the roster
  must still list it). A mixed batch deletes the deletable ids and reports
  `protectedAgentIds`.
- `tests/main-agent-roster.test.mjs` — `listAgents` returns the seeded row
  with `isProtected: true` and ordered first even with a newer `updatedAt`
  agent beside it.

## Not done / caveats

- No `archive/wave-3` file contained this mechanism (wave-3 only carried the
  agent-store layout it relies on), so this is a fresh port of the approach
  described in the task, adapted to current `main`.
- The seeded agent counts toward the 50-agent cap (`countOwnedAgents` walks
  directories) — correct: it is a real agent.
- `pinnedAgentIds` seeding was not used for first-position; the roster sort
  in edit 3 is unconditional and survives settings loss. If the product
  prefers pinned-section semantics, `pinnedAgentIds: [SAND_MAIN_AGENT_ID]` in
  `~/.grokbot/settings.json` is the alternative — owned by settings-store.
- The `undeletable` flag is generic: any dir carrying it is protected by the
  same guard. `cloneAgentDir` strips it from copies.
