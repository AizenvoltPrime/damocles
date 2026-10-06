import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as lockfile from 'proper-lockfile';
import { DAMOCLES_HOME_DIR } from '../../paths';
import { log } from '../../logger';
import { isSafeAgentPathId } from '../agent-records';
import { isUuid } from '../../../shared/uuid';

/** Outside every session dir, so pi's session listing, the session watcher and the list cache never see a lease. */
export const SESSION_LEASE_DIR: string = path.join(DAMOCLES_HOME_DIR, 'locks', 'sessions');
// A lease whose heartbeat stopped this long ago belongs to a dead process and is taken over.
export const SESSION_LEASE_STALE_MS = 20_000;
// Also the release-request poll: proper-lockfile itself polls mtimes because watchers are unreliable on network filesystems.
const SESSION_LEASE_UPDATE_MS = 2_000;
// A heartbeat this far behind means the holder stopped refreshing: it died or its event loop is wedged.
const SESSION_LEASE_HEARTBEAT_STOPPED_MS = 3 * SESSION_LEASE_UPDATE_MS;
/**
 * How long a requester waits for a handover, and how old a request a holder still acts on: a request older than the wait
 * was left by a requester that died. Covers one holder poll, the abort, the 2 s checkpoint drain, the 10 s agent settle and a margin.
 */
export const SESSION_RELEASE_REQUEST_TTL_MS = 20_000;
// An owner record or release request is a few hundred bytes; anything longer is not one.
const MAX_RECORD_BYTES = 1024;
const MAX_HOSTNAME_LENGTH = 255;

/** What holds a lease: a panel's session, which must stop writing the moment its lease is lost. */
export interface SessionLeaseHolder {
  onSessionLeaseLost(sessionId: string): void;
  /** Another process asked for the session: let go of it, finishing this process's writes first. Absent on a holder that never hands over. */
  onSessionReleaseRequested?(sessionId: string): Promise<void>;
  /** The token of the panel this holder belongs to, which the owner record names; absent or null for none. */
  sessionLeasePanelToken?(): string | null;
}

/** `<sessionId>.owner` beside the lock: which process holds the lease, and the nonce a release request must name. */
export interface SessionLeaseOwner {
  readonly v: 1;
  /** Fresh per cross-process acquisition, so a record a crashed holder left behind never matches a live lease. */
  readonly nonce: string;
  readonly pid: number;
  readonly hostname: string;
  readonly panelToken: string | null;
  readonly acquiredAt: number;
}

/** `<sessionId>.release`: a request to the holder whose owner record names `nonce` to hand the session over. */
export interface SessionReleaseRequest {
  readonly v: 1;
  readonly nonce: string;
  readonly requestedAt: number;
  readonly requesterPid: number;
}

interface Lease {
  release: () => void;
  /** Every holder in this process; the lease excludes other processes only, and panels share it. */
  holders: Set<SessionLeaseHolder>;
  /** A holder that writes the file outside any live panel; while it holds the lease, no other holder joins. */
  writer: SessionLeaseHolder | null;
  readonly nonce: string;
  readonly acquiredAt: number;
  /** The panel token the owner record on disk names; undefined until a write of it succeeded. */
  recordedToken: string | null | undefined;
  ownerWriteFailed: boolean;
  /** Set from a valid release request until every holder answered it. */
  handingOver: boolean;
}

/** Why a lease cannot be taken now. `heldUntilMs` is set when the other process's heartbeat has stopped: the epoch ms its lease turns stale. */
export type SessionLeaseBlocker =
  | { readonly kind: 'writing' }
  | { readonly kind: 'other-process'; readonly heldUntilMs?: number };

const leases = new Map<string, Lease>();
let requestPoll: ReturnType<typeof setInterval> | null = null;
/** Lease files already logged as unreadable, and leases whose poll already logged a failure, so each is logged once rather than at every poll. */
const unreadableLogged = new Set<string>();

function leaseFilePath(sessionId: string, suffix: 'lock' | 'owner' | 'release'): string {
  if (!isSafeAgentPathId(sessionId)) throw new Error(`Invalid session id "${sessionId}"`);
  return path.join(SESSION_LEASE_DIR, `${sessionId}.${suffix}`);
}

