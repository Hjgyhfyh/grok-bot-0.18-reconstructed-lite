//! Tauri-команды — контракт с фронтендом (типы зеркалят src/services/tauri.ts).
//! Имена полей сериализуются в snake_case — как в TS-интерфейсах.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Сколько файлов максимум обходим при подсчёте/mtime — защита от огромных деревьев.
const MAX_WALK_FILES: u32 = 5_000;
/// Проект «давно не трогали», если активности не было больше 14 дней.
const STALE_SECS: u64 = 14 * 24 * 60 * 60;
/// Таймаут внутренних вызовов git (статусы карточек).
const GIT_TIMEOUT: Duration = Duration::from_secs(5);
/// Таймаут команды git_run (порт src/core/git.ts → ~10 с).
const GIT_RUN_TIMEOUT: Duration = Duration::from_secs(10);
/// read_file: потолок размера по умолчанию.
const DEFAULT_MAX_BYTES: u64 = 1_000_000;
/// Имя файла-манифеста внутри папки бэкапа.
const BACKUP_MANIFEST: &str = ".grok-backup-manifest.json";
/// Префикс имён папок бэкапов внутри проекта.
const BACKUP_PREFIX: &str = ".grok-backup-";
/// Имя файла настроек в app_config_dir.
const SETTINGS_FILE: &str = "settings.json";

/// Папки, которые никогда не обходим при сканировании и подсчёте.
const PRUNE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    "target",
    ".venv",
];

/// Файлы-маркеры: их наличие в папке делает её «проектом».
/// (*.sln/*.csproj проверяются отдельно — это маски, а не точные имена.)
// CONTRACT: список зеркалит PROJECT_FILE_MARKERS в src/core/scanner.ts.
const MARKER_FILES: &[&str] = &[
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "Cargo.toml",
    "go.mod",
    "Makefile",
    "default.project.json",
    "index.html",
];

/// Расширения-маркеры проектов (*.sln, *.csproj).
const MARKER_EXTS: &[&str] = &["sln", "csproj"];

