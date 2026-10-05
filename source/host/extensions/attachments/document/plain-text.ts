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

import { PlainTextCollector } from "./xml.js";

export interface DecodedText {
  readonly text: string;
  readonly encoding: string;
  readonly confidence: number;
}

const JSDETECT_TO_ICONV: Readonly<Record<string, string>> = {
  "ascii": "ascii", "utf-8": "utf8", "utf8": "utf8",
  "windows-1251": "win1251", "windows-1252": "win1252", "windows-1250": "win1250", "windows-1253": "win1253", "windows-1254": "win1254",
  "iso-8859-1": "latin1", "iso-8859-2": "iso88592", "iso-8859-5": "iso88595", "iso-8859-7": "iso88597",
  "iso-8859-15": "latin9", "koi8-r": "koi8-r", "koi8-u": "koi8-u", "ibm866": "cp866",
  // `jschardet` для русского текста часто называет `x-mac-cyrillic`. Это
  // отдельная кодировка, а не windows-1251: раньше она подменялась на cp1251,
  // и первые буквы файла терялись.
  "x-mac-cyrillic": "maccyrillic", "maccyrillic": "maccyrillic", "maccyrillic-utf8": "maccyrillic",
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

/** Кириллица плюс `ё` с прописной и строчной. */
function isCyrillicCode(code: number): boolean {
  return (code >= 0x410 && code <= 0x44f) || code === 0x401 || code === 0x451;
}

/**
 * Буквы, которые в русском тексте почти не встречаются. Ими набиваются неверные
 * расшифровки: `Фонд` в ISO-8859-5, прочитанный как windows-1251, даёт `ДЮЭФ` —
 * три настоящие русские буквы, но ни одного настоящего слова.
 */
const RARE_CYRILLIC: ReadonlySet<string> = new Set(["ъ", "ё", "э", "ю", "я", "ў", "ѓ"]);

/** Насколько образец похож на русский текст в одной-байтовой кодировке. */
const CYRILLIC_ENCODINGS: readonly string[] = ["win1251", "cp866", "koi8-r", "koi8-u", "iso88595", "maccyrillic"];

/** Ниже этой доли старших байт текст считается западноевропейским, а не русским. */
const CYRILLIC_HIGH_BYTE_RATIO = 0.25;
/** Сколько символов разбирается при оценке: длинный текст оценивать незачем. */
const SCORE_SAMPLE_CHARS = 4_096;
/** Насколько одно слово из словаря повышает оценку. */
const WORD_BONUS = 2.2;
/** Оценка, ниже которой расшифровка считается мусором. */
const MIN_CYRILLIC_SCORE = 0.55;
/** Насколько близкие оценки решаются в пользу подсказки `jschardet`. */
const HINT_TIE_MARGIN = 0.3;

/**
 * Словарь для проверки «прочиталось ли осмысленно». Не морфология: только слова,
 * которые бот и так знает по должности — библиотека, фонд, заседание, протокол.
 * Их хватает, чтобы отличить настоящий русский текст от похожей на него каши.
 */
const KNOWN_WORDS: ReadonlySet<string> = new Set([
  "и", "в", "во", "не", "что", "он", "на", "я", "с", "со", "как", "а", "то", "все", "она",
  "так", "его", "но", "да", "ты", "к", "у", "же", "вы", "за", "бы", "по", "только", "ее",
  "мне", "было", "вот", "от", "меня", "еще", "нет", "о", "из", "ему", "теперь", "когда",
  "даже", "ну", "ли", "если", "уже", "или", "ни", "быть", "был", "него", "до",
  "вас", "нибудь", "опять", "уж", "вам", "ведь", "там", "потом", "себя", "ничего", "ей",
  "может", "они", "тут", "где", "есть", "надо", "ней", "для", "мы", "тебя", "их", "чем",
  "была", "сам", "чтоб", "без", "чего", "раз", "тоже", "себе", "под", "будет",
  "тогда", "кто", "этот", "того", "потому", "этого", "какой", "совсем", "ним",
  "здесь", "этом", "один", "почти", "мой", "тем", "чтобы", "нее", "были", "куда", "зачем",
  "всех", "никогда", "можно", "при", "наконец", "два", "об", "другой", "хоть", "после",
  "над", "больше", "тот", "через", "эти", "нас", "про", "всего", "них", "какая", "много",
  "разве", "три", "эту", "моя", "свою", "этой", "перед", "иногда", "лучше",
  "чуть", "том", "нельзя", "такой", "им", "более", "всегда", "конечно", "всю", "между",
  "библиотека", "библиотеки", "библиотеке", "библиотеку", "библиотекой", "фонд", "фонда",
  "зал", "зала", "читаль", "читателя", "читателей", "читателю", "книг", "книга", "книги",
  "книгу", "книге", "книжный", "экземпляр", "экземпляров", "выдача", "выдачи", "абонемент",
  "заведующая", "заведующей", "заведующую", "директор", "директора", "совещание", "совещания",
  "заседание", "заседания", "протокол", "протокола", "протоколы", "повестка", "повестки",
  "решение", "решения", "принято", "слушали", "постановили", "отчёт", "отчет", "год",
  "года", "году", "дата", "даты", "число", "количество", "сумма", "рублей", "руб",
  "работа", "работы", "работе", "работают", "план", "плана", "мероприятие", "мероприятия",
  "выставка", "выставки", "экскурсия", "экскурсии", "встреча", "встречи", "занятие",
  "занятия", "кружок", "кружки", "клуб", "клубы", "праздник", "праздника",
  "январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь",
  "октябрь", "ноябрь", "декабрь", "приказ", "приказа", "служба", "службы", "отдел", "отдела",
  "родитель", "родители", "ребёнок", "ребенок", "ребенка", "детей", "дети", "детский",
  "детская", "школа", "школы", "класс", "класса", "урок", "уроки", "занятость",
  "посетитель", "посетителей", "пользователь", "пользователей", "библиотекарь",
  "библиотекаря", "электронный", "электронная", "сайт", "почта", "телефон", "интернет",
  "компьютер", "программа", "программы", "система", "системы", "область", "город",
  "города", "улица", "дом", "дома", "штука", "штук", "лист", "листа", "номер", "номера",
  "позиция", "позиции", "позиций", "название", "названия", "автор", "авторы",
  "издательство", "бумага", "бумаги", "тип", "типография", "замена", "списания",
  "поступления", "списание", "инвентарь", "инвентарный", "штрих", "приход", "расход",
  "остаток", "движение", "оборотно", "ведомость", "выгрузка", "выгрузки", "таблица",
  "таблицы", "столбец", "строки", "строка", "ячейка", "итого", "всего", "месяц",
  "поступление", "сверить", "сверка", "ошибка", "ошибки", "фио", "иванов", "петрова",
  "сидорова", "алексеев", "николаев", "родительский",
]);

/**
 * Доля старших байт среди всех печатных. У русского текста в однобайтовой
 * кодировке почти каждая буква лежит выше 0x7F, а у немецкого или французского
 * текста старшие байты — редкие буквы с диакритикой среди латиницы.
 */
function highByteRatio(bytes: Uint8Array): number {
  let high = 0;
  let total = 0;
  for (const byte of bytes) {
    if (byte >= 0x80) { high += 1; total += 1; }
    else if (byte >= 0x20) total += 1;
  }
  return total === 0 ? 0 : high / total;
}

function knownWordBonus(text: string): number {
  let bonus = 0;
  for (const token of text.split(/[^Ѐ-ӿ]+/)) {
    if (token.length < 2) continue;
    if (KNOWN_WORDS.has(token.toLowerCase())) bonus += WORD_BONUS;
  }
  return bonus;
}

/**
 * Оценка одной расшифровки: русская буква приносит единицу, буква из
 * `RARE_CYRILLIC` — четверть, пробел — половину, знаки и прочее — минус. Нет ни
 * одной русской буквы — минус сто: лучше не угадывать вовсе.
 */
function cyrillicScore(text: string, digits: number): number {
  let sum = 0;
  let count = 0;
  let letters = 0;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    count += 1;
    if (isCyrillicCode(code)) { sum += RARE_CYRILLIC.has(char.toLowerCase()) ? 0.25 : 1; letters += 1; continue; }
    if (char === " " || char === "\n" || char === "\r" || char === "\t") { sum += 0.5; continue; }
    // Цифры в русском тексте обычны: даты, суммы, номера книг. Обнулять их
    // нельзя, иначе «Тюмень 2026 2025» не набирает оценки и отдаётся греческому.
    if (code >= 48 && code <= 57) { sum += 0.3; continue; }
    sum -= 1.5;
  }
  if (count === 0 || letters === 0) return -100;
  return sum / count + knownWordBonus(text) + (digits >= 2 ? 0.15 : 0);
}

