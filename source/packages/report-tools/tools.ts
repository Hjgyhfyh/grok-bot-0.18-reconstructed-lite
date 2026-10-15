/**
 * Пять инструментов агента для работы с отчётами: `save_report`, `fill_sample`,
 * `report_preview`, `skill_list`, `skill_read`.
 *
 * Имена инструментов — в змеином регистре, как в текстах скиллов из папки
 * `skills/`: все десять скиллов пишут в промпте именно `save_report`,
 * `fill_sample` и `report_preview`. Переименование в `SaveReport` разорвало бы
 * связь между инструкцией и инструментом.
 *
 * Куда сохранять: `<dataRoot>/Отчёты/` — рядом с заметкой лежит и `.md`, и
 * документ. `dataRoot` — это `getSandRootDir()` из `source/host/host-paths.ts`
 * (по умолчанию `~/.grokbot`); путь приходит снаружи, потому что слой
 * `source/packages/**` не должен знать про хост.
 *
 * Канал превью: существующий `send-message` из `source/host/runner/turn-shape.ts`
 * и `turn-toolset.ts` (`turn.emitUpdate`). Новый тип события не заводится —
 * принимать его всё равно некому, пока не тронуты `turn-runtime.ts` и рендерер.
 * По правилу безопасности `report_preview` НЕ входит в `DELIVERY_TOOL_NAMES`:
 * он обновляет экран, а не доставляет ответ.
 *
 * Порт: Graphite Lite `ai/tools.rs:510-524, 1053-1167`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { blocksToDocx } from "./docx.js";
import { fillDocument, type FillReport } from "./fill-sample.js";
import { reportBlocks } from "./markdown-to-blocks.js";
import { blocksToOdt } from "./odt.js";
import { blocksToRtf } from "./rtf.js";
import { formatSkillList, listSkills, readSkill } from "./skills.js";

/** Раздел отчётов внутри хранилища. То же имя, что в Graphite Lite `memory.rs:18`. */
export const REPORTS_DIR_NAME = "Отчёты";

export type ReportFormat = "rtf" | "docx" | "odt" | "md";

/** Обновление для интерфейса в уже существующем канале `send-message`. */
export interface ReportPreviewUpdate {
  readonly type: "send-message";
  readonly message: { readonly type: "text"; readonly content: string };
  readonly timestampMs: number;
}

export interface ReportToolsDependencies {
  /** Корень данных приложения (`getSandRootDir()`), по умолчанию `~/.grokbot`. */
  readonly dataRoot: string;
  /** Папка со скиллами отчётов. */
  readonly skillsDir: string;
  /** Куда уходит превью. Не задано — превью пишется только в файл черновика. */
  readonly emitPreview?: (update: ReportPreviewUpdate) => void;
  /** Время для метки обновления; по умолчанию `Date.now`. */
  readonly now?: () => number;
}

export interface ReportTool<Args = any> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly parameters: z.ZodTypeAny;
  execute(args: Args): Promise<string>;
}

export function reportsDir(deps: ReportToolsDependencies): string {
  return join(deps.dataRoot, REPORTS_DIR_NAME);
}

