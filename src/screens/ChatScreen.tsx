import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { MessageCircle } from "lucide-react";
import { ru, t } from "../i18n";
import { useAppStore } from "../stores/appStore";
import { projectStatus, type ProjectStatus } from "../services/tauri";
// CONTRACT: src/hooks/useChat.ts от StoresHooks —
// { projectPath, messages, streaming, pendingChanges, applied, error: UiError|null,
//   send(text), stop(), retry(), applyPending(), revertPending(), clearError(),
//   newChat(), draft, setDraft }.
import { useChat } from "../hooks/useChat";
import MessageBubble from "../components/MessageBubble";
import ChatInput from "../components/ChatInput";
import ChangesPanel from "../components/ChangesPanel";
import ErrorCard, { type UiError } from "../components/ErrorCard";
import ConfirmDialog from "../components/ConfirmDialog";

const STATUS_KEYS: Record<ProjectStatus, { key: Parameters<typeof t>[0]; mod: string }> = {
  clean: { key: "statusClean", mod: "clean" },
  dirty: { key: "statusDirty", mod: "dirty" },
  stale: { key: "statusStale", mod: "stale" },
  crashed: { key: "statusFailed", mod: "failed" },
};

function projectName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export default function ChatScreen() {
  const { projectPath: routePath } = useParams<{ projectPath: string }>();
  const navigate = useNavigate();
  const projects = useAppStore((s) => s.projects);
  const activeProject = useAppStore((s) => s.activeProject);
  const setActiveProject = useAppStore((s) => s.setActiveProject);

  const effectivePath = routePath ?? activeProject;
  const chat = useChat(effectivePath);

  const [status, setStatus] = useState<ProjectStatus | null>(null);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [applying, setApplying] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const toastTimer = useRef<number>(0);

  // Глубокий линк /chat/<path> открывает проект и помечает его активным.
  useEffect(() => {
    if (routePath && routePath !== activeProject) setActiveProject(routePath);
  }, [routePath, activeProject, setActiveProject]);

  // Статус-плашка: из карточки проекта, иначе спросим у бэкенда.
  useEffect(() => {
    setStatus(null);
    if (!effectivePath) return;
    const card = projects.find((p) => p.path === effectivePath);
    if (card) {
      setStatus(card.status);
      return;
    }
    let alive = true;
    projectStatus(effectivePath)
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus(null));
    return () => {
      alive = false;
    };
  }, [effectivePath, projects]);

  // Автоскролл вниз при новых сообщениях/токенах — только если уже у низа.
  useEffect(() => {
    const el = historyRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [chat.messages, chat.streaming, chat.error]);

  // Тост «Изменения записаны» — и на ручное «Применить», и на авто-запись хука.
  const prevApplied = useRef(chat.applied);
  useEffect(() => {
    if (chat.applied && !prevApplied.current) showToastRef.current(t("appliedToast"));
    prevApplied.current = chat.applied;
  }, [chat.applied]);

  const showToastRef = useRef((text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  });
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const showToast = showToastRef.current;

  const handleErrorAction = (action: Exclude<UiError["action"], "none">) => {
    chat.clearError();
    if (action === "retry") {
      // retry() повторяет запрос без дублирования пузыря пользователя.
      void chat.retry();
    } else if (action === "open-settings") {
      navigate("/settings");
    } else if (action === "pick-folder") {
      // Выбор/смена папки живёт на экране «Мои проекты».
      navigate("/projects");
    }
  };

  const handleApply = async () => {
    setApplying(true);
    const ok = await chat.applyPending();
    setApplying(false);
    if (ok) showToast(t("appliedToast"));
  };

  const handleRevert = async () => {
    setConfirmRevert(false);
    setApplying(true);
    const ok = await chat.revertPending();
    setApplying(false);
    if (ok) showToast(t("revertedToast"));
  };

  const name = effectivePath ? projectName(effectivePath) : null;
  const hasMessages = chat.messages.length > 0;
  const lastMsg = chat.messages[chat.messages.length - 1];
  // Пустой стрим-пузырь помощника (хук создаёт его до первой дельты) не рисуем —
  // вместо него показываем «Помощник думает…».
  const thinking =
    chat.streaming &&
    (lastMsg === undefined ||
      (lastMsg.role === "assistant" && lastMsg.content.trim() === ""));

  return (
    <section className="screen screen--chat">
      <header className="chat-header">
        <button
          type="button"
          className="btn btn-secondary chat-back"
          onClick={() => navigate("/projects")}
        >
          {t("backToProjects")}
        </button>
        <h1 className="screen-title chat-title">{name ?? t("navChat")}</h1>
        {status && (
          <span className={`status-pill status-pill--${STATUS_KEYS[status].mod}`}>
            {t(STATUS_KEYS[status].key)}
          </span>
        )}
        {applying && <span className="chat-applying">{t("aiApplying")}</span>}
      </header>

      <div className="chat-history" ref={historyRef}>
        {!hasMessages && (
          <div className="empty-state">
            <MessageCircle size={48} strokeWidth={1.5} />
            <p className="empty-state-title">{t("chatEmptyTitle")}</p>
            <p className="empty-state-hint">
              {effectivePath ? t("chatEmptyBody") : t("readyBody")}
            </p>
            {effectivePath ? (
              <div className="chips">
                {ru.chatChips.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    className="chip"
                    onClick={() => {
                      chat.setDraft(chip);
                      inputRef.current?.focus();
                    }}
                  >
                    {chip}
                  </button>
                ))}
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => navigate("/projects")}
              >
                {t("backToProjects")}
              </button>
            )}
          </div>
        )}

        {chat.messages.map(
          (m) =>
            !(m.role === "assistant" && m.streaming && m.content.trim() === "") && (
              <MessageBubble key={m.id} role={m.role} content={m.content} streaming={m.streaming} />
            ),
        )}

        {thinking && (
          <div className="chat-thinking">
            {t("aiThinking")}
          </div>
        )}
      </div>

      {chat.pendingChanges.length > 0 && (
        <ChangesPanel
          changes={chat.pendingChanges}
          onApply={chat.applied ? undefined : handleApply}
          onRevert={() => setConfirmRevert(true)}
          busy={applying}
        />
      )}

      {chat.error && (
        <ErrorCard error={chat.error} onAction={handleErrorAction} onDismiss={chat.clearError} />
      )}

      <ChatInput
        ref={inputRef}
        value={chat.draft}
        onChange={chat.setDraft}
        onSend={(text) => void chat.send(text)}
        onStop={chat.stop}
        streaming={chat.streaming}
        disabled={!effectivePath}
      />

      {confirmRevert && (
        <ConfirmDialog
          title={t("revertConfirmTitle")}
          body={t("revertConfirmBody")}
          confirmLabel={t("revertConfirmYes")}
          cancelLabel={t("keepAsIs")}
          onConfirm={handleRevert}
          onCancel={() => setConfirmRevert(false)}
        />
      )}

      {toast && (
        <div className="toast-stack">
          <div className="toast" role="status">
            {toast}
          </div>
        </div>
      )}
    </section>
  );
}
