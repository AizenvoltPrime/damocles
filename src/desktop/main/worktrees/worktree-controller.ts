// Main's side of worktree chats (D30 to D33, slice 12a): core's host services, the New menu's options, the finish actions
// and their questions, and every worktree delete in rule 14's order (close what runs there first, then `git worktree remove`).
import * as fs from 'node:fs';
import type { Disposable } from '../../../platform/disposable';
import type { GitRunner } from '../../../core/scm/git-runner';
import type { HandOffConfirmRequest, RefusalRequest, SetupReviewRequest, SetupRunRequest, SetupStep, WorktreeHostServices } from '../../../core/worktrees/host';
import {
  aheadBehind,
  apply,
  branchContained,
  isRewritten,
  lineChangesSinceBase,
  mergeInto,
  rebaseOnto,
  removeWorktree,
  targetBranch,
  uncommittedFiles,
  unmergedCommits,
  updateFrom,
  worktreeFolderState,
  type UpdateOutcome,
} from '../../../core/worktrees/integrate';
import { nulList, projectGit, worktreeOptions } from '../../../core/worktrees/create';
import { pruneWorktrees, scanLeftovers, type LeftoverFinding } from '../../../core/worktrees/leftovers';
import type { ChatWorktreeRecord, WorktreeRegistry } from '../../../core/worktrees/registry';
import { DEFAULT_BRANCH_PREFIX } from '../../../core/worktrees/slug';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { rootKey } from '../../preload/folder-root';
import type { ChatsContinueWorktree, ChatsWorktreeOptions, WorktreeFinishAction, WorktreeFinishState } from '../../preload/shell-channels';
import type { AskMessage } from '../message-dialog';
import type { TerminalTaskRequest } from '../terminal/terminal-service';
import type { WorktreeRoots } from './roots';
import { setupArgs, type SetupShell } from './setup-terminal';
import type { AskWorktreeDialog, WorktreeDialogOf } from './worktree-dialogs';
import { boundWorktreeDialog } from '../overlay';
import { visibleLines, visibleText } from '../../../shared/visible-text';

// A loaded chat that uses a worktree, as core last reported it.
export interface WorktreeChatUse {
  readonly panelId: string;
  // running, waiting on the user, or with subagents or a team working; browser pages never count (D33)
  readonly busy: boolean;
}

