/**
 * Извлечение текста из вложения любого формата.
 *
 * Это точка, где раньше стоял белый список: `readAttachmentText` смотрел на
 * `TEXT_PREVIEWABLE_EXTENSIONS` и всё, чего там не было, называл двоичным.
 * Теперь решение принимает содержимое файла. Порядок такой:
 *
 *   1. по сигнатуре — zip, PDF, RTF, CFB (старый Office), текст, двоичное;
 *   2. по расширению — когда сигнатура не сработала;
 *   3. по содержимому zip — `word/document.xml`, `xl/workbook.xml`,
 *      `content.xml` с `mimetype` LibreOffice.
 *
 * Файл с расширением `.foo` и файл без расширения читаются так же, как
 * `.docx`. Отказ даётся только там, где прочитать нечем, и всегда по-русски.
 */

import {
  ATTACHMENT_TEXT_CHAR_LIMIT,
  DOCUMENT_BYTE_LIMIT,
} from "../../../../shared/media/attachment-limits.js";
import {
  attachmentFormatOf,
  attachmentReadFailureNoticeRu,
  attachmentWithoutTextNoticeRu,
  describeAttachmentFormatRu,
  isAttachmentReadableExtension,
  type AttachmentFormat,
} from "../../../../shared/media/attachment-formats.js";
import { attachmentExtension } from "../../../../shared/media/attachment-open-policy.js";
import { looksLikeBinary } from "../../../../shared/media/attachment-preview.js";
import { documentArchiveToText } from "./archive.js";
import { isArchiveExtension, isOpaqueArchiveExtension } from "../../../../shared/media/attachment-formats.js";
import { salvageLegacyOfficeText } from "./legacy-office.js";
import { docxZipToText, DocumentParseError, odtZipToText, officeZipKindOf, xlsxZipToText } from "./ooxml.js";
import { decodeTextBytes, markupToText } from "./plain-text.js";
import { pdfBytesToText, PdfTextError } from "./pdf.js";
import { rtfBytesToText } from "./rtf.js";
import { hasZipSignature, readGuardedZipEntries, ZipGuardError, type ZipReadLimits } from "./zip-reader.js";

export interface DocumentExtractLimits {
  /** Файл больше этого размера целиком не разбирается. */
  readonly maxBytes: number;
  /** Потолок на символы одного файла. */
  readonly maxChars: number;
  readonly zip: ZipReadLimits;
  /** Сколько файлов вытаскивается из архива. */
  readonly maxArchiveInnerFiles: number;
}

export const DEFAULT_DOCUMENT_LIMITS: DocumentExtractLimits = {
  maxBytes: DOCUMENT_BYTE_LIMIT,
  maxChars: ATTACHMENT_TEXT_CHAR_LIMIT,
  zip: { maxEntries: 2_000, maxEntryBytes: 48 * 1024 * 1024, maxTotalBytes: 96 * 1024 * 1024 },
  maxArchiveInnerFiles: 60,
};

export type AttachmentTextStatus = "text" | "partial" | "empty" | "unsupported" | "too-large" | "unreadable";

export interface AttachmentTextResult {
  readonly status: AttachmentTextStatus;
  readonly format: AttachmentFormat;
  readonly text: string;
  readonly truncated: boolean;
  readonly chars: number;
  readonly encoding: string | null;
  /** По-русски и пусто, когда претензий к файлу нет. */
  readonly notice: string;
}

const MAX_NAME_FOR_NOTICE = 80;

function shortName(name: string): string {
  return name.length <= MAX_NAME_FOR_NOTICE ? name : `…${name.slice(-(MAX_NAME_FOR_NOTICE - 1))}`;
}

function finish(
  name: string,
  format: AttachmentFormat,
  text: string,
  limits: DocumentExtractLimits,
  extra: { readonly encoding?: string | null; readonly status?: AttachmentTextStatus; readonly notice?: string } = {},
): AttachmentTextResult {
  const truncated = text.length > limits.maxChars;
  const limited = truncated ? text.slice(0, limits.maxChars) : text;
  const status = extra.status ?? (limited.trim().length === 0 ? "empty" : "text");
  return {
    status,
    format,
    text: limited,
    truncated,
    chars: limited.length,
    encoding: extra.encoding ?? null,
    notice: extra.notice ?? "",
  };
}

/** Отказ всегда заканчивается одной и той же фразой — что делать пользователю. */
function refuse(name: string, format: AttachmentFormat, reason?: string): AttachmentTextResult {
  return {
    status: "unsupported",
    format,
    text: "",
    truncated: false,
    chars: 0,
    encoding: null,
    notice: attachmentReadFailureNoticeRu(shortName(name), name, reason),
  };
}

function withoutText(name: string, format: AttachmentFormat): AttachmentTextResult {
  return {
    status: "empty",
    format,
    text: "",
    truncated: false,
    chars: 0,
    encoding: null,
    notice: attachmentWithoutTextNoticeRu(shortName(name), describeAttachmentFormatRu(name)),
  };
}

// ───────────────────────── сигнатуры ─────────────────────────

export type SniffedFormat =
  | "zip-ooxml" | "zip" | "pdf" | "rtf" | "ole" | "text" | "binary";

export function sniffFormat(bytes: Uint8Array): SniffedFormat {
  if (hasZipSignature(bytes)) return "zip-ooxml";
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf";
  if (bytes.length >= 5 && bytes[0] === 0x7b && bytes[1] === 0x5c && bytes[2] === 0x72 && bytes[3] === 0x74 && bytes[4] === 0x66) return "rtf";
  if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return "ole";
  if (looksLikeBinary(bytes)) return "binary";
  return "text";
}

