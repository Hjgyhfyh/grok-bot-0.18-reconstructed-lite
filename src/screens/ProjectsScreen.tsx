import { FolderPlus } from "lucide-react";

export default function ProjectsScreen() {
  return (
    <section className="screen">
      <h1 className="screen-title">Мои проекты</h1>
      <div className="empty-state">
        <FolderPlus size={48} strokeWidth={1.5} />
        <p className="empty-state-title">Здесь появятся ваши проекты</p>
        <p className="empty-state-hint">
          Укажите папку, где лежат ваши проекты, — и мы покажем их карточками.
        </p>
        <button className="btn btn-primary" type="button">
          Выбрать папку
        </button>
      </div>
    </section>
  );
}
