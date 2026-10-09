import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SESSION_LEASE_DIR,
  SESSION_LEASE_STALE_MS,
  SESSION_RELEASE_REQUEST_TTL_MS,
  acquireSessionLease,
  readSessionLeaseOwner,
  refreshSessionLeaseOwners,
  releaseSessionLease,
  sessionLeaseBlocker,
  sessionLeasePath,
  sessionLeasesOf,
  type SessionLeaseHolder,
} from '../session-lease';
import { claimStoredSession, requestSessionHandoff } from '../../../chat-panel/session-ownership';
import { createSessionHandlers } from '../../../chat-panel/message-router/handlers/session-handlers';
import { createFakePlatform, type FakePlatform } from '../../../../__mocks__/fake-platform';
import type { ChatSession } from '../../../chat-session';
import type { HandlerContext, HandlerDependencies } from '../../../chat-panel/message-router/types';
import type { HostInstance } from '../../../chat-panel/types';
import type { FolderTarget } from '../../../workspace-folders/folder-registry';
import type { WebviewToExtensionMessage } from '../../../../shared/types/messages';
import { TerminalAttachmentManager } from '../../../chat-panel/terminal-attachment-manager';

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

/** Another process holding `sessionId`'s lease; resolves once it answered whether it got it. `args`: the fixture's mode and panel token. */
async function otherWindow(sessionId: string, ...args: string[]): Promise<{ child: ChildProcess; answer: unknown; next: () => Promise<unknown> }> {
  // The child inherits this file's hermetic HOME, so both processes share one ~/.damocles.
  const child = fork(childBundle, [sessionId, ...args], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
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

const ownerPath = (sessionId: string): string => path.join(SESSION_LEASE_DIR, `${sessionId}.owner`);
const requestPath = (sessionId: string): string => path.join(SESSION_LEASE_DIR, `${sessionId}.release`);
const readOwner = (sessionId: string): { nonce: string; pid: number; hostname: string; panelToken: string | null } =>
  JSON.parse(fs.readFileSync(ownerPath(sessionId), 'utf8')) as { nonce: string; pid: number; hostname: string; panelToken: string | null };

const OPEN_HERE = 'Open here';
const FOLDER: FolderTarget = { key: '/ws', fsPath: '/ws', name: 'ws', label: 'ws', projectScope: true };

/** A panel's session the way PiSession tracks its stored-session target. */
function panelSession() {
  let target: string | null = null;
  return {
    holdsSession: (id: string) => target === id,
    hasConversation: () => target !== null,
    onSessionLeaseLost: () => undefined,
    onSessionReleaseRequested: async () => undefined,
    setPanelToken: () => undefined,
    setResumeSession: (id: string | null) => { target = id; },
    initializeEarly: async () => undefined,
    onWebviewReady: () => undefined,
    getToolStatus: () => ({}),
    seedCheckpoints: () => undefined,
  };
}

/** One restored panel and the real `ready` and resume handlers around it. */
function restoringPanel(platform: FakePlatform) {
  const session = panelSession();
  const host = { id: 'host-1', reveal: vi.fn() };
  const instance = { host, session, folder: FOLDER, panelToken: null } as unknown as HostInstance;
  const panels = new Map([['host-1', instance]]);
  const loaded: string[] = [];
  const deps = {
    platform,
    getPanels: () => panels,
    switchPanelFolder: async (_panelId: string, _key: string, _reason: string, afterSwitch?: (i: HostInstance) => Promise<void>) => {
      await afterSwitch?.(instance);
      return instance;
    },
    postWorkspaceFolderState: () => undefined,
    folderRegistry: { resolve: (key: string) => (key === FOLDER.key ? FOLDER : undefined) },
    postMessage: () => undefined,
    historyManager: { loadSessionHistory: async (_cwd: string, id: string) => { loaded.push(id); return []; } },
    storageManager: {
      folderOf: async () => FOLDER,
      getStoredSessions: async () => ({ sessions: [], hasMore: false, nextOffset: 0 }),
      getPromptHistory: async () => ({ history: [], hasMore: false }),
    },
    settingsManager: {
      sendCurrentSettings: async () => undefined,
      sendAvailableModels: () => undefined,
      sendImageGenerationSettings: () => undefined,
      sendMcpConfig: () => undefined,
      sendModelForPanel: () => undefined,
      sendThinkingForPanel: () => undefined,
    },
    getLanguagePreference: () => 'en',
    webviewPrompts: { repost: () => undefined },
  } as unknown as HandlerDependencies;
  const ctx = { host, session, panelId: 'host-1', permissionHandler: {}, terminalAttachments: new TerminalAttachmentManager(() => {}), folder: FOLDER } as unknown as HandlerContext;
  const ready = (savedSessionId: string, panelToken: string): Promise<void> =>
    Promise.resolve(createSessionHandlers(deps).ready!({ type: 'ready', savedSessionId, panelToken } as WebviewToExtensionMessage, ctx));
  return { session, ready, loaded };
}

describe('a conversation a live process with no window holds', () => {
  it('a restore by the panel that held it takes it over in the background, with no toast', async () => {
    const sessionId = newSessionId();
    const token = randomUUID();
    const other = await otherWindow(sessionId, 'windowless', token);
    expect(other.answer).toBe('held');
    const platform = createFakePlatform();
    const panel = restoringPanel(platform);

    await panel.ready(sessionId, token);

    expect(await other.next()).toBe('handed-off');
    await vi.waitFor(() => expect(sessionLeasesOf(panel.session)).toEqual([sessionId]), { timeout: 5_000 });
    expect(panel.loaded).toEqual([sessionId]);
    expect(platform.notifications.calls).toEqual([]);
    releaseSessionLease(sessionId, panel.session);
  }, 15_000);

  it('a restore by another panel is refused with the choice to open it here, and asks nothing yet', async () => {
    const sessionId = newSessionId();
    await otherWindow(sessionId, 'windowless', randomUUID());
    const platform = createFakePlatform();
    const panel = restoringPanel(platform);

    await panel.ready(sessionId, randomUUID());

    expect(platform.notifications.calls).toEqual([expect.objectContaining({ level: 'info', actions: [OPEN_HERE] })]);
    expect(fs.existsSync(requestPath(sessionId))).toBe(false);
    expect(sessionLeaseBlocker(sessionId)).toEqual({ kind: 'other-process' });
    expect(sessionLeasesOf(panel.session)).toEqual([]);
  });

  it('choosing Open here takes it over from the other process and opens it in the refused panel', async () => {
    const sessionId = newSessionId();
    const other = await otherWindow(sessionId, 'windowless', randomUUID());
    const platform = createFakePlatform();
    platform.notifications.answerWith((call) => (call.actions.includes(OPEN_HERE) ? OPEN_HERE : undefined));
    const panel = restoringPanel(platform);

    await panel.ready(sessionId, randomUUID());

    expect(await other.next()).toBe('handed-off');
    await vi.waitFor(() => expect(sessionLeasesOf(panel.session)).toEqual([sessionId]), { timeout: 5_000 });
    expect(panel.loaded).toEqual([sessionId]);
    expect(fs.existsSync(requestPath(sessionId))).toBe(false);
    releaseSessionLease(sessionId, panel.session);
  }, 15_000);

  it('the holder records who it is beside the lock, and acts only on a fresh request naming its own lease', async () => {
    const sessionId = newSessionId();
    const token = randomUUID();
    const other = await otherWindow(sessionId, 'windowless', token);
    const owner = readOwner(sessionId);
    expect(owner).toMatchObject({ v: 1, pid: other.child.pid, hostname: os.hostname(), panelToken: token });
    // proper-lockfile removes the lock dir with rmdir, so nothing may sit inside it.
    expect(fs.readdirSync(sessionLeasePath(sessionId))).toEqual([]);

    const ask = (request: object): void => fs.writeFileSync(requestPath(sessionId), JSON.stringify(request));
    const holderPolled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2_500));
    ask({ v: 1, nonce: randomUUID(), requestedAt: Date.now(), requesterPid: process.pid });
    await holderPolled();
    expect(sessionLeaseBlocker(sessionId)).toEqual({ kind: 'other-process' });

    ask({ v: 1, nonce: owner.nonce, requestedAt: Date.now() - 60_000, requesterPid: process.pid });
    await holderPolled();
    expect(sessionLeaseBlocker(sessionId)).toEqual({ kind: 'other-process' });

    ask({ v: 1, nonce: owner.nonce, requestedAt: Date.now(), requesterPid: process.pid });
    expect(await other.next()).toBe('handed-off');
    expect(sessionLeaseBlocker(sessionId)).toBeUndefined();
    expect(fs.existsSync(ownerPath(sessionId))).toBe(false);
    expect(fs.existsSync(requestPath(sessionId))).toBe(false);
  }, 15_000);

  it('a holder that never answers is waited for until the request expires, then the restore is refused with the choice', async () => {
    const sessionId = newSessionId();
    const token = randomUUID();
    await otherWindow(sessionId, 'old');
    // Left by an earlier holder that crashed; the old release holding the lock now never reads requests.
    fs.writeFileSync(ownerPath(sessionId), JSON.stringify({ v: 1, nonce: randomUUID(), pid: 1, hostname: os.hostname(), panelToken: token, acquiredAt: Date.now() - 60_000 }));
    const platform = createFakePlatform();
    const panel = restoringPanel(platform);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await panel.ready(sessionId, token);
    expect(platform.notifications.calls).toEqual([]);
    expect(fs.existsSync(requestPath(sessionId))).toBe(true);
    await vi.advanceTimersByTimeAsync(25_000);

    expect(platform.notifications.calls).toEqual([expect.objectContaining({ level: 'info', actions: [OPEN_HERE] })]);
    expect(fs.existsSync(requestPath(sessionId))).toBe(false);
    expect(sessionLeasesOf(panel.session)).toEqual([]);
    fs.rmSync(ownerPath(sessionId), { force: true });
  });
});

