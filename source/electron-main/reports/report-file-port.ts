/**
 * Кнопки «Сохранить» и «Печать» под готовым отчётом.
 *
 * Здесь всё, что умеет только главный процесс: окно выбора места, запись
 * файла и отправка на принтер. Electron приходит портами — модуль можно
 * проверить, не открывая окно.
 *
 * Печать: страница собирается в HTML (`report-documents.ts`), грузится в
 * скрытое окно и печатается через `webContents.print` с `silent: false`.
 * Так открывается обычное окно печати Windows, где пользователь сам выбирает
 * принтер, число копий и бумагу. Молчаливую печать без выбора пользователь не
 * просил, поэтому `silent` здесь всегда false.
 */

import { resolveDefaultDownloadPath } from "../downloads/download-path.js";
import {
  DEFAULT_REPORT_FORMAT,
  normalizeReportFormat,
  reportDocumentBytes,
  reportFileName,
  reportFilters,
  reportFormatFromPath,
  reportPrintHtml,
  type ReportFormat,
} from "./report-documents.js";

export interface ReportSaveRequest {
  readonly title?: unknown;
  readonly markdown?: unknown;
  readonly format?: unknown;
}

export interface ReportPrintRequest {
  readonly title?: unknown;
  readonly markdown?: unknown;
}

/** Что показываем пользователю под кнопками. Всё по-русски и без терминов. */
export type ReportSaveOutcome =
  | { readonly saved: true; readonly path: string }
  | { readonly saved: false; readonly reason: "cancelled" }
  | { readonly saved: false; readonly reason: "empty"; readonly message: string }
  | { readonly saved: false; readonly reason: "failed"; readonly message: string };

export type ReportPrintOutcome =
  | { readonly printed: true }
  | { readonly printed: false; readonly reason: "empty"; readonly message: string }
  | { readonly printed: false; readonly reason: "failed"; readonly message: string };

/** Окно, в котором Chromium печатает страницу отчёта. */
export interface ReportPrintWindow {
  readonly webContents: {
    loadURL(url: string): Promise<void>;
    print(
      options: { readonly silent: boolean; readonly printBackground: boolean; readonly pageSize: "A4" },
      callback: (success: boolean, failureReason: string) => void,
    ): void;
    executeJavaScript(code: string): Promise<unknown>;
    isDestroyed?(): boolean;
  };
  isDestroyed(): boolean;
  destroy(): void;
}

export interface ReportFileDeps {
  readonly getMainWindow: () => unknown | null;
  readonly createHiddenWindow: (options: { readonly show: false }) => unknown;
  readonly showSaveDialog: (
    window: unknown | null,
    options: {
      readonly defaultPath: string;
      readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[];
    },
  ) => Promise<{ readonly canceled: boolean; readonly filePath?: string }>;
  readonly writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly createPrintWindow: () => ReportPrintWindow;
  readonly downloadsDir: string;
  readonly onEdgeFailure?: (leg: string, error: unknown) => void;
}

/**
 * Ошибка файла на языке пользователя. `ENOENT: no such file or directory,
 * open 'C:\…'` пользователю ничего не объясняет, а `EACCES` на Windows чаще
 * всего означает открытый в Word файл — об этом стоит сказать прямо.
 */
export function reportFileErrorMessage(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const target = typeof (error as { readonly path?: unknown })?.path === "string"
    ? (error as { readonly path: string }).path
    : "";
  const where = target.length > 0 ? `: ${target}` : "";
  if (code === "EACCES" || code === "EPERM" || code === "EBUSY") {
    return `не удалось записать файл${where}. Закройте его в Word и попробуйте ещё раз.`;
  }
  if (code === "ENOENT") return `не удалось записать файл${where}. Папка не найдена.`;
  if (code === "EISDIR") return `по этому пути лежит папка, а не файл${where}. Выберите имя файла.`;
  return error instanceof Error && error.message.length > 0
    ? `не удалось записать файл${where}. ${error.message}`
    : "не удалось записать файл.";
}

