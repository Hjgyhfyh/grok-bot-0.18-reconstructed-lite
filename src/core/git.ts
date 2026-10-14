/**
 * src/core/git.ts — чистая логика git-статуса и отката.
 *
 * Модуль не знает ни про Tauri, ни про Node: git вызывается через порт
 * {@link GitPort}, реализацию которого вернёт Rust-адаптер
 * (src-tauri/src/commands.rs). В тестах порт подменяется на
 * node:child_process или на стаб, бросающий ENOENT («git отсутствует»).
 *
 * Никакая функция не бросает исключений на данных от git: любой сбой
 * порта или ненулевой exit-код → безопасный результат
 * (false / 'none' / null), а не throw.
 */

// ─── Порт ───────────────────────────────────────────────────────────

/** Результат одного запуска процесса git. */
export interface GitRun {
  /** exit-код процесса; 0 = успех, ненулевой — не ошибка порта. */
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * CONTRACT: порт выполнения git — реализует Rust-адаптер поверх
 * std::process::Command (см. src-tauri/src/commands.rs):
 *  - резолвится при ЛЮБОМ exit-коде;
 *  - бросает, только если процесс не удалось запустить (ENOENT — git
 *    не установлен) или адаптер убил его по таймауту (~10 с);
 *  - stdout/stderr приходят UTF-8-строками (допустимо lossy);
 *  - cwd — рабочая папка команды (проект); для isGitAvailable не важна.
 */
export interface GitPort {
  run(cmd: string, args: string[], cwd?: string): Promise<GitRun>;
}

// ─── Парсер `git status --porcelain` ────────────────────────────────

/** Одна запись `git status --porcelain` (v1, обычный и -z формат). */
export interface PorcelainEntry {
  /** Путь файла; для переименования/копии — новый путь. */
  path: string;
  /** Исходный путь для R/C-записей. */
  origPath?: string;
  /** Статус индекса (X): ' ', 'M', 'A', 'D', 'R', 'C', 'U', 'T', '?', '!'. */
  x: string;
  /** Статус рабочей копии (Y), тот же алфавит. */
  y: string;
  /** Изменение уже в индексе (x — не пробел, не '?', не '!'). */
  staged: boolean;
  /** Файл не отслеживается git'ом (??). */
  untracked: boolean;
  /** Неразрешённый конфликт слияния (U*, *U, AA, DD). */
  unmerged: boolean;
}

export interface StatusSummary {
  /** Есть любые изменения: staged, unstaged или untracked. */
  dirty: boolean;
  /** Есть файлы в индексе. */
  staged: boolean;
  /** Есть неотслеживаемые файлы. */
  untracked: boolean;
  /** Значимые записи; строки '!!' (ignored) и '##' (заголовок ветки) отброшены. */
  files: PorcelainEntry[];
}

const UNMERGED: Record<string, true> = {
  DD: true, AA: true, UU: true,
  AU: true, UA: true, DU: true, UD: true,
};

const utf8 = new TextEncoder();

/** Пары статусов X/Y, при которых поле пути имеет вид «orig -> new». */
function isRenameStatus(x: string, y: string): boolean {
  return x === "R" || x === "C" || y === "R" || y === "C";
}

/**
 * Снимает C-кавычки с пути из porcelain-вывода: "...\" \n \t \NNN".
 * Восьмеричные эскейпы — байты UTF-8 (кириллица при core.quotepath=true).
 * Строка без обрамляющих кавычек возвращается как есть.
 */
export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') {
    return raw;
  }
  const inner = raw.slice(1, -1);
  const bytes: number[] = [];
  const pushStr = (s: string) => {
    for (const b of utf8.encode(s)) bytes.push(b);
  };
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== "\\") {
      pushStr(ch);
      continue;
    }
    if (i + 1 >= inner.length) {
      bytes.push(0x5c); // висячий '\' в конце — как есть
      break;
    }
    const n = inner[i + 1];
    if (n >= "0" && n <= "7") {
      let oct = n;
      i++;
      while (
        oct.length < 3 &&
        i + 1 < inner.length &&
        inner[i + 1] >= "0" &&
        inner[i + 1] <= "7"
      ) {
        oct += inner[i + 1];
        i++;
      }
      bytes.push(parseInt(oct, 8) & 0xff);
      continue;
    }
    i++;
    switch (n) {
      case "a": bytes.push(0x07); break;
      case "b": bytes.push(0x08); break;
      case "t": bytes.push(0x09); break;
      case "n": bytes.push(0x0a); break;
      case "v": bytes.push(0x0b); break;
      case "f": bytes.push(0x0c); break;
      case "r": bytes.push(0x0d); break;
      case '"': bytes.push(0x22); break;
      case "\\": bytes.push(0x5c); break;
      default: pushStr(n); break; // неизвестный эскейп — символ как есть
    }
  }
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

