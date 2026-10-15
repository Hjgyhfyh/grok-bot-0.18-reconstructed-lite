/**
 * Текстовые файлы с учётом кодировки.
 *
 * Заведующая библиотеки работает в Windows, и половина её `.txt` и `.csv` лежит
 * в windows-1251, четверть — в UTF-8 с BOM, остальное — в cp866. Читать всё как
 * UTF-8 нельзя: русский текст превращается в «РќРѕРјРјРѕ». В проекте уже есть
 * `jschardet` (определение) и `iconv-lite` (перекодировка) — здесь они связаны
 * в одну функцию.
 */

import iconv from "iconv-lite";
import jschardet from "jschardet";

export interface DecodedText {
  readonly text: string;
  readonly encoding: string;
  readonly confidence: number;
}

const JSDETECT_TO_ICONV: Readonly<Record<string, string>> = {
  "ascii": "ascii", "utf-8": "utf8", "utf8": "utf8",
  "windows-1251": "win1251", "windows-1252": "win1252", "windows-1250": "win1250", "windows-1253": "win1253", "windows-1254": "win1254",
  "iso-8859-1": "latin1", "iso-8859-2": "iso88592", "iso-8859-5": "iso88595", "iso-8859-7": "iso88597",
  "iso-8859-15": "latin9", "koi8-r": "koi8-r", "koi8-u": "koi8-u", "ibm866": "cp866", "maccyrillic": "cp1251",
};

/** Настоящий UTF-8 без BOM: непрерывная последовательность байтов без замен. */
export function looksLikeUtf8(bytes: Uint8Array): boolean {
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index] as number;
    let extra = 0;
    if (byte < 0x80) { index += 1; continue; }
    else if (byte >= 0xc2 && byte <= 0xdf) extra = 1;
    else if (byte >= 0xe0 && byte <= 0xef) extra = 2;
    else if (byte >= 0xf0 && byte <= 0xf4) extra = 3;
    else return false;
    if (index + extra >= bytes.length) return true;
    for (let step = 1; step <= extra; step += 1) {
      const next = bytes[index + step] as number;
      if (next < 0x80 || next > 0xbf) return false;
    }
    index += extra + 1;
  }
  return true;
}

function stripBom(text: string): string { return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; }

/**
 * Определяет кодировку и декодирует. Порядок: BOM, потом настоящий UTF-8,
 * потом `jschardet`, и только в конце windows-1251 — русские документы чаще
 * именно в ней, а не в ISO-8859-1, который `jschardet` любит выдавать.
 */
export function decodeTextBytes(bytes: Uint8Array, hintedEncoding?: string | null): DecodedText {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: stripBom(new TextDecoder("utf-8").decode(bytes)), encoding: "utf-8", confidence: 1 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decodeWith(bytes, "utf16-le"), encoding: "utf-16le", confidence: 1 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decodeWith(bytes, "utf16-be"), encoding: "utf-16be", confidence: 1 };
  }
  if (hintedEncoding != null && hintedEncoding.length > 0) {
    const mapped = JSDETECT_TO_ICONV[hintedEncoding.toLowerCase()] ?? hintedEncoding;
    if (iconv.encodingExists(mapped)) return { text: decodeWith(bytes, mapped), encoding: mapped, confidence: 0.9 };
  }
  if (looksLikeUtf8(bytes)) return { text: new TextDecoder("utf-8").decode(bytes), encoding: "utf-8", confidence: 0.8 };

  const sample = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
  const detected = jschardet.detect(Buffer.from(sample));
  const label = (detected.encoding ?? "").toLowerCase();
  const confidence = typeof detected.confidence === "number" ? detected.confidence : 0;
  const mapped = JSDETECT_TO_ICONV[label];
  if (mapped != null && iconv.encodingExists(mapped) && confidence >= 0.4) {
    return { text: decodeWith(bytes, mapped), encoding: mapped, confidence };
  }
  if (hasCyrillicHighBytes(sample)) return { text: decodeWith(bytes, "win1251"), encoding: "win1251", confidence: 0.5 };
  return { text: decodeWith(bytes, "win1252"), encoding: "win1252", confidence: 0.3 };
}

function decodeWith(bytes: Uint8Array, encoding: string): string {
  try {
    return iconv.decode(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), encoding);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function hasCyrillicHighBytes(bytes: Uint8Array): boolean {
  let found = 0;
  for (const byte of bytes) if (byte >= 0xc0 && byte <= 0xff) { found += 1; if (found > 16) return true; }
  return false;
}

const TAG_BREAK = /<\/?[a-zA-Z][^>]*>|\s+/;

/** HTML, XML и SVG: убираем разметку, оставляем текст и разрывы абзацев. */
export function markupToText(markup: string): string {
  return markup
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|table|blockquote)>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10) || 32))
    .split(TAG_BREAK)
    .filter((part) => part.length > 0)
    .join(" ");
}
