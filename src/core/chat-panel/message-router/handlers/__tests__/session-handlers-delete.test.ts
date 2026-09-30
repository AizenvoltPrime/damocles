import * as fs from 'node:fs';
import * as lockfile from 'proper-lockfile';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSessionHandlers } from '../session-handlers';
import { createFakePlatform, type FakePlatform } from '../../../../../__mocks__/fake-platform';
import { SESSION_LEASE_DIR, sessionLeasePath } from '../../../../pi-session/session-store/session-lease';
import { claimStoredSession, type ClaimRefusal } from '../../../session-ownership';
import type { ChatSession } from '../../../../chat-session';

const H = vi.hoisted(() => {
  const order: string[] = [];
  const mutators = new Map<string, { detachFromDeletedSession: () => Promise<void> }>();
  return { order, mutators };
});

vi.mock('../../../../pi-session/session-store', () => ({
  renamePiSession: vi.fn(),
  tagPiSession: vi.fn(),
  deletePiSession: vi.fn(async (cwd: string) => { H.order.push(cwd === '/ws' ? 'rm-file' : `rm-file:${cwd}`); }),
}));

vi.mock('../../../../pi-session/pi-runtime', () => ({
  PiRuntime: { liveSessionMutator: (id: string) => H.mutators.get(id) },
}));

vi.mock('../../../../logger', () => ({ log: vi.fn() }));

/**
 * Deleting a session must stop every live writer for it FIRST. pi's SessionManager keeps
 * `flushed = true` after its first write, so any append that lands after the `rm` is a bare
 * `appendFileSync` that recreates the path as a header-less one-entry file — permanently unparseable,
 * permanently invisible to the picker, and it re-logs on every list rebuild. The owning panel is found
 * by session id (like rename/tag), because the panel issuing the delete is often not the one holding
 * the session.
 */
