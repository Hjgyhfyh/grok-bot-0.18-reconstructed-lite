// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#L511
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=2554016 (all-hidden roster state)
import { SandButton } from "../../ui/sand-kit-primitives";

export type RosterStatusKind = "loading" | "empty" | "all-hidden" | "error";

export interface RosterStatusProps {
  kind: RosterStatusKind;
  isRetrying?: boolean;
  onRetry?(): void;
  onShowHiddenBots?(): void;
}

const ROSTER_STATUS_COPY = { retry: "Повторить", retrying: "Повторяем…" };

export function RosterStatus({ kind, isRetrying = false, onRetry, onShowHiddenBots }: RosterStatusProps) {
  if (kind === "loading") {
    return (
      <div className="sand-agents-state sand-agents-state--connecting" role="status">
        <div className="sand-agents-state__header">
          <span aria-hidden="true" />
          <span className="sand-agents-state__label">Подключаемся к вашему компьютеру…</span>
        </div>
      </div>
    );
  }

  if (kind === "empty") return <div className="sand-agents-empty">Сохранённых помощников пока нет.</div>;

  if (kind === "all-hidden") {
    return <div className="sand-agents-empty">
      <span>Все помощники скрыты</span>
      <SandButton onClick={onShowHiddenBots} size="sm" variant="secondary">Показать скрытых</SandButton>
    </div>;
  }

  return (
    <div className="sand-agents-state sand-agents-state--unreachable" role="status">
      <div className="sand-agents-state__header">
        <span aria-hidden="true" />
        <span className="sand-agents-state__label">Не удаётся связаться с компьютером</span>
      </div>
      <span className="sand-agents-state__body">Помощники в безопасности — их просто не удаётся загрузить прямо сейчас.</span>
      <div className="sand-agents-state__actions">
        <SandButton disabled={isRetrying} onClick={onRetry} size="sm" variant="secondary">{ROSTER_STATUS_COPY.retry}</SandButton>
        {isRetrying ? <span className="sand-agents-state__retrying">{ROSTER_STATUS_COPY.retrying}</span> : null}
      </div>
    </div>
  );
}

export default RosterStatus;
