/**
 * Документация долго звала команды, которых в проекте нет, и человек, который пытался собрать
 * программу, упирался в тупик: `npm run package`, `npm run verify`, `npm run bootstrap`,
 * `npm run publication:check`, `npm run package:diagnostic`, `npm run frontend:recover`.
 * В `package.json` таких записей нет с тех пор, как единственным рабочим путём сборки стал
 * `scripts/build-from-source.mjs`, а упаковки — `scripts/package-windows-lite.mjs`. Тексты
 * остались: CONTRIBUTING.md звал macOS-путь, docs/PUBLISHING.md — шаг публикации,
 * docs/WORKTREES.md — запрет на команды в слоте, frontend/README.md и docs/ARCHITECTURE.md —
 * сборку «поверх бандла», удалённую вместе с `src/app/dist`, а лаунчер
 * `scripts/start-grokbot.ps1` предлагал собрать отсутствующий бандл командой без названия.
 *
 * Ни один из этих вызовов не ронял сборку: это была документация, а не код, поэтому зелёный набор
 * тестов молчал, пока читатель не натыкался на `npm ERR! Missing script: "package"`. Мёртвый
 * текст не ломает ничего, пока кто-то не попробует выполнить его буквально.
 *
 * Теперь список команд читается из самого `package.json`, и любое `npm run <имя>` в любом `.md`
 * обязано быть ключом в `scripts`. Второе правило проверяет `node scripts/<файл>.mjs`: такой файл
 * обязан лежать на диске, иначе читателю тоже некуда идти. Оба правила статические, поэтому
 * нулевой результат ничего не доказывает: тест отдельно проверяет, что его собственные разборы
 * вообще находят упоминания, и падает, если просканировало меньше пяти файлов.
 *
 * Третья проверка закрывает вторую половину требования пользователя: программа собирается и
 * работает без Cursor, без входа в аккаунт Cursor и без отдельного компьютера агента, поэтому
 * инструкции по сборке не могут потребовать ни того, ни другого, ни третьего.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import createIgnore from "ignore";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// `.git` в `.gitignore` не значится, остальное (`node_modules`, `.build`, `dist`, `.tmp*`,
// `.cache`) отсекает сам список игнорируемых путей — тем же, каким пользуется публикация.
const SKIPPED_DIRECTORIES = new Set([".git"]);

// Имя команды — то, что между `npm run` и концом слова. Точка в конце может закрывать
// предложение внутри строки, поэтому она срезается: иначе `npm run build.` в прозе читался бы
// как обращение к команде `build.`.
const NPM_RUN_PATTERN = /\bnpm\s+run\s+([A-Za-z0-9:._-]+)/g;
const NODE_SCRIPT_PATTERN = /\bnode\s+(scripts\/[A-Za-z0-9._-]+\.mjs)\b/g;

// Единственное упоминание отсутствующего скрипта, которое ничего не зовёт: `AGENTS.md` §9
// называет `node scripts/verify.mjs` прямо в тексте, чтобы сказать, что его больше нет.
const ABSENT_ON_PURPOSE = new Map([["AGENTS.md", new Set(["scripts/verify.mjs"])]]);

// Инструкции, по которым человек собирает и запускает программу. `docs/REMOVE-CURSOR.md` сюда
// не входит намеренно: это опись того, что вычистили, и по определению называет Cursor.
// `research-archives/README.md` и `scripts/mcp/README.md` — прочие ссылки на исходный продукт.
const SETUP_DOCS = [
  "README.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "frontend/README.md",
  "docs/ARCHITECTURE.md",
  "docs/PUBLISHING.md",
  "docs/WORKTREES.md",
];

const readRepoFile = relativePath => readFile(path.join(repoRoot, ...relativePath.split("/")), "utf8");

async function collectMarkdown(relativeDirectory = "") {
  const entries = await readdir(path.join(repoRoot, relativeDirectory), { withFileTypes: true });
  const found = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".tmp")) continue;
      found.push(...await collectMarkdown(relative));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      found.push(relative);
    }
  }
  return found;
}

async function markdownFiles() {
  const ignoreRules = await readRepoFile(".gitignore");
  assert.ok(ignoreRules.trim().length > 0, ".gitignore пуст, поэтому фильтр игнорируемых папок ничего не отсекает");
  const matcher = createIgnore().add(ignoreRules);
  const files = await collectMarkdown();
  return files.filter(file => !matcher.ignores(file));
}

const commandName = match => match.replace(/\.+$/, "");

test("каждая команда npm run в документации объявлена в package.json", async () => {
  const manifest = JSON.parse(await readRepoFile("package.json"));
  const scripts = new Set(Object.keys(manifest.scripts ?? {}));
  const files = await markdownFiles();

  // Скан, который не нашёл ни одного файла, проходит на пустом месте — это провал, а не успех.
  assert.ok(files.length >= 5, `просканировано файлов .md: ${files.length} — правило ничем не подкреплено`);
  assert.ok(scripts.has("build") && scripts.has("package:win"),
    "в package.json нет ни build, ни package:win, а на них ссылается документация — список команд читается не оттуда");

  // Разбор проверяется на строке, где есть и настоящая команда, и заведомо выдуманная.
  // Если regex перестанет находить имя, скан станет слепым ровно тогда, когда понадобится.
  assert.deepEqual(
    [...`npm run build\nnpm run package\n`.matchAll(NPM_RUN_PATTERN)].map(match => commandName(match[1])),
    ["build", "package"],
    "разбор npm run перестал находить имя команды — скан пропустит устаревшую команду молча",
  );

  const seen = new Set();
  const stale = [];
  let nonEmpty = 0;
  for (const file of files) {
    const text = await readRepoFile(file);
    if (text.trim().length > 0) nonEmpty += 1;
    for (const match of text.matchAll(NPM_RUN_PATTERN)) {
      const name = commandName(match[1]);
      seen.add(name);
      if (!scripts.has(name)) stale.push(`${file}: ${match[0]}`);
    }
  }

  // Пустой файл проходит проверку молча, поэтому считаются именно непустые: `PROVENANCE.md`
  // в репозитории существует и весит ноль байт, и это не повод ронять чужую правку.
  assert.ok(nonEmpty >= 5, `прочитано непустых файлов .md: ${nonEmpty} — скан нечего было проверять`);
  assert.ok(seen.size > 0, "ни одна команда npm run не найдена — правило не проверяет ничего");
  assert.deepEqual(stale, [], `документация зовёт команды, которых нет в package.json:\n${stale.join("\n")}`);
});

test("каждый упомянутый в документации скрипт node scripts лежит на диске", async () => {
  const files = await markdownFiles();
  assert.ok(files.length >= 5, `просканировано файлов .md: ${files.length} — правило ничем не подкреплено`);
  assert.deepEqual(
    [...`node scripts/wt-pool.mjs list\n`.matchAll(NODE_SCRIPT_PATTERN)].map(match => match[1]),
    ["scripts/wt-pool.mjs"],
    "разбор node scripts перестал находить путь к скрипту — скан пропустит удалённый файл молча",
  );

  const missing = [];
  const seen = new Set();
  for (const file of files) {
    const text = await readRepoFile(file);
    for (const match of text.matchAll(NODE_SCRIPT_PATTERN)) {
      const script = match[1];
      seen.add(script);
      if (ABSENT_ON_PURPOSE.get(file)?.has(script)) continue;
      if (!existsSync(path.join(repoRoot, ...script.split("/")))) missing.push(`${file}: node ${script}`);
    }
  }

  assert.ok(seen.size > 0, "ни один запуск node scripts не найден — правило не проверяет ничего");
  assert.deepEqual(missing, [], `документация зовёт скрипты, которых нет на диске:\n${missing.join("\n")}`);
});

test("инструкции по сборке не требуют Cursor и отдельного компьютера агента", async () => {
  const setupDocs = [];
  for (const file of SETUP_DOCS) {
    const absolute = path.join(repoRoot, ...file.split("/"));
    assert.ok(existsSync(absolute), `файл инструкций исчез: ${file} — список SETUP_DOCS надо чинить вручную`);
    const text = await readRepoFile(file);
    assert.ok(text.trim().length > 0, `${file} пуст, поэтому его нечего было проверять`);
    assert.doesNotMatch(text, /cursor/i,
      `${file} снова называет Cursor: программа работает без него и без входа в аккаунт`);
    assert.doesNotMatch(text, /box\s*runtime|boxRuntime|компьютер агента|agent'?s computer/i,
      `${file} снова предлагает выбрать компьютер агента: исполнитель один, это машина пользователя`);
    setupDocs.push(file);
  }

  assert.equal(setupDocs.length, SETUP_DOCS.length, "не все файлы инструкций были прочитаны");
});