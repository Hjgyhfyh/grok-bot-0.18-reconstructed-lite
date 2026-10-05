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

export function rtfEscape(text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch === "\\") out += "\\\\";
    else if (ch === "{") out += "\\{";
    else if (ch === "}") out += "\\}";
    else if ((ch.codePointAt(0) as number) < 128) out += ch;
    else {
      const code = ch.codePointAt(0) as number;
      const signed = code > 32767 ? code - 65536 : code;
      out += `\\u${signed}?`;
    }
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

/** Простой построчный конвертер: заголовки, списки, таблицы, жирный. */
export function markdownToRtf(markdown: string): string {
  let out = RTF_HEADER;
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (trimmed.trim().length === 0 || trimmed.startsWith("---")) {
      out += "\\par\n";
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading !== null) {
      const size = (heading[1] as string).length === 1 ? 30 : (heading[1] as string).length === 2 ? 26 : 24;
      out += `\\b\\fs${size} ${rtfInline(heading[2] as string)} \\b0\\fs22\\par\n`;
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
      const size = block.level === 1 ? 30 : block.level === 2 ? 26 : 24;
      out += `\\b\\fs${size} ${rtfInline(block.text)} \\b0\\fs22\\par\n`;
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
