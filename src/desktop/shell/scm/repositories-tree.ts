import type { ScmArtifacts, ScmBranchArtifact, ScmStashArtifact, ScmTagArtifact, ScmWorktreeArtifact } from '../../preload/scm-channels';

// The Repositories section's rows (D58), one flat list for the virtualized tree: VS Code's Source Control Repositories view in
// explorer mode. sortRefByName, the folder tree with its merged single-child chains, the descriptions and the worktree order
// are ported from extensions/git/src/artifactProvider.ts, the repeated-time hiding and the compression rule from
// src/vs/workbench/contrib/scm/browser/scmRepositoriesViewPane.ts (VS Code, MIT, Copyright (c) Microsoft Corporation; see
// THIRD-PARTY-NOTICES.md).

/** The groups of a repository, in VS Code's order; Branches and Tags group into folders at each '/'. */
export const REPOSITORY_GROUPS = ['branches', 'stashes', 'tags', 'worktrees'] as const;
export type RepositoryGroup = (typeof REPOSITORY_GROUPS)[number];

/**
 * A group's rows as the section holds them: absent until it is first expanded, then loading, ready or failed; gone once main
 * answered that it no longer has the repository, until the view drops it.
 */
export type GroupList =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly artifacts: ScmArtifacts }
  | { readonly state: 'failed' }
  | { readonly state: 'gone' };

export interface RepositoryEntry {
  readonly repoId: string;
  readonly label: string;
  // project-relative ('' for the project folder), or absolute for a parent repository: stable across runs, so row ids use it
  readonly displayPath: string;
  // HEAD's branch or detached commit, the repository row's description
  readonly head: string;
}

export interface RepositoryTreeInput {
  readonly repos: readonly RepositoryEntry[];
  // ids of expanded repository, group and folder rows
  readonly expanded: ReadonlySet<string>;
  // a group's list, undefined while it has never been requested
  readonly lists: (repoId: string, group: RepositoryGroup) => GroupList | undefined;
  // a commit date as the row shows it (VS Code's fromNow); two rows showing the same text hide the second's
  readonly timeOf: (date: number) => string;
  // VS Code's l10n 'detached', in a worktree's description
  readonly detached: string;
  // each ready list's rows from an earlier build, reused while the inputs they were built from are the same
  readonly memo?: GroupRowsMemo;
}

export type GroupRowsMemo = WeakMap<GroupList, { readonly inputs: readonly unknown[]; readonly rows: readonly RepositoryRow[] }>;

// position and setSize: 1-based among the row's siblings, for aria-posinset and aria-setsize; level for aria-level.
interface Placed {
  readonly key: string;
  readonly repoId: string;
  readonly level: number;
  readonly position: number;
  readonly setSize: number;
}
// time: the commit's relative time, '' without one; timeHidden: the row above in the same folder shows the same time
interface Timed {
  readonly time: string;
  readonly timeHidden: boolean;
}
export type RepositoryRow = Placed & (
  | { readonly kind: 'repo'; readonly repo: RepositoryEntry; readonly expanded: boolean }
  | { readonly kind: 'group'; readonly group: RepositoryGroup; readonly count: number | null; readonly loading: boolean; readonly expanded: boolean }
  // path: the folder's full path in its group; label: its segment, or the merged chain as VS Code's compressed row shows it
  | { readonly kind: 'folder'; readonly group: 'branches' | 'tags'; readonly path: string; readonly label: string; readonly count: number; readonly expanded: boolean }
  | ({ readonly kind: 'branch'; readonly branch: ScmBranchArtifact; readonly label: string; readonly description: string } & Timed)
  | ({ readonly kind: 'tag'; readonly tag: ScmTagArtifact; readonly label: string; readonly description: string } & Timed)
  | ({ readonly kind: 'stash'; readonly stash: ScmStashArtifact; readonly label: string; readonly description: string } & Timed)
  | { readonly kind: 'worktree'; readonly worktree: ScmWorktreeArtifact; readonly label: string; readonly description: string }
  | { readonly kind: 'note'; readonly group: RepositoryGroup; readonly text: 'empty' | 'failed' }
);
export type ExpandableRow = Extract<RepositoryRow, { kind: 'repo' | 'group' | 'folder' }>;

