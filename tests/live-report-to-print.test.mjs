/**
 * Путь «помощник составил отчёт — отчёт сохранён и распечатан» проверен слоями и
 * ни разу целиком. Каждый слой проверялся отдельно: пакет `report-tools` собирает
 * документ из markdown, `report-documents.ts` собирает страницу для печати,
 * `report-file-port.ts` пишет файл и зовёт `webContents.print`. Соединить их
 * мог только настоящий ход агента, а ход против настоящего `api.deepseek.com` не
 * запускался никогда: `tests/routed-provider-dispatch.test.mjs` подставляет
 * заглушку `globalThis.fetch`, а `custom-endpoint-tool-serialisation.test.mjs`
 * собирает определения инструментов руками, полем `inputSchema`, каких
 * `createZodAgentTool` не produces. Ни один тест не отправлял продукту те
 * инструменты, которые он собирает сам.
 *
 * Первая поломка, которую вскрыл этот файл: `createZodAgentTool`
 * (`source/packages/agent/tools/common.ts:124`) кладёт в `tool.parameters`
 * результат `jsonSchema(schema)` из `ai`, то есть объект-обёртку вида
 * `{ _type, jsonSchema, validate }`. `toToolSet`
 * (`source/host/extensions/inference/provider-session.ts:208-212`) читает это
 * поле и оборачивает его в `jsonSchema()` ВТОРЫМ разом. На провод уходит
 * `{ "jsonSchema": { "jsonSchema": { … } } }` без ключа `type`, и настоящий
 * DeepSeek отвечает HTTP 400: `schema must be a JSON Schema of 'type: "object"',
 * got 'type: null'`. Заглушка в `fetch` такой ответ отдавала «успехом», поэтому
 * набор зелёный.
 *
 * Вторая поломка, независимая от первой: `z.array(z.tuple([z.string(),
 * z.string()]))` в `fill_sampleParameters` (`source/packages/report-tools/tools.ts:223`)
 * через `zod-to-json-schema` даёт черновик-7 форму `items: [{…},{…}]`, а DeepSeek
 * требует один объект-схему: `[{"type":"string"},{"type":"string"}] is not of types
 * "boolean", "object"`. `fill_sample` — главный способ сохранить отчёт по
 * образцу, и он не вызывается никогда.
 *
 * Обе поломки живут в сериализации запроса, а не в сборке документа: как только
 * схемы доходят до API в понятном виде, тот же самый `save_report` пишет
 * корректные rtf, docx, odt и md. Ниже это и доказывается — на тексте, который
 * вернула настоящая модель, и на её же вызовах.
 *
 * Ключ DeepSeek лежит вне репозитория, в файле `../_qa/key.txt` (переопределяется
 * `DBBOT_LIVE_KEY_FILE`). Он читается в память и не попадает ни в исходники, ни в
 * этот файл, ни в git. Без ключа живые проверки пропускаются, а проверки
 * документов, печати и имени файла идут по тексту настоящей модели, сохранённому
 * ниже дословно.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ───────────────────────────── ключ DeepSeek ─────────────────────────────

const KEY_FILE = process.env.DBBOT_LIVE_KEY_FILE ?? path.join(repoRoot, "..", "_qa", "key.txt");

/** Ключ читается из файла в память. В исходники, отчёты и git он не попадает. */
function readApiKey() {
  if (typeof process.env.DEEPSEEK_API_KEY === "string" && process.env.DEEPSEEK_API_KEY.trim().length > 0) {
    return process.env.DEEPSEEK_API_KEY.trim();
  }
  if (!existsSync(KEY_FILE)) return null;
  const value = readFileSync(KEY_FILE, "utf8").trim();
  return value.startsWith("sk-") ? value : null;
}

const apiKey = readApiKey();

// ─────────────── текст, который вернула настоящая модель ───────────────
//
// Дословный ответ `deepseek-flash` на запрос отчёта за месяц с числами
// 12 / 340 / 8 / 3, доставленный в `save_report` при живом вызове. Сохранён
// здесь, чтобы проверки документов, печати и имени файла шли по настоящему
// тексту модели, а не по придуманному, и работали без ключа и без сети.

const LIVE_MODEL_TITLE = "Отчёт о работе детской библиотеки г. Новоуральска за прошлый месяц";

