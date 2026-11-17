import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FileWatcherFactory } from '../../../platform/file-watcher';
import type { Memento } from '../../../platform/key-value-state';
import type { OpenFolder, WorkspaceFolders } from '../../../platform/workspace-folders';
import { folderKey } from '../folder-key';
import { sameFolderRole, WorkspaceFolderRegistry, type FolderChange } from '../folder-registry';

const inert = { dispose: () => undefined };
const watchers: FileWatcherFactory = {
  watch: () => ({ ready: Promise.resolve(), onDidCreate: () => inert, onDidChange: () => inert, onDidDelete: () => inert, dispose: () => undefined }),
  watchWorkspace: () => ({ ready: Promise.resolve(), onDidCreate: () => inert, onDidChange: () => inert, onDidDelete: () => inert, dispose: () => undefined }),
  onDidRenameFiles: () => inert,
};
const memento: Memento = { get: (_key: string, fallback?: unknown) => fallback, update: async () => undefined } as Memento;

/** Slice 12a rule 5: a chat's working folder is resolvable while held, and never one of the projects. */
describe('owned working folders', () => {
  it('stay out of targets(), resolve while held, leave with their last holder and with their project', () => {
    const project = path.resolve('/projects/app');
    const worktree = path.resolve('/home/.damocles/worktrees/app-abcdef/aaaaaaaa');
    let open: OpenFolder[] = [{ fsPath: project, name: 'app' }];
    let changed: () => void = () => undefined;
    const folders: WorkspaceFolders = { folders: () => open, onDidChange: (cb) => ((changed = cb), inert) };
    const registry = new WorkspaceFolderRegistry(folders, memento, watchers);
    const a = registry.acquireOwned(worktree, folderKey(project));
    const b = registry.acquireOwned(worktree, folderKey(project));
    expect(registry.targets().map((t) => t.fsPath)).toEqual([project]);
    expect(registry.resolve(folderKey(worktree))).toMatchObject({ fsPath: worktree, ownerKey: folderKey(project) });
    expect(registry.projectOf(registry.resolve(folderKey(worktree))!)?.fsPath).toBe(project);
    expect(() => registry.acquireOwned(worktree, folderKey('/other'))).toThrow();
    a.dispose();
    expect(registry.resolve(folderKey(worktree))).toBeDefined();
    b.dispose();
    expect(registry.resolve(folderKey(worktree))).toBeUndefined();
    registry.acquireOwned(worktree, folderKey(project));
    const changes: FolderChange[] = [];
    registry.onDidChange((c) => changes.push(c));
    open = [];
    changed();
    expect(changes[0]!.removed.map((t) => t.fsPath)).toEqual([project, worktree]);
    expect(registry.resolve(folderKey(worktree))).toBeUndefined();
    registry.dispose();
  });

  it('leaves a registration made again after its project came back alone when an old holder lets go', () => {
    const project = path.resolve('/projects/app');
    const worktree = path.resolve('/home/.damocles/worktrees/app-abcdef/cccccccc');
    let open: OpenFolder[] = [{ fsPath: project, name: 'app' }];
    let changed: () => void = () => undefined;
    const folders: WorkspaceFolders = { folders: () => open, onDidChange: (cb) => ((changed = cb), inert) };
    const registry = new WorkspaceFolderRegistry(folders, memento, watchers);
    const stale = registry.acquireOwned(worktree, folderKey(project));
    open = [];
    changed();
    open = [{ fsPath: project, name: 'app' }];
    changed();
    registry.acquireOwned(worktree, folderKey(project));
    stale.dispose();
    expect(registry.resolve(folderKey(worktree))).toBeDefined();
    registry.dispose();
  });

  // A chat of the project keeps working in its worktree while the user opens that worktree as a project of its own.
  it('holds a working folder open as a project in both roles, each kept apart, through the folder opening and closing', () => {
    const project = path.resolve('/projects/app');
    const worktree = path.resolve('/home/.damocles/worktrees/app-abcdef/dddddddd');
    const key = folderKey(worktree);
    let open: OpenFolder[] = [{ fsPath: project, name: 'app' }];
    let changed: () => void = () => undefined;
    const folders: WorkspaceFolders = { folders: () => open, onDidChange: (cb) => ((changed = cb), inert) };
    const registry = new WorkspaceFolderRegistry(folders, memento, watchers);
    registry.acquireOwned(worktree, folderKey(project));
    const owned = registry.ownedTarget(key)!;
    const changes: FolderChange[] = [];
    registry.onDidChange((c) => changes.push(c));
    open = [{ fsPath: project, name: 'app' }, { fsPath: worktree, name: 'dddddddd' }];
    changed();
    const asProject = registry.resolve(key)!;
    expect(asProject).toMatchObject({ fsPath: worktree, label: 'dddddddd' });
    expect(asProject.ownerKey).toBeUndefined();
    expect(registry.ownedFolders()).toMatchObject([{ fsPath: worktree, ownerKey: folderKey(project) }]);
    expect(registry.current(owned)).toBe(owned);
    expect(registry.current(asProject)).toBe(asProject);
    expect(registry.projectOf(owned)?.fsPath).toBe(project);
    expect(registry.projectOf(asProject)?.fsPath).toBe(worktree);
    open = [{ fsPath: project, name: 'app' }];
    changed();
    expect(changes.map((c) => c.removed.map((t) => [t.fsPath, t.ownerKey]))).toEqual([[], [[worktree, undefined]]]);
    expect(registry.current(asProject)).toBeUndefined();
    expect(registry.current(owned)).toBe(owned);
    expect(registry.resolve(key)).toBe(owned);
    registry.dispose();
  });

  it('registers a working folder already open as a project, which resolve() still answers as the project', () => {
    const project = path.resolve('/projects/app');
    const worktree = path.resolve('/home/.damocles/worktrees/app-abcdef/ffffffff');
    const open: OpenFolder[] = [{ fsPath: project, name: 'app' }, { fsPath: worktree, name: 'ffffffff' }];
    const folders: WorkspaceFolders = { folders: () => open, onDidChange: () => inert };
    const registry = new WorkspaceFolderRegistry(folders, memento, watchers);
    const hold = registry.acquireOwned(worktree, folderKey(project));
    expect(registry.ownedTarget(folderKey(worktree))).toMatchObject({ fsPath: worktree, ownerKey: folderKey(project), label: 'app' });
    expect(registry.resolve(folderKey(worktree))?.ownerKey).toBeUndefined();
    expect(registry.targets().map((t) => t.fsPath)).toEqual([project, worktree]);
    hold.dispose();
    expect(registry.ownedTarget(folderKey(worktree))).toBeUndefined();
    registry.dispose();
  });

  it('removes the owned role of a folder open as a project with its owner, and keeps the project role', () => {
    const project = path.resolve('/projects/app');
    const worktree = path.resolve('/home/.damocles/worktrees/app-abcdef/eeeeeeee');
    let open: OpenFolder[] = [{ fsPath: project, name: 'app' }, { fsPath: worktree, name: 'eeeeeeee' }];
    let changed: () => void = () => undefined;
    const folders: WorkspaceFolders = { folders: () => open, onDidChange: (cb) => ((changed = cb), inert) };
    const registry = new WorkspaceFolderRegistry(folders, memento, watchers);
    registry.acquireOwned(worktree, folderKey(project));
    const changes: FolderChange[] = [];
    const owned: Array<{ removed: string[] }> = [];
    registry.onDidChange((c) => changes.push(c));
    registry.onDidChangeOwned((c) => owned.push({ removed: c.removed.map((t) => t.fsPath) }));
    open = [{ fsPath: worktree, name: 'eeeeeeee' }];
    changed();
    expect(changes.map((c) => c.removed.map((t) => [t.fsPath, t.ownerKey]))).toEqual([[[project, undefined], [worktree, folderKey(project)]]]);
    expect(owned).toEqual([{ removed: [worktree] }]);
    expect(registry.resolve(folderKey(worktree))?.ownerKey).toBeUndefined();
    expect(registry.ownedTarget(folderKey(worktree))).toBeUndefined();
    open = [];
    changed();
    expect(registry.resolve(folderKey(worktree))).toBeUndefined();
    registry.dispose();
  });

  it('keeps the default a project: a stored default whose project left never answers its owned working-folder role', async () => {
    const project = path.resolve('/projects/app');
    const worktree = path.resolve('/home/.damocles/worktrees/app-abcdef/dddddddd');
    let open: OpenFolder[] = [{ fsPath: project, name: 'app' }, { fsPath: worktree, name: 'dddddddd' }];
    let changed: () => void = () => undefined;
    const folders: WorkspaceFolders = { folders: () => open, onDidChange: (cb) => ((changed = cb), inert) };
    const values = new Map<string, unknown>();
    const state = { get: (key: string, fallback?: unknown) => values.get(key) ?? fallback, update: async (key: string, value: unknown) => { values.set(key, value); } } as Memento;
    const registry = new WorkspaceFolderRegistry(folders, state, watchers);
    expect(await registry.setDefault(folderKey(worktree))).toBe(true);
    registry.acquireOwned(worktree, folderKey(project));
    open = [{ fsPath: project, name: 'app' }];
    changed();
    expect(registry.defaultTarget()).toMatchObject({ fsPath: project });
    expect(registry.defaultTarget().ownerKey).toBeUndefined();
    expect(await registry.setDefault(folderKey(worktree))).toBe(false);
    registry.dispose();
  });

  it('tells two roles of one folder apart', () => {
    const target = { key: 'k', fsPath: '/k', name: 'k', label: 'k', projectScope: true };
    const relabelled = { ...target, label: 'other' };
    expect(sameFolderRole(target, relabelled)).toBe(true);
    expect(sameFolderRole(target, { ...target, ownerKey: 'p' })).toBe(false);
    expect(sameFolderRole({ ...target, ownerKey: 'p' }, { ...target, ownerKey: 'p' })).toBe(true);
  });

  it('lists the owned folders and announces the first holder, the last holder and a project removal', () => {
    const project = path.resolve('/projects/app');
    const worktree = path.resolve('/home/.damocles/worktrees/app-abcdef/bbbbbbbb');
    let open: OpenFolder[] = [{ fsPath: project, name: 'app' }];
    let changed: () => void = () => undefined;
    const folders: WorkspaceFolders = { folders: () => open, onDidChange: (cb) => ((changed = cb), inert) };
    const registry = new WorkspaceFolderRegistry(folders, memento, watchers);
    const events: Array<{ added: string[]; removed: string[] }> = [];
    registry.onDidChangeOwned((c) => events.push({ added: c.added.map((t) => t.fsPath), removed: c.removed.map((t) => t.fsPath) }));
    const a = registry.acquireOwned(worktree, folderKey(project));
    const b = registry.acquireOwned(worktree, folderKey(project));
    expect(registry.ownedFolders().map((t) => t.fsPath)).toEqual([worktree]);
    a.dispose();
    b.dispose();
    expect(registry.ownedFolders()).toEqual([]);
    registry.acquireOwned(worktree, folderKey(project));
    open = [];
    changed();
    expect(events).toEqual([
      { added: [worktree], removed: [] },
      { added: [], removed: [worktree] },
      { added: [worktree], removed: [] },
      { added: [], removed: [worktree] },
    ]);
    registry.dispose();
  });
});
