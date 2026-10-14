/**
 * Чистая логика сканирования папки проектов и карточек.
 *
 * НИКАКИХ прямых обращений к fs/git/invoke в вычислениях — всё приходит
 * параметрами через порты (см. тест-план §0). Date.now используется
 * только как значение по умолчанию аргумента nowMs — тесты всегда
 * передают его явно.
 */

import type {
  DirEntry,
  DirEntryObject,
  FsDirPort,
  FsReadPort,
  GitRepoStatus,
  GitStatusPort,
  ProjectCard,
  ProjectCardModel,
  ProjectDirStat,
  ProjectStatus,
  ScanResult,
  TimeTranslator,
  TreeNode,
} from "./types";

/* ------------------------------------------------------------------ */
/* Константы                                                           */
/* ------------------------------------------------------------------ */

/** «Давно не открывали» — строго больше 14 суток. */
export const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** Максимальная глубина спуска внутри проекта при подсчёте файлов. */
export const WALK_DEPTH_LIMIT = 4;

/** Потолок файлов в подсчёте — страховка от «проекта» = корень диска. */
export const FILE_COUNT_LIMIT = 10_000;

/** Сколько карточек собираем параллельно (порты могут быть медленными). */
export const SCAN_CONCURRENCY = 4;

/** Префикс каталогов бэкапов, которые никогда не являются проектами. */
export const BACKUP_DIR_PREFIX = ".grok-backup";

/** Каталоги, в которые не спускаемся и не показываем как проекты. */
export const EXCLUDED_DIR_NAMES: Record<string, true> = {
  node_modules: true,
  dist: true,
  build: true,
  out: true,
  ".git": true,
  ".hg": true,
  ".svn": true,
  ".idea": true,
  ".vscode": true,
  ".next": true,
  ".nuxt": true,
  ".cache": true,
  ".parcel-cache": true,
  ".turbo": true,
  coverage: true,
  target: true,
  bin: true,
  obj: true,
  tmp: true,
  temp: true,
  __pycache__: true,
  ".venv": true,
  venv: true,
  vendor: true,
  bower_components: true,
};

/** Файлы-хлам: не считаем их ни маркерами проекта, ни «файлами проекта». */
export const EXCLUDED_FILE_NAMES: Record<string, true> = {
  ".ds_store": true,
  "thumbs.db": true,
  "desktop.ini": true,
  "error.log": true,
  "debug.log": true,
  "npm-debug.log": true,
  "yarn-debug.log": true,
  "yarn-error.log": true,
  "pnpm-debug.log": true,
  "crash.log": true,
};

/** Файлы, чьё присутствие означает «последний запуск не удался». */
export const ERROR_MARKER_FILES: Record<string, true> = {
  "error.log": true,
  "debug.log": true,
  "npm-debug.log": true,
  "yarn-debug.log": true,
  "yarn-error.log": true,
  "pnpm-debug.log": true,
  "crash.log": true,
  "core.dmp": true,
  "crash.dmp": true,
};

/**
 * Маркеры «это проект» — файлы. Проверка регистронезависимая;
 * запись вида "*.ext" сравнивается по расширению.
 */
export const PROJECT_FILE_MARKERS: readonly string[] = [
  "package.json",
  "index.html",
  "readme.md",
  "pyproject.toml",
  "requirements.txt",
  "cargo.toml",
  "go.mod",
  "composer.json",
  "gemfile",
  "makefile",
  "dockerfile",
  "docker-compose.yml",
  "pom.xml",
  "build.gradle",
  "*.sln",
  "*.csproj",
  "*.fsproj",
  "*.vbproj",
  "*.xcodeproj",
];

/** Маркеры «это проект» — подкаталоги. */
export const PROJECT_DIR_MARKERS: Record<string, true> = {
  src: true,
  public: true,
  app: true,
};

const inTable = (table: Record<string, true>, lowerName: string): boolean =>
  table[lowerName] === true;

/* ------------------------------------------------------------------ */
/* Утилиты над именами и записями каталога                             */
/* ------------------------------------------------------------------ */

/** Имя записи независимо от формы DirEntry. */
export function entryName(entry: DirEntry): string {
  return typeof entry === "string" ? entry : entry.name;
}