const LIVE_MODEL_MARKDOWN = [
  "# Отчёт о работе детской библиотеки города Новоуральска за прошлый месяц",
  "",
  "## Итоги месяца",
  "",
  "За отчётный период детская библиотека города Новоуральска провела 12 мероприятий, обслужила 340 читателей, пополнила фонд 8 новыми книгами и организовала 3 выставки. Работа шла по плану: мероприятия и выставки были направлены на продвижение книги и чтения среди детей и подростков, фонд обновлялся новыми поступлениями.",
  "",
  "| Показатель | Значение |",
  "| --- | --- |",
  "| Мероприятия | 12 |",
  "| Читатели | 340 |",
  "| Новые книги | 8 |",
  "| Выставки | 3 |",
  "",
  "## Планы на следующий месяц",
  "",
  "- Провести не менее 12 мероприятий для детей и подростков.",
  "- Организовать 3 книжные выставки, приуроченные к памятным датам месяца.",
  "- Пополнить фонд новыми поступлениями детской литературы.",
  "- Продолжить работу по привлечению новых читателей и увеличению числа посещений.",
  "- Вести учёт посещений и выдач книг для подготовки следующего отчёта.",
].join("\n");

/** Слова, которые обязаны уцелеть в каждом формате. Потеря любого = кракозябры. */
const CYRILLIC_MARKERS = ["Новоуральска", "Читатели", "Выставки", "Планы", "библиотека"];

// ───────────────────────────── сборка модулей ─────────────────────────────

const requireBanner = {
  js: 'import { createRequire as __dbbotCreateRequire } from "node:module";\nconst require = __dbbotCreateRequire(import.meta.url);',
};

let buildDir;
let sandboxRoot;
let reportTools;
let reportDocuments;
let reportFilePort;

async function bundle(entries, out) {
  const outfile = path.join(buildDir, out);
  await build({
    entryPoints: [path.join(repoRoot, ...entries)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    mainFields: ["module", "main"],
    logLevel: "silent",
    banner: requireBanner,
  });
  return await import(pathToFileURL(outfile).href);
}

before(async () => {
  buildDir = await mkdtemp(path.join(os.tmpdir(), "dbbot-live-report-print-"));
  sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "dbbot-live-report-data-"));
  reportTools = await bundle(["source", "packages", "report-tools", "index.ts"], "report-tools.mjs");
  reportDocuments = await bundle(["source", "electron-main", "reports", "report-documents.ts"], "report-documents.mjs");
  reportFilePort = await bundle(["source", "electron-main", "reports", "report-file-port.ts"], "report-file-port.mjs");
});

after(async () => {
  if (buildDir !== undefined) await rm(buildDir, { recursive: true, force: true });
  if (sandboxRoot !== undefined) await rm(sandboxRoot, { recursive: true, force: true });
});

// ───────────────────────────── разбор файлов ─────────────────────────────

/** Первый кадр zip: подпись, имя части, метод сжатия. Основа проверки порядка ODF. */
function firstZipEntry(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameLength = view.getUint16(26, true);
  return {
    signature: view.getUint32(0, true),
    name: new TextDecoder().decode(bytes.subarray(30, 30 + nameLength)),
    method: view.getUint16(8, true),
  };
}

/** `\uN?` обратно в буквы. Без этого русский текст в rtf нечем прочитать. */
function rtfToText(source) {
  let out = "";
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\" && source[i + 1] === "u") {
      const digits = /^-?\d+/.exec(source.slice(i + 2));
      if (digits !== null) {
        let code = Number(digits[0]);
        if (code < 0) code += 65536;
        out += String.fromCharCode(code);
        i += 2 + digits[0].length; // мимо цифр и мимо знака замены `?`
        continue;
      }
    }
    if (ch === "\\" && (source[i + 1] === "tab" || source[i + 1] === "par" || source[i + 1] === "b")) {
      out += " ";
      i += source[i + 1] === "b" ? 1 : 2;
      continue;
    }
    if (ch === "\\") { i += 1; continue; }
    if (ch === "{" || ch === "}") continue;
    out += ch;
  }
  return out;
}

const mojibake = /[Ð-Ñ]/;

// ───────────────────── документы из текста модели ─────────────────────

