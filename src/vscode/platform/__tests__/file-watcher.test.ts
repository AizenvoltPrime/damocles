import * as path from 'node:path';
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

describe('VS Code watch', () => {
  // A pattern with `/` or `**` is a recursive watch of its base, so a watch based at the home folder would watch all of it.
  it('narrows the base to the glob\'s static prefix, as the desktop watcher does', () => {
    const home = path.resolve('/home/me');
    const factory = createVsCodeFileWatcherFactory();
    factory.watch(home, '.claude/agents/**/*.md');
    factory.watch(home, '.codex/config.toml');
    factory.watch(home, '{settings.json,settings.local.json}');
    expect(__watchers.map((w) => w.globPattern)).toEqual([
      new RelativePattern(vscode.Uri.file(path.join(home, '.claude', 'agents')), '**/*.md'),
      new RelativePattern(vscode.Uri.file(path.join(home, '.codex')), 'config.toml'),
      new RelativePattern(vscode.Uri.file(home), '{settings.json,settings.local.json}'),
    ]);
  });

  // VS Code's watcher would open the root, so one a link below the base carries off the base's share is never watched (D10).
  it('refuses a root the check refuses from its base: no VS Code watcher, one that fires nothing, logged once per base and root', async () => {
    const home = path.resolve('/home/me');
    const agents = path.join(home, '.claude', 'agents');
    const judged: Array<[string, string]> = [];
    const lines: string[] = [];
    const factory = createVsCodeFileWatcherFactory({
      checkRoot: (base, root) => {
        judged.push([base, root]);
        return root === agents ? { refused: 'share' } : 'ok';
      },
      log: (line) => lines.push(line),
    });
    const refused = factory.watch(home, '.claude/agents/**/*.md');
    const again = factory.watch(home, '.claude/agents/*');
    factory.watch(home, '.claude/settings.json');

    expect(judged).toEqual([[home, agents], [home, agents], [home, path.join(home, '.claude')]]);
    expect(__watchers.map((w) => w.globPattern)).toEqual([new RelativePattern(vscode.Uri.file(path.join(home, '.claude')), 'settings.json')]);
    await refused.ready;
    refused.onDidCreate(() => undefined).dispose();
    refused.dispose();
    again.dispose();
    expect(lines).toEqual([`[watcher] ${agents} is not watched: a link below ${home} leads onto a network share, WSL or device path off its share`]);
  });

  it('refuses a root whose check fails, a link loop, and logs why once', () => {
    const home = path.resolve('/home/me');
    const lines: string[] = [];
    const factory = createVsCodeFileWatcherFactory({
      checkRoot: () => {
        throw Object.assign(new Error('The path under /home/me goes through too many links.'), { code: 'ELOOP' });
      },
      log: (line) => lines.push(line),
    });
    factory.watch(home, '.claude/agents/**/*.md');
    factory.watch(home, '.claude/agents/**/*.md');

    expect(__watchers).toEqual([]);
    expect(lines).toEqual([`[watcher] ${path.join(home, '.claude', 'agents')} is not watched: the network rule's check of the links below ${home} failed: The path under /home/me goes through too many links.`]);
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
