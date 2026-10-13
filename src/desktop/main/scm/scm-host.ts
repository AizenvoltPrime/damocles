// Source control in main (plan AD4, "Who does what"): the damocles:scm:* requests, the user flows keyed by op, the selected
// repository per project, the pushes to the shell, the editor tabs and the palette's entry points.
import * as path from 'node:path';
import type { SettingsStore } from '../../../platform/settings-store';
import { UNREACHABLE, type StructuredCompletionRequest, type StructuredCompletionResult } from '../../../core/pi-session/structured-completion';
import { generateCommitMessage, type CommitMessageComplete } from '../../../core/scm/commit-message';
import { isInside, samePath } from '../../../core/scm/discovery';
import { redactUrls, GitError } from '../../../core/scm/git-runner';
import type { Change, ChangeGroup, Repository } from '../../../core/scm/repository';
import type { ProjectView, ScmService } from '../../../core/scm/scm-service';
import { SCM_SETTING_KEYS, type PromptToSaveFilesBeforeCommit } from '../../../core/scm/settings-keys';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { inputProblem } from '../../../shared/input-validation';
import type { FileRef } from '../../preload/shell-channels';
import {
  parseScmAmend,
  parseScmCommit,
  parseScmCopy,
  parseScmFileDiff,
  parseScmRepoRef,
  parseScmRun,
  parseScmSelect,
  type ScmChangesTab,
  type ScmCommitInput,
  type ScmCommitResult,
  type ScmCommitVariant,
  type ScmDecorations,
  type ScmFileDiffResult,
  type ScmGenerateResult,
  type ScmOp,
  type ScmOperation,
  type ScmRepoSnapshot,
  type ScmRunRequest,
  type ScmRunResult,
  type ScmSetInput,
  type ScmSettings,
  type ScmShellCommand,
  type ScmShellState,
  type ScmView,
  type SCM_DISCARD_ALL_SCOPES,
  type SCM_STAGE_ALL_SCOPES,
} from '../../preload/scm-channels';
import { isDesktopSettingValue } from '../desktop-configuration';
import type { Project } from '../documents/confine';
import type { EditorPane, NotShownSide } from '../editor-pane';
import type { AskMessage } from '../message-dialog';
import type { AskInput } from '../overlay';
import { decodeDocument } from '../platform/editor-document';

export interface ScmQuickPickItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface ScmHostDeps {
  readonly service: ScmService;
  readonly settings: SettingsStore;
  readonly projects: () => readonly Project[];
  // the selected project, whose selected repository the palette and the menu act on
  readonly selectedProjectKey: () => string | undefined;
  readonly editorPane: EditorPane;
  // each project's selected repository root, persisted in window-layout.json (AD8)
  readonly selection: { get(projectKey: string): string | undefined; set(projectKey: string, root: string): void };
  readonly notify: {
    info(message: string, ...actions: string[]): Promise<string | undefined>;
    warn(message: string, ...actions: string[]): Promise<string | undefined>;
    error(message: string, ...actions: string[]): Promise<string | undefined>;
  };
  readonly t: (message: string, ...args: Array<string | number>) => string;
  readonly showGitLog: () => void;
  readonly copy: (text: string) => Promise<void>;
  readonly reveal: (absolutePath: string) => Promise<void>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly pickFolder: (defaultPath: string) => Promise<string | undefined>;
  readonly quickPick: (placeholder: string, items: readonly ScmQuickPickItem[]) => Promise<string | undefined>;
  // a question main's own flows ask (the save-before-commit prompt): the overlay dialog (D41)
  readonly ask: AskMessage;
  // the overlay QuickInput; undefined for Escape, or when it could not show (its asker told the user)
  readonly askInput: AskInput;
  readonly mention: (target: FileRef | { readonly path: string }) => Promise<void>;
  readonly complete: CommitMessageComplete;
  readonly send: {
    view(view: ScmView): void;
    state(snapshot: ScmRepoSnapshot): void;
    decorations(decorations: ScmDecorations): void;
    settings(settings: ScmSettings): void;
    command(command: ScmShellCommand): void;
    setInput(input: ScmSetInput): void;
    // the Files tree lists the project's shown folders again, so their ignored flags follow git
    filesChanged(projectKey: string): void;
  };
  // MenuState's scm fields changed
  readonly menuChanged: () => void;
  readonly log: (line: string) => void;
  // a line of the Git log
  readonly gitLog: (line: string) => void;
  readonly platform: NodeJS.Platform;
}

export type ScmPaletteRequest =
  | { readonly op: 'init' | 'openRepository' | 'reopenClosed' | 'openParentRepositories' | 'manageUnsafeRepositories' }
  | { readonly op: 'showOutput' | 'closeAllUnmodifiedEditors' }
  | { readonly op: 'openAllChanges' | 'closeAllDiffEditors' }
  | { readonly op: 'closeRepository' | 'closeOtherRepositories' | 'refresh' | 'unstageAll' | 'abortOperation' | 'undoLastCommit' }
  | { readonly op: 'stageAll'; readonly scope: (typeof SCM_STAGE_ALL_SCOPES)[number] }
  | { readonly op: 'discardAll'; readonly scope: (typeof SCM_DISCARD_ALL_SCOPES)[number] }
  | { readonly op: 'openGroupChanges'; readonly group: ChangeGroup };
export type ScmActiveFileOp = 'stage' | 'unstage' | 'discard' | 'openChanges' | 'openFile' | 'openFileHead' | 'addToGitignore' | 'rename' | 'delete';

export interface ScmMenuState {
  // git was found and the selected project is trusted (VS Code's config.git.enabled && !git.missing)
  readonly available: boolean;
  // repositories open in the selected project (VS Code's gitOpenRepositoryCount)
  readonly openRepositoryCount: number;
  readonly closedRepositoryCount: number;
  // the selected repository's operation in progress
  readonly operation: ScmOperation | null;
  readonly unsafeRepositoryCount: number;
  readonly parentRepositoryCount: number;
  readonly untrackedChanges: ScmSettings['untrackedChanges'];
  // the active editor's file has changes in an open repository (VS Code's scmActiveResourceHasChanges)
  readonly activeFileHasChanges: boolean;
  // the active editor's file lies in an open repository (scmActiveResourceRepository)
  readonly activeFileInRepository: boolean;
  // the active editor shows a file on disk (resourceScheme == file)
  readonly activeEditorFile: boolean;
  // config.git.allowNoVerifyCommit: the No Verify commit commands are listed
  readonly allowNoVerifyCommit: boolean;
  // the selected repository's commit box is in amend mode, so every commit command amends
  readonly amending: boolean;
}

