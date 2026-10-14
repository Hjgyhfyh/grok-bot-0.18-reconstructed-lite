import { SendHorizonal, MessageCircle } from "lucide-react";

export default function ChatScreen() {
  return (
    <section className="screen screen--chat">
      <header className="chat-header">
        <h1 className="screen-title">Чат</h1>
        <span className="chat-status">проект не выбран</span>
      </header>
      <div className="chat-history">
        <div className="empty-state">
          <MessageCircle size={48} strokeWidth={1.5} />
          <p className="empty-state-title">Сообщений пока нет</p>
          <p className="empty-state-hint">
            Откройте проект на вкладке «Мои проекты» и напишите, что нужно
            сделать, — например: «сделай красивее» или «добавь кнопку».
          </p>
        </div>
      </div>
      <div className="chat-input-row">
        <textarea
          className="chat-input"
          placeholder="Напишите, что сделать с проектом…"
          rows={2}
        />
        <button className="btn btn-primary btn-send" type="button" aria-label="Отправить">
          <SendHorizonal size={22} />
        </button>
      </div>
    </section>
  );
}
