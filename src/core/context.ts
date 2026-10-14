/**
 * Сборка контекста проекта для модели и разбор её ответа.
 *
 * Чистый модуль волны B: без invoke, без DOM, без сети — только строки.
 * Порты не нужны: всё содержимое файлов подаётся извне параметрами.
 *
 * CONTRACT (ChatScreen / AiClient):
 *   - `buildContextMessage(...)` возвращает [{role:"system"|"user", content}]
 *     для POST {base}/chat/completions; историю чата вызывающий код
 *     вставляет между system и финальным user-сообщением.
 *   - `parseModelFileEdits(reply)` вытаскивает ```file:path блоки;
 *     `stripFileEditBlocks(reply)` — остальной текст для показа в пузыре.
 *     AiClient может собрать из них свой parseModelOutput.
 *   - `toFileChanges` маппит на {path, diff} — контракт services/tauri.ts
 *     `apply_changes` (поле diff несёт ПОЛНЫЙ новый текст файла).
 */

/** Сообщение для OpenAI-compatible /chat/completions. */
export interface ContextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Одна правка файла, предложенная моделью. */
export interface FileEdit {
  /** Путь от корня проекта, прямые слэши, без ведущего «/». */
  path: string;
  /** Полный новый текст файла (не фрагмент и не diff). */
  content: string;
}

/**
 * Дерево файлов проекта на входе — максимально терпимое к форме:
 * готовая строка, список путей, узлы {name|path, children}
 * (что бы ни отдал scanner — контракт его выхода ещё у соседнего агента).
 */
export interface FileTreeNode {
  name?: string;
  path?: string;
  isDir?: boolean;
  children?: FileTreeNode[];
}

export type FileTreeInput =
  | string
  | readonly (string | FileTreeNode)[]
  | FileTreeNode
  | null
  | undefined;

/** Содержимое ключевых файлов: record, Map, пары или объекты. */
export type KeyFileContents =
  | ReadonlyMap<string, string>
  | Readonly<Record<string, string>>
  | readonly (readonly [string, string])[]
  | readonly { path: string; content: string }[]
  | null
  | undefined;

/** Дефолтный бюджет контекста в символах (фича «≤30k»). */
export const DEFAULT_CONTEXT_BUDGET = 30_000;

/** Потолок на отрисовку дерева — больше для модели только шум. */
const MAX_TREE_CHARS = 6_000;

/** Меньше этого хвоста файл не обрезаем — толку от клочка нет. */
const MIN_FILE_SLICE = 64;

const TRUNC_MARK = "…";

// ---------------------------------------------------------------------------
// Нормализация путей и дерева
// ---------------------------------------------------------------------------

/** Нормализует путь: обратные слэши → прямые, без «./» и крайних «/». */
export function normalizePath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "")
    .replace(/^\/+/, "");
}

/** Срезает «рисующие» символы дерева (├──, │, │   и т.п.) из строки. */
function stripTreeGlyphs(line: string): string {
  return line.replace(/^[\s│┃┆┊╎╏║]*(?:[├└╰]──\s*)?/, "").trim();
}

function walkNodes(
  node: FileTreeNode,
  parentPath: string,
  out: string[],
): void {
  const self = node.path !== undefined && node.path !== ""
    ? normalizePath(node.path)
    : normalizePath(node.name !== undefined && node.name !== ""
        ? parentPath === "" ? node.name : `${parentPath}/${node.name}`
        : "");
  if (self !== "") out.push(self);
  const prefix = self !== "" ? self : parentPath;
  for (const child of node.children ?? []) walkNodes(child, prefix, out);
}

/**
 * Достаёт плоский список путей из дерева любой из принятых форм.
 * Дубликаты сохраняются нормализованными; порядок — обход сверху вниз.
 */
