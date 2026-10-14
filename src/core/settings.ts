/**
 * Модель настроек приложения — чистый core-модуль.
 *
 * Никаких import из Tauri/DOM/config.ts: файл обязан одинаково работать
 * в webview и под `node --test` (см. grok-lite-testplan, §8 settings-store).
 * Зашитые в сборку значения (VITE_AI_*) сюда не доходят — адаптер
 * (stores/settingsStore) передаёт их через `defaults` в normalizeSettings.
 *
 * Пользовательских строк здесь нет: валидация возвращает коды,
 * перевод в текст — задача экрана через src/i18n/ru.ts.
 */

/** Тема интерфейса. `system` — следовать за Windows. */
export type Theme = "dark" | "light" | "system";

export interface Settings {
  /** Корневая папка, где лежат проекты пользователя. "" — ещё не выбрана. */
  projectsDir: string;
  /** Bearer-ключ OpenAI-compatible сервера. */
  apiKey: string;
  /** Базовый адрес сервера, напр. `http://127.0.0.1:20128/v1` (без trailing `/`). */
  baseUrl: string;
  /** Идентификатор модели. */
  model: string;
  theme: Theme;
}

/**
 * Дефолты «из коробки». apiKey пуст намеренно: реальный зашитый ключ
 * знает только адаптер (src/config.ts) и подставляет его как defaults
 * при normalizeSettings.
 */
export const DEFAULT_SETTINGS: Settings = {
  projectsDir: "",
  apiKey: "",
  baseUrl: "http://127.0.0.1:20128/v1",
  model: "swe-2-max",
  theme: "dark",
};

export type SettingsField = keyof Settings;

/** Стабильный порядок полей для обхода в формах и validateSettings. */
export const SETTINGS_FIELDS: readonly SettingsField[] = [
  "projectsDir",
  "apiKey",
  "baseUrl",
  "model",
  "theme",
] as const;

/**
 * Код ошибки валидации. Никаких русских текстов — маппинг в i18n:
 * - "empty"         — поле обязательно и пустое (после trim);
 * - "invalid-url"   — baseUrl не парсится или протокол не http/https;
 * - "invalid-theme" — тема не из списка.
 */
export type SettingsErrorCode = "empty" | "invalid-url" | "invalid-theme";

export interface SettingsError {
  field: SettingsField;
  code: SettingsErrorCode;
}

const THEMES: readonly string[] = ["dark", "light", "system"];

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && THEMES.includes(value);
}

/**
 * Нормализация адреса: обрезать пробелы по краям и хвостовые `/`.
 * Слэши схемы (`proto://`) не трогаем — "http://" остаётся "http://"
 * (валидатор его всё равно отвергнет, но строка не портится).
 */
export function sanitizeUrl(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  const sep = trimmed.indexOf("://");
  if (sep < 0) return trimmed.replace(/\/+$/, "");
  const head = trimmed.slice(0, sep + 3);
  const rest = trimmed.slice(sep + 3).replace(/\/+$/, "");
  return head + rest;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}


/**
 * Проверка одного поля. `value` типизирован как unknown, чтобы форму
 * можно было гонять по корпусу «мусорных» значений из тест-плана
 * (null, числа, массивы) без приведений.
 */
export function validateField(
  field: SettingsField,
  value: unknown,
): SettingsError | null {
  switch (field) {
    case "apiKey":
    case "model":
    case "projectsDir":
      return isNonEmptyString(value) ? null : { field, code: "empty" };
    case "baseUrl": {
      if (!isNonEmptyString(value)) return { field, code: "empty" };
      let protocol: string;
      try {
        protocol = new URL(value).protocol;
      } catch {
        return { field, code: "invalid-url" };
      }
      // http допустим намеренно: lite разрешает LAN-серверы (features §4);
      // доступность здесь НЕ проверяется — validate только про формат.
      return protocol === "http:" || protocol === "https:"
        ? null
        : { field, code: "invalid-url" };
    }
    case "theme":
      return isTheme(value) ? null : { field, code: "invalid-theme" };
  }
}

/** Все ошибки настроек сразу (для подсветки формы). Порядок = SETTINGS_FIELDS. */
export function validateSettings(s: Settings): SettingsError[] {
  const errors: SettingsError[] = [];
  for (const field of SETTINGS_FIELDS) {
    const error = validateField(field, s[field]);
    if (error) errors.push(error);
  }
  return errors;
}

/**
 * Слить сохранённый JSON с дефолтами → валидная по форме Settings.
 * Переживает любой мусор: не-объект, неверные типы, отсутствующие поля.
 *
 * Правила:
 * - строки trim'ятся; baseUrl дополнительно sanitizeUrl;
 * - пустая строка в apiKey/baseUrl/model = «оставить как есть»
 *   (подсказка в UI) → берётся дефолт;
 * - projectsDir пустую сохраняем — «папка не выбрана» легальное состояние
 *   до онбординга, выдумывать путь нельзя;
 * - неизвестная тема → дефолтная.
 */
export function normalizeSettings(
  raw: unknown,
  defaults: Settings = DEFAULT_SETTINGS,
): Settings {
  const r: Record<string, unknown> =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};

  const keepEmpty = (v: unknown, fallback: string): string =>
    typeof v === "string" ? v.trim() : fallback;

  const orDefault = (v: unknown, fallback: string): string => {
    const s = keepEmpty(v, fallback);
    return s === "" ? fallback : s;
  };

  return {
    projectsDir: keepEmpty(r.projectsDir, defaults.projectsDir),
    apiKey: orDefault(r.apiKey, defaults.apiKey),
    baseUrl: sanitizeUrl(orDefault(r.baseUrl, defaults.baseUrl)),
    model: orDefault(r.model, defaults.model),
    theme: isTheme(r.theme) ? r.theme : defaults.theme,
  };
}

/**
 * Маска ключа для показа в UI: «sk-…••••».
 * Для ключей вида `sk-…` оставляем префикс до первого дефиса включительно;
 * иначе — не больше трети и не больше 4 символов. Пустой ключ → "".
 * Никогда не возвращает ключ целиком (кроме совсем коротких ≤4 — те
 * прячем полностью).
 */
export function maskKey(key: string): string {
  const k = String(key ?? "").trim();
  if (k === "") return "";
  if (k.length <= 4) return "••••";
  const dash = k.indexOf("-");
  const head =
    dash > 0 && dash <= 5 ? dash + 1 : Math.min(4, Math.ceil(k.length / 3));
  return `${k.slice(0, head)}…••••`;
}