function requireMarkdown(request: ReportSaveRequest | ReportPrintRequest): string {
  return typeof request.markdown === "string" ? request.markdown : "";
}

function requireTitle(request: ReportSaveRequest | ReportPrintRequest): string {
  const title = typeof request.title === "string" ? request.title.trim() : "";
  return title.length > 0 ? title : "Отчёт";
}

const EMPTY_MARKDOWN_MESSAGE = "в сообщении нет текста отчёта. Попросите помощника показать отчёт ещё раз.";

/** Ждём отрисовку: два кадра достаточно, чтобы браузер посчитал ширину колонок. */
const LAYOUT_READY_SCRIPT = "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))";

async function waitForLayout(contents: ReportPrintWindow["webContents"]): Promise<void> {
  try {
    await contents.executeJavaScript(LAYOUT_READY_SCRIPT);
  } catch {
    // Разметка не успела за два кадра: печатаем как есть, а не отменяем печать.
  }
}

async function printDocument(html: string, deps: ReportFileDeps): Promise<void> {
  const printWindow = deps.createPrintWindow();
  try {
    await printWindow.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await waitForLayout(printWindow.webContents);
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      printWindow.webContents.print({ silent: false, printBackground: true, pageSize: "A4" }, (success, failureReason) => {
        if (!success && failureReason.length > 0) deps.onEdgeFailure?.("print", new Error(failureReason));
        finish();
      });
    });
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
  }
}

export interface ReportFileActions {
  saveFile(request: ReportSaveRequest): Promise<ReportSaveOutcome>;
  printReport(request: ReportPrintRequest): Promise<ReportPrintOutcome>;
}

export function createReportFilePort(deps: ReportFileDeps): ReportFileActions {
  return {
    async saveFile(request) {
      const markdown = requireMarkdown(request);
      if (markdown.trim().length === 0) {
        return { saved: false, reason: "empty", message: EMPTY_MARKDOWN_MESSAGE };
      }
      const title = requireTitle(request);
      const requested: ReportFormat = normalizeReportFormat(request.format);
      const owner = deps.getMainWindow() ?? deps.createHiddenWindow({ show: false });
      const defaultPath = resolveDefaultDownloadPath({
        fileName: reportFileName(title, requested),
        configuredDir: null,
        osDownloadsDir: deps.downloadsDir,
      });
      let prompt: { readonly canceled: boolean; readonly filePath?: string };
      try {
        prompt = await deps.showSaveDialog(owner, { defaultPath, filters: reportFilters() });
      } catch (error) {
        deps.onEdgeFailure?.("save-dialog", error);
        return { saved: false, reason: "failed", message: reportFileErrorMessage(error) };
      }
      if (prompt.canceled || prompt.filePath == null || prompt.filePath.length === 0) {
        return { saved: false, reason: "cancelled" };
      }
      try {
        await deps.writeFile(prompt.filePath, reportDocumentBytes(markdown, reportFormatFromPath(prompt.filePath)));
        return { saved: true, path: prompt.filePath };
      } catch (error) {
        deps.onEdgeFailure?.("save-write", error);
        return { saved: false, reason: "failed", message: reportFileErrorMessage(error) };
      }
    },

    async printReport(request) {
      const markdown = requireMarkdown(request);
      if (markdown.trim().length === 0) {
        return { printed: false, reason: "empty", message: EMPTY_MARKDOWN_MESSAGE };
      }
      try {
        await printDocument(reportPrintHtml(requireTitle(request), markdown), deps);
        return { printed: true };
      } catch (error) {
        deps.onEdgeFailure?.("print", error);
        return { printed: false, reason: "failed", message: "не получилось отправить отчёт на принтер. Проверьте, включён ли принтер." };
      }
    },
  };
}

export { DEFAULT_REPORT_FORMAT };