export function fileTreePaths(tree: FileTreeInput): string[] {
  const out: string[] = [];
  if (tree == null) return out;
  if (typeof tree === "string") {
    for (const raw of tree.split("\n")) {
      const p = normalizePath(stripTreeGlyphs(raw));
      if (p !== "") out.push(p);
    }
    return out;
  }
  const list: readonly (string | FileTreeNode)[] = Array.isArray(tree)
    ? tree
    : [tree];
  for (const item of list) {
    if (typeof item === "string") {
      const p = normalizePath(item);
      if (p !== "") out.push(p);
    } else {
      walkNodes(item, "", out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Выбор ключевых файлов
// ---------------------------------------------------------------------------

/** Манифесты/конфиги корня, которые почти всегда полезны модели. */
const ROOT_MANIFESTS: Record<string, true> = {
  "package.json": true,
  "package-lock.json": true,
  "pnpm-lock.yaml": true,
  "cargo.toml": true,
  "pyproject.toml": true,
  "requirements.txt": true,
  "composer.json": true,
  "gemfile": true,
  "go.mod": true,
  "tsconfig.json": true,
  "vite.config.ts": true,
  "vite.config.js": true,
  "docker-compose.yml": true,
};

/** Точки входа в корне проекта. */
const ROOT_ENTRIES: Record<string, true> = {
  "index.html": true,
  "index.htm": true,
  "main.ts": true,
  "main.tsx": true,
  "main.js": true,
  "main.jsx": true,
  "main.py": true,
  "main.rs": true,
  "app.py": true,
  "manage.py": true,
  "server.js": true,
  "server.ts": true,
};

const README_RE = /^readme(\.[a-z0-9]+)*$/i;
const SRC_ENTRY_RE = /^(index|main|app)\.(?!(css|md|txt)$)[a-z0-9]+$/i;

/**
 * Ранг «ключевости» файла: меньше — важнее.
 * Возвращает null, если файл не ключевой.
 */
function keyFileRank(path: string): number | null {
  const depth = path.split("/").length - 1;
  const lower = path.slice(path.lastIndexOf("/") + 1).toLowerCase();

  if (depth === 0 && lower === "package.json") return 0;
  if (depth === 0 && README_RE.test(lower)) return 1;
  if (depth === 0 && ROOT_ENTRIES[lower] === true) return 2;
  if (depth === 1 && path.split("/")[0] === "src" && SRC_ENTRY_RE.test(lower))
    return 3;
  if (depth === 0 && ROOT_MANIFESTS[lower] === true) return 4;
  // Вложенные index.*/main.* и прочие README — в последнюю очередь.
  if (SRC_ENTRY_RE.test(lower) || README_RE.test(lower) || lower === "package.json")
    return 5;
  return null;
}

/**
 * Выбирает пути ключевых файлов проекта: package.json, README,
 * entry-points (index.*, src/main.* и т.п.).
 * Порядок: важность → глубина → алфавит; детерминирован.
 */
export function selectKeyFiles(
  fileTree: FileTreeInput,
  limit = 12,
): string[] {
  const paths = fileTreePaths(fileTree);
  const seen = new Set<string>();
  const picked: { path: string; rank: number; depth: number }[] = [];
  for (const raw of paths) {
    const path = normalizePath(raw);
    if (path === "") continue;
    const dedupeKey = path.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const rank = keyFileRank(path);
    if (rank !== null)
      picked.push({ path, rank, depth: path.split("/").length - 1 });
  }
  picked.sort(
    (a, b) =>
      a.rank - b.rank || a.depth - b.depth || a.path.localeCompare(b.path, "ru"),
  );
  return picked.slice(0, Math.max(0, limit)).map((f) => f.path);
}

// ---------------------------------------------------------------------------
// Обрезка под бюджет
// ---------------------------------------------------------------------------

/**
 * Обрезает текст до max символов; при обрезке добавляет «…».
 * Никогда не разрывает суррогатную пару; результат всегда ≤ max.
 */
export function truncateToBudget(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return "";
  if (max <= TRUNC_MARK.length) return text.slice(0, max);
  let end = max - TRUNC_MARK.length;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end).replace(/\s+$/, "") + TRUNC_MARK;
}

// ---------------------------------------------------------------------------
// Сборка сообщений для модели
// ---------------------------------------------------------------------------

/**
 * Системный промпт: тон «для новичка» и формат блоков правок.
 * Экспортируется отдельно — пригодится автоназванию чата и тестам.
 */
export const CONTEXT_SYSTEM_PROMPT = [
  "Ты — Грок Бот, помощник для человека, который плохо разбирается",
  "в программировании. Отвечай простым русским языком, коротко,",
  "без жаргона: сначала одно-два предложения о том, что ты делаешь.",
  "Чтобы изменить файл, выведи блок строго такого вида:",
  "```file:путь/к/файлу",
  "полный новый текст файла",
  "```",
  "Правила блоков:",
  "- путь указывай от корня проекта, прямыми слэшами, без диска,",
  "  без ведущего слэша и без «..»;",
  "- внутри блока — ВЕСЬ новый текст файла целиком, не кусок и не diff;",
  "- один блок = один файл; блоков может быть несколько или ни одного;",
  "- обычный код и команды в тексте ответа не пиши — только file-блоки;",
  "- если правки не нужны, просто ответь текстом.",
].join("\n");

interface KeyFileEntry {
  path: string;
  content: string;
}

function normalizeKeyFiles(input: KeyFileContents): KeyFileEntry[] {
  if (input == null) return [];
  if (input instanceof Map) {
    return [...input.entries()].map(([path, content]) => ({
      path: normalizePath(path),
      content,
    }));
  }
  if (Array.isArray(input)) {
    const first = input[0] as unknown;
    if (
      first !== undefined &&
      typeof first === "object" &&
      first !== null &&
      "path" in first
    ) {
      return (input as readonly { path: string; content: string }[]).map(
        (f) => ({ path: normalizePath(f.path), content: f.content }),
      );
    }
    return (input as readonly (readonly [string, string])[]).map(
      ([path, content]) => ({ path: normalizePath(path), content }),
    );
  }
  return Object.entries(input).map(([path, content]) => ({
    path: normalizePath(path),
    content,
  }));
}


/**
 * Собирает [system, user] сообщения с контекстом проекта.
 * User-сообщение гарантированно ≤ budget символов:
 * сначала режется дерево, потом хвосты файлов, в крайнем случае —
 * текст просьбы; невместившиеся файлы перечисляются строкой-заметкой.
 */
export function buildContextMessage(
  projectName: string,
  tree: FileTreeInput,
  keyFileContents: KeyFileContents,
  userText: string,
  budget: number = DEFAULT_CONTEXT_BUDGET,
): ContextMessage[] {
  const head = `Проект «${projectName}». Файлы:\n`;
  const mid = "\n\nКлючевые файлы (полное содержимое):\n";
  const tailStart = "\n\nПросьба пользователя:\n";

  let request = userText;
  let room = budget - (head + mid + tailStart).length - request.length;
  if (room < 0) {
    // Просьба сама по себе не влезает — режем её, но заголовки оставляем.
    const allowed = Math.max(0, request.length + room);
    request = truncateToBudget(request, allowed);
    room = budget - (head + mid + tailStart).length - request.length;
    if (room < 0) room = 0;
  }

  const treeAllowance = Math.min(room, MAX_TREE_CHARS);
  const renderedTree =
    typeof tree === "string"
      ? tree.trim()
      : fileTreePaths(tree)
          .sort((a, b) => a.localeCompare(b, "ru"))
          .join("\n");
  const treeText =
    truncateToBudget(renderedTree, Math.max(0, treeAllowance)) || "(пусто)";
  room -= treeText.length;

  const blocks: string[] = [];
  const skipped: string[] = [];
  for (const file of normalizeKeyFiles(keyFileContents)) {
    const header = `### ${file.path}\n`;
    const full = header + file.content;
    if (room >= full.length) {
      blocks.push(full);
      room -= full.length;
    } else {
      const slice = room - header.length;
      if (slice >= MIN_FILE_SLICE) {
        const cut = truncateToBudget(file.content, slice);
        blocks.push(header + cut);
        room -= header.length + cut.length;
      } else {
        skipped.push(file.path);
      }
    }
  }

  let skippedNote = "";
  if (skipped.length > 0) {
    skippedNote =
      `\n\nНе вошли целиком (если нужно, попроси файл отдельно): ` +
      skipped.join(", ");
    if (skippedNote.length > room) skippedNote = "";
  }

  const content =
    head +
    treeText +
    mid +
    blocks.join("\n") +
    skippedNote +
    tailStart +
    request;

  return [
    { role: "system", content: CONTEXT_SYSTEM_PROMPT },
    // Финальная страховка: инвариант «≤ budget» держится всегда.
    { role: "user", content: truncateToBudget(content, Math.max(0, budget)) },
  ];
}

// ---------------------------------------------------------------------------
// Разбор ответа модели: ```file:path блоки
// ---------------------------------------------------------------------------

const FENCE_OPEN_RE = /^(`{3,}|~{3,})\s*file\s*:\s*(.+?)\s*$/i;

/** Зарезервированные имена Windows — в них писать нельзя. */
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.[a-z0-9]+)?$/i;
const INVALID_SEG_CHARS_RE = new RegExp('[<>:"|?*\\u0000-\\u001F]');

/**
 * Проверяет и нормализует относительный путь из блока модели.
 * Отклоняет: абсолютные пути, «..», UNC, длину >512, пустые сегменты,
 * запрещённые символы и зарезервированные имена Windows.
 */
export function normalizeFileEditPath(raw: string): string | null {
  let p = raw.trim();
  if (
    p.length >= 2 &&
    ((p.startsWith('"') && p.endsWith('"')) ||
      (p.startsWith("'") && p.endsWith("'")))
  ) {
    p = p.slice(1, -1).trim();
  }
  // Одиночные «./» в начале безопасны, «../» — обязаны остаться и попасть под reject.
  p = p.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  if (p === "" || p.length > 512) return null;
  if (/^[a-zA-Z]:/.test(p)) return null; // C:\…
  if (p.startsWith("/")) return null; // абсолютный / UNC (\\→//)
  if (p.startsWith("?")) return null; // \?\-формы
  const segments = p.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return null;
    if (INVALID_SEG_CHARS_RE.test(seg)) return null;
    if (/[. ]$/.test(seg)) return null; // Windows-нелегально
    if (WIN_RESERVED_RE.test(seg)) return null;
  }
  return segments.join("/");
}

function isClosingFence(line: string, fenceChar: string, minLen: number): boolean {
  const re = fenceChar === "`" ? /^`+\s*$/ : /^~+\s*$/;
  return re.test(line) && line.trim().length >= minLen;
}

interface RawBlock {
  path: string;
  content: string;
}

function scanFileBlocks(reply: string): { blocks: RawBlock[]; textLines: string[] } {
  const lines = reply.split("\n");
  const blocks: RawBlock[] = [];
  const textLines: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = FENCE_OPEN_RE.exec(lines[i]);
    if (!m) {
      textLines.push(lines[i]);
      i++;
      continue;
    }
    const fence = m[1];
    const fenceChar = fence[0];
    let j = i + 1;
    while (j < lines.length && !isClosingFence(lines[j], fenceChar, fence.length)) {
      j++;
    }
    if (j >= lines.length) {
      // Незакрытый блок — стрим оборвался; не применяем, текст оставляем.
      textLines.push(...lines.slice(i));
      break;
    }
    const norm = normalizeFileEditPath(m[2]);
    // Битый путь — блок пропускаем, но из текста тоже убираем.
    if (norm !== null) {
      blocks.push({ path: norm, content: lines.slice(i + 1, j).join("\n") });
    }
    i = j + 1;
  }
  return { blocks, textLines };
}

/**
 * Вытаскивает из ответа модели все ```file:path блоки.
 * Невалидные пути (.., диски, UNC, абсолютные) молча отбрасываются;
 * при дубле пути побеждает последний блок. Порядок — появление в ответе.
 */
export function parseModelFileEdits(reply: string): FileEdit[] {
  const { blocks } = scanFileBlocks(reply);
  const byPath = new Map<string, FileEdit>();
  for (const b of blocks) {
    byPath.delete(b.path); // переупорядочить: last wins, сохранив порядок
    byPath.set(b.path, { path: b.path, content: b.content });
  }
  return [...byPath.values()];
}

/**
 * Текст ответа без file-блоков — то, что показывается в пузыре чата.
 * Пустые прогоны схлопываются до одной пустой строки.
 */
export function stripFileEditBlocks(reply: string): string {
  const { textLines } = scanFileBlocks(reply);
  return textLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Маппит FileEdit → {path, diff} под контракт `apply_changes`
 * в services/tauri.ts: поле diff там = «полный новый текст».
 */
export function toFileChanges(
  edits: readonly FileEdit[],
): { path: string; diff: string }[] {
  return edits.map((e) => ({ path: e.path, diff: e.content }));
}
