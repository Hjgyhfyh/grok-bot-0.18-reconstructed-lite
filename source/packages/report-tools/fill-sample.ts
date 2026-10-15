/**
 * Точное заполнение образца: строки данных вставляются прямо в документ-образец
 * (rtf/docx/odt), поэтому шрифты, размеры, рамки и структура таблиц остаются
 * ровно такими, как в оригинале. **Документ не пересоздаётся — он дополняется.**
 *
 * Главный приём: копируется весь исходный фрагмент строки целиком, а
 * переписывается только содержимое ячеек. Все `\trowd`, `\cellx`, `\clcbpat`,
 * `\fs`, ширины колонок и `\trgaph` остаются байт-в-байт.
 *
 * ВНИМАНИЕ к единицам смещений: Rust считал байты UTF-8, здесь — кодовые
 * единицы UTF-16. Смещение всегда считается как сумма `raw.length`, а
 * `String.prototype.slice` режет по той же единице, поэтому пара всегда
 * согласована. Смешивать `Buffer`-байты и индексы строки здесь нельзя.
 *
 * Порт: Graphite Lite `ai/docfill.rs` (1-1327).
 */

import { readZipEntries, readZipEntryText, writeZip } from "./zip.js";
import { stripXmlTags, xmlEscapeText, xmlUnescape } from "./xml.js";

export type DocFormat = "rtf" | "docx" | "odt";

export function formatOf(path: string): DocFormat | null {
  const match = /\.([^.\\/]+)$/.exec(path);
  const extension = (match?.[1] ?? "").toLowerCase();
  if (extension === "rtf" || extension === "docx" || extension === "odt") return extension;
  return null;
}

export interface FillReport {
  readonly applied: readonly (readonly [string, number])[];
  readonly notFound: readonly string[];
  readonly removedRows: number;
  readonly replacements: number;
  readonly warnings: readonly string[];
}

interface MdSection {
  readonly number: string;
  readonly label: string;
  readonly headerCells: readonly (readonly [number, string])[];
  readonly rows: readonly (readonly string[])[];
}

interface ExtractedRow {
  readonly start: number;
  readonly end: number;
  readonly firstCell: string;
  readonly allText: string;
  readonly cells: readonly (readonly [number, number, string])[];
}

interface RowOps {
  readonly deletions: (readonly [number, number])[];
  readonly insertions: [number, string][];
  readonly cellEdits: (readonly [number, number, string])[];
}

function newRowOps(): RowOps {
  return { deletions: [], insertions: [], cellEdits: [] };
}

/** Вставки в одну позицию склеиваем в порядке добавления (детерминированно). */
function insertAfter(ops: RowOps, position: number, text: string): void {
  const existing = ops.insertions.find(([pos]) => pos === position);
  if (existing !== undefined) {
    existing[1] += text;
    return;
  }
  ops.insertions.push([position, text]);
}

// ───────────────────── разбор markdown на разделы ─────────────────────

function collapseWhitespace(cell: string): string {
  return cell.replace(/\s+/g, "");
}

/** Нумерация пункта в первой колонке: только цифры и точки, есть хоть одна цифра. */
function isSectionNumber(cell: string): boolean {
  const text = collapseWhitespace(cell).replace(/\.+$/, "");
  return (
    text.length > 0
    && /^[0-9.]+$/.test(text)
    && /\d/.test(text)
    && !text.startsWith(".")
  );
}

function tableCellsOfLine(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("|")) {
    return trimmed
      .replace(/^\|+/, "")
      .replace(/\|+$/, "")
      .split("|")
      .map((cell) => cell.trim());
  }
  if (raw.includes("\t")) return raw.split("\t").map((cell) => cell.trim());
  return null;
}

export function parseMarkdownSections(markdown: string): MdSection[] {
  const rows: string[][] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    const cells = tableCellsOfLine(raw);
    if (cells === null) continue;
    if (cells.every((cell) => /^[-: ]*$/.test(cell))) continue;
    if (cells.every((cell) => cell.length === 0)) continue;
    rows.push(cells);
  }

  const sections: { number: string; label: string; headerCells: [number, string][]; rows: string[][] }[] = [];
  for (const row of rows) {
    const first = row[0] ?? "";
    if (isSectionNumber(first)) {
      sections.push({
        number: first.trim().replace(/\.+$/, ""),
        label: row[1] ?? "",
        headerCells: row
          .map((value, index) => [index, value] as [number, string])
          .filter(([index, value]) => index >= 2 && value.length > 0),
        rows: [],
      });
      continue;
    }
    sections[sections.length - 1]?.rows.push(row);
  }
  return sections;
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Длина наибольшей общей подстроки (не подпоследовательности), O(n·m). */
function longestCommonSubstringLen(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  if (left.length === 0 || right.length === 0) return 0;
  let best = 0;
  let previous = new Array<number>(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Array<number>(right.length + 1).fill(0);
    for (let j = 1; j <= right.length; j += 1) {
      if (left[i - 1] === right[j - 1]) {
        current[j] = (previous[j - 1] as number) + 1;
        if ((current[j] as number) > best) best = current[j] as number;
      }
    }
    previous = current;
  }
  return best;
}

