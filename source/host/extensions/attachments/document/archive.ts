/**
 * Текст из архива.
 *
 * Заведующая присылает zip с фотографиями и протоколами. Сами фотографии
 * текста не дают, но имена файлов и текстовые документы внутри — дают, и по
 * ним уже можно понять, что за отчёт прислали. Поэтому архив читается
 * частично: сначала список частей, потом текст из текстовых и офисных файлов.
 *
 * 7z и rar не читаются: в проекте нет ни одной библиотеки для них. Для них
 * возвращается честный отказ по-русски, а не пустое «прочитано».
 */

import { attachmentExtension } from "../../../../shared/media/attachment-open-policy.js";
import { isTextPreviewableName } from "../../../../shared/media/attachment-preview.js";
import { docxZipToText, odtZipToText, officeZipKindOf, xlsxZipToText } from "./ooxml.js";
import { decodeTextBytes, markupToText } from "./plain-text.js";
import { rtfBytesToText } from "./rtf.js";
import { readGuardedZipEntries, type ZipReadLimits } from "./zip-reader.js";

const MAX_ENTRY_CHARS = 40_000;
const OFFICE_INSIDE = new Set(["docx", "odt", "xlsx"]);
const MARKUP_INSIDE = new Set(["html", "htm", "xml", "svg"]);

function safe<T>(action: () => T): T | null {
  try { return action(); } catch { return null; }
}

function textOfEntry(name: string, data: Uint8Array, limits: ZipReadLimits): string | null {
  const extension = attachmentExtension(name);
  if (extension == null) return null;
  return safe(() => {
    if (OFFICE_INSIDE.has(extension)) {
      const kind = officeZipKindOf(readGuardedZipEntries(data, limits));
      if (kind === "docx") return docxZipToText(data, limits);
      if (kind === "xlsx") return xlsxZipToText(data, limits);
      return odtZipToText(data, limits);
    }
    if (extension === "rtf") return rtfBytesToText(data);
    if (!isTextPreviewableName(name)) return null;
    const decoded = decodeTextBytes(data);
    return MARKUP_INSIDE.has(extension) ? markupToText(decoded.text) : decoded.text;
  });
}

/** Имя части, список частей и текст из текстовых файлов. */
export function documentArchiveToText(bytes: Uint8Array, limits: ZipReadLimits, maxInnerFiles: number): string {
  const entries = readGuardedZipEntries(bytes, limits);
  const listing = entries.map((entry) => `${entry.name} (${Math.round(entry.uncompressedSize / 1024)} КБ)`).join("\n");
  const blocks: string[] = [`Состав архива:\n${listing}`];
  let shown = 0;
  for (const entry of entries) {
    if (shown >= maxInnerFiles) { blocks.push(`Остальные части архива не показаны.`); break; }
    if (entry.uncompressedSize > limits.maxEntryBytes) continue;
    const extension = attachmentExtension(entry.name);
    const worthReading = extension != null && (OFFICE_INSIDE.has(extension) || extension === "rtf" || isTextPreviewableName(entry.name));
    if (!worthReading) continue;
    const text = textOfEntry(entry.name, entry.data, limits);
    if (text == null) continue;
    const limited = text.slice(0, MAX_ENTRY_CHARS).trim();
    if (limited.length === 0) continue;
    shown += 1;
    blocks.push(`## Файл в архиве: ${entry.name}\n${limited}`);
  }
  return blocks.join("\n\n");
}
