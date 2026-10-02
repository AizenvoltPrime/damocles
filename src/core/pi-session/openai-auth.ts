import { PI_AGENT_DIR } from './agent-dir';
import { logAuthReadFailure, readAuthFile } from './auth-file';

/** pi's `openai` provider: the API key (as a runtime key) or a Sign in with ChatGPT grant. */
export const OPENAI_API_PROVIDER = 'openai';
/** pi's legacy Codex OAuth provider, kept until the user signs in with ChatGPT. */
export const OPENAI_CODEX_PROVIDER = 'openai-codex';

/** Workspace-state key: prefer the OpenAI API key over a ChatGPT or Codex sign-in when a key is configured. */
export const OPENAI_PREFER_API_KEY_STATE = 'damocles.openai.preferApiKey';

/** Host secret holding the OpenAI API key; Damocles never writes the key to auth.json. */
export const OPENAI_API_KEY_SECRET = 'damocles.openai.apiKey';

/**
 * OpenAI auth state. `apiKey`: the secret is present, or auth.json `openai` still holds a plain-text api_key,
 * which pi uses. `chatgpt`: auth.json `openai` holds an OAuth grant. `codex`: auth.json `openai-codex` holds
 * an OAuth grant.
 */
export interface OpenAIAuthStatus {
  apiKey: boolean;
  chatgpt: boolean;
  chatgptExpires?: number;
  codex: boolean;
  codexExpires?: number;
}

/** The auth.json part of `OpenAIAuthStatus`. `storedApiKey`: a plain-text `openai` api_key an older version wrote. */
export interface OpenAIDiskAuth {
  chatgpt: boolean;
  chatgptExpires?: number;
  codex: boolean;
  codexExpires?: number;
  storedApiKey: boolean;
}

function oauthState(cred: { type?: unknown; expires?: unknown } | undefined): { signedIn: boolean; expires?: number } {
  const signedIn = cred?.type === 'oauth';
  return signedIn && typeof cred?.expires === 'number' ? { signedIn, expires: cred.expires } : { signedIn };
}

/** The auth.json part of OpenAI auth state, read without loading pi so the settings panel can render on open. */
export function readOpenAIAuthFromDisk(agentDir: string = PI_AGENT_DIR): OpenAIDiskAuth {
  let auth: Record<string, unknown> | undefined;
  try {
    auth = readAuthFile(agentDir);
  } catch (err) {
    logAuthReadFailure('openai-auth', err, 'showing OpenAI as signed out');
  }
  const apiCred = auth?.[OPENAI_API_PROVIDER] as { type?: unknown; expires?: unknown } | undefined;
  const chatgpt = oauthState(apiCred);
  const codex = oauthState(auth?.[OPENAI_CODEX_PROVIDER] as { type?: unknown; expires?: unknown } | undefined);
  return {
    chatgpt: chatgpt.signedIn,
    ...(chatgpt.expires !== undefined ? { chatgptExpires: chatgpt.expires } : {}),
    codex: codex.signedIn,
    ...(codex.expires !== undefined ? { codexExpires: codex.expires } : {}),
    storedApiKey: apiCred?.type === 'api_key',
  };
}

/** Full OpenAI auth state from the disk part and whether the key secret is present. */
export function openaiAuthStatus(disk: OpenAIDiskAuth, secretPresent: boolean): OpenAIAuthStatus {
  return {
    apiKey: secretPresent || disk.storedApiKey,
    chatgpt: disk.chatgpt,
    ...(disk.chatgptExpires !== undefined ? { chatgptExpires: disk.chatgptExpires } : {}),
    codex: disk.codex,
    ...(disk.codexExpires !== undefined ? { codexExpires: disk.codexExpires } : {}),
  };
}

/** Whether the key secret is applied as pi's `openai` runtime key, which overrides a stored ChatGPT grant. */
export function openaiRuntimeKeyWanted(status: Pick<OpenAIAuthStatus, 'apiKey' | 'chatgpt'>, preferApiKey: boolean): boolean {
  return status.apiKey && (preferApiKey || !status.chatgpt);
}