// ───────────────────── правки по смещениям ─────────────────────

export function braceBalance(text: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
  }
  return depth;
}

/**
 * Доводит границы фрагмента до сбалансированного состояния: клонирование
 * несбалансированного куска RTF разъезжается по группам и портит документ.
 */
function balancedFragment(source: string, start: number, end: number): [number, number] {
  const base = braceBalance(source.slice(0, start));
  let depth = base;
  for (let index = start; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth < base) return [start, index];
      if (index + 1 >= end && depth === base) return [start, index + 1];
    }
  }
  return [start, end];
}

function applyOps(source: string, ops: RowOps): string {
  const debug = process.env.DBBOT_FILL_DEBUG != null;
  const actions: { start: number; end: number; text: string | null }[] = [];
  for (const [start, end] of ops.deletions) {
    if (debug) {
      process.stderr.write(
        `DELETE ${start}..${end} balance=${braceBalance(source.slice(start, end))} (длина ${end - start})\n`,
      );
    }
    actions.push({ start, end, text: null });
  }
  for (const [position, text] of ops.insertions) {
    if (debug) {
      process.stderr.write(`INSERT @${position} balance=${braceBalance(text)} (длина ${text.length})\n`);
    }
    actions.push({ start: position, end: position, text });
  }
  for (const [start, end, text] of ops.cellEdits) {
    if (debug) {
      process.stderr.write(`EDIT ${start}..${end} → ${text.length} байт\n`);
    }
    actions.push({ start, end, text });
  }
  // Обратный порядок по смещению: тогда ранее посчитанные смещения остаются верными.
  actions.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = source;
  for (const action of actions) {
    if (action.start > out.length || action.end > out.length || action.start > action.end) continue;
    out = out.slice(0, action.start) + (action.text ?? "") + out.slice(action.end);
    if (debug) {
      process.stderr.write(`после операции @${action.start}..${action.end} баланс документа = ${braceBalance(out)}\n`);
    }
  }
  return out;
}

function cloneRow(
  source: string,
  donor: ExtractedRow,
  newCells: readonly string[],
  format: DocFormat,
): string {
  let out = "";
  let cursor = donor.start;
  donor.cells.forEach(([cellStart, cellEnd], index) => {
    if (cellEnd <= donor.start || cellStart >= donor.end) return;
    out += source.slice(cursor, cellStart);
    out += rewriteCell(source.slice(cellStart, cellEnd), newCells[index] ?? "", format);
    cursor = cellEnd;
  });
  out += source.slice(cursor, donor.end);
  return out;
}

