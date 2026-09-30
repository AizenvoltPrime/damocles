import { fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SESSION_LEASE_STALE_MS,
  acquireSessionLease,
  releaseSessionLease,
  sessionLeaseBlocker,
  sessionLeasePath,
  sessionLeasesOf,
  type SessionLeaseHolder,
} from '../session-lease';
import { claimStoredSession } from '../../../chat-panel/session-ownership';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import type { ChatSession } from '../../../chat-session';

let workDir: string;
let childBundle: string;
const children: ChildProcess[] = [];

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-session-lease-'));
  childBundle = path.join(workDir, 'lease-holder-child.cjs');
  // The child runs the real module in a plain node process, as another Damocles window would.
  await build({
    entryPoints: [path.join(__dirname, 'fixtures', 'session-lease-holder-child.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: childBundle,
    external: ['@earendil-works/*'],
    logLevel: 'silent',
  });
});

afterEach(() => {
  vi.useRealTimers();
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
});

let nextId = 0;
const newSessionId = (): string => `0190a0e0-0000-7000-8000-${String(++nextId).padStart(12, '0')}`;

function holder(): SessionLeaseHolder & { lost: string[] } {
  const lost: string[] = [];
  return { lost, onSessionLeaseLost: (id) => lost.push(id) };
}

/** Another process holding `sessionId`'s lease; resolves once it answered whether it got it. */
async function otherWindow(sessionId: string): Promise<{ child: ChildProcess; answer: unknown; next: () => Promise<unknown> }> {
  // The child inherits this file's hermetic HOME, so both processes share one ~/.damocles.
  const child = fork(childBundle, [sessionId], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(child);
  const queue: unknown[] = [];
  const waiters: ((m: unknown) => void)[] = [];
  child.on('message', (message) => {
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  const next = (): Promise<unknown> => (queue.length > 0 ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiters.push(resolve)));
  return { child, answer: await next(), next };
}

function fakeSession(): ChatSession & { setResumeSession: ReturnType<typeof vi.fn> } {
  return { setResumeSession: vi.fn(), onSessionLeaseLost: vi.fn(), holdsSession: () => false } as unknown as ChatSession & { setResumeSession: ReturnType<typeof vi.fn> };
}

describe('session lease across processes', () => {
  it('refuses a conversation another window holds, telling the user, and binds nothing', async () => {
    const sessionId = newSessionId();
    const other = await otherWindow(sessionId);
    expect(other.answer).toBe('held');

    const platform = createFakePlatform();
    const session = fakeSession();
    const refusal = claimStoredSession(platform.notifications, new Map(), { panelId: 'p1', session }, sessionId);

    expect(refusal).toEqual({ lease: { kind: 'other-process' } });
    expect(platform.notifications.calls).toEqual([
      expect.objectContaining({ level: 'info', message: 'This conversation is open in another Damocles window.' }),
    ]);
    expect(session.setResumeSession).not.toHaveBeenCalled();
    expect(sessionLeasesOf(session)).toEqual([]);
  });

  it('lets this window take the conversation once the other one releases it', async () => {
    const sessionId = newSessionId();
    const other = await otherWindow(sessionId);
    const mine = holder();
    expect(acquireSessionLease(sessionId, mine)).toBe(false);

    other.child.send('release');
    expect(await other.next()).toBe('released');

    const platform = createFakePlatform();
    const session = fakeSession();
    expect(claimStoredSession(platform.notifications, new Map(), { panelId: 'p1', session }, sessionId)).toBeUndefined();
    expect(session.setResumeSession).toHaveBeenCalledWith(sessionId);
    releaseSessionLease(sessionId, session);
    expect(fs.existsSync(sessionLeasePath(sessionId))).toBe(false);
  });

  it('takes over from a killed holder once its lease is stale, not before', async () => {
    const sessionId = newSessionId();
    const other = await otherWindow(sessionId);
    const exited = new Promise((resolve) => other.child.once('exit', resolve));
    other.child.kill('SIGKILL');
    await exited;
    // A killed process runs no exit handler, so its lock stays behind.
    expect(fs.existsSync(sessionLeasePath(sessionId))).toBe(true);

    const mine = holder();
    expect(acquireSessionLease(sessionId, mine)).toBe(false);
    const heartbeatStopped = new Date(Date.now() - SESSION_LEASE_STALE_MS - 1_000);
    fs.utimesSync(sessionLeasePath(sessionId), heartbeatStopped, heartbeatStopped);
    expect(acquireSessionLease(sessionId, mine)).toBe(true);
    releaseSessionLease(sessionId, mine);
  });

  it('tells every holder once its lock is taken from it, and forgets the lease', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const sessionId = newSessionId();
    const first = holder();
    const second = holder();
    expect(acquireSessionLease(sessionId, first)).toBe(true);
    expect(acquireSessionLease(sessionId, second)).toBe(true);

    // Another process judged the lease stale and re-created the lock: its mtime is no longer ours.
    const taken = new Date(Date.now() + 5_000);
    fs.utimesSync(sessionLeasePath(sessionId), taken, taken);
    vi.advanceTimersByTime(2_000);

    expect(first.lost).toEqual([sessionId]);
    expect(second.lost).toEqual([sessionId]);
    expect(sessionLeasesOf(first)).toEqual([]);
    fs.rmSync(sessionLeasePath(sessionId), { recursive: true, force: true });
  });

  it('shares one lock among the panels of this process and removes it with the last holder', () => {
    const sessionId = newSessionId();
    const first = holder();
    const second = holder();
    expect(acquireSessionLease(sessionId, first)).toBe(true);
    expect(acquireSessionLease(sessionId, second)).toBe(true);
    releaseSessionLease(sessionId, first);
    expect(fs.existsSync(sessionLeasePath(sessionId))).toBe(true);
    releaseSessionLease(sessionId, first);
    expect(fs.existsSync(sessionLeasePath(sessionId))).toBe(true);
    releaseSessionLease(sessionId, second);
    expect(fs.existsSync(sessionLeasePath(sessionId))).toBe(false);
  });

  it('tells a live holder in another process from one whose heartbeat stopped, and a stale lease from both', () => {
    const sessionId = newSessionId();
    expect(sessionLeaseBlocker(sessionId)).toBeUndefined();
    // A lock left by a process that is gone: nothing refreshes its mtime.
    fs.mkdirSync(sessionLeasePath(sessionId), { recursive: true });
    try {
      expect(sessionLeaseBlocker(sessionId)).toEqual({ kind: 'other-process' });

      const stoppedAt = Date.now() - 10_000;
      fs.utimesSync(sessionLeasePath(sessionId), new Date(stoppedAt), new Date(stoppedAt));
      const stopped = sessionLeaseBlocker(sessionId);
      expect(stopped?.kind).toBe('other-process');
      const heldUntilMs = (stopped as { heldUntilMs?: number }).heldUntilMs!;
      expect(Math.abs(heldUntilMs - (stoppedAt + SESSION_LEASE_STALE_MS))).toBeLessThan(1_000);

      const staleAt = new Date(Date.now() - SESSION_LEASE_STALE_MS - 1_000);
      fs.utimesSync(sessionLeasePath(sessionId), staleAt, staleAt);
      expect(sessionLeaseBlocker(sessionId)).toBeUndefined();
    } finally {
      fs.rmSync(sessionLeasePath(sessionId), { recursive: true, force: true });
    }
  });

  it('lets no new holder join while a writer holds the lease, and keeps the holders it already had', () => {
    const sessionId = newSessionId();
    const panel = holder();
    const writer = holder();
    const latecomer = holder();
    expect(acquireSessionLease(sessionId, panel)).toBe(true);
    expect(acquireSessionLease(sessionId, writer, { writer: true })).toBe(true);

    expect(sessionLeaseBlocker(sessionId)).toEqual({ kind: 'writing' });
    expect(acquireSessionLease(sessionId, latecomer)).toBe(false);
    expect(acquireSessionLease(sessionId, holder(), { writer: true })).toBe(false);
    expect(acquireSessionLease(sessionId, panel)).toBe(true);

    releaseSessionLease(sessionId, panel);
    expect(fs.existsSync(sessionLeasePath(sessionId))).toBe(true);
    releaseSessionLease(sessionId, writer);
    expect(fs.existsSync(sessionLeasePath(sessionId))).toBe(false);
    expect(acquireSessionLease(sessionId, latecomer)).toBe(true);
    releaseSessionLease(sessionId, latecomer);
  });

  it('refuses a claim while this process writes the conversation, saying so', () => {
    const sessionId = newSessionId();
    const writer = holder();
    expect(acquireSessionLease(sessionId, writer, { writer: true })).toBe(true);
    const platform = createFakePlatform();
    const session = fakeSession();

    expect(claimStoredSession(platform.notifications, new Map(), { panelId: 'p1', session }, sessionId)).toEqual({ lease: { kind: 'writing' } });

    expect(session.setResumeSession).not.toHaveBeenCalled();
    expect(platform.notifications.calls.map((c) => c.message)).toEqual(['This conversation is being deleted or changed. Try again in a moment.']);
    releaseSessionLease(sessionId, writer);
  });

  it('refuses a claim of an unsafe id with a logged reason instead of throwing', () => {
    const platform = createFakePlatform();
    const session = fakeSession();

    const refusal = claimStoredSession(platform.notifications, new Map(), { panelId: 'p1', session }, '../escape');

    expect(refusal?.lease?.kind).toBe('unreadable');
    expect(session.setResumeSession).not.toHaveBeenCalled();
    expect(platform.notifications.calls).toEqual([expect.objectContaining({ level: 'error', message: expect.stringContaining('This conversation could not be opened') })]);
  });

  it('rejects a session id that is not a single safe path segment', () => {
    expect(() => acquireSessionLease('../escape', holder())).toThrow(/Invalid session id/);
  });
});
