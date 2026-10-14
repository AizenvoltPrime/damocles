// One open git repository: its status, the index writes and the reads the views need (plan AD4).
// Group and letter rules follow VS Code's extensions/git/src/repository.ts and decorationProvider.ts.
import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { hasUnsafeWindowsSegment, isRelativeFilePath } from '../../shared/relative-path';
import { followsLocalLinksOnly } from '../local-links';
import { endOfOptions, MAX_CLI_LENGTH, RepoQueue, revision, splitInChunks, GitError, type GitCall, type GitResult, type GitRunner, type GitVersion } from './git-runner';
import { isInside, readSubmodules, samePath } from './discovery';
import { GitStatusParser, stripCommitMessageComments, type FileStatus } from './parsers';
import { isRemoteName, isRemoteUrl, parseRemoteBranches, parseRemoteNames, parseRemotes, parseUpstream, type Remote } from './remotes';
import type { UntrackedChanges } from './settings-keys';

export type ChangeStatus =
  | 'INDEX_MODIFIED'
  | 'INDEX_ADDED'
  | 'INDEX_DELETED'
  | 'INDEX_RENAMED'
  | 'INDEX_COPIED'
  | 'MODIFIED'
  | 'DELETED'
  | 'UNTRACKED'
  | 'IGNORED'
  | 'INTENT_TO_ADD'
  | 'INTENT_TO_RENAME'
  | 'TYPE_CHANGED'
  | 'ADDED_BY_US'
  | 'ADDED_BY_THEM'
  | 'DELETED_BY_US'
  | 'DELETED_BY_THEM'
  | 'BOTH_ADDED'
  | 'BOTH_DELETED'
  | 'BOTH_MODIFIED';

export type ChangeLetter = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | 'T' | '!' | 'S' | 'I';
export type ChangeTone = 'modified' | 'added' | 'deleted' | 'untracked' | 'conflict' | 'renamed' | 'submodule' | 'ignored';
export type ChangeGroup = 'merge' | 'index' | 'workingTree' | 'untracked';

export interface Change {
  readonly path: string;
  readonly originalPath?: string;
  readonly status: ChangeStatus;
  readonly letter: ChangeLetter;
  readonly tone: ChangeTone;
  readonly strike: boolean;
  readonly submodule?: true;
}

export type Groups = { readonly [G in ChangeGroup]: readonly Change[] };
export type Head = { readonly type: 'branch'; readonly name: string } | { readonly type: 'detached'; readonly commit: string } | { readonly type: 'unborn'; readonly name: string };
export type Operation = 'merge' | 'rebase' | 'cherryPick';
export type RepoKind = 'root' | 'nested' | 'submodule' | 'parent';

// HEAD's commit; subject is its message's first line (the amend banner)
export interface HeadCommitSummary {
  readonly hash: string;
  readonly subject: string;
}

export interface Upstream {
  readonly remote: string;
  readonly branch: string;
  readonly ahead: number;
  readonly behind: number;
}

export interface RepositoryStatus {
  readonly head: Head | null;
  // null on an unborn branch
  readonly commit: HeadCommitSummary | null;
  readonly operation: Operation | null;
  readonly mergeMessage?: string;
  readonly groups: Groups;
  readonly tooManyChanges: boolean;
  // submodule paths of the repository, repo-relative; decorated S
  readonly submodules: readonly string[];
  readonly upstream: Upstream | null;
  // remote names that pass isRemoteName, sorted
  readonly remotes: readonly string[];
}

export const EMPTY_GROUPS: Groups = { merge: [], index: [], workingTree: [], untracked: [] };

// VS Code's git.statusLimit default; must equal SCM_STATUS_LIMIT in src/desktop/preload/scm-channels.ts.
export const STATUS_LIMIT = 10_000;
// Bytes of a file side or a diff main reads for the editor; past it the side is not shown.
export const MAX_SHOW_BYTES: number = 10 * 1024 * 1024;
export const MAX_DIFF_BYTES: number = 5 * 1024 * 1024;

function letterOf(status: ChangeStatus): ChangeLetter {
  switch (status) {
    case 'INDEX_MODIFIED':
    case 'MODIFIED':
      return 'M';
    case 'INDEX_ADDED':
    case 'INTENT_TO_ADD':
      return 'A';
    case 'INDEX_DELETED':
    case 'DELETED':
      return 'D';
    case 'INDEX_RENAMED':
    case 'INTENT_TO_RENAME':
      return 'R';
    case 'TYPE_CHANGED':
      return 'T';
    case 'UNTRACKED':
      return 'U';
    case 'IGNORED':
      return 'I';
    case 'INDEX_COPIED':
      return 'C';
    default:
      return '!';
  }
}

function toneOf(status: ChangeStatus): ChangeTone {
  switch (status) {
    case 'INDEX_MODIFIED':
    case 'MODIFIED':
    case 'TYPE_CHANGED':
      return 'modified';
    case 'INDEX_DELETED':
    case 'DELETED':
      return 'deleted';
    case 'INDEX_ADDED':
    case 'INTENT_TO_ADD':
      return 'added';
    case 'INDEX_COPIED':
    case 'INDEX_RENAMED':
    case 'INTENT_TO_RENAME':
      return 'renamed';
    case 'UNTRACKED':
      return 'untracked';
    case 'IGNORED':
      return 'ignored';
    default:
      return 'conflict';
  }
}

const STRUCK: ReadonlySet<ChangeStatus> = new Set(['DELETED', 'BOTH_DELETED', 'DELETED_BY_THEM', 'DELETED_BY_US', 'INDEX_DELETED']);
const CONFLICTS: ReadonlySet<ChangeStatus> = new Set(['BOTH_DELETED', 'ADDED_BY_US', 'DELETED_BY_THEM', 'ADDED_BY_THEM', 'DELETED_BY_US', 'BOTH_ADDED', 'BOTH_MODIFIED']);

export const isConflict = (status: ChangeStatus): boolean => CONFLICTS.has(status);
export const isUntrackedStatus = (status: ChangeStatus): boolean => status === 'UNTRACKED' || status === 'IGNORED';

// VS Code's resourceUri: a rename shows at its destination, with the source as originalPath.
function change(entry: FileStatus, status: ChangeStatus, submodules: ReadonlySet<string>): Change {
  const renamed = entry.rename !== undefined && (status === 'MODIFIED' || status === 'DELETED' || status === 'INDEX_RENAMED' || status === 'INDEX_COPIED' || status === 'INTENT_TO_RENAME');
  const shown = renamed ? entry.rename! : entry.path;
  return {
    path: shown,
    ...(renamed ? { originalPath: entry.path } : {}),
    status,
    letter: letterOf(status),
    tone: toneOf(status),
    strike: STRUCK.has(status),
    ...(submodules.has(shown) ? { submodule: true as const } : {}),
  };
}