function planFill(
  source: string,
  format: DocFormat,
  rows: readonly ExtractedRow[],
  sections: readonly MdSection[],
  ops: RowOps,
): { readonly report: MutableFillReport } {
  const report: MutableFillReport = {
    applied: [],
    notFound: [],
    removedRows: 0,
    replacements: 0,
    warnings: [],
  };
  const used: boolean[] = rows.map(() => false);
  const firstDataRow = rows.findIndex(
    (row) => row.firstCell.trim().length === 0 && row.allText.trim().length > 0,
  );

  for (const section of sections) {
    // Кандидат — либо свободная строка образца, либо (как запасной вариант)
    // уже занятая строка, которую можно склонировать вместе с её строками.
    const pick = (requireFree: boolean): number | null => {
      const sectionNorm = normalize(`${section.number} ${section.label}`);
      let best: { readonly score: number; readonly index: number } | null = null;
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index] as ExtractedRow;
        if (requireFree && used[index] === true) continue;
        if (!isSectionNumber(row.firstCell)) continue;
        const first = collapseWhitespace(row.firstCell).replace(/\.+$/, "");
        const sameNumber = first === section.number;
        // Подпись важнее номера: у отделов нумерация «плывёт», а текст раздела
        // скопирован из формы — совпадение по нему надёжнее.
        const score = Math.min(longestCommonSubstringLen(sectionNorm, normalize(row.allText)), 120)
          + (sameNumber ? 40 : 0);
        if (score > (best?.score ?? 0)) best = { score, index };
      }
      return best !== null && best.score >= 30 ? best.index : null;
    };

    const free = pick(true);
    const clonedSection = free === null;
    const rowIndex = free ?? pick(false);
    if (rowIndex === null) {
      report.notFound.push(`${section.number} ${section.label}`);
      continue;
    }
    used[rowIndex] = true;
    const row = rows[rowIndex] as ExtractedRow;

    let areaEnd = rowIndex + 1;
    while (areaEnd < rows.length && !isSectionNumber((rows[areaEnd] as ExtractedRow).firstCell)) {
      areaEnd += 1;
    }
    const area = rows.slice(rowIndex + 1, areaEnd);
    const donor = area.find((candidate) => candidate.cells.length >= 2)
      ?? (firstDataRow >= 0 ? rows[firstDataRow] : undefined);

    // Конец области данных: начало следующей распознанной строки. Одна и та же
    // точка и для удаления, и для вставки клона.
    const areaEndPos = rows[areaEnd]?.start ?? area[area.length - 1]?.end ?? row.end;
    const insertPosition = clonedSection
      ? areaEndPos
      : row.end;
    if (!clonedSection && area.length > 0) {
      // Удаляем область до начала следующей строки: так вычищаются и «сироты»,
      // не попавшие в отдельные строки (хитрости Word).
      ops.deletions.push([(area[0] as ExtractedRow).start, areaEndPos]);
    }

    let inserted = "";
    if (clonedSection) {
      // Второй блок с тем же номером: клонируем строку-заголовок секции.
      const sectionCells = new Array<string>(row.cells.length).fill("");
      if (sectionCells.length > 0) sectionCells[0] = section.number;
      if (sectionCells.length > 1) sectionCells[1] = section.label;
      for (const [index, value] of section.headerCells) {
        if (index < sectionCells.length) sectionCells[index] = value;
      }
      inserted += cloneRow(source, row, sectionCells, format);
    }
    if (section.rows.length > 0) {
      if (donor === undefined) {
        report.warnings.push(`нет строки-донора для раздела ${section.number}`);
        continue;
      }
      for (const cells of section.rows) inserted += cloneRow(source, donor, cells, format);
    }
    if (inserted.length > 0) insertAfter(ops, insertPosition, inserted);
    if (!clonedSection) {
      rewriteCellInto(ops, source, row, 0, section.number, format);
      if (section.label.trim().length > 0) rewriteCellInto(ops, source, row, 1, section.label, format);
      for (const [index, value] of section.headerCells) {
        rewriteCellInto(ops, source, row, index, value, format);
      }
    }
    report.applied.push([`${section.number} ${section.label}`, section.rows.length]);
    if (!clonedSection) report.removedRows += area.length;
  }

  // Незадействованные секции образца убираем вместе со строками-примерами:
  // итог должен соответствовать отчёту, а не пустой форме.
  const debug = process.env.DBBOT_FILL_DEBUG != null;
  let index = 0;
  while (index < rows.length) {
    const row = rows[index] as ExtractedRow;
    if (used[index] === true || !isSectionNumber(row.firstCell)) {
      index += 1;
      continue;
    }
    // Строка-заголовок таблицы («№№ п/п») не номерная — её не трогаем.
    let areaEnd = index + 1;
    while (areaEnd < rows.length && !isSectionNumber((rows[areaEnd] as ExtractedRow).firstCell)) {
      areaEnd += 1;
    }
    if (debug) {
      process.stderr.write(
        `УДАЛЯЮ незадействованную секцию '${collapseWhitespace(row.firstCell)}' (строк: ${areaEnd - index})\n`,
      );
    }
    ops.deletions.push([row.start, rows[areaEnd]?.start ?? (rows[areaEnd - 1] as ExtractedRow).end]);
    report.removedRows += areaEnd - index;
    index = areaEnd;
  }
  return { report };
}

interface MutableFillReport {
  applied: [string, number][];
  notFound: string[];
  removedRows: number;
  replacements: number;
  warnings: string[];
}

function rewriteCellInto(
  ops: RowOps,
  source: string,
  row: ExtractedRow,
  index: number,
  value: string,
  format: DocFormat,
): void {
  const cell = row.cells[index];
  if (cell === undefined) return;
  const [start, end, current] = cell;
  if (current.trim() === value.trim()) return;
  ops.cellEdits.push([start, end, rewriteCell(source.slice(start, end), value, format)]);
}

