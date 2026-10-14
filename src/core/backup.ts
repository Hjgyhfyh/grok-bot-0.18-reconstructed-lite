/**
 * src/core/backup.ts — чистое планирование бэкапов и применения изменений.
 *
 * Модуль не знает ни про fs, ни про Tauri: он только строит ПЛАНЫ
 * операций ({@link FsOp}[]), которые выполняет адаптер (Rust-команда или
 * node:fs в тестах). Исполнитель обязан:
 *  - выполнять ops строго в порядке массива;
 *  - `mkdir`   — создать папку (idempotent, «уже есть» — не ошибка);
 *  - `copy`    — побайтово скопировать файл from → to (без разыменования
 *                ссылок/junction: копируется сам файл);
 *  - `write`   — записать файл целиком (желательно атомарно: temp+rename);
 *  - `remove`  — удалить файл; отсутствующая цель — не ошибка.
 * Все `path`/`from`/`to` в планах — относительные пути (канонизированы,
 * '/'-разделитель), привязанные к корню соответствующей стороны:
 *  - planBackup:   from — относительно projectDir, to/path — внутри dir;
 *  - planRestore:  from — внутри backupDir, to/path — относительно projectDir;
 *  - mergeApplyPlan: path — относительно корня проекта.
 *
 * Безопасность: ни один план не содержит путей, выходящих за свой корень
 * (сегменты '..', абсолютные и укоренённые формы, диски, UNC, '\\?\',
 * ADS ':', NUL, управляющие символы, trailing '.'/' ', DOS-устройства).
 * Запись/удаление внутри '.git', 'node_modules' и '.grok-backup-*'
 * отклоняется (reserved). См. тест-план §7: traversal-атаки → reject
 * без побочных эффектов.
 */

import { classifyPath } from "./git.ts";

/** Преференс каталога бэкапов внутри проекта: `.grok-backup-<ts>[-n]`. */
export const BACKUP_PREFIX = ".grok-backup-";

// ─── Операции плана ──────────────────────────────────────────────────

export type FsOp =
  | { kind: "mkdir"; path: string }
  | { kind: "copy"; from: string; to: string }
  | { kind: "write"; path: string; content: string }
  | { kind: "remove"; path: string };

/** Причина отклонения пути/операции (коды, не строки — маппинг в адаптере). */
export type RejectReason =
  | "unsafe-path" // '../', абсолютный, NUL, trailing '.', устройство DOS и т.п.
  | "reserved-dir" // внутри '.git' / 'node_modules' / '.grok-backup-*'
  | "unsupported-op"; // оп, который этот планировщик не умеет разворачивать

export interface RejectedPath {
  path: string;
  reason: RejectReason;
}

export interface BackupPlan {
  /** Папка бэкапа: '<projectDir>/.grok-backup-<YYYYMMDD-HHMMSS>[-n]'. */
  dir: string;
  /** mkdir '.' (сам dir) → mkdir родителей → copy-операции. */
  ops: FsOp[];
  /** Относительные пути, реально попавшие в бэкап (для отчёта/манифеста). */
  copied: string[];
  /** Входы, отвергнутые проверками. */
  skipped: RejectedPath[];
}

export interface RestorePlan {
  /**
   * Корень проекта = родитель backupDir — только если имя папки
   * соответствует конвенции '.grok-backup-*'; иначе null (адаптер знает
   * projectDir сам, ops всё равно относительные и безопасные).
   */
  projectDir: string | null;
  /** remove созданных apply файлов → mkdir родителей → copy восстановления. */
  ops: FsOp[];
  rejected: RejectedPath[];
}

/**
 * Одно изменение файла для mergeApplyPlan.
 * CONTRACT: wire-формат FileChange{path,diff} из types.ts/tauri.ts резолвится
 * адаптером в {path, content} ДО вызова (применение unified diff — не задача
 * этого планировщика).
 */
