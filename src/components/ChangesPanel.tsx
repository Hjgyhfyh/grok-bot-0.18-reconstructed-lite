import { useEffect, useState } from "react";
import { FileText, X } from "lucide-react";
import { t } from "../i18n";
import type { FileChange } from "../services/tauri";

export interface ChangesPanelProps {
  changes: FileChange[];
  /** «Применить» — записать изменения в файлы. Не передан — кнопки нет. */
  onApply?: () => void;
  /** «Отменить изменения» — откат (экран показывает подтверждение сам). */
  onRevert?: () => void;
  /** Идёт запись/откат — кнопки заблокированы. */
  busy?: boolean;
}

/**
 * Панель «Изменённые файлы» под историей чата: список файлов ответа,
 * «Посмотреть» (модалка с содержимым), «Применить», «Отменить изменения».
 */
export default function ChangesPanel({ changes, onApply, onRevert, busy }: ChangesPanelProps) {
  const [preview, setPreview] = useState<FileChange | null>(null);
  if (changes.length === 0) return null;

  return (
    <div className="changes-panel">
      <div className="changes-title">{t("changesTitle", { n: changes.length })}</div>
      <ul className="changes-list">
        {changes.map((c) => (
          <li key={c.path} className="changes-row">
            <FileText size={16} className="changes-icon" />
            <span className="changes-name" title={c.path}>
              {c.path}
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => setPreview(c)}
            >
              {t("changeView")}
            </button>
          </li>
        ))}
      </ul>
      <div className="changes-actions">
        {onApply && (
          <button type="button" className="btn btn-primary" onClick={onApply} disabled={busy}>
            {t("changeApply")}
          </button>
        )}
        {onRevert && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onRevert}
            disabled={busy}
            title={t("changeRevertTip")}
          >
            {t("changeRevert")}
          </button>
        )}
      </div>
      {preview && <FilePreviewModal change={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

function FilePreviewModal({ change, onClose }: { change: FileChange; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="dialog dialog--file"
        role="dialog"
        aria-modal="true"
        aria-label={change.path}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <span className="dialog-title">{change.path}</span>
          <button
            type="button"
            className="dialog-close"
            onClick={onClose}
            aria-label={t("dismiss")}
            title={t("dismiss")}
          >
            <X size={18} />
          </button>
        </div>
        <pre className="file-preview">{change.diff}</pre>
      </div>
    </div>
  );
}
