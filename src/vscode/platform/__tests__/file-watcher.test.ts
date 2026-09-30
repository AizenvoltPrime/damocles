import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  folders: [] as Array<{ uri: { fsPath: string; toString(): string }; name: string; index: number }>,
  folderListeners: [] as Array<() => void>,
}));

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vscode') & Record<string, unknown>>();
  return {
    ...actual,
    workspace: {
      ...actual.workspace,
      get workspaceFolders() { return H.folders; },
      onDidChangeWorkspaceFolders: (cb: () => void) => {
        H.folderListeners.push(cb);
        return { dispose: () => H.folderListeners.splice(H.folderListeners.indexOf(cb), 1) };
      },
    },
  };
});

import * as vscode from 'vscode';
import { __renameEmitter, __watchers, RelativePattern, type FakeFileSystemWatcher } from '../../../__mocks__/vscode';
import { createVsCodeFileWatcherFactory } from '../file-watcher';

function folder(fsPath: string, index: number) {
  return { uri: { fsPath, toString: () => `file://${fsPath}` }, name: fsPath.split('/').pop()!, index };
}

function setFolders(...paths: string[]): void {
  H.folders = paths.map(folder);
  for (const cb of [...H.folderListeners]) cb();
}

function watcherFor(fsPath: string): FakeFileSystemWatcher {
  const found = [...__watchers].reverse().find((w) => !w.disposed && (w.globPattern as RelativePattern).base === H.folders.find((f) => f.uri.fsPath === fsPath));
  if (!found) throw new Error(`no live watcher for ${fsPath}`);
  return found;
}

beforeEach(() => {
  __watchers.length = 0;
  __renameEmitter.clear();
  H.folders = [];
  H.folderListeners.length = 0;
});

describe('VS Code watchWorkspace', () => {
  it('matches the glob relative to each workspace folder, never against the absolute path', () => {
    setFolders('/ws/a', '/ws/b');
    const watcher = createVsCodeFileWatcherFactory().watchWorkspace('.damocles/settings.json');

    expect(__watchers.map((w) => w.globPattern)).toEqual([
      new RelativePattern(H.folders[0], '.damocles/settings.json'),
      new RelativePattern(H.folders[1], '.damocles/settings.json'),
    ]);
    const changed = vi.fn();
    watcher.onDidChange(changed);
    watcherFor('/ws/b').emitChange('/ws/b/.damocles/settings.json');
    expect(changed).toHaveBeenCalledWith('/ws/b/.damocles/settings.json');
  });

  it('follows folders added and removed, and disposes every folder watcher with it', () => {
    setFolders('/ws/a');
    const watcher = createVsCodeFileWatcherFactory().watchWorkspace('**/*.md');
    const first = watcherFor('/ws/a');
    const created = vi.fn();
    watcher.onDidCreate(created);

    setFolders('/ws/b');
    expect(first.disposed).toBe(true);
    watcherFor('/ws/b').emitCreate('/ws/b/x.md');
    expect(created).toHaveBeenCalledWith('/ws/b/x.md');

    watcher.dispose();
    expect(__watchers.every((w) => w.disposed)).toBe(true);
    expect(H.folderListeners).toEqual([]);
  });
});

describe('VS Code onDidRenameFiles', () => {
  it('skips a batch in which no rename is a file rename', () => {
    const cb = vi.fn();
    createVsCodeFileWatcherFactory().onDidRenameFiles(cb);
    const untitled = { scheme: 'untitled', fsPath: 'Untitled-1' };
    __renameEmitter.fire({ files: [{ oldUri: untitled, newUri: { ...untitled, fsPath: 'Untitled-2' } }] } as never);
    expect(cb).not.toHaveBeenCalled();
    __renameEmitter.fire({ files: [{ oldUri: vscode.Uri.file('/ws/a.ts'), newUri: vscode.Uri.file('/ws/b.ts') }] } as never);
    expect(cb).toHaveBeenCalledWith([{ oldPath: '/ws/a.ts', newPath: '/ws/b.ts' }]);
  });
});
