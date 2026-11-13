import type { RemoteEndpoint } from '../../shared/forge/bindings';
import { MAX_PROTECTED_REMOTES, type BranchProtectionRule, type RemoteBranchProtection } from '../../shared/forge/branch-protection';
import type { BindingStore } from './bindings/binding-store';
import { resolveWithoutAccess } from './bindings/resolve';
import { ruleProtects } from '../scm/branch-protection';
import { boundedRules } from './providers/protection-rules';
import { matchServer } from './remote-url';
import { checkedRepoPath } from './tools/api';
import { ForgeHttpError, type AccountRecord, type ForgeServer } from './types';

// The server branch protection a commit asks by and a refused push is judged by (docs/invariants.md "GitHub and GitLab
// accounts", branch protection). Rules are kept per (server, repository) in memory; a lookup answers from them at once and
// reads a missing or stale entry in the background, so a commit never waits on a server, and one with nothing held goes on
// unprompted. A refused push, which the user already waited for, reads a missing or stale entry once before it decides.

/** How long an entry answers before a lookup reads it again in the background. */
export const PROTECTION_FRESH_MS: number = 30 * 60_000;
/** After a failed read, how long lookups wait before reading that entry again; the last rules keep answering meanwhile. */
export const PROTECTION_RETRY_MS: number = 5 * 60_000;
const MAX_ENTRIES = 500;

/** What a lookup reads of a repository: its project, authority and remote endpoints, as main read them on its own core. */
export interface ProtectionRepo {
  readonly projectKey?: string;
  readonly authorityKey: string;
  readonly endpoints: readonly RemoteEndpoint[];
  /** The branch's upstream remote, whose rules a commit reads; a lookup answers it first. */
  readonly pushRemote?: string;
}