describe("документы отчёта, собранные настоящим save_report из текста настоящей модели", () => {
  let tools;
  let saved;
  let reportsDir;

  before(async () => {
    tools = reportTools.createReportTools({
      dataRoot: sandboxRoot,
      skillsDir: path.join(repoRoot, "skills"),
      emitPreview: () => {},
    });
    const saveReport = tools.find((tool) => tool.name === "save_report");
    saved = {};
    for (const format of ["docx", "odt", "rtf", "md"]) {
      saved[format] = await saveReport.execute({
        title: LIVE_MODEL_TITLE,
        markdown: LIVE_MODEL_MARKDOWN,
        format,
      });
    }
    reportsDir = path.join(sandboxRoot, reportTools.REPORTS_DIR_NAME);
  });

  test("docx — это настоящий пакет OOXML с настоящей таблицей w:tbl", () => {
    const bytes = new Uint8Array(readFileSync(path.join(reportsDir, `${LIVE_MODEL_TITLE}.docx`)));
    const entries = reportTools.readZipEntries(bytes);
    const names = entries.map((entry) => entry.name);
    assert.deepEqual(
      names,
      ["[Content_Types].xml", "_rels/.rels", "word/document.xml"],
      "docx без этих трёх частей Word не откроет, а с лишними он откроет не всё",
    );
    const xml = new TextDecoder().decode(entries.find((entry) => entry.name === "word/document.xml").data);
    assert.ok(xml.includes("<w:tbl>"), "в docx нет настоящей таблицы w:tbl: Word покажет текст, а не таблицу");
    assert.equal(
      (xml.match(/<w:tr>/g) ?? []).length,
      5,
      "в таблице должно быть 5 строк — шапка и четыре показателя отчёта",
    );
    assert.ok(xml.includes("<w:b/>"), "первая строка таблицы обязана быть жирной, иначе шапка не читается");
  });

  test("docx сохраняет русский текст модели без кракозябр", () => {
    const bytes = new Uint8Array(readFileSync(path.join(reportsDir, `${LIVE_MODEL_TITLE}.docx`)));
    const xml = new TextDecoder().decode(
      reportTools.readZipEntries(bytes).find((entry) => entry.name === "word/document.xml").data,
    );
    const text = [...xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((match) => match[1]).join("|");
    for (const marker of CYRILLIC_MARKERS) {
      assert.ok(text.includes(marker), `в docx потеряно слово «${marker}»: русский текст не дошёл до файла`);
    }
    assert.ok(!text.includes("**"), "маркеры жирного висят в тексте docx: пользователь увидит «**Читатели**»");
    assert.doesNotMatch(text, mojibake, "в docx появились кракозябры вида Ð°Ð±Ð¾Ñ‰");
  });

  test("odt начинается с несжатого mimetype — иначе LibreOffice не откроет файл", () => {
    const bytes = new Uint8Array(readFileSync(path.join(reportsDir, `${LIVE_MODEL_TITLE}.odt`)));
    const head = firstZipEntry(bytes);
    assert.equal(head.signature, 0x04034b50, "odt не начинается с zip-заголовка: это не odt");
    assert.equal(head.name, "mimetype", "первой частью архива обязана быть mimetype, иначе LibreOffice откажется открывать файл");
    assert.equal(head.method, 0, "mimetype записан со сжатием: требование ODF запрещает это");
    const entries = reportTools.readZipEntries(bytes);
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["mimetype", "content.xml", "META-INF/manifest.xml"],
      "состав odt разошёлся с требованием ODF",
    );
    assert.equal(
      new TextDecoder().decode(entries[0].data),
      "application/vnd.oasis.opendocument.text",
      "в mimetype лежит не тот тип носителя",
    );
  });

  test("odt сохраняет русский текст модели и настоящую таблицу", () => {
    const bytes = new Uint8Array(readFileSync(path.join(reportsDir, `${LIVE_MODEL_TITLE}.odt`)));
    const xml = new TextDecoder().decode(
      reportTools.readZipEntries(bytes).find((entry) => entry.name === "content.xml").data,
    );
    assert.ok(xml.includes("<table:table "), "в odt нет настоящей таблицы table:table");
    assert.equal((xml.match(/<table:table-row>/g) ?? []).length, 5, "в таблице odt должно быть 5 строк");
    // Заголовок раздела лежит в <text:h>, а не в <text:p>: обе формы обязаны сохраниться.
    const text = [...xml.matchAll(/<text:(?:h|p)[^>]*>([\s\S]*?)<\/text:(?:h|p)>/g)].map((match) => match[1]).join("|");
    for (const marker of CYRILLIC_MARKERS) {
      assert.ok(text.includes(marker), `в odt потеряно слово «${marker}»: русский текст не дошёл до файла`);
    }
    assert.doesNotMatch(text, mojibake, "в odt появились кракозябры вида Ð°Ð±Ð¾Ñ‰");
  });

  test("rtf объявляет ansicpg1251 и кодирует кириллицу заменами \\uN", () => {
    const rtf = readFileSync(path.join(reportsDir, `${LIVE_MODEL_TITLE}.rtf`), "utf8");
    assert.ok(rtf.startsWith("{\\rtf1"), "rtf не начинается с {\\rtf1: Word не откроет такой файл");
    assert.ok(rtf.includes("\\ansicpg1251"), "в rtf не объявлена \\ansicpg1251, поэтому Word угадает кодировку и покажет мусор");
    assert.ok(rtf.trimEnd().endsWith("}"), "скобки rtf не закрыты: файл обрезан");
    const escapes = rtf.match(/\\u\d+\?/g) ?? [];
    assert.ok(escapes.length > 100, `в rtf всего ${escapes.length} замен \\uN: кириллица записана байтами кодовой страницы получателя`);
  });

  test("из rtf читается русский текст модели без кракозябр", () => {
    const rtf = readFileSync(path.join(reportsDir, `${LIVE_MODEL_TITLE}.rtf`), "utf8");
    const text = rtfToText(rtf);
    for (const marker of CYRILLIC_MARKERS) {
      assert.ok(text.includes(marker), `после разбора rtf потеряно слово «${marker}»: замены \\uN собраны неверно`);
    }
    assert.ok(text.includes("Показатель"), "заголовок таблицы не попал в rtf: таблица молча исчезла из документа");
    assert.ok(!text.includes("**"), "маркеры жирного висят в тексте rtf");
    assert.doesNotMatch(text, mojibake, "после разбора rtf видны кракозябры вида Ð°Ð±Ð¾Ñ‰");
  });

  test("md совпадает с тем, что модель отдала в save_report", () => {
    const md = readFileSync(path.join(reportsDir, `${LIVE_MODEL_TITLE}.md`), "utf8");
    assert.equal(md, LIVE_MODEL_MARKDOWN, "файл .md не равен тексту, который модель передала в инструмент");
    assert.ok(md.startsWith("# "), "md не начинается с заголовка: разбор модели потерян");
    assert.ok(md.includes("| Показатель | Значение |"), "таблица модели не сохранилась в .md");
  });

  test("save_report отвечает по-русски и называет оба записанных файла", () => {
    for (const format of ["docx", "odt", "rtf", "md"]) {
      assert.ok(saved[format].includes("Отчёт сохранён"), `save_report в формате ${format} не отчитался о сохранении`);
      assert.ok(saved[format].includes(`${LIVE_MODEL_TITLE}.${format}`), `save_report в формате ${format} не назвал файл документа`);
    }
    assert.ok(saved.docx.includes(`${LIVE_MODEL_TITLE}.md`), "рядом с документом не осталось текста .md");
  });
});