#[derive(Debug, Clone, Serialize)]
pub struct ProjectCard {
    pub path: String,
    pub name: String,
    pub status: ProjectStatus,
    /// unix-timestamp последнего изменения (секунды)
    pub last_activity: u64,
    /// Число файлов проекта без node_modules/.git/dist/… (потолок 5000)
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
    /// Путь файла ОТНОСИТЕЛЬНО папки проекта.
    pub path: String,
    /// Полный новый текст файла (НЕ unified diff).
    // CONTRACT: src/core/context.ts toFileChanges() кладёт сюда
    // финальное содержимое файла целиком — мы пишем его как есть.
    pub diff: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApplyResult {
    /// Относительные пути успешно записанных файлов.
    pub applied: Vec<String>,
    /// Абсолютный путь к папке бэкапа (.grok-backup-<ts>) или null.
    pub backup_dir: Option<String>,
}

/// Результат `git_run` — зеркалит GitRun из src/core/git.ts.
#[derive(Debug, Clone, Serialize)]
pub struct GitRunResult {
    /// exit-код процесса; -1 если код недоступен (сигнал и т.п.).
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Элемент `list_dir` — дети папки на 1 уровень.
#[derive(Debug, Clone, Serialize)]
pub struct DirEntry {
    pub name: String,
    /// Абсолютный путь.
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// unix-time модификации, миллисекунды; 0 — неизвестно.
    pub modified_ms: u64,
}

/// Манифест бэкапа: что восстановить копированием, что удалить (новые файлы).
#[derive(Debug, Serialize, Deserialize)]
struct BackupManifest {
    /// Файлы, которые существовали до применения — их копии лежат в папке бэкапа.
    files: Vec<String>,
    /// Файлы, созданные применением — при откате их надо удалить.
    new_files: Vec<String>,
}

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn mtime_secs(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Скрытое имя (начинается с точки) — такие папки сканер пропускает.
fn is_hidden(name: &std::ffi::OsStr) -> bool {
    name.to_string_lossy().starts_with('.')
}

/// Имя папки в списке прунинга, скрытое или наша папка бэкапа.
fn is_pruned(name: &std::ffi::OsStr) -> bool {
    let n = name.to_string_lossy();
    is_hidden(name)
        || PRUNE_DIRS.iter().any(|p| n == *p)
        || n.starts_with(BACKUP_PREFIX)
}

/// Есть ли в папке маркеры проекта (точные имена, *.sln, *.csproj).
fn has_project_marker(dir: &Path) -> bool {
    if MARKER_FILES.iter().any(|m| dir.join(m).is_file()) {
        return true;
    }
    if let Ok(rd) = fs::read_dir(dir) {
        for entry in rd.flatten() {
            let marked = entry
                .path()
                .extension()
                .is_some_and(|e| {
                    MARKER_EXTS
                        .iter()
                        .any(|x| e.eq_ignore_ascii_case(x))
                });
            if marked && entry.file_type().is_ok_and(|t| t.is_file()) {
                return true;
            }
        }
    }
    false
}

/// Есть ли в папке хотя бы один не-скрытый элемент (файл или подпапка).
fn has_visible_children(dir: &Path) -> bool {
    fs::read_dir(dir).is_ok_and(|rd| {
        rd.flatten().any(|e| !is_hidden(&e.file_name()))
    })
}

/// Папка — проект: есть маркер или хоть какое-то содержимое.
/// (Пустые папки — не проекты, см. src/core/scanner.ts.)
fn is_project_dir(dir: &Path) -> bool {
    has_project_marker(dir) || has_visible_children(dir)
}

/// Обход проекта (без пруненых папок): максимальный mtime и число файлов.
/// Останавливаемся после MAX_WALK_FILES файлов — для карточки этого хватит.
fn dir_stats(dir: &Path) -> (u64, u32) {
    let mut last_activity = fs::metadata(dir)
        .map(|m| mtime_secs(&m))
        .unwrap_or_else(|_| now_secs());
    let mut file_count: u32 = 0;
    let mut stack = vec![dir.to_path_buf()];

    while let Some(d) = stack.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue; // не ходим по ссылкам — защита от циклов
            }
            if ft.is_dir() {
                if !is_pruned(&entry.file_name()) {
                    if let Ok(m) = entry.metadata() {
                        last_activity = last_activity.max(mtime_secs(&m));
                    }
                    stack.push(entry.path());
                }
            } else if ft.is_file() {
                file_count += 1;
                if let Ok(m) = entry.metadata() {
                    last_activity = last_activity.max(mtime_secs(&m));
                }
                if file_count >= MAX_WALK_FILES {
                    return (last_activity, file_count);
                }
            }
        }
    }
    (last_activity, file_count)
}

/// Самый свежий mtime среди «аварийных» файлов в корне проекта
/// (*.log, имена со «crash»/«error»). None — таких файлов нет.
fn newest_error_file_mtime(dir: &Path) -> Option<u64> {
    let rd = fs::read_dir(dir).ok()?;
    let mut newest = None;
    for entry in rd.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_lowercase();
        let suspicious =
            name.ends_with(".log") || name.contains("crash") || name.contains("error");
        if suspicious {
            if let Ok(m) = entry.metadata() {
                let t = mtime_secs(&m);
                newest = Some(newest.map_or(t, |n: u64| n.max(t)));
            }
        }
    }
    newest
}

/// Запуск `git <args>` в папке `dir` с таймаутом.
/// Ok(Some(output)) — процесс завершился (любой exit-код);
/// Ok(None) — не удалось запустить или таймаут; Err — spawn-ошибка.
fn run_git_raw(
    dir: Option<&Path>,
    args: &[&str],
    timeout: Duration,
) -> Result<Option<Output>, String> {
    let cwd = dir.map(|d| d.to_path_buf());
    let args: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut cmd = Command::new("git");
        cmd.args(&args)
            .stdin(Stdio::null())
            .stderr(Stdio::piped())
            .stdout(Stdio::piped());
        if let Some(cwd) = cwd {
            cmd.current_dir(cwd);
        }
        // На Windows не даём git создать консольное окно.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let _ = tx.send(cmd.output());
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(out)) => Ok(Some(out)),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Ok(Err(e)) => Err(format!("Не удалось запустить git: {e}")),
        // Таймаут или внезапная смерть потока — считаем git недоступным.
        _ => Ok(None),
    }
}

