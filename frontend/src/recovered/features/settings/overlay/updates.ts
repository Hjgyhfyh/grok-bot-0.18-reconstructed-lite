import type { DesktopUpdateTrack } from "../../../contracts/desktop-bridge";
// @evidence src/app/dist/renderer/assets/index-BlqerJhg.js#L1

export type UpdateTrack = DesktopUpdateTrack;
export type UpdateTone = "default" | "error" | "ready";

export const UPDATE_TRACK_LABELS: Readonly<Record<UpdateTrack, string>> = {
  stable: "Обычный",
  nightly: "Ежедневный",
  dogfood: "Опытный"
};

/** Preserved verbatim as configuration evidence from the public 0.18 renderer. */
export const INTERNAL_RELEASE_TRACK_CONFIG_URL =
  "https://console.statsig.com/5oWaLs1Xr8U2ei9Hq2R45w/dynamic_configs/sand_internal_release_track_override";

export type DisabledUpdateReason =
  | "not-packaged"
  | "lab-build"
  | "unsupported-platform"
  | "disabled-by-env";

export type LastUpdateCheck =
  | { result: "up-to-date" }
  | { result: "error"; errorMessage?: string | null };

export type UpdateState =
  | { type: "disabled"; reason: DisabledUpdateReason }
  | { type: "checking" }
  | { type: "available"; version: string }
  | { type: "downloading"; version: string; progress?: number | null }
  | { type: "staging"; version: string }
  | { type: "ready"; version: string; lastCheck?: LastUpdateCheck | null }
  | { type: "idle"; lastCheck?: LastUpdateCheck | null };

export interface UpdateStatus {
  state: UpdateState;
  currentTrack: UpdateTrack;
  currentVersion: string;
  isTrackManagedByPolicy?: boolean;
  autoUpdateWhenIdleOptIn?: boolean;
  autoUpdateWhenIdleGateEnabled?: boolean;
}

export interface UpdateStatusMessage {
  text: string;
  tone: UpdateTone;
}

export function updateTrackOption(track: UpdateTrack): { value: UpdateTrack; label: string } {
  return { value: track, label: UPDATE_TRACK_LABELS[track] };
}

export function disabledUpdateMessage(status: UpdateStatus): string {
  if (status.state.type !== "disabled") return "";
  switch (status.state.reason) {
    case "not-packaged":
      return "В сборках для разработки обновления отключены";
    case "lab-build":
      return "Grok Bot Lab — разовая тестовая сборка, она никогда не обновляется сама";
    case "unsupported-platform":
      return "На этой системе обновления недоступны";
    case "disabled-by-env":
      return "Обновления отключены переменной SAND_DISABLE_UPDATES";
  }
}

export function updateStatusMessage(status: UpdateStatus): UpdateStatusMessage {
  const state = status.state;
  switch (state.type) {
    case "disabled":
      return { text: disabledUpdateMessage(status), tone: "default" };
    case "checking":
      return { text: "Проверяем обновления…", tone: "default" };
    case "available":
      return { text: `Доступна версия Grok Bot ${state.version}`, tone: "default" };
    case "downloading": {
      const progress = state.progress != null ? ` (${Math.round(state.progress * 100)}%)` : "";
      return { text: `Скачиваем Grok Bot ${state.version}…${progress}`, tone: "default" };
    }
    case "staging":
      return { text: `Готовим Grok Bot ${state.version}…`, tone: "default" };
    case "ready":
      return state.lastCheck?.result === "error"
        ? { text: `Проверка обновлений не удалась: ${state.lastCheck.errorMessage ?? "неизвестная ошибка"}. Grok Bot ${state.version} готов. Перезапустите, чтобы обновиться.`, tone: "error" }
        : { text: `Grok Bot ${state.version} готов. Перезапустите, чтобы обновиться.`, tone: "ready" };
    case "idle":
      return state.lastCheck == null
        ? { text: "", tone: "default" }
        : state.lastCheck.result === "up-to-date"
          ? { text: "Обновлений нет", tone: "default" }
          : { text: `Проверка обновлений не удалась: ${state.lastCheck.errorMessage ?? "неизвестная ошибка"}`, tone: "error" };
  }
}

export type EgressTunnelStatus =
  | { state: "connected"; activeStreams: number; relayedStreams: number }
  | { state: "connecting" }
  | { state: "off" };

/** Русские окончания для числа: 1 соединение, 2 соединения, 5 соединений. */
function connectionWord(count: number): string {
  const mod100 = Math.abs(count) % 100, mod10 = mod100 % 10;
  return mod100 >= 11 && mod100 <= 14 ? "соединений"
    : mod10 === 1 ? "соединение"
    : mod10 >= 2 && mod10 <= 4 ? "соединения"
    : "соединений";
}

export function egressTunnelStatusDescription(status: EgressTunnelStatus): string {
  switch (status.state) {
    case "connected":
      return status.activeStreams > 0
        ? `Подключено — через этот компьютер идёт ${status.activeStreams} ${connectionWord(status.activeStreams)}, всего за сеанс ${status.relayedStreams}.`
        : `Подключено — компьютер готов пропускать интернет-трафик Grok Bot (за сеанс пропущено ${status.relayedStreams}).`;
    case "connecting":
      return "Подключаемся к компьютеру Grok Bot…";
    case "off":
      return "Включено, но трафик пока не идёт — ждём подключения компьютера Grok Bot.";
  }
}