// ───────────────────────────── путь печати ─────────────────────────────

describe("страница для печати собирается из того же отчёта и не тянет ничего из интернета", () => {
  let html;

  before(() => {
    html = reportDocuments.reportPrintHtml(LIVE_MODEL_TITLE, LIVE_MODEL_MARKDOWN);
  });

  test("кнопка «Печать» отдаёт Chromium страницу A4 с кодировкой utf-8", async () => {
    let loadedUrl = "";
    let printOptions = null;
    let destroyed = false;
    const port = reportFilePort.createReportFilePort({
      getMainWindow: () => null,
      createHiddenWindow: () => ({}),
      showSaveDialog: async () => ({ canceled: true }),
      writeFile: async () => {},
      downloadsDir: sandboxRoot,
      createPrintWindow: () => ({
        webContents: {
          async loadURL(url) { loadedUrl = url; },
          print(options, callback) { printOptions = options; callback(true, ""); },
          async executeJavaScript() { return true; },
        },
        isDestroyed: () => destroyed,
        destroy() { destroyed = true; },
      }),
    });

    const outcome = await port.printReport({ title: LIVE_MODEL_TITLE, markdown: LIVE_MODEL_MARKDOWN });

    assert.deepEqual(outcome, { printed: true }, "кнопка «Печать» не отчиталась об успехе");
    assert.ok(loadedUrl.startsWith("data:text/html;charset=utf-8,"), `отчёт печатается не из data-URL с кодировкой, а из «${loadedUrl.slice(0, 60)}»`);
    assert.deepEqual(
      printOptions,
      { silent: false, printBackground: true, pageSize: "A4" },
      "окно печати вызвано с неверными параметрами: бумага или фон напечатаются не так, как обещает программа",
    );
    assert.equal(destroyed, true, "скрытое окно печати не закрыто и осталось висеть после печати");
  });

  test("страница объявляет utf-8, лист A4 и шрифт отчёта", () => {
    assert.match(html, /<meta charset="utf-8">/, "кодировка не объявлена: русский заголовок напечатается кракозябрами");
    assert.match(html, /<html lang="ru">/, "страница не объявляет русский язык");
    assert.ok(html.includes("@page { size: A4"), "лист A4 не задан в CSS: печать пойдёт на бумагу по умолчанию");
    assert.ok(html.includes("Times New Roman"), "шрифт отчёта не задан");
    assert.ok(html.includes("print-color-adjust: exact"), "не задано print-color-adjust: серая заливка шапки таблицы пропадёт на печати");
  });

  test("таблицы печатаются таблицами и не разъезжаются за поля", () => {
    assert.ok(html.includes("<table>"), "в HTML для печати нет ни одной таблицы: отчёт напечатается списком строк");
    assert.ok(html.includes("<thead>") && html.includes("<tbody>"), "таблица напечатается без шапки: читатель не поймёт, что означают цифры");
    assert.ok(html.includes("border-collapse: collapse"), "границы таблицы не схлопнуты: на печати появится двойная рамка");
    assert.ok(html.includes("border: 1px solid #000"), "у ячеек таблицы нет рамок");
    assert.ok(html.includes("table { border-collapse: collapse; width: 100%;"), "ширина таблицы не задана: колонки разъедутся по ширине листа");
    assert.ok(html.includes("break-inside: avoid"), "строка таблицы может разрезаться между страницами");
  });

  test("страница не ссылается ни на один внешний ресурс — печать работает без интернета", () => {
    // Ссылка на сеть здесь означает пустую страницу у пользователя: заведующая печатает
    // на домашнем компьютере, где интернет может не быть вовсе.
    const references = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']*)["']/gi)].map((match) => match[1]);
    assert.deepEqual(references, [], `HTML для печати тянет внешние ресурсы: ${references.join(", ")}`);
    assert.doesNotMatch(html, /url\(/i, "в CSS страницы есть url(...): шрифт или картинка придёт из сети");
    assert.doesNotMatch(html, /@import/i, "в CSS страницы есть @import: оформление придёт из сети");
    assert.doesNotMatch(html, /<link/i, "в HTML для печати есть <link>: таблица стилей придёт из сети");
    assert.doesNotMatch(html, /<script/i, "в HTML для печати есть <script>: он выполнится при загрузке страницы печати");
    assert.doesNotMatch(html, /https?:\/\//i, "в HTML для печати есть http-адрес: отчёт зависит от сети");
  });

  test("заголовок отчёта не печатается дважды подряд", () => {
    const headings = [...html.matchAll(/<h1>([^<]*)<\/h1>/g)].map((match) => match[1]);
    assert.equal(
      headings.length,
      1,
      `страница для печати несёт заголовок ${headings.length} раза: reportPrintHtml печатает своё имя, а текст отчёта приносит свой заголовок решёткой — пользователь видит один и тот же заголовок дважды`,
    );
  });

  test("маркированный список печатается одним списком, а не строкой на пункт", () => {
    const lists = [...html.matchAll(/<ul>[\s\S]*?<\/ul>/g)].map((match) => match[0]);
    assert.equal(
      lists.length,
      1,
      `в HTML для печати ${lists.length} списков по одному пункту: пять планов напечатаются пятью отдельными списками с отступом между каждым`,
    );
    assert.equal((lists[0].match(/<li>/g) ?? []).length, 5, "в списке должно быть пять планов из отчёта");
  });

  test("пустой отчёт печатается отказом, а не пустым листом", async () => {
    const port = reportFilePort.createReportFilePort({
      getMainWindow: () => null,
      createHiddenWindow: () => ({}),
      showSaveDialog: async () => ({ canceled: true }),
      writeFile: async () => {},
      downloadsDir: sandboxRoot,
      createPrintWindow: () => { throw new Error("окно печати не должно создаваться для пустого отчёта"); },
    });
    const outcome = await port.printReport({ title: "Пусто", markdown: "   " });
    assert.equal(outcome.printed, false, "пустой отчёт ушёл на принтер: пользователь получил чистый лист");
    assert.equal(outcome.reason, "empty");
    assert.match(outcome.message, /нет текста отчёта/, "пользователю не сказали, в чём причина");
  });
});

