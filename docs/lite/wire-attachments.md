# wire-attachments.md — registration edits outside `lite/waveb-attachments` ownership

This branch lands the document-extraction engine
(`source/host/extensions/attachments/document/**`), the prompt block builder
(`source/host/extensions/attachments/documents-note.ts`), the extension
policy (`source/shared/media/attachment-formats.ts`) and two tests
(`tests/attachment-any-format.test.mjs`,
`tests/attachment-content-reaches-model.test.mjs`), ported verbatim from
`archive/wave-3` and adapted where `main` moved.

The engine is dead code until the edits below land: nothing calls
`extractAttachmentText` or `buildAttachmentDocumentsNote` yet. All edits are
taken from `archive/wave-3`; where `main` diverged (cloud-agent code is still
present on `main`) the hunk is given against the current anchor.

Verification on this branch: `tsc -p source/tsconfig.json` fails with exactly
three errors — all "no exported member" on `attachment-limits.ts` (edit 1).
`node --test tests/attachment-*.test.mjs` → **22/22 pass** when edits 1–8 are
applied to the worktree together with `source/packages/report-tools`
(branch `lite/waveb-report-tools`; the two test files build docx/odt/xlsx
fixtures with it). Without the wiring, both new test files fail inside
`before` at esbuild bundle time on the missing `attachment-limits.ts`
exports — the same three errors.

---

## 0. Prerequisites (no edit needed, listed for completeness)

- `source/packages/report-tools/**` — landed by `lite/waveb-report-tools`.
  Both attachment tests bundle `source/packages/report-tools/index.ts` to
  build real docx/odt/xlsx/zip fixtures with the same code the bot writes
  reports with. Until that branch merges, the tests cannot build.
- `iconv-lite` and `jschardet` are already in `package.json` — used by
  `document/plain-text.ts` for windows-1251/cp866 decoding.
- No RPC table entry is needed for `readDocuments`: `host-runner-composition`
  reaches service methods through `method(attachments, "readDocuments")`.
- `SAND_DATA_ROOT` is honored by `getSandRootDir` on `main` — the
  `attachment-content-reaches-model` test relies on it to sandbox reads.

## 1. `source/shared/media/attachment-limits.ts` — replace the whole file

Why: `document/text.ts` imports `ATTACHMENT_TEXT_CHAR_LIMIT` and
`DOCUMENT_BYTE_LIMIT`, `documents-note.ts` imports
`ATTACHMENT_TEXT_TOTAL_CHAR_LIMIT`, `attachment-formats.ts` is consumed by
`nameLooksLikeDocument`, and the frontend notice helpers import
`formatAttachmentTooLargeNotice` / `describeAttachmentByteLimitRu`. None of
these exist in the current file (documents are still capped at the 25 MB
generic limit and refusals are English).

Replace the entire file with the `archive/wave-3` version:

```
git show origin/archive/wave-3:source/shared/media/attachment-limits.ts
```

which contains: `ATTACHMENT_BYTE_LIMIT` (25 MB), `VIDEO_BYTE_LIMIT` (200 MB),
`DOCUMENT_BYTE_LIMIT` (100 MB), `ATTACHMENT_COUNT_LIMIT` (20),
`ATTACHMENT_TEXT_CHAR_LIMIT` (150 000), `ATTACHMENT_TEXT_TOTAL_CHAR_LIMIT`
(600 000), `nameLooksLikeVideo`, `nameLooksLikeDocument`,
`attachmentByteLimitForName` (video → document → generic ordering),
`formatMegabytes`, `describeAttachmentByteLimitRu`,
`formatAttachmentTooLargeNotice` (Russian), `AttachmentTooLargeError`.

## 2. `source/shared/media/file-preview-kind.ts` — document/archive kinds

Why: without the new kinds, `getFilePreviewKind` returns `unknown` for
`.odt`, `.rtf`, `.doc`, `.zip`, and `previewKindNeedsBytes` returns `false`,
so the composer never hands the bytes to the host and the engine never sees
them.

Apply the `archive/wave-3` diff:

- imports: add `import { attachmentFormatOf, isArchiveExtension } from "./attachment-formats.js";`
- `TABLE_EXTENSIONS`: append `"xlsm", "ods"`.
- `FilePreviewKind` union: add `"document"` and `"archive"` before `"text"`.
- `getFilePreviewKind`: after the `docx` check add

```ts
  const format = attachmentFormatOf(nameOrPath);
  if (format === "doc" || format === "odt" || format === "ods" || format === "odp" || format === "rtf") return "document";
  if (format === "archive" || isArchiveExtension(extension)) return "archive";
```

