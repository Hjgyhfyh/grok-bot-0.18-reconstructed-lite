import { installApplicationMenu, type ApplicationMenuElectronPort } from "./application-menu.js";
import { reportDesktopEdgeFailure } from "./desktop-edge-failures.js";
import { createDevToolsGate, createDevToolsMembershipResolver } from "./devtools-gate.js";
import {
  createHostWindowChords,
  type HostInputEvent,
  type HostWindowInput,
} from "./host-window-chords.js";
import {
  attachWindowFocusForwarding,
  attachWindowStateBroadcast,
  createWindowFocusSync,
  createWindowsTitleBarOverlaySession,
  windowChromeOptions,
  type Rectangle,
  type WindowState,
  type WindowsTitleBarOverlay,
} from "./window-chrome.js";
import type { SandWindowPlacement, WindowStatePersistenceWindow } from "./window-state-persistence.js";
import { createElectronMainProductionComposition, type ElectronMainProductionBindings } from "./main-production-services.js";
import { startAutomaticUpdates } from "./updater/auto-updates.js";

export interface PreventableEvent {
  preventDefault(): void;
}

export interface MainWebContents {
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
  isDevToolsOpened(): boolean;
  closeDevTools(): void;
  openDevTools(options: { readonly mode: "detach" }): void;
  toggleDevTools(): void;
  getZoomFactor(): number;
  setZoomFactor(factor: number): void;
  reload(): void;
  executeJavaScript(script: string, userGesture: boolean): Promise<unknown>;
  getURL(): string;
  setWindowOpenHandler(
    handler: (details: { readonly url: string }) => { readonly action: "deny" },
  ): void;
  on(
    event: "before-input-event",
    listener: (event: HostInputEvent, input: HostWindowInput) => void,
  ): void;
  on(event: "will-navigate", listener: (event: PreventableEvent, url: string) => void): void;
  on(
    event: "will-frame-navigate",
    listener: (details: PreventableEvent & { readonly isMainFrame: boolean; readonly url: string }) => void,
  ): void;
  on(event: "did-start-loading", listener: () => void): void;
  on(event: "unresponsive" | "responsive", listener: () => void): void;
}

export interface MainBrowserWindow extends WindowStatePersistenceWindow {
  readonly webContents: MainWebContents;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  isFocused(): boolean;
  setFullScreen(fullscreen: boolean): void;
  setTitleBarOverlay?(overlay: WindowsTitleBarOverlay): void;
  loadURL(url: string): Promise<unknown>;
  loadFile(file: string): Promise<unknown>;
  on(
    event:
      | "resize"
      | "move"
      | "maximize"
      | "unmaximize"
      | "close"
      | "enter-full-screen"
      | "leave-full-screen"
      | "focus"
      | "blur"
      | "session-end"
      | "closed",
    listener: () => void,
  ): void;
}

export interface ElectronMainApp {
  readonly isPackaged: boolean;
  disableHardwareAcceleration(): void;
  readonly commandLine: { readonly appendSwitch: (name: string, value?: string) => void };
  requestSingleInstanceLock(): boolean;
  quit(): void;
  isReady(): boolean;
  whenReady(): Promise<unknown>;
  on(event: "second-instance", listener: (event: unknown, argv: readonly string[]) => void): void;
  on(event: "open-url", listener: (event: PreventableEvent, url: string) => void): void;
  on(event: "activate" | "window-all-closed", listener: () => void): void;
  on(event: "before-quit", listener: (event: PreventableEvent) => void): void;
  on(event: "will-quit", listener: () => void): void;
  on(
    event: "render-process-gone",
    listener: (event: unknown, contents: MainWebContents, details: { readonly reason: string; readonly exitCode?: number }) => void,
  ): void;
  on(
    event: "child-process-gone",
    listener: (event: unknown, details: { readonly type: string; readonly serviceName?: string; readonly reason: string; readonly exitCode?: number }) => void,
  ): void;
}

