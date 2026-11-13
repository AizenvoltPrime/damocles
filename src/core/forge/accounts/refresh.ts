// Single-flight refresh adapted from GitLab Workflow for VS Code (https://gitlab.com/gitlab-org/gitlab-vscode-extension),
// src/desktop/gitlab/token_exchange_service.ts. Copyright (c) 2020-present GitLab Inc. Licensed under the MIT License
// (THIRD-PARTY-NOTICES.md).
import type { ForgeHttp } from '../http';
import { providerFor, RefreshRefusedError } from '../providers/provider';
import { ForgeHttpError, type AccountRecord, type ForgeServer, type TokenSet } from '../types';
import type { TokenStore } from './token-store';

// docs/invariants.md "GitHub and GitLab accounts", refresh and revoke: one refresh in flight per account, started when under
// REFRESH_MARGIN_MS remain; the rotated tokens are stored before first use; a refused refresh token marks the account
// "Sign in again"; a network failure keeps the current token until it expires.

export const REFRESH_MARGIN_MS: number = 5 * 60_000;

export interface RefresherDeps {
  readonly http: ForgeHttp;
  readonly tokens: TokenStore;
  readonly log: (line: string) => void;
  /** The account must sign in again: its token is gone, expired, or its refresh was refused. Called on the account's chain. */
  readonly needsSignIn: (accountId: string) => Promise<void>;
  readonly now?: () => number;
}

export interface Refresher {
  /** A usable access token for the account, refreshed first when it expires within REFRESH_MARGIN_MS. */
  accessToken(account: AccountRecord, server: ForgeServer): Promise<string>;
  /** Runs work alone on the account's chain, so no refresh lands meanwhile; `token` resolves without queuing. */
  exclusive<T>(account: AccountRecord, server: ForgeServer, work: (token: () => Promise<string>) => Promise<T>): Promise<T>;
  /**
   * The server refused refusedAccess: a refresh now, whatever its expiry, unless the stored token is already another one,
   * which is returned; one that cannot refresh signs in again.
   */
  refreshNow(account: AccountRecord, server: ForgeServer, refusedAccess: string): Promise<string>;
}

const signInAgain = (): ForgeHttpError => new ForgeHttpError('unauthorized', 'The account must sign in again');

export function createRefresher(deps: RefresherDeps): Refresher {
  const now = deps.now ?? Date.now;
  const chains = new Map<string, Promise<unknown>>();

  async function refresh(account: AccountRecord, server: ForgeServer, current: TokenSet, refused = false): Promise<string> {
    const client = server.oauth && (account.clientId === undefined || account.clientId === server.oauth.clientId) ? server.oauth : undefined;
    if (current.refresh === undefined || client === undefined) {
      deps.log(`[forge] ${account.id} cannot refresh (${current.refresh === undefined ? 'no refresh token' : 'its OAuth app is gone'})`);
      if (!refused && current.accessExpiresAt !== undefined && current.accessExpiresAt > now()) return current.access;
      await deps.needsSignIn(account.id);
      throw signInAgain();
    }
    let next: TokenSet;
    try {
      const grant = await providerFor(server.kind).refresh(deps.http, server, client, current.refresh, account.auth, now);
      // a server that does not rotate keeps the old refresh token valid
      next = grant.tokens.refresh !== undefined ? grant.tokens : { ...grant.tokens, ...(current.refresh !== undefined ? { refresh: current.refresh } : {}), ...(current.refreshExpiresAt !== undefined ? { refreshExpiresAt: current.refreshExpiresAt } : {}) };
    } catch (err) {
      if (err instanceof RefreshRefusedError) {
        deps.log(`[forge] ${account.id} refresh refused; the account must sign in again`);
        await deps.needsSignIn(account.id);
        throw signInAgain();
      }
      deps.log(`[forge] ${account.id} refresh failed: ${err instanceof ForgeHttpError ? err.kind : err instanceof Error ? err.name : typeof err}`);
      if (!refused && current.accessExpiresAt !== undefined && current.accessExpiresAt > now()) return current.access;
      throw err;
    }
    await deps.tokens.set(account.id, next);
    deps.log(`[forge] ${account.id} refreshed its token`);
    return next.access;
  }

  async function resolveToken(account: AccountRecord, server: ForgeServer): Promise<string> {
    const current = await deps.tokens.get(account.id);
    if (current === undefined) {
      await deps.needsSignIn(account.id);
      throw signInAgain();
    }
    if (current.accessExpiresAt === undefined || current.accessExpiresAt - now() > REFRESH_MARGIN_MS) return current.access;
    return refresh(account, server, current);
  }

  // calls for one account run one after another, so a call queued behind a refresh reads the rotated tokens
  function chained<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    const previous = chains.get(accountId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    chains.set(accountId, run);
    // run's rejection reaches the caller; this branch only clears the chain
    void run.finally(() => {
      if (chains.get(accountId) === run) chains.delete(accountId);
    }).catch(() => undefined);
    return run;
  }

  return {
    accessToken: (account, server) => chained(account.id, () => resolveToken(account, server)),
    exclusive: (account, server, work) => chained(account.id, () => work(() => resolveToken(account, server))),
    refreshNow: (account, server, refusedAccess) => chained(account.id, async () => {
      const current = await deps.tokens.get(account.id);
      if (current === undefined) {
        await deps.needsSignIn(account.id);
        throw signInAgain();
      }
      // another caller refused for the same token already rotated it; a second rotation would revoke that caller's token
      if (current.access !== refusedAccess) return current.access;
      return refresh(account, server, current, true);
    }),
  };
}