export interface WorktreeControllerDeps {
  readonly registry: WorktreeRegistry;
  readonly roots: WorktreeRoots;
  readonly git: () => GitRunner | undefined;
  // damocles.desktop.git.branchPrefix, '' when unset
  readonly branchPrefix: () => string;
  readonly isTrusted: (folder: string) => boolean;
  readonly askDialog: AskWorktreeDialog;
  readonly ask: AskMessage;
  readonly notify: {
    info(message: string, ...actions: string[]): Promise<string | undefined>;
    warn(message: string, ...actions: string[]): Promise<string | undefined>;
    error(message: string, ...actions: string[]): Promise<string | undefined>;
  };
  readonly t: (message: string, ...args: Array<string | number>) => string;
  readonly log: (line: string) => void;
  // the Setup tab (rule 23)
  readonly setupShell: () => SetupShell | undefined;
  readonly runTask: (request: TerminalTaskRequest) => void;
  readonly retrySetup: (worktreeId: string) => Promise<void>;
  readonly worktreeEnv: (record: ChatWorktreeRecord) => Readonly<Record<string, string>>;
  // the loaded chats whose latest worktree entry names this worktree
  readonly chatsUsing: (worktreeId: string) => readonly WorktreeChatUse[];
  // the stored sessions whose latest worktree entry names it, loaded or not
  readonly sessionsUsing: (worktreeId: string) => Promise<readonly string[]>;
  // another Damocles process holds the session's lease
  readonly leasedElsewhere: (sessionId: string) => boolean;
  // Rule 14's first half (close-worktree.ts): every question first (dirty editor tabs, then terminals running a process), then
  // stop, then the tabs close, the chats using it unload, the terminals end and the formatter host, watchers and source
  // control of the root stop. stop takes the delete's hold and closes the root; it is called after the last question and
  // before anything stops, and false cancels as the user's cancel does. false: nothing was stopped.
  readonly closeWorktree: (worktreeId: string, root: string, stop: () => boolean) => Promise<boolean>;
  // after the delete, whether it removed the worktree or not
  readonly afterClose: (worktreeId: string, removed: boolean) => void;
  readonly showProjectFolder: (projectKey: string) => void;
  readonly newChatInProject: (projectPath: string) => void;
  // New Chat in This Worktree for a live chat worktree of the project; it tells the user when it fails
  readonly newChatInWorktree: (projectPath: string, worktreeId: string) => void;
  // core refuses sends to the worktree's chats while held; undefined, and nothing held, when one of them is busy (D33)
  readonly beginFinish: (worktreeId: string, action: 'apply' | 'merge' | 'update' | 'delete') => Disposable | undefined;
  // the terminal tab running the task named key shows and becomes active; false when it was closed
  readonly showTask: (key: string) => boolean;
  // the terminal tab running the task named key, if any, is killed and closed
  readonly stopTask: (key: string) => void;
  // a listed project whose repository's refs changed (source control's .git watcher, AD4), by its path as listed
  readonly onDidChangeRefs: (listener: (projectPath: string) => void) => Disposable;
  // a project folder whose repositories source control discovered again, by its path
  readonly onDidChangeProjectRepository: (listener: (projectPath: string) => void) => Disposable;
  // the root of the repository source control opened for the project folder, its own or a parent (D9); undefined: none
  readonly projectRepository: (projectPath: string) => string | undefined;
  // the same once source control finished discovering the project's repositories
  readonly projectRepositoryWhenReady: (projectPath: string) => Promise<string | undefined>;
  // the project's chats by the worktree their latest worktree entry names, loaded or listed
  readonly worktreeChats: (projectPath: string) => Promise<ReadonlyMap<string, { readonly count: number; readonly lastActivity: number }>>;
  // the merge editor for the conflicted files of the repository holding folder (slice 12)
  readonly openConflicts: (folder: string, files: readonly string[], applyBranch?: string) => Promise<void>;
  // slice 11's Publish Branch on the repository of the worktree's root key, with its remote picker
  readonly publish: (worktreeRootKey: string) => Promise<void>;
  // from the project folder's repository status: it has a remote (Push branch), its HEAD is detached (Merge)
  readonly targetFacts: (record: ChatWorktreeRecord) => { readonly hasRemote: boolean; readonly detached: boolean };
  // D24's generator over the worktree's uncommitted changes; undefined when it told the user why not
  readonly generateMessage: (record: ChatWorktreeRecord) => Promise<string | undefined>;
  // shown folders, chat rows and menus read registry and git state that a finish action changed
  readonly changed: () => void;
  // Reveal in File Explorer
  readonly reveal: (absolutePath: string) => Promise<void>;
}

type Told = 'done' | 'cancelled' | 'refused';

export class WorktreeController {
  private readonly deps: WorktreeControllerDeps;
  // one finish action per worktree at a time
  private readonly running = new Set<string>();
  // the worktrees of the open mergeMessage dialogs, the newest last, for the Generate button of the dialog on top
  private readonly generating: ChatWorktreeRecord[] = [];

  constructor(deps: WorktreeControllerDeps) {
    this.deps = deps;
  }

  /** What core receives as Platform.worktrees. */
  hostServices(): WorktreeHostServices {
    return {
      registry: this.deps.registry,
      git: () => this.deps.git(),
      branchPrefix: () => this.deps.branchPrefix(),
      reviewSetup: (request) => this.reviewSetup(request),
      runSetup: (request, onStep) => this.runSetup(request, onStep),
      showSetupTerminal: (worktreeId) => this.showSetupTerminal(worktreeId),
      stopSetup: (worktreeId) => this.deps.stopTask(setupTaskKey(worktreeId)),
      newChatInWorktree: (projectPath, worktreeId) => this.deps.newChatInWorktree(projectPath, worktreeId),
      onDidChangeRefs: (listener) => this.deps.onDidChangeRefs(listener),
      onDidChangeProjectRepository: (listener) => this.deps.onDidChangeProjectRepository(listener),
      projectRepository: (projectPath) => this.deps.projectRepository(projectPath),
      confirmHandOff: (request) => this.confirmHandOff(request),
      showRefusal: (request) => this.showRefusal(request),
      showApplyConflicts: (record, files) => this.applyConflicts(record, files),
      newChatInProject: (projectPath) => this.deps.newChatInProject(projectPath),
    };
  }