function rewriteCell(raw: string, value: string, format: DocFormat): string {
  if (format === "rtf") return rewriteRtfCell(raw, value);
  if (format === "docx") return rewriteDocxCell(raw, value);
  return rewriteOdtCell(raw, value);
}

// ───────────────────────── RTF ─────────────────────────

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

type RtfToken =
  | { readonly kind: "control"; readonly word: string; readonly number: number | null }
  | { readonly kind: "hex"; readonly byte: number }
  | { readonly kind: "escaped"; readonly char: string }
  | { readonly kind: "char"; readonly char: string }
  | { readonly kind: "open" }
  | { readonly kind: "close" };

interface RtfTokenRecord {
  readonly token: RtfToken;
  readonly raw: string;
}

/**
 * Токенизатор RTF. Важная деталь: если сразу за управляющим словом идёт
 * пробел, этот пробел входит в `raw` — он часть команды, а не текст.
 * Забыть об этом — классический способ склеить `\ltrpar13.01.2026` с текстом.
 */
export function tokenizeRtf(source: string): RtfTokenRecord[] {
  const chars = Array.from(source);
  const tokens: RtfTokenRecord[] = [];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i] as string;
    if (ch === "{") {
      tokens.push({ token: { kind: "open" }, raw: "{" });
      i += 1;
      continue;
    }
    if (ch === "}") {
      tokens.push({ token: { kind: "close" }, raw: "}" });
      i += 1;
      continue;
    }
    if (ch === "\\") {
      const next = chars[i + 1];
      if (next === undefined) {
        tokens.push({ token: { kind: "escaped", char: "\\" }, raw: "\\" });
        break;
      }
      if (next === "'") {
        const hex = (chars[i + 2] ?? "") + (chars[i + 3] ?? "");
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          tokens.push({ token: { kind: "hex", byte: Number.parseInt(hex, 16) }, raw: `\\'${hex}` });
          i += 4;
          continue;
        }
      }
      if (/^[A-Za-z]$/.test(next)) {
        let word = "";
        let j = i + 1;
        while (j < chars.length && /^[A-Za-z]$/.test(chars[j] as string)) {
          word += chars[j];
          j += 1;
        }
        let numberText = "";
        const firstNumber = chars[j];
        if (firstNumber !== undefined && (firstNumber === "-" || /^[0-9]$/.test(firstNumber))) {
          numberText += firstNumber;
          j += 1;
          while (j < chars.length && /^[0-9]$/.test(chars[j] as string)) {
            numberText += chars[j];
            j += 1;
          }
        }
        let raw = chars.slice(i, j).join("");
        if (chars[j] === " ") {
          raw += " ";
          j += 1;
        }
        const parsed = /^-?\d+$/.test(numberText) ? Number.parseInt(numberText, 10) : null;
        tokens.push({ token: { kind: "control", word, number: parsed }, raw });
        i = j;
        continue;
      }
      const mapped =
        next === "\\" ? "\\"
        : next === "{" ? "{"
        : next === "}" ? "}"
        : next === "~" ? " "
        : next === "-" ? "­"
        : next === "_" ? "‑"
        : next;
      tokens.push({ token: { kind: "escaped", char: mapped }, raw: `\\${next}` });
      i += 2;
      continue;
    }
    tokens.push({ token: { kind: "char", char: ch }, raw: ch });
    i += 1;
  }
  return tokens;
}

function rtfCharOf(byte: number): string {
  if (byte < 0x80) return String.fromCharCode(byte);
  return CP1251_HIGH[byte - 0x80] ?? "";
}

function controlChar(token: Extract<RtfToken, { kind: "control" }>): string | null {
  if (token.number === null) return null;
  const value = token.number < 0 ? token.number + 65536 : token.number;
  return value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : null;
}

export function rtfText(tokens: readonly RtfTokenRecord[]): string {
  let out = "";
  // После `\uN` в RTF идёт один символ «запасного» представления для программ
  // без Unicode. Его полагается пропустить, иначе в расшифрованном тексте
  // каждая буква тащит лишний «?». В оригинале на Rust этот символ попадал в
  // текст, из-за чего подпись из заполненного образца не совпадала с исходной.
  let skipFallback = false;
  for (const { token } of tokens) {
    if (token.kind === "char" && skipFallback) {
      skipFallback = false;
      continue;
    }
    skipFallback = false;
    if (token.kind === "char" || token.kind === "escaped") out += token.char;
    else if (token.kind === "hex") out += rtfCharOf(token.byte);
    else if (token.kind === "control") {
      if (token.word === "par" || token.word === "line") out += "\n";
      else if (token.word === "tab") out += "\t";
      else if (token.word === "u") {
        const decoded = controlChar(token);
        if (decoded !== null) {
          out += decoded;
          skipFallback = true;
        }
      }
    }
  }
  return out;
}

