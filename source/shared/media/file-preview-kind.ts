import {
  AUDIO_MIME_FROM_EXTENSION,
  IMAGE_MIME_FROM_EXTENSION,
  VIDEO_MIME_FROM_EXTENSION,
} from "./media-extensions.js";
import { attachmentExtension } from "./attachment-open-policy.js";
import { isTextPreviewableName } from "./attachment-preview.js";
import { attachmentFormatOf, isArchiveExtension } from "./attachment-formats.js";

const IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_MIME_FROM_EXTENSION).map((extension) => extension.slice(1)));
const VIDEO_EXTENSIONS = new Set(Object.keys(VIDEO_MIME_FROM_EXTENSION).map((extension) => extension.slice(1)));
const AUDIO_EXTENSIONS = new Set(Object.keys(AUDIO_MIME_FROM_EXTENSION).map((extension) => extension.slice(1)));
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);
const JSON_EXTENSIONS = new Set(["json"]);
const TABLE_EXTENSIONS = new Set(["csv", "tsv", "xlsx", "xls", "xlsm", "ods"]);

export type FilePreviewKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "table"
  | "json"
  | "markdown"
  | "docx"
  | "document"
  | "archive"
  | "text"
  | "unknown";

/**
 * Вид карточки вложения. Раньше `docx` был единственным «документом», а
 * `.doc`, `.odt`, `.ods`, `.rtf` и архивы попадали в `unknown`: из-за этого
 * `previewKindNeedsBytes` возвращал `false` и байты файла не отдавались
 * вообще. Теперь у документа и архива есть свои виды, и байты доходят.
 */
export function getFilePreviewKind(nameOrPath: string): FilePreviewKind {
  const extension = attachmentExtension(nameOrPath);
  if (extension == null) return "unknown";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (extension === "pdf") return "pdf";
  if (TABLE_EXTENSIONS.has(extension)) return "table";
  if (JSON_EXTENSIONS.has(extension)) return "json";
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (extension === "docx") return "docx";
  const format = attachmentFormatOf(nameOrPath);
  if (format === "doc" || format === "odt" || format === "ods" || format === "odp" || format === "rtf") return "document";
  if (format === "archive" || isArchiveExtension(extension)) return "archive";
  if (isTextPreviewableName(nameOrPath)) return "text";
  return "unknown";
}

export function previewKindNeedsBytes(kind: FilePreviewKind): boolean {
  return kind === "pdf" || kind === "table" || kind === "docx" || kind === "document"
    || kind === "archive" || kind === "text" || kind === "json" || kind === "markdown";
}
