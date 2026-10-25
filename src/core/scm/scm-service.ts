// Each project's repositories, their state and the user flows that ask inside an operation (plan AD4, D8, D9).
// Trust is asked about the project folder: a repository found in it takes its trust (TrustStore matches folders exactly),
// except one inside another registered project that is not trusted, where no git runs whichever project found it (gate()).
// An untrusted project starts no git process, discovery, watcher and check-ignore included.
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import picomatch from 'picomatch';
import type { Disposable } from '../../platform/disposable';
import type { FileWatcherFactory } from '../../platform/file-watcher';
import type { Memento } from '../../platform/key-value-state';
import type { SettingsStore } from '../../platform/settings-store';
import type { TrustService } from '../../platform/trust-service';
import { followsLocalLinksOnly } from '../local-links';
import { processLauncher, type SessionJob } from '../process-launcher';
import { folderKey } from '../workspace-folders/folder-key';
import { commitHistory, recordCommitMessage } from './commit-history';
import { discover, inspectFolder, isInside, samePath, type FoundRepository } from './discovery';
import type { AskpassRegistration, AskpassServer } from './askpass/askpass-server';
import { autofetchPeriodSeconds, Autofetcher, type AutofetchTarget } from './autofetch';
import { cloneArgs, cloneFolderName, freeCloneTarget, removeCloneTarget } from './clone';
import { GitQueueDisposedError, logText, MAX_CLI_LENGTH, revision, gitAtLeast, subcommandIndex, type GitCall, type GitCloner, type GitResult, type GitRunner, type GitVersion, type RepoQueue } from './git-runner';
import { GitError, GitUntrustedError, gitErrorText, RemoteCancelledError, StashKeptError, SyncBranchChangedError, type StashKeptOutcome, type SyncBranch } from './errors';
import type { Remote } from './remotes';
import { diffRefs, diffStash, entryPatch, readArtifacts, type ArtifactGroup, type Artifacts, type CommitPairDiff, type CommitPairEntry } from './artifacts';
import { checkout, createBranchArgs, deleteBranch, deleteRemoteRefArgs, failed, fastForwardArgs, integrate, renameBranchArgs, type CheckoutTarget } from './branches';
import { commitMessage, emptyTreeOf, isCommit, loadHistory, mergeBase, readCommitDetails, readHeadRefs, readHistoryPage, resolveTypedCommit, type CommitDetails, type HeadRefs, type HistoryChoice, type HistoryCommit, type HistoryLoad } from './history';
import { stashApply, stashClear, stashDrop, stashPush, type StashScope, type StashTarget } from './stash';
import { readCommitAttachment } from './commit-attachment';
import type { CommitAttachmentInput } from '../../shared/types/chat-attachment';
import { visibleText } from '../../shared/visible-text';
import { createTagArgs, deleteTagArgs, parseRemoteTags, PUSH_TAGS_ARGS, remoteTagsArgs, type RemoteTag } from './tags';
import { addWorktree, removeWorktree } from './worktrees';
import { recordWorktreeRoot, worktreeRoot } from './worktree-roots';
import { fetchArgs, needsStashAroundPull, pullArgs, pullTarget, pushArgs, type FetchOptions } from './sync';
import { updateSerially } from './serial-update';
import { BlameCache, type BlameRead } from './blame';
import { mergeFile, mergeLabels, mergeOperationIn, readMergeInputs, type MergeFileResult, type MergeInputs, type MergeTitles } from './merge';
import { quickDiffBase, readBlob, stageRanges, TREE_BLOB, type QuickDiffBase, type StageOutcome, type StageRangesRequest, type TextCodec } from './staging';
import { readTimeline, type TimelineCursor, type TimelinePage } from './timeline';
import {
  checkRepoPath,
  DIFF,
  EMPTY_GROUPS,
  isUntrackedStatus,
  Repository,
  STATUS_LIMIT,
  type Change,
  type ChangeGroup,
  type ChangeLetter,
  type ChangeStatus,
  type ChangeTone,
  type CommitOptions,
  type CommitOutcome,
  type DiscardFailure,
  type DiscardOutcome,
  type Head,
  type LockScope,
  type NetworkCall,
  type NewestStash,
  type PatchResult,
  type RepoKind,
  type RepositoryStatus,
  type StashedOutcome,
  type StashMode,
  type StashSlot,
  type Upstream,
} from './repository';
import { SCM_SETTING_KEYS, type BranchProtectionPrompt, type OpenRepositoryInParentFolders, type SmartCommitChanges, type UntrackedChanges } from './settings-keys';

// The quick diff's base, or why the file gets none (VS Code's quickDiffProvider.ts cases and the blob checks).
export type QuickDiffBaseOutcome =
  | (Extract<QuickDiffBase, { ok: true }> & { readonly hasStaged: boolean })
  | { readonly ok: false; readonly reason: Extract<QuickDiffBase, { ok: false }>['reason'] | 'notInRepository' | 'symlink' | 'ignored' };