/**
 * Выбор кодировки русского текста: пробуем все однобайтовые и берём ту, чей
 * текст больше всего похож на русский. `jschardet` на коротких файлах уверенно
 * называет windows-1252 даже там, где текст на cp866 или ISO-8859-5, поэтому
 * решает не он, а сравнение расшифровок; его вывод берётся только при почти
 * равных оценках.
 */
function pickCyrillicEncoding(sample: Uint8Array, hinted: string | null): string | null {
  const latinView = decodeWith(sample.subarray(0, 2_048), "latin1");
  const digits = (latinView.match(/\d/g) ?? []).length;
  let best: string | null = null;
  let bestScore = -Infinity;
  let hintedScore = -Infinity;
  for (const encoding of CYRILLIC_ENCODINGS) {
    const score = cyrillicScore(decodeWith(sample, encoding).slice(0, SCORE_SAMPLE_CHARS), digits);
    if (score > bestScore) { bestScore = score; best = encoding; }
    if (hinted != null && encoding === hinted) hintedScore = score;
  }
  if (best == null || bestScore < MIN_CYRILLIC_SCORE) return null;
  if (hintedScore >= bestScore - HINT_TIE_MARGIN) return hinted;
  return best;
}

/**
 * Западноевропейская однобайтовая кодировка для текста, где кириллицы нет.
 * Возвращается `null`, если в образце есть байты 0x80..0x9F: в латинице там
 * ничего не бывает, значит файл не западноевропейский текст.
 */
