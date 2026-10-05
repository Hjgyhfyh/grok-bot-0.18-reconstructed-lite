// frontend/src/production/report-actions-model.ts
var DEFAULT_REPORT_FORMAT = "docx";
var REPORT_MIN_BODY_CHARS = 80;
var TITLE_MAX_CHARS = 200;
var STRUCTURE_LINE = /^(?:#{1,6}\s|\||[-*+>]\s|\d+(?:\.\d+)*[.)]\s)/;
var BODY_STRUCTURE = [
  /^#{1,6}\s+\S/m,
  // заголовок раздела
  /^\s*\|.*\|\s*$/m,
  // строка таблицы
  /^\s*[-*+]\s+\S/m,
  // список
  /^\s*\d+(?:\.\d+)*[.)]\s+\S/m,
  // пункт отчёта: «3.1.2 Название»
  /^[^\n]*\t[^\n]*$/m
  // таблица колонками через табуляцию
];
function hasReportStructure(body) {
  return BODY_STRUCTURE.some((pattern) => pattern.test(body));
}
function detectReportMessage(content) {
  const text = content.replace(/\r\n?/g, "\n").trim();
  if (text.length === 0) return null;
  const lines = text.split("\n");
  const title = (lines[0] ?? "").trim();
  if (title.length < 3 || title.length > TITLE_MAX_CHARS || STRUCTURE_LINE.test(title)) return null;
  const markdown = lines.slice(1).join("\n").trim();
  if (markdown.length < REPORT_MIN_BODY_CHARS) return null;
  if (lines.slice(1).filter((line) => line.trim().length > 0).length < 2) return null;
  if (!hasReportStructure(markdown)) return null;
  return { title, markdown };
}
var REPORT_SAVE_LABEL = "\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C";
var REPORT_PRINT_LABEL = "\u041F\u0435\u0447\u0430\u0442\u044C";
var REPORT_SAVE_HINT = "\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u043E\u0442\u0447\u0451\u0442 \u0432 \u0444\u0430\u0439\u043B";
var REPORT_PRINT_HINT = "\u0420\u0430\u0441\u043F\u0435\u0447\u0430\u0442\u0430\u0442\u044C \u043E\u0442\u0447\u0451\u0442 \u043D\u0430 \u043F\u0440\u0438\u043D\u0442\u0435\u0440\u0435";
var REPORT_ACTIONS_LABEL = "\u0427\u0442\u043E \u0441\u0434\u0435\u043B\u0430\u0442\u044C \u0441 \u043E\u0442\u0447\u0451\u0442\u043E\u043C";
var REPORT_BRIDGE_MISSING = "\u041E\u0442\u0447\u0451\u0442 \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u0435\u0442\u0441\u044F \u043F\u0440\u043E\u0433\u0440\u0430\u043C\u043C\u043E\u0439 \u043D\u0430 \u044D\u0442\u043E\u043C \u043A\u043E\u043C\u043F\u044C\u044E\u0442\u0435\u0440\u0435. \u041F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 \u043F\u0440\u043E\u0433\u0440\u0430\u043C\u043C\u0443 \u0438 \u043F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u0441\u043D\u043E\u0432\u0430.";
var REPORT_SAVED_PREFIX = "\u041E\u0442\u0447\u0451\u0442 \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D: ";
var REPORT_PRINTED = "\u041E\u0442\u0447\u0451\u0442 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D \u043D\u0430 \u043F\u0440\u0438\u043D\u0442\u0435\u0440.";
var REPORT_SAVE_FAILED = "\u041D\u0435 \u043F\u043E\u043B\u0443\u0447\u0438\u043B\u043E\u0441\u044C \u0441\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u043E\u0442\u0447\u0451\u0442. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u0435\u0449\u0451 \u0440\u0430\u0437.";
var REPORT_PRINT_FAILED = "\u041D\u0435 \u043F\u043E\u043B\u0443\u0447\u0438\u043B\u043E\u0441\u044C \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u043E\u0442\u0447\u0451\u0442 \u043D\u0430 \u043F\u0440\u0438\u043D\u0442\u0435\u0440. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u0435\u0449\u0451 \u0440\u0430\u0437.";
function readMessage(value) {
  if (typeof value !== "object" || value == null) return null;
  const message = value.message;
  return typeof message === "string" && message.length > 0 ? message : null;
}
function describeSaveOutcome(value) {
  if (typeof value !== "object" || value == null) return { tone: "error", text: REPORT_SAVE_FAILED };
  const result = value;
  if (result.saved === true && typeof result.path === "string" && result.path.length > 0) {
    return { tone: "ok", text: `${REPORT_SAVED_PREFIX}${result.path}` };
  }
  if (result.saved === false && value.reason === "cancelled") return null;
  return { tone: "error", text: readMessage(value) ?? REPORT_SAVE_FAILED };
}
function describePrintOutcome(value) {
  if (typeof value !== "object" || value == null) return { tone: "error", text: REPORT_PRINT_FAILED };
  const result = value;
  if (result.printed === true) return { tone: "ok", text: REPORT_PRINTED };
  return { tone: "error", text: readMessage(value) ?? REPORT_PRINT_FAILED };
}
function describeActionFailure(error, fallback) {
  const text = typeof error === "object" && error != null && typeof error.message === "string" ? error.message : "";
  return { tone: "error", text: text.length > 0 ? text : fallback };
}
export {
  DEFAULT_REPORT_FORMAT,
  REPORT_ACTIONS_LABEL,
  REPORT_BRIDGE_MISSING,
  REPORT_MIN_BODY_CHARS,
  REPORT_PRINTED,
  REPORT_PRINT_FAILED,
  REPORT_PRINT_HINT,
  REPORT_PRINT_LABEL,
  REPORT_SAVED_PREFIX,
  REPORT_SAVE_FAILED,
  REPORT_SAVE_HINT,
  REPORT_SAVE_LABEL,
  describeActionFailure,
  describePrintOutcome,
  describeSaveOutcome,
  detectReportMessage,
  hasReportStructure
};
