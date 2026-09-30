import type { Disposable } from './disposable';

export interface FileWatcher extends Disposable {
  onDidCreate(cb: (fsPath: string) => void): Disposable;
  onDidChange(cb: (fsPath: string) => void): Disposable;
  onDidDelete(cb: (fsPath: string) => void): Disposable;
}

export interface FileRename {
  readonly oldPath: string;
  readonly newPath: string;
}

export interface FileWatcherFactory {
  // base is an absolute path; glob is matched against paths relative to it
  watch(base: string, glob: string): FileWatcher;
  // glob is matched against paths relative to each open workspace folder, following folder changes
  watchWorkspace(glob: string): FileWatcher;
  // renames the host performs itself (explorer, refactorings), in addition to the watchers' delete + create
  onDidRenameFiles(cb: (renames: readonly FileRename[]) => void): Disposable;
}
