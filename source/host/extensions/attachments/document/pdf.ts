/**
 * Текст из PDF — свой разбор на `node:zlib`.
 *
 * Почему не `pdfjs-dist`, который есть в зависимостях: хост собирается esbuild
 * в один CJS-файл, а `pdfjs-dist` тянет worker, ESM-динамические импорты и
 * около трёх мегабайт. Проверить это вживую сейчас нельзя — окно приложения
 * не создаётся, — а ломать рабочую сборку ради одного формата нельзя.
 *
 * Что покрыто: цифровые PDF, потоки `FlateDecode` и `ASCIIHexDecode`, объекты,
 * упакованные в `/ObjStm`, простые шрифты с `/ToUnicode` и `/WinAnsiEncoding`,
 * составные шрифты `Identity-H`. Чего нет: шифрование (RC4/AES) и LZW. Оба
 * случая возвращаются честным отказом, а не мусором.
 */

import { inflateSync } from "node:zlib";

const LATIN1 = "latin1";
const MAX_INFLATED_BYTES = 96 * 1024 * 1024;
const MAX_PAGES = 2_000;
const MAX_OBJECTS = 200_000;

export class PdfTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfTextError";
  }
}

interface PdfObject {
  readonly num: number;
  readonly dict: string;
  readonly stream: Uint8Array | null;
}

export interface PdfTextResult {
  readonly text: string;
  readonly pageCount: number;
  readonly encrypted: boolean;
}

// ───────────────────────── разбор структуры ─────────────────────────

function toLatin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(LATIN1);
}

/**
 * Значение ключа словаря PDF. Ссылка, имя, массив, вложенный словарь или
 * число. Раньше значение искалось регуляркой «всё до следующего слэша», и
 * `/Contents 4 0 R` читалось как пустая строка — содержимое страницы
 * терялось целиком.
 */
type PdfValue =
  | { readonly kind: "ref"; readonly ref: number }
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "array"; readonly items: readonly string[] }
  | { readonly kind: "dict"; readonly body: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "none" };

const VALUE_PATTERN = "(\\d+)\\s+(\\d+)\\s+R|\\[([^\\]]*)\\]|<<([\\s\\S]*?)>>|\\/([^\\s/\\[\\]<>(){}]+)|(-?\\d+(?:\\.\\d+)?)";

function lookup(dict: string, key: string): PdfValue {
  const match = new RegExp(`\\/${key}\\s*(?:${VALUE_PATTERN})`).exec(dict);
  if (match == null) return { kind: "none" };
  if (match[1] != null) return { kind: "ref", ref: Number.parseInt(match[1], 10) };
  if (match[3] != null) return { kind: "array", items: (match[3] ?? "").match(/\d+\s+\d+\s+R/g) ?? [] };
  if (match[4] != null) return { kind: "dict", body: match[4] };
  if (match[5] != null) return { kind: "name", name: match[5] };
  return { kind: "number", value: Number.parseFloat(match[6] ?? "0") };
}

function refOf(value: PdfValue): number | null {
  return value.kind === "ref" ? value.ref : null;
}

function dictValue(dict: string, key: string): string | undefined {
  const value = lookup(dict, key);
  if (value.kind === "number") return String(value.value);
  if (value.kind === "name") return value.name;
  return undefined;
}

function isReference(value: string | undefined): number | null {
  if (value == null) return null;
  const match = /^(\d+)\s+\d+\s+R$/.exec(value.trim());
  return match == null ? null : Number.parseInt(match[1] as string, 10);
}

function arrayRefs(dict: string, key: string): number[] {
  const value = lookup(dict, key);
  return value.kind === "array" ? value.items.map((item) => Number.parseInt(/^(\d+)/.exec(item)?.[1] ?? "0", 10)) : [];
}

function scanObjects(source: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const pattern = /(?:^|[\s>])(\d+)\s+(\d+)\s+obj\b/g;
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) != null) {
    if (++count > MAX_OBJECTS) break;
    const num = Number.parseInt(match[1] as string, 10);
    const bodyStart = match.index + match[0].length;
    const endIndex = source.indexOf("endobj", bodyStart);
    const bodyEnd = endIndex < 0 ? Math.min(source.length, bodyStart + 4 * 1024 * 1024) : endIndex;
    const body = source.slice(bodyStart, bodyEnd);
    const streamStart = findStreamStart(body);
    if (streamStart == null) {
      if (!objects.has(num)) objects.set(num, { num, dict: body, stream: null });
      continue;
    }
    const dict = body.slice(0, streamStart.dictEnd);
    const stream = sliceStream(body, streamStart.dataStart, dict);
    if (!objects.has(num)) objects.set(num, { num, dict, stream });
    pattern.lastIndex = bodyEnd;
  }
  return objects;
}

