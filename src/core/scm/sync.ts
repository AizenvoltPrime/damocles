// Fetch, pull, push and sync argv (VS Code's extensions/git/src/git.ts fetch, pull and push, repository.ts _sync). A remote
// name passes isRemoteName and a branch revision() before it reaches an argv, and both follow --end-of-options.
import { endOfOptions, gitAtLeast, isSafeRevision, revision, type GitVersion } from './git-runner';
import { isRemoteName } from './remotes';
import type { Upstream } from './repository';

export interface FetchOptions {
  // absent: git's default remote
  readonly remote?: string;
  readonly all?: boolean;
  readonly prune: boolean;
}

export interface PullOptions {
  readonly rebase: boolean;
  readonly autoStash: boolean;
  // both or neither: the upstream's remote and its branch on the remote
  readonly remote?: string;
  readonly branch?: string;
}

export interface PushOptions {
  // absent: git push with no remote, which pushes as push.default says
  readonly remote?: string;
  // the local branch, pushed to toBranch (default: the same name) on remote
  readonly branch?: string;
  readonly toBranch?: string;
  readonly setUpstream: boolean;
  readonly followTags: boolean;
  readonly force: boolean;
}

export function remoteArg(remote: string): string {
  if (remote !== '.' && !isRemoteName(remote)) throw new Error('Refused a remote name that git could read as an option');
  return remote;
}

// A full ref, so a name such as '+main' can never read as a forced refspec.
function headRef(branch: string): string {
  return revision(`refs/heads/${branch}`);
}

export function fetchArgs(options: FetchOptions, version: GitVersion): string[] {
  return [
    'fetch',
    ...(options.prune ? ['--prune'] : []),
    ...(options.remote !== undefined ? [...endOfOptions(version), remoteArg(options.remote)] : options.all ? ['--all'] : []),
  ];
}

export function pullArgs(options: PullOptions, version: GitVersion): string[] {
  const target = options.remote !== undefined && options.branch !== undefined ? [...endOfOptions(version), remoteArg(options.remote), headRef(options.branch)] : [];
  return ['pull', ...(options.autoStash && gitAtLeast(version, 2, 27) ? ['--autostash'] : []), ...(options.rebase ? ['-r'] : []), ...target];
}

// undefined for an upstream that is no remote plus refs/heads/<branch> (refs/pull/*, a refused name): a plain pull finds it.
export function pullTarget(upstream: Upstream): { readonly remote: string; readonly branch: string } | undefined {
  const { remote, branch } = upstream;
  if (remote !== '.' && !isRemoteName(remote)) return undefined;
  if (branch.startsWith('refs/') || !isSafeRevision(`refs/heads/${branch}`)) return undefined;
  return { remote, branch };
}

export function pushArgs(options: PushOptions, version: GitVersion): string[] {
  const refspec = options.branch !== undefined ? [`${headRef(options.branch)}:${headRef(options.toBranch ?? options.branch)}`] : [];
  return [
    'push',
    ...(options.force ? ['--force-with-lease', ...(gitAtLeast(version, 2, 30) ? ['--force-if-includes'] : [])] : []),
    ...(options.setUpstream ? ['-u'] : []),
    ...(options.followTags ? ['--follow-tags'] : []),
    ...(options.remote !== undefined ? [...endOfOptions(version), remoteArg(options.remote), ...refspec] : []),
  ];
}

export function needsStashAroundPull(version: GitVersion, autoStash: boolean): boolean {
  return autoStash && !gitAtLeast(version, 2, 27);
}

// Matched against stderr in English, which holds ssh's refusal too (VS Code's AuthenticationFailed).
export const AUTHENTICATION_FAILED: RegExp = /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey/i;
