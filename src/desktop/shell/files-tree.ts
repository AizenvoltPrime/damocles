import type { FileEntry } from '../preload/shell-channels';

// A directory's listing as the Files tree holds it: not yet asked for, loading, loaded, or failed.
export type Listing = { readonly state: 'loading' } | { readonly state: 'loaded'; readonly entries: readonly FileEntry[] } | { readonly state: 'failed' };

// The inline input of New file, New folder or Rename, which takes a row's place in the tree.
export type TreeEdit =
  | { readonly mode: 'newFile' | 'newFolder'; readonly parentDir: string }
  | { readonly mode: 'rename'; readonly path: string };

export type TreeRow =
  // position and setSize: 1-based among the folder's entries, for aria-posinset and aria-setsize (a virtualized tree must say them)
  | { readonly kind: 'entry'; readonly path: string; readonly name: string; readonly directory: boolean; readonly depth: number; readonly expanded: boolean; readonly loading: boolean; readonly position: number; readonly setSize: number }
  | { readonly kind: 'input'; readonly edit: TreeEdit; readonly depth: number; readonly name: string; readonly directory: boolean };

export const childPath = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`);
export const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));
export const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
/** Every directory above `path`, outermost first ('' excluded). */
export const ancestorsOf = (path: string): string[] => path.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'));

// VS Code's explorer.autoRevealExclude default (`**/node_modules`, `**/bower_components`).
const AUTO_REVEAL_EXCLUDED = new Set(['node_modules', 'bower_components']);
/** Whether opening `path` leaves the tree as it is instead of expanding to the file. */
export const autoRevealExcluded = (path: string): boolean => path.split('/').some((segment) => AUTO_REVEAL_EXCLUDED.has(segment));

/**
 * The visible rows of the tree in display order: a directory's children follow it while it is expanded. A new entry's input
 * opens at the top of its folder, as VS Code's explorer does; a rename's input replaces its row.
 */
export function flattenTree(listings: ReadonlyMap<string, Listing>, expanded: ReadonlySet<string>, edit: TreeEdit | null): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number): void => {
    if (edit && edit.mode !== 'rename' && edit.parentDir === dir) rows.push({ kind: 'input', edit, depth, name: '', directory: edit.mode === 'newFolder' });
    const listing = listings.get(dir);
    if (listing?.state !== 'loaded') return;
    for (const [index, entry] of listing.entries.entries()) {
      const path = childPath(dir, entry.name);
      const directory = entry.kind === 'dir';
      const open = directory && expanded.has(path);
      if (edit?.mode === 'rename' && edit.path === path) rows.push({ kind: 'input', edit, depth, name: entry.name, directory });
      else rows.push({ kind: 'entry', path, name: entry.name, directory, depth, expanded: open, loading: open && listings.get(path)?.state === 'loading', position: index + 1, setSize: listing.entries.length });
      if (open) walk(path, depth + 1);
    }
  };
  walk('', 0);
  return rows;
}