/// Успешный (exit 0) stdout git-команды; None — git нет/упал/таймаут.
fn run_git_ok(dir: &Path, args: &[&str]) -> Option<String> {
    let mut full = vec!["-C"];
    // -C принимает &str; собираем вектор ссылок с заёмным путём.
    let dir_s = dir.to_string_lossy().to_string();
    full.push(dir_s.as_str());
    full.extend_from_slice(args);
    match run_git_raw(None, &full, GIT_TIMEOUT) {
        Ok(Some(out)) if out.status.success() => {
            Some(String::from_utf8_lossy(&out.stdout).to_string())
        }
        _ => None,
    }
}

/// Статус карточки: авария > несохранённое > давно не трогали > чисто.
fn compute_status(dir: &Path, is_git: bool, last_activity: u64, now: u64) -> ProjectStatus {
    // «Последний запуск упал»: аварийный файл — самое свежее, что есть в проекте.
    if let Some(err_mtime) = newest_error_file_mtime(dir) {
        if err_mtime + 60 >= last_activity {
            return ProjectStatus::Crashed;
        }
    }
    if is_git {
        if let Some(out) = run_git_ok(dir, &["status", "--porcelain"]) {
            if !out.trim().is_empty() {
                return ProjectStatus::Dirty;
            }
        }
    }
    if now.saturating_sub(last_activity) > STALE_SECS {
        ProjectStatus::Stale
    } else {
        ProjectStatus::Clean
    }
}

/// Безопасное соединение «база + относительный путь»: без `..`, без абсолютных.
fn safe_join(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim();
    if rel.is_empty() {
        return Err("Пустой путь к файлу".to_string());
    }
    let rp = Path::new(rel);
    if rp.is_absolute() {
        return Err(format!("Путь «{rel}» должен быть относительным"));
    }
    for c in rp.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(format!("Недопустимый путь к файлу: «{rel}»")),
        }
    }
    Ok(base.join(rp))
}

/// Это папка бэкапа (имя .grok-backup-*)?
fn is_backup_dir(p: &Path) -> bool {
    p.file_name()
        .map(|n| n.to_string_lossy().starts_with(BACKUP_PREFIX))
        .unwrap_or(false)
}

/// Самый свежий .grok-backup-<ts> внутри проекта.
fn newest_backup_dir(project: &Path) -> Option<PathBuf> {
    let rd = fs::read_dir(project).ok()?;
    rd.flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .filter(|p| is_backup_dir(p))
        .max_by_key(|p| {
            // Имя тоже хронологическое, но mtime надёжнее при смешанных форматах.
            p.metadata()
                .map(|m| mtime_secs(&m))
                .unwrap_or(0)
        })
}

/// Имя папки бэкапа в формате src/core/backup.ts: .grok-backup-YYYYMMDD-HHMMSS
/// (UTC; при коллизии дописываем -2, -3, …).
fn backup_dir_name() -> String {
    let secs = now_secs();
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Григорианская дата из дней с эпохи (алгоритм Хиннанта).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    let (h, m, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    format!("{BACKUP_PREFIX}{year:04}{month:02}{day:02}-{h:02}{m:02}{s:02}")
}

/// Свободное имя .grok-backup-… внутри проекта (суффикс -n при коллизии).
fn fresh_backup_dir(project: &Path) -> PathBuf {
    let base = backup_dir_name();
    let candidate = project.join(&base);
    if !candidate.exists() {
        return candidate;
    }
    for n in 2..1000 {
        let c = project.join(format!("{base}-{n}"));
        if !c.exists() {
            return c;
        }
    }
    // Практически недостижимо — вернём штамп с наносекундной солью.
    project.join(format!("{base}-{}", SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0)))
}

