import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CheckCircle2,
  FolderOpen,
  FolderPlus,
  Loader2,
  Sparkles,
} from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { t } from "../i18n";
import { useAppStore } from "../stores/appStore";
import { useProjects } from "../hooks/useProjects";
import type { ProjectCard as ProjectCardData } from "../services/tauri";
import ErrorCard from "../components/ErrorCard";
import ProjectCard, { projectChatUrl } from "../components/ProjectCard";

/**
 * Экран «Мои проекты»: онбординг при первом запуске (settings.projectsDir пуст),
 * сетка карточек, пустое состояние, загрузка и карточки ошибок.
 *
 * CONTRACT (StoresHooks): useProjects() → {projects, projectsRoot, loading,
 * scanState, error(UiError|null), refresh, selectFolder, pickAndSelect,
 * openProject, dismissError}; selectFolder/pickAndSelect сами персистят
 * settings.projectsDir и сканируют; ошибки классифицирует classifyFolderError.
 * appStore: s.loadSettings() — гидратация из localStorage/settings.json;
 * s.onboardingDone + s.setOnboardingDone — онбординг показываем один раз.
 * CONTRACT (RustBackend): pickFolder() внутри хука — tauri-plugin-dialog.
 * CONTRACT (роутинг): /chat/:projectPath, параметр = encodeURIComponent(path).
 */

/** Браузерный dev-режим (vite без Tauri): диалог и invoke недоступны → мок. */
const DEV_ROOT = "C:\\Мои проекты";
const NOW_SEC = Math.floor(Date.now() / 1000);
const MOCK_PROJECTS: ProjectCardData[] = [
  {
    path: `${DEV_ROOT}\\Сайт для мамы`,
    name: "Сайт для мамы",
    status: "clean",
    last_activity: NOW_SEC - 2 * 3600,
    file_count: 38,
    is_git_repo: true,
  },
  {
    path: `${DEV_ROOT}\\Открытки внукам`,
    name: "Открытки внукам",
    status: "dirty",
    last_activity: NOW_SEC - 26 * 3600,
    file_count: 12,
    is_git_repo: true,
  },
  {
    path: `${DEV_ROOT}\\Старый блог`,
    name: "Старый блог",
    status: "stale",
    last_activity: NOW_SEC - 20 * 86400,
    file_count: 214,
    is_git_repo: false,
  },
  {
    path: `${DEV_ROOT}\\Пробный`,
    name: "Пробный",
    status: "crashed",
    last_activity: NOW_SEC - 4 * 86400,
    file_count: 3,
    is_git_repo: false,
  },
];