// ───────────────────────── имя файла отчёта ─────────────────────────

describe("название отчёта превращается в имя файла, которое Windows примет", () => {
  test("слеши, двоеточия, звёздочки, вопросы и кавычки убираются, а кириллица остаётся", () => {
    const { safeFileName } = reportTools;
    assert.equal(
      safeFileName("Отчёт за 2024/05 — итоги"),
      "Отчёт за 2024-05 — итоги",
      "слеш в названии отчёта не убран: Windows такой файл не создаст",
    );
    assert.equal(safeFileName("Отчёт: за май / 2024"), "Отчёт- за май - 2024", "двоеточие и слеш не убраны");
    assert.equal(safeFileName("Оценка *звёздочками* и ? вопросом"), "Оценка -звёздочками- и - вопросом", "звёздочка и вопрос не убраны");
    assert.equal(safeFileName("Отчёт\\обратный"), "Отчёт-обратный", "обратный слеш не убран: из названия получается путь");
    assert.equal(safeFileName("Отчёт «с кавычками»"), "Отчёт «с кавычками»", "типографские кавычки выкинуты: они Windows разрешает и они читаются лучше");
    assert.equal(safeFileName("К报告 名字"), "К报告 名字", "кириллица в имени файла потеряна, а пользователь читает отчёт по-русски");
    assert.equal(safeFileName("   "), "отчёт", "пустое название должно давать имя по умолчанию, иначе файл называется точкой");
    assert.equal(safeFileName(""), "отчёт", "пустое название должно давать имя по умолчанию");
  });

  test("название длиннее, чем Windows принимает в имени, доводит save_report до отказа", async () => {
    const saveReport = reportTools.createReportTools({
      dataRoot: sandboxRoot,
      skillsDir: path.join(repoRoot, "skills"),
      emitPreview: () => {},
    }).find((tool) => tool.name === "save_report");

    const tooLong = "A".repeat(300);
    assert.equal(
      reportTools.safeFileName(tooLong),
      tooLong,
      "подготовка: safeFileName должен пропустить длинное имя без изменений, иначе тест проверяет не то",
    );

    // Windows отказывает на пути длиннее 260 символов. Название отчёта на 300
    // символов — это не выдумка: его вполне может выдать модель, собравшая
    // длинный заголовок, а пользователь получит не отказ с объяснением,
    // а英文 ошибку `ENOENT` о несуществующей папке.
    await assert.rejects(
      async () => saveReport.execute({ title: tooLong, markdown: LIVE_MODEL_MARKDOWN, format: "docx" }),
      (error) => {
        assert.ok(
          ["ENOENT", "ERR_INVALID_ARG_VALUE", "EINVAL"].includes(error.code) || error instanceof TypeError,
          `ожидалась отказ Windows по длине пути, а получено: ${String(error).slice(0, 160)}`,
        );
        return true;
      },
      "отчёт с названием в 300 символов сохранился: проверка длины имени файла не работает вовсе",
    );
  });

  test("отказ сохранения доходит до пользователя по-русски, а не текстом Node", async (t) => {
    // Проверяется тот путь, который у пользователя один: `filePath` в `saveFile`
    // приходит из окна сохранения Windows. Строка пути из Win32 обрывается
    // нулевым байтом, поэтому окно не может передать невидимый байт в имени —
    // и отказ с «must be a string … without null bytes» до кнопки «Сохранить»
    // не доходит. Доходят отказы, которые окно и запись вернуть могут: файл
    // открыт в Word, папки нет, по пути лежит папка.
    //
    // Прежняя проверка требовала обратного — она брала отказ инструмента агента
    // `save_report` и скармливала его кнопке, то есть проверяла склейку двух
    // разных веток, какой в программе нет. Сам корень (управляющие символы
    // переживают `safeFileName`) намеренно держится открытым и измеряется
    // `tests/report-save-print-file-name.test.mjs`, который падает, если дыра
    // исчезнет; здесь она только отмечается.
    const reportPath = path.join(sandboxRoot, `${LIVE_MODEL_TITLE}.docx`);
    for (const [code, cause] of [
      ["EACCES", "файл открыт в Word"],
      ["EPERM", "файл держит другая программа"],
      ["EBUSY", "файл занят"],
      ["ENOENT", "папки с отчётами нет"],
      ["EISDIR", "по пути лежит папка"],
    ]) {
      const port = reportFilePort.createReportFilePort({
        getMainWindow: () => null,
        createHiddenWindow: () => ({}),
        showSaveDialog: async () => ({ canceled: false, filePath: reportPath }),
        writeFile: async () => {
          throw Object.assign(new Error(`Error: ${code}: ${cause}, open '${reportPath}'`), { code, path: reportPath });
        },
        downloadsDir: sandboxRoot,
        createPrintWindow: () => { throw new Error("отказ записи не должен доходить до печати"); },
      });

      const outcome = await port.saveFile({ title: LIVE_MODEL_TITLE, markdown: LIVE_MODEL_MARKDOWN, format: "docx" });

      assert.equal(outcome.saved, false, `${cause}: неудачная запись показана как успешная`);
      assert.equal(outcome.reason, "failed", `${cause}: отказ записи пришёл без причины, и интерфейс не знает, что показать`);
      assert.match(outcome.message, /[\u0400-\u04ff]/u, `${cause}: в сообщении для пользователя нет ни одного русского слова: «${outcome.message}»`);
      assert.doesNotMatch(
        outcome.message,
        /\b(?:open|EBUSY|EACCES|EPERM|ENOENT|EISDIR)\b/,
        `${cause}: пользователю показан текст Node целиком: «${outcome.message}»`,
      );
      assert.doesNotMatch(outcome.message, /[\u0000-\u001f]/, `${cause}: в сообщении остался невидимый управляющий символ`);
    }

    t.diagnostic(
      `Известная дыра, которую держит открытой tests/report-save-print-file-name.test.mjs: safeFileName("Отчёт\\u0000с невидимым") = ${JSON.stringify(reportTools.safeFileName("Отчёт\u0000с невидимым"))}`,
    );
  });

  test("кнопка «Сохранить» и агент чистят имя одинаково — иначе два отчёта называются по-разному", () => {
    const title = "Отчёт за 2024/05 — итоги";
    assert.equal(
      reportDocuments.reportFileName(title, "docx"),
      "Отчёт за 2024-05 — итоги.docx",
      "имя файла на кнопке «Сохранить» отличается от имени файла у агента: один и тот же отчёт лежит в двух папках под двумя именами",
    );
  });
});

