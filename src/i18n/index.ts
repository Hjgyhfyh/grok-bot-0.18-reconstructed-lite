import { ru, type RuKey } from "./ru";

export { ru };
export type { RuKey };

// Ключи, значения которых — строки (не массивы форм).
export type RuStringKey = {
  [K in RuKey]: (typeof ru)[K] extends string ? K : never;
}[RuKey];

export type PluralForms = readonly [one: string, few: string, many: string];
export type TParams = Record<string, string | number>;

const PLACEHOLDER = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/**
 * Подставляет {params} в строку словаря: t("projectFiles", { n: 5 }) → "Файлов: 5".
 * Для ключей-массивов форм (agoMinutes/agoHours/agoDays) сам выбирает форму по params.n:
 * t("agoDays", { n: 21 }) → "21 день назад".
 * Без параметров возвращает строку как есть. Неизвестный ключ/не-строка → сам ключ (не падаем в UI).
 */
export function t(key: RuKey, params?: TParams): string {
  const value = ru[key];
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((s) => typeof s === "string" && s.includes("{n}"))
  ) {
    // Тройка plural-форм [one, few, many] — выбор по params.n.
    const n = params && "n" in params ? Number(params.n) : NaN;
    text = (value as PluralForms)[pluralForm(n)];
  } else {
    return String(key);
  }
  if (!params) return text;

  const used: Record<string, true> = {};
  const out = text.replace(PLACEHOLDER, (m, name: string) => {
    if (name in params) {
      used[name] = true;
      return String(params[name]);
    }
    return m;
  });

  if (import.meta.env?.DEV) {
    const missing = out.match(PLACEHOLDER);
    if (missing) {
      console.error(`[i18n] t("${key}"): нет параметров для ${missing.join(", ")}`);
    }
    for (const name of Object.keys(params)) {
      if (!used[name] && !text.includes(`{${name}}`)) {
        console.warn(`[i18n] t("${key}"): лишний параметр {${name}}`);
      }
    }
  }
  return out;
}
/**
 * Русское правило трёх форм → индекс 0 (one) / 1 (few) / 2 (many).
 * 1 → 0; 2–4 → 1; 5–20, 25, 111 → 2; 21 → 0; 22–24 → 1.
 * Нечисловые/бесконечные/дробные значения → форма many (2).
 */
export function pluralForm(n: number): 0 | 1 | 2 {
  if (!Number.isFinite(n)) return 2;
  const abs = Math.abs(n);
  if (abs % 1 !== 0) return 2;
  const i = Math.floor(abs);
  const d = i % 10;
  const h = i % 100;
  if (d === 1 && h !== 11) return 0;
  if (d >= 2 && d <= 4 && (h < 10 || h >= 20)) return 1;
  return 2;
}

// Алиас по контракту тест-плана.
export const pluralRu = pluralForm;

/**
 * Выбирает форму по n и подставляет {n}:
 * plural(21, ru.agoDays) → "21 день назад".
 */
export function plural(n: number, forms: PluralForms): string {
  const tpl = forms[pluralForm(n)] ?? forms[2];
  return tpl.replace(/\{n\}/g, String(n));
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Относительное время для подписи «Изменено: …».
 * ts — момент в мс, now — «сейчас» в мс (по умолчанию Date.now()).
 * <1 мин → «только что»; <1 ч → минуты; <24 ч → часы; <30 д → дни; дальше → «больше месяца назад».
 * Будущее/NaN → «только что»; ±Infinity → «только что»/«больше месяца назад».
 */
export function formatRelative(ts: number, now: number = Date.now()): string {
  const delta = now - ts;
  if (Number.isNaN(delta)) return ru.agoJustNow;
  if (delta === Infinity) return ru.agoLongAgo;
  if (delta < MINUTE) return ru.agoJustNow; // включая будущее и -Infinity
  if (delta < HOUR) return plural(Math.floor(delta / MINUTE), ru.agoMinutes);
  if (delta < DAY) return plural(Math.floor(delta / HOUR), ru.agoHours);
  if (delta < 30 * DAY) return plural(Math.floor(delta / DAY), ru.agoDays);
  return ru.agoLongAgo;
}

// Алиас по контракту тест-плана: formatRelativeTime(ts, now) === formatRelative(ts, now).
export const formatRelativeTime = formatRelative;
