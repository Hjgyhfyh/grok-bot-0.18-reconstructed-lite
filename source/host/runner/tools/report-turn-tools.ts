/**
 * Подключение пяти отчётных инструментов к набору инструментов агента.
 *
 * Сами инструменты написаны в `source/packages/report-tools/`. Здесь только
 * две вещи, которых в пакете нет и которые по определению принадлежат хосту:
 *
 *  1. Русские описания. `ReportTool.description` в пакете — английский текст
 *     для модели; пользователь проекта русскоязычный, а десять скиллов в
 *     `skills/*.md` написаны по-русски и называют инструменты по-русски.
 *     Модель читает и то, и другое, и получает противоречивые подсказки.
 *     Описание для модели — это текст слоя хоста, поэтому оно здесь.
 *
 *  2. Форма TurnTool. `ReportTool.execute(args)` принимает разобранные
 *     аргументы, а агент отдаёт инструменту поток сырого JSON. Мост —
 *     `defineCommunicateTool`, тот же, что у `update_state` и `send-message`:
 *     он разбирает поток по zod-схеме, показывает вызов в панели хода и
 *     превращает ошибку в текст для модели.
 *
 * Путь к папке скиллов приходит снаружи и ищется в нескольких местах: путь,
 * зашитый в код, в упакованном `app.asar` не найдётся. Скрипты упаковки
 * (`scripts/package-windows-lite.mjs`) копируют `.build/app/**` и папку
 * `skills/` в архив не кладут, поэтому в упакованной сборке скиллов не будет,
 * пока их туда не положат. Пока папки нет, `skill_list` честно отвечает, что
 * скиллов нет, а не падает.
 *
 * Безопасность: `report_preview` НЕ входит в `DELIVERY_TOOL_NAMES`
 * (`source/host/runner/turn-shape.ts`). Он обновляет экран, а не доставляет
 * ответ, и добавлять его туда нельзя. Он идёт в интерфейс тем же событием
 * `send-message`, что и настоящий `SendMessage`, поэтому строка переписки
 * несёт автора, а `fromAgent`/`channel` (признаки чужой строки) не появляются.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  createReportTools,
  type ReportTool,
  type ReportToolsDependencies,
} from "../../../packages/report-tools/index.js";
import { defineCommunicateTool } from "./communicate-tool.js";

/** Имена пяти отчётных инструментов. Порядок тот же, что у пакета. */
export const REPORT_TURN_TOOL_NAMES = [
  "save_report",
  "fill_sample",
  "report_preview",
  "skill_list",
  "skill_read",
] as const;

export type ReportTurnToolName = (typeof REPORT_TURN_TOOL_NAMES)[number];

/** Явный путь к папке со скиллами. Первый, кого спрашивают. */
export const REPORT_SKILLS_DIR_ENV = "SAND_REPORT_SKILLS_DIR";

const SKILLS_DIRNAME = "skills";

/**
 * Описания инструментов для модели.
 *
 * Правило: пишем так, как объяснил бы простой человек, и не переводим имена
 * инструментов, параметров и названий папок — они и есть то, что модель
 * напечатает в вызове.
 */
export const REPORT_TURN_TOOL_DESCRIPTIONS: Readonly<Record<ReportTurnToolName, string>> = {
  save_report: [
    "Сохраняет готовый отчёт одним вызовом: кладёт текст (.md) и документ в папку «Отчёты».",
    "Зови, когда у пользователя нет образца или он попросил обычный файл.",
    "Если образец есть, зови fill_sample: там сохраняется оформление образца.",
    "Один отчёт — один вызов. Файл руками не пиши.",
  ].join(" "),
  fill_sample: [
    "Заполняет образец пользователя данными и сохраняет его, не меняя оформление.",
    "Зови, когда среди присланных файлов есть образец .rtf, .docx или .odt: это главный способ сохранить отчёт.",
    "Шрифты, размеры, границы и ширину колонок берёт из самого образца.",
    "Нужен полный путь к образцу на компьютере пользователя.",
  ].join(" "),
  report_preview: [
    "Показывает черновик отчёта на экране и оставляет копию в файле.",
    "Зови по ходу работы: один раз, когда документы разобраны, и один раз с готовым текстом.",
    "Текст должен быть ровно тот, который потом попадёт в файл.",
    "Это показ черновика, а не ответ: короткое сообщение пользователю всё равно отправь через SendMessage.",
  ].join(" "),
  skill_list: [
    "Показывает список скиллов отчётов: имя, название и одна строка о каждом.",
    "Зови, когда не уверен, какой отчёт нужен, или перед чтением соседнего скилла.",
    "Аргументов нет.",
  ].join(" "),
  skill_read: [
    "Читает полный текст скилла отчёта по имени — это готовая инструкция, как собрать один вид отчёта.",
    "Зови до сборки отчёта, а не после.",
    "Имя бери из skill_list, например «fdb-miloserdie».",
    "Чтение скилла не начинает работу: делай по шагам, которые в нём перечислены.",
  ].join(" "),
};