// Before startup finished: nothing open.
export const NO_SCM_MENU_STATE: ScmMenuState = {
  available: false,
  openRepositoryCount: 0,
  closedRepositoryCount: 0,
  operation: null,
  unsafeRepositoryCount: 0,
  parentRepositoryCount: 0,
  untrackedChanges: 'mixed',
  activeFileHasChanges: false,
  activeFileInRepository: false,
  activeEditorFile: false,
  allowNoVerifyCommit: false,
  amending: false,
};

type Flow<K extends ScmOp> = (host: ScmHost, request: Extract<ScmRunRequest, { op: K }>) => Promise<ScmRunResult>;
type FlowRegistry = { readonly [K in ScmOp]: Flow<K> };

const OK: ScmRunResult = { ok: true };
const SCM_GROUP_NAMES: readonly ChangeGroup[] = ['merge', 'index', 'workingTree', 'untracked'];
const CANCELLED: ScmRunResult = { ok: false, reason: 'cancelled' };

const GIT_DOWNLOAD: Readonly<Partial<Record<NodeJS.Platform, string>>> = { win32: 'https://git-scm.com/download/win', darwin: 'https://git-scm.com/download/mac' };

// The user flows, one per op.
const FLOWS: FlowRegistry = {
  init: async (host, request) => {
    await host.deps.service.init(request.projectKey);
    return OK;
  },
  openRepository: (host, request) => host.openRepository(request.projectKey),
  reopenClosed: (host, request) => host.reopenClosed(request.projectKey),
  openParentRepositories: async (host, request) => {
    await host.deps.service.openParents(request.projectKey);
    return OK;
  },
  manageUnsafeRepositories: (host, request) => host.manageUnsafe(request.projectKey),
  showOutput: async (host) => {
    host.deps.showGitLog();
    return OK;
  },
  openGitDownload: async (host) => {
    await host.deps.openExternal(GIT_DOWNLOAD[host.deps.platform] ?? 'https://git-scm.com/download/linux');
    return OK;
  },
  closeRepository: async (host, request) => {
    await host.deps.service.close([request.repoId]);
    return OK;
  },
  closeOtherRepositories: async (host, request) => {
    const others = host.projectOfRepo(request.repoId)?.repos.filter((repo) => repo.repoId !== request.repoId).map((repo) => repo.repoId) ?? [];
    await host.deps.service.close(others);
    return OK;
  },
  refresh: async (host, request) => {
    host.deps.service.refresh(request.repoId);
    return OK;
  },
  stage: async (host, request) => ((await host.deps.service.stage(request.repoId, request.paths)) ? OK : CANCELLED),
  unstage: async (host, request) => {
    await host.deps.service.unstage(request.repoId, request.paths);
    return OK;
  },
  discard: async (host, request) => ((await host.deps.service.discard(request.repoId, request.paths)) ? OK : CANCELLED),
  stageAll: async (host, request) => ((await host.deps.service.stageAll(request.repoId, request.scope)) ? OK : CANCELLED),
  unstageAll: async (host, request) => {
    await host.deps.service.unstage(request.repoId, 'all');
    return OK;
  },
  discardAll: async (host, request) => ((await host.deps.service.discardAll(request.repoId, request.scope)) ? OK : CANCELLED),
  abortOperation: async (host, request) => {
    await host.deps.service.abortOperation(request.repoId);
    return OK;
  },
  addToGitignore: async (host, request) => {
    const file = await host.deps.service.addToGitignore(request.repoId, request.paths);
    await host.openAbsolute(file);
    return OK;
  },
  reveal: async (host, request) => {
    await host.deps.reveal(await host.repo(request.repoId).confinedEntry(request.path));
    return OK;
  },
  mention: async (host, request) => {
    const absolute = await host.repo(request.repoId).confinedEntry(request.path);
    await host.deps.mention(host.fileRefOf(absolute) ?? { path: absolute });
    return OK;
  },
  openChanges: (host, request) => host.openChanges(request.repoId, request.path, request.group),
  openFile: async (host, request) => {
    await host.openAbsolute(await host.repo(request.repoId).confinedEntry(request.path));
    return OK;
  },
  openFileHead: (host, request) => host.openFileHead(request.repoId, request.path),
  openGroupChanges: (host, request) => host.openGroupChanges(request.repoId, request.group),
  undoLastCommit: (host, request) => host.undoLastCommit(request.repoId),
  restoreCommitTemplate: async (host, request) => {
    const template = await host.repo(request.repoId).commitTemplate();
    host.deps.send.setInput({ repoId: request.repoId, message: template ?? '', cause: 'template' });
    return OK;
  },
};

function errorText(err: unknown): string {
  if (err instanceof GitError) return redactUrls(err.stderr.trim().split('\n').find((line) => line.trim() !== '') ?? err.message);
  return err instanceof Error ? err.message : String(err);
}

