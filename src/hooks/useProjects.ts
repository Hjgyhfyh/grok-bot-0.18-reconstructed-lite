import { useCallback, useState } from "react";
import { scanProjects } from "../services/tauri";
import { useAppStore } from "../stores/appStore";

/**
 * Загрузка карточек проектов из корневой папки.
 * Волна B: привязать к экрану «Мои проекты» и выбору папки (диалог).
 */
export function useProjects() {
  const { projectsRoot, projects, setProjects } = useAppStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectsRoot) return;
    setLoading(true);
    setError(null);
    try {
      setProjects(await scanProjects(projectsRoot));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить проекты");
    } finally {
      setLoading(false);
    }
  }, [projectsRoot, setProjects]);

  return { projects, loading, error, refresh };
}
