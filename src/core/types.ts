/**
 * Общие типы бизнес-логики (src/core/*).
 *
 * Wire-типы (ProjectCard, FileChange, ApplyResult) зеркалят
 * src/services/tauri.ts и src-tauri/src/commands.rs — менять только
 * согласованно с Rust-стороной.
 *
 * Всё в этом файле — чистые данные: без invoke, без DOM, без node-API.
 */

/* ------------------------------------------------------------------ */
/* Wire-контракт с Rust (см. src/services/tauri.ts)                    */
/* ------------------------------------------------------------------ */

export type ProjectStatus = "clean" | "dirty" | "stale" | "crashed";

export interface ProjectCard {
  path: string;
  name: string;
  status: ProjectStatus;
  /** unix-timestamp последнего изменения, секунды */
  last_activity: number;
  file_count: number;
  is_git_repo: boolean;
}

export interface FileChange {
  path: string;
  /** unified diff или полный новый текст */
  diff: string;
}

export interface ApplyResult {
  applied: string[];
  backup_dir: string | null;
}

/** Типизированная ошибка сканирования — никогда не throw, всегда карточка. */
export interface ScanError {
  path: string;
  /** "not_found" | "denied" | "io" — мапится на карточки из copy-дока */
  reason: string;
  message: string;
}

/** Результат сканирования корня проектов. */
export interface ScanResult {
  /** Карточки в итоговом виде (camelCase — модель для UI-слоя). */
  cards: ProjectCardModel[];
  /** Подпапки, которые не удалось прочитать (карточек на них нет). */
  errors: ScanError[];
}

/**
 * UI-модель карточки проекта (camelCase, миллисекунды) —
 * внутренняя форма core; в сервисный слой уходит toWireCard().
 */
export interface ProjectCardModel {
  path: string;
  name: string;
  status: ProjectStatus;
  /** миллисекунды unix-time */
  lastActivityMs: number;
  fileCount: number;
  hasGit: boolean;
}

/* ------------------------------------------------------------------ */
/* Порты: файловая система и git (инъекция, см. тест-план §0)          */
/* ------------------------------------------------------------------ */

/** Тип элемента каталога. "other" — ссылки, сокеты, junctions и т.п. */
export type DirEntryKind = "file" | "dir" | "other";

export interface DirEntryObject {
  name: string;
  kind: DirEntryKind;
}

/**
 * Элемент readdir. Строка трактуется как запись без сведений о типе
 * (kind уточняется stat'ом при необходимости).
 */
export type DirEntry = string | DirEntryObject;

/** Минимальная стат-информация, нужная core. */
export interface FileStat {
  /** миллисекунды unix-time */
  mtimeMs?: number;
  size?: number;
  isDir?: boolean;
}

/** Порт: только навигация по каталогам. Без readFile — он не нужен сканеру. */
export interface FsDirPort {
  /** Список имён/записей каталога. Бросает ошибку при not-found/denied. */
  readDir(path: string): Promise<DirEntry[]>;
  /** Метаданные пути (mtime, размер, тип). */
  stat(path: string): Promise<FileStat>;
  /** Необязательная быстрая проверка существования. */
  exists?(path: string): Promise<boolean>;
}

/** Состояние проекта с точки зрения git. "none" — не репозиторий. */
export type GitRepoStatus = "clean" | "dirty" | "none";

/** Порт: git-операции над одной папкой проекта. */
export interface GitStatusPort {
  status(path: string): Promise<GitRepoStatus>;
  /** unix-time последнего коммита, миллисекунды; null — коммитов нет. */
  lastCommitTime?(path: string): Promise<number | null>;
}

/* ------------------------------------------------------------------ */
/* Сигналы для computeStatus                                          */
/* ------------------------------------------------------------------ */

/** Агрегированный слепок папки проекта (собирает walker сканера). */
export interface ProjectDirStat {
  /** unix-time самого свежего файла/папки внутри проекта, мс; 0 = неизвестно */
  lastModifiedMs: number;
  /** число файлов проекта (без исключённых каталогов/файлов-хлама) */
  fileCount: number;
  /** найдены error-логи / crash-файлы (npm-debug.log, crash.log и т.п.) */
  hasErrorMarkers: boolean;
  /** есть несохранённые изменения вне git (зарезервировано; UI-редакторы) */
  hasUnsavedChanges: boolean;
}

/* ------------------------------------------------------------------ */
/* Переводчик для форматирования «как давно»                           */
/* ------------------------------------------------------------------ */

/**
 * Ключи относительного времени из src/i18n/ru.ts
 * (agoMinutes/agoHours/agoDays — массивы из трёх форм для plural).
 */
export type TimeTranslationKey =
  | "agoJustNow"
  | "agoMinutes"
  | "agoHours"
  | "agoDays"
  | "agoLongAgo";

/**
 * Переводчик пользовательских строк.
 * CONTRACT: реализация — src/i18n (I18nImpl). Для ключей-массивов t()
 * выбирает форму по plural(n, [one, few, many]) и подставляет {n}.
 */
export interface TimeTranslator {
  (key: TimeTranslationKey, params?: { n?: number }): string;
}

/* ------------------------------------------------------------------ */
/* Дерево проекта и чтение файлов (контекст для чата)                  */
/* ------------------------------------------------------------------ */

/** Узел дерева проекта (глубина ограничена сборщиком). */
export interface TreeNode {
  name: string;
  /** Полный путь в том виде, как его склеил сканер. */
  path: string;
  isDir: boolean;
  /** Есть только у папок и только пока не исчерпана глубина. */
  children?: TreeNode[];
}

/** Порт: навигация + чтение текстовых файлов (для контекста чата). */
export interface FsReadPort extends FsDirPort {
  /** UTF-8 содержимое файла. */
  readFile(path: string): Promise<string>;
}
