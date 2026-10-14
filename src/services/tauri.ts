import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { scanProjects as coreScan } from "../core/scanner";
import type {
  DirEntry,
  FileStat,
  FsDirPort,
  GitStatusPort,
  GitRepoStatus,
  ProjectCardModel,
} from "../core/types";
import { normalizeProjects } from "../stores/stateFns";

/**
 * Типы совпадают с serde-структурами в src-tauri/src/commands.rs.
 * Это контракт для волны B — менять только согласованно с Rust-стороной.
 * На проводе поля snake_case.
 */

export interface ProjectCard {
  path: string;
  name: string;
  status: ProjectStatus;
  /** unix-timestamp последнего изменения, секунды */
  last_activity: number;
  file_count: number;
  is_git_repo: boolean;
}

export type ProjectStatus = "clean" | "dirty" | "stale" | "crashed";

export interface FileChange {
  path: string;
  /** полный новый текст файла (контракт RustBackend; НЕ unified diff) */
  diff: string;
}

export interface ApplyResult {
  applied: string[];
  backup_dir: string | null;
}

/** Запись одного уровня каталога (команда list_dir). */
export interface TauriDirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified_ms: number;
}

// ---------------------------------------------------------------------------
// Файловая система — адаптеры для core-портов
// ---------------------------------------------------------------------------

function isDirEntry(v: unknown): v is TauriDirEntry {
  return (
    typeof v === "object" &&
    v !== null &&
    "name" in v &&
    typeof v.name === "string" &&
    "is_dir" in v &&
    typeof v.is_dir === "boolean"
  );
}

/** Дети папки, 1 уровень. Пустая папка → []; нет папки/доступа → throw. */
export async function listDir(path: string): Promise<TauriDirEntry[]> {
  const raw: unknown = await invoke("list_dir", { path });
  if (!Array.isArray(raw)) return [];
  const out: TauriDirEntry[] = [];
  for (const item of raw) {
    if (isDirEntry(item)) {
      out.push({
        name: item.name,
        path: typeof item.path === "string" ? item.path : `${path}/${item.name}`,
        is_dir: item.is_dir,
        size: typeof item.size === "number" ? item.size : 0,
        modified_ms: typeof item.modified_ms === "number" ? item.modified_ms : 0,
      });
    }
  }
  return out;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await invoke<unknown>("file_exists", { path })) === true;
  } catch {
    return false;
  }
}

/** FsDirPort поверх invoke — для core/scanner.ts и сборки контекста. */
export const fsDirPort: FsDirPort = {
  async readDir(path: string): Promise<DirEntry[]> {
    const entries = await listDir(path);
    return entries.map((e) => ({
      name: e.name,
      kind: e.is_dir ? ("dir" as const) : ("file" as const),
    }));
  },
  async stat(path: string): Promise<FileStat> {
    if (!(await fileExists(path))) {
      throw new Error(`ENOENT: ${path}`);
    }
    const parent = path.replace(/[\\/][^\\/]+$/, "");
    const name = path.slice(parent.length + 1);
    try {
      const entries = await listDir(parent);
      const found = entries.find((e) => e.name === name);
      if (found) {
        return { mtimeMs: found.modified_ms, size: found.size, isDir: found.is_dir };
      }
    } catch {
      /* родитель не читается — вернём минимальный stat */
    }
    return { isDir: true };
  },
  exists: fileExists,
};

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Низкоуровневый запуск git (команда RustBackend; таймаут — на его стороне). */
export async function gitRun(args: string[], cwd?: string): Promise<GitRunResult> {
  const raw: unknown = await invoke("git_run", { args, cwd: cwd ?? null });
  if (typeof raw !== "object" || raw === null) {
    return { code: -1, stdout: "", stderr: "" };
  }
  return {
    code: "code" in raw && typeof raw.code === "number" ? raw.code : -1,
    stdout: "stdout" in raw && typeof raw.stdout === "string" ? raw.stdout : "",
    stderr: "stderr" in raw && typeof raw.stderr === "string" ? raw.stderr : "",
  };
}

/** GitStatusPort поверх git_run — статус и время последнего коммита. */
export const gitStatusPort: GitStatusPort = {
  async status(path: string): Promise<GitRepoStatus> {
    try {
      const inside = await gitRun(["rev-parse", "--is-inside-work-tree"], path);
      if (inside.code !== 0 || !inside.stdout.includes("true")) return "none";
      const st = await gitRun(["status", "--porcelain"], path);
      if (st.code !== 0) return "none";
      return st.stdout.trim() === "" ? "clean" : "dirty";
    } catch {
      return "none";
    }
  },
  async lastCommitTime(path: string): Promise<number | null> {
    try {
      const r = await gitRun(["log", "-1", "--format=%ct"], path);
      if (r.code !== 0) return null;
      const sec = Number.parseInt(r.stdout.trim(), 10);
      return Number.isFinite(sec) ? sec * 1000 : null;
    } catch {
      return null;
    }
  },
};