const CONTENT_CONTROLS = new Set([
  "u", "par", "line", "tab", "endash", "emdash", "enspace", "emspace", "bullet",
  "lquote", "rquote", "ldblquote", "rdblquote", "~", "-", "_",
]);

function isContentToken(token: RtfToken): boolean {
  if (token.kind === "char" || token.kind === "escaped" || token.kind === "hex") return true;
  return token.kind === "control" && CONTENT_CONTROLS.has(token.word);
}

/** Экранирование для вставки: `\n` → `\par `, `\t` → `\tab `. */
export function rtfEscapeText(text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch === "\\") out += "\\\\";
    else if (ch === "{") out += "\\{";
    else if (ch === "}") out += "\\}";
    else if (ch === "\n") out += "\\par ";
    else if (ch === "\t") out += "\\tab ";
    else if ((ch.codePointAt(0) as number) < 128) out += ch;
    else {
      const code = ch.codePointAt(0) as number;
      out += `\\u${code > 32767 ? code - 65536 : code}?`;
    }
  }
  return out;
}

/**
 * Заменяет ТОЛЬКО текстовые токены ячейки, сохраняя все служебные (скобки,
 * группы форматирования, row/coldef). Иначе ломается структура RTF.
 */
export function rewriteRtfCell(raw: string, value: string): string {
  const tokens = tokenizeRtf(raw);
  const content: number[] = [];
  tokens.forEach((record, index) => {
    if (isContentToken(record.token)) content.push(index);
  });
  const escaped = rtfEscapeText(value);
  if (content.length === 0) return raw + escaped;

  const first = content[0] as number;
  let out = "";
  tokens.forEach((record, index) => {
    if (index === first) {
      // Управляющее слово перед текстом обязано быть отделено пробелом, иначе
      // текст прилипнет к параметру контрола (`\ltrpar13.01.2026`).
      // Для пустого текста пробел не ставим: в ячейке строки таблицы
      // определение колонок не должно получать лишний пробел.
      const previous = index > 0 ? tokens[index - 1] : undefined;
      if (
        escaped.length > 0
        && previous !== undefined
        && previous.token.kind === "control"
        && !previous.raw.endsWith(" ")
      ) {
        out += " ";
      }
      out += escaped;
      return;
    }
    if (isContentToken(record.token)) return;
    out += record.raw;
  });
  return out;
}

function extractRtfRows(source: string): ExtractedRow[] {
  const tokens = tokenizeRtf(source);
  const offsets: number[] = [];
  let position = 0;
  for (const record of tokens) {
    offsets.push(position);
    position += record.raw.length;
  }
  const tokenEnd = (index: number): number => (offsets[index] as number) + (tokens[index] as RtfTokenRecord).raw.length;
  const isControl = (index: number, word: string): boolean => {
    const token = tokens[index]?.token;
    return token?.kind === "control" && token.word === word;
  };

  // Строка = чанк между соседними `\trowd`. Такой разрез устойчив к «хитрым»
  // конструкциям Word: вложенные таблички попадают внутрь чанка.
  const trowds: number[] = [];
  tokens.forEach((record, index) => {
    if (record.token.kind === "control" && record.token.word === "trowd") trowds.push(index);
  });

  const rows: ExtractedRow[] = [];
  trowds.forEach((trowd, slot) => {
    const nextTrowd = trowds[slot + 1] ?? tokens.length;
    let endToken = nextTrowd < tokens.length ? nextTrowd : tokens.length - 1;
    for (let index = trowd + 1; index < nextTrowd; index += 1) {
      if (isControl(index, "row")) {
        endToken = index;
        break;
      }
    }
    const cells: [number, number, string][] = [];
    let cellStart = trowd;
    for (let index = trowd; index <= endToken; index += 1) {
      if (!isControl(index, "cell")) continue;
      const text = rtfText(tokens.slice(cellStart, index));
      cells.push([offsets[cellStart] as number, offsets[index] as number, text]);
      cellStart = index + 1;
    }
    if (cells.length === 0) return;
    const rawStart = offsets[trowd] as number;
    const [start, end] = balancedFragment(source, rawStart, tokenEnd(endToken));
    const allText = cells.map(([, , text]) => text).join(" ");
    rows.push({ start, end, firstCell: cells[0]?.[2] ?? "", allText, cells });
  });
  return rows;
}

