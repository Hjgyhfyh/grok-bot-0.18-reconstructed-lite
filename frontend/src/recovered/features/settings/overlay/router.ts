import type { AgentDesktopBridge } from "../../../contracts/desktop-bridge";

/** DeepSeek is the only provider. The picker has one entry and no alternative. */
export type RouterProviderId = "deepseek";

export interface RouterProvider {
  readonly id: RouterProviderId;
  readonly label: string;
  readonly description: string;
  readonly usageDescription: string;
  /** DeepSeek meters usage on its own side, so this is always "external". */
  readonly usageSource: "external";
}

export const DEFAULT_ROUTER_PROVIDER: RouterProviderId = "deepseek";
export const ROUTER_PROVIDER_PERSISTENCE_KEY = "settings.router-provider.v1";

/** The models `GET https://api.deepseek.com/models` currently returns. */
export const DEEPSEEK_MODEL_CHOICES: readonly { readonly id: string; readonly label: string; readonly description: string }[] = [
  { id: "deepseek-flash", label: "deepseek-flash", description: "Базовая модель. Понимает текст и картинки. Рекомендуется по умолчанию." },
  { id: "deepseek-v4-pro", label: "deepseek-v4-pro", description: "Модель с размышлением. Только текст. Для сложных задач." }
];

export const ROUTER_PROVIDERS: readonly RouterProvider[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    description: "Официальный API DeepSeek. Других провайдеров в приложении нет.",
    usageDescription: "Расход токенов считает DeepSeek, а не DB Bot Lite.",
    usageSource: "external"
  }
];

const ROUTER_PROVIDER_IDS = new Set<RouterProviderId>(ROUTER_PROVIDERS.map((provider) => provider.id));

export function isRouterProviderId(value: unknown): value is RouterProviderId {
  return typeof value === "string" && ROUTER_PROVIDER_IDS.has(value as RouterProviderId);
}

export function routerProviderById(id: RouterProviderId): RouterProvider {
  return ROUTER_PROVIDERS.find((provider) => provider.id === id) ?? ROUTER_PROVIDERS[0]!;
}

export function parseRouterProviderPreference(raw: string | null): RouterProviderId {
  if (raw == null) return DEFAULT_ROUTER_PROVIDER;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value == null || Array.isArray(value)) return DEFAULT_ROUTER_PROVIDER;
    const record = value as Record<string, unknown>;
    if (record.schemaVersion !== 1 || !isRouterProviderId(record.provider)) return DEFAULT_ROUTER_PROVIDER;
    return record.provider;
  } catch {
    return DEFAULT_ROUTER_PROVIDER;
  }
}

export type RouterProviderPersistence = Pick<AgentDesktopBridge["clientPersistence"], "read" | "write">;

export async function loadRouterProvider(persistence: RouterProviderPersistence): Promise<RouterProviderId> {
  return parseRouterProviderPreference(await persistence.read(ROUTER_PROVIDER_PERSISTENCE_KEY));
}

export async function saveRouterProvider(persistence: RouterProviderPersistence, provider: RouterProviderId): Promise<void> {
  if (!isRouterProviderId(provider)) throw new Error("Неизвестный провайдер.");
  await persistence.write(ROUTER_PROVIDER_PERSISTENCE_KEY, JSON.stringify({ schemaVersion: 1, provider }));
}