export const isExpandable = (row: RepositoryRow): row is ExpandableRow => row.kind === 'repo' || row.kind === 'group' || row.kind === 'folder';

// Row ids name a repository by its display path, so an expanded row is the same row after a restart (AD8).
const id = (...parts: readonly string[]): string => JSON.stringify(parts);
export const repoRowId = (repo: Pick<RepositoryEntry, 'displayPath'>): string => id('repo', repo.displayPath);
export const groupRowId = (repo: Pick<RepositoryEntry, 'displayPath'>, group: RepositoryGroup): string => id('group', repo.displayPath, group);
export const folderRowId = (repo: Pick<RepositoryEntry, 'displayPath'>, group: RepositoryGroup, path: string): string => id('folder', repo.displayPath, group, path);
const leafRowId = (repo: Pick<RepositoryEntry, 'displayPath'>, kind: string, name: string): string => id(kind, repo.displayPath, name);

/** The expanded ids naming a folder row of `group` that none of its refs' `names` holds any more. */
export function missingFolderIds(expanded: readonly string[], repo: Pick<RepositoryEntry, 'displayPath'>, group: 'branches' | 'tags', names: readonly string[]): string[] {
  const live = new Set<string>();
  for (const name of names) {
    const segments = name.split('/').filter((part) => part !== '');
    for (let depth = 1; depth < segments.length; depth++) live.add(folderRowId(repo, group, segments.slice(0, depth).join('/')));
  }
  // every folder id of this repository's group starts so, being the JSON of an array that begins with these three
  const prefix = `${JSON.stringify(['folder', repo.displayPath, group]).slice(0, -1)},`;
  return expanded.filter((key) => key.startsWith(prefix) && !live.has(key));
}

interface Ref {
  readonly ref: string;
  readonly name: string;
  readonly commit: { readonly hash: string; readonly subject: string; readonly date: number } | null;
}

/**
 * VS Code's sortRefByName: refs with a '/' (inside folders) come first, their folders compared segment by segment with
 * localeCompare and a deeper folder before a shallower one it shares a prefix with; refs in one folder, and refs with no '/',
 * keep their order (for-each-ref --sort=-creatordate, newest first).
 */
export function sortRefByName(a: Pick<Ref, 'name'>, b: Pick<Ref, 'name'>): number {
  const lastSlashA = a.name.lastIndexOf('/');
  const lastSlashB = b.name.lastIndexOf('/');
  if (lastSlashA === -1 && lastSlashB === -1) return 0;
  if (lastSlashA !== -1 && lastSlashB === -1) return -1;
  if (lastSlashA === -1) return 1;
  const segmentsA = a.name.substring(0, lastSlashA).split('/');
  const segmentsB = b.name.substring(0, lastSlashB).split('/');
  for (let index = 0; index < Math.min(segmentsA.length, segmentsB.length); index++) {
    const result = segmentsA[index]!.localeCompare(segmentsB[index]!);
    if (result !== 0) return result;
  }
  return segmentsB.length - segmentsA.length;
}

/** VS Code's sortByWorktreeTypeAndNameAsc: the main worktree first, then the others by name. */
export function sortWorktrees(a: ScmWorktreeArtifact, b: ScmWorktreeArtifact): number {
  if (a.main !== b.main) return a.main ? -1 : 1;
  return a.name.localeCompare(b.name);
}

// VS Code's artifact description: the 7-character hash and the message's first line, each only when present.
function refDescription(commit: Ref['commit']): string {
  return commit ? [commit.hash.substring(0, 7), commit.subject].join(' \u2022 ') : '';
}

// A branch or tag row shows its name's last segment, the folders above it being rows of their own.
const lastSegment = (name: string): string => name.slice(name.lastIndexOf('/') + 1);

// The id's folder: refs/heads/feat/a is in refs/heads/feat, refs/heads/main in refs/heads.
const directoryOf = (ref: string): string => (ref.lastIndexOf('/') > 0 ? ref.substring(0, ref.lastIndexOf('/')) : ref);

/**
 * scmRepositoriesViewPane's hideTimestamp over a sorted list: a row hides its time when the row before it is in the same
 * folder and both show the same relative time.
 */