/// Восстановить файлы из папки бэкапа в проект и удалить новые файлы.
fn restore_backup(backup: &Path, project: &Path) -> Result<(), String> {
    let manifest_path = backup.join(BACKUP_MANIFEST);
    let manifest: BackupManifest = if manifest_path.is_file() {
        let text = fs::read_to_string(&manifest_path)
            .map_err(|e| format!("Не удалось прочитать манифест бэкапа: {e}"))?;
        serde_json::from_str(&text).map_err(|e| format!("Манифест бэкапа повреждён: {e}"))?
    } else {
        // Бэкап без манифеста (сделан руками/старым форматом) — копируем всё.
        let mut files = Vec::new();
        let mut stack = vec![backup.to_path_buf()];
        while let Some(d) = stack.pop() {
            if let Ok(rd) = fs::read_dir(&d) {
                for e in rd.flatten() {
                    if e.file_type().is_ok_and(|t| t.is_dir()) {
                        stack.push(e.path());
                    } else if let Ok(rel) = e.path().strip_prefix(backup) {
                        files.push(rel.to_string_lossy().to_string());
                    }
                }
            }
        }
        BackupManifest {
            files,
            new_files: Vec::new(),
        }
    };

    // Возвращаем старые версии файлов.
    for rel in &manifest.files {
        let src = safe_join(backup, rel)?;
        let dst = safe_join(project, rel)?;
        if !src.is_file() {
            continue; // копии нет — пропускаем, не считаем ошибкой
        }
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Не удалось создать папку: {e}"))?;
        }
        fs::copy(&src, &dst)
            .map_err(|e| format!("Не удалось восстановить файл «{rel}»: {e}"))?;
    }
    // Удаляем файлы, которых до применения не было.
    for rel in &manifest.new_files {
        let dst = safe_join(project, rel)?;
        if dst.is_file() {
            let _ = fs::remove_file(&dst);
        }
    }
    // Отработанный бэкап убираем: следующий откат возьмёт более старый.
    let _ = fs::remove_dir_all(backup);
    Ok(())
}

/// Родительская папка для ребёнка-кандидата при сканировании.
fn collect_child_dirs(dir: &Path, out: &mut Vec<PathBuf>) {
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            if !e.file_type().is_ok_and(|t| t.is_dir()) || is_pruned(&e.file_name()) {
                continue;
            }
            out.push(e.path());
        }
    }
}

fn card_for(dir: &Path, now: u64) -> ProjectCard {
    let (last_activity, file_count) = dir_stats(dir);
    let is_git = dir.join(".git").exists();
    ProjectCard {
        path: dir.to_string_lossy().to_string(),
        name: dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| dir.to_string_lossy().to_string()),
        status: compute_status(dir, is_git, last_activity, now),
        last_activity,
        file_count,
        is_git_repo: is_git,
    }
}

// ---------------------------------------------------------------------------
// Команды
// ---------------------------------------------------------------------------

/// Сканирует корень проектов на 2 уровня и возвращает карточки.
/// Проект = папка с маркером или любым непустым содержимым
/// (пустые папки, скрытые, .grok-backup-* и служебные — не проекты).
#[tauri::command]
pub fn scan_projects(root: String) -> Result<Vec<ProjectCard>, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err("Папка не найдена. Проверьте путь и попробуйте снова.".to_string());
    }
    let now = now_secs();
    let mut project_dirs: Vec<PathBuf> = Vec::new();

    // Уровень 0: пользователь мог выбрать сам проект как «корень».
    // Только при явном маркере — иначе любая папка с файлами стала бы проектом.
    if has_project_marker(root_path) {
        project_dirs.push(root_path.to_path_buf());
    }

    // Уровень 1.
    let mut level1 = Vec::new();
    collect_child_dirs(root_path, &mut level1);
    for d1 in level1 {
        if is_project_dir(&d1) {
            project_dirs.push(d1);
            continue;
        }
        // Уровень 2 — только если сама папка не проект.
        let mut level2 = Vec::new();
        collect_child_dirs(&d1, &mut level2);
        for d2 in level2 {
            if is_project_dir(&d2) {
                project_dirs.push(d2);
            }
        }
    }

    let mut cards: Vec<ProjectCard> = project_dirs.iter().map(|d| card_for(d, now)).collect();
    // Свежие проекты сверху.
    cards.sort_by_key(|c| std::cmp::Reverse(c.last_activity));
    cards.dedup_by(|a, b| a.path == b.path);
    Ok(cards)
}

