// Ref, stash and worktree lists with commit details (plan AD4, `damocles:scm:artifacts`), and the commit pair diffs View
// Stash and Compare with... open. parseStashes ports VS Code's parseGitStashes (extensions/git/src/git.ts, MIT, Copyright (c)
// Microsoft Corporation; see THIRD-PARTY-NOTICES.md); the ref format follows its getRefs and the rows its artifactProvider.ts.
import * as path from 'node:path';
import { samePath } from './discovery';
import { gitAtLeast, revision } from './git-runner';
import { upstreamFrom } from './remotes';
import { isObjectName } from '../../shared/git-object-name';
import { commitChange, DIFF, type Change, type ChangeStatus, type PatchResult, type Repository, type Upstream } from './repository';

export { isObjectName };

export type ArtifactGroup = 'branches' | 'remoteBranches' | 'tags' | 'stashes' | 'worktrees';

export interface ArtifactCommit {
  readonly hash: string;
  readonly subject: string;
  readonly author: string;
  // the committer date, ms since epoch
  readonly date: number;
}

export interface BranchArtifact {
  readonly ref: string;
  readonly name: string;
  readonly commit: ArtifactCommit | null;
  readonly current: boolean;
  // null when the branch has none or it is gone
  readonly upstream: Upstream | null;
}

export interface RemoteBranchArtifact {
  readonly ref: string;
  readonly name: string;
  readonly remote: string;
  readonly commit: ArtifactCommit | null;
}

export interface TagArtifact {
  readonly ref: string;
  readonly name: string;
  // the commit an annotated tag peels to
  readonly commit: ArtifactCommit | null;
  readonly annotated: boolean;
  readonly current: boolean;
}

export interface StashArtifact {
  readonly index: number;
  readonly hash: string;
  readonly description: string;
  readonly branch: string | null;
  readonly date: number;
}

export interface WorktreeArtifact {
  readonly path: string;
  readonly name: string;
  readonly branch: string | null;
  readonly commit: ArtifactCommit | null;
  readonly main: boolean;
  readonly current: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
}

export type Artifacts =
  | { readonly group: 'branches'; readonly rows: readonly BranchArtifact[] }
  | { readonly group: 'remoteBranches'; readonly rows: readonly RemoteBranchArtifact[] }
  | { readonly group: 'tags'; readonly rows: readonly TagArtifact[] }
  | { readonly group: 'stashes'; readonly rows: readonly StashArtifact[] }
  | { readonly group: 'worktrees'; readonly rows: readonly WorktreeArtifact[] };

// One line per ref; the starred fields are those of the commit an annotated tag points to.
const REF_FIELDS = [
  '%(refname)',
  '%(objectname)',
  '%(objecttype)',
  '%(*objectname)',
  '%(authorname)',
  '%(*authorname)',
  '%(committerdate:unix)',
  '%(*committerdate:unix)',
  '%(subject)',
  '%(*subject)',
  '%(HEAD)',
  '%(upstream:remotename)',
  '%(upstream:remoteref)',
  '%(upstream:track,nobracket)',
] as const;
const REF_FORMAT: string = REF_FIELDS.join('%00');

export interface RawRef {
  readonly ref: string;
  readonly commit: ArtifactCommit | null;
  readonly annotated: boolean;
  // %(HEAD): this branch is checked out here
  readonly head: boolean;
  readonly upstream: Upstream | null;
}

function details(hash: string, author: string, date: string, subject: string): ArtifactCommit | null {
  if (!isObjectName(hash) || !/^\d+$/.test(date)) return null;
  return { hash, subject, author, date: Number(date) * 1000 };
}

/** for-each-ref output in REF_FORMAT, in git's order; a line with fewer fields is skipped. */
export function parseRefs(stdout: string): RawRef[] {
  const refs: RawRef[] = [];
  for (const line of stdout.split('\n')) {
    const fields = line.split('\0');
    if (fields.length !== REF_FIELDS.length || !fields[0]!.startsWith('refs/')) continue;
    const [ref, object, type, peeled, author, peeledAuthor, date, peeledDate, subject, peeledSubject, head, remote, remoteRef, track] = fields as [
      string, string, string, string, string, string, string, string, string, string, string, string, string, string,
    ];
    const annotated = type === 'tag';
    const commit = annotated ? details(peeled, peeledAuthor, peeledDate, peeledSubject) : type === 'commit' ? details(object, author, date, subject) : null;
    refs.push({ ref, commit, annotated, head: head === '*', upstream: upstreamFrom(remote, remoteRef, track) });
  }
  return refs;
}