/**
 * Разрезает поле пути «orig -> new» для R/C-записей.
 * Разделитель ищется только вне кавычек («weird -> name» в кавычках
 * не ломает разбор).
 */
function splitRenameField(field: string): [string, string | undefined] {
  let inQ = false;
  for (let i = 0; i + 3 < field.length; i++) {
    const c = field[i];
    if (inQ) {
      if (c === "\\") i++;
      else if (c === '"') inQ = false;
      continue;
    }
    if (c === '"') {
      inQ = true;
      continue;
    }
    if (field.startsWith(" -> ", i)) {
      return [field.slice(0, i), field.slice(i + 4)];
    }
  }
  return [field, undefined];
}

function pushEntry(
  out: PorcelainEntry[],
  x: string,
  y: string,
  path: string,
  origPath?: string,
): void {
  if (path === "") return;
  if (x === "!" && y === "!") return; // ignored — не изменение
  if (x === "#" && y === "#") return; // заголовок ветки (--branch)
  out.push({
    path,
    origPath,
    x,
    y,
    staged: x !== " " && x !== "?" && x !== "!",
    untracked: x === "?" && y === "?",
    unmerged: UNMERGED[x + y] === true,
  });
}

/**
 * Разбирает вывод `git status --porcelain` (v1).
 * Поддерживает оба формата: строчный (пути могут быть в C-кавычках с
 * \NNN-эскейпами UTF-8) и NUL-разделённый (-z: без кавычек, переименование
 * — два соседних поля «новый\0исходный»).
 * Никогда не бросает: мусорные строки пропускаются, пустой ввод → clean.
 */
export function parseStatusPorcelain(text: string): StatusSummary {
  const files: PorcelainEntry[] = [];

  if (text.includes("\0")) {
    // Формат -z: поля через NUL, у R/C исходный путь — следующее поле.
    const fields = text.split("\0");
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (f.length < 4) continue;
      const x = f[0];
      const y = f[1];
      let origPath: string | undefined;
      if (isRenameStatus(x, y)) {
        const next = fields[++i];
        if (next !== undefined && next !== "") origPath = next;
      }
      pushEntry(files, x, y, f.slice(3), origPath);
    }
  } else {
    for (const rawLine of text.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.length < 4) continue;
      const x = line[0];
      const y = line[1];
      const field = line.slice(3); // пропускаем «XY »
      if (isRenameStatus(x, y)) {
        // Строка R/C: «исходный -> новый»; entry.path — новый путь.
        const [from, to] = splitRenameField(field);
        if (to === undefined) {
          pushEntry(files, x, y, unquoteGitPath(field));
        } else {
          pushEntry(files, x, y, unquoteGitPath(to), unquoteGitPath(from));
        }
      } else {
        pushEntry(files, x, y, unquoteGitPath(field));
      }
    }
  }

  let staged = false;
  let untracked = false;
  for (const f of files) {
    staged ||= f.staged;
    untracked ||= f.untracked;
  }
  return { dirty: files.length > 0, staged, untracked, files };
}

// ─── Операции через порт ────────────────────────────────────────────

/** Статус рабочей копии: 'none' — не репозиторий или git недоступен. */
export type WorktreeStatus = "clean" | "dirty" | "none";

/**
 * Выполняет git-команду; сбой порта (нет git, таймаут) → null.
 * Ненулевой exit — НЕ null, а {code: n, ...}: разбор — у вызывающего.
 */
async function runGit(
  port: GitPort,
  args: string[],
  cwd?: string,
): Promise<GitRun | null> {
  try {
    return await port.run("git", args, cwd);
  } catch {
    return null;
  }
}

