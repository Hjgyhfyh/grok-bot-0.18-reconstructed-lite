import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/*
 * Отчёт, готовый к сдаче, доходил до пользователя обычным сообщением в ленте:
 * агент показывал черновик инструментом `report_preview`, и на этом всё. Файла
 * на диске не было и принтера тоже — единственный способ получить отчёт был
 * попросить агента самого вызвать `save_report`, а заведующая библиотеки не
 * должна этим заниматься. Кнопок под отчётом не существовало вовсе, и проверить
 * это можно было только глазами: сборка и типизатор были зелёными.
 *
 * Тест закрывает три вещи по отдельности:
 *   1. какое сообщение считается отчётом (модель на renderer-е);
 *   2. что под отчётом появляются именно две кнопки, и каждая зовёт свой метод
 *      моста — а не общий, и не чужой;
 *   3. что главный процесс по этому методу действительно пишет файл на диск.
 *
 * И ещё одно, самое дорогое по опыту проекта: `bridgeRpcEdge` строит функцию
 * только для ключей из `MAIN_METHOD_TABLE`, обработчик без записи в таблице
 * молча не вызывается, а обёртка preload без обработчика падает уже у
 * пользователя. Поэтому тест проверяет все три места сразу.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Каталог сборки лежит внутри репозитория: `react-dom` из `node_modules` и
// `react` из собранного модуля должны быть одной и той же копией, иначе React
// не увидит свои хуки.
const buildDir = mkdtempSync(path.join(repoRoot, "report-actions-tmp-"));
test.after(() => rmSync(buildDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
  await build({
    entryPoints: [entry],
    outfile: path.join(buildDir, outfile),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    jsx: "automatic",
    // React и react-dom остаются общими с тестом: вторая копия React не видит
    // хуки react-dom, и компонент падает на первом же useState.
    external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"],
    // Кнопки подключают свой стиль через импорт css; для теста он не нужен,
    // а без заглушки esbuild отказывается собирать модуль вообще.
    loader: { ".css": "empty" },
    logLevel: "silent",
  });
  return import(pathToFileURL(path.join(buildDir, outfile)).href);
}

const reportMarkdown = [
  "## 1. Отчёт о работе библиотеки",
  "",
  "### 1.1. Обслуживание читателей",
  "",
  "| Период | Читателей | Новых поступлений |",
  "| --- | --- | --- |",
  "| 1 квартал | 1 240 | 86 |",
  "| 2 квартал | 1 318 | 91 |",
  "",
  "- Книговыдача выросла на 6 %.",
].join("\n");
const reportPreview = `Годовой отчёт библиотеки\n\n${reportMarkdown}`;

await bundle(path.join(repoRoot, "frontend", "src", "production", "report-actions-model.ts"), "model.mjs");
const reportActionsModule = await bundle(
  path.join(repoRoot, "frontend", "src", "recovered", "features", "conversation", "cards", "transcript-card", "views", "report-actions.tsx"),
  "component.mjs",
);
const reportFilePort = await bundle(
  path.join(repoRoot, "source", "electron-main", "reports", "report-file-port.ts"),
  "port.mjs",
);
const model = await bundle(path.join(repoRoot, "frontend", "src", "production", "report-actions-model.ts"), "model-check.mjs");

// ───────────────────── окно для настоящего клика по кнопке ─────────────────────

const { Window } = await import("happy-dom");
const window = new Window({ url: "http://127.0.0.1/" });
// `navigator` в Node — свойство только на чтение, поэтому через defineProperty.
for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "window" ? window : window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { act, createElement } = await import("react");

function stubBridge() {
  const calls = [];
  return {
    calls,
    bridge: {
      async saveFile(...args) {
        calls.push(["saveFile", ...args]);
        return { saved: true, path: "C:\\Загрузки\\Годовой отчёт.docx" };
      },
      async print(...args) {
        calls.push(["print", ...args]);
        return { printed: true };
      },
    },
  };
}

async function renderActions(report, bridge) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(reportActionsModule.ReportActions, { report, bridge }));
  });
  return { container, root };
}

const clickByLabel = async (container, label) => {
  const button = [...container.querySelectorAll("button")].find((node) => node.textContent.trim() === label);
  assert.ok(button != null, `под отчётом нет кнопки «${label}»`);
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
};

// ───────────────────────────── отчёт или переписка ─────────────────────────────

test("сообщение с таблицей или разделами считается отчётом, а короткий ответ — нет", () => {
  const report = model.detectReportMessage(reportPreview);
  assert.notEqual(report, null, "готовый отчёт не опознан, под ним не появятся кнопки");
  assert.equal(report.title, "Годовой отчёт библиотеки", "имя файла взято не из строки-заголовка");
  assert.equal(report.markdown, reportMarkdown, "в файл уйдёт текст вместе со строкой-заголовка");

  assert.equal(model.detectReportMessage("Готово, отчёт лежит в папке Отчёты."), null,
    "короткий ответ помощника принят за отчёт — под перепиской появятся лишние кнопки");
  assert.equal(model.detectReportMessage(""), null, "пустое сообщение принято за отчёт");
});

// ───────────────────────────── две кнопки ─────────────────────────────

test("под готовым отчётом появляются ровно две кнопки: «Сохранить» и «Печать»", async () => {
  const { bridge } = stubBridge();
  const { container, root } = await renderActions({ title: "Годовой отчёт библиотеки", markdown: reportMarkdown }, bridge);
  const labels = [...container.querySelectorAll("button")].map((node) => node.textContent.trim());
  assert.deepEqual(labels, ["Сохранить", "Печать"], "пользователь просил две отдельные кнопки, а не одну общую");
  await act(async () => root.unmount());
});

test("кнопка «Сохранить» зовёт сохранение с текстом отчёта и форматом по умолчанию", async () => {
  const { calls, bridge } = stubBridge();
  const { container, root } = await renderActions({ title: "Годовой отчёт библиотеки", markdown: reportMarkdown }, bridge);
  await clickByLabel(container, "Сохранить");
  assert.equal(calls.length, 1, "нажатие «Сохранить» вызвало не один метод");
  assert.deepEqual(calls[0], ["saveFile", "Годовой отчёт библиотеки", reportMarkdown, "docx"],
    "в главный процесс ушло не то название, не тот текст или не тот формат по умолчанию");
  assert.equal(container.querySelector(".sand-report-actions__status")?.textContent?.includes("Годовой отчёт.docx"), true,
    "пользователю не сказали, куда сохранился файл");
  await act(async () => root.unmount());
});

test("кнопка «Печать» зовёт печать и не трогает сохранение", async () => {
  const { calls, bridge } = stubBridge();
  const { container, root } = await renderActions({ title: "Годовой отчёт библиотеки", markdown: reportMarkdown }, bridge);
  await clickByLabel(container, "Печать");
  assert.deepEqual(calls, [["print", "Годовой отчёт библиотеки", reportMarkdown]],
    "печать пошла не туда: либо вместе с сохранением, либо с чужим текстом");
  await act(async () => root.unmount());
});

test("без моста кнопки остаются видимыми и говорят почему, вместо того чтобы молча не работать", async () => {
  const { container, root } = await renderActions({ title: "Годовой отчёт библиотеки", markdown: reportMarkdown }, null);
  const disabled = [...container.querySelectorAll("button")].every((node) => node.disabled === true);
  assert.equal(disabled, true, "кнопки выглядят рабочими, хотя моста в окне нет");
  assert.notEqual(container.querySelector(".sand-report-actions__hint")?.textContent, "",
    "пользователю не сказали, почему кнопки не нажимаются");
  await act(async () => root.unmount());
});

// ───────────────────────────── файл на диске ─────────────────────────────

function reportPortFor(overrides) {
  const dialogs = [];
  const written = [];
  const port = reportFilePort.createReportFilePort({
    getMainWindow: () => null,
    createHiddenWindow: () => null,
    showSaveDialog: async (_window, options) => {
      dialogs.push(options);
      return overrides.prompt;
    },
    writeFile: async (target, bytes) => {
      written.push({ target, bytes });
      await overrides.write(target, bytes);
    },
    createPrintWindow: () => overrides.printWindow,
    downloadsDir: os.tmpdir(),
  });
  return { port, dialogs, written };
}

test("по «Сохранить» главный процесс спрашивает место и кладёт туда настоящий документ", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dbbot-report-"));
  const target = path.join(dir, "Годовой отчёт библиотеки.docx");
  const { port, dialogs, written } = reportPortFor({
    prompt: { canceled: false, filePath: target },
    write: async (file, bytes) => { await (await import("node:fs/promises")).writeFile(file, bytes); },
    printWindow: null,
  });

  const outcome = await port.saveFile({ title: "Годовой отчёт библиотеки", markdown: reportMarkdown, format: "docx" });
  assert.equal(outcome.saved, true, `файл не записался: ${JSON.stringify(outcome)}`);
  assert.equal(existsSync(target), true, "после сохранения файла на диске нет");
  assert.ok(statSync(target).size > 0, "файл создан, но пустой");
  const head = readFileSync(target).subarray(0, 2).toString("latin1");
  assert.equal(head, "PK", "в файле с расширением docx лежит не документ Word");
  assert.match(dialogs[0].defaultPath, /\.docx$/, "в окне сохранения не был предложен формат по умолчанию");
  assert.deepEqual(written.map((item) => item.target), [target], "файл записан не туда, куда выбрал пользователь");
  assert.deepEqual(dialogs[0].filters[0].extensions, ["docx", "rtf", "odt", "md"],
    "в окне сохранения нет всех четырёх форматов, агент умеет писать их все");
  rmSync(dir, { recursive: true, force: true });
});

test("закрытое окно сохранения не считается ошибкой и не оставляет файла", async () => {
  const { port, written } = reportPortFor({
    prompt: { canceled: true },
    write: async () => { throw new Error("файл не должен был записываться"); },
    printWindow: null,
  });
  const outcome = await port.saveFile({ title: "Годовой отчёт", markdown: reportMarkdown });
  assert.deepEqual(outcome, { saved: false, reason: "cancelled" }, "отмена окна сохранения дойдёт до пользователя как сбой");
  assert.deepEqual(written, [], "после отмены что-то всё равно записали на диск");
});

test("«Печать» открывает системное окно печати, а не молча отправляет отчёт на принтер", async () => {
  const printed = [];
  const { port } = reportPortFor({
    prompt: { canceled: true },
    write: async () => {},
    printWindow: {
      webContents: {
        loadURL: async (url) => { printed.push(["loadURL", url]); },
        executeJavaScript: async () => true,
        print: (options, callback) => { printed.push(["print", options]); callback(true, ""); },
      },
      isDestroyed: () => false,
      destroy: () => { printed.push(["destroy"]); },
    },
  });

  const outcome = await port.printReport({ title: "Годовой отчёт библиотеки", markdown: reportMarkdown });
  assert.deepEqual(outcome, { printed: true }, `печать не состоялась: ${JSON.stringify(outcome)}`);
  const options = printed.find(([kind]) => kind === "print")?.[1];
  assert.equal(options.silent, false, "отчёт ушёл на принтер без окна: пользователь не выбрал принтер, бумагу и число копий");
  assert.equal(options.pageSize, "A4", "отчёт напечатан не на А4");
  const html = printed.find(([kind]) => kind === "loadURL")?.[1] ?? "";
  assert.equal(decodeURIComponent(html).includes("Годовой отчёт библиотеки"), true, "на печать ушла пустая страница");
  assert.equal(printed.some(([kind]) => kind === "destroy"), true, "окно печати осталось висеть после печати");
});

// ───────────────────────── три места, без которых кнопки мертвы ─────────────────────────

test("методы сохранения и печати объявлены в таблице, обработаны и обёрнуты", async () => {
  const [table, mainEdge, preload] = await Promise.all([
    readFile(path.join(repoRoot, "source", "shared", "rpc", "main.ts"), "utf8"),
    readFile(path.join(repoRoot, "source", "electron-main", "main-edge.ts"), "utf8"),
    readFile(path.join(repoRoot, "source", "electron-preload", "preload.ts"), "utf8"),
  ]);

  assert.match(table, /saveReportFile: \{ args: "object" \}/, "без записи в MAIN_METHOD_TABLE моста не существует");
  assert.match(table, /printReport: \{ args: "object" \}/, "без записи в MAIN_METHOD_TABLE печати не существует");
  assert.match(mainEdge, /saveReportFile: \(raw\)/, "в главном процессе нет обработчика сохранения");
  assert.match(mainEdge, /printReport: \(raw\)/, "в главном процессе нет обработчика печати");
  assert.match(preload, /edge\("saveReportFile"/, "preload не отдаёт метод сохранения интерфейсу");
  assert.match(preload, /edge\("printReport"/, "preload не отдаёт метод печати интерфейсу");
});