/** Имя файла без символов, которые Windows не принимает в имени. */
export function safeFileName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
  return cleaned.length === 0 ? "отчёт" : cleaned;
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} Б` : `${Math.floor(bytes / 1024)} КБ`;
}

async function writeReportFile(path: string, data: Uint8Array | string): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  await writeFile(path, bytes);
  return bytes.length;
}

export interface SaveReportInput {
  readonly title: string;
  readonly markdown: string;
  readonly format?: ReportFormat;
}

export async function saveReport(
  input: SaveReportInput,
  deps: ReportToolsDependencies,
): Promise<string> {
  const format: ReportFormat = input.format ?? "rtf";
  const dir = reportsDir(deps);
  await mkdir(dir, { recursive: true });
  const name = safeFileName(input.title);

  const blocks = reportBlocks(input.markdown);
  const document =
    format === "docx" ? blocksToDocx(blocks)
    : format === "odt" ? blocksToOdt(blocks)
    : format === "md" ? new TextEncoder().encode(input.markdown)
    : new TextEncoder().encode(blocksToRtf(blocks));

  const notePath = join(dir, `${name}.md`);
  const documentPath = join(dir, `${name}.${format}`);
  await writeFile(notePath, input.markdown, "utf8");
  const size = await writeReportFile(documentPath, document);

  return [
    "Отчёт сохранён:",
    `- текст: ${notePath}`,
    `- документ: ${documentPath} (${formatSize(size)}, формат ${format})`,
  ].join("\n");
}

export interface FillSampleInput {
  readonly sample_path: string;
  readonly title: string;
  readonly markdown: string;
  readonly replacements?: readonly (readonly [string, string])[];
}

function formatFillReport(name: string, report: FillReport, path: string, size: number): string {
  const lines = [
    `Готово: заполнен сам образец «${name}», шрифты и таблицы сохранены как в оригинале.`,
    `- документ: ${path} (${formatSize(size)})`,
    ...report.applied.map(([section, count]) => `  • ${section.trim()} — строк данных: ${count}`),
  ];
  if (report.removedRows > 0) lines.push(`  • удалено строк-примеров: ${report.removedRows}`);
  if (report.replacements > 0) lines.push(`  • замен в шапке: ${report.replacements}`);
  if (report.notFound.length > 0) {
    lines.push(`! Разделы без пары в образце (проверь вручную): ${report.notFound.join("; ")}`);
  }
  for (const warning of report.warnings) lines.push(`! ${warning}`);
  return lines.join("\n");
}

export async function fillSample(
  input: FillSampleInput,
  deps: ReportToolsDependencies,
): Promise<string> {
  const sampleBytes = await readFile(input.sample_path);
  const { bytes, report } = fillDocument({
    sampleName: input.sample_path,
    sampleBytes,
    markdown: input.markdown,
    replacements: input.replacements ?? [],
  });

  const dir = reportsDir(deps);
  await mkdir(dir, { recursive: true });
  const name = safeFileName(input.title);
  // Итог сохраняем в том же формате, в каком пришёл образец: пользователь
  // ждёт открыть файл той же программой, в которой прислал форму.
  const sampleName = input.sample_path.split(/[\\/]/).pop() ?? input.sample_path;
  const dot = sampleName.lastIndexOf(".");
  const format = dot > 0 ? sampleName.slice(dot + 1).toLowerCase() : "doc";
  const documentPath = join(dir, `${name}.${format}`);
  await writeFile(join(dir, `${name}.md`), input.markdown, "utf8");
  const size = await writeReportFile(documentPath, bytes);

  return formatFillReport(sampleName, report, documentPath, size);
}

export interface ReportPreviewInput {
  readonly text: string;
  readonly title?: string;
}

export function buildReportPreviewUpdate(
  title: string,
  text: string,
  timestampMs: number,
): ReportPreviewUpdate {
  return {
    type: "send-message",
    message: { type: "text", content: `${title}\n\n${text}` },
    timestampMs,
  };
}

export async function reportPreview(
  input: ReportPreviewInput,
  deps: ReportToolsDependencies,
): Promise<string> {
  const title = (input.title ?? "Черновик отчёта").trim() || "Черновик отчёта";
  const dir = reportsDir(deps);
  await mkdir(dir, { recursive: true });
  const draftPath = join(dir, `${safeFileName(title)}-черновик.md`);
  await writeReportFile(draftPath, input.text);

  if (deps.emitPreview === undefined) {
    return `Черновик сохранён: ${draftPath}. На экран он не выведен: канал превью не подключён.`;
  }
  deps.emitPreview(
    buildReportPreviewUpdate(title, input.text, (deps.now ?? Date.now)()),
  );
  return `Превью отчёта «${title}» показано пользователю. Черновик: ${draftPath}`;
}

// ───────────────────────── схемы параметров ─────────────────────────

export const saveReportParameters = z.object({
  title: z.string().trim().min(1).describe("Имя отчёта, например «ФДБ Милосердие — 1 квартал 2026»."),
  markdown: z.string().describe("Полный текст отчёта в markdown: заголовки, списки, таблицы колонками через « | »."),
  format: z.enum(["rtf", "docx", "odt", "md"]).optional().describe(
    "Формат документа. Бери тот же, в котором прислан образец; если образца нет — rtf. По умолчанию rtf.",
  ),
});

export const fillSampleParameters = z.object({
  sample_path: z.string().trim().min(1).describe("Полный путь к файлу-образцу .rtf/.docx/.odt на компьютере пользователя."),
  title: z.string().trim().min(1).describe("Имя отчёта — оно станёт именем файла."),
  markdown: z.string().describe(
    "Готовый текст отчёта таблицей с теми же колонками, что в образце. Строка-раздел начинается с номера пункта (например «3.1.2») в первой колонке, во второй — подпись раздела; строки с пустой первой колонкой — данные.",
  ),
  replacements: z.array(z.tuple([z.string(), z.string()])).optional().describe(
    "Пары [что заменить, на что] для шапки образца: например [[\"за 2025 год\", \"за 2026 год\"]].",
  ),
});

export const reportPreviewParameters = z.object({
  title: z.string().trim().min(1).describe("Название отчёта, показывается над черновиком."),
  text: z.string().describe("Текст черновика отчёта в markdown — тот же, который пойдёт в файл."),
});

export const skillListParameters = z.object({});

export const skillReadParameters = z.object({
  name: z.string().trim().min(1).optional().describe("Slug или название скилла, например «fdb-miloserdie»."),
  skill: z.string().trim().min(1).optional().describe("Синоним name, если так удобнее."),
}).refine((value) => (value.name ?? value.skill ?? "").length > 0, {
  message: "передай имя скилла: name или skill",
  path: ["name"],
});

// ───────────────────────── описания для модели ─────────────────────────

const SAVE_REPORT_DESCRIPTION = [
  "Save a finished report in ONE call: writes the report text and a document file into the «Отчёты» folder of the app's data directory.",
  "Use it when there is NO sample (template) file among the input files, or when the user asked for a plain file.",
  "When a sample exists, use fill_sample instead — that one keeps the sample's fonts, sizes and tables.",
  "Never write the report file by hand and never call this twice for the same report.",
].join(" ");

const FILL_SAMPLE_DESCRIPTION = [
  "Fill the user's sample (template) document with data, keeping its formatting exactly: rows are inserted straight into the sample file, so fonts, sizes, borders and column widths stay as in the original.",
  "This is the preferred way to save a report whenever a sample in .rtf/.docx/.odt is among the input files.",
  "Requires an absolute path to the sample on the user's computer. The markdown must have the same columns as the sample: a section row starts with the item number in the first column (for example «3.1.2») and its label in the second; rows with an empty first column are the data rows.",
  "Do not use save_report when a sample exists — the sample's own look is lost there.",
].join(" ");

const REPORT_PREVIEW_DESCRIPTION = [
  "Show the report draft to the user on screen, and keep a copy as a draft file.",
  "Call it while you work: once after the first documents are parsed and once with the final text. The user reads the draft and may ask for corrections — show the corrected text again before saving.",
  "The text must be exactly the markdown that will be written to the file.",
].join(" ");

const SKILL_LIST_DESCRIPTION = [
  "List the report skills available: slug, title and a one-line summary of each.",
  "Call it before reading a neighbouring skill, or when you are not sure which report the user means.",
  "This tool takes no arguments.",
].join(" ");

const SKILL_READ_DESCRIPTION = [
  "Read the full text of a report skill by slug — the exact recipe for making one kind of report.",
  "Call it when the user asks for a report kind you do not have instructions for, or names a skill explicitly. The slug comes from skill_list, for example «fdb-miloserdie».",
  "Reading a skill does not start the work: follow the steps it lists.",
].join(" ");

// ───────────────────────── сборка набора ─────────────────────────

export function createReportTools(deps: ReportToolsDependencies): ReportTool<any>[] {
  return [
    {
      id: "SAVE_REPORT",
      name: "save_report",
      description: SAVE_REPORT_DESCRIPTION,
      parameters: saveReportParameters,
      execute: (args: SaveReportInput) => saveReport(args, deps),
    },
    {
      id: "FILL_SAMPLE",
      name: "fill_sample",
      description: FILL_SAMPLE_DESCRIPTION,
      parameters: fillSampleParameters,
      execute: (args: FillSampleInput) => fillSample(args, deps),
    },
    {
      id: "REPORT_PREVIEW",
      name: "report_preview",
      description: REPORT_PREVIEW_DESCRIPTION,
      parameters: reportPreviewParameters,
      execute: (args: ReportPreviewInput) => reportPreview(args, deps),
    },
    {
      id: "SKILL_LIST",
      name: "skill_list",
      description: SKILL_LIST_DESCRIPTION,
      parameters: skillListParameters,
      execute: () => listSkills(deps.skillsDir).then(formatSkillList),
    },
    {
      id: "SKILL_READ",
      name: "skill_read",
      description: SKILL_READ_DESCRIPTION,
      parameters: skillReadParameters,
      execute: (args: { name?: string; skill?: string }) =>
        readSkill(deps.skillsDir, args.name ?? args.skill ?? ""),
    },
  ];
}
