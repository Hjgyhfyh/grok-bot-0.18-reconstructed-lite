//! Tauri-команды — контракт с фронтендом (типы зеркалят src/services/tauri.ts).
//! Пока заглушки: реализацию пишет волна B. Сигнатуры и структуры — стабильные.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCard {
    pub path: String,
    pub name: String,
    pub status: ProjectStatus,
    /// unix-timestamp последнего изменения
    pub last_activity: u64,
    pub file_count: u32,
    pub is_git_repo: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectStatus {
    Clean,
    Dirty,
    /// Проект не трогали больше 14 дней
    Stale,
    /// Последний запуск упал
    Crashed,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FileChange {
    pub path: String,
    /// unified diff или полный новый текст — определит волна B
    pub diff: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub applied: Vec<String>,
    pub backup_dir: Option<String>,
}

fn not_implemented(cmd: &str) -> String {
    format!("{cmd} ещё не реализована (скелет)")
}

/// Сканирует корень проектов на 2 уровня и возвращает карточки.
#[tauri::command]
pub fn scan_projects(_root: String) -> Result<Vec<ProjectCard>, String> {
    Err(not_implemented("scan_projects"))
}

/// Текущий статус одного проекта.
#[tauri::command]
pub fn project_status(_path: String) -> Result<ProjectStatus, String> {
    Err(not_implemented("project_status"))
}

/// Читает файл проекта как UTF-8.
#[tauri::command]
pub fn read_file(_path: String) -> Result<String, String> {
    Err(not_implemented("read_file"))
}

/// Применяет изменения к файлам проекта (с бэкапом, если не git-репо).
#[tauri::command]
pub fn apply_changes(
    _project_path: String,
    _changes: Vec<FileChange>,
) -> Result<ApplyResult, String> {
    Err(not_implemented("apply_changes"))
}

/// Откатывает последнее применённое изменение (git checkout . или бэкап).
#[tauri::command]
pub fn rollback(_project_path: String) -> Result<(), String> {
    Err(not_implemented("rollback"))
}

/// Есть ли в папке проекта .git.
#[tauri::command]
pub fn git_is_repo(path: String) -> bool {
    Path::new(&path).join(".git").exists()
}