/** VS Code's status-to-group rules (repository.ts getStatus's switch). */
export function groupStatus(entries: readonly FileStatus[], untrackedChanges: UntrackedChanges, submodules: ReadonlySet<string> = new Set()): Groups {
  const merge: Change[] = [];
  const index: Change[] = [];
  const workingTree: Change[] = [];
  const untracked: Change[] = [];
  const add = (group: Change[], entry: FileStatus, status: ChangeStatus): void => {
    group.push(change(entry, status, submodules));
  };
  for (const entry of entries) {
    switch (entry.x + entry.y) {
      case '??':
        if (untrackedChanges === 'mixed') add(workingTree, entry, 'UNTRACKED');
        else if (untrackedChanges === 'separate') add(untracked, entry, 'UNTRACKED');
        continue;
      case '!!':
        if (untrackedChanges === 'mixed') add(workingTree, entry, 'IGNORED');
        else if (untrackedChanges === 'separate') add(untracked, entry, 'IGNORED');
        continue;
      case 'DD': add(merge, entry, 'BOTH_DELETED'); continue;
      case 'AU': add(merge, entry, 'ADDED_BY_US'); continue;
      case 'UD': add(merge, entry, 'DELETED_BY_THEM'); continue;
      case 'UA': add(merge, entry, 'ADDED_BY_THEM'); continue;
      case 'DU': add(merge, entry, 'DELETED_BY_US'); continue;
      case 'AA': add(merge, entry, 'BOTH_ADDED'); continue;
      case 'UU': add(merge, entry, 'BOTH_MODIFIED'); continue;
    }
    switch (entry.x) {
      case 'M': add(index, entry, 'INDEX_MODIFIED'); break;
      case 'A': add(index, entry, 'INDEX_ADDED'); break;
      case 'D': add(index, entry, 'INDEX_DELETED'); break;
      case 'R': add(index, entry, 'INDEX_RENAMED'); break;
      case 'C': add(index, entry, 'INDEX_COPIED'); break;
    }
    switch (entry.y) {
      case 'M': add(workingTree, entry, 'MODIFIED'); break;
      case 'D': add(workingTree, entry, 'DELETED'); break;
      case 'A': add(workingTree, entry, 'INTENT_TO_ADD'); break;
      case 'R': add(workingTree, entry, 'INTENT_TO_RENAME'); break;
      case 'T': add(workingTree, entry, 'TYPE_CHANGED'); break;
    }
  }
  return { merge, index, workingTree, untracked };
}


/** A change between two commits (diff --name-status), marked as VS Code's parseGitChanges marks it. */
export function commitChange(status: ChangeStatus, relativePath: string, originalPath?: string): Change {
  return {
    path: relativePath,
    ...(originalPath !== undefined ? { originalPath } : {}),
    status,
    letter: letterOf(status),
    tone: toneOf(status),
    strike: STRUCK.has(status),
  };
}

export class PathRefusedError extends Error {
  constructor() {
    super('Refused a path outside the repository');
    this.name = 'PathRefusedError';
  }
}

// A file a repository author named: a NUL, backslash, '..', root or (on Windows) a reserved segment is refused before use.
function isRepoPath(relativePath: string): boolean {
  return isRelativeFilePath(relativePath) && !(process.platform === 'win32' && hasUnsafeWindowsSegment(relativePath));
}

export function checkRepoPath(relativePath: string): void {
  if (!isRepoPath(relativePath)) throw new PathRefusedError();
}

// git's conflict markers at a line start (VS Code's categorizeResourceByResolution reads the same three).
const CONFLICT_MARKERS = /^<{7}[^<]|^={7}$|^>{7}[^>]/m;
const MAX_MARKER_SCAN_BYTES = 10 * 1024 * 1024;
// MERGE_MSG, the commit template and HEAD's message are read up to the commit box's bound.
const MAX_MERGE_MESSAGE_BYTES = 64 * 1024;
// Must equal MAX_COMMIT_MESSAGE_CHARS in src/desktop/preload/scm-channels.ts.
export const MAX_MESSAGE_CHARS: number = 64 * 1024;
// Characters of a commit object read: its headers (a signature included) and message.
const MAX_COMMIT_OBJECT_CHARS = 1024 * 1024;
// Every engine diff: no color, no external diff driver, and no index refresh, which would take the index lock.
export const DIFF: readonly string[] = ['-c', 'diff.autoRefreshIndex=false', 'diff', '--no-color', '--no-ext-diff'];

export interface RepositoryInfo {
  // the work tree's realpath, native separators
  readonly root: string;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly kind: RepoKind;
  // the project folder whose trust governs every git call here
  readonly project: string;
}

// A change a discard left as it was, because its working copy could not be saved to the trash.
export interface DiscardFailure {
  readonly path: string;
  readonly error: unknown;
}

export type DiscardOutcome = { readonly kind: 'changed' } | { readonly kind: 'discarded'; readonly failed: readonly DiscardFailure[] };

export type CommitFailure = 'emptyMessage' | 'nothingToCommit' | 'unresolvedConflicts' | 'missingUserConfig' | 'cancelled' | 'failed';
export type CommitOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: CommitFailure; readonly error?: unknown };

// How one commit runs, after every question: VS Code's CommitOptions as its repository.ts and git.ts apply them.
export interface CommitOptions {
  // stage first: every change (add -A), or tracked ones only (add -u)
  readonly all: false | 'all' | 'tracked';
  readonly amend: boolean;
  readonly signoff: boolean;
  // -S (enableCommitSigning); otherwise git's own commit.gpgSign decides
  readonly sign: boolean;
  readonly empty: boolean;
  readonly noVerify: boolean;
  // staged files saved before the commit, added again so their saved text is committed
  readonly restage: readonly string[];
  // a branch to create and check out first (Commit to a New Branch), which check-ref-format accepted
  readonly branch?: string;
}

// What a caller of Repository.read and Repository.write may set on its call.
export type GitCallOptions = Pick<GitCall, 'allowFailure' | 'maxOutputBytes' | 'literalPathspecs' | 'input'>;

// english: LC_ALL=C, for a caller that tells one refusal from another by git's words
export type WriteOptions = GitCallOptions & { readonly english?: boolean };

export type PatchResult = { readonly kind: 'patch'; readonly patch: string } | { readonly kind: 'binary' | 'tooLarge' };

export const PLAIN_COMMIT: CommitOptions = { all: false, amend: false, signoff: false, sign: false, empty: false, noVerify: false, restage: [] };

// What a network call carries: its cancel and, when it may need credentials, the askpass registration's variables.
export interface NetworkCall {
  readonly signal: AbortSignal;
  readonly askpassEnv?: Readonly<Record<string, string>>;
  // LC_ALL=C, for a caller that tells a refusal from git's words
  readonly english?: true;
}

// fenced stashes tracked changes only, as git's autostash does; includeUntracked is VS Code's maybeAutoStash
export type StashMode = 'none' | 'fenced' | 'includeUntracked';

export type SlotGit = (args: readonly string[], options?: WriteOptions & { readonly net?: NetworkCall }) => Promise<GitResult>;

export interface StashSlot {
  readonly mode: StashMode;
  branch(): Promise<{ readonly head: Head | null; readonly upstream: Upstream | null }>;
  // must run before a pull, merge or rebase under the fence, which the gate refuses otherwise
  stash(): Promise<void>;
  // the newest stash entry, read in this slot; undefined when the list is empty
  newestStash(): Promise<NewestStash | undefined>;
}

export interface NewestStash {
  readonly hash: string;
  // the reflog message, which `stash list` shows after "stash@{n}: "
  readonly message: string;
}

export interface StashedOutcome<T> {
  readonly result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
  readonly kept?: { readonly stash?: string; readonly error?: unknown };
}

