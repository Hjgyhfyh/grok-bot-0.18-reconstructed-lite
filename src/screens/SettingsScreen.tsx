import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Eye, EyeOff } from "lucide-react";
import {
  DEFAULT_SETTINGS,
  maskKey,
  normalizeSettings,
  sanitizeUrl,
  validateField,
  validateSettings,
  type Settings,
  type SettingsErrorCode,
  type SettingsField,
} from "../core/settings";
import { AI_API_KEY, AI_BASE_URL, AI_MODEL } from "../config";
import { t, type RuKey } from "../i18n";
import { useAppStore } from "../stores/appStore";
import { checkConnection, errorCardFor } from "../services/ai";
import type { ConnectionResult } from "../services/ai";

/* appStore.settings — читаем/пишем через s.loadSettings()/s.saveSettings();
 * saveSettings сам синкнет мирроры theme/projectsRoot и персистит
 * (localStorage + settings.json в app_config_dir). */

/* ------------------------------------------------------------------ */
/* CONTRACT: AiClient — services/ai.ts checkConnection(overrides?)      */
/*   → ConnectionResult { ok, latencyMs, models? | error: AiError },    */
/*   никогда не бросает; errorCardFor(error) даёт ключи карточки.       */
/* ------------------------------------------------------------------ */
type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; models: string[]; ms: number }
  | { kind: "fail"; titleKey: RuKey; bodyKey: RuKey; code?: number };

/** Маппинг кода валидации core → ключ словаря. */
const ERROR_KEYS: Record<SettingsErrorCode, RuKey> = {
  empty: "settingsErrRequired",
  "invalid-url": "settingsErrBaseUrl",
  "invalid-theme": "settingsErrRequired",
};

/** Проверка соединения через ai.checkConnection на черновых значениях формы. */
async function runCheck(draft: Settings): Promise<CheckState> {
  let result: ConnectionResult;
  try {
    result = await checkConnection({
      baseUrl: sanitizeUrl(draft.baseUrl),
      apiKey: draft.apiKey,
      model: draft.model,
    });
  } catch (e) {
    // По контракту не бросает; если сломалось — всё равно карточка, не reject.
    const card = errorCardFor(e);
    return { kind: "fail", titleKey: card.titleKey, bodyKey: card.bodyKey, code: card.code };
  }
  if (result.ok) {
    return { kind: "ok", models: result.models, ms: result.latencyMs };
  }
  // Карточка ошибки — ключи из core/ai.errorCardFor (включая мелкий код).
  const card = errorCardFor(result.error);
  return {
    kind: "fail",
    titleKey: card.titleKey,
    bodyKey: card.bodyKey,
    code: card.code,
  };
}

