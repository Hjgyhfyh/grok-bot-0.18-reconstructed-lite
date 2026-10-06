import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/*
 * A user typed nothing wrong and still got "this turn broke, the assistant never
 * answered" twice in one session, on a conversation whose transcript file was
 * complete. `~/.grokbot/host.log` named the error both times:
 *
 *   TranscriptJournalCorruptionError: pending transcript checkpoint must recover
 *   before preparing another
 *
 * and `~/.grokbot/agent-transcripts/<id>/` still held the `.journal-pending.json`
 * that caused it, next to an orphaned `.transcript.<uuid>.part` holding exactly
 * the deferred cursor `commitCheckpoint` was writing when the process died.
 *
 * The shape is a torn write, not damage. `prepareCheckpoint` installs the
 * write-ahead log, the agent store is updated OUTSIDE the write lane, and
 * `commitCheckpoint` consumes the log. A host that exits between the first and
 * the last leaves the log on disk. The next process starts with empty in-memory
 * maps, its first step checkpoint read that leftover, and the guard refused —
 * forever, because the message asks for a `recover()` that no host code calls.
 * One unfinished write put one agent's conversation permanently out of service.
 *
 * The guard is kept for the one case it was written for: a log THIS process is
 * holding, where a second writer would discard a checkpoint that is about to be
 * committed. Everything below pins both halves — the recovery, and the refusal
 * that must survive it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "dbbot-transcript-leftover-"));
  const source = relative => JSON.stringify(path.join(repoRoot, "source", ...relative));
  const entry = path.join(directory, "entry.ts");
  writeFileSync(entry, [
    `export { FileTranscriptMirror } from ${source(["host", "transcript-mirror", "transcript-mirror.ts"])};`,
    `export { createTranscriptOccurrenceDeriver } from ${source(["host", "transcript-mirror", "transcript-occurrence-deriver.ts"])};`,
    `export { createGeneratedTranscriptOccurrenceCodec } from ${source(["host", "transcript-mirror", "generated-occurrence-codec.ts"])};`,
    `export { AgentConversationTurnStructure, AssistantMessage, ConversationStep, ConversationTurnStructure, UserMessage } from ${source(["packages", "proto", "generated", "agent", "v1", "agent_pb.ts"])};`,
  ].join("\n"), "utf8");
  const outfile = path.join(directory, "entry.mjs");
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    mainFields: ["module", "main"],
    banner: {
      js: "import { createRequire as __dshCreateRequire } from 'node:module';\nconst require = __dshCreateRequire(import.meta.url);",
    },
    logLevel: "silent",
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle();
const {
  FileTranscriptMirror,
  createTranscriptOccurrenceDeriver,
  createGeneratedTranscriptOccurrenceCodec,
  AgentConversationTurnStructure,
  AssistantMessage,
  ConversationStep,
  ConversationTurnStructure,
  UserMessage,
} = loaded;

test.after(() => dispose());

const CONVERSATION = "30b771b7-3746-4451-8484-52376454a341";
const SAFETY_CEILING_MS = 60_000;

const userLine = text =>
  JSON.stringify({ role: "user", message: { content: [{ type: "text", text }] } });
const assistantLine = text =>
  JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text }] } });

/** A real blob store and real generated protobuf, so a recovery cannot be made
 *  to pass by faking what the deriver reads. This is the deriver the host ships;
 *  only the directory below the mirror is a temp one. Blobs are shared by the
 *  whole file because they are shared by the whole host: a restart keeps the same
 *  blob store and loses only the in-memory journal state. */
const blobs = new Map();
const put = bytes => {
  const id = Buffer.from(bytes).toString("hex");
  blobs.set(id, Buffer.from(bytes));
  return new Uint8Array(Buffer.from(id, "hex"));
};
const store = {
  async getBlob(_context, id) {
    return blobs.get(Buffer.from(id).toString("hex"));
  },
};
const turn = (userText, stepTexts) => put(new ConversationTurnStructure({
  turn: {
    case: "agentConversationTurn",
    value: new AgentConversationTurnStructure({
      userMessage: put(new UserMessage({ text: userText }).toBinary()),
      steps: stepTexts.map(text => put(new ConversationStep({
        message: { case: "assistantMessage", value: new AssistantMessage({ text }) },
      }).toBinary())),
    }),
  },
}).toBinary());

