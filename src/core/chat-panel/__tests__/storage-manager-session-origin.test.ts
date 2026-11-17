import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { StorageManager } from '../storage-manager';
import { inProcessIndex, PI_PACKAGE_DIR } from '../../pi-session/session-store/meta-index/__tests__/in-process';
import { ensurePiSessionDir, piSessionDir, piSessionsRoot } from '../../pi-session/session-store/session-dir';
import { metaCacheKey } from '../../pi-session/session-store/meta-index/protocol';
import { SESSION_META_CACHE_DIR } from '../../paths';
import { initPiLoader } from '../../pi-session/pi-loader';
import { installRelocations, relocationsSnapshot } from '../../project-relocation/current';
import { installWorktreeProjectLookup } from '../../worktrees/personal-config';
import { folderKey } from '../../workspace-folders/folder-key';
import type { FolderTarget } from '../../workspace-folders/folder-registry';
import type { SessionMetaIndex } from '../../pi-session/session-store';

vi.mock('../../logger', () => ({ log: vi.fn() }));

// docs/invariants.md "Worktree chats", Ownership: pi names a folder's session directory by a lossy encoding of its path, so
// a session with no worktree entry lists under the folder its own header names, never under whichever folder's directory holds it.

const ROOT = path.join(os.homedir(), 'session-origin');
const folder = (...segments: string[]): FolderTarget => {
  const fsPath = path.join(ROOT, ...segments);
  return { key: folderKey(fsPath), fsPath, name: path.basename(fsPath), label: path.basename(fsPath), projectScope: true };
};

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
let sequence = 0;

/** A conversation as pi writes it: a header naming the folder it was started in, a prompt and a reply, then any extra entries. */
function writeSession(dir: string, cwd: string, prompt: string, options: { at?: string; entries?: unknown[] } = {}): string {
  sequence += 1;
  const id = `01a0e000-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
  const at = options.at ?? `2026-01-0${sequence % 9 + 1}T09:00:00.000Z`;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${at.replace(/[:.]/g, '-')}_${id}.jsonl`);
  fs.writeFileSync(file,
    line({ type: 'session', version: 3, id, timestamp: at, cwd })
    + line({ type: 'message', id: 'u1', parentId: null, timestamp: at, message: { role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.parse(at) } })
    + line({ type: 'message', id: 'a1', parentId: 'u1', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], provider: 'anthropic', model: 'claude-opus-4-8', timestamp: Date.parse(at) } })
    + (options.entries ?? []).map(line).join(''));
  return file;
}

const worktreeEntry = (worktreeId: string, projectPath: string, at = '2026-01-01T10:00:00.000Z') =>
  ({ type: 'custom', customType: 'damocles.worktree', id: 'w1', parentId: 'a1', timestamp: at, data: { worktreeId, projectPath, place: 'worktree' } });

const open: StorageManager[] = [];
function storage(folders: readonly FolderTarget[]): StorageManager {
  const metaIndex: SessionMetaIndex = inProcessIndex().index;
  const manager = new StorageManager({
    folders: () => folders,
    isMultiRoot: () => folders.length > 1,
    postMessage: () => undefined,
    getPanels: () => new Map(),
    liveSession: () => undefined,
    fileWatchers: createFakePlatform().fileWatchers,
    metaIndex,
  });
  open.push(manager);
  return manager;
}

/** A folder's list once every parsed row of its load was applied. */
const listOf = async (manager: StorageManager, target: FolderTarget): Promise<string[]> =>
  (await manager.completeSessionsOf(target.key)).map((s) => s.preview).sort();

beforeAll(async () => {
  await initPiLoader();
});