  /** The New menu's worktree options (D30, D63) for an open project. */
  async options(project: { readonly fsPath: string; readonly name: string }): Promise<ChatsWorktreeOptions> {
    if (!this.deps.isTrusted(project.fsPath)) return { available: false, reason: 'untrusted' };
    const git = this.deps.git();
    if (!git || (await this.deps.projectRepositoryWhenReady(project.fsPath)) === undefined) return { available: false, reason: 'notGit' };
    const options = await worktreeOptions(git, project.fsPath);
    if (!options.available) return options;
    const prefix = this.deps.branchPrefix();
    return { ...options, projectName: project.name, branchPrefix: prefix === '' ? DEFAULT_BRANCH_PREFIX : prefix };
  }

  // The New menu's Continue in a worktree: the project's live chat worktrees whose folder exists, most recently used first, with their changes against baseCommit.
  async continueWorktrees(project: { readonly fsPath: string }): Promise<ChatsContinueWorktree[]> {
    const git = this.deps.git();
    if (!git || !this.deps.isTrusted(project.fsPath)) return [];
    const chats = await this.deps.worktreeChats(project.fsPath);
    // a worktree a finish action holds takes no new chat
    const records = this.deps.registry.liveChatRecords(project.fsPath).filter((record) => !this.running.has(record.id) && fs.existsSync(record.worktreeRoot));
    const settled = await Promise.allSettled(records.map(async (record): Promise<ChatsContinueWorktree & { readonly createdAt: number }> => {
      const target = await targetBranch(record, git);
      const [changes, { behind }] = await Promise.all([lineChangesSinceBase(record, git), aheadBehind(record, git, target)]);
      const used = chats.get(record.id);
      return {
        worktreeId: record.id,
        branch: record.branch,
        chatCount: used?.count ?? 0,
        ...changes,
        behind,
        ...(target !== undefined ? { baseBranch: target } : {}),
        lastActivity: Math.max(used?.lastActivity ?? 0, record.createdAt),
        createdAt: record.createdAt,
      };
    }));
    // a worktree whose git fails is left out of the list, never the list itself
    const rows = settled.flatMap((result, index) => {
      if (result.status === 'fulfilled') return [result.value];
      this.deps.log(`[worktrees] reading ${records[index]!.worktreeRoot} for the New menu failed: ${errorText(result.reason)}`);
      return [];
    });
    return mostRecentlyUsed(rows).map(({ createdAt: _createdAt, ...row }) => row);
  }

  /** The New menu's choice checked against fresh options: a listed ref, and bringChanges only from the current branch. */
  async checkOptIn(project: { readonly fsPath: string; readonly name: string }, startRef: string, bringChanges: boolean): Promise<boolean> {
    const options = await this.options(project);
    if (!options.available) return false;
    const branch = options.branches.find((candidate) => candidate.ref === startRef);
    return branch !== undefined && (!bringChanges || (branch.current && options.uncommittedCount > 0));
  }

  /** The finish actions' enablement for a live chat worktree (D33). */
  finishState(record: ChatWorktreeRecord): WorktreeFinishState {
    const facts = this.deps.targetFacts(record);
    return { busy: this.busy(record.id), hasRemote: facts.hasRemote, detachedTarget: facts.detached };
  }

  /** A finish action runs on the worktree, so it takes no new chat. */
  isFinishing(worktreeId: string): boolean {
    return this.running.has(worktreeId);
  }

  busy(worktreeId: string): boolean {
    return this.running.has(worktreeId) || this.deps.chatsUsing(worktreeId).some((chat) => chat.busy);
  }

  /** The mergeMessage dialog's Generate: D24's message for the open dialog's worktree. */
  async generateForOpenDialog(): Promise<{ readonly message: string } | null> {
    const record = this.generating.at(-1);
    if (!record) return null;
    const message = await this.deps.generateMessage(record);
    return message === undefined ? null : { message };
  }

