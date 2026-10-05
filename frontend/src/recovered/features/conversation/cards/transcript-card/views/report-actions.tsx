import { useCallback, useState } from "react";

import type { ReportsDesktopBridge } from "../../../../../contracts/desktop-bridge";
import {
  DEFAULT_REPORT_FORMAT,
  REPORT_ACTIONS_LABEL,
  REPORT_BRIDGE_MISSING,
  REPORT_PRINT_HINT,
  REPORT_PRINT_LABEL,
  REPORT_SAVE_HINT,
  REPORT_SAVE_LABEL,
  describeActionFailure,
  describePrintOutcome,
  describeSaveOutcome,
  type ReportActionStatus,
  type ReportMessage,
} from "../../../../../../production/report-actions-model";

import "./report-actions.css";

// Две кнопки под готовым отчётом: «Сохранить» и «Печать». Пользователь просил
// их отдельно, поэтому нажатие одной не делает работу другой: «Сохранить» открывает
// окно выбора файла, «Печать» — окно печати Windows.
//
// Мост — тот же `window.desktop`, что и у вложений. Если его нет, кнопки
// остаются видимыми, но нерабочими, и под ними пишется почему: молчаливые
// кнопки выглядят как готовая функция, которая ничего не делает.

export interface ReportActionsProps {
  readonly report: ReportMessage;
  readonly bridge: ReportsDesktopBridge | null;
}

export function ReportActions({ report, bridge }: ReportActionsProps) {
  const [busy, setBusy] = useState<"save" | "print" | null>(null);
  const [status, setStatus] = useState<ReportActionStatus | null>(null);

  const run = useCallback(async (which: "save" | "print") => {
    if (bridge == null || busy != null) return;
    setBusy(which);
    setStatus(null);
    try {
      const outcome = which === "save"
        ? await bridge.saveFile(report.title, report.markdown, DEFAULT_REPORT_FORMAT)
        : await bridge.print(report.title, report.markdown);
      const described = which === "save"
        ? describeSaveOutcome(outcome)
        : describePrintOutcome(outcome);
      setStatus(described);
    } catch (error) {
      setStatus(describeActionFailure(error, which === "save"
        ? "Не получилось сохранить отчёт. Попробуйте ещё раз."
        : "Не получилось отправить отчёт на принтер. Попробуйте ещё раз."));
    } finally {
      setBusy(null);
    }
  }, [bridge, busy, report.markdown, report.title]);

  return (
    <div aria-label={REPORT_ACTIONS_LABEL} className="sand-report-actions" role="group">
      <button
        aria-label={REPORT_SAVE_HINT}
        className="sand-report-actions__button"
        disabled={bridge == null || busy != null}
        onClick={() => void run("save")}
        title={REPORT_SAVE_HINT}
        type="button"
      >
        <span aria-hidden="true" data-icon-name="arrow-down-tray" />
        {REPORT_SAVE_LABEL}
      </button>
      <button
        aria-label={REPORT_PRINT_HINT}
        className="sand-report-actions__button"
        disabled={bridge == null || busy != null}
        onClick={() => void run("print")}
        title={REPORT_PRINT_HINT}
        type="button"
      >
        <span aria-hidden="true" data-icon-name="printer" />
        {REPORT_PRINT_LABEL}
      </button>
      <span aria-live="polite" className="sand-report-actions__hint">
        {bridge == null ? REPORT_BRIDGE_MISSING : ""}
      </span>
      {status == null ? null : (
        <span
          className={`sand-report-actions__status sand-report-actions__status--${status.tone}`}
          data-tone={status.tone}
          role="status"
        >
          {status.text}
        </span>
      )}
    </div>
  );
}

export default ReportActions;