/** Установлен ли git на машине (`git --version`). */
export async function isGitAvailable(port: GitPort): Promise<boolean> {
  const r = await runGit(port, ["--version"]);
  return r !== null && r.code === 0;
}

/**
 * Папка — рабочая копия git-репозитория (`git -C path rev-parse
 * --is-inside-work-tree`). Bare-репозиторий → false (для проекта это
 * «не git», откат пойдёт через бэкап). Нет git / ошибка → false.
 */
export async function isGitRepo(port: GitPort, path: string): Promise<boolean> {
  const r = await runGit(port, ["-C", path, "rev-parse", "--is-inside-work-tree"]);
  return r !== null && r.code === 0 && r.stdout.trim() === "true";
}

/**
 * Карточный статус проекта: 'clean' | 'dirty' | 'none'.
 * 'none' — git недоступен, папка не репозиторий или команда упала.
 */
export async function status(
  port: GitPort,
  path: string,
): Promise<WorktreeStatus> {
  const r = await runGit(port, [
    "-C", path,
    "-c", "core.quotepath=false",
    "status", "--porcelain",
  ]);
  if (r === null || r.code !== 0) return "none";
  return parseStatusPorcelain(r.stdout).dirty ? "dirty" : "clean";
}

/** То же, что status(), но возвращает полный разбор (null при сбое). */
export async function statusPorcelain(
  port: GitPort,
  path: string,
): Promise<StatusSummary | null> {
  const r = await runGit(port, [
    "-C", path,
    "-c", "core.quotepath=false",
    "status", "--porcelain",
  ]);
  if (r === null || r.code !== 0) return null;
  return parseStatusPorcelain(r.stdout);
}

/**
 * Unix-ms последнего коммита (`git log -1 --format=%ct`).
 * Коммитов нет (unborn), не репозиторий, нет git → null;
 * вызывающий тогда падает обратно на max(mtime) файлов.
 */
export async function lastCommitTime(
  port: GitPort,
  path: string,
): Promise<number | null> {
  const r = await runGit(port, ["-C", path, "log", "-1", "--format=%ct"]);
  if (r === null || r.code !== 0) return null;
  const sec = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(sec) ? sec * 1000 : null;
}

/**
 * Откат «как было до ответа» в git-проекте: `git checkout -- .`
 * ВАЖНО: untracked-файлы checkout не удаляет — это поведение референса.
 * Успех → true; ненулевой exit, нет git, таймаут → false.
 */
export async function checkoutAll(
  port: GitPort,
  path: string,
): Promise<boolean> {
  const r = await runGit(port, ["-C", path, "checkout", "--", "."]);
  return r !== null && r.code === 0;
}

/** remote.origin.url репозитория (для extractRepoName); null при сбое. */
export async function remoteUrl(
  port: GitPort,
  path: string,
): Promise<string | null> {
  const r = await runGit(port, ["-C", path, "config", "--get", "remote.origin.url"]);
  if (r === null || r.code !== 0) return null;
  const url = r.stdout.trim();
  return url === "" ? null : url;
}

/**
 * Набор git-операций с уже привязанным портом — контракт вызовов
 * из тест-плана §5; единый интерфейс для адаптеров и экранов.
 */
export interface GitOps {
  isGitAvailable(): Promise<boolean>;
  isGitRepo(path: string): Promise<boolean>;
  status(path: string): Promise<WorktreeStatus>;
  statusPorcelain(path: string): Promise<StatusSummary | null>;
  lastCommitTime(path: string): Promise<number | null>;
  checkoutAll(path: string): Promise<boolean>;
  remoteUrl(path: string): Promise<string | null>;
}

export function createGitOps(port: GitPort): GitOps {
  return {
    isGitAvailable: () => isGitAvailable(port),
    isGitRepo: (path: string) => isGitRepo(port, path),
    status: (path: string) => status(port, path),
    statusPorcelain: (path: string) => statusPorcelain(port, path),
    lastCommitTime: (path: string) => lastCommitTime(port, path),
    checkoutAll: (path: string) => checkoutAll(port, path),
    remoteUrl: (path: string) => remoteUrl(port, path),
  };
}

