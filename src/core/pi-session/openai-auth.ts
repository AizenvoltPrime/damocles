import { PI_AGENT_DIR } from './agent-dir';
import { logAuthReadFailure, readAuthFile } from './auth-file';

/** pi's API-key OpenAI provider (full GPT-5.x catalog, billed to the API account). */
export const OPENAI_API_PROVIDER = 'openai';
/** pi's ChatGPT-OAuth OpenAI provider (Codex subscription, a 4-model subset). */
export const OPENAI_CODEX_PROVIDER = 'openai-codex';

/**
 * The login-method id pi's codex OAuth provider expects from `onSelect` to run the browser /
 * local-callback PKCE flow (vs. `"device_code"`). Hardcoded so the CJS bundle avoids a value-import
 * from the ESM pi-ai package.
 */
export const OPENAI_CODEX_BROWSER_LOGIN = 'browser';

/** Workspace-state key: prefer the OpenAI API key over Codex OAuth when both are configured. */
export const OPENAI_PREFER_API_KEY_STATE = 'damocles.openai.preferApiKey';

/**
 * OpenAI auth state. The two providers are independent: a user may have an API key, a Codex OAuth
 * grant, both, or neither. The settings panel decides which to use via the prefer-api-key flag.
 */
export interface OpenAIAuthStatus {
  apiKey: boolean;
  codex: boolean;
  codexExpires?: number;
}

/**
 * Derive OpenAI auth state straight from disk without loading pi, so the settings panel can render
 * on open. Mirrors `readClaudeAuthFromDisk` but for the `openai` (API key) and `openai-codex`
 * (ChatGPT OAuth) providers.
 */
export function readOpenAIAuthFromDisk(agentDir: string = PI_AGENT_DIR): OpenAIAuthStatus {
  let auth: Record<string, unknown> | undefined;
  try {
    auth = readAuthFile(agentDir);
  } catch (err) {
    logAuthReadFailure('openai-auth', err, 'showing OpenAI as signed out');
  }
  const apiCred = auth?.[OPENAI_API_PROVIDER] as { type?: unknown } | undefined;
  const codexCred = auth?.[OPENAI_CODEX_PROVIDER] as { type?: unknown; expires?: unknown } | undefined;
  const codex = codexCred?.type === 'oauth';
  return {
    apiKey: apiCred?.type === 'api_key',
    codex,
    ...(codex && typeof codexCred?.expires === 'number' ? { codexExpires: codexCred.expires } : {}),
  };
}
