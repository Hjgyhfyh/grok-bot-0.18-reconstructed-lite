/**
 * Текст из офисных форматов на zip: `.docx`, `.odt`, `.ods`, `.odp`, `.xlsx`.
 *
 * Все три — это zip с XML внутри. Разбор свой, на `scanXml`: в проекте нет ни
 * DOM, ни XML-библиотеки, а вставлять их ради одного `.docx` нельзя — сборка
 * идёт из исходников и лишние мегабайты в бандл не нужны.
 */

import { decodeXmlPart, scanXml, tidyExtractedText, type XmlToken } from "./xml.js";
import {
  guardedZipEntryNames,
  planGuardedZipEntries,
  readGuardedZipEntriesByName,
  readGuardedZipEntry,
  type ZipReadLimits,
  type GuardedZipEntry,
  type GuardedZipPlan,
} from "./zip-reader.js";


/** Части Word, из которых собирается читаемый текст. Порядок имеет смысл. */
const DOCX_PARTS = [
  "word/document.xml",
  "word/footnotes.xml",
  "word/endnotes.xml",
  "word/comments.xml",
  "word/header1.xml",
  "word/header2.xml",
  "word/header3.xml",
  "word/footer1.xml",
  "word/footer2.xml",
  "word/footer3.xml",
];

const DOCX_SKIP_ELEMENTS = new Set(["w:instrText", "w:delText", "w:proofErr", "w:del", "w:pPr", "w:rPr", "w:sectPr", "w:tblPr", "w:trPr", "w:tcPr"]);

export class DocumentParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentParseError";
  }
}

// ───────────────────────────── DOCX ─────────────────────────────

/**
 * `word/document.xml` → текст. `w:p` даёт перенос строки, `w:tc` — табуляцию,
 * поэтому таблица читается как таблица, а не как каша.
 */
export function docxXmlToText(xml: string): string {
  let out = "";
  let depth = 0;
  let skipName: string | null = null;
  let skipDepthValue = -1;
  // Глубина, на которой открылась ближайшая ячейка таблицы. Внутри ячейки
  // абзацы не разделяются переносом: иначе строка таблицы распадается на
  // по одной ячейке на строку, и свести четыре файла в один отчёт не выйдет.
  let cellDepthValue = -1;
  for (const token of scanXml(xml)) {
    if (token.kind === "text") {
      if (skipName == null) out += token.value;
      continue;
    }
    if (token.kind === "open") {
      depth += 1;
      if (skipName == null && DOCX_SKIP_ELEMENTS.has(token.name)) { skipName = token.name; skipDepthValue = depth; }
      if (token.name === "w:tc") cellDepthValue = depth;
      continue;
    }
    if (token.kind === "empty") {
      if (token.name === "w:tab") out += "\t";
      else if (token.name === "w:br" || token.name === "w:cr") out += "\n";
      else if (token.name === "w:noBreakHyphen") out += "-";
      continue;
    }
    depth -= 1;
    if (skipName != null) {
      if (depth < skipDepthValue) skipName = null;
      continue;
    }
    if (token.name === "w:p") { if (cellDepthValue < 0) out += "\n"; }
    else if (token.name === "w:tc") { out += "\t"; cellDepthValue = -1; }
    else if (token.name === "w:tr") out += "\n";
  }
  return tidyExtractedText(out);
}

export function docxZipToText(bytes: Uint8Array, limits?: ZipReadLimits): string {
  const plan = planGuardedZipEntries(bytes, limits);
  if (findGuardedZipEntryName(plan, "word/document.xml") == null) {
    throw new DocumentParseError("В документе Word нет части word/document.xml.");
  }
  // Распаковываются только части с текстом. Фотография на 40 МБ внутри документа
  // текста не даёт, а раньше она распаковывалась целиком и стоила столько же
  // памяти, сколько весь документ.
  const parts = readGuardedZipEntriesByName(plan, DOCX_PARTS);
  const chunks: string[] = [];
  for (const entry of parts) {
    const text = docxXmlToText(decodeXmlPart(entry.data));
    if (text.length > 0) chunks.push(text);
  }
  return tidyExtractedText(chunks.join("\n\n"));
}

function findGuardedZipEntryName(plan: GuardedZipPlan, name: string): GuardedZipPlan["entries"][number] | null {
  return plan.entries.find((entry) => entry.name === name) ?? null;
}

// ───────────────────────────── ODT ─────────────────────────────

