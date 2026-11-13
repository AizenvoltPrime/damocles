// Account resolution in order, adapted from GitLab Workflow for VS Code
// (https://gitlab.com/gitlab-org/gitlab-vscode-extension), src/desktop/accounts/workspace_account_manager.ts and
// account_preselection_service.ts. Copyright (c) 2020-present GitLab Inc. Licensed under the MIT License
// (THIRD-PARTY-NOTICES.md).
import type { ResolveHow } from '../../../shared/forge/bindings';
import type { RepoAccess } from '../providers/provider';
import { ForgeHttpError, type AccountRecord, type ForgeServer } from '../types';
import type { BindingStore } from './binding-store';

// docs/invariants.md "GitHub and GitLab accounts", resolution: binding, host default, only account, username hint, access
// check preferring push, then ask. Only a binding is stored; every other step is worked out again each time.

/** The access check's cap for all accounts together. */
export const ACCESS_CHECK_TIMEOUT_MS = 10_000;
/** How long an access check's answer is reused. */
export const ACCESS_CACHE_MS: number = 60 * 60_000;
/** Answers kept at most, per account and repository; the least recently used goes first. */
export const MAX_ACCESS_CACHE_ENTRIES = 1000;
/** An access check that singles out one account within this long proceeds without asking. */
export const FAST_PATH_MS = 1_000;

/** One account's access check: checked, an organization policy keeping the token out, or no answer. */
export type AccessOutcome =
  | ({ readonly kind: 'checked' } & RepoAccess)
  | { readonly kind: 'ssoRequired' }
  | { readonly kind: 'appNotApproved' }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'signInAgain' };

export interface AccessCheckerDeps {
  /** The account's access with a live token of its own, sent only to its own server; rejects as http.ts classifies. */
  readonly check: (account: AccountRecord, server: ForgeServer, repoPath: string, signal: AbortSignal) => Promise<RepoAccess>;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

export interface AccessChecker {
  /** A fresh cached outcome, or undefined. */
  cached(accountId: string, repoPath: string): AccessOutcome | undefined;
  /** The outcome for each account, all in parallel; recheck skips the cache. Each settles within ACCESS_CHECK_TIMEOUT_MS. */
  run(accounts: readonly AccountRecord[], server: ForgeServer, repoPath: string, recheck: boolean): Map<string, Promise<AccessOutcome>>;
  forgetAccount(accountId: string): void;
}

function outcomeOf(err: unknown): AccessOutcome {
  if (err instanceof ForgeHttpError) {
    switch (err.kind) {
      case 'ssoRequired': return { kind: 'ssoRequired' };
      case 'appNotApproved': return { kind: 'appNotApproved' };
      case 'unauthorized': return { kind: 'signInAgain' };
      case 'forbidden': return { kind: 'checked', canPush: false, owner: false, readable: false };
      default: return { kind: 'unreachable' };
    }
  }
  return { kind: 'unreachable' };
}

export function createAccessChecker(deps: AccessCheckerDeps): AccessChecker {
  const cache = new Map<string, { readonly at: number; readonly outcome: AccessOutcome }>();
  const running = new Map<string, Promise<AccessOutcome>>();
  const keyOf = (accountId: string, repoPath: string): string => `${accountId}\n${repoPath}`;

  async function checkOne(account: AccountRecord, server: ForgeServer, repoPath: string): Promise<AccessOutcome> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const capped = new Promise<AccessOutcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        deps.log(`[forge] access check of ${account.id} on ${repoPath} took over ${ACCESS_CHECK_TIMEOUT_MS} ms`);
        resolve({ kind: 'unreachable' });
      }, ACCESS_CHECK_TIMEOUT_MS);
    });
    const checked = deps.check(account, server, repoPath, controller.signal).then(
      (access): AccessOutcome => ({ kind: 'checked', ...access }),
      (err: unknown): AccessOutcome => {
        const outcome = outcomeOf(err);
        if (!controller.signal.aborted) deps.log(`[forge] access check of ${account.id} on ${server.id} ended: ${outcome.kind}${err instanceof ForgeHttpError ? ` (${err.kind})` : ''}`);
        return outcome;
      },
    );
    try {
      return await Promise.race([checked, capped]);
    } finally {
      clearTimeout(timer);
    }
  }

  // the cache's Map order is its use order: a read or a write moves the entry last
  const cached = (accountId: string, repoPath: string): AccessOutcome | undefined => {
    const key = keyOf(accountId, repoPath);
    const held = cache.get(key);
    if (!held) return undefined;
    cache.delete(key);
    if (deps.now() - held.at >= ACCESS_CACHE_MS) return undefined;
    cache.set(key, held);
    return held.outcome;
  };
  const remember = (key: string, outcome: AccessOutcome): void => {
    const now = deps.now();
    for (const [held, entry] of cache) if (now - entry.at >= ACCESS_CACHE_MS) cache.delete(held);
    cache.delete(key);
    cache.set(key, { at: now, outcome });
    for (const held of cache.keys()) {
      if (cache.size <= MAX_ACCESS_CACHE_ENTRIES) break;
      cache.delete(held);
    }
  };

  return {
    cached,
    run(accounts, server, repoPath, recheck) {
      const outcomes = new Map<string, Promise<AccessOutcome>>();
      for (const account of accounts) {
        const key = keyOf(account.id, repoPath);
        const fresh = recheck ? undefined : cached(account.id, repoPath);
        if (fresh) {
          outcomes.set(account.id, Promise.resolve(fresh));
          continue;
        }
        let pending = running.get(key);
        if (!pending) {
          pending = checkOne(account, server, repoPath).then((outcome) => {
            // no answer is not an answer: it is asked again next time
            if (outcome.kind !== 'unreachable' && outcome.kind !== 'signInAgain') remember(key, outcome);
            return outcome;
          }).finally(() => running.delete(key));
          running.set(key, pending);
        }
        outcomes.set(account.id, pending);
      }
      return outcomes;
    },
    forgetAccount(accountId) {
      for (const key of [...cache.keys()]) if (key.startsWith(`${accountId}\n`)) cache.delete(key);
    },
  };
}