  /** A finish action from a command, the Files chip or a chat row; it tells the user every outcome itself. */
  /** retried: a Delete's Retry, which finishes the remove the user confirmed, branch choice included. */
  async finish(worktreeId: string, action: WorktreeFinishAction, retried?: { readonly deleteBranch: boolean }): Promise<void> {
    const t = this.deps.t;
    const record = this.liveChat(worktreeId);
    if (!record) {
      void this.deps.notify.info(t('This worktree no longer exists.'));
      return;
    }
    if (this.running.has(worktreeId)) {
      void this.deps.notify.info(t('Another action is running on this worktree. Try again once it ends.'));
      return;
    }
    // Push branch publishes the branch and writes nothing in the worktree, so a working chat does not hold it (D33)
    if (action === 'push') {
      await this.runFinish(record, action);
      return;
    }
    if (this.busy(worktreeId)) {
      void this.deps.notify.info(t('A chat using this worktree is working. Try again once it is idle.'));
      return;
    }
    this.running.add(worktreeId);
    this.deps.changed();
    try {
      await this.runFinish(record, action, retried);
    } finally {
      this.running.delete(worktreeId);
      this.deps.changed();
    }
  }

  private async runFinish(record: ChatWorktreeRecord, action: WorktreeFinishAction, retried?: { readonly deleteBranch: boolean }): Promise<void> {
    const git = this.requireGit();
    if (!git) return;
    try {
      switch (action) {
        case 'apply':
          await this.apply(record, git);
          return;
        case 'merge':
          await this.merge(record, git);
          return;
        case 'update':
          await this.update(record, git);
          return;
        case 'push':
          if (!this.deps.targetFacts(record).hasRemote) {
            void this.deps.notify.info(this.deps.t('This repository has no remote, so the branch cannot be pushed.'));
            return;
          }
          await this.deps.publish(this.rootKeyOf(record));
          return;
        case 'delete':
          await this.deleteChatWorktree(record, git, retried);
          return;
      }
    } catch (err) {
      this.deps.log(`[worktrees] ${action} on ${record.worktreeRoot} failed: ${errorText(err)}`);
      void this.deps.notify.error(this.deps.t('The worktree action failed: {0}', visibleLines(errorText(err))));
    }
  }

  // After the last question: core holds the worktree's chats, or one of them started working and the action stops.
  private hold(record: ChatWorktreeRecord, action: 'apply' | 'merge' | 'update' | 'delete'): Disposable | undefined {
    const held = this.deps.beginFinish(record.id, action);
    if (!held) void this.deps.notify.info(this.deps.t('A chat using this worktree is working. Try again once it is idle.'));
    return held;
  }

  private async apply(record: ChatWorktreeRecord, git: GitRunner): Promise<Told> {
    const t = this.deps.t;
    const held = this.hold(record, 'apply');
    if (!held) return 'refused';
    let outcome;
    try {
      outcome = await apply(record, git, this.deps.registry);
    } finally {
      held.dispose();
    }
    if (outcome.kind === 'refused') {
      await this.deps.askDialog({ dialog: 'refusal', action: 'apply', files: outcome.files });
      return 'refused';
    }
    this.deps.showProjectFolder(this.projectKeyOf(record));
    if (outcome.kind === 'conflicts') {
      await this.applyConflicts(record, outcome.files);
      return 'done';
    }
    void this.deps.notify.info(outcome.files.length === 1 ? t('Applied 1 file to the project folder.') : t('Applied {0} files to the project folder.', outcome.files.length));
    return 'done';
  }

  // D33: an Apply that left files in conflict opens them in the merge editor.
  private async applyConflicts(record: ChatWorktreeRecord, files: readonly string[]): Promise<void> {
    void this.deps.notify.warn(this.deps.t('There are merge conflicts. Please resolve them before committing your changes.'));
    await this.deps.openConflicts(record.projectPath, files, record.branch);
  }

