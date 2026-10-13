// Each project's repositories, their state and the user flows that ask inside an operation (plan AD4, D8, D9).
// Trust is asked about the project folder: a repository found in it takes its trust (TrustStore matches folders exactly),
// except one inside another registered project that is not trusted, where no git runs whichever project found it (gate()).
// An untrusted project starts no git process, discovery, watcher and check-ignore included.
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
import { createShellSessionJob, type ShellSessionJob } from '../pi-session/tools/process-tree';
import { folderKey } from '../workspace-folders/folder-key';
import { commitHistory, recordCommitMessage } from './commit-history';
import { discover, inspectFolder, isInside, samePath, type FoundRepository } from './discovery';
import { GitQueueDisposedError, GitUntrustedError, subcommandIndex, type GitCall, type GitRunner } from './git-runner';
import { updateSerially } from './serial-update';
import {
  EMPTY_GROUPS,
  isUntrackedStatus,
  Repository,
  type Change,
  type ChangeGroup,
  type ChangeLetter,
  type ChangeStatus,
  type ChangeTone,
  type CommitOptions,
  type CommitOutcome,
  type DiscardFailure,
  type DiscardOutcome,
  type RepoKind,
  type RepositoryStatus,
} from './repository';
import { SCM_SETTING_KEYS, type BranchProtectionPrompt, type OpenRepositoryInParentFolders, type SmartCommitChanges, type UntrackedChanges } from './settings-keys';