export default function ProjectsScreen() {
  const navigate = useNavigate();
  const loadSettings = useAppStore((s) => s.loadSettings);
  const setOnboardingDone = useAppStore((s) => s.setOnboardingDone);
  const setProjects = useAppStore((s) => s.setProjects);
  const setProjectsRoot = useAppStore((s) => s.setProjectsRoot);
  const setProjectsScan = useAppStore((s) => s.setProjectsScan);

  const {
    projects,
    projectsRoot,
    scanState,
    error,
    refresh,
    pickAndSelect,
    openProject,
    dismissError,
  } = useProjects();

  /** Настройки ещё не загружены — не показываем ни онбординг, ни скан. */
  const [hydrated, setHydrated] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3 | null>(null);
  const [pickedEmpty, setPickedEmpty] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Гидратация настроек (папка проектов живёт в settings.json/localStorage).
  useEffect(() => {
    let alive = true;
    void loadSettings().finally(() => {
      if (alive) setHydrated(true);
    });
    return () => {
      alive = false;
    };
  }, [loadSettings]);

  // Без папки → онбординг (шаг 1). Папка есть, но не сканировали → скан.
  // В dev-браузере invoke недоступен → подставляем мок-карточки.
  useEffect(() => {
    if (!hydrated) return;
    if (!projectsRoot) {
      setStep(1);
      return;
    }
    if (scanState === "idle") {
      if (isTauri()) {
        void refresh();
      } else {
        setProjects(MOCK_PROJECTS);
        setProjectsScan("done");
      }
    }
  }, [
    hydrated,
    projectsRoot,
    scanState,
    refresh,
    setProjects,
    setProjectsScan,
  ]);

  // Шаг 2: папка выбрана, скан завершён.
  // Пусто → подсказка «проектов пока нет» + «Дальше»; есть проекты → авто-шаг 3.
  useEffect(() => {
    if (step === 2 && projectsRoot && scanState === "done") {
      if (projects.length > 0) setStep(3);
      else setPickedEmpty(true);
    }
  }, [step, projectsRoot, scanState, projects.length]);

  /** «Выбрать папку»: нативный диалог (Tauri) или мок-корень (браузер). */
  const pick = useCallback(async () => {
    setPickedEmpty(false);
    if (!isTauri()) {
      setProjectsRoot(DEV_ROOT);
      setProjects(MOCK_PROJECTS);
      setProjectsScan("done");
      return;
    }
    await pickAndSelect(); // диалог → persist projectsDir → refresh; ошибки → error
  }, [pickAndSelect, setProjectsRoot, setProjects, setProjectsScan]);

  const pickFromConfirm = useCallback(async () => {
    setConfirming(false);
    await pick();
  }, [pick]);

  const onOpen = useCallback(
    (path: string) => {
      openProject(path);
      navigate(projectChatUrl(path));
    },
    [openProject, navigate],
  );

  /** Главная кнопка карточки ошибки: action из UiError (stateFns). */
  const onErrorAction = useCallback(
    (action: "retry" | "open-settings" | "pick-folder") => {
      if (action === "pick-folder") void pick();
      else if (action === "open-settings") navigate("/settings");
      else if (action === "retry") void refresh();
    },
    [pick, refresh, navigate],
  );

  const finishOnboarding = useCallback(() => {
    setStep(null);
    setOnboardingDone(true);
  }, [setOnboardingDone]);

  // ---------- Онбординг (settings.projectsDir пуст) ----------
  if (step !== null) {
    return (
      <section className="screen">
        <div className="empty-state onboarding">
          {step === 1 && (
            <>
              <Sparkles size={48} strokeWidth={1.5} />
              <p className="empty-state-title">{t("welcomeTitle")}</p>
              <p className="empty-state-hint">{t("welcomeBody")}</p>
              <p className="onboarding-hint">{t("welcomeHint")}</p>
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => setStep(2)}
              >
                {t("welcomeStart")}
              </button>
            </>
          )}
          {step === 2 && (
            <>
              <FolderOpen size={48} strokeWidth={1.5} />
              <p className="empty-state-title">{t("folderStepTitle")}</p>
              <p className="empty-state-hint">{t("folderStepBody")}</p>
              <p className="onboarding-hint">
                {pickedEmpty ? t("folderStepEmpty") : t("folderStepHint")}
              </p>
              {scanState === "scanning" && (
                <p className="onboarding-hint">
                  <Loader2 className="spin" size={16} aria-hidden />{" "}
                  {t("loading")}
                </p>
              )}
              {scanState === "error" && error && (
                <ErrorCard
                  error={error}
                  onAction={onErrorAction}
                  onDismiss={dismissError}
                />
              )}
              {pickedEmpty ? (
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => setStep(3)}
                >
                  {t("nextStep")}
                </button>
              ) : (
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={scanState === "scanning"}
                  onClick={() => void pick()}
                >
                  {t("pickFolder")}
                </button>
              )}
            </>
          )}
          {step === 3 && (
            <>
              <CheckCircle2 size={48} strokeWidth={1.5} />
              <p className="empty-state-title">{t("readyTitle")}</p>
              <p className="empty-state-hint">{t("readyBody")}</p>
              <button
                className="btn btn-primary"
                type="button"
                onClick={finishOnboarding}
              >
                {t("readyStart")}
              </button>
            </>
          )}
          <p className="onboarding-steps">{t("stepOf", { n: step })}</p>
        </div>
      </section>
    );
  }

  // ---------- Экран списка ----------
  return (
    <section className="screen">
      <h1 className="screen-title">{t("navProjects")}</h1>
      <div className="screen-subtitle">
        <span className="projects-dir" title={projectsRoot ?? undefined}>
          {t("projectsFolder", { path: projectsRoot ?? "" })}
        </span>
        <button
          className="btn btn-secondary btn-small"
          type="button"
          onClick={() => setConfirming(true)}
        >
          {t("changeFolder")}
        </button>
      </div>

      {(!hydrated || scanState === "scanning") && (
        <div className="empty-state">
          <Loader2 className="spin" size={40} strokeWidth={1.5} />
          <p className="empty-state-hint">{t("loading")}</p>
        </div>
      )}

      {scanState === "error" && error && (
        <ErrorCard
          error={error}
          onAction={onErrorAction}
          onDismiss={dismissError}
        />
      )}

      {hydrated && scanState === "done" && projects.length === 0 && (
        <div className="empty-state">
          <FolderPlus size={48} strokeWidth={1.5} />
          <p className="empty-state-title">{t("projectsEmptyTitle")}</p>
          <p className="empty-state-hint">{t("projectsEmptyBody")}</p>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => setConfirming(true)}
          >
            {t("pickOtherFolder")}
          </button>
        </div>
      )}

      {scanState === "done" && projects.length > 0 && (
        <div className="projects-grid">
          {projects.map((p) => (
            <ProjectCard key={p.path} project={p} onOpen={onOpen} />
          ))}
        </div>
      )}

      {confirming && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal">
            <p className="modal-title--block">{t("changeFolderTitle")}</p>
            <p className="modal-body">{t("changeFolderBody")}</p>
            <div className="modal-actions">
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => void pickFromConfirm()}
              >
                {t("changeFolderYes")}
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => setConfirming(false)}
              >
                {t("keep")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