  private async merge(record: ChatWorktreeRecord, git: GitRunner): Promise<void> {
    const t = this.deps.t;
    const target = await targetBranch(record, git);
    if (target === undefined) {
      void this.deps.notify.info(t('The project folder is on a detached HEAD, so there is no branch to merge into.'));
      return;
    }
    // D33: a rewritten target asks before anything is committed
    if (await isRewritten(record, git, target)) {
      const rewritten = await this.rewritten(record, git, target);
      if (rewritten !== 'merge') return;
    }
    let message: string | undefined;
    const files = await uncommittedFiles(record, git);
    if (files.length > 0) {
      this.generating.push(record);
      let answer;
      try {
        answer = await this.deps.askDialog({ dialog: 'mergeMessage', branch: record.branch, target, files });
      } finally {
        this.generating.splice(this.generating.lastIndexOf(record), 1);
      }
      if (answer.choice !== 'commit') return;
      message = answer.message;
    }
    const held = this.hold(record, 'merge');
    if (!held) return;
    let outcome;
    try {
      outcome = await mergeInto(record, git, this.deps.registry, message !== undefined ? { message } : {});
    } finally {
      held.dispose();
    }
    switch (outcome.kind) {
      case 'ok':
        this.deps.showProjectFolder(this.projectKeyOf(record));
        void this.deps.notify.info(t('Merged {0} into {1}.', visibleText(record.branch), visibleText(target)));
        return;
      case 'needsMessage':
        void this.deps.notify.warn(t('The worktree changed while Damocles was asking, so nothing was merged. Try again.'));
        return;
      case 'detached':
        void this.deps.notify.info(t('The project folder is on a detached HEAD, so there is no branch to merge into.'));
        return;
      case 'rewritten':
        void this.deps.notify.warn(t('{0} was rewritten after this worktree started', visibleText(outcome.branch)));
        return;
      case 'conflicts':
        this.deps.showProjectFolder(this.projectKeyOf(record));
        void this.deps.notify.warn(t('There are merge conflicts. Please resolve them before committing your changes.'));
        await this.deps.openConflicts(record.projectPath, outcome.files);
        return;
      case 'refused':
        void this.deps.notify.error(visibleLines(outcome.message));
        return;
    }
  }

  // D33's question; 'merge': rebased cleanly, so the merge goes on and fast-forwards.
  private async rewritten(record: ChatWorktreeRecord, git: GitRunner, target: string): Promise<'merge' | 'stop'> {
    const answer = await this.deps.askDialog({ dialog: 'rewritten', branch: target });
    if (answer.choice === 'apply') {
      await this.apply(record, git);
      return 'stop';
    }
    if (answer.choice !== 'rebase') return 'stop';
    const rebased = await this.rebase(record, git, 'merge');
    if (!rebased) return 'stop';
    return (await this.updated(record, rebased, target)) ? 'merge' : 'stop';
  }

  private async rebase(record: ChatWorktreeRecord, git: GitRunner, action: 'merge' | 'update'): Promise<UpdateOutcome | undefined> {
    const held = this.hold(record, action);
    if (!held) return undefined;
    try {
      return await rebaseOnto(record, git, this.deps.registry);
    } finally {
      held.dispose();
    }
  }

  private async update(record: ChatWorktreeRecord, git: GitRunner): Promise<void> {
    const t = this.deps.t;
    const target = await targetBranch(record, git);
    if (target === undefined) {
      void this.deps.notify.info(t('The project folder is on a detached HEAD, so there is no branch to update from.'));
      return;
    }
    const held = this.hold(record, 'update');
    if (!held) return;
    let outcome: UpdateOutcome;
    try {
      outcome = await updateFrom(record, git, this.deps.registry);
    } finally {
      held.dispose();
    }
    if (outcome.kind === 'rewritten') {
      const answer = await this.deps.askDialog({ dialog: 'rewritten', branch: outcome.branch });
      if (answer.choice !== 'rebase') return;
      const rebased = await this.rebase(record, git, 'update');
      if (!rebased) return;
      outcome = rebased;
    }
    if (await this.updated(record, outcome, target)) void this.deps.notify.info(t('Updated {0} from {1}.', visibleText(record.branch), visibleText(target)));
  }

  // An update or rebase's outcome told to the user; true when it went through.
  private async updated(record: ChatWorktreeRecord, outcome: UpdateOutcome, target: string): Promise<boolean> {
    const t = this.deps.t;
    switch (outcome.kind) {
      case 'ok':
        return true;
      case 'detached':
        void this.deps.notify.info(t('The project folder is on a detached HEAD, so there is no branch to update from.'));
        return false;
      case 'rewritten':
        void this.deps.notify.warn(t('{0} was rewritten after this worktree started', visibleText(target)));
        return false;
      case 'conflicts':
        void this.deps.notify.warn(t('There are merge conflicts. Please resolve them before committing your changes.'));
        await this.deps.openConflicts(record.workingFolder, outcome.files);
        return false;
      case 'refused':
        void this.deps.notify.error(visibleLines(outcome.message));
        return false;
    }
  }

