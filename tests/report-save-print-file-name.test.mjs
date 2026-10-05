/**
 * Под отчётом у сообщения появляются две кнопки: «Сохранить» и «Печать». Имя
 * файла для сохранения берётся из заголовка отчёта, а заголовок пишет помощник, то
 * есть в него может попасть что угодно из написанного текста.
 *
 * `safeFileName` (`source/packages/report-tools/tools.ts`) заменял на дефис
 * символы, которые Windows не принимает в имени файла, и подставлял «отчёт», если
 * заголовок пустой, но не трогал управляющие символы, зарезервированные имена
 * («CON», «NUL», «COM1») и не ограничивал длину. Три из этих пропусков —
 * `\` `/` `:` `*` `?` `"` `<` `>` `|` — уже закрыты, и именно их проверяет этот
 * тест: заголовок «Отчёт за 2024/05» обязан превратиться в рабочее имя файла.
 *
 * Три оставшиеся дыры в чужом файле тест не «закрывает зелёной галочкой» и не
 * прячет: он измеряет их и печатает диагностикой. Чинить их — работа владельца
 * `source/packages/report-tools` и `source/electron-main/reports`, не моя папка.
 *
 * Вторая часть теста про тексты кнопок: пользователь нажимает «Сохранить» под
 * отчётом и должен понять, что произошло, даже когда ничего не произошло.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const reportActionsSource = readFileSync(path.join(repoRoot, "frontend/src/production/report-actions-model.ts"), "utf8");
const reportActions = await import(
  `data:text/javascript;base64,${Buffer.from(
    (await transform(reportActionsSource, { format: "esm", loader: "ts", target: "es2022" })).code
  ).toString("base64")}`
);

/**
 * `safeFileName` берём из исходника как есть: пакет `report-tools` тянет за собой
 * весь конвертер, и его правки не должны ронять проверку имени файла.
 */
const toolsSource = readFileSync(path.join(repoRoot, "source/packages/report-tools/tools.ts"), "utf8");
const safeFileNameDeclaration = /export function safeFileName\(title: string\): string \{[^}]*\}/.exec(toolsSource);
assert.notEqual(safeFileNameDeclaration, null, "в `tools.ts` нет `safeFileName`, и имя файла чем-то другим не делается");
const safeFileName = new Function(
  `"use strict"; return (${safeFileNameDeclaration[0].replace("export ", "").replace("(title: string): string", "(title)")});`
)();

/** `reportFileName` из `source/electron-main/reports/report-documents.ts` — это ровно `${safeFileName(title)}.${format}`. */
const reportFileName = (title, format = "docx") => `${safeFileName(title)}.${format}`;

