# wire-themes — out-of-scope edits required by `lite/waveb-themes`

Branch `lite/waveb-themes` ports the wave-3 light-theme work:

- `frontend/src/recovered/features/runtime-theme-token-installer.ts` — now the wave-3
  four-variant installer. `RuntimeThemeMode` (`"light" | "dark"`), `IMMUTABLE_THEME_SNAPSHOT_HASHES`,
  `bzn`/`Ezn`/`_zn`/`CORE_CSS` are gone; the exports are `RuntimeThemeVariant`
  (`"light-white" | "milk" | "smoke" | "sky"`), `RUNTIME_THEME_VARIANTS`,
  `DEFAULT_RUNTIME_THEME_VARIANT` (`"light-white"`), `RUNTIME_THEME_LABELS`,
  `RUNTIME_THEME_CLASS` (variant → `data-theme` value, identity map), `RUNTIME_THEME_CANVAS`,
  `isRuntimeThemeVariant`, `buildRuntimeThemeCss(variant)`, `buildRuntimeThemeSheet()`,
  `Bzn(variant)`, `createRuntimeThemeInstaller(document, initialVariant)`.
  The whole four-variant sheet is installed once; switching is `data-theme` on `<html>`
  plus `style.colorScheme = "light"`. No dark palette, no `prefers-color-scheme`, the OS
  appearance is never read.
- `source/electron-main/prefs/theme-controller.ts` — now the wave-3 controller.
  `SandResolvedTheme = SandThemePreference`, `themeSource` pinned to `"light"`,
  `#resolveTheme()` returns the stored preference (no `nativeTheme` listener),
  `WINDOW_BACKGROUND_BY_THEME` is keyed by variant, `themeLabel()` added.
- Eight CSS files ported verbatim from wave-3 (dark fallbacks → light `--sand-*` tokens).

The edits below are needed outside the owned paths so the new theme contract type-checks
and the app boots into `light-white`. Apply them exactly; where a wave-3 reference exists
the code is taken from `git show origin/archive/wave-3:<path>`.

---

## 1. `source/shared/desktop.ts` — theme preference union

Required by the ported `theme-controller.ts` (imports `SAND_THEME_LABELS`; `SandResolvedTheme`
and `WINDOW_BACKGROUND_BY_THEME` are now keyed by variant). Without this, `tsc` fails with
`TS2305` (no `SAND_THEME_LABELS` export) and `TS2322`/`TS2415` on the variant literals.

```ts
// replace
export const SAND_THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type SandThemePreference = (typeof SAND_THEME_PREFERENCES)[number];
export const DEFAULT_SAND_THEME_PREFERENCE: SandThemePreference = "system";

// with (wave-3 verbatim)
/** Четыре светлых варианта оформления. Тёмных тем в приложении нет.
 *  Идентификаторы совпадают со значением data-theme на <html>. */
export const SAND_THEME_PREFERENCES = ["light-white", "milk", "smoke", "sky"] as const;
export type SandThemePreference = (typeof SAND_THEME_PREFERENCES)[number];
export const DEFAULT_SAND_THEME_PREFERENCE: SandThemePreference = "light-white";
export const SAND_THEME_LABELS: Readonly<Record<SandThemePreference, string>> = {
  "light-white": "Белый",
  milk: "Молочный",
  smoke: "Дымчатый",
  sky: "Небо"
};
```

`isSandThemePreference` needs no change. `sand-settings-store.ts` keeps working: a stored
`"system"`/`"light"`/`"dark"` now fails the guard and falls back to `light-white` — the
desired migration behaviour.

## 2. `source/electron-main/dev/dev-controls-window.ts` — theme-state guard (wave-3 verbatim)

```ts
// line ~136, replace
export interface SandThemeState { readonly preference: SandThemePreference; readonly resolved: "light" | "dark" }
// with
export interface SandThemeState { readonly preference: SandThemePreference; readonly resolved: SandThemePreference }

// line ~138, replace the `resolved` check
...(value.resolved === "light" || value.resolved === "dark");
// with
...isSandThemePreference(value.resolved);
```

## 3. `frontend/src/recovered/contracts/desktop-bridge.ts` — bridge theme types

```ts
// replace
export type ThemePreference = "system" | "light" | "dark";
export interface ThemeState {
  preference: ThemePreference;
  resolved: "light" | "dark";
}
// with (wave-3 verbatim)
/** Четыре светлых варианта оформления. Тёмных тем нет, системная тема не читается. */
export type ThemePreference = "light-white" | "milk" | "smoke" | "sky";
export interface ThemeState {
  preference: ThemePreference;
  resolved: ThemePreference;
}
```

## 4. `frontend/src/recovered/contracts/main-rpc.ts` — RPC payload type

```ts
// line 62, replace
setThemePreference: { preference: "system" | "light" | "dark" };
// with
setThemePreference: { preference: "light-white" | "milk" | "smoke" | "sky" };
```

## 5. `frontend/src/recovered/features/window-chrome/model.ts` — `applyRootShellTheme`

```ts
// import line: add the type
import { RUNTIME_THEME_CLASS, type RuntimeThemeVariant } from "../runtime-theme-token-installer";

// replace the whole function (wave-3 verbatim)
export function applyRootShellTheme(resolved: RuntimeThemeVariant): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  // Переключение варианта идёт через data-theme на <html>: установщик темы уже положил в
  // документ все четыре светлых набора токенов, правила отфильтрованы по этому атрибуту.
  root.dataset.theme = RUNTIME_THEME_CLASS[resolved];
  root.style.colorScheme = "light";
}
```

