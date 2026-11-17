import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileWatcherFactory } from '../../../platform/file-watcher';
import { relocatedRepositoryRoot, validRecord, worktreeFolderFor } from '../records';
import { REGISTRY_FILE, WorktreeRegistry, type ChatWorktreeRecord } from '../registry';

const inert = { dispose: () => undefined };
const watchers: FileWatcherFactory = {
  watch: () => ({ ready: Promise.resolve(), onDidCreate: () => inert, onDidChange: () => inert, onDidDelete: () => inert, dispose: () => undefined }),
  watchWorkspace: () => ({ ready: Promise.resolve(), onDidCreate: () => inert, onDidChange: () => inert, onDidDelete: () => inert, dispose: () => undefined }),
  onDidRenameFiles: () => inert,
};

let base: string;
let root: string;
// the project is the `app` subfolder of its repository, so a working folder is the `app` subfolder of its worktree
let from: string;
let to: string;
const open: WorktreeRegistry[] = [];

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-registry-relocate-')));
  root = path.join(base, 'worktrees');
  from = path.join(base, 'old', 'repo', 'app');
  to = path.join(base, 'new', 'repo', 'app');
});
afterEach(() => {
  for (const r of open.splice(0)) r.dispose();
  fs.rmSync(base, { recursive: true, force: true });
});

function registry(): WorktreeRegistry {
  const r = new WorktreeRegistry({ rootDir: root, watcherFactory: watchers, log: () => undefined });
  open.push(r);
  return r;
}

function chat(id: string, projectPath: string): Omit<ChatWorktreeRecord, 'index'> {
  const worktreeRoot = worktreeFolderFor(root, projectPath, id);
  return { id, kind: 'chat', projectPath, repositoryRoot: path.dirname(projectPath), worktreeRoot, workingFolder: path.join(worktreeRoot, 'app'), branch: `damocles/${id}`, baseCommit: 'a'.repeat(40), createdAt: 1 };
}

const chats = (r: WorktreeRegistry): ChatWorktreeRecord[] => r.records().filter((record): record is ChatWorktreeRecord => record.kind === 'chat');

