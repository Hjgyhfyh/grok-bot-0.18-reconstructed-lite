import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  SAND_MAIN_AGENT_DESCRIPTION,
  SAND_MAIN_AGENT_ID,
  SAND_MAIN_AGENT_INSTRUCTIONS,
  SAND_MAIN_AGENT_NAME,
  SAND_MAIN_AGENT_PURPOSE,
  SAND_MAIN_AGENT_TITLE,
  isSandMainAgentId,
} from "../../shared/agents/main-agent.js";
import { SandAgentDb, ensureAgentDbDirectory } from "../extensions/session/agent-db.js";
import { getAgentDbPath } from "../extensions/session/session-paths.js";
import { AGENT_INSTRUCTIONS_FILENAME, writeAgentInstructions } from "../runner/system-prompt-assembly.js";
import { getSandProfilePath, writeSandProfileFile } from "./agent-profile.js";
import { getSandSettingsPath, readSandSettingsFile, writeSandSettingsFile } from "./settings-file.js";

/**
 * Seeding failure for the report agent. Distinct name so a host log line names
 * the feature that could not come up rather than whichever fs call threw.
 */
export class SandMainAgentSeedError extends Error {
  constructor(readonly agentDir: string, options?: ErrorOptions) {
    super(`The main report agent could not be seeded under ${agentDir}`, options);
    this.name = "SandMainAgentSeedError";
  }
}

/**
 * Thrown by the delete path when every id in the request is protected. Plain
 * `Error` rather than a lifecycle subclass so the guard stays usable from
 * files that cannot import the lifecycle module; the caller decides the
 * status mapping (409/403 are the honest ones).
 */
export class SandAgentProtectedError extends Error {
  constructor(readonly agentIds: readonly string[]) {
    super(
      `Agent ${agentIds.join(", ")} is the built-in report agent and cannot be deleted. It can be renamed and personalized instead.`,
    );
    this.name = "SandAgentProtectedError";
  }
}

export interface SandMainAgentSeedResult {
  readonly id: string;
  readonly dir: string;
  /** True when this call created the directory; false when it only healed one. */
  readonly created: boolean;
}

/**
 * True when `agentId` names an agent the user must not be able to delete.
 *
 * Two ways to qualify, on purpose. `SAND_MAIN_AGENT_ID` is the seeded report
 * agent and is protected even if its `settings.json` was wiped or never
 * written — the id alone is enough, because a delete guard that depends on a
 * file inside the directory it protects can be disarmed by losing that file.
 * The `undeletable` flag is the second, generic mechanism: any agent directory
 * carrying `"undeletable": true` in `settings.json` is protected too, so a
 * future protected record needs no code change here.
 */
export function isSandProtectedAgentId(agentId: string): boolean {
  return isSandMainAgentId(agentId);
}

/** `isSandProtectedAgentId` plus the settings-flag check, for a path the caller already holds. */
export function isSandProtectedAgentDir(agentDir: string): boolean {
  if (isSandMainAgentId(basename(agentDir))) return true;
  return readSandSettingsFile(getSandSettingsPath(agentDir)).undeletable === true;
}

/**
 * Idempotent seed of the one undeletable report agent.
 *
 * A missing directory is built the same way `createLocalSession` builds a fresh
 * agent — `profile.json`, `settings.json`, then a `store.db` whose KV carries
 * `agentId`, `origin: "user"`, `purpose: "main-agent"` and a pending
 * introduction — so the record is a full citizen of the agent store: it
 * survives `reclaimDanglingAgentDirs` (which removes only directories with no
 * `store.db`), `buildSummary` reports it (a non-default name satisfies
 * `hasIdentity`), and `openSession` accepts it.
 *
 * An existing directory is healed, not rewritten: the `undeletable` flag is
 * re-asserted and a missing `store.db`, `profile.json` or `instructions.md` is
 * replaced, but a profile or brief the user edited is never clobbered —
 * personalization of the main agent keeps working.
 *
 * Synchronous, like the file writers it composes. Throws
 * `SandMainAgentSeedError` on failure; a caller that must not die on a seed
 * failure (extension start) should catch and log.
 */
export function ensureSandMainAgent(agentsRootDir: string): SandMainAgentSeedResult {
  const dir = join(agentsRootDir, SAND_MAIN_AGENT_ID);
  const created = !existsSync(dir);
  try {
    const dbPath = getAgentDbPath(agentsRootDir, SAND_MAIN_AGENT_ID);
    ensureAgentDbDirectory(dbPath);
    if (!existsSync(getSandProfilePath(dir))) {
      writeSandProfileFile(getSandProfilePath(dir), {
        name: SAND_MAIN_AGENT_NAME,
        description: SAND_MAIN_AGENT_DESCRIPTION,
        title: SAND_MAIN_AGENT_TITLE,
        avatarShape: "",
        avatarColor: "",
      });
    }
    // The flag is re-asserted on every call rather than only at create: a
    // settings.json that lost it would quietly disarm the delete guard, and a
    // merge write keeps every other setting the user toggled.
    writeSandSettingsFile(getSandSettingsPath(dir), { undeletable: true });
    const db = new SandAgentDb(dbPath);
    try {
      db.set("agentId", SAND_MAIN_AGENT_ID);
      db.setAgentOrigin("user");
      db.setAgentPurpose(SAND_MAIN_AGENT_PURPOSE);
      if (created) db.setIntroductionPending(true);
    } finally {
      db.close();
    }
    // The brief is seeded once and never overwritten: `instructions.md` is user
    // text once the agent exists, and re-seeding an edited file would silently
    // revert a personalization the user made on purpose.
    const instructionsPath = join(dir, AGENT_INSTRUCTIONS_FILENAME);
    if (!existsSync(instructionsPath)) writeAgentInstructions(dir, SAND_MAIN_AGENT_INSTRUCTIONS);
    return { id: SAND_MAIN_AGENT_ID, dir, created };
  } catch (error) {
    throw new SandMainAgentSeedError(dir, { cause: error });
  }
}
