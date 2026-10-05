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
import { docxZipToText, odtZipToText, officeZipKindOfNames, xlsxZipToText } from "./ooxml.js";
import { decodeTextBytes, markupToText } from "./plain-text.js";
import { rtfBytesToText } from "./rtf.js";
import { guardedZipEntryNames, planGuardedZipEntries, readGuardedZipEntry, type ZipReadLimits } from "./zip-reader.js";

const MAX_ENTRY_CHARS = 40_000;
/**
 * Сколько байт части архива декодируется в строку. Модель получает не больше
 * 150 000 символов, а часть на 48 МБ раньше превращалась в строку целиком.
 */
const ENTRY_DECODE_BUDGET = 8 * 1024 * 1024;
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
      const plan = planGuardedZipEntries(data, limits);
      const kind = officeZipKindOfNames(guardedZipEntryNames(plan));
      if (kind === "docx") return docxZipToText(data, limits);
      if (kind === "xlsx") return xlsxZipToText(data, limits);
      return odtZipToText(data, limits);
    }
    if (extension === "rtf") return rtfBytesToText(data);
    if (!isTextPreviewableName(name)) return null;
    const readable = data.byteLength > ENTRY_DECODE_BUDGET ? data.subarray(0, ENTRY_DECODE_BUDGET) : data;
    const decoded = decodeTextBytes(readable);
    return MARKUP_INSIDE.has(extension) ? markupToText(decoded.text) : decoded.text;
  });
}

/** Имя части, список частей и текст из текстовых файлов. */
export function documentArchiveToText(bytes: Uint8Array, limits: ZipReadLimits, maxInnerFiles: number): string {
  // Части распаковываются по одной: раньше `readGuardedZipEntries` держал в
  // памяти весь архив разом, и две части по 48 МБ жили одновременно.
  const plan = planGuardedZipEntries(bytes, limits);
  const listing = plan.entries
    .map((entry) => `${entry.name} (${Math.round(Math.max(entry.uncompressedSize, entry.compressedSize) / 1024)} КБ)`)
    .join("\n");
  const blocks: string[] = [`Состав архива:\n${listing}`];
  let shown = 0;
  let inflated = 0;
  for (const item of plan.entries) {
    if (shown >= maxInnerFiles) { blocks.push(`Остальные части архива не показаны.`); break; }
    if (item.uncompressedSize > limits.maxEntryBytes) continue;
    const extension = attachmentExtension(item.name);
    const worthReading = extension != null && (OFFICE_INSIDE.has(extension) || extension === "rtf" || isTextPreviewableName(item.name));
    if (!worthReading) continue;
    const entry = readGuardedZipEntry(plan, item, inflated);
    inflated += entry.data.byteLength;
    const text = textOfEntry(entry.name, entry.data, limits);
    if (text == null || text.trim().length === 0) continue;
    shown += 1;
    // Текст части не обрезается: файл внутри архива должен доехать до модели
    // таким, какой он есть, вместе с переводами строк.
    blocks.push(`## Файл в архиве: ${entry.name}\n${text.slice(0, MAX_ENTRY_CHARS)}`);
  }
  return blocks.join("\n\n");
}
