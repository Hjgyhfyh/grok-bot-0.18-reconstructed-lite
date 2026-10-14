import { create } from "zustand";
import type { ProjectCard, FileChange } from "../services/tauri";
import { normalizeSettings, DEFAULT_SETTINGS } from "../core/settings";
import type { Settings } from "../core/settings";
import { AI_API_KEY, AI_BASE_URL, AI_MODEL } from "../config";
import { getSettingsRaw, setSettingsRaw } from "../services/tauri";
import { setAiSettingsProvider } from "../services/ai";
import type { UiError, UiMessage } from "./stateFns";

/**
 * Общее состояние приложения (zustand).
 * Слайсы: settings (persist через localStorage + команда set_settings),
 * projects, чат по проектам (chatByProject), ui-state.
 * Ошибки — UiError (kind/code/action); тексты — через i18n по errorCardKeys().
 */
export type { UiError, UiMessage, ErrorKind, ErrorAction } from "./stateFns";
export type { Settings } from "../core/settings";

export interface UsageStats {
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

/** Сессия чата одного проекта. */
export interface ChatSession {
  messages: UiMessage[];
  streaming: boolean;
  /** Правки из ответа модели, ожидающие «Посмотреть»/«Отменить изменения». */
  pendingChanges: FileChange[];
  /** Правки уже записаны в файлы — доступен откат. */
  applied: boolean;
  error: UiError | null;
  draft: string;
}

export const EMPTY_SESSION: ChatSession = {
  messages: [],
  streaming: false,
  pendingChanges: [],
  applied: false,
  error: null,
  draft: "",
};

export type ProjectsScan = "idle" | "scanning" | "done" | "error";

/** Дефолты настроек: зашитые при сборке значения поверх core-дефолтов. */
const BUILT_IN_SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  apiKey: AI_API_KEY,
  baseUrl: AI_BASE_URL,
  model: AI_MODEL,
};

// ---------------------------------------------------------------------------
// Персистентность (localStorage + settings.json в app_config_dir)
// ---------------------------------------------------------------------------

const STORAGE_KEY = "grok-lite.app.v1";

interface PersistedApp {
  version: number;
  settings: unknown;
  onboardingDone: unknown;
  usage: unknown;
}

function persistable(s: AppState): PersistedApp {
  return {
    version: 1,
    settings: s.settings,
    onboardingDone: s.onboardingDone,
    usage: s.usage,
  };
}

function readLocalStorage(): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeLocalStorage(p: PersistedApp): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* localStorage может быть недоступен — настройки живут в памяти */
  }
}

/** settings.json (app_config_dir) → localStorage → null. */
async function loadPersisted(): Promise<unknown> {
  try {
    const raw = await getSettingsRaw();
    if (raw) return JSON.parse(raw) as unknown;
  } catch {
    /* нет команды/файла — пробуем localStorage */
  }
  return readLocalStorage();
}

/** Пишем синхронно в localStorage; запись в файл — best effort. */
function savePersisted(p: PersistedApp): void {
  writeLocalStorage(p);
  void setSettingsRaw(JSON.stringify(p));
}

