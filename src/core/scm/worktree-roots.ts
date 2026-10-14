// The folder each repository root last created a worktree in, kept in global KeyValueState under WORKTREE_ROOTS_KEY as
// { [folderKey(root)]: folder }. VS Code keeps the same per root (repository.ts createWorktree, `worktreeRoot:<root>`), but
// writes it only when a value already exists; this records it on every creation, the first included.
import type { Memento } from '../../platform/key-value-state';
import { folderKey } from '../workspace-folders/folder-key';
import { updateSerially } from './serial-update';

export const WORKTREE_ROOTS_KEY = 'damocles.scm.worktreeRoots';
// Roots kept; the root that created a worktree longest ago goes first, so the stored value stays bounded.
export const WORKTREE_ROOTS_LIMIT = 100;

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The folder the root's last worktree was created in, or undefined. */
export function worktreeRoot(state: Memento, root: string): string | undefined {
  const all = recordOf(state.get<unknown>(WORKTREE_ROOTS_KEY, {}));
  const key = folderKey(root);
  const folder = Object.hasOwn(all, key) ? all[key] : undefined;
  return typeof folder === 'string' && folder !== '' ? folder : undefined;
}

/** Remembers `folder` as the root's worktree folder. */
export function recordWorktreeRoot(state: Memento, root: string, folder: string): Promise<void> {
  const key = folderKey(root);
  return updateSerially(state, WORKTREE_ROOTS_KEY, (current) => {
    const others = Object.entries(recordOf(current)).filter(([candidate]) => candidate !== key);
    // insertion order is recency: the root just written goes last, and the oldest roots fall off the front
    return Object.fromEntries([...others.slice(Math.max(0, others.length - WORKTREE_ROOTS_LIMIT + 1)), [key, folder]]);
  });
}
