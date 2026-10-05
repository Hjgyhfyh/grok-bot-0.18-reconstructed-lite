/**
 * The Cursor model catalog is disabled.
 *
 * It used to call `AiService.availableModels` on the Cursor backend (`api2.cursor.sh`) to fill
 * the model picker. DB Bot Lite has no Cursor account and must not reach that host, so the
 * function keeps its name — `main-production-services.ts` still wires it as a dependency — but
 * makes no request and throws instead. The picker is filled by
 * `listSandEndpointModels`, which asks `https://api.deepseek.com/models`.
 */
export const SAND_AVAILABLE_MODELS_SCOPE = "USER_AVAILABLE" as const;

export const SAND_CURSOR_MODEL_CATALOG_DISABLED_MESSAGE =
  "Каталог моделей Cursor отключён. Доступные модели перечисляет DeepSeek: GET https://api.deepseek.com/models.";

export interface SandAvailableModelsClient<Result> { availableModels(request: { readonly useModelParameters: true; readonly scope: typeof SAND_AVAILABLE_MODELS_SCOPE }): Promise<Result> }

export async function fetchSandAvailableModels<Options, Result>(_options: Options, createClient?: (options: Options) => SandAvailableModelsClient<Result>): Promise<Result> {
  void createClient;
  throw new Error(SAND_CURSOR_MODEL_CATALOG_DISABLED_MESSAGE);
}