function extractUsage(raw: unknown): UsageStats {
  if (typeof raw === "object" && raw !== null) {
    const r = raw as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    return {
      requests: num(r.requests),
      promptTokens: num(r.promptTokens),
      completionTokens: num(r.completionTokens),
    };
  }
  return { requests: 0, promptTokens: 0, completionTokens: 0 };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface AppState {
  // --- settings ---
  settings: Settings;
  usage: UsageStats;

  // --- ui-state (persisted) ---
  onboardingDone: boolean;
  /** Миррор settings.theme ("dark" | "light" | "system"). */
  theme: Settings["theme"];

  // --- projects ---
  /** Корневая папка проектов (миррор settings.projectsDir; null = не выбрана). */
  projectsRoot: string | null;
  projects: ProjectCard[];
  /** Проект, открытый в чате (полный путь — он же id). */
  activeProject: string | null;
  /** Состояние сканирования + ошибка папки. */
  projectsScan: ProjectsScan;
  projectsError: UiError | null;

  // --- chat ---
  chatByProject: Record<string, ChatSession>;

  // --- settings actions ---
  loadSettings: () => Promise<void>;
  saveSettings: (patch: Partial<Settings> & { onboardingDone?: boolean }) => Promise<void>;
  setTheme: (theme: Settings["theme"]) => void;
  setOnboardingDone: (done: boolean) => void;
  addUsage: (delta: Partial<UsageStats>) => void;

  // --- projects actions ---
  setProjectsRoot: (root: string | null) => void;
  setProjects: (projects: ProjectCard[]) => void;
  setActiveProject: (path: string | null) => void;
  setProjectsScan: (scan: ProjectsScan, error?: UiError | null) => void;
  openProject: (path: string) => void;

  // --- chat actions ---
  ensureChat: (projectPath: string) => void;
  appendChatMessage: (projectPath: string, msg: UiMessage) => void;
  updateChatMessage: (
    projectPath: string,
    id: string,
    patch: Partial<Pick<UiMessage, "content" | "streaming">>,
  ) => void;
  setChatStreaming: (projectPath: string, streaming: boolean) => void;
  setChatError: (projectPath: string, error: UiError | null) => void;
  setChatPending: (projectPath: string, changes: FileChange[], applied: boolean) => void;
  setChatDraft: (projectPath: string, draft: string) => void;
  resetChat: (projectPath: string) => void;
}

function patchSession(
  byProject: Record<string, ChatSession>,
  projectPath: string,
  patch: Partial<ChatSession>,
): Record<string, ChatSession> {
  const prev = byProject[projectPath] ?? EMPTY_SESSION;
  return { ...byProject, [projectPath]: { ...prev, ...patch } };
}

export const useAppStore = create<AppState>((set, get) => ({
  // --- settings ---
  settings: { ...BUILT_IN_SETTINGS },
  usage: { requests: 0, promptTokens: 0, completionTokens: 0 },

  onboardingDone: false,
  theme: BUILT_IN_SETTINGS.theme,

  // --- projects ---
  projectsRoot: null,
  projects: [],
  activeProject: null,
  projectsScan: "idle",
  projectsError: null,

  // --- chat ---
  chatByProject: {},

  // --- settings actions ---
  loadSettings: async () => {
    const raw = await loadPersisted();
    const persisted: PersistedApp | null =
      typeof raw === "object" && raw !== null
        ? (raw as PersistedApp)
        : null;
    const settings = normalizeSettings(persisted?.settings, BUILT_IN_SETTINGS);
    set((s) => ({
      settings,
      theme: settings.theme,
      projectsRoot: settings.projectsDir || s.projectsRoot,
      onboardingDone: persisted?.onboardingDone === true,
      usage: extractUsage(persisted?.usage),
    }));
  },

  saveSettings: async (patch) => {
    const current = get().settings;
    const settings = normalizeSettings({ ...current, ...patch }, BUILT_IN_SETTINGS);
    const onboardingDone =
      patch.onboardingDone !== undefined ? patch.onboardingDone : get().onboardingDone;
    set({ settings, theme: settings.theme, projectsRoot: settings.projectsDir || null, onboardingDone });
    savePersisted(persistable(get()));
  },

  setTheme: (theme) => {
    void get().saveSettings({ theme });
  },

  setOnboardingDone: (done) => {
    set({ onboardingDone: done });
    savePersisted(persistable(get()));
  },

  addUsage: (delta) => {
    const u = get().usage;
    set({
      usage: {
        requests: u.requests + (delta.requests ?? 0),
        promptTokens: u.promptTokens + (delta.promptTokens ?? 0),
        completionTokens: u.completionTokens + (delta.completionTokens ?? 0),
      },
    });
    savePersisted(persistable(get()));
  },

  // --- projects actions ---
  setProjectsRoot: (root) => {
    set({ projectsRoot: root });
    const dir = root ?? "";
    if (get().settings.projectsDir !== dir) {
      void get().saveSettings({ projectsDir: dir });
    } else {
      savePersisted(persistable(get()));
    }
  },

  setProjects: (projects) => set({ projects }),
  setActiveProject: (activeProject) => set({ activeProject }),
  setProjectsScan: (projectsScan, error = null) =>
    set({ projectsScan, projectsError: error }),
  openProject: (path) => {
    set({ activeProject: path });
    get().ensureChat(path);
  },

  // --- chat actions ---
  ensureChat: (projectPath) => {
    const { chatByProject } = get();
    if (!(projectPath in chatByProject)) {
      set({ chatByProject: { ...chatByProject, [projectPath]: { ...EMPTY_SESSION } } });
    }
  },

  appendChatMessage: (projectPath, msg) => {
    set((s) => ({
      chatByProject: patchSession(s.chatByProject, projectPath, {
        messages: [...(s.chatByProject[projectPath]?.messages ?? []), msg],
      }),
    }));
  },

  updateChatMessage: (projectPath, id, patch) => {
    set((s) => {
      const sess = s.chatByProject[projectPath];
      if (!sess) return s;
      const messages = sess.messages.map((m) => (m.id === id ? { ...m, ...patch } : m));
      return { chatByProject: patchSession(s.chatByProject, projectPath, { messages }) };
    });
  },

  setChatStreaming: (projectPath, streaming) => {
    set((s) => ({ chatByProject: patchSession(s.chatByProject, projectPath, { streaming }) }));
  },

  setChatError: (projectPath, error) => {
    set((s) => ({ chatByProject: patchSession(s.chatByProject, projectPath, { error }) }));
  },

  setChatPending: (projectPath, changes, applied) => {
    set((s) => ({
      chatByProject: patchSession(s.chatByProject, projectPath, {
        pendingChanges: changes,
        applied,
      }),
    }));
  },

  setChatDraft: (projectPath, draft) => {
    set((s) => ({ chatByProject: patchSession(s.chatByProject, projectPath, { draft }) }));
  },

  resetChat: (projectPath) => {
    set((s) => ({
      chatByProject: { ...s.chatByProject, [projectPath]: { ...EMPTY_SESSION } },
    }));
  },
}));

// Настройки → адаптер AI (контракт services/ai.ts setAiSettingsProvider).
// Провайдер живёт отдельно от store-подписки: регистрируем один раз.
setAiSettingsProvider(() => {
  const s = useAppStore.getState().settings;
  return { apiKey: s.apiKey, baseUrl: s.baseUrl, model: s.model };
});

/** Селектор сессии с безопасным дефолтом (стабильная ссылка). */
export function selectChat(state: AppState, projectPath: string | null): ChatSession {
  return projectPath ? state.chatByProject[projectPath] ?? EMPTY_SESSION : EMPTY_SESSION;
}
