import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// The app still shipped as a Cursor client with a local mode bolted on. Three
// coupled defaults kept it that way and nothing threw, so nothing looked broken:
// the `sand_product_analytics` gate defaulted to true and every host start
// posted an event to api2.cursor.sh with no account; every feature gate pinned
// through `pinGateOnAuthenticatedBootstrap` stayed dead forever because a
// signed-out host can never complete an authenticated Statsig bootstrap; and both
// readers of the routing decision fell back to the "cursor" provider, so a fresh
// install sent every turn to an account-backed endpoint that can never answer.
// The renderer then opened the Router settings on "Cursor" and mounted the
// Cursor billing panel. A fatal startup failure compounded it: it was reported
// to telemetry only, so a host that could not reach Cursor exited 1 with nothing
// on stderr at all.
//
// These tests pin the local behaviour. The two that matter most are the ones
// that observe an outbound client never being constructed and a gate callback
// firing with no network at all: a default read out of a file proves nothing.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ANALYTICS_ENV_NAMES = ["SAND_DISABLE_TELEMETRY", "SAND_DISABLE_ANALYTICS"];

const savedEnv = {};
for (const name of ANALYTICS_ENV_NAMES) {
  savedEnv[name] = process.env[name];
  delete process.env[name];
}
test.after(() => {
  for (const name of ANALYTICS_ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-local-only-"));
  const names = [];
  for (const entry of entries) {
    const name = `${entry.at(-1).replace(/\.ts$/, "")}.mjs`;
    names.push([name, path.join(directory, name)]);
    await build({
      entryPoints: [path.join(repoRoot, "source", ...entry)],
      outfile: path.join(directory, name),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
      // The analytics client reaches undici, which is CommonJS and calls
      // `require("assert")` from inside the bundle. Defining `require` for the
      // emitted ESM is what lets that interop resolve; without it the whole
      // product-analytics import dies on "Dynamic require of assert".
      banner: { js: 'import { createRequire as __sandCreateRequire } from "node:module"; const require = __sandCreateRequire(import.meta.url);' },
    });
  }
  const loaded = {};
  for (const [name, file] of names) loaded[name] = await import(pathToFileURL(file).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["shared", "node", "experiments", "experiment-config.gen.ts"],
  ["shared", "node", "experiments", "cursor-experiments.ts"],
  ["shared", "node", "analytics", "product-analytics.ts"],
  ["shared", "node", "settings", "sand-settings-store.ts"],
]);
test.after(() => dispose());

const { FLAGS } = loaded["experiment-config.gen.mjs"];
const { SandExperimentService } = loaded["cursor-experiments.mjs"];
const { SandProductAnalytics } = loaded["product-analytics.mjs"];
const store = loaded["sand-settings-store.mjs"];

function scratch() {
  return mkdtempSync(path.join(os.tmpdir(), "grok-local-only-case-"));
}

test("the product-analytics gate defaults to off in the shipped flag table", () => {
  assert.equal(
    FLAGS.sand_product_analytics.default,
    false,
    "the bundled default is the only value a signed-out host can ever read, so a true here ships an analytics event on every start",
  );
});

test("a signed-out host never constructs an analytics client, even with the gate readable", async () => {
  const cacheDir = scratch();
  let clientBuilt = 0;
  let tokensRequested = 0;
  const analytics = new SandProductAnalytics({
    hostInBox: false,
    getAccessToken: async () => {
      tokensRequested += 1;
      return "";
    },
    getMachineId: async () => "machine-local",
    createClient: () => {
      clientBuilt += 1;
      return { trackEvents: async () => undefined };
    },
  });
  // A gate that answers the bundled default, exactly as `checkFeatureGate` does
  // when no Statsig client has ever been hydrated.
  const gate = { checkGate: async (name) => FLAGS[name]?.default ?? false, subscribe: () => () => {} };
  await analytics.activate(gate);
  try {
    assert.equal(analytics.state.kind, "disabled", "analytics is opt-in now: with no SAND_ENABLE_TELEMETRY the client must never be built, so nothing can reach api2.cursor.sh");
    assert.equal(clientBuilt, 0, "no AnalyticsService client may be constructed, because that is the call that reaches api2.cursor.sh");
    assert.equal(tokensRequested, 0, "no credential may be requested on the way to an endpoint the user never opted into");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a gate pinned at host startup fires with no authenticated bootstrap and no network", () => {
  const cacheDir = scratch();
  let tokenRequests = 0;
  const service = new SandExperimentService({
    getAccessToken: async () => {
      tokenRequests += 1;
      return "";
    },
    getMachineId: async () => "machine-local",
    getCacheDir: () => cacheDir,
    // The packaged-build shape: overrides are disabled, so the bundled default
    // is the only value any reader can see.
    isDevBuild: false,
  });
  const pinned = [];
  let pinCalls = 0;
  try {
    assert.equal(
      service.hasAuthenticatedStatsigBootstrap(),
      false,
      "no Statsig bootstrap has run, which is the state a signed-out host is stuck in permanently",
    );
    service.pinGateOnAuthenticatedBootstrap("sand_stale_root_gc", (value) => {
      pinCalls += 1;
      pinned.push(value);
    });
    assert.ok(pinCalls > 0, "the pin callback must fire at startup; the old code only ever fired it from an authenticated bootstrap that never arrives locally");
    assert.equal(tokenRequests, 0, "resolving a bundled default must not touch the network for a credential");
    assert.deepEqual(
      pinned,
      [FLAGS.sand_stale_root_gc.default],
      "the pin must carry the bundled default, which is the only value a local host can read",
    );
    assert.equal(FLAGS.sand_stale_root_gc.default, true, "stale checkpoint-root cleanup is guarded, runs once per store, and is the one dead gate safe to switch on");
  } finally {
    service.dispose();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("the three flags that can newly fail the user stay off in the shipped flag table", () => {
  assert.equal(
    FLAGS.grok_bot_conversation_gc.default,
    false,
    "conversation GC can throw SandConversationTooLargeError, a failure mode the user has never seen; it needs its own change",
  );
  assert.equal(
    FLAGS.sand_legacy_store_blob_retirement.default,
    false,
    "legacy blob retirement deletes rows from store.db and has never run in a shipped build",
  );
  assert.equal(
    FLAGS.sand_memory_dreaming.default,
    false,
    "memory dreaming calls the inference provider from the memory service and spends tokens on every session",
  );
});

test("a settings file with no routing key reads as the user's own endpoint", () => {
  const directory = scratch();
  try {
    const settings = new store.SandSettingsStore(path.join(directory, "settings.json"));
    assert.equal(
      settings.getInferenceProvider(),
      "deepseek",
      "a fresh install has no settings.json, and the default route must be DeepSeek",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an existing settings file without the routing key is migrated onto the user's own endpoint", () => {
  const directory = scratch();
  const settingsPath = path.join(directory, "settings.json");
  try {
    // A file written by a build that predates the local provider: the old
    // migration id is present, so the store's old early-return would have
    // skipped every migration added afterwards.
    writeFileSync(
      settingsPath,
      JSON.stringify({
        ...store.emptySettings(),
        settingsMigrations: ["downgrade-persisted-max-fast"],
      }),
      "utf8",
    );
    const settings = new store.SandSettingsStore(settingsPath);
    assert.equal(
      settings.getInferenceProvider(),
      "deepseek",
      "a store that already carries the first migration id must still receive the provider migration",
    );
    const onDisk = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(
      onDisk.inferenceProvider,
      "deepseek",
      "the migration has to persist the key, or every later read falls back again",
    );
    assert.deepEqual(
      onDisk.settingsMigrations,
      ["downgrade-persisted-max-fast", "local-inference-provider", "deepseek-only"],
      "the migration id must be recorded exactly once so a second load is a no-op",
    );
    const second = new store.SandSettingsStore(settingsPath);
    assert.equal(second.getInferenceProvider(), "deepseek", "a migrated store stays on DeepSeek across reloads");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a provider choice left by an older build is rewritten onto DeepSeek", () => {
  const directory = scratch();
  const settingsPath = path.join(directory, "settings.json");
  try {
    // `openrouter` was a real choice once. It is not a provider any more, so it must not
    // survive the load: a turn would be routed into an account-backed endpoint that can
    // never answer, which is exactly the defect this file was opened for.
    // A file written by an older build: no `settingsMigrations` key at all, because the
    // current ids did not exist yet, and an endpoint on someone else's host.
    writeFileSync(
      settingsPath,
      JSON.stringify({
        version: 1,
        inferenceProvider: "openrouter",
        inferenceCustomEndpoint: { baseUrl: "https://openrouter.ai/api/v1", modelId: "openrouter-model-777" },
      }),
      "utf8",
    );
    const settings = new store.SandSettingsStore(settingsPath);
    assert.equal(
      settings.getInferenceProvider(),
      "deepseek",
      "a retired provider id read back as itself would route the turn to a service this build cannot reach",
    );
    assert.deepEqual(
      settings.getInferenceCustomEndpoint(),
      { baseUrl: "https://api.deepseek.com", modelId: "deepseek-flash" },
      "a non-DeepSeek endpoint must not survive the load: nothing in this build may address another host",
    );
    const onDisk = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(onDisk.inferenceProvider, "deepseek", "the rewrite has to be persisted, or every later read falls back again");
    assert.equal(
      onDisk.inferenceCustomEndpoint.baseUrl,
      "https://api.deepseek.com",
      "the migrated endpoint has to reach the disk, or the next start reads the old host back",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// --- Renderer -----------------------------------------------------------------
// The two renderer guards below used to parse `COMPONENT_SOURCE`, a minified JSX
// string exported by `scripts/lib/router-renderer-patch.mjs`. That module injected
// the string into the shipped 0.18 bundle at `src/app/dist/renderer/assets/*.js`.
// The fidelity build is gone — its LFS objects were deleted from the server and
// `src/app/dist/**` was removed — so no build produces those bytes and nothing can
// inject the component. The guards now read the sources the Lite renderer is
// actually compiled from, so a returning Cursor entry fails here too.

const routerSourcePath = path.join(
  repoRoot,
  "frontend", "src", "recovered", "features", "settings", "overlay", "router.ts",
);
const routerPanelPath = path.join(
  repoRoot,
  "frontend", "src", "recovered", "features", "settings", "overlay", "panels.tsx",
);

/**
 * The body of one top-level declaration in `panels.tsx`.
 *
 * `panels.tsx` holds several panels, and `UsageSettingsPanel` still types its
 * props with `CursorUsageSummary`. A whole-file grep would therefore match a
 * symbol the Router panel never touches and fail for an unrelated reason, so the
 * guard is scoped to the declaration it is actually about.
 */
function topLevelDeclaration(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start > 0, `the guard must find \`${signature}\` in panels.tsx, or it proves nothing`);
  const after = source.slice(start + signature.length);
  const next = after.search(/\n(?:export )?(?:function|const|class|interface|type) /);
  return next === -1 ? source.slice(start) : source.slice(start, start + signature.length + next);
}

test("the Router settings panel offers no Cursor provider and mounts no billing panel", () => {
  const routerSource = readFileSync(routerSourcePath, "utf8");
  const routerPanelSource = readFileSync(routerPanelPath, "utf8");
  const routerPanel = topLevelDeclaration(routerPanelSource, "export function RouterSettingsPanel(");

  // A guard that finds nothing is a passing test that proves nothing.
  assert.ok(
    /export const ROUTER_PROVIDERS/.test(routerSource),
    "the guard must find the provider table it is about to inspect, or it proves nothing",
  );
  assert.ok(
    /export type RouterProviderId = "deepseek"/.test(routerSource),
    "the provider id type must be the single DeepSeek literal",
  );

  // Exactly one provider, and it is DeepSeek.
  const providerIds = [...routerSource.matchAll(/^\s*id: "([^"]+)",$/gm)].map(match => match[1]);
  assert.deepEqual(
    providerIds,
    ["deepseek"],
    "the panel must offer exactly one provider: another entry routes a turn into an account-backed endpoint that can never answer",
  );

  // The Cursor provider entry and the account slot it selected are both gone.
  assert.equal(
    routerSource.includes('"cursor"'),
    false,
    "the Cursor provider entry routes a turn into an account-backed endpoint that can never answer",
  );
  assert.equal(
    /provider: "cursor"/.test(routerSource),
    false,
    "no Router state may be seeded with the Cursor provider",
  );
  assert.doesNotMatch(
    routerPanel,
    /CursorUsageSummary|getUsageSummary|UsageMeter/,
    "the Cursor usage/billing panel must not be mounted by the Router panel",
  );
  // What it does show is DeepSeek's own description of where the tokens are metered.
  assert.match(routerPanel, /selectedProvider\.usageDescription/);
});

test("the DeepSeek model picker survives the provider removal", () => {
  const routerSource = readFileSync(routerSourcePath, "utf8");
  const routerPanel = topLevelDeclaration(
    readFileSync(routerPanelPath, "utf8"),
    "export function RouterSettingsPanel(",
  );

  assert.ok(
    /export const DEEPSEEK_MODEL_CHOICES/.test(routerSource),
    "the model table must survive removing the Cursor entry",
  );
  assert.ok(
    /id: "deepseek-flash"/.test(routerSource) && /id: "deepseek-v4-pro"/.test(routerSource),
    "both shipped DeepSeek models must survive removing the Cursor entry",
  );
  // The panel still renders a named, reachable select over that table.
  assert.match(routerPanel, /ariaLabel="Модель DeepSeek"/);
  assert.match(
    routerPanel,
    /const selectedModel = models\.find\(\(choice\) => choice\.id === modelId\) \?\? models\[0\]!/,
    "a model id the table does not carry must fall back, never be rewritten",
  );
});

// --- Fatal startup reporting --------------------------------------------------

test("a fatal startup failure is written to stderr before it is reported to telemetry", () => {
  const source = readFileSync(path.join(repoRoot, "source", "host", "main.ts"), "utf8");
  const reported = source.indexOf('host.reportProcessCrash(error, "fatal_startup")');
  assert.ok(reported > 0, "the guard must find the fatal startup report it is about to order against");
  const start = source.lastIndexOf("catch (error) {", reported);
  const logged = source.indexOf('log.error("[sand-host] fatal startup failure:"', start);
  assert.ok(logged > start, "a fatal startup failure must reach stderr; telemetry alone left a silent exit code 1");
  assert.ok(logged < reported, "the stderr line has to come first, so the cause survives a telemetry flush that never returns");
});