  /**
   * D33 Delete on a chat worktree: refused while a chat using it works or another process holds one of its chats; the
   * confirmation names what would be lost; then rule 14: close first, remove second. A failure keeps the worktree
   * registered, names the path, and offers Retry.
   */
  async deleteChatWorktree(record: ChatWorktreeRecord, git: GitRunner, retried?: { readonly deleteBranch: boolean }): Promise<void> {
    const t = this.deps.t;
    const sessions = await this.deps.sessionsUsing(record.id);
    if (sessions.some((sessionId) => this.deps.leasedElsewhere(sessionId))) {
      void this.deps.notify.warn(t('Another Damocles window has a chat of this worktree open, so the worktree was not deleted.'));
      return;
    }
    // Removed outside Damocles: nothing is left to lose or ask about, and the remove prunes git's record, keeping the branch.
    // Left without its .git link by a remove git could not finish: a Retry of that confirmed Delete removes what is left with
    // the user's branch choice; any other Delete asks before the folder and everything in it go.
    const state = await worktreeFolderState(record.worktreeRoot);
    if (state === 'gone' || (state === 'leftover' && retried)) {
      await this.closeAndRemove(record, git, retried?.deleteBranch ?? false, false);
      return;
    }
    if (state === 'leftover') {
      const choice = await this.deps.ask({
        severity: 'danger',
        message: t('The folder of the worktree "{0}" is no longer a git worktree. Delete it and everything in it?', visibleText(record.worktreeRoot)),
        detail: t('A delete that could not finish may have left it behind. Its files go for good, not to the trash.'),
        actions: [t('Delete worktree')],
        cancelLabel: t('Cancel'),
      });
      if (choice === 0) await this.closeAndRemove(record, git, false, false);
      return;
    }
    const [uncommitted, unmerged, contained, submodules] = await Promise.all([uncommittedFiles(record, git), unmergedCommits(record, git), branchContained(record, git), submoduleState(record, git)]);
    const answer = await this.deps.askDialog({
      dialog: 'delete',
      path: record.worktreeRoot,
      branch: record.branch,
      uncommitted,
      submoduleChanges: submodules.changed.map((path) => ({ path, letter: 'S' as const })),
      unmergedCommits: unmerged,
      deleteBranchDefault: unmerged.length === 0 && contained,
      deleteBranchLocked: false,
    });
    if (answer.choice !== 'delete') return;
    // --force only for what the user was shown: work that appears after the question makes git refuse, which keeps it
    await this.closeAndRemove(record, git, answer.deleteBranch, uncommitted.length > 0 || submodules.initialized);
  }

  private async closeAndRemove(record: ChatWorktreeRecord, git: GitRunner, deleteBranch: boolean, force: boolean): Promise<void> {
    const t = this.deps.t;
    let removed = false;
    let held: Disposable | undefined;
    let closing: { dispose(): void } | undefined;
    try {
      // the root stays open through the questions, so a Save writes and nothing keyed by root stops before the hold
      const stop = (): boolean => {
        held = this.hold(record, 'delete');
        if (held) closing = this.deps.roots.close(record.id);
        return held !== undefined;
      };
      if (!(await this.deps.closeWorktree(record.id, this.rootKeyOf(record), stop))) return;
      try {
        await removeWorktree(record, git, this.deps.registry, { deleteBranch, force });
        removed = true;
      } catch (err) {
        removed = this.deps.registry.get(record.id)?.deletedAt !== undefined;
        this.deps.log(`[worktrees] deleting ${record.worktreeRoot} failed: ${errorText(err)}`);
        const retry = t('Retry');
        const message = removed ? visibleLines(errorText(err)) : t('Could not delete the worktree "{0}": {1}', visibleText(record.worktreeRoot), visibleLines(errorText(err)));
        void this.deps.notify.error(message, ...(removed ? [] : [retry]))
          .then((choice) => (choice === retry ? this.finish(record.id, 'delete', { deleteBranch }) : undefined))
          .catch((retryErr: unknown) => this.deps.log(`[worktrees] retrying the delete of ${record.worktreeRoot} failed: ${errorText(retryErr)}`));
      }
    } finally {
      held?.dispose();
      closing?.dispose();
      this.deps.afterClose(record.id, removed);
    }
    if (removed) this.deps.showProjectFolder(this.projectKeyOf(record));
  }

