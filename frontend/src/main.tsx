import { ProductionRenderer } from "./production/ProductionRenderer";
import { acquireProductionRendererRuntime, mountProductionRenderer, requireProductionRendererMount } from "./production/bootstrap";
import { PRODUCTION_RENDERER_GAPS } from "./production/evidence";
import { RootShellErrorBoundary } from "./recovered/features/window-chrome/root-shell-state";

const mount = requireProductionRendererMount(document.getElementById("root"));
const runtime = acquireProductionRendererRuntime(window);
mountProductionRenderer(mount, <RootShellErrorBoundary><ProductionRenderer {...runtime} /></RootShellErrorBoundary>);

// Отчёт о состоянии принимает только сервер разработки
// (`frontend/vite.config.ts`): в упакованном приложении маршрута
// `/__reconstructed_health` нет, и запрос каждый раз падал с
// ERR_FILE_NOT_FOUND. В production-сборке запрос не выполняется вовсе.
const reportHealth = async () => {
  const health = {
    ready: mount.childElementCount > 0,
    title: document.title,
    url: location.href,
    preload: typeof window.desktop === "object" && typeof window.coordinatorPort === "object",
    sourceComposed: true,
    upstreamEntry: false,
    cleanEntrypoint: "frontend/src/main.tsx",
    recoveredEntrypoints: 5,
    viteClient: import.meta.hot != null,
    surfaces: ["shell", "account", "sign-in", "conversation", "transcript", "composer", "sidebar", "agents", "settings", "plugins", "updates", "deep-links", "desktop-bridge"],
    evidenceGaps: Object.keys(PRODUCTION_RENDERER_GAPS)
  };
  if (import.meta.env.DEV !== true) return;
  try {
    await fetch("/__reconstructed_health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(health)
    });
  } catch {
    // Сервер разработки может быть выключен — это не поломка приложения.
  }
};
window.requestAnimationFrame(() => void reportHealth());

if (import.meta.hot) {
  import.meta.hot.accept();
}
