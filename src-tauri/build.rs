fn main() {
    // Пробрасываем AI-настройки из окружения сборки в Rust-код как env!-переменные.
    // Фронтенд читает те же значения через VITE_* / import.meta.env (src/config.ts).
    for key in ["VITE_AI_BASE_URL", "VITE_AI_API_KEY", "VITE_AI_MODEL"] {
        if let Ok(value) = std::env::var(key) {
            println!("cargo:rustc-env={key}={value}");
        }
        println!("cargo:rerun-if-env-changed={key}");
    }
    tauri_build::build()
}
