import { useCallback } from "react";
import { sendChat } from "../services/ai";
import { applyChanges, fsDirPort, readFile, rollbackChanges } from "../services/tauri";
import type { FileChange } from "../services/tauri";
import { buildContextMessage, parseModelFileEdits, selectKeyFiles, stripFileEditBlocks, toFileChanges } from "../core/context";
import { buildProjectTree, collectFilePaths, readProjectFiles, baseName } from "../core/scanner";
import { classifyPath } from "../core/git";
import type { ChatMessage } from "../core/ai";
import { isAbortError } from "../core/ai";
import type { FsReadPort } from "../core/types";
import { EMPTY_SESSION, selectChat, useAppStore } from "../stores/appStore";
import type { ChatSession, UiError } from "../stores/appStore";
import { errorFromException, lastUserText, trimHistory, uiError } from "../stores/stateFns";

/**
 * useChat — оркестрация чата по проекту.
 * send(text) → buildContext(core: дерево 2 ур + ключевые файлы ≤30k) →
 * services/ai.sendChat (стрим) → дельты в appStore → parseModelFileEdits(core)
 * → pendingChanges → auto-apply через apply_changes → applied.
 * Вся логика разбора — в core/services; хук только связывает их со стором.
 */

export type { ChatSession, UiError };
export { EMPTY_SESSION };

/** Порт чтения файлов для core-функций (контекст). */
const fsReadPort: FsReadPort = {
  ...fsDirPort,
  readFile: (path: string) => readFile(path),
};

const aborts = new Map<string, AbortController>();
let msgSeq = 0;

