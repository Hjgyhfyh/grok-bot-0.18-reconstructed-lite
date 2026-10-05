import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(path.join(os.tmpdir(), "dbbot-qa-explore2-"));
async function bundle(entry, out) {
  await build({ entryPoints: [entry], outfile: path.join(dir, out), bundle: true, format: "esm", platform: "node", target: "node22", logLevel: "silent" });
  return import(pathToFileURL(path.join(dir, out)).href);
}
const model = await bundle(path.join(repoRoot, "frontend", "src", "production", "report-actions-model.ts"), "model.mjs");
const docs = await bundle(path.join(repoRoot, "source", "electron-main", "reports", "report-documents.ts"), "docs.mjs");

const body = "## Раздел\n\n" + "- пункт\n- пункт\n- пункт\n\n" + "Абзац подлиннее, чтобы длина тела была заведомо больше восьмидесяти символов, иначе проверка обрежется раньше.\n";

const samples = {
  "обычный отчёт с таблицей": "Годовой отчёт\n\n" + body,
  "отчёт одной прозой (без разделов и списков)":
    "Отчёт о работе библиотеки за 2024 год\n\nВ 2024 году библиотека обслужила 12480 читателей и выдала 21345 книг.\n\nФонд вырос на 640 единиц, на обновление потрачено 118000 рублей.\n\nЗакупки велись в основном по заявкам читателей.",
  "отчёт с подзаголовком и прозой":
    "Годовой отчёт\n\nКраткое резюме по итогам года.\n\n1. Книговыдача выросла на шесть процентов по сравнению с 2023 годом.\n\n2. Число читателей снизилось из-за ремонта в читальном зале.",
  "название из двух слов и цифр": "Отчёт 24\n\n" + body,
  "длинное название 200": "Я".repeat(200) + "\n\n" + body,
  "длинное название 201": "Я".repeat(201) + "\n\n" + body,
  "название с двоеточием и слешем": "Отчёт за 2024/05\n\n" + body,
  "название кавычками": "\"Отчёт\" за май\n\n" + body,
  "тело одной строкой с табуляцией": "План на месяц\n\nМероприятие\tОтветственный\tСрок\n" + "Читательская конференция\tИванова\t1 мая\n" + "Выставка\tПетрова\t5 мая\n" + "Круглый стол\tСидорова\t9 мая",
};
for (const [name, sample] of Object.entries(samples)) {
  const r = model.detectReportMessage(sample);
  console.log(`${name} -> ${r === null ? "НЕТ КНОПОК" : "кнопки есть, title=" + JSON.stringify(r.title.slice(0, 40))}`);
}

// сколько символов markdown укладывается в data-url для печати
for (const lines of [1000, 2000, 3000, 4000, 6000, 10000]) {
  const md = Array.from({ length: lines }, (_, i) => `Строка ${i}: русский текст для проверки объёма печатной страницы отчёта.`).join("\n\n");
  const html = docs.reportPrintHtml("Большой отчёт", md);
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  console.log(`markdown=${md.length} html=${html.length} data-url=${url.length}`);
}
await rm(dir, { recursive: true, force: true });