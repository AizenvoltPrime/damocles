import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import type { StoredSession } from '../../../shared/types/session';
import type { FolderTarget } from '../../workspace-folders/folder-registry';
import type { HostInstance } from '../types';

const H = vi.hoisted(() => ({
  /** Session metadata per folder fsPath, as the folder's session dir holds it. */
  store: new Map<string, StoredSession[]>(),
  tmpRoot: '',
}));

vi.mock('../../logger', () => ({ log: vi.fn() }));

vi.mock('../../pi-session/session-store', async () => {
  const nodePath = await import('path');
  const nodeFs = await import('fs');
  const sessionDir = (cwd: string) => nodePath.join(H.tmpRoot, 'sessions', cwd.replace(/[\\/:]/g, '-'));
  const idFromFile = (file: string) => {
    const base = nodePath.basename(file).replace(/\.jsonl$/, '');
    return base.slice(base.indexOf('_') + 1);
  };
  const fileOf = (cwd: string, id: string) => nodePath.join(sessionDir(cwd), `0_${id}.jsonl`);
  const findByFile = (file: string) => {
    for (const [cwd, sessions] of H.store) {
      const hit = sessions.find((s) => fileOf(cwd, s.id) === file);
      if (hit) return hit;
    }
    return null;
  };
  return {
    ensurePiSessionDir: (cwd: string) => {
      const dir = sessionDir(cwd);
      nodeFs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    listPiSessions: vi.fn(async (cwd: string) => [...(H.store.get(cwd) ?? [])].sort((a, b) => b.timestamp - a.timestamp)),
    getPiSessionMetadata: vi.fn(async (cwd: string, id: string) => H.store.get(cwd)?.find((s) => s.id === id) ?? null),
    getPiSessionMetadataByFile: vi.fn(async (file: string) => findByFile(file)),
    currentCachedRow: vi.fn(async (): Promise<StoredSession | null | undefined> => undefined),
    readLiveSessionMetadata: vi.fn(() => undefined),
    forgetSessionMetadata: vi.fn(),
    flushSessionMetaCache: vi.fn(),
    piSessionIdFromFile: idFromFile,
    extractPiPromptHistory: vi.fn(async () => ['newest prompt']),
    resolvePiSessionFile: vi.fn(async (cwd: string, id: string) =>
      H.store.get(cwd)?.some((s) => s.id === id) ? fileOf(cwd, id) : null),
    fileOf,
  };
});

vi.mock('../../pi-session/checkpoints', async () => {
  const nodePath = await import('path');
  return {
    pruneOrphanCheckpointRepos: vi.fn(async () => undefined),
    getCheckpointsBaseDir: () => nodePath.join(H.tmpRoot, 'flat-checkpoints'),
    getWorkspaceCheckpointDir: (dir: string) => nodePath.join(H.tmpRoot, 'checkpoints', nodePath.basename(dir)),
  };
});

import { StorageManager } from '../storage-manager';
import * as store from '../../pi-session/session-store';
import { log } from '../../logger';
import { pruneOrphanCheckpointRepos } from '../../pi-session/checkpoints';

H.tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-storage-multi-root-'));
afterAll(() => fs.rmSync(H.tmpRoot, { recursive: true, force: true }));

const fileOf = (store as unknown as { fileOf: (cwd: string, id: string) => string }).fileOf;

const folder = (fsPath: string, label = path.basename(fsPath)): FolderTarget =>
  ({ key: fsPath.toLowerCase(), fsPath, name: path.basename(fsPath), label, projectScope: true });
const A = folder('/work/alpha');
const B = folder('/work/beta', 'beta (server)');

const session = (id: string, timestamp: number, extra: Partial<StoredSession> = {}): StoredSession =>
  ({ id, timestamp, preview: `preview ${id}`, ...extra });

type Posted = { host: unknown; message: { type: string; sessions?: StoredSession[] } };

function harness(initial: FolderTarget[], multiRoot = initial.length >= 2) {
  let folders = initial;
  const posted: Posted[] = [];
  const panels = new Map<string, HostInstance>([
    ['p1', { host: { id: 'h1' } } as unknown as HostInstance],
    ['p2', { host: { id: 'h2' } } as unknown as HostInstance],
  ]);
  const manager = new StorageManager({
    folders: () => folders,
    isMultiRoot: () => multiRoot,
    postMessage: (host, message) => posted.push({ host, message }),
    getPanels: () => panels,
    liveSession: () => undefined,
    fileWatchers: platform.fileWatchers,
  });
  const lastList = (hostId: string) =>
    [...posted].reverse().find((p) => (p.host as { id: string }).id === hostId && p.message.type === 'storedSessions')?.message.sessions;
  return {
    manager,
    posted,
    lastList,
    setFolders: (next: FolderTarget[], nextMultiRoot = next.length >= 2) => { folders = next; multiRoot = nextMultiRoot; },
  };
}

let platform: FakePlatform = createFakePlatform();

beforeEach(() => {
  H.store.clear();
  platform = createFakePlatform();
  vi.clearAllMocks();
});

describe('StorageManager: one history over every open folder', () => {
  it('merges both folders newest first and labels each session with its folder', async () => {
    H.store.set(A.fsPath, [session('a-old', 100), session('a-new', 400)]);
    H.store.set(B.fsPath, [session('b-mid', 300), session('b-old', 50)]);
    const { manager } = harness([A, B]);

    const { sessions } = await manager.getStoredSessions();

    expect(sessions.map((s) => s.id)).toEqual(['a-new', 'b-mid', 'a-old', 'b-old']);
    expect(sessions.find((s) => s.id === 'b-mid')!.workspaceFolder).toEqual({ key: B.key, label: 'beta (server)' });
    expect(sessions.find((s) => s.id === 'a-new')!.workspaceFolder).toEqual({ key: A.key, label: 'alpha' });
  });

  it('never stamps the objects the session store hands out, which its metadata cache still holds', async () => {
    const cached = session('a-1', 1);
    H.store.set(A.fsPath, [cached]);
    const { manager } = harness([A, B]);

    await manager.getStoredSessions();

    expect(cached.workspaceFolder).toBeUndefined();
  });

  it('keeps a single-folder list in the store order, reading only that folder', async () => {
    H.store.set(A.fsPath, [session('a-1', 100), session('a-2', 200), session('a-3', 150)]);
    const { manager } = harness([A]);

    const { sessions } = await manager.getStoredSessions();

    expect(sessions.map((s) => s.id)).toEqual(['a-2', 'a-3', 'a-1']);
    expect(vi.mocked(store.listPiSessions).mock.calls).toEqual([[A.fsPath]]);
  });

  it('search matches the folder label with two or more folders open', async () => {
    H.store.set(A.fsPath, [session('a-1', 100)]);
    H.store.set(B.fsPath, [session('b-1', 200), session('b-2', 150, { tag: 'urgent' })]);
    const { manager } = harness([A, B]);

    expect((await manager.searchSessions('SERVER')).sessions.map((s) => s.id)).toEqual(['b-1', 'b-2']);
    expect((await manager.searchSessions('urgent')).sessions.map((s) => s.id)).toEqual(['b-2']);
    expect((await manager.searchSessions('preview a-1')).sessions.map((s) => s.id)).toEqual(['a-1']);
  });

  it('search ignores the folder name with one folder open, where no label is shown', async () => {
    H.store.set(A.fsPath, [session('a-1', 100)]);
    const { manager } = harness([A]);

    expect((await manager.searchSessions('alpha')).sessions).toEqual([]);
  });

  it('extracts prompt history from every folder in one newest-first pass', async () => {
    H.store.set(A.fsPath, [session('a-1', 100)]);
    H.store.set(B.fsPath, [session('b-1', 200)]);
    const { manager } = harness([A, B]);

    const { history } = await manager.getPromptHistory(0);

    expect(history).toEqual(['newest prompt']);
    const [cwds, sessions] = vi.mocked(store.extractPiPromptHistory).mock.calls[0]!;
    expect(cwds).toEqual([A.fsPath, B.fsPath]);
    expect(sessions.map((s) => s.id)).toEqual(['b-1', 'a-1']);
  });

  it('prunes orphan checkpoint repos once per folder, not once per list rebuild', async () => {
    // Folders no other test lists, since earlier tests' fire-and-forget prunes can land late.
    const C = folder('/work/gamma');
    const D = folder('/work/delta');
    const scopesOf = (f: FolderTarget) =>
      vi.mocked(pruneOrphanCheckpointRepos).mock.calls.filter((c) => path.basename(c[1]!).includes(path.basename(f.fsPath)));
    H.store.set(C.fsPath, [session('c-1', 100)]);
    H.store.set(D.fsPath, [session('d-1', 200)]);
    const { manager } = harness([C, D]);

    await manager.getStoredSessions();
    manager.invalidateSessionsCache();
    await manager.getStoredSessions();
    await vi.waitFor(() => expect(scopesOf(C).length + scopesOf(D).length).toBe(2));

    expect(scopesOf(C)).toHaveLength(1);
    expect(scopesOf(D)).toHaveLength(1);
  });
});

describe('StorageManager.folderOf', () => {
  it('answers from the list index', async () => {
    H.store.set(B.fsPath, [session('b-1', 200)]);
    const { manager } = harness([A, B]);
    await manager.getStoredSessions();
    vi.mocked(store.resolvePiSessionFile).mockClear();

    expect(await manager.folderOf('b-1')).toBe(B);
    expect(store.resolvePiSessionFile).not.toHaveBeenCalled();
  });

  it('probes every open folder for an id the list has not seen yet', async () => {
    H.store.set(B.fsPath, [session('b-1', 200)]);
    const { manager } = harness([A, B]);

    expect(await manager.folderOf('b-1')).toBe(B);
    expect(vi.mocked(store.resolvePiSessionFile).mock.calls).toEqual([[A.fsPath, 'b-1'], [B.fsPath, 'b-1']]);
  });

  it('never names a folder that is no longer open, nor a session no open folder holds', async () => {
    H.store.set(B.fsPath, [session('b-1', 200)]);
    const h = harness([A, B]);
    await h.manager.getStoredSessions();

    h.setFolders([A]);

    expect(await h.manager.folderOf('b-1')).toBeUndefined();
    expect(await h.manager.folderOf('../../etc/passwd')).toBeUndefined();
  });
});

describe('StorageManager: live updates per folder', () => {
  it('watches each open folder\'s session dir', async () => {
    const { manager } = harness([A, B]);

    await manager.setupSessionWatcher();
    await manager.setupSessionWatcher(B.key);

    expect(platform.fileWatchers.watchers).toHaveLength(2);
  });

  it('a new session in another folder appears, labeled, in every panel', async () => {
    H.store.set(A.fsPath, [session('a-1', 100)]);
    const { manager, lastList } = harness([A, B]);
    await manager.getStoredSessions();

    H.store.set(B.fsPath, [session('b-new', 500)]);
    await manager.addOrUpdateSession('b-new', B.key);

    for (const hostId of ['h1', 'h2']) {
      const list = lastList(hostId)!;
      expect(list.map((s) => s.id)).toEqual(['b-new', 'a-1']);
      expect(list[0]!.workspaceFolder).toEqual({ key: B.key, label: 'beta (server)' });
    }
    expect(await manager.folderOf('b-new')).toBe(B);
  });

  it('a file created in a folder\'s session dir is listed under that folder', async () => {
    H.store.set(A.fsPath, [session('a-1', 100)]);
    const { manager, lastList } = harness([A, B]);
    await manager.getStoredSessions();
    await manager.setupSessionWatcher();
    const watcherB = platform.fileWatchers.watchers[1]!;

    H.store.set(B.fsPath, [session('b-new', 500)]);
    watcherB.fireCreate(fileOf(B.fsPath, 'b-new'));

    await vi.waitFor(() => expect(lastList('h1')?.map((s) => s.id)).toEqual(['b-new', 'a-1']));
    expect(lastList('h1')![0]!.workspaceFolder?.key).toBe(B.key);
  });

  it('removing a folder hides its sessions and stops its watcher; re-adding shows them again', async () => {
    H.store.set(A.fsPath, [session('a-1', 100)]);
    H.store.set(B.fsPath, [session('b-1', 200)]);
    const h = harness([A, B]);
    await h.manager.setupSessionWatcher();
    await h.manager.getStoredSessions();
    const watcherB = platform.fileWatchers.watchers[1]!;

    h.setFolders([A]);
    await h.manager.reloadFolders();

    expect(watcherB.disposed).toBe(true);
    expect(h.lastList('h1')!.map((s) => s.id)).toEqual(['a-1']);

    h.setFolders([A, B]);
    await h.manager.reloadFolders();

    expect(h.lastList('h2')!.map((s) => s.id)).toEqual(['b-1', 'a-1']);
    expect(platform.fileWatchers.watchers.filter((w) => !w.disposed)).toHaveLength(2);
  });

  it('an update for a folder that closed meanwhile is dropped', async () => {
    H.store.set(A.fsPath, [session('a-1', 100)]);
    H.store.set(B.fsPath, [session('b-1', 200)]);
    const h = harness([A, B]);
    await h.manager.getStoredSessions();
    h.setFolders([A]);
    await h.manager.reloadFolders();
    const before = h.posted.length;

    await h.manager.addOrUpdateSession('b-1', B.key);

    expect(h.posted.length).toBe(before);
  });
});

describe('StorageManager: one list load at a time', () => {
  it('concurrent callers share one load', async () => {
    H.store.set(A.fsPath, [session('a-1', 100)]);
    H.store.set(B.fsPath, [session('b-1', 200)]);
    const { manager } = harness([A, B]);

    const [first, second] = await Promise.all([manager.getStoredSessions(), manager.getStoredSessions(), manager.getPromptHistory(0)]);

    expect(first.sessions.map((s) => s.id)).toEqual(['b-1', 'a-1']);
    expect(second.sessions).toEqual(first.sessions);
    expect(vi.mocked(store.listPiSessions).mock.calls).toEqual([[A.fsPath], [B.fsPath]]);
  });

  it('watcher changes that land during the first load wait for it instead of starting their own', async () => {
    H.store.set(A.fsPath, [session('a-1', 100), session('a-2', 200)]);
    const { manager, lastList } = harness([A]);
    await manager.setupSessionWatcher();
    const watcher = platform.fileWatchers.watchers[0]!;
    let release!: () => void;
    vi.mocked(store.listPiSessions).mockImplementationOnce(async (cwd: string) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return [...(H.store.get(cwd) ?? [])];
    });

    const listing = manager.getStoredSessions();
    await vi.waitFor(() => expect(release).toBeDefined());
    watcher.fireCreate(fileOf(A.fsPath, 'a-1'));
    watcher.fireCreate(fileOf(A.fsPath, 'a-2'));
    await vi.waitFor(() => expect(store.getPiSessionMetadataByFile).toHaveBeenCalledTimes(2));
    release();
    await listing;

    await vi.waitFor(() => expect(lastList('h1')?.map((s) => s.id)).toEqual(['a-2', 'a-1']));
    expect(store.listPiSessions).toHaveBeenCalledTimes(1);
  });

  it('an invalidation during a load discards that load and the next call loads afresh', async () => {
    H.store.set(A.fsPath, [session('a-old', 100)]);
    const { manager } = harness([A]);
    let release!: () => void;
    vi.mocked(store.listPiSessions).mockImplementationOnce(async (cwd: string) => {
      const snapshot = [...(H.store.get(cwd) ?? [])];
      await new Promise<void>((resolve) => { release = resolve; });
      return snapshot;
    });

    const stale = manager.getStoredSessions();
    await vi.waitFor(() => expect(release).toBeDefined());
    H.store.set(A.fsPath, [session('a-new', 200)]);
    manager.invalidateSessionsCache();
    release();

    expect((await stale).sessions.map((s) => s.id)).toEqual(['a-new']);
    expect((await manager.getStoredSessions()).sessions.map((s) => s.id)).toEqual(['a-new']);
    expect(store.listPiSessions).toHaveBeenCalledTimes(2);
  });

  it('a change event for a file whose size and mtime match the cached read does nothing', async () => {
    vi.useFakeTimers();
    try {
      H.store.set(A.fsPath, [session('a-1', 100)]);
      const { manager, posted } = harness([A]);
      await manager.getStoredSessions();
      await manager.setupSessionWatcher();
      vi.mocked(store.currentCachedRow).mockResolvedValueOnce(session('a-1', 100));
      const before = posted.length;

      platform.fileWatchers.watchers[0]!.fireChange(fileOf(A.fsPath, 'a-1'));
      await vi.runAllTimersAsync();

      expect(store.currentCachedRow).toHaveBeenCalledWith(fileOf(A.fsPath, 'a-1'));
      expect(store.getPiSessionMetadataByFile).not.toHaveBeenCalled();
      expect(posted.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a change event whose cached row differs from the list row applies it without reading the file', async () => {
    vi.useFakeTimers();
    try {
      H.store.set(A.fsPath, [session('a-1', 100), session('a-2', 200)]);
      const { manager, lastList } = harness([A]);
      await manager.getStoredSessions();
      await manager.setupSessionWatcher();
      vi.mocked(store.currentCachedRow).mockResolvedValueOnce(session('a-1', 300, { messageCount: 4 }));

      platform.fileWatchers.watchers[0]!.fireChange(fileOf(A.fsPath, 'a-1'));
      await vi.runAllTimersAsync();

      expect(lastList('h1')!.map((s) => [s.id, s.messageCount])).toEqual([['a-1', 4], ['a-2', undefined]]);
      expect(store.getPiSessionMetadataByFile).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a rejected load rejects its callers, and the next call loads afresh', async () => {
    H.store.set(A.fsPath, [session('a-1', 100)]);
    const { manager } = harness([A]);
    vi.mocked(store.listPiSessions).mockRejectedValueOnce(new Error('EACCES'));

    await expect(manager.getStoredSessions()).rejects.toThrow('EACCES');
    expect((await manager.getStoredSessions()).sessions.map((s) => s.id)).toEqual(['a-1']);
  });

  it('a caller whose load was overtaken by an invalidation gets the newer load even when the old one rejects', async () => {
    H.store.set(A.fsPath, [session('a-1', 100)]);
    const { manager } = harness([A]);
    let fail: (() => void) | undefined;
    vi.mocked(store.listPiSessions).mockImplementationOnce(async () => {
      await new Promise<void>((_resolve, reject) => { fail = () => reject(new Error('EACCES')); });
      return [];
    });

    const listing = manager.getStoredSessions();
    await vi.waitFor(() => expect(fail).toBeDefined());
    manager.invalidateSessionsCache();
    fail!();

    expect((await listing).sessions.map((s) => s.id)).toEqual(['a-1']);
  });

  it('a watcher change whose load rejects is logged, not left unhandled', async () => {
    H.store.set(A.fsPath, [session('a-1', 100)]);
    const { manager } = harness([A]);
    await manager.setupSessionWatcher();
    vi.mocked(store.listPiSessions).mockRejectedValueOnce(new Error('EACCES'));

    platform.fileWatchers.watchers[0]!.fireChange(fileOf(A.fsPath, 'a-1'));

    await vi.waitFor(() => expect(vi.mocked(log).mock.calls.some(([msg]) => String(msg).includes('change upsert failed'))).toBe(true));
  });
});

describe('StorageManager: changes that land during a list load', () => {
  /** Makes the next load snapshot the store as it is now, then wait for `release`. */
  function gateNextLoad(): { started: () => boolean; release: () => void } {
    let release: (() => void) | undefined;
    vi.mocked(store.listPiSessions).mockImplementationOnce(async (cwd: string) => {
      const snapshot = [...(H.store.get(cwd) ?? [])];
      await new Promise<void>((resolve) => { release = resolve; });
      return snapshot;
    });
    return { started: () => release !== undefined, release: () => release!() };
  }

  it('an upsert read before a rename never overwrites the list loaded after it', async () => {
    H.store.set(A.fsPath, [session('a-1', 100, { customTitle: 'first' })]);
    const { manager, lastList } = harness([A]);
    const gate = gateNextLoad();
    const listing = manager.getStoredSessions();
    await vi.waitFor(() => expect(gate.started()).toBe(true));

    const upsert = manager.addOrUpdateSession('a-1', A.key);
    await vi.waitFor(() => expect(store.getPiSessionMetadata).toHaveBeenCalled());
    H.store.set(A.fsPath, [session('a-1', 100, { customTitle: 'second' })]);
    manager.invalidateSessionsCache();
    gate.release();
    await Promise.all([listing, upsert]);

    expect((await manager.getStoredSessions()).sessions.map((s) => s.customTitle)).toEqual(['second']);
    expect(lastList('h1')).toBeUndefined();
  });

  it('an upsert read before a delete does not bring the row back', async () => {
    H.store.set(A.fsPath, [session('a-1', 100), session('a-2', 200)]);
    const { manager } = harness([A]);
    const gate = gateNextLoad();
    const listing = manager.getStoredSessions();
    await vi.waitFor(() => expect(gate.started()).toBe(true));

    const upsert = manager.addOrUpdateSession('a-2', A.key);
    await vi.waitFor(() => expect(store.getPiSessionMetadata).toHaveBeenCalled());
    H.store.set(A.fsPath, [session('a-1', 100)]);
    manager.invalidateSessionsCache();
    gate.release();
    await Promise.all([listing, upsert]);

    expect((await manager.getStoredSessions()).sessions.map((s) => s.id)).toEqual(['a-1']);
  });

  it('a watcher upsert for a folder removed while it waited on the load is dropped', async () => {
    H.store.set(A.fsPath, [session('a-1', 100)]);
    const h = harness([A, B]);
    await h.manager.setupSessionWatcher();
    const watcherB = platform.fileWatchers.watchers[1]!;
    const gate = gateNextLoad();
    const listing = h.manager.getStoredSessions();
    await vi.waitFor(() => expect(gate.started()).toBe(true));

    H.store.set(B.fsPath, [session('b-new', 500)]);
    watcherB.fireCreate(fileOf(B.fsPath, 'b-new'));
    await vi.waitFor(() => expect(store.getPiSessionMetadataByFile).toHaveBeenCalled());
    h.setFolders([A]);
    await h.manager.reloadFolders();
    gate.release();
    await listing;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.lastList('h1')!.map((s) => s.id)).toEqual(['a-1']);
    expect((await h.manager.getStoredSessions()).sessions.map((s) => s.id)).toEqual(['a-1']);
  });

  it('a file deleted during a load is not listed by it', async () => {
    H.store.set(A.fsPath, [session('a-1', 100), session('a-2', 200)]);
    const { manager } = harness([A]);
    await manager.setupSessionWatcher();
    const gate = gateNextLoad();
    const listing = manager.getStoredSessions();
    await vi.waitFor(() => expect(gate.started()).toBe(true));

    H.store.set(A.fsPath, [session('a-1', 100)]);
    platform.fileWatchers.watchers[0]!.fireDelete(fileOf(A.fsPath, 'a-2'));
    gate.release();

    expect((await listing).sessions.map((s) => s.id)).toEqual(['a-1']);
  });
});