describe('WorktreeRegistry.relocateProject', () => {
  it('re-points every chat record of the project, live or deleted, leaving its worktree where it is, named for the old path, keeping each index', async () => {
    const r = registry();
    const a = await r.addChat(chat('aaaa1111', from));
    const b = await r.addChat(chat('bbbb2222', from));
    const gone = await r.addChat(chat('cccc3333', from));
    await r.markDeleted(gone.id);
    const other = await r.addChat(chat('dddd4444', path.join(base, 'elsewhere', 'app')));
    const adopted = await r.upsertAdopted({ worktreeRoot: path.join(base, 'linked'), workingFolder: path.join(base, 'linked'), repositoryRoot: path.dirname(from), projectPath: from });

    await r.relocateProject([{ from, to }]);

    const moved = chats(r).filter((record) => record.projectPath === to);
    expect(moved.map((record) => record.id).sort()).toEqual([a.id, b.id, gone.id]);
    for (const record of moved) {
      const worktreeRoot = worktreeFolderFor(root, from, record.id);
      expect(record).toMatchObject({ repositoryRoot: path.join(base, 'new', 'repo'), worktreeRoot, workingFolder: path.join(worktreeRoot, 'app'), namedFor: from });
      expect(validRecord(record, root)).toEqual(record);
    }
    expect(moved.find((record) => record.id === a.id)!.index).toBe(a.index);
    expect(moved.find((record) => record.id === b.id)!.index).toBe(b.index);
    expect(moved.find((record) => record.id === gone.id)!.deletedAt).toBeDefined();
    expect(r.get(other.id)).toEqual(other);
    expect(r.get(adopted.id)).toEqual({ ...adopted, projectPath: to });

    // another process reads every rewritten record as valid, none set aside as unreadable
    const raw = JSON.parse(fs.readFileSync(path.join(root, REGISTRY_FILE), 'utf8')) as { records: unknown[] };
    expect(raw.records).toHaveLength(5);
    expect(registry().records()).toEqual(r.records());
  });

  it('keeps the path a worktree was first named for through a second move, and drops it once the project is back there', async () => {
    const r = registry();
    const a = await r.addChat(chat('aaaa1111', from));
    const third = path.join(base, 'third', 'repo', 'app');
    await r.relocateProject([{ from, to }]);
    await r.relocateProject([{ from: to, to: third }]);
    expect(r.get(a.id)).toMatchObject({ projectPath: third, worktreeRoot: a.worktreeRoot, namedFor: from });
    await r.relocateProject([{ from: third, to: from }]);
    expect(r.get(a.id)).toEqual(a);
  });

  it('removes the empty folder a relocated worktree lay in, the one its name came from', async () => {
    const r = registry();
    const a = await r.addChat(chat('aaaa1111', from));
    fs.mkdirSync(a.worktreeRoot, { recursive: true });
    await r.relocateProject([{ from, to }]);
    await r.markDeleted(a.id);
    fs.rmSync(a.worktreeRoot, { recursive: true });
    await r.removeEmptyProjectFolder(r.get(a.id) as ChatWorktreeRecord);
    expect(fs.existsSync(path.dirname(a.worktreeRoot))).toBe(false);
  });

  it('a second run writes nothing new', async () => {
    const r = registry();
    await r.addChat(chat('aaaa1111', from));
    await r.relocateProject([{ from, to }]);
    const once = fs.readFileSync(path.join(root, REGISTRY_FILE), 'utf8');
    await r.relocateProject([{ from, to }]);
    expect(fs.readFileSync(path.join(root, REGISTRY_FILE), 'utf8')).toBe(once);
  });

  it('in a merge renumbers only a moved index a live record of the target holds, another version\'s records included', async () => {
    const r = registry();
    const target = await r.addChat(chat('tttt0000', to));
    const deletedTarget = await r.addChat(chat('tttt1111', to));
    await r.markDeleted(deletedTarget.id);
    const a = await r.addChat(chat('aaaa1111', from));
    const b = await r.addChat(chat('bbbb2222', from));
    expect([target.index, a.index, b.index]).toEqual([1, 1, 2]);
    // a record this version cannot read, which may still hold index 3 of the target
    const file = path.join(root, REGISTRY_FILE);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: number; records: unknown[] };
    fs.writeFileSync(file, JSON.stringify({ ...raw, records: [...raw.records, { id: 'future01', kind: 'future', projectPath: to, index: 3 }] }));
    r.reload();

    await r.relocateProject([{ from, to }]);

    const live = chats(r).filter((record) => record.projectPath === to && record.deletedAt === undefined);
    expect(Object.fromEntries(live.map((record) => [record.id, record.index]))).toEqual({ [target.id]: 1, [a.id]: 4, [b.id]: 2 });
    for (const record of live) expect(validRecord(record, root)).toEqual(record);
    expect(r.foreignWorktreeRoots()).toEqual([]);
    expect((JSON.parse(fs.readFileSync(file, 'utf8')) as { records: unknown[] }).records).toContainEqual({ id: 'future01', kind: 'future', projectPath: to, index: 3 });
  });

  it('refuses, writing nothing, a target that does not lie in its repository as the project did', async () => {
    const r = registry();
    await r.addChat(chat('aaaa1111', from));
    const before = fs.readFileSync(path.join(root, REGISTRY_FILE), 'utf8');
    await expect(r.relocateProject([{ from, to: path.join(base, 'new', 'repo', 'renamed') }])).rejects.toThrow();
    expect(fs.readFileSync(path.join(root, REGISTRY_FILE), 'utf8')).toBe(before);
    expect(chats(r)[0]!.projectPath).toBe(from);
  });
});

describe('validRecord of a relocated chat worktree', () => {
  const raw = (extra: Record<string, unknown>): Record<string, unknown> => {
    const worktreeRoot = worktreeFolderFor(root, from, 'aaaa1111');
    return { id: 'aaaa1111', kind: 'chat', projectPath: to, repositoryRoot: path.dirname(to), worktreeRoot, workingFolder: path.join(worktreeRoot, 'app'), branch: 'b', index: 1, baseCommit: 'a'.repeat(40), createdAt: 1, ...extra };
  };

  it('holds a folder only where the path it was named for puts it', () => {
    expect(validRecord(raw({ namedFor: from }), root)).toMatchObject({ projectPath: to, namedFor: from });
    expect(validRecord(raw({}), root)).toBeUndefined();
    expect(validRecord(raw({ namedFor: path.join(base, 'other', 'app') }), root)).toBeUndefined();
    expect(validRecord(raw({ namedFor: 'repo/app' }), root)).toBeUndefined();
    expect(validRecord(raw({ namedFor: path.join(root, 'app') }), root)).toBeUndefined();
  });
});

describe('relocatedRepositoryRoot', () => {
  it('strips the project\'s path in its old repository from the new folder', () => {
    const repo = path.resolve('/old/repo');
    expect(relocatedRepositoryRoot(repo, path.join(repo, 'packages', 'app'), path.resolve('/new/r2/packages/app'))).toBe(path.resolve('/new/r2'));
    expect(relocatedRepositoryRoot(repo, repo, path.resolve('/new/r2'))).toBe(path.resolve('/new/r2'));
    expect(relocatedRepositoryRoot(repo, path.join(repo, 'packages', 'app'), path.resolve('/new/r2/app'))).toBeUndefined();
  });
});