function nextId(prefix: string): string {
  msgSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${msgSeq.toString(36)}`;
}

/** Сбор контекста проекта → [system, user] сообщений для модели. */
async function buildContextMessages(
  projectPath: string,
  userText: string,
): Promise<ChatMessage[]> {
  // Один обход на глубину 3: и дерево для промпта (обрежем до 2 уровней),
  // и плоский список для выбора ключевых файлов (src/main.* и т.п.).
  const deep = await buildProjectTree(projectPath, fsDirPort, { depth: 3 }).catch(() => []);
  const tree = deep.map((n) => ({
    ...n,
    children: n.children?.map((c) => ({ ...c, children: undefined })),
  }));
  const candidates = selectKeyFiles(collectFilePaths(deep), 8);
  const files = await readProjectFiles(projectPath, fsReadPort, candidates, {
    maxTotalChars: 24_000,
  });
  return buildContextMessage(baseName(projectPath), tree, files, userText);
}

/** Один раунд: userText → стрим ответа в новое assistant-сообщение. */
async function runRound(
  projectPath: string,
  history: ChatMessage[],
  userText: string,
): Promise<void> {
  const st = () => useAppStore.getState();
  const assistantId = nextId("a");
  st().appendChatMessage(projectPath, {
    id: assistantId,
    role: "assistant",
    content: "",
    streaming: true,
    at: Date.now(),
  });
  st().setChatStreaming(projectPath, true);
  st().setChatError(projectPath, null);

  const ctl = new AbortController();
  aborts.set(projectPath, ctl);
  let full = "";
  try {
    const contextMsgs = await buildContextMessages(projectPath, userText).catch(() => null);
    const messages: ChatMessage[] = contextMsgs
      ? [contextMsgs[0], ...history, contextMsgs[1]]
      : [
          {
            role: "system",
            content: `Ты — помощник для проекта «${baseName(projectPath)}». Отвечай по-русски, коротко.`,
          },
          ...history,
          { role: "user", content: userText },
        ];

    for await (const delta of sendChat(messages, { signal: ctl.signal })) {
      if (ctl.signal.aborted) break;
      full += delta;
      st().updateChatMessage(projectPath, assistantId, { content: full });
    }

    st().updateChatMessage(projectPath, assistantId, { streaming: false });
    st().addUsage({ requests: 1 });

    if (!full.trim()) {
      st().setChatError(projectPath, uiError("empty"));
      return;
    }

    // Правки файлов из ответа (core/context) — только безопасные пути.
    const edits = parseModelFileEdits(full).filter((e) => classifyPath(e.path) === "inside");
    const shown = stripFileEditBlocks(full);
    if (shown.trim() && shown !== full) {
      st().updateChatMessage(projectPath, assistantId, { content: shown });
    }

    if (edits.length === 0) return;

    const changes: FileChange[] = toFileChanges(edits);
    st().setChatPending(projectPath, changes, false);

    try {
      const res = await applyChanges(projectPath, changes);
      if (res.applied.length > 0) {
        st().setChatPending(
          projectPath,
          changes.filter((c) => res.applied.includes(c.path)),
          true,
        );
      } else {
        st().setChatPending(projectPath, [], false);
      }
    } catch (e) {
      // Запись не удалась — правки остаются pending, кнопка «Применить» повторит.
      st().setChatError(projectPath, errorFromException(e));
    }
  } catch (e) {
    st().updateChatMessage(projectPath, assistantId, { streaming: false });
    if (isAbortError(e) || ctl.signal.aborted) {
      // «Стоп» — без карточки; набранный текст остаётся в пузыре.
      return;
    }
    if (!full.trim()) {
      // Пустой неудачный пузырь убираем, чтобы не плодить мусор.
      const sess = selectChat(st(), projectPath);
      const filtered = sess.messages.filter((m) => m.id !== assistantId);
      st().resetChat(projectPath);
      for (const m of filtered) st().appendChatMessage(projectPath, m);
    }
    st().setChatError(projectPath, errorFromException(e));
  } finally {
    aborts.delete(projectPath);
    st().setChatStreaming(projectPath, false);
  }
}

export function useChat(projectPath?: string | null) {
  const path = projectPath ?? useAppStore((s) => s.activeProject);
  const session = useAppStore((s) => selectChat(s, path ?? null));

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      const st = useAppStore.getState();
      if (!path || !trimmed || selectChat(st, path).streaming) return;
      const prior = trimHistory(selectChat(st, path).messages);
      st.appendChatMessage(path, {
        id: nextId("u"),
        role: "user",
        content: trimmed,
        at: Date.now(),
      });
      st.setChatDraft(path, "");
      await runRound(path, prior, trimmed);
    },
    [path],
  );

  /** Повтор последнего user-сообщения без нового пузыря (кнопка «Попробовать снова»). */
  const retry = useCallback(async () => {
    const st = useAppStore.getState();
    if (!path) return;
    const sess = selectChat(st, path);
    if (sess.streaming) return;
    const text = lastUserText(sess.messages);
    if (!text) return;
    let lastIdx = -1;
    for (let i = sess.messages.length - 1; i >= 0; i--) {
      const m = sess.messages[i];
      if (m.role === "user" && !m.streaming && m.content.trim()) {
        lastIdx = i;
        break;
      }
    }
    const prior = trimHistory(lastIdx < 0 ? [] : sess.messages.slice(0, lastIdx));
    st.setChatError(path, null);
    await runRound(path, prior, text);
  }, [path]);

  const stop = useCallback(() => {
    if (!path) return;
    aborts.get(path)?.abort();
  }, [path]);

  /** Применить pending-правки (повтор после сбоя записи). */
  const applyPending = useCallback(async (): Promise<boolean> => {
    const st = useAppStore.getState();
    if (!path) return false;
    const sess = selectChat(st, path);
    if (sess.applied || sess.pendingChanges.length === 0) return sess.applied;
    try {
      const res = await applyChanges(path, sess.pendingChanges);
      const ok = res.applied.length > 0;
      if (ok) {
        st.setChatPending(
          path,
          sess.pendingChanges.filter((c) => res.applied.includes(c.path)),
          true,
        );
      }
      return ok;
    } catch (e) {
      st.setChatError(path, errorFromException(e));
      return false;
    }
  }, [path]);

  /** «Отменить изменения»: git → checkout ., иначе → restore из бэкапа. */
  const revertPending = useCallback(async (): Promise<boolean> => {
    const st = useAppStore.getState();
    if (!path) return false;
    try {
      const done = await rollbackChanges(path);
      if (done) {
        st.setChatPending(path, [], false);
        return true;
      }
      // Нечего откатывать: не git и бэкапа нет — честная карточка.
      st.setChatError(path, uiError("revert"));
      return false;
    } catch {
      st.setChatError(path, uiError("revert"));
      return false;
    }
  }, [path]);

  const clearError = useCallback(() => {
    if (path) useAppStore.getState().setChatError(path, null);
  }, [path]);

  /** «Начать новый разговор»: чистит историю, pending и ошибку (файлы не трогает). */
  const newChat = useCallback(() => {
    if (!path) return;
    aborts.get(path)?.abort();
    useAppStore.getState().resetChat(path);
  }, [path]);

  const setDraft = useCallback(
    (draft: string) => {
      if (path) useAppStore.getState().setChatDraft(path, draft);
    },
    [path],
  );

  return {
    projectPath: path ?? null,
    messages: session.messages,
    streaming: session.streaming,
    pendingChanges: session.pendingChanges,
    applied: session.applied,
    error: session.error,
    draft: session.draft,
    send,
    retry,
    stop,
    applyPending,
    revertPending,
    clearError,
    newChat,
    setDraft,
  };
}
