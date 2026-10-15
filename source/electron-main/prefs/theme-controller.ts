import { SAND_THEME_LABELS, type SandThemePreference } from "../../shared/desktop.js";

/** Разрешённая тема равна выбранному варианту: тёмных тем нет, системная тема не читается. */
export type SandResolvedTheme = SandThemePreference;
export interface SandThemeState { readonly preference: SandThemePreference; readonly resolved: SandResolvedTheme }
export interface SandThemeSettingsStore {
  getThemePreference(): SandThemePreference;
  setThemePreference(preference: SandThemePreference): void;
}
/** Собственный тип Electron: main-процесс всегда просит светлый colorScheme. */
export type SandNativeThemeSource = "system" | "light" | "dark";
export interface NativeThemePort {
  themeSource: SandNativeThemeSource;
  readonly shouldUseDarkColors: boolean;
  on(event: "updated", listener: () => void): void;
  removeListener(event: "updated", listener: () => void): void;
}

/** Цвет окна Electron до первого кадра рендерера. Взят из палитры варианта. */
export const WINDOW_BACKGROUND_BY_THEME: Readonly<Record<SandResolvedTheme, string>> = {
  "light-white": "#FFFFFF",
  milk: "#FBF7F1",
  smoke: "#F2F4F6",
  sky: "#EFF5FD"
};

export function windowBackgroundColorForResolvedTheme(theme: SandResolvedTheme): string {
  return WINDOW_BACKGROUND_BY_THEME[theme];
}

export function themeLabel(theme: SandThemePreference): string {
  return SAND_THEME_LABELS[theme];
}

export class SandThemeController {
  readonly #settingsStore: SandThemeSettingsStore;
  readonly #broadcastState: (state: SandThemeState) => void;
  readonly #nativeTheme: NativeThemePort;
  #disposed = false;

  constructor(settingsStore: SandThemeSettingsStore, broadcastState: (state: SandThemeState) => void, nativeTheme: NativeThemePort) {
    this.#settingsStore = settingsStore;
    this.#broadcastState = broadcastState;
    this.#nativeTheme = nativeTheme;
    // Системная тема не используется: нативные элементы окна всегда светлые.
    this.#nativeTheme.themeSource = "light";
  }

  getState(): SandThemeState {
    return { preference: this.#settingsStore.getThemePreference(), resolved: this.#resolveTheme() };
  }

  setPreference(preference: SandThemePreference): SandThemeState {
    if (this.#disposed) throw new Error("Sand theme controller is disposed.");
    this.#settingsStore.setThemePreference(preference);
    const state = this.getState();
    this.#broadcastState(state);
    return state;
  }

  getWindowBackgroundColor(): string {
    return windowBackgroundColorForResolvedTheme(this.#resolveTheme());
  }

  dispose(): void {
    this.#disposed = true;
  }

  #resolveTheme(): SandResolvedTheme { return this.#settingsStore.getThemePreference(); }
}