  /** A chat was deleted: when it was the last chat using its live worktree, offer to delete the worktree too (D33). */
  async afterChatDeleted(worktreeId: string): Promise<void> {
    const record = this.liveChat(worktreeId);
    if (!record || (await this.deps.sessionsUsing(worktreeId)).length > 0 || this.deps.chatsUsing(worktreeId).length > 0) return;
    const t = this.deps.t;
    const choice = await this.deps.ask({
      severity: 'warning',
      message: t('No chat uses the worktree "{0}" now. Delete it too?', visibleText(record.worktreeRoot)),
      detail: t('The branch {0} stays unless you choose to delete it.', visibleText(record.branch)),
      actions: [t('Delete worktree')],
      cancelLabel: t('Keep worktree'),
    });
    if (choice === 0) await this.finish(worktreeId, 'delete');
  }

  /**
   * R15's startup scan: one notice naming how many leftovers it found, whose Review lists them. Nothing is deleted, and
   * `git worktree prune` runs only from the dialog's Prune, on the repository that holds git's stale record.
   */
  async scanAtStartup(projects: readonly string[]): Promise<void> {
    const findings = await scanLeftovers({ registry: this.deps.registry, git: this.deps.git(), projects, isTrusted: (folder) => this.deps.isTrusted(folder) });
    if (findings.length === 0) return;
    const t = this.deps.t;
    const review = t('Review');
    const choice = await this.deps.notify.info(findings.length === 1 ? t('1 leftover worktree') : t('{0} leftover worktrees', findings.length), review);
    if (choice === review) await this.reviewLeftovers(findings, projects);
  }

  private async reviewLeftovers(initial: readonly LeftoverFinding[], projects: readonly string[]): Promise<void> {
    let findings = initial;
    while (findings.length > 0) {
      const dialog: WorktreeDialogOf<'leftovers'> = {
        dialog: 'leftovers',
        items: findings.map((finding) => ({ path: finding.path, reason: finding.reason, ...(finding.reason === 'gitRecordOnly' && finding.projectPath !== undefined ? { repository: finding.projectPath } : {}) })),
      };
      const answer = await this.deps.askDialog(dialog);
      if (answer.choice === 'close') return;
      // the dialog shows each path made visible and cut to bounds, so the answer is matched against those
      const shown = boundWorktreeDialog(dialog);
      const index = shown.dialog === 'leftovers' ? shown.items.findIndex((item) => item.path === answer.path) : -1;
      const finding = findings[index];
      if (!finding) return;
      if (answer.choice === 'reveal') {
        await this.deps.reveal(finding.path);
        return;
      }
      const git = this.requireGit();
      if (!git) return;
      // a no-chat worktree takes D33's Delete with its own confirmation
      if (answer.choice === 'delete' && finding.worktreeId !== undefined) await this.finish(finding.worktreeId, 'delete');
      else if (answer.choice === 'keep' && finding.worktreeId !== undefined) await this.deps.registry.markUsed(finding.worktreeId);
      else if (answer.choice === 'prune' && finding.projectPath !== undefined) await pruneWorktrees(git, finding.projectPath);
      else return;
      findings = await scanLeftovers({ registry: this.deps.registry, git, projects, isTrusted: (folder) => this.deps.isTrusted(folder) });
    }
  }

  private async reviewSetup(request: SetupReviewRequest): Promise<'run' | 'skip'> {
    return (await this.deps.askDialog({ dialog: 'setupReview', projectName: request.projectName, commands: request.commands })).choice;
  }

