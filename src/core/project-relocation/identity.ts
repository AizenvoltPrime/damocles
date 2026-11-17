// A project folder's repository identity (docs/invariants.md "Project relocation"): its remotes and its place in the repository
// are read from git's files without running git, since the folder may not be trusted; root commits come only from a trusted
// folder's git. A folder that is gone can no longer be read, so core records each identity while its folder exists.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseRemoteUrl } from '../forge/remote-url';
import { readBounded } from '../workspace-folders/git-head';
import { isPlain, repositoryDirs } from './worktree-links';

export const CONFIG_READ_LIMIT: number = 64 * 1024;
export const MAX_REMOTES: number = 16;
export const MAX_ROOTS: number = 8;
export const MAX_SUBPATH_CHARS: number = 1024;
const MAX_REMOTE_CHARS = 2048;
const MAX_HOST_CHARS = 255;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface FolderIdentity {
  /** The folder relative to its repository root, `/`-separated; '' at the root. */
  readonly subpath: string;
  /** Each remote URL as `host/path`, lowercase and without `.git`: never a scheme, user, password or port. */
  readonly remotes: readonly string[];
  /** The repository's root commits; empty until a trusted read found them. */
  readonly roots: readonly string[];
}

/** The folder's identity from git's files; undefined when the folder is not there or lies in no repository git would use. */
export async function readFolderIdentity(folder: string): Promise<FolderIdentity | undefined> {
  const root = await repositoryRootOf(folder);
  if (root === undefined) return undefined;
  const dirs = await repositoryDirs(root);
  if (!dirs) return undefined;
  const subpath = path.relative(root, path.resolve(folder)).split(path.sep).join('/');
  if (subpath.length > MAX_SUBPATH_CHARS) return undefined;
  const config = path.join(dirs.commonDir, 'config');
  const text = (await isPlain(config)) ? await readBounded(config, CONFIG_READ_LIMIT) : undefined;
  return { subpath, remotes: text === undefined ? [] : remotesOfConfig(text), roots: [] };
}

// The nearest folder from `folder` upward holding a `.git` entry, as git discovers the work tree; a link is never followed,
// and repositoryDirs refuses one.
async function repositoryRootOf(folder: string): Promise<string | undefined> {
  const start = path.resolve(folder);
  if (!(await fs.stat(start).then((stat) => stat.isDirectory(), () => false))) return undefined;
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (await fs.lstat(path.join(dir, '.git')).then(() => true, () => false)) return dir;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** The normalized URLs of a git config's `[remote "<name>"] url` entries; `include` and `includeIf` are never followed. */
export function remotesOfConfig(text: string): string[] {
  const remotes = new Set<string>();
  let inRemote = false;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    const header = /^\[([^\]]*)\](.*)$/.exec(line);
    if (header) {
      inRemote = /^remote\s+"/i.test(header[1]!.trim());
      line = header[2]!.trim();
    }
    if (!inRemote) continue;
    const entry = /^url\s*=(.*)$/i.exec(line);
    if (!entry) continue;
    const normalized = normalizedRemote(configValue(entry[1]!));
    if (normalized !== undefined) remotes.add(normalized);
    if (remotes.size >= MAX_REMOTES) break;
  }
  return [...remotes];
}

// A config value: quotes removed, `\` escapes taken, a comment outside quotes dropped.
function configValue(raw: string): string {
  let value = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (char === '\\' && i + 1 < raw.length) {
      const next = raw[++i]!;
      value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
    } else if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '#' || char === ';')) break;
    else value += char;
  }
  return value.trim();
}

/** `host/path` of an https, http, git or ssh remote URL, lowercase and without `.git`; undefined for a local path. */
export function normalizedRemote(url: string): string | undefined {
  // only host and path are compared, so http and git:// parse as https would
  const parsed = parseRemoteUrl(url.replace(/^(?:http|git):\/\//i, 'https://'));
  if (!parsed) return undefined;
  const repoPath = parsed.path.replace(/\/+$/, '').replace(/\.git$/i, '');
  return repoPath === '' ? undefined : `${parsed.host}/${repoPath}`.toLowerCase();
}

/**
 * Whether a stored remote has the `host/path` form normalizedRemote writes: a lowercase host with no user, password or port, and
 * a path that may hold the spaces and other characters its decoding gives. So no credential can be stored.
 */
export function isStoredRemote(value: string): boolean {
  const slash = value.indexOf('/');
  if (value.length > MAX_REMOTE_CHARS || slash <= 0) return false;
  const host = value.slice(0, slash);
  const segments = value.slice(slash + 1).split('/');
  return host.length <= MAX_HOST_CHARS && host === host.toLowerCase() && !/[@:\s\p{Cc}]/u.test(host)
    && segments.some((segment) => segment !== '') && !segments.some((segment) => /\p{Cc}/u.test(segment));
}

/** The root commits `git rev-list --max-parents=0` printed, at most MAX_ROOTS. */
export function rootsOfOutput(stdout: string): string[] {
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => OBJECT_ID.test(line)).slice(0, MAX_ROOTS);
}

/** The rev-list arguments for the root commits of HEAD's history, stopping at MAX_ROOTS. */
export const ROOT_COMMITS_ARGS: readonly string[] = ['rev-list', '--max-parents=0', `--max-count=${MAX_ROOTS}`, 'HEAD'];

/**
 * Same: they share a remote or a root commit. Different: they share neither, though both have remotes or both have roots.
 * Unknown otherwise, e.g. one side read no remote and the other no root commit.
 */
export function identityRelation(a: FolderIdentity, b: FolderIdentity): 'same' | 'different' | 'unknown' {
  const shares = (left: readonly string[], right: readonly string[]): boolean => left.some((value) => right.includes(value));
  if (shares(a.remotes, b.remotes) || shares(a.roots, b.roots)) return 'same';
  const comparable = (a.remotes.length > 0 && b.remotes.length > 0) || (a.roots.length > 0 && b.roots.length > 0);
  return comparable ? 'different' : 'unknown';
}