export interface MainEdge {
  emit(event: string, payload: unknown): void;
}

export interface ElectronMainServices {
  readonly mainEdge: MainEdge;
  readonly getDevToolsMembershipStatus: () => Promise<{
    readonly kind: string;
    readonly isAnysphereUser?: boolean;
  }>;
  readonly subscribeDevToolsMembership: (listener: () => void) => () => void;
  readonly getThemeBackgroundColor: () => string;
  readonly openExternalUrl: (url: string) => Promise<unknown>;
  readonly configureVncTrust?: () => void;
  readonly hardenVncWebviewAttach?: (contents: MainWebContents) => void;
  readonly onWindowCreated?: (window: MainBrowserWindow) => void;
  /** Process-lifetime image context-menu listener installed after the application menu. */
  readonly registerImageContextMenu?: () => void;
  readonly dispose?: () => void | Promise<void>;
}

export interface ElectronMainServicesInitializationOptions {
  readonly routeHostInput: (input: HostWindowInput) => boolean;
}

export interface MainWindowStatePersistence {
  readonly resolveSandWindowPlacement: () => SandWindowPlacement;
  readonly applySandWindowPlacement: (
    window: WindowStatePersistenceWindow,
    placement: SandWindowPlacement,
  ) => void;
}

export interface ElectronMainDependencies {
  readonly app: ElectronMainApp;
  readonly menu: ApplicationMenuElectronPort;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly isLabBuild?: boolean;
  readonly isAttachProdBox?: boolean;
  readonly appVersion?: string;
  readonly appName: string;
  readonly devAppIcon?: string;
  readonly preloadPath: string;
  readonly rendererHtmlPath: string;
  readonly createBrowserWindow: (options: MainBrowserWindowOptions) => MainBrowserWindow;
  readonly getAllWindows: () => readonly MainBrowserWindow[];
  readonly windowStatePersistence: MainWindowStatePersistence;
  readonly deepLinks: {
    readonly extractCandidatesFromArgv: (argv: readonly string[]) => readonly string[];
    readonly handleCandidate: (candidate: string, source: "second-instance" | "open-url") => void;
    readonly handleArgv: (argv: readonly string[], source: "initial-argv") => void;
    readonly hasPendingActivation: () => boolean;
    readonly markNotReady: () => void;
  };
  readonly startup: {
    readonly bootstrapBeforeSingleInstance: () => void;
    readonly bootstrapAfterSingleInstance: (isPrimaryInstance: boolean) => void;
    readonly markPhase: (phase: "move_check" | "services" | "window") => void;
    readonly runMoveCheck: (input: { readonly hasPendingActivation: () => boolean }) => Promise<"continue-bootstrap" | "stop-bootstrap">;
    readonly armStuckWatchdog: () => void;
    readonly noteReady: () => void;
    readonly noteFailed: (error: unknown) => void;
    readonly cancel: () => void;
  };
  readonly initializeFoundation: () => void;
  readonly initializeServices: (options?: ElectronMainServicesInitializationOptions) => Promise<ElectronMainServices>;
  readonly syncWindowFocused: (state: { readonly isFocused: boolean }) => Promise<unknown>;
  readonly beginBeforeQuit?: () => "continue" | "prevent";
}

export interface MainBrowserWindowOptions {
  readonly x?: number;
  readonly y?: number;
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
  readonly title: string;
  readonly icon?: string;
  readonly backgroundColor: string;
  readonly frame: boolean;
  readonly titleBarStyle: "hiddenInset" | "hidden" | "default";
  readonly trafficLightPosition?: { readonly x: number; readonly y: number };
  readonly titleBarOverlay?: WindowsTitleBarOverlay;
  readonly webPreferences: {
    readonly contextIsolation: true;
    readonly nodeIntegration: false;
    readonly preload: string;
    readonly sandbox: false;
    readonly webviewTag: true;
    /**
     * Проверка орфографии выключена намеренно. Chromium подгружает словарь
     * Hunspell в память каждого рендерера (10–25 МБ) и гоняет разбор каждого
     * нажатия. Интерфейс и так ставит `spellcheck="false"` на полях ввода
     * (`rich-text-editor.tsx:730`), то есть пользователь от словаря ничего
     * не получает.
     */
    readonly spellcheck: false;
  };
}