/** Что показывает панель хода, пока инструмент работает. Коротко, по-русски. */
function reportActivityDetail(toolName: string, args: unknown): { readonly detail: string } {
  const values = (args ?? {}) as Record<string, unknown>;
  const title = typeof values.title === "string" ? values.title.trim() : "";
  if (toolName === "skill_list") return { detail: "список скиллов" };
  if (toolName === "skill_read") {
    const name = typeof values.name === "string" ? values.name.trim() : "";
    const alias = typeof values.skill === "string" ? values.skill.trim() : "";
    return { detail: name.length > 0 ? name : alias };
  }
  if (toolName === "report_preview") return { detail: title.length > 0 ? title : "черновик отчёта" };
  return { detail: title };
}

/**
 * Файловая ошибка на языке пользователя.
 *
 * `readFile`/`writeFile` бросают английский `ENOENT: no such file or directory,
 * open 'C:\...'` — пользователю оттуда нечего понять. Имя файла оставляем
 * (оно и так по-русски), остальное переводим.
 */
function reportErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const errno = error as NodeJS.ErrnoException;
  const code = errno.code;
  const target = typeof errno.path === "string" ? errno.path : "";
  if (code === "ENOENT") {
    return target.length > 0
      ? `файла нет: ${target}. Проверь путь и имя файла.`
      : "файла нет. Проверь путь и имя файла.";
  }
  if (code === "EACCES" || code === "EPERM") {
    return `нет прав на файл${target.length > 0 ? `: ${target}` : ""}. Закрой файл в Word и попробуй снова.`;
  }
  if (code === "EISDIR") {
    return `это папка, а не файл${target.length > 0 ? `: ${target}` : ""}. Укажи путь к файлу.`;
  }
  if (code === "ENOTDIR") {
    return `в пути есть папка вместо файла${target.length > 0 ? `: ${target}` : ""}. Укажи полный путь к файлу.`;
  }
  return error.message;
}

export interface ReportTurnTool extends Record<string, unknown> {
  readonly name: string;
  readonly id: string;
}

/**
 * Пять TurnTool из пяти инструментов пакета.
 *
 * Порядок и набор имён не меняются: десять скиллов в `skills/*.md` называют
 * инструменты именно этими именами.
 */
export function createReportTurnTools(deps: ReportToolsDependencies): readonly ReportTurnTool[] {
  const tools: ReportTool<any>[] = createReportTools(deps);
  return tools.map((tool) => {
    const description = REPORT_TURN_TOOL_DESCRIPTIONS[tool.name as ReportTurnToolName]
      ?? tool.description;
    const built = defineCommunicateTool(deps, {
      id: tool.id,
      name: tool.name,
      description,
      parameters: tool.parameters,
      describeActivity: (args: unknown) => reportActivityDetail(tool.name, args),
      execute: async (_ctx, args: unknown) => {
        try {
          return await tool.execute(args);
        } catch (error) {
          throw new Error(reportErrorMessage(error));
        }
      },
    });
    return built as ReportTurnTool;
  });
}

function skillsDirIn(root: string | undefined): string | undefined {
  if (root === undefined || root.trim().length === 0) return undefined;
  const candidate = join(root.trim(), SKILLS_DIRNAME);
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Где искать папку `skills` с отчётными скиллами.
 *
 * Порядок проверки:
 *  1. `SAND_REPORT_SKILLS_DIR` — явное указание, важнее всего остального.
 *  2. `<корень данных>/skills` — папка рядом с данными приложения. Её видит
 *     пользователь, и скиллы можно обновить без переустановки программы.
 *  3. Папка приложения: `resourcesPath`, рабочая папка и папка `dist/host`,
 *     где лежит собранный хост. Это покрывает запуск из исходников и из
 *     `.build/app`.
 *
 * Если папки нет, возвращается путь «всё равно не найдётся»: `skill_list`
 * должен ответить «скиллов нет», а не упасть. Проверка папки сделана один раз
 * при создании набора инструментов, а не на каждый вызов.
 */
export function resolveReportSkillsDir(
  dataRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  runtime: {
    readonly cwd?: string;
    readonly execPath?: string;
    readonly resourcesPath?: string;
  } = {},
): string {
  const override = env[REPORT_SKILLS_DIR_ENV]?.trim();
  if (override !== undefined && override.length > 0) return override;
  const resourcesPath = runtime.resourcesPath
    ?? (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath;
  const execPath = runtime.execPath ?? process.execPath;
  const cwd = runtime.cwd ?? process.cwd();
  const archive = resourcesPath === undefined
    ? undefined
    : join(resourcesPath, "app.asar");
  for (const root of [
    dataRoot,
    resourcesPath,
    // В упакованной сборке скиллы лежат внутри app.asar, а process.resourcesPath
    // указывает на resources/ — на один уровень выше. Без этой строки skill_list
    // в установленной программе отвечает «скиллов нет».
    archive,
    cwd,
    execPath === undefined ? undefined : dirname(execPath),
    execPath === undefined ? undefined : dirname(dirname(execPath)),
  ]) {
    const found = skillsDirIn(root);
    if (found !== undefined) return found;
  }
  return join(dataRoot, SKILLS_DIRNAME);
}