/** Тип записи; строки → null (тип неизвестен без stat). */
export function entryKind(entry: DirEntry): DirEntryObject["kind"] | null {
  return typeof entry === "string" ? null : entry.kind;
}

/** Скрытое имя: точечные файлы/папки (.git, .idea, .env). */
export function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

/** Имя принадлежит служебному каталогу бэкапа (.grok-backup-2024-…). */
export function isBackupDirName(name: string): boolean {
  return name === BACKUP_DIR_PREFIX || name.startsWith(`${BACKUP_DIR_PREFIX}-`);
}

/** Служебный/тяжёлый каталог — не проект, не спускаемся, не считаем. */
export function isExcludedDirName(name: string): boolean {
  return (
    isHiddenName(name) ||
    isBackupDirName(name) ||
    inTable(EXCLUDED_DIR_NAMES, name.toLowerCase())
  );
}

/** Файл-хлам или error-маркер — не считаем «файлами проекта». */
export function isExcludedFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (isHiddenName(name) && !inTable(ERROR_MARKER_FILES, lower)) return true;
  return inTable(EXCLUDED_FILE_NAMES, lower);
}

/** Совпадает ли имя файла с маркером проекта (поддержка "*.ext"). */
export function matchesFileMarker(name: string): boolean {
  const lower = name.toLowerCase();
  for (const marker of PROJECT_FILE_MARKERS) {
    if (marker.startsWith("*.")) {
      if (lower.endsWith(marker.slice(1))) return true;
    } else if (lower === marker) {
      return true;
    }
  }
  return false;
}

/**
 * План обхода: отфильтровать из записей каталога мусор —
 * node_modules, .git, скрытые имена, бэкапы, временные файлы.
 * Возвращает только «значимые» записи, порядок сохраняется.
 * Записи-строки (тип неизвестен) режутся по обоим спискам.
 */
export function walkPlan(entries: readonly DirEntry[]): DirEntry[] {
  const kept: DirEntry[] = [];
  for (const entry of entries) {
    const name = entryName(entry);
    if (!name || name === "." || name === "..") continue;
    const kind = entryKind(entry);
    if (kind === "file") {
      if (!isExcludedFileName(name)) kept.push(entry);
    } else if (kind === "dir") {
      if (!isExcludedDirName(name)) kept.push(entry);
    } else if (kind === null) {
      if (!isExcludedDirName(name) && !isExcludedFileName(name)) {
        kept.push(entry);
      }
    }
    // kind === "other" (ссылки, сокеты) — в план не берём.
  }
  return kept;
}

/**
 * Из списка записей — имена подкаталогов, в которые имеет смысл
 * спускаться (не скрытые, не служебные). Записи-строки без типа
 * каталогами не считаются.
 */
export function descendPlan(entries: readonly DirEntry[]): string[] {
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entryKind(entry) === "dir" && !isExcludedDirName(entryName(entry))) {
      dirs.push(entryName(entry));
    }
  }
  return dirs;
}

/**
 * Это папка-проект? Маркеры (package.json, index.html, src/…) —
 * или вообще любое значимое содержимое: у «чайника» проектом может
 * быть и папка с парой html-файлов.
 * Пустые и состоящие только из мусора папки — не проекты.
 */
export function isProjectDir(entries: readonly DirEntry[]): boolean {
  const kept = walkPlan(entries);
  if (kept.length === 0) return false;
  for (const entry of kept) {
    const name = entryName(entry);
    const kind = entryKind(entry);
    if (kind === "file" && matchesFileMarker(name)) return true;
    if (kind === "dir" && inTable(PROJECT_DIR_MARKERS, name.toLowerCase())) {
      return true;
    }
    // Строка без типа: имя-маркер тоже зачтём.
    if (kind === null && matchesFileMarker(name)) return true;
  }
  // Нет явных маркеров — но есть настоящее содержимое.
  return kept.length > 0;
}

