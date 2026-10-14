import { useCallback } from "react";
import { pickFolder, scanProjects } from "../services/tauri";
import { useAppStore } from "../stores/appStore";
import { classifyFolderError } from "../stores/stateFns";

/**
 * Карточки проектов: refresh() → services scan_projects (внутри — нормализация
 * через computeStatus из core/scanner) → appStore. Хук только оркестрация.
 */
export function useProjects() {
  const projects = useAppStore((s) => s.projects);
  const projectsRoot = useAppStore((s) => s.projectsRoot);
  const projectsScan = useAppStore((s) => s.projectsScan);
  const projectsError = useAppStore((s) => s.projectsError);
  const activeProject = useAppStore((s) => s.activeProject);

  const refresh = useCallback(async () => {
    const st = useAppStore.getState();
    const root = st.projectsRoot;
    if (!root) {
      st.setProjectsScan("idle");
      return;
    }
    st.setProjectsScan("scanning");
    try {
      const cards = await scanProjects(root);
      st.setProjects(cards);
      st.setProjectsScan("done");
    } catch (e) {
      st.setProjectsScan("error", classifyFolderError(e));
    }
  }, []);

  /** Записать выбранную папку (персистит) и пересканировать. */
  const selectFolder = useCallback(
    async (path: string) => {
      useAppStore.getState().setProjectsRoot(path || null);
      await refresh();
    },
    [refresh],
  );

  /** Нативный диалог → selectFolder. true — папка выбрана. */
  const pickAndSelect = useCallback(async (): Promise<boolean> => {
    const dir = await pickFolder();
    if (!dir) return false;
    await selectFolder(dir);
    return true;
  }, [selectFolder]);

  /** Открыть проект в чате (только store; навигация — у экрана). */
  const openProject = useCallback((path: string) => {
    useAppStore.getState().openProject(path);
  }, []);

  const dismissError = useCallback(() => {
    const st = useAppStore.getState();
    if (st.projectsScan === "error") st.setProjectsScan("done", null);
    else st.setProjectsScan(st.projectsScan, null);
  }, []);

  return {
    projects,
    projectsRoot,
    activeProject,
    loading: projectsScan === "scanning",
    scanState: projectsScan,
    error: projectsError,
    refresh,
    selectFolder,
    pickAndSelect,
    openProject,
    dismissError,
  };
}
