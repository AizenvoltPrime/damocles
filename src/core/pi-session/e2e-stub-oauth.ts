// The e2e hooks' stub OAuth sign-in (development builds with DAMOCLES_E2E_HOOKS=1 only; core serves it only with
// CoreInit.e2eHooks): ChatGPT's `openai` OAuth on this computer's core signs in and refreshes with no network, each token
// valid for expiresInMs, so a Sign-in needed wait can be driven in seconds. A daemon's core keeps pi's real handler,
// whose toAuth sends the access token as the key.
import type { OAuthCredential } from '@earendil-works/pi-ai';
import { OPENAI_API_PROVIDER } from './openai-auth';
import type { PiRuntime } from './pi-runtime';

// offline: the stub's refresh fails as a refresh without a network does
let installed: { offline: boolean } | undefined;

/**
 * Signs this computer in to a stub ChatGPT account whose tokens name `account` and last expiresInMs, refreshed by the stub;
 * with `offline` set once the stub is signed in, only switches whether its refresh fails.
 */
export async function signInStubOAuth(runtime: PiRuntime, account: string, expiresInMs: number, offline?: boolean): Promise<void> {
  if (installed && offline !== undefined) {
    installed.offline = offline;
    return;
  }
  await runtime.init();
  const oauth = runtime.modelRuntime?.getProvider(OPENAI_API_PROVIDER)?.auth.oauth;
  if (!oauth) throw new Error('pi has no OAuth sign-in for openai');
  const stub = { offline: offline === true };
  installed = stub;
  let issued = 0;
  const issue = async (): Promise<OAuthCredential> => {
    issued++;
    return { type: 'oauth', access: `e2e-oauth-${account}-${issued}`, refresh: `e2e-refresh-${account}-${issued}`, expires: Date.now() + expiresInMs, clientId: 'e2e-client' };
  };
  oauth.login = issue;
  oauth.refresh = async () => {
    if (stub.offline) throw new Error('fetch failed');
    return issue();
  };
  await runtime.signInChatGPT({ prompt: async () => '', notify: () => undefined });
}
