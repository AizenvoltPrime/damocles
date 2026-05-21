import type { ModelInfo } from '../../shared/types/settings';

/** Auth path the bridge uses when forwarding upstream. */
export type OpenAIBridgeAuthMode = "codex" | "apikey";

/** Per-bearer routing entry. The proxy resolves auth and model per request from this. */
export interface BridgeRouteEntry {
  backend: OpenAIBridgeAuthMode;
  panelId: string;
  bearer: string;
  /** Latest model the panel has selected; surfaced via /health and used for log context. */
  currentModel: string;
  createdAt: number;
}

/** Secret-storage keys used by US-005 for API-key persistence. Centralized to mirror Explore. */
export const OPENAI_BRIDGE_SECRET_KEYS = {
  apikey: "damocles.openaiBridge.apiKey",
  codexRefreshToken: "damocles.openaiBridge.codex.refreshToken",
  codexAccessToken: "damocles.openaiBridge.codex.accessToken",
} as const;

/** Snapshot returned by ensureRunning(); never includes the bearer over IPC boundaries. */
export interface BridgeEndpoint {
  url: string;
  bearer: string;
}

/** Status payload exposed via GET /health. Stable shape consumed by OpenAIAuthPanel.vue. */
export interface BridgeHealth {
  status: "ok";
  backend: OpenAIBridgeAuthMode | null;
  model: string | null;
  codexAuth: {
    signedIn: boolean;
    accountId?: string;
    expiresAt?: number;
  };
  apikeyAuth: {
    configured: boolean;
  };
  inflightRequests: number;
  uptime: number;
}

/**
 * Subset of `ModelInfo` consumed by the bridge for request shaping. Kept narrow so the proxy
 * never depends on the full settings module — easier to mock in tests.
 */
export type BridgeModelInfo = Pick<
  ModelInfo,
  "value" | "backend" | "openaiModelId" | "openaiAuthMode" | "openaiReasoningEffort"
>;