function pickWesternEncoding(sample: Uint8Array): string | null {
  const size = Math.min(sample.length, 1_024);
  for (let index = 0; index < size; index += 1) {
    const byte = sample[index] as number;
    if (byte >= 0x80 && byte < 0xa0) return null;
  }
  return "win1252";
}

/**
 * UTF-16, у которого может не быть метки порядка байтов. Проверять это надо до
 * `looksLikeBinary`: нули в файле — не признак двоичного файла, а признак UTF-16.
 *
 * Признак — не «нули через букву», а одинаковый малый старший байт: у русской
 * буквы в UTF-16LE пара `0x11 0x04`, у латинской `0x65 0x00`. Раньше считались
 * только пары с нулевым байтом, и короткий русский текст без пробелов и цифр
 * («Библиотека работает») порог не проходил: нулей в нём нет вообще.
 *
 * Файл из одних переводов строк и пробелов даёт пары `0D 0A`, `20 0D`, `0A 20`:
 * малых байтов много, а одинакового старшего байта нет. Поэтому отсекает не
 * «сколько пар», а доля одного значения старшего байта и их число.
 */
export function utf16Flavour(bytes: Uint8Array): "utf16-le" | "utf16-be" | null {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf16-le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf16-be";
  const sample = bytes.subarray(0, Math.min(bytes.length, 4_096));
  const littleHigh = new Map<number, number>();
  const bigHigh = new Map<number, number>();
  let pairs = 0;
  for (let index = 0; index + 1 < sample.length; index += 2) {
    const first = sample[index] as number;
    const second = sample[index + 1] as number;
    pairs += 1;
    if (second <= 0x1f) littleHigh.set(second, (littleHigh.get(second) ?? 0) + 1);
    if (first <= 0x1f) bigHigh.set(first, (bigHigh.get(first) ?? 0) + 1);
  }
  if (pairs < 2) return null;
  const uniform = (histogram: Map<number, number>): number | null => {
    if (histogram.size === 0 || histogram.size > 4) return null;
    let top = 0;
    for (const count of histogram.values()) top = Math.max(top, count);
    return top >= pairs * 0.5 ? top : null;
  };
  const little = uniform(littleHigh);
  const big = uniform(bigHigh);
  if (little != null && (big == null || little >= big)) return "utf16-le";
  if (big != null) return "utf16-be";
  return null;
}