- `previewKindNeedsBytes`: include `"document"` and `"archive"`.

## 3. `source/host/extensions/attachments/attachments-service.ts` — readDocuments

Why: this is the host method the prompt glue calls. The current
`readAttachmentText` gates on `TEXT_PREVIEWABLE_EXTENSIONS` and reads only a
64 KB head — a docx is a zip, so it is declared binary and reaches the model
as a path with no contents.

Apply the `archive/wave-3` diff, which on current `main` is self-contained:

- `node:path` import: add `basename`.
- new imports:

```ts
import { extractAttachmentText, DEFAULT_DOCUMENT_LIMITS, type AttachmentTextResult, type DocumentExtractLimits } from "./document/text.js";
import { buildAttachmentDocumentsNote, type AttachmentDocumentItem } from "./documents-note.js";
```

- add `export const ATTACHMENT_WHOLE_READ_BYTE_CAP = 100 * 1024 * 1024;` after
  `ATTACHMENT_TEXT_PREVIEW_BYTE_CAP`.
- delete the local `TEXT_PREVIEWABLE_EXTENSIONS` set, `isTextPreviewableName`,
  `looksLikeBinary` and the old `readAttachmentText` (they moved to
  `source/shared/media/attachment-preview.ts` usage inside the engine).
- add `readWholeAttachment`, `resolveDocumentLimits`, `EMPTY_RESULT`, the new
  `readAttachmentText` (extracts text via the engine, returns `kind: "text"`
  with `format`/`encoding`/`notice`, `kind: "binary"` with `notice`
  otherwise), and `readAttachmentDocuments` (per-file
  `AttachmentDocumentItem[]` for a list of paths, files outside the
  attachments dir get an `unreadable` result instead of being dropped).
- in the `createAttachmentsService` return literal, after `readText`:

```ts
    /**
     * Содержимое всех прикреплённых файлов разом. Вызывающий код кладёт
     * `buildAttachmentDocumentsNote(items)` в промпт хода.
     */
    async readDocuments(args: { paths: readonly string[]; agentId?: string | null }) { const dir = resolveAttachmentOwnerDir(args.paths[0] ?? "") ?? (() => { try { return resolveDir(args.agentId); } catch { return null; } })(); if (dir == null) { deps.report?.({ extension: "attachments", kind: "read_documents_miss", hasActive: args.agentId != null }); return null; } const items = await readAttachmentDocuments(dir, args.paths); return { items, note: buildAttachmentDocumentsNote(items) }; },
```

## 4. `source/host/runner/prompt-collector-glue.ts` — feed the note into the turn prompt

Why: `buildAttachedFilesNote` sends only paths and sizes. This is the defect
`attachment-content-reaches-model.test.mjs` names in its header.

Apply the `archive/wave-3` hunks:

- import: add `import { attachmentFormatOf } from "../../shared/media/attachment-formats.js";`
  (keep `main`'s existing `SAND_BOX_WORKSPACE_ROOT` import from
  `../cloud-agents/cloud-agent-images.js` and `downloadBoxFiles` from
  `../box/box-transfer.js`; wave-3 consolidated them into box-transfer, which
  also exports the constant on `main`, but the consolidation is unrelated).
- `PromptCollectorHost`: add

```ts
  /**
   * Текст всех прикреплённых файлов разом — то, что возвращает метод
   * `attachments.readDocuments`. Раньше этого проброса не было: в модель уходили
   * пути и размеры, а ни байта содержимого, поэтому «свести четыре файла в один
   * отчёт» было невыполнимо. Пустая строка означает, что читать нечего.
   */
  readAttachmentDocuments?: ((paths: readonly string[]) => Promise<string | null>) | undefined;
```

- inside `createPromptCollectorGlue`, before `assembleTurnAction`:

```ts
  /**
   * Файлы, из которых движок способен взять текст. Фотографию и видео модель
   * и так видит отдельным вложением, а блок «прочитать нечем» про каждое
   * изображение только шумит в промпте.
   */
  function documentPathsForPrompt(files: readonly string[]): string[] {
    const paths: string[] = [];
    for (const filePath of files) {
      const cleaned = filePath.trim();
      if (cleaned.length === 0) continue;
      const format = attachmentFormatOf(cleaned);
      if (format === "image" || format === "media") continue;
      paths.push(cleaned);
    }
    return paths;
  }

  /** Блок с содержимым файлов для промпта. Пустая строка, если читать нечего. */
  async function buildAttachedDocumentsNote(files: readonly string[]): Promise<string> {
    const paths = documentPathsForPrompt(files);
    if (paths.length === 0 || host.readAttachmentDocuments == null) return "";
    try {
      const note = await host.readAttachmentDocuments(paths);
      return typeof note === "string" ? note.trim() : "";
    } catch {
      return "";
    }
  }
```

