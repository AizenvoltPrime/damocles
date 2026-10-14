// Remotes: their names, URLs and branches, Add Remote and Remove Remote (VS Code's extensions/git/src/git.ts addRemote,
// removeRemote and getRemotes). A remote name or URL the user typed, or a repository's config holds, never becomes an option.
import { MAX_REMOTE_NAME_LENGTH } from '../../shared/input-validation';
import type { Upstream } from './repository';

export const MAX_REMOTE_URL_LENGTH = 2048;

/** Stricter than git: a letter or digit, then letters, digits, '.', '_' or '-'; no '..', trailing '.' or '.lock'. */
export function isRemoteName(name: string): boolean {
  return name.length <= MAX_REMOTE_NAME_LENGTH && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..') && !name.endsWith('.') && !name.endsWith('.lock');
}

// git's url_is_local_not_ssh (connect.c): no ':', a '/' before the first ':', or a DOS drive prefix
function isLocalPath(url: string): boolean {
  const colon = url.indexOf(':');
  const slash = url.indexOf('/');
  return colon < 0 || (slash >= 0 && slash < colon) || /^[A-Za-z]:/.test(url);
}

/** Only a local path may hold whitespace: in a URL or scp-like address ` -oProxyCommand=x:p` reads as an ssh host. */
export function isRemoteUrl(url: string): boolean {
  if (url.length === 0 || url.length > MAX_REMOTE_URL_LENGTH || url.startsWith('-') || /^\s/.test(url)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(url) || /^[A-Za-z][A-Za-z0-9+.-]*::/.test(url)) return false;
  return isLocalPath(url) || !/\s/.test(url);
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
