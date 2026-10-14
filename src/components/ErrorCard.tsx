import { TriangleAlert } from "lucide-react";
import { t } from "../i18n";
import { errorCardKeys, type ErrorAction, type UiError } from "../stores/stateFns";

export type { UiError, ErrorKind, ErrorAction } from "../stores/stateFns";

export interface ErrorCardProps {
  error: UiError;
  /** Вызовется при клике на основную кнопку (retry / open-settings / pick-folder). */
  onAction?: (action: Exclude<ErrorAction, "none">) => void;
  /** «Понятно» — скрыть карточку. */
  onDismiss?: () => void;
}

/**
 * Карточка ошибки по copy-доку §7: что случилось → почему/что делать →
 * кнопка действия + «Понятно». Тексты — ключи словаря из errorCardKeys();
 * никаких stacktrace и крупных кодов (код — мелким серым внизу).
 */
export default function ErrorCard({ error, onAction, onDismiss }: ErrorCardProps) {
  const keys = errorCardKeys(error);
  const hasAction = error.action !== "none";

  return (
    <div className="error-card" role="alert">
      <div className="error-card-head">
        <TriangleAlert size={20} className="error-card-icon" />
        <p className="error-card-title">{t(keys.titleKey)}</p>
      </div>
      <p className="error-card-body">{t(keys.bodyKey)}</p>
      <div className="error-card-actions">
        {hasAction && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onAction?.(error.action as Exclude<ErrorAction, "none">)}
          >
            {t(keys.actionKey)}
          </button>
        )}
        <button type="button" className="btn btn-secondary" onClick={onDismiss}>
          {t("dismiss")}
        </button>
      </div>
      {error.code != null && error.code !== "" && (
        <div className="error-card-code">{error.code}</div>
      )}
    </div>
  );
}
