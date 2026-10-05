/**
 * Разбор markdown-отчёта на блоки: заголовки, абзацы, списки, таблицы.
 *
 * Таблица распознаётся двумя способами: строка, начинающаяся с `|`, либо строка
 * с табуляцией. Оба вида накапливаются в отдельные буферы, при переключении
 * типа буфер предыдущего вида выталкивается как готовый блок.
 *
 * Уровней заголовка ровно шесть — столько их в markdown. Регулярка уровней
 * 1–3 пропускала `####`, и строка падала в обычный абзац: в документе появлялся
 * `#### Пункт 2.1.1` с видимыми решётками и кеглем абзаца при правильно
 * оформленных трёх верхних уровнях, поэтому дефект не бросался в глаза.
 *
 * Маркеры `**` снимаются ОТОВСЮДУ, а не только с абзацев и списков. Заголовок и
 * ячейка таблицы в RTF печатаются жирным, в DOCX и ODT — нет, и оставленный
 * маркер попадал в подписанный отчёт как `**Итого**`. Формат не умеет жирный —
 * маркер обязан исчезнуть, а не висесть в тексте.
 *
 * Порт: Graphite Lite `ai/tools.rs:652-756`.
 */

export type ReportBlock =
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "bullet"; readonly text: string }
  | { readonly kind: "table"; readonly rows: readonly (readonly string[])[] };

export function stripBoldMarkers(text: string): string {
  return text.replaceAll("**", "");
}

function isSeparatorRow(row: readonly string[]): boolean {
  return row.every((cell) => [...cell].every((ch) => ch === "-" || ch === ":" || ch === " "));
}

function pushTable(
  blocks: ReportBlock[],
  buffer: readonly (readonly string[])[],
  keep: (row: readonly string[]) => boolean,
): void {
  const rows = buffer.filter(keep);
  if (rows.length > 0) blocks.push({ kind: "table", rows });
}

export function reportBlocks(markdown: string): ReportBlock[] {
  const blocks: ReportBlock[] = [];
  let pipe: string[][] = [];
  let tabs: string[][] = [];
  const flushPipe = (): void => {
    if (pipe.length === 0) return;
    const buffer = pipe;
    pipe = [];
    pushTable(blocks, buffer, (row) => !isSeparatorRow(row));
  };
  const flushTabs = (): void => {
    if (tabs.length === 0) return;
    const buffer = tabs;
    tabs = [];
    pushTable(blocks, buffer, (row) => row.some((cell) => cell.trim().length > 0));
  };

  for (const raw of markdown.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("|")) {
      flushTabs();
      pipe.push(
        trimmed
          .replace(/^\|+/, "")
          .replace(/\|+$/, "")
          .split("|")
          .map((cell) => stripBoldMarkers(cell.trim())),
      );
      continue;
    }
    if (raw.includes("\t")) {
      flushPipe();
      tabs.push(raw.split("\t").map((cell) => stripBoldMarkers(cell.trim())));
      continue;
    }
    flushPipe();
    flushTabs();
    if (trimmed.length === 0 || trimmed.startsWith("---")) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading !== null) {
      blocks.push({
        kind: "heading",
        level: (heading[1] as string).length,
        text: stripBoldMarkers(heading[2] as string),
      });
      continue;
    }
    if (trimmed.startsWith("> ")) {
      blocks.push({ kind: "paragraph", text: trimmed.slice(2) });
      continue;
    }
    if (trimmed.startsWith("- ")) {
      blocks.push({ kind: "bullet", text: stripBoldMarkers(trimmed.slice(2)) });
      continue;
    }
    blocks.push({ kind: "paragraph", text: stripBoldMarkers(trimmed) });
  }
  flushPipe();
  flushTabs();
  return blocks;
}
