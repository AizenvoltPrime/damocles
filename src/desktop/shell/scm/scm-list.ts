import type { ScmChange, ScmGroup, ScmRepoSnapshot, ScmTone } from '../../preload/scm-channels';
import type { ScmSortKey, ScmViewMode } from './scm-menus';

// The Source control view's visible rows, one flat list for the virtualized tree: each group's header, then its folders (tree
// view) and changes while it is expanded. Keys never depend on position, so a row keeps its element as others come and go.
// position and setSize: 1-based among the row's siblings, for aria-posinset and aria-setsize (a virtualized tree must say them).
interface Sibling {
  readonly position: number;
  readonly setSize: number;
}
export type ScmRow = Sibling & (
  | { readonly kind: 'group'; readonly key: string; readonly group: ScmGroup; readonly count: number; readonly expanded: boolean; readonly level: 1 }
  | { readonly kind: 'empty'; readonly key: string; readonly group: ScmGroup; readonly text: 'noUnstaged' | 'clean'; readonly level: 2 }
  | { readonly kind: 'folder'; readonly key: string; readonly group: ScmGroup; readonly path: string; readonly name: string; readonly count: number; readonly expanded: boolean; readonly level: number }
  | { readonly kind: 'change'; readonly key: string; readonly group: ScmGroup; readonly change: ScmChange; readonly name: string; readonly dir: string; readonly level: number }
);

export interface ScmListOptions {
  readonly viewMode: ScmViewMode;
  readonly sortKey: ScmSortKey;
  // keys of collapsed groups and folders (`group:<group>`, `folder:<group>:<path>`)
  readonly collapsed: ReadonlySet<string>;
  // a change's status as the user reads it, which Sort by Status compares (VS Code compares the resource's tooltip)
  readonly statusText: (change: ScmChange) => string;
}

const GROUP_ORDER: readonly ScmGroup[] = ['merge', 'index', 'workingTree', 'untracked'];

// Text on a row that can be hovered or selected takes the tone's -text shade, which stays AA there (D48).
export const TONE_TEXT: Readonly<Record<ScmTone, string>> = {
  modified: 'var(--d-warning-text)',
  added: 'var(--d-success-text)',
  untracked: 'var(--d-success-text)',
  renamed: 'var(--d-success-text)',
  deleted: 'var(--d-danger-text)',
  conflict: 'var(--d-danger-text)',
  submodule: 'var(--d-info-text)',
  ignored: 'var(--d-faint-text)',
};

// C0 and C1 controls, the bidi marks, embeddings, overrides and isolates, the zero-width characters and the line and paragraph
// separators, which can make a file name read as another.
// eslint-disable-next-line no-control-regex
const HIDDEN_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/g;

/** Git text (a path, a branch) as the shell shows it: each control or bidi character as its visible `\u{…}` escape. */
export const visibleText = (text: string): string =>
  text.replace(HIDDEN_CHARACTERS, (char) => `\\u{${char.codePointAt(0)!.toString(16).toUpperCase()}}`);

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const comparePaths = (a: string, b: string): number => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

export const groupKey = (group: ScmGroup): string => `group:${group}`;
export const changeKey = (group: ScmGroup, path: string): string => `${group}:${path}`;
const folderKey = (group: ScmGroup, path: string): string => `folder:${group}:${path}`;

/** List view order (VS Code's SCMTreeSorter in list mode): by file name, by status text, or by path, path breaking ties. */
function sortList(changes: readonly ScmChange[], options: ScmListOptions): ScmChange[] {
  const sorted = [...changes];
  if (options.sortKey === 'name') sorted.sort((a, b) => collator.compare(nameOf(a.path), nameOf(b.path)) || comparePaths(a.path, b.path));
  else if (options.sortKey === 'status') sorted.sort((a, b) => collator.compare(options.statusText(a), options.statusText(b)) || comparePaths(a.path, b.path));
  else sorted.sort((a, b) => comparePaths(a.path, b.path));
  return sorted;
}

interface Folder {
  readonly dirs: Map<string, Folder>;
  readonly files: ScmChange[];
  count: number;
}

/** Tree view (VS Code's tree sorter): folders first, then files, each by name. */
function treeRows(group: ScmGroup, changes: readonly ScmChange[], options: ScmListOptions, rows: ScmRow[]): void {
  const root: Folder = { dirs: new Map(), files: [], count: 0 };
  for (const change of changes) {
    let node = root;
    node.count++;
    for (const segment of dirOf(change.path).split('/').filter(Boolean)) {
      let next = node.dirs.get(segment);
      if (!next) node.dirs.set(segment, (next = { dirs: new Map(), files: [], count: 0 }));
      next.count++;
      node = next;
    }
    node.files.push(change);
  }
  const walk = (node: Folder, base: string, level: number): void => {
    const setSize = node.dirs.size + node.files.length;
    let position = 0;
    for (const name of [...node.dirs.keys()].sort(collator.compare)) {
      const path = base === '' ? name : `${base}/${name}`;
      const key = folderKey(group, path);
      const expanded = !options.collapsed.has(key);
      const folder = node.dirs.get(name)!;
      rows.push({ kind: 'folder', key, group, path, name, count: folder.count, expanded, level, position: ++position, setSize });
      if (expanded) walk(folder, path, level + 1);
    }
    for (const change of [...node.files].sort((a, b) => collator.compare(nameOf(a.path), nameOf(b.path)))) {
      rows.push({ kind: 'change', key: changeKey(group, change.path), group, change, name: nameOf(change.path), dir: '', level, position: ++position, setSize });
    }
  };
  walk(root, '', 2);
}

/** Merge, Staged and Untracked show only while they hold changes; Changes always shows, with its empty text. */
export function visibleGroups(snapshot: ScmRepoSnapshot): ScmGroup[] {
  return GROUP_ORDER.filter((group) => group === 'workingTree' || snapshot.groups[group].length > 0);
}

export function flattenChanges(snapshot: ScmRepoSnapshot, options: ScmListOptions): ScmRow[] {
  const rows: ScmRow[] = [];
  const groups = visibleGroups(snapshot);
  for (const [index, group] of groups.entries()) {
    const changes = snapshot.groups[group];
    const expanded = !options.collapsed.has(groupKey(group));
    rows.push({ kind: 'group', key: groupKey(group), group, count: changes.length, expanded, level: 1, position: index + 1, setSize: groups.length });
    if (!expanded) continue;
    if (changes.length === 0) {
      const others = snapshot.groups.merge.length + snapshot.groups.index.length + snapshot.groups.untracked.length;
      rows.push({ kind: 'empty', key: `empty:${group}`, group, text: others > 0 ? 'noUnstaged' : 'clean', level: 2, position: 1, setSize: 1 });
    } else if (options.viewMode === 'tree') treeRows(group, changes, options, rows);
    else {
      for (const [position, change] of sortList(changes, options).entries()) {
        rows.push({ kind: 'change', key: changeKey(group, change.path), group, change, name: nameOf(change.path), dir: dirOf(change.path), level: 2, position: position + 1, setSize: changes.length });
      }
    }
  }
  return rows;
}

/** Every change of the snapshot, for the header's count (VS Code counts every resource of every group). */
export const changeCount = (snapshot: ScmRepoSnapshot): number => GROUP_ORDER.reduce((sum, group) => sum + snapshot.groups[group].length, 0);

/** The changes under a folder row, for its actions. */
export function changesUnder(snapshot: ScmRepoSnapshot, group: ScmGroup, folder: string): ScmChange[] {
  return snapshot.groups[group].filter((change) => change.path.startsWith(`${folder}/`));
}
