mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::scan_projects,
            commands::project_status,
            commands::read_file,
            commands::file_exists,
            commands::list_dir,
            commands::get_settings,
            commands::set_settings,
            commands::git_run,
            commands::apply_changes,
            commands::rollback,
            commands::git_checkout,
            commands::git_is_repo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