## 6. `frontend/src/production/ProductionRenderer.tsx` — commands + state defaults

```ts
// THEME_COMMANDS (~line 394): replace the three entries with the wave-3 four
const THEME_COMMANDS: readonly { preference: ThemePreference; label: string; keywords: readonly string[] }[] = [
  { preference: "light-white", label: "Тема: Белый", keywords: ["appearance", "white", "bright", "day"] },
  { preference: "milk", label: "Тема: Молочный", keywords: ["appearance", "milk", "warm", "cream"] },
  { preference: "smoke", label: "Тема: Дымчатый", keywords: ["appearance", "smoke", "grey", "gray"] },
  { preference: "sky", label: "Тема: Небо", keywords: ["appearance", "sky", "blue", "cold"] }
];

// ~line 895-896: variant preference and resolved-as-variant state
const [themePreference, setThemePreference] = useState<ThemePreference>(() => bridge?.theme.initial.preference ?? "light-white");
const [resolvedTheme, setResolvedTheme] = useState<ThemePreference>(() => bridge?.theme.initial.resolved ?? "light-white");
```

`data-theme={RUNTIME_THEME_CLASS[resolvedTheme]}` (line ~3426) and the
`themeInstaller?.update(theme.resolved)` call now take the variant — no further change.

## 7. `frontend/src/recovered/features/settings/overlay/panels.tsx` — theme picker

```ts
// import line: add ThemePreference to the desktop-bridge type import
import type { CursorUsageSummary, CursorUsageUpgradeAction, DesktopTimeZoneState, ThemePreference } from "../../../contracts/desktop-bridge";

// GeneralSettingsPanelProps (~line 26-28)
  theme: ThemePreference;
  onThemeChange(theme: ThemePreference): void | Promise<unknown>;

// THEME_PREFERENCE_OPTIONS (~line 38-43): wave-3 four variants
/** Четыре светлых варианта. Значение совпадает с data-theme на <html>. */
export const THEME_PREFERENCE_OPTIONS: readonly { value: ThemePreference; label: string }[] = [
  { value: "light-white", label: "Белый" },
  { value: "milk", label: "Молочный" },
  { value: "smoke", label: "Дымчатый" },
  { value: "sky", label: "Небо" }
];
```

## 8. `frontend/src/recovered/features/onboarding/signed-in/view.tsx` — onboarding root

```tsx
// line ~222, replace
data-theme={bridge.theme.initial.resolved === "dark" ? "cursor-dark" : "cursor-light"}
// with (wave-3 verbatim)
data-theme={bridge.theme.initial.resolved}
```

## 9. `frontend/src/recovered/features/conversation/workspace/mermaid.tsx` — diagram theme

`data-theme` now carries the variant name (`"light-white"`, not `"light"`), so the old
`=== "light"` check would pick mermaid's dark theme everywhere. Wave-3 fix:

```ts
// line ~213, replace
const resolvedTheme = theme ?? (typeof document !== "undefined" && document.documentElement.dataset.theme === "light" ? "light" : "dark");
// with
// В приложении только светлые темы, поэтому схемы всегда рисуются в светлом варианте mermaid.
// Значение data-theme на <html> больше не читается: оно несёт имя светлого варианта оформления.
const resolvedTheme = theme === "dark" ? "dark" : "light";
```

## 10. `frontend/src/dev/DevShell.tsx` — dev preview state

```ts
// line ~16, extend the existing import
import { hasDesktopBridge, type ThemePreference } from "../recovered/contracts/desktop-bridge";

// line ~45, replace
const [previewTheme, setPreviewTheme] = useState<"system" | "light" | "dark">("system");
// with (wave-3 verbatim)
const [previewTheme, setPreviewTheme] = useState<ThemePreference>("light-white");
```

## 11. `tests/settings-file-write-integrity.test.mjs` — theme literals

`"dark"`/`"system"` are out-of-schema after edit 1 and read back as `"light-white"`.
Update the theme touch-points (wave-3 deleted this file; on this base it still exists):

- `themePreference: "dark"` (POPULATED, ~line 92) → `themePreference: "milk"`
- `assert.equal(onDisk(settingsPath).themePreference, "dark", ...)` (~line 113) → `"milk"`
- `assert.equal(settings.getThemePreference(), "system", ...)` (~line 173) → `"light-white"`
- `["setThemePreference", "neon", "themePreference", "system"]` (~line 186) →
  `["setThemePreference", "neon", "themePreference", "light-white"]`
- `before.setThemePreference("dark")` (~line 208) → `before.setThemePreference("smoke")`
- `assert.equal(after.getThemePreference(), "dark", ...)` (~line 235) → `"smoke"`

---

## Expected residual `tsc -p source/tsconfig.json` errors until edits 1-2 land

`theme-controller.ts`: `TS2305 SAND_THEME_LABELS`, `TS2322`/`TS2415` variant-vs-`SandThemePreference`.
`dev-controls-window.ts` is itself an out-of-scope edit (item 2).

## Deliberately left dark (matches wave-3)

- `frontend/src/dev/dev-shell.css` — dev-controls overlay chrome, not a shipped theme.
- `frontend/src/recovered/features/computer/shell/view.css` — vendored remote-desktop
  shell stylesheet with its own internal token block; untouched by wave-3.
- `frontend/src/recovered/features/onboarding/signed-in/character.tsx` — `surfaceTheme: "light"`
  literal already light.
