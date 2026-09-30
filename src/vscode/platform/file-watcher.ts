import * as vscode from 'vscode';
import type { Disposable } from '../../platform/disposable';
import type { FileRename, FileWatcher, FileWatcherFactory } from '../../platform/file-watcher';

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

export function createVsCodeFileWatcherFactory(): FileWatcherFactory {
  return {
    watch: (base, glob) => wrap(vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), glob))),
    watchWorkspace,
    onDidRenameFiles: (cb): Disposable => vscode.workspace.onDidRenameFiles((e) => {
      const renames: FileRename[] = e.files
        .filter((file) => file.oldUri.scheme === 'file' && file.newUri.scheme === 'file')
        .map((file) => ({ oldPath: file.oldUri.fsPath, newPath: file.newUri.fsPath }));
      if (renames.length > 0) cb(renames);
    }),
  };
}