// AD4: the workspace and .git watchers feed a 500 ms trailing debounce
export const WATCH_DEBOUNCE_MS = 500;
const CLOSED_REPOSITORIES_KEY = 'damocles.scm.closedRepositories';
const PARENT_REPOSITORIES_KEY = 'damocles.scm.parentRepositories';
// git dir entries whose change can change a ref, stash or worktree list, relative to the git dir or the common dir, '/' separated
const ARTIFACT_PATHS: ReadonlyArray<readonly [RegExp, readonly ArtifactGroup[]]> = [
  [/^HEAD$/, ['branches', 'tags', 'worktrees']],
  [/^packed-refs$/, ['branches', 'remoteBranches', 'tags']],
  [/^refs\/heads\//, ['branches', 'worktrees']],
  // a branch row's ahead and behind follow its upstream's ref and the branch's config
  [/^refs\/remotes\//, ['remoteBranches', 'branches']],
  [/^config$/, ['branches']],
  [/^refs\/tags\//, ['tags']],
  // dropping stash@{1} rewrites only the reflog
  [/^(logs\/)?refs\/stash$/, ['stashes']],
  [/^worktrees\//, ['worktrees']],
];
// git dir entries whose change can change what status, HEAD, the upstream, the remotes or the operation in progress shows (AD4's .git watcher)
const GIT_DIR_WATCHED = /^(HEAD|index|packed-refs|FETCH_HEAD|MERGE_HEAD|REBASE_HEAD|CHERRY_PICK_HEAD|MERGE_MSG|SQUASH_MSG|config)$|^(refs|rebase-merge|rebase-apply|worktrees)[\\/]/;

export type ScmQuestionSeverity = 'info' | 'warning' | 'danger';

// The fields of desktop's MessageQuestion (src/desktop/main/message-dialog.ts).
export interface ScmQuestion {
  readonly severity: ScmQuestionSeverity;
  readonly message: string;
  readonly detail?: string;
  readonly actions: readonly string[];
  readonly cancelLabel?: string;
  readonly defaultAction?: number;
  readonly preview?: readonly string[];
}

export type ScmAsk = (question: ScmQuestion) => Promise<number | undefined>;

export interface ScmServiceDeps {
  // undefined: git was not found, and the view says so
  readonly runner: (GitRunner & GitCloner) | undefined;
  // the askpass server credential-capable calls register with; without one git gets no askpass and prompts nowhere
  readonly askpass?: AskpassServer;
  readonly trust: TrustService;
  readonly watchers: FileWatcherFactory;
  readonly settings: SettingsStore;
  // global KeyValueState: closed repositories by project, parent repositories the user opened
  readonly globalState: Memento;
  readonly ask: ScmAsk;
  // a non-modal notice with actions (NotificationService.info); resolves the chosen action's label
  readonly notify: (message: string, ...actions: string[]) => Promise<string | undefined>;
  readonly trash: (absolutePath: string) => Promise<void>;
  // the host has no trash (a daemon's core): trash deletes permanently, and the questions say so in VS Code's words
  readonly deletesPermanently?: boolean;
  readonly t: (message: string, ...args: Array<string | number>) => string;
  readonly log: (line: string) => void;
  readonly platform?: NodeJS.Platform;
  // a registered project folder's realpath (fs.promises.realpath); it runs on the main thread, so it must never block
  readonly realpath?: (folder: string) => Promise<string>;
}

export interface ScmProject {
  readonly key: string;
  readonly path: string;
}

export type ProjectViewState = 'loading' | 'untrusted' | 'gitMissing' | 'noRepository' | 'ready';

export interface RepoView {
  readonly repoId: string;
  readonly root: string;
  readonly kind: RepoKind;
}

export interface ProjectView {
  readonly projectKey: string;
  readonly state: ProjectViewState;
  // the repository holding the project folder first, then by path
  readonly repos: readonly RepoView[];
  readonly closedRoots: readonly string[];
  readonly unsafe: readonly string[];
  readonly parents: readonly string[];
}

export interface RepoSnapshot {
  readonly repoId: string;
  readonly projectKey: string;
  readonly status: RepositoryStatus | undefined;
  readonly busy: boolean;
  readonly running: RemoteOp | null;
  readonly lastRemote: RemoteOutcome | null;
  // grows with every status that lands, whether or not it changed
  readonly revision: number;
}

// The interactive remote operations a user can cancel; publish and Push Tags run as push, Add Remote's fetch as fetch and a
// pullBeforeCheckout fast-forward as pull.
export type RemoteOp = 'fetch' | 'pull' | 'push' | 'sync' | 'deleteRemoteBranch' | 'deleteRemoteTag';
export type RemoteOutcomeKind = 'ok' | 'failed' | 'cancelled';
export interface RemoteOutcome {
  readonly op: RemoteOp;
  readonly outcome: RemoteOutcomeKind;
  // the changes stashed around the operation's pull could not be applied back and stay in the stash list (StashKeptError)
  readonly stashKept: boolean;
  readonly seq: number;
}

/**
 * The outcome a remote operation records when its pull kept the stash: a pull that went through finished, while a sync stops
 * before its push.
 */
export function keptStashOutcome(op: RemoteOp, pull: StashKeptOutcome): RemoteOutcomeKind {
  if (pull === 'cancelled') return 'cancelled';
  return op === 'pull' && pull === 'ok' ? 'ok' : 'failed';
}

export interface CloneState {
  // the folder name being cloned into
  readonly running: { readonly name: string } | null;
  readonly last: { readonly outcome: RemoteOutcomeKind; readonly seq: number } | null;
}

// A push: VS Code's push, push to and publish (pushTo with setUpstream) and the force and follow-tags variants.
export interface PushRequest {
  readonly remote?: string;
  readonly branch?: string;
  readonly toBranch?: string;
  readonly setUpstream: boolean;
  readonly followTags: boolean;
  readonly force: boolean;
}

export interface Decoration {
  readonly letter?: ChangeLetter;
  readonly tone: ChangeTone;
  readonly staged: boolean;
  readonly strike: boolean;
  readonly status?: ChangeStatus;
  readonly submodule?: true;
}

export type ScmEvent =
  | { readonly kind: 'view'; readonly projectKey: string }
  // the repository's snapshot or busy flag changed, or it closed: repository(repoId) is then undefined
  | { readonly kind: 'repository'; readonly repoId: string }
  | { readonly kind: 'decorations'; readonly projectKey: string }
  // what git ignores in the project may have changed (its repositories, a .gitignore, info/exclude): listings ask again
  | { readonly kind: 'ignores'; readonly projectKey: string }
  // the clone state changed (cloneState())
  | { readonly kind: 'clone' }
  // the repository's ref, stash or worktree lists of these groups may have changed: the watcher (debounced) or an engine write.
  // refs: a branch, remote branch or tag changed, by an engine operation or outside them (the watcher found refs other than
  // the last ones reported); absent when no ref changed, as for the watcher's echo of an engine write
  | { readonly kind: 'artifacts'; readonly repoId: string; readonly groups: readonly ArtifactGroup[]; readonly refs?: RefsChange };

export type RefsChange = 'engine' | 'background';

// The groups whose rows follow a branch, remote branch or tag.
const REF_GROUPS: ReadonlySet<ArtifactGroup> = new Set(['branches', 'remoteBranches', 'tags']);

export type OpenFolderOutcome = 'opened' | 'outside' | 'notRepository' | 'parent' | 'unsafe';

// Which commit the user asked for: VS Code's commit commands' options. staged and auto behave alike, as VS Code's all: false
// and all: undefined do.
export interface CommitVariant {
  readonly scope: 'auto' | 'staged' | 'all';
  readonly amend: boolean;
  readonly signoff: boolean;
  readonly noVerify: boolean;
  readonly empty: boolean;
}

export const PLAIN_VARIANT: CommitVariant = { scope: 'auto', amend: false, signoff: false, noVerify: false, empty: false };

// What main brings to a commit: its save before the questions, and Commit to a New Branch's name input.
export interface CommitHooks {
  // absolute paths of the documents saved just before (Save All & Commit Changes); the staged ones are added again
  readonly saved?: readonly string[];
  // undefined cancels the commit
  readonly branchName?: () => Promise<string | undefined>;
}

export type UndoOutcome = { readonly kind: 'noCommit' } | { readonly kind: 'cancelled' } | { readonly kind: 'undone'; readonly message: string };

export interface CommitInput {
  readonly template: string | null;
  // newest first
  readonly history: readonly string[];
  readonly headMessage: string | null;
}

interface RepoEntry {
  readonly id: string;
  readonly projectKey: string;
  readonly repo: Repository;
  kind: RepoKind;
  status: RepositoryStatus | undefined;
  // statuses landed, the snapshot's revision
  revision: number;
  // HEAD's blames of its files, per HEAD commit
  readonly blames: BlameCache;
  timer: NodeJS.Timeout | undefined;
  readonly disposables: Array<() => void>;
  running: { readonly op: RemoteOp; readonly controller: AbortController } | undefined;
  lastRemote: RemoteOutcome | undefined;
  // the watcher's artifact groups waiting on the debounce
  readonly artifactGroups: Set<ArtifactGroup>;
  artifactTimer: NodeJS.Timeout | undefined;
  // the refs as the newest listing that landed read them (recordRefs), the first read when the repository opens; undefined
  // until one lands
  refsDigest: string | undefined;
  // listings started, and the number of the one refsDigest holds, so an older listing finishing later is dropped
  refsReads: number;
  refsLanded: number;
}

interface ProjectEntry {
  readonly key: string;
  readonly path: string;
  // the folder's realpath once resolved, when it exists
  real: string | undefined;
  // set while the realpath is unknown; resolves once it settles or the project is removed
  realPending: Promise<void> | undefined;
  releaseReal: () => void;
  state: ProjectViewState;
  readonly repos: Map<string, RepoEntry>;
  closedFound: string[];
  parents: string[];
  unsafe: string[];
  // roots Open Repository opened this run, kept on rediscovery
  readonly explicit: Map<string, FoundRepository>;
  // unsafe repositories Open Repository found this run, as git printed them, opened once safe.directory lists them
  readonly pickedUnsafe: Set<string>;
  // aborted when the project is removed, which kills a discovery's git
  readonly removed: AbortController;
  // parent roots asked about this run, so a rediscovery asks no second time
  readonly asked: Set<string>;
  generation: number;
  watcher: Disposable | undefined;
  rediscoverTimer: NodeJS.Timeout | undefined;
  ignoresTimer: NodeJS.Timeout | undefined;
  disposed: boolean;
}

const rootKey = (root: string): string => folderKey(root);

export class ScmService implements Disposable {
  private readonly deps: ScmServiceDeps;
  private readonly projects = new Map<string, ProjectEntry>();
  private readonly listeners = new Set<(event: ScmEvent) => void>();
  private readonly subscriptions: Disposable[];
  // ids are unique across services, so an id held from a restarted core names no repository of this one
  private readonly repoIdPrefix = `repo-${randomBytes(6).toString('hex')}-`;
  private nextRepoId = 0;
  // how often mayRunIn refused because a realpath was unknown; a discovery that saw one runs again
  private pendingRefusals = 0;
  private disposed = false;
  // The session job every cancellable git call of this service joins: closing it, on dispose or by the host's death, kills what
  // still runs. Index writes never join it.
  private readonly sessionJob: SessionJob | undefined;
  private readonly gitRunner: GitRunner | undefined;
  private remoteSeq = 0;
  private cloning: { readonly name: string; readonly controller: AbortController } | undefined;
  private lastClone: CloneState['last'] = null;
  // the selected project, whose repositories autofetch fetches (D10, AD4)
  private autofetchProject: string | undefined;
  private autofetchReady = false;
  private readonly autofetcher: Autofetcher;
  // repoId to (path to worktree branch): files a worktree Apply left in conflict, until they resolve
  private readonly worktreeConflicts = new Map<string, Map<string, string>>();

  constructor(deps: ScmServiceDeps) {
    this.deps = deps;
    this.sessionJob = deps.runner ? processLauncher().createSessionJob() : undefined;
    this.gitRunner = deps.runner && this.gate(deps.runner, []);
    this.autofetcher = new Autofetcher({
      enabled: () => this.gitRunner !== undefined && this.flag(SCM_SETTING_KEYS.autofetch, true),
      periodMs: () => autofetchPeriodSeconds(this.deps.settings.get<unknown>(SCM_SETTING_KEYS.autofetchPeriod)) * 1000,
      targets: () => this.autofetchTargets(),
      log: (line) => deps.log(line),
      describe: gitErrorText,
    });
    this.subscriptions = [
      deps.trust.onDidGrantTrust((folders) => this.rediscoverAround(folders.map((folder) => path.resolve(folder)), [])),
      deps.settings.onDidChange('damocles.desktop.git', (change) => {
        if (change.affects(SCM_SETTING_KEYS.untrackedChanges)) for (const entry of this.allRepos()) this.scheduleStatus(entry, 0);
        if (change.affects(SCM_SETTING_KEYS.repositoryScanMaxDepth) || change.affects(SCM_SETTING_KEYS.openRepositoryInParentFolders)) {
          for (const project of this.projects.values()) void this.discoverProject(project);
        }
        if (change.affects(SCM_SETTING_KEYS.autofetch) || change.affects(SCM_SETTING_KEYS.autofetchPeriod)) this.autofetcher.start();
      }),
    ];
  }

  onDidChange(listener: (event: ScmEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** The open projects; a project that left the list disposes its repositories, watchers and queued work. */
  setProjects(projects: readonly ScmProject[]): void {
    const wanted = new Map(projects.map((project) => [project.key, project]));
    const changed: string[] = [];
    for (const [key, entry] of this.projects) {
      if (wanted.has(key) && samePath(wanted.get(key)!.path, entry.path)) continue;
      changed.push(...rootsOf(entry));
      this.disposeProject(entry);
      this.projects.delete(key);
    }
    const added: ProjectEntry[] = [];
    for (const project of projects) {
      if (this.projects.has(project.key)) continue;
      const entry: ProjectEntry = {
        key: project.key,
        path: project.path,
        real: undefined,
        realPending: undefined,
        releaseReal: () => undefined,
        state: 'loading',
        repos: new Map(),
        closedFound: [],
        parents: [],
        unsafe: [],
        explicit: new Map(),
        pickedUnsafe: new Set(),
        removed: new AbortController(),
        asked: new Set(),
        generation: 0,
        watcher: undefined,
        rediscoverTimer: undefined,
        ignoresTimer: undefined,
        disposed: false,
      };
      this.projects.set(project.key, entry);
      this.resolveReal(entry);
      added.push(entry);
      changed.push(...rootsOf(entry));
    }
    this.rediscoverAround(changed, added);
    for (const entry of added) void this.discoverProject(entry);
  }

  projectKeys(): string[] {
    return [...this.projects.keys()];
  }

  view(projectKey: string): ProjectView | undefined {
    const project = this.projects.get(projectKey);
    if (!project) return undefined;
    const repos = [...project.repos.values()]
      .map((entry) => ({ repoId: entry.id, root: entry.repo.root, kind: entry.kind }))
      .sort((a, b) => order(a.kind) - order(b.kind) || a.root.localeCompare(b.root));
    return { projectKey, state: project.state, repos, closedRoots: project.closedFound, unsafe: project.unsafe, parents: project.parents };
  }

  snapshot(repoId: string): RepoSnapshot | undefined {
    const entry = this.entry(repoId);
    return entry
      ? { repoId, projectKey: entry.projectKey, status: entry.status, busy: entry.repo.queue.busy, running: entry.running?.op ?? null, lastRemote: entry.lastRemote ?? null, revision: entry.revision }
      : undefined;
  }

  /** The repository and its project's path, for main's flows; undefined for an id this run never issued or that closed. */
  repository(repoId: string): { readonly repo: Repository; readonly projectKey: string; readonly projectPath: string; readonly kind: RepoKind } | undefined {
    const entry = this.entry(repoId);
    const project = entry ? this.projects.get(entry.projectKey) : undefined;
    return entry && project ? { repo: entry.repo, projectKey: entry.projectKey, projectPath: project.path, kind: entry.kind } : undefined;
  }

  /** The project folder's realpath, which repository roots are given in; undefined while it resolves or when it does not exist. */
  projectRealPath(projectKey: string): string | undefined {
    return this.projects.get(projectKey)?.real;
  }

  /** File decorations of the project by project-relative path, in VS Code's order (a later group wins), plus S for submodules. */
  decorations(projectKey: string): Record<string, Decoration> {
    const project = this.projects.get(projectKey);
    const files: Record<string, Decoration> = {};
    if (!project?.real) return files;
    const put = (absolute: string, decoration: Decoration): void => {
      if (samePath(project.real!, absolute) || !isInside(project.real!, absolute)) return;
      files[path.relative(project.real!, absolute).split(path.sep).join('/')] = decoration;
    };
    for (const entry of project.repos.values()) {
      const status = entry.status;
      if (!status) continue;
      const root = entry.repo.root;
      const groups: Array<[ChangeGroup, readonly Change[]]> = [['index', status.groups.index], ['untracked', status.groups.untracked], ['workingTree', status.groups.workingTree], ['merge', status.groups.merge]];
      for (const [group, changes] of groups) {
        for (const change of changes) {
          const decoration: Decoration = { letter: change.letter, tone: change.tone, staged: group === 'index', strike: change.strike, status: change.status, ...(change.submodule ? { submodule: true as const } : {}) };
          put(path.join(root, ...change.path.split('/')), decoration);
          if (change.originalPath !== undefined && (change.status === 'INDEX_RENAMED' || change.status === 'INTENT_TO_RENAME')) put(path.join(root, ...change.originalPath.split('/')), decoration);
        }
      }
      for (const submodule of status.submodules) put(path.join(root, ...submodule.split('/')), { letter: 'S', tone: 'submodule', staged: false, strike: false, submodule: true });
    }
    return files;
  }

  /** The names in a listed directory of the project that git ignores; nothing, and no git, in an untrusted project. */
  async ignoredIn(projectKey: string, relativeDir: string, entries: ReadonlyArray<{ readonly name: string; readonly dir: boolean }>): Promise<Set<string>> {
    const project = this.projects.get(projectKey);
    if (!project || project.state !== 'ready' || !this.deps.trust.isTrusted(project.path) || entries.length === 0) return new Set();
    const segments = relativeDir.split('/').filter(Boolean);
    if (!(await followsLocalLinksOnly(project.path, segments))) return new Set();
    const dir = await fs.realpath(path.join(project.path, ...segments));
    const owner = this.deepestRepo(project, dir);
    if (!owner) return new Set();
    const prefix = path.relative(owner.repo.root, dir).split(path.sep).filter(Boolean).join('/');
    const asked = new Map(entries.map((entry) => [`${prefix === '' ? '' : `${prefix}/`}${entry.name}${entry.dir ? '/' : ''}`, entry.name]));
    const ignored = await owner.repo.checkIgnore([...asked.keys()]);
    return new Set([...ignored].flatMap((repoPath) => (asked.has(repoPath) ? [asked.get(repoPath)!] : [])));
  }

  refresh(repoId: string): void {
    const entry = this.entry(repoId);
    if (entry) this.scheduleStatus(entry, 0);
  }

  async init(projectKey: string): Promise<void> {
    const project = this.require(projectKey);
    await Repository.init(this.runner(), project.path, project.path);
    await this.discoverProject(project);
  }

  /**
   * Open Repository for a folder the user picked: it must lie inside the project folder (by realpath) and hold a repository
   * whose top level does too; one above the project goes through D9's prompt. Opens below the scan depth and a closed one.
   */
  async openFolder(projectKey: string, folder: string): Promise<OpenFolderOutcome> {
    const project = this.require(projectKey);
    const projectReal = await fs.realpath(project.path);
    const real = await fs.realpath(folder);
    if (!isInside(projectReal, real)) return 'outside';
    await this.refuseDeclined(real);
    const found = await inspectFolder(this.runner(), project.path, real, project.removed.signal);
    if (found.kind === 'repository') await this.refuseDeclined(found.root, found.gitDir, found.commonDir);
    if (found.kind === 'unsafe') await this.refuseDeclined(path.resolve(found.path));
    // an unsafe repository above the project folder is a parent first, as in discover()
    if (found.kind === 'unsafe' && !isInside(projectReal, path.resolve(found.path))) {
      if (!isInside(path.resolve(found.path), projectReal)) return 'outside';
      if (!project.parents.some((entry) => samePath(entry, found.path))) project.parents = [...project.parents, found.path];
      this.emit({ kind: 'view', projectKey });
      await this.askAboutParents(project, true);
      return 'parent';
    }
    if (found.kind === 'unsafe') {
      project.pickedUnsafe.add(found.path);
      if (!project.unsafe.some((entry) => samePath(entry, found.path))) project.unsafe = [...project.unsafe, found.path];
      this.emit({ kind: 'view', projectKey });
      return 'unsafe';
    }
    if (found.kind === 'none') return 'notRepository';
    if (!isInside(projectReal, found.root)) {
      if (!isInside(found.root, projectReal)) return 'outside';
      if (!project.parents.some((entry) => samePath(entry, found.root))) project.parents = [...project.parents, found.root];
      this.emit({ kind: 'view', projectKey });
      await this.askAboutParents(project, true);
      return 'parent';
    }
    const kind = samePath(found.root, projectReal) ? 'root' : 'nested';
    project.explicit.set(rootKey(found.root), { root: found.root, gitDir: found.gitDir, commonDir: found.commonDir, kind });
    await this.setClosed(project, found.root, false);
    await this.discoverProject(project);
    return 'opened';
  }

  async close(repoIds: readonly string[]): Promise<void> {
    for (const repoId of repoIds) {
      const entry = this.entry(repoId);
      const project = entry ? this.projects.get(entry.projectKey) : undefined;
      if (!entry || !project) continue;
      await this.setClosed(project, entry.repo.root, true);
      this.disposeRepo(project, entry);
      project.closedFound = [...project.closedFound, entry.repo.root];
      if (project.repos.size === 0 && project.state === 'ready') project.state = 'noRepository';
      this.emit({ kind: 'view', projectKey: project.key });
      this.emit({ kind: 'decorations', projectKey: project.key });
    }
  }

  async reopen(projectKey: string, roots: readonly string[]): Promise<void> {
    const project = this.require(projectKey);
    for (const root of roots) await this.setClosed(project, root, false);
    await this.discoverProject(project);
  }

  /** Open Repositories In Parent Folders: the user's Yes to every parent waiting on D9. */
  async openParents(projectKey: string): Promise<void> {
    const project = this.require(projectKey);
    await this.rememberParents(project.parents);
    await this.discoverProject(project);
  }

  /**
   * Manage Unsafe Repositories for one path main's own discovery found: after the user confirms, the path joins the global
   * safe.directory list, run outside the repository.
   */
  async trustUnsafe(projectKey: string, unsafePath: string): Promise<boolean> {
    const project = this.require(projectKey);
    const listed = project.unsafe.find((entry) => samePath(entry, unsafePath));
    if (listed === undefined) throw new Error('Unknown unsafe repository');
    await this.refuseDeclined(path.resolve(listed));
    const t = this.deps.t;
    const choice = await this.deps.ask({
      severity: 'warning',
      message: t('The git repository in the current folder is potentially unsafe as the folder is owned by someone other than the current user.'),
      detail: t('Opening it adds "{0}" to safe.directory in your global git configuration, so git runs its configuration and hooks for you.', visibleText(listed)),
      actions: [t('Open Repository')],
      cancelLabel: t('Cancel'),
    });
    if (choice !== 0) return false;
    // the answer may come after the folder's project was registered or untrusted
    await this.refuseDeclined(path.resolve(listed));
    await this.runner().run({ project: project.path, cwd: os.homedir(), args: ['config', '--global', '--add', 'safe.directory', listed], kind: 'mutation' });
    project.unsafe = project.unsafe.filter((entry) => entry !== listed);
    await this.discoverProject(project);
    return true;
  }

  /** Stage; files of the merge group that still hold conflict markers are confirmed first, as VS Code does. */
  async stage(repoId: string, paths: readonly string[]): Promise<boolean> {
    const entry = this.requireRepo(repoId);
    const merge = new Set((entry.status?.groups.merge ?? []).map((change) => change.path));
    if (!(await this.confirmUnresolved(entry, paths.filter((candidate) => merge.has(candidate))))) return false;
    await entry.repo.stage(paths);
    await this.wrote(entry);
    return true;
  }

  async stageAll(repoId: string, scope: 'all' | 'tracked' | 'untracked' | 'merge'): Promise<boolean> {
    const entry = this.requireRepo(repoId);
    if (scope === 'merge' && !(await this.confirmUnresolved(entry, (entry.status?.groups.merge ?? []).map((change) => change.path)))) return false;
    await entry.repo.stageAll(scope, this.untrackedChanges());
    await this.wrote(entry);
    return true;
  }

  async unstage(repoId: string, paths: readonly string[] | 'all'): Promise<void> {
    const entry = this.requireRepo(repoId);
    await entry.repo.unstage(paths);
    await this.wrote(entry);
  }

  /** Discard Changes on these paths of the working tree or untracked group, after VS Code's confirmation. */
  async discard(repoId: string, paths: readonly string[]): Promise<boolean> {
    const entry = this.requireRepo(repoId);
    const groups = entry.status?.groups ?? EMPTY_GROUPS;
    const wanted = new Set(paths);
    return this.cleanAll(entry, [...groups.workingTree, ...groups.untracked].filter((change) => wanted.has(change.path)));
  }

  // VS Code's git.cleanAll (the working tree group), git.cleanAllTracked and git.cleanAllUntracked
  async discardAll(repoId: string, scope: 'all' | 'tracked' | 'untracked'): Promise<boolean> {
    const entry = this.requireRepo(repoId);
    const groups = entry.status?.groups ?? EMPTY_GROUPS;
    if (scope === 'all') return this.cleanAll(entry, groups.workingTree);
    if (scope === 'tracked') {
      const tracked = groups.workingTree.filter((change) => !isUntrackedStatus(change.status));
      return tracked.length > 0 && this.cleanTracked(entry, tracked);
    }
    const untracked = [...groups.workingTree, ...groups.untracked].filter((change) => isUntrackedStatus(change.status));
    return untracked.length > 0 && this.cleanUntracked(entry, untracked);
  }

  /** The repository's status as it is now, for a flow about to decide from it. */
  async currentStatus(repoId: string): Promise<RepositoryStatus> {
    const entry = this.requireRepo(repoId);
    const status = await entry.repo.status(this.untrackedChanges());
    if (this.isLive(entry)) {
      entry.status = status;
      entry.revision++;
      this.emit({ kind: 'repository', repoId: entry.id });
      this.emit({ kind: 'decorations', projectKey: entry.projectKey });
    }
    return status;
  }

  /**
   * VS Code's smartCommit after its save prompt (commands.ts), in its order: Commit Empty's confirmation, the smart-commit
   * suggestion, the nothing-to-commit check, the No Verify confirmation, then the protected-branch question and name. Nothing is
   * staged and no branch created until the last question is answered; then the commit step does both. A successful commit's
   * message joins the root's history.
   */
  async commit(repoId: string, message: string, variant: CommitVariant = PLAIN_VARIANT, hooks: CommitHooks = {}): Promise<CommitOutcome> {
    const entry = this.requireRepo(repoId);
    const status = await this.currentStatus(repoId);
    if (status.groups.merge.length > 0) return { ok: false, reason: 'unresolvedConflicts' };
    const opts = await this.commitOptions(entry, status, message, variant, hooks);
    if (!opts.ok) return opts;
    const outcome = await entry.repo.commit(message, opts.opts);
    // the history holds the message before the snapshot of the new HEAD goes out, which re-reads it; the commit has landed
    // either way, so a failed history write is logged and the commit still reported
    if (outcome.ok && status.operation !== 'rebase') {
      await recordCommitMessage(this.deps.globalState, entry.repo.root, message).catch((err: unknown) => this.deps.log(`[scm] the commit message history was not saved: ${errorText(err)}`));
    }
    await this.wrote(entry, ['branches']);
    return outcome;
  }

  /** The commit box's inputs: the commit template, the history of the root and HEAD's full message. */
  async commitInput(repoId: string): Promise<CommitInput> {
    const entry = this.requireRepo(repoId);
    // an unreadable template is no template, as VS Code's getCommitTemplate has it
    const template = entry.repo.commitTemplate().catch((err: unknown) => {
      this.deps.log(`[scm] the commit template could not be read: ${errorText(err)}`);
      return null;
    });
    const [templateText, head] = await Promise.all([template, entry.repo.headCommit()]);
    return { template: templateText, history: commitHistory(this.deps.globalState, entry.repo.root), headMessage: head?.message ?? null };
  }

  /** VS Code's undoCommit: a merge commit is confirmed first; the undone commit's message comes back for the box. */
  async undoLastCommit(repoId: string): Promise<UndoOutcome> {
    const entry = this.requireRepo(repoId);
    const head = await entry.repo.headCommit();
    if (!head) return { kind: 'noCommit' };
    const t = this.deps.t;
    if (head.parents.length > 1) {
      const choice = await this.deps.ask({ severity: 'warning', message: t('The last commit was a merge commit. Are you sure you want to undo it?'), actions: [t('Undo merge commit')], cancelLabel: t('Cancel'), defaultAction: 0 });
      if (choice !== 0) return { kind: 'cancelled' };
    }
    let undone: 'undone' | 'moved' | 'merging';
    try {
      undone = await entry.repo.undoCommit(head);
    } finally {
      await this.wrote(entry, ['branches']);
    }
    if (undone === 'moved') throw new Error(t('The last commit changed after you asked to undo it, so nothing was undone.'));
    if (undone === 'merging') throw new Error(t('Can\'t undo the last commit while a merge is in progress or files have merge conflicts.'));
    return { kind: 'undone', message: head.message };
  }

  /** Rename through git (git mv), repo-relative. */
  async move(repoId: string, from: string, to: string): Promise<void> {
    const entry = this.requireRepo(repoId);
    try {
      await entry.repo.move(from, to);
    } finally {
      await this.wrote(entry);
    }
  }

  /** Delete through git (git rm), repo-relative. */
  async remove(repoId: string, paths: readonly string[]): Promise<void> {
    const entry = this.requireRepo(repoId);
    try {
      await entry.repo.remove(paths);
    } finally {
      await this.wrote(entry);
    }
  }

  async abortOperation(repoId: string): Promise<void> {
    const entry = this.requireRepo(repoId);
    const operation = entry.status?.operation;
    if (!operation) return;
    try {
      await entry.repo.abort(operation);
    } finally {
      // aborting a rebase or a cherry-pick sequence moves HEAD's branch back
      await this.wrote(entry, ['branches']);
    }
  }

  async addToGitignore(repoId: string, paths: readonly string[]): Promise<string> {
    const entry = this.requireRepo(repoId);
    const file = await entry.repo.appendGitignore(paths);
    await this.wrote(entry);
    return file;
  }

  /** The git the engine runs, for the version checks of features (Stash Staged needs 2.35); undefined when git was not found. */
  gitVersion(): GitVersion | undefined {
    return this.deps.runner?.git.version;
  }

  /** One group's rows (AD4's damocles:scm:artifacts), read fresh from git. */
  artifacts(repoId: string, group: ArtifactGroup): Promise<Artifacts> {
    return readArtifacts(this.requireRepo(repoId).repo, group);
  }

  /** dirty: the checkout would overwrite local changes, and git changed nothing. */
  async checkout(repoId: string, target: CheckoutTarget): Promise<'ok' | 'dirty'> {
    const entry = this.requireRepo(repoId);
    try {
      return await checkout(entry.repo, target);
    } finally {
      await this.wrote(entry, ['branches', 'tags', 'worktrees']);
    }
  }

  /**
   * pullBeforeCheckout's fast-forward of a local branch from its upstream (VS Code's fastForwardBranch), as a cancellable
   * pull. rejected: git refused it, because the branch has commits the upstream lacks or is checked out in another worktree,
   * and the branch is as it was (VS Code's BranchFastForwardRejected, which its checkout ignores); that is no failure.
   */
  async fastForward(repoId: string, branch: string, upstream: { readonly remote: string; readonly branch: string }): Promise<'ok' | 'rejected'> {
    // before the lock scan takes the branch as a path
    revision(`refs/heads/${branch}`);
    const entry = this.requireRepo(repoId);
    const outcome = await this.remoteOp(entry, 'pull', async (net) => {
      try {
        await entry.repo.network(fastForwardArgs(upstream.remote, upstream.branch, branch, entry.repo.gitVersion), { ...net, english: true });
        return 'ok' as const;
      } catch (err) {
        if (err instanceof GitError && FAST_FORWARD_REFUSED.test(err.stderr)) return 'rejected' as const;
        throw err;
      }
    }, { branches: [branch], workTree: false });
    await this.listsChanged(entry, ['branches', 'remoteBranches']);
    return outcome;
  }

  /** VS Code's branch with checkout: a new branch at start (HEAD, a full refname or a commit), checked out. */
  async createBranch(repoId: string, name: string, start: string): Promise<void> {
    const entry = this.requireRepo(repoId);
    try {
      await entry.repo.write(createBranchArgs(name, start));
    } finally {
      await this.wrote(entry, ['branches', 'worktrees']);
    }
  }

  /** Renames the checked-out branch. */
  async renameBranch(repoId: string, name: string): Promise<void> {
    const entry = this.requireRepo(repoId);
    try {
      await entry.repo.write(renameBranchArgs(name, entry.repo.gitVersion));
    } finally {
      await this.wrote(entry, ['branches', 'worktrees']);
    }
  }

  /** unmerged: `branch -d` refused, and the caller asks before forcing. */
  async deleteBranch(repoId: string, name: string, force: boolean): Promise<'ok' | 'unmerged'> {
    const entry = this.requireRepo(repoId);
    try {
      return await deleteBranch(entry.repo, name, force);
    } finally {
      await this.wrote(entry, ['branches']);
    }
  }

  /** Delete Remote Branch... and Delete Remote Tag...: `push --delete`, a cancellable remote operation. */
  async deleteRemoteRef(repoId: string, remote: string, ref: string): Promise<void> {
    const op: RemoteOp = ref.startsWith('refs/tags/') ? 'deleteRemoteTag' : 'deleteRemoteBranch';
    const entry = this.requireRepo(repoId);
    await this.remoteOp(entry, op, async (net) => {
      await entry.repo.network(deleteRemoteRefArgs(remote, ref, entry.repo.gitVersion), net);
    }, REMOTE_LOCKS);
    await this.listsChanged(entry, op === 'deleteRemoteBranch' ? ['remoteBranches'] : []);
  }

  /** A remote's tags (`ls-remote --tags`), listed as Delete Remote Tag's remoteOp, which may need credentials. */
  remoteTags(repoId: string, remote: string): Promise<RemoteTag[]> {
    const entry = this.requireRepo(repoId);
    return this.remoteOp(entry, 'deleteRemoteTag', async (net) => parseRemoteTags((await entry.repo.network(remoteTagsArgs(remote), net)).stdout.toString('utf8')));
  }

  async integrate(repoId: string, command: 'merge' | 'rebase', name: string): Promise<'ok' | 'conflict'> {
    const entry = this.requireRepo(repoId);
    try {
      const conflicted = this.deps.t('Resolve the merge conflicts before merging or rebasing a branch.');
      const stashed = await integrate(entry.repo, command, name, () => (this.declinedInside(entry.repo.root).length > 0 ? 'fenced' : 'none'), conflicted);
      return this.settleStash(stashed, (result) => (result.ok ? result.value : 'failed'));
    } finally {
      await this.wrote(entry, ['branches', 'worktrees']);
    }
  }

  /** Stash, Stash (Include Untracked), Stash Staged and Stash Changes (paths). */
  async stash(repoId: string, scope: StashScope, message: string, paths: readonly string[] = []): Promise<'ok' | 'noCommits' | 'noChanges'> {
    const entry = this.requireRepo(repoId);
    // one stash takes every path in one call, so the paths must fit one command line
    if (paths.reduce((length, candidate) => length + candidate.length + 3, 0) > MAX_CLI_LENGTH) throw new Error(this.deps.t('Too many files to stash at once. Stash fewer files, or stash all changes.'));
    try {
      return await stashPush(entry.repo, scope, message, paths);
    } finally {
      await this.wrote(entry, ['stashes']);
    }
  }

  async stashApply(repoId: string, target: StashTarget, pop: boolean): Promise<'ok' | 'conflict' | 'moved'> {
    const entry = this.requireRepo(repoId);
    try {
      return await stashApply(entry.repo, target, pop, this.deps.t('Resolve the merge conflicts before applying a stash.'));
    } finally {
      await this.wrote(entry, pop ? ['stashes'] : []);
    }
  }

  async stashDrop(repoId: string, target: StashTarget): Promise<'ok' | 'moved'> {
    const entry = this.requireRepo(repoId);
    try {
      return await stashDrop(entry.repo, target);
    } finally {
      await this.wrote(entry, ['stashes']);
    }
  }

  async stashClear(repoId: string): Promise<void> {
    const entry = this.requireRepo(repoId);
    try {
      await stashClear(entry.repo);
    } finally {
      await this.wrote(entry, ['stashes']);
    }
  }

  /** View Stash's files: the stash against its base, its untracked files added. */
  diffStash(repoId: string, hash: string): Promise<CommitPairDiff> {
    return diffStash(this.requireRepo(repoId).repo, hash);
  }

  /** The files that differ between two commits (Compare with...). */
  diffRefs(repoId: string, left: string, right: string): Promise<CommitPairDiff> {
    return diffRefs(this.requireRepo(repoId).repo, left, right);
  }

  entryPatch(repoId: string, left: string, entry: CommitPairEntry): Promise<PatchResult> {
    return entryPatch(this.requireRepo(repoId).repo, left, entry);
  }

  /** The empty tree's object name in this repository's hash, which a root commit is compared against. */
  emptyTree(repoId: string): Promise<string> {
    return emptyTreeOf(this.requireRepo(repoId).repo);
  }

  /** A blob of a commit (commit:path), up to MAX_SHOW_BYTES; undefined when the commit lacks the path. */
  async commitBlob(repoId: string, commit: string, relativePath: string): Promise<Buffer | 'tooLarge' | undefined> {
    checkRepoPath(relativePath);
    const repo = this.requireRepo(repoId).repo;
    const listed = await repo.read(['ls-tree', '-z', revision(commit), '--', relativePath], { literalPathspecs: true });
    const match = TREE_BLOB.exec(listed.stdout.toString('utf8'));
    return match ? readBlob(repo, match[1]!) : undefined;
  }

  /**
   * The quick diff's base for a file of this repository, with VS Code's quickDiffProvider.ts refusals: a file of a nested
   * repository or the git dir, a link, a merge-group, untracked or ignored file. hasStaged: the file is in the index group,
   * so HEAD's text comes too.
   */
  async quickDiffBase(repoId: string, relativePath: string, codec: TextCodec | undefined): Promise<QuickDiffBaseOutcome> {
    checkRepoPath(relativePath);
    const entry = this.requireRepo(repoId);
    const project = this.projects.get(entry.projectKey);
    const absolute = path.join(entry.repo.root, ...relativePath.split('/'));
    const { gitDir, commonDir } = entry.repo.info;
    if (!project || this.deepestRepo(project, absolute) !== entry || isInside(gitDir, absolute) || isInside(commonDir, absolute)) return { ok: false, reason: 'notInRepository' };
    const stat = await fs.lstat(absolute).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return undefined;
      throw err;
    });
    if (stat?.isSymbolicLink()) return { ok: false, reason: 'symlink' };
    const groups = entry.status?.groups ?? EMPTY_GROUPS;
    const named = (changes: readonly Change[]): Change | undefined => changes.find((change) => change.path === relativePath);
    if (named(groups.merge)) return { ok: false, reason: 'merge' };
    const untracked = named(groups.untracked) ?? named(groups.workingTree);
    if (untracked?.status === 'UNTRACKED') return { ok: false, reason: 'untracked' };
    if (untracked?.status === 'IGNORED' || (await entry.repo.checkIgnore([relativePath])).has(relativePath)) return { ok: false, reason: 'ignored' };
    const hasStaged = named(groups.index) !== undefined;
    const base = await quickDiffBase(entry.repo, relativePath, codec, hasStaged);
    return base.ok ? { ...base, hasStaged } : base;
  }

  /** Stage or Unstage Selected Ranges; the snapshot is fresh once it resolves (wrote). */
  async stageRanges(repoId: string, request: StageRangesRequest): Promise<StageOutcome> {
    const entry = this.requireRepo(repoId);
    while (this.realpathPending()) await this.realpathsSettled();
    const outcome = await stageRanges(entry.repo, request, this.declinedInside(entry.repo.root));
    if (outcome.ok) await this.wrote(entry);
    return outcome;
  }

  /** HEAD's blame of a file, cached per HEAD commit. */
  blame(repoId: string, relativePath: string): Promise<BlameRead> {
    const entry = this.requireRepo(repoId);
    return entry.blames.read(entry.repo, relativePath);
  }

  /** One page of a file's timeline, after a cursor, and whether the file has staged changes (a Staged Changes entry leads). */
  async timeline(repoId: string, relativePath: string, after?: TimelineCursor): Promise<TimelinePage & { readonly hasStaged: boolean }> {
    const entry = this.requireRepo(repoId);
    const page = await readTimeline(entry.repo, relativePath, after);
    return { ...page, hasStaged: (entry.status?.groups.index ?? []).some((change) => change.path === relativePath) };
  }

  /** A Graph load: the ref choice resolved once, with its first page; undefined while HEAD is unborn. */
  async historyLoad(repoId: string, choice: HistoryChoice): Promise<{ readonly load: HistoryLoad; readonly commits: readonly HistoryCommit[] } | undefined> {
    const repo = this.requireRepo(repoId).repo;
    const load = await loadHistory(repo, choice, this.deps.log);
    if (!load) return undefined;
    return { load, commits: await readHistoryPage(repo, load.tips, 0, load.headRefs.base?.id) };
  }

  /** A later page of a Graph load, logged from the commits its cursor carries. */
  historyPage(repoId: string, tips: readonly string[], skip: number, baseRef: string | undefined): Promise<HistoryCommit[]> {
    return readHistoryPage(this.requireRepo(repoId).repo, tips, skip, baseRef);
  }

  /** HEAD, its upstream and its base ref with their commits; undefined while HEAD is unborn. */
  headRefs(repoId: string): Promise<HeadRefs | undefined> {
    return readHeadRefs(this.requireRepo(repoId).repo, this.deps.log);
  }

  mergeBase(repoId: string, a: string, b: string): Promise<string | undefined> {
    return mergeBase(this.requireRepo(repoId).repo, a, b);
  }

  /** Whether hash is a full object name of a commit of the repository (cat-file -t). */
  isCommit(repoId: string, hash: string): Promise<boolean> {
    return isCommit(this.requireRepo(repoId).repo, hash);
  }

  /** A commit the user typed, as rev-parse --verify <rev>^{commit} resolves it; undefined when it names none. */
  resolveTypedCommit(repoId: string, typed: string): Promise<string | undefined> {
    return resolveTypedCommit(this.requireRepo(repoId).repo, typed);
  }

  commitMessage(repoId: string, hash: string): Promise<string> {
    return commitMessage(this.requireRepo(repoId).repo, hash);
  }

  commitDetails(repoId: string, hash: string): Promise<CommitDetails> {
    return readCommitDetails(this.requireRepo(repoId).repo, hash);
  }

  /** The Graph's Add to Chat: a commit main checked, read as a bounded attachment with its patch against the first parent. */
  commitAttachment(repoId: string, hash: string): Promise<CommitAttachmentInput> {
    return readCommitAttachment(this.requireRepo(repoId).repo, hash);
  }

  /**
   * VS Code's cherryPick of a commit main checked: conflict leaves the cherry-pick in progress with the conflicts in the
   * index; empty (the changes are already there) aborts it, so none stays in progress. Told from the repository, never from
   * git's words: CHERRY_PICK_HEAD, the unmerged entries and the index against HEAD. A refusal before git started (a merge
   * commit without -m, local changes in the way) throws, and so does an operation already in progress, checked in the same
   * slot: its state would read as this pick's, and an abort of the user's own cherry-pick sequence would drop its commits.
   */
  async cherryPick(repoId: string, commit: string): Promise<'ok' | 'conflict' | 'empty'> {
    const entry = this.requireRepo(repoId);
    const { gitDir } = entry.repo.info;
    const picking = path.join(gitDir, 'CHERRY_PICK_HEAD');
    const exists = (file: string): Promise<boolean> => fs.stat(file).then(() => true, () => false);
    let ran = false;
    try {
      return await entry.repo.mutate(async (git) => {
        // each lives in this worktree's own git dir, as git keeps them per worktree
        const states = ['CHERRY_PICK_HEAD', 'MERGE_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'].map((name) => path.join(gitDir, name));
        if ((await Promise.all(states.map(exists))).some(Boolean)) throw new Error(this.deps.t('A merge, rebase, revert or cherry-pick is in progress. Finish or abort it before cherry picking.'));
        const args = ['cherry-pick', ...entry.repo.endOfOptions(), revision(commit)];
        ran = true;
        const result = await git(args, { allowFailure: true });
        if (result.exitCode === 0) return 'ok';
        if (!(await exists(picking))) throw failed(args, result);
        if ((await git(['ls-files', '--unmerged', '-z'])).stdout.length > 0) return 'conflict';
        // a staged gitlink counts whatever diff.ignoreSubmodules says, as it does for the commit cherry-pick makes
        const staged = await git([...DIFF, '--cached', '--quiet', '--ignore-submodules=none'], { allowFailure: true });
        if (staged.exitCode !== 0) throw failed(args, result);
        await git(['cherry-pick', '--abort']);
        return 'empty';
      });
    } finally {
      // a refusal before git ran moved no ref, so the Graph gets no reload
      await this.wrote(entry, ran ? ['branches'] : []);
    }
  }

  /** The merge editor's inputs and labels; fileText is the conflicted file's text, whose markers tell a stash apply. */
  async mergeInputs(repoId: string, relativePath: string, codec: TextCodec, fileText: string): Promise<MergeInputs> {
    const branch = this.worktreeConflicts.get(repoId)?.get(relativePath);
    const inputs = await readMergeInputs(this.requireRepo(repoId).repo, relativePath, codec, fileText, this.mergeTitles(), branch);
    if (!inputs.ok && inputs.reason === 'notConflicted') this.worktreeConflicts.get(repoId)?.delete(relativePath);
    return inputs;
  }

  /** Paths a worktree Apply left in conflict (`git apply --3way` writes no MERGE_HEAD), so the merge editor labels Incoming with the branch. */
  noteWorktreeConflicts(repoId: string, paths: readonly string[], branch: string): void {
    const noted = this.worktreeConflicts.get(repoId) ?? new Map<string, string>();
    for (const p of paths) noted.set(p, branch);
    this.worktreeConflicts.set(repoId, noted);
  }

  /** Compute Conflicts With Git (Diff3): git's merge of the file's three stages, labelled as the merge editor labels them. */
  async mergeFile(repoId: string, relativePath: string, codec: TextCodec, diff3: boolean, fileText: string): Promise<MergeFileResult> {
    const entry = this.requireRepo(repoId);
    const branch = this.worktreeConflicts.get(repoId)?.get(relativePath);
    const labels = await mergeLabels(entry.repo, mergeOperationIn(entry.repo, fileText, branch), this.mergeTitles(), branch);
    return mergeFile(entry.repo, relativePath, codec, diff3, labels);
  }

  /** Complete Merge: the saved file staged as resolved, with no marker question (the merge editor asked its own). */
  async completeMerge(repoId: string, relativePath: string): Promise<void> {
    const entry = this.requireRepo(repoId);
    await entry.repo.stage([relativePath]);
    this.worktreeConflicts.get(repoId)?.delete(relativePath);
    await this.wrote(entry);
  }

  private mergeTitles(): MergeTitles {
    const t = this.deps.t;
    return { current: t('Current'), incoming: t('Incoming'), base: t('Base'), stash: t('Stashed Changes'), worktree: (branch) => t('{0} (worktree)', branch) };
  }

  /** Create Tag at HEAD, or at commit; a message makes it annotated, and goes in on stdin. */
  async createTag(repoId: string, name: string, message: string, commit?: string): Promise<void> {
    const entry = this.requireRepo(repoId);
    try {
      await entry.repo.write(createTagArgs(name, message !== '', entry.repo.gitVersion, commit), message !== '' ? { input: message } : {});
    } finally {
      await this.wrote(entry, ['tags']);
    }
  }

  async deleteTag(repoId: string, name: string): Promise<void> {
    const entry = this.requireRepo(repoId);
    try {
      await entry.repo.write(deleteTagArgs(name, entry.repo.gitVersion));
    } finally {
      await this.wrote(entry, ['tags']);
    }
  }

  /** Push Tags: every tag, to the remote git picks, as a cancellable push. */
  pushTags(repoId: string): Promise<void> {
    const entry = this.requireRepo(repoId);
    return this.remoteOp(entry, 'push', async (net) => {
      await entry.repo.network(PUSH_TAGS_ARGS, net);
    }, REMOTE_LOCKS);
  }

  /**
   * Create Worktree: a linked worktree at an absolute path, on a new branch from commitish or on commitish itself. The
   * folder it was created in becomes the root's worktree folder.
   */
  async addWorktree(repoId: string, worktreePath: string, commitish: string, branch: string | undefined): Promise<void> {
    const entry = this.requireRepo(repoId);
    try {
      await addWorktree(entry.repo, worktreePath, commitish, branch);
    } finally {
      await this.wrote(entry, branch !== undefined ? ['worktrees', 'branches'] : ['worktrees']);
    }
    // the worktree exists either way, so a failed write is logged and the creation still reported
    await recordWorktreeRoot(this.deps.globalState, entry.repo.root, path.dirname(worktreePath)).catch((err: unknown) => this.deps.log(`[scm] the worktree folder was not remembered: ${errorText(err)}`));
  }

  /** The folder the repository's last worktree was created in, or undefined before its first. */
  worktreeFolder(repoId: string): string | undefined {
    return worktreeRoot(this.deps.globalState, this.requireRepo(repoId).repo.root);
  }

  /** Whether a linked worktree holds modified or untracked files, which git worktree remove refuses without --force. */
  worktreeDirty(repoId: string, worktreePath: string): Promise<boolean> {
    return this.requireRepo(repoId).repo.worktreeDirty(worktreePath);
  }

  /** dirty: the worktree holds modified or untracked files, and the caller asks before forcing. */
  async removeWorktree(repoId: string, worktreePath: string, force: boolean): Promise<'ok' | 'dirty'> {
    const entry = this.requireRepo(repoId);
    try {
      return await removeWorktree(entry.repo, worktreePath, force);
    } finally {
      await this.wrote(entry, ['worktrees']);
    }
  }

  /** The window's clone: the one running and how the last one ended. */
  cloneState(): CloneState {
    return { running: this.cloning ? { name: this.cloning.name } : null, last: this.lastClone };
  }

  setAutofetchProject(projectKey: string | undefined): void {
    if (this.autofetchProject === projectKey) return;
    this.autofetchProject = projectKey;
    this.autofetcher.stop();
    this.autofetchReady = false;
    this.autofetchWhenReady();
  }

  /** One autofetch round now, as if the period had elapsed; only the gated e2e hook calls it (ScmHost.autofetchNow). */
  autofetchNow(): void {
    this.autofetcher.runNow();
  }

  /** Cancels the repository's running remote operation; its call then rejects with RemoteCancelledError. */
  cancel(repoId: string): void {
    this.entry(repoId)?.running?.controller.abort();
  }

  cancelClone(): void {
    this.cloning?.controller.abort();
  }

  /** The repository's remotes with their URLs, for the pickers. */
  remotes(repoId: string): Promise<Remote[]> {
    return this.requireRepo(repoId).repo.remotes();
  }

  /** The branches of a remote as last fetched, for Pull from... */
  remoteBranches(repoId: string, remote: string): Promise<string[]> {
    return this.requireRepo(repoId).repo.remoteBranches(remote);
  }

  async addRemote(repoId: string, name: string, url: string): Promise<void> {
    const entry = this.requireRepo(repoId);
    try {
      await entry.repo.addRemote(name, url);
    } finally {
      await this.wrote(entry);
    }
  }

  async removeRemote(repoId: string, name: string): Promise<void> {
    const entry = this.requireRepo(repoId);
    try {
      await entry.repo.removeRemote(name);
    } finally {
      await this.wrote(entry);
    }
  }

  /** VS Code's _fetch: pruneOnFetch adds --prune when the caller did not ask for it. */
  fetch(repoId: string, options: Omit<FetchOptions, 'prune'> & { readonly prune?: boolean }): Promise<void> {
    const prune = options.prune === true || this.flag(SCM_SETTING_KEYS.pruneOnFetch, false);
    const entry = this.requireRepo(repoId);
    return this.remoteOp(entry, 'fetch', async (net) => {
      await entry.repo.network(fetchArgs({ ...options, prune }, entry.repo.gitVersion), net);
    }, REMOTE_LOCKS);
  }

  pull(repoId: string, options: { readonly rebase: boolean; readonly remote?: string; readonly branch?: string }): Promise<void> {
    const entry = this.requireRepo(repoId);
    const from = options.remote !== undefined && options.branch !== undefined ? { remote: options.remote, branch: options.branch } : undefined;
    return this.remoteOp(entry, 'pull', (net) => this.runPull(entry, net, options.rebase, from));
  }

  /**
   * A push. A force push is refused while allowForcePush is off and always confirmed first (danger, Cancel focused); false: the
   * user said no. It uses --force-with-lease, plus --force-if-includes from git 2.30, never a plain --force.
   */
  async push(repoId: string, request: PushRequest): Promise<boolean> {
    const t = this.deps.t;
    if (request.force) {
      if (!this.flag(SCM_SETTING_KEYS.allowForcePush, false)) throw new Error(t('Force push is not allowed, please enable it with the "Allow force push" setting.'));
      const choice = await this.deps.ask({
        severity: 'danger',
        message: t('You are about to force push your changes, this can be destructive and could inadvertently overwrite changes made by others.'),
        detail: t('Are you sure to continue?'),
        actions: [t('Force Push')],
        cancelLabel: t('Cancel'),
      });
      if (choice !== 0) return false;
    }
    const entry = this.requireRepo(repoId);
    await this.remoteOp(entry, 'push', async (net) => {
      await entry.repo.network(pushArgs(request, entry.repo.gitVersion), net);
    }, REMOTE_LOCKS);
    return true;
  }

  // The pull and the push each run only while HEAD keeps the branch and upstream the question named.
  async sync(repoId: string, rebase: boolean): Promise<boolean> {
    const entry = this.requireRepo(repoId);
    const confirmed = syncBranchOf(entry.status?.head ?? null, entry.status?.upstream ?? null);
    if (!confirmed) throw new Error('Sync needs a branch with an upstream');
    const t = this.deps.t;
    if (this.flag(SCM_SETTING_KEYS.confirmSync, true)) {
      const choice = await this.deps.ask({
        severity: 'warning',
        message: t('This action will pull and push commits from and to "{0}/{1}".', visibleText(confirmed.remote), visibleText(confirmed.upstreamBranch)),
        actions: [t('OK'), t('OK, Don\'t Show Again')],
        cancelLabel: t('Cancel'),
        defaultAction: 0,
      });
      if (choice === undefined) return false;
      if (choice === 1) await this.deps.settings.update(SCM_SETTING_KEYS.confirmSync, false, 'user');
    }
    const useRebase = rebase || this.flag(SCM_SETTING_KEYS.rebaseWhenSync, false);
    await this.remoteOp(entry, 'sync', async (net) => {
      await this.runPull(entry, net, useRebase, undefined, confirmed);
      const fresh = await entry.repo.status(this.untrackedChanges());
      if (this.isLive(entry)) {
        entry.status = fresh;
        entry.revision++;
      }
      const found = syncBranchOf(fresh.head, fresh.upstream);
      if (!sameSyncBranch(found, confirmed)) throw this.syncBranchChanged('push', confirmed, found);
      if ((fresh.upstream?.ahead ?? 0) === 0) return;
      const followTags = this.flag(SCM_SETTING_KEYS.followTagsWhenSync, false);
      const target = pullTarget(fresh.upstream!);
      const request = target ? { remote: target.remote, branch: confirmed.branch, toBranch: target.branch } : {};
      await entry.repo.network(pushArgs({ ...request, setUpstream: false, followTags, force: false }, entry.repo.gitVersion), net);
    }, REMOTE_LOCKS);
    return true;
  }

  // No trust decides a clone, which runs no code of an existing repository; the clone's project starts untrusted.
  async clone(url: string, parent: string, recursive: boolean): Promise<string> {
    const t = this.deps.t;
    const runner = this.deps.runner;
    if (!runner) throw new Error(t('Git was not found'));
    if (this.cloning) throw new Error(t('A clone is already running.'));
    const name = cloneFolderName(url);
    if (name === undefined) throw new Error(t('The repository URL names no folder to clone into.'));
    const controller = new AbortController();
    this.cloning = { name, controller };
    this.emit({ kind: 'clone' });
    let outcome: RemoteOutcomeKind = 'failed';
    let registration: AskpassRegistration | undefined;
    let target: string | undefined;
    try {
      await fs.mkdir(parent, { recursive: true });
      // the clone's project starts untrusted, so a folder name the trust store still lists is skipped
      target = await freeCloneTarget(parent, name, (folder) => this.deps.trust.isTrusted(folder));
      if (target === undefined) throw new Error(t('Every folder name for the clone already exists in {0}.', parent));
      registration = await this.register('clone', controller);
      await runner.clone({ cwd: parent, args: cloneArgs(url, target, recursive), signal: controller.signal, ...(this.sessionJob ? { session: this.sessionJob } : {}), ...(registration ? { askpassEnv: registration.env } : {}) });
      outcome = 'ok';
      return target;
    } catch (err) {
      if (controller.signal.aborted) outcome = 'cancelled';
      if (target !== undefined) {
        await removeCloneTarget(target).catch((cleanup: unknown) => this.deps.log(`[scm] the folder of a ${outcome} clone was not removed: ${errorText(cleanup)}`));
      }
      if (outcome === 'cancelled') throw new RemoteCancelledError();
      throw err;
    } finally {
      registration?.dispose();
      this.cloning = undefined;
      this.lastClone = { outcome, seq: ++this.remoteSeq };
      this.emit({ kind: 'clone' });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.autofetcher.stop();
    this.cloning?.controller.abort();
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const project of this.projects.values()) this.disposeProject(project);
    this.projects.clear();
    this.listeners.clear();
    this.sessionJob?.dispose();
  }

  // The questions of a commit, in VS Code's order, and the options its answers give; ok: false ends the commit unmade.
  private async commitOptions(
    entry: RepoEntry,
    status: RepositoryStatus,
    message: string,
    variant: CommitVariant,
    hooks: CommitHooks,
  ): Promise<{ readonly ok: true; readonly opts: CommitOptions } | { readonly ok: false; readonly reason: 'emptyMessage' | 'nothingToCommit' | 'cancelled' | 'failed'; readonly error?: unknown }> {
    const t = this.deps.t;
    const cancelled = { ok: false as const, reason: 'cancelled' as const };
    const keys = SCM_SETTING_KEYS;
    // a rebase continues with git's prepared message, so its box may be empty
    const rebase = status.operation === 'rebase';
    if (!variant.amend && !rebase && message.trim() === '') return { ok: false, reason: 'emptyMessage' };
    if (variant.empty && this.flag(keys.confirmEmptyCommits, true)) {
      const choice = await this.deps.ask({ severity: 'warning', message: t('Are you sure you want to create an empty commit?'), actions: [t('Yes'), t('Yes, Don\'t Show Again')], cancelLabel: t('Cancel'), defaultAction: 0 });
      if (choice === undefined) return cancelled;
      if (choice === 1) await this.deps.settings.update(keys.confirmEmptyCommits, false, 'user');
    }
    const noStaged = status.groups.index.length === 0;
    const noUnstaged = status.groups.workingTree.length === 0;
    let all = variant.scope === 'all';
    if (!variant.empty) {
      let smart = this.flag(keys.enableSmartCommit, false);
      if (!noUnstaged && noStaged && !smart && !all && !variant.amend) {
        if (!this.flag(keys.suggestSmartCommit, true)) return { ok: false, reason: 'nothingToCommit' };
        const choice = await this.deps.ask({
          severity: 'warning',
          message: t('There are no staged changes to commit.'),
          detail: t('Would you like to stage all your changes and commit them directly?'),
          actions: [t('Yes'), t('Always'), t('Never')],
          cancelLabel: t('Cancel'),
          defaultAction: 0,
        });
        if (choice === undefined) return cancelled;
        if (choice === 2) {
          await this.deps.settings.update(keys.suggestSmartCommit, false, 'user');
          return cancelled;
        }
        if (choice === 1) await this.deps.settings.update(keys.enableSmartCommit, true, 'user');
        smart = true;
      }
      if (smart && !all) all = noStaged;
    }
    const changes = this.smartCommitChanges();
    const nothing = (noStaged && noUnstaged) || (!all && noStaged) || (noStaged && changes === 'tracked' && status.groups.workingTree.every((change) => change.status === 'UNTRACKED'));
    if (nothing && !variant.amend && !variant.empty && status.operation !== 'merge' && !rebase) return { ok: false, reason: 'nothingToCommit' };
    const staged = all && (changes === 'tracked' || this.untrackedChanges() !== 'mixed') ? 'tracked' : all ? 'all' : false;
    // staging 'all' adds the listed changes only, so past the status limit it would commit part of them
    if (staged === 'all' && status.tooManyChanges) {
      return { ok: false, reason: 'failed', error: new Error(t('The change list shows only the first {0} changes, so nothing was committed. Stage the changes to commit, or commit from a terminal.', STATUS_LIMIT)) };
    }
    if (variant.noVerify) {
      if (!this.flag(keys.allowNoVerifyCommit, false)) return { ok: false, reason: 'failed', error: new Error(t('Commits without verification are not allowed, please enable them with the "Allow no-verify commits" setting.')) };
      if (this.flag(keys.confirmNoVerifyCommit, true)) {
        const choice = await this.deps.ask({
          severity: 'warning',
          message: t('You are about to commit your changes without verification, this skips pre-commit hooks and can be undesirable.'),
          detail: t('Are you sure to continue?'),
          actions: [t('OK'), t('OK, Don\'t Ask Again')],
          cancelLabel: t('Cancel'),
          defaultAction: 0,
        });
        if (choice === undefined) return cancelled;
        if (choice === 1) await this.deps.settings.update(keys.confirmNoVerifyCommit, false, 'user');
      }
    }
    let branch: string | undefined;
    const prompt = this.branchProtectionPrompt();
    const head = status.head;
    if (head && head.type !== 'detached' && this.isBranchProtected(head.name) && prompt !== 'alwaysCommit') {
      let toNewBranch = true;
      if (prompt === 'alwaysPrompt') {
        const choice = await this.deps.ask({
          severity: 'warning',
          message: t('You are trying to commit to a protected branch. How would you like to proceed?'),
          actions: [t('Commit to a New Branch'), t('Commit Anyway')],
          cancelLabel: t('Cancel'),
          defaultAction: 0,
        });
        if (choice === undefined) return cancelled;
        toNewBranch = choice === 0;
      }
      if (toNewBranch) {
        branch = (await hooks.branchName?.())?.trim();
        if (!branch) return cancelled;
        if (!(await entry.repo.isValidBranchName(branch))) return { ok: false, reason: 'failed', error: new Error(t('Invalid branch name')) };
      }
    }
    const stagedPaths = new Set(status.groups.index.map((change) => change.path));
    const restage = (hooks.saved ?? []).map((file) => path.relative(entry.repo.root, file).split(path.sep).join('/')).filter((relative) => stagedPaths.has(relative));
    return {
      ok: true,
      opts: {
        all: staged,
        amend: variant.amend,
        signoff: variant.signoff || this.flag(keys.alwaysSignOff, false),
        sign: this.flag(keys.enableCommitSigning, false),
        empty: variant.empty,
        noVerify: variant.noVerify,
        restage,
        ...(branch !== undefined ? { branch } : {}),
      },
    };
  }

  // One per common dir, which linked worktrees share; a pull passes no locks and cleans up in its own slot.
  private async remoteOp<T>(entry: RepoEntry, op: RemoteOp, work: (net: NetworkCall) => Promise<T>, locks?: LockScope): Promise<T> {
    const commonDir = folderKey(entry.repo.info.commonDir);
    if (this.remoteRunningIn(commonDir)) throw new Error(this.deps.t('Another remote operation is running in this repository.'));
    const controller = new AbortController();
    entry.running = { op, controller };
    this.emit({ kind: 'repository', repoId: entry.id });
    const started = Date.now() - LOCK_TIME_SLACK_MS;
    let outcome: RemoteOutcomeKind = 'failed';
    let stashKept = false;
    let registration: AskpassRegistration | undefined;
    let before: ReadonlySet<string> = new Set();
    try {
      await this.autofetcher.yieldTo(commonDir);
      if (locks) before = await entry.repo.lockFiles(locks);
      registration = await this.register(op, controller);
      const result = await work({ signal: controller.signal, ...(registration ? { askpassEnv: registration.env } : {}) });
      outcome = 'ok';
      return result;
    } catch (err) {
      if (locks && (controller.signal.aborted || entry.repo.queue.signal.aborted)) await this.removeKilledLocks(entry, op, locks, started, before, false);
      if (err instanceof StashKeptError) {
        stashKept = true;
        outcome = keptStashOutcome(op, err.outcome);
        throw err;
      }
      if (err instanceof SyncBranchChangedError || !controller.signal.aborted) throw err;
      outcome = 'cancelled';
      throw new RemoteCancelledError();
    } finally {
      registration?.dispose();
      entry.running = undefined;
      entry.lastRemote = { op, outcome, stashKept, seq: ++this.remoteSeq };
      if (this.isLive(entry)) this.emit({ kind: 'repository', repoId: entry.id });
      await this.wrote(entry, ['branches', 'remoteBranches', 'tags']);
    }
  }

  private remoteRunningIn(commonDir: string): boolean {
    for (const entry of this.allRepos()) if (entry.running && folderKey(entry.repo.info.commonDir) === commonDir) return true;
    return false;
  }

  // None when the server cannot start, and one line says so; the call then runs as with no server. A credential prompt the
  // user cancels aborts the operation's own controller, so it ends as the Cancel button ends it.
  private async register(label: string, controller: AbortController): Promise<AskpassRegistration | undefined> {
    try {
      const registration = await this.deps.askpass?.register('interactive', label);
      registration?.cancelled.addEventListener('abort', () => controller.abort(), { once: true });
      return registration;
    } catch (err) {
      this.deps.log(`[scm] credential prompts are unavailable for this ${label}: ${errorText(err)}`);
      return undefined;
    }
  }

  // Holds every sharing repository's mutation slot, so no engine write's lock is taken; never throws over the outcome.
  private async removeKilledLocks(entry: RepoEntry, label: string, scope: LockScope, since: number, before: ReadonlySet<string>, holding: boolean): Promise<void> {
    const commonDir = folderKey(entry.repo.info.commonDir);
    const sharing = [...this.allRepos()].filter((other) => other !== entry && folderKey(other.repo.info.commonDir) === commonDir);
    const queues = [...(holding ? [] : [entry]), ...sharing].sort((a, b) => a.id.localeCompare(b.id)).map((other) => other.repo.queue);
    await holdingAll(queues, async () => {
      try {
        const { removed, failed } = await entry.repo.removeLocksSince(scope, since, before);
        if (removed.length > 0) this.deps.log(`[scm] removed the lock files a killed ${label} left: ${removed.map(logText).join(', ')}`);
        for (const failure of failed) this.deps.log(`[scm] a lock file a killed ${label} left could not be removed: ${logText(failure.path)}: ${errorText(failure.error)}`);
      } catch (err) {
        this.deps.log(`[scm] the lock files a killed ${label} left could not be checked: ${errorText(err)}`);
      }
    });
  }

  // The target is read in the pull's own mutation slot, never from the snapshot, which may predate a checkout.
  private async runPull(entry: RepoEntry, net: NetworkCall, rebase: boolean, from?: { readonly remote: string; readonly branch: string }, confirmed?: SyncBranch): Promise<void> {
    const version = entry.repo.gitVersion;
    const autoStash = this.flag(SCM_SETTING_KEYS.autoStash, false);
    const mode = (): StashMode => (this.declinedInside(entry.repo.root).length > 0 ? 'fenced' : needsStashAroundPull(version, autoStash) ? 'includeUntracked' : 'none');
    let keptAutostash: string | undefined;
    const stashed = await entry.repo.withStash(mode, async (git, slot) => {
      const { head, upstream } = await slot.branch();
      if (confirmed) {
        const found = syncBranchOf(head, upstream);
        if (!sameSyncBranch(found, confirmed)) throw this.syncBranchChanged('pull', confirmed, found);
      }
      const target = from ?? (head?.type === 'branch' && upstream ? pullTarget(upstream) : undefined);
      const scope: LockScope = { branches: head?.type === 'branch' ? [head.name] : [], workTree: true };
      const started = Date.now() - LOCK_TIME_SLACK_MS;
      const before = await entry.repo.lockFiles(scope);
      await slot.stash();
      // git 2.27 and later, with no stash of the engine's own
      const gitAutostash = autoStash && slot.mode === 'none';
      const newestBefore = gitAutostash ? await slot.newestStash() : undefined;
      try {
        await git(pullArgs({ rebase, autoStash: gitAutostash, ...target }, version), { net });
      } catch (err) {
        if (net.signal.aborted || entry.repo.queue.signal.aborted) await this.removeKilledLocks(entry, 'pull', scope, started, before, true);
        throw err;
      } finally {
        if (gitAutostash) keptAutostash = await this.keptAutostash(slot, newestBefore);
      }
    });
    const outcomeOf = (result: StashedOutcome<void>['result']): StashKeptOutcome => (result.ok ? 'ok' : net.signal.aborted ? 'cancelled' : 'failed');
    this.settleStash(keptAutostash === undefined ? stashed : { ...stashed, kept: { stash: keptAutostash } }, outcomeOf);
  }

  // git keeps its autostash in the list and exits 0 when it cannot apply it back; the entry's reflog message is git's untranslated
  // "autostash". Never throws, so the pull keeps its own outcome.
  private async keptAutostash(slot: StashSlot, before: NewestStash | undefined): Promise<string | undefined> {
    try {
      const after = await slot.newestStash();
      return after && after.hash !== before?.hash && after.message === 'autostash' ? after.hash : undefined;
    } catch (err) {
      this.deps.log(`[scm] the stash list could not be read after the pull, so an autostash git kept is not reported: ${errorText(err)}`);
      return undefined;
    }
  }

  // A kept stash wins over the operation's own outcome, so the user is told where the changes are.
  private settleStash<T>(stashed: StashedOutcome<T>, outcomeOf: (result: StashedOutcome<T>['result']) => StashKeptOutcome): T {
    const { result, kept } = stashed;
    if (kept) {
      const message = this.deps.t('Your changes were stashed for this operation and could not be applied back, so they are kept in the stash list.');
      throw new StashKeptError(message, outcomeOf(result), kept.stash, result.ok ? kept.error : result.error);
    }
    if (!result.ok) throw result.error;
    return result.value;
  }

  private syncBranchChanged(stage: 'pull' | 'push', confirmed: SyncBranch, found: SyncBranch | null): SyncBranchChangedError {
    const t = this.deps.t;
    const message = stage === 'pull'
      ? t('The branch or its upstream changed after you confirmed the sync, so nothing was pulled or pushed.')
      : t('The branch or its upstream changed during the sync, so nothing was pushed.');
    return new SyncBranchChangedError(message, stage, confirmed, found);
  }

  // The autofetch project's repositories that have a remote, one per common dir; trust is the project's (D8).
  private autofetchTargets(): AutofetchTarget[] {
    const project = this.autofetchProject === undefined ? undefined : this.projects.get(this.autofetchProject);
    if (!project || project.disposed || !this.deps.trust.isTrusted(project.path)) return [];
    const byCommonDir = new Map<string, RepoEntry[]>();
    for (const entry of project.repos.values()) {
      const key = folderKey(entry.repo.info.commonDir);
      byCommonDir.set(key, [...(byCommonDir.get(key) ?? []), entry]);
    }
    return [...byCommonDir].flatMap(([key, entries]) => {
      const entry = entries.find((candidate) => (candidate.status?.remotes.length ?? 0) > 0);
      if (!entry) return [];
      return [{ key, idle: () => !this.remoteRunningIn(key), fetch: (signal: AbortSignal) => this.backgroundFetch(entry, entries, signal) }];
    });
  }

  // The first round waits for a repository with a remote and a status, which the first rounds at selection never had.
  private autofetchWhenReady(): void {
    const ready = this.autofetchTargets().length > 0;
    if (ready && !this.autofetchReady) this.autofetcher.start();
    this.autofetchReady = ready;
  }

  // English, so AUTHENTICATION_FAILED matches; a failed registration fails the fetch, since an inherited askpass could prompt.
  private async backgroundFetch(entry: RepoEntry, sharing: readonly RepoEntry[], signal: AbortSignal): Promise<void> {
    const started = Date.now() - LOCK_TIME_SLACK_MS;
    let registration: AskpassRegistration | undefined;
    try {
      registration = await this.deps.askpass?.register('background', 'autofetch');
      const before = await entry.repo.lockFiles(REMOTE_LOCKS);
      try {
        await entry.repo.network(fetchArgs({ prune: this.flag(SCM_SETTING_KEYS.pruneOnFetch, false) }, entry.repo.gitVersion), { signal, english: true, ...(registration ? { askpassEnv: registration.env } : {}) });
      } catch (err) {
        if (signal.aborted || entry.repo.queue.signal.aborted) await this.removeKilledLocks(entry, 'autofetch', REMOTE_LOCKS, started, before, false);
        throw err;
      }
    } finally {
      registration?.dispose();
      for (const repo of sharing) if (this.isLive(repo)) this.scheduleStatus(repo, 0);
    }
  }

  // VS Code's isBranchProtected for the branchProtection setting: one picomatch over the trimmed, non-empty globs.
  private isBranchProtected(branch: string): boolean {
    const value = this.deps.settings.get<unknown>(SCM_SETTING_KEYS.branchProtection);
    const globs = (Array.isArray(value) ? value : [value]).map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter((entry) => entry !== '');
    return globs.length > 0 && picomatch(globs)(branch);
  }

  private flag(key: string, fallback: boolean): boolean {
    const value = this.deps.settings.get<unknown>(key);
    return typeof value === 'boolean' ? value : fallback;
  }

  private smartCommitChanges(): SmartCommitChanges {
    return this.deps.settings.get<unknown>(SCM_SETTING_KEYS.smartCommitChanges) === 'tracked' ? 'tracked' : 'all';
  }

  private branchProtectionPrompt(): BranchProtectionPrompt {
    const value = this.deps.settings.get<unknown>(SCM_SETTING_KEYS.branchProtectionPrompt);
    return value === 'alwaysCommit' || value === 'alwaysCommitToNewBranch' ? value : 'alwaysPrompt';
  }

  private async confirmUnresolved(entry: RepoEntry, paths: readonly string[]): Promise<boolean> {
    if (paths.length === 0) return true;
    const unresolved = await entry.repo.unresolved(paths);
    if (unresolved.length === 0) return true;
    const t = this.deps.t;
    const message = unresolved.length > 1
      ? t('Are you sure you want to stage {0} files with merge conflicts?', unresolved.length)
      : t('Are you sure you want to stage {0} with merge conflicts?', visibleText(path.basename(unresolved[0]!)));
    return (await this.deps.ask({ severity: 'warning', message, actions: [t('Yes')], cancelLabel: t('Cancel'), defaultAction: 0 })) === 0;
  }

  // VS Code's _cleanAll: tracked only, untracked only, or both with its three-way question
  private async cleanAll(entry: RepoEntry, changes: readonly Change[]): Promise<boolean> {
    if (changes.length === 0) return false;
    const tracked = changes.filter((change) => !isUntrackedStatus(change.status));
    const untracked = changes.filter((change) => isUntrackedStatus(change.status));
    if (untracked.length === 0) return this.cleanTracked(entry, changes);
    if (tracked.length === 0) return this.cleanUntracked(entry, changes);
    const t = this.deps.t;
    const [untrackedMessage, untrackedDetail] = this.untrackedQuestion(untracked);
    const trackedMessage = tracked.length === 1
      ? t('\n\nAre you sure you want to discard changes in \'{0}\'?', visibleText(path.basename(tracked[0]!.path)))
      : t('\n\nAre you sure you want to discard ALL changes in {0} files?', tracked.length);
    const yesTracked = tracked.length === 1 ? t('Discard 1 Tracked File') : t('Discard All {0} Tracked Files', tracked.length);
    const yesAll = t('Discard All {0} Files', changes.length);
    const trackedDetail = this.trackedQuestionDetail(tracked);
    const choice = await this.deps.ask({
      severity: 'danger',
      message: `${untrackedMessage} ${untrackedDetail}${trackedMessage}${trackedDetail === undefined ? '' : `\n\n${trackedDetail}`}`,
      actions: [yesTracked, yesAll],
      cancelLabel: t('Cancel'),
    });
    if (choice === undefined) return false;
    await this.runDiscard(entry, choice === 0 ? tracked : changes);
    return true;
  }

  private async cleanTracked(entry: RepoEntry, changes: readonly Change[]): Promise<boolean> {
    const t = this.deps.t;
    const allDeleted = changes.every((change) => change.status === 'DELETED');
    const one = changes.length === 1 ? visibleText(path.basename(changes[0]!.path)) : '';
    const message = allDeleted
      ? changes.length === 1 ? t('Are you sure you want to restore \'{0}\'?', one) : t('Are you sure you want to restore ALL {0} files?', changes.length)
      : changes.length === 1
        ? t('Are you sure you want to discard changes in \'{0}\'?', one)
        : t('Are you sure you want to discard ALL changes in {0} files?', changes.length);
    const yes = allDeleted
      ? changes.length === 1 ? t('Restore File') : t('Restore All {0} Files', changes.length)
      : changes.length === 1 ? t('Discard File') : t('Discard All {0} Files', changes.length);
    const detail = this.trackedQuestionDetail(changes);
    if ((await this.deps.ask({ severity: 'danger', message, ...(detail === undefined ? {} : { detail }), actions: [yes], cancelLabel: t('Cancel') })) !== 0) return false;
    await this.runDiscard(entry, changes);
    return true;
  }

  private async cleanUntracked(entry: RepoEntry, changes: readonly Change[]): Promise<boolean> {
    const t = this.deps.t;
    const [message, detail] = this.untrackedQuestion(changes);
    const action = this.deps.deletesPermanently
      ? changes.length === 1 ? t('Delete File') : t('Delete All {0} Files', changes.length)
      : this.platform() === 'win32' ? t('Move to Recycle Bin') : t('Move to Trash');
    if ((await this.deps.ask({ severity: 'danger', message, detail, actions: [action], cancelLabel: t('Cancel') })) !== 0) return false;
    await this.runDiscard(entry, changes);
    return true;
  }

  // VS Code's discardUntrackedChangesToTrash wording, whose {1} is empty when the files go to the OS trash.
  private untrackedQuestion(changes: readonly Change[]): [string, string] {
    const t = this.deps.t;
    const message = changes.length === 1
      ? t('Are you sure you want to DELETE the following untracked file: \'{0}\'?', visibleText(path.basename(changes[0]!.path)))
      : t('Are you sure you want to DELETE the {0} untracked files?', changes.length);
    if (this.deps.deletesPermanently) {
      return [message, changes.length === 1 ? t('This is IRREVERSIBLE!\nThis file will be FOREVER LOST if you proceed.') : t('This is IRREVERSIBLE!\nThese files will be FOREVER LOST if you proceed.')];
    }
    const windows = this.platform() === 'win32';
    const detail = changes.length === 1
      ? windows ? t('You can restore this file from the Recycle Bin.') : t('You can restore this file from the Trash.')
      : windows ? t('You can restore these files from the Recycle Bin.') : t('You can restore these files from the Trash.');
    return [message, detail];
  }

  // Where a tracked discard puts the working copies it replaces; none for a deletion or a submodule, which have none to trash.
  private trackedQuestionDetail(changes: readonly Change[]): string | undefined {
    if (this.deps.deletesPermanently) return undefined;
    const trashed = changes.filter((change) => change.status !== 'DELETED' && !change.submodule).length;
    if (trashed === 0) return undefined;
    const t = this.deps.t;
    const windows = this.platform() === 'win32';
    return trashed === 1
      ? windows ? t('You can restore the changed file from the Recycle Bin.') : t('You can restore the changed file from the Trash.')
      : windows ? t('You can restore the changed files from the Recycle Bin.') : t('You can restore the changed files from the Trash.');
  }

  private async runDiscard(entry: RepoEntry, changes: readonly Change[]): Promise<void> {
    let outcome: DiscardOutcome;
    try {
      outcome = await entry.repo.discard(changes, this.deps.trash);
    } finally {
      await this.wrote(entry);
    }
    if (outcome.kind === 'changed') throw new Error(this.deps.t('The files changed after you confirmed, so nothing was discarded. Review the changes and try again.'));
    if (outcome.failed.length > 0) throw new Error(this.notTrashedMessage(outcome.failed));
  }

  private notTrashedMessage(failed: readonly DiscardFailure[]): string {
    const t = this.deps.t;
    const windows = this.platform() === 'win32';
    const reason = errorText(failed[0]!.error);
    if (this.deps.deletesPermanently) {
      return failed.length > 1
        ? t('{0} files could not be deleted, so their changes were not discarded: {1}', failed.length, reason)
        : t('\'{0}\' could not be deleted, so its changes were not discarded: {1}', path.basename(failed[0]!.path), reason);
    }
    if (failed.length > 1) {
      return windows
        ? t('{0} files could not be moved to the Recycle Bin, so their changes were not discarded: {1}', failed.length, reason)
        : t('{0} files could not be moved to the Trash, so their changes were not discarded: {1}', failed.length, reason);
    }
    const name = path.basename(failed[0]!.path);
    return windows
      ? t('\'{0}\' could not be moved to the Recycle Bin, so its changes were not discarded: {1}', name, reason)
      : t('\'{0}\' could not be moved to the Trash, so its changes were not discarded: {1}', name, reason);
  }

  private platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform;
  }

  private untrackedChanges(): UntrackedChanges {
    const value = this.deps.settings.get<unknown>(SCM_SETTING_KEYS.untrackedChanges);
    return value === 'separate' || value === 'hidden' ? value : 'mixed';
  }

  private scanDepth(): number {
    const value = this.deps.settings.get<unknown>(SCM_SETTING_KEYS.repositoryScanMaxDepth);
    return typeof value === 'number' && Number.isInteger(value) && value >= -1 ? value : 1;
  }

  private parentSetting(): OpenRepositoryInParentFolders {
    const value = this.deps.settings.get<unknown>(SCM_SETTING_KEYS.openRepositoryInParentFolders);
    return value === 'always' || value === 'never' ? value : 'prompt';
  }

  private runner(): GitRunner {
    if (!this.gitRunner) throw new Error('Git was not found');
    return this.gitRunner;
  }

  // Every git call: the nearest registered project above its folder, and above each of folders, must be trusted when the call
  // starts, git searches up into no refused folder, and an untrusted project inside the folder is fenced off (fence()).
  // A call waits until every registered project's realpath has settled; the checks and the spawn then share one tick, so the
  // fence's inputs, read before them, are read again whenever the untrusted projects inside the folder changed meanwhile.
  private gate(runner: GitRunner, folders: readonly string[]): GitRunner {
    const gated: GitRunner = {
      git: runner.git,
      envFor: (call) => runner.envFor(call),
      run: async (call) => {
        for (;;) {
          while (this.realpathPending()) await this.realpathsSettled(call.signal);
          const declined = this.declinedInside(call.cwd);
          if (declined.length === 0) return this.spawnGated(runner, folders, call, call);
          const roots = await enclosingRepositories(call.cwd, declined);
          const names = COARSE_SUBCOMMANDS.has(call.args[subcommandIndex(call.args)] ?? '') ? await submoduleNames(gated, call) : [];
          if (this.realpathPending() || !sameMembers(this.declinedInside(call.cwd), declined)) continue;
          return this.spawnGated(runner, folders, call, fence(call, roots, names, runner.git.version));
        }
      },
    };
    return gated;
  }

  private spawnGated(runner: GitRunner, folders: readonly string[], call: GitCall, fenced: GitCall | undefined): Promise<GitResult> {
    if (!fenced || ![call.cwd, ...folders].every((folder) => this.mayRunIn(folder))) throw new GitUntrustedError();
    const ceiling = this.ceilingFor(call.cwd);
    return runner.run({ ...fenced, ...(ceiling !== undefined ? { ceilingDirectories: [ceiling] } : {}), ...(this.sessionJob ? { session: this.sessionJob } : {}) });
  }

  // Resolves project's realpath off the main thread; projects whose folders hold or lie inside it are rediscovered.
  private resolveReal(project: ProjectEntry): void {
    let release!: () => void;
    project.realPending = new Promise((resolve) => (release = resolve));
    project.releaseReal = () => {
      project.realPending = undefined;
      release();
    };
    void realpathOrLexical(project.path, this.deps.realpath ?? fs.realpath, this.deps.log).then((real) => {
      if (project.disposed) return;
      project.real = real;
      project.releaseReal();
      if (real !== undefined && !samePath(real, path.resolve(project.path))) this.rediscoverAround([real], [project]);
    });
  }

  private realpathPending(): boolean {
    for (const project of this.projects.values()) if (project.realPending) return true;
    return false;
  }

  // Resolves once every realpath pending now has settled or its project was removed; rejects when signal aborts first.
  private realpathsSettled(signal?: AbortSignal): Promise<void> {
    const pending = Promise.all([...this.projects.values()].flatMap((project) => (project.realPending ? [project.realPending] : [])));
    if (!signal) return pending.then(() => undefined);
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = (): void => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      void pending.then(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }

  // The registered projects whose folder holds folder, nearest first.
  private projectsAbove(folder: string): ProjectEntry[] {
    const found: Array<{ readonly project: ProjectEntry; readonly depth: number }> = [];
    for (const project of this.projects.values()) {
      const roots = rootsOf(project).filter((root) => isInside(root, folder));
      if (roots.length > 0) found.push({ project, depth: Math.max(...roots.map((root) => root.length)) });
    }
    return found.sort((a, b) => b.depth - a.depth).map((entry) => entry.project);
  }

  // The nearest registered project above a folder decides, as the trust store does per folder: a trusted parent never trusts a
  // child, and a parent left untrusted never overrides a child trusted by name. With none above it, the call's project decides.
  // While any project's realpath is unknown it refuses, as that project may hold folder through a link.
  private mayRunIn(folder: string): boolean {
    if (this.realpathPending()) {
      this.pendingRefusals++;
      return false;
    }
    const nearest = this.projectsAbove(folder)[0];
    return nearest === undefined || this.deps.trust.isTrusted(nearest.path);
  }

  // Where git must stop looking up from cwd: the folder holding the outermost trusted project below an untrusted one.
  private ceilingFor(cwd: string): string | undefined {
    let below: ProjectEntry | undefined;
    for (const project of this.projectsAbove(cwd)) {
      if (!this.deps.trust.isTrusted(project.path)) return below && path.dirname(below.real ?? path.resolve(below.path));
      below = project;
    }
    return undefined;
  }

  // The untrusted registered projects strictly inside folder, as '/' paths relative to it.
  private declinedInside(folder: string): string[] {
    const found = new Set<string>();
    for (const project of this.projects.values()) {
      if (this.deps.trust.isTrusted(project.path)) continue;
      for (const root of rootsOf(project)) {
        if (isInside(folder, root) && !samePath(folder, root)) found.add(path.relative(folder, root).split(path.sep).join('/'));
      }
    }
    return [...found];
  }

  private async refuseDeclined(...folders: string[]): Promise<void> {
    while (this.realpathPending()) await this.realpathsSettled();
    if (!folders.every((folder) => this.mayRunIn(folder))) throw new Error(this.deps.t('That folder belongs to a project you have not trusted, so source control runs no git there.'));
  }

  // Rediscovers every trusted project whose folder holds, or lies inside, one of folders, except skip.
  private rediscoverAround(folders: readonly string[], skip: readonly ProjectEntry[]): void {
    if (folders.length === 0) return;
    for (const project of this.projects.values()) {
      if (skip.includes(project) || !this.deps.trust.isTrusted(project.path)) continue;
      if (rootsOf(project).some((root) => folders.some((folder) => isInside(root, folder) || isInside(folder, root)))) void this.discoverProject(project);
    }
  }

  private require(projectKey: string): ProjectEntry {
    const project = this.projects.get(projectKey);
    if (!project) throw new Error('Unknown project');
    if (!this.deps.trust.isTrusted(project.path)) throw new Error('Source control is off in an untrusted project');
    return project;
  }

  private entry(repoId: string): RepoEntry | undefined {
    for (const project of this.projects.values()) for (const entry of project.repos.values()) if (entry.id === repoId) return entry;
    return undefined;
  }

  private requireRepo(repoId: string): RepoEntry {
    const entry = this.entry(repoId);
    if (!entry) throw new Error('Unknown repository');
    return entry;
  }

  private *allRepos(): IterableIterator<RepoEntry> {
    for (const project of this.projects.values()) yield* project.repos.values();
  }

  private closedRoots(project: ProjectEntry): string[] {
    const all = this.deps.globalState.get<Record<string, unknown>>(CLOSED_REPOSITORIES_KEY, {});
    const list = Object.hasOwn(all, folderKey(project.path)) ? all[folderKey(project.path)] : undefined;
    return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : [];
  }

  private setClosed(project: ProjectEntry, root: string, closed: boolean): Promise<void> {
    const key = folderKey(project.path);
    return updateSerially(this.deps.globalState, CLOSED_REPOSITORIES_KEY, (stored) => {
      const all: Record<string, unknown> = typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? { ...stored } : {};
      const list = Object.hasOwn(all, key) ? all[key] : undefined;
      const current = (Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : []).filter((entry) => !samePath(entry, root));
      const next = closed ? [...current, root] : current;
      if (next.length > 0) all[key] = next;
      else delete all[key];
      return all;
    });
  }

  private openedParents(): string[] {
    const list = this.deps.globalState.get<unknown>(PARENT_REPOSITORIES_KEY, []);
    return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : [];
  }

  private rememberParents(roots: readonly string[]): Promise<void> {
    return updateSerially(this.deps.globalState, PARENT_REPOSITORIES_KEY, (stored) => {
      const known = Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === 'string') : [];
      return [...known, ...roots.filter((root) => !known.some((entry) => samePath(entry, root)))];
    });
  }

  // D9 with VS Code's notification text: a notice after discovery, since nothing the user did asked (section 7, Focus), and
  // a Cancel-first dialog after Open Repository, the user's own action. Yes opens, Always and Never write the setting;
  // dismissing opens nothing, and until an answer git runs nothing in the parent.
  private async askAboutParents(project: ProjectEntry, again: boolean): Promise<void> {
    const pending = project.parents.filter((root) => again || !project.asked.has(rootKey(root)));
    if (pending.length === 0 || this.parentSetting() !== 'prompt') return;
    for (const root of pending) project.asked.add(rootKey(root));
    const t = this.deps.t;
    const message = pending.length === 1
      ? t('A git repository was found in the parent folders of the workspace or the open file(s). Would you like to open the repository?')
      : t('Git repositories were found in the parent folders of the workspace or the open file(s). Would you like to open the repositories?');
    const actions = [t('Yes'), t('Always'), t('Never')];
    const choice = again
      ? await this.deps.ask({ severity: 'warning', message, preview: pending.map(visibleText), actions, cancelLabel: t('Cancel') })
      : await this.deps.notify([message, ...pending.map(visibleText)].join('\n'), ...actions).then((answer) => (answer === undefined ? undefined : actions.indexOf(answer)));
    if (choice === 0) await this.rememberParents(pending);
    else if (choice === 1 || choice === 2) await this.deps.settings.update(SCM_SETTING_KEYS.openRepositoryInParentFolders, choice === 1 ? 'always' : 'never', 'user');
    if (choice === 0 || choice === 1) await this.discoverProject(project);
  }

  private async discoverProject(project: ProjectEntry): Promise<void> {
    const generation = ++project.generation;
    const stale = (): boolean => project.disposed || this.disposed || generation !== project.generation;
    const runner = this.gitRunner;
    if (!runner || !this.deps.trust.isTrusted(project.path)) {
      this.clearProject(project, runner ? 'untrusted' : 'gitMissing');
      return;
    }
    const signal = project.removed.signal;
    try {
      while (this.realpathPending()) await this.realpathsSettled(signal);
      if (stale()) return;
      const refusals = this.pendingRefusals;
      const projectReal = await fs.realpath(project.path);
      const result = await discover(runner, project.path, projectReal, this.scanDepth(), (folder) => this.mayRunIn(folder), signal);
      if (stale()) return;
      project.real = projectReal;
      const setting = this.parentSetting();
      const opened = this.openedParents();
      const parents: FoundRepository[] = [];
      const consentedUnsafe: string[] = [];
      const pendingParents: string[] = [];
      const allowed = (dir: string): boolean => this.mayRunIn(path.resolve(dir));
      for (const root of result.parents.filter(allowed)) {
        if (setting === 'always' || opened.some((entry) => samePath(entry, root))) {
          const found = await inspectFolder(runner, project.path, root, signal);
          if (stale()) return;
          if (found.kind === 'repository' && [found.root, found.gitDir, found.commonDir].every(allowed)) parents.push({ root: found.root, gitDir: found.gitDir, commonDir: found.commonDir, kind: 'root' });
          else if (found.kind === 'unsafe' && allowed(found.path)) consentedUnsafe.push(found.path);
        } else if (setting === 'prompt') pendingParents.push(root);
      }
      const pickedUnsafe: string[] = [];
      for (const picked of [...project.pickedUnsafe].filter(allowed)) {
        const found = await inspectFolder(runner, project.path, picked, signal);
        if (stale()) return;
        if (found.kind === 'unsafe') pickedUnsafe.push(found.path);
        project.pickedUnsafe.delete(picked);
        if (found.kind === 'unsafe') project.pickedUnsafe.add(found.path);
        if (found.kind === 'repository' && isInside(projectReal, found.root) && [found.root, found.gitDir, found.commonDir].every(allowed)) {
          project.explicit.set(rootKey(found.root), { root: found.root, gitDir: found.gitDir, commonDir: found.commonDir, kind: samePath(found.root, projectReal) ? 'root' : 'nested' });
        }
      }
      // a project registered meanwhile made allowed() refuse while its realpath was unknown
      if (this.pendingRefusals !== refusals) return await this.discoverProject(project);
      const closed = this.closedRoots(project);
      const isClosed = (root: string): boolean => closed.some((entry) => samePath(entry, root));
      const wanted = new Map<string, { found: FoundRepository; kind: RepoKind }>();
      for (const found of [...result.repositories, ...[...project.explicit.values()].filter((explicit) => [explicit.root, explicit.gitDir, explicit.commonDir].every(allowed))]) {
        if (!wanted.has(rootKey(found.root))) wanted.set(rootKey(found.root), { found, kind: found.kind });
      }
      for (const found of parents) wanted.set(rootKey(found.root), { found, kind: 'parent' });
      project.closedFound = [...wanted.values()].filter((candidate) => isClosed(candidate.found.root)).map((candidate) => candidate.found.root);
      for (const [key, candidate] of wanted) if (isClosed(candidate.found.root)) wanted.delete(key);
      for (const [key, entry] of project.repos) if (!wanted.has(key)) this.disposeRepo(project, entry);
      for (const [key, candidate] of wanted) {
        const existing = project.repos.get(key);
        if (existing) existing.kind = candidate.kind;
        else this.openRepo(project, key, candidate.found, candidate.kind);
      }
      project.parents = pendingParents;
      project.unsafe = [...result.unsafe, ...consentedUnsafe, ...pickedUnsafe].filter((entry, index, all) => all.findIndex((other) => samePath(other, entry)) === index);
      project.state = project.repos.size > 0 ? 'ready' : 'noRepository';
      this.watchProject(project);
      this.emit({ kind: 'view', projectKey: project.key });
      this.emit({ kind: 'decorations', projectKey: project.key });
      this.emit({ kind: 'ignores', projectKey: project.key });
      if (pendingParents.length > 0) void this.askAboutParents(project, false).catch((err: unknown) => this.deps.log(`[scm] the parent repository question failed: ${errorText(err)}`));
    } catch (err) {
      if (stale()) return;
      this.deps.log(`[scm] discovery failed for a project: ${errorText(err)}`);
      if (project.repos.size === 0) project.state = 'noRepository';
      this.emit({ kind: 'view', projectKey: project.key });
    }
  }

  private openRepo(project: ProjectEntry, key: string, found: FoundRepository, kind: RepoKind): void {
    const gated = this.gate(this.deps.runner!, [found.gitDir, found.commonDir]);
    const runner: GitRunner = { git: gated.git, envFor: (call) => gated.envFor(call), run: (call) => gated.run(call).catch((err: unknown) => this.closeIfGone(entry, err)) };
    const repo = new Repository({ root: found.root, gitDir: found.gitDir, commonDir: found.commonDir, kind, project: project.path }, runner);
    const entry: RepoEntry = { id: `${this.repoIdPrefix}${++this.nextRepoId}`, projectKey: project.key, repo, kind, status: undefined, revision: 0, blames: new BlameCache(), timer: undefined, disposables: [], running: undefined, lastRemote: undefined, artifactGroups: new Set(), artifactTimer: undefined, refsDigest: undefined, refsReads: 0, refsLanded: 0 };
    entry.disposables.push(repo.queue.onIdleChange(() => this.emit({ kind: 'repository', repoId: entry.id })));
    // a git dir outside the project folder (a linked worktree's, a parent's) gets its own watch; the project's watch covers the rest
    const projectReal = project.real!;
    for (const dir of new Set([found.gitDir, found.commonDir])) {
      if (isInside(projectReal, dir)) continue;
      const watcher = this.deps.watchers.watch(dir, '**');
      const onEvent = (fsPath: string): void => this.gitDirEvent(entry, fsPath);
      watcher.onDidCreate(onEvent);
      watcher.onDidChange(onEvent);
      watcher.onDidDelete(onEvent);
      entry.disposables.push(() => watcher.dispose());
    }
    project.repos.set(key, entry);
    this.scheduleStatus(entry, 0);
    // the refs the first watcher event compares with, so an echo of refs the Graph's first load read reports no change
    void this.recordRefs(entry);
  }

  private gitDirEvent(entry: RepoEntry, fsPath: string): void {
    const info = entry.repo.info;
    for (const dir of new Set([info.gitDir, info.commonDir])) {
      if (!isInside(dir, fsPath)) continue;
      const relative = path.relative(dir, fsPath).split(path.sep).join('/');
      for (const [pattern, groups] of ARTIFACT_PATHS) if (pattern.test(relative)) this.scheduleArtifacts(entry, groups);
    }
    for (const dir of [info.gitDir, info.commonDir]) {
      if (!isInside(dir, fsPath)) continue;
      const relative = path.relative(dir, fsPath);
      if (GIT_DIR_WATCHED.test(relative)) this.scheduleStatus(entry, WATCH_DEBOUNCE_MS);
      const project = this.projects.get(entry.projectKey);
      if (project && relative === path.join('info', 'exclude')) this.scheduleIgnores(project);
      return;
    }
  }

  // One watch per project folder: git dir entries refresh their repository, a new or removed .git or a .gitmodules change
  // rediscovers, and anything else refreshes the deepest repository holding it.
  private watchProject(project: ProjectEntry): void {
    if (project.watcher) return;
    const watcher = this.deps.watchers.watch(project.path, '**');
    const onEvent = (fsPath: string): void => this.projectEvent(project, fsPath);
    watcher.onDidCreate(onEvent);
    watcher.onDidChange(onEvent);
    watcher.onDidDelete(onEvent);
    project.watcher = watcher;
  }

  private projectEvent(project: ProjectEntry, fsPath: string): void {
    if (project.disposed) return;
    const real = project.real ? path.join(project.real, path.relative(project.path, fsPath)) : fsPath;
    for (const entry of project.repos.values()) {
      const info = entry.repo.info;
      if (isInside(info.gitDir, real) || isInside(info.commonDir, real)) {
        this.gitDirEvent(entry, real);
        return;
      }
    }
    const segments = path.relative(project.real ?? project.path, real).split(path.sep);
    const name = segments.at(-1);
    if (name === '.git' || name === '.gitmodules') {
      this.scheduleRediscovery(project);
      if (name === '.git') return;
    }
    if (segments.includes('.git')) return;
    if (name === '.gitignore') this.scheduleIgnores(project);
    const owner = this.deepestRepo(project, real);
    if (owner) this.scheduleStatus(owner, WATCH_DEBOUNCE_MS);
  }

  private scheduleIgnores(project: ProjectEntry): void {
    if (project.ignoresTimer) clearTimeout(project.ignoresTimer);
    project.ignoresTimer = setTimeout(() => {
      project.ignoresTimer = undefined;
      this.emit({ kind: 'ignores', projectKey: project.key });
    }, WATCH_DEBOUNCE_MS);
  }

  private scheduleRediscovery(project: ProjectEntry): void {
    if (project.rediscoverTimer) clearTimeout(project.rediscoverTimer);
    project.rediscoverTimer = setTimeout(() => {
      project.rediscoverTimer = undefined;
      void this.discoverProject(project);
    }, WATCH_DEBOUNCE_MS);
  }

  private deepestRepo(project: ProjectEntry, absolute: string): RepoEntry | undefined {
    let best: RepoEntry | undefined;
    for (const entry of project.repos.values()) {
      if (isInside(entry.repo.root, absolute) && (!best || entry.repo.root.length > best.repo.root.length)) best = entry;
    }
    return best;
  }

  private scheduleStatus(entry: RepoEntry, delayMs: number): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.runStatus(entry);
    }, delayMs);
  }

  // Never rejects, so an operation awaiting it keeps its own outcome.
  private runStatus(entry: RepoEntry): Promise<void> {
    return entry.repo.status(this.untrackedChanges()).then(
      (status) => {
        if (!this.isLive(entry)) return;
        entry.status = status;
        entry.revision++;
        this.emit({ kind: 'repository', repoId: entry.id });
        this.emit({ kind: 'decorations', projectKey: entry.projectKey });
        if (entry.projectKey === this.autofetchProject) this.autofetchWhenReady();
      },
      (err: unknown) => {
        if (!this.isLive(entry) || err instanceof GitQueueDisposedError || err instanceof GitUntrustedError) return;
        this.deps.log(`[scm] status failed: ${errorText(err)}`);
        const project = this.projects.get(entry.projectKey);
        if (project) this.scheduleRediscovery(project);
      },
    );
  }

  // The watcher's changes, coalesced over WATCH_DEBOUNCE_MS like status.
  private scheduleArtifacts(entry: RepoEntry, groups: readonly ArtifactGroup[]): void {
    for (const group of groups) entry.artifactGroups.add(group);
    if (entry.artifactTimer) clearTimeout(entry.artifactTimer);
    entry.artifactTimer = setTimeout(() => {
      entry.artifactTimer = undefined;
      const changed = [...entry.artifactGroups];
      entry.artifactGroups.clear();
      if (!changed.some((group) => REF_GROUPS.has(group))) {
        if (this.isLive(entry)) this.emit({ kind: 'artifacts', repoId: entry.id, groups: changed });
        return;
      }
      void this.recordRefs(entry).then((refs) => {
        if (!this.isLive(entry)) return;
        this.emit({ kind: 'artifacts', repoId: entry.id, groups: changed, ...(refs === 'moved' ? { refs: 'background' as const } : {}) });
      });
    }, WATCH_DEBOUNCE_MS);
  }

  // Lists the refs and keeps their digest unless a later listing landed first: moved when they differ from the digest kept
  // before or could not be listed, stale when a later listing landed.
  private async recordRefs(entry: RepoEntry): Promise<'moved' | 'same' | 'stale'> {
    const read = ++entry.refsReads;
    const refs = await this.readRefs(entry);
    if (read < entry.refsLanded) return 'stale';
    if (refs === undefined) return 'moved';
    const moved = refs !== entry.refsDigest;
    entry.refsDigest = refs;
    entry.refsLanded = read;
    return moved ? 'moved' : 'same';
  }

  // A digest of every branch, remote branch and tag with its object; undefined (logged) when git could not list them.
  private async readRefs(entry: RepoEntry): Promise<string | undefined> {
    try {
      const listed = await entry.repo.read(['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags'], { maxOutputBytes: 64 * 1024 * 1024 });
      return createHash('sha256').update(listed.stdout).digest('hex');
    } catch (err) {
      if (this.isLive(entry) && !(err instanceof GitQueueDisposedError)) this.deps.log(`[scm] listing the refs failed: ${errorText(err)}`);
      return undefined;
    }
  }

  // Every operation awaits this, so a caller reading the snapshot next sees what the operation left (VS Code's Repository.run).
  private async wrote(entry: RepoEntry, groups: readonly ArtifactGroup[] = []): Promise<void> {
    if (!this.isLive(entry)) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    await this.runStatus(entry);
    await this.listsChanged(entry, groups);
  }

  // An engine write's lists; one that may have moved a ref records the refs first, so the watcher's echo reports no ref change.
  private async listsChanged(entry: RepoEntry, groups: readonly ArtifactGroup[]): Promise<void> {
    if (groups.length === 0 || !this.isLive(entry)) return;
    if (!groups.some((group) => REF_GROUPS.has(group))) {
      this.emit({ kind: 'artifacts', repoId: entry.id, groups });
      return;
    }
    await this.recordRefs(entry);
    if (!this.isLive(entry)) return;
    this.emit({ kind: 'artifacts', repoId: entry.id, groups, refs: 'engine' });
  }

  private isLive(entry: RepoEntry): boolean {
    const project = this.projects.get(entry.projectKey);
    return project !== undefined && !project.disposed && [...project.repos.values()].includes(entry);
  }

  // A failed call of a repository whose root or git dir no longer exists closes it and rejects as a closed repository's call,
  // as VS Code disposes a repository on NotAGitRepository (git's own answer, or a spawn ENOENT in a removed folder).
  private async closeIfGone(entry: RepoEntry, err: unknown): Promise<never> {
    if (err instanceof GitQueueDisposedError || err instanceof GitUntrustedError) throw err;
    const { root, gitDir } = entry.repo.info;
    if (!(await isMissing(root)) && !(await isMissing(gitDir))) throw err;
    const project = this.projects.get(entry.projectKey);
    if (project && this.isLive(entry)) {
      this.deps.log(`[scm] ${root} or its git dir no longer exists, so its repository closed`);
      this.disposeRepo(project, entry);
      if (project.repos.size === 0 && project.state === 'ready') project.state = 'noRepository';
      this.emit({ kind: 'view', projectKey: project.key });
      this.emit({ kind: 'decorations', projectKey: project.key });
    }
    throw new GitQueueDisposedError({ cause: err });
  }

  private clearProject(project: ProjectEntry, state: ProjectViewState): void {
    for (const entry of project.repos.values()) this.disposeRepo(project, entry);
    project.watcher?.dispose();
    project.watcher = undefined;
    project.closedFound = [];
    project.parents = [];
    project.unsafe = [];
    project.state = state;
    this.emit({ kind: 'view', projectKey: project.key });
    this.emit({ kind: 'decorations', projectKey: project.key });
    this.emit({ kind: 'ignores', projectKey: project.key });
  }

  private disposeRepo(project: ProjectEntry, entry: RepoEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (entry.artifactTimer) clearTimeout(entry.artifactTimer);
    entry.artifactTimer = undefined;
    for (const dispose of entry.disposables.splice(0)) dispose();
    entry.repo.dispose();
    for (const [key, candidate] of project.repos) if (candidate === entry) project.repos.delete(key);
    this.emit({ kind: 'repository', repoId: entry.id });
    if (project.key === this.autofetchProject) this.autofetchWhenReady();
  }

  private disposeProject(project: ProjectEntry): void {
    project.disposed = true;
    project.generation++;
    project.releaseReal();
    project.removed.abort(new GitQueueDisposedError());
    if (project.rediscoverTimer) clearTimeout(project.rediscoverTimer);
    if (project.ignoresTimer) clearTimeout(project.ignoresTimer);
    for (const entry of [...project.repos.values()]) this.disposeRepo(project, entry);
    project.watcher?.dispose();
    project.watcher = undefined;
  }

  private emit(event: ScmEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.deps.log(`[scm] a listener failed: ${errorText(err)}`);
      }
    }
  }
}

