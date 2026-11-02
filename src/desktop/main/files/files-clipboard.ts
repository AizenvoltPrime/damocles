import type { FileRef, FilesClipboardChanged } from '../../preload/shell-channels';

export interface FilesClipboardItem {
  readonly op: 'copy' | 'cut';
  readonly ref: FileRef;
}

/** One window's Files clipboard: Copy and Cut hold one item; a cut is dimmed in the tree until a paste or Escape clears it. */
export class FilesClipboard {
  private item: FilesClipboardItem | undefined;
  private readonly changed: (change: FilesClipboardChanged) => void;

  constructor(changed: (change: FilesClipboardChanged) => void) {
    this.changed = changed;
  }

  set(op: FilesClipboardItem['op'], ref: FileRef): void {
    this.item = { op, ref: { projectKey: ref.projectKey, relativePath: ref.relativePath } };
    this.changed(op === 'cut' ? { cut: this.item.ref } : {});
  }

  current(): FilesClipboardItem | undefined {
    return this.item;
  }

  // Escape, and a paste that consumed a cut; a copy stays for the next paste
  clearCut(): void {
    if (this.item?.op !== 'cut') return;
    this.item = undefined;
    this.changed({});
  }
}
