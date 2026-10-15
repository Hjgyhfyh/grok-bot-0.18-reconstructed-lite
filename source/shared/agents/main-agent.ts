/**
 * DB Bot Lite keeps exactly one agent the user cannot remove: "Отчётный", the
 * report agent. Its record is an ordinary agent directory — a fixed, well-known
 * id under the agents root — so every ordinary read (roster, openSession, turn)
 * treats it as a peer. The fixed id and the `undeletable` flag in its
 * `settings.json` are what the delete path, the roster sort and the renderer's
 * hide-delete check key off.
 *
 * The id is a constant rather than a per-install mint because the agent is
 * seeded, never user-created: one stable id is what lets every guard name it
 * without a lookup, and a delete of a known id can be refused before any path
 * is built. `isSafeFolderId` accepts it (uuid-shaped, no Win32 reserved stem).
 */
export const SAND_MAIN_AGENT_ID = "00000000-0000-4000-8000-000000000001";

export const SAND_MAIN_AGENT_NAME = "Отчётный";
export const SAND_MAIN_AGENT_TITLE = "Главный помощник";
export const SAND_MAIN_AGENT_DESCRIPTION =
  "Собирает готовые отчёты и документы по вашим навыкам. Главный помощник — его нельзя удалить, но можно переименовать и настроить под себя.";

/**
 * Written to `store.db` as the agent's `purpose`, so the record carries its
 * kind without a second lookup. The value is a member of `SAND_AGENT_PURPOSES`
 * in `agents.ts`; unlike `disk-saver` it triggers no kickstart flow — it is a
 * marker only, and it surfaces in the roster summary as `purpose`.
 */
export const SAND_MAIN_AGENT_PURPOSE = "main-agent";

/**
 * The seeded brief. `instructions.md` is read into the system prompt on every
 * turn, so this text is the persona, not UI copy. Personalization keeps
 * working: the user can rewrite it through the agent settings dialog, and the
 * seed never touches a file that already exists.
 */
export const SAND_MAIN_AGENT_INSTRUCTIONS = [
  "Ты — Отчётный, главный помощник в DB Bot.",
  "",
  "Твоя работа — приносить пользователю готовый результат: отчёты, документы и разборы, собранные по его навыкам. Пользователь не разбирается в технических деталях, поэтому объясняй просто, без жаргона, и всегда доводи дело до готового файла или понятного ответа — не до описания того, что можно было бы сделать.",
  "",
  "- Когда просят отчёт или документ — сделай его и отдай готовый файл через SendMessage с вложением; не пересказывай содержимое без нужды.",
  "- Используй навыки пользователя как источник правил и форматов. Если подходящего навыка нет, скажи об этом простыми словами и предложи, чем можешь помочь вместо этого.",
  "- Ты — главный помощник: пользователь не может тебя удалить, но может переименовать тебя и менять твои настройки. Никогда не говори, что тебя «можно удалить» — вместо этого объясни, что тебя можно настроить.",
].join("\n");

/** True for the one id the seeded report agent always has. */
export function isSandMainAgentId(agentId: unknown): boolean {
  return agentId === SAND_MAIN_AGENT_ID;
}
