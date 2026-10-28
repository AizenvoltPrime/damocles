// Worktree argv and outcomes (VS Code's extensions/git/src/git.ts addWorktree and deleteWorktree, commands.ts
// _createWorktree, repository.ts createWorktree and deleteWorktree). A worktree path is absolute, so it never reads as an
// option, and follows --end-of-options all the same.
import * as path from 'node:path';
import { revision } from './git-runner';
import { failed } from './branches';
import type { Repository } from './repository';

/** VS Code's worktree folder name: the branch (or commit-ish) without branchPrefix, '/' turned to '-'. */
export function worktreeName(branchOrCommitish: string, branchPrefix: string): string {
  const name = branchPrefix !== '' && branchOrCommitish.startsWith(branchPrefix) ? branchOrCommitish.slice(branchPrefix.length) : branchOrCommitish;
  return name.replace(/\//g, '-');
}

/**
 * VS Code's default worktree path: `<root>.worktrees/<name>` beside the repository, or `<name>` beside a linked worktree, in
 * the path rules of the host the repository is on.
 */
export function defaultWorktreePath(root: string, name: string, linked: boolean, flavor: path.PlatformPath = path): string {
  return linked ? flavor.join(flavor.dirname(root), name) : flavor.join(flavor.dirname(root), `${flavor.basename(root)}.worktrees`, name);
}

/** `worktree add [-b <branch>] <path> <commit-ish>`; a new branch starts at commitish, an existing one is checked out there. */
export function addWorktreeArgs(worktreePath: string, commitish: string, branch: string | undefined, endOfOptions: readonly string[]): string[] {
  if (!path.isAbsolute(worktreePath)) throw new Error('A worktree path is absolute');
  return ['worktree', 'add', ...(branch !== undefined ? ['-b', revision(branch)] : []), ...endOfOptions, worktreePath, revision(commitish)];
}

export async function addWorktree(repo: Repository, worktreePath: string, commitish: string, branch: string | undefined): Promise<void> {
  await repo.write(addWorktreeArgs(worktreePath, commitish, branch, repo.endOfOptions()));
}

/** dirty: git refused a worktree with modified or untracked files (VS Code's WorktreeContainsChanges); --force removes it. */
export async function removeWorktree(repo: Repository, worktreePath: string, force: boolean): Promise<'ok' | 'dirty'> {
  if (!path.isAbsolute(worktreePath)) throw new Error('A worktree path is absolute');
  const args = ['worktree', 'remove', ...(force ? ['--force'] : []), ...repo.endOfOptions(), worktreePath];
  const result = await repo.write(args, { english: true, allowFailure: true });
  if (result.exitCode === 0) return 'ok';
  if (!force && /contains modified or untracked files/.test(result.stderr)) return 'dirty';
  throw failed(args, result);
}
