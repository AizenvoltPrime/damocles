// Keep running's token refresh and push: docs/invariants.md "Remote daemon and wire", a client pushes only its own tokens.
import type { BrokerAnswer, HeldAuth } from '../../../shared/remote-user';
import type { PushedCredential } from '../../core-protocol/messages';
import { brokerAnswerOf, checkProvider } from './user-relays';

// the most Keep running waits for the pushes (and the refresh before them)
export const PUSH_TIMEOUT_MS = 5000;
// the most a row's note says a token has left
const MAX_NOTE_MINUTES = 24 * 60;

/** One remote run as `control.listRuns` reported it, with the providers its broker cache used. */
export interface KeepRunningRun {
  readonly hostId: string;
  readonly panelId: string;
  readonly providers: readonly string[];
}

/** A host this app is attached to: push sends `user.credentials.push` over this app's connection and honors the signal. */
export interface KeepRunningHost {
  readonly hostId: string;
  readonly push: (provider: string, credential: PushedCredential, signal: AbortSignal) => Promise<void>;
}

/** A row's note when its sign-in could not be refreshed: the whole minutes its current token has left. */
export interface TokenNote {
  readonly provider: string;
  readonly minutesLeft: number;
}

export interface KeepRunningDeps {
  // the local core's user.resolveCredential, force-refreshing under pi's lock
  readonly resolveCredential: (provider: string, force: boolean) => Promise<BrokerAnswer>;
  // the local core's user.clientAuth: every provider's credential type and expiry on this clock
  readonly clientAuth: () => Promise<HeldAuth>;
  readonly log: (line: string) => void;
  readonly now?: () => number;
}

export interface KeepRunningRefresh {
  // by runKey, the note of each run whose refresh failed; settles once every refresh settled
  readonly notes: Promise<ReadonlyMap<string, TokenNote>>;
  // pushes each refreshed token to the hosts whose runs reported it, settling within timeoutMs
  push(hosts: readonly KeepRunningHost[], timeoutMs?: number): Promise<void>;
}

export const runKey = (hostId: string, panelId: string): string => `${hostId}\n${panelId}`;

interface Refreshed {
  readonly answer: Extract<BrokerAnswer, { readonly type: 'oauth' }>;
  // on this computer's clock
  readonly expires: number;
}

/** Starts refreshing exactly the OAuth sign-ins the runs reported (an API key never expires in a broker's cache). */
export function startKeepRunningRefresh(deps: KeepRunningDeps, runs: readonly KeepRunningRun[]): KeepRunningRefresh {
  const now = deps.now ?? Date.now;
  // a local core that cannot answer (halted, not started) leaves nothing to refresh: Keep running still keeps the runs
  const readAuth = (): Promise<HeldAuth> => deps.clientAuth().catch((err: unknown): HeldAuth => {
    deps.log(`[keep-running] reading this computer's sign-ins failed: ${err instanceof Error ? err.message : String(err)}`);
    return { providers: {} };
  });
  const before = readAuth();
  // each reported provider this computer holds an OAuth sign-in for, refreshed on its own: undefined when the refresh failed
  const refreshes = before.then((auth) => new Map([...new Set(runs.flatMap((run) => run.providers))].flatMap((provider) => {
    try {
      checkProvider(provider, auth);
    } catch (err) {
      deps.log(`[keep-running] skipped a provider a host reported: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
    if (auth.providers[provider]?.type !== 'oauth') return [];
    const refreshed = deps.resolveCredential(provider, true).then((raw): Refreshed => {
      const answer = brokerAnswerOf(raw);
      if (answer.type !== 'oauth') throw new Error(`the ${provider} sign-in is no longer OAuth`);
      return { answer, expires: now() + answer.expiresIn };
    }).catch((err: unknown) => {
      deps.log(`[keep-running] refreshing ${provider} failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    });
    return [[provider, refreshed] as const];
  })));

  const notes = refreshes.then(async (byProvider) => {
    const failed = new Set((await Promise.all([...byProvider].map(async ([provider, refreshed]) => ((await refreshed) === undefined ? [provider] : [])))).flat());
    // the minutes the current tokens have left, read after the failed refreshes settled
    const after = failed.size > 0 ? await readAuth() : await before;
    const byRun = new Map<string, TokenNote>();
    for (const run of runs) {
      for (const provider of run.providers) {
        if (!failed.has(provider)) continue;
        const expires = after.providers[provider]?.expires ?? now();
        const minutesLeft = Math.min(Math.max(Math.floor((expires - now()) / 60_000), 0), MAX_NOTE_MINUTES);
        const held = byRun.get(runKey(run.hostId, run.panelId));
        if (held === undefined || minutesLeft < held.minutesLeft) byRun.set(runKey(run.hostId, run.panelId), { provider, minutesLeft });
      }
    }
    return byRun as ReadonlyMap<string, TokenNote>;
  });

  const push = async (hosts: readonly KeepRunningHost[], timeoutMs = PUSH_TIMEOUT_MS): Promise<void> => {
    const bound = new AbortController();
    const signal = bound.signal;
    const timedOut = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    const timer = setTimeout(() => bound.abort(new Error(`Keep running stopped waiting for the pushes after ${timeoutMs} ms`)), timeoutMs);
    // each token goes as soon as its own refresh is done
    const pushes = refreshes.then((byProvider) => Promise.all(hosts.flatMap((host) => {
      const providers = new Set(runs.filter((run) => run.hostId === host.hostId).flatMap((run) => run.providers));
      return [...providers].flatMap((provider) => {
        const refreshed = byProvider.get(provider);
        return refreshed === undefined ? [] : [refreshed.then(async (token) => {
          if (token === undefined || signal.aborted) return;
          await host.push(provider, { ...token.answer, expiresIn: Math.max(token.expires - now(), 0) }, signal);
        }).catch((err: unknown) => {
          deps.log(`[keep-running] pushing ${provider} to ${host.hostId} failed: ${err instanceof Error ? err.message : String(err)}`);
        })];
      });
    })));
    try {
      await Promise.race([pushes, timedOut]);
    } finally {
      clearTimeout(timer);
    }
    if (signal.aborted) deps.log(`[keep-running] the pushes did not all finish within ${timeoutMs} ms`);
  };

  return { notes, push };
}

/** An OS shutdown or an update's quit keeps the runs with no dialog: refresh and push within the shutdown window, best effort. */
export function keepRunningAtShutdown(deps: KeepRunningDeps, runs: readonly KeepRunningRun[], hosts: readonly KeepRunningHost[], windowMs: number): Promise<void> {
  return startKeepRunningRefresh(deps, runs).push(hosts, windowMs);
}