// AD4: the workspace and .git watchers feed a 500 ms trailing debounce
export const WATCH_DEBOUNCE_MS = 500;
const CLOSED_REPOSITORIES_KEY = 'damocles.scm.closedRepositories';
const PARENT_REPOSITORIES_KEY = 'damocles.scm.parentRepositories';
// git dir entries whose change can change what status, HEAD or the operation in progress shows (AD4's .git watcher)
const GIT_DIR_WATCHED = /^(HEAD|index|packed-refs|FETCH_HEAD|MERGE_HEAD|REBASE_HEAD|CHERRY_PICK_HEAD|MERGE_MSG)$|^(refs|rebase-merge|rebase-apply|worktrees)[\\/]/;

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
  readonly runner: GitRunner | undefined;
  readonly trust: TrustService;
  readonly watchers: FileWatcherFactory;
  readonly settings: SettingsStore;
  // global KeyValueState: closed repositories by project, parent repositories the user opened
  readonly globalState: Memento;
  readonly ask: ScmAsk;
  // a non-modal notice with actions (NotificationService.info); resolves the chosen action's label
  readonly notify: (message: string, ...actions: string[]) => Promise<string | undefined>;
  readonly trash: (absolutePath: string) => Promise<void>;
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
  | { readonly kind: 'ignores'; readonly projectKey: string };

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
  timer: NodeJS.Timeout | undefined;
  readonly disposables: Array<() => void>;
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
  private nextRepoId = 0;
  // how often mayRunIn refused because a realpath was unknown; a discovery that saw one runs again
  private pendingRefusals = 0;
  private disposed = false;
  // The session job every cancellable git call of this service joins: closing it, on dispose or by the host's death, kills what
  // still runs. Index writes never join it.
  private readonly sessionJob: ShellSessionJob | undefined;
  private readonly gitRunner: GitRunner | undefined;

  constructor(deps: ScmServiceDeps) {
    this.deps = deps;
    this.sessionJob = deps.runner ? createShellSessionJob() : undefined;
    this.gitRunner = deps.runner && this.gate(deps.runner, []);
    this.subscriptions = [
      deps.trust.onDidGrantTrust((folders) => this.rediscoverAround(folders.map((folder) => path.resolve(folder)), [])),
      deps.settings.onDidChange('damocles.desktop.git', (change) => {
        if (change.affects(SCM_SETTING_KEYS.untrackedChanges)) for (const entry of this.allRepos()) this.scheduleStatus(entry, 0);
        if (change.affects(SCM_SETTING_KEYS.repositoryScanMaxDepth) || change.affects(SCM_SETTING_KEYS.openRepositoryInParentFolders)) {
          for (const project of this.projects.values()) void this.discoverProject(project);
        }
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
    return entry ? { repoId, projectKey: entry.projectKey, status: entry.status, busy: entry.repo.queue.busy } : undefined;
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
      detail: t('Opening it adds "{0}" to safe.directory in your global git configuration, so git runs its configuration and hooks for you.', listed),
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
    this.scheduleStatus(entry, 0);
    return true;
  }

  async stageAll(repoId: string, scope: 'all' | 'tracked' | 'untracked' | 'merge'): Promise<boolean> {
    const entry = this.requireRepo(repoId);
    if (scope === 'merge' && !(await this.confirmUnresolved(entry, (entry.status?.groups.merge ?? []).map((change) => change.path)))) return false;
    await entry.repo.stageAll(scope, this.untrackedChanges());
    this.scheduleStatus(entry, 0);
    return true;
  }

  async unstage(repoId: string, paths: readonly string[] | 'all'): Promise<void> {
    const entry = this.requireRepo(repoId);
    await entry.repo.unstage(paths);
    this.scheduleStatus(entry, 0);
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
    this.scheduleStatus(entry, 0);
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
      this.scheduleStatus(entry, 0);
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
      this.scheduleStatus(entry, 0);
    }
  }

  /** Delete through git (git rm), repo-relative. */
  async remove(repoId: string, paths: readonly string[]): Promise<void> {
    const entry = this.requireRepo(repoId);
    try {
      await entry.repo.remove(paths);
    } finally {
      this.scheduleStatus(entry, 0);
    }
  }

  async abortOperation(repoId: string): Promise<void> {
    const entry = this.requireRepo(repoId);
    const operation = entry.status?.operation;
    if (!operation) return;
    await entry.repo.abort(operation);
    this.scheduleStatus(entry, 0);
  }

  async addToGitignore(repoId: string, paths: readonly string[]): Promise<string> {
    const entry = this.requireRepo(repoId);
    const file = await entry.repo.appendGitignore(paths);
    this.scheduleStatus(entry, 0);
    return file;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
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
    const staged = all && (changes === 'tracked' || this.untrackedChanges() !== 'mixed') ? 'tracked' : all ? 'all' : false;
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
      : t('Are you sure you want to stage {0} with merge conflicts?', path.basename(unresolved[0]!));
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
      ? t('\n\nAre you sure you want to discard changes in \'{0}\'?', path.basename(tracked[0]!.path))
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
    const one = changes.length === 1 ? path.basename(changes[0]!.path) : '';
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
    const action = this.platform() === 'win32' ? t('Move to Recycle Bin') : t('Move to Trash');
    if ((await this.deps.ask({ severity: 'danger', message, detail, actions: [action], cancelLabel: t('Cancel') })) !== 0) return false;
    await this.runDiscard(entry, changes);
    return true;
  }

  // Untracked files always go to the OS trash, so VS Code's discardUntrackedChangesToTrash wording applies, whose {1} is empty.
  private untrackedQuestion(changes: readonly Change[]): [string, string] {
    const t = this.deps.t;
    const message = changes.length === 1
      ? t('Are you sure you want to DELETE the following untracked file: \'{0}\'?', path.basename(changes[0]!.path))
      : t('Are you sure you want to DELETE the {0} untracked files?', changes.length);
    const windows = this.platform() === 'win32';
    const detail = changes.length === 1
      ? windows ? t('You can restore this file from the Recycle Bin.') : t('You can restore this file from the Trash.')
      : windows ? t('You can restore these files from the Recycle Bin.') : t('You can restore these files from the Trash.');
    return [message, detail];
  }

  // Where a tracked discard puts the working copies it replaces; none for a deletion or a submodule, which have none to trash.
  private trackedQuestionDetail(changes: readonly Change[]): string | undefined {
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
      this.scheduleStatus(entry, 0);
    }
    if (outcome.kind === 'changed') throw new Error(this.deps.t('The files changed after you confirmed, so nothing was discarded. Review the changes and try again.'));
    if (outcome.failed.length > 0) throw new Error(this.notTrashedMessage(outcome.failed));
  }

  private notTrashedMessage(failed: readonly DiscardFailure[]): string {
    const t = this.deps.t;
    const windows = this.platform() === 'win32';
    const reason = errorText(failed[0]!.error);
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
  // A call waits until every registered project's realpath has settled; the checks and the spawn then share one tick.
  private gate(runner: GitRunner, folders: readonly string[]): GitRunner {
    return {
      git: runner.git,
      envFor: (call) => runner.envFor(call),
      run: async (call) => {
        while (this.realpathPending()) await this.realpathsSettled(call.signal);
        const declined = this.declinedInside(call.cwd);
        const fenced = declined.length > 0 ? fence(call, declined) : call;
        if (!fenced || ![call.cwd, ...folders].every((folder) => this.mayRunIn(folder))) throw new GitUntrustedError();
        const ceiling = this.ceilingFor(call.cwd);
        return runner.run({ ...fenced, ...(ceiling !== undefined ? { ceilingDirectories: [ceiling] } : {}), ...(this.sessionJob ? { session: this.sessionJob } : {}) });
      },
    };
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
      ? await this.deps.ask({ severity: 'warning', message, preview: pending, actions, cancelLabel: t('Cancel') })
      : await this.deps.notify([message, ...pending].join('\n'), ...actions).then((answer) => (answer === undefined ? undefined : actions.indexOf(answer)));
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
    const repo = new Repository({ root: found.root, gitDir: found.gitDir, commonDir: found.commonDir, kind, project: project.path }, this.gate(this.deps.runner!, [found.gitDir, found.commonDir]));
    const entry: RepoEntry = { id: `repo-${++this.nextRepoId}`, projectKey: project.key, repo, kind, status: undefined, timer: undefined, disposables: [] };
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
  }

  private gitDirEvent(entry: RepoEntry, fsPath: string): void {
    const info = entry.repo.info;
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
      this.runStatus(entry);
    }, delayMs);
  }

  private runStatus(entry: RepoEntry): void {
    entry.repo.status(this.untrackedChanges()).then(
      (status) => {
        if (!this.isLive(entry)) return;
        entry.status = status;
        this.emit({ kind: 'repository', repoId: entry.id });
        this.emit({ kind: 'decorations', projectKey: entry.projectKey });
      },
      (err: unknown) => {
        if (!this.isLive(entry) || err instanceof GitQueueDisposedError || err instanceof GitUntrustedError) return;
        this.deps.log(`[scm] status failed: ${errorText(err)}`);
        const project = this.projects.get(entry.projectKey);
        if (project) this.scheduleRediscovery(project);
      },
    );
  }

  private isLive(entry: RepoEntry): boolean {
    const project = this.projects.get(entry.projectKey);
    return project !== undefined && !project.disposed && [...project.repos.values()].includes(entry);
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
    for (const dispose of entry.disposables.splice(0)) dispose();
    entry.repo.dispose();
    for (const [key, candidate] of project.repos) if (candidate === entry) project.repos.delete(key);
    this.emit({ kind: 'repository', repoId: entry.id });
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

// The project folder as registered and, when it exists, its realpath: repository roots and git's cwds are realpaths.
function rootsOf(project: ProjectEntry): string[] {
  const lexical = path.resolve(project.path);
  return project.real === undefined || samePath(project.real, lexical) ? [lexical] : [lexical, project.real];
}

// The engine's subcommands whose arguments after `--` are pathspecs; checkout-index and mv take plain paths.
const PATHSPEC_SUBCOMMANDS: ReadonlySet<string> = new Set(['status', 'diff', 'add', 'reset', 'rm', 'ls-files']);
// Subcommands that take no pathspec yet enter every gitlink, each with the setting that stops it (scm-trust.integration.test.ts).
// commit prints a full status when it has nothing to commit, and only that status reads diff.ignoreSubmodules; rebase
// --continue runs a child commit whose message template holds a status, which GIT_EDITOR=true means nobody reads.
const COARSE_SUBCOMMANDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['commit', ['-c', 'diff.ignoreSubmodules=all']],
  ['rebase', ['-c', 'commit.status=false']],
]);