  private runSetup(request: SetupRunRequest, onStep: (step: SetupStep) => void): Promise<{ exitCode: number }> {
    const record = this.liveChat(request.worktreeId);
    // the commands are repository-authored (D32), and trust can be revoked before a Retry or Restart
    if (record && !this.deps.isTrusted(record.projectPath)) {
      void this.deps.notify.error(this.deps.t('Trust this folder to use worktrees'));
      return Promise.resolve({ exitCode: 1 });
    }
    const shell = this.deps.setupShell();
    if (!record || !shell) {
      if (!shell) void this.deps.notify.error(this.deps.t('No shell was found to run the worktree setup.'));
      return Promise.resolve({ exitCode: 1 });
    }
    let started = 0;
    return new Promise((resolve) => {
      this.deps.runTask({
        key: setupTaskKey(request.worktreeId),
        name: this.deps.t('Setup'),
        file: shell.file,
        args: setupArgs(shell, request.commands),
        projectKey: this.rootKeyOf(record),
        cwd: request.cwd,
        env: { ...this.deps.worktreeEnv(record), ...request.env },
        // a process that could not start or was stopped counts as a failed setup
        onExit: (exitCode) => resolve({ exitCode: exitCode ?? 1 }),
        onRestart: () => {
          this.deps.retrySetup(request.worktreeId).catch((err: unknown) => this.deps.log(`[worktrees] restarting the setup failed: ${errorText(err)}`));
        },
        onCommandStart: () => {
          const command = request.commands[started];
          started++;
          if (command !== undefined) onStep({ index: started, total: request.commands.length, command });
        },
      });
    });
  }

  private showSetupTerminal(worktreeId: string): void {
    if (!this.deps.showTask(setupTaskKey(worktreeId))) void this.deps.notify.info(this.deps.t('The Setup terminal was closed.'));
  }

  private async confirmHandOff(request: HandOffConfirmRequest): Promise<boolean> {
    const answer = await this.deps.askDialog({ dialog: 'handOffConfirm', direction: request.direction, ...(request.branch !== undefined ? { branch: request.branch } : {}), files: request.files });
    return answer.choice === 'move';
  }

  private async showRefusal(request: RefusalRequest): Promise<void> {
    await this.deps.askDialog({ dialog: 'refusal', action: request.kind, files: request.files });
  }

  private liveChat(worktreeId: string): ChatWorktreeRecord | undefined {
    const record = this.deps.registry.get(worktreeId);
    return record?.kind === 'chat' && record.deletedAt === undefined ? record : undefined;
  }

  private requireGit(): GitRunner | undefined {
    const git = this.deps.git();
    if (!git) void this.deps.notify.error(this.deps.t('Git was not found, so the worktree action cannot run.'));
    return git;
  }

  private projectKeyOf(record: ChatWorktreeRecord): string {
    return this.deps.roots.ofWorktree(record.id)?.root.projectKey ?? folderKey(record.projectPath);
  }

  private rootKeyOf(record: ChatWorktreeRecord): string {
    return rootKey({ projectKey: this.projectKeyOf(record), worktreeId: record.id });
  }
}

/**
 * The worktree's checked-out submodules (git refuses to remove a worktree holding one without --force), and those with
 * uncommitted work, which D33's confirmation names.
 */
export async function submoduleState(record: ChatWorktreeRecord, runner: GitRunner): Promise<{ readonly initialized: boolean; readonly changed: string[] }> {
  const git = projectGit(runner, record.projectPath);
  const listed = await git.text(record.worktreeRoot, ['submodule', 'status', '--recursive']);
  const initialized = listed.split('\n').some((line) => line.trim() !== '' && !line.startsWith('-'));
  if (!initialized) return { initialized, changed: [] };
  const entries = nulList((await git.run(record.worktreeRoot, ['status', '--porcelain=v2', '-z', '--ignore-submodules=none'], { kind: 'status' })).stdout);
  return { initialized, changed: changedSubmodules(entries) };
}

/** Paths of porcelain v2 entries for a submodule with tracked changes (M) or untracked files (U) inside it. */
export function changedSubmodules(entries: readonly string[]): string[] {
  const changed: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const kind = entry[0];
    // a rename or copy entry is followed by its original path
    if (kind === '2') index++;
    if (kind !== '1' && kind !== '2') continue;
    const fields = entry.split(' ');
    const sub = fields[2] ?? '';
    if (!sub.startsWith('S') || (sub[2] !== 'M' && sub[3] !== 'U')) continue;
    changed.push(fields.slice(kind === '1' ? 8 : 9).join(' '));
  }
  return changed;
}

export function setupTaskKey(worktreeId: string): string {
  return `setup:${worktreeId}`;
}

/** Continue in a worktree's order: the latest chat activity first, then the newer worktree. */
export function mostRecentlyUsed<T extends { readonly lastActivity: number; readonly createdAt: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.lastActivity - a.lastActivity || b.createdAt - a.createdAt);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