// ---------------------------------------------------------------------------
// Сканирование проектов
// ---------------------------------------------------------------------------

/** Модель карточки для UI (camelCase + миллисекунды). */
export type { ProjectCardModel };

/**
 * Сканирует корень проектов → wire-карточки (snake_case, секунды).
 * Основной путь — команда Rust `scan_projects`; если команда не реализована
 * (старый бэкенд) — чистый core-сканер поверх портов list_dir/git_run.
 * Ошибки чтения root — throw; карточку собирает хук (classifyFolderError).
 */
export async function scanProjects(root: string): Promise<ProjectCard[]> {
  try {
    const raw: unknown = await invoke("scan_projects", { root });
    return normalizeProjects(raw, Date.now());
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
    const unimplemented =
      msg.includes("not implemented") ||
      msg.includes("не реализована") ||
      msg.includes("unknown command");
    if (!unimplemented) throw e;
    const res = await coreScan(root, { fs: fsDirPort, git: gitStatusPort });
    if (res.cards.length === 0 && res.errors.length > 0) {
      const first = res.errors[0];
      if (first.reason === "not_found" || first.reason === "denied") {
        throw new Error(first.reason);
      }
    }
    return res.cards.map((c) => ({
      path: c.path,
      name: c.name,
      status: c.status,
      last_activity: Math.floor(c.lastActivityMs / 1000),
      file_count: c.fileCount,
      is_git_repo: c.hasGit,
    }));
  }
}

/** Текущий статус одного проекта. */
export async function projectStatus(path: string): Promise<ProjectStatus> {
  return invoke<ProjectStatus>("project_status", { path });
}

/** Читает файл проекта (UTF-8). Ошибка — throw. */
export async function readFile(path: string, maxBytes?: number): Promise<string> {
  return invoke<string>("read_file", {
    path,
    maxBytes: maxBytes ?? null,
  });
}

/** Читает файл или null при отсутствии — для сборки контекста. */
export async function readFileOrNull(path: string, maxBytes?: number): Promise<string | null> {
  try {
    return await readFile(path, maxBytes);
  } catch {
    return null;
  }
}

/**
 * Применяет изменения к файлам проекта.
 * diff = ПОЛНЫЙ новый текст файла (контракт RustBackend). Бэкап/запись — в Rust.
 */
export async function applyChanges(
  projectPath: string,
  changes: FileChange[],
): Promise<ApplyResult> {
  return invoke<ApplyResult>("apply_changes", { projectPath, changes });
}

/**
 * «Отменить изменения»: git-проект → git_checkout (checkout .), иначе →
 * restore из .grok-backup-* (команда rollback). true — что-то откатили.
 */
export async function rollbackChanges(projectPath: string): Promise<boolean> {
  let isRepo = false;
  try {
    isRepo = await gitIsRepo(projectPath);
  } catch {
    isRepo = false;
  }
  if (isRepo) {
    try {
      const ok: unknown = await invoke("git_checkout", { projectPath });
      if (ok === true) return true;
    } catch {
      /* упавший checkout не мешает попробовать бэкап */
    }
  }
  const restored: unknown = await invoke("rollback", { projectPath });
  return restored === true;
}

/** Есть ли в папке проекта .git. */
export async function gitIsRepo(path: string): Promise<boolean> {
  return invoke<boolean>("git_is_repo", { path });
}

// ---------------------------------------------------------------------------
// Диалог выбора папки и хранилище настроек
// ---------------------------------------------------------------------------

/**
 * Нативный диалог «выбрать папку» (tauri-plugin-dialog, ставит RustBackend).
 * null — пользователь отменил или плагин недоступен (dev-режим в браузере).
 */
export async function pickFolder(): Promise<string | null> {
  try {
    const res = await openDialog({ directory: true });
    return typeof res === "string" ? res : null;
  } catch {
    return null;
  }
}

/** Сырой JSON настроек из app_config_dir (команды RustBackend). null — нет файла. */
export async function getSettingsRaw(): Promise<string | null> {
  const raw: unknown = await invoke("get_settings");
  return typeof raw === "string" && raw ? raw : null;
}

/** Записывает сырой JSON настроек. Ошибка — молча (хранилище дублирует localStorage). */
export async function setSettingsRaw(json: string): Promise<void> {
  try {
    await invoke("set_settings", { json });
  } catch {
    /* настроечный бэкенд необязателен — localStorage остаётся источником */
  }
}