/** A server of a repository as resolution reads it. */
export interface ResolveTarget {
  /** Absent for a clone, whose project does not exist yet. */
  readonly projectKey?: string;
  readonly authorityKey: string;
  readonly server: ForgeServer;
  readonly usernameHint?: string;
}

/** A settled account: null is "Use Git's own credentials", which only a binding gives. */
export interface Settled {
  readonly how: ResolveHow;
  readonly account: AccountRecord | null;
}

/** The steps before the access check; undefined: the access check decides, then the user. */
export function resolveWithoutAccess(target: ResolveTarget, accounts: readonly AccountRecord[], bindings: BindingStore): Settled | undefined {
  const byId = (id: string): AccountRecord | undefined => accounts.find((account) => account.id === id);
  const bound = target.projectKey !== undefined ? bindings.binding(target.projectKey, target.server.id) : undefined;
  if (bound) {
    if (bound.account === null) return { how: 'bound', account: null };
    // a binding to an account no longer here is passed over
    const account = byId(bound.account);
    if (account) return { how: 'bound', account };
  }
  const hostDefault = bindings.hostDefaults(target.authorityKey)[target.server.id];
  const fromHost = hostDefault !== undefined ? byId(hostDefault) : undefined;
  if (fromHost) return { how: 'hostDefault', account: fromHost };
  if (accounts.length === 1) return { how: 'onlyAccount', account: accounts[0]! };
  const hint = target.usernameHint?.toLowerCase();
  const hinted = hint !== undefined ? accounts.filter((account) => account.login.toLowerCase() === hint) : [];
  if (hinted.length === 1) return { how: 'usernameHint', account: hinted[0]! };
  return undefined;
}

/** The one account that can push, once every check is in; the Choose account dialog's fast path asks nothing else of the access check. */
export function singlePusher(accounts: readonly AccountRecord[], outcomes: ReadonlyMap<string, AccessOutcome | undefined>): AccountRecord | undefined {
  if (accounts.some((account) => outcomes.get(account.id) === undefined)) return undefined;
  const pushers = accounts.filter((account) => {
    const outcome = outcomes.get(account.id);
    return outcome?.kind === 'checked' && outcome.canPush;
  });
  return pushers.length === 1 ? pushers[0] : undefined;
}

/** The one account that can push, else the one that can read; undefined while any check is out or none stands alone. */
export function pickByAccess(accounts: readonly AccountRecord[], outcomes: ReadonlyMap<string, AccessOutcome | undefined>): AccountRecord | undefined {
  if (accounts.some((account) => outcomes.get(account.id) === undefined)) return undefined;
  const checked = accounts.filter((account) => outcomes.get(account.id)?.kind === 'checked');
  const access = (account: AccountRecord): RepoAccess => outcomes.get(account.id) as RepoAccess;
  const pushers = checked.filter((account) => access(account).canPush);
  if (pushers.length === 1) return pushers[0];
  if (pushers.length > 1) return undefined;
  const readers = checked.filter((account) => access(account).readable);
  return readers.length === 1 ? readers[0] : undefined;
}

/** The row the Choose account dialog preselects: the one pick, else an owner that can push, else the first that can push. */
export function preselectOf(accounts: readonly AccountRecord[], outcomes: ReadonlyMap<string, AccessOutcome | undefined>): string | undefined {
  const picked = pickByAccess(accounts, outcomes);
  if (picked) return picked.id;
  const checked = (account: AccountRecord): RepoAccess | undefined => {
    const outcome = outcomes.get(account.id);
    return outcome?.kind === 'checked' ? outcome : undefined;
  };
  return (accounts.find((account) => checked(account)?.owner === true && checked(account)?.canPush === true) ?? accounts.find((account) => checked(account)?.canPush === true))?.id;
}