export function hiddenTimes<T>(rows: readonly T[], dateOf: (row: T) => number | undefined, folderOf: (row: T) => string, timeOf: (date: number) => string): boolean[] {
  return rows.map((row, index) => {
    if (index === 0) return false;
    const previous = rows[index - 1]!;
    const date = dateOf(row);
    const previousDate = dateOf(previous);
    return date !== undefined && previousDate !== undefined && folderOf(row) === folderOf(previous) && timeOf(previousDate) === timeOf(date);
  });
}

// ResourceTree's node: a folder holds children in the order they were first added; a leaf holds its ref.
interface Node<T extends Ref> {
  readonly name: string;
  readonly path: string;
  readonly children: Map<string, Node<T>>;
  leaf?: { readonly ref: T; readonly timeHidden: boolean };
}

function leafCount<T extends Ref>(node: Node<T>): number {
  let count = 0;
  for (const child of node.children.values()) count += child.leaf ? 1 : leafCount(child);
  return count;
}

/** The rows of an expanded Branches or Tags group: its folders and refs, as VS Code's compressed resource tree shows them. */
function refRows<T extends Ref>(
  repo: RepositoryEntry,
  group: 'branches' | 'tags',
  refs: readonly T[],
  level: number,
  input: RepositoryTreeInput,
  leaf: (ref: T, base: Placed, timed: Timed) => RepositoryRow,
): RepositoryRow[] {
  const sorted = [...refs].sort(sortRefByName);
  const hidden = hiddenTimes(sorted, (ref) => ref.commit?.date, (ref) => directoryOf(ref.ref), input.timeOf);
  const root: Node<T> = { name: '', path: '', children: new Map() };
  sorted.forEach((ref, index) => {
    let node = root;
    for (const segment of ref.name.split('/').filter((part) => part !== '')) {
      let child = node.children.get(segment);
      if (!child) node.children.set(segment, (child = { name: segment, path: node.path === '' ? segment : `${node.path}/${segment}`, children: new Map() }));
      node = child;
    }
    node.leaf = { ref, timeHidden: hidden[index]! };
  });
  const rows: RepositoryRow[] = [];
  const walk = (node: Node<T>, depth: number): void => {
    const setSize = node.children.size;
    let position = 0;
    for (const child of node.children.values()) {
      position++;
      if (child.leaf) {
        const { ref, timeHidden } = child.leaf;
        rows.push(leaf(ref, { key: leafRowId(repo, group, ref.ref), repoId: repo.repoId, level: depth, position, setSize }, { time: ref.commit ? input.timeOf(ref.commit.date) : '', timeHidden }));
        continue;
      }
      // VS Code's compression: a folder takes in its only child while that child is a folder holding one child itself
      let end = child;
      for (;;) {
        const only = end.children.size === 1 ? end.children.values().next().value : undefined;
        if (!only || only.leaf || only.children.size !== 1) break;
        end = only;
      }
      const key = folderRowId(repo, group, end.path);
      const expanded = input.expanded.has(key);
      // a merged row is labelled with its folder's whole path, as renderCompressedElements labels it
      rows.push({ kind: 'folder', key, repoId: repo.repoId, group, path: end.path, label: end === child ? child.name : end.path, count: leafCount(end), expanded, level: depth, position, setSize });
      if (expanded) walk(end, depth + 1);
    }
  };
  walk(root, level);
  return rows;
}

function memoGroupRows(repo: RepositoryEntry, list: Extract<GroupList, { state: 'ready' }>, level: number, input: RepositoryTreeInput): readonly RepositoryRow[] {
  const inputs = [repo.repoId, repo.displayPath, level, input.expanded, input.timeOf, input.detached];
  const cached = input.memo?.get(list);
  if (cached && cached.inputs.every((value, index) => value === inputs[index])) return cached.rows;
  const rows = groupRows(repo, list, level, input);
  input.memo?.set(list, { inputs, rows });
  return rows;
}

