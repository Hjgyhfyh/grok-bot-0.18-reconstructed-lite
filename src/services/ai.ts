import { AI_CHAT_URL, AI_API_KEY, AI_MODEL } from "../config";

/**
 * OpenAI-compatible клиент OmniRoute.
 * Волна B реализует sendChat (стриминг или простой ответ) поверх этого файла.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
}

/** Проверка связи с сервером: GET {base}/models. */
export async function checkConnection(): Promise<boolean> {
  const base = AI_CHAT_URL.replace(/\/chat\/completions$/, "");
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${AI_API_KEY}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Простой запрос без стриминга (заготовка под sendChat). */
export async function sendChat(messages: ChatMessage[]): Promise<string> {
  const res = await fetch(AI_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AI_API_KEY}`,
    },
    body: JSON.stringify({ model: AI_MODEL, messages } satisfies ChatRequest),
  });
  if (!res.ok) {
    throw new Error(`Сервер ответил с ошибкой ${res.status}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}
