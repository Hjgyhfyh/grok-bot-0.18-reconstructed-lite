/**
 * Текст из RTF.
 *
 * RTF — это текст с разметкой: группы в фигурных скобках, управляющие слова
 * `\par`, `\tab`, `\uN` и кодовые страницы `\'hh`. В проекте уже есть токенизатор
 * в `report-tools/fill-sample.ts`, но он разбирает весь файл целиком, включая
 * `\fonttbl`, `\colortbl` и `\stylesheet`, где лежит не текст, а определения.
 * Здесь разбор с учётом вложенности групп: группы-определения пропускаются,
 * а `\ansicpg` решает, как читать `\'hh`.
 */

const DECODER = new TextDecoder("utf-8");

/** Группы, содержимое которых не является текстом документа. */
const SKIP_DESTINATIONS = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "themedata",
  "colorschememapping", "latentstyles", "datastore", "rsidtbl", "listtable",
  "listoverridetable", "filetbl", "revtbl", "generator", "xmlnstbl", "mmathPr",
  "wgrffmtfilter", "pntext", "pn", "upr", "headerl", "headerr", "headerf",
  "footerl", "footerr", "footerf", "do", "shp", "shpinst", "nonshppict",
  "bkmkstart", "bkmkend", "atrfstart", "atrfend", "fldinst", "company", "operator",
]);

const CONTROL_REPLACEMENTS: Readonly<Record<string, string>> = {
  par: "\n", line: "\n", sect: "\n", page: "\n", row: "\n", nestrow: "\n",
  tab: "\t", cell: "\t", emdash: "—", endash: "–", emspace: " ", enspace: " ",
  qmspace: " ", bullet: "•", lquote: "«", rquote: "»", ldblquote: "„", rdblquote: "“",
  "~": " ", "-": "­", "_": "‑", ":": " ", "|": "¦", "^": "ˆ",
};

/** Кодовые страницы RTF, которые встречаются в русских документах. */
const CODEPAGES: Readonly<Record<number, string>> = { 1251: "win1251", 1252: "win1252", 1250: "win1250", 65001: "utf8", 866: "cp866", 10000: "macroman" };

interface RtfState {
  readonly codePage: string;
  readonly depth: number;
  readonly skipDepth: number | null;
  readonly ucSkip: boolean;
  readonly skipNextChar: boolean;
}

// По спецификации RTF после `\uN` идёт `uc` символов запасного представления,
// и `uc` по умолчанию равен 1. Если это не учесть, каждая русская буква
// превращается в «С?v?к?е?т».
const DEFAULT_STATE: RtfState = { codePage: "win1252", depth: 0, skipDepth: null, ucSkip: true, skipNextChar: false };

/** Замена верхнего состояния в стеке: состояние лежит по ссылке, поля меняем на месте. */
function setState(stack: RtfState[], state: RtfState): RtfState {
  const index = stack.length - 1;
  const next: RtfState = { ...state };
  stack[index] = next;
  return next;
}

