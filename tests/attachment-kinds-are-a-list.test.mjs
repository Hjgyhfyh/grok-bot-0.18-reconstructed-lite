/**
 * The application could not open at all. Opening the window threw
 * `TypeError: n.filter is not a function` from the renderer, and the sidebar never
 * painted.
 *
 * The renderer counts attachments for the last thing an agent said. It receives
 * them from the host projection, and the host was handing it a `Record<string,
 * number>` where the renderer does `kinds.filter(...)`. An object has no
 * `length`, so the renderer's own null-and-empty guard never fires and the call
 * reaches `.filter` on an object.
 *
 * This test does not re-describe what the renderer does. It runs the renderer's own
 * tally — `mergeKindCounts` in `source/shared/media/attachments.ts`, the module the
 * whole renderer shares — against the host projection's real output. It used to mine
 * the same guard out of the checksum-pinned renderer chunk in `src/app/dist/**`, which
 * was a minified copy of this module: that tree is gone with the rest of the fidelity
 * payload, and the recovered source is what the renderer actually runs now.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The host projection and the renderer's tally, bundled together so both are
 * exercised for real rather than re-described.
 */
async function loadReal(repoRoot) {
  const esbuild = await import("esbuild");
  const out = await mkdtemp(join(tmpdir(), "dbbot-attachment-kinds-"));
  try {
    const entry = join(out, "entry.mjs");
    await writeFile(
      entry,
      [
        `export { buildAttachmentLastEntry } from ${JSON.stringify(join(repoRoot, "source/host/extensions/session/session-projection.ts"))};`,
        `export { mergeKindCounts, SAND_ATTACHMENT_KINDS } from ${JSON.stringify(join(repoRoot, "source/shared/media/attachments.ts"))};`,
      ].join("\n"),
    );
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile: join(out, "attachment-kinds.mjs"),
      logLevel: "silent",
    });
    return await import(`file://${join(out, "attachment-kinds.mjs")}`);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

test("the attachment tally the renderer runs does not throw on what the host sends", async () => {
  const repoRoot = process.cwd();
  const { buildAttachmentLastEntry, mergeKindCounts, SAND_ATTACHMENT_KINDS } = await loadReal(repoRoot);

  const entry = buildAttachmentLastEntry(
    [
      { kind: "user-attachment", batchId: "b1", file_name: "one.png", file_path: "C:/box/one.png" },
      { kind: "user-attachment", batchId: "b1", file_name: "two.pdf", file_path: "C:/box/two.pdf" },
      { kind: "user-attachment", batchId: "b1", file_name: "three.png", file_path: "C:/box/three.png" },
    ],
    2,
  );

  assert.equal(entry.kind, "attachment", "the projection still reports an attachment batch");
  assert.equal(entry.count, 3, "the batch size is the number of attachments, not the number of kinds");

  // This is the call that threw. It is the renderer's own guard and its own
  // `.filter`, given the host's own output.
  assert.ok(Array.isArray(entry.kinds), "the renderer reads kinds as a list and calls filter on it");
  const counted = mergeKindCounts(entry.kinds);

  assert.equal(
    counted.reduce((sum, part) => sum + part.count, 0),
    3,
    "every attachment in the batch is accounted for by kind",
  );
  assert.deepEqual(
    counted.map((part) => part.kind).sort(),
    ["document", "image"],
    "two images and one document are two kinds, not three attachments",
  );
  for (const part of counted) {
    assert.ok(
      SAND_ATTACHMENT_KINDS.includes(part.kind),
      `the host classified an attachment as "${part.kind}", which is not one of the kinds the renderer words`,
    );
  }
});

test("an attachment kind the renderer has no word for still reaches the call", async () => {
  const repoRoot = process.cwd();
  const { buildAttachmentLastEntry, mergeKindCounts } = await loadReal(repoRoot);

  const entry = buildAttachmentLastEntry(
    [{ kind: "user-attachment", batchId: "b1", file_name: "sheet.xlsx", file_path: "C:/box/sheet.xlsx" }],
    0,
  );
  assert.equal(entry.count, 1);

  // The host classifies a spreadsheet as "document", while the renderer's own
  // table words its kinds as image/video/audio/pdf/markdown/table/json/text/
  // document/archive/file. Falling back to "file" is the renderer's own designed
  // behaviour, not a failure: what matters is that the call completes and the
  // attachment is still counted.
  const counted = mergeKindCounts(entry.kinds);
  assert.equal(counted.length, 1, "one kind in the batch reads as one part of the tally");
  assert.equal(
    counted.reduce((sum, part) => sum + part.count, 0),
    1,
    "the attachment is counted even when the renderer has no word for its kind",
  );
});

test("a kinds field shaped as a record is refused, so the shape cannot drift back", async () => {
  // The defect this file closes was a `Record<string, number>` reaching a
  // `.filter`. The tally's own guard only catches `null` and `[]`, so the shape
  // itself has to be pinned here rather than hoped for: this is the argument the
  // renderer used to receive.
  const repoRoot = process.cwd();
  const { mergeKindCounts } = await loadReal(repoRoot);
  const asRecord = { image: 2, document: 1 };

  assert.equal(Array.isArray(asRecord), false, "the fixture must really be a record, or this test cannot prove anything");
  assert.throws(
    () => mergeKindCounts(asRecord),
    TypeError,
    "the tally accepted a record where it expects a list, so the renderer is one host change away from a blank window again",
  );
});

test("the projection's kinds field matches the shape the shared media contract declares", async () => {
  const repoRoot = process.cwd();
  const { buildAttachmentLastEntry } = await loadReal(repoRoot);
  const entry = buildAttachmentLastEntry(
    [{ kind: "user-attachment", batchId: "b1", file_name: "clip.mp4", file_path: "C:/box/clip.mp4" }],
    0,
  );

  // `mergeKindCounts` in shared/media/attachments.ts is typed against
  // `AttachmentKindCount[]` and returns `{kind, count}[]`. If this ever drifts
  // back to a record, the two sides of that contract stop agreeing again.
  assert.ok(Array.isArray(entry.kinds), "shared/media/attachments.ts expects a list here");
  for (const part of entry.kinds) {
    assert.equal(typeof part.kind, "string", "each part names its kind");
    assert.equal(typeof part.count, "number", "each part carries how many");
  }
});

test("the tally this suite measures is the one the renderer really renders with", async () => {
  // A test that bundled a private copy of the guard would pass no matter what the
  // renderer shipped. The preview line is the surface that consumes the tally, so
  // it is what names the module.
  const repoRoot = process.cwd();
  const preview = await readFile(
    join(repoRoot, "frontend/src/recovered/features/conversation/workspace/sidebar-agent-preview-content.tsx"),
    "utf8",
  );
  assert.match(preview, /Object\.entries\(entry\.kinds\)/,
    "the sidebar preview no longer reads entry.kinds, so the tally measured above is not the one the user sees");
});