- in both `assembleTurnAction` and `assembleGeneratedTurnAction`, right after
  the `buildAttachedFilesNote`/`if (attachments.length > 0)` lines:

```ts
    const documents = await buildAttachedDocumentsNote(files);
    if (documents.length > 0) text = text.length > 0 ? `${text}\n\n${documents}` : documents;
```

## 5. `source/host/runner/runner-prompt-glue.ts` — forward the host method

- `RunnerPromptGlueOwner`: add

```ts
  /** Содержимое прикреплённых файлов текстом. Пустая строка, если читать нечего. */
  readonly readAttachmentDocuments?: (paths: readonly string[]) => Promise<string | null>;
```

- in the forwarding literal inside `createRunnerPromptGlue`, after the
  `uploadAttachmentsIntoBox` getter:

```ts
    get readAttachmentDocuments() { return owner.readAttachmentDocuments; },
```

## 6. `source/host/host-runner-composition.ts` — bind `attachments.readDocuments`

- after `const readVideoAttachmentBytes = method(attachments, "readVideoBytes");`
  (main ~line 1646):

```ts
    const readDocuments = method(attachments, "readDocuments");
    /**
     * Содержимое вложений текстом для промпта хода. Метод `readDocuments`
     * читает каждый файл своим движком и собирает блок сам; здесь только
     * проброс. Раньше его не было, и модель видела пути без содержимого.
     */
    const readAttachmentDocumentsNote = async (paths: readonly string[]): Promise<string> => {
      if (readDocuments === undefined || paths.length === 0) return "";
      try {
        const read = await readDocuments({ paths, agentId: session.id });
        return typeof read?.note === "string" ? read.note : "";
      } catch {
        return "";
      }
    };
```

- in the `createRunnerPromptGlue` argument object (after
  `uploadAttachmentsIntoBox: async paths => new Map(...)`, main ~line 1683):

```ts
          readAttachmentDocuments: readAttachmentDocumentsNote,
```

- in the runner host literal (after
  `uploadAttachmentsIntoBox: (hostPaths: readonly string[]) => method(attachments, "stageIntoBox")?.(session.id, hostPaths),`, main ~line 2099):

```ts
        readAttachmentDocuments: readAttachmentDocumentsNote,
```

## 7. `frontend/src/recovered/features/conversation/workspace/model.ts` — composer limit

Why: `COMPOSER_ATTACHMENT_LIMIT = 6` silently drops every file past the
sixth while the host accepts twenty; the two numbers must come from one
constant.

- import at top: `import { ATTACHMENT_COUNT_LIMIT } from "../../../../../../source/shared/media/attachment-limits";`
- replace `export const COMPOSER_ATTACHMENT_LIMIT = 6;` with
  `export const COMPOSER_ATTACHMENT_LIMIT = ATTACHMENT_COUNT_LIMIT;` and add
  `ComposerFileSelection`, `selectComposerFiles` and
  `describeDroppedComposerFiles` exactly as in `archive/wave-3` (the callers
  of the old silent `slice` must switch to `selection.accepted` and surface
  `describeDroppedComposerFiles(selection.dropped)` to the user).

## 8. `frontend/src/recovered/features/conversation/workspace/desktop.ts` — Russian refusal notices

Why: the current notice is English and claims "max 25 MB" for documents.

- import at top: `import { formatAttachmentTooLargeNotice } from "../../../../../../source/shared/media/attachment-limits";`
- delete `VIDEO_EXTENSIONS` and `isVideoFileName`; replace
  `formatStageAttachmentFailureNotice` with the wave-3 version (single
  failure: `formatAttachmentTooLargeNotice(name)` / «Файл «X» пустой…» /
  «Не получилось прикрепить файл «X».»; multiple: per-file
  `formatAttachmentTooLargeNotice` joined, or «Попробуйте прикрепить их по
  одному.»).
- `commitComposerAttachments` error message →
  `"Мост не смог сохранить подготовленные вложения."`

---

## What stays red until these land

- `tsc -p source/tsconfig.json`: 3 errors, all `TS2305` on
  `attachment-limits.ts` (edit 1). Nothing inside the ported paths errors.
- `tests/attachment-any-format.test.mjs` + `tests/attachment-content-reaches-model.test.mjs`:
  bundle fails on the same missing exports; after edits 1–8 + report-tools
  are present, all 22 tests pass (verified on this branch's worktree).
- `documents-note.ts` needs no registration of its own: it is consumed only
  through `buildAttachmentDocumentsNote` inside the service's `readDocuments`.
