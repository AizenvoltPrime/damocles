import * as vscode from "vscode";
import { OPENAI_BRIDGE_SECRET_KEYS, type OpenAIBridgeAuthMode } from "./types";
import { getCodexAuthSnapshot, getValidAccessToken } from "./codex-oauth";

/** Workspace-state key for the precedence override toggle. */
export const OPENAI_PREFER_API_KEY_STATE = "damocles.openai.preferApiKey";

/** Unified resolution returned to upstream consumers (proxy, env injection). */
export interface AuthResolution {
  mode: OpenAIBridgeAuthMode;
  token: string;
  accountId?: string;
  expiresAt?: number;
}

export interface ResolveAuthOptions {
  forceRefresh?: boolean;
  onCodexExpired?: () => void;
}

/**
 * Resolves credentials for a single auth path. Returns `null` when the requested
 * path is unconfigured so callers can fall through to the alternate path. Never throws.
 */
export async function resolveAuth(
  mode: OpenAIBridgeAuthMode,
  context: vscode.ExtensionContext,
  options: ResolveAuthOptions = {}
): Promise<AuthResolution | null> {
  switch (mode) {
    case "apikey": {
      const key = await context.secrets.get(OPENAI_BRIDGE_SECRET_KEYS.apikey);
      if (!key) return null;
      return { mode: "apikey", token: key };
    }
    case "codex": {
      const blob = await getValidAccessToken({
        context,
        forceRefresh: options.forceRefresh === true,
        onExpired: () => options.onCodexExpired?.(),
      });
      if (!blob) return null;
      return {
        mode: "codex",
        token: blob.access_token,
        ...(blob.chatgpt_account_id ? { accountId: blob.chatgpt_account_id } : {}),
        expiresAt: blob.expires_at,
      };
    }
  }
}

/**
 * Resolves the preferred auth path, falling back to the alternate when the preferred
 * path is unavailable. Codex wins by default; the `preferApiKey` workspace toggle
 * inverts the order.
 */
export async function resolvePreferredAuth(
  context: vscode.ExtensionContext,
  workspaceState: vscode.Memento,
  options: ResolveAuthOptions = {}
): Promise<AuthResolution | null> {
  const preferApiKey = workspaceState.get<boolean>(OPENAI_PREFER_API_KEY_STATE, false);
  const order: OpenAIBridgeAuthMode[] = preferApiKey ? ["apikey", "codex"] : ["codex", "apikey"];

  for (const mode of order) {
    const resolution = await resolveAuth(mode, context, options);
    if (resolution) return resolution;
  }
  return null;
}

/** Snapshot used by the settings UI to render auth indicators. Never includes secrets. */
export interface OpenAIAuthStatusSnapshot {
  codex: {
    signedIn: boolean;
    accountId?: string;
    expiresAt?: number;
  };
  apikey: {
    configured: boolean;
  };
}

/** Builds the auth-status snapshot for the webview. */
export async function getOpenAIAuthStatus(
  context: vscode.ExtensionContext
): Promise<OpenAIAuthStatusSnapshot> {
  const [apiKey, codex] = await Promise.all([
    context.secrets.get(OPENAI_BRIDGE_SECRET_KEYS.apikey),
    getCodexAuthSnapshot(context),
  ]);
  return {
    codex,
    apikey: { configured: Boolean(apiKey) },
  };
}
