/**
 * Markdown → RTF без внешних программ.
 *
 * Несмотря на `\ansicpg1251` в шапке, кириллица пишется как `\uN?`, а не как
 * байты cp1251: так результат не зависит от code page получателя. Знак `?` —
 * обязательный символ замены, без него Word ломает разбор.
 *
 * Таблицы в RTF — псевдотаблица: ячейки склеены через `\tab`, без `\trowd`.
 * Это осознанный компромисс — зато RTF всегда открывается. Настоящие таблицы
 * появляются только в `fill_sample`, где строка берётся из образца.
 *
 * Порт: Graphite Lite `ai/tools.rs:526-559, 561-617, 1169-1218`.
 */

import { type ReportBlock } from "./markdown-to-blocks.js";

const RTF_HEADER = "{\\rtf1\\ansi\\ansicpg1251\\deff0{\\fonttbl{\\f0 Times New Roman;}}\\f0\\fs22 ";

/**
 * Кодовая точка → последовательность `\uN?`.
 *
 * `\uN` в RTF — ЗНАКОВЫЙ 16-бит. Одно вычитание 65536 спасает только BMP:
 * всё, что выше U+FFFF, после вычитания снова больше 32767, и символ уезжает
 * в область частной области (U+1F600 → U+F600), а U+10000 превращается в
 * `\u0?`, то есть в NUL. Символы вне BMP в RTF хранятся сурогатной парой из
 * двух `\uN?` по UTF-16-единицам — читатель собирает их обратно в один символ.
 */
export function rtfUnicodeEscape(code: number): string {
  if (code > 0xffff) {
    const adjusted = code - 0x10000;
    const high = 0xd800 + (adjusted >> 10);
    const low = 0xdc00 + (adjusted & 0x3ff);
    return `\\u${high - 0x10000}?\\u${low - 0x10000}?`;
  }
  return `\\u${code > 32767 ? code - 65536 : code}?`;
}

export function rtfEscape(text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch === "\\") out += "\\\\";
    else if (ch === "{") out += "\\{";
    else if (ch === "}") out += "\\}";
    else if ((ch.codePointAt(0) as number) < 128) out += ch;
    else out += rtfUnicodeEscape(ch.codePointAt(0) as number);
  }
  return out;
}

/**
 * Переписывает в готовом документе каждый символ вне ASCII как `\uN?`.
 *
 * Нужна для образца в Windows-1251: файл приходит с байтами cp1251, читается
 * в строку, и если записать её обратно байтами UTF-8, то Word, объявивший
 * `\ansicpg1251`, прочитает их как cp1251 — то есть снова мусор. Единственная
 * запись, которая не зависит от кодовой страницы получателя, — `\uN?`.
 */
export function rtfEscapeNonAscii(source: string): string {
  let out = "";
  for (const ch of source) {
    const code = ch.codePointAt(0) as number;
    out += code < 128 ? ch : rtfUnicodeEscape(code);
  }
  return out;
}

/** Жирный внутри строки: текст режется по `**`, нечётные куски оборачиваются в `{\b ...}`. */
export function rtfInline(text: string): string {
  let out = "";
  text.split("**").forEach((part, index) => {
    if (part.length === 0) return;
    out += index % 2 === 1 ? `{\\b ${rtfEscape(part)}}` : rtfEscape(part);
  });
  return out;
}

/**
 * Заголовок целиком жирный и своего кегля.
 *
 * Жирный выражен ГРУППОЙ `{\b ...}`, а не переключателем `\b … \b0`. Иначе
 * заголовок был единственным местом в документе, где состояние начертания
 * менялось и возвращалось вручную, и расходился с тем, как тот же жирный пишется
 * в первой строке таблицы и внутри строки. DOCX и ODT тоже печатают заголовок
 * жирным — значит, все три формата обязаны выражать одно и то же одним способом.
 */
function rtfHeading(level: number, text: string): string {
  const size = level === 1 ? 30 : level === 2 ? 26 : 24;
  return `{\\b \\fs${size} ${rtfInline(text)}}\\fs22\\par\n`;
}

/** Простой построчный конвертер: заголовки, списки, таблицы, жирный. */
export function markdownToRtf(markdown: string): string {
  let out = RTF_HEADER;
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (trimmed.trim().length === 0 || trimmed.startsWith("---")) {
      out += "\\par\n";
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading !== null) {
      out += rtfHeading((heading[1] as string).length, heading[2] as string);
      continue;
    }
    if (trimmed.trimStart().startsWith("|")) {
      const cells = trimmed
        .trim()
        .replace(/^\|+/, "")
        .replace(/\|+$/, "")
        .split("|")
        .map((cell) => cell.trim());
      if (cells.every((cell) => [...cell].every((ch) => ch === "-" || ch === ":" || ch === " "))) {
        continue;
      }
      out += `${cells.map((cell) => rtfInline(cell)).join("\\tab ")}\\par\n`;
      continue;
    }
    if (trimmed.startsWith("- ")) {
      out += `${rtfEscape("• ")}${rtfInline(trimmed.slice(2))}\\par\n`;
      continue;
    }
    out += `${rtfInline(trimmed)}\\par\n`;
  }
  return `${out}}`;
}

export function blocksToRtf(blocks: readonly ReportBlock[]): string {
  let out = RTF_HEADER;
  for (const block of blocks) {
    if (block.kind === "heading") {
      out += rtfHeading(block.level, block.text);
      continue;
    }
    if (block.kind === "paragraph") {
      for (const line of block.text.split("\n")) out += `${rtfInline(line)}\\par\n`;
      continue;
    }
    if (block.kind === "bullet") {
      out += `${rtfEscape("• ")}${rtfInline(block.text)}\\par\n`;
      continue;
    }
    for (const [index, row] of block.rows.entries()) {
      const cells = row.map((cell) => (index === 0 ? `{\\b ${rtfEscape(cell)}}` : rtfEscape(cell)));
      out += `${cells.join("\\tab ")}\\par\n`;
    }
  }
  return `${out}}`;
}