// A deleted change's folder may be gone, so its lexical path under the root names it; never opened, only shown or copied.
async function entryOrLexical(repo: Repository, relativePath: string): Promise<string> {
  try {
    return await repo.confinedEntry(relativePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
    return path.join(repo.root, ...relativePath.split('/'));
  }
}

// What a structured sub-call needs of PiRuntime.
export interface SubCallRuntime {
  folder(cwd: string): Promise<unknown>;
  syncCustomProviders(getSecret: (key: string) => PromiseLike<string | undefined>): Promise<unknown>;
  runStructuredCompletion<T>(request: StructuredCompletionRequest): Promise<StructuredCompletionResult<T>>;
}

/**
 * Generate commit message's sub-call, with the runtime prepared as a chat's start prepares it: the project's folder runtime,
 * whose provider registrations the Background model resolves against, and the key-backed providers. runtime creates the
 * runtime when no chat has, and answers null once shutdown retired it.
 */
export function backgroundCompletion(runtime: () => SubCallRuntime | null, getSecret: (key: string) => PromiseLike<string | undefined>, log: (line: string) => void): CommitMessageComplete {
  return async (request) => {
    const live = runtime();
    const cwd = request.attribution?.cwd;
    if (!live || cwd === undefined) return UNREACHABLE;
    try {
      await live.folder(cwd);
      await live.syncCustomProviders(getSecret);
    } catch (err) {
      log(`[scm] the model runtime could not start: ${err instanceof Error ? err.message : String(err)}`);
      return UNREACHABLE;
    }
    return live.runStructuredCompletion<{ message?: unknown }>(request);
  };
}

export class ScmHost {
  readonly deps: ScmHostDeps;
  private readonly pending = { views: new Set<string>(), repos: new Set<string>(), decorations: new Set<string>(), ignores: new Set<string>() };
  private flushScheduled = false;
  private postCommitNoted = false;
  private disposed = false;
  // the repository whose commit box amends, from the shell's last report; cleared wherever the box leaves amend mode
  private amendingRepoId: string | undefined;
  private readonly subscriptions: Array<{ dispose(): void }>;

  constructor(deps: ScmHostDeps) {
    this.deps = deps;
    this.subscriptions = [
      deps.service.onDidChange((event) => {
        if (event.kind === 'view') this.pending.views.add(event.projectKey);
        else if (event.kind === 'repository') this.pending.repos.add(event.repoId);
        else if (event.kind === 'ignores') this.pending.ignores.add(event.projectKey);
        else this.pending.decorations.add(event.projectKey);
        this.scheduleFlush();
      }),
      deps.settings.onDidChange('damocles.desktop.git', () => {
        deps.send.settings(this.settings());
        deps.menuChanged();
      }),
      deps.editorPane.onDidChangeActiveContext(() => deps.menuChanged()),
    ];
  }

  setProjects(projects: readonly Project[]): void {
    this.deps.service.setProjects(projects.map((project) => ({ key: project.key, path: project.fsPath })));
  }

  state(): ScmShellState {
    const views = this.deps.service.projectKeys().flatMap((key) => {
      const view = this.view(key);
      return view ? [view] : [];
    });
    const snapshots = views.flatMap((view) => view.repos.flatMap((repo) => {
      const snapshot = this.snapshot(repo.repoId);
      return snapshot ? [snapshot] : [];
    }));
    return { views, snapshots, decorations: views.map((view) => this.decorations(view.projectKey)), settings: this.settings() };
  }

  /** Selects a repository; the view naming it follows through the coalesced flush, after this returns. */
  select(raw: unknown): void {
    const request = parseScmSelect(raw);
    if (!request) throw new Error('Malformed source control selection from the shell');
    const view = this.deps.service.view(request.projectKey);
    const repo = view?.repos.find((candidate) => candidate.repoId === request.repoId);
    // closed or removed since the shell's last view, which the next view corrects
    if (!view || !repo) return;
    if (this.amendingRepoId !== repo.repoId) this.amendingRepoId = undefined;
    this.deps.selection.set(request.projectKey, repo.root);
    this.pending.views.add(request.projectKey);
    this.scheduleFlush();
    this.deps.menuChanged();
  }

  /** The shell's amend mode for its selected repository; a repository main no longer has is answered and dropped. */
  amend(raw: unknown): void {
    const report = parseScmAmend(raw);
    if (!report) throw new Error('Malformed amend report from the shell');
    if (!this.deps.service.repository(report.repoId)) return;
    this.setAmending(report.amending ? report.repoId : undefined);
  }

  async run(raw: unknown): Promise<ScmRunResult> {
    const request = parseScmRun(raw);
    if (!request) throw new Error('Malformed source control request from the shell');
    return this.runRequest(request);
  }

  async runRequest(request: ScmRunRequest): Promise<ScmRunResult> {
    if ('repoId' in request && !this.deps.service.repository(request.repoId)) return { ok: false, reason: 'unknown' };
    if ('projectKey' in request && !this.deps.service.view(request.projectKey)) return { ok: false, reason: 'unknown' };
    const flow = FLOWS[request.op] as Flow<typeof request.op>;
    try {
      return await flow(this, request as never);
    } catch (err) {
      this.deps.log(`[scm] ${request.op} failed: ${err instanceof Error ? err.message : String(err)}`);
      this.failed(errorText(err));
      return { ok: false, reason: 'failed' };
    }
  }

  /**
   * A commit (VS Code's smartCommit): the save-before-commit prompt here, then core's questions and the protected branch's name
   * input, the commit, the box's new text and the post-commit command. The reasons the shell shows inline get no notice;
   * failed gets one with Show Git Output.
   */
  async commit(raw: unknown): Promise<ScmCommitResult> {
    const request = parseScmCommit(raw);
    if (!request) throw new Error('Malformed commit from the shell');
    const target = this.deps.service.repository(request.repoId);
    if (!target) return { ok: false, reason: 'unknown' };
    try {
      // Commit Empty skips the save prompt, as VS Code's empty option does
      const saved = request.variant.empty ? [] : await this.saveBeforeCommit(request.repoId, target.repo.root);
      if (saved === undefined) return { ok: false, reason: 'cancelled' };
      const outcome = await this.deps.service.commit(request.repoId, request.message, request.variant, { saved, branchName: () => this.askBranchName() });
      if (!outcome.ok) {
        if (outcome.reason === 'failed') this.failed(errorText(outcome.error));
        return { ok: false, reason: outcome.reason };
      }
      this.leaveAmend(request.repoId);
      const commitInput = await this.freshCommitInput(request.repoId);
      this.runPostCommitCommand();
      return { ok: true, message: commitInput?.template ?? '', ...(commitInput ? { commitInput } : {}) };
    } catch (err) {
      this.deps.log(`[scm] commit failed: ${err instanceof Error ? err.message : String(err)}`);
      this.failed(errorText(err));
      return { ok: false, reason: 'failed' };
    }
  }

  /** The commit box's template, history and HEAD message; empty for an id main no longer knows. */
  async commitInput(raw: unknown): Promise<ScmCommitInput> {
    const request = parseScmRepoRef(raw);
    if (!request) throw new Error('Malformed request from the shell');
    if (!this.deps.service.repository(request.repoId)) return { template: null, history: [], headMessage: null };
    return this.deps.service.commitInput(request.repoId);
  }

  async generateMessage(raw: unknown): Promise<ScmGenerateResult> {
    const request = parseScmRepoRef(raw);
    if (!request) throw new Error('Malformed request from the shell');
    const target = this.deps.service.repository(request.repoId);
    if (!target) return { ok: false };
    const t = this.deps.t;
    const result = await generateCommitMessage(target.repo, this.deps.complete, target.projectPath).catch((err: unknown) => {
      this.deps.log(`[scm] generating a commit message failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false as const, reason: 'failed' as const };
    });
    if (result.ok) return result;
    const reasons: Record<typeof result.reason, string> = {
      noChanges: t('There are no changes to describe.'),
      unreachable: t('No model could be reached. Check the Background model in Settings.'),
      credential: t('The Background model\'s provider refused the sign-in. Sign in again in Settings › Models & accounts.'),
      forbidden: t('The Background model\'s provider refused access.'),
      rejected: t('The model refused the request.'),
      unanswered: t('The model gave no usable message.'),
      failed: t('Git could not read the changes.'),
    };
    void this.deps.notify.warn(`${t('Couldn\'t generate a commit message')}. ${reasons[result.reason]}`);
    return { ok: false };
  }

  async fileDiff(raw: unknown): Promise<ScmFileDiffResult> {
    const request = parseScmFileDiff(raw);
    if (!request) throw new Error('Malformed diff request from the shell');
    const repo = this.deps.service.repository(request.repoId)?.repo;
    return repo ? repo.diff(request.source.kind, request.path) : { kind: 'missing' };
  }

  /** Copies a path of a change; nothing for a repository main no longer has. */
  async copy(raw: unknown): Promise<void> {
    const request = parseScmCopy(raw);
    if (!request) throw new Error('Malformed copy from the shell');
    const repo = this.deps.service.repository(request.repoId)?.repo;
    if (!repo) return;
    // only a path of the repository's own status, so the text is main's data and never a renderer's
    const groups = repo.lastStatus?.groups;
    const known = groups !== undefined && SCM_GROUP_NAMES.some((group) => groups[group].some((change) => change.path === request.value || change.originalPath === request.value));
    // eslint-disable-next-line no-control-regex
    if (!known || /[\u0000-\u001f\u007f]/.test(request.value)) throw new Error('Copy names a path that is not a change of the repository');
    const absolute = await entryOrLexical(repo, request.value);
    const ref = this.fileRefOf(absolute);
    const relative = ref ? ref.relativePath : request.value;
    await this.deps.copy(request.kind === 'path' ? absolute : relative.split('/').join(path.sep));
  }

  /** The Files tree's ignored entries for one listed folder. */
  ignored(projectKey: string, relativeDir: string, entries: ReadonlyArray<{ readonly name: string; readonly kind: 'file' | 'dir' }>): Promise<ReadonlySet<string>> {
    return this.deps.service.ignoredIn(projectKey, relativeDir, entries.map((entry) => ({ name: entry.name, dir: entry.kind === 'dir' })));
  }

  menuState(): ScmMenuState {
    const view = this.selectedView();
    const selected = view?.selectedRepoId ?? null;
    const active = this.activeResource();
    return {
      available: view !== undefined && view.state !== 'untrusted' && view.state !== 'gitMissing',
      openRepositoryCount: view?.repos.length ?? 0,
      closedRepositoryCount: view?.closedCount ?? 0,
      operation: selected ? (this.snapshot(selected)?.operation ?? null) : null,
      unsafeRepositoryCount: view?.unsafePaths.length ?? 0,
      parentRepositoryCount: view?.parentCount ?? 0,
      untrackedChanges: this.settings().untrackedChanges,
      activeFileHasChanges: active?.group !== undefined,
      activeFileInRepository: active !== undefined,
      activeEditorFile: this.deps.editorPane.activeContext()?.filePath !== undefined,
      allowNoVerifyCommit: this.settings().allowNoVerifyCommit,
      amending: selected !== null && this.amendingRepoId === selected && this.deps.service.repository(selected) !== undefined,
    };
  }

  /**
   * A palette command on the selected project's selected repository, or its project. One that needs a repository while none
   * is open gets VS Code's error, as its pickRepository gives.
   */
  paletteRun(request: ScmPaletteRequest): void {
    switch (request.op) {
      case 'showOutput':
        void this.runRequest({ op: request.op });
        return;
      case 'closeAllUnmodifiedEditors':
        void this.guarded(request.op, () => this.closeAllUnmodified());
        return;
      case 'init':
      case 'openRepository':
      case 'reopenClosed':
      case 'openParentRepositories':
      case 'manageUnsafeRepositories': {
        const projectKey = this.deps.selectedProjectKey();
        if (projectKey !== undefined) void this.runRequest({ op: request.op, projectKey });
        return;
      }
    }
    const repoId = this.selectedView()?.selectedRepoId ?? undefined;
    if (repoId === undefined) {
      void this.deps.notify.error(this.deps.t('There are no available repositories'));
      return;
    }
    switch (request.op) {
      case 'openAllChanges':
        void this.guarded(request.op, () => this.openAllChanges(repoId));
        return;
      case 'closeAllDiffEditors':
        void this.guarded(request.op, () => this.deps.editorPane.closeScmDiffs(this.repo(repoId).root));
        return;
      default:
        void this.runRequest({ ...request, repoId });
    }
  }

  /** A commit command from the palette: the shell holds the drafts, so it commits the selected repository's with the variant. */
  paletteCommit(variant: ScmCommitVariant): void {
    const repoId = this.selectedView()?.selectedRepoId;
    if (repoId) this.deps.send.command({ command: 'commit', repoId, variant });
  }

  /** Stage, Unstage, Discard, Open Changes, Open File, Open File (HEAD), Add to .gitignore, Rename and Delete on the active editor's file. */
  activeFile(op: ScmActiveFileOp): void {
    const active = this.activeResource();
    if (!active) return;
    const { repoId, relativePath, group } = active;
    if (op === 'rename' || op === 'delete') {
      void this.guarded(op, () => (op === 'rename' ? this.rename(repoId, relativePath) : this.delete(repoId, relativePath, group !== undefined)));
      return;
    }
    const request: ScmRunRequest | undefined =
      op === 'stage' || op === 'unstage' || op === 'discard' || op === 'addToGitignore'
        ? { op, repoId, paths: [relativePath] }
        : op === 'openChanges'
          ? group === undefined ? undefined : { op, repoId, path: relativePath, group }
          : { op, repoId, path: relativePath };
    if (request) void this.runRequest(request);
  }

  /** A code tab's Open Changes. */
  async openChangesOf(absolutePath: string): Promise<void> {
    const found = this.resourceAt(absolutePath);
    if (found?.group === undefined) return;
    await this.runRequest({ op: 'openChanges', repoId: found.repoId, path: found.relativePath, group: found.group });
  }

  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  // flows

  // VS Code's undoCommit: the undone commit's message goes back in the box.
  async undoLastCommit(repoId: string): Promise<ScmRunResult> {
    const outcome = await this.deps.service.undoLastCommit(repoId);
    if (outcome.kind === 'noCommit') {
      void this.deps.notify.warn(this.deps.t('Can\'t undo because HEAD doesn\'t point to any commit.'));
      return OK;
    }
    if (outcome.kind === 'cancelled') return CANCELLED;
    this.leaveAmend(repoId);
    const commitInput = await this.freshCommitInput(repoId);
    this.deps.send.setInput({ repoId, message: outcome.message, cause: 'undo', ...(commitInput ? { commitInput } : {}) });
    return OK;
  }

  // Read after the change landed, which already happened: a failed read is logged and the shell reads the input again.
  private freshCommitInput(repoId: string): Promise<ScmCommitInput | undefined> {
    return this.deps.service.commitInput(repoId).catch((err: unknown) => {
      this.deps.log(`[scm] reading the commit input after a commit or undo failed: ${errorText(err)}`);
      return undefined;
    });
  }

  // VS Code's git.rename on the active file: git mv, then its tabs follow it as a Files rename's do, keeping unsaved edits; a
  // file outside every project closes and opens again at its new path, as VS Code's command does.
  async rename(repoId: string, from: string): Promise<void> {
    const t = this.deps.t;
    const answer = await this.deps.askInput({
      title: t('Rename'),
      prompt: t('Press \'Enter\' to confirm your input or \'Escape\' to cancel'),
      value: from,
      valueSelection: [from.length - path.posix.basename(from).length, from.length],
      validation: 'path',
    });
    const to = answer?.trim();
    if (!to || to === from) return;
    // the answer passed validation before the trim, and core refuses a Windows-unsafe name with a generic failure
    if (inputProblem('path', to, { windows: this.deps.platform === 'win32' }) !== undefined) {
      void this.deps.notify.warn(t('{0} is not a valid file or folder name.', to));
      return;
    }
    const repo = this.repo(repoId);
    const source = this.fileRefOf(path.join(repo.root, ...from.split('/')));
    const target = this.fileRefOf(path.join(repo.root, ...to.split('/')));
    if (source && target && source.projectKey === target.projectKey) {
      await this.deps.editorPane.fileRenamed(source.projectKey, source.relativePath, async () => {
        await this.deps.service.move(repoId, from, to);
        return { ok: true, relativePath: target.relativePath };
      });
      return;
    }
    await this.deps.service.move(repoId, from, to);
    await this.deps.editorPane.closeActive({ cleanOnly: false });
    await this.openAbsolute(await repo.confinedEntry(to));
  }

  // VS Code's git.delete: a file with uncommitted changes is refused; otherwise git rm, and its tab closes unless it is dirty.
  async delete(repoId: string, relativePath: string, changed: boolean): Promise<void> {
    if (changed) {
      void this.deps.notify.info(this.deps.t('Git: Delete can only be performed on committed files without uncommitted changes.'));
      return;
    }
    const absolute = path.join(this.repo(repoId).root, ...relativePath.split('/'));
    await this.deps.service.remove(repoId, [relativePath]);
    const active = this.deps.editorPane.activeContext()?.filePath;
    if (active !== undefined && folderKey(active) === folderKey(absolute)) await this.deps.editorPane.closeActive({ cleanOnly: true });
  }

  // VS Code's git.openAllChanges: every working tree and untracked change that still exists, opened without taking the active tab.
  async openAllChanges(repoId: string): Promise<void> {
    const repo = this.repo(repoId);
    const groups = repo.lastStatus?.groups;
    const gone: ReadonlySet<string> = new Set(['DELETED', 'DELETED_BY_THEM', 'DELETED_BY_US', 'BOTH_DELETED']);
    const files: string[] = [];
    for (const change of [...(groups?.workingTree ?? []), ...(groups?.untracked ?? [])]) {
      if (!gone.has(change.status) && !change.submodule) files.push(await repo.confinedEntry(change.path));
    }
    await this.deps.editorPane.openInBackground(files);
  }

  // VS Code's git.closeAllUnmodifiedEditors: a clean text tab closes unless its file has a change in any open repository.
  async closeAllUnmodified(): Promise<void> {
    const changed = new Set<string>();
    for (const projectKey of this.deps.service.projectKeys()) {
      for (const { repoId } of this.deps.service.view(projectKey)?.repos ?? []) {
        const repo = this.deps.service.repository(repoId)?.repo;
        for (const group of SCM_GROUP_NAMES) for (const change of repo?.lastStatus?.groups[group] ?? []) changed.add(folderKey(path.join(repo!.root, ...change.path.split('/'))));
      }
    }
    await this.deps.editorPane.closeUnmodified((absolute) => changed.has(folderKey(absolute)));
  }

  async openRepository(projectKey: string): Promise<ScmRunResult> {
    const project = this.deps.projects().find((candidate) => candidate.key === projectKey);
    if (!project) return { ok: false, reason: 'unknown' };
    const folder = await this.deps.pickFolder(project.fsPath);
    if (folder === undefined) return CANCELLED;
    const t = this.deps.t;
    const outcome = await this.deps.service.openFolder(projectKey, folder);
    if (outcome === 'outside') void this.deps.notify.warn(t('Open Repository opens a repository inside the project folder only.'));
    else if (outcome === 'notRepository') void this.deps.notify.warn(t('There is no Git repository in that folder.'));
    return outcome === 'opened' || outcome === 'parent' || outcome === 'unsafe' ? OK : CANCELLED;
  }

  async reopenClosed(projectKey: string): Promise<ScmRunResult> {
    const closed = this.deps.service.view(projectKey)?.closedRoots ?? [];
    if (closed.length === 0) return OK;
    const picked = await this.deps.quickPick(this.deps.t('Pick a repository to reopen'), closed.map((root) => ({ id: root, label: path.basename(root), description: root })));
    if (picked === undefined) return CANCELLED;
    const root = closed.find((candidate) => candidate === picked);
    if (root === undefined) return CANCELLED;
    await this.deps.service.reopen(projectKey, [root]);
    return OK;
  }

  async manageUnsafe(projectKey: string): Promise<ScmRunResult> {
    const unsafe = this.deps.service.view(projectKey)?.unsafe ?? [];
    if (unsafe.length === 0) return OK;
    const picked = unsafe.length === 1
      ? unsafe[0]
      : await this.deps.quickPick(this.deps.t('Pick a repository to mark as safe and open'), unsafe.map((root) => ({ id: root, label: path.basename(root), description: root })));
    const chosen = unsafe.find((candidate) => candidate === picked);
    if (chosen === undefined) return CANCELLED;
    return (await this.deps.service.trustUnsafe(projectKey, chosen)) ? OK : CANCELLED;
  }

  // VS Code's resolveChangeCommand: a diff of its left and right sides, or the one side when there is no left (added,
  // untracked, deleted); a conflicted file opens itself.
  async openChanges(repoId: string, relativePath: string, group: ChangeGroup): Promise<ScmRunResult> {
    const repo = this.repo(repoId);
    const change = repo.lastStatus?.groups[group].find((candidate) => candidate.path === relativePath);
    if (!change) return OK;
    const name = path.basename(change.path);
    if (group === 'merge') {
      await this.openAbsolute(await repo.confinedEntry(change.path));
      return OK;
    }
    const title = (fileName: string): string => titleOf(change.status, fileName, this.deps.t);
    switch (change.status) {
      case 'INDEX_MODIFIED':
      case 'INDEX_RENAMED':
      case 'TYPE_CHANGED': {
        const left = await this.gitSide(repo, 'HEAD', change.originalPath ?? change.path, name);
        if (group !== 'index') {
          const absolute = await repo.confinedEntry(change.path);
          await this.diff(repoId, repo.root, title, absolute, left, { path: absolute });
          return OK;
        }
        const right = await this.gitSide(repo, 'index', change.path, name);
        await this.diff(repoId, repo.root, title, await entryOrLexical(repo, change.path), left, right);
        return OK;
      }
      case 'MODIFIED': {
        const absolute = await repo.confinedEntry(change.path);
        const left = await this.gitSide(repo, 'index', change.path, name);
        await this.diff(repoId, repo.root, title, absolute, left, { path: absolute });
        return OK;
      }
      case 'INDEX_ADDED':
      case 'INDEX_COPIED':
        this.openSide(title(name), await this.gitSide(repo, 'index', change.path, name));
        return OK;
      case 'INDEX_DELETED':
      case 'DELETED':
        this.openSide(title(name), await this.gitSide(repo, 'HEAD', change.path, name));
        return OK;
      default:
        await this.openAbsolute(await repo.confinedEntry(change.path));
        return OK;
    }
  }

  async openFileHead(repoId: string, relativePath: string): Promise<ScmRunResult> {
    const repo = this.repo(repoId);
    const change = [...(repo.lastStatus?.groups.index ?? []), ...(repo.lastStatus?.groups.workingTree ?? [])].find((candidate) => candidate.path === relativePath);
    const name = path.basename(relativePath);
    this.openSide(this.deps.t('{0} (HEAD)', name), await this.gitSide(repo, 'HEAD', change?.originalPath ?? relativePath, name));
    return OK;
  }

  // VS Code's git.viewChanges family: one multi-file diff tab per repository and group, titled "<repository>: <group>".
  async openGroupChanges(repoId: string, group: ChangeGroup): Promise<ScmRunResult> {
    const target = this.deps.service.repository(repoId);
    if (!target) return { ok: false, reason: 'unknown' };
    const entries = target.repo.lastStatus?.groups[group] ?? [];
    const t = this.deps.t;
    if (entries.length === 0) {
      const empty = group === 'index' ? t('The repository does not have any staged changes.') : group === 'untracked' ? t('The repository does not have any untracked changes.') : t('The repository does not have any changes.');
      void this.deps.notify.info(empty);
      return OK;
    }
    this.deps.editorPane.showChanges({ title: this.changesTitle(target.repo, group), changes: { repoId, source: { kind: group }, entries: entries.map(toScmChange) } }, { focus: true });
    return OK;
  }

  repo(repoId: string): Repository {
    const target = this.deps.service.repository(repoId);
    if (!target) throw new Error('Unknown repository');
    return target.repo;
  }

  projectOfRepo(repoId: string): ScmView | undefined {
    const projectKey = this.deps.service.repository(repoId)?.projectKey;
    return projectKey === undefined ? undefined : this.view(projectKey);
  }

  fileRefOf(absolute: string): FileRef | undefined {
    for (const project of this.deps.projects()) {
      for (const folder of this.projectFolders(project)) {
        if (!isInside(folder, absolute)) continue;
        const relative = path.relative(folder, absolute).split(path.sep).join('/');
        if (relative !== '') return { projectKey: project.key, relativePath: relative };
      }
    }
    return undefined;
  }

  // A file inside a project opens editable through the document service; a parent repository's file outside every project
  // opens read-only as a core-originated document (AD5).
  async openAbsolute(absolute: string): Promise<void> {
    const ref = this.fileRefOf(absolute);
    if (ref) {
      const opened = await this.deps.editorPane.openFromUser(ref.projectKey, ref.relativePath);
      if (!opened.ok) throw new Error(`The file could not be opened (${opened.reason})`);
      return;
    }
    await this.deps.editorPane.openPath(absolute, { focus: true });
  }

  private async diff(repoId: string, root: string, title: (fileName: string) => string, absolute: string, left: GitSide, right: GitSide | { path: string }): Promise<void> {
    await this.deps.editorPane.showDiff(title, absolute, left, right, { focus: true, scm: { root, repoId } });
  }

  // A git side as text, or the placeholder of one absent there, past MAX_SHOW_BYTES or binary, whose bytes stay in main.
  private async gitSide(repo: Repository, where: 'HEAD' | 'index', file: string, name: string): Promise<GitSide> {
    const bytes = await repo.show(where, file);
    if (bytes === undefined) return { name, notDisplayed: 'missing' };
    if (bytes === 'tooLarge') return { name, notDisplayed: 'tooLarge' };
    const decoded = decodeDocument(bytes);
    return decoded ? { name, content: decoded.text } : { name, notDisplayed: 'binary', bytes: bytes.length };
  }

  private openSide(title: string, side: GitSide): void {
    if ('notDisplayed' in side) this.deps.editorPane.openPlaceholder(title, side);
    else this.deps.editorPane.openReadOnly(title, side.content, side.name);
  }

  private setAmending(repoId: string | undefined): void {
    if (this.amendingRepoId === repoId) return;
    this.amendingRepoId = repoId;
    this.deps.menuChanged();
  }

  // The shell's setInput after a commit or an undo ends its amend mode too.
  private leaveAmend(repoId: string): void {
    if (this.amendingRepoId === repoId) this.setAmending(undefined);
  }

  // The project folder's realpath, which repository roots are given in, then the folder as registered.
  private projectFolders(project: Project): string[] {
    const real = this.deps.service.projectRealPath(project.key);
    return real === undefined || samePath(real, project.fsPath) ? [project.fsPath] : [real, project.fsPath];
  }

  // VS Code's save prompt in smartCommit: unsaved files under the root, only the staged ones at 'staged' or when something is
  // staged. Resolves the saved paths, or undefined for Cancel.
  private async saveBeforeCommit(repoId: string, root: string): Promise<string[] | undefined> {
    const mode = this.read<PromptToSaveFilesBeforeCommit>(SCM_SETTING_KEYS.promptToSaveFilesBeforeCommit, 'always');
    if (mode === 'never') return [];
    const status = await this.deps.service.currentStatus(repoId);
    let documents = (await this.deps.editorPane.dirtyFiles()).filter((document) => isInside(root, document.path));
    if (mode === 'staged' || status.groups.index.length > 0) {
      const staged = new Set(status.groups.index.map((change) => folderKey(path.join(root, ...change.path.split('/')))));
      documents = documents.filter((document) => staged.has(folderKey(document.path)));
    }
    if (documents.length === 0) return [];
    const t = this.deps.t;
    const one = documents.length === 1;
    const choice = await this.deps.ask({
      severity: 'warning',
      message: one
        ? t('The following file has unsaved changes which won\'t be included in the commit if you proceed: {0}.', path.basename(documents[0]!.path))
        : t('There are {0} unsaved files.', documents.length),
      detail: one ? t('Would you like to save it before committing?') : t('Would you like to save them before committing?'),
      actions: [t('Save All & Commit Changes'), t('Commit Changes')],
      cancelLabel: t('Cancel'),
      defaultAction: 0,
    });
    if (choice === undefined) return undefined;
    if (choice === 1) return [];
    if (!(await this.deps.editorPane.saveDocuments(documents.map((document) => document.documentId)))) throw new Error(t('The unsaved files could not be saved, so nothing was committed.'));
    return documents.map((document) => document.path);
  }

  // VS Code's promptForBranchName: the box starts with branchPrefix and the caret after it.
  private askBranchName(): Promise<string | undefined> {
    const t = this.deps.t;
    const prefix = this.read(SCM_SETTING_KEYS.branchPrefix, '');
    return this.deps.askInput({
      title: t('Commit to a New Branch'),
      prompt: t('Please provide a new branch name'),
      placeholder: t('Branch name'),
      value: prefix,
      valueSelection: [prefix.length, prefix.length],
      validation: 'branchName',
    });
  }

  // The post-commit command's one place. Push and sync need remote operations the engine does not have yet, so they act as
  // none, and the Git log says so once per run.
  private runPostCommitCommand(): void {
    const command = this.read(SCM_SETTING_KEYS.postCommitCommand, 'none');
    if (command === 'none' || this.postCommitNoted) return;
    this.postCommitNoted = true;
    this.deps.gitLog(`[scm] postCommitCommand is "${command}", which runs nothing yet: it acts as "none"`);
  }

  // A flow main starts itself (a palette command): a failure gets the notice runRequest gives.
  private async guarded(op: string, flow: () => Promise<void>): Promise<void> {
    try {
      await flow();
    } catch (err) {
      this.deps.log(`[scm] ${op} failed: ${err instanceof Error ? err.message : String(err)}`);
      this.failed(errorText(err));
    }
  }

  private read<T>(key: string, fallback: T): T {
    const value = this.deps.settings.get<unknown>(key);
    return isDesktopSettingValue(key, value) ? (value as T) : fallback;
  }

  private changesTitle(repo: Repository, group: ChangeGroup): string {
    const t = this.deps.t;
    const label = group === 'index' ? t('Staged Changes') : group === 'merge' ? t('Merge Changes') : group === 'untracked' ? t('Untracked Changes') : t('Changes');
    return `${path.basename(repo.root)}: ${label}`;
  }

  private failed(message: string): void {
    const t = this.deps.t;
    const show = t('Show Git Output');
    void this.deps.notify.error(message, show).then((choice) => {
      if (choice === show) this.deps.showGitLog();
    });
  }

  private settings(): ScmSettings {
    return {
      untrackedChanges: this.read(SCM_SETTING_KEYS.untrackedChanges, 'mixed'),
      inputValidation: this.read(SCM_SETTING_KEYS.inputValidation, false),
      inputValidationSubjectLength: this.read(SCM_SETTING_KEYS.inputValidationSubjectLength, 50),
      inputValidationLength: this.read(SCM_SETTING_KEYS.inputValidationLength, 72),
      allowNoVerifyCommit: this.read(SCM_SETTING_KEYS.allowNoVerifyCommit, false),
    };
  }

  private selectedView(): ScmView | undefined {
    const key = this.deps.selectedProjectKey();
    return key === undefined ? undefined : this.view(key);
  }

  private view(projectKey: string): ScmView | undefined {
    const view = this.deps.service.view(projectKey);
    const project = this.deps.projects().find((candidate) => candidate.key === projectKey);
    if (!view || !project) return undefined;
    const folders = this.projectFolders(project);
    return {
      projectKey,
      state: view.state,
      repos: view.repos.map((repo) => ({
        repoId: repo.repoId,
        label: path.basename(repo.root),
        displayPath: repo.kind === 'parent' ? repo.root : path.relative(folders[0]!, repo.root).split(path.sep).join('/'),
        kind: repo.kind,
      })),
      selectedRepoId: this.selectedRepoId(projectKey, view, folders),
      closedCount: view.closedRoots.length,
      unsafePaths: view.unsafe.map((entry) => path.normalize(entry)),
      parentCount: view.parents.length,
    };
  }

  // The persisted root, else the repository holding the project folder, else the first.
  private selectedRepoId(projectKey: string, view: ProjectView, projectFolders: readonly string[]): string | null {
    const saved = this.deps.selection.get(projectKey);
    const sameRoot = (a: string, b: string): boolean => (this.deps.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    const chosen = (saved !== undefined ? view.repos.find((repo) => sameRoot(repo.root, saved)) : undefined)
      ?? view.repos.find((repo) => projectFolders.some((folder) => isInside(repo.root, folder)))
      ?? view.repos[0];
    return chosen?.repoId ?? null;
  }

  private snapshot(repoId: string): ScmRepoSnapshot | undefined {
    const snapshot = this.deps.service.snapshot(repoId);
    if (!snapshot) return undefined;
    const status = snapshot.status;
    const groups = status?.groups;
    return {
      repoId,
      projectKey: snapshot.projectKey,
      head: status?.head ?? null,
      commit: status?.commit ?? null,
      operation: status?.operation ?? null,
      ...(status?.mergeMessage !== undefined ? { mergeMessage: status.mergeMessage } : {}),
      groups: {
        merge: (groups?.merge ?? []).map(toScmChange),
        index: (groups?.index ?? []).map(toScmChange),
        workingTree: (groups?.workingTree ?? []).map(toScmChange),
        untracked: (groups?.untracked ?? []).map(toScmChange),
      },
      tooManyChanges: status?.tooManyChanges ?? false,
      busy: snapshot.busy,
    };
  }

  private decorations(projectKey: string): ScmDecorations {
    return { projectKey, files: this.deps.service.decorations(projectKey) };
  }

  // The active editor's file in an open repository, with the group its change sits in (unstaged first, as VS Code's
  // getSCMResource picks the working tree resource).
  private activeResource(): { readonly repoId: string; readonly relativePath: string; readonly group?: ChangeGroup } | undefined {
    const filePath = this.deps.editorPane.activeContext()?.filePath;
    return filePath === undefined ? undefined : this.resourceAt(filePath);
  }

  private resourceAt(absolute: string): { readonly repoId: string; readonly relativePath: string; readonly group?: ChangeGroup } | undefined {
    let best: { repoId: string; root: string } | undefined;
    for (const key of this.deps.service.projectKeys()) {
      for (const repo of this.deps.service.view(key)?.repos ?? []) {
        if (isInside(repo.root, absolute) && (!best || repo.root.length > best.root.length)) best = { repoId: repo.repoId, root: repo.root };
      }
    }
    if (!best) return undefined;
    const relativePath = path.relative(best.root, absolute).split(path.sep).join('/');
    const groups = this.deps.service.repository(best.repoId)?.repo.lastStatus?.groups;
    const group = (['workingTree', 'untracked', 'index', 'merge'] as const).find((candidate) => groups?.[candidate].some((change) => change.path === relativePath));
    return { repoId: best.repoId, relativePath, ...(group ? { group } : {}) };
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      // the editor pane and the shell this writes to are disposed first
      if (!this.disposed) this.flush();
    });
  }

  private flush(): void {
    const { views, repos, decorations, ignores } = this.pending;
    for (const projectKey of views) {
      const view = this.view(projectKey);
      if (view) this.deps.send.view(view);
    }
    for (const repoId of repos) {
      const snapshot = this.snapshot(repoId);
      if (snapshot) this.deps.send.state(snapshot);
    }
    for (const projectKey of decorations) this.deps.send.decorations(this.decorations(projectKey));
    for (const projectKey of ignores) this.deps.send.filesChanged(projectKey);
    if (repos.size > 0) this.refreshChangesTabs(repos);
    if (views.size > 0 || repos.size > 0) this.deps.menuChanged();
    views.clear();
    repos.clear();
    decorations.clear();
    ignores.clear();
  }

  // A repository core no longer has closes its changes and diff tabs, as VS Code closes a closed repository's editors.
  private refreshChangesTabs(repoIds: ReadonlySet<string>): void {
    for (const repoId of repoIds) {
      if (this.deps.service.repository(repoId)) continue;
      if (this.amendingRepoId === repoId) this.amendingRepoId = undefined;
      void this.deps.editorPane.closeChanges(repoId).catch((err: unknown) => this.deps.log(`[scm] closing a closed repository's tabs failed: ${errorText(err)}`));
    }
    for (const { tabId, state } of this.deps.editorPane.changesTabs()) {
      const repo = repoIds.has(state.changes.repoId) ? this.deps.service.repository(state.changes.repoId)?.repo : undefined;
      if (!repo) continue;
      const source = state.changes.source;
      const entries = (repo.lastStatus?.groups[source.kind] ?? []).map(toScmChange);
      const changes: ScmChangesTab = { repoId: state.changes.repoId, source, entries };
      this.deps.editorPane.updateChanges(tabId, { title: state.title, changes });
    }
  }
}

type GitSide = { readonly name: string; readonly content: string } | NotShownSide;

function toScmChange(change: Change): ScmRepoSnapshot['groups']['merge'][number] {
  return {
    path: change.path,
    ...(change.originalPath !== undefined ? { originalPath: change.originalPath } : {}),
    status: change.status,
    letter: change.letter,
    tone: change.tone,
    strike: change.strike,
    ...(change.submodule ? { submodule: true as const } : {}),
  };
}

// VS Code's Repository.getTitle, for the file's current name.
function titleOf(status: Change['status'], name: string, t: ScmHostDeps['t']): string {
  switch (status) {
    case 'INDEX_MODIFIED':
    case 'INDEX_RENAMED':
    case 'INDEX_ADDED':
      return t('{0} (Index)', name);
    case 'MODIFIED':
    case 'BOTH_ADDED':
    case 'BOTH_MODIFIED':
      return t('{0} (Working Tree)', name);
    case 'INDEX_DELETED':
    case 'DELETED':
      return t('{0} (Deleted)', name);
    case 'DELETED_BY_US':
      return t('{0} (Theirs)', name);
    case 'DELETED_BY_THEM':
      return t('{0} (Ours)', name);
    case 'UNTRACKED':
      return t('{0} (Untracked)', name);
    case 'INTENT_TO_ADD':
    case 'INTENT_TO_RENAME':
      return t('{0} (Intent to add)', name);
    case 'TYPE_CHANGED':
      return t('{0} (Type changed)', name);
    default:
      return name;
  }
}

