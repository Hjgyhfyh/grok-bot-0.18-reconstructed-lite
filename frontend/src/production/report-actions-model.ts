/**
 * Отчёт на экране: когда сообщение считать отчётом и что сказать пользователю.
 *
 * Отчёт приходит в ленту обычным сообщением помощника — `report_preview`
 * отправляет `send-message` с текстом «название, пустая строка, сам отчёт».
 * Пометки «это отчёт» в сообщении нет, и поставить её некуда: хост менять нельзя.
 * Поэтому сообщение опознаётся по виду: сверху короткая строка-заголовок, под
 * ней разделённый текст — заголовки, списки или таблица.
 *
 * Ошибиться можно только в одну сторону: лишние кнопки под длинным ответом со
 * списком. Обратная ошибка (отчёт без кнопок) бьёт по делу, поэтому условия
 * снижены до минимума, который отличает документ от переписки.
 *
 * Все подписи — простым языком: без «экспорта», «формата документа» и «диалога».
 */

export type ReportFormat = "rtf" | "docx" | "odt" | "md";

/**
 * Формат по умолчанию — тот же, что и в главном процессе
 * (`source/electron-main/reports/report-documents.ts`): русский Word открывает
 * `.docx` сам, а таблицы в нём настоящие, а не «ячейки через табуляцию».
 */
export const DEFAULT_REPORT_FORMAT: ReportFormat = "docx";

export interface ReportMessage {
  /** То, что стоит в имени файла и в заголовке листа. */
  readonly title: string;
  /** Сам отчёт без строки-заголовка. */
  readonly markdown: string;
}

/** Короче этого отчёт не считается отчётом: одна фраза — это переписка. */
export const REPORT_MIN_BODY_CHARS = 80;
const TITLE_MAX_CHARS = 200;

/** Строка, с которой начинается markdown-структура, а не название. */
const STRUCTURE_LINE = /^(?:#{1,6}\s|\||[-*+>]\s|\d+(?:\.\d+)*[.)]\s)/;

const BODY_STRUCTURE = [
  /^#{1,6}\s+\S/m, // заголовок раздела
  /^\s*\|.*\|\s*$/m, // строка таблицы
  /^\s*[-*+]\s+\S/m, // список
  /^\s*\d+(?:\.\d+)*[.)]\s+\S/m, // пункт отчёта: «3.1.2 Название»
  /^[^\n]*\t[^\n]*$/m, // таблица колонками через табуляцию
];

export function hasReportStructure(body: string): boolean {
  return BODY_STRUCTURE.some((pattern) => pattern.test(body));
}

/**
 * Название и текст отчёта из сообщения, либо `null`, если это не отчёт.
 *
 * `null` означает «кнопок не будет». Короткий ответ вроде «Готово, файл в
 * папке Отчёты» под это не попадает: под ним нет ни заголовка, ни таблицы.
 */
export function detectReportMessage(content: string): ReportMessage | null {
  const text = content.replace(/\r\n?/g, "\n").trim();
  if (text.length === 0) return null;
  const lines = text.split("\n");
  const title = (lines[0] ?? "").trim();
  if (title.length < 3 || title.length > TITLE_MAX_CHARS || STRUCTURE_LINE.test(title)) return null;
  const markdown = lines.slice(1).join("\n").trim();
  if (markdown.length < REPORT_MIN_BODY_CHARS) return null;
  if (lines.slice(1).filter((line) => line.trim().length > 0).length < 2) return null;
  if (!hasReportStructure(markdown)) return null;
  return { title, markdown };
}

// ───────────────────────── подписи для пользователя ─────────────────────────

export const REPORT_SAVE_LABEL = "Сохранить";
export const REPORT_PRINT_LABEL = "Печать";
export const REPORT_SAVE_HINT = "Сохранить отчёт в файл";
export const REPORT_PRINT_HINT = "Распечатать отчёт на принтере";
export const REPORT_ACTIONS_LABEL = "Что сделать с отчётом";
export const REPORT_BRIDGE_MISSING = "Отчёт сохраняется программой на этом компьютере. Перезапустите программу и попробуйте снова.";
export const REPORT_SAVED_PREFIX = "Отчёт сохранён: ";
export const REPORT_PRINTED = "Отчёт отправлен на принтер.";
export const REPORT_SAVE_FAILED = "Не получилось сохранить отчёт. Попробуйте ещё раз.";
export const REPORT_PRINT_FAILED = "Не получилось отправить отчёт на принтер. Попробуйте ещё раз.";

export interface ReportActionStatus {
  readonly tone: "ok" | "error";
  readonly text: string;
}

function readMessage(value: unknown): string | null {
  if (typeof value !== "object" || value == null) return null;
  const message = (value as { readonly message?: unknown }).message;
  return typeof message === "string" && message.length > 0 ? message : null;
}

/**
 * Ответ главного процесса → строка под кнопками. `null` означает «ничего не
 * показывать»: пользователь закрыл окно сохранения — это его выбор, а не сбой.
 */
export function describeSaveOutcome(value: unknown): ReportActionStatus | null {
  if (typeof value !== "object" || value == null) return { tone: "error", text: REPORT_SAVE_FAILED };
  const result = value as { readonly saved?: unknown; readonly path?: unknown };
  if (result.saved === true && typeof result.path === "string" && result.path.length > 0) {
    return { tone: "ok", text: `${REPORT_SAVED_PREFIX}${result.path}` };
  }
  if (result.saved === false && (value as { readonly reason?: unknown }).reason === "cancelled") return null;
  return { tone: "error", text: readMessage(value) ?? REPORT_SAVE_FAILED };
}

export function describePrintOutcome(value: unknown): ReportActionStatus | null {
  if (typeof value !== "object" || value == null) return { tone: "error", text: REPORT_PRINT_FAILED };
  const result = value as { readonly printed?: unknown };
  if (result.printed === true) return { tone: "ok", text: REPORT_PRINTED };
  return { tone: "error", text: readMessage(value) ?? REPORT_PRINT_FAILED };
}

/** Ошибка, дошедшая из моста: сообщение оставляем, чужое имя класса прячем. */
export function describeActionFailure(error: unknown, fallback: string): ReportActionStatus {
  const text = typeof error === "object" && error != null && typeof (error as { readonly message?: unknown }).message === "string"
    ? (error as { readonly message: string }).message
    : "";
  return { tone: "error", text: text.length > 0 ? text : fallback };
}