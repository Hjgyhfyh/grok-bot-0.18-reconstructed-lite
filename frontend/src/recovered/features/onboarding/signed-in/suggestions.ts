import { CHARACTER_COLORS, CHARACTER_SHAPES } from "./model";

// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#L512

// Exact shipped catalog: immutable renderer JS bytes 4,479,912-4,486,061.
// Exact ranking starts at byte 4,486,867; card identity starts at byte 5,396,514.
const TOOL_TOKEN = "{tool}";

type Eligibility = { kind: "universal" } | { kind: "selected-tools"; recommendedIf: readonly string[] };
interface SuggestionTemplate { id: string; name: string; description: string; eligibility: Eligibility }
export type SuggestionDescriptionPart = { kind: "text"; text: string } | { kind: "tool"; label: string };
export interface OnboardingSuggestion { templateId: string; name: string; description: SuggestionDescriptionPart[] }
export interface SuggestionIdentity { color: string; shape: string }

export const ONBOARDING_SUGGESTION_CATALOG: readonly SuggestionTemplate[] = [
  { id: "night-shift", name: "Ночная смена", description: "Работает ночью и готовит утренний отчёт", eligibility: { kind: "universal" } },
  { id: "inbox-triage", name: "Разбор почты", description: "Разбирает почту и пишет ответы вашим голосом", eligibility: { kind: "universal" } },
  { id: "chief-of-staff", name: "Личный помощник", description: "Управляет другими помощниками и зовёт вас для решения", eligibility: { kind: "universal" } },
  { id: "negotiator", name: "Торговец", description: "Ищет справедливую цену и торгуется вашим голосом", eligibility: { kind: "universal" } },
  { id: "prototyper", name: "Прототипист", description: "Превращает ваши замыслы в работающие образцы", eligibility: { kind: "universal" } },
  { id: "researcher", name: "Исследователь", description: "Ищет ответ на любой вопрос в ваших программах и в интернете", eligibility: { kind: "universal" } },
  { id: "shopper", name: "Покупатель", description: "Собирает предложения и цены в понятное сравнение", eligibility: { kind: "universal" } },
  { id: "apartment-scout", name: "Жилищный помощник", description: "Отбирает объявления сразу и записывает на просмотр", eligibility: { kind: "universal" } },
  { id: "lookout", name: "Сторож", description: "Следит за любым сайтом и сообщает об изменениях", eligibility: { kind: "universal" } },
  { id: "competitor-watcher", name: "Следящий за конкурентами", description: "Следит за ценами и новинками конкурентов, раз в неделю даёт сводку", eligibility: { kind: "universal" } },
  { id: "crm-scribe", name: "Записи в CRM", description: `Переносит ваши звонки в ${TOOL_TOKEN} и готовит напоминания`, eligibility: { kind: "selected-tools", recommendedIf: ["Salesforce", "HubSpot", "Outreach", "Salesloft", "Apollo"] } },
  { id: "pipeline-scout", name: "Наблюдатель за сделками", description: `Изучает нужных клиентов в ${TOOL_TOKEN} и готовит план действий`, eligibility: { kind: "selected-tools", recommendedIf: ["Salesforce", "HubSpot", "Apollo", "Clay", "ZoomInfo", "LinkedIn", "Outreach", "Salesloft"] } },
  { id: "first-responder", name: "Быстрый ответ", description: `Отвечает новым обращениям за минуты и назначает встречу в ${TOOL_TOKEN}`, eligibility: { kind: "selected-tools", recommendedIf: ["Calendly", "HubSpot", "Salesforce", "Intercom", "Outreach", "Salesloft", "Apollo"] } },
  { id: "win-loss-analyst", name: "Разбор сделок", description: `Разбирает каждую проигранную сделку в ${TOOL_TOKEN} и объясняет настоящую причину`, eligibility: { kind: "selected-tools", recommendedIf: ["Salesforce", "HubSpot", "Outreach", "Salesloft", "Apollo"] } },
  { id: "icebreaker", name: "Знакомство", description: `Следит в ${TOOL_TOKEN} за новыми людьми для знакомства`, eligibility: { kind: "selected-tools", recommendedIf: ["LinkedIn", "Clay", "ZoomInfo", "Apollo", "Salesforce", "HubSpot"] } },
  { id: "call-coach", name: "Разбор звонков", description: `Прослушивает ваши звонки в ${TOOL_TOKEN} и даёт советы`, eligibility: { kind: "selected-tools", recommendedIf: ["Zoom", "Nooks", "Loom", "Outreach", "Salesloft"] } },
  { id: "deck-designer", name: "Дизайн презентаций", description: `Превращает заметки в презентацию в ${TOOL_TOKEN}`, eligibility: { kind: "selected-tools", recommendedIf: ["Canva", "Figma", "Workspace", "Microsoft 365"] } },
  { id: "channel-digest", name: "Сводка по каналам", description: `Собирает сводку по каналам в ${TOOL_TOKEN} и отмечает, что нужно вам`, eligibility: { kind: "selected-tools", recommendedIf: ["Slack", "Microsoft 365"] } },
  { id: "ticket-triager", name: "Разбор обращений", description: `Разбирает новые обращения в ${TOOL_TOKEN} и пишет первый ответ`, eligibility: { kind: "selected-tools", recommendedIf: ["Zendesk", "Intercom", "Jira", "Trello", "monday.com", "ClickUp"] } },
  { id: "feedback-miner", name: "Разбор отзывов", description: `Собирает отзывы из ${TOOL_TOKEN} в понятные темы`, eligibility: { kind: "selected-tools", recommendedIf: ["Zendesk", "Intercom", "Shopify", "Notion"] } },
  { id: "review-responder", name: "Ответы на отзывы", description: `Пишет ответы на отзывы и сообщения в ${TOOL_TOKEN}`, eligibility: { kind: "selected-tools", recommendedIf: ["Shopify", "Zendesk", "Intercom"] } },
  { id: "marketing-analyst", name: "Аналитик рекламы", description: `Показывает, как сработали кампании в ${TOOL_TOKEN} и куда вложить дальше`, eligibility: { kind: "selected-tools", recommendedIf: ["HubSpot", "Mailchimp", "Amplitude", "Mixpanel", "Shopify"] } },
  { id: "shopkeeper", name: "Смотритель магазина", description: `Следит за заказами и выплатами в ${TOOL_TOKEN} и сообщает о странном`, eligibility: { kind: "selected-tools", recommendedIf: ["Shopify", "Stripe"] } },
  { id: "invoice-chaser", name: "Напоминание об оплате", description: `Следит за неоплаченными счетами в ${TOOL_TOKEN} и пишет напоминания`, eligibility: { kind: "selected-tools", recommendedIf: ["QuickBooks", "NetSuite", "Stripe", "Ramp"] } },
  { id: "expense-auditor", name: "Проверка расходов", description: `Разбирает чеки в ${TOOL_TOKEN} и сортирует каждый расход`, eligibility: { kind: "selected-tools", recommendedIf: ["QuickBooks", "NetSuite", "Ramp", "Rippling", "Workday"] } },
  { id: "subscription-sleuth", name: "Проверка подписок", description: `Находит подписки, которыми вы не пользуетесь, по расходам в ${TOOL_TOKEN}`, eligibility: { kind: "selected-tools", recommendedIf: ["QuickBooks", "NetSuite", "Ramp", "Stripe"] } },
  { id: "paralegal", name: "Помощник по договорам", description: `Проверяет договоры в ${TOOL_TOKEN} и готовит правки на согласование`, eligibility: { kind: "selected-tools", recommendedIf: ["DocuSign", "Box", "Dropbox"] } },
  { id: "application-screener", name: "Отбор заявок", description: `Отбирает новые заявки в ${TOOL_TOKEN} и выделяет лучших кандидатов`, eligibility: { kind: "selected-tools", recommendedIf: ["Ashby", "Greenhouse", "Workday", "Rippling", "LinkedIn"] } },
  { id: "sourcing-scout", name: "Поиск сотрудников", description: `Подбирает подходящих людей на вакансии из ${TOOL_TOKEN}`, eligibility: { kind: "selected-tools", recommendedIf: ["Ashby", "Greenhouse", "Workday", "Rippling", "LinkedIn"] } },
  { id: "qa-engineer", name: "Проверка запусков", description: `Проверяет каждую новую выкладку в ${TOOL_TOKEN} и пишет, что сломалось`, eligibility: { kind: "selected-tools", recommendedIf: ["Vercel", "GitHub"] } },
  { id: "dashboard-watcher", name: "Слежение за показателями", description: `Следит за цифрами в ${TOOL_TOKEN} и сообщает об отклонениях`, eligibility: { kind: "selected-tools", recommendedIf: ["Tableau", "Hex", "Amplitude", "Mixpanel", "Snowflake", "Databricks", "Stripe", "Shopify"] } },
  { id: "data-scientist", name: "Работа с данными", description: `Отвечает на вопросы о данных запросами и графиками в ${TOOL_TOKEN}`, eligibility: { kind: "selected-tools", recommendedIf: ["Tableau", "Hex", "Amplitude", "Mixpanel", "Snowflake", "Databricks"] } },
] as const;