/** Последний компонент пути; терпим и к "/" и к "\". */
export function baseName(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** Соединение путей без зависимости от платформы разделителя. */
export function joinPath(dir: string, name: string): string {
  if (dir === "" || /[\\/]$/.test(dir)) return dir + name;
  return `${dir}/${name}`;
}

/* ------------------------------------------------------------------ */
/* Статус карточки                                                     */
/* ------------------------------------------------------------------ */

/**
 * Статус проекта (приоритет сверху вниз):
 *  - "crashed" — в папке лежат error-логи/crash-файлы;
 *  - "dirty"   — git видит несохранённые изменения (или hasUnsavedChanges);
 *  - "stale"   — проект не трогали строго дольше 14 суток;
 *  - "clean"   — всё остальное.
 *
 * @param dirStat         слепок папки (см. ProjectDirStat)
 * @param gitStatus       "clean" | "dirty" | "none"; boolean для совместимости:
 *                        true/false = «репо есть, считаем чистым» / «не репо»
 * @param lastModifiedMs  момент последней активности, мс
 *                        (для git-проектов — max(mtime, lastCommitTime))
 * @param nowMs           «сейчас», мс
 */
export function computeStatus(
  dirStat: Pick<ProjectDirStat, "hasErrorMarkers" | "hasUnsavedChanges">,
  gitStatus: GitRepoStatus | boolean,
  lastModifiedMs: number,
  nowMs: number,
): ProjectStatus {
  if (dirStat.hasErrorMarkers) return "crashed";
  if (gitStatus === "dirty" || dirStat.hasUnsavedChanges) return "dirty";
  if (
    Number.isFinite(lastModifiedMs) &&
    Number.isFinite(nowMs) &&
    nowMs - lastModifiedMs > STALE_AFTER_MS
  ) {
    return "stale";
  }
  return "clean";
}

/* ------------------------------------------------------------------ */
/* «Как давно» — форматирование активности                             */
/* ------------------------------------------------------------------ */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;

/**
 * «Изменено: 2 часа назад» — человеческая строка относительного времени.
 * Бакеты: <1 мин → «только что»; <1 ч → минуты; <24 ч → часы;
 * <30 д → дни; дальше → «больше месяца назад».
 * Будущее/NaN/Infinity → «только что» (clock skew не показываем).
 *
 * @param tsMs  момент активности, мс
 * @param nowMs «сейчас», мс
 * @param t     переводчик (см. TimeTranslator; реализация — src/i18n)
 */
export function formatActivity(
  tsMs: number,
  nowMs: number,
  t: TimeTranslator,
): string {
  const delta = nowMs - tsMs;
  if (!Number.isFinite(delta) || delta < MINUTE_MS) {
    return t("agoJustNow");
  }
  if (delta < HOUR_MS) {
    return t("agoMinutes", { n: Math.floor(delta / MINUTE_MS) });
  }
  if (delta < DAY_MS) {
    return t("agoHours", { n: Math.floor(delta / HOUR_MS) });
  }
  if (delta < MONTH_MS) {
    return t("agoDays", { n: Math.floor(delta / DAY_MS) });
  }
  return t("agoLongAgo");
}

/* ------------------------------------------------------------------ */
/* Сортировка                                                          */
/* ------------------------------------------------------------------ */

interface WireLike {
  last_activity?: number;
}

/**
 * Карточки по свежести: недавно изменённые первыми, при равенстве —
 * по имени (детерминированное сравнение без locale-зависимости).
 * Возвращает НОВЫЙ массив; вход не мутирует.
 * Принимает и UI-модель (lastActivityMs, мс), и wire (last_activity, сек).
 */
export function sortProjects<
  T extends Pick<ProjectCardModel, "lastActivityMs" | "name"> & WireLike,
>(cards: readonly T[]): T[] {
  const activityOf = (c: T): number => {
    if (Number.isFinite(c.lastActivityMs)) return c.lastActivityMs;
    const wire = c.last_activity;
    return typeof wire === "number" && Number.isFinite(wire)
      ? wire * 1000
      : 0;
  };
  return [...cards].sort((a, b) => {
    const d = activityOf(b) - activityOf(a);
    if (d !== 0) return d;
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
}

/* ------------------------------------------------------------------ */
/* Сбор статистики папки проекта                                       */
/* ------------------------------------------------------------------ */

interface ResolvedEntry {
  name: string;
  kind: "file" | "dir" | "other";
}

async function resolveEntryKind(
  fs: FsDirPort,
  dir: string,
  entry: DirEntry,
): Promise<ResolvedEntry> {
  const name = entryName(entry);
  const known = entryKind(entry);
  if (known !== null) return { name, kind: known };
  try {
    const st = await fs.stat(joinPath(dir, name));
    return { name, kind: st.isDir ? "dir" : "file" };
  } catch {
    return { name, kind: "other" };
  }
}

/**
 * Слепок папки проекта: число файлов, самый свежий mtime,
 * флаги error-маркеров. Глубина и счётчик ограничены — страховка
 * от тяжёлых деревьев и junction-петель. Ошибки вложенных каталогов
 * глушим: недоступная подпапка не должна ломать всю карточку.
 */
export async function statProjectDir(
  dir: string,
  fs: FsDirPort,
  opts: { depthLimit?: number; fileCountLimit?: number } = {},
): Promise<ProjectDirStat> {
  const depthLimit = opts.depthLimit ?? WALK_DEPTH_LIMIT;
  const fileCountLimit = opts.fileCountLimit ?? FILE_COUNT_LIMIT;

  let fileCount = 0;
  let lastModifiedMs = 0;
  let hasErrorMarkers = false;

  const touchMtime = (mtime: number | undefined): void => {
    if (typeof mtime === "number" && Number.isFinite(mtime) && mtime > lastModifiedMs) {
      lastModifiedMs = mtime;
    }
  };

  const walk = async (current: string, depth: number): Promise<void> => {
    if (fileCount >= fileCountLimit) return;
    let raw: DirEntry[];
    try {
      raw = await fs.readDir(current);
    } catch {
      return; // вложенная папка недоступна — пропускаем её ветку
    }
    for (const entry of raw) {
      if (fileCount >= fileCountLimit) return;
      const name = entryName(entry);
      if (!name || name === "." || name === "..") continue;
      const resolved = await resolveEntryKind(fs, current, entry);
      if (resolved.kind === "dir") {
        if (isExcludedDirName(name)) continue;
        if (depth < depthLimit) await walk(joinPath(current, name), depth + 1);
        continue;
      }
      if (resolved.kind !== "file") continue;
      if (inTable(ERROR_MARKER_FILES, name.toLowerCase())) {
        hasErrorMarkers = true;
      }
      if (isExcludedFileName(name)) continue;
      fileCount += 1;
      try {
        const st = await fs.stat(joinPath(current, name));
        touchMtime(st.mtimeMs);
      } catch {
        /* файл исчез между readdir и stat — пропускаем */
      }
    }
  };

  // mtime самой папки — тоже сигнал активности.
  try {
    const st = await fs.stat(dir);
    touchMtime(st.mtimeMs);
  } catch {
    /* игнорируем — про папку узнаем из листинга */
  }
  await walk(dir, 1);

  return {
    lastModifiedMs,
    fileCount,
    hasErrorMarkers,
    hasUnsavedChanges: false,
  };
}

/* ------------------------------------------------------------------ */
/* Сканирование корня проектов                                         */
/* ------------------------------------------------------------------ */

export interface ScanPorts {
  fs: FsDirPort;
  git: GitStatusPort;
}

/** UI-модель → wire-карточка для сервисного слоя / Rust. */
export function toWireCard(card: ProjectCardModel): ProjectCard {
  const lastActivitySec =
    Number.isFinite(card.lastActivityMs) && card.lastActivityMs > 0
      ? Math.floor(card.lastActivityMs / 1000)
      : 0;
  return {
    path: card.path,
    name: card.name,
    status: card.status,
    last_activity: lastActivitySec,
    file_count: card.fileCount,
    is_git_repo: card.hasGit,
  };
}

/** Классификация ошибки чтения каталога под карточки из copy-дока. */
function classifyFsError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  let code = "";
  if (typeof err === "object" && err !== null && "code" in err) {
    const raw = err.code; // unknown — нормализуем к строке
    if (typeof raw === "string") code = raw;
  }
  const hay = `${code} ${msg}`.toLowerCase();
  if (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    /not found|cannot find|не найден/.test(hay)
  ) {
    return "not_found";
  }
  if (code === "EACCES" || code === "EPERM" || /denied|отказано/.test(hay)) {
    return "denied";
  }
  return "io";
}

async function buildCard(
  ports: ScanPorts,
  path: string,
  name: string,
  nowMs: number,
): Promise<ProjectCardModel> {
  const dirStat = await statProjectDir(path, ports.fs);
  let gitStatus: GitRepoStatus = "none";
  let lastCommitMs: number | null = null;
  try {
    gitStatus = await ports.git.status(path);
    if (gitStatus !== "none" && ports.git.lastCommitTime) {
      lastCommitMs = await ports.git.lastCommitTime(path);
    }
  } catch {
    gitStatus = "none"; // git недоступен/упал — проект считается без git
  }
  const lastModifiedMs = Math.max(dirStat.lastModifiedMs, lastCommitMs ?? 0);
  return {
    path,
    name,
    status: computeStatus(dirStat, gitStatus, lastModifiedMs, nowMs),
    lastActivityMs: lastModifiedMs,
    fileCount: dirStat.fileCount,
    hasGit: gitStatus !== "none",
  };
}

/**
 * Сканирует корень проектов на 2 уровня:
 *  - уровень 1: дети root — кандидаты в проекты;
 *  - уровень 2: кандидат без маркеров раскрываем — проектами могут
 *    оказаться его подпапки (паттерн «Мои проекты/2024/сайт»).
 *
 * Карточки возвращаются отсортированными по свежести.
 * Ошибки чтения — типизированные в result.errors, без throw.
 */
export async function scanProjects(
  root: string,
  ports: ScanPorts,
  nowMs: number = Date.now(),
): Promise<ScanResult> {
  const errors: ScanResult["errors"] = [];
  const messageOf = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

  let rootEntries: DirEntry[];
  try {
    rootEntries = await ports.fs.readDir(root);
  } catch (err) {
    return {
      cards: [],
      errors: [
        { path: root, reason: classifyFsError(err), message: messageOf(err) },
      ],
    };
  }

  // Уровень 1: только явные подкаталоги — кандидаты.
  interface Candidate {
    path: string;
    name: string;
  }
  const candidates: Candidate[] = [];
  const seenCandidates = new Set<string>();
  for (const entry of rootEntries) {
    const name = entryName(entry);
    if (!name || isExcludedDirName(name)) continue;
    const known = entryKind(entry);
    if (known === "file" || known === "other") continue;
    const childPath = joinPath(root, name);
    let isDir = known === "dir";
    if (known === null) {
      try {
        const st = await ports.fs.stat(childPath);
        isDir = st.isDir === true;
      } catch {
        continue;
      }
    }
    if (!isDir) continue;
    const key = childPath.toLowerCase();
    if (seenCandidates.has(key)) continue;
    seenCandidates.add(key);
    candidates.push({ path: childPath, name });
  }

  // Уровень 2: кандидаты без маркеров раскрываем в своих подпапок.
  const projects: Candidate[] = [];
  const seenProjects = new Set<string>();
  const addProject = (path: string, name: string): void => {
    const key = path.toLowerCase();
    if (seenProjects.has(key)) return;
    seenProjects.add(key);
    projects.push({ path, name });
  };

  for (const cand of candidates) {
    let entries: DirEntry[];
    try {
      entries = await ports.fs.readDir(cand.path);
    } catch (err) {
      errors.push({
        path: cand.path,
        reason: classifyFsError(err),
        message: messageOf(err),
      });
      continue;
    }
    if (isProjectDir(entries)) {
      addProject(cand.path, cand.name);
      continue;
    }
    // Пусто или только мусор — вдруг это «папка-обёртка» с проектами внутри.
    for (const sub of descendPlan(entries)) {
      const subPath = joinPath(cand.path, sub);
      let subEntries: DirEntry[];
      try {
        subEntries = await ports.fs.readDir(subPath);
      } catch {
        continue;
      }
      if (isProjectDir(subEntries)) addProject(subPath, sub);
    }
  }

  // Собираем карточки с ограниченным параллелизмом.
  const cards: ProjectCardModel[] = [];
  const queue = [...projects];
  const worker = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      try {
        cards.push(await buildCard(ports, next.path, next.name, nowMs));
      } catch (err) {
        errors.push({
          path: next.path,
          reason: classifyFsError(err),
          message: messageOf(err),
        });
      }
    }
  };
  const lanes = Math.max(1, Math.min(SCAN_CONCURRENCY, projects.length));
  await Promise.all(Array.from({ length: lanes }, worker));

  return { cards: sortProjects(cards), errors };
}

