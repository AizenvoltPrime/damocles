import * as path from 'node:path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { AgentWindDown } from '../../shared/types/wind-down';
import { log } from '../logger';
import { agentFileSessionId } from './agent-records';
import type { SubagentSessionStore } from './folder-runtime';
import { acquireSessionLease, releaseSessionLease, sessionLeaseBlocker, type SessionLeaseHolder } from './session-store/session-lease';
import type { RunLifecycle } from './run-lifecycle';
import { noticeWindDown, type WindDownNotice } from './wind-down-notice';

/**
 * The one writer of an agent session file, a team member's or a subagent's (docs/invariants.md, "Teams and subagents").
 * Taken before pi opens the file and released by the run that opened it, once that run settled and its session was disposed.
 */
export interface AgentFileOwner {
  /** The session opened on the file, by its run lifecycle: a run waiting for the file shows its wind-down, and its writes stop if the lease is lost. */
  watch(run: RunLifecycle, stop: AbortSignal): void;
  /** Only once the owner's session can write no more. */
  release(): void;
}

/** A run that waits for the file: its stop cancels the wait, and it shows the owner's wind-down meanwhile. */
export interface AgentFileWaiter {
  signal: AbortSignal;
  onWindDown: (windDown: AgentWindDown | null) => void;
}

export type AgentFileStore = Exclude<SubagentSessionStore, { kind: 'memory' }>;

interface Owned {
  dir: string;
  session: AgentSession | null;
  muted: boolean;
  windDown: AgentWindDown | null;
  watchers: Set<(windDown: AgentWindDown | null) => void>;
  released: Promise<void>;
}

/** Keyed by the file's pi session id, which a fork's copy of the file does not share. */
const owned = new Map<string, Owned>();

const sessionIdOf = (store: AgentFileStore): string => (store.kind === 'file' ? store.id : agentFileSessionId(store.path));

/** Stops the entry's session writing its file, now or once it opens. */
function mute(entry: Owned): void {
  entry.muted = true;
  // pi's SessionManager has no close; replacing its file writer is the one synchronous way to stop it, as `PiSession` does.
  if (entry.session) entry.session.sessionManager._persist = () => undefined;
}

/** Before agent data is deleted: no session of this process, a held stopped run included, appends to a file under `dir` again. */
export function muteAgentFilesUnder(dir: string): void {
  for (const entry of owned.values()) {
    const relative = path.relative(dir, entry.dir);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) mute(entry);
  }
}

const heldElsewhereError = (sessionId: string): Error =>
  new Error(`Its session file ${sessionId} is still open in another Damocles window, whose stopped run has not finished. Wait for that run to stop or close that window, then try again.`);

/** Whether another Damocles process holds the file now, read for a resume's validation; it takes nothing, so `takeAgentFile` still guards the open. */
export function agentFileHeldElsewhere(store: AgentFileStore): boolean {
  return sessionLeaseBlocker(sessionIdOf(store))?.kind === 'other-process';
}

/**
 * Own the file `store` names before pi opens it: null while another run of this process owns it (`waitForAgentFile`), and
 * throws when another Damocles process holds it.
 */
export function takeAgentFile(store: AgentFileStore): AgentFileOwner | null {
  const sessionId = sessionIdOf(store);
  if (owned.has(sessionId)) return null;
  let markReleased!: () => void;
  const entry: Owned = {
    dir: store.kind === 'file' ? store.dir : path.dirname(store.path),
    session: null,
    muted: false,
    windDown: null,
    watchers: new Set(),
    released: new Promise<void>((resolve) => { markReleased = resolve; }),
  };
  const holder: SessionLeaseHolder = {
    onSessionLeaseLost: (id) => {
      log('[agent-file-owner] another process took the lease on agent file %s; its session here writes no more', id);
      mute(entry);
    },
  };
  if (!acquireSessionLease(sessionId, holder, { writer: true })) throw heldElsewhereError(sessionId);
  owned.set(sessionId, entry);
  let notice: WindDownNotice | null = null;
  let released = false;
  return {
    watch: (run, stop) => {
      entry.session = run.session;
      if (entry.muted) mute(entry);
      notice = noticeWindDown(run, stop, (windDown) => {
        entry.windDown = windDown;
        for (const watcher of entry.watchers) watcher(windDown);
      });
    },
    release: () => {
      if (released) return;
      released = true;
      notice?.end();
      owned.delete(sessionId);
      releaseSessionLease(sessionId, holder);
      markReleased();
    },
  };
}

/** Settles when `owner` lets go of the file, or rejects with the stop's reason. */
function untilReleased(owner: Owned, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void owner.released.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

/** Wait until no run of this process owns the file, showing its owner's wind-down meanwhile, then own it as `takeAgentFile` does. */
export async function waitForAgentFile(store: AgentFileStore, waiter: AgentFileWaiter): Promise<AgentFileOwner> {
  const sessionId = sessionIdOf(store);
  let shown = false;
  const relay = (windDown: AgentWindDown | null): void => {
    shown = windDown !== null;
    waiter.onWindDown(windDown);
  };
  try {
    for (;;) {
      waiter.signal.throwIfAborted();
      const owner = takeAgentFile(store);
      if (owner) return owner;
      const current = owned.get(sessionId)!;
      if (current.windDown) relay(current.windDown);
      current.watchers.add(relay);
      try {
        await untilReleased(current, waiter.signal);
      } finally {
        current.watchers.delete(relay);
      }
    }
  } finally {
    if (shown) waiter.onWindDown(null);
  }
}