beforeEach(() => {
  for (const dir of [ROOT, piSessionsRoot(), SESSION_META_CACHE_DIR]) fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(async () => {
  for (const manager of open.splice(0)) await manager.dispose();
  installRelocations(undefined);
});

describe('StorageManager: folders whose session directories collide', () => {
  const dashed = folder('work', 'a-b');
  const nested = folder('work', 'a', 'b');

  it("lists each open project's own chat under it, though pi gives both one session directory", async () => {
    expect(piSessionDir(dashed.fsPath)).toBe(piSessionDir(nested.fsPath));
    for (const target of [dashed, nested]) fs.mkdirSync(target.fsPath, { recursive: true });
    writeSession(ensurePiSessionDir(dashed.fsPath), dashed.fsPath, 'dashed chat');
    writeSession(ensurePiSessionDir(nested.fsPath), nested.fsPath, 'nested chat');

    const manager = storage([dashed, nested]);

    expect(await listOf(manager, dashed)).toEqual(['dashed chat']);
    expect(await listOf(manager, nested)).toEqual(['nested chat']);
    expect((await manager.storedSession((await manager.completeSessionsOf(nested.key))[0]!.id))?.listedFrom).toBeUndefined();
  });

  it('lists none of the chats a folder that is not open left in the directory it shares with an open project', async () => {
    writeSession(ensurePiSessionDir(dashed.fsPath), dashed.fsPath, 'dashed chat');
    writeSession(ensurePiSessionDir(nested.fsPath), nested.fsPath, 'nested chat');

    expect(await listOf(storage([nested]), nested)).toEqual(['nested chat']);
    expect(await listOf(storage([dashed]), dashed)).toEqual(['dashed chat']);
  });

  it('names the project a chat lists under, whichever of the two open folders finds its file', async () => {
    writeSession(ensurePiSessionDir(dashed.fsPath), dashed.fsPath, 'dashed chat');
    writeSession(ensurePiSessionDir(nested.fsPath), nested.fsPath, 'nested chat');
    const manager = storage([dashed, nested]);
    const ids = new Map((await manager.completeSessionsOf(dashed.key)).concat(await manager.completeSessionsOf(nested.key)).map((s) => [s.preview, s.id]));

    const fresh = storage([dashed, nested]);
    expect([await fresh.folderOf(ids.get('dashed chat')!), await fresh.folderOf(ids.get('nested chat')!)]).toEqual([dashed, nested]);
  });

  it('opens a chat a folder that is not open left in the shared directory as that folder\'s, never as the open project\'s own', async () => {
    const own = writeSession(ensurePiSessionDir(nested.fsPath), nested.fsPath, 'nested chat');
    const left = writeSession(ensurePiSessionDir(dashed.fsPath), dashed.fsPath, 'dashed chat');
    const idOf = (file: string): string => path.basename(file, '.jsonl').split('_')[1]!;
    const manager = storage([nested]);

    expect(await manager.storedFileFrom(nested.fsPath, idOf(own))).toBe('own');
    expect(await manager.storedFileFrom(nested.fsPath, idOf(left))).toBe('other');
    expect(await manager.storedFileFrom(nested.fsPath, '01a0e000-0000-7000-8000-999999999999')).toBeNull();
  });

  // docs/invariants.md "Project relocation": session files move whole, so a moved project's chats name its old folder.
  it("lists a relocated project's chat, whose header names the old folder, under the moved project and not the folder sharing its directory", async () => {
    const moved = folder('moved', 'x-y');
    const sharing = folder('moved', 'x', 'y');
    const old = path.join(ROOT, 'old', 'project');
    writeSession(ensurePiSessionDir(moved.fsPath), old, 'chat from before the move', { at: '2026-01-01T09:00:00.000Z' });
    writeSession(ensurePiSessionDir(sharing.fsPath), sharing.fsPath, 'sharing chat');
    installRelocations(relocationsSnapshot([], [{ seq: 1, startedAt: Date.parse('2026-01-02T00:00:00.000Z'), folders: [{ from: old, to: moved.fsPath }] }]));

    const manager = storage([sharing, moved]);

    expect(await listOf(manager, moved)).toEqual(['chat from before the move']);
    expect(await listOf(manager, sharing)).toEqual(['sharing chat']);
  });

  // docs/invariants.md "Project relocation", Stop moving: an abandoned relocation's moves do not count yet, and the chats it moved
  // belong to the new folder by the directory that holds them.
  it("lists a chat whose header folder's directory is not the one holding it under that directory's project", async () => {
    const moved = folder('moved', 'p');
    writeSession(ensurePiSessionDir(moved.fsPath), path.join(ROOT, 'old', 'p'), 'moved by a stopped relocation');

    expect(await listOf(storage([moved]), moved)).toEqual(['moved by a stopped relocation']);
  });
});

describe('StorageManager: worktree chats beside colliding folders', () => {
  const project = folder('repo', 'app-web');
  const sharing = folder('repo', 'app', 'web');
  const worktree = path.join(ROOT, 'worktrees', 'app-web', 'aaaaaaaa');
  let lookup: { dispose(): void };

  beforeEach(() => {
    lookup = installWorktreeProjectLookup({
      projectOf: (target) => (folderKey(target) === folderKey(worktree) ? project.fsPath : undefined),
      recordsOfProject: (projectPath) => (folderKey(projectPath) === project.key ? [{ workingFolder: worktree, kind: 'chat' }] : []),
      get: (id) => (id === 'aaaaaaaa' ? { workingFolder: worktree, projectPath: project.fsPath } : undefined),
      chatRecordFor: () => undefined,
    });
  });
  afterEach(() => lookup.dispose());

  it("lists a chat working in the project's worktree under the project, from either session directory, and the worktree's own chat nowhere", async () => {
    // a /clear made in the worktree, a chat handed off into it, the worktree's own chat from when it was open as a project
    writeSession(piSessionDir(worktree), worktree, 'cleared in the worktree', { entries: [worktreeEntry('aaaaaaaa', project.fsPath)] });
    writeSession(ensurePiSessionDir(project.fsPath), project.fsPath, 'handed off', { entries: [worktreeEntry('aaaaaaaa', project.fsPath)] });
    writeSession(piSessionDir(worktree), worktree, "the worktree's own chat");
    writeSession(ensurePiSessionDir(sharing.fsPath), sharing.fsPath, 'sharing chat');

    const manager = storage([sharing, project]);

    expect(await listOf(manager, project)).toEqual(['cleared in the worktree', 'handed off']);
    expect((await manager.completeSessionsOf(project.key)).map((s) => [s.preview, s.listedFrom]).sort()).toEqual([['cleared in the worktree', worktree], ['handed off', undefined]]);
    expect(await listOf(manager, sharing)).toEqual(['sharing chat']);
  });
});

describe('the session metadata index across a schema change', () => {
  const dashed = folder('indexed', 'a-b');
  const nested = folder('indexed', 'a', 'b');

  // Rows an index of schema 8 wrote, still valid for their unchanged files, carry no header folder.
  it('lists colliding chats under their own projects though an earlier schema indexed their unchanged files', async () => {
    const files = [writeSession(ensurePiSessionDir(dashed.fsPath), dashed.fsPath, 'dashed chat'), writeSession(ensurePiSessionDir(nested.fsPath), nested.fsPath, 'nested chat')];
    const piVersion = (JSON.parse(fs.readFileSync(path.join(PI_PACKAGE_DIR, 'package.json'), 'utf8')) as { version: string }).version;
    fs.mkdirSync(SESSION_META_CACHE_DIR, { recursive: true });
    const earlier = new DatabaseSync(path.join(SESSION_META_CACHE_DIR, `index.s8.pi-${piVersion.replace(/[^A-Za-z0-9._-]/g, '_')}.db`));
    earlier.exec('CREATE TABLE files (key TEXT PRIMARY KEY, dir_key TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, stored TEXT, prompts TEXT NOT NULL)');
    const put = earlier.prepare('INSERT INTO files (key, dir_key, size, mtime_ms, stored, prompts) VALUES (?, ?, ?, ?, ?, ?)');
    for (const file of files) {
      const stat = fs.statSync(file);
      const id = path.basename(file, '.jsonl').split('_')[1]!;
      const preview = file === files[0] ? 'dashed chat' : 'nested chat';
      put.run(metaCacheKey(file), metaCacheKey(path.dirname(file)), stat.size, stat.mtimeMs, JSON.stringify({ id, timestamp: 1, createdAt: 1, preview, messageCount: 2 }), JSON.stringify([preview]));
    }
    earlier.close();

    const manager = storage([dashed, nested]);

    expect(await listOf(manager, dashed)).toEqual(['dashed chat']);
    expect(await listOf(manager, nested)).toEqual(['nested chat']);
  });
});