/** `\'hh` читается в кодовой странице документа, а не всегда в 1251. */
function byteToChar(byte: number, codePage: string): string {
  if (byte < 0x80) return String.fromCharCode(byte);
  if (codePage === "win1251") return CP1251_HIGH[byte - 0x80] ?? "";
  if (codePage === "cp866") return CP866_HIGH[byte - 0x80] ?? "";
  try { return new TextDecoder(codePage, { fatal: false }).decode(new Uint8Array([byte])); } catch { return ""; }
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

const CP866_HIGH = [
  "Ё", "Ё", "Ѓ", "‚", "ѓ", "„", "…", "†", "‡", "€", "‰", "‹", "Њ", "Ќ", "‽", "Џ",
  "ђ", "‘", "’", "“", "”", "•", "–", "—", "Ї", "™", "љ", "›", "њ", "ќ", "ћ", "џ",
  " ", "Ў", "ў", "Ј", "¤", "Ґ", "¦", "§", "Ё", "©", "Є", "«", "¬", "­", "®",
  "Ї", "°", "±", "І", "і", "ґ", "µ", "¶", "·", "ё", "№", "є", "»", "ј", "Ѕ", "ѕ",
  "ї", "А", "Б", "В", "Г", "Д", "Е", "Ж", "З", "И", "Й", "К", "Л", "М", "Н", "О",
  "П", "Р", "С", "Т", "У", "Ф", "Х", "Ц", "Ч", "Ш", "Щ", "Ъ", "Ы", "Ь", "Э", "Ю",
  "Я", "а", "б", "в", "г", "д", "е", "ж", "з", "и", "й", "к", "л", "м", "н", "о",
  "п", "р", "с", "т", "у", "ф", "х", "ц", "ч", "ш", "щ", "ъ", "ы", "ь", "э", "ю",
  "я", "ё", "Ё",
];

/**
 * Достаёт текст из строки RTF. Возвращает `null`, если это не RTF: по
 * одному `{\rtf1` решать нельзя, вызывающий код проверяет сигнатуру отдельно.
 */
export function rtfSourceToText(source: string): string {
  let out = "";
  const stack: RtfState[] = [DEFAULT_STATE];
  let state = DEFAULT_STATE;
  let index = 0;
  const length = source.length;
  while (index < length) {
    const char = source[index] as string;
    if (char === "{") {
      const next: RtfState = { ...state, depth: state.depth + 1 };
      stack.push(next);
      state = next;
      index += 1;
      continue;
    }
    if (char === "}") {
      if (stack.length > 1) stack.pop();
      state = stack[stack.length - 1] as RtfState;
      index += 1;
      continue;
    }
    if (char !== "\\") {
      if (state.skipDepth == null) {
        if (state.skipNextChar) state = setState(stack, { ...state, skipNextChar: false });
        else out += char;
      }
      index += 1;
      continue;
    }
    index += 1;
    const next = source[index];
    if (next === undefined) break;
    if (next === "'") {
      const hex = source.slice(index + 1, index + 3);
      index += 3;
      if (/^[0-9a-fA-F]{2}$/.test(hex) && state.skipDepth == null) out += byteToChar(Number.parseInt(hex, 16), state.codePage);
      continue;
    }
    if (next === "\n" || next === "\r") { index += 1; continue; }
    if (!/[A-Za-z]/.test(next)) {
      const mapped = next === "\\" ? "\\" : next === "{" ? "{" : next === "}" ? "}" : next === "~" ? " " : next === "_" ? "‑" : next;
      if (state.skipDepth == null) out += mapped;
      index += 1;
      continue;
    }
    const wordStart = index;
    while (index < length && /[A-Za-z]/.test(source[index] as string)) index += 1;
    const word = source.slice(wordStart, index);
    let digits = "";
    if (source[index] === "-") { digits += "-"; index += 1; }
    while (index < length && /[0-9]/.test(source[index] as string)) { digits += source[index]; index += 1; }
    if (source[index] === " ") index += 1;
    const number = digits.length > 0 ? Number.parseInt(digits, 10) : null;

    if (word === "ansicpg" && number != null) {
      const codePage = CODEPAGES[number];
      if (codePage != null) state = setState(stack, { ...state, codePage });
      continue;
    }
    if (word === "uc" && number != null) {
      state = setState(stack, { ...state, ucSkip: number > 0 });
      continue;
    }
    if (state.skipDepth != null) continue;
    if (word === "u" && number != null) {
      const value = number < 0 ? number + 65536 : number;
      if (value >= 0 && value <= 0x10ffff) out += String.fromCodePoint(value);
      // После `\uN` идёт `uc` символов запасного представления — их пропускаем.
      state = setState(stack, { ...state, skipNextChar: state.ucSkip });
      continue;
    }
    if (state.skipNextChar) { state = setState(stack, { ...state, skipNextChar: false }); continue; }
    if (word === "*") { state = setState(stack, { ...state, skipDepth: state.depth }); continue; }
    const destination = CONTROL_REPLACEMENTS[word];
    if (destination != null) out += destination;
    if (SKIP_DESTINATIONS.has(word)) state = setState(stack, { ...state, skipDepth: state.depth });
  }
  return out.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function rtfBytesToText(bytes: Uint8Array): string {
  // RTF — ASCII с `\'hh`, поэтому читать его как UTF-8 безопасно.
  return rtfSourceToText(DECODER.decode(bytes));
}