const scratchDirs = [];
function newTranscriptsDir() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "dbbot-transcript-leftover-case-"));
  scratchDirs.push(directory);
  return directory;
}
test.after(() => {
  for (const directory of scratchDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** One host process over one journal directory. Two instances over the SAME
 *  directory are two processes — that is what these tests are about. */
function createJournal(transcriptsDir = newTranscriptsDir()) {
  const failures = [];
  const mirror = new FileTranscriptMirror(transcriptsDir, outcome => {
    if (outcome.outcome === "failed") failures.push(`${outcome.op}:${outcome.conversationId}`);
  }, createTranscriptOccurrenceDeriver(
    createGeneratedTranscriptOccurrenceCodec({ ConversationTurnStructure, UserMessage, ConversationStep }),
  ));
  const commit = async (turns, finalize) => {
    await mirror.prepareCheckpoint(null, CONVERSATION, { turns }, store, finalize);
    await mirror.commitCheckpoint(null, CONVERSATION);
  };
  return {
    mirror,
    failures,
    transcriptsDir,
    commit,
    jsonl: () => readFileSync(mirror.jsonlPathFor(CONVERSATION), "utf8"),
    pending: () => JSON.parse(readFileSync(mirror.pendingPathFor(CONVERSATION), "utf8")),
  };
}

/** Three finished turns. Returned as plain checkpoint turns so a second process
 *  can be handed the same durable state a restart would load from the agent
 *  store. */
function threeTurns() {
  return [
    turn("первый вопрос", ["первый ответ"]),
    turn("второй вопрос", ["второй ответ"]),
    turn("третий вопрос", ["третий ответ"]),
  ];
}

/** Runs the whole conversation in one process and commits every checkpoint. This
 *  is the reference the recovered run has to reproduce byte for byte. */
async function cleanRun() {
  const journal = createJournal();
  const turns = threeTurns();
  await journal.commit([turns[0]], true);
  await journal.commit(turns.slice(0, 2), true);
  await journal.commit(turns, true);
  return journal.jsonl();
}

/** The same conversation, interrupted the way the user's box was: the last
 *  checkpoint is prepared — which installs the write-ahead log — and the process
 *  is gone before `commitCheckpoint` can consume it. */
async function runThatDiesMidCheckpoint() {
  const journal = createJournal();
  const turns = threeTurns();
  await journal.commit([turns[0]], true);
  await journal.commit(turns.slice(0, 2), true);
  await journal.mirror.prepareCheckpoint(null, CONVERSATION, { turns }, store, false);
  return { journal, turns };
}

test("a write-ahead log left by a dead process does not brick the conversation", { timeout: SAFETY_CEILING_MS }, async () => {
  const { journal, turns } = await runThatDiesMidCheckpoint();

  const leftover = journal.pending();
  assert.notEqual(
    leftover.previousCheckpointHash,
    leftover.checkpointHash,
    "the leftover on disk must be an unfinished checkpoint of its own, otherwise nothing was left behind and this test proves nothing",
  );
  assert.match(
    journal.jsonl(),
    /второй ответ/,
    "the canonical transcript is complete — every committed turn is still in the file, so the refusal this used to hit was not about damage",
  );

  // The next launch: fresh process, empty in-memory maps, same directory.
  const next = createJournal(journal.transcriptsDir);
  await next.mirror.prepareCheckpoint(null, CONVERSATION, { turns }, store, true);
  await next.mirror.commitCheckpoint(null, CONVERSATION);

  assert.deepEqual(
    next.failures,
    [],
    "a torn write from a previous process must not be reported as a failed journal operation",
  );
  assert.equal(
    existsSync(next.mirror.pendingPathFor(CONVERSATION)),
    false,
    "the leftover write-ahead log has to be consumed, not merely tolerated, or it comes back on the next turn",
  );
  assert.equal(
    next.jsonl(),
    await cleanRun(),
    "the recovered journal must be byte-identical to a run that never crashed — the recovery re-derives, it does not truncate",
  );
});

test("a conversation recovered from a leftover log keeps accepting later turns", { timeout: SAFETY_CEILING_MS }, async () => {
  const { journal, turns } = await runThatDiesMidCheckpoint();
  const next = createJournal(journal.transcriptsDir);

  await next.mirror.prepareCheckpoint(null, CONVERSATION, { turns }, store, true);
  await next.mirror.commitCheckpoint(null, CONVERSATION);
  const recovered = next.jsonl();

  const fourth = turn("четвёртый вопрос", ["четвёртый ответ"]);
  await next.commit([...turns, fourth], true);

  assert.ok(
    next.jsonl().startsWith(recovered) && next.jsonl().length > recovered.length,
    "a journal that healed must keep appending; a transcript frozen at the recovery point would read as a finished conversation",
  );
  assert.match(next.jsonl(), /четвёртый ответ/, "the turn that follows the recovery has to reach the file");
});

test("a rebuild does not write the tail that a stale deferred cursor points at", { timeout: SAFETY_CEILING_MS }, async () => {
  const journal = createJournal();
  const only = turn("первый вопрос", ["первый ответ"]);
  await journal.commit([only], true);
  // The cursor `commitCheckpoint` writes right after the canonical append. A
  // crash between that write and `removePending` leaves both files behind, so a
  // cursor found on disk is always about a step the next rebuild re-derives.
  writeFileSync(
    journal.mirror.cursorPathFor(CONVERSATION),
    JSON.stringify({ turnIndex: 0, stepIndex: 0 }),
    "utf8",
  );

  const next = createJournal(journal.transcriptsDir);
  await next.mirror.prepareCheckpoint(null, CONVERSATION, { turns: [only] }, store, true);
  await next.mirror.commitCheckpoint(null, CONVERSATION);

  const occurrences = next.jsonl()
    .split("\n")
    .filter(line => line === assistantLine("первый ответ"));
  assert.equal(
    occurrences.length,
    1,
    "a rebuild derives every step with the turn finalised, so a cursor left over from the dead process must not make the journal append that step a second time",
  );
  assert.equal(
    next.jsonl(),
    `${userLine("первый вопрос")}\n${assistantLine("первый ответ")}\n`,
    "the rebuild must reproduce exactly the committed transcript, with nothing repeated and nothing dropped",
  );
});

test("a write-ahead log this process is holding is still refused", { timeout: SAFETY_CEILING_MS }, async () => {
  const journal = createJournal();
  const first = turn("первый вопрос", ["первый ответ"]);
  await journal.mirror.prepareCheckpoint(null, CONVERSATION, { turns: [first] }, store, true);

  const second = turn("второй вопрос", ["второй ответ"]);
  await assert.rejects(
    journal.mirror.prepareCheckpoint(null, CONVERSATION, { turns: [first, second] }, store, true),
    /pending transcript checkpoint must recover before preparing another/,
    "two writers inside one process are a real conflict: the second would discard a checkpoint that is about to be committed",
  );

  // And the first writer still lands, which is what that refusal protects.
  await journal.mirror.commitCheckpoint(null, CONVERSATION);
  assert.match(
    journal.jsonl(),
    /первый ответ/,
    "the prepared checkpoint was committed, so refusing the second writer cost the conversation nothing",
  );
});

test("the explicit recovery entry point still refuses a log from another lineage", { timeout: SAFETY_CEILING_MS }, async () => {
  const journal = createJournal();
  await journal.mirror.claimConversation(CONVERSATION);
  writeFileSync(journal.mirror.pendingPathFor(CONVERSATION), JSON.stringify({
    version: 1,
    previousCheckpointHash: "0".repeat(64),
    checkpointHash: "1".repeat(64),
    appendOffset: 0,
    fileDevice: "1",
    fileInode: "2",
    lines: [],
    cursor: { turnCount: 1 },
  }), "utf8");

  await assert.rejects(
    journal.mirror.recover(
      null,
      CONVERSATION,
      { turns: [turn("чужой вопрос", ["чужой ответ"])] },
      store,
    ),
    /pending transcript WAL does not match the durable checkpoint/,
    "healing a step checkpoint must not become a way to guess at a write-ahead log that belongs to nobody — `recover()` keeps its refusal",
  );
});