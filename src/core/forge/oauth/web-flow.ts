import { l } from '../../l10n';
import type { ForgeHttp } from '../http';
import type { ForgeProvider, TokenGrant } from '../providers/provider';
import { ForgeSignInError, type ForgeServer, type OAuthClient } from '../types';
import { startLoopbackReceiver } from './loopback-receiver';
import { createPkce, randomToken } from './pkce';

// The system-browser sign-in (RFC 8252): authorization code with PKCE S256 through a loopback redirect, after VS Code's
// github-authentication flows.ts 288 (MIT) and GitLab Workflow's oauth_flow.ts (MIT). The browser always opens through the
// host's openExternal, never the agent's browser.

export interface WebFlowDeps {
  readonly http: ForgeHttp;
  readonly openExternal: (url: string) => Promise<boolean>;
  readonly log: (line: string) => void;
  readonly now?: () => number;
}

export interface WebFlowOptions {
  readonly client: OAuthClient;
  /** GitHub "Sign in again" names the login; any other GitHub sign-in asks which account (prompt=select_account). */
  readonly login?: string;
  readonly signal: AbortSignal;
  /** The browser opened on url; the flow now waits for its callback. "Open the page again" opens url. */
  readonly onWaiting: (url: string) => void;
}

export async function runWebFlow(deps: WebFlowDeps, server: ForgeServer, provider: ForgeProvider, options: WebFlowOptions): Promise<TokenGrant> {
  const state = randomToken();
  const pkce = createPkce();
  const receiver = await startLoopbackReceiver({ state, signal: options.signal, log: deps.log });
  try {
    const url = provider.authorizeUrl(server, {
      client: options.client,
      redirectUri: receiver.redirectUri,
      state,
      challenge: pkce.challenge,
      ...(options.login !== undefined ? { login: options.login } : {}),
    });
    if (!(await deps.openExternal(url))) throw new ForgeSignInError('provider', l('Damocles could not open your browser. Sign in with a device code or a token.'));
    options.onWaiting(url);
    const code = await receiver.code;
    return await provider.exchangeCode(deps.http, server, options.client, { code, redirectUri: receiver.redirectUri, verifier: pkce.verifier }, options.signal, deps.now ?? Date.now);
  } finally {
    receiver.close();
  }
}
