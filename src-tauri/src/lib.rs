mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::scan_projects,
            commands::project_status,
            commands::read_file,
            commands::apply_changes,
            commands::rollback,
            commands::git_is_repo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