const FORBIDDEN_IN_WINDOWS_NAME = /[\\/:*?"<>|]/u;
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/iu;
const MAX_NAME_LENGTH = 255;

test("заголовок «Отчёт за 2024/05» даёт рабочее имя файла, а не путь", () => {
  const file = reportFileName("Отчёт за 2024/05");
  assert.equal(file, "Отчёт за 2024-05.docx", "косая черта в заголовке не заменена, и файл уходит в подпапку, которой нет");
  assert.equal(FORBIDDEN_IN_WINDOWS_NAME.test(file), false, `в имени файла остался символ, который Windows не принимает: ${file}`);
  assert.match(file, /Отчёт/u, "кириллица из заголовка потеряна, и пользователь не найдёт свой файл");
});

test("остальные недопустимые символы Windows заменяются, а пустой заголовок даёт рабочее имя", () => {
  for (const title of ["Отчёт: 2024*05", 'Отчёт? 2024 "черновик"', "Отчёт <черновик>|2024", "Отчёт\\2024"]) {
    const file = reportFileName(title);
    assert.equal(
      FORBIDDEN_IN_WINDOWS_NAME.test(file),
      false,
      `в имени «${file}» остался символ, который Windows не принимает, и сохранение провалится с «не удалось записать файл»`,
    );
  }
  for (const empty of ["", "   ", "\t\n"]) {
    assert.equal(
      reportFileName(empty),
      "отчёт.docx",
      "заголовок пустой, а в диалоге сохранения имя файла окажется пустым, и Windows предложит своё",
    );
  }
  assert.equal(
    reportFileName("Годовой отчёт библиотеки"),
    "Годовой отчёт библиотеки.docx",
    "обычный заголовок изменился, и пользователь ищет файл не под тем именем",
  );
});

test("известные дыры в имени файла измерены и объявлены, а не спрятаны", (t) => {
  // Через кнопки длинный заголовок не доходит: `detectReportMessage` отбрасывает
  // сообщения с заголовком длиннее 200 символов, и кнопок под ними просто нет.
  const longBody = ["# Раздел", "- пункт отчёта, достаточно длинный, чтобы текст сошёл за отчёт"].join("\n").padEnd(120, " ть");
  assert.equal(
    reportActions.detectReportMessage(`Отчёт за 2024${" а".repeat(300)}\n${longBody}`),
    null,
    "под сообщением с заголовком в 300 символов появились кнопки, и имя файла может стать длиннее предела Windows",
  );
  const worstNameFromButtons = reportFileName("а".repeat(200));
  assert.ok(
    worstNameFromButtons.length <= MAX_NAME_LENGTH,
    `самый длинный заголовок, под которым ещё показываются кнопки, даёт имя в ${worstNameFromButtons.length} символов при пределе ${MAX_NAME_LENGTH}`,
  );

  const gaps = [];
  for (const [title, problem] of [
    ["Отчёт\u0007 со звонком", "управляющий символ остаётся в имени файла"],
    ["CON", "зарезервированное имя Windows: `CON.docx` невозможно создать"],
    [`Отчёт за 2024${" очень".repeat(60)}`, "имя длиннее предела Windows в 255 символов — достижимо через инструмент `save_report`, где заголовок не обрезан"],
  ]) {
    const file = reportFileName(title);
    if (/[\u0000-\u001f]/u.test(file)) gaps.push(`${problem}: ${JSON.stringify(file)}`);
    if (RESERVED_WINDOWS_NAME.test(file)) gaps.push(`${problem}: «${file}»`);
    if (file.length > MAX_NAME_LENGTH) gaps.push(`${problem}: ${file.length} символов`);
  }
  t.diagnostic(
    `Дыры в safeFileName (source/packages/report-tools/tools.ts, чужой файл): ${gaps.length === 0 ? "не найдено" : gaps.join("; ")}`,
  );
  assert.ok(gaps.length > 0, "пропуски safeFileName исчезли: если это так, отчёт FIX-frontend1.md устарел, и дыры надо закрыть утверждениями");
});

test("кнопки называются по-русски и объясняют, что сделали", () => {
  assert.equal(reportActions.REPORT_SAVE_LABEL, "Сохранить", "подпись кнопки сохранения не «Сохранить»");
  assert.equal(reportActions.REPORT_PRINT_LABEL, "Печать", "подпись кнопки печати не «Печать»");
  const strings = [
    reportActions.REPORT_SAVE_HINT,
    reportActions.REPORT_PRINT_HINT,
    reportActions.REPORT_ACTIONS_LABEL,
    reportActions.REPORT_BRIDGE_MISSING,
    reportActions.REPORT_SAVED_PREFIX,
    reportActions.REPORT_PRINTED,
    reportActions.REPORT_SAVE_FAILED,
    reportActions.REPORT_PRINT_FAILED,
  ];
  for (const text of strings) {
    assert.match(text, /[\u0400-\u04ff]/u, `текст для пользователя не на русском: «${text}»`);
  }
});

test("после нажатия пользователю говорят, что произошло, и куда делся отчёт", () => {
  const saved = reportActions.describeSaveOutcome({ saved: true, path: "C:\\Users\\les\\Downloads\\Отчёт за 2024-05.docx" });
  assert.equal(saved.tone, "ok", "успешное сохранение показано как ошибка");
  assert.match(saved.text, /Отчёт за 2024-05\.docx/u, `пользователю не сказали, куда сохранился отчёт: «${saved.text}»`);

  const printed = reportActions.describePrintOutcome({ printed: true });
  assert.equal(printed.tone, "ok", "успешная печать показана как ошибка");

  const failed = reportActions.describeSaveOutcome({ saved: false, reason: "failed", message: "не удалось записать файл C:\\Отчёт.docx. Закройте его в Word и попробуйте ещё раз." });
  assert.equal(failed.tone, "error", "отказ сохранения показан как успех");
  assert.match(failed.text, /Закройте его в Word/u, `в отказе нет подсказки, что делать дальше: «${failed.text}»`);

  const bridge = reportActions.describeActionFailure(new Error(""), reportActions.REPORT_BRIDGE_MISSING);
  assert.match(bridge.text, /Перезапустите программу/u, `при молчании моста пользователю не сказано, что делать: «${bridge.text}»`);

  assert.equal(
    reportActions.describeSaveOutcome({ saved: false, reason: "cancelled" }),
    null,
    "отменённое пользователем сохранение показывается как ошибка, и человек думает, что отчёт потерян",
  );
  assert.equal(
    reportActions.describeSaveOutcome({ saved: false, reason: "empty", message: "в сообщении нет текста отчёта. Попросите помощника показать отчёт ещё раз." }).text,
    "в сообщении нет текста отчёта. Попросите помощника показать отчёт ещё раз.",
    "причина отказа из главного процесса потеряна, и пользователь думает, что отчёт пустой",
  );
});