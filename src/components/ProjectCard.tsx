import { FolderOpen } from "lucide-react";
import { t, formatRelative } from "../i18n";
import type { RuStringKey } from "../i18n";
import type { ProjectCard as ProjectCardData, ProjectStatus } from "../services/tauri";

/**
 * Карточка проекта на экране «Мои проекты».
 * Тонкий адаптер: данные приходят из scan_projects (services/tauri.ts),
 * все строки — через i18n. Классы — общие из global.css
 * (.project-card / .status--* / .project-card-meta).
 */

/** CONTRACT: имя карточки в навигации — encodeURIComponent(path), роут /chat/:projectPath. */
export function projectChatUrl(path: string): string {
  return `/chat/${encodeURIComponent(path)}`;
}

/** Статус → ключ подписи и модификатор цвета (.status--* в global.css). */
const STATUS_VIEW: Record<ProjectStatus, { key: RuStringKey; mod: string }> = {
  clean: { key: "statusClean", mod: "status--clean" },
  dirty: { key: "statusDirty", mod: "status--dirty" },
  stale: { key: "statusStale", mod: "status--stale" },
  crashed: { key: "statusFailed", mod: "status--failed" },
};

interface Props {
  project: ProjectCardData;
  onOpen: (path: string) => void;
}

export default function ProjectCard({ project, onOpen }: Props) {
  const status = STATUS_VIEW[project.status] ?? STATUS_VIEW.clean;
  // last_activity — unix-секунды из Rust; formatRelative ждёт мс.
  const when = formatRelative(project.last_activity * 1000);

  return (
    <article className="project-card">
      <div className="project-card-head">
        <FolderOpen size={20} strokeWidth={1.8} aria-hidden />
        <h2 className="project-card-name" title={project.path}>
          {project.name}
        </h2>
      </div>
      <span className={`status ${status.mod}`}>{t(status.key)}</span>
      <p className="project-card-meta">
        {t("projectChanged", { when })}
        {" · "}
        {t("projectFiles", { n: project.file_count })}
      </p>
      <button
        className="btn btn-secondary"
        type="button"
        onClick={() => onOpen(project.path)}
      >
        {t("projectOpen")}
      </button>
    </article>
  );
}