function groupRows(repo: RepositoryEntry, list: Extract<GroupList, { state: 'ready' }>, level: number, input: RepositoryTreeInput): RepositoryRow[] {
  const artifacts = list.artifacts;
  switch (artifacts.group) {
    case 'branches':
      return refRows(repo, 'branches', artifacts.rows, level, input, (branch, base, timed) => ({
        ...base, ...timed, kind: 'branch', branch, label: lastSegment(branch.name), description: refDescription(branch.commit),
      }));
    case 'tags':
      return refRows(repo, 'tags', artifacts.rows, level, input, (tag, base, timed) => ({
        ...base, ...timed, kind: 'tag', tag, label: lastSegment(tag.name), description: refDescription(tag.commit),
      }));
    case 'stashes': {
      const hidden = hiddenTimes(artifacts.rows, (stash) => stash.date, () => '', input.timeOf);
      return artifacts.rows.map((stash, index) => ({
        kind: 'stash', key: leafRowId(repo, 'stash', stash.hash), repoId: repo.repoId, level, position: index + 1, setSize: artifacts.rows.length,
        stash, label: stash.description, description: stash.branch ?? '', time: input.timeOf(stash.date), timeHidden: hidden[index]!,
      }));
    }
    case 'worktrees': {
      const sorted = [...artifacts.rows].sort(sortWorktrees);
      return sorted.map((worktree, index) => ({
        kind: 'worktree', key: leafRowId(repo, 'worktree', worktree.path), repoId: repo.repoId, level, position: index + 1, setSize: sorted.length,
        worktree, label: worktree.name,
        description: [worktree.branch ?? input.detached, worktree.commit?.hash.substring(0, 7), worktree.commit?.subject].filter((part) => part !== undefined).join(' \u2022 '),
      }));
    }
    case 'remoteBranches':
      return [];
  }
}

/**
 * The section's visible rows: each repository (left out when there is one, so its groups are the top level), its expanded
 * groups and folders and their items. A group's list is read only once it is expanded; an expanded group still loading or gone
 * shows no rows, a failed or empty one a note.
 */
export function buildRepositoryRows(input: RepositoryTreeInput): RepositoryRow[] {
  const rows: RepositoryRow[] = [];
  const single = input.repos.length === 1;
  input.repos.forEach((repo, repoIndex) => {
    const groupLevel = single ? 1 : 2;
    if (!single) {
      const key = repoRowId(repo);
      const expanded = input.expanded.has(key);
      rows.push({ kind: 'repo', key, repoId: repo.repoId, repo, expanded, level: 1, position: repoIndex + 1, setSize: input.repos.length });
      if (!expanded) return;
    }
    REPOSITORY_GROUPS.forEach((group, groupIndex) => {
      const key = groupRowId(repo, group);
      const expanded = input.expanded.has(key);
      const list = input.lists(repo.repoId, group);
      const count = list?.state === 'ready' ? list.artifacts.rows.length : null;
      rows.push({ kind: 'group', key, repoId: repo.repoId, group, count, loading: list?.state === 'loading', expanded, level: groupLevel, position: groupIndex + 1, setSize: REPOSITORY_GROUPS.length });
      if (!expanded || list === undefined || list.state === 'loading' || list.state === 'gone') return;
      const children = list.state === 'ready' ? memoGroupRows(repo, list, groupLevel + 1, input) : [];
      if (children.length > 0) rows.push(...children);
      else rows.push({ kind: 'note', key: id('note', repo.displayPath, group), repoId: repo.repoId, group, text: list.state === 'failed' ? 'failed' : 'empty', level: groupLevel + 1, position: 1, setSize: 1 });
    });
  });
  return rows;
}

/** The groups a row list shows expanded, which the section reads and keeps reading while they stay expanded. */
export function expandedGroups(rows: readonly RepositoryRow[]): Array<{ readonly repoId: string; readonly group: RepositoryGroup }> {
  return rows.flatMap((row) => (row.kind === 'group' && row.expanded ? [{ repoId: row.repoId, group: row.group }] : []));
}

/**
 * Type-ahead in the tree (plan section 7): the next row after `start` whose label starts with `typed`, wrapping; repeating one
 * character cycles through the rows that start with it, as the overlay's menus do.
 */
export function typeAheadIndex(labels: readonly string[], start: number, typed: string): number | undefined {
  if (typed === '' || labels.length === 0) return undefined;
  const first = typed[0]!;
  const needle = ([...typed].every((char) => char === first) ? first : typed).toLocaleLowerCase();
  for (let step = 1; step <= labels.length; step++) {
    const index = (start + step) % labels.length;
    if (labels[index]!.toLocaleLowerCase().startsWith(needle)) return index;
  }
  return undefined;
}
