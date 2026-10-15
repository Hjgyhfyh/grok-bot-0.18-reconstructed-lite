/**
 * Помощники XML для docx/odt: экранирование, разэкранирование, снятие тегов.
 *
 * Порт: Graphite Lite `ai/tools.rs:874-879` и `ai/docfill.rs:773-785, 961-974`.
 * `&` экранируется первым, иначе получится двойное экранирование.
 */

/** Экранирование для генерации XML: четыре замены, включая кавычки. */
export function xmlEscape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}

/** Экранирование для записи в готовый документ: без кавычек (порт `docfill.rs:773`). */
export function xmlEscapeText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function xmlUnescape(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/** Убирает всё, что внутри тегов, оставляя только текст. */
export function stripXmlTags(text: string): string {
  let out = "";
  let depth = 0;
  for (const ch of text) {
    if (ch === "<") depth += 1;
    else if (ch === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}
