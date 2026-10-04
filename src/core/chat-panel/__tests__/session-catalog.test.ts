import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as lockfile from 'proper-lockfile';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import { StorageManager, type StoredSessionsChange } from '../storage-manager';
import { createSessionCatalog, MAX_SESSION_NAME_CHARS, MAX_SESSION_TAG_CHARS, type SessionCatalog } from '../session-catalog';
import type { HostInstance } from '../types';
import type { FolderTarget } from '../../workspace-folders/folder-registry';
import { ensurePiSessionDir } from '../../pi-session/session-store/session-dir';
import { initPiLoader } from '../../pi-session/pi-loader';
import { DAMOCLES_TAG_ENTRY, DAMOCLES_USER_RENAMED_ENTRY } from '../../pi-session/session-store/constants';
import { SESSION_LEASE_DIR, sessionLeasePath } from '../../pi-session/session-store/session-lease';
import { deletePiSession, renamePiSession, tagPiSession } from '../../pi-session/session-store';
import type { LiveSessionMutator } from '../../pi-session/pi-runtime';

const H = vi.hoisted(() => ({ order: [] as string[], mutators: new Map<string, unknown>() }));

vi.mock('../../pi-session/pi-runtime', () => ({ PiRuntime: { liveSessionMutator: (id: string) => H.mutators.get(id) } }));
vi.mock('../../logger', () => ({ log: vi.fn() }));
// The real file writers, observed: which path a mutation took, and when the rm ran relative to the detaches.
vi.mock('../../pi-session/session-store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../pi-session/session-store')>();
  return {
    ...real,
    renamePiSession: vi.fn(real.renamePiSession),
    tagPiSession: vi.fn(real.tagPiSession),
    deletePiSession: vi.fn(async (cwd: string, id: string) => {
      H.order.push('rm');
      return real.deletePiSession(cwd, id);
    }),
  };
});

const folder = (name: string): FolderTarget => {
  const fsPath = path.join(os.homedir(), 'session-catalog', name);
  return { key: fsPath, fsPath, name, label: name, projectScope: true };
};
const ALPHA = folder('alpha');
const BETA = folder('beta');

const ID_OLD = '01a0e000-0000-7000-8000-0000000000a1';
const ID_NEW = '01a0e000-0000-7000-8000-0000000000a2';
const ID_BETA = '01a0e000-0000-7000-8000-0000000000b1';

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

/** A stored conversation: one prompt and one reply from `claude-opus-4-8`, last active at `at`. */
function writeSession(target: FolderTarget, id: string, prompt: string, at: string): string {
  const file = path.join(ensurePiSessionDir(target.fsPath), `${at.replace(/[:.]/g, '-')}_${id}.jsonl`);
  fs.writeFileSync(file,
    line({ type: 'session', version: 3, id, timestamp: at, cwd: target.fsPath })
    + line({ type: 'message', id: 'u1', parentId: null, timestamp: at, message: { role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.parse(at) } })
    + line({ type: 'message', id: 'a1', parentId: 'u1', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], provider: 'anthropic', model: 'claude-opus-4-8', timestamp: Date.parse(at) } }));
  return file;
}

/** A panel's session as the catalog sees it: what it holds, and a detach that settles a tick later. */
function panelHolding(name: string, held: string | null): HostInstance {
  return {
    session: {
      holdsSession: (id: string) => id === held,
      detachFromDeletedSession: async () => {
        await new Promise((r) => setTimeout(r, 0));
        H.order.push(`detach:${name}`);
      },
    },
  } as unknown as HostInstance;
}

/** A live chat on `file`, writing through its own pi SessionManager the way `PiSession`'s mutators do. */
async function liveChatOn(file: string, name = 'live'): Promise<LiveSessionMutator> {
  const pi = (await initPiLoader())!;
  const sm = pi.SessionManager.open(file, path.dirname(file));
  return {
    renameActiveSession: async (newName: string) => {
      sm.appendSessionInfo(newName);
      sm.appendCustomEntry(DAMOCLES_USER_RENAMED_ENTRY);
    },
    setActiveSessionTag: async (tag: string | null) => { sm.appendCustomEntry(DAMOCLES_TAG_ENTRY, { tag }); },
    detachFromDeletedSession: async () => {
      await new Promise((r) => setTimeout(r, 0));
      H.order.push(`detach:${name}`);
    },
    liveSessionFile: () => undefined,
    storedMetadata: () => null,
    publishAccountInfo: () => undefined,
  };
}