export function branchRows(refs: readonly RawRef[]): BranchArtifact[] {
  return refs.filter((ref) => ref.ref.startsWith('refs/heads/')).map((ref) => ({
    ref: ref.ref,
    name: ref.ref.slice('refs/heads/'.length),
    commit: ref.commit,
    current: ref.head,
    upstream: ref.upstream,
  }));
}

// remoteNames must be git remote's unfiltered list, or a ref of remote foo/bar would resolve to remote foo.
export function remoteBranchRows(refs: readonly RawRef[], remoteNames: readonly string[]): RemoteBranchArtifact[] {
  const longestFirst = [...remoteNames].sort((a, b) => b.length - a.length);
  return refs.flatMap((ref) => {
    if (!ref.ref.startsWith('refs/remotes/')) return [];
    const rest = ref.ref.slice('refs/remotes/'.length);
    const remote = longestFirst.find((name) => rest.startsWith(`${name}/`)) ?? rest.split('/', 1)[0]!;
    const branch = rest.slice(remote.length + 1);
    if (remote === '' || branch === '' || branch === 'HEAD') return [];
    return [{ ref: ref.ref, name: rest, remote, commit: ref.commit }];
  });
}

/**
 * Tags; with HEAD detached, the first tag by name that points at HEAD's commit is current, as VS Code's getHEADRef names a
 * detached HEAD after it (git.ts) and artifactProvider.ts marks that tag.
 */
export function tagRows(refs: readonly RawRef[], detachedAt: string | undefined): TagArtifact[] {
  const tags = refs.filter((ref) => ref.ref.startsWith('refs/tags/'));
  const current = detachedAt === undefined ? undefined : [...tags].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)).find((ref) => ref.commit?.hash === detachedAt)?.ref;
  return tags.map((ref) => ({ ref: ref.ref, name: ref.ref.slice('refs/tags/'.length), commit: ref.commit, annotated: ref.annotated, current: ref.ref === current }));
}

const STASH_FORMAT = '%H%n%P%n%gd%n%gs%n%at%n%ct';
// eslint-disable-next-line no-control-regex
const STASH_REGEX = /([0-9a-f]{40}|[0-9a-f]{64})\n(.*)\nstash@{(\d+)}\n(.*)\n(\d+)\n(\d+)(?:\x00)/gi;
const STASH_MESSAGE = /^(WIP\s)?on\s([^:]+):\s(.*)$/i;

/**
 * `stash list --format=STASH_FORMAT -z`, read as VS Code's parseGitStashes reads git's "On <branch>:" and "WIP on <branch>:"
 * messages. Any other message (git's own "autostash", `stash store -m`) is listed by that message with no branch, which VS Code
 * leaves out, so a stash git kept for the user is never hidden. One made on a detached HEAD has no branch either.
 */
export function parseStashes(raw: string): StashArtifact[] {
  const stashes: StashArtifact[] = [];
  for (const match of raw.matchAll(STASH_REGEX)) {
    const [, hash, , index, message, , commitDate] = match as unknown as string[];
    const named = STASH_MESSAGE.exec(message!);
    const branch = named ? named[2]!.trim() : null;
    const description = named ? named[3]!.trim() : message!.trim();
    stashes.push({
      index: Number(index),
      hash: hash!,
      description: named?.[1] ? `WIP (${description})` : description,
      branch: branch === '(no branch)' ? null : branch,
      date: Number(commitDate) * 1000,
    });
  }
  return stashes;
}

export interface RawWorktree {
  // as git prints it: '/' separated on every platform
  readonly path: string;
  readonly head: string | undefined;
  // refs/heads/<name>; undefined when detached
  readonly branchRef: string | undefined;
  readonly bare: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
}

/**
 * `worktree list --porcelain`, NUL terminated (-z, git 2.36) or by lines: records split by an empty line, each a list of
 * `<attribute> [<value>]` lines; the first record is the main worktree.
 */
