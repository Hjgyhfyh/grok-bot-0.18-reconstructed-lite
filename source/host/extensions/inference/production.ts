import type { HostExtensionContext } from "../../../internal/host-extensions.js";
import type { SandAgentModelSelection } from "../../../shared/agents/sand-agent-model.js";
import { createCursorWebFetchService, createCursorWebSearchService } from "./cursor-web-tools.js";
import { getSandInferenceBackendUrl } from "../../../shared/node/cursor-backend/cursor-inference.js";
import { createHostInference } from "./inference-service.js";
import type { InferenceExtensionContext } from "./extension.js";

type ProductionContext = HostExtensionContext<unknown> & {
  readonly deps: InferenceExtensionContext["deps"];
};

/** Recreates the artifact's concrete inference construction at host-main.cjs:617672-617732. */
export function createInferenceProductionExtras(
  context: ProductionContext,
): Omit<InferenceExtensionContext, "deps"> {
  const auth = context.deps.auth;
  return {
    createPort(onModelExperimentApplied) {
      return createHostInference({
        auth,
        experiments: context.deps.experiments,
        settings: context.deps.settings,
        onModelExperimentApplied,
      });
    },
    createWebSearch(args) {
      // Службы Cursor в сборке нет, а клиент строился сразу и бросал исключение
      // при СОЗДАНИИ. Этим исключением умирал `createRunner`, то есть любой ход:
      // команда `sendPrompt` проходила, а ответа не появлялось.
      //
      // `undefined` здесь тоже не годится: инструмент веб-поиска объявлен по
      // НАЛИЧИЮ этой функции, и без службы он падал уже во время хода с
      // «web search service is not bound». Поэтому возвращаем отказ: инструмент
      // есть, но говорит по-русски, что поиска в вебе нет.
      if (getSandInferenceBackendUrl().length === 0) return async () => { throw new Error(SAND_WEB_SEARCH_UNAVAILABLE_MESSAGE); };
      const request = args as { modelId: string; onRequestId?: (requestId: string) => void };
      return createCursorWebSearchService({
        getAccessToken: auth.getAccessToken,
        getMachineId: auth.getMachineId,
        modelId: request.modelId,
        ...(request.onRequestId == null ? {} : { onRequestId: request.onRequestId }),
      });
    },
    createWebFetch(args) {
      if (getSandInferenceBackendUrl().length === 0) return async () => { throw new Error(SAND_WEB_FETCH_UNAVAILABLE_MESSAGE); };
      const request = args as { onRequestId?: (requestId: string) => void };
      return createCursorWebFetchService({
        getAccessToken: auth.getAccessToken,
        getMachineId: auth.getMachineId,
        ...(request.onRequestId == null ? {} : { onRequestId: request.onRequestId }),
      });
    },
  };
}

export type InferenceModelSelection = SandAgentModelSelection;

/**
 * Что отвечает пользователю, когда он или помощник просят то, чего в сборке нет.
 * По-русски и без упоминания внутренних переменных: человек не должен
 * переписывать команды ради поиска в вебе.
 */
export const SAND_WEB_SEARCH_UNAVAILABLE_MESSAGE =
  "Поиск в интернете в этой сборке не работает. Помощник всё равно ответит по тому, что уже знает.";
export const SAND_WEB_FETCH_UNAVAILABLE_MESSAGE =
  "Открыть страницу из интернета в этой сборке нельзя. Помощник всё равно ответит по тому, что уже знает.";