export interface ApplyChange {
  /** Относительный путь в проекте ('/' или '\' — канонизируется). */
  path: string;
  /** Полное новое содержимое файла. Не-строка/отсутствие → пустой файл. */
  content?: string;
  /** true → файл удаляется (игнорирует content). */
  delete?: boolean;
}

export interface ApplyPlan {
  /** remove → mkdir (отсортированы) → write → copy; порядок — порядок выполнения. */
  ops: FsOp[];
  /** Канонизированные пути принятых изменений (без дублей). */
  applied: string[];
  rejected: RejectedPath[];
}

// ─── Проверка и канонизация путей ────────────────────────────────────

/** Имя/стебель, совпадающий с DOS-устройством — Windows откроет не файл. */
const DOS_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** Trailing '.'/' ' Windows обрезает молча — путь «меняется» под ногами. */
const TRAILING_BAD_RE = /[. ]$/;
/** Управляющие символы и DEL недопустимы в именах. */
const CONTROL_RE = /[-]/;

/** Первый сегмент, куда писать/читать нельзя ни при каких условиях. */
const RESERVED_TOP: Record<string, true> = { ".git": true, node_modules: true };

function isReservedTop(rel: string): boolean {
  const slash = rel.indexOf("/");
  const top = (slash === -1 ? rel : rel.slice(0, slash)).toLowerCase();
  return RESERVED_TOP[top] === true || top.startsWith(BACKUP_PREFIX);
}

/**
 * Канонизация относительного пути → 'a/b/c' или null (небезопасно).
 *
 * Первый барьер — {@link classifyPath} из core/git.ts (единая конвенция
 * отклонения: '..', абсолютные формы, ':', NUL, пустые). Поверх — правила
 * для записи: DOS-устройства, управляющие символы, trailing '.'/' '.
 * Сегменты '' и '.' схлопываются ('a//b', 'a/./b' → 'a/b'; './a' → 'a').
 */
export function normalizeRelPath(p: string): string | null {
  if (typeof p !== "string" || classifyPath(p) !== "inside") return null;
  const out: string[] = [];
  for (const seg of p.split(/[/\\]+/)) {
    if (seg === "" || seg === ".") continue;
    if (TRAILING_BAD_RE.test(seg) || CONTROL_RE.test(seg)) return null;
    if (DOS_DEVICE_RE.test(seg.split(".", 1)[0] ?? seg)) return null;
    out.push(seg);
  }
  return out.length > 0 ? out.join("/") : null;
}

/** Нормализация корня: '\' → '/', хвостовые '/' срезаются; '..' в корне → null. */
function normalizeRoot(root: string): string | null {
  if (typeof root !== "string" || root.length === 0) return null;
  if (root.trim().length === 0 || root.includes("\0")) return null;
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (r.length === 0) return "/";
  for (const seg of r.split("/")) {
    if (seg === "..") return null;
  }
  return r;
}

function joinPath(base: string, rel: string): string {
  return base === "/" ? `/${rel}` : `${base}/${rel}`;
}

function parentOf(rel: string): string | null {
  const i = rel.lastIndexOf("/");
  return i === -1 ? null : rel.slice(0, i);
}

/** Цепочка предков 'a/b/c' → ['a','a/b'] (от внешнего к внутреннему). */
function ancestorsOf(rel: string): string[] {
  const out: string[] = [];
  let p = parentOf(rel);
  while (p !== null) {
    out.unshift(p);
    p = parentOf(p);
  }
  return out;
}

/**
 * Безопасное присоединение относительного пути к корню:
 * канонизированный abs-путь или null, если rel небезопасен либо корень
 * пуст/содержит '..'. Не проверяет reserved-имена — это решают
 * планировщики (корень может быть любым, не только проектом).
 */
export function safeJoin(root: string, rel: string): string | null {
  const rootN = normalizeRoot(root);
  if (rootN === null) return null;
  const relN = normalizeRelPath(rel);
  if (relN === null) return null;
  return joinPath(rootN, relN);
}