const ODT_SKIP_ELEMENTS = new Set(["office:annotation", "text:note", "text:tracked-changes", "text:changed-region"]);

/** `content.xml` → текст. `text:p` и `text:h` — абзац, `table:table-cell` — табуляция. */
export function odtXmlToText(xml: string): string {
  let out = "";
  let depth = 0;
  let skipName: string | null = null;
  let skipDepthValue = -1;
  // Как и в docx: внутри ячейки абзацы не разделяются переносом, иначе строка
  // таблицы рассыпается на по одной ячейке на строку.
  let cellDepthValue = -1;
  for (const token of scanXml(xml)) {
    if (token.kind === "text") {
      if (skipName == null) out += token.value;
      continue;
    }
    if (token.kind === "open") {
      depth += 1;
      if (skipName == null && ODT_SKIP_ELEMENTS.has(token.name)) { skipName = token.name; skipDepthValue = depth; }
      if (token.name === "table:table-cell") cellDepthValue = depth;
      continue;
    }
    if (token.kind === "empty") {
      if (skipName != null) continue;
      if (token.name === "text:tab") out += "\t";
      else if (token.name === "text:line-break" || token.name === "text:soft-page-break") out += "\n";
      else if (token.name === "text:s") out += " ".repeat(clampRepeat(token.attrs.get("text:c")));
      continue;
    }
    depth -= 1;
    if (skipName != null) {
      if (depth < skipDepthValue) skipName = null;
      continue;
    }
    if (token.name === "text:p" || token.name === "text:h") { if (cellDepthValue < 0) out += "\n"; }
    else if (token.name === "table:table-cell") { out += "\t"; cellDepthValue = -1; }
    else if (token.name === "table:table-row") out += "\n";
  }
  return tidyExtractedText(out);
}

function clampRepeat(raw: string | undefined): number {
  const value = Number.parseInt(raw ?? "1", 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 200) : 1;
}

export function odtZipToText(bytes: Uint8Array, limits?: ZipReadLimits): string {
  const plan = planGuardedZipEntries(bytes, limits);
  const [content] = readGuardedZipEntriesByName(plan, ["content.xml"]);
  if (content == null) throw new DocumentParseError("В документе LibreOffice нет части content.xml.");
  const text = odtXmlToText(decodeXmlPart(content.data));
  if (text.length === 0) {
    const [spreadsheet] = readGuardedZipEntriesByName(plan, ["Object 1/content.xml"]);
    if (spreadsheet != null) return tidyExtractedText(odtXmlToText(decodeXmlPart(spreadsheet.data)));
  }
  return text;
}

// ───────────────────────────── XLSX ─────────────────────────────

function sharedStringsOf(plan: GuardedZipPlan): string[] {
  const [part] = readGuardedZipEntriesByName(plan, ["xl/sharedStrings.xml"]);
  if (part == null) return [];
  const strings: string[] = [];
  let current = "";
  let inside = false;
  for (const token of scanXml(decodeXmlPart(part.data))) {
    if (token.kind === "open" && token.name === "si") { inside = true; current = ""; continue; }
    if (token.kind === "close" && token.name === "si") { strings.push(current); inside = false; continue; }
    if (!inside) continue;
    if (token.kind === "open" && token.name === "rPh") continue;
    if (token.kind === "text") current += token.value;
  }
  return strings;
}

function sheetNamesOf(plan: GuardedZipPlan): string[] {
  const [part] = readGuardedZipEntriesByName(plan, ["xl/workbook.xml"]);
  if (part == null) return [];
  const names: string[] = [];
  for (const token of scanXml(decodeXmlPart(part.data))) {
    if (token.kind === "empty" && token.name === "sheet") {
      const name = token.attrs.get("name");
      if (name != null) names.push(name);
    }
  }
  return names;
}

function columnIndexOf(reference: string | undefined): number {
  if (reference == null) return -1;
  let index = 0;
  for (const char of reference) {
    const upper = char.toUpperCase();
    if (upper < "A" || upper > "Z") break;
    index = index * 26 + (upper.charCodeAt(0) - 64);
  }
  return index - 1;
}

