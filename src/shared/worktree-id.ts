/** A worktree's 8-character id, also its folder name under the worktrees root (AD12 Names). */
export const WORKTREE_ID_LENGTH = 8;
export const WORKTREE_ID_PATTERN: RegExp = /^[0-9a-z]{8}$/;

export function isWorktreeId(value: unknown): value is string {
  return typeof value === 'string' && WORKTREE_ID_PATTERN.test(value);
}
