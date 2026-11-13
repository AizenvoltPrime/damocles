// Remotes: their names, URLs and branches, Add Remote and Remove Remote (VS Code's extensions/git/src/git.ts addRemote,
// removeRemote and getRemotes). A remote name or URL the user typed, or a repository's config holds, never becomes an option.
import { MAX_REMOTE_NAME_LENGTH } from '../../shared/input-validation';
import type { Upstream } from './repository';

/** Stricter than git: a letter or digit, then letters, digits, '.', '_' or '-'; no '..', trailing '.' or '.lock'. */
export function isRemoteName(name: string): boolean {
  return name.length <= MAX_REMOTE_NAME_LENGTH && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..') && !name.endsWith('.') && !name.endsWith('.lock');
}

/** How a fork re-points a repository's remotes: the pushed remote becomes upstreamName, and the fork is added as origin. */
export interface ForkRemotePlan {
  readonly pushed: string;
  /** "upstream", else "upstream-2", "upstream-3"... the first name no remote has. */
  readonly upstreamName: string;
  /** A remote named upstream exists already, so the original takes another name (the dialog's note). */
  readonly upstreamExists: boolean;
}

const MAX_UPSTREAM_SUFFIX = 100;

/**
 * The fork's remote plan for a push refused on pushed; undefined unless pushed is origin (a fork replaces origin, and another
 * remote's push has no origin to take the place of), or when every upstream name up to upstream-100 is taken.
 */
export function forkRemotePlan(pushed: string, existing: readonly string[]): ForkRemotePlan | undefined {
  if (pushed !== 'origin' || !existing.includes(pushed)) return undefined;
  const taken = new Set(existing);
  const upstreamExists = taken.has('upstream');
  if (!upstreamExists) return { pushed, upstreamName: 'upstream', upstreamExists };
  for (let suffix = 2; suffix <= MAX_UPSTREAM_SUFFIX; suffix++) {
    const name = `upstream-${suffix}`;
    if (!taken.has(name)) return { pushed, upstreamName: name, upstreamExists };
  }
  return undefined;
}

export type RemoteEdit = { readonly op: 'rename'; readonly from: string; readonly to: string } | { readonly op: 'remove'; readonly name: string };

/** What puts the remotes back after a fork stopped before its push: the added origin goes, then the original gets its name back. */
export function forkRestorePlan(plan: ForkRemotePlan, done: { readonly renamed: boolean; readonly added: boolean }): RemoteEdit[] {
  return [
    ...(done.added ? [{ op: 'remove', name: 'origin' } as const] : []),
    ...(done.renamed ? [{ op: 'rename', from: plan.upstreamName, to: plan.pushed } as const] : []),
  ];
}

export interface Remote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
}

/** `git remote` output: the names isRemoteName accepts, sorted. */
export function parseRemoteNames(stdout: string): string[] {
  return [...new Set(stdout.split(/\r?\n/).filter((name) => name !== '' && isRemoteName(name)))].sort();
}

// A partial clone's fetch line ends in its filter (`[blob:none]`, git 2.37).
export function parseRemotes(stdout: string): Remote[] {
  const remotes = new Map<string, { fetchUrl?: string; pushUrl?: string }>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([^\t]+)\t(.+?) \((fetch|push)\)(?: \[[^\]]*\])?$/.exec(line);
    if (!match || !isRemoteName(match[1]!)) continue;
    const remote = remotes.get(match[1]!) ?? {};
    if (match[3] === 'fetch') remote.fetchUrl = match[2]!;
    else remote.pushUrl = match[2]!;
    remotes.set(match[1]!, remote);
  }
  return [...remotes].map(([name, urls]) => ({ name, ...urls })).sort((a, b) => a.name.localeCompare(b.name));
}

// The one upstream parser for status and branch rows; a gone upstream is none, as in VS Code's getBranch.
export function upstreamFrom(remote: string, remoteRef: string, track: string): Upstream | null {
  if (remote === '' || remoteRef === '' || track === 'gone') return null;
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  const branch = remoteRef.startsWith('refs/heads/') ? remoteRef.slice('refs/heads/'.length) : remoteRef;
  return { remote, branch, ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0 };
}

// The pattern matches refs below ref too, so the refname must equal it.
export function parseUpstream(stdout: string, ref: string): Upstream | null {
  for (const line of stdout.split('\n')) {
    const [refname, remote, remoteRef, track] = line.split('\0');
    if (refname === ref) return upstreamFrom(remote ?? '', remoteRef ?? '', track ?? '');
  }
  return null;
}

/** for-each-ref `%(refname)` lines under refs/remotes/<remote>/: the branch names, HEAD left out. */
export function parseRemoteBranches(stdout: string, remote: string): string[] {
  const prefix = `refs/remotes/${remote}/`;
  return stdout
    .split('\n')
    .filter((refname) => refname.startsWith(prefix))
    .map((refname) => refname.slice(prefix.length))
    .filter((branch) => branch !== '' && branch !== 'HEAD');
}