function universal(template: SuggestionTemplate): OnboardingSuggestion {
  return { templateId: template.id, name: template.name, description: [{ kind: "text", text: template.description }] };
}
function withTool(template: SuggestionTemplate, tool: string): OnboardingSuggestion {
  const index = template.description.indexOf(TOOL_TOKEN);
  if (index < 0) return universal(template);
  const before = template.description.slice(0, index), after = template.description.slice(index + TOOL_TOKEN.length);
  return { templateId: template.id, name: template.name, description: [
    ...(before ? [{ kind: "text" as const, text: before }] : []), { kind: "tool", label: tool },
    ...(after ? [{ kind: "text" as const, text: after }] : []),
  ] };
}
function bestForTool(tool: string, used: Set<string>): SuggestionTemplate | null {
  let best: SuggestionTemplate | null = null, rank = Number.POSITIVE_INFINITY;
  for (const template of ONBOARDING_SUGGESTION_CATALOG) {
    if (used.has(template.id) || template.eligibility.kind !== "selected-tools") continue;
    const index = template.eligibility.recommendedIf.indexOf(tool);
    if (index >= 0 && index < rank) { best = template; rank = index; }
  }
  return best;
}
export function selectOnboardingSuggestions(tools: readonly string[], limit = 10): OnboardingSuggestion[] {
  const suggestions: OnboardingSuggestion[] = [], used = new Set<string>();
  for (const tool of tools) {
    if (suggestions.length >= limit) break;
    const template = bestForTool(tool, used);
    if (template) { used.add(template.id); suggestions.push(withTool(template, tool)); }
  }
  for (const template of ONBOARDING_SUGGESTION_CATALOG) {
    if (suggestions.length >= limit) break;
    if (used.has(template.id) || template.eligibility.kind !== "selected-tools") continue;
    const tool = template.eligibility.recommendedIf.find((candidate) => tools.includes(candidate));
    if (tool) { used.add(template.id); suggestions.push(withTool(template, tool)); }
  }
  for (const template of ONBOARDING_SUGGESTION_CATALOG) {
    if (suggestions.length >= limit) break;
    if (!used.has(template.id) && template.eligibility.kind === "universal") {
      used.add(template.id); suggestions.push(universal(template));
    }
  }
  return suggestions;
}
export function flattenSuggestionDescription(parts: readonly SuggestionDescriptionPart[]): string {
  return parts.map((part) => part.kind === "text" ? part.text : part.label).join("");
}
function fnv1a(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}
function random(seed: number): () => number {
  let value = seed >>> 0;
  return () => { value = value + 1831565813 | 0; let next = Math.imul(value ^ value >>> 15, 1 | value); next = next + Math.imul(next ^ next >>> 7, 61 | next) ^ next; return ((next ^ next >>> 14) >>> 0) / 4294967296; };
}
function colorFor(name: string): string {
  const seeded = (fnv1a(name) ^ Math.imul(1, 2654435769)) >>> 0;
  return CHARACTER_COLORS[Math.floor(random((seeded ^ Math.imul(1, 2654435769)) >>> 0)() * CHARACTER_COLORS.length)]?.id ?? "brown";
}
function shapeFor(name: string): string {
  let hash = fnv1a(name); hash = Math.imul(hash ^ hash >>> 16, 73244475); hash = Math.imul(hash ^ hash >>> 13, 3266489909); hash = (hash ^ hash >>> 16) >>> 0;
  return CHARACTER_SHAPES[hash % CHARACTER_SHAPES.length] ?? "blob";
}
function unused(candidate: string, values: readonly string[], used: Set<string>): string {
  if (!used.has(candidate)) return candidate;
  const start = values.indexOf(candidate);
  for (let offset = 1; offset < values.length; offset += 1) { const value = values[(Math.max(start, 0) + offset) % values.length]; if (value && !used.has(value)) return value; }
  return candidate;
}
export function suggestionIdentities(suggestions: readonly OnboardingSuggestion[]): SuggestionIdentity[] {
  const colors = CHARACTER_COLORS.map(({ id }) => id), shapes = [...CHARACTER_SHAPES];
  const usedColors = new Set<string>(), usedShapes = new Set<string>();
  return suggestions.map(({ name }) => {
    const color = unused(colorFor(name), colors, usedColors), shape = unused(shapeFor(name), shapes, usedShapes);
    usedColors.add(color); usedShapes.add(shape); return { color, shape };
  });
}