describe('the owner record and release requests of a lease this process holds', () => {
  /** A panel's session as the lease sees it: its token, and a handover the test settles. */
  function panelHolder(token: string | null) {
    const asked: string[] = [];
    let settle: () => void = () => undefined;
    const holder = {
      token,
      asked,
      lost: [] as string[],
      onSessionLeaseLost: (id: string) => { holder.lost.push(id); },
      onSessionReleaseRequested: (id: string) => {
        asked.push(id);
        return new Promise<void>((resolve) => { settle = resolve; });
      },
      sessionLeasePanelToken: () => holder.token,
      settle: () => settle(),
    };
    return holder;
  }
  const ask = (sessionId: string, nonce: string, requestedAt = Date.now()): void =>
    fs.writeFileSync(requestPath(sessionId), JSON.stringify({ v: 1, nonce, requestedAt, requesterPid: 4242 }));

  it('names the panel token, follows it, keeps the lock dir empty, and goes when the lease does', () => {
    const sessionId = newSessionId();
    const first = randomUUID();
    const panel = panelHolder(first);
    expect(acquireSessionLease(sessionId, panel)).toBe(true);
    const owner = readOwner(sessionId);
    expect(owner).toEqual({ v: 1, nonce: expect.stringMatching(/^[0-9a-f-]{36}$/), pid: process.pid, hostname: os.hostname(), panelToken: first, acquiredAt: expect.any(Number) });
    expect(fs.readdirSync(sessionLeasePath(sessionId))).toEqual([]);

    panel.token = randomUUID();
    refreshSessionLeaseOwners(panel);
    expect(readOwner(sessionId)).toMatchObject({ nonce: owner.nonce, panelToken: panel.token });
    // A writer belongs to no panel, so joining changes nothing the record says.
    const writer = holder();
    expect(acquireSessionLease(sessionId, writer, { writer: true })).toBe(true);
    expect(readOwner(sessionId).panelToken).toBe(panel.token);
    releaseSessionLease(sessionId, panel);
    expect(readOwner(sessionId).panelToken).toBeNull();

    releaseSessionLease(sessionId, writer);
    expect(fs.existsSync(ownerPath(sessionId))).toBe(false);
    expect(fs.existsSync(sessionLeasePath(sessionId))).toBe(false);
    expect(fs.readdirSync(SESSION_LEASE_DIR).filter((name) => name.startsWith(sessionId))).toEqual([]);
  });

  it('a fresh acquisition gets a fresh nonce', () => {
    const sessionId = newSessionId();
    const panel = panelHolder(null);
    acquireSessionLease(sessionId, panel);
    const first = readOwner(sessionId).nonce;
    releaseSessionLease(sessionId, panel);
    acquireSessionLease(sessionId, panel);
    expect(readOwner(sessionId).nonce).not.toBe(first);
    releaseSessionLease(sessionId, panel);
  });

  it('on release leaves alone a record another process wrote since', () => {
    const sessionId = newSessionId();
    const panel = panelHolder(null);
    acquireSessionLease(sessionId, panel);
    const theirs = { v: 1, nonce: randomUUID(), pid: 4242, hostname: 'elsewhere', panelToken: null, acquiredAt: Date.now() };
    fs.writeFileSync(ownerPath(sessionId), JSON.stringify(theirs));

    releaseSessionLease(sessionId, panel);

    expect(readOwner(sessionId)).toEqual(theirs);
    fs.rmSync(ownerPath(sessionId));
  });

  it('a lease taken from this process leaves the owner record to the process that took it', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const sessionId = newSessionId();
    const panel = panelHolder(null);
    acquireSessionLease(sessionId, panel);
    const recorded = fs.readFileSync(ownerPath(sessionId), 'utf8');
    const taken = new Date(Date.now() + 5_000);
    fs.utimesSync(sessionLeasePath(sessionId), taken, taken);
    vi.advanceTimersByTime(2_000);

    expect(panel.lost).toEqual([sessionId]);
    expect(fs.readFileSync(ownerPath(sessionId), 'utf8')).toBe(recorded);
    fs.rmSync(sessionLeasePath(sessionId), { recursive: true, force: true });
    fs.rmSync(ownerPath(sessionId));
  });

  it('defers a request while a writer holds the lease, then asks every holder once, and once only while they answer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const sessionId = newSessionId();
    const panel = panelHolder(randomUUID());
    const writer = holder();
    acquireSessionLease(sessionId, panel);
    acquireSessionLease(sessionId, writer, { writer: true });
    const { nonce } = readOwner(sessionId);

    ask(sessionId, nonce);
    vi.advanceTimersByTime(2_000);
    expect(panel.asked).toEqual([]);
    expect(fs.existsSync(requestPath(sessionId))).toBe(true);

    releaseSessionLease(sessionId, writer);
    vi.advanceTimersByTime(2_000);
    expect(panel.asked).toEqual([sessionId]);
    expect(fs.existsSync(requestPath(sessionId))).toBe(false);

    ask(sessionId, nonce);
    vi.advanceTimersByTime(4_000);
    expect(panel.asked).toEqual([sessionId]);

    panel.settle();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(panel.asked).toEqual([sessionId, sessionId]);
    releaseSessionLease(sessionId, panel);
  });

  it('polls only while this process holds a lease', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const sessionId = newSessionId();
    const panel = panelHolder(null);
    expect(vi.getTimerCount()).toBe(0);
    acquireSessionLease(sessionId, panel);
    acquireSessionLease(newSessionId(), panel);
    expect(vi.getTimerCount()).toBe(1);
    for (const id of sessionLeasesOf(panel)) releaseSessionLease(id, panel);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads a malformed, oversized or foreign owner record as no record, never throwing', () => {
    const sessionId = newSessionId();
    const valid = { v: 1, nonce: randomUUID(), pid: 4242, hostname: 'h', panelToken: null, acquiredAt: 1 };
    fs.mkdirSync(SESSION_LEASE_DIR, { recursive: true });
    for (const bad of [
      '{',
      JSON.stringify({ ...valid, v: 2 }),
      JSON.stringify({ ...valid, nonce: '../../etc' }),
      JSON.stringify({ ...valid, pid: 1.5 }),
      JSON.stringify({ ...valid, hostname: 'h'.repeat(256) }),
      JSON.stringify({ ...valid, panelToken: 'X' }),
      JSON.stringify({ ...valid, acquiredAt: 'yesterday' }),
      JSON.stringify({ ...valid, pad: 'x'.repeat(2_000) }),
    ]) {
      fs.writeFileSync(ownerPath(sessionId), bad);
      expect(readSessionLeaseOwner(sessionId)).toBeUndefined();
    }
    fs.writeFileSync(ownerPath(sessionId), JSON.stringify(valid));
    expect(readSessionLeaseOwner(sessionId)).toEqual(valid);
    fs.rmSync(ownerPath(sessionId));
    expect(readSessionLeaseOwner(sessionId)).toBeUndefined();
    expect(readSessionLeaseOwner('../escape')).toBeUndefined();
  });

  it('a requester waiting on a holder that never answers gets timeout and removes its request', async () => {
    const sessionId = newSessionId();
    await otherWindow(sessionId, 'old');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const result = requestSessionHandoff(sessionId, randomUUID());
    expect(fs.existsSync(requestPath(sessionId))).toBe(true);
    await vi.advanceTimersByTimeAsync(SESSION_RELEASE_REQUEST_TTL_MS);

    await expect(result).resolves.toBe('timeout');
    expect(fs.existsSync(requestPath(sessionId))).toBe(false);
  });
});