export interface BranchProtectionDeps {
  readonly servers: () => readonly ForgeServer[];
  readonly accounts: () => readonly AccountRecord[];
  readonly bindings: BindingStore;
  /** The account has a token this run can use (not "Sign in again"). */
  readonly usable: (account: AccountRecord) => boolean;
  /** The access check's pick among candidates; network, so only in the background. */
  readonly pickByAccess: (candidates: readonly AccountRecord[], server: ForgeServer, repoPath: string) => Promise<AccountRecord | undefined>;
  /** The server's rules for the account, read with its own token. */
  readonly read: (account: AccountRecord, server: ForgeServer, repoPath: string, signal: AbortSignal) => Promise<readonly BranchProtectionRule[]>;
  /** damocles.desktop.forge.branchProtection: off answers nothing and reads nothing. */
  readonly enabled: () => boolean;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

/**
 * Whether the server protects a refused push's branch for the account the push used. unknown: no managed server, no account
 * of Damocles, the setting off, or the rules could not be read.
 */
export type PushProtection =
  | { readonly protection: 'unprotected' | 'unknown' }
  | { readonly protection: 'protected'; readonly serverId: string; readonly serverName: string; readonly kind: 'github' | 'gitlab'; readonly accountId: string; readonly login: string; readonly path: string };

export interface BranchProtectionCache {
  /** The rules held for each remote of repo, at once; never waits, never throws. */
  lookup(repo: ProtectionRepo): RemoteBranchProtection[];
  /** Whether branch is protected on the server remote pushes to, from rules read for the push's account in the last 30 minutes, else read now. */
  pushProtection(repo: ProtectionRepo, remote: string, branch: string, signal: AbortSignal): Promise<PushProtection>;
  forgetAccount(accountId: string): void;
  /** Settles once every background read started so far has. */
  idle(): Promise<void>;
  dispose(): void;
}

interface Entry {
  readonly accountId: string;
  readonly rules: readonly BranchProtectionRule[];
  readonly at: number;
}

/** A background read under way: the account it reads with, once settled or picked, and its run, true once it stored rules. */
interface BackgroundRead {
  accountId: string | undefined;
  run: Promise<boolean>;
}

const entryKey = (server: ForgeServer, repoPath: string): string => `${server.id}\n${repoPath}`;

const errorName = (err: unknown): string => (err instanceof ForgeHttpError ? `${err.name} ${err.kind}` : err instanceof Error ? err.name : typeof err);

/** work's outcome, or signal's reason once it aborts first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createBranchProtectionCache(deps: BranchProtectionDeps): BranchProtectionCache {
  const entries = new Map<string, Entry>();
  const failures = new Map<string, number>();
  const running = new Map<string, BackgroundRead>();
  const controller = new AbortController();

  const remember = <T>(map: Map<string, T>, key: string, value: T): void => {
    map.delete(key);
    map.set(key, value);
    while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value!);
  };

  const readRules = async (account: AccountRecord, server: ForgeServer, repoPath: string, signal: AbortSignal): Promise<readonly BranchProtectionRule[]> =>
    boundedRules(await deps.read(account, server, repoPath, signal), deps.log);

  async function refresh(key: string, server: ForgeServer, repoPath: string, settled: AccountRecord | undefined, candidates: readonly AccountRecord[], read: BackgroundRead): Promise<boolean> {
    try {
      const account = settled ?? (await deps.pickByAccess(candidates.filter(deps.usable), server, repoPath));
      if (!account || !deps.usable(account)) {
        remember(failures, key, deps.now());
        deps.log(`[forge] no account of ${server.id} could read its branch protection`);
        return false;
      }
      read.accountId = account.id;
      const rules = await readRules(account, server, repoPath, controller.signal);
      remember(entries, key, { accountId: account.id, rules, at: deps.now() });
      failures.delete(key);
      deps.log(`[forge] read the branch protection of a repository on ${server.id}`);
      return true;
    } catch (err) {
      remember(failures, key, deps.now());
      if (!controller.signal.aborted) deps.log(`[forge] reading the branch protection of ${server.id} failed: ${errorName(err)}`);
      return false;
    }
  }

  function start(key: string, server: ForgeServer, repoPath: string, settled: AccountRecord | undefined, candidates: readonly AccountRecord[]): void {
    if (running.has(key) || controller.signal.aborted) return;
    const failedAt = failures.get(key);
    if (failedAt !== undefined && deps.now() - failedAt < PROTECTION_RETRY_MS) return;
    const read: BackgroundRead = { accountId: settled?.id, run: Promise.resolve(false) };
    read.run = refresh(key, server, repoPath, settled, candidates, read).finally(() => running.delete(key));
    running.set(key, read);
  }

  return {
    lookup(repo) {
      if (!deps.enabled()) return [];
      const servers = deps.servers();
      const accounts = deps.accounts();
      const out: RemoteBranchProtection[] = [];
      // the wire carries MAX_PROTECTED_REMOTES remotes, the upstream's first, since a commit reads only its rules
      const ordered = [...repo.endpoints.filter((endpoint) => endpoint.remote === repo.pushRemote), ...repo.endpoints.filter((endpoint) => endpoint.remote !== repo.pushRemote)];
      for (const endpoint of ordered.slice(0, MAX_PROTECTED_REMOTES)) {
        // protection applies where commits are pushed
        const location = endpoint.push ?? endpoint.fetch;
        const match = location ? matchServer(location, servers) : undefined;
        const repoPath = match ? checkedRepoPath(match.server.kind, match.repoPath) : undefined;
        if (!match || repoPath === undefined) continue;
        const { server } = match;
        const candidates = accounts.filter((account) => account.serverId === server.id);
        if (candidates.length === 0) continue;
        const settled = resolveWithoutAccess({ ...(repo.projectKey !== undefined ? { projectKey: repo.projectKey } : {}), authorityKey: repo.authorityKey, server, ...(location!.usernameHint !== undefined ? { usernameHint: location!.usernameHint } : {}) }, candidates, deps.bindings);
        // a project on Git's own credentials uses no account of Damocles
        if (settled?.account === null) continue;
        const key = entryKey(server, repoPath);
        const entry = entries.get(key);
        const ownAccount = entry !== undefined && (settled?.account ? entry.accountId === settled.account.id : candidates.some((account) => account.id === entry.accountId));
        if (ownAccount && entry.rules.length > 0) out.push({ remote: endpoint.remote, rules: entry.rules });
        if (!ownAccount || deps.now() - entry.at >= PROTECTION_FRESH_MS) start(key, server, repoPath, settled?.account ?? undefined, candidates);
      }
      return out;
    },

    async pushProtection(repo, remote, branch, signal) {
      if (!deps.enabled()) return { protection: 'unknown' };
      const endpoint = repo.endpoints.find((item) => item.remote === remote);
      const location = endpoint?.push ?? endpoint?.fetch;
      const match = location ? matchServer(location, deps.servers()) : undefined;
      const repoPath = match ? checkedRepoPath(match.server.kind, match.repoPath) : undefined;
      if (!match || repoPath === undefined) return { protection: 'unknown' };
      const { server } = match;
      const candidates = deps.accounts().filter((account) => account.serverId === server.id);
      if (candidates.length === 0) return { protection: 'unknown' };
      const settled = resolveWithoutAccess({ ...(repo.projectKey !== undefined ? { projectKey: repo.projectKey } : {}), authorityKey: repo.authorityKey, server, ...(location!.usernameHint !== undefined ? { usernameHint: location!.usernameHint } : {}) }, candidates, deps.bindings);
      if (settled?.account === null) return { protection: 'unknown' };
      const account = settled?.account ?? (await deps.pickByAccess(candidates.filter(deps.usable), server, repoPath));
      if (!account || !deps.usable(account)) return { protection: 'unknown' };
      const key = entryKey(server, repoPath);
      // a background read of the entry under way for this account is this decision's read, and its failure answers unknown
      const background = running.get(key);
      if (background?.accountId === account.id && !(await untilAborted(background.run, signal))) return { protection: 'unknown' };
      let entry = entries.get(key);
      if (entry?.accountId !== account.id || deps.now() - entry.at >= PROTECTION_FRESH_MS) {
        let rules: readonly BranchProtectionRule[];
        try {
          rules = await readRules(account, server, repoPath, AbortSignal.any([signal, controller.signal]));
        } catch (err) {
          if (signal.aborted) throw err;
          remember(failures, key, deps.now());
          deps.log(`[forge] reading the branch protection of ${server.id} for a refused push failed: ${errorName(err)}`);
          return { protection: 'unknown' };
        }
        entry = { accountId: account.id, rules, at: deps.now() };
        remember(entries, key, entry);
        failures.delete(key);
      }
      if (!entry.rules.some((rule) => ruleProtects(rule, branch))) return { protection: 'unprotected' };
      return { protection: 'protected', serverId: server.id, serverName: server.id, kind: server.kind, accountId: account.id, login: account.login, path: repoPath };
    },

    forgetAccount(accountId) {
      for (const [key, entry] of [...entries]) if (entry.accountId === accountId) entries.delete(key);
    },

    async idle() {
      while (running.size > 0) await Promise.all([...running.values()].map((read) => read.run));
    },

    dispose() {
      controller.abort();
      entries.clear();
      failures.clear();
    },
  };
}
