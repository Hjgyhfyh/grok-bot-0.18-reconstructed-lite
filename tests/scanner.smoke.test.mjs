// Smoke-тесты чистой логики сканера. Node >=22.6 стрипает типы из .ts.
// Запуск: node --test tests/scanner.smoke.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeStatus,
  formatActivity,
  sortProjects,
  isProjectDir,
  walkPlan,
  descendPlan,
  baseName,
  isInsideRoot,
  scanProjects,
  buildProjectTree,
  collectFilePaths,
  readProjectFiles,
  toWireCard,
  STALE_AFTER_MS,
} from "../src/core/scanner.ts";

const NOW = 1_800_000_000_000; // фиксированное «сейчас»
const stat = { hasErrorMarkers: false, hasUnsavedChanges: false };

/* ---------------- computeStatus ---------------- */

test("computeStatus: приоритет crashed > dirty > stale > clean", () => {
  assert.equal(
    computeStatus({ ...stat, hasErrorMarkers: true }, "dirty", NOW - 1, NOW),
    "crashed",
  );
  assert.equal(computeStatus(stat, "dirty", NOW, NOW), "dirty");
  assert.equal(
    computeStatus({ ...stat, hasUnsavedChanges: true }, "clean", NOW, NOW),
    "dirty",
  );
  assert.equal(
    computeStatus(stat, "clean", NOW - STALE_AFTER_MS - 1, NOW),
    "stale",
  );
  assert.equal(computeStatus(stat, "clean", NOW - STALE_AFTER_MS, NOW), "clean");
  assert.equal(computeStatus(stat, "none", NOW - 1000, NOW), "clean");
  // будущее (clock skew) — не stale
  assert.equal(computeStatus(stat, "none", NOW + 10_000, NOW), "clean");
});

/* ---------------- formatActivity ---------------- */

const ru = {
  agoJustNow: "только что",
  agoMinutes: ["{n} минуту назад", "{n} минуты назад", "{n} минут назад"],
  agoHours: ["{n} час назад", "{n} часа назад", "{n} часов назад"],
  agoDays: ["{n} день назад", "{n} дня назад", "{n} дней назад"],
  agoLongAgo: "больше месяца назад",
};
const pluralRu = (n, forms) =>
  forms[
    n % 10 === 1 && n % 100 !== 11 ? 0
    : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 1
    : 2
  ];
const t = (key, params = {}) => {
  const v = ru[key];
  const s = Array.isArray(v) ? pluralRu(params.n ?? 0, v) : v;
  return s.replace("{n}", String(params.n ?? ""));
};

test("formatActivity: бакеты и plural", () => {
  assert.equal(formatActivity(NOW, NOW, t), "только что");
  assert.equal(formatActivity(NOW - 30_000, NOW, t), "только что");
  assert.equal(formatActivity(NOW - 5 * 60_000, NOW, t), "5 минут назад");
  assert.equal(formatActivity(NOW - 61 * 60_000, NOW, t), "1 час назад");
  assert.equal(formatActivity(NOW - 2 * 3_600_000, NOW, t), "2 часа назад");
  assert.equal(formatActivity(NOW - 14 * 3_600_000, NOW, t), "14 часов назад");
  assert.equal(formatActivity(NOW - 26 * 3_600_000, NOW, t), "1 день назад");
  assert.equal(formatActivity(NOW - 3 * 86_400_000, NOW, t), "3 дня назад");
  assert.equal(
    formatActivity(NOW - 45 * 86_400_000, NOW, t),
    "больше месяца назад",
  );
  assert.equal(formatActivity(NOW + 60_000, NOW, t), "только что"); // будущее
  assert.equal(formatActivity(NaN, NOW, t), "только что");
});

/* ---------------- sortProjects ---------------- */

test("sortProjects: свежие первыми, тай-брейк по имени, вход не мутирует", () => {
  const cards = [
    { name: "б", lastActivityMs: 100 },
    { name: "а", lastActivityMs: 100 },
    { name: "я", lastActivityMs: 300 },
  ];
  const sorted = sortProjects(cards);
  assert.deepEqual(
    sorted.map((c) => c.name),
    ["я", "а", "б"],
  );
  assert.deepEqual(
    cards.map((c) => c.name),
    ["б", "а", "я"],
  );
});

/* ---------------- isProjectDir / walkPlan ---------------- */

const dir = (name) => ({ name, kind: "dir" });
const file = (name) => ({ name, kind: "file" });

test("isProjectDir: маркеры и содержимое", () => {
  assert.equal(isProjectDir([file("package.json"), dir("node_modules")]), true);
  assert.equal(isProjectDir([dir("src")]), true);
  assert.equal(isProjectDir([file("page.html")]), true); // любой контент
  assert.equal(isProjectDir([dir("node_modules"), file("thumbs.db")]), false);
  assert.equal(isProjectDir([]), false);
  assert.equal(isProjectDir(["index.html", ".git"]), true); // строки
});

test("walkPlan/descendPlan: фильтрация мусора", () => {
  const entries = [
    dir("node_modules"),
    dir(".git"),
    dir("src"),
    dir(".grok-backup-2024"),
    file("app.ts"),
    file("npm-debug.log"),
    file(".env"),
  ];
  const kept = walkPlan(entries);
  assert.deepEqual(kept.map((e) => e.name), ["src", "app.ts"]);
  assert.deepEqual(descendPlan(entries), ["src"]);
});

test("baseName/isInsideRoot", () => {
  assert.equal(baseName("C:\\proj\\сайт"), "сайт");
  assert.equal(baseName("C:/proj/сайт/"), "сайт");
  assert.equal(isInsideRoot("C:\\root", "c:/root/sub/f.txt"), true);
  assert.equal(isInsideRoot("C:\\root", "C:\\other\\f.txt"), false);
});

