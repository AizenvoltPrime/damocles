// Branch names for worktree chats (slice 12a Outcome, "Branch name"; D63).
import type { GitRunner } from '../scm/git-runner';

const SLUG_WORDS = 5;
const SLUG_MAX_LENGTH = 40;
const SLUG_MIN_CHARS = 3;
export const DEFAULT_BRANCH_PREFIX = 'damocles/';
// A name already taken gets -2, -3 and so on; past this many git keeps refusing for a reason no suffix fixes.
const MAX_SUFFIX = 100;

/** The lowercase ASCII letters and digits of the prompt's first five words, joined with '-', at most 40 characters; `chat-<id>` below 3 such characters. */
export function branchSlug(prompt: string, id: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, SLUG_WORDS);
  const parts = words.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, '')).filter((w) => w.length > 0);
  const chars = parts.reduce((n, p) => n + p.length, 0);
  if (chars < SLUG_MIN_CHARS) return `chat-${id}`;
  return parts.join('-').slice(0, SLUG_MAX_LENGTH).replace(/-+$/, '');
}

/** `branchPrefix` plus the slug when the prefix is set, otherwise `damocles/` plus the slug (D63). */
export function branchBaseName(branchPrefix: string, slug: string): string {
  return `${branchPrefix !== '' ? branchPrefix : DEFAULT_BRANCH_PREFIX}${slug}`;
}

export class BranchNameError extends Error {
  readonly branch: string;
  constructor(branch: string, detail: string) {
    super(detail);
    this.name = 'BranchNameError';
    this.branch = branch;
  }
}

/**
 * The first of `base`, `base-2`, `base-3`, ... that `git check-ref-format --branch` accepts and no local branch holds.
 * Throws BranchNameError with git's message when git refuses the name itself.
 */
export async function freeBranchName(git: GitRunner, project: string, cwd: string, base: string): Promise<string> {
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (candidate.startsWith('-')) throw new BranchNameError(candidate, `'${candidate}' is not a valid branch name`);
    const check = await git.run({ project, cwd, args: ['check-ref-format', '--branch', candidate], kind: 'read', parsed: true, allowFailure: true });
    if (check.exitCode !== 0) throw new BranchNameError(candidate, check.stderr.trim() || `'${candidate}' is not a valid branch name`);
    const exists = await git.run({ project, cwd, args: ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], kind: 'read', parsed: true, allowFailure: true });
    if (exists.exitCode !== 0) return candidate;
  }
  throw new BranchNameError(base, `Every name from ${base} to ${base}-${MAX_SUFFIX} is taken`);
}
