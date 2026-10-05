/**
 * Содержимое вложений в промпте модели.
 *
 * До этого модель получала только пути и размеры: `buildAttachedFilesNote`
 * перечислял файлы, но ни одного байта их содержимого в контексте не было.
 * Заведующая просила «свести четыре файла в один отчёт» — и получала отказ
 * инструмента или выдуманный ответ. Здесь собирается блок, где у каждого
 * файла есть имя и его текст, а заголовок прямо говорит модели, что все
 * файлы относятся к одному запросу.
 *
 * Формат блока английский: он попадает в системный промпт рядом с
 * `buildAttachedFilesNote`. Сообщения пользователю — по-русски, они лежат в
 * `AttachmentTextResult.notice`.
 */

import { ATTACHMENT_TEXT_TOTAL_CHAR_LIMIT } from "../../../shared/media/attachment-limits.js";
import type { AttachmentTextResult } from "./document/text.js";

export interface AttachmentDocumentItem {
  readonly filename: string;
  readonly path: string;
  readonly bytes: number;
  readonly result: AttachmentTextResult;
}

export interface AttachmentDocumentsNoteOptions {
  /** Общий потолок на символы всех файлов за ход. */
  readonly totalCharBudget?: number;
}

export function formatAttachedBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

const OPENING = [
  "The user attached these files. Their contents are inlined below, file by file, so you do not",
  "need to open them yourself. Use ALL of the files together when the user asks for a combined",
  "report. Spreadsheet rows are separated by TAB characters; a document may be cut off, and the",
  "cut is marked. If a file could not be read, say so plainly and ask for it in Word or as a table.",
  "Never invent the contents of a file you cannot see below.",
].join(" ");

/** Режет набор файлов под общий бюджет, не теряя ни одного имени файла. */
export function trimDocumentsToBudget(
  items: readonly AttachmentDocumentItem[],
  totalCharBudget = ATTACHMENT_TEXT_TOTAL_CHAR_LIMIT,
): AttachmentDocumentItem[] {
  const trimmed: AttachmentDocumentItem[] = [];
  let spent = 0;
  for (const item of items) {
    const room = totalCharBudget - spent;
    const text = item.result.text;
    if (text.length <= room) { trimmed.push(item); spent += text.length; continue; }
    if (room < 200) {
      trimmed.push({ ...item, result: { ...item.result, text: "", truncated: text.length > 0 } });
      continue;
    }
    trimmed.push({ ...item, result: { ...item.result, text: text.slice(0, room), truncated: true } });
    spent = totalCharBudget;
  }
  return trimmed;
}

/** Блок для промпта. Пустая строка, если читать нечего. */
export function buildAttachmentDocumentsNote(
  items: readonly AttachmentDocumentItem[],
  options: AttachmentDocumentsNoteOptions = {},
): string {
  const trimmed = trimDocumentsToBudget(items, options.totalCharBudget ?? ATTACHMENT_TEXT_TOTAL_CHAR_LIMIT);
  const blocks: string[] = [];
  for (const [index, item] of trimmed.entries()) {
    const size = formatAttachedBytes(item.bytes);
    const header = `## File ${index + 1}: ${item.filename} (${item.result.format}${size.length > 0 ? `, ${size}` : ""})`;
    const { result } = item;
    if (result.text.trim().length === 0) {
      blocks.push(`${header}\nNOT READABLE. ${result.notice}`);
      continue;
    }
    const cut = result.truncated ? "\n[truncated: the file is longer than what fits here]" : "";
    blocks.push(`${header}\n${result.text}${cut}`);
  }
  if (blocks.length === 0) return "";
  return `${OPENING}\n\n${blocks.join("\n\n")}`;
}
