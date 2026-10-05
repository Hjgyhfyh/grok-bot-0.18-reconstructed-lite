import { SettingsGroup } from "./computer-view-internals";
import { settingsComputerPhase, useSettingsComputerController, type SettingsComputerMount } from "./computer";
import { SandButton } from "../../../ui/sand-kit-primitives";

// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#L523

const UPDATE_COPY = "Обновляет компьютер, на котором работают ваши помощники. Ваши файлы и входы в программы останутся на месте.";
const UP_TO_DATE_COPY = "Ваш компьютер уже новой версии";
const BUSY_COPY = "Помощник сейчас работает. Обновление прервёт его работу.";
const QUEUED_COPY = "Обновление в очереди. Оно начнётся, как только все помощники закончат работу.";
const BLOCKED_COPY = "Обновление и пересборка компьютера отключены до конца сеанса. Перезапустите Grok Bot, когда компьютер снова будет доступен.";
const RESET_COPY = "Начните с чистого листа, если компьютер завис. Он соберётся заново из последнего сохранённого состояния, поэтому самые свежие изменения могут пропасть.";
const RESET_UNAVAILABLE_COPY = "Откройте помощника, чтобы пересобрать общий компьютер";

export function SettingsComputerPanel({ state, actions }: SettingsComputerMount) {
  const phase = settingsComputerPhase(state);
  const controller = useSettingsComputerController(state, actions);
  const updateExtraCopy = state.isRebuildBlocked
    ? BLOCKED_COPY
    : phase === "queued"
      ? QUEUED_COPY
      : phase === "busy-override"
        ? BUSY_COPY
        : null;
  const resetExtraCopy = state.isRebuildBlocked ? BLOCKED_COPY : !state.canResetBox ? RESET_UNAVAILABLE_COPY : null;

  return (
    <SettingsGroup title="Компьютер Grok Bot">
      {phase === "up-to-date" && !state.isRebuildBlocked ? (
        <div className="sand-settings-uptodate-banner" role="status">
          <strong>{UP_TO_DATE_COPY}</strong>
          <span>{UPDATE_COPY}</span>
        <SandButton className="sand-settings-reset" disabled={controller.updateDisabled} onClick={controller.requestUpdate} size="md" variant="secondary">{controller.updateLabel}</SandButton>
        </div>
      ) : (
        <SettingsComputerRow
          description={UPDATE_COPY}
          extraCopy={updateExtraCopy}
          label="Обновить компьютер Grok Bot"
          control={<SandButton className="sand-settings-reset" data-confirming={controller.updateConfirming || undefined} disabled={controller.updateDisabled} onClick={controller.requestUpdate} size="md" variant="secondary">{controller.updateLabel}</SandButton>}
        />
      )}
      {state.isDevBuild ? <SandButton className="sand-settings-force-refresh" disabled={state.isRebuildBlocked || state.isUpdateBoxPending || state.isResetBoxPending} onClick={controller.refreshAnyway} size="md" title="Проверить обновление, хотя компьютер уже новой версии" variant="secondary">Обновить всё равно</SandButton> : null}
      <SettingsComputerRow
        description={RESET_COPY}
        extraCopy={resetExtraCopy}
        label="Пересобрать компьютер Grok Bot"
        control={<SandButton className="sand-settings-reset" disabled={!state.canResetBox || state.isRebuildBlocked || state.isUpdateBoxPending || state.isResetBoxPending} onClick={controller.requestReset} sentiment="danger" size="md" variant="primary">{state.isResetBoxPending ? "Пересобираем…" : "Пересобрать"}</SandButton>}
      />
    </SettingsGroup>
  );
}

function SettingsComputerRow({ description, extraCopy, label, control }: { description: string; extraCopy: string | null; label: string; control: React.ReactNode }) {
  return (
    <div className="sand-settings-row">
      <div className="sand-settings-copy">
        <strong>{label}</strong>
        <span className="sand-settings-field__hint">{description}</span>
        {extraCopy ? <span className="sand-settings-field__hint">{extraCopy}</span> : null}
      </div>
      <div className="sand-settings-control">{control}</div>
    </div>
  );
}
