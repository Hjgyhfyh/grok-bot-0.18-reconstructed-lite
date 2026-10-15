import type { DesktopBridge } from "../../contracts/desktop-bridge";
import { RUNTIME_THEME_CLASS, type RuntimeThemeVariant } from "../runtime-theme-token-installer";

// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#L132738
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#L132917
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#L129272-L129323

export const WINDOW_CHROME_METRICS = {
  controlsInset: 140,
  hiddenControlsBlock: 51,
  controlsBlock: 52,
  iconSize: 12
} as const;

export function scaledWindowChromeDimension(pixels: number): string {
  return `calc(${pixels}px / var(--sand-zoom-factor, 1))`;
}

export function windowChromeBlock(platform: DesktopBridge["platform"]): string {
  return platform === "win32"
    ? scaledWindowChromeDimension(WINDOW_CHROME_METRICS.hiddenControlsBlock)
    : `${WINDOW_CHROME_METRICS.controlsBlock}px`;
}

export function setWindowChromeVariables(platform: DesktopBridge["platform"], isFullscreen: boolean): (() => void) | undefined {
  if (typeof document === "undefined" || platform === "darwin" || isFullscreen) return undefined;
  const root = document.documentElement;
  root.style.setProperty("--sand-window-controls-inset", scaledWindowChromeDimension(WINDOW_CHROME_METRICS.controlsInset));
  root.style.setProperty("--sand-window-controls-block", windowChromeBlock(platform));
  return () => {
    root.style.removeProperty("--sand-window-controls-inset");
    root.style.removeProperty("--sand-window-controls-block");
  };
}

export function applyRootShellTheme(resolved: RuntimeThemeVariant): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  // Переключение варианта идёт через data-theme на <html>: установщик темы уже положил в
  // документ все четыре светлых набора токенов, правила отфильтрованы по этому атрибуту.
  root.dataset.theme = RUNTIME_THEME_CLASS[resolved];
  root.style.colorScheme = "light";
}

// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#L537
export function applyRootShellZoomFactor(factor: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--sand-zoom-factor", String(Number.isFinite(factor) ? factor : 1));
}

export function shouldRefreshRootShellOnFocus(transport: "browser" | "connecting" | "connected" | "down", visibility: "hidden" | "visible"): boolean {
  return transport === "connected" && visibility === "visible";
}
