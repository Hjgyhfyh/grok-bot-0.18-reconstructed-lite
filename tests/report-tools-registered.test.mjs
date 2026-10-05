/**
 * Отчётные инструменты были написаны, но нигде не объявлены.
 *
 * `source/packages/report-tools/` отдаёт пять готовых инструментов — `save_report`,
 * `fill_sample`, `report_preview`, `skill_list`, `skill_read`. До подключения в
 * `buildTurnTools` ни один из них не попадал в набор инструментов захода: модель
 * не могла их вызвать, а десять скиллов в `skills/*.md` описывали именно их.
 * При этом всё выглядело исправным: инструменты существовали, были покрыты
 * сорока тестами и просто не были видны агенту. Проверка «пакет есть» такую
 * поломку не ловит: нужен сам набор, который собирает заход.
 *
 * Вторая половина дефекта — описание. У пакета описания английские, а скиллы и
 * пользователь проекта русскоязычные. Инструмент с пустым описанием модель либо
 * не зовёт, либо зовёт наугад. Поэтому проверка здесь не только «инструмент
 * есть», но и «описание непустое и русское».
 *
 * Третье — правило безопасности. `report_preview` обновляет экран, а не
 * доставляет ответ, и в `DELIVERY_TOOL_NAMES` (`source/host/runner/turn-shape.ts`)
 * попадать не должен: там лежат инструменты, чей вызов считается ответом
 * пользователю. Если превью туда попадёт, заход, который только показал черновик,
 * будет засчитан как отвеченный.
 *
 * Тест собирает настоящий `createTurnReportToolFactory`, а не читает список
 * имён из исходника: чтение исходника прошло бы и на мёртвом коде.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const REPORT_TOOL_NAMES = [
  "save_report",
  "fill_sample",
  "report_preview",
  "skill_list",
  "skill_read",
];

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "dbbot-report-tools-"));
  const files = [];
  for (const entry of entries) {
    const file = path.join(directory, `${entry.at(-1).replace(/\.ts$/, "")}.cjs`);
    files.push(file);
    await build({
      entryPoints: [path.join(repoRoot, "source", ...entry)],
      outfile: file,
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node22",
      mainFields: ["module", "main"],
      logLevel: "silent",
    });
  }
  const loaded = {};
  for (const file of files) loaded[path.basename(file, ".cjs")] = require(file);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "runner", "tools", "report-turn-tools.ts"],
  ["host", "runner", "tools", "turn-toolset.ts"],
  ["host", "runner", "turn-shape.ts"],
  ["packages", "report-tools", "index.ts"],
]);
const adapter = loaded["report-turn-tools"];
const toolset = loaded["turn-toolset"];
const shape = loaded["turn-shape"];
const pack = loaded["index"];
test.after(() => dispose());

function toolsFor(dataRoot) {
  return toolset.createTurnReportToolFactory({
    dependencies: {
      dataRoot,
      skillsDir: path.join(dataRoot, "skills"),
      emitPreview: () => {},
    },
  })();
}

test("заход получает все пять отчётных инструментов", () => {
  const built = toolsFor(mkdtempSync(path.join(os.tmpdir(), "dbbot-report-root-")));
  assert.deepEqual(
    built.map((tool) => tool.name),
    REPORT_TOOL_NAMES,
    "набор захода не совпал со списком отчётных инструментов: либо часть потерялась при сборке, либо появилась лишняя",
  );
});

test("у каждого отчётного инструмента есть непустое русское описание", () => {
  const built = toolsFor(mkdtempSync(path.join(os.tmpdir(), "dbbot-report-desc-")));
  assert.equal(built.length, 5, "собралось не пять инструментов, поэтому описания ниже не все проверены");
  for (const tool of built) {
    // Модель видит ровно то, что отдаёт `descriptionGenerator`: набор
    // инструментов строит описание из него (`packages/agent/tools/core.ts:224`),
    // и поля `description` у TurnTool нет вообще.
    assert.equal(
      typeof tool.descriptionGenerator,
      "function",
      `${tool.name}: у инструмента нет descriptionGenerator, поэтому модель получит описание пустым и вызовет инструмент наугад или не вызовет вовсе`,
    );
    const description = tool.descriptionGenerator({});
    assert.equal(
      typeof description,
      "string",
      `${tool.name}: descriptionGenerator вернул не текст, значит описание до модели не доходит`,
    );
    assert.ok(
      description.trim().length >= 40,
      `${tool.name}: описание длиной ${description.trim().length} знаков ничего не объясняет модели о том, когда звать инструмент`,
    );
    assert.match(
      description,
      /[А-Яа-яЁё]/u,
      `${tool.name}: описание без русских слов, а скиллы в skills/ и сам пользователь русскоязычные`,
    );
    // Главное в описании — когда звать. Без этого предложения модель видит
    // перечень возможностей и не понимает, что инструмент к её задаче.
    assert.match(
      description,
      /Зови|зови/,
      `${tool.name}: в описании нет ни одного «зови», поэтому модель не поймёт, когда этот инструмент ей нужен`,
    );
  }
});

test("описание skill_read зовёт сначала skill_list", () => {
  // Порядок «список → чтение» — это правило из системного промпта. Если
  // описание перестанет на него ссылаться, модель начнёт угадывать имя скилла.
  const description = adapter.REPORT_TURN_TOOL_DESCRIPTIONS.skill_read;
  assert.match(
    description,
    /skill_list/,
    "skill_read больше не говорит, что имя берётся из skill_list: модель станет угадывать имя скилла вместо того, чтобы спросить список",
  );
});

test("описание есть у каждого из пяти, даже если сборщик их не перечислил", () => {
  for (const name of REPORT_TOOL_NAMES) {
    const description = adapter.REPORT_TURN_TOOL_DESCRIPTIONS[name];
    assert.equal(typeof description, "string", `${name}: в таблице описаний нет этой строки`);
    assert.ok(
      description.trim().length >= 40,
      `${name}: строка описания пустая, поэтому модель не поймёт, когда звать инструмент`,
    );
  }
  assert.equal(
    Object.keys(adapter.REPORT_TURN_TOOL_DESCRIPTIONS).length,
    REPORT_TOOL_NAMES.length,
    "таблица описаний разошлась с числом инструментов: часть описаний потерялась при переносе",
  );
});

test("report_preview доходит до интерфейса тем же событием, что и SendMessage", async () => {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), "dbbot-report-preview-"));
  const emitted = [];
  const deps = {
    dataRoot,
    skillsDir: path.join(dataRoot, "skills"),
    emitPreview: (update) => { emitted.push(update); },
    now: () => 1_700_000_000_000,
  };
  const answer = await pack.reportPreview(
    { title: "ФДБ Милосердие — 1 квартал 2026", text: "Черновик отчёта." },
    deps,
  );
  assert.match(answer, /Превью отчёта/, "инструмент не показал черновик, а отвечает текстом: пользователь на экране его не увидит");
  assert.equal(emitted.length, 1, "вызов report_preview не дошёл до интерфейса: черновик остался в файле молча");
  assert.equal(emitted[0].type, "send-message", "превью ушло не тем событием, что и SendMessage, поэтому интерфейс его не рисует");
  assert.equal(emitted[0].message.type, "text", "превью пришло не текстовым сообщением");
  assert.ok(
    emitted[0].message.content.includes("ФДБ Милосердие"),
    "превью пришло без названия отчёта: человек не поймёт, что именно показано",
  );
  assert.ok(
    emitted[0].timestampMs === 1_700_000_000_000,
    "превью пришло без метки времени, и интерфейс не сможет его отсортировать",
  );
  rmSync(dataRoot, { recursive: true, force: true });
});

test("report_preview не попал в DELIVERY_TOOL_NAMES", () => {
  assert.equal(
    shape.DELIVERY_TOOL_NAMES.has("report_preview"),
    false,
    "превью обновляет экран, а не отвечает. В DELIVERY_TOOL_NAMES лежат инструменты, чей вызов считается ответом пользователю, и туда он попадать не должен",
  );
  for (const name of REPORT_TOOL_NAMES) {
    assert.equal(
      shape.DELIVERY_TOOL_NAMES.has(name),
      false,
      `${name}: инструмент отчётов не доставляет ответ и не должен закрывать ожидание пользователя в turn-shape.ts`,
    );
  }
  assert.equal(
    shape.DELIVERY_TOOL_NAMES.has("SendMessage"),
    true,
    "контрольная проверка ослаблена: настоящий SendMessage обязан остаться в DELIVERY_TOOL_NAMES",
  );
});

test("папка со скиллами ищется снаружи и не зашита в код", () => {
  assert.equal(
    typeof adapter.resolveReportSkillsDir,
    "function",
    "нет функции поиска папки скиллов: путь, зашитый в код, в упакованном app.asar не найдётся",
  );
  assert.equal(
    adapter.resolveReportSkillsDir("C:\\данные", { SAND_REPORT_SKILLS_DIR: "D:\\папка\\скиллов" }, {}),
    "D:\\папка\\скиллов",
    "явное указание в SAND_REPORT_SKILLS_DIR должно побеждать все остальные места поиска",
  );
  const missing = adapter.resolveReportSkillsDir(
    "C:\\данные",
    {},
    { cwd: "C:\\нет\\такой", execPath: "C:\\нет\\такой\\узел.exe" },
  );
  assert.equal(
    missing,
    path.join("C:\\данные", "skills"),
    "если папки нигде нет, skill_list должен получить путь, который честно скажет «скиллов нет», а не упасть",
  );
});
