import { join } from "node:path";

import { resolveComputerUseModelSelection, type SandAgentModelSelection } from "../../../shared/agents/sand-agent-model.js";
import type { SandModelExperimentState } from "../../../shared/node/experiments/sand-model-experiment.js";
import { SandSettingsStore } from "../../../shared/node/settings/sand-settings-store.js";
import { createCursorSandInference } from "./cursor-session.js";
import type { SandInferenceProvider } from "../../../shared/inference-router.js";
import { createProviderPromptSession } from "./provider-session.js";
import { getSandRootDir } from "../../host-paths.js";
export interface HostInferenceOptions {
  auth: { getAccessToken(...args: unknown[]): Promise<string>; getMachineId(): string };
  experiments: { checkFeatureGate(name: string): boolean; getComputerUseModelOverride(): SandAgentModelSelection | undefined; getBrowserUseModelOverride(): SandAgentModelSelection | undefined; getSandModelExperimentState(): SandModelExperimentState | null | undefined; hasHydratedStatsigUserId(): boolean; getConfiguredDefaultModel(): SandAgentModelSelection | undefined; getConfiguredAutomationsModel(): SandAgentModelSelection | undefined };
  settings: { getAgentDefaultModel(): SandAgentModelSelection | undefined; getComputerUseModel(): SandAgentModelSelection | undefined; getInferenceProvider(): SandInferenceProvider; recordInferenceUsage(provider: SandInferenceProvider, usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }): void };
  onModelExperimentApplied(): void;
}
export function createHostInference(options: HostInferenceOptions) {
  const { auth, experiments, settings } = options;
  const routerSettings = new SandSettingsStore(join(getSandRootDir(), "settings.json"));
  const cursor = createCursorSandInference({
    getAccessToken: auth.getAccessToken,
    getMachineId: auth.getMachineId,
    isGeminiVideoDeveloperApiEnabled: () => experiments.checkFeatureGate("gemini_video_developer_api"),
    getDefaultModel: () => settings.getAgentDefaultModel(),
    getComputerUseModel: () => { const storedModel=settings.getComputerUseModel(),overrideModel=experiments.getComputerUseModelOverride();return resolveComputerUseModelSelection({...(storedModel==null?{}:{storedModel}),...(overrideModel==null?{}:{overrideModel})}); },
    getBrowserUseModel: () => experiments.getBrowserUseModelOverride(),
    getModelExperimentState: () => { const state = experiments.getSandModelExperimentState(); if (experiments.hasHydratedStatsigUserId()) options.onModelExperimentApplied(); return state; },
    getConfiguredDefaultModel: () => experiments.getConfiguredDefaultModel(),
    getConfiguredAutomationsModel: () => experiments.getConfiguredAutomationsModel()
  });
  // DeepSeek is the only provider, so both sessions come from the same factory. The usage
  // ledger is written by that factory's own executor, so nothing here records a second time.
  void routerSettings;
  return {
    ...cursor,
    createSession(onRequestId: (requestId: string) => void, sessionOptions?: Parameters<typeof cursor.createSession>[1]) {
      void onRequestId;
      void sessionOptions;
      return createProviderPromptSession() as ReturnType<typeof cursor.createSession>;
    },
    createSummarizationSession(onRequestId: (requestId: string) => void, sessionOptions?: Parameters<NonNullable<typeof cursor.createSummarizationSession>>[1]) {
      void onRequestId;
      void sessionOptions;
      return createProviderPromptSession() as ReturnType<NonNullable<typeof cursor.createSummarizationSession>>;
    },
  };
}