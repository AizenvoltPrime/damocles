import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FileWatcherFactory } from '../../../platform/file-watcher';
import type { Memento } from '../../../platform/key-value-state';
import type { OpenFolder, WorkspaceFolders } from '../../../platform/workspace-folders';
import { folderKey } from '../folder-key';
import { WorkspaceFolderRegistry, type FolderChange } from '../folder-registry';

const inert = { dispose: () => undefined };
const watchers: FileWatcherFactory = {
  watch: () => ({ onDidCreate: () => inert, onDidChange: () => inert, onDidDelete: () => inert, dispose: () => undefined }),
  watchWorkspace: () => ({ onDidCreate: () => inert, onDidChange: () => inert, onDidDelete: () => inert, dispose: () => undefined }),
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
    expect(registry.projectOf(folderKey(worktree))?.fsPath).toBe(project);
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