// Only what the operation can create, so a cleanup never takes another git's index or HEAD lock.
export interface LockScope {
  readonly branches: readonly string[];
  readonly workTree: boolean;
}

export interface LockRemoval {
  // relative to the git dir, '/' separated
  readonly removed: readonly string[];
  readonly failed: ReadonlyArray<{ readonly path: string; readonly error: unknown }>;
}

export interface HeadCommit {
  readonly hash: string;
  readonly parents: readonly string[];
  // the full message as git stores it, without its final newlines, cut at MAX_MESSAGE_CHARS
  readonly message: string;
}

export class Repository {
  readonly info: RepositoryInfo;
  readonly queue: RepoQueue = new RepoQueue();
  private readonly runner: GitRunner;
  // the last status, which the index writes read their path lists from
  private last: RepositoryStatus | undefined;

  constructor(info: RepositoryInfo, runner: GitRunner) {
    this.info = info;
    this.runner = runner;
  }

  get root(): string {
    return this.info.root;
  }

  get lastStatus(): RepositoryStatus | undefined {
    return this.last;
  }

  /** `git init` in folder, which then holds a repository the engine can open. */
  static async init(runner: GitRunner, project: string, folder: string): Promise<void> {
    await runner.run({ project, cwd: folder, args: ['init'], kind: 'mutation' });
  }

  status(untrackedChanges: UntrackedChanges): Promise<RepositoryStatus> {
    return this.queue.status(async () => {
      const { entries, tooManyChanges } = await this.readStatus([untrackedChanges === 'hidden' ? '-uno' : '-uall']);
      const [{ head, hash }, operation, submodules, remotes] = await Promise.all([this.head(), this.operation(), this.submodulePaths(), this.remoteNames()]);
      const upstream = await this.upstreamOf(head);
      const mergeMessage = operation === 'merge' || operation === 'cherryPick' ? await this.readGitFile('MERGE_MSG') : undefined;
      const known = this.last?.commit;
      const commit = hash === undefined ? null : known?.hash === hash ? known : { hash, subject: subjectOf((await this.readCommit(hash)).message) };
      const status: RepositoryStatus = {
        head,
        commit,
        operation,
        ...(mergeMessage !== undefined ? { mergeMessage: stripCommitMessageComments(mergeMessage) } : {}),
        groups: groupStatus(entries, untrackedChanges, new Set(submodules)),
        tooManyChanges,
        submodules,
        upstream,
        remotes,
      };
      this.last = status;
      return status;
    });
  }

  /** git add -A of these paths; a conflicted file is staged as resolved. */
  stage(paths: readonly string[]): Promise<void> {
    return this.queue.mutation(() => this.chunked(['add', '-A'], paths));
  }

  // VS Code's stageAll: every working change at mixed, tracked ones only otherwise; tracked: -u; untracked and merge: the listed paths.
  stageAll(scope: 'all' | 'tracked' | 'untracked' | 'merge', untrackedChanges: UntrackedChanges): Promise<void> {
    const status = this.last;
    return this.queue.mutation(async () => {
      if (scope === 'all') await this.run(['add', untrackedChanges === 'mixed' ? '-A' : '-u', '--', '.'], 'mutation', true);
      else if (scope === 'tracked') await this.run(['add', '-u', '--', '.'], 'mutation', true);
      else if (scope === 'untracked') {
        const groups = status?.groups ?? EMPTY_GROUPS;
        await this.chunked(['add', '-A'], [...groups.workingTree, ...groups.untracked].filter((entry) => isUntrackedStatus(entry.status)).map((entry) => entry.path));
      } else await this.chunked(['add', '-A'], (status?.groups.merge ?? []).map((entry) => entry.path));
    });
  }

  // VS Code's revert: reset to HEAD, or rm --cached while HEAD is unborn (nothing to reset to).
  unstage(paths: readonly string[] | 'all'): Promise<void> {
    const unborn = this.last?.head?.type === 'unborn';
    // No --end-of-options: git 2.43 (Ubuntu 24.04's) refuses it on reset in every form, and the revision is the constant HEAD.
    const base = unborn ? ['rm', '--cached', '-r', '-q'] : ['reset', '-q', revision('HEAD')];
    return this.queue.mutation(async () => {
      if (paths === 'all') {
        await this.run([...base, '--', '.'], 'mutation', true);
        return;
      }
      await this.chunked(base, paths);
    });
  }

  /**
   * VS Code's clean for the changes the user confirmed, with every working copy saved first (docs/invariants.md "Source
   * control"): an untracked file goes to trash; a tracked file's working copy goes to trash, then git writes its index version;
   * a submodule or other gitlink goes back to its recorded commit (submodule update --no-fetch). A file whose trash step fails
   * is left as it is and comes back in failed. Nothing runs, and the result is 'changed', when a fresh status no longer lists
   * every change as it was confirmed.
   */
  discard(changes: readonly Change[], trash: (absolutePath: string) => Promise<void>): Promise<DiscardOutcome> {
    for (const change of changes) for (const entry of [change.path, change.originalPath ?? change.path]) checkRepoPath(entry);
    return this.queue.mutation(async () => {
      if (!(await this.unchangedSince(changes))) return { kind: 'changed' };
      const gitlinks = await this.gitlinks(changes.filter((change) => !isUntrackedStatus(change.status)).map((change) => change.path));
      const submodules = changes.filter((change) => change.submodule || gitlinks.has(change.path));
      const failed: DiscardFailure[] = [];
      const written: string[] = [];
      for (const change of changes) {
        if (submodules.includes(change)) continue;
        const untracked = isUntrackedStatus(change.status);
        // an intent-to-rename's source is still in the index, a staged rename's source is not
        const targets = !untracked && change.status === 'INTENT_TO_RENAME' && change.originalPath !== undefined ? [change.originalPath, change.path] : [change.path];
        try {
          for (const target of targets) {
            const entry = untracked ? await this.confinedEntry(target) : await this.workingCopy(target);
            if (entry !== undefined) await trash(entry);
          }
        } catch (error) {
          failed.push({ path: change.path, error });
          continue;
        }
        if (!untracked) written.push(...targets);
      }
      // without -f git creates each file exclusively and refuses one that came back after its trash step
      if (written.length > 0) await this.chunked(['checkout-index', '-u'], written);
      // --no-fetch stops a fetch but not the clone of a submodule whose git dir is gone, which localOnly refuses
      for (const chunk of splitInChunks(submodules.map((change) => change.path), MAX_CLI_LENGTH)) {
        await this.runner.run({ ...this.call(['submodule', 'update', '--no-fetch', '--', ...chunk], 'mutation'), literalPathspecs: true, localOnly: true });
      }
      return { kind: 'discarded', failed };
    });
  }