/* ---------------- scanProjects через fake-порты ---------------- */

const memFs = (tree) => ({
  async readDir(p) {
    const node = tree[p];
    if (!node || node.kind !== "dir") {
      const e = new Error(`ENOENT: ${p}`);
      e.code = "ENOENT";
      throw e;
    }
    return node.entries.map((n) => ({ name: n, kind: tree[`${p}/${n}`]?.kind ?? "file" }));
  },
  async stat(p) {
    const node = tree[p];
    if (!node) {
      const e = new Error(`ENOENT: ${p}`);
      e.code = "ENOENT";
      throw e;
    }
    return { mtimeMs: node.mtimeMs ?? NOW - 60_000, isDir: node.kind === "dir" };
  },
});

test("scanProjects: карточки, исключения, ошибки, сортировка", async () => {
  const tree = {
    "/root": { kind: "dir", entries: ["site", "lib", ".hidden", "node_modules", ".grok-backup-1", "readme.txt"] },
    "/root/site": { kind: "dir", entries: ["package.json", "src"], mtimeMs: NOW - 1000 },
    "/root/site/package.json": { kind: "file", mtimeMs: NOW - 1000 },
    "/root/site/src": { kind: "dir", entries: ["main.ts"] },
    "/root/site/src/main.ts": { kind: "file", mtimeMs: NOW - 2000 },
    "/root/lib": { kind: "dir", entries: ["index.html", "error.log"], mtimeMs: NOW - 500 },
    "/root/lib/index.html": { kind: "file", mtimeMs: NOW - 500 },
    "/root/lib/error.log": { kind: "file", mtimeMs: NOW - 500 },
    "/root/.hidden": { kind: "dir", entries: ["x"] },
    "/root/.hidden/x": { kind: "file" },
    "/root/node_modules": { kind: "dir", entries: ["a.js"] },
    "/root/.grok-backup-1": { kind: "dir", entries: ["b.js"] },
    "/root/readme.txt": { kind: "file" },
  };
  const git = { async status() { return "none"; } };
  const res = await scanProjects("/root", { fs: memFs(tree), git }, NOW);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(
    res.cards.map((c) => c.name),
    ["lib", "site"], // lib свежее (mtime -500)
  );
  const lib = res.cards[0];
  assert.equal(lib.status, "crashed"); // error.log
  assert.equal(lib.hasGit, false);
  const site = res.cards[1];
  assert.equal(site.fileCount, 2); // package.json + src/main.ts
  assert.equal(site.status, "clean");
});

test("scanProjects: отсутствующий корень → not_found, без throw", async () => {
  const res = await scanProjects(
    "/nope",
    { fs: memFs({}), git: { async status() { return "none"; } } },
    NOW,
  );
  assert.equal(res.cards.length, 0);
  assert.equal(res.errors[0].reason, "not_found");
});

test("scanProjects: git dirty → статус dirty", async () => {
  const tree = {
    "/root": { kind: "dir", entries: ["p"] },
    "/root/p": { kind: "dir", entries: ["f.txt"], mtimeMs: NOW - 100 },
    "/root/p/f.txt": { kind: "file", mtimeMs: NOW - 100 },
  };
  const git = {
    async status() { return "dirty"; },
    async lastCommitTime() { return NOW - 20 * 86_400_000; },
  };
  const res = await scanProjects("/root", { fs: memFs(tree), git }, NOW);
  assert.equal(res.cards[0].status, "dirty");
  assert.equal(res.cards[0].hasGit, true);
});

/* ---------------- buildProjectTree / readProjectFiles ---------------- */

test("buildProjectTree + collectFilePaths + readProjectFiles", async () => {
  const contents = {
    "/p/package.json": "{}",
    "/p/src/main.ts": "console.log(1)",
  };
  const tree = {
    "/p": { kind: "dir", entries: ["src", "node_modules", "package.json"] },
    "/p/src": { kind: "dir", entries: ["main.ts", "deep"] },
    "/p/src/main.ts": { kind: "file" },
    "/p/src/deep": { kind: "dir", entries: ["x.ts"] },
    "/p/src/deep/x.ts": { kind: "file" },
    "/p/node_modules": { kind: "dir", entries: ["junk.js"] },
    "/p/package.json": { kind: "file" },
  };
  const fs = {
    ...memFs(tree),
    async readFile(p) {
      if (!(p in contents)) throw new Error(`ENOENT: ${p}`);
      return contents[p];
    },
  };
  const nodes = await buildProjectTree("/p", fs, { depth: 2 });
  assert.deepEqual(nodes.map((n) => n.name), ["src", "package.json"]);
  const src = nodes[0];
  assert.equal(src.isDir, true);
  assert.deepEqual(src.children.map((n) => n.name), ["deep", "main.ts"]);
  // deep — папка без раскрытых детей: глубина исчерпана
  assert.equal(src.children[0].children, undefined);
  assert.deepEqual(collectFilePaths(nodes), [
    "/p/src/main.ts",
    "/p/package.json",
  ]);
  const files = await readProjectFiles(
    "/p",
    fs,
    ["/p/package.json", "src/main.ts", "../evil"],
    { maxTotalChars: 30_000 },
  );
  assert.deepEqual(files.map((f) => f.path), [
    "/p/package.json",
    "/p/src/main.ts",
  ]);
});

test("toWireCard: snake_case + секунды", () => {
  const wire = toWireCard({
    path: "/p",
    name: "p",
    status: "clean",
    lastActivityMs: 1_700_000_000_999,
    fileCount: 3,
    hasGit: true,
  });
  assert.equal(wire.last_activity, 1_700_000_000);
  assert.equal(wire.file_count, 3);
  assert.equal(wire.is_git_repo, true);
});