let platform: FakePlatform;
let panels: Map<string, HostInstance>;
let storage: StorageManager;
let catalog: SessionCatalog;
let changes: StoredSessionsChange[];
let oldFile: string;
let newFile: string;

beforeEach(() => {
  H.order.length = 0;
  H.mutators.clear();
  vi.mocked(renamePiSession).mockClear();
  vi.mocked(tagPiSession).mockClear();
  vi.mocked(deletePiSession).mockClear();
  for (const target of [ALPHA, BETA]) fs.rmSync(ensurePiSessionDir(target.fsPath), { recursive: true, force: true });
  oldFile = writeSession(ALPHA, ID_OLD, 'older question', '2026-01-01T09:00:00.000Z');
  newFile = writeSession(ALPHA, ID_NEW, 'newer question', '2026-01-02T09:00:00.000Z');
  writeSession(BETA, ID_BETA, 'beta question', '2026-01-03T09:00:00.000Z');

  platform = createFakePlatform();
  panels = new Map();
  storage = new StorageManager({
    folders: () => [ALPHA, BETA],
    isMultiRoot: () => true,
    postMessage: () => undefined,
    getPanels: () => panels,
    liveSession: () => undefined,
    fileWatchers: platform.fileWatchers,
  });
  catalog = createSessionCatalog({ storage, getPanels: () => panels, notifications: platform.notifications });
  changes = [];
  catalog.onDidChange((change) => changes.push(change));
});

afterEach(() => {
  storage.dispose();
});

const row = async (id: string) => (await catalog.list(ALPHA.key)).find((s) => s.id === id);

describe('SessionCatalog listing', () => {
  it("lists one open folder's sessions, complete and newest first, each with its model", async () => {
    const listed = await catalog.list(ALPHA.key);

    expect(listed.map((s) => s.id)).toEqual([ID_NEW, ID_OLD]);
    expect(listed[0]).toMatchObject({ model: { provider: 'anthropic', id: 'claude-opus-4-8' }, workspaceFolder: { key: ALPHA.key } });
    expect(await catalog.list('not-an-open-folder')).toEqual([]);
  });

  it('searches titles and tags within the folder only, and a blank query lists', async () => {
    expect((await catalog.search(ALPHA.key, 'OLDER')).map((s) => s.id)).toEqual([ID_OLD]);
    expect((await catalog.search(ALPHA.key, 'beta')).map((s) => s.id)).toEqual([]);
    expect((await catalog.search(ALPHA.key, '  ')).map((s) => s.id)).toEqual([ID_NEW, ID_OLD]);
  });
});

describe('SessionCatalog rename and tag', () => {
  it('a conversation no chat holds: written to its file under the lease, and announced', async () => {
    expect(await catalog.rename(ID_OLD, '  Old work  ')).toEqual({ ok: true });
    expect(await catalog.tag(ID_OLD, 'api')).toEqual({ ok: true });

    expect(renamePiSession).toHaveBeenCalledWith(ALPHA.fsPath, ID_OLD, 'Old work');
    expect(tagPiSession).toHaveBeenCalledWith(ALPHA.fsPath, ID_OLD, 'api');
    expect(await row(ID_OLD)).toMatchObject({ customTitle: 'Old work', tag: 'api' });
    expect(changes).toEqual([{ projectKey: ALPHA.key }, { projectKey: ALPHA.key }]);
  });

  // A second writer on a live conversation forks its branch, so the live chat writes and the file follows from it.
  it('a conversation a live chat holds: reaches the live chat and, through it, the session file, with no second writer', async () => {
    H.mutators.set(ID_NEW, await liveChatOn(newFile));

    expect(await catalog.rename(ID_NEW, 'Live work')).toEqual({ ok: true });
    expect(await catalog.tag(ID_NEW, 'wip')).toEqual({ ok: true });

    expect(renamePiSession).not.toHaveBeenCalled();
    expect(tagPiSession).not.toHaveBeenCalled();
    const written = fs.readFileSync(newFile, 'utf8');
    expect(written).toContain('Live work');
    expect(written).toContain('"tag":"wip"');
    expect(await row(ID_NEW)).toMatchObject({ customTitle: 'Live work', tag: 'wip' });
    expect(changes).toEqual([{ projectKey: ALPHA.key }, { projectKey: ALPHA.key }]);
  });

  it('removing a tag clears it from the file and the list', async () => {
    await catalog.tag(ID_OLD, 'api');
    expect(await catalog.tag(ID_OLD, null)).toEqual({ ok: true });

    expect((await row(ID_OLD))?.tag).toBeUndefined();
  });

  it('refuses a name or tag outside its bounds, or not a string, before touching anything', async () => {
    const tooLong = (n: number): string => 'x'.repeat(n + 1);
    const refusals = [
      await catalog.rename(ID_OLD, '   '),
      await catalog.rename(ID_OLD, tooLong(MAX_SESSION_NAME_CHARS)),
      await catalog.rename(ID_OLD, 42 as unknown as string),
      await catalog.tag(ID_OLD, ''),
      await catalog.tag(ID_OLD, tooLong(MAX_SESSION_TAG_CHARS)),
      await catalog.tag(ID_OLD, {} as unknown as string),
    ];

    expect(refusals.map((r) => (r.ok ? 'ok' : r.reason))).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid']);
    expect(renamePiSession).not.toHaveBeenCalled();
    expect(tagPiSession).not.toHaveBeenCalled();
    expect(changes).toEqual([]);
  });

  it('answers missing for an id that is not one safe path segment or that no open folder stores', async () => {
    expect(await catalog.rename('../escape', 'x')).toEqual({ ok: false, reason: 'missing' });
    expect(await catalog.tag(7 as unknown as string, 'x')).toEqual({ ok: false, reason: 'missing' });
    expect(await catalog.delete('01a0e000-0000-7000-8000-0000000000ff')).toEqual({ ok: false, reason: 'missing' });
    expect(deletePiSession).not.toHaveBeenCalled();
  });
});

