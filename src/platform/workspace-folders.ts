import type { Disposable } from './disposable';

export interface OpenFolder {
  readonly fsPath: string;
  readonly name: string;
}

export interface WorkspaceFolders {
  // file-scheme folders only, in workspace order
  folders(): readonly OpenFolder[];
  onDidChange(cb: () => void): Disposable;
}