/** Замены текста в шапке RTF (до первой таблицы) на уровне токенов. */
function applyRtfReplacements(
  source: string,
  replacements: readonly (readonly [string, string])[],
  ops: RowOps,
): number {
  if (replacements.length === 0) return 0;
  const tokens = tokenizeRtf(source);
  let firstRowToken = tokens.length;
  tokens.forEach((record, index) => {
    if (record.token.kind === "control" && record.token.word === "trowd" && firstRowToken === tokens.length) {
      firstRowToken = index;
    }
  });
  const offsets: number[] = [];
  let position = 0;
  for (const record of tokens) {
    offsets.push(position);
    position += record.raw.length;
  }

  let count = 0;
  for (const [old, next] of replacements) {
    if (old.length === 0) continue;
    const oldChars = Array.from(old);
    // Карта: (позиция в декодированном тексте) → индекс токена.
    // Запасной символ после `\uN` пропускается — иначе в шапке, набранной
    // Word как `\u1055?\u1088?...`, ни одна замена не нашла бы свой текст.
    const decoded: { char: string; token: number }[] = [];
    let skipFallback = false;
    tokens.slice(0, firstRowToken).forEach((record, index) => {
      const token = record.token;
      if (skipFallback && token.kind === "char") {
        skipFallback = false;
        return;
      }
      skipFallback = false;
      if (token.kind === "char" || token.kind === "escaped") decoded.push({ char: token.char, token: index });
      else if (token.kind === "hex") decoded.push({ char: rtfCharOf(token.byte), token: index });
      else if (token.kind === "control" && token.word === "u") {
        const decodedChar = controlChar(token);
        if (decodedChar !== null) {
          decoded.push({ char: decodedChar, token: index });
          skipFallback = true;
        }
      }
    });
    let searchFrom = 0;
    while (searchFrom + oldChars.length <= decoded.length) {
      const matched = oldChars.every((expected, offset) => decoded[searchFrom + offset]?.char === expected);
      if (!matched) {
        searchFrom += 1;
        continue;
      }
      const firstToken = (decoded[searchFrom] as { token: number }).token;
      const lastToken = (decoded[searchFrom + oldChars.length - 1] as { token: number }).token;
      const start = offsets[firstToken] as number;
      const end = (offsets[lastToken] as number) + (tokens[lastToken] as RtfTokenRecord).raw.length;
      ops.cellEdits.push([start, end, rtfEscapeText(next)]);
      count += 1;
      searchFrom += oldChars.length;
    }
  }
  return count;
}

// ───────────────────────── DOCX ─────────────────────────

export function extractDocxRows(source: string): ExtractedRow[] {
  const rows: ExtractedRow[] = [];
  let position = 0;
  while (position <= source.length) {
    const relative = source.indexOf("<w:tr", position);
    if (relative < 0) break;
    const start = relative;
    // Проверяем, что это именно `w:tr`, а не `w:trPr` и подобное.
    if (source[start + 5] !== ">" && source[start + 5] !== " ") {
      position = start + 5;
      continue;
    }
    const endRelative = source.indexOf("</w:tr>", start);
    if (endRelative < 0) break;
    const end = endRelative + "</w:tr>".length;
    const rowXml = source.slice(start, end);
    const cells: [number, number, string][] = [];
    let cursor = 0;
    while (cursor <= rowXml.length) {
      const cellRelative = rowXml.indexOf("<w:tc>", cursor);
      if (cellRelative < 0) break;
      // `indexOf` уже возвращает позицию от начала строки, `cursor` в сумму не входит.
      const cellStart = cellRelative;
      const cellEndRelative = rowXml.indexOf("</w:tc>", cellStart);
      if (cellEndRelative < 0) break;
      const cellEnd = cellEndRelative + "</w:tc>".length;
      const cellXml = rowXml.slice(cellStart, cellEnd);
      let text = "";
      let scan = 0;
      while (scan <= cellXml.length) {
        const openRelative = cellXml.indexOf("<w:t", scan);
        if (openRelative < 0) break;
        const open = openRelative;
        if (cellXml[open + 4] !== ">" && cellXml[open + 4] !== " ") {
          scan = open + 4;
          continue;
        }
        const gtRelative = cellXml.indexOf(">", open);
        if (gtRelative < 0) break;
        const contentStart = gtRelative + 1;
        const closeRelative = cellXml.indexOf("</w:t>", contentStart);
        if (closeRelative < 0) break;
        text += xmlUnescape(cellXml.slice(contentStart, closeRelative));
        scan = closeRelative + "</w:t>".length;
      }
      cells.push([start + cellStart, start + cellEnd, text]);
      cursor = cellEnd;
    }
    rows.push({
      start,
      end,
      firstCell: cells[0]?.[2] ?? "",
      allText: cells.map(([, , text]) => text).join(" "),
      cells,
    });
    position = end;
  }
  return rows;
}

