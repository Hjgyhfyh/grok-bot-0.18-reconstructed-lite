import type { CursorAccountDesktopBridge, DesktopBridge } from "../../../contracts/desktop-bridge";

// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#L518
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#L523
// Immutable root sha256: ef4e9831b65d39633f09c9ad0c083b98b7ebf52e3bb558182aee5bde31f876fa

export const ACCESS_BLOCKED_FAILURE_CODE = "sand-access-blocked" as const;
export const ACCESS_ONBOARDING_URL = "https://cursor.com/bot/onboarding" as const;

export type SandAccessState = "granted" | "unavailable" | "paymentRequired" | "unknown";
export type SandAccessBlockReason =
  | "none"
  | "teamPrivacyMode"
  | "teamSetupRequired"
  | "teamAccessRequired"
  | "notOffered"
  | "freeTrialAvailable"
  | "paywallIndividual"
  | "paywallTeamMember"
  | "paywallTeamAdmin"
  | "unspecified";

export interface SandAccess {
  readonly state: SandAccessState | "checking";
  readonly reason: SandAccessBlockReason;
}

export const SAND_ACCESS_CHECKING: SandAccess = { state: "checking", reason: "unspecified" };
export const SAND_ACCESS_UNKNOWN: SandAccess = { state: "unknown", reason: "unspecified" };

const ACCESS_REASONS: ReadonlySet<string> = new Set([
  "none",
  "teamPrivacyMode",
  "teamSetupRequired",
  "teamAccessRequired",
  "notOffered",
  "freeTrialAvailable",
  "paywallIndividual",
  "paywallTeamMember",
  "paywallTeamAdmin",
  "unspecified"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSandAccess(value: unknown): value is SandAccess {
  if (!isRecord(value) || typeof value.state !== "string" || typeof value.reason !== "string") return false;
  return ["checking", "granted", "unavailable", "paymentRequired", "unknown"].includes(value.state)
    && ACCESS_REASONS.has(value.reason);
}

export function projectSandAccess(value: unknown): SandAccess {
  return isSandAccess(value) ? value : SAND_ACCESS_UNKNOWN;
}

export interface AccessCoverCopy {
  readonly title: string;
  readonly body: string;
  readonly action: string | null;
}

// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=4734556
export function accessNoticeCopy(access: SandAccess): AccessCoverCopy | null {
  if (access.state === "checking" || access.state === "unknown" || access.state === "granted") return null;
  if (access.reason === "teamPrivacyMode") {
    return {
      title: "Режим приватности команды запрещает DB Bot",
      body: "DB Bot не работает в режиме приватности (Legacy). Попросите администратора команды отключить его.",
      action: "Подробнее"
    };
  }
  if (access.reason === "teamSetupRequired") {
    return {
      title: "Команда ещё не настроила DB Bot",
      body: "Администратор команды должен закончить настройку DB Bot, потом участники смогут писать сообщения.",
      action: "Подробнее"
    };
  }
  if (access.reason === "teamAccessRequired") {
    return {
      title: "Команда не открыла DB Bot для этой учётной записи",
      body: "В настройках команды DB Bot закрыт. Открыть его может администратор команды.",
      action: "Запросить доступ"
    };
  }
  if (access.reason === "notOffered") {
    return { title: "DB Bot недоступен для этой учётной записи", body: "Здесь нечего настраивать и покупать.", action: null };
  }
  if (access.reason === "freeTrialAvailable") {
    return { title: "Чтобы писать сообщения, включите пробный период DB Bot", body: "Эта учётная запись может попробовать DB Bot.", action: "Начать пробный период" };
  }
  if (access.reason === "paywallIndividual") {
    return { title: "Для DB Bot нужен тариф Ultra", body: "Перейдите на тариф Ultra, чтобы писать сообщения в DB Bot.", action: "Перейти на Ultra" };
  }
  if (access.reason === "paywallTeamMember") {
    return { title: "Для DB Bot нужно место Premium", body: "Попросите администратора команды перевести эту учётную запись на место Premium.", action: "Запросить доступ" };
  }
  if (access.reason === "paywallTeamAdmin") {
    return { title: "Для DB Bot нужно место Premium", body: "Переведите эту учётную запись на место Premium, чтобы писать сообщения.", action: "Управлять местами" };
  }
  if (access.state === "unavailable") {
    return { title: "DB Bot недоступен для этой учётной записи", body: "Отправка выключена, пока у этой учётной записи нет доступа. Проверьте условия на сайте.", action: "Проверить доступ" };
  }
  if (access.state === "paymentRequired") {
    return { title: "DB Bot не входит в этот тариф", body: "Отправка выключена, пока у учётной записи нет DB Bot. Посмотрите варианты на сайте.", action: "Проверить доступ" };
  }
  return null;
}

// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=5544115
export function accessCoverCopy(access: SandAccess): AccessCoverCopy {
  return accessNoticeCopy(access) ?? {
    title: "DB Bot пока недоступен для этой учётной записи",
    body: "Проверьте на сайте, что нужно этой учётной записи.",
    action: "Проверить доступ"
  };
}

export interface AccessCoverGateInput {
  readonly rosterFailureCode: string | null | undefined;
  readonly hasReachedBox: boolean;
  readonly isShowingRestoredRoster: boolean;
  readonly isComputerRebuildLocked: boolean;
}

// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=5543963
export function shouldShowAccessCover(input: AccessCoverGateInput): boolean {
  return input.rosterFailureCode === ACCESS_BLOCKED_FAILURE_CODE
    && !input.hasReachedBox
    && !input.isShowingRestoredRoster
    && !input.isComputerRebuildLocked;
}

export async function readFreshSandAccess(
  bridge: Pick<CursorAccountDesktopBridge, "getSandAccessFresh">
): Promise<SandAccess> {
  return projectSandAccess(await bridge.getSandAccessFresh());
}

export function openAccessOnboarding(bridge: Pick<DesktopBridge, "openExternal">): Promise<void> {
  return bridge.openExternal(ACCESS_ONBOARDING_URL);
}
