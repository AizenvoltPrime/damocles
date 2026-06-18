import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import type { HistoryAgentMessage } from "../../shared/types/content";

export type ExploreProvider = "openrouter" | "gemini" | "stepfun";

/**
 * Providers that route through their own per-call upstream proxy (api key stored in SecretStorage).
 * Every Explore provider is third-party; the alias is kept for the call sites that narrow to it.
 */
export type ExploreThirdPartyProvider = "openrouter" | "gemini" | "stepfun";

export const EXPLORE_PROVIDERS: readonly ExploreProvider[] = ["openrouter", "gemini", "stepfun"] as const;

export const EXPLORE_THIRD_PARTY_PROVIDERS: readonly ExploreThirdPartyProvider[] = ["openrouter", "gemini", "stepfun"] as const;

export const EXPLORE_SECRET_KEYS: Record<ExploreThirdPartyProvider, string> = {
  openrouter: "damocles.explore.apiKey.openrouter",
  gemini: "damocles.explore.apiKey.gemini",
  stepfun: "damocles.explore.apiKey.stepfun",
};

export const DEFAULT_EXPLORE_MODELS: Record<ExploreThirdPartyProvider, string> = {
  openrouter: "deepseek/deepseek-v4-flash",
  gemini: "gemini-3-flash-preview",
  stepfun: "step-3.7-flash",
};

export interface ExploreSdkEnvOverrides {
  baseUrl: string;
  bearer: string;
}

export interface ExploreRunConfig {
  toolUseId: string;
  prompt: string;
  description: string;
  cwd: string;
  abortSignal: AbortSignal;
  onMessage: (msg: ExtensionToWebviewMessage) => void;
  compassMcpServer?: Record<string, unknown>;
  sessionId: string | null;
  sessionDir: string | null;
  envOverrides: ExploreSdkEnvOverrides;
}

export interface ExploreResult {
  summary: string;
  toolCount: number;
  elapsed: number;
  status: "completed" | "failed";
  messages: HistoryAgentMessage[];
}

export interface ExploreMetadata {
  model: string;
  description: string;
  status: "completed" | "failed";
  startTime: number;
  endTime: number;
  toolCount: number;
  prompt: string;
}

export type ExploreMetadataFile = Record<string, ExploreMetadata>;