/**
 * U+FEFF — невидимый знак. В начале файла это метка кодировки, в середине —
 * след склейки двух выгрузок в Windows (`copy a.csv + b.csv`). В текст модели
 * он не должен попадать нигде.
 */
function dropZeroWidthMarks(text: string): string {
  return text.includes("﻿") ? text.replaceAll("﻿", "") : text;
}

 /**
 * Определяет кодировку и декодирует. Порядок: BOM, потом UTF-16 без метки,
 * потом настоящий UTF-8, потом `jschardet` вместе со сравнением однобайтовых
 * расшифровок. Русские документы чаще в windows-1251, cp866 или ISO-8859-5, чем
 * в windows-1252, который `jschardet` выдаёт уверенно и неверно.
 */
export function decodeTextBytes(bytes: Uint8Array, hintedEncoding?: string | null): DecodedText {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: dropZeroWidthMarks(new TextDecoder("utf-8").decode(bytes)), encoding: "utf-8", confidence: 1 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decodeWith(bytes, "utf16-le"), encoding: "utf-16le", confidence: 1 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decodeWith(bytes, "utf16-be"), encoding: "utf-16be", confidence: 1 };
  }
  const utf16 = utf16Flavour(bytes);
  if (utf16 != null) {
    return { text: decodeWith(bytes, utf16), encoding: utf16 === "utf16-le" ? "utf-16le" : "utf16-be", confidence: 0.85 };
  }
  if (hintedEncoding != null && hintedEncoding.length > 0) {
    const mapped = JSDETECT_TO_ICONV[hintedEncoding.toLowerCase()] ?? hintedEncoding;
    if (isUnverifiedUtf16Label(hintedEncoding) && utf16 == null) {
      // Подсказка говорит «UTF-16», а проверка не подтверждает: так выглядит
      // файл из одних пробелов и переводов строк, который иначе декодировался бы
      // в иероглифы и ушёл бы в модель «текстом».
    } else if (iconv.encodingExists(mapped)) {
      return { text: decodeWith(bytes, mapped), encoding: mapped, confidence: 0.9 };
    }
  }
  if (looksLikeUtf8(bytes)) return { text: dropZeroWidthMarks(new TextDecoder("utf-8").decode(bytes)), encoding: "utf-8", confidence: 0.8 };

  const sample = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
  const detected = jschardet.detect(Buffer.from(sample));
  const label = (detected.encoding ?? "").toLowerCase();
  const confidence = typeof detected.confidence === "number" ? detected.confidence : 0;
  const mapped = JSDETECT_TO_ICONV[label];
  const guessed = mapped != null && iconv.encodingExists(mapped) ? mapped : null;
  // `jschardet` называет UTF-16 и файлы без единого слова — одни пробелы и
  // переводы строк. Такую подсказку берём только вместе с проверкой `utf16Flavour`.
  const trustedGuess = isUnverifiedUtf16Label(label) && utf16 == null ? null : guessed;
  if (highByteRatio(sample) >= CYRILLIC_HIGH_BYTE_RATIO) {
    const cyrillic = pickCyrillicEncoding(sample, trustedGuess);
    if (cyrillic != null) return { text: decodeWith(bytes, cyrillic), encoding: cyrillic, confidence: Math.max(confidence, 0.5) };
  }
  if (trustedGuess != null && CYRILLIC_ENCODINGS.includes(trustedGuess)) {
    // `jschardet` назвал кириллицу там, где кириллицы нет: так он читает немецкий
    // текст в windows-1252 и русский в maccyrillic. Сначала проверяем, похож ли
    // текст на русский, и только потом верим подсказке.
    const cyrillic = pickCyrillicEncoding(sample, trustedGuess);
    if (cyrillic != null) return { text: decodeWith(bytes, cyrillic), encoding: cyrillic, confidence: Math.max(confidence, 0.5) };
    const western = pickWesternEncoding(sample);
    if (western != null) return { text: decodeWith(bytes, western), encoding: western, confidence: 0.5 };
  }
  if (trustedGuess != null && confidence >= 0.4) {
    return { text: decodeWith(bytes, trustedGuess), encoding: trustedGuess, confidence };
  }
  const cyrillic = pickCyrillicEncoding(sample, trustedGuess);
  if (cyrillic != null) return { text: decodeWith(bytes, cyrillic), encoding: cyrillic, confidence: 0.5 };
  return { text: decodeWith(bytes, "win1252"), encoding: "win1252", confidence: 0.3 };
}

