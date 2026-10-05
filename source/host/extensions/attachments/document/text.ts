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
import { docxZipToText, DocumentParseError, odtZipToText, officeZipKindOf, officeZipKindOfNames, xlsxZipToText } from "./ooxml.js";
import { decodeTextBytes, markupToText, utf16Flavour } from "./plain-text.js";
import { pdfBytesToText, PdfTextError } from "./pdf.js";
import { rtfBytesToText } from "./rtf.js";
import { hasZipSignature, planGuardedZipEntries, guardedZipEntryNames, ZipGuardError, type ZipReadLimits } from "./zip-reader.js";

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
  zip: { maxEntries: 2_000, maxEntryBytes: 48 * 1024 * 1024, maxTotalBytes: DOCUMENT_BYTE_LIMIT },
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

/**
 * Сколько байт файла имеет смысл декодировать в строку. В модель уходит не больше
 * `ATTACHMENT_TEXT_CHAR_LIMIT` символов, а HTML на 25 МБ раньше стоил 362 МБ
 * памяти: разметка превращалась в пять миллионов отдельных строк. Восемь мегабайт
 * заведомо больше потолка символов, поэтому текст от этого не теряется.
 */
const decodeByteBudget = 8 * 1024 * 1024;

/**
 * Имя файла без пути: заведующая видит в отказе своё `protokol.doc`, а не
 * `C:\Users\...\dbbot\agents\<uuid>\attachments\protokol.doc`. Раньше путь
 * укорачивался по длине и оставался целиком, если помещался.
 */
function shortName(name: string): string {
  const parts = name.split(/[/\\]/).filter((part) => part.length > 0);
  const base = parts.length === 0 ? name : (parts.at(-1) as string);
  return base.length <= MAX_NAME_FOR_NOTICE ? base : `…${base.slice(-(MAX_NAME_FOR_NOTICE - 1))}`;
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
    notice: extra.notice ?? (status === "empty" && extra.status == null ? EMPTY_TEXT_NOTICE_RU : ""),
  };
}

/**
 * Пустой результат тоже объясняется по-русски. Раньше модель получала строку
 * «NOT READABLE.» без причины и не могла объяснить пользователю, что произошло.
 */
const EMPTY_TEXT_NOTICE_RU = "В файле нет текста: только пробелы и пустые строки.";

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

/**
 * Тот же отказ, но со статусом «нечитаемый» — файл существует и известного
 * формата, но добраться до текста нечем. Формулировка собирается общей
 * функцией, иначе такие ветки расходятся между собой.
 */
function unreadable(name: string, format: AttachmentFormat, reason?: string): AttachmentTextResult {
  return {
    status: "unreadable",
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

/**
 * Сколько байт в начале файла просматривается в поиске сигнатуры. По спецификации
 * перед `%PDF` может лежать мусор (файл, скачанный как `.txt`, склеенный выгрузкой),
 * и такой PDF обязан читаться как PDF, а не уходить в модель сырым текстом.
 */
const SIGNATURE_WINDOW = 1_024;

/** Начало файла без BOM: метка UTF-8 не должна прятать сигнатуру RTF. */
function startWithoutBom(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3);
  return bytes;
}

function startsWithAt(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false;
  }
  return true;
}

function hasSignatureInWindow(bytes: Uint8Array, signature: readonly number[]): boolean {
  const limit = Math.min(bytes.length, SIGNATURE_WINDOW);
  for (let offset = 0; offset + signature.length <= limit; offset += 1) {
    if (startsWithAt(bytes, signature, offset)) return true;
  }
  return false;
}

export function sniffFormat(bytes: Uint8Array): SniffedFormat {
  if (hasZipSignature(bytes)) return "zip-ooxml";
  if (hasSignatureInWindow(bytes, [0x25, 0x50, 0x44, 0x46])) return "pdf";
  const start = startWithoutBom(bytes);
  if (startsWithAt(start, [0x7b, 0x5c, 0x72, 0x74, 0x66])) return "rtf";
  if (startsWithAt(start, [0xd0, 0xcf, 0x11, 0xe0])) return "ole";
  // Нули в файле — это не всегда двоичный файл: так записан UTF-16 без метки.
  if (looksLikeBinary(bytes) && utf16Flavour(bytes) == null) return "binary";
  return "text";
}

function officeZipFormatOf(bytes: Uint8Array, limits: DocumentExtractLimits): AttachmentFormat {
  try {
    // Состав архива известен из центрального каталога: распаковывать части ради
    // проверки «docx или обычный архив» незачем, иначе документ читается дважды.
    return officeZipKindOfNames(guardedZipEntryNames(planGuardedZipEntries(bytes, limits.zip)));
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
        // Скан без текстового слоя и битый файл — это разные вещи. Если ни одна
        // страница не дала содержимого, файл не разобран, и говорить про сканы
        // враньё: модель отвечает пользователю, что в документе нет текста.
        if (result.damaged) {
          return unreadable(nameOrPath, "pdf", `Файл ${name} повреждён: текст из него не достать.`);
        }
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
        return unreadable(nameOrPath, kind, `Разворачивать такой архив слишком опасно или долго: ${error.message}`);
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
  const readable = bytes.length > decodeByteBudget ? bytes.subarray(0, decodeByteBudget) : bytes;
  if (declared === "html" || declared === "xml") {
    const decoded = decodeTextBytes(readable);
    return finish(nameOrPath, declared, markupToText(decoded.text), limits, { encoding: decoded.encoding });
  }
  if (declared === "archive") {
    return refuse(nameOrPath, "archive", "Это не zip: распакуйте его и пришлите файлы по одному.");
  }
  const decoded = decodeTextBytes(readable);
  return finish(nameOrPath, declared, decoded.text, limits, { encoding: decoded.encoding });
}

export { officeZipKindOf };