/// Текущий статус одного проекта.
#[tauri::command]
pub fn project_status(path: String) -> Result<ProjectStatus, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err("Папка проекта не найдена.".to_string());
    }
    let (last_activity, _) = dir_stats(dir);
    let is_git = dir.join(".git").exists();
    Ok(compute_status(dir, is_git, last_activity, now_secs()))
}

/// Читает файл как UTF-8 (невалидные байты заменяются), не более max_bytes.
// CONTRACT: фронт передаёт полный путь файла проекта (абсолютный,
// внутри выбранной папки проектов); «..» и прочие выходы отклоняем всегда.
#[tauri::command]
pub fn read_file(path: String, max_bytes: Option<u64>) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("Пустой путь к файлу.".to_string());
    }
    let p = Path::new(&path);
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("В пути нельзя использовать «..».".to_string());
    }
    let meta = fs::metadata(p).map_err(|_| format!("Файл не найден: «{path}»"))?;
    if !meta.is_file() {
        return Err(format!("«{path}» — это не файл."));
    }
    let limit = max_bytes.unwrap_or(DEFAULT_MAX_BYTES) as usize;
    let bytes = fs::read(p).map_err(|e| format!("Не удалось прочитать файл: {e}"))?;
    let cut = bytes.len().min(limit);
    Ok(String::from_utf8_lossy(&bytes[..cut]).to_string())
}

/// Существует ли путь (файл или папка). Без ошибок — просто false.
#[tauri::command]
pub fn file_exists(path: String) -> bool {
    !path.trim().is_empty() && Path::new(&path).exists()
}

/// Дети папки на 1 уровень (без скрытых и служебных — как у сканера).
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err("Папка не найдена.".to_string());
    }
    let rd = fs::read_dir(dir).map_err(|e| format!("Не удалось прочитать папку: {e}"))?;
    let mut out = Vec::new();
    for e in rd.flatten() {
        if is_hidden(&e.file_name()) {
            continue;
        }
        let p = e.path();
        let Ok(meta) = e.metadata() else { continue };
        if meta.file_type().is_symlink() {
            continue;
        }
        out.push(DirEntry {
            name: e.file_name().to_string_lossy().to_string(),
            path: p.to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
            size: if meta.is_file() { meta.len() } else { 0 },
            modified_ms: mtime_ms(&meta),
        });
    }
    // Сначала папки, потом файлы; внутри — по имени.
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Прочитать settings.json из app_config_dir. None — файла ещё нет.
#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Не удалось найти папку настроек: {e}"))?;
    let file = dir.join(SETTINGS_FILE);
    if !file.is_file() {
        return Ok(None);
    }
    fs::read_to_string(&file)
        .map(Some)
        .map_err(|e| format!("Не удалось прочитать настройки: {e}"))
}

/// Записать settings.json в app_config_dir (перезапись целиком).
#[tauri::command]
pub fn set_settings(app: tauri::AppHandle, json: String) -> Result<(), String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Не удалось найти папку настроек: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Не удалось создать папку настроек: {e}"))?;
    fs::write(dir.join(SETTINGS_FILE), json)
        .map_err(|e| format!("Не удалось сохранить настройки: {e}"))
}

/// Порт GitPort из src/core/git.ts: `git <args>` в cwd, таймаут 10 с.
/// Резолвится при ЛЮБОМ exit-коде; Err только если git не нашёлся,
/// не запустился или не ответил за 10 с.
#[tauri::command]
pub fn git_run(args: Vec<String>, cwd: Option<String>) -> Result<GitRunResult, String> {
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let dir = cwd.as_deref().map(Path::new);
    let out = run_git_raw(dir, &arg_refs, GIT_RUN_TIMEOUT)?
        .ok_or_else(|| "Git не найден или не ответил за 10 секунд.".to_string())?;
    Ok(GitRunResult {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    })
}