  /**
   * The commit step, once every question is answered: a rebase continues with git's prepared message (GIT_EDITOR=true);
   * otherwise the branch is created, the changes staged and the commit made, in that order, in one mutation. An empty message
   * with amend keeps HEAD's message (--no-edit).
   */
  commit(message: string, opts: CommitOptions = PLAIN_COMMIT): Promise<CommitOutcome> {
    const status = this.last;
    return this.queue.mutation(async () => {
      if ((status?.groups.merge.length ?? 0) > 0) return { ok: false, reason: 'unresolvedConflicts' };
      let committing = false;
      try {
        if (opts.branch !== undefined) await this.run(['checkout', '-q', '-b', revision(opts.branch)], 'mutation');
        if (opts.all) await this.run(['add', opts.all === 'tracked' ? '-u' : '-A', '--', '.'], 'mutation', true);
        if (opts.restage.length > 0) await this.chunked(['add', '-A'], opts.restage);
        if (status?.operation === 'rebase') {
          await this.run(['rebase', '--continue'], 'mutation');
          return { ok: true };
        }
        const keepMessage = opts.amend && message.trim() === '';
        const args = [
          '-c', 'user.useConfigOnly=true', 'commit', '--quiet', '--allow-empty-message',
          ...(keepMessage ? ['--no-edit'] : ['--file', '-']),
          ...(opts.amend ? ['--amend'] : []),
          ...(opts.signoff ? ['--signoff'] : []),
          ...(opts.sign ? ['-S'] : []),
          ...(opts.empty ? ['--allow-empty'] : []),
          ...(opts.noVerify ? ['--no-verify'] : []),
        ];
        committing = true;
        await this.runner.run({ ...this.call(args, 'mutation'), ...(keepMessage ? {} : { input: message }) });
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: await this.commitFailure(error, committing && !opts.amend && !opts.empty), error };
      }
    });
  }

  /** HEAD's commit with its parents and full message; undefined on an unborn branch. */
  headCommit(): Promise<HeadCommit | undefined> {
    return this.queue.read(async () => {
      const result = await this.runner.run({ ...this.call(['rev-parse', '-q', '--verify', 'HEAD'], 'read', true), allowFailure: true });
      return result.exitCode === 0 ? this.readCommit(result.stdout.toString('utf8').trim()) : undefined;
    });
  }

  /**
   * VS Code's undoCommit of the commit the user confirmed, as reset --soft does it: HEAD's branch moves to the parent and the
   * index and work tree stay, so its changes show staged; a first commit has no parent, so HEAD's ref is deleted and
   * everything unstaged. 'moved' when HEAD is no longer that commit; 'merging' where reset --soft refuses (a merge in progress
   * or an unmerged index).
   */
  undoCommit(commit: HeadCommit): Promise<'undone' | 'moved' | 'merging'> {
    return this.queue.mutation(async () => {
      if (await this.midMerge()) return 'merging';
      const parent = commit.parents[0];
      // with the old value, git moves or deletes the ref only while it still names this commit, in one locked update
      const args = parent !== undefined
        ? ['update-ref', '-m', `reset: moving to ${parent}`, 'HEAD', revision(parent), revision(commit.hash)]
        : ['update-ref', '-d', 'HEAD', revision(commit.hash)];
      const result = await this.runner.run({ ...this.call(args, 'mutation'), allowFailure: true });
      if (result.exitCode !== 0) {
        if ((await this.headHash()) !== commit.hash) return 'moved';
        throw new GitError(`git update-ref exited with ${result.exitCode}`, result.exitCode, result.stdout.toString('utf8'), result.stderr);
      }
      if (parent === undefined) await this.run(['rm', '--cached', '-r', '-q', '--', '.'], 'mutation', true);
      return 'undone';
    });
  }

  /** git mv of one repo-relative path to another (Rename on the active file). */
  move(from: string, to: string): Promise<void> {
    checkRepoPath(from);
    checkRepoPath(to);
    return this.queue.mutation(() => this.run(['mv', '--', from, to], 'mutation', true).then(() => undefined));
  }

  /** git rm of these repo-relative paths (Delete on the active file). */
  remove(paths: readonly string[]): Promise<void> {
    return this.queue.mutation(() => this.chunked(['rm', '-q'], paths));
  }

  /**
   * The commit.template file's text without git's comment lines (VS Code's getCommitTemplate, which resolves ~, ~user and a
   * path relative to the work tree as git's path.c does); null when the setting is unset or names no file.
   */
  commitTemplate(): Promise<string | null> {
    return this.queue.read(async () => {
      const result = await this.runner.run({ ...this.call(['config', '--get', 'commit.template'], 'read'), allowFailure: true });
      const value = result.exitCode === 0 ? result.stdout.toString('utf8').trim() : '';
      if (value === '') return null;
      const home = os.homedir();
      const resolved = value.replace(/^~([^/]*)\//, (_match, user: string) => `${user ? path.join(path.dirname(home), user) : home}/`);
      const file = path.isAbsolute(resolved) ? resolved : path.join(this.root, resolved);
      const text = await readRegularFile(file, MAX_MERGE_MESSAGE_BYTES * 4);
      return text === undefined ? null : stripCommitMessageComments(text).slice(0, MAX_MESSAGE_CHARS);
    });
  }

  /** Whether git accepts name as a new branch's name: check-ref-format --branch must echo it back unchanged (no @{-N}). */
  isValidBranchName(name: string): Promise<boolean> {
    if (name.startsWith('-') || name.length > 1024) return Promise.resolve(false);
    return this.queue.read(async () => {
      const result = await this.runner.run({ ...this.call(['check-ref-format', '--branch', name], 'read', true), allowFailure: true });
      return result.exitCode === 0 && result.stdout.toString('utf8').trim() === name;
    });
  }

  get gitVersion(): GitVersion {
    return this.runner.git.version;
  }

  /** A read whose output a caller parses (LC_ALL=C), in the read queue; a non-zero exit throws unless allowFailure. */
  read(args: readonly string[], options: GitCallOptions = {}): Promise<GitResult> {
    return this.queue.read(() => this.runner.run({ ...this.call(args, 'read', true), ...options }));
  }

  /** A ref, stash or worktree write in the mutation queue; with english, the hooks it runs print in English too. */
  write(args: readonly string[], options: WriteOptions = {}): Promise<GitResult> {
    return this.mutate((git) => git(args, options));
  }

  /** Several git calls in one mutation slot, so nothing the engine runs comes between a check and the write it guards. */
  mutate<T>(task: (git: (args: readonly string[], options?: WriteOptions) => Promise<GitResult>) => Promise<T>): Promise<T> {
    return this.queue.mutation(() =>
      task((args, options = {}) => {
        const { english, ...call } = options;
        return this.runner.run({ ...this.call(args, 'mutation', english === true), ...call });
      }),
    );
  }

  /** One file's unified diff from a diff's options and paths (DIFF is prepended), in the read queue. */
  patch(args: readonly string[]): Promise<PatchResult> {
    return this.queue.read(() => this.readPatch([...DIFF, ...args]));
  }

  /** A commit's parents and message (cat-file), in the read queue. */
  commitObject(hash: string): Promise<HeadCommit> {
    return this.queue.read(() => this.readCommit(hash));
  }

  /** Whether the index holds unmerged entries: a merge, rebase or stash apply stopped on conflicts. */
  hasConflicts(): Promise<boolean> {
    return this.queue.read(async () => (await this.runner.run(this.call(['ls-files', '--unmerged', '-z'], 'read', true))).stdout.length > 0);
  }

  /** --end-of-options from git 2.24, for the subcommands that parse it on every git the engine runs (never checkout or reset). */
  endOfOptions(): string[] {
    return endOfOptions(this.runner.git.version);
  }

  /**
   * A fetch or push: its process tree dies when signal aborts or the repository closes, and only it gets the askpass
   * registration's variables. It writes refs, each under git's own lock, and no index, so it takes no queue slot.
   */
  network(args: readonly string[], net: NetworkCall): Promise<GitResult> {
    return this.runner.run(this.networkCall(args, net));
  }

  // Only the stash slot.stash() created is applied back, by its commit, so a stash made meanwhile is never taken.
  withStash<T>(mode: () => StashMode, operation: (git: SlotGit, slot: StashSlot) => Promise<T>): Promise<StashedOutcome<T>> {
    return this.queue.mutation(async () => {
      const chosen = mode();
      let marked = false;
      let stashed: string | undefined;
      // set when the push ran but refs/stash could not be read after it, so a stash may exist
      let unread: { readonly error: unknown } | undefined;
      const git: SlotGit = (args, options = {}) => {
        const { english, net, ...rest } = options;
        const call = net ? this.networkCall(args, { ...net, ...(english ? { english } : {}) }) : this.call(args, 'mutation', english === true);
        return this.runner.run({ ...call, ...rest, ...(marked ? { fencedStash: true as const } : {}) });
      };
      const slot: StashSlot = {
        mode: chosen,
        branch: async () => {
          const { head } = await this.head();
          return { head, upstream: await this.upstreamOf(head) };
        },
        stash: async () => {
          if (chosen === 'none' || marked) return;
          const before = await this.stashCommit();
          await this.run(chosen === 'fenced' ? ['stash', 'push'] : ['stash', 'push', '--include-untracked'], 'mutation');
          marked = chosen === 'fenced';
          try {
            const after = await this.stashCommit();
            if (after !== undefined && after !== before) stashed = after;
          } catch (error) {
            unread = { error };
            throw error;
          }
        },
        newestStash: async () => {
          const hash = await this.stashCommit();
          if (hash === undefined) return undefined;
          const result = await this.runner.run(this.call(['log', '-g', '-1', '--format=%gs', 'refs/stash'], 'mutation', true));
          return { hash, message: result.stdout.toString('utf8').trimEnd() };
        },
      };
      let result: StashedOutcome<T>['result'];
      try {
        result = { ok: true, value: await operation(git, slot) };
      } catch (error) {
        result = { ok: false, error };
      }
      if (unread) return { result, kept: { error: unread.error } };
      if (stashed === undefined) return { result };
      try {
        if ((await this.operation()) !== null) return { result, kept: { stash: stashed } };
        // --quiet: otherwise git runs a status that enters every submodule, a declined project's included
        const applied = await this.runner.run({ ...this.call(['stash', 'apply', '--index', '--quiet', ...this.endOfOptions(), stashed], 'mutation'), allowFailure: true });
        if (applied.exitCode !== 0) return { result, kept: { stash: stashed, error: new GitError(`git stash exited with ${applied.exitCode}`, applied.exitCode, applied.stdout.toString('utf8'), applied.stderr) } };
      } catch (error) {
        return { result, kept: { stash: stashed, error } };
      }
      // the changes are back in the work tree, so a failed drop only leaves a copy in the list, and rejects
      await this.dropStash(stashed);
      return { result };
    });
  }

  /** `git remote --verbose`: each remote isRemoteName accepts, with its URLs. */
  remotes(): Promise<Remote[]> {
    return this.queue.read(async () => {
      const result = await this.runner.run({ ...this.call(['remote', '--verbose'], 'read', true), maxOutputBytes: 1024 * 1024 });
      return parseRemotes(result.stdout.toString('utf8'));
    });
  }

  /** The branches of remote this repository last fetched (refs/remotes/<remote>/*), HEAD left out. */
  remoteBranches(remote: string): Promise<string[]> {
    if (!isRemoteName(remote)) throw new Error('Refused a remote name that git could read as an option');
    return this.queue.read(async () => {
      const result = await this.runner.run({ ...this.call(['for-each-ref', '--format=%(refname)', `refs/remotes/${remote}/`], 'read', true), maxOutputBytes: 4 * 1024 * 1024 });
      return parseRemoteBranches(result.stdout.toString('utf8'), remote);
    });
  }

  addRemote(name: string, url: string): Promise<void> {
    if (!isRemoteName(name) || !isRemoteUrl(url)) throw new Error('Refused a remote name or URL that git could read as an option');
    return this.queue.mutation(() => this.run(['remote', 'add', '--', name, url], 'mutation').then(() => undefined));
  }

  removeRemote(name: string): Promise<void> {
    if (!isRemoteName(name)) throw new Error('Refused a remote name that git could read as an option');
    return this.queue.mutation(() => this.run(['remote', 'remove', '--', name], 'mutation').then(() => undefined));
  }

  async lockFiles(scope: LockScope): Promise<Set<string>> {
    const found = new Set<string>();
    const { gitDir, commonDir } = this.info;
    const candidates: Array<readonly [string, readonly string[]]> = [
      ...['packed-refs.lock', 'config.lock', 'shallow.lock'].map((name) => [commonDir, [name]] as const),
      ...[...new Set([gitDir, commonDir])].map((dir) => [dir, ['FETCH_HEAD.lock']] as const),
      ...scope.branches.map((branch) => [commonDir, ['refs', 'heads', ...`${branch}.lock`.split('/')]] as const),
    ];
    for (const [dir, segments] of candidates) {
      const file = await plainFileUnder(dir, segments);
      if (file !== undefined) found.add(file);
    }
    for (const folder of [['refs', 'remotes'], ['refs', 'tags']]) for (const file of await locksUnder(commonDir, folder, true)) found.add(file);
    if (scope.workTree) {
      for (const folder of [[], ['rebase-merge'], ['rebase-apply']]) for (const file of await locksUnder(gitDir, folder, false)) found.add(file);
    }
    return found;
  }

  // The caller holds the mutation slot of every repository sharing the common dir.
  async removeLocksSince(scope: LockScope, since: number, before: ReadonlySet<string>): Promise<LockRemoval> {
    const removed: string[] = [];
    const failed: Array<{ path: string; error: unknown }> = [];
    for (const lock of await this.lockFiles(scope)) {
      if (before.has(lock)) continue;
      const stat = await fs.lstat(lock).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return undefined;
        throw err;
      });
      if (!stat?.isFile() || stat.mtimeMs < since) continue;
      const shown = path.relative(isInside(this.info.gitDir, lock) ? this.info.gitDir : this.info.commonDir, lock).split(path.sep).join('/');
      try {
        await fs.rm(lock);
        removed.push(shown);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed.push({ path: shown, error });
      }
    }
    return { removed, failed };
  }

  abort(operation: Operation): Promise<void> {
    const command = operation === 'merge' ? 'merge' : operation === 'rebase' ? 'rebase' : 'cherry-pick';
    return this.queue.mutation(() => this.run([command, '--abort'], 'mutation').then(() => undefined));
  }

  /** A file side for the editor: the index (`:0:`) or HEAD; tooLarge past MAX_SHOW_BYTES, undefined when it does not exist there. */
  show(side: 'index' | 'HEAD', relativePath: string): Promise<Buffer | 'tooLarge' | undefined> {
    checkRepoPath(relativePath);
    const object = side === 'index' ? `:0:${relativePath}` : `${revision('HEAD')}:${relativePath}`;
    return this.queue.read(async () => {
      const result = await this.runner.run({ ...this.call(['show', ...this.endOfOptions(), object], 'read'), allowFailure: true, maxOutputBytes: MAX_SHOW_BYTES }).catch((err: unknown) => {
        if (err instanceof Error && err.name === 'GitOutputTooLargeError') return 'tooLarge' as const;
        throw err;
      });
      if (result === 'tooLarge') return result;
      return result.exitCode === 0 ? result.stdout : undefined;
    });
  }

  /** One file's unified diff for a group's side pair. */
  diff(group: ChangeGroup, relativePath: string): Promise<{ readonly kind: 'patch'; readonly patch: string } | { readonly kind: 'binary' | 'tooLarge' | 'missing' }> {
    checkRepoPath(relativePath);
    const entry = this.last?.groups[group].find((candidate) => candidate.path === relativePath);
    if (!entry) return Promise.resolve({ kind: 'missing' });
    const base = [...DIFF, '--find-renames'];
    const paths = entry.originalPath !== undefined ? [entry.originalPath, entry.path] : [entry.path];
    const args =
      isUntrackedStatus(entry.status) || entry.status === 'INTENT_TO_ADD'
        ? [...base, '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', entry.path]
        : group === 'index'
          ? [...base, '--cached', '--', ...paths]
          : group === 'merge'
            ? [...base, ...this.endOfOptions(), revision('HEAD'), '--', entry.path]
            : [...base, '--', ...paths];
    return this.queue.read(() => this.readPatch(args));
  }

  // --no-index exits 1 when the files differ; a diff of two commits exits 0
  private async readPatch(args: readonly string[]): Promise<PatchResult> {
    try {
      const result = await this.runner.run({ ...this.call(args, 'read', true), literalPathspecs: true, allowFailure: true, maxOutputBytes: MAX_DIFF_BYTES });
      if (result.exitCode > 1) throw new GitError(`git diff exited with ${result.exitCode}`, result.exitCode, '', result.stderr);
      const patch = result.stdout.toString('utf8');
      return /^Binary files .* differ$/m.test(patch) && !patch.includes('\n@@') ? { kind: 'binary' } : { kind: 'patch', patch };
    } catch (err) {
      if (err instanceof Error && err.name === 'GitOutputTooLargeError') return { kind: 'tooLarge' };
      throw err;
    }
  }

  /**
   * Which of these repo-relative paths git ignores (check-ignore over stdin, NUL separated); a folder ends in '/'. A name that
   * is no plain repository path, and a path inside a submodule, which git refuses, are never asked about.
   */
  checkIgnore(paths: readonly string[]): Promise<Set<string>> {
    const submodules = this.last?.submodules ?? [];
    // a folder is asked with its trailing slash, which a dir/ pattern needs
    const asked = paths.filter((entry) => {
      const bare = entry.endsWith('/') ? entry.slice(0, -1) : entry;
      return isRepoPath(bare) && !submodules.some((submodule) => bare.startsWith(`${submodule}/`));
    });
    if (asked.length === 0) return Promise.resolve(new Set());
    return this.queue.read(async () => {
      const ignored = await this.ignoredOf(asked);
      if (ignored) return ignored;
      // one path git refuses (behind a link, say) fails the whole batch, so each is asked alone and a refused one left out
      const found = new Set<string>();
      for (const entry of asked) for (const name of (await this.ignoredOf([entry])) ?? []) found.add(name);
      return found;
    });
  }

  /** Appends the paths to the root's .gitignore, escaped as VS Code does; refuses a .gitignore that is a link. Returns its path. */
  appendGitignore(paths: readonly string[]): Promise<string> {
    for (const entry of paths) checkRepoPath(entry);
    return this.queue.mutation(async () => {
      const file = path.join(this.root, '.gitignore');
      const lines = paths.map(gitignoreLine).join('\n');
      const stat = await fs.lstat(file).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return undefined;
        throw err;
      });
      if (stat && !stat.isFile()) throw new PathRefusedError();
      // only the last byte is read, so a file in another encoding keeps its bytes
      let separator = '';
      if (stat && stat.size > 0) {
        const handle = await fs.open(file, 'r');
        try {
          const last = Buffer.alloc(1);
          await handle.read(last, 0, 1, stat.size - 1);
          if (last[0] !== 0x0a) separator = '\n';
        } finally {
          await handle.close();
        }
      }
      await fs.appendFile(file, `${separator}${lines}\n`, 'utf8');
      return file;
    });
  }

  /** D24's input: the staged diff, or with nothing staged the diff of every tracked change against HEAD, cut at maxChars. */
  diffForMessage(maxChars: number): Promise<{ readonly diff: string; readonly truncated: boolean }> {
    const read = (args: readonly string[]): Promise<{ diff: string; truncated: boolean }> =>
      this.queue.read(async () => {
        let diff = '';
        let truncated = false;
        await this.runner.run({
          ...this.call([...DIFF, ...args], 'read', true),
          onData: (chunk) => {
            diff += chunk;
            if (diff.length <= maxChars) return undefined;
            truncated = true;
            diff = cutAt(diff, maxChars);
            return 'stop';
          },
        });
        return { diff, truncated };
      });
    return read(['--cached']).then((staged) => {
      if (staged.diff.trim() !== '') return staged;
      return read(this.last?.head?.type === 'unborn' ? [] : [...this.endOfOptions(), revision('HEAD')]);
    });
  }

  /** The current branch's last commit subjects, newest first; none on an unborn branch. */
  subjects(count: number): Promise<string[]> {
    return this.queue.read(async () => {
      const result = await this.runner.run({ ...this.call(['log', `-n${count}`, '--no-color', '--no-show-signature', '--format=%s'], 'read', true), allowFailure: true });
      return result.exitCode === 0 ? result.stdout.toString('utf8').split('\n').filter((line) => line !== '') : [];
    });
  }

  /** Paths of the merge group whose file still holds conflict markers (VS Code asks before staging them). */
  async unresolved(paths: readonly string[]): Promise<string[]> {
    const found: string[] = [];
    for (const relativePath of paths) {
      const absolute = await this.confinedEntry(relativePath).catch(() => undefined);
      // a link or a FIFO is never opened: only a regular file holds markers git wrote
      if (!absolute || !(await fs.lstat(absolute).then((stat) => stat.isFile(), () => false))) continue;
      const handle = await fs.open(absolute, 'r').catch(() => undefined);
      if (!handle) continue;
      try {
        const buffer = Buffer.alloc(Math.min((await handle.stat()).size, MAX_MARKER_SCAN_BYTES));
        await handle.read(buffer, 0, buffer.length, 0);
        if (CONFLICT_MARKERS.test(buffer.toString('utf8'))) found.push(relativePath);
      } finally {
        await handle.close();
      }
    }
    return found;
  }

  /**
   * The absolute path of an entry of this work tree a renderer named: the entry itself (a link is not followed), whose parent
   * folder's realpath lies inside the root.
   */
  async confinedEntry(relativePath: string): Promise<string> {
    checkRepoPath(relativePath);
    const segments = relativePath.split('/');
    if (!(await followsLocalLinksOnly(this.root, segments.slice(0, -1)))) throw new PathRefusedError();
    const absolute = path.join(this.root, ...segments);
    const parent = await fs.realpath(path.dirname(absolute));
    if (!isInside(this.root, parent)) throw new PathRefusedError();
    return path.join(parent, path.basename(absolute));
  }

  dispose(): void {
    this.queue.dispose();
  }

  // The tracked entry git would write, decided by lstat whatever the status letter says, or undefined when nothing is there.
  // A parent folder that is a link is refused: lstat follows it, and git never writes through one.
  private async workingCopy(relativePath: string): Promise<string | undefined> {
    const absolute = path.join(this.root, ...relativePath.split('/'));
    const present = await fs.lstat(absolute).then(
      () => true,
      (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
        throw err;
      },
    );
    if (!present) return undefined;
    const confined = await this.confinedEntry(relativePath);
    if (!samePath(confined, absolute)) throw new PathRefusedError();
    return confined;
  }

  // Which of these paths the index holds as gitlinks (mode 160000): their work tree is a repository, never a file to trash.
  private async gitlinks(paths: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const chunk of splitInChunks(paths, MAX_CLI_LENGTH)) {
      const result = await this.runner.run({ ...this.call(['ls-files', '-s', '-z', '--', ...chunk], 'read', true), literalPathspecs: true });
      for (const record of result.stdout.toString('utf8').split('\0')) if (record.startsWith('160000 ')) found.add(record.slice(record.indexOf('\t') + 1));
    }
    return found;
  }

  // Decided from the repository, never from git's words: commit runs in the user's locale, since its hooks inherit the
  // environment. mayBeEmpty: the commit itself failed, and it was neither an amend nor an empty commit.
  private async commitFailure(error: unknown, mayBeEmpty: boolean): Promise<'unresolvedConflicts' | 'nothingToCommit' | 'missingUserConfig' | 'failed'> {
    if (!(error instanceof GitError)) return 'failed';
    const unmerged = await this.runner.run(this.call(['ls-files', '--unmerged', '-z'], 'read', true));
    if (unmerged.stdout.length > 0) return 'unresolvedConflicts';
    for (const variable of ['GIT_COMMITTER_IDENT', 'GIT_AUTHOR_IDENT']) {
      // the commit's own user.useConfigOnly, so an identity git would have to guess counts as missing here too
      const probe = await this.runner.run({ ...this.call(['-c', 'user.useConfigOnly=true', 'var', variable], 'read', true), allowFailure: true });
      if (probe.exitCode !== 0) return 'missingUserConfig';
    }
    if (mayBeEmpty && (await this.operation()) !== 'merge') {
      // exit 0: the index matches HEAD (the empty tree on an unborn branch); a staged gitlink counts whatever
      // diff.ignoreSubmodules says, as it does for commit
      const staged = await this.runner.run({ ...this.call([...DIFF, '--cached', '--quiet', '--ignore-submodules=none'], 'read', true), allowFailure: true });
      if (staged.exitCode === 0) return 'nothingToCommit';
    }
    return 'failed';
  }

  private async head(): Promise<{ readonly head: Head | null; readonly hash: string | undefined }> {
    const [symbolic, commit] = await Promise.all([
      this.runner.run({ ...this.call(['symbolic-ref', '-q', '--short', 'HEAD'], 'read', true), allowFailure: true }),
      this.runner.run({ ...this.call(['rev-parse', '-q', '--verify', 'HEAD'], 'read', true), allowFailure: true }),
    ]);
    const name = symbolic.exitCode === 0 ? symbolic.stdout.toString('utf8').trim() : undefined;
    const hash = commit.exitCode === 0 ? commit.stdout.toString('utf8').trim() : undefined;
    if (name !== undefined) return { head: hash === undefined ? { type: 'unborn', name } : { type: 'branch', name }, hash };
    return { head: hash === undefined ? null : { type: 'detached', commit: hash }, hash };
  }

  // for-each-ref's upstream fields of HEAD's branch; the pattern also matches refs below it, so the refname must equal it
  private async upstreamOf(head: Head | null): Promise<Upstream | null> {
    if (head?.type !== 'branch') return null;
    const ref = `refs/heads/${head.name}`;
    const result = await this.runner.run({
      ...this.call(['for-each-ref', '--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:track,nobracket)', ref], 'read', true),
      maxOutputBytes: 64 * 1024,
    });
    return parseUpstream(result.stdout.toString('utf8'), ref);
  }

  // `git remote`: one name per line; a name the engine would refuse to pass on (isRemoteName) is left out
  private async remoteNames(): Promise<string[]> {
    const result = await this.runner.run({ ...this.call(['remote'], 'read', true), maxOutputBytes: 1024 * 1024 });
    return parseRemoteNames(result.stdout.toString('utf8'));
  }

  private async stashCommit(): Promise<string | undefined> {
    const result = await this.runner.run({ ...this.call(['rev-parse', '-q', '--verify', 'refs/stash'], 'mutation', true), allowFailure: true });
    return result.exitCode === 0 ? result.stdout.toString('utf8').trim() : undefined;
  }

  // stash@{n} is checked to still name commit right before the drop, whatever was stashed since.
  private async dropStash(commit: string): Promise<void> {
    const listed = await this.runner.run(this.call(['stash', 'list', '--format=%H'], 'mutation', true));
    const index = listed.stdout.toString('utf8').split('\n').indexOf(commit);
    if (index < 0) return;
    const named = await this.runner.run({ ...this.call(['rev-parse', '-q', '--verify', `stash@{${index}}`], 'mutation', true), allowFailure: true });
    if (named.exitCode === 0 && named.stdout.toString('utf8').trim() === commit) await this.run(['stash', 'drop', '--quiet', `stash@{${index}}`], 'mutation');
  }

  private async headHash(): Promise<string | undefined> {
    const result = await this.runner.run({ ...this.call(['rev-parse', '-q', '--verify', 'HEAD'], 'read', true), allowFailure: true });
    return result.exitCode === 0 ? result.stdout.toString('utf8').trim() : undefined;
  }

  // reset --soft's refusal: MERGE_HEAD exists or the index holds unmerged entries
  private async midMerge(): Promise<boolean> {
    if (await fs.stat(path.join(this.info.gitDir, 'MERGE_HEAD')).then(() => true, () => false)) return true;
    const unmerged = await this.runner.run(this.call(['ls-files', '--unmerged', '-z'], 'read', true));
    return unmerged.stdout.length > 0;
  }

  // The raw commit object up to MAX_COMMIT_OBJECT_CHARS: headers up to the first blank line (a signature's continuation lines
  // are never empty), then the message.
  private async readCommit(hash: string): Promise<HeadCommit> {
    let text = '';
    await this.runner.run({
      ...this.call(['cat-file', 'commit', revision(hash)], 'read', true),
      onData: (chunk) => {
        text += chunk;
        if (text.length <= MAX_COMMIT_OBJECT_CHARS) return undefined;
        text = cutAt(text, MAX_COMMIT_OBJECT_CHARS);
        return 'stop';
      },
    });
    const split = text.indexOf('\n\n');
    const headers = split < 0 ? text : text.slice(0, split);
    const parents = headers.split('\n').flatMap((line) => (line.startsWith('parent ') ? [line.slice('parent '.length)] : []));
    const message = cutAt((split < 0 ? '' : text.slice(split + 2)).replace(/\n+$/, ''), MAX_MESSAGE_CHARS);
    return { hash, parents, message };
  }

  // VS Code's getRebaseCommit, isMergeInProgress and isCherryPickInProgress, read from this work tree's git dir
  private async operation(): Promise<Operation | null> {
    const exists = (name: string): Promise<boolean> => fs.stat(path.join(this.info.gitDir, name)).then(() => true, () => false);
    const [rebaseMerge, rebaseApply, merge, cherryPick] = await Promise.all([exists('rebase-merge'), exists('rebase-apply'), exists('MERGE_HEAD'), exists('CHERRY_PICK_HEAD')]);
    if (rebaseMerge || rebaseApply) return 'rebase';
    if (merge) return 'merge';
    return cherryPick ? 'cherryPick' : null;
  }

  // undefined when git refuses one of the paths (exit 128)
  private async ignoredOf(paths: readonly string[]): Promise<Set<string> | undefined> {
    const input = paths.map((entry) => `./${entry}\0`).join('');
    const result = await this.runner.run({ ...this.call(['check-ignore', '-z', '--stdin'], 'read', true), input, allowFailure: true });
    if (result.exitCode === 128) return undefined;
    // 1: nothing is ignored
    if (result.exitCode > 1) throw new GitError(`git check-ignore exited with ${result.exitCode}`, result.exitCode, '', result.stderr);
    return new Set(result.stdout.toString('utf8').split('\0').filter((entry) => entry.startsWith('./')).map((entry) => entry.slice(2)));
  }

  // porcelain v1 entries, the first STATUS_LIMIT of them; paths, when given, limit the status to those literal paths
  private async readStatus(options: readonly string[], paths: readonly string[] = []): Promise<{ entries: FileStatus[]; tooManyChanges: boolean }> {
    const parser = new GitStatusParser();
    let tooManyChanges = false;
    await this.runner.run({
      ...this.call(['status', '--porcelain=v1', '-z', ...options, ...(paths.length > 0 ? ['--', ...paths] : [])], 'status', true),
      ...(paths.length > 0 ? { literalPathspecs: true as const } : {}),
      onData: (chunk) => {
        parser.update(chunk);
        if (parser.status.length <= STATUS_LIMIT) return undefined;
        tooManyChanges = true;
        return 'stop';
      },
    });
    return { entries: parser.status.slice(0, STATUS_LIMIT), tooManyChanges };
  }

  // Whether a fresh status of these paths still lists each change as confirmed: same path, status, source and submodule flag.
  private async unchangedSince(changes: readonly Change[]): Promise<boolean> {
    const paths = [...new Set(changes.flatMap((change) => (change.originalPath !== undefined ? [change.originalPath, change.path] : [change.path])))];
    const submodules = new Set(await this.submodulePaths());
    const fresh = new Map<string, Change>();
    for (const chunk of splitInChunks(paths, MAX_CLI_LENGTH)) {
      const { entries, tooManyChanges } = await this.readStatus(['-uall'], chunk);
      if (tooManyChanges) return false;
      for (const change of groupStatus(entries, 'mixed', submodules).workingTree) fresh.set(change.path, change);
    }
    return changes.every((change) => {
      const now = fresh.get(change.path);
      return now !== undefined && now.status === change.status && now.originalPath === change.originalPath && now.submodule === change.submodule;
    });
  }

  // .gitmodules paths that are folders of this work tree; a path a repository author wrote is confined first
  private async submodulePaths(): Promise<string[]> {
    return (await readSubmodules(this.root)).map((submodule) => submodule.relativePath);
  }

  private readGitFile(name: string): Promise<string | undefined> {
    return readRegularFile(path.join(this.info.gitDir, name), MAX_MERGE_MESSAGE_BYTES);
  }

  private networkCall(args: readonly string[], net: NetworkCall): GitCall {
    return { ...this.call(args, 'mutation', net.english === true), signal: AbortSignal.any([net.signal, this.queue.signal]), ...(net.askpassEnv ? { askpassEnv: net.askpassEnv } : {}) };
  }

  // A read or status is killed with its process tree when the queue is disposed; an index write never is.
  private call(args: readonly string[], kind: GitCall['kind'], parsed = false): GitCall {
    return { project: this.info.project, cwd: this.root, args, kind, parsed, ...(kind === 'mutation' ? {} : { signal: this.queue.signal }) };
  }

  private run(args: readonly string[], kind: GitCall['kind'], literalPathspecs = false): Promise<unknown> {
    return this.runner.run({ ...this.call(args, kind), ...(literalPathspecs ? { literalPathspecs: true as const } : {}) });
  }

  private async chunked(base: readonly string[], paths: readonly string[]): Promise<void> {
    for (const entry of paths) checkRepoPath(entry);
    for (const chunk of splitInChunks(paths, MAX_CLI_LENGTH)) await this.run([...base, '--', ...chunk], 'mutation', true);
  }
}