export function parseWorktrees(raw: string, nul: boolean): RawWorktree[] {
  const lineEnd = nul ? '\0' : '\n';
  const worktrees: RawWorktree[] = [];
  for (const record of raw.split(lineEnd + lineEnd)) {
    const lines = record.split(lineEnd).filter((line) => line !== '');
    const first = lines[0];
    if (first === undefined || !first.startsWith('worktree ')) continue;
    const value = (name: string): string | undefined => {
      const line = lines.find((candidate) => candidate === name || candidate.startsWith(`${name} `));
      return line === undefined ? undefined : line.slice(name.length + 1);
    };
    const head = value('HEAD');
    const branch = value('branch');
    worktrees.push({
      path: first.slice('worktree '.length),
      // an unborn HEAD prints the null object name, which git log refuses
      head: head !== undefined && isObjectName(head) && !/^0+$/.test(head) ? head : undefined,
      branchRef: branch !== undefined && branch.startsWith('refs/heads/') ? branch : undefined,
      bare: lines.includes('bare'),
      locked: value('locked') !== undefined,
      prunable: value('prunable') !== undefined,
    });
  }
  return worktrees;
}

const COMMIT_FORMAT = '%H%x00%an%x00%ct%x00%s';

/** `log --no-walk=unsorted --format=COMMIT_FORMAT` lines, by hash. */
export function parseCommits(stdout: string): Map<string, ArtifactCommit> {
  const commits = new Map<string, ArtifactCommit>();
  for (const line of stdout.split('\n')) {
    const [hash, author, date, subject] = line.split('\0');
    const commit = details(hash ?? '', author ?? '', date ?? '', subject ?? '');
    if (commit) commits.set(commit.hash, commit);
  }
  return commits;
}

// for-each-ref of one namespace, newest first (VS Code's sort: 'creatordate')
async function readRefs(repo: Repository, namespace: 'refs/heads' | 'refs/remotes' | 'refs/tags'): Promise<RawRef[]> {
  const result = await repo.read(['for-each-ref', '--sort=-creatordate', `--format=${REF_FORMAT}`, ...repo.endOfOptions(), namespace]);
  return parseRefs(result.stdout.toString('utf8'));
}

// HEAD's commit when HEAD is detached; undefined on a branch or an unborn one
async function detachedHead(repo: Repository): Promise<string | undefined> {
  const symbolic = await repo.read(['symbolic-ref', '-q', 'HEAD'], { allowFailure: true });
  if (symbolic.exitCode === 0) return undefined;
  const head = await repo.read(['rev-parse', '-q', '--verify', 'HEAD'], { allowFailure: true });
  return head.exitCode === 0 ? head.stdout.toString('utf8').trim() : undefined;
}

export async function readStashes(repo: Repository): Promise<StashArtifact[]> {
  const result = await repo.read(['stash', 'list', `--format=${STASH_FORMAT}`, '-z']);
  return parseStashes(result.stdout.toString('utf8'));
}

/** The worktrees of the repository's common dir, the main one first; a bare main is left out, as VS Code does. */
export async function readWorktrees(repo: Repository): Promise<WorktreeArtifact[]> {
  const nul = gitAtLeast(repo.gitVersion, 2, 36);
  const result = await repo.read(['worktree', 'list', '--porcelain', ...(nul ? ['-z'] : [])]);
  const raw = parseWorktrees(result.stdout.toString('utf8'), nul);
  const heads = [...new Set(raw.flatMap((worktree) => (worktree.head ? [worktree.head] : [])))];
  const commits = heads.length === 0 ? new Map<string, ArtifactCommit>() : parseCommits((await repo.read(['log', '--no-walk=unsorted', '--ignore-missing', `--format=${COMMIT_FORMAT}`, ...repo.endOfOptions(), ...heads])).stdout.toString('utf8'));
  return raw.flatMap((worktree, index) => {
    if (worktree.bare) return [];
    const native = path.normalize(worktree.path);
    return [{
      path: native,
      name: path.basename(native),
      branch: worktree.branchRef?.slice('refs/heads/'.length) ?? null,
      commit: (worktree.head && commits.get(worktree.head)) || null,
      main: index === 0,
      current: samePath(native, repo.root),
      locked: worktree.locked,
      prunable: worktree.prunable,
    }];
  });
}