export function sessionLeasePath(sessionId: string): string {
  return leaseFilePath(sessionId, 'lock');
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

// On Windows a lock dir another process is removing fails mkdir and stat with EPERM until it is gone.
function isBusyError(err: unknown): boolean {
  const code = errorCode(err);
  return code === 'ELOCKED' || (process.platform === 'win32' && code === 'EPERM');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseOwner(raw: unknown): SessionLeaseOwner | undefined {
  if (!isRecord(raw)) return undefined;
  const { v, nonce, pid, hostname, panelToken, acquiredAt } = raw;
  if (v !== 1 || !isUuid(nonce) || !isPid(pid) || !isTimestamp(acquiredAt)) return undefined;
  if (typeof hostname !== 'string' || hostname.length === 0 || hostname.length > MAX_HOSTNAME_LENGTH) return undefined;
  if (panelToken !== null && !isUuid(panelToken)) return undefined;
  return { v: 1, nonce, pid, hostname, panelToken, acquiredAt };
}

function parseRequest(raw: unknown): SessionReleaseRequest | undefined {
  if (!isRecord(raw)) return undefined;
  const { v, nonce, requestedAt, requesterPid } = raw;
  if (v !== 1 || !isUuid(nonce) || !isTimestamp(requestedAt) || !isPid(requesterPid)) return undefined;
  return { v: 1, nonce, requestedAt, requesterPid };
}

/** The JSON in `file`, undefined when it does not exist. Throws for anything else, a file over the size bound included. */
function readBoundedJson(file: string): unknown {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return undefined;
    throw err;
  }
  try {
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > MAX_RECORD_BYTES) throw new Error(`larger than ${MAX_RECORD_BYTES} bytes`);
    return JSON.parse(buffer.toString('utf8', 0, length)) as unknown;
  } finally {
    fs.closeSync(fd);
  }
}

/** Another process wrote these files, so a missing one is undefined and a bad one is undefined and logged once; never throws. */
function readLeaseFile<T>(sessionId: string, suffix: 'owner' | 'release', parse: (raw: unknown) => T | undefined): T | undefined {
  const key = `${sessionId}.${suffix}`;
  let reason: string;
  try {
    const raw = readBoundedJson(leaseFilePath(sessionId, suffix));
    const value = raw === undefined ? undefined : parse(raw);
    if (raw === undefined || value !== undefined) {
      unreadableLogged.delete(key);
      return value;
    }
    reason = 'not a valid record';
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }
  if (!unreadableLogged.has(key)) {
    unreadableLogged.add(key);
    log('[session-lease] ignoring unreadable %s: %s', key, reason);
  }
  return undefined;
}

/** Replace `file` in one rename, so a reader in another process sees the old record or the new one, never part of one. */
function writeAtomically(file: string, value: object): void {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx' });
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

function unlinkIfPresent(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') throw err;
  }
}

/** The record the process holding `sessionId`'s lease wrote beside it; undefined when there is none or it is unreadable. Never throws. */
export function readSessionLeaseOwner(sessionId: string): SessionLeaseOwner | undefined {
  return readLeaseFile(sessionId, 'owner', parseOwner);
}

/** Ask the holder of `sessionId`'s lease to hand it over. Throws when the request cannot be written. */
export function writeSessionReleaseRequest(sessionId: string, request: SessionReleaseRequest): void {
  fs.mkdirSync(SESSION_LEASE_DIR, { recursive: true });
  writeAtomically(leaseFilePath(sessionId, 'release'), request);
}

/** Remove `request`, unless another requester has replaced it since. Never throws. */
export function withdrawSessionReleaseRequest(sessionId: string, request: SessionReleaseRequest): void {
  const current = readLeaseFile(sessionId, 'release', parseRequest);
  if (current?.requesterPid !== request.requesterPid || current.requestedAt !== request.requestedAt) return;
  try {
    unlinkIfPresent(leaseFilePath(sessionId, 'release'));
  } catch (err) {
    log('[session-lease] removing the release request for session %s failed: %O', sessionId, err);
  }
}

/** The panel token the owner record names: the first panel holder's that has one. A writer belongs to no panel. */
function panelTokenOf(lease: Lease): string | null {
  for (const holder of lease.holders) {
    if (holder === lease.writer) continue;
    const token = holder.sessionLeasePanelToken?.() ?? null;
    if (isUuid(token)) return token;
  }
  return null;
}

/** Bring `lease`'s owner record up to date. A failed write is logged once and retried at the next poll; the lease holds either way. */
function syncOwnerRecord(sessionId: string, lease: Lease): void {
  const panelToken = panelTokenOf(lease);
  if (lease.recordedToken === panelToken) return;
  const owner: SessionLeaseOwner = { v: 1, nonce: lease.nonce, pid: process.pid, hostname: os.hostname(), panelToken, acquiredAt: lease.acquiredAt };
  try {
    writeAtomically(leaseFilePath(sessionId, 'owner'), owner);
    lease.recordedToken = panelToken;
    lease.ownerWriteFailed = false;
  } catch (err) {
    if (!lease.ownerWriteFailed) log('[session-lease] writing the owner record of session %s failed: %O', sessionId, err);
    lease.ownerWriteFailed = true;
  }
}