describe('deleteSession — detaches the owning writer before removing the file', () => {
  beforeEach(() => {
    H.order.length = 0;
    H.mutators.clear();
  });

  /** Records only once its promise SETTLES, so a `void`-ed (un-awaited) detach orders after the rm. */
  function registerOwner(sessionId: string): { detached: () => number } {
    let count = 0;
    H.mutators.set(sessionId, {
      detachFromDeletedSession: async () => {
        await new Promise((r) => setTimeout(r, 0));
        count++;
        H.order.push(`detach:${sessionId}`);
      },
    });
    return { detached: () => count };
  }

  type OtherPanel = { panelId: string; holding: string };

  let platform: FakePlatform;

  function harness(thisPanelSessionId: string | null, opts: { others?: OtherPanel[]; sessionFolder?: string; recordLookup?: boolean } = {}) {
    platform = createFakePlatform();
    const session = {
      persistenceSessionId: thisPanelSessionId,
      holdsSession: (id: string) => id === thisPanelSessionId,
      detachFromDeletedSession: async () => {
        await new Promise((r) => setTimeout(r, 0));
        H.order.push('detach:this-panel');
      },
    };
    const panels = new Map<string, unknown>([['p1', { session }]]);
    for (const other of opts.others ?? []) {
      panels.set(other.panelId, {
        session: {
          holdsSession: (id: string) => id === other.holding,
          detachFromDeletedSession: async () => {
            await new Promise((r) => setTimeout(r, 0));
            H.order.push(`detach:${other.panelId}`);
          },
        },
      });
    }
    const sessionFolder = opts.sessionFolder;
    const deps = {
      postMessage: () => undefined,
      getPanels: () => panels,
      storageManager: {
        folderOf: async () => {
          if (opts.recordLookup) H.order.push('folder-lookup');
          return sessionFolder ? { key: sessionFolder, fsPath: sessionFolder } : undefined;
        },
        invalidateSessionsCache: () => undefined,
        getStoredSessions: async () => ({ sessions: [], hasMore: false, nextOffset: 0 }),
      },
      settingsManager: {},
      getLanguagePreference: () => 'en',
      platform,
    } as unknown as Parameters<typeof createSessionHandlers>[0];
    const ctx = { folder: { key: '/ws', fsPath: '/ws', name: 'ws', label: 'ws', projectScope: true }, session, host: {}, panelId: 'p1', permissionHandler: {} } as never;
    return { deps, ctx };
  }

  async function runDelete(thisPanelSessionId: string | null, target: string, opts: Parameters<typeof harness>[1] = {}): Promise<void> {
    const { deps, ctx } = harness(thisPanelSessionId, opts);
    await createSessionHandlers(deps).deleteSession!({ type: 'deleteSession', sessionId: target } as never, ctx);
  }

  it('detaches the panel that owns the session even when the delete came from another panel', async () => {
    const owner = registerOwner('sess-live-elsewhere');
    // This panel holds a DIFFERENT session, so an owner check based on its own id would find nothing
    // and leave the other panel writing into the deleted path.
    await runDelete('sess-mine', 'sess-live-elsewhere');

    expect(owner.detached()).toBe(1);
    expect(H.order).toEqual(['detach:sess-live-elsewhere', 'rm-file']);
  });

  it('waits for the detach to COMPLETE before the rm, not merely to be called', async () => {
    // The invariant is completion order: a fire-and-forget detach still "runs first" but leaves the
    // old manager writable across the rm. The fakes settle on a later tick, so dropping the await
    // reorders these entries.
    registerOwner('sess-1');
    await runDelete('sess-mine', 'sess-1');
    expect(H.order).toEqual(['detach:sess-1', 'rm-file']);
  });

  it('detaches BOTH holders when the registry winner is not the panel issuing the delete', async () => {
    // Two panels resuming one file share a header-derived session id, and the mutator registry is a
    // Map — so the second registrant displaces the first. Detaching only the registry entry leaves the
    // displaced panel live on the removed path.
    const registered = registerOwner('sess-shared');
    await runDelete('sess-shared', 'sess-shared');

    expect(registered.detached()).toBe(1);
    expect(H.order.filter((e) => e.startsWith('detach:')).sort())
      .toEqual(['detach:sess-shared', 'detach:this-panel']);
    expect(H.order[H.order.length - 1]).toBe('rm-file');
  });

  it('does NOT delete the file when a holder cannot let go', async () => {
    // A failed replacement means the old session is still installed and still writable. Removing the
    // file anyway is the exact corruption this handler exists to prevent.
    H.mutators.set('sess-stuck', {
      detachFromDeletedSession: async () => { throw new Error('session replacement was cancelled'); },
    });
    await runDelete('sess-other', 'sess-stuck');
    expect(H.order).not.toContain('rm-file');
  });

  it('falls back to this panel when it only points at the session and never started it', async () => {
    // No mutator is registered until start(), but the panel still has the session as its resume
    // target — it must not go on to resume a file that is about to be deleted.
    await runDelete('sess-pending', 'sess-pending');
    expect(H.order).toEqual(['detach:this-panel', 'rm-file']);
  });

  it('deletes a session no panel holds without detaching anything', async () => {
    await runDelete('sess-mine', 'sess-cold');
    expect(H.order).toEqual(['rm-file']);
  });

  it('detaches another panel that only points at the session as its resume target', async () => {
    // No mutator is registered before start(), so only the panel map knows this panel would go on to
    // open the file being removed.
    await runDelete('sess-mine', 'sess-pending', { others: [{ panelId: 'p2', holding: 'sess-pending' }] });
    expect(H.order).toEqual(['detach:p2', 'rm-file']);
  });

  it("removes the session from its own folder's store when the panel is on another folder", async () => {
    await runDelete('sess-mine', 'sess-b', { sessionFolder: '/work/beta' });
    expect(H.order).toEqual(['rm-file:/work/beta']);
  });

  it('looks up the session folder before detaching, so no await separates the detach from the rm', async () => {
    registerOwner('sess-1');
    await runDelete('sess-mine', 'sess-1', { recordLookup: true });
    expect(H.order).toEqual(['folder-lookup', 'detach:sess-1', 'rm-file']);
  });

  // Another process still writing the conversation would recreate the removed file on its next append.
  it('refuses to delete a session another process holds, before detaching anything', async () => {
    registerOwner('sess-held-elsewhere');
    fs.mkdirSync(SESSION_LEASE_DIR, { recursive: true });
    const lease = sessionLeasePath('sess-held-elsewhere');
    const release = lockfile.lockSync(lease, { lockfilePath: lease, realpath: false });
    try {
      await runDelete('sess-mine', 'sess-held-elsewhere');
    } finally {
      release();
    }
    expect(H.order).toEqual([]);
    expect(platform.notifications.calls.map((c) => c.message)).toEqual(['This conversation is open in another Damocles window.']);
  });

  it('holds the lease across the detach and the rm, and releases it after', async () => {
    const lease = sessionLeasePath('sess-cold');
    const leaseHeld: boolean[] = [];
    const { deletePiSession } = await import('../../../../pi-session/session-store');
    vi.mocked(deletePiSession).mockImplementationOnce(async () => {
      leaseHeld.push(fs.existsSync(lease));
      return { refsDeleted: Promise.resolve() };
    });
    await runDelete('sess-mine', 'sess-cold');
    expect(leaseHeld).toEqual([true]);
    expect(fs.existsSync(lease)).toBe(false);
  });

  // Another panel of this window claiming the session between the detach and the rm would resume the
  // file and append to it after it is gone.
  it('refuses a claim from another panel of this window while the delete detaches and removes the file', async () => {
    const claimer = { setResumeSession: vi.fn(), onSessionLeaseLost: vi.fn(), holdsSession: () => false } as unknown as ChatSession & { setResumeSession: ReturnType<typeof vi.fn> };
    const claimerPlatform = createFakePlatform();
    const claims: Array<ClaimRefusal | undefined> = [];
    const claim = (): void => {
      claims.push(claimStoredSession(claimerPlatform.notifications, new Map(), { panelId: 'p9', session: claimer }, 'sess-racing'));
    };
    H.mutators.set('sess-racing', {
      detachFromDeletedSession: async () => {
        await new Promise((r) => setTimeout(r, 0));
        claim();
        H.order.push('detach:sess-racing');
      },
    });
    const { deletePiSession } = await import('../../../../pi-session/session-store');
    vi.mocked(deletePiSession).mockImplementationOnce(async () => {
      claim();
      H.order.push('rm-file');
      return { refsDeleted: Promise.resolve() };
    });

    await runDelete('sess-mine', 'sess-racing');

    expect(H.order).toEqual(['detach:sess-racing', 'rm-file']);
    expect(claims).toEqual([{ lease: { kind: 'writing' } }, { lease: { kind: 'writing' } }]);
    expect(claimer.setResumeSession).not.toHaveBeenCalled();
    expect(fs.existsSync(sessionLeasePath('sess-racing'))).toBe(false);
  });

  it('refuses a second delete of the same conversation while the first one runs', async () => {
    let second: Promise<void> | undefined;
    const { deletePiSession } = await import('../../../../pi-session/session-store');
    vi.mocked(deletePiSession).mockImplementationOnce(async () => {
      second = runDelete('sess-mine', 'sess-twice');
      await second;
      H.order.push('rm-file');
      return { refsDeleted: Promise.resolve() };
    });

    await runDelete('sess-mine', 'sess-twice');

    expect(H.order).toEqual(['rm-file']);
    expect(platform.notifications.calls.map((c) => c.message)).toEqual(['This conversation is being deleted or changed. Try again in a moment.']);
  });
});