/// Применяет изменения к файлам проекта. Перед записью создаёт в проекте
/// .grok-backup-YYYYMMDD-HHMMSS с копиями затронутых файлов и манифестом —
/// по нему работает rollback. `FileChange.diff` — полный новый текст файла.
#[tauri::command]
pub fn apply_changes(
    project_path: String,
    changes: Vec<FileChange>,
) -> Result<ApplyResult, String> {
    let project = Path::new(&project_path);
    if !project.is_dir() {
        return Err("Папка проекта не найдена.".to_string());
    }
    if changes.is_empty() {
        return Ok(ApplyResult {
            applied: Vec::new(),
            backup_dir: None,
        });
    }

    // 1. Проверяем все пути до первой записи на диск.
    let mut targets = Vec::with_capacity(changes.len());
    for ch in &changes {
        targets.push(safe_join(project, &ch.path)?);
    }

    // 2. Бэкап: копии существующих файлов + манифест.
    let backup = fresh_backup_dir(project);
    let mut manifest = BackupManifest {
        files: Vec::new(),
        new_files: Vec::new(),
    };
    for (ch, target) in changes.iter().zip(&targets) {
        if target.is_file() {
            let dest = safe_join(&backup, &ch.path)?;
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Не удалось создать папку бэкапа: {e}"))?;
            }
            fs::copy(target, &dest)
                .map_err(|e| format!("Не удалось сделать копию файла «{}»: {e}", ch.path))?;
            manifest.files.push(ch.path.clone());
        } else {
            manifest.new_files.push(ch.path.clone());
        }
    }
    fs::create_dir_all(&backup).map_err(|e| format!("Не удалось создать папку бэкапа: {e}"))?;
    let manifest_text =
        serde_json::to_string(&manifest).map_err(|e| format!("Внутренняя ошибка: {e}"))?;
    fs::write(backup.join(BACKUP_MANIFEST), manifest_text)
        .map_err(|e| format!("Не удалось записать манифест бэкапа: {e}"))?;

    // 3. Записываем новые версии.
    let mut applied = Vec::with_capacity(changes.len());
    for (ch, target) in changes.iter().zip(&targets) {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Не удалось создать папку для «{}»: {e}", ch.path))?;
        }
        fs::write(target, &ch.diff)
            .map_err(|e| format!("Не удалось записать файл «{}»: {e}", ch.path))?;
        applied.push(ch.path.clone());
    }

    Ok(ApplyResult {
        applied,
        backup_dir: Some(backup.to_string_lossy().to_string()),
    })
}

/// Откат последнего применённого изменения из бэкапа.
/// Принимает папку проекта (ищет самый свежий .grok-backup-*) или саму папку
/// бэкапа. Возвращает false, если бэкапа нет — тогда для git-проекта фронт
/// вызывает git_checkout.
#[tauri::command]
pub fn rollback(project_path: String) -> Result<bool, String> {
    let p = Path::new(&project_path);
    if !p.is_dir() {
        return Err("Папка не найдена.".to_string());
    }
    let (backup, project) = if is_backup_dir(p) {
        match p.parent() {
            Some(parent) => (p.to_path_buf(), parent.to_path_buf()),
            None => return Err("У папки бэкапа нет родителя.".to_string()),
        }
    } else {
        match newest_backup_dir(p) {
            Some(b) => (b, p.to_path_buf()),
            None => return Ok(false),
        }
    };
    restore_backup(&backup, &project)?;
    Ok(true)
}

/// `git checkout .` в проекте — откат для git-репозиториев.
/// false, если это не git-проект или git недоступен/не ответил за 5 с.
#[tauri::command]
pub fn git_checkout(project_path: String) -> Result<bool, String> {
    let p = Path::new(&project_path);
    if !p.is_dir() {
        return Err("Папка проекта не найдена.".to_string());
    }
    if !p.join(".git").exists() {
        return Ok(false);
    }
    Ok(run_git_ok(p, &["checkout", "."]).is_some())
}

/// Есть ли в папке проекта .git.
#[tauri::command]
pub fn git_is_repo(path: String) -> bool {
    Path::new(&path).join(".git").exists()
}