function findStreamStart(body: string): { readonly dictEnd: number; readonly dataStart: number } | null {
  const match = /stream\r\n|stream\n|stream\r/.exec(body);
  if (match == null) return null;
  return { dictEnd: match.index, dataStart: match.index + match[0].length };
}

function sliceStream(body: string, dataStart: number, dict: string): Uint8Array {
  const buffer = Buffer.from(body, LATIN1);
  const declared = Number.parseInt(dictValue(dict, "Length") ?? "", 10);
  if (Number.isFinite(declared) && declared > 0 && dataStart + declared <= buffer.byteLength) {
    return new Uint8Array(buffer.subarray(dataStart, dataStart + declared));
  }
  const endIndex = body.indexOf("endstream", dataStart);
  const stop = endIndex < 0 ? buffer.byteLength : endIndex;
  let end = stop;
  while (end > dataStart && (buffer[end - 1] === 0x0a || buffer[end - 1] === 0x0d)) end -= 1;
  return new Uint8Array(buffer.subarray(dataStart, end));
}

function filterNamesOf(dict: string): string[] {
  const single = /\/Filter\s*\/(\w+)/.exec(dict);
  if (single != null) return [single[1] as string];
  const list = /\/Filter\s*\[([^\]]*)\]/.exec(dict);
  if (list == null) return [];
  return [...(list[1] ?? "").matchAll(/\/(\w+)/g)].map((entry) => entry[1] as string);
}

function decodeStream(dict: string, raw: Uint8Array): Uint8Array | null {
  const filters = filterNamesOf(dict);
  if (filters.length === 0) return raw;
  let data = raw;
  for (const filter of filters) {
    if (filter === "FlateDecode" || filter === "Fl") {
      try {
        data = new Uint8Array(inflateSync(Buffer.from(data), { maxOutputLength: MAX_INFLATED_BYTES }));
      } catch (error) {
        // Поток может быть обрезан последней страницей — пробуем мягкую распаковку.
        try { data = new Uint8Array(inflateSync(Buffer.from(data), { finishFlush: 2 /* Z_SYNC_FLUSH */, maxOutputLength: MAX_INFLATED_BYTES })); }
        catch { return error instanceof Error ? null : null; }
      }
      continue;
    }
    if (filter === "ASCIIHexDecode" || filter === "AHx") {
      const hex = toLatin1(data).replace(/[^0-9A-Fa-f]/g, "");
      const even = hex.length - (hex.length % 2);
      const out = new Uint8Array(even / 2);
      for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
      data = out;
      continue;
    }
    if (filter === "ASCII85Decode" || filter === "A85") { data = decodeAscii85(data); continue; }
    return null;
  }
  return data;
}

