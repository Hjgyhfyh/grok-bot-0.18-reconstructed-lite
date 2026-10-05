/**
 * The provider settings are the only place the librarian sets a model, so both
 * halves of the screen are pinned: the registry entry that mounts the panel and
 * the provider list the panel offers. Wave 2 translated the labels, which is
 * what the first of the two tests below now checks instead of the English word
 * `Router` it used to look for.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routerSourcePath = path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/router.ts");

async function loadRouterModule() {
  const source = await readFile(routerSourcePath, "utf8");
  const { code: output } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("router provider preference is DeepSeek and nothing else round-trips", async () => {
  const router = await loadRouterModule();
  // One provider, so the picker can never offer the user a route this build cannot serve.
  assert.deepEqual(router.ROUTER_PROVIDERS.map(({ id }) => id), ["deepseek"]);
  assert.equal(router.DEFAULT_ROUTER_PROVIDER, "deepseek");
  assert.equal(router.parseRouterProviderPreference(null), "deepseek");
  assert.equal(router.parseRouterProviderPreference("not-json"), "deepseek");
  assert.equal(router.parseRouterProviderPreference(JSON.stringify({ schemaVersion: 1, provider: "unknown" })), "deepseek");
  // A value left by an earlier build names a provider that no longer exists, and must not survive.
  assert.equal(router.parseRouterProviderPreference(JSON.stringify({ schemaVersion: 1, provider: "cursor" })), "deepseek");
  assert.equal(router.parseRouterProviderPreference(JSON.stringify({ schemaVersion: 1, provider: "openrouter" })), "deepseek");
  assert.equal(router.isRouterProviderId("cursor"), false, "the retired provider id must not still validate");

  let stored = null;
  const persistence = {
    async read(key) {
      assert.equal(key, router.ROUTER_PROVIDER_PERSISTENCE_KEY);
      return stored;
    },
    async write(key, value) {
      assert.equal(key, router.ROUTER_PROVIDER_PERSISTENCE_KEY);
      stored = value;
    }
  };
  for (const provider of router.ROUTER_PROVIDERS) {
    await router.saveRouterProvider(persistence, provider.id);
    assert.equal(await router.loadRouterProvider(persistence), provider.id);
  }
});

test("the settings registry offers the Provider section, and its icon is the native one", async () => {
  // Wave 2 translated the registry: `Router` became `Провайдер`. The icon is the
  // part that carries meaning — the section is mounted by `id`, so a translated
  // label must not be able to break the mount — and the label is pinned to the
  // shipped wording rather than to the word "Router".
  const source = await readFile(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/view.tsx"), "utf8");
  const entry = /\{ id: "router", label: "([^"]+)", icon: "([^"]+)" \}/.exec(source);
  assert.notEqual(entry, null, "the settings registry offers no Router section, so the provider settings have no place to open");
  assert.equal(entry[1], "Провайдер", "the Provider section carries a label this build does not ship, so the navigation shows something the product does not have");
  assert.equal(entry[2], "git-branch", "the Provider section must keep the native branch icon, so it is recognisable as the provider route and not as a generic setting");
  assert.match(source, /export type SettingsSectionId = "general" \| "router" \| "usage" \| "beta";/,
    "the section id is what the renderer mounts by, and a renamed id would leave the panel unreachable");
});
