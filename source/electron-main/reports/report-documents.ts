/**
 * Отчёт на экране → файл на диске и страница для печати.
 *
 * Разбор markdown и сборку RTF/DOCX/ODT берём из пакета отчётных
 * инструментов (`source/packages/report-tools`) — это ровно тот код, которым
 * пользуется агент в `save_report`. Поэтому файл, сохранённый кнопкой
 * «Сохранить», и файл, сохранённый агентом, не расходятся: правила таблиц,
 * заголовков и кириллицы одни и те же. Здесь только три вещи, которых в
 * пакете нет: список форматов с русскими названиями, имя файла и страница для
 * печати — печати в пакете нет вовсе, её делает Chromium по HTML.
 *
 * Electron здесь не нужен: модуль чистый, его можно проверить без окна.
 */

import {
  blocksToDocx,
  blocksToOdt,
  blocksToRtf,
  reportBlocks,
  safeFileName,
  stripBoldMarkers,
  type ReportBlock,
  type ReportFormat,
} from "../../packages/report-tools/index.js";

export type { ReportFormat };

/**
 * Формат по умолчанию — `docx`.
 *
 * Выбор не по привычке, а по двум проверяемым свойствам:
 *  - русский Word открывает `.docx` сам, без «выберите кодировку», потому что
 *    внутри OOXML текст хранится в UTF-8;
 *  - в DOCX таблицы настоящие (`w:tbl`), а не «ячейки, склеенные табуляцией».
 *    В RTF пакет собирает таблицу как `\tab`-строку, и на бумаге она
 *    выглядит как текст с отступами.
 *
 * RTF остаётся вторым в списке для старого Word, ODT — для LibreOffice,
 * `.md` — когда нужно просто открыть текст в блокноте.
 */
export const DEFAULT_REPORT_FORMAT: ReportFormat = "docx";

export interface ReportFormatChoice {
  readonly id: ReportFormat;
  /** Что видит пользователь в окне сохранения. */
  readonly label: string;
  readonly extension: string;
}

/** Порядок в окне сохранения: первым идёт лучший для русского Word. */
export const REPORT_FORMAT_CHOICES: readonly ReportFormatChoice[] = [
  { id: "docx", label: "Документ Word (docx)", extension: "docx" },
  { id: "rtf", label: "Документ для старого Word (rtf)", extension: "rtf" },
  { id: "odt", label: "Документ LibreOffice (odt)", extension: "odt" },
  { id: "md", label: "Текст в markdown (md)", extension: "md" },
];

const FORMAT_IDS: readonly string[] = REPORT_FORMAT_CHOICES.map((choice) => choice.id);

/** Что просил интерфейс, если формат неизвестен или не пришёл. */
export function normalizeReportFormat(value: unknown): ReportFormat {
  return typeof value === "string" && FORMAT_IDS.includes(value) ? value as ReportFormat : DEFAULT_REPORT_FORMAT;
}

/** Расширение, написанное пользователем в окне сохранения, если он его поменял. */
export function reportFormatFromPath(path: string): ReportFormat {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  const extension = match?.[1]?.toLowerCase();
  if (extension === undefined) return DEFAULT_REPORT_FORMAT;
  const found = REPORT_FORMAT_CHOICES.find((choice) => choice.extension === extension);
  return found?.id ?? DEFAULT_REPORT_FORMAT;
}

/** Имя файла по названию отчёта: то же чистка имени, что у агента в `save_report`. */
export function reportFileName(title: string, format: ReportFormat): string {
  return `${safeFileName(title)}.${format}`;
}

export function reportFilters(): readonly { readonly name: string; readonly extensions: readonly string[] }[] {
  return [{ name: "Отчёт", extensions: REPORT_FORMAT_CHOICES.map((choice) => choice.extension) }];
}

/** Байты документа в выбранном формате. Пустой текст даёт пустой документ, а не отказ. */
export function reportDocumentBytes(markdown: string, format: ReportFormat): Uint8Array {
  if (format === "md") return new TextEncoder().encode(markdown);
  const blocks = reportBlocks(markdown);
  if (format === "docx") return blocksToDocx(blocks);
  if (format === "odt") return blocksToOdt(blocks);
  return new TextEncoder().encode(blocksToRtf(blocks));
}

export function htmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Те же блоки, что у файла, — только в HTML. Блоки приходят из пакета, а не разбираются здесь снова. */
export function reportBlocksToHtml(blocks: readonly ReportBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.kind === "heading") {
      const level = Math.min(3, Math.max(1, block.level));
      parts.push(`<h${level}>${htmlEscape(stripBoldMarkers(block.text))}</h${level}>`);
      continue;
    }
    if (block.kind === "bullet") {
      parts.push(`<ul><li>${htmlEscape(block.text)}</li></ul>`);
      continue;
    }
    if (block.kind === "paragraph") {
      parts.push(`<p>${htmlEscape(block.text)}</p>`);
      continue;
    }
    const [first, ...rest] = block.rows;
    if (first === undefined) continue;
    const head = first.map((cell) => `<th>${htmlEscape(cell)}</th>`).join("");
    const body = rest.map((row) => `<tr>${row.map((cell) => `<td>${htmlEscape(cell)}</td>`).join("")}</tr>`).join("");
    parts.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
  }
  return parts.join("\n");
}

/** Лист A4 для печати: поля, шрифт и рамки таблиц заданы в CSS, а не окном драйвера. */
const REPORT_PRINT_STYLE = [
  "@page { size: A4; margin: 18mm 14mm; }",
  "html { print-color-adjust: exact; -webkit-print-color-adjust: exact; }",
  'body { font-family: "Times New Roman", Times, serif; font-size: 12pt; line-height: 1.45; color: #000; margin: 0; }',
  "h1 { font-size: 17pt; margin: 0 0 10pt; }",
  "h2 { font-size: 14pt; margin: 14pt 0 6pt; }",
  "h3 { font-size: 12.5pt; margin: 12pt 0 5pt; }",
  "p { margin: 0 0 6pt; }",
  "ul { margin: 0 0 8pt; padding-left: 20pt; }",
  "table { border-collapse: collapse; width: 100%; margin: 0 0 10pt; }",
  "th, td { border: 1px solid #000; padding: 4pt 6pt; text-align: left; vertical-align: top; }",
  "th { background: #f0f0f0; }",
  "tr { break-inside: avoid; }",
].join("\n");

export function reportPrintHtml(title: string, markdown: string): string {
  const body = reportBlocksToHtml(reportBlocks(markdown));
  return [
    "<!doctype html>",
    '<html lang="ru"><head><meta charset="utf-8">',
    `<title>${htmlEscape(title)}</title>`,
    `<style>${REPORT_PRINT_STYLE}</style>`,
    "</head><body>",
    `<h1>${htmlEscape(title)}</h1>`,
    body,
    "</body></html>",
  ].join("");
}