export function rewriteDocxCell(cellXml: string, value: string): string {
  const escaped = xmlEscapeText(value);
  let out = "";
  let scan = 0;
  let replaced = false;
  while (scan <= cellXml.length) {
    const openRelative = cellXml.indexOf("<w:t", scan);
    if (openRelative < 0) break;
    const open = openRelative;
    if (cellXml[open + 4] !== ">" && cellXml[open + 4] !== " ") {
      out += cellXml.slice(scan, open + 4);
      scan = open + 4;
      continue;
    }
    const gtRelative = cellXml.indexOf(">", open);
    if (gtRelative < 0) break;
    const contentStart = gtRelative + 1;
    const closeRelative = cellXml.indexOf("</w:t>", contentStart);
    if (closeRelative < 0) break;
    out += cellXml.slice(scan, open);
    // Открывающие и закрывающие теги вокруг `<w:rPr>` не трогаем — шрифт и
    // размер ячейки остаются как в образце.
    out += replaced
      ? "<w:t xml:space=\"preserve\"></w:t>"
      : `<w:t xml:space="preserve">${escaped}</w:t>`;
    replaced = true;
    scan = closeRelative + "</w:t>".length;
  }
  return out + cellXml.slice(scan);
}

// ───────────────────────── ODT ─────────────────────────

export function extractOdtRows(source: string): ExtractedRow[] {
  const rows: ExtractedRow[] = [];
  let position = 0;
  while (position <= source.length) {
    const relative = source.indexOf("<table:table-row", position);
    if (relative < 0) break;
    const start = relative;
    const openGt = source.indexOf(">", start);
    if (openGt < 0) break;
    if (source[openGt - 1] === "/") {
      position = openGt + 1;
      continue;
    }
    const endRelative = source.indexOf("</table:table-row>", start);
    if (endRelative < 0) break;
    const end = endRelative + "</table:table-row>".length;
    const rowXml = source.slice(start, end);
    const cells: [number, number, string][] = [];
    let cursor = 0;
    while (cursor <= rowXml.length) {
      const cellRelative = rowXml.indexOf("<table:table-cell", cursor);
      if (cellRelative < 0) break;
      const cellStart = cellRelative;
      const cellOpenGt = rowXml.indexOf(">", cellStart);
      if (cellOpenGt < 0) break;
      const cellBodyStart = cellOpenGt + 1;
      const cellEndRelative = rowXml.indexOf("</table:table-cell>", cellBodyStart);
      if (cellEndRelative < 0) break;
      const cellEnd = cellEndRelative + "</table:table-cell>".length;
      const cellXml = rowXml.slice(cellStart, cellEnd);
      let text = "";
      let scan = 0;
      while (scan <= cellXml.length) {
        const openRelative = cellXml.indexOf("<text:p", scan);
        if (openRelative < 0) break;
        const open = openRelative;
        const gtRelative = cellXml.indexOf(">", open);
        if (gtRelative < 0) break;
        const contentStart = gtRelative + 1;
        const closeRelative = cellXml.indexOf("</text:p>", contentStart);
        if (closeRelative < 0) break;
        const contentEnd = closeRelative;
        if (text.length > 0) text += "\n";
        text += xmlUnescape(stripXmlTags(cellXml.slice(contentStart, contentEnd)));
        scan = contentEnd + "</text:p>".length;
      }
      cells.push([start + cellStart, start + cellEnd, text]);
      cursor = cellEnd;
    }
    rows.push({
      start,
      end,
      firstCell: cells[0]?.[2] ?? "",
      allText: cells.map(([, , text]) => text).join(" "),
      cells,
    });
    position = end;
  }
  return rows;
}

export function rewriteOdtCell(cellXml: string, value: string): string {
  const escaped = xmlEscapeText(value);
  let out = "";
  let scan = 0;
  let replaced = false;
  while (scan <= cellXml.length) {
    const openRelative = cellXml.indexOf("<text:p", scan);
    if (openRelative < 0) break;
    const open = openRelative;
    const gtRelative = cellXml.indexOf(">", open);
    if (gtRelative < 0) break;
    const contentStart = gtRelative + 1;
    const closeRelative = cellXml.indexOf("</text:p>", contentStart);
    if (closeRelative < 0) break;
    out += cellXml.slice(scan, contentStart);
    if (!replaced) {
      out += escaped;
      replaced = true;
    }
    out += "</text:p>";
    scan = closeRelative + "</text:p>".length;
  }
  return out + cellXml.slice(scan);
}

// ───────────────────────── общий вход ─────────────────────────

function extractRows(source: string, format: DocFormat): ExtractedRow[] {
  if (format === "rtf") return extractRtfRows(source);
  if (format === "docx") return extractDocxRows(source);
  return extractOdtRows(source);
}

function applyXmlHeaderReplacement(
  source: string,
  old: string,
  next: string,
  format: DocFormat,
): string {
  const tableMarker = format === "docx" ? "<w:tbl" : "<table:table ";
  const headEnd = source.indexOf(tableMarker) < 0 ? source.length : source.indexOf(tableMarker);
  const head = source.slice(0, headEnd);
  const tail = source.slice(headEnd);
  const tag = format === "docx" ? "w:t" : "text:p";
  const closeTag = `</${tag}>`;
  const openTag = `<${tag}`;
  let out = "";
  let scan = 0;
  while (scan <= head.length) {
    const openRelative = head.indexOf(openTag, scan);
    if (openRelative < 0) break;
    const open = openRelative;
    const gtRelative = head.indexOf(">", open);
    if (gtRelative < 0) break;
    const contentStart = gtRelative + 1;
    const closeRelative = head.indexOf(closeTag, contentStart);
    if (closeRelative < 0) break;
    const contentEnd = closeRelative;
    out += head.slice(scan, contentStart);
    const content = xmlUnescape(stripXmlTags(head.slice(contentStart, contentEnd)));
    out += content.includes(old) ? xmlEscapeText(content.replaceAll(old, next)) : head.slice(contentStart, contentEnd);
    out += closeTag;
    scan = contentEnd + closeTag.length;
  }
  return out + head.slice(scan) + tail;
}

/** Архив пересобирается целиком: все части копируются, `mimetype` — без сжатия. */
function rebuildZip(sample: Uint8Array, part: string, newPart: string): Uint8Array {
  const entries = readZipEntries(sample).map((entry) => ({
    name: entry.name,
    data: entry.name === part ? new TextEncoder().encode(newPart) : entry.data,
    stored: entry.name === "mimetype",
  }));
  return writeZip(entries);
}

export interface FillDocumentInput {
  readonly sampleName: string;
  readonly sampleBytes: Uint8Array;
  readonly markdown: string;
  readonly replacements: readonly (readonly [string, string])[];
}

export function fillDocument(input: FillDocumentInput): { readonly bytes: Uint8Array; readonly report: FillReport } {
  const format = formatOf(input.sampleName);
  if (format === null) throw new Error("формат образца не поддержан (нужен rtf/docx/odt)");
  const sections = parseMarkdownSections(input.markdown);
  if (sections.length === 0) throw new Error("в отчёте не найдено ни одной таблицы-раздела");

  if (format === "rtf") {
    const source = new TextDecoder().decode(input.sampleBytes);
    const rows = extractRtfRows(source);
    if (rows.length === 0) throw new Error("в образце не найдено таблиц");
    const ops = newRowOps();
    const { report } = planFill(source, format, rows, sections, ops);
    const applied = applyRtfReplacements(source, input.replacements, ops);
    report.replacements = applied;
    const filled = applyOps(source, ops);
    return { bytes: new TextEncoder().encode(filled), report };
  }

  const part = format === "docx" ? "word/document.xml" : "content.xml";
  let xml: string;
  try {
    xml = readZipEntryText(input.sampleBytes, part);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
  const rows = extractRows(xml, format);
  if (rows.length === 0) throw new Error("в образце не найдено таблиц");
  const ops = newRowOps();
  const { report } = planFill(xml, format, rows, sections, ops);
  // Честный счётчик: сколько пар реально заменено, а не сколько запрошено.
  let appliedReplacements = 0;
  let filled = applyOps(xml, ops);
  for (const [old, next] of input.replacements) {
    const before = filled;
    filled = applyXmlHeaderReplacement(filled, old, next, format);
    if (filled !== before) appliedReplacements += 1;
  }
  report.replacements = appliedReplacements;
  return { bytes: rebuildZip(input.sampleBytes, part, filled), report };
}
