// frontend/src/recovered/features/conversation/cards/transcript-card/views/report-actions.tsx
import { useCallback, useState } from "react";

// frontend/src/production/report-actions-model.ts
var DEFAULT_REPORT_FORMAT = "docx";
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

// frontend/src/recovered/features/conversation/cards/transcript-card/views/report-actions.tsx
import { jsx, jsxs } from "react/jsx-runtime";
function ReportActions({ report, bridge }) {
  const [busy, setBusy] = useState(null);
  const [status, setStatus] = useState(null);
  const run = useCallback(async (which) => {
    if (bridge == null || busy != null) return;
    setBusy(which);
    setStatus(null);
    try {
      const outcome = which === "save" ? await bridge.saveFile(report.title, report.markdown, DEFAULT_REPORT_FORMAT) : await bridge.print(report.title, report.markdown);
      const described = which === "save" ? describeSaveOutcome(outcome) : describePrintOutcome(outcome);
      setStatus(described);
    } catch (error) {
      setStatus(describeActionFailure(error, which === "save" ? "\u041D\u0435 \u043F\u043E\u043B\u0443\u0447\u0438\u043B\u043E\u0441\u044C \u0441\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u043E\u0442\u0447\u0451\u0442. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u0435\u0449\u0451 \u0440\u0430\u0437." : "\u041D\u0435 \u043F\u043E\u043B\u0443\u0447\u0438\u043B\u043E\u0441\u044C \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u043E\u0442\u0447\u0451\u0442 \u043D\u0430 \u043F\u0440\u0438\u043D\u0442\u0435\u0440. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u0435\u0449\u0451 \u0440\u0430\u0437."));
    } finally {
      setBusy(null);
    }
  }, [bridge, busy, report.markdown, report.title]);
  return /* @__PURE__ */ jsxs("div", { "aria-label": REPORT_ACTIONS_LABEL, className: "sand-report-actions", role: "group", children: [
    /* @__PURE__ */ jsxs(
      "button",
      {
        "aria-label": REPORT_SAVE_HINT,
        className: "sand-report-actions__button",
        disabled: bridge == null || busy != null,
        onClick: () => void run("save"),
        title: REPORT_SAVE_HINT,
        type: "button",
        children: [
          /* @__PURE__ */ jsx("span", { "aria-hidden": "true", "data-icon-name": "arrow-down-tray" }),
          REPORT_SAVE_LABEL
        ]
      }
    ),
    /* @__PURE__ */ jsxs(
      "button",
      {
        "aria-label": REPORT_PRINT_HINT,
        className: "sand-report-actions__button",
        disabled: bridge == null || busy != null,
        onClick: () => void run("print"),
        title: REPORT_PRINT_HINT,
        type: "button",
        children: [
          /* @__PURE__ */ jsx("span", { "aria-hidden": "true", "data-icon-name": "printer" }),
          REPORT_PRINT_LABEL
        ]
      }
    ),
    /* @__PURE__ */ jsx("span", { "aria-live": "polite", className: "sand-report-actions__hint", children: bridge == null ? REPORT_BRIDGE_MISSING : "" }),
    status == null ? null : /* @__PURE__ */ jsx(
      "span",
      {
        className: `sand-report-actions__status sand-report-actions__status--${status.tone}`,
        "data-tone": status.tone,
        role: "status",
        children: status.text
      }
    )
  ] });
}
var report_actions_default = ReportActions;
export {
  ReportActions,
  report_actions_default as default
};
