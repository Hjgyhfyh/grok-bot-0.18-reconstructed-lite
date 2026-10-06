import type { CursorAccountDesktopBridge, DesktopBridge } from "../../../contracts/desktop-bridge";

// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#L518
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#L523
// Immutable root sha256: ef4e9831b65d39633f09c9ad0c083b98b7ebf52e3bb558182aee5bde31f876fa

export const ACCESS_BLOCKED_FAILURE_CODE = "sand-access-blocked" as const;
/**
 * Адрес, который открывала кнопка на обложке доступа, удалён.
 *
 * Он вёл на `cursor.com/bot/onboarding`. В DB Bot Lite нет ни учётной записи
 * Cursor, ни платёжного тарифа, ни команды: кнопка «Перейти на Ultra» уводила
 * пользователя на чужую страницу оплаты. Константа оставлена пустой строкой,
 * потому что на неё ссылается тип `AccessCoverCopy`.
 */
export const ACCESS_ONBOARDING_URL = "" as const;

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
// Тексты про тарифы Ultra, Premium и пробный период убраны. DB Bot Lite —
// одна программа для одного человека, оплаты в ней нет; прежние надписи
// обещали пользователю покупку, которой не существует, и уводили на сайт.
export function accessNoticeCopy(access: SandAccess): AccessCoverCopy | null {
  if (access.state === "checking" || access.state === "unknown" || access.state === "granted") return null;
  if (access.reason === "teamPrivacyMode") {
    return {
      title: "Режим приватности команды запрещает DB Bot",
      body: "DB Bot не работает в режиме приватности (Legacy). Обратитесь к тому, кто устанавливал программу.",
      action: null
    };
  }
  if (access.reason === "teamSetupRequired") {
    return {
      title: "Программа ещё не настроена",
      body: "Установку программы должен закончить тот, кто ставил её на этот компьютер.",
      action: null
    };
  }
  if (access.reason === "teamAccessRequired") {
    return {
      title: "Программа закрыта на этом компьютере",
      body: "В настройках программы DB Bot закрыт. Открыть его может тот, кто устанавливал DB Bot.",
      action: null
    };
  }
  return {
    title: "DB Bot пока недоступен",
    body: "Помощники не отвечают. Перезапустите программу; если это не помогло, обратитесь к тому, кто её устанавливал.",
    action: null
  };
}

// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=5544115
export function accessCoverCopy(access: SandAccess): AccessCoverCopy {
  return accessNoticeCopy(access) ?? {
    title: "DB Bot пока недоступен",
    body: "Помощники не отвечают. Перезапустите программу; если это не помогло, обратитесь к тому, кто её устанавливал.",
    action: null
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

/**
 * Открыть страницу регистрации. В DB Bot Lite регистрации нет, поэтому функция
 * ничего не делает и ничего наружу не отправляет. Она осталась, потому что
 * экспортируется из модуля вместе с остальным контрактом обложки.
 */
export function openAccessOnboarding(bridge: Pick<DesktopBridge, "openExternal">): Promise<void> {
  void bridge;
  return Promise.resolve();
}