describe('SessionCatalog delete', () => {
  it('detaches every holder across every panel, deduped, before the rm, then announces', async () => {
    const live = await liveChatOn(newFile, 'registered');
    H.mutators.set(ID_NEW, live);
    panels.set('p1', panelHolding('pending-resume', ID_NEW));
    panels.set('p2', panelHolding('other-conversation', ID_OLD));
    // The registered mutator is also a panel's session: it detaches once.
    panels.set('p3', { session: Object.assign(live, { holdsSession: (id: string) => id === ID_NEW }) } as unknown as HostInstance);

    expect(await catalog.delete(ID_NEW)).toEqual({ ok: true });

    expect(H.order.slice(0, -1).sort()).toEqual(['detach:pending-resume', 'detach:registered']);
    expect(H.order.at(-1)).toBe('rm');
    expect(fs.existsSync(newFile)).toBe(false);
    expect((await catalog.list(ALPHA.key)).map((s) => s.id)).toEqual([ID_OLD]);
    expect(changes).toEqual([{ projectKey: ALPHA.key }]);
  });

  it('removes nothing when a holder cannot let go', async () => {
    panels.set('p1', { session: { holdsSession: () => true, detachFromDeletedSession: async () => { throw new Error('replacement cancelled'); } } } as unknown as HostInstance);

    expect(await catalog.delete(ID_NEW)).toEqual({ ok: false, reason: 'failed', message: 'replacement cancelled' });
    expect(deletePiSession).not.toHaveBeenCalled();
    expect(fs.existsSync(newFile)).toBe(true);
  });
});

// Another Damocles window holding the conversation would write it again after any change made here.
describe('SessionCatalog with the lease held by another process', () => {
  let release: () => void;
  beforeEach(() => {
    fs.mkdirSync(SESSION_LEASE_DIR, { recursive: true });
    const lease = sessionLeasePath(ID_OLD);
    release = lockfile.lockSync(lease, { lockfilePath: lease, realpath: false });
  });
  afterEach(() => release());

  it('rename, tag and delete answer leased, announce it, and never write or rm the file', async () => {
    panels.set('p1', panelHolding('would-detach', ID_OLD));
    const before = fs.readFileSync(oldFile, 'utf8');

    expect(await catalog.rename(ID_OLD, 'x')).toEqual({ ok: false, reason: 'leased' });
    expect(await catalog.tag(ID_OLD, 'x')).toEqual({ ok: false, reason: 'leased' });
    expect(await catalog.delete(ID_OLD)).toEqual({ ok: false, reason: 'leased' });

    expect(renamePiSession).not.toHaveBeenCalled();
    expect(tagPiSession).not.toHaveBeenCalled();
    expect(H.order).toEqual([]);
    expect(fs.readFileSync(oldFile, 'utf8')).toBe(before);
    expect(platform.notifications.calls.map((c) => c.message)).toEqual(Array(3).fill('This conversation is open in another Damocles window.'));
    expect(changes).toEqual([]);
  });
});