// ─── Имя бэкапа ──────────────────────────────────────────────────────

/**
 * Формат метки времени для имени бэкапа: 'YYYYMMDD-HHMMSS' (локальное
 * время — чтобы пользователь узнавал «вчерашний, после обеда»).
 * Бросает TypeError на не-числе/NaN/±Infinity — это программная ошибка
 * вызывающего, а не данные.
 */
export function formatBackupTs(ts: number): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) {
    throw new TypeError("backup timestamp must be a finite unix-ms number");
  }
  const d = new Date(ts);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return (
    String(d.getFullYear()).padStart(4, "0") +
    p2(d.getMonth() + 1) +
    p2(d.getDate()) +
    "-" +
    p2(d.getHours()) +
    p2(d.getMinutes()) +
    p2(d.getSeconds())
  );
}

// ─── План бэкапа ─────────────────────────────────────────────────────

/**
 * План бэкапа изменяемых файлов в '<projectDir>/.grok-backup-<ts>'.
 *
 * @param changedPaths относительные пути файлов, которые apply собирается
 *        трогать (изменённые и удаляемые — копируется текущее состояние).
 *        Файлы, которых apply ещё не создал, сюда не входят — их убирает
 *        planRestore по createdPaths.
 * @param ts метка времени (unix-ms), скажем от порт-часов; имя — локальное.
 * @param suffix числовой суффикс при коллизии имён в одну секунду
 *        ('...-1', '...-2'); адаптер проверяет exists() и увеличивает.
 *
 * Небезопасные и reserved-пути молча уходят в skipped — план остаётся
 * выполнимым для остальных. Пустой changedPaths → ops всё равно создаёт
 * dir (пустой бэкап — легитимный результат).
 */
export function planBackup(
  projectDir: string,
  changedPaths: readonly string[],
  ts: number,
  suffix?: number,
): BackupPlan {
  const root = normalizeRoot(projectDir);
  if (root === null) {
    throw new TypeError("projectDir must be a non-empty path");
  }
  const tag = formatBackupTs(ts) + (suffix && suffix > 0 ? `-${suffix}` : "");
  const dir = joinPath(root, BACKUP_PREFIX + tag);

  const ops: FsOp[] = [{ kind: "mkdir", path: "." }];
  const dirs = new Set<string>();
  const copied: string[] = [];
  const skipped: RejectedPath[] = [];
  const seen = new Set<string>();

  for (const raw of changedPaths ?? []) {
    const rel = normalizeRelPath(raw);
    if (rel === null) {
      skipped.push({ path: String(raw), reason: "unsafe-path" });
      continue;
    }
    if (isReservedTop(rel)) {
      skipped.push({ path: rel, reason: "reserved-dir" });
      continue;
    }
    if (seen.has(rel)) continue;
    seen.add(rel);
    for (const a of ancestorsOf(rel)) {
      if (!dirs.has(a)) dirs.add(a);
    }
    copied.push(rel);
    ops.push({ kind: "copy", from: rel, to: rel });
  }

  // mkdir-операции — после корня, по алфавиту (родитель < потомка лексикально).
  const mkdirs = [...dirs].sort();
  const copies = ops.slice(1);
  const plan: FsOp[] = [
    ops[0]!,
    ...mkdirs.map((path): FsOp => ({ kind: "mkdir", path })),
    ...copies,
  ];
  return { dir, ops: plan, copied, skipped };
}

// ─── План восстановления ─────────────────────────────────────────────

/**
 * Разворачивает план бэкапа в план восстановления.
 *
 * @param backupDir папка '.grok-backup-<ts>' (слеш-форма любая).
 * @param ops ops, вернувшиеся из planBackup (только copy разворачиваются;
 *        mkdir/прочие — отклоняются как 'unsupported-op'). Каждый from/to
 *        валидируется заново — подменённый план с '../' не выйдет из корня.
 * @param createdPaths файлы, созданные apply и поэтому НЕ попавшие в бэкап —
 *        для них ставится remove (проект вернётся к виду «до apply»).
 */
