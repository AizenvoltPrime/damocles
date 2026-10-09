// The Search view's result tree as view state over main's results: grouping (list by file, tree by folder), VS Code's sort
// orders (compareSearchResults in shared/text-search.ts) and its collapse rule (searchView.ts).

import type { SearchSortOrder, SearchViewMode, ShellSearchSettings } from '../../preload/shell-channels';
import { compareSearchResults } from '../../../shared/text-search';

type SearchCollapseResults = ShellSearchSettings['collapseResults'];

export interface TreeMatch {
  readonly id: number;
  readonly range: { readonly startLine: number; readonly startColumn: number; readonly endLine: number; readonly endColumn: number };
}

export interface TreeFile<M extends TreeMatch = TreeMatch> {
  // unique among the results: the relative path, or the untitled tab's document id
  readonly key: string;
  // '/'-separated; an untitled tab's title, which is never a path
  readonly relativePath: string;
  readonly untitled: boolean;
  readonly mtimeMs?: number | undefined;
  readonly matches: readonly M[];
}

export interface FolderNode<F extends TreeFile> {
  readonly kind: 'folder';
  readonly key: string;
  // the folder's path, the last of a compressed chain
  readonly path: string;
  // the compressed chain's names joined by '/', as VS Code's compressed folder rows read
  readonly label: string;
  readonly children: ReadonlyArray<TreeNode<F>>;
  readonly files: readonly F[];
  readonly count: number;
}

export interface FileNode<F extends TreeFile> {
  readonly kind: 'file';
  readonly key: string;
  readonly file: F;
}

export type TreeNode<F extends TreeFile> = FolderNode<F> | FileNode<F>;

function compareFiles(a: TreeFile, b: TreeFile, order: SearchSortOrder): number {
  return compareSearchResults({ path: a.relativePath, count: a.matches.length, mtimeMs: a.mtimeMs }, { path: b.relativePath, count: b.matches.length, mtimeMs: b.mtimeMs }, order);
}

function compareFolders<F extends TreeFile>(a: FolderNode<F>, b: FolderNode<F>, order: SearchSortOrder): number {
  return compareSearchResults({ path: a.path, count: a.count }, { path: b.path, count: b.count }, order);
}

function compareNodes<F extends TreeFile>(a: TreeNode<F>, b: TreeNode<F>, order: SearchSortOrder): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
  return a.kind === 'folder' ? compareFolders(a, b as FolderNode<F>, order) : compareFiles(a.file, (b as FileNode<F>).file, order);
}

export const fileKey = (file: TreeFile): string => `f:${file.key}`;
export const folderKey = (path: string): string => `d:${path}`;

/** The results as top-level nodes: one per file in list mode; folders (compressed chains) then files in tree mode. */
export function buildNodes<F extends TreeFile>(files: readonly F[], mode: SearchViewMode, order: SearchSortOrder): Array<TreeNode<F>> {
  if (mode === 'list') return [...files].sort((a, b) => compareFiles(a, b, order)).map((file) => ({ kind: 'file' as const, key: fileKey(file), file }));
  interface Draft { readonly folders: Map<string, Draft>; readonly files: F[] }
  const root: Draft = { folders: new Map(), files: [] };
  for (const file of files) {
    let draft = root;
    // An untitled tab has no folder; it sits at the top level.
    const segments = file.untitled ? [] : file.relativePath.split('/').slice(0, -1);
    for (const segment of segments) {
      let next = draft.folders.get(segment);
      if (!next) draft.folders.set(segment, (next = { folders: new Map(), files: [] }));
      draft = next;
    }
    draft.files.push(file);
  }
  const build = (draft: Draft, parentPath: string): Array<TreeNode<F>> => {
    const nodes: Array<TreeNode<F>> = draft.files.map((file) => ({ kind: 'file' as const, key: fileKey(file), file }));
    for (const [name, child] of draft.folders) {
      // VS Code's compressible tree joins a folder whose only child is one folder into a single row.
      let path = parentPath === '' ? name : `${parentPath}/${name}`;
      let label = name;
      let inner = child;
      while (inner.files.length === 0 && inner.folders.size === 1) {
        const [nextName, nextDraft] = inner.folders.entries().next().value as [string, Draft];
        path = `${path}/${nextName}`;
        label = `${label}/${nextName}`;
        inner = nextDraft;
      }
      const children = build(inner, path);
      const descendants = children.flatMap((node) => (node.kind === 'file' ? [node.file] : node.files));
      nodes.push({ kind: 'folder', key: folderKey(path), path, label, children, files: descendants, count: descendants.reduce((sum, file) => sum + file.matches.length, 0) });
    }
    return nodes.sort((a, b) => compareNodes(a, b, order));
  };
  return build(root, '');
}

/** VS Code's originalShouldCollapse, decided when a row first appears: auto collapses a file or folder past 10 matches. */
export function startsCollapsed(count: number, setting: SearchCollapseResults): boolean {
  return setting === 'alwaysCollapse' || (count > 10 && setting !== 'alwaysExpand');
}

export const nodeCount = <F extends TreeFile>(node: TreeNode<F>): number => (node.kind === 'folder' ? node.count : node.file.matches.length);

export type ResultRow<F extends TreeFile> =
  | { readonly kind: 'folder'; readonly key: string; readonly node: FolderNode<F>; readonly level: number; readonly expanded: boolean; readonly position: number; readonly setSize: number }
  | { readonly kind: 'file'; readonly key: string; readonly file: F; readonly level: number; readonly expanded: boolean; readonly position: number; readonly setSize: number }
  | { readonly kind: 'match'; readonly key: string; readonly file: F; readonly match: F['matches'][number]; readonly level: number; readonly position: number; readonly setSize: number };

/** The visible rows, depth first, skipping the children of a collapsed key; matches in range order. */
export function flattenRows<F extends TreeFile>(nodes: ReadonlyArray<TreeNode<F>>, collapsed: ReadonlySet<string>): Array<ResultRow<F>> {
  const out: Array<ResultRow<F>> = [];
  const visit = (list: ReadonlyArray<TreeNode<F>>, level: number): void => {
    list.forEach((node, index) => {
      const expanded = !collapsed.has(node.key);
      const common = { key: node.key, level, expanded, position: index + 1, setSize: list.length };
      if (node.kind === 'folder') {
        out.push({ kind: 'folder', node, ...common });
        if (expanded) visit(node.children, level + 1);
        return;
      }
      out.push({ kind: 'file', file: node.file, ...common });
      if (!expanded) return;
      const matches = [...node.file.matches].sort((a, b) => a.range.startLine - b.range.startLine || a.range.startColumn - b.range.startColumn);
      matches.forEach((match, matchIndex) => {
        out.push({ kind: 'match', key: `m:${match.id}`, file: node.file, match, level: level + 1, position: matchIndex + 1, setSize: matches.length });
      });
    });
  };
  visit(nodes, 1);
  return out;
}

/** Every node key, depth first, for Expand All and the collapse defaults of rows that just appeared. */
export function allNodes<F extends TreeFile>(nodes: ReadonlyArray<TreeNode<F>>): Array<TreeNode<F>> {
  return nodes.flatMap((node) => (node.kind === 'folder' ? [node, ...allNodes(node.children)] : [node]));
}
