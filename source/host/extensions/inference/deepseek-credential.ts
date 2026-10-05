import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEEPSEEK_API_KEY_ENV, DEEPSEEK_MISSING_KEY_MESSAGE } from "../../../shared/inference-router.js";
import { SandSettingsStore } from "../../../shared/node/settings/sand-settings-store.js";
import { getSandRootDir } from "../../host-paths.js";
import { getBoxSecretsStorePath } from "../secrets/secrets-service.js";

/** Where a usable key was found. Reported to the settings panel so the user knows what to change. */
export type DeepSeekApiKeySource = "env" | "settings" | "box-secrets";

export interface DeepSeekApiKeyStatus {
  /** True when a turn could authenticate. The key itself never leaves this module. */
  readonly configured: boolean;
  readonly source: DeepSeekApiKeySource | null;
  /** What to show the user when `configured` is false. Russian, actionable. */
  readonly message: string | null;
}

/**
 * The launcher writes its secrets to `box-secrets.json` because `process.env` does not survive
 * the hop into the agent worker. It is the third place a key may come from, after the env var
 * and the settings file.
 */
function persistedSecrets(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(getBoxSecretsStorePath(), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return {};
    const secrets = (parsed as { secrets?: unknown }).secrets;
    if (typeof secrets !== "object" || secrets == null || Array.isArray(secrets)) return {};
    return Object.fromEntries(Object.entries(secrets).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return {}; }
}

export function findDeepSeekApiKey(): { readonly key: string; readonly source: DeepSeekApiKeySource } | null {
  const fromEnv = process.env[DEEPSEEK_API_KEY_ENV]?.trim();
  if (fromEnv != null && fromEnv.length > 0) return { key: fromEnv, source: "env" };
  const fromSettings = new SandSettingsStore(join(getSandRootDir(), "settings.json")).getInferenceApiKey();
  if (fromSettings != null) return { key: fromSettings, source: "settings" };
  const fromBox = persistedSecrets()[DEEPSEEK_API_KEY_ENV]?.trim();
  if (fromBox != null && fromBox.length > 0) return { key: fromBox, source: "box-secrets" };
  return null;
}

/**
 * The key a DeepSeek request is signed with. Throws a Russian message the user can act on,
 * because a turn that starts without a key fails here and nowhere else gives no clue.
 */
export function readDeepSeekApiKey(): string {
  const found = findDeepSeekApiKey();
  if (found == null) throw new Error(DEEPSEEK_MISSING_KEY_MESSAGE);
  return found.key;
}

export function deepSeekApiKeyStatus(): DeepSeekApiKeyStatus {
  const found = findDeepSeekApiKey();
  return found == null
    ? { configured: false, source: null, message: DEEPSEEK_MISSING_KEY_MESSAGE }
    : { configured: true, source: found.source, message: null };
}