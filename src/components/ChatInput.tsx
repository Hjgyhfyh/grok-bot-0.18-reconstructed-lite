import { forwardRef, useEffect, useRef, type KeyboardEvent, type MutableRefObject } from "react";
import { SendHorizonal, Square } from "lucide-react";
import { t } from "../i18n";

export interface ChatInputProps {
  /** Черновик (хранится снаружи — useChat дедуплицирует по проекту). */
  value: string;
  onChange: (v: string) => void;
  /** Отправка. Пустой текст обрезается здесь — вызывать безопасно. */
  onSend: (text: string) => void;
  /** Остановка стрима — кнопка «Стоп» вместо «Отправить». */
  onStop: () => void;
  streaming: boolean;
  /** Проект не выбран — поле заблокировано совсем. */
  disabled?: boolean;
}

/**
 * Поле ввода чата. Enter — отправить, Shift+Enter — новая строка.
 * Во время стрима поле не блокируем (пусть дописывает следующую просьбу),
 * но отправку блокируем — вместо неё кнопка «Стоп».
 */
const ChatInput = forwardRef<HTMLTextAreaElement, ChatInputProps>(function ChatInput(
  { value, onChange, onSend, onStop, streaming, disabled },
  forwardedRef,
) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);

  const setRefs = (el: HTMLTextAreaElement | null) => {
    innerRef.current = el;
    if (typeof forwardedRef === "function") forwardedRef(el);
    else if (forwardedRef) {
      (forwardedRef as MutableRefObject<HTMLTextAreaElement | null>).current = el;
    }
  };

  // Автовысота: до ~8 строк, дальше скролл внутри поля.
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const submit = () => {
    const text = value.trim();
    if (!text || streaming || disabled) return;
    onSend(text);
    onChange("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.repeat) return;
    e.preventDefault();
    submit();
  };

  return (
    <div className="chat-input-row">
      <textarea
        ref={setRefs}
        className="chat-input"
        placeholder={t("chatPlaceholder")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        rows={1}
      />
      {streaming ? (
        <button
          type="button"
          className="btn btn-danger chat-btn"
          onClick={onStop}
          aria-label={t("chatStop")}
        >
          <Square size={16} fill="currentColor" />
          {t("chatStop")}
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-primary chat-btn"
          onClick={submit}
          disabled={disabled || !value.trim()}
        >
          <SendHorizonal size={18} />
          {t("chatSend")}
        </button>
      )}
    </div>
  );
});

export default ChatInput;