// a second of slack for file systems whose times are coarser than Date.now()
const LOCK_TIME_SLACK_MS = 1000;
const REMOTE_LOCKS: LockScope = { branches: [], workTree: false };
// Before git 2.35 the checked-out refusal read "Refusing to fetch into current branch"; matched in LC_ALL=C.
const FAST_FORWARD_REFUSED = /\(non-fast-forward\)|refusing to fetch into (current )?branch|can't fetch into checked-out branch/i;

function syncBranchOf(head: Head | null, upstream: Upstream | null): SyncBranch | null {
  return head?.type === 'branch' && upstream ? { branch: head.name, remote: upstream.remote, upstreamBranch: upstream.branch } : null;
}

function sameSyncBranch(found: SyncBranch | null, confirmed: SyncBranch): boolean {
  return found !== null && found.branch === confirmed.branch && found.remote === confirmed.remote && found.upstreamBranch === confirmed.upstreamBranch;
}

// A queue disposed before its slot came is skipped, so a closed repository never blocks the cleanup.
async function holdingAll(queues: readonly RepoQueue[], task: () => Promise<void>): Promise<void> {
  const [first, ...rest] = queues;
  if (!first) return task();
  let held = false;
  await first.mutation(async () => {
    held = true;
    await holdingAll(rest, task);
  }).catch((err: unknown) => {
    if (held || !(err instanceof GitQueueDisposedError)) throw err;
  });
  if (!held) await holdingAll(rest, task);
}

