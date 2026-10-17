import type { ShellEditorTab } from '../../preload/shell-channels';
import { parseRootKey } from '../../preload/folder-root';
import { visibleText } from '@shared/visible-text';

/**
 * Where a tab's file lives (D31): a chat worktree, the project folder while that project has worktree tabs open, or unmarked.
 * A worktree's branch is undefined while main cannot name it; `label` is the part of the branch its chip shows.
 */
export type TabPlace =
  | { readonly kind: 'worktree'; readonly branch: string | undefined; readonly label: string | undefined }
  | { readonly kind: 'project' }
  | undefined;

/** What every open tab's place depends on: the projects with worktree tabs open, and the label each open branch shows. */
export interface TabPlaces {
  readonly worktreeProjects: ReadonlySet<string>;
  readonly labels: ReadonlyMap<string, string>;
}

// A tab's root key names its worktree whether or not main can still name the branch.
const worktreeRootOf = (tab: ShellEditorTab) => {
  const root = parseRootKey(tab.projectKey);
  return root?.worktreeId === undefined ? undefined : root;
};

/**
 * The shortest '/'-separated suffix of each branch that no other branch ends with, as VS Code labels same-named tabs: the
 * leaf alone unless another open branch has the same leaf.
 */
export function branchLabels(branches: Iterable<string>): Map<string, string> {
  const distinct = [...new Set(branches)];
  const split = new Map(distinct.map((branch) => [branch, branch.split('/')]));
  const suffix = (branch: string, length: number): string => split.get(branch)!.slice(-length).join('/');
  return new Map(distinct.map((branch) => {
    const segments = split.get(branch)!.length;
    for (let length = 1; length < segments; length++) {
      const label = suffix(branch, length);
      if (!distinct.some((other) => other !== branch && suffix(other, length) === label)) return [branch, label];
    }
    return [branch, branch];
  }));
}

export function tabPlaces(tabs: readonly ShellEditorTab[]): TabPlaces {
  const worktreeProjects = new Set<string>();
  const branches: string[] = [];
  for (const tab of tabs) {
    const root = worktreeRootOf(tab);
    if (!root) continue;
    worktreeProjects.add(root.projectKey);
    if (tab.worktreeBranch !== undefined) branches.push(tab.worktreeBranch);
  }
  return { worktreeProjects, labels: branchLabels(branches) };
}

// clientWidth and scrollWidth round a fractional box separately, so a box that fits can read one pixel short.
const ROUNDING_PX = 1;

/** Widths in CSS px of a box whose text may be cut: what it shows and what its text needs. */
export interface TextFit {
  readonly clientWidth: number;
  readonly scrollWidth: number;
}

/**
 * A place chip folds to its icon when its whole label does not fit beside the title, which gives way first: the title is
 * cut below `minTitle`, or below its own width when that is shorter.
 */
export function placeChipFolds(title: TextFit, minTitle: number): boolean {
  return title.clientWidth + ROUNDING_PX < Math.min(title.scrollWidth, minTitle);
}

export function placeOf(tab: ShellEditorTab, places: TabPlaces): TabPlace {
  if (worktreeRootOf(tab)) {
    const branch = tab.worktreeBranch;
    return { kind: 'worktree', branch, label: branch === undefined ? undefined : places.labels.get(branch) };
  }
  const root = parseRootKey(tab.projectKey);
  return root && places.worktreeProjects.has(root.projectKey) ? { kind: 'project' } : undefined;
}

/** The file's own name as shown: a Compare tab's title names the comparison, its path names the file on any tab. */
export function tabFileName(tab: Pick<ShellEditorTab, 'displayPath' | 'title'>): string {
  // Escaped after the split, since an escape holds a backslash.
  const leaf = tab.displayPath.split(/[\\/]/).at(-1) ?? '';
  return leaf === '' ? tab.title : visibleText(leaf);
}
