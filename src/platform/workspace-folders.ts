import type { Disposable } from './disposable';

export interface OpenFolder {
  readonly fsPath: string;
  readonly name: string;
  /** The project folder a worktree chat's working folder belongs to (slice 12a rule 5); never set on a host's own folders. */
  readonly ownerKey?: string;
}

export interface WorkspaceFolders {
  // file-scheme folders only, in workspace order
  folders(): readonly OpenFolder[];
  onDidChange(cb: () => void): Disposable;
}