export function planRestore(
  backupDir: string,
  ops: readonly FsOp[],
  createdPaths: readonly string[] = [],
): RestorePlan {
  const dirN = normalizeRoot(backupDir);
  const base = dirN === null ? "" : dirN.slice(dirN.lastIndexOf("/") + 1);
  const projectDir =
    dirN !== null && base.toLowerCase().startsWith(BACKUP_PREFIX)
      ? dirN.slice(0, Math.max(0, dirN.lastIndexOf("/"))) || "/"
      : null;

  const rejected: RejectedPath[] = [];
  const restoredTo = new Set<string>();
  const dirs = new Set<string>();
  const copies: FsOp[] = [];

  for (const op of ops ?? []) {
    if (op.kind !== "copy") {
      rejected.push({ path: opPath(op), reason: "unsupported-op" });
      continue;
    }
    const fromBackup = normalizeRelPath(op.to); // источник — внутри бэкапа
    const toProject = normalizeRelPath(op.from); // цель — внутри проекта
    if (fromBackup === null || toProject === null) {
      rejected.push({ path: op.from ?? op.to, reason: "unsafe-path" });
      continue;
    }
    if (isReservedTop(toProject)) {
      rejected.push({ path: toProject, reason: "reserved-dir" });
      continue;
    }
    if (restoredTo.has(toProject)) continue;
    restoredTo.add(toProject);
    for (const a of ancestorsOf(toProject)) dirs.add(a);
    copies.push({ kind: "copy", from: fromBackup, to: toProject });
  }

  const removes: FsOp[] = [];
  for (const raw of createdPaths ?? []) {
    const rel = normalizeRelPath(raw);
    if (rel === null) {
      rejected.push({ path: String(raw), reason: "unsafe-path" });
      continue;
    }
    if (isReservedTop(rel)) {
      rejected.push({ path: rel, reason: "reserved-dir" });
      continue;
    }
    if (restoredTo.has(rel)) continue; // файл восстанавливается — удалять не надо
    removes.push({ kind: "remove", path: rel });
  }

  return {
    projectDir,
    ops: [
      ...removes,
      ...[...dirs].sort().map((path): FsOp => ({ kind: "mkdir", path })),
      ...copies,
    ],
    rejected,
  };
}

function opPath(op: FsOp): string {
  switch (op.kind) {
    case "copy":
      return op.from;
    case "mkdir":
    case "write":
    case "remove":
      return op.path;
  }
}

// ─── План применения изменений ───────────────────────────────────────

/**
 * План записи изменений в проект.
 *
 * @param current слепок существующих относительных путей проекта И/ИЛИ
 *        ранее построенные FsOp (merge): строки лишь отмечают «уже есть»
 *        — под них mkdir не ставится; FsOp валидируются заново и входят
 *        в план, при конфликте пути incoming побеждает (last-write-wins).
 * @param incoming изменения: {path, content} → write (недостающие папки
 *        создаются), {path, delete:true} → remove.
 *
 * Порядок ops: remove → mkdir(отсорт.) → write → copy — удаления идут
 * первыми, чтобы «удалить файл a и записать a/b.txt» имело шанс выполниться.
 * Пустой результат на пустом incoming — нормальный итог.
 */