function sheetXmlToRows(xml: string, shared: readonly string[]): string[] {
  const rows: string[] = [];
  let cells: string[] = [];
  let column = -1;
  let cell: { kind: string; inline: string } | null = null;
  let inlineDepth = 0;
  const push = (): void => {
    const current: { kind: string; inline: string } | null = cell;
    cell = null;
    if (current == null) return;
    const value = current.kind === "s" ? (shared[Number.parseInt(current.inline, 10)] ?? "") : current.inline;
    cells[column] = value;
  };
  for (const token of scanXml(xml)) {
    if (token.kind === "open" && token.name === "row") {
      cells = [];
      column = -1;
      inlineDepth = 0;
      continue;
    }
    if (token.kind === "close" && token.name === "row") {
      push();
      const line = trimRow(cells).join("\t");
      if (line.length > 0) rows.push(line);
      continue;
    }
    if (token.kind === "empty" && token.name === "c") { continue; }
    if (token.kind === "open" && token.name === "c") {
      const reference = token.attrs.get("r");
      const parsed = columnIndexOf(reference);
      column = parsed >= 0 ? parsed : column + 1;
      cell = { kind: token.attrs.get("t") ?? "n", inline: "" };
      continue;
    }
    if (token.kind === "close" && token.name === "c") { push(); continue; }
    if (cell == null) continue;
    if (token.kind === "open" && token.name === "is") { inlineDepth += 1; continue; }
    if (token.kind === "close" && token.name === "is") { inlineDepth -= 1; continue; }
    if (token.kind === "text") {
      if (cell.kind === "inlineStr" || inlineDepth > 0) cell.inline += token.value;
      else cell.inline += token.value;
    }
  }
  return rows;
}

function trimRow(cells: readonly string[]): string[] {
  let end = cells.length;
  while (end > 0 && (cells[end - 1] ?? "").trim().length === 0) end -= 1;
  const out: string[] = [];
  for (let index = 0; index < end; index += 1) out.push((cells[index] ?? "").replace(/\s+/g, " ").trim());
  return out;
}

export function xlsxZipToText(bytes: Uint8Array, limits?: ZipReadLimits): string {
  const plan = planGuardedZipEntries(bytes, limits);
  const shared = sharedStringsOf(plan);
  const names = sheetNamesOf(plan);
  // Листы распаковываются по одному: книга на 40 МБ не должна целиком лежать в
  // памяти только затем, чтобы из неё вытащили текст.
  const sheetNames = guardedZipEntryNames(plan).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  if (sheetNames.length === 0) throw new DocumentParseError("В книге Excel нет листов.");
  const ordered = sheetNames.slice().sort((left, right) => sheetOrder(left) - sheetOrder(right));
  const blocks: string[] = [];
  let inflated = 0;
  for (const [index, name] of ordered.entries()) {
    const item = plan.entries.find((entry) => entry.name === name);
    if (item == null) continue;
    const sheet = readGuardedZipEntry(plan, item, inflated);
    inflated += sheet.data.byteLength;
    const rows = sheetXmlToRows(decodeXmlPart(sheet.data), shared);
    const title = names[index] ?? `Лист ${index + 1}`;
    blocks.push(rows.length === 0 ? `## ${title}` : `## ${title}\n${rows.join("\n")}`);
  }
  return tidyExtractedText(blocks.join("\n\n"));
}

function sheetOrder(name: string): number {
  const match = /sheet(\d+)\.xml$/.exec(name);
  return match == null ? 0 : Number.parseInt(match[1] as string, 10);
}

export type OfficeZipKind = "docx" | "odt" | "xlsx" | "archive";

/**
 * Вход по содержимому zip: `.docx`, `.xlsx` и ODF различаются составом частей.
 * Если ни одного из известных наборов нет — это обычный архив, а не документ.
 */
export function officeZipKindOf(entries: readonly GuardedZipEntry[]): OfficeZipKind {
  return officeZipKindOfNames(entries.map((entry) => entry.name));
}

/** Тот же вход, но по именам: распаковывать части ради проверки состава незачем. */
export function officeZipKindOfNames(names: readonly string[]): OfficeZipKind {
  const set = new Set(names);
  if (set.has("word/document.xml")) return "docx";
  if (set.has("xl/workbook.xml")) return "xlsx";
  if (set.has("content.xml") || [...set].some((name) => name.endsWith("/content.xml"))) return "odt";
  return "archive";
}

export function officeZipToText(bytes: Uint8Array, kind: OfficeZipKind, limits?: ZipReadLimits): string {
  if (kind === "docx") return docxZipToText(bytes, limits);
  if (kind === "xlsx") return xlsxZipToText(bytes, limits);
  if (kind === "odt") return odtZipToText(bytes, limits);
  throw new DocumentParseError("В архиве нет ни документа Word, ни таблицы Excel, ни файла LibreOffice.");
}

export type { XmlToken };
