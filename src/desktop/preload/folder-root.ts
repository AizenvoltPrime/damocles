// A folder the views show and the shell names files by (D31, AD5): a project's folder, or one of its chat worktrees.
// Shared by main and (as types and pure functions) the shell.

import { isWorktreeId, WORKTREE_ID_LENGTH } from '../../shared/worktree-id';

export interface FolderRoot {
  // folderKey of the project's folder, the key the shell names projects by
  readonly projectKey: string;
  // absent: the project folder; present: the project's live `chat` worktree with this registry id
  readonly worktreeId?: string;
}

export const MAX_PROJECT_KEY_LENGTH = 200;

// No folder path holds a NUL, so it never appears inside a project key.
const SEPARATOR = '\u0000';

// Every channel and store bound on a root key is this (MAX_ID_LENGTH, MAX_SCM_ID_LENGTH, file-drag.ts), so a worktree of
// the longest project key is never refused where its project folder is taken.
export const MAX_ROOT_KEY_LENGTH: number = MAX_PROJECT_KEY_LENGTH + SEPARATOR.length + WORKTREE_ID_LENGTH;

export function isFolderRoot(value: unknown): value is FolderRoot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const record = value as Record<string, unknown>;
  const projectKey = record['projectKey'];
  if (typeof projectKey !== 'string' || projectKey.length === 0 || projectKey.length > MAX_PROJECT_KEY_LENGTH || projectKey.includes(SEPARATOR)) return false;
  if (!keys.every((key) => key === 'projectKey' || key === 'worktreeId')) return false;
  return !Object.hasOwn(record, 'worktreeId') || isWorktreeId(record['worktreeId']);
}

/**
 * The string the shell and main key a root by on every channel that names files (Files, the editor, Quick Open, Search,
 * terminals, source control views): the project key itself for the project folder.
 */
export function rootKey(root: FolderRoot): string {
  return root.worktreeId === undefined ? root.projectKey : `${root.projectKey}${SEPARATOR}${root.worktreeId}`;
}

/** The root a key names, or undefined when the text is no root key; main still resolves it against its own lists. */
export function parseRootKey(key: unknown): FolderRoot | undefined {
  if (typeof key !== 'string') return undefined;
  const at = key.indexOf(SEPARATOR);
  const root = at < 0 ? { projectKey: key } : { projectKey: key.slice(0, at), worktreeId: key.slice(at + 1) };
  return isFolderRoot(root) ? root : undefined;
}