export function mergeApplyPlan(
  current: readonly (string | FsOp)[],
  incoming: readonly ApplyChange[],
): ApplyPlan {
  const knownDirs = new Set<string>(); // существующие пути и их предки
  const mkdirDirs = new Set<string>(); // запланированные mkdir
  const fileOps = new Map<string, FsOp>(); // write|remove по пути (last wins)
  const copyOps: FsOp[] = []; // развёрнутые copy из current
  const appliedSet = new Set<string>();
  const rejected: RejectedPath[] = [];

  const reject = (p: string, reason: RejectReason): void => {
    rejected.push({ path: p, reason });
  };

  const planDir = (rel: string): void => {
    if (isReservedTop(rel)) {
      reject(rel, "reserved-dir");
      return;
    }
    if (knownDirs.has(rel) || fileOps.has(rel)) return;
    mkdirDirs.add(rel);
  };

  const planFile = (rel: string, op: FsOp): void => {
    if (isReservedTop(rel)) {
      reject(rel, "reserved-dir");
      return;
    }
    mkdirDirs.delete(rel); // на месте папки будет файл — mkdir не нужен
    for (const a of ancestorsOf(rel)) {
      if (!knownDirs.has(a) && !fileOps.has(a)) mkdirDirs.add(a);
    }
    fileOps.set(rel, op);
  };

  // 1) current: строки → knownDirs; FsOp → повторная валидация и слияние.
  for (const e of current ?? []) {
    if (typeof e === "string") {
      const rel = normalizeRelPath(e);
      if (rel !== null) {
        knownDirs.add(rel);
        for (const a of ancestorsOf(rel)) knownDirs.add(a);
      }
      continue;
    }
    switch (e.kind) {
      case "mkdir": {
        const rel = normalizeRelPath(e.path);
        if (rel === null) {
          reject(e.path, "unsafe-path");
        } else {
          planDir(rel);
        }
        break;
      }
      case "write": {
        const rel = normalizeRelPath(e.path);
        if (rel === null) reject(e.path, "unsafe-path");
        else planFile(rel, { kind: "write", path: rel, content: e.content });
        break;
      }
      case "remove": {
        const rel = normalizeRelPath(e.path);
        if (rel === null) reject(e.path, "unsafe-path");
        else planFile(rel, { kind: "remove", path: rel });
        break;
      }
      case "copy": {
        const from = normalizeRelPath(e.from);
        const to = normalizeRelPath(e.to);
        if (from === null || to === null) {
          reject(e.from, "unsafe-path");
        } else if (isReservedTop(to)) {
          reject(to, "reserved-dir");
        } else {
          for (const a of ancestorsOf(to)) {
            if (!knownDirs.has(a) && !fileOps.has(a)) mkdirDirs.add(a);
          }
          copyOps.push({ kind: "copy", from, to });
        }
        break;
      }
    }
  }

  // 2) incoming: валидируем и накладываем поверх (last-write-wins по пути).
  for (const ch of incoming ?? []) {
    if (ch === null || typeof ch !== "object") {
      reject(String(ch), "unsafe-path");
      continue;
    }
    const rel = normalizeRelPath(ch.path);
    if (rel === null) {
      reject(typeof ch.path === "string" ? ch.path : String(ch.path), "unsafe-path");
      continue;
    }
    if (ch.delete === true) {
      if (isReservedTop(rel)) {
        reject(rel, "reserved-dir");
        continue;
      }
      planFile(rel, { kind: "remove", path: rel });
      appliedSet.add(rel);
      continue;
    }
    const content = typeof ch.content === "string" ? ch.content : "";
    if (isReservedTop(rel)) {
      reject(rel, "reserved-dir");
      continue;
    }
    planFile(rel, { kind: "write", path: rel, content });
    appliedSet.add(rel);
  }

  const ops: FsOp[] = [
    ...[...fileOps.values()].filter((o): o is Extract<FsOp, { kind: "remove" }> => o.kind === "remove"),
    ...[...mkdirDirs].sort().map((path): FsOp => ({ kind: "mkdir", path })),
    ...[...fileOps.values()].filter(
      (o): o is Extract<FsOp, { kind: "write" }> => o.kind === "write",
    ),
    ...copyOps,
  ];

  return { ops, applied: [...appliedSet], rejected };
}