/**
 * Подпись @tauri-apps/api/core invoke — объявлена структурно, чтобы
 * модуль оставался чистым (без импорта Tauri).
 */
export type InvokeFn = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Адаптер к Rust-команде `git_run(args, cwd)` из src-tauri/commands.rs.
 * cmd игнорируется: Rust-сторона сама запускает бинарь "git".
 * Проводка: `createGitOps(tauriGitPort(invoke))`.
 */
export function tauriGitPort(invoke: InvokeFn): GitPort {
  return {
    run(_cmd, args, cwd) {
      return invoke("git_run", { args, cwd: cwd ?? null }) as Promise<GitRun>;
    },
  };
}

// ─── Решения об откате ──────────────────────────────────────────────

/**
 * Кнопка «Отменить изменения» доступна: git-проект откатывается
 * checkout'ом всегда, не-git — только если есть живой бэкап
 * `.grok-backup-*`.
 */
export function canRollback(isRepo: boolean, hasBackup: boolean): boolean {
  return isRepo || hasBackup;
}

export type RollbackPlan = "git-checkout" | "restore-backup" | "none";

/**
 * Каким механизмом откатывать проект.
 * isRepo: true → `git checkout -- .`; false → восстановление из бэкапа;
 * null/undefined (состояние git неизвестно — напр. проверка ещё идёт)
 * → 'none', решение принимать рано.
 * Отсутствие бэкапа сюда не подаётся: это забота canRollback + UI.
 */
export function planRollback(isRepo: boolean | null | undefined): RollbackPlan {
  if (isRepo === true) return "git-checkout";
  if (isRepo === false) return "restore-backup";
  return "none";
}

// ─── Имя репозитория из remote URL ──────────────────────────────────

/**
 * Имя репозитория из remote-ссылки — для подписи в UI:
 *   'https://github.com/user/repo.git' → 'repo'
 *   'git@github.com:user/repo'         → 'repo'
 *   'ssh://git@h/u/r.git', 'file:///d/r', 'C:\\p\\r' → 'r'/'repo'
 * Пустая/бессмысленная строка → null.
 */
export function extractRepoName(remoteUrl: string): string | null {
  let s = remoteUrl.trim();
  if (!s) return null;
  const h = s.indexOf("#");
  if (h >= 0) s = s.slice(0, h);
  const q = s.indexOf("?");
  if (q >= 0) s = s.slice(0, q);
  s = s.replace(/[/\\]+$/, ""); // trailing слэши
  if (!s) return null;
  // Последний сегмент: разделители '/', '\' и ':' (scp-синтаксис
  // 'host:path/repo', Windows-диски).
  const seg = s.split(/[/\\:]/).filter((p) => p !== "").pop() ?? "";
  let name = seg;
  if (name.toLowerCase().endsWith(".git")) name = name.slice(0, -4);
  name = name.trim();
  return name === "" ? null : name;
}

// ─── Защита путей для applyChanges ──────────────────────────────────

export type PathClass = "inside" | "outside" | "traversal";

/**
 * Классифицирует относительный путь из изменения файла — можно ли
 * присоединять его к корню проекта:
 *  - 'inside'    — обычный относительный путь, остаётся в корне;
 *  - 'outside'   — абсолютный/укоренённый путь (диск 'X:', UNC '\\',
 *                  '/', device '\\?\\') или содержит ':' (ADS);
 *  - 'traversal' — сегмент '..' (любая попытка выйти из корня),
 *                  NUL-байт, пустая/пробельная строка.
 * Всё, что не 'inside', applyChanges отклоняет без побочных эффектов.
 * Заметь: 'a/../b' → 'traversal', хотя после нормализации остался бы
 * внутри — правило «ни одного ..» проще и безопаснее.
 */
export function classifyPath(p: string): PathClass {
  if (typeof p !== "string" || p.length === 0) return "traversal";
  if (p.includes("\0")) return "traversal";
  if (p.trim().length === 0) return "traversal";
  if (p.startsWith("/") || p.startsWith("\\")) return "outside";
  if (p.includes(":")) return "outside";
  const segs = p.split(/[/\\]+/);
  if (segs.some((s) => s === "..")) return "traversal";
  return "inside";
}
