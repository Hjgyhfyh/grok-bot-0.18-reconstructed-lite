import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// Пять инструментов отчётов существовали в скиллах как текст инструкции, но не
// как вызовы: ни одного из них не было в наборе инструментов агента. Модель
// читала «вызови `fill_sample`, если образец есть» и упиралась в «инструмент не
// найден», а пользователь получал отчёт в переписке вместо файла. Проверить
// это было нечем: инструментов не было, тестов на них тоже.
// Тест закрывает две беды разом: инструменты называются ровно так, как их
// называют все десять скиллов в `skills/`, и каждый из них пишет или читает
// настоящий файл в разделе «Отчёты».

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = path.join(repoRoot, "skills");

let tools;
let buildDir;
let dataRoot;
const updates = [];

function deps(overrides = {}) {
  return {
    dataRoot,
    skillsDir,
    now: () => 1_700_000_000_000,
    emitPreview: (update) => updates.push(update),
    ...overrides,
  };
}

before(async () => {
  buildDir = await mkdtemp(path.join(os.tmpdir(), "dbbot-report-tools-"));
  const output = path.join(buildDir, "report-tools.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source", "packages", "report-tools", "index.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  tools = await import(pathToFileURL(output).href);
  dataRoot = path.join(buildDir, "grokbot");
  await mkdir(dataRoot, { recursive: true });
});

after(async () => {
  if (buildDir !== undefined) await rm(buildDir, { recursive: true, force: true });
});

const MARKDOWN = [
  "ОТЧЕТ",
  "",
  "## 1 квартал",
  "",
  "| № | Мероприятие |",
  "|---|---|",
  "| 1 | Клуб «Омега» |",
].join("\n");

test("набор отчётных инструментов собирается из пяти штук", () => {
  const names = tools.createReportTools(deps()).map((tool) => tool.name);
  assert.deepEqual(
    [...names].sort(),
    ["fill_sample", "report_preview", "save_report", "skill_list", "skill_read"],
    "состав набора инструментов изменился",
  );
});

test("каждый инструмент, названный в скиллах, действительно существует", async () => {
  // Скиллы пишут имена инструментов в обратных кавычках. Если инструмент
  // переименуют в PascalCase ради единообразия с остальным набором, скиллы
  // продолжат звать несуществующее имя — и это должен ловить тест, а не
  // заведующая в разговоре с агентом.
  const available = new Set(tools.createReportTools(deps()).map((tool) => tool.name));
  const files = (await readdir(skillsDir)).filter((name) => name.endsWith(".md"));
  const mentioned = new Set();
  for (const file of files) {
    const text = await readFile(path.join(skillsDir, file), "utf8");
    for (const [, name] of text.matchAll(/`(save_report|fill_sample|report_preview|skill_list|skill_read)[^`]*`/g)) {
      mentioned.add(name);
    }
  }
  assert.ok(mentioned.size >= 5, "скиллы перестали называть инструменты отчётов — проверка ослабла");
  for (const name of mentioned) {
    assert.ok(available.has(name), `скиллы зовут ${name}, а такого инструмента в наборе нет`);
  }
});

test("у каждого отчётного инструмента есть описание для модели и схема аргументов", () => {
  for (const tool of tools.createReportTools(deps())) {
    assert.ok(tool.description.length > 80, `у ${tool.name} пустое описание: модель не поймёт, когда его звать`);
    assert.ok(tool.parameters != null, `у ${tool.name} нет схемы аргументов`);
  }
});

test("save_report кладёт и текст, и документ в раздел «Отчёты» хранилища", async () => {
  const tools5 = tools.createReportTools(deps());
  const save = tools5.find((tool) => tool.name === "save_report");
  const result = await save.execute({ title: "ФДБ Милосердие — 1 квартал 2026", markdown: MARKDOWN, format: "rtf" });

  const dir = path.join(dataRoot, "Отчёты");
  const files = (await readdir(dir)).sort();
  assert.ok(files.includes("ФДБ Милосердие — 1 квартал 2026.md"), "текст отчёта не сохранён рядом с документом");
  assert.ok(files.includes("ФДБ Милосердие — 1 квартал 2026.rtf"), "документ отчёта не сохранён");
  assert.ok(result.includes(path.join(dir, "ФДБ Милосердие — 1 квартал 2026.rtf")), "ответ не называет путь: пользователь не найдёт файл");
  const rtf = await readFile(path.join(dir, "ФДБ Милосердие — 1 квартал 2026.rtf"), "utf8");
  assert.ok(rtf.startsWith("{\\rtf1"), "сохранённый документ должен быть настоящим RTF");
});

test("save_report в каждом формате даёт файл, который сам же и открывается", async () => {
  const dir = path.join(dataRoot, "Отчёты");
  const save = tools.createReportTools(deps()).find((tool) => tool.name === "save_report");
  for (const format of ["docx", "odt", "md"]) {
    await save.execute({ title: `Проверка ${format}`, markdown: MARKDOWN, format });
    const file = path.join(dir, `Проверка ${format}.${format}`);
    const bytes = await readFile(file);
    if (format === "md") {
      assert.equal(bytes.toString("utf8"), MARKDOWN, "текст отчёта исказился при сохранении в md");
      continue;
    }
    const names = tools.readZipEntries(bytes).map((entry) => entry.name);
    const wanted = format === "docx" ? "word/document.xml" : "content.xml";
    assert.ok(names.includes(wanted), `в ${format} нет части ${wanted}: файл не откроется`);
  }
});

test("save_report без формата делает rtf — так требуют скиллы, когда образца нет", async () => {
  const save = tools.createReportTools(deps()).find((tool) => tool.name === "save_report");
  await save.execute({ title: "Без формата", markdown: MARKDOWN });
  const files = await readdir(path.join(dataRoot, "Отчёты"));
  assert.ok(files.includes("Без формата.rtf"), "формат по умолчанию должен быть rtf");
});

test("имя файла очищается от символов, которые Windows не принимает", () => {
  assert.equal(tools.safeFileName("Отчёты/Подросток — 2026"), "Отчёты-Подросток — 2026");
  assert.equal(tools.safeFileName("  "), "отчёт", "пустое имя превращается в рабочее");
  assert.ok(!/[\\/:*?"<>|]/.test(tools.safeFileName("a/b\\c:d*e?f\"g<h>i|j")), "в имени остались запрещённые символы");
});

test("report_preview отдаёт черновик в существующий канал send-message, а не в новый", async () => {
  updates.length = 0;
  const preview = tools.createReportTools(deps()).find((tool) => tool.name === "report_preview");
  const result = await preview.execute({ title: "Черновик ФДБ", text: MARKDOWN });

  assert.equal(updates.length, 1, "превью не ушло в интерфейс");
  const update = updates[0];
  assert.equal(update.type, "send-message", "новый тип события принимать некому: канал должен быть существующим");
  assert.equal(update.message.type, "text");
  assert.ok(update.message.content.includes("Черновик ФДБ"), "в превью нет названия отчёта");
  assert.ok(update.message.content.includes("Клуб «Омега»"), "в превью нет текста черновика");
  assert.equal(typeof update.timestampMs, "number");
  assert.ok(result.includes("черновик"), "ответ инструмента должен говорить, где лежит черновик");

  const draft = path.join(dataRoot, "Отчёты", "Черновик ФДБ-черновик.md");
  assert.equal(await readFile(draft, "utf8"), MARKDOWN, "черновик должен лежать на диске, а не только в сообщении");
});

test("report_preview без подключённого канала честно говорит об этом и всё равно сохраняет черновик", async () => {
  updates.length = 0;
  const preview = tools.createReportTools(deps({ emitPreview: undefined })).find((tool) => tool.name === "report_preview");
  const result = await preview.execute({ title: "Без канала", text: MARKDOWN });
  assert.equal(updates.length, 0, "превью не должно уходить туда, куда никто не слушает");
  assert.match(result, /не подключён/, "инструмент не должен делать вид, что превью показано");
  const draft = path.join(dataRoot, "Отчёты", "Без канала-черновик.md");
  assert.equal(await readFile(draft, "utf8"), MARKDOWN);
});

test("skill_list показывает все десять скиллов с названием и описанием", async () => {
  const skillList = tools.createReportTools(deps()).find((tool) => tool.name === "skill_list");
  const result = await skillList.execute({});
  const files = (await readdir(skillsDir)).filter((name) => name.endsWith(".md"));
  assert.equal(files.length, 10, "в папке скиллов изменилось число отчётных навыков");
  assert.ok(result.includes(`Скиллы отчётов (${files.length})`), "список не сообщает, сколько скиллов найдено");
  for (const file of files) {
    const slug = file.replace(/\.md$/, "");
    assert.ok(result.includes(slug), `скилл ${slug} не попал в список`);
  }
  assert.ok(result.includes("skill_read"), "список должен подсказать, как прочитать скилл");
});

test("skill_read отдаёт текст скилла по его slug и по названию", async () => {
  const skillRead = tools.createReportTools(deps()).find((tool) => tool.name === "skill_read");
  const bySlug = await skillRead.execute({ name: "fdb-miloserdie" });
  const byTitle = await skillRead.execute({ name: "ФДБ — Милосердие" });
  assert.ok(bySlug.includes("## Порядок работы"), "скилл прочитан не полностью");
  assert.equal(byTitle, bySlug, "поиск по названию и по slug обязан приводить к одному файлу");
  const byAlias = await skillRead.execute({ skill: "fdb-miloserdie" });
  assert.equal(byAlias, bySlug, "скиллы зовут аргумент по-разному — skill_read обязан понимать оба");
});

test("skill_read на несуществующий скилл объясняет это по-русски и велит посмотреть список", async () => {
  const skillRead = tools.createReportTools(deps()).find((tool) => tool.name === "skill_read");
  await assert.rejects(
    () => skillRead.execute({ name: "такого-нет" }),
    /не найден[\s\S]*skill_list/,
    "агент должен понять, что делать дальше",
  );
});

test("skill_list не падает на пустой папке, а честно говорит, что скиллов нет", async () => {
  const empty = path.join(buildDir, "пустые-скиллы");
  await mkdir(empty, { recursive: true });
  const skillList = tools.createReportTools(deps({ skillsDir: empty })).find((tool) => tool.name === "skill_list");
  assert.match(await skillList.execute({}), /Скиллов отчётов нет/);
});

test("fill_sample берёт образец с диска и кладёт заполненный документ в «Отчёты»", async () => {
  const sample = path.join(buildDir, "ОБРАЗЕЦ ЗАПОЛНЕНИЯ.rtf");
  await writeFile(
    sample,
    [
      "{\\rtf1\\ansi\\ansicpg1251\\deff0{\\fonttbl{\\f0 Times New Roman;}}\\f0\\fs22",
      "ОТЧЕТ за 2026 год",
      "\\trowd\\trgaph108\\cellx2000\\cellx4000",
      "3.1.2\\cell Работа с подростками\\cell Дата\\cell",
      "\\row",
      "\\trowd\\trgaph108\\cellx2000\\cellx4000",
      "\\cell Название\\cell Дата\\cell",
      "\\row",
      "}",
    ].join("\n"),
    "utf8",
  );
  const fill = tools.createReportTools(deps()).find((tool) => tool.name === "fill_sample");
  const result = await fill.execute({
    sample_path: sample,
    title: "Подросток 2026",
    markdown: ["| 3.1.2 | Работа с подростками | Дата |", "|  | Клуб «Омега» | 12.03.2026 |"].join("\n"),
    replacements: [["2026 год", "2027 год"]],
  });

  const filled = path.join(dataRoot, "Отчёты", "Подросток 2026.rtf");
  assert.ok(result.includes(filled), "инструмент не назвал путь к заполненному образцу");
  const text = await readFile(filled, "utf8");
  assert.equal(tools.braceBalance(text), 0, "заполненный образец не откроется: скобки разъехались");
  const decoded = tools.rtfText(tools.tokenizeRtf(text));
  assert.ok(decoded.includes("Клуб «Омега»"), "строка данных не вписалась в образец");
  assert.ok(decoded.includes("2027 год"), "период в шапке образца не заменился");
  assert.ok((await readFile(path.join(dataRoot, "Отчёты", "Подросток 2026.md"), "utf8")).includes("Клуб «Омега»"));
});
