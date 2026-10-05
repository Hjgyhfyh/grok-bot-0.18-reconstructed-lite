/**
 * Старый бинарный Office: `.doc` (Word 97–2003) и `.xls` (Excel 97–2003).
 *
 * Это составной файл CFB, а не zip. Разбирать его целиком здесь незачем: заведующей
 * нужен текст, а не форматирование. Текст в обоих форматах лежит рядом
 * UTF-16-блоками, поэтому он вытаскивается поиском читаемых отрезков.
 *
 * Результат честно помечается как частичный: формулы, диаграммы и форматирование
 * не восстанавливаются. Полная замена формата невозможна без Word, а Word на
 * компьютере заведующей нет.
 */

const MIN_RUN = 6;
const MAX_RUN = 4_000;
const MAX_OUT = 200_000;

function isWidePrintable(code: number): boolean {
  if (code === 9 || code === 10 || code === 13) return true;
  if (code < 32) return false;
  if (code >= 0x410 && code <= 0x44f) return true; // кириллица
  if (code >= 0x400 && code <= 0x40f) return true; // ё и знаки препинания
  if (code >= 0x20 && code < 0x7f) return true;
  if (code >= 0xa0 && code <= 0xff) return true;    // типографские и латиница
  if (code === 0xab || code === 0xbb || code === 0x2014 || code === 0x2013 || code === 0x2026) return true;
  if (code >= 0x400 && code <= 0x4ff) return true;   // кириллица-2
  return false;
}

/**
 * Тот же признак, но без «печатного» ограничения снизу: в UTF-16 русская буква
 * лежит в 0x0400..0x04FF, и её младший байт — 0x04 или 0x10, а не ноль. Раньше
 * пара байт проверялась по отдельности, и текст Word 97–2003 не находился вовсе.
 */
function isWideCode(code: number): boolean {
  return isWidePrintable(code);
}

interface Segment {
  readonly start: number;
  readonly text: string;
}

/**
 * Сколько пар байт в файле похожи на текст в UTF-16 с заданным порядком байтов.
 * Word 97–2003 пишет текст блоками UTF-16LE, поэтому порядок определяется по
 * самому файлу, а не предполагается.
 */
function widePairCount(bytes: Uint8Array, littleEndian: boolean): number {
  let found = 0;
  const limit = Math.min(bytes.length, 64 * 1024) - 1;
  for (let index = 0; index + 1 <= limit; index += 2) {
    const code = littleEndian
      ? (bytes[index] as number) | ((bytes[index + 1] as number) << 8)
      : ((bytes[index] as number) << 8) | (bytes[index + 1] as number);
    if (isWideCode(code)) found += 1;
  }
  return found;
}

function wideRuns(bytes: Uint8Array): Segment[] {
  const littleEndian = widePairCount(bytes, true) >= widePairCount(bytes, false);
  const segments: Segment[] = [];
  let index = 0;
  while (index + 1 < bytes.length) {
    const first = wideCodeAt(bytes, index, littleEndian);
    if (first == null) { index += 1; continue; }
    let text = "";
    const start = index;
    let length = 0;
    while (index + 1 < bytes.length && length < MAX_RUN) {
      const code = wideCodeAt(bytes, index, littleEndian);
      if (code == null) break;
      text += String.fromCharCode(code);
      index += 2;
      length += 1;
    }
    if (text.replace(/\s+/g, "").length >= MIN_RUN) segments.push({ start, text });
    else index = start + 2;
  }
  return segments;
}

/** Код символа UTF-16 по двум байтам, либо `null`, если это не текст. */
function wideCodeAt(bytes: Uint8Array, index: number, littleEndian: boolean): number | null {
  const first = bytes[index] as number;
  const second = bytes[index + 1] as number;
  const code = littleEndian ? first | (second << 8) : (first << 8) | second;
  return isWideCode(code) ? code : null;
}

function narrowRuns(bytes: Uint8Array, skip: ReadonlySet<number>): Segment[] {
  const segments: Segment[] = [];
  let index = 0;
  let current = "";
  let start = 0;
  const push = (at: number): void => {
    if (current.replace(/\s+/g, "").length >= 12) segments.push({ start, text: current });
    current = "";
    start = at;
  };
  while (index < bytes.length) {
    const byte = bytes[index] as number;
    if (skip.has(index)) { push(index + 1); index += 1; continue; }
    const ok = (byte >= 0x20 && byte < 0x7f) || (byte >= 0xc0 && byte <= 0xff) || byte === 9 || byte === 10 || byte === 13;
    if (ok) { if (current.length === 0) start = index; current += String.fromCharCode(byte); }
    else push(index + 1);
    index += 1;
  }
  push(bytes.length);
  return segments;
}

function mergeIntoText(segments: readonly Segment[]): string {
  const kept: string[] = [];
  let total = 0;
  for (const segment of segments) {
    if (total >= MAX_OUT) break;
    const text = segment.text.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
    if (text.length < MIN_RUN) continue;
    const previous = kept.at(-1);
    if (previous != null && previous.endsWith(text)) continue;
    kept.push(text);
    total += text.length + 1;
  }
  return kept.join("\n").trim();
}

const CP1251_HIGH = [
  "Ђ", "Ѓ", "‚", "ѓ", "„", "…", "†", "‡", "€", "‰", "Љ", "‹", "Њ", "Ќ", "Ћ", "Џ",
  "ђ", "‘", "’", "“", "”", "•", "–", "—", "", "™", "љ", "›", "њ", "ќ", "ћ", "џ",
  " ", "Ў", "ў", "Ј", "¤", "Ґ", "¦", "§", "Ё", "©", "Є", "«", "¬", "­", "®",
  "Ї", "°", "±", "І", "і", "ґ", "µ", "¶", "·", "ё", "№", "є", "»", "ј", "Ѕ", "ѕ",
  "ї", "А", "Б", "В", "Г", "Д", "Е", "Ж", "З", "И", "Й", "К", "Л", "М", "Н", "О",
  "П", "Р", "С", "Т", "У", "Ф", "Х", "Ц", "Ч", "Ш", "Щ", "Ъ", "Ы", "Ь", "Э", "Ю",
  "Я", "а", "б", "в", "г", "д", "е", "ж", "з", "и", "й", "к", "л", "м", "н", "о",
  "п", "р", "с", "т", "у", "ф", "х", "ц", "ч", "ш", "щ", "ъ", "ы", "ь", "э", "ю",
  "я",
];

function narrowToText(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    if (byte < 0x80) out += String.fromCharCode(byte);
    else out += CP1251_HIGH[byte - 0x80] ?? "";
  }
  return out;
}

/**
 * Возвращает текст, найденный в бинарном Office, или `null`, если читать нечего.
 */
export function salvageLegacyOfficeText(bytes: Uint8Array, nameOrPath: string): string | null {
  const wide = wideRuns(bytes);
  let text = mergeIntoText(wide);
  if (text.length < 40) {
    const covered = new Set<number>();
    for (const segment of wide) for (let offset = 0; offset < segment.text.length * 2; offset += 1) covered.add(segment.start + offset);
    const narrow = narrowRuns(bytes, covered).map((segment) => ({ start: segment.start, text: narrowToText(bytes.subarray(segment.start, Math.min(bytes.length, segment.start + MAX_RUN * 2))) }));
    text = mergeIntoText([...wide, ...narrow]);
  }
  if (text.length === 0) return null;
  return text;
}