function decodeAscii85(raw: Uint8Array): Uint8Array {
  const source = toLatin1(raw);
  const out: number[] = [];
  let tuple = 0;
  let count = 0;
  for (const char of source) {
    if (char === "~") break;
    if (char === "z" && count === 0) { out.push(0, 0, 0, 0); continue; }
    if (char === " " || char === "\n" || char === "\r" || char === "\t") continue;
    const value = char.charCodeAt(0) - 33;
    if (value < 0 || value > 84) continue;
    tuple = tuple * 85 + value;
    count += 1;
    if (count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    for (let index = count; index < 5; index += 1) tuple = tuple * 85 + 84;
    const bytes = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
    for (let index = 0; index < count - 1; index += 1) out.push(bytes[index] as number);
  }
  return new Uint8Array(out);
}

/** Объекты внутри `/ObjStm` — в PDF 1.5+ они не лежат в файле открытым текстом. */
function expandObjectStreams(objects: Map<number, PdfObject>): void {
  for (const object of [...objects.values()]) {
    if (object.stream == null) continue;
    if (!/\/Type\s*\/ObjStm/.test(object.dict)) continue;
    const data = decodeStream(object.dict, object.stream);
    if (data == null) continue;
    const count = Number.parseInt(dictValue(object.dict, "N") ?? "", 10);
    const first = Number.parseInt(dictValue(object.dict, "First") ?? "", 10);
    if (!Number.isFinite(count) || !Number.isFinite(first)) continue;
    const source = toLatin1(data);
    const header = source.slice(0, Math.min(first, source.length));
    const numbers = [...header.matchAll(/(\d+)\s+(\d+)/g)].slice(0, count);
    for (const [index, entry] of numbers.entries()) {
      const num = Number.parseInt(entry[1] as string, 10);
      const offset = Number.parseInt(entry[2] as string, 10);
      if (objects.has(num)) continue;
      const start = first + offset;
      if (start >= source.length) continue;
      const rest = source.slice(start);
      const end = rest.search(/\s+endobj|[\r\n]/);
      const body = end < 0 ? rest : rest.slice(0, end);
      objects.set(num, { num, dict: body, stream: null });
      void index;
    }
  }
}

// ───────────────────────── шрифты ─────────────────────────

type CMap = Map<number, string>;

function parseCMap(source: string): CMap {
  const map: CMap = new Map();
  const hex = /<([0-9A-Fa-f]+)>/g;
  const charBlock = /beginbfchar([\s\S]*?)endbfchar/g;
  let block: RegExpExecArray | null;
  while ((block = charBlock.exec(source)) != null) {
    hex.lastIndex = 0;
    const pairs = [...(block[1] ?? "").matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)];
    for (const pair of pairs) {
      const code = Number.parseInt(pair[1] as string, 16);
      map.set(code, utf16beHex(pair[2] as string));
    }
  }
  const rangeBlock = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((block = rangeBlock.exec(source)) != null) {
    const body = block[1] ?? "";
    const triple = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g;
    const pair = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g;
    let entry: RegExpExecArray | null;
    while ((entry = triple.exec(body)) != null) {
      const low = Number.parseInt(entry[1] as string, 16);
      const high = Number.parseInt(entry[2] as string, 16);
      const start = Number.parseInt((entry[3] as string).slice(0, 4) || "0", 16);
      const width = (entry[3] as string).length;
      for (let code = low; code <= high && code - low < 65_536; code += 1) {
        map.set(code, utf16beHex((start + (code - low)).toString(16).padStart(width, "0")));
      }
    }
    while ((entry = pair.exec(body)) != null) {
      const low = Number.parseInt(entry[1] as string, 16);
      const high = Number.parseInt(entry[2] as string, 16);
      const items = [...(entry[3] ?? "").matchAll(/<([0-9A-Fa-f]*)>/g)];
      for (const [index, item] of items.entries()) {
        if (low + index > high) break;
        map.set(low + index, utf16beHex(item[1] as string));
      }
    }
  }
  return map;
}

function utf16beHex(hex: string): string {
  if (hex.length === 0) return "";
  let out = "";
  for (let index = 0; index + 4 <= hex.length; index += 4) {
    out += String.fromCharCode(Number.parseInt(hex.slice(index, index + 4), 16));
  }
  if (hex.length % 4 === 2) out += String.fromCharCode(Number.parseInt(hex.slice(-2), 16));
  return out;
}

interface PdfFont {
  readonly twoByte: boolean;
  readonly map: CMap | null;
}

const WIN1252_HIGH: Readonly<Record<number, string>> = {
  128: "€", 130: "‚", 131: "ƒ", 132: "„", 133: "…", 134: "†", 135: "‡", 136: "ˆ", 137: "‰",
  138: "Š", 139: "‹", 140: "Œ", 142: "Ž", 145: "‘", 146: "’", 147: "“", 148: "”", 149: "•",
  150: "–", 151: "—", 152: "˜", 153: "™", 154: "š", 155: "›", 156: "œ", 158: "ž", 159: "Ÿ",
};

function resolveFont(objects: Map<number, PdfObject>, value: string | undefined, cache: Map<number, PdfFont>): PdfFont | null {
  const reference = isReference(value);
  if (reference == null) return null;
  const cached = cache.get(reference);
  if (cached != null) return cached;
  const object = objects.get(reference);
  if (object == null) return null;
  const twoByte = /\/Subtype\s*\/Type0/.test(object.dict);
  let map: CMap | null = null;
  const toUnicode = refOf(lookup(object.dict, "ToUnicode"));
  const toUnicodeObject = toUnicode == null ? undefined : objects.get(toUnicode);
  if (toUnicodeObject?.stream != null) {
    const decoded = decodeStream(toUnicodeObject.dict, toUnicodeObject.stream);
    if (decoded != null) map = parseCMap(toLatin1(decoded));
  }
  const font: PdfFont = { twoByte, map };
  cache.set(reference, font);
  return font;
}