/** UTF-16 без метки порядка байтов: верить такой подсказке можно только после проверки байтов. */
function isUnverifiedUtf16Label(label: string): boolean {
  const lower = label.toLowerCase();
  return lower.includes("utf-16") || lower === "utf16" || lower === "ucs-2";
}

function decodeWith(bytes: Uint8Array, encoding: string): string {
  try {
    return iconv.decode(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), encoding);
  } catch {
    return dropZeroWidthMarks(new TextDecoder("utf-8").decode(bytes));
  }
}

/**
 * HTML, XML и SVG: убираем разметку, оставляем текст и разрывы абзацев.
 *
 * Один проход, а не одиннадцать `replace`. Страница на 25 МБ раньше стоила
 * 347 МБ памяти процесса: каждая замена создавала ещё одну копию строки, а
 * `split` по пробелам на тексте из одних слов превращал его в миллионы мелких
 * строк. Теперь исходная строка читается один раз, а результат собирается в
 * список кусков и склеивается в конце.
 */
const SKIPPED_HTML_BLOCKS = new Set(["script", "style", "head"]);
const NEWLINE_HTML_TAGS = new Set([
  "p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "table", "blockquote",
]);
const TAB_HTML_TAGS = new Set(["td", "th"]);
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", laquo: "«", raquo: "»", mdash: "—", ndash: "–",
};

function decodeEntities(chunk: string): string {
  if (!chunk.includes("&")) return chunk;
  return chunk.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1] === "x" || entity[1] === "X"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Конец тега `>`, если он не внутри кавычек значения атрибута. */
function findHtmlTagEnd(markup: string, open: number): number {
  let quote = "";
  for (let index = open + 1; index < markup.length; index += 1) {
    const char = markup[index] as string;
    if (quote !== "") { if (char === quote) quote = ""; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === ">") return index + 1;
  }
  return -1;
}

export function markupToText(markup: string): string {
  const collector = new PlainTextCollector();
  let index = 0;
  while (index < markup.length) {
    const open = markup.indexOf("<", index);
    if (open < 0) { collector.pushText(decodeEntities(markup.slice(index))); break; }
    if (open > index) collector.pushText(decodeEntities(markup.slice(index, open)));
    if (markup.startsWith("<!--", open)) {
      const close = markup.indexOf("-->", open + 4);
      index = close < 0 ? markup.length : close + 3;
      collector.pushText(" ");
      continue;
    }
    const closing = markup[open + 1] === "/";
    const nameMatch = /^<?\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(markup.slice(open, open + 40));
    const name = (nameMatch?.[1] ?? "").toLowerCase();
    if (name !== "" && !closing && SKIPPED_HTML_BLOCKS.has(name)) {
      // Поиск через регулярку, а не через `markup.toLowerCase()`: на файле в
      // 48 МБ копия строки стоит столько же, сколько весь разбор.
      const closer = new RegExp(`</${name}`, "i");
      closer.lastIndex = open + 1;
      const found = closer.exec(markup);
      const closeAt = found?.index ?? -1;
      const closeEnd = closeAt < 0 ? -1 : findHtmlTagEnd(markup, closeAt);
      index = closeEnd < 0 ? markup.length : closeEnd;
      collector.pushText(" ");
      continue;
    }
    const tagEnd = findHtmlTagEnd(markup, open);
    if (tagEnd < 0) { collector.pushText(decodeEntities(markup.slice(open))); break; }
    if (name === "br" || name === "hr") collector.pushNewline();
    else if (!closing && TAB_HTML_TAGS.has(name)) collector.pushTab();
    else if (closing && NEWLINE_HTML_TAGS.has(name)) collector.pushNewline();
    index = tagEnd;
  }
  return collector.toString();
}
