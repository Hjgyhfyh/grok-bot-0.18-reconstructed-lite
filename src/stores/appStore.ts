import { create } from "zustand";
import type { ProjectCard } from "../services/tauri";

/**
 * Общее состояние приложения.
 * Волна B: добавить settingsStore (переопределение config.ts),
 * chatStore (история сообщений), backupStore.
 */

interface AppState {
  /** Корневая папка, выбранная пользователем («где мои проекты»). */
  projectsRoot: string | null;
  /** Карточки проектов после сканирования. */
  projects: ProjectCard[];
  /** Проект, открытый в чате. */
  activeProject: string | null;

  setProjectsRoot: (root: string | null) => void;
  setProjects: (projects: ProjectCard[]) => void;
  setActiveProject: (path: string | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  projectsRoot: null,
  projects: [],
  activeProject: null,

  setProjectsRoot: (projectsRoot) => set({ projectsRoot }),
  setProjects: (projects) => set({ projects }),
  setActiveProject: (activeProject) => set({ activeProject }),
}));