// The project folder as registered and, when it exists, its realpath: repository roots and git's cwds are realpaths.
function rootsOf(project: ProjectEntry): string[] {
  const lexical = path.resolve(project.path);
  return project.real === undefined || samePath(project.real, lexical) ? [lexical] : [lexical, project.real];
}

// The engine's subcommands whose arguments after `--` are pathspecs, and stash push; checkout-index and mv take plain paths.
const PATHSPEC_SUBCOMMANDS: ReadonlySet<string> = new Set(['status', 'diff', 'add', 'reset', 'rm', 'ls-files']);
// pull.autoStash (git 2.51) beats the other two, as pull passes it on as --autostash (scm-trust.integration.test.ts).
const NO_AUTOSTASH = ['-c', 'rebase.autoStash=false', '-c', 'merge.autoStash=false', '-c', 'pull.autoStash=false'];
// A printed status (commit with nothing to commit, a pending autostash's apply) enters every gitlink unless these say otherwise;
// status.submoduleSummary's summary runs git log in each.
const QUIET_STATUS = ['-c', 'diff.ignoreSubmodules=all', '-c', 'status.submoduleSummary=false'];
// Each subcommand that enters every gitlink with no pathspec, and the settings that stop it (scm-trust.integration.test.ts):
// rebase --continue's child commit also prints a status into its message template. Each also gets submodule.<name>.ignore=all
// for every name (fence()), as a per-name setting beats diff.ignoreSubmodules in a printed status and in a real merge's
// stash create, which a pull's merge runs too.
const COARSE_SUBCOMMANDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['commit', QUIET_STATUS],
  ['rebase', ['-c', 'commit.status=false', ...QUIET_STATUS, ...NO_AUTOSTASH]],
  ['merge', [...QUIET_STATUS, ...NO_AUTOSTASH]],
  ['cherry-pick', QUIET_STATUS],
  ['pull', NO_AUTOSTASH],
]);
const OPERATION_CONTROLS: ReadonlySet<string> = new Set(['--abort', '--continue', '--quit', '--skip']);

