import { defineHostExtension } from "../../../internal/host-extensions.js"; import { GrokBotService } from "../../../packages/proto/generated/aiserver/v1/grok_bot_connect.js"; import { createSandCursorBackendClient, getSandInferenceBackendUrl } from "../../../shared/node/cursor-backend/cursor-inference.js"; import type { NotificationAgent } from "../../../shared/os-notification.js"; import { HostExtensions } from "../extension-ids.generated.js"; import { SandMobilePushNotifier, createSandMobilePushSender } from "./mobile-push-notifier.js";
type NotificationHostEvent =
  | { readonly kind: "notification-baseline"; readonly agents: readonly NotificationAgent[] }
  | { readonly kind: "notification-agents"; readonly event: { readonly agents: readonly NotificationAgent[] }; readonly presence: { readonly windowFocusedAtMs?: number | null } }
  | { readonly kind: "notification-agent-upserted"; readonly event: { readonly agent: NotificationAgent }; readonly presence: { readonly windowFocusedAtMs?: number | null } }
  | { readonly kind: "notification-agent-forgotten"; readonly agentId: string };
interface NotificationHost { readonly events: { subscribe(listener: (event: NotificationHostEvent) => void): () => void }; }

/**
 * Что было. Расширение безусловно строил клиента службы Cursor, чтобы слать
 * push-уведомления на телефон. В этой сборке служба отключена, и клиент бросает
 * исключение прямо в `start`. Падение одного расширения валило старт всего
 * хоста: окно открывалось, но координатор не поднимался, и создание помощника
 * заканчивалось «Соединение с программой закрыто».
 *
 * Что стало. Пустой адрес означает «мобильных уведомлений нет», а не
 * «программа сломана». У пользователя один компьютер и нет телефона, связанного
 * с DB Bot, поэтому уведомления отправлять некому.
 */
export const notificationsExtension = defineHostExtension<{}, NotificationHost>({ id: HostExtensions.Notifications, dependencies: [HostExtensions.Auth], start: (context) => { if (getSandInferenceBackendUrl().length === 0) return {}; const auth = context.deps[HostExtensions.Auth] as { getAccessToken(options: { backendUrl: string }): Promise<string>; getMachineId(): Promise<string> }; const client = createSandCursorBackendClient(GrokBotService, { getAccessToken: auth.getAccessToken, getMachineId: auth.getMachineId }); const notifier = new SandMobilePushNotifier({ notify: createSandMobilePushSender(client as unknown as Parameters<typeof createSandMobilePushSender>[0]) }); const unsubscribe = context.host.events.subscribe((event) => { switch (event.kind) { case "notification-baseline": notifier.seedBaseline(event.agents); break; case "notification-agents": notifier.handleAgentsEvent(event.event, event.presence); break; case "notification-agent-upserted": notifier.handleAgentUpsertedEvent(event.event, event.presence); break; case "notification-agent-forgotten": notifier.forget(event.agentId); } }); context.onStop(unsubscribe); return {}; } });
