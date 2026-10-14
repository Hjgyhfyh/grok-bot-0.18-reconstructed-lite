import { invoke } from "@tauri-apps/api/core";

/**
 * Типы совпадают с serde-структурами в src-tauri/src/commands.rs.
 * Это контракт для волны B — менять только согласованно с Rust-стороной.
 */

export interface ProjectCard {
  path: string;
  name: string;
  status: ProjectStatus;
  /** unix-timestamp последнего изменения */
  last_activity: number;
  file_count: number;
  is_git_repo: boolean;
}

export type ProjectStatus = "clean" | "dirty" | "stale" | "crashed";

export interface FileChange {
  path: string;
  /** unified diff или полный новый текст — решается в волне B */
  diff: string;
}

export interface ApplyResult {
  applied: string[];
  backup_dir: string | null;
}

/** Сканирует корень проектов на 2 уровня, возвращает карточки. */
export async function scanProjects(root: string): Promise<ProjectCard[]> {
  return invoke<ProjectCard[]>("scan_projects", { root });
}

/** Текущий статус одного проекта. */
export async function projectStatus(path: string): Promise<ProjectStatus> {
  return invoke<ProjectStatus>("project_status", { path });
}

/** Читает файл проекта (UTF-8). */
export async function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

/** Применяет набор изменений к файлам проекта (с бэкапом при необходимости). */
export async function applyChanges(
  projectPath: string,
  changes: FileChange[],
): Promise<ApplyResult> {
  return invoke<ApplyResult>("apply_changes", { projectPath, changes });
}

/** Откатывает последнее применённое изменение. */
export async function rollback(projectPath: string): Promise<void> {
  return invoke<void>("rollback", { projectPath });
}

/** Есть ли в папке проекта .git. */
export async function gitIsRepo(path: string): Promise<boolean> {
  return invoke<boolean>("git_is_repo", { path });
}
