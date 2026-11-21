import * as vscode from 'vscode';
import type { Disposable } from '../../platform/disposable';
import type { FileRename, FileWatcher, FileWatcherFactory } from '../../platform/file-watcher';
import { checkConfigPathSync, type ConfigPathVerdict } from '../../core/config/local-config-path';
import { log } from '../../core/logger';
import { watchRoot } from '../../core/watch-root';
import { folderKey } from '../../core/workspace-folders/folder-key';

type Listener = (fsPath: string) => void;

function listenerSet(): { add(cb: Listener): Disposable; fire(fsPath: string): void; clear(): void } {
  const listeners = new Set<Listener>();
  return {
    add: (cb) => {
      listeners.add(cb);
      return { dispose: () => { listeners.delete(cb); } };
    },
    fire: (fsPath) => {
      for (const cb of [...listeners]) cb(fsPath);
    },
    clear: () => listeners.clear(),
  };
}

function wrap(watcher: vscode.FileSystemWatcher): FileWatcher {
  return {
    // VS Code reports no watch start.
    ready: Promise.resolve(),
    onDidCreate: (cb): Disposable => watcher.onDidCreate((uri) => cb(uri.fsPath)),
    onDidChange: (cb): Disposable => watcher.onDidChange((uri) => cb(uri.fsPath)),
    onDidDelete: (cb): Disposable => watcher.onDidDelete((uri) => cb(uri.fsPath)),
    dispose: () => watcher.dispose(),
  };
}

// A string glob would be matched against the absolute path, so each folder gets a RelativePattern, as the desktop host watches per project.
function watchWorkspace(glob: string): FileWatcher {
  const create = listenerSet();
  const change = listenerSet();
  const remove = listenerSet();
  const perFolder = new Map<string, Disposable>();
  const sync = (): void => {
    const wanted = new Map((vscode.workspace.workspaceFolders ?? []).map((folder) => [folder.uri.toString(), folder]));
    for (const [key, watcher] of perFolder) {
      if (wanted.has(key)) continue;
      watcher.dispose();
      perFolder.delete(key);
    }
    for (const [key, folder] of wanted) {
      if (perFolder.has(key)) continue;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, glob));
      watcher.onDidCreate((uri) => create.fire(uri.fsPath));
      watcher.onDidChange((uri) => change.fire(uri.fsPath));
      watcher.onDidDelete((uri) => remove.fire(uri.fsPath));
      perFolder.set(key, watcher);
    }
  };
  const folderSubscription = vscode.workspace.onDidChangeWorkspaceFolders(sync);
  sync();
  return {
    // VS Code reports no watch start.
    ready: Promise.resolve(),
    onDidCreate: (cb) => create.add(cb),
    onDidChange: (cb) => change.add(cb),
    onDidDelete: (cb) => remove.add(cb),
    dispose: () => {
      folderSubscription.dispose();
      for (const watcher of perFolder.values()) watcher.dispose();
      perFolder.clear();
      create.clear();
      change.clear();
      remove.clear();
    },
  };
}

const INERT: FileWatcher = {
  ready: Promise.resolve(),
  onDidCreate: () => ({ dispose: () => undefined }),
  onDidChange: () => ({ dispose: () => undefined }),
  onDidDelete: () => ({ dispose: () => undefined }),
  dispose: () => undefined,
};

export interface VsCodeFileWatcherOptions {
  // the network rule's verdict on root, judged from base; throws when the check cannot finish (a link loop)
  readonly checkRoot?: (base: string, root: string) => ConfigPathVerdict;
  readonly log?: (line: string) => void;
}

/**
 * watch(base, glob) judges the watched root from base by the network rule (D10) when the watch starts: a root a link below base
 * carries off base's share, or one the check cannot follow, gets a watcher that fires nothing, logged once per base and root.
 */
export function createVsCodeFileWatcherFactory(options: VsCodeFileWatcherOptions = {}): FileWatcherFactory {
  const checkRoot = options.checkRoot ?? checkConfigPathSync;
  const logLine = options.log ?? ((line: string) => log('%s', line));
  const refused = new Set<string>();
  const refuse = (base: string, root: string, why: string): FileWatcher => {
    const key = `${folderKey(base)}\0${folderKey(root)}`;
    if (!refused.has(key)) logLine(`[watcher] ${root} is not watched: ${why}`);
    refused.add(key);
    return INERT;
  };
  return {
    watch: (base, glob) => {
      // VS Code watches a pattern holding `/` or `**` recursively from its base, so the base is the glob's static prefix
      const narrowed = watchRoot(base, glob);
      let verdict: ConfigPathVerdict;
      try {
        verdict = checkRoot(base, narrowed.root);
      } catch (err) {
        return refuse(base, narrowed.root, `the network rule's check of the links below ${base} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (verdict !== 'ok') return refuse(base, narrowed.root, `a link below ${base} leads onto a network share, WSL or device path off its share`);
      return wrap(vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(narrowed.root), narrowed.glob)));
    },
    watchWorkspace,
    onDidRenameFiles: (cb): Disposable => vscode.workspace.onDidRenameFiles((e) => {
      const renames: FileRename[] = e.files
        .filter((file) => file.oldUri.scheme === 'file' && file.newUri.scheme === 'file')
        .map((file) => ({ oldPath: file.oldUri.fsPath, newPath: file.newUri.fsPath }));
      if (renames.length > 0) cb(renames);
    }),
  };
}