function officeZipFormatOf(bytes: Uint8Array, limits: DocumentExtractLimits): AttachmentFormat {
  try {
    const entries = readGuardedZipEntries(bytes, limits.zip);
    return officeZipKindOf(entries);
  } catch {
    return "archive";
  }
}

function fromArchive(bytes: Uint8Array, limits: DocumentExtractLimits): string {
  return documentArchiveToText(bytes, limits.zip, limits.maxArchiveInnerFiles);
}

// ───────────────────────── главная функция ─────────────────────────

export function extractAttachmentText(
  nameOrPath: string,
  bytes: Uint8Array,
  limits: DocumentExtractLimits = DEFAULT_DOCUMENT_LIMITS,
): AttachmentTextResult {
  const declared = attachmentFormatOf(nameOrPath);
  const extension = attachmentExtension(nameOrPath);
  const name = shortName(nameOrPath);
  if (!isAttachmentReadableExtension(extension)) {
    return refuse(nameOrPath, declared, "Содержимое этого файла прочитать нечем. Пришлите документ в Word или таблицу в Excel.");
  }
  if (bytes.byteLength === 0) {
    return { status: "unreadable", format: declared, text: "", truncated: false, chars: 0, encoding: null, notice: `Файл ${name} пустой — пришлите его заново.` };
  }
  if (bytes.byteLength > limits.maxBytes) {
    return {
      status: "too-large",
      format: declared,
      text: "",
      truncated: false,
      chars: 0,
      encoding: null,
      notice: `Файл ${name} слишком большой: ${Math.round(bytes.byteLength / (1024 * 1024))} МБ. Пришлите его по частям или сожмите.`,
    };
  }

  const sniffed = sniffFormat(bytes);

  if (sniffed === "pdf") {
    try {
      const result = pdfBytesToText(bytes);
      if (result.encrypted) {
        return { status: "unreadable", format: "pdf", text: "", truncated: false, chars: 0, encoding: null, notice: `Файл ${name} защищён паролем — снимите пароль или пришлите его в Word.` };
      }
      if (result.text.length === 0) {
        return { status: "empty", format: "pdf", text: "", truncated: false, chars: 0, encoding: null, notice: `Файл ${name} — это PDF из сканированных страниц, текста в нём нет. Пришлите его в Word или в виде фотографий, чтобы я прочитал его сам.` };
      }
      return finish(nameOrPath, "pdf", result.text, limits);
    } catch (error) {
      return refuse(nameOrPath, "pdf", error instanceof PdfTextError ? `${error.message} Пришлите его в Word или в виде таблицы.` : undefined);
    }
  }

  if (sniffed === "rtf") return finish(nameOrPath, "rtf", rtfBytesToText(bytes), limits);

  if (sniffed === "ole") {
    const salvaged = salvageLegacyOfficeText(bytes, nameOrPath);
    if (salvaged == null) return refuse(nameOrPath, declared, "Это старый формат Word или Excel без Word на компьютере. Пришлите его в виде .docx или .xlsx.");
    return finish(nameOrPath, declared, salvaged, limits, {
      status: "partial",
      notice: `Файл ${name} прочитан частично: это старый формат ${describeAttachmentFormatRu(nameOrPath)} без таблиц и форматирования.`,
    });
  }

  if (sniffed === "zip-ooxml") {
    const kind = officeZipFormatOf(bytes, limits);
    try {
      if (kind === "docx") return finish(nameOrPath, declared === "docx" ? "docx" : kind, docxZipToText(bytes, limits.zip), limits);
      if (kind === "xlsx") return finish(nameOrPath, declared === "xlsx" ? "xlsx" : kind, xlsxZipToText(bytes, limits.zip), limits);
      if (kind === "odt") return finish(nameOrPath, declared === "odt" || declared === "ods" || declared === "odp" ? declared : kind, odtZipToText(bytes, limits.zip), limits);
      return finish(nameOrPath, "archive", fromArchive(bytes, limits), limits);
    } catch (error) {
      if (error instanceof ZipGuardError) {
        return { status: "unreadable", format: kind, text: "", truncated: false, chars: 0, encoding: null, notice: `Не смог прочитать файл ${name} — он, скорее всего, в формате ${describeAttachmentFormatRu(nameOrPath)}. Разворачивать такой архив слишком опасно или долго: ${error.message} Пришлите его в Word или в виде таблицы.` };
      }
      return refuse(nameOrPath, kind, error instanceof DocumentParseError ? `${error.message}` : undefined);
    }
  }

  if (sniffed === "binary") {
    if (isOpaqueArchiveExtension(extension)) {
      return refuse(nameOrPath, "archive", "Бот не умеет распаковывать 7z и rar без Word. Распакуйте архив и пришлите файлы по одному.");
    }
    if (isArchiveExtension(extension)) {
      return refuse(nameOrPath, "archive", "Это не zip: распакуйте его и пришлите файлы по одному.");
    }
    if (declared === "image") return withoutText(nameOrPath, "image");
    if (declared === "media") return withoutText(nameOrPath, "media");
    return refuse(nameOrPath, declared);
  }

  // `sniffed === "text"` — читаем с определением кодировки.
  if (declared === "html" || declared === "xml") {
    const decoded = decodeTextBytes(bytes);
    return finish(nameOrPath, declared, markupToText(decoded.text), limits, { encoding: decoded.encoding });
  }
  if (declared === "archive") {
    return refuse(nameOrPath, "archive", "Это не zip: распакуйте его и пришлите файлы по одному.");
  }
  const decoded = decodeTextBytes(bytes);
  return finish(nameOrPath, declared, decoded.text, limits, { encoding: decoded.encoding });
}

export { officeZipKindOf };