/* ------------------------------------------------------------------ */
/* Дерево проекта и чтение файлов (контекст для чата)                  */
/* ------------------------------------------------------------------ */

/** Как глубоко рисуем дерево для контекста чата. */
export const TREE_DEPTH = 2;

/**
 * Дерево папки проекта ограниченной глубины (по умолчанию 2 уровня,
 * как договорились в тест-плане §4). Мусор отфильтрован walkPlan,
 * порядок детей: сначала папки, потом файлы, внутри по имени.
 * children есть у папок только до исчерпания depth.
 */
export async function buildProjectTree(
  dir: string,
  fs: FsDirPort,
  opts: { depth?: number } = {},
): Promise<TreeNode[]> {
  const depth = opts.depth ?? TREE_DEPTH;

  const level = async (
    current: string,
    remaining: number,
  ): Promise<TreeNode[]> => {
    let raw: DirEntry[];
    try {
      raw = await fs.readDir(current);
    } catch {
      return [];
    }
    const nodes: TreeNode[] = [];
    for (const entry of walkPlan(raw)) {
      const name = entryName(entry);
      const resolved = await resolveEntryKind(fs, current, entry);
      if (resolved.kind !== "dir" && resolved.kind !== "file") continue;
      const path = joinPath(current, name);
      const node: TreeNode =
        resolved.kind === "dir"
          ? { name, path, isDir: true }
          : { name, path, isDir: false };
      if (resolved.kind === "dir" && remaining > 1) {
        node.children = await level(path, remaining - 1);
      }
      nodes.push(node);
    }
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      if (a.name < b.name) return -1;
      if (a.name > b.name) return 1;
      return 0;
    });
    return nodes;
  };

  return level(dir, depth);
}

