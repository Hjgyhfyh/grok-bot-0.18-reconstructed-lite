/**
 * Разбор XML без DOM.
 *
 * `word/document.xml` и `content.xml` весят сотни килобайт, а в проекте нет ни
 * DOM-парсера, ни XML-библиотеки. Здесь маленький сканер: он выдаёт открывающие,
 * закрывающие, самозамкнутые теги и текст между ними. Этого хватает, чтобы
 * вытащить абзацы, ячейки таблиц и строки листов.
 */

export type XmlToken =
  | { readonly kind: "open"; readonly name: string; readonly attrs: ReadonlyMap<string, string> }
  | { readonly kind: "close"; readonly name: string }
  | { readonly kind: "empty"; readonly name: string; readonly attrs: ReadonlyMap<string, string> }
  | { readonly kind: "text"; readonly value: string };

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[-A-Za-z0-9_:.]/;
const WHITESPACE = /\s/;

export function decodeXmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code: string) => safeCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => safeCodePoint(Number.parseInt(code, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(value: number): string {
  return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
}

function parseAttributes(source: string): ReadonlyMap<string, string> {
  const attrs = new Map<string, string>();
  let index = 0;
  while (index < source.length) {
    while (index < source.length && WHITESPACE.test(source[index] as string)) index += 1;
    if (index >= source.length || source[index] === "/") break;
    const nameStart = index;
    while (index < source.length && source[index] !== "=" && !WHITESPACE.test(source[index] as string)) index += 1;
    const name = source.slice(nameStart, index);
    if (name.length === 0) { index += 1; continue; }
    while (index < source.length && WHITESPACE.test(source[index] as string)) index += 1;
    if (source[index] !== "=") { attrs.set(name, ""); continue; }
    index += 1;
    while (index < source.length && WHITESPACE.test(source[index] as string)) index += 1;
    const quote = source[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      const valueStart = index;
      while (index < source.length && source[index] !== quote) index += 1;
      attrs.set(name, decodeXmlEntities(source.slice(valueStart, index)));
      index += 1;
      continue;
    }
    const valueStart = index;
    while (index < source.length && !WHITESPACE.test(source[index] as string) && source[index] !== ">") index += 1;
    attrs.set(name, decodeXmlEntities(source.slice(valueStart, index)));
  }
  return attrs;
}

export function* scanXml(xml: string): Generator<XmlToken> {
  let index = 0;
  let textStart = 0;
  while (index < xml.length) {
    const next = xml.indexOf("<", index);
    if (next < 0) break;
    if (next > textStart) yield { kind: "text", value: decodeXmlEntities(xml.slice(textStart, next)) };
    if (xml.startsWith("<!--", next)) {
      const end = xml.indexOf("-->", next);
      index = end < 0 ? xml.length : end + 3;
      textStart = index;
      continue;
    }
    if (xml.startsWith("<![CDATA[", next)) {
      const end = xml.indexOf("]]>", next);
      const value = xml.slice(next + 9, end < 0 ? xml.length : end);
      yield { kind: "text", value };
      index = end < 0 ? xml.length : end + 3;
      textStart = index;
      continue;
    }
    if (xml.startsWith("<?", next) || xml.startsWith("<!", next)) {
      const end = xml.indexOf(">", next);
      index = end < 0 ? xml.length : end + 1;
      textStart = index;
      continue;
    }
    index = next + 1;
    const closing = xml[index] === "/";
    if (closing) index += 1;
    if (index >= xml.length || !NAME_START.test(xml[index] as string)) { textStart = next + 1; index = textStart; continue; }
    const nameStart = index;
    while (index < xml.length && NAME_CHAR.test(xml[index] as string)) index += 1;
    const name = xml.slice(nameStart, index);
    const attrStart = index;
    while (index < xml.length && xml[index] !== ">") index += 1;
    const attrSource = xml.slice(attrStart, index);
    const selfClosing = attrSource.trimEnd().endsWith("/");
    const attrs = parseAttributes(selfClosing ? attrSource.trimEnd().slice(0, -1) : attrSource);
    index = index < xml.length ? index + 1 : xml.length;
    if (closing) yield { kind: "close", name };
    else if (selfClosing) yield { kind: "empty", name, attrs };
    else yield { kind: "open", name, attrs };
    textStart = index;
  }
  if (textStart < xml.length) yield { kind: "text", value: decodeXmlEntities(xml.slice(textStart)) };
}

/** Схлопывает пробелы, оставляя переносы строк. Так отчёт читается глазами. */
export function tidyExtractedText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[   ]/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\t{2,}/g, "\t")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}