// submodule.recurse=false: a user's submodule.recurse=true makes a work-tree write recurse into every gitlink. A starting pull,
// merge or rebase needs the engine's fenced stash first (GitCall.fencedStash): a real merge runs `stash create`, which enters them.
// declined must hold no root inside a folder that holds a .git, which git would enter whole (enclosingRepositories()).
function fence(call: GitCall, declined: readonly string[], names: readonly string[], version: GitVersion): GitCall | undefined {
  const at = subcommandIndex(call.args);
  const subcommand = call.args[at] ?? '';
  const separator = call.args.indexOf('--');
  const paths = separator < 0 ? [] : call.args.slice(separator + 1);
  // a submodule command with no path acts on every submodule
  if (subcommand === 'submodule' && (paths.length === 0 || paths.includes('.'))) return undefined;
  if ((separator < 0 ? call.args : call.args.slice(0, separator)).includes('--autostash')) return undefined;
  const starts = subcommand === 'pull' || ((subcommand === 'merge' || subcommand === 'rebase') && !call.args.slice(at + 1).some((arg) => OPERATION_CONTROLS.has(arg)));
  if (starts && call.fencedStash !== true) return undefined;
  // folded on macOS too, whose volumes are case-insensitive by default; over-refusing on a case-sensitive one is harmless
  const folded = process.platform === 'win32' || process.platform === 'darwin';
  const key = (relative: string): string => (folded ? relative.toLowerCase() : relative);
  const within = (outer: string, inner: string): boolean => key(inner) === key(outer) || key(inner).startsWith(`${key(outer)}/`);
  // remote add's and remove's operands are a name and a URL; every other operand after -- is a path
  const named = subcommand === 'remote' ? [] : paths;
  if (named.some((entry) => entry !== '.' && declined.some((root) => within(root, entry) || within(entry, root)))) return undefined;
  // GIT_CONFIG_COUNT pairs (git 2.31) keep hundreds of names off the command line; -c splits a name at its first '='
  const pairs = gitAtLeast(version, 2, 31);
  if (!pairs && names.some((name) => name.includes('='))) return undefined;
  const ignored = pairs ? [] : names.flatMap((name) => ['-c', `submodule.${name}.ignore=all`]);
  const config = pairs ? names.map((name): [string, string] => [`submodule.${name}.ignore`, 'all']) : [];
  const fenced = { ...call, args: ['-c', 'submodule.recurse=false', ...(COARSE_SUBCOMMANDS.get(subcommand) ?? []), ...ignored, ...call.args], ...(config.length > 0 ? { config: [...(call.config ?? []), ...config] } : {}) };
  // --no-index compares two files and takes no pathspec
  // stash push checks every gitlink for changes (a status inside each submodule) unless its pathspec excludes it
  const pathspecs = PATHSPEC_SUBCOMMANDS.has(subcommand) || (subcommand === 'stash' && call.args[at + 1] === 'push');
  if (!pathspecs || call.args.includes('--no-index')) return fenced;
  // exclude magic needs pathspec magic on, so each named path keeps its literal meaning through :(literal) instead
  const { literalPathspecs: _literal, ...rest } = fenced;
  const magic = folded ? 'exclude,literal,icase' : 'exclude,literal';
  const literal = paths.map((entry) => (entry === '.' ? entry : `:(literal)${entry}`));
  const head = separator < 0 ? [...rest.args, '--'] : rest.args.slice(0, rest.args.indexOf('--') + 1);
  return { ...rest, args: [...head, ...literal, ...declined.map((root) => `:(${magic})${root}`)] };
}