function fontsOf(objects: Map<number, PdfObject>, resources: string): Map<string, string> {
  const fonts = new Map<string, string>();
  const fontRef = refOf(lookup(resources, "Font"));
  const fontDict = fontRef == null ? resources : (objects.get(fontRef)?.dict ?? "");
  const inline = /\/Font\s*<<([\s\S]*?)>>/.exec(resources);
  const body = inline == null ? fontDict : `<<${inline[1] ?? ""}>>`;
  for (const entry of body.matchAll(/\/([^\s/]+)\s+(\d+\s+\d+\s+R)/g)) fonts.set(entry[1] as string, entry[2] as string);
  return fonts;
}

// ───────────────────────── содержимое страницы ─────────────────────────

type Operand = { readonly kind: "string"; readonly bytes: number[] } | { readonly kind: "number"; readonly value: number } | { readonly kind: "name"; readonly value: string } | { readonly kind: "array"; readonly items: Operand[] } | { readonly kind: "other" };

function tokenizeContent(source: string): { operands: Operand[]; operator: string }[] {
  const out: { operands: Operand[]; operator: string }[] = [];
  const operands: Operand[] = [];
  let index = 0;
  const length = source.length;
  while (index < length) {
    const char = source[index] as string;
    if (char === "(") {
      const bytes: number[] = [];
      let depth = 1;
      index += 1;
      while (index < length && depth > 0) {
        const inner = source[index] as string;
        if (inner === "\\") {
          const next = source[index + 1];
          const code = source.charCodeAt(index + 1);
          if (next === "n") bytes.push(10);
          else if (next === "r") bytes.push(13);
          else if (next === "t") bytes.push(9);
          else if (next === "b") bytes.push(8);
          else if (next === "f") bytes.push(12);
          else if (next !== undefined && code >= 0x30 && code <= 0x37) {
            const octal = /^[0-7]{1,3}/.exec(source.slice(index + 1, index + 4))?.[0] ?? "0";
            bytes.push(Number.parseInt(octal, 8) & 0xff);
            index += octal.length;
          } else if (code < 256) bytes.push(code);
          index += 2;
          continue;
        }
        if (inner === "(") depth += 1;
        else if (inner === ")") { depth -= 1; if (depth === 0) { index += 1; break; } }
        bytes.push(source.charCodeAt(index));
        index += 1;
      }
      operands.push({ kind: "string", bytes });
      continue;
    }
    if (char === "<" && source[index + 1] !== "<") {
      const end = source.indexOf(">", index);
      const hex = source.slice(index + 1, end < 0 ? length : end).replace(/[^0-9A-Fa-f]/g, "");
      const even = hex.length - (hex.length % 2);
      const bytes: number[] = [];
      for (let position = 0; position < even; position += 2) bytes.push(Number.parseInt(hex.slice(position, position + 2), 16));
      operands.push({ kind: "string", bytes });
      index = end < 0 ? length : end + 1;
      continue;
    }
    if (char === "/") {
      const match = /\/([^\s/[\]<>(){}%]*)/.exec(source.slice(index));
      operands.push({ kind: "name", value: match?.[1] ?? "" });
      index += match?.[0].length ?? 1;
      continue;
    }
    if (char === "[") {
      const items: Operand[] = [];
      let depth = 1;
      index += 1;
      let inner = "";
      while (index < length && depth > 0) {
        const nested = source[index] as string;
        if (nested === "\\") { inner += nested + (source[index + 1] ?? ""); index += 2; continue; }
        if (nested === "[") depth += 1;
        else if (nested === "]") { depth -= 1; if (depth === 0) { index += 1; break; } }
        inner += nested;
        index += 1;
      }
      const nestedTokens = tokenizeContent(inner);
      for (const token of nestedTokens) for (const operand of token.operands) items.push(operand);
      operands.push({ kind: "array", items });
      continue;
    }
    if (char === "<" || char === ">" || char === "{" || char === "}") { index += 1; continue; }
    const token = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(source.slice(index));
    if (token != null) {
      operands.push({ kind: "number", value: Number.parseFloat(token[0]) });
      index += token[0].length;
      continue;
    }
    const name = /^[A-Za-z'"*][A-Za-z0-9'"*]*/.exec(source.slice(index));
    if (name != null) {
      // Копия, а не сам массив: `operands` общий и обнуляется на каждом операторе.
      out.push({ operands: operands.slice(), operator: name[0] });
      operands.length = 0;
      index += name[0].length;
      continue;
    }
    index += 1;
  }
  return out;
}

function applyFont(bytes: number[], font: PdfFont | null): string {
  if (bytes.length === 0) return "";
  const step = font?.twoByte === true ? 2 : 1;
  let out = "";
  for (let index = 0; index < bytes.length; index += step) {
    const code = step === 2 ? ((bytes[index] as number) << 8) | (bytes[index + 1] ?? 0) : (bytes[index] as number);
    const mapped = font?.map?.get(code);
    if (mapped != null) { out += mapped; continue; }
    if (step === 1) {
      if (code >= 32 && code < 127) out += String.fromCharCode(code);
      else if (code >= 0xa0) out += WIN1252_HIGH[code] ?? String.fromCharCode(code);
      else if (code === 9 || code === 10 || code === 13) out += "\n";
    } else if (code === 32) out += " ";
  }
  return out;
}

function extractPageText(content: string, fonts: Map<string, string>, objects: Map<number, PdfObject>, cache: Map<number, PdfFont>): string {
  let out = "";
  let current: PdfFont | null = null;
  const lineHasText = { value: false };
  const breakLine = (): void => {
    if (!lineHasText.value) return;
    out += "\n";
    lineHasText.value = false;
  };
  const show = (operand: Operand | undefined): void => {
    if (operand == null || operand.kind !== "string") return;
    const text = applyFont(operand.bytes, current);
    if (text.length === 0) return;
    if (!lineHasText.value) { lineHasText.value = true; }
    out += text;
  };
  for (const token of tokenizeContent(content)) {
    const { operator, operands } = token;
    if (operator === "Tf") {
      const name = operands.length >= 2 && operands[operands.length - 2]?.kind === "name" ? (operands[operands.length - 2] as { value: string }).value : undefined;
      const reference = name == null ? undefined : fonts.get(name);
      current = reference == null ? null : resolveFont(objects, reference, cache);
      continue;
    }
    if (operator === "Tj" || operator === "'" || operator === "\"") {
      if (operator !== "Tj") breakLine();
      show(operands.at(-1));
      continue;
    }
    if (operator === "TJ") {
      const array = operands.at(-1);
      if (array == null || array.kind !== "array") continue;
      for (const item of array.items) {
        if (item.kind === "string") show(item);
        else if (item.kind === "number" && item.value <= -120) { if (lineHasText.value && !out.endsWith(" ")) out += " "; }
      }
      continue;
    }
    if (operator === "Td" || operator === "TD" || operator === "T*" || operator === "ET" || operator === "BT") { breakLine(); continue; }
  }
  return out;
}

// ───────────────────────── точка входа ─────────────────────────

export function pdfBytesToText(bytes: Uint8Array): PdfTextResult {
  const source = toLatin1(bytes);
  if (!source.startsWith("%PDF")) throw new PdfTextError("Файл не начинается с %PDF — это не PDF.");
  if (/\/Encrypt\b/.test(source)) return { text: "", pageCount: 0, encrypted: true };
  const objects = scanObjects(source);
  expandObjectStreams(objects);
  const fontCache = new Map<number, PdfFont>();
  const pages = [...objects.values()].filter((object) => /\/Type\s*\/Page\b/.test(object.dict) && !/\/Type\s*\/Pages\b/.test(object.dict));
  const texts: string[] = [];
  let pageCount = 0;
  for (const page of pages.slice(0, MAX_PAGES)) {
    const contents = pageContentsOf(page, objects);
    if (contents.length === 0) continue;
    pageCount += 1;
    const resources = resolveResources(objects, lookup(page.dict, "Resources"));
    const fonts = fontsOf(objects, resources);
    const content = contents.map((part) => decodeStream(part.dict, part.stream ?? new Uint8Array()) ?? new Uint8Array()).map((part) => toLatin1(part)).join("\n");
    if (content.length === 0) continue;
    const text = extractPageText(content, fonts, objects, fontCache).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length > 0) texts.push(text);
  }
  return { text: texts.join("\n\n").trim(), pageCount, encrypted: false };
}

/** `/Resources` бывает и словарём на месте, и ссылкой на отдельный объект. */
function resolveResources(objects: Map<number, PdfObject>, value: PdfValue): string {
  if (value.kind === "dict") return `<<${value.body}>>`;
  if (value.kind === "ref") return objects.get(value.ref)?.dict ?? "";
  if (value.kind === "name") return value.name;
  return "";
}

function pageContentsOf(page: PdfObject, objects: Map<number, PdfObject>): PdfObject[] {
  const direct = refOf(lookup(page.dict, "Contents"));
  if (direct != null) {
    const object = objects.get(direct);
    return object == null ? [] : [object];
  }
  return arrayRefs(page.dict, "Contents")
    .map((num) => objects.get(num))
    .filter((object): object is PdfObject => object != null);
}
