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

/** Неразрывные пробелы, которые приходят из Word и Excel, — обычные пробелы. */
const EXOTIC_SPACES = new Set(["\u00a0", "\u2007", "\u202f", "\u2009"]);

function isSpaceChar(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "" || EXOTIC_SPACES.has(char);
}

/**
 * Сколько символов текста имеет смысл собрать. В модель уходит не больше
 * `ATTACHMENT_TEXT_CHAR_LIMIT` символов, а разбор шёл до конца файла: страница
 * на 25 МБ схлопывалась целиком, хотя её первые шестьсот тысяч символов всё
 * равно никто не увидит. Потолок вчетверо больше того, что уходит в модель, и
 * для любого файла короче него результат остаётся прежним.
 */
export const PLAIN_TEXT_BUDGET = 600_000;

/**
 * Собирает текст и схлопывает пробелы за один проход, без копий строки целиком.
 *
 * Раньше схлопывание делалось цепочкой `replace` и `split`/`map`/`join`. На
 * разметке в 8 МБ это 150 МБ памяти: на каждый пробел создавался свой кусок, и
 * на странице из одних коротких слов их было пять миллионов. Здесь текст идёт
 * кусками, а сборка останавливается на потолке выше.
 */
export class PlainTextCollector {
  private readonly parts: string[] = [];
  private spaces = 0;
  private newlines = 0;
  private tabs = 0;
  private wrote = false;
  private produced = 0;

  private pushRun(run: string): void {
    if (run.length === 0 || this.produced >= PLAIN_TEXT_BUDGET) return;
    if (!this.wrote) { this.newlines = 0; this.tabs = 0; this.spaces = 0; }
    this.flush();
    this.wrote = true;
    this.produced += run.length;
    this.parts.push(run);
  }

  private flush(): void {
    if (this.tabs > 0) { this.parts.push("\t"); this.tabs = 0; }
    if (this.newlines > 0) { this.parts.push("\n".repeat(Math.min(this.newlines, 2))); this.newlines = 0; }
    if (this.spaces > 0) { this.parts.push(" "); this.spaces = 0; }
  }

  /** Текст между тегами: пробелы схлопываются, пустые строки — в одну перевод строки. */
  pushText(text: string): void {
    const length = text.length;
    let start = 0;
    let index = 0;
    while (index < length && this.produced < PLAIN_TEXT_BUDGET) {
      if (!isSpaceChar(text[index] as string)) { index += 1; continue; }
      if (index > start) this.pushRun(text.slice(start, index));
      while (index < length && isSpaceChar(text[index] as string)) {
        const char = text[index] as string;
        if (char === "\n" || char === "\r") { this.newlines += 1; this.spaces = 0; }
        else if (char === "\t") { this.tabs += 1; this.spaces = 0; }
        else if (this.wrote) this.spaces += 1;
        index += 1;
      }
      start = index;
    }
    if (start < length) this.pushRun(text.slice(start));
  }

  /** Табуляция ячейки таблицы. */
  pushTab(): void {
    this.tabs += 1;
    this.spaces = 0;
  }

  /** Перевод строки на конце абзаца. */
  pushNewline(): void {
    this.newlines += 1;
    this.spaces = 0;
  }

  /** Значение, которое можно отдать модели. */
  toString(): string {
    // Хвостовые пробелы, табуляции и переводы строки уходят, как и в прежнем
    // `.trim()` в конце цепочки `replace`.
    while (this.parts.length > 0 && /^[ \t\n]+$/.test(this.parts[this.parts.length - 1] as string)) this.parts.pop();
    if (this.parts.length === 0) return "";
    this.flush();
    return this.parts.join("");
  }
}

/**
 * Схлопывает пробелы, оставляя переносы строк. Так отчёт читается глазами.
 * Один проход вместо семи `replace` и `split`/`map`/`join`: на
 * `word/document.xml` весом 47 МБ старый вариант делал шесть копий строки и
 * массив из миллионов строк.
 */
export function tidyExtractedText(text: string): string {
  const collector = new PlainTextCollector();
  collector.pushText(text);
  return collector.toString();
}/**
 * Сколько байт части имеет смысл декодировать в строку. В модель уходит не больше
 * `ATTACHMENT_TEXT_CHAR_LIMIT` символов, а `word/document.xml` на 47 МБ
 * декодировался целиком: строка в 47 миллионов символов и ещё шесть её копий.
 * Восемь мегабайт разметки дают больше миллиона символов текста — заведомо
 * больше потолка, поэтому текст от этого не теряется.
 */
export const XML_DECODE_BUDGET = 8 * 1024 * 1024;

/** Декодирует часть архива в строку, не разрывая многобайтовый символ на границе. */
export function decodeXmlPart(data: Uint8Array): string {
  const decoder = new TextDecoder();
  if (data.byteLength <= XML_DECODE_BUDGET) return decoder.decode(data);
  let cut = XML_DECODE_BUDGET;
  // Отступаем назад, пока не найдём начало последовательности UTF-8.
  while (cut > 0 && (data[cut] as number) >= 0x80 && ((data[cut] as number) & 0xc0) === 0x80) cut -= 1;
  return decoder.decode(data.subarray(0, cut));
}