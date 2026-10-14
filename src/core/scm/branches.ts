// Checkout, branch, merge and rebase argv and outcomes (VS Code's extensions/git/src/git.ts checkout, branch, deleteBranch,
// renameBranch, merge and rebase; repository.ts fastForwardBranch). Every short name passes revision(), so it never reads as
// an option. checkout parses --end-of-options as a path before git 2.44, so its revision follows `-q` and precedes `--`.
import { endOfOptions, GitError, revision, type GitResult, type GitVersion } from './git-runner';
import type { Repository, StashedOutcome, StashMode } from './repository';
import { remoteArg } from './sync';

export type CheckoutTarget =
  // a local branch by its short name
  | { readonly kind: 'branch'; readonly name: string }
  // a remote branch (refs/remotes/<remote>/<branch>): a new local branch tracking it (VS Code's checkoutTracking)
  | { readonly kind: 'track'; readonly ref: string }
  // a commit or a full refname, with HEAD detached there
  | { readonly kind: 'detached'; readonly revision: string };

export function checkoutArgs(target: CheckoutTarget): string[] {
  switch (target.kind) {
    case 'branch':
      return ['checkout', '-q', revision(target.name), '--'];
    case 'track':
      if (!target.ref.startsWith('refs/remotes/')) throw new Error('Only a remote branch is checked out with --track');
      return ['checkout', '-q', '--track', revision(target.ref), '--'];
    case 'detached':
      return ['checkout', '-q', '--detach', revision(target.revision), '--'];
  }
}

export function failed(args: readonly string[], result: GitResult): GitError {
  return new GitError(`git ${args.find((arg) => !arg.startsWith('-')) ?? ''} exited with ${result.exitCode}`, result.exitCode, result.stdout.toString('utf8'), result.stderr);
}

/** dirty: git refused because the checkout would overwrite local changes (VS Code's DirtyWorkTree). */
export async function checkout(repo: Repository, target: CheckoutTarget): Promise<'ok' | 'dirty'> {
  const args = checkoutArgs(target);
  const result = await repo.write(args, { english: true, allowFailure: true });
  if (result.exitCode === 0) return 'ok';
  if (/Please,? commit your changes or stash them/.test(result.stderr)) return 'dirty';
  throw failed(args, result);
}

/** VS Code's branch(name, checkout: true, ref): `checkout -q -b <name> --no-track <start>`. */
export function createBranchArgs(name: string, start: string): string[] {
  return ['checkout', '-q', '-b', revision(name), '--no-track', revision(start), '--'];
}

/**
 * VS Code's sanitizeBranchName (commands.ts), regular expression unchanged: trims, drops leading dashes and replaces each
 * sequence check-ref-format refuses, and each whitespace character, with whitespaceChar.
 */
export function sanitizeBranchName(name: string, whitespaceChar: string): string {
  return name ? name.trim().replace(/^-+/, '').replace(/^\.|\/\.|\.\.|~|\^|:|\/$|\.lock$|\.lock\/|\\|\*|\s|^\s*$|\.$|\[|\]$/g, whitespaceChar) : name;
}

export function renameBranchArgs(name: string, version: GitVersion): string[] {
  return ['branch', '-m', ...endOfOptions(version), revision(name)];
}

/** unmerged: `branch -d` refused a branch not merged into its upstream or HEAD (VS Code's BranchNotFullyMerged). */
export async function deleteBranch(repo: Repository, name: string, force: boolean): Promise<'ok' | 'unmerged'> {
  const args = ['branch', force ? '-D' : '-d', ...repo.endOfOptions(), revision(name)];
  const result = await repo.write(args, { english: true, allowFailure: true });
  if (result.exitCode === 0) return 'ok';
  if (!force && /is not fully merged/.test(result.stderr)) return 'unmerged';
  throw failed(args, result);
}

export function integrate(repo: Repository, command: 'merge' | 'rebase', name: string, mode: () => StashMode): Promise<StashedOutcome<'ok' | 'conflict'>> {
  const args = [command, ...repo.endOfOptions(), revision(name)];
  return repo.withStash(mode, async (git, slot) => {
    await slot.stash();
    const result = await git(args, { allowFailure: true });
    if (result.exitCode === 0) return 'ok';
    if (await repo.hasConflicts()) return 'conflict';
    throw failed(args, result);
  });
}

/**
 * VS Code's fastForwardBranch: fetch the upstream's branch into the local one, which git refuses unless it fast-forwards
 * (no '+', so a branch with outgoing commits stays as it is).
 */
export function fastForwardArgs(remote: string, upstreamBranch: string, branch: string, version: GitVersion): string[] {
  return ['fetch', ...endOfOptions(version), remoteArg(remote), `${revision(`refs/heads/${upstreamBranch}`)}:${revision(`refs/heads/${branch}`)}`];
}

/** VS Code's deleteRemoteRef: `push <remote> --delete <ref>`, the ref in full so its name never reads as a refspec. */
export function deleteRemoteRefArgs(remote: string, ref: string, version: GitVersion): string[] {
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) throw new Error('A remote ref to delete is a branch or a tag');
  return ['push', '--delete', ...endOfOptions(version), remoteArg(remote), revision(ref)];
}