/**
 * While an untrusted project lies inside the call's folder (declined, '/' paths relative to it), git enters none of it: a path
 * the call names at, inside or holding one is refused and so is submodule with no path; every pathspec call excludes each
 * declined path, so git never examines those entries and other submodules keep their changes; and every call runs with
 * submodule.recurse=false, since a user's submodule.recurse=true makes a work-tree write recurse into every gitlink; a
 * COARSE_SUBCOMMANDS call also gets its own setting. Undefined: refused.
 */
function fence(call: GitCall, declined: readonly string[]): GitCall | undefined {
  const subcommand = call.args[subcommandIndex(call.args)] ?? '';
  const separator = call.args.indexOf('--');
  const paths = separator < 0 ? [] : call.args.slice(separator + 1);
  // a submodule command with no path acts on every submodule
  if (subcommand === 'submodule' && (paths.length === 0 || paths.includes('.'))) return undefined;
  // folded on macOS too, whose volumes are case-insensitive by default; over-refusing on a case-sensitive one is harmless
  const folded = process.platform === 'win32' || process.platform === 'darwin';
  const key = (relative: string): string => (folded ? relative.toLowerCase() : relative);
  const within = (outer: string, inner: string): boolean => key(inner) === key(outer) || key(inner).startsWith(`${key(outer)}/`);
  if (paths.some((named) => named !== '.' && declined.some((root) => within(root, named) || within(named, root)))) return undefined;
  const fenced = { ...call, args: ['-c', 'submodule.recurse=false', ...(COARSE_SUBCOMMANDS.get(subcommand) ?? []), ...call.args] };
  // --no-index compares two files and takes no pathspec
  if (!PATHSPEC_SUBCOMMANDS.has(subcommand) || call.args.includes('--no-index')) return fenced;
  // exclude magic needs pathspec magic on, so each named path keeps its literal meaning through :(literal) instead
  const { literalPathspecs: _literal, ...rest } = fenced;
  const magic = folded ? 'exclude,literal,icase' : 'exclude,literal';
  const named = paths.map((entry) => (entry === '.' ? entry : `:(literal)${entry}`));
  const head = separator < 0 ? [...rest.args, '--'] : rest.args.slice(0, rest.args.indexOf('--') + 1);
  return { ...rest, args: [...head, ...named, ...declined.map((root) => `:(${magic})${root}`)] };
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