export default function SettingsScreen() {
  const storeSettings = useAppStore((s) => s.settings);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const setTheme = useAppStore((s) => s.setTheme);

  const [draft, setDraft] = useState<Settings>(() =>
    normalizeSettings(
      {},
      {
        ...DEFAULT_SETTINGS,
        apiKey: AI_API_KEY,
        baseUrl: AI_BASE_URL,
        model: AI_MODEL,
      },
    ),
  );
  const [errors, setErrors] = useState<Partial<Record<SettingsField, string>>>({});
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const [modelList, setModelList] = useState<string[]>([]);
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(false);
  const dirtyRef = useRef(false);
  const toastTimer = useRef<number | undefined>(undefined);

  // Подтянуть сохранённые настройки (never throw — мержит с дефолтами).
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // Пока пользователь не трогал форму — драфт следует за стором.
  useEffect(() => {
    if (!dirtyRef.current) setDraft(storeSettings);
  }, [storeSettings]);

  // Тема → data-theme на <html> (тёмная — дефолт, system трактуем как тёмную).
  const dark = draft.theme !== "light";
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const flashSaved = () => {
    setToast(true);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(false), 2200);
  };

  const setField = useCallback(
    <K extends SettingsField>(field: K, value: Settings[K]) => {
      dirtyRef.current = true;
      setDraft((d) => ({ ...d, [field]: value }));
      // Живая очистка/подсветка ошибки под полем.
      setErrors((prev) => {
        if (!prev[field]) return prev;
        const next = { ...prev };
        const err = validateField(field, value);
        if (err) next[field] = t(ERROR_KEYS[err.code]);
        else delete next[field];
        return next;
      });
    },
    [],
  );

  const pickFolder = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        title: t("settingsPickTitle"),
        defaultPath: draft.projectsDir || undefined,
      });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (typeof path === "string" && path !== "") {
        setField("projectsDir", path);
      }
    } catch {
      // Диалог недоступен (dev-браузер без Tauri) — поле остаётся редактируемым.
    }
  }, [draft.projectsDir, setField]);

  const onCheck = useCallback(async () => {
    setCheck({ kind: "checking" });
    const result = await runCheck(draft);
    setCheck(result);
    if (result.kind === "ok" && result.models.length > 0) {
      setModelList(result.models);
    }
  }, [draft]);

  const onSave = useCallback(async () => {
    const normalized: Settings = {
      ...draft,
      baseUrl: sanitizeUrl(draft.baseUrl),
      apiKey: draft.apiKey.trim(),
      model: draft.model.trim(),
      projectsDir: draft.projectsDir.trim(),
    };
    const found = validateSettings(normalized);
    if (found.length > 0) {
      const next: Partial<Record<SettingsField, string>> = {};
      for (const f of found) next[f.field] = t(ERROR_KEYS[f.code]);
      setErrors(next);
      return;
    }
    setErrors({});
    setDraft(normalized);
    dirtyRef.current = false;
    setSaving(true);
    try {
      await saveSettings(normalized);
      flashSaved();
    } finally {
      setSaving(false);
    }
  }, [draft, saveSettings]);

  const onThemeToggle = useCallback(
    (checked: boolean) => {
      const theme = checked ? "dark" : "light";
      setDraft((d) => ({ ...d, theme }));
      // Переключатель сохраняется сразу (автосохранение по copy-доку).
      setTheme(theme);
      flashSaved();
    },
    [setTheme],
  );

  const fieldInput = (f: SettingsField) =>
    `field-input${errors[f] ? " field-input--invalid" : ""}`;

  return (
    <section className="screen">
      <h1 className="screen-title">{t("navSettings")}</h1>

      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave();
        }}
        noValidate
      >
        {/* Папка проектов */}
        <label className="field">
          <span className="field-label">{t("settingsProjectsDir")}</span>
          <span className="field-row">
            <input
              className={fieldInput("projectsDir")}
              type="text"
              value={draft.projectsDir}
              onChange={(e) => setField("projectsDir", e.target.value)}
              aria-invalid={Boolean(errors.projectsDir)}
            />
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => void pickFolder()}
            >
              {t("settingsPick")}
            </button>
          </span>
          {errors.projectsDir && (
            <p className="field-error">{errors.projectsDir}</p>
          )}
        </label>

        {/* Ключ модели */}
        <label className="field">
          <span className="field-label">{t("settingsApiKey")}</span>
          <span className="field-password">
            <input
              className={fieldInput("apiKey")}
              type={showKey ? "text" : "password"}
              value={draft.apiKey}
              placeholder={maskKey(storeSettings.apiKey)}
              onChange={(e) => setField("apiKey", e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={Boolean(errors.apiKey)}
            />
            <button
              className="field-eye"
              type="button"
              title={t("settingsShowKey")}
              aria-label={t("settingsShowKey")}
              onClick={() => setShowKey((v) => !v)}
            >
              {showKey ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </span>
          <p className="field-hint">{t("settingsApiKeyHint")}</p>
          {errors.apiKey && <p className="field-error">{errors.apiKey}</p>}
        </label>

        {/* Адрес сервера */}
        <label className="field">
          <span className="field-label">{t("settingsBaseUrl")}</span>
          <input
            className={fieldInput("baseUrl")}
            type="text"
            value={draft.baseUrl}
            onChange={(e) => setField("baseUrl", e.target.value)}
            spellCheck={false}
            aria-invalid={Boolean(errors.baseUrl)}
          />
          <p className="field-hint">{t("settingsBaseUrlHint")}</p>
          {errors.baseUrl && <p className="field-error">{errors.baseUrl}</p>}
        </label>

        {/* Модель: живой список после «Проверить соединение» + свободный ввод */}
        <label className="field">
          <span className="field-label">{t("settingsModel")}</span>
          <input
            className={fieldInput("model")}
            type="text"
            list="settings-models"
            value={draft.model}
            onChange={(e) => setField("model", e.target.value)}
            spellCheck={false}
            aria-invalid={Boolean(errors.model)}
          />
          <datalist id="settings-models">
            {modelList.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <p className="field-hint">{t("settingsModelHint")}</p>
          {errors.model && <p className="field-error">{errors.model}</p>}
        </label>

        {/* Тёмная тема */}
        <label className="switch">
          <input
            type="checkbox"
            checked={dark}
            onChange={(e) => onThemeToggle(e.target.checked)}
          />
          <span className="switch-slider" />
          <span>{t("settingsDarkTheme")}</span>
        </label>

        {/* Действия */}
        <div className="settings-actions">
          <button
            className="btn btn-secondary"
            type="button"
            disabled={check.kind === "checking"}
            onClick={() => void onCheck()}
          >
            {t("settingsCheck")}
          </button>
          <button className="btn btn-primary" type="submit" disabled={saving}>
            {t("settingsSave")}
          </button>
        </div>

        {check.kind === "ok" && (
          <p className="notice notice--ok" role="status">
            {t("checkOkDetail", { n: check.models.length, ms: check.ms })}
          </p>
        )}
        {check.kind === "fail" && (
          <div className="error-card" role="alert">
            <p className="error-card-title">{t(check.titleKey)}</p>
            <p className="error-card-body">{t(check.bodyKey)}</p>
            {check.code !== undefined && (
              <p className="error-card-code">{check.code}</p>
            )}
            <div className="error-card-actions">
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => void onCheck()}
              >
                {t("retry")}
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => setCheck({ kind: "idle" })}
              >
                {t("dismiss")}
              </button>
            </div>
          </div>
        )}
      </form>

      {toast && (
        <div className="toast-stack" aria-live="polite">
          <div className="toast">{t("savedToast")}</div>
        </div>
      )}
    </section>
  );
}