// Each declined root, or the outermost folder between cwd and it that holds a .git: git sees that repository only as a gitlink
// and enters all of it, so only excluding the whole gitlink keeps git out of the root. An lstat failing but by absence counts as one.
async function enclosingRepositories(cwd: string, declined: readonly string[]): Promise<string[]> {
  const roots = await Promise.all(
    declined.map(async (root) => {
      const segments = root.split('/');
      const between = segments.slice(1).map((_segment, index) => segments.slice(0, index + 1).join('/'));
      const holds = await Promise.all(between.map((folder) => holdsGitEntry(path.join(cwd, ...folder.split('/')))));
      return between[holds.indexOf(true)] ?? root;
    }),
  );
  return [...new Set(roots)];
}

async function holdsGitEntry(folder: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(folder, '.git'));
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

// Only lstat's own answer that nothing is there; any other failure (a denied folder) proves nothing is gone.
async function isMissing(absolute: string): Promise<boolean> {
  try {
    await fs.lstat(absolute);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

// The submodule names of the .gitmodules git reads: the work tree's, else the index's or HEAD's. While the work tree's does not
// parse (conflict markers), every one an abort may restore. A .gitmodules that does not parse names nothing, as git dies reading it.
async function submoduleNames(runner: GitRunner, call: GitCall): Promise<string[]> {
  const inTree = await fs.stat(path.join(call.cwd, '.gitmodules')).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
      throw err;
    },
  );
  const read = async (source: readonly string[]): Promise<string[] | undefined> => {
    const args = ['config', '-z', '--name-only', ...source, '--get-regexp', '^submodule\\.'];
    const result = await runner.run({ project: call.project, cwd: call.cwd, args, kind: 'read', parsed: true, allowFailure: true, ...(call.signal ? { signal: call.signal } : {}) });
    // 1: no such key, or no such blob; 3 and 128: a file that does not parse. Anything else (a kill) fails the call.
    if (result.exitCode === 3 || result.exitCode === 128) return undefined;
    if (result.exitCode !== 0 && result.exitCode !== 1) throw new GitError(`git config exited with ${result.exitCode}`, result.exitCode, '', result.stderr);
    return result.stdout.toString('utf8').split('\0').flatMap((key) => {
      const last = key.lastIndexOf('.');
      return last > 'submodule.'.length ? [key.slice('submodule.'.length, last)] : [];
    });
  };
  const found = inTree ? await read(['--file', '.gitmodules']) : undefined;
  if (found) return [...new Set(found)];
  const blobs = inTree ? [':.gitmodules', ':1:.gitmodules', ':2:.gitmodules', ':3:.gitmodules', 'HEAD:.gitmodules', 'ORIG_HEAD:.gitmodules'] : [':.gitmodules', 'HEAD:.gitmodules'];
  const names = new Set<string>();
  for (const blob of blobs) for (const name of (await read(['--blob', blob])) ?? []) names.add(name);
  return [...names];
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry) => b.includes(entry));
}

// A folder that does not exist has no realpath; one whose realpath fails otherwise is logged and matched by its path alone.
async function realpathOrLexical(folder: string, realpath: (folder: string) => Promise<string>, log: (line: string) => void): Promise<string | undefined> {
  try {
    return await realpath(folder);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') log(`[scm] a project folder's realpath failed, so it is matched by its path alone: ${errorText(err)}`);
    return undefined;
  }
}

function order(kind: RepoKind): number {
  return kind === 'root' ? 0 : kind === 'parent' ? 1 : 2;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