/** One group's rows (AD4's artifacts request). */
export async function readArtifacts(repo: Repository, group: ArtifactGroup): Promise<Artifacts> {
  switch (group) {
    case 'branches':
      return { group, rows: branchRows(await readRefs(repo, 'refs/heads')) };
    case 'remoteBranches': {
      const [refs, names] = await Promise.all([readRefs(repo, 'refs/remotes'), repo.read(['remote'])]);
      return { group, rows: remoteBranchRows(refs, names.stdout.toString('utf8').split(/\r?\n/).filter((name) => name !== '')) };
    }
    case 'tags': {
      const [refs, detached] = await Promise.all([readRefs(repo, 'refs/tags'), detachedHead(repo)]);
      return { group, rows: tagRows(refs, detached) };
    }
    case 'stashes':
      return { group, rows: await readStashes(repo) };
    case 'worktrees':
      return { group, rows: await readWorktrees(repo) };
  }
}

// diff --name-status letters as VS Code's parseGitChanges maps them, with copies and type changes kept
const NAME_STATUS: Readonly<Record<string, ChangeStatus>> = { A: 'INDEX_ADDED', M: 'MODIFIED', D: 'DELETED', R: 'INDEX_RENAMED', C: 'INDEX_COPIED', T: 'TYPE_CHANGED' };

/** `diff --name-status -z` output: a rename or copy (R100, C75) carries its source, then its destination. */
export function parseNameStatus(raw: string): Change[] {
  const segments = raw.split('\0');
  const changes: Change[] = [];
  let index = 0;
  while (index < segments.length) {
    const code = segments[index++]!;
    if (code === '') continue;
    const status = NAME_STATUS[code[0]!];
    const first = segments[index++];
    if (status === undefined || first === undefined || first === '') break;
    if (status === 'INDEX_RENAMED' || status === 'INDEX_COPIED') {
      const second = segments[index++];
      if (second === undefined || second === '') break;
      changes.push(commitChange(status, second, first));
    } else changes.push(commitChange(status, first));
  }
  return changes;
}

// A change and the commit its right side comes from.
export interface CommitPairEntry {
  readonly change: Change;
  readonly right: string;
}

export interface CommitPairDiff {
  readonly left: string;
  readonly entries: readonly CommitPairEntry[];
}

/** The files that differ between two commits, renames found as status finds them (slice 11a's Compare with...). */
export async function diffRefs(repo: Repository, left: string, right: string): Promise<CommitPairDiff> {
  if (!isObjectName(left) || !isObjectName(right)) throw new Error('A commit pair diff takes two full object names');
  const result = await repo.read([...DIFF, '--name-status', '-z', '--find-renames', ...repo.endOfOptions(), left, right, '--']);
  return { left, entries: parseNameStatus(result.stdout.toString('utf8')).map((change) => ({ change, right })) };
}

/**
 * A stash against the commit it was made on (its first parent), its untracked files (the third parent, when there is one)
 * added, as VS Code's _viewStash builds it.
 */
export async function diffStash(repo: Repository, hash: string): Promise<CommitPairDiff> {
  if (!isObjectName(hash)) throw new Error('A stash is named by its full object name');
  const { parents } = await repo.commitObject(hash);
  const base = parents[0];
  if (base === undefined || !isObjectName(base)) throw new Error('The stash commit has no base commit');
  const tracked = await diffRefs(repo, base, hash);
  const untrackedCommit = parents[2];
  if (untrackedCommit === undefined || !isObjectName(untrackedCommit)) return { left: base, entries: tracked.entries };
  const listed = await repo.read(['ls-tree', '-r', '-z', '--name-only', ...repo.endOfOptions(), untrackedCommit]);
  const known = new Set(tracked.entries.map((entry) => entry.change.path));
  const untracked = listed.stdout.toString('utf8').split('\0').filter((file) => file !== '' && !known.has(file));
  return { left: base, entries: [...tracked.entries, ...untracked.map((file) => ({ change: commitChange('INDEX_ADDED', file), right: untrackedCommit }))] };
}

/** One entry's unified diff between its pair's commits. */
export function entryPatch(repo: Repository, left: string, entry: CommitPairEntry): Promise<PatchResult> {
  const paths = entry.change.originalPath !== undefined ? [entry.change.originalPath, entry.change.path] : [entry.change.path];
  return repo.patch(['--find-renames', ...repo.endOfOptions(), revision(left), revision(entry.right), '--', ...paths]);
}
