import * as fs from 'node:fs';
import * as path from 'node:path';
import * as lockfile from 'proper-lockfile';
import { DAMOCLES_HOME_DIR } from '../../paths';
import { log } from '../../logger';
import { isSafeAgentPathId } from '../agent-records';

/** Outside every session dir, so pi's session listing, the session watcher and the list cache never see a lease. */
export const SESSION_LEASE_DIR: string = path.join(DAMOCLES_HOME_DIR, 'locks', 'sessions');
// A lease whose heartbeat stopped this long ago belongs to a dead process and is taken over.
export const SESSION_LEASE_STALE_MS = 20_000;
const SESSION_LEASE_UPDATE_MS = 2_000;
// A heartbeat this far behind means the holder stopped refreshing: it died or its event loop is wedged.
const SESSION_LEASE_HEARTBEAT_STOPPED_MS = 3 * SESSION_LEASE_UPDATE_MS;

/** What holds a lease: a panel's session, which must stop writing the moment its lease is lost. */
export interface SessionLeaseHolder {
  onSessionLeaseLost(sessionId: string): void;
}

interface Lease {
  release: () => void;
  /** Every holder in this process; the lease excludes other processes only, and panels share it. */
  holders: Set<SessionLeaseHolder>;
  /** A holder that writes the file outside any live panel; while it holds the lease, no other holder joins. */
  writer: SessionLeaseHolder | null;
}

/** Why a lease cannot be taken now. `heldUntilMs` is set when the other process's heartbeat has stopped: the epoch ms its lease turns stale. */
export type SessionLeaseBlocker =
  | { readonly kind: 'writing' }
  | { readonly kind: 'other-process'; readonly heldUntilMs?: number };

const leases = new Map<string, Lease>();

export function sessionLeasePath(sessionId: string): string {
  if (!isSafeAgentPathId(sessionId)) throw new Error(`Invalid session id "${sessionId}"`);
  return path.join(SESSION_LEASE_DIR, `${sessionId}.lock`);
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

// On Windows a lock dir another process is removing fails mkdir and stat with EPERM until it is gone.
function isBusyError(err: unknown): boolean {
  const code = errorCode(err);
  return code === 'ELOCKED' || (process.platform === 'win32' && code === 'EPERM');
}

function onCompromised(sessionId: string, lease: Lease, err: Error): void {
  if (leases.get(sessionId) !== lease) return;
  leases.delete(sessionId);
  log('[session-lease] lease on session %s lost: %s', sessionId, err.message);
  for (const holder of lease.holders) holder.onSessionLeaseLost(sessionId);
}

/**
 * What keeps `sessionId`'s lease from being taken by a new holder in this process right now, without
 * taking it; undefined when nothing does. Read-only: another process can still take the lease after it.
 */
export function sessionLeaseBlocker(sessionId: string): SessionLeaseBlocker | undefined {
  const lockPath = sessionLeasePath(sessionId);
  const held = leases.get(sessionId);
  if (held) return held.writer ? { kind: 'writing' } : undefined;
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return undefined;
    if (isBusyError(err)) return { kind: 'other-process' };
    throw err;
  }
  // The same staleness rule proper-lockfile applies when it takes a lock over.
  const heldUntilMs = mtimeMs + SESSION_LEASE_STALE_MS;
  const now = Date.now();
  if (heldUntilMs < now) return undefined;
  return now - mtimeMs > SESSION_LEASE_HEARTBEAT_STOPPED_MS ? { kind: 'other-process', heldUntilMs } : { kind: 'other-process' };
}

/**
 * Take the cross-process write lease on stored session `sessionId` for `holder`, at once or not at all.
 * False when another process holds it, or when a `writer` of this process holds it and `holder` is new.
 * A process already holding it adds `holder` without touching disk. A `writer` holder is the only one
 * joining until it releases, so nothing binds the file while it is written or removed outside a panel.
 */
export function acquireSessionLease(sessionId: string, holder: SessionLeaseHolder, options?: { writer?: boolean }): boolean {
  const lockPath = sessionLeasePath(sessionId);
  const writer = options?.writer === true;
  const held = leases.get(sessionId);
  if (held) {
    if (held.holders.has(holder)) return true;
    if (held.writer) return false;
    held.holders.add(holder);
    if (writer) held.writer = holder;
    return true;
  }
  fs.mkdirSync(SESSION_LEASE_DIR, { recursive: true });
  const lease: Lease = { release: () => undefined, holders: new Set([holder]), writer: writer ? holder : null };
  try {
    // The lock is keyed by session id alone; realpath false because nothing exists at that path until the lock does.
    lease.release = lockfile.lockSync(lockPath, {
      lockfilePath: lockPath,
      realpath: false,
      stale: SESSION_LEASE_STALE_MS,
      update: SESSION_LEASE_UPDATE_MS,
      onCompromised: (err) => onCompromised(sessionId, lease, err),
    });
  } catch (err) {
    if (isBusyError(err)) return false;
    throw err;
  }
  leases.set(sessionId, lease);
  return true;
}

/** Drop `holder` from the lease on `sessionId`; the last holder out removes the lock. */
export function releaseSessionLease(sessionId: string, holder: SessionLeaseHolder): void {
  const lease = leases.get(sessionId);
  if (!lease || !lease.holders.delete(holder)) return;
  if (lease.writer === holder) lease.writer = null;
  if (lease.holders.size > 0) return;
  leases.delete(sessionId);
  try {
    lease.release();
  } catch (err) {
    // The lock dir may already be gone (removed by hand); the lease is released either way.
    log('[session-lease] releasing the lease on session %s failed: %O', sessionId, err);
  }
}

/** The session ids `holder` holds a lease on in this process. */
export function sessionLeasesOf(holder: SessionLeaseHolder): string[] {
  return [...leases].filter(([, lease]) => lease.holders.has(holder)).map(([sessionId]) => sessionId);
}