/** Remove `lease`'s owner record. Called while the lock is still held; a record with another nonce belongs to a process that took the lease over. */
function removeOwnerRecord(sessionId: string, lease: Lease): void {
  if (readSessionLeaseOwner(sessionId)?.nonce !== lease.nonce) return;
  try {
    unlinkIfPresent(leaseFilePath(sessionId, 'owner'));
  } catch (err) {
    log('[session-lease] removing the owner record of session %s failed: %O', sessionId, err);
  }
}

/** Hand `sessionId` over when a fresh release request names this lease. */
function answerReleaseRequest(sessionId: string, lease: Lease): void {
  // A write of this process, or a handover already under way, holds the session; the request is read again at the next poll.
  if (lease.writer || lease.handingOver) return;
  const request = readLeaseFile(sessionId, 'release', parseRequest);
  if (request?.nonce !== lease.nonce) return;
  // Either way round, so a requester on another host whose clock runs ahead is still answered.
  if (Math.abs(Date.now() - request.requestedAt) > SESSION_RELEASE_REQUEST_TTL_MS) return;
  unlinkIfPresent(leaseFilePath(sessionId, 'release'));
  lease.handingOver = true;
  log('[session-lease] process %d asked for session %s; handing it over', request.requesterPid, sessionId);
  const answers = [...lease.holders].map((holder) => holder.onSessionReleaseRequested?.(sessionId));
  void Promise.allSettled(answers).then((results) => {
    lease.handingOver = false;
    for (const result of results) {
      if (result.status === 'rejected') log('[session-lease] handing session %s over failed: %O', sessionId, result.reason);
    }
  });
}

function pollLeases(): void {
  for (const [sessionId, lease] of [...leases]) {
    if (leases.get(sessionId) !== lease) continue;
    const key = `${sessionId}.poll`;
    try {
      syncOwnerRecord(sessionId, lease);
      answerReleaseRequest(sessionId, lease);
      unreadableLogged.delete(key);
    } catch (err) {
      if (unreadableLogged.has(key)) continue;
      unreadableLogged.add(key);
      log('[session-lease] checking session %s for a release request failed: %O', sessionId, err);
    }
  }
}

/** One poll per process while it holds any lease; unref'd, so it never keeps a process alive. */
function leasesChanged(): void {
  if (leases.size > 0 && requestPoll === null) {
    requestPoll = setInterval(pollLeases, SESSION_LEASE_UPDATE_MS);
    requestPoll.unref();
  } else if (leases.size === 0 && requestPoll !== null) {
    clearInterval(requestPoll);
    requestPoll = null;
  }
}

function onCompromised(sessionId: string, lease: Lease, err: Error): void {
  if (leases.get(sessionId) !== lease) return;
  leases.delete(sessionId);
  leasesChanged();
  // The owner record is left alone: the process that took the lock over writes its own.
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
 * A process already holding it adds `holder` without touching the lock. A `writer` holder is the only one
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
    syncOwnerRecord(sessionId, held);
    return true;
  }
  fs.mkdirSync(SESSION_LEASE_DIR, { recursive: true });
  const lease: Lease = {
    release: () => undefined,
    holders: new Set([holder]),
    writer: writer ? holder : null,
    nonce: randomUUID(),
    acquiredAt: Date.now(),
    recordedToken: undefined,
    ownerWriteFailed: false,
    handingOver: false,
  };
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
  // Nothing between the lock and the map may throw, or the lock would heartbeat with no lease to release it.
  leases.set(sessionId, lease);
  leasesChanged();
  syncOwnerRecord(sessionId, lease);
  return true;
}

/** Drop `holder` from the lease on `sessionId`; the last holder out removes the owner record, then the lock. */
export function releaseSessionLease(sessionId: string, holder: SessionLeaseHolder): void {
  const lease = leases.get(sessionId);
  if (!lease || !lease.holders.delete(holder)) return;
  if (lease.writer === holder) lease.writer = null;
  if (lease.holders.size > 0) {
    syncOwnerRecord(sessionId, lease);
    return;
  }
  leases.delete(sessionId);
  leasesChanged();
  removeOwnerRecord(sessionId, lease);
  try {
    lease.release();
  } catch (err) {
    // The lock dir may already be gone (removed by hand); the lease is released either way.
    log('[session-lease] releasing the lease on session %s failed: %O', sessionId, err);
  }
}

/** Rewrite the owner record of every lease `holder` holds, after its panel token changed. */
export function refreshSessionLeaseOwners(holder: SessionLeaseHolder): void {
  for (const [sessionId, lease] of leases) if (lease.holders.has(holder)) syncOwnerRecord(sessionId, lease);
}

/** The session ids `holder` holds a lease on in this process. */
export function sessionLeasesOf(holder: SessionLeaseHolder): string[] {
  return [...leases].filter(([, lease]) => lease.holders.has(holder)).map(([sessionId]) => sessionId);
}