/** Плоский список путей файлов из дерева (в порядке обхода). */
export function collectFilePaths(nodes: readonly TreeNode[]): string[] {
  const paths: string[] = [];
  const visit = (list: readonly TreeNode[]): void => {
    for (const node of list) {
      if (node.isDir) {
        if (node.children) visit(node.children);
      } else {
        paths.push(node.path);
      }
    }
  };
  visit(nodes);
  return paths;
}

export interface ProjectFileContent {
  path: string;
  content: string;
}

/** Файл под корнем проекта? Делители нормализуются к "/"; регистр — как в Windows. */
export function isInsideRoot(rootPath: string, filePath: string): boolean {
  const norm = (p: string): string =>
    p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const rootNorm = norm(rootPath);
  const fileNorm = norm(filePath);
  return fileNorm === rootNorm || fileNorm.startsWith(`${rootNorm}/`);
}

/**
 * Читает тексты ключевых файлов проекта для контекста чата.
 * Принимает и относительные («src/main.ts»), и полные пути —
 * полные обязаны лежать внутри rootPath (иначе пропускаем:
 * никаких «../» и выходов за проект). Суммарный объём ≤ maxTotalChars;
 * последний поместившийся файл урезается по остатку бюджета.
 * Нечитаемые/бинарные-на-вид файлы пропускаются молча.
 */
export async function readProjectFiles(
  rootPath: string,
  fs: FsReadPort,
  paths: readonly string[],
  opts: { maxTotalChars?: number } = {},
): Promise<ProjectFileContent[]> {
  const maxTotalChars = opts.maxTotalChars ?? 30_000;
  const out: ProjectFileContent[] = [];
  let budget = maxTotalChars;
  for (const p of paths) {
    if (budget <= 0) break;
    if (!p || p.includes("\0")) continue;
    const absolute = /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p);
    const full = absolute ? p : joinPath(rootPath, p);
    if (absolute && !isInsideRoot(rootPath, full)) continue;
    if (!absolute && p.split(/[\\/]/).some((seg) => seg === "..")) continue;
    try {
      let content = await fs.readFile(full);
      if (content.length > budget) content = content.slice(0, budget);
      out.push({ path: full, content });
      budget -= content.length;
    } catch {
      /* файл нельзя прочитать — просто не включаем в контекст */
    }
  }
  return out;
}
