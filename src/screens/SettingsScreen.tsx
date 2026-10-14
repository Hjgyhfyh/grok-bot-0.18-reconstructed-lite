import { AI_BASE_URL, AI_API_KEY, AI_MODEL } from "../config";

export default function SettingsScreen() {
  return (
    <section className="screen">
      <h1 className="screen-title">Настройки</h1>
      <div className="settings-form">
        <label className="field">
          <span className="field-label">Ключ модели</span>
          <input
            className="field-input"
            type="password"
            defaultValue={AI_API_KEY}
            placeholder="sk-…"
          />
        </label>
        <label className="field">
          <span className="field-label">Адрес сервера</span>
          <input
            className="field-input"
            type="text"
            defaultValue={AI_BASE_URL}
          />
        </label>
        <label className="field">
          <span className="field-label">Модель</span>
          <input className="field-input" type="text" defaultValue={AI_MODEL} />
        </label>
        <label className="field">
          <span className="field-label">Папка проектов</span>
          <input
            className="field-input"
            type="text"
            placeholder="Например: Документы\Проекты"
          />
        </label>
        <button className="btn btn-secondary" type="button">
          Проверить соединение
        </button>
      </div>
    </section>
  );
}
