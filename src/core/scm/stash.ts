// Stash argv and outcomes (VS Code's extensions/git/src/git.ts createStash, applyStash, popStash, dropStash). A stash is
// named by the commit main listed: apply takes the commit itself, and pop and drop, which need its reflog entry, check that
// stash@{n} still names that commit in the same mutation slot.
import { gitAtLeast, type GitVersion } from './git-runner';
import { failed, hasUnmerged } from './branches';
import { isObjectName } from './artifacts';
import { checkRepoPath, type Repository } from './repository';

export type StashScope = 'default' | 'includeUntracked' | 'staged';

export interface StashTarget {
  readonly index: number;
  readonly hash: string;
}

/** Stash Staged needs git 2.35 (AD4); without git it is never offered. */
export function canStashStaged(version: GitVersion | undefined): boolean {
  return version !== undefined && gitAtLeast(version, 2, 35);
}

/** `stash push`: --include-untracked and --staged by scope, the message, paths (Stash Changes) after --, read literally. */
export function stashPushArgs(scope: StashScope, message: string, paths: readonly string[]): string[] {
  return [
    'stash',
    'push',
    ...(scope === 'includeUntracked' ? ['--include-untracked'] : []),
    ...(scope === 'staged' ? ['--staged'] : []),
    // one argument, so a message such as '--' never reads as the pathspec separator
    ...(message !== '' ? [`--message=${message}`] : []),
    ...(paths.length > 0 ? ['--', ...paths] : []),
  ];
}

/** noCommits: the repository has no commit to stash on; noChanges: git found nothing to save. */
export async function stashPush(repo: Repository, scope: StashScope, message: string, paths: readonly string[] = []): Promise<'ok' | 'noCommits' | 'noChanges'> {
  if (scope === 'staged' && !canStashStaged(repo.gitVersion)) throw new Error('Stash Staged needs git 2.35 or later');
  for (const entry of paths) checkRepoPath(entry);
  const args = stashPushArgs(scope, message, paths);
  const result = await repo.write(args, { english: true, allowFailure: true, ...(paths.length > 0 ? { literalPathspecs: true as const } : {}) });
  if (result.exitCode === 0) return /No local changes to save/.test(result.stdout.toString('utf8')) ? 'noChanges' : 'ok';
  if (/You do not have the initial commit yet/.test(result.stderr)) return 'noCommits';
  if (/No local changes to save/.test(result.stderr)) return 'noChanges';
  throw failed(args, result);
}

const stashRef = (index: number): string => {
  if (!Number.isInteger(index) || index < 0) throw new Error('A stash index is a non-negative integer');
  return `stash@{${index}}`;
};

/**
 * Apply or Pop: conflict when git stopped with unmerged entries (the stash is kept, as git keeps it); moved when stash@{n}
 * no longer names the commit (pop only). Refused with conflicted as the message while the index has unmerged entries, which
 * git cannot write, so any found after the apply are its own; `--quiet` prints no CONFLICT line to read instead.
 */
export function stashApply(repo: Repository, target: StashTarget, pop: boolean, conflicted: string): Promise<'ok' | 'conflict' | 'moved'> {
  if (!isObjectName(target.hash)) throw new Error('A stash is named by its full object name');
  return repo.mutate(async (git) => {
    if (await hasUnmerged(git)) throw new Error(conflicted);
    if (pop && !(await names(git, target))) return 'moved';
    // --quiet: otherwise git runs a status that enters every submodule, a declined project's included
    const args = ['stash', pop ? 'pop' : 'apply', '--quiet', ...repo.endOfOptions(), pop ? stashRef(target.index) : target.hash];
    const result = await git(args, { allowFailure: true });
    if (result.exitCode === 0) return 'ok';
    if (await hasUnmerged(git)) return 'conflict';
    throw failed(args, result);
  });
}

/** Drop: moved when stash@{n} no longer names the commit. */
export function stashDrop(repo: Repository, target: StashTarget): Promise<'ok' | 'moved'> {
  if (!isObjectName(target.hash)) throw new Error('A stash is named by its full object name');
  return repo.mutate(async (git) => {
    if (!(await names(git, target))) return 'moved';
    await git(['stash', 'drop', ...repo.endOfOptions(), stashRef(target.index)]);
    return 'ok';
  });
}

/** Drop All Stashes: `stash clear`. */
export async function stashClear(repo: Repository): Promise<void> {
  await repo.write(['stash', 'clear']);
}

async function names(git: Parameters<Parameters<Repository['mutate']>[0]>[0], target: StashTarget): Promise<boolean> {
  const result = await git(['rev-parse', '-q', '--verify', stashRef(target.index)], { allowFailure: true, english: true });
  return result.exitCode === 0 && result.stdout.toString('utf8').trim() === target.hash;
}