// No link or junction is followed, the folders on the way included; modules/ and reftable/ are not scanned (a residual).
async function locksUnder(dir: string, segments: readonly string[], recursive: boolean): Promise<string[]> {
  let folder = dir;
  for (const segment of segments) {
    folder = path.join(folder, segment);
    if (!(await isRealFolder(folder))) return [];
  }
  const found: string[] = [];
  const pending = [folder];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const entries = await fs.readdir(next, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
      throw err;
    });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.lock')) found.push(path.join(next, entry.name));
      else if (recursive && entry.isDirectory()) pending.push(path.join(next, entry.name));
    }
  }
  return found;
}

async function lstatOrUndefined(file: string): Promise<Stats | undefined> {
  return fs.lstat(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return undefined;
    throw err;
  });
}

const isRealFolder = async (folder: string): Promise<boolean> => (await lstatOrUndefined(folder))?.isDirectory() === true;

async function plainFileUnder(dir: string, segments: readonly string[]): Promise<string | undefined> {
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return undefined;
  let current = dir;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await lstatOrUndefined(current);
    if (!(index === segments.length - 1 ? stat?.isFile() : stat?.isDirectory())) return undefined;
  }
  return current;
}

function subjectOf(message: string): string {
  return message.split('\n', 1)[0]!.trim();
}

