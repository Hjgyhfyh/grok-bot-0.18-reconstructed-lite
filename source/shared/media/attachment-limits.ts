import { VIDEO_MIME_FROM_EXTENSION, extensionOf } from "./media-extensions.js";
import { attachmentFormatOf } from "./attachment-formats.js";

/**
 * Лимиты вложений.
 *
 * Раньше всё, что не видео, ограничивалось 25 МБ, и проверка шла по имени:
 * `nameLooksLikeVideo` смотрит только на пять расширений. Заведующая
 * библиотеки присылает сканы PDF, выгрузки таблиц и фотографии из архива —
 * 25 МБ там заканчивается быстро. Документы и архивы получили отдельную
 * полосу, остальное осталось на прежнем уровне: защита от абсурда на месте.
 */

/** Обычный файл: фотография, текст, таблица в тексте. */
export const ATTACHMENT_BYTE_LIMIT = 25 * 1024 * 1024;
/** Видео. */
export const VIDEO_BYTE_LIMIT = 200 * 1024 * 1024;
/** Документ или архив: `.docx`, `.odt`, `.xlsx`, `.pdf`, `.zip` и подобное. */
export const DOCUMENT_BYTE_LIMIT = 100 * 1024 * 1024;

/**
 * Сколько файлов можно прикрепить к одному сообщению. Раньше интерфейс
 * резал шесть и молча выбрасывал остальные, а заведующая просит «свести четыре
 * файла в один отчёт». Восемьдесят процентов рабочих запросов — это 4–10
 * файлов; двадцать — это уже свалка, а не отчёт.
 */
export const ATTACHMENT_COUNT_LIMIT = 20;

/**
 * Сколько символов текста одного файла уходит в контекст модели. 150 000
 * символов — это примерно 40 000 токенов; для библиотечных отчётов хватает,
 * а для файла на 2 МБ хватать не должно.
 */
export const ATTACHMENT_TEXT_CHAR_LIMIT = 150_000;
/** Общий потолок на один ход, чтобы четыре больших файла не съели окно целиком. */
export const ATTACHMENT_TEXT_TOTAL_CHAR_LIMIT = 600_000;

export const BYTES_PER_MB = 1024 * 1024;

export function nameLooksLikeVideo(name: string): boolean { return VIDEO_MIME_FROM_EXTENSION[extensionOf(name)] !== undefined; }

/** `true` для форматов, у которых документная полоса. Видео сюда не попадает. */
export function nameLooksLikeDocument(name: string): boolean {
  if (nameLooksLikeVideo(name)) return false;
  const format = attachmentFormatOf(name);
  return format === "docx" || format === "doc" || format === "odt" || format === "ods"
    || format === "odp" || format === "rtf" || format === "xlsx" || format === "xls" || format === "pdf"
    || format === "archive";
}

export function attachmentByteLimitForName(name: string): number {
  if (nameLooksLikeVideo(name)) return VIDEO_BYTE_LIMIT;
  if (nameLooksLikeDocument(name)) return DOCUMENT_BYTE_LIMIT;
  return ATTACHMENT_BYTE_LIMIT;
}

export function formatMegabytes(bytes: number): string { return `${Math.round(bytes / BYTES_PER_MB)} MB`; }

/** Человеческий текст о лимите — по-русски, его видит заведующая. */
export function describeAttachmentByteLimitRu(filename: string): string {
  if (nameLooksLikeVideo(filename)) return "видео — до 200 МБ";
  if (nameLooksLikeDocument(filename)) return "документ или архив — до 100 МБ";
  return "файл — до 25 МБ";
}

/** Сообщение о слишком большом файле — по-русски. */
export function formatAttachmentTooLargeNotice(filename: string): string {
  return `«${filename}» слишком большой: ${describeAttachmentByteLimitRu(filename)}. Сожмите файл или пришлите его по частям.`;
}

export class AttachmentTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Файл превышает ${limitBytes} байт.`);
    this.name = "AttachmentTooLargeError";
  }
}