export interface ElectronMainRuntime {
  readonly isPrimaryInstance: boolean;
  readonly isQuitting: () => boolean;
  readonly getMainWindow: () => MainBrowserWindow | undefined;
  readonly ensureMainWindow: () => void;
  readonly setTitleBarOverlayTone: (isOverlayTone: boolean) => void;
  readonly syncWindowsTitleBarOverlay: () => void;
}

export function configureDesktopEnvironment(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly isPackaged: boolean;
  readonly isAttachProdBox: boolean;
  readonly isLabBuild: boolean;
  readonly appVersion?: string;
}): void {
  if (input.isAttachProdBox) input.env.SAND_ATTACH_PROD_BOX = "1";
  else if (!input.isPackaged) input.env.SAND_ATTACH_PROD_BOX = "0";
  input.env.SAND_PACKAGED = input.isAttachProdBox || input.isPackaged ? "1" : "0";
  input.env.SAND_LAB = input.isLabBuild ? "1" : "0";
  if (input.appVersion != null) input.env.SAND_CLIENT_APP_VERSION = input.appVersion;
}

export function isSameDocumentNavigation(target: string, current: string): boolean {
  try {
    const next = new URL(target);
    const here = new URL(current);
    return next.origin === here.origin && next.pathname === here.pathname;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Слабый компьютер пользователя: 8 ГБ RAM, RTX 1050 Ti 4 ГБ, Windows 10.
// ---------------------------------------------------------------------------

/** Потолок кучи V8 для каждого процесса Chromium. */
export const WEAK_MACHINE_MAX_OLD_SPACE_MB = 1536;
/** Молодое поколение V8. По умолчанию 16 МБ на scavenger, здесь 4 МБ. */
export const WEAK_MACHINE_MAX_SEMI_SPACE_MB = 4;
/** Функции Chromium, которые на слабой машине только отнимают ресурсы. */
export const WEAK_MACHINE_DISABLED_FEATURES = [
  // Нативный трекер оклюзии: отдельный поток и GetWindowRgn на каждом кадре.
  "CalculateNativeWinOcclusion",
  // Кэш «назад-вперёд» держит в памяти закрытые документы. У Lite их нет.
  "BackForwardCache",
  // MediaRouter поднимает слушающий сокет в сетевом процессе (трансляция на ТВ).
  "MediaRouter",
  // WebGPU уводит Chromium в D3D12-DXC, то есть в вырезанные из пакета
  // dxcompiler.dll и dxil.dll.
  "WebGPU",
].join(",");

export interface WeakMachineSwitch {
  readonly name: string;
  readonly value?: string;
}

/**
 * Полный список переключателей Chromium для слабой машины.
 *
 * Функция чистая: она ничего не меняет и только считает. Так её можно проверить
 * тестом и сравнить с тем, что реально ушло в командную строку.
 *
 * Два выключателя нужны для отката без пересборки:
 *   `DB_BOT_GPU_MODE=hardware` — оставить аппаратное ускорение видеокарты;
 *   `DB_BOT_DISABLE_WEAK_SWITCHES=1` — не добавлять ничего.
 * Они существуют потому, что правильный выбор зависит не только от железа,
 * но и от версии драйвера: у части машин с 1050 Ti программный рендер быстрее,
 * у части — аппаратный.
 */
export function collectWeakMachineSwitches(env: NodeJS.ProcessEnv): WeakMachineSwitch[] {
  if (env.DB_BOT_DISABLE_WEAK_SWITCHES === "1") return [];
  const hardwareGpu = (env.DB_BOT_GPU_MODE ?? "software").trim().toLowerCase() === "hardware";
  const switches: WeakMachineSwitch[] = [
    // Потолок old-space. Без него 64-битный Chromium берёт около 2 ГБ на
    // главный процесс, и на 8 ГБ это съедает память рендерера и демонов.
    // Молодое поколение уменьшено отдельно: при большом транскрипте там
    // живут долгоживущие объекты, и слишком маленькое значение даёт
    // лишние сборки мусора.
    {
      name: "js-flags",
      value: `--max-old-space-size=${WEAK_MACHINE_MAX_OLD_SPACE_MB} --max-semi-space-size=${WEAK_MACHINE_MAX_SEMI_SPACE_MB}`,
    },
    { name: "disable-features", value: WEAK_MACHINE_DISABLED_FEATURES },
    // Кэш для `file://` почти не используется, но Chromium всё равно его
    // создаёт и держит на диске без нужды.
    { name: "disk-cache-size", value: "1048576" },
    { name: "media-cache-size", value: "1048576" },
    // Фоновые службы Chromium: пинги безопасности, проверка компонентов,
    // статистика использования. Приложению нужен только исходящий HTTPS.
    { name: "disable-background-networking" },
    { name: "disable-component-update" },
  ];
  if (hardwareGpu) return switches;
  return [
    // Программный рендер. 1050 Ti — младшая карта, на которой Chromium
    // проигрывает собственному программному растеризатору, а каждое
    // переключение контекста на слабой машине стоит дороже отрисовки окна.
    { name: "disable-gpu" },
    { name: "disable-gpu-compositing" },
    // Минус один процесс: при программном рендере GPU-процесс только
    // перекладывает кадры и стоит 20–40 МБ RAM.
    { name: "in-process-gpu" },
    ...switches,
  ];
}

/**
 * Применяет список к Chromium. Вызывается строго до `whenReady()`: после
 * готовности командная строка читается один раз и позже не меняется.
 *
 * Возвращает применённые имена переключателей — их пишет журнал запуска,
 * чтобы по жалобе «тормозит» можно было сразу увидеть, что включено.
 */
export function applyWeakMachineSwitches(input: {
  readonly app: Pick<ElectronMainApp, "disableHardwareAcceleration" | "commandLine">;
  readonly env: NodeJS.ProcessEnv;
}): string[] {
  const switches = collectWeakMachineSwitches(input.env);
  if (switches.some(entry => entry.name === "disable-gpu")) input.app.disableHardwareAcceleration();
  for (const entry of switches) {
    if (entry.value === undefined) input.app.commandLine.appendSwitch(entry.name);
    else input.app.commandLine.appendSwitch(entry.name, entry.value);
  }
  return switches.map(entry => entry.name);
}

export function startElectronMain(deps: ElectronMainDependencies): ElectronMainRuntime {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  configureDesktopEnvironment({
    env,
    isPackaged: deps.app.isPackaged,
    isAttachProdBox: deps.isAttachProdBox ?? false,
    isLabBuild: deps.isLabBuild ?? false,
    ...(deps.appVersion == null ? {} : { appVersion: deps.appVersion }),
  });
  deps.startup.bootstrapBeforeSingleInstance();

  // `no-sandbox` не часть списка мер: он снимает песочницу вспомогательных
  // процессов, и без неё Electron не стартует на Windows 10 без второй
  // учётной записи. Остальные переключатели считаются функцией, чтобы их
  // можно было проверить тестом и отключить переменной окружения.
  deps.app.commandLine.appendSwitch("no-sandbox");
  applyWeakMachineSwitches({ app: deps.app, env });

  const isPrimaryInstance = !deps.app.isPackaged || deps.app.requestSingleInstanceLock();
  if (!isPrimaryInstance) deps.app.quit();
  deps.startup.bootstrapAfterSingleInstance(isPrimaryInstance);

  let mainWindow: MainBrowserWindow | undefined;
  let mainWindowCreation: Promise<void> | undefined;
  let isMainWindowCreationReady = false;
  let appIsQuitting = false;
  let services: ElectronMainServices | undefined;
  let overlaySession: ReturnType<typeof createWindowsTitleBarOverlaySession> | undefined;

  const syncWindowFocused = createWindowFocusSync({
    getMainWindow: () => mainWindow,
    setWindowFocused: deps.syncWindowFocused,
    reportFailure: (error) => reportDesktopEdgeFailure("window-focus", "push", error),
  });

  const devToolsGate = createDevToolsGate({ isDevBuild: !deps.app.isPackaged });
  const hostChords = createHostWindowChords({
    getMainWindow: () => mainWindow,
    emitZoomFactorChanged: (factor) => services?.mainEdge.emit("zoom-factor-changed", { factor }),
    quitApp: () => deps.app.quit(),
    canUseDevTools: () => devToolsGate.isAllowed(),
    shouldCloseOpenDevTools: () => devToolsGate.shouldCloseOpenDevTools(),
    platform,
  });
  devToolsGate.subscribe(() => hostChords.enforceDevToolsGate());

  const focusMainWindow = (): void => {
    const window = mainWindow;
    if (window != null && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      return;
    }
    if (deps.app.isReady() && isMainWindowCreationReady) ensureMainWindow();
  };

  const createWindow = async (): Promise<void> => {
    if (services == null) throw new Error("Electron main services were not initialized");
    services.configureVncTrust?.();
    const placement = deps.windowStatePersistence.resolveSandWindowPlacement();
    const backgroundColor = services.getThemeBackgroundColor();
    const chrome = windowChromeOptions({
      isMac: platform === "darwin",
      isWindows: platform === "win32",
      backgroundColor,
    });
    const icon = deps.app.isPackaged ? undefined : deps.devAppIcon;
    const window = deps.createBrowserWindow({
      ...placement.windowOptions,
      title: deps.appName,
      ...(icon == null ? {} : { icon }),
      backgroundColor,
      ...chrome,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: deps.preloadPath,
        sandbox: false,
        webviewTag: true,
        spellcheck: false,
      },
    });
    services.hardenVncWebviewAttach?.(window.webContents);
    mainWindow = window;
    overlaySession = createWindowsTitleBarOverlaySession({
      isWindows: platform === "win32",
      getWindow: () => mainWindow,
      getThemeBackgroundColor: services.getThemeBackgroundColor,
    });
    attachWindowStateBroadcast(window, (state: WindowState) => {
      services?.mainEdge.emit("window-state", state);
    });
    deps.windowStatePersistence.applySandWindowPlacement(window, placement);
    attachWindowFocusForwarding(window, syncWindowFocused);
    services.onWindowCreated?.(window);
    hostChords.attachChordForwarding(window.webContents);
    window.webContents.setWindowOpenHandler(({ url }) => {
      void services?.openExternalUrl(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (isSameDocumentNavigation(url, window.webContents.getURL())) return;
      event.preventDefault();
      void services?.openExternalUrl(url);
    });
    window.webContents.on("will-frame-navigate", (details) => {
      if (details.isMainFrame) return;
      if (isSameDocumentNavigation(details.url, window.webContents.getURL())) return;
      details.preventDefault();
    });
    window.webContents.on("did-start-loading", () => deps.deepLinks.markNotReady());
    window.on("closed", () => deps.deepLinks.markNotReady());
    if (env.VITE_DEV_SERVER_URL != null) await window.loadURL(env.VITE_DEV_SERVER_URL);
    else await window.loadFile(deps.rendererHtmlPath);
  };

  const ensureMainWindow = (): void => {
    if (mainWindow != null && !mainWindow.isDestroyed()) return;
    if (mainWindowCreation != null || !isMainWindowCreationReady) return;
    mainWindowCreation = createWindow().finally(() => {
      mainWindowCreation = undefined;
    });
  };

  deps.app.on("second-instance", (_event, argv) => {
    const candidates = deps.deepLinks.extractCandidatesFromArgv(argv);
    if (candidates.length === 0) {
      const window = mainWindow;
      if (window == null || window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.focus();
      return;
    }
    for (const candidate of candidates) deps.deepLinks.handleCandidate(candidate, "second-instance");
  });
  deps.app.on("open-url", (event, url) => {
    event.preventDefault();
    if (!isPrimaryInstance) return;
    deps.deepLinks.handleCandidate(url, "open-url");
  });
  if (isPrimaryInstance) deps.deepLinks.handleArgv(process.argv, "initial-argv");
  deps.initializeFoundation();

  void deps.app
    .whenReady()
    .then(async () => {
      if (!isPrimaryInstance) {
        deps.startup.cancel();
        return;
      }
      deps.startup.markPhase("move_check");
      const moveDisposition = await deps.startup.runMoveCheck({
        hasPendingActivation: deps.deepLinks.hasPendingActivation,
      });
      if (moveDisposition === "stop-bootstrap") return;
      deps.startup.armStuckWatchdog();
      deps.startup.markPhase("services");
      // Проверка обновлений идёт по сети и не должна задерживать окно,
      // поэтому она запускается параллельно сбору сервисов, а не после него.
      void startAutomaticUpdates({
        app: deps.app,
        env,
        platform,
        ...(deps.appVersion == null ? {} : { appVersion: deps.appVersion }),
      });
      services = await deps.initializeServices({ routeHostInput: hostChords.routeHostInput });

      const membership = createDevToolsMembershipResolver({
        getStatus: services.getDevToolsMembershipStatus,
        setMembership: devToolsGate.setMembership,
        onError: (error) => reportDesktopEdgeFailure("cursor-auth", "anysphere-membership", error),
      });
      services.subscribeDevToolsMembership(() => void membership.refresh());
      void membership.refresh();

      const installMenu = (): void =>
        installApplicationMenu(
          {
            applyWindowShortcut: hostChords.applyWindowShortcut,
            canUseDevTools: devToolsGate.isAllowed,
            emitOpenAbout: () => services?.mainEdge.emit("open-about", {}),
            emitOpenFeedback: () => services?.mainEdge.emit("open-feedback", {}),
            platform,
          },
          deps.menu,
        );
      installMenu();
      services.registerImageContextMenu?.();
      devToolsGate.subscribe(installMenu);

      deps.startup.markPhase("window");
      isMainWindowCreationReady = true;
      await createWindow();
      deps.startup.noteReady();
      deps.app.on("activate", () => {
        if (deps.getAllWindows().length === 0) ensureMainWindow();
      });
    })
    .catch((error: unknown) => deps.startup.noteFailed(error));

  deps.app.on("window-all-closed", () => {
    if (platform !== "darwin") deps.app.quit();
  });
  deps.app.on("before-quit", (event) => {
    appIsQuitting = true;
    deps.startup.cancel();
    if (deps.beginBeforeQuit?.() === "prevent") {
      event.preventDefault();
      return;
    }
    void services?.dispose?.();
    mainWindow = undefined;
  });

  return {
    isPrimaryInstance,
    isQuitting: () => appIsQuitting,
    getMainWindow: () => mainWindow,
    ensureMainWindow,
    setTitleBarOverlayTone: (isOverlayTone) => overlaySession?.setOverlayTone(isOverlayTone),
    syncWindowsTitleBarOverlay: () => overlaySession?.syncFromTheme(),
  };
}

export function startElectronMainProduction(bindings: ElectronMainProductionBindings): ElectronMainRuntime {
  const composition = createElectronMainProductionComposition(bindings);
  const runtime = startElectronMain(composition.dependencies);
  composition.bindRuntime(runtime);
  return runtime;
}