// At most max UTF-16 units of text, never ending inside a surrogate pair.
function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

// O_NONBLOCK where it exists, so a FIFO swapped in after the stat opens at once instead of blocking a thread.
const OPEN_NONBLOCKING = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/**
 * A regular file's text up to maxBytes, never ending inside a UTF-8 sequence; undefined when it does not exist or is no
 * regular file. A FIFO or device is never read: the path is checked before it is opened, and the handle again after.
 */
async function readRegularFile(file: string, maxBytes: number): Promise<string | undefined> {
  const stat = await fs.stat(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return undefined;
    throw err;
  });
  if (!stat?.isFile()) return undefined;
  const handle = await fs.open(file, OPEN_NONBLOCKING);
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return new StringDecoder('utf8').write(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/**
 * One .gitignore line for a path, as VS Code's ignore writes it ('[' escaped), plus the escapes a repository author's file
 * name needs: a leading '#' or '!', glob characters and trailing spaces; a control character in a name is refused, since a
 * newline would add a rule of its own.
 */
export function gitignoreLine(relativePath: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(relativePath)) throw new PathRefusedError();
  const escaped = relativePath.replace(/[\\[\]*?]/g, (match) => `\\${match}`).replace(/ $/, '\\ ');
  return /^[#!]/.test(escaped) ? `\\${escaped}` : escaped;
}
