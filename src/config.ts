/**
 * Зашитые при сборке настройки AI.
 *
 * Источник: переменные окружения VITE_AI_* (файл .env в корне проекта,
 * не коммитится; пример — .env.example). build.rs в src-tauri пробрасывает
 * те же значения в Rust-часть как env!-переменные.
 *
 * Волна B: настройки на экране «Настройки» должны перекрывать эти дефолты
 * (хранение пользовательских значений — через stores/settingsStore).
 */

export const AI_BASE_URL: string =
  import.meta.env.VITE_AI_BASE_URL ?? "http://127.0.0.1:20128/v1";

export const AI_API_KEY: string = import.meta.env.VITE_AI_API_KEY ?? "";

export const AI_MODEL: string =
  import.meta.env.VITE_AI_MODEL ?? "swe-2-max";

/** OpenAI-compatible endpoint для чата: POST {AI_BASE_URL}/chat/completions */
export const AI_CHAT_URL = `${AI_BASE_URL.replace(/\/+$/, "")}/chat/completions`;