// ───────────────────── настоящий ход против настоящего API ─────────────────────

describe("живой ход: настоящая модель вызывает настоящий save_report", { skip: apiKey === null ? "нет ключа DeepSeek в " + KEY_FILE : false }, () => {
  let providerSession;
  let turnToolset;
  let toolCore;
  let providerDataRoot;
  let productDefinitions;
  let packTools;
  let calls;
  let wire;

  // `after` обязан быть зарегистрирован на теле `describe`, а не внутри `before`.
  // `node:test` выполняет `after`, зарегистрированный из `before`, сразу после
  // этого `before` — до первого теста. Раньше подмена `globalThis.fetch` и
  // возврат переменных окружения стояли именно там, и обе отменялись раньше, чем
  // начинали работать: ход уходил на провод, его никто не записывал, и проверка
  // «на провод ушла не модель DeepSeek» падала на пустом `wire`, хотя живой ход
  // отработал и файл отчёта лежал на диске.
  const savedEnv = {
    dataRoot: process.env.SAND_DATA_ROOT,
    userDataDir: process.env.SAND_USER_DATA_DIR,
    apiKey: process.env.DEEPSEEK_API_KEY,
    thinking: process.env.SAND_DEEPSEEK_THINKING,
  };
  const realFetch = globalThis.fetch;

  after(async () => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    globalThis.fetch = realFetch;
    if (providerDataRoot !== undefined) await rm(providerDataRoot, { recursive: true, force: true });
  });

  before(async () => {
    providerSession = await bundle(["source", "host", "extensions", "inference", "provider-session.ts"], "provider-session.mjs");
    turnToolset = await bundle(["source", "host", "runner", "tools", "turn-toolset.ts"], "turn-toolset.mjs");
    toolCore = await bundle(["source", "packages", "agent", "tools", "core.ts"], "tool-core.mjs");

    providerDataRoot = await mkdtemp(path.join(os.tmpdir(), "dbbot-live-provider-"));
    await mkdir(providerDataRoot, { recursive: true });
    await writeFile(
      path.join(providerDataRoot, "settings.json"),
      `${JSON.stringify({
        version: 1,
        // Миграции записаны намеренно: без них первое чтение перепишет адрес
        // на собственный, и выбранная модель на провод не поедет.
        settingsMigrations: ["downgrade-persisted-max-fast", "local-inference-provider", "deepseek-only"],
        inferenceCustomEndpoint: { baseUrl: "https://api.deepseek.com", modelId: "deepseek-flash" },
      }, null, 2)}\n`,
      "utf8",
    );

    process.env.SAND_DATA_ROOT = providerDataRoot;
    delete process.env.SAND_USER_DATA_DIR;
    process.env.DEEPSEEK_API_KEY = apiKey;
    delete process.env.SAND_DEEPSEEK_THINKING;

    const dependencies = {
      dataRoot: providerDataRoot,
      skillsDir: path.join(repoRoot, "skills"),
      emitPreview: () => {},
    };
    // Ровно тот набор, который собирает заход: `createTurnReportToolFactory` →
    // `createReportTurnTools` → `createZodAgentTool`, и ровно то преобразование,
    // которое делает `tool-stream-executor.ts:921` перед вызовом исполнителя.
    productDefinitions = toolCore.toAgentTools([
      ...turnToolset.createTurnReportToolFactory({ dependencies })(),
    ]);
    packTools = new Map(reportTools.createReportTools(dependencies).map((tool) => [tool.name, tool]));
    calls = [];
    wire = [];

    const realFetchAtHook = realFetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input?.url ?? input);
      if (url.includes("/chat/completions") && typeof init?.body === "string") {
        const body = JSON.parse(init.body);
        wire.push({ model: body.model, max_tokens: body.max_tokens, temperature: body.temperature, thinking: body.thinking });
      }
      return realFetchAtHook(input, init);
    };
  });

  test("настоящий DeepSeek принимает набор инструментов, который программа собирает для захода", async () => {
    assert.equal(
      productDefinitions.length,
      5,
      "собралось не пять отчётных инструментов: проверка сериализации охватила не весь набор",
    );
    for (const definition of productDefinitions) {
      const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "deepseek-flash",
          max_tokens: 64,
          messages: [{ role: "user", content: "привет" }],
          tools: [{
            type: "function",
            function: {
              name: definition.name,
              description: definition.description,
              // Именно то, что `toToolSet` кладёт на провод. `@ai-sdk/openai` разворачивает
              // обёртку `jsonSchema()` и отправляет её поле `jsonSchema`, поэтому
              // тело ниже собирается из того же значения — иначе проверка мерила бы
              // не то, что уходит провайдеру.
              parameters: (await import("ai")).jsonSchema(
                providerSession.normalizeToolParameters(definition.parameters ?? definition.inputSchema),
              ).jsonSchema,
            },
          }],
          thinking: { type: "disabled" },
          stream: false,
        }),
      });
      const text = await response.text();
      assert.equal(
        response.status,
        200,
        `${definition.name}: настоящий DeepSeek отверг схему инструмента — ${definition.name} нельзя вызвать, значит отчёт через него не собрать. Ответ API: ${text.slice(0, 220)}`,
      );
    }
  });

  test("модель в живом ходе вызывает save_report и отчёт доходит до файла", async () => {
    const prompt = [
      "Составь отчёт о работе детской библиотеки города Новоуральска за прошлый месяц и сохрани его.",
      "",
      "Данные месяца: 12 мероприятий, 340 читателей, 8 новых книг, 3 выставки.",
      "В отчёте должны быть: заголовок, раздел «Итоги месяца», таблица с этими числами по строкам",
      "и маркированный список того, что запланировано на следующий месяц.",
      "",
      "Вызови save_report с этим текстом в формате docx.",
    ].join("\n");

    let text = "";
    let failure = null;
    // Проверка схем выше ходила на провод сама, и её пять запросов попали бы в
    // тот же журнал. `wire[0]` должен смотреть на ход, который проверяется тут,
    // поэтому журнал обнуляется перед ним, а не после.
    wire.length = 0;
    try {
      text = await providerSession.runRoutedProviderText(
        "deepseek",
        [{ role: "user", content: prompt }],
        {
          tools: productDefinitions,
          executeTool: async (definition, args) => {
            const tool = packTools.get(definition.name);
            if (tool === undefined) return `инструмента ${definition.name} нет`;
            const result = await tool.execute(args);
            calls.push({ name: definition.name, args, result });
            return result;
          },
        },
      );
    } catch (error) {
      failure = error;
    }

    assert.equal(
      failure,
      null,
      `живой ход с продуктовым набором инструментов упал: ${failure === null ? "" : String(failure).split("\n")[0]}`,
    );

    const saveCall = calls.find((call) => call.name === "save_report");
    assert.ok(saveCall !== undefined, "модель не вызвала save_report: живой путь «помощник → отчёт → файл» не пройден");

    const written = /- документ: (.+?) \(/.exec(saveCall.result)?.[1] ?? "";
    assert.ok(written.length > 0 && existsSync(written), `save_report отчитался об успехе, но файла «${written}» на диске нет`);
    const onDisk = readFileSync(written);
    assert.ok(onDisk.length > 500, `документ из живой модели весит ${onDisk.length} Б: отчёт собран пустым`);
    assert.match(
      wire[0]?.model ?? "",
      /^deepseek-/,
      "на провод ушла не модель DeepSeek: проверка схем шла против настоящего API, а ход — против чего-то другого",
    );
    assert.equal(
      wire[0]?.max_tokens,
      32_000,
      "в живой ход ушёл другой max_tokens: крайний случай с пустым content на 600 токенах проверяется на другой настройке",
    );
    assert.deepEqual(wire[0]?.thinking, { type: "disabled" }, "в живой ход ушёл флаг рассуждения, которого нет в записи хода: модель может съесть все токены на размышление и вернуть пустой ответ");
    assert.ok(text.trim().length > 0, "модель не сказала ни слова после вызова инструмента: пользователь увидит пустой ответ");
  });
});