// Per-panel worktree work (D30, D32, D61; slice 12a rules 3 to 5): the opt-in held until the first send, the creation and
// setup with the first prompt held aside, the hand-off between the project folder and the worktree, a new chat in an existing
// worktree, the finish actions' hold, and the owned-folder registrations of the working folders panels bind to.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../../platform/disposable';
import type { UserContentBlock } from '../../shared/types/content';
import type { StoredSession } from '../../shared/types/session';
import type { ChatPlace, ExtensionToWebviewMessage, PromptReturnReason, WebviewToExtensionMessage, WorktreeAction, WorktreeFinishAction } from '../../shared/types/messages';
import { log } from '../logger';
import { visibleLines, visibleText } from '../../shared/visible-text';
import { t } from '../l10n';
import { folderKey } from '../workspace-folders/folder-key';
import type { FolderTarget, WorkspaceFolderRegistry } from '../workspace-folders/folder-registry';
import { approveSetup, createChatWorktree, discardChatWorktree, gitMessage, isSetupApproved, readSetupCommands, worktreeOptions } from '../worktrees/create';
import { worktreeEnvironment } from '../worktrees/environment';
import { filesToMove, HandOffMoveError, moveFilesToWorktree, readLatestWorktreeEntry } from '../worktrees/hand-off';
import type { PlatformWithWorktrees, SetupStep, WorktreeHostServices } from '../worktrees/host';
import type { GitRunner } from '../scm/git-runner';
import { apply, applyPlan } from '../worktrees/integrate';
import type { ChatWorktreeRecord, WorktreeId } from '../worktrees/registry';
import type { PanelWorktreeView, WorktreeStateEvent } from '../pi-session/session-worktree';
import { acquireSessionLease, releaseSessionLease, sessionLeaseBlocker, type SessionLeaseHolder } from '../pi-session/session-store/session-lease';
import type { WorktreeStateData } from '../../shared/types/messages';
import type { HostInstance } from './types';
import { resolvePiSessionFile } from '../pi-session/session-store/reading';
import { piSessionDir } from '../pi-session/session-store/session-dir';

export interface PanelWorktreeStateEvent extends WorktreeStateEvent {
  readonly panelId: string;
  readonly sessionId?: string;
}

export interface WorktreeOptIn {
  /** A full refname from the Start from picker (D63). */
  readonly startRef: string;
  readonly bringChanges: boolean;
}

type SendMessage = Extract<WebviewToExtensionMessage, { type: 'sendMessage' }>;

interface OptInState extends WorktreeOptIn {
  view: PanelWorktreeView;
  held?: SendMessage;
  /** The worktree this opt-in created, or the hand-off moved the chat into. */
  worktreeId?: WorktreeId;
  /** No session has used the worktree yet, so a panel that goes away discards it. */
  unused: boolean;
  /** The creation in flight, up to the chat working in the worktree; it discards what it made once the opt-in is gone. */
  creating?: Promise<ChatWorktreeRecord | undefined>;
}

/** D32's setup of one worktree, kept apart from any held prompt so Restart reruns it. */
interface SetupState {
  readonly record: ChatWorktreeRecord;
  readonly commands: readonly string[];
  /** Bumped by each run; a run that is no longer the latest changes nothing. */
  run: number;
}

/** Where a stored session resumes, and the worktree state its file gives before its session starts. */
export interface ResumeBinding {
  readonly folder: FolderTarget;
  /** null when the chat has no worktree state to show; undefined on a host without worktree chats. */
  readonly state?: WorktreeStateData | null;
  /**
   * Called once the switch to `folder` ended, with the panel as it is then: a panel working in the working folder keeps its
   * registration, and any other lets it go.
   */
  readonly settle: (landed: HostInstance | undefined) => void;
}

// One hand-off in flight (D61).
interface HandOff {
  readonly panelId: string;
  readonly host: WorktreeHostServices;
  readonly runner: GitRunner;
  readonly session: HostInstance['session'];
  readonly sessionId: string;
  readonly projectTarget: FolderTarget;
  readonly reusable: ChatWorktreeRecord | undefined;
  /** Re-checks that the chat may still move, and tells the user when it may not. */
  readonly refused: () => boolean;
  readonly markMoving: (worktreeId: WorktreeId) => void;
}

export interface PanelWorktreesDeps {
  readonly platform: PlatformWithWorktrees;
  readonly folderRegistry: WorkspaceFolderRegistry;
  readonly panels: () => Map<string, HostInstance>;
  /** switchPanelFolder with the 'chatMove' reason. */
  readonly moveTo: (panelId: string, key: string, afterSwitch?: (instance: HostInstance) => Promise<void>) => Promise<HostInstance | undefined>;
  /** Posts to the panel's webview. */
  readonly post: (panelId: string, message: ExtensionToWebviewMessage) => void;
  /** Re-dispatches a held webview message to the panel's current session. */
  readonly dispatch: (panelId: string, message: WebviewToExtensionMessage) => Promise<void>;
  /**
   * Binds the panel's new session to stored session `sessionId` and replays it, as a resume does: a session holding another
   * conversation only once pi switched to it, false when it did not; one not started before its start, which then opens it.
   * `beforeOpen` runs on the session before its start, which writes what it was given first.
   */
  readonly resumeInto: (instance: HostInstance, sessionId: string, beforeOpen?: (session: HostInstance['session']) => void) => Promise<boolean>;
  readonly releaseFolder: (key: string) => Promise<void>;
  readonly sessionsClosed: () => Promise<void>;
  /** The stored sessions listed under the open project `projectKey` so far, with each one's latest worktree entry; rows still being parsed arrive as a stored sessions change. */
  readonly storedSessionsOf: (projectKey: string) => Promise<readonly StoredSession[]>;
  /** `storedSessionsOf` once none is still being parsed: for a decision a missing row would make wrong. */
  readonly completeStoredSessionsOf: (projectKey: string) => Promise<readonly StoredSession[]>;
}

const MAX_HELD_TEXT = 4000;

export class PanelWorktrees implements Disposable {
  private readonly optIns = new Map<string, OptInState>();
  private readonly setups = new Map<WorktreeId, SetupState>();
  private readonly finishing = new Map<WorktreeId, WorktreeFinishAction>();
  // Hand-offs in flight, by panel and by the worktree they move to or from: neither takes another move or a finish action.
  private readonly movingPanels = new Set<string>();
  private readonly movingWorktrees = new Set<WorktreeId>();
  private readonly holds = new Map<string, { readonly key: string; readonly hold: Disposable }>();
  private readonly releasing = new Map<string, Promise<void>>();
  // A release waiting for sessions to close; a reacquire of the key cancels it.
  private readonly pendingReleases = new Map<string, { cancelled: boolean }>();
  // The discard each closed panel's unused worktree is going through, until it settles.
  private readonly closedDiscards = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(event: PanelWorktreeStateEvent) => void>();
  // One removal of unused deleted records at a time, each reading the lists as they are when it starts.
  private pruning: Promise<void> = Promise.resolve();
  private readonly deps: PanelWorktreesDeps;

  constructor(deps: PanelWorktreesDeps) {
    this.deps = deps;
  }

  private host(): WorktreeHostServices | undefined {
    return this.deps.platform.capabilities.worktrees ? this.deps.platform.worktrees : undefined;
  }

  onDidChangeState(listener: (event: PanelWorktreeStateEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  /** Wires a panel's (new) session to the panel's worktree view and the state event; it publishes once at bind. */
  bind(panelId: string, instance: HostInstance): void {
    const worktree = instance.session.worktree;
    worktree.bindPanel({
      view: () => this.optIns.get(panelId)?.view,
      sharedWith: (worktreeId, projectPath, sessionId) => this.sharedWith(worktreeId, projectPath, sessionId),
      finishing: (worktreeId) => this.finishing.get(worktreeId),
      moving: () => this.movingPanels.has(panelId),
      projectName: (projectPath) => this.deps.folderRegistry.resolve(folderKey(projectPath))?.label,
    });
    let placeKey: string | undefined;
    worktree.setListener((event) => {
      const sessionId = instance.session.storedSessionId ?? undefined;
      const payload: PanelWorktreeStateEvent = { ...event, panelId, ...(sessionId !== undefined ? { sessionId } : {}) };
      for (const listener of [...this.listeners]) {
        try {
          listener(payload);
        } catch (err) {
          log('[PanelWorktrees] state listener failed: %O', err);
        }
      }
      // A chat joining or leaving a worktree changes what its other chats show; a busy flip or a chip change does not.
      const key = JSON.stringify([event.worktreeId ?? null, event.state.place, sessionId ?? null]);
      if (key === placeKey) return;
      placeKey = key;
      if (event.worktreeId !== undefined) this.publishOthers(panelId);
    });
    worktree.publish();
  }

  private publish(panelId: string): void {
    this.deps.panels().get(panelId)?.session.worktree.publish();
  }

  private publishOthers(panelId: string): void {
    for (const [other, instance] of this.deps.panels()) if (other !== panelId) instance.session.worktree.publish();
  }

  /** The stored sessions changed (a chat created, deleted or handed off): every chat's share count is read again. */
  storedSessionsChanged(): Promise<void> {
    for (const instance of this.deps.panels().values()) instance.session.worktree.publish();
    const run = this.pruning.then(() => this.pruneDeletedRecords());
    this.pruning = run.catch((err: unknown) => log('[PanelWorktrees] removing deleted worktree records no chat uses failed: %O', err));
    return this.pruning;
  }

  /**
   * AD12 Listing keeps a deleted record so its chats stay listed: one is dropped once no chat of an open project lists from
   * its folder's session directory or names it in its latest entry, stored or loaded.
   */
  private async pruneDeletedRecords(): Promise<void> {
    const registry = this.host()?.registry;
    // An unparsable registry.json refuses every write and the user was told once; its records stay as last read.
    if (!registry || registry.unreadable() !== undefined) return;
    const named = new Set<string>();
    for (const instance of this.deps.panels().values()) {
      const entry = instance.session.worktree.entry();
      if (entry) named.add(entry.worktreeId);
    }
    const unused: WorktreeId[] = [];
    for (const project of this.deps.folderRegistry.targets()) {
      const deleted = registry.recordsOfProject(project.fsPath).filter((r) => r.deletedAt !== undefined);
      if (deleted.length === 0) continue;
      for (const stored of await this.deps.completeStoredSessionsOf(project.key)) if (stored.worktree) named.add(stored.worktree.worktreeId);
      for (const record of deleted) {
        if (!named.has(record.id) && !(await holdsSessionFile(piSessionDir(record.workingFolder)))) unused.push(record.id);
      }
    }
    if (unused.length > 0) await registry.removeDeleted(unused);
  }

  /**
   * The other chats of the project whose latest worktree entry places them in `worktreeId`. A loaded chat's live entries
   * decide for it; every other chat is read from its stored file's latest entry.
   */
  private async sharedWith(worktreeId: string, projectPath: string, sessionId: string | undefined): Promise<number> {
    const projectKey = folderKey(projectPath);
    const inWorktree = new Map<string, boolean>();
    for (const stored of await this.deps.storedSessionsOf(projectKey)) {
      inWorktree.set(stored.id, stored.worktree?.worktreeId === worktreeId && stored.worktree.place === 'worktree');
    }
    for (const instance of this.deps.panels().values()) {
      const id = instance.session.currentSessionId;
      const entry = instance.session.worktree.entry();
      if (id === null || entry === undefined || folderKey(entry.projectPath) !== projectKey) continue;
      inWorktree.set(id, entry.worktreeId === worktreeId && entry.place === 'worktree');
    }
    if (sessionId !== undefined) inWorktree.delete(sessionId);
    return [...inWorktree.values()].filter(Boolean).length;
  }

  /** D30's opt-in for an empty chat in a project folder; nothing is created until its first send. */
  async setOptIn(panelId: string, optIn: WorktreeOptIn): Promise<void> {
    const host = this.host();
    const instance = this.deps.panels().get(panelId);
    if (!host || !instance) throw new Error('Worktree chats are not available here');
    if (instance.folder.ownerKey !== undefined || instance.session.hasConversation()) throw new Error('Only a new chat in a project folder can opt in');
    const runner = host.git();
    if (!runner || !this.deps.platform.trust.isTrusted(instance.folder.fsPath)) throw new Error(t('Trust this folder to use worktrees'));
    // D9 and D30: worktrees are offered where source control has the project's repository open.
    if (host.projectRepository(instance.folder.fsPath) === undefined) throw new Error(t("This folder isn't in a git repository"));
    const options = await worktreeOptions(runner, instance.folder.fsPath);
    if (!options.available) throw new Error(options.reason === 'notGit' ? t("This folder isn't in a git repository") : t('This repository has no commits yet'));
    const start = options.branches.find((b) => b.ref === optIn.startRef);
    if (!start) throw new Error(`Unknown start ref ${optIn.startRef}`);
    const bring = optIn.bringChanges && start.current && options.uncommittedCount > 0;
    this.optIns.set(panelId, {
      startRef: optIn.startRef,
      bringChanges: bring,
      view: { phase: 'pending', branch: start.name, ...(bring ? { uncommittedCount: options.uncommittedCount } : {}) },
      unused: true,
    });
    this.publish(panelId);
  }

  /**
   * Rule 4: a send is held while the chat's worktree is created and set up, and returned while a first prompt already waits.
   * True when core took the send. D33's refusal during a finish action is the session's (`PiSession.promptPi`).
   */
  interceptSend(panelId: string, message: WebviewToExtensionMessage): boolean {
    if (message.type !== 'sendMessage') return false;
    const state = this.optIns.get(panelId);
    if (!state) return false;
    if (state.held !== undefined) {
      this.returnPrompt(panelId, message, 'heldPromptWaiting');
      return true;
    }
    // The webview shows a send as running until the host says otherwise; a held prompt runs no turn yet.
    this.deps.post(panelId, { type: 'processing', isProcessing: false });
    state.held = message;
    state.view = { ...state.view, heldPrompt: heldSummary(message) };
    if (state.view.phase === 'pending') void this.create(panelId);
    else this.publish(panelId);
    return true;
  }

  private returnPrompt(panelId: string, message: SendMessage, reason: PromptReturnReason): void {
    this.deps.post(panelId, { type: 'processing', isProcessing: false });
    this.deps.post(panelId, { type: 'promptReturned', content: contentBlocks(message.content), reason });
  }

  /** The first prompt the panel holds, text and images, for the host to keep as the chat's draft; undefined when none. */
  heldPrompt(panelId: string): UserContentBlock[] | undefined {
    const held = this.optIns.get(panelId)?.held;
    return held ? contentBlocks(held.content) : undefined;
  }

  async action(panelId: string, action: WorktreeAction): Promise<void> {
    const state = this.optIns.get(panelId);
    const instance = this.deps.panels().get(panelId);
    if (!instance) return;
    switch (action) {
      case 'cancelOptIn':
        if (state?.view.phase === 'pending' && state.held === undefined) {
          this.optIns.delete(panelId);
          this.publish(panelId);
        }
        return;
      case 'sendNow':
        if (state?.view.phase === 'settingUp' || state?.view.phase === 'setupFailed') await this.releaseHeld(panelId);
        return;
      case 'retry':
        if (state?.view.phase === 'createFailed') await this.create(panelId);
        else if (state?.view.phase === 'setupFailed' && state.worktreeId !== undefined) await this.runSetup(state.worktreeId);
        return;
      case 'runInProjectFolder':
        if (state?.view.phase === 'createFailed' || state?.view.phase === 'pending') {
          this.optIns.delete(panelId);
          if (state.held) await this.deps.dispatch(panelId, state.held);
          this.publish(panelId);
        }
        return;
      case 'newChatInProject': {
        const project = instance.session.worktree.entry()?.projectPath ?? instance.folder.fsPath;
        this.host()?.newChatInProject(project);
        return;
      }
      case 'showSetupTerminal': {
        const worktreeId = state?.worktreeId ?? instance.session.worktree.inLiveWorktree()?.id;
        if (worktreeId !== undefined) this.host()?.showSetupTerminal(worktreeId);
        return;
      }
      case 'newChatInWorktree': {
        const live = instance.session.worktree.inLiveWorktree();
        if (live && instance.session.worktree.place() === 'worktree') this.host()?.newChatInWorktree(live.projectPath, live.id);
        return;
      }
    }
  }

  /** The Setup terminal's Restart: runs the worktree's setup again, whether or not its first prompt was sent (D32). */
  async retrySetup(worktreeId: WorktreeId): Promise<void> {
    await this.runSetup(worktreeId);
  }

  private async create(panelId: string): Promise<void> {
    const state = this.optIns.get(panelId);
    if (!state) return;
    const creating = this.makeWorktree(panelId, state);
    state.creating = creating;
    const record = await creating;
    if (state.creating === creating) delete state.creating;
    // A chat that closed meanwhile has its worktree discarded instead (discardIfUnused).
    if (record && this.optIns.get(panelId) === state) await this.runSetup(record.id);
  }

  // The worktree the chat now works in, or undefined when creation failed or the chat went away (what it made is then discarded).
  private async makeWorktree(panelId: string, state: OptInState): Promise<ChatWorktreeRecord | undefined> {
    const host = this.host();
    const instance = this.deps.panels().get(panelId);
    const runner = host?.git();
    if (!host || !instance || !runner) return undefined;
    const project = instance.folder;
    state.view = { phase: 'creating', ...keptFields(state.view), ...(state.view.uncommittedCount !== undefined ? { uncommittedCount: state.view.uncommittedCount } : {}) };
    this.publish(panelId);
    let record: ChatWorktreeRecord | undefined;
    try {
      if (!this.deps.platform.trust.isTrusted(project.fsPath)) throw new Error(t('Trust this folder to use worktrees'));
      // Read before anything is created, so a malformed file leaves no worktree behind, and the array the dialog shows is the
      // array that runs.
      const commands = await readSetupCommands(project.fsPath);
      const created = await createChatWorktree({ git: runner, registry: host.registry, projectPath: project.fsPath, startRef: state.startRef, bringChanges: state.bringChanges, slugSource: heldText(state.held), branchPrefix: host.branchPrefix() });
      record = created.record;
      this.reportSkippedLinks(created.skippedLinks);
      if (this.optIns.get(panelId) !== state) {
        // The chat closed, or left its project, while the worktree was being created.
        await discardChatWorktree(runner, host.registry, record);
        return undefined;
      }
      state.worktreeId = record.id;
      this.setups.set(record.id, { record, commands, run: 0 });
      const moved = await this.bindTo(panelId, project, record);
      if (this.optIns.get(panelId) !== state) {
        await this.discardUnused(record);
        return undefined;
      }
      if (!moved || moved.folder.key !== folderKey(record.workingFolder)) throw new Error(t('Damocles could not start a session in the worktree'));
    } catch (err) {
      log('[PanelWorktrees] creating the worktree of %s failed: %O', panelId, err);
      // A worktree the chat never landed in goes with the failure, so a Retry never leaves one behind.
      const made = record;
      if (made && this.deps.panels().get(panelId)?.folder.key !== folderKey(made.workingFolder)) {
        await this.discardUnused(made).catch((discardErr: unknown) => log('[PanelWorktrees] discarding the unused worktree %s failed: %O', made.worktreeRoot, discardErr));
      }
      if (this.optIns.get(panelId) !== state) return undefined;
      delete state.worktreeId;
      state.view = { phase: 'createFailed', ...(state.view.branch !== undefined ? { branch: state.view.branch } : {}), ...(state.view.heldPrompt ? { heldPrompt: state.view.heldPrompt } : {}), error: gitMessage(err) };
      this.publish(panelId);
      return undefined;
    }
    return record;
  }

  // A worktree no session used: its setup goes with it. Discarded once, whichever of the closing panel and the failed creation
  // comes first, and only after its Setup terminal and the chat's session there stopped (rule 14's close-then-remove order).
  private async discardUnused(record: ChatWorktreeRecord): Promise<void> {
    const host = this.host();
    const runner = host?.git();
    if (!this.setups.delete(record.id)) return;
    if (!host || !runner) throw new Error(`Could not discard the unused worktree ${record.worktreeRoot}: git is not available`);
    host.stopSetup(record.id);
    await this.whenFolderReleased(record.workingFolder);
    await discardChatWorktree(runner, host.registry, record);
  }

  private warn(message: string): void {
    this.deps.platform.notifications.warn(message).catch((err: unknown) => log('[PanelWorktrees] the notice "%s" failed: %O', message, err));
  }

  private reportSkippedLinks(links: readonly string[]): void {
    if (links.length === 0) return;
    this.deps.platform.notifications
      .warn(t('Windows needs Developer Mode to create symbolic links, so these links were not copied to the worktree: {0}', links.map(visibleText).join(', ')))
      .catch((err: unknown) => log('[PanelWorktrees] the skipped-links notice failed: %O', err));
  }

  /** Registers `fsPath` as owned by `ownerKey`, cancelling a release of it still waiting. */
  private acquire(fsPath: string, ownerKey: string): Disposable {
    const hold = this.deps.folderRegistry.acquireOwned(fsPath, ownerKey);
    const key = folderKey(fsPath);
    const pending = this.pendingReleases.get(key);
    if (pending) {
      pending.cancelled = true;
      this.pendingReleases.delete(key);
    }
    return hold;
  }

  // Registers the working folder as owned by the project and moves the panel there; a fresh session records the entry.
  private async bindTo(panelId: string, project: FolderTarget, record: ChatWorktreeRecord, afterSwitch?: (instance: HostInstance) => Promise<void>): Promise<HostInstance | undefined> {
    const key = folderKey(record.workingFolder);
    const hold = this.acquire(record.workingFolder, project.key);
    let moved: HostInstance | undefined;
    try {
      moved = await this.deps.moveTo(panelId, key, afterSwitch);
    } finally {
      if (moved && moved.folder.key === key) this.setHold(panelId, key, hold);
      else this.release(key, hold);
    }
    return moved;
  }

  private setHold(panelId: string, key: string, hold: Disposable): void {
    const previous = this.holds.get(panelId);
    this.holds.set(panelId, { key, hold });
    if (previous) this.release(previous.key, previous.hold);
  }

  private async runSetup(worktreeId: WorktreeId): Promise<void> {
    const setup = this.setups.get(worktreeId);
    const host = this.host();
    if (!setup || !host) return;
    const live = host.registry.get(worktreeId);
    if (live?.kind !== 'chat' || live.deletedAt !== undefined) {
      this.setups.delete(worktreeId);
      return;
    }
    const { record, commands } = setup;
    if (commands.length === 0) {
      await this.releaseHeldOf(worktreeId);
      return;
    }
    // The commands are repository-authored (D32), and trust can be revoked before a Retry or Restart.
    if (!this.deps.platform.trust.isTrusted(record.projectPath)) {
      this.warn(t('Trust this folder to use worktrees'));
      this.updateHolding(worktreeId, (view) => ({ phase: 'setupFailed', exitCode: -1, ...keptFields(view) }));
      return;
    }
    const global = this.deps.platform.state.global;
    if (!isSetupApproved(global, record.projectPath, commands)) {
      const projectName = this.deps.folderRegistry.resolve(folderKey(record.projectPath))?.name ?? record.projectPath;
      const choice = await host.reviewSetup({ projectPath: record.projectPath, projectName, commands });
      if (choice === 'skip') {
        await this.releaseHeldOf(worktreeId);
        return;
      }
      await approveSetup(global, record.projectPath, commands);
    }
    const run = ++setup.run;
    this.updateHolding(worktreeId, (view) => ({ phase: 'settingUp', ...keptFields(view) }));
    let exitCode: number;
    try {
      ({ exitCode } = await host.runSetup(
        { worktreeId, cwd: record.workingFolder, commands, env: worktreeEnvironment(record) },
        (step: SetupStep) => {
          if (setup.run === run) this.updateHolding(worktreeId, (view) => (view.phase === 'settingUp' ? { ...view, setupStep: { ...step } } : view));
        },
      ));
    } catch (err) {
      log('[PanelWorktrees] the setup of %s failed to run: %O', record.worktreeRoot, err);
      exitCode = -1;
    }
    // A Restart started a newer run, which reports instead.
    if (setup.run !== run) return;
    if (exitCode === 0) {
      await this.releaseHeldOf(worktreeId);
      return;
    }
    this.updateHolding(worktreeId, (view) => (view.phase === 'settingUp' ? { phase: 'setupFailed', exitCode, ...keptFields(view) } : view));
  }

  // The views of the panels holding a first prompt for this worktree.
  private updateHolding(worktreeId: WorktreeId, next: (view: PanelWorktreeView) => PanelWorktreeView): void {
    for (const [panelId, state] of this.optIns) {
      if (state.worktreeId !== worktreeId) continue;
      state.view = next(state.view);
      this.publish(panelId);
    }
  }

  private async releaseHeldOf(worktreeId: WorktreeId): Promise<void> {
    const panels = [...this.optIns].filter(([, state]) => state.worktreeId === worktreeId).map(([panelId]) => panelId);
    for (const panelId of panels) await this.releaseHeld(panelId);
  }

  private async releaseHeld(panelId: string): Promise<void> {
    const state = this.optIns.get(panelId);
    if (!state) return;
    this.optIns.delete(panelId);
    this.publish(panelId);
    if (state.worktreeId !== undefined) this.markUsed(state.worktreeId);
    // The move to the worktree gave the chat a new session, and the held first prompt starts the conversation there.
    if (state.held) await this.deps.dispatch(panelId, { ...state.held, sessionId: null });
  }

  /** A worktree a chat worked in is no leftover, even once its chats are gone. */
  markUsed(worktreeId: WorktreeId): void {
    this.host()?.registry.markUsed(worktreeId).catch((err: unknown) => log('[PanelWorktrees] recording that %s is used failed: %O', worktreeId, err));
  }

  /** Where the panel works now, for a webview waiting to hear it; the live publisher refines it once the session starts. */
  placeOf(panelId: string): WorktreeStateData | null {
    const instance = this.deps.panels().get(panelId);
    const project = instance ? this.deps.folderRegistry.projectOf(instance.folder.key) : undefined;
    if (!instance || !project || !this.showsWorktreeState(project.fsPath)) return null;
    const view = this.optIns.get(panelId)?.view;
    if (instance.folder.ownerKey !== undefined) {
      const record = this.host()?.registry.liveChatRecordAt(instance.folder.fsPath);
      const projectName = this.deps.folderRegistry.resolve(instance.folder.ownerKey)?.label;
      return { phase: view?.phase ?? 'ready', place: 'worktree', canHandOff: false, ...(record ? { branch: record.branch } : {}), ...(projectName !== undefined ? { projectName } : {}) };
    }
    return { phase: view?.phase ?? 'none', place: 'project', canHandOff: false, ...(view?.branch !== undefined ? { branch: view.branch } : {}) };
  }

  /** The panel's opt-in view, for a chat that has not sent its first prompt yet. */
  viewOf(panelId: string): PanelWorktreeView | undefined {
    return this.optIns.get(panelId)?.view;
  }

  /**
   * Binds a panel being set up to the live chat worktree `worktreeId` of the open project `projectKey`, before its first
   * session is created, so that session starts in the working folder and records the worktree entry, as `/clear` does.
   * Resolves the folder the panel targets. Throws for any other record, an untrusted project or a missing folder. The caller
   * marks the worktree used once the session is created.
   */
  bindNewPanel(panelId: string, projectKey: string, worktreeId: string): FolderTarget {
    const host = this.host();
    if (!host) throw new Error('Worktree chats are not available here');
    const project = this.deps.folderRegistry.resolve(projectKey);
    if (!project || project.ownerKey !== undefined || !project.projectScope) throw new Error(`The project ${projectKey} is not open`);
    if (!this.deps.platform.trust.isTrusted(project.fsPath)) throw new Error(t('Trust this folder to use worktrees'));
    const record = host.registry.get(worktreeId);
    if (record?.kind !== 'chat' || record.deletedAt !== undefined || folderKey(record.projectPath) !== project.key) throw new Error(`${worktreeId} is not a live chat worktree of ${project.fsPath}`);
    if (!fs.existsSync(record.workingFolder)) throw new Error(t("This chat's worktree was deleted"));
    if (this.finishing.has(record.id)) throw new Error(t('Apply, Merge, Update or Delete is running on this worktree. Try again when it ends.'));
    const key = folderKey(record.workingFolder);
    this.setHold(panelId, key, this.acquire(record.workingFolder, project.key));
    const target = this.deps.folderRegistry.resolve(key);
    if (!target) throw new Error(`${record.workingFolder} is not registered`);
    return target;
  }

  private isFinishing(worktreeId: WorktreeId | undefined): boolean {
    return worktreeId !== undefined && this.finishing.has(worktreeId);
  }

  /**
   * D33: holds worktree `worktreeId` for a finish action. Undefined, holding nothing, when a loaded chat working in it is busy
   * by D33 now or a hand-off moves a chat into or out of it. While held, its chats show `finishing` and their sends are refused.
   */
  beginFinish(worktreeId: WorktreeId, action: WorktreeFinishAction): Disposable | undefined {
    const chats = [...this.deps.panels()].filter(([, instance]) => instance.session.worktree.inLiveWorktree()?.id === worktreeId);
    if (this.movingWorktrees.has(worktreeId) || chats.some(([panelId, instance]) => instance.session.worktree.busy() || this.movingPanels.has(panelId))) return undefined;
    if (this.finishing.has(worktreeId)) throw new Error(`A finish action already runs on ${worktreeId}`);
    this.finishing.set(worktreeId, action);
    for (const [panelId] of chats) this.publish(panelId);
    let released = false;
    return {
      dispose: () => {
        if (released) return;
        released = true;
        this.finishing.delete(worktreeId);
        for (const [panelId, instance] of this.deps.panels()) {
          if (instance.session.worktree.record()?.id === worktreeId) this.publish(panelId);
        }
      },
    };
  }

  /**
   * D61: moves an idle chat between its project folder and its worktree, keeping the conversation (rule 3). Core re-checks
   * that the chat is idle, writable and has a conversation; the user confirms the files that move. Nothing on disk or in the
   * registry changes before the conversation is claimed for the move, and the place entry is written only once the chat
   * runs in the new folder. From the call until the conversation runs in its new folder, the chat and its worktree take no
   * other move and no finish action.
   */
  async chatMove(panelId: string, to: ChatPlace): Promise<void> {
    const host = this.host();
    const instance = this.deps.panels().get(panelId);
    const runner = host?.git();
    if (!host || !instance || !runner) return;
    const session = instance.session;
    const worktree = session.worktree;
    if (worktree.place() === to) return;
    const sessionId = session.storedSessionId;
    const existing = worktree.record();
    if (this.movingPanels.has(panelId) || (existing !== undefined && this.movingWorktrees.has(existing.id))) {
      this.warn(t('This chat is already moving. Try again when the move ends.'));
      return;
    }
    // Why the chat cannot move now: '' once the panel holds another chat, which needs no notice.
    const refusal = (): string | undefined => {
      if (this.deps.panels().get(panelId) !== instance || instance.session !== session) return '';
      if (worktree.readOnly()) return t("This chat's worktree was deleted");
      if (this.isFinishing(worktree.record()?.id)) return t('Apply, Merge, Update or Delete is running on this worktree. Try again when it ends.');
      if (sessionId === null || !session.hasConversation() || worktree.busy() || this.optIns.has(panelId)) return t('The chat can move only while it is idle and has a conversation, so it was not moved.');
      return undefined;
    };
    const refused = (): boolean => {
      const reason = refusal();
      if (reason) this.warn(reason);
      return reason !== undefined;
    };
    if (refused() || sessionId === null) return;
    const projectTarget = this.deps.folderRegistry.projectOf(instance.folder.key);
    if (!projectTarget || !this.deps.platform.trust.isTrusted(projectTarget.fsPath)) {
      this.warn(t('Trust this folder to use worktrees'));
      return;
    }
    if (sessionLeaseBlocker(sessionId)) {
      this.warn(t('This conversation is being written elsewhere, so it was not moved.'));
      return;
    }
    const reusable = existing && existing.deletedAt === undefined && fs.existsSync(existing.workingFolder) ? existing : undefined;
    if (to === 'project' && !reusable) {
      this.warn(t("This chat's worktree was deleted"));
      return;
    }
    const marked: WorktreeId[] = [];
    const markMoving = (worktreeId: WorktreeId): void => {
      this.movingWorktrees.add(worktreeId);
      marked.push(worktreeId);
    };
    this.movingPanels.add(panelId);
    if (reusable) markMoving(reusable.id);
    this.publish(panelId);
    const move: HandOff = { panelId, host, runner, session, sessionId, projectTarget, reusable, refused, markMoving };
    let setup: { readonly record: ChatWorktreeRecord; readonly commands: readonly string[] } | undefined;
    try {
      if (to === 'worktree') setup = await this.handOffToWorktree(move);
      else if (reusable) await this.handOffToProject(move, reusable);
    } finally {
      this.movingPanels.delete(panelId);
      for (const worktreeId of marked) this.movingWorktrees.delete(worktreeId);
      this.publish(panelId);
    }
    if (!setup) return;
    // D32's setup of a worktree the hand-off created, once the conversation runs there; nothing is held.
    this.setups.set(setup.record.id, { record: setup.record, commands: setup.commands, run: 0 });
    this.optIns.set(panelId, { startRef: '', bringChanges: false, view: { phase: 'settingUp', branch: setup.record.branch }, worktreeId: setup.record.id, unused: false });
    await this.runSetup(setup.record.id);
  }

  // The worktree the chat now runs in, with the setup commands still to run there; undefined when it did not move.
  private async handOffToWorktree(move: HandOff): Promise<{ record: ChatWorktreeRecord; commands: readonly string[] } | undefined> {
    const { panelId, host, runner, session, sessionId, projectTarget, reusable } = move;
    const worktree = session.worktree;
    const changed = (await session.chatReviewSnapshot('chat', { fresh: true })).files.map((f) => ({ absolute: f.absolute, outsideEdits: f.outsideEdits }));
    const files = await filesToMove(projectTarget.fsPath, runner, changed);
    // Read before anything is created, so a malformed file refuses before the user is asked.
    const setupCommands = reusable ? [] : await readSetupCommands(projectTarget.fsPath);
    if (!(await host.confirmHandOff({ direction: 'toWorktree', ...(reusable ? { branch: reusable.branch } : {}), files }))) return undefined;
    const claim = this.claimForMove(sessionId);
    if (!claim) return undefined;
    try {
      // A turn or a finish action may have started while the dialog was open.
      if (move.refused()) return undefined;
      let record = reusable;
      let created = false;
      if (!record) {
        const options = await worktreeOptions(runner, projectTarget.fsPath);
        if (!options.available) {
          this.warn(options.reason === 'notGit' ? t("This folder isn't in a git repository") : t('This repository has no commits yet'));
          return undefined;
        }
        // D61: from the current branch's HEAD, or from HEAD's commit on a detached HEAD.
        const startRef = options.branches.find((b) => b.current)?.ref ?? 'HEAD';
        const made = await createChatWorktree({ git: runner, registry: host.registry, projectPath: projectTarget.fsPath, startRef, bringChanges: false, slugSource: worktree.firstPromptText(), branchPrefix: host.branchPrefix() });
        this.reportSkippedLinks(made.skippedLinks);
        record = made.record;
        created = true;
        move.markMoving(record.id);
      }
      try {
        const { skippedLinks } = await moveFilesToWorktree(record, runner, files);
        this.reportSkippedLinks(skippedLinks);
      } catch (err) {
        // Once the project folder's copies may have changed, the worktree holds files that may exist nowhere else.
        if (err instanceof HandOffMoveError && err.sourcesChanged) {
          this.markUsed(record.id);
          await this.deps.platform.notifications.warn(t('The files could not all be moved, so the chat stays in the project folder. Check the files there and in {0}. {1}', visibleText(record.workingFolder), visibleLines(err.message)));
          return undefined;
        }
        if (created) {
          const made = record;
          await discardChatWorktree(runner, host.registry, made).catch((discardErr: unknown) => log('[PanelWorktrees] discarding %s after a failed move failed: %O', made.worktreeRoot, discardErr));
        }
        throw err;
      }
      const live = record;
      // The chat's files are in the worktree now, whether or not the conversation follows them.
      this.markUsed(live.id);
      let resumed = false;
      try {
        await this.bindTo(panelId, projectTarget, live, async (target) => {
          resumed = await this.deps.resumeInto(target, sessionId, (session) => session.noteWorkingFolder(live.workingFolder));
        });
      } catch (err) {
        log('[PanelWorktrees] moving %s to its worktree failed: %O', panelId, err);
      }
      if (!resumed) {
        await this.recoverMove(panelId, sessionId, projectTarget, t('The chat could not move to its worktree, so it stays in the project folder. The moved files are in {0}.', visibleText(live.workingFolder)));
        return undefined;
      }
      return setupCommands.length > 0 ? { record: live, commands: setupCommands } : undefined;
    } finally {
      claim.release();
    }
  }

  private async handOffToProject(move: HandOff, reusable: ChatWorktreeRecord): Promise<void> {
    const { panelId, host, runner, session, sessionId, projectTarget } = move;
    // A clash refuses before anything is confirmed; Apply re-checks it after the confirmation.
    const { clashes } = await applyPlan(reusable, runner);
    if (clashes.length > 0) {
      await host.showRefusal({ kind: 'handOff', files: clashes });
      return;
    }
    const changed = (await session.chatReviewSnapshot('chat', { fresh: true })).files.map((f) => ({ path: f.path, letter: f.status, alsoUserEdits: false }));
    if (!(await host.confirmHandOff({ direction: 'toProject', branch: reusable.branch, files: changed }))) return;
    const claim = this.claimForMove(sessionId);
    if (!claim) return;
    let conflicts: readonly string[] = [];
    try {
      if (move.refused()) return;
      const outcome = await apply(reusable, runner, host.registry);
      if (outcome.kind === 'refused') {
        await host.showRefusal({ kind: 'handOff', files: outcome.files });
        return;
      }
      // The chat still moves: the conflicted files are the project folder's to resolve, as after the Apply command.
      if (outcome.kind === 'conflicts') conflicts = outcome.files;
      let resumed = false;
      let moved: HostInstance | undefined;
      try {
        moved = await this.deps.moveTo(panelId, projectTarget.key, async (target) => {
          resumed = await this.deps.resumeInto(target, sessionId, (session) => {
            session.worktree.appendPlace('project', reusable);
            session.noteWorkingFolder(projectTarget.fsPath);
          });
        });
      } catch (err) {
        log('[PanelWorktrees] moving %s to its project folder failed: %O', panelId, err);
      }
      if (!resumed) {
        await this.recoverMove(panelId, sessionId, reusable, t('The chat could not move to the project folder, so it stays in its worktree. Its changes were applied to {0}.', visibleText(projectTarget.fsPath)));
      } else if (moved && moved.folder.key === projectTarget.key) {
        this.dropHold(panelId);
      }
    } finally {
      claim.release();
    }
    if (conflicts.length > 0) await host.showApplyConflicts(reusable, conflicts);
  }

  // Keeps the conversation's lease in this process from before the first change until the moved session holds it.
  private claimForMove(sessionId: string): { release(): void } | undefined {
    const holder: SessionLeaseHolder = { onSessionLeaseLost: () => log('[PanelWorktrees] lost the lease of %s while moving it', sessionId) };
    if (!acquireSessionLease(sessionId, holder)) {
      this.warn(t('This conversation is being written elsewhere, so it was not moved.'));
      return undefined;
    }
    return { release: () => releaseSessionLease(sessionId, holder) };
  }

  /**
   * A move whose resume failed puts the conversation back where it was. A switch that failed before it landed already
   * resumed it there (recoverSession); one that landed with an empty session moves back and resumes there.
   */
  private async recoverMove(panelId: string, sessionId: string, back: FolderTarget | ChatWorktreeRecord, message: string): Promise<void> {
    const instance = this.deps.panels().get(panelId);
    const backKey = 'kind' in back ? folderKey(back.workingFolder) : back.key;
    if (instance && instance.folder.key !== backKey) {
      const resume = async (target: HostInstance): Promise<void> => {
        await this.deps.resumeInto(target, sessionId);
      };
      if ('kind' in back) {
        const project = this.deps.folderRegistry.resolve(folderKey(back.projectPath));
        if (project) await this.bindTo(panelId, project, back, resume);
      } else {
        const returned = await this.deps.moveTo(panelId, back.key, resume);
        if (returned && returned.folder.key === back.key) this.dropHold(panelId);
      }
    }
    await this.deps.platform.notifications.warn(message);
  }

  /**
   * Rule 2 and AD12's resume binding: the folder a stored session resumes in is its latest entry's, a live chat worktree's
   * working folder registered as owned; anything else (a deleted or vanished worktree, an adopted worktree's chat) binds to
   * the project. The state is the stored file's, which the webview hears before the replay.
   */
  async resumeFolder(panelId: string, sessionId: string, project: FolderTarget): Promise<ResumeBinding> {
    const host = this.host();
    const inProject = (state?: WorktreeStateData | null): ResumeBinding => ({ folder: project, ...(state !== undefined ? { state } : {}), settle: () => undefined });
    if (!host) return inProject();
    // Only a chat the live publisher would show has a state; a read-only chat always does.
    const shown = this.showsWorktreeState(project.fsPath);
    const none: WorktreeStateData | null = shown ? { phase: 'none', place: 'project', canHandOff: false } : null;
    const sessionFile = await resolvePiSessionFile(project.fsPath, sessionId);
    if (sessionFile === null) return inProject(none);
    const entry = await readLatestWorktreeEntry(sessionFile);
    if (entry === undefined) {
      // A chat of a deleted adopted worktree is history only (rule 18), as SessionWorktree.readOnly reads it.
      const dir = folderKey(piSessionDir(project.fsPath));
      const sessionDir = folderKey(path.dirname(sessionFile));
      const adoptedDeleted = sessionDir !== dir && host.registry.records().some((r) => r.kind === 'adopted' && r.deletedAt !== undefined && folderKey(piSessionDir(r.workingFolder)) === sessionDir);
      return inProject(adoptedDeleted ? { phase: 'deleted', place: 'project', canHandOff: false } : none);
    }
    const record = host.registry.get(entry.worktreeId);
    const chat = record?.kind === 'chat' ? record : undefined;
    const projectName = project.label;
    const branch = chat ? { branch: chat.branch } : {};
    if (entry.place === 'project') return inProject(shown ? { phase: 'none', place: 'project', canHandOff: false, projectName, ...branch } : null);
    // A working folder removed outside Damocles reads as deleted.
    if (!chat || chat.deletedAt !== undefined || folderKey(chat.projectPath) !== project.key || !fs.existsSync(chat.workingFolder)) {
      return inProject({ phase: 'deleted', place: 'worktree', canHandOff: false, projectName, ...branch });
    }
    const key = folderKey(chat.workingFolder);
    // Registered now, so the switch finds the folder; the panel's own hold changes only once it works there.
    const hold = this.acquire(chat.workingFolder, project.key);
    const folder = this.deps.folderRegistry.resolve(key);
    if (!folder) {
      this.release(key, hold);
      throw new Error(`${chat.workingFolder} is not registered`);
    }
    let settled = false;
    const settle = (landed: HostInstance | undefined): void => {
      if (settled) return;
      settled = true;
      if (landed?.folder.key === key) this.setHold(panelId, key, hold);
      else this.release(key, hold);
    };
    return { folder, state: shown ? { phase: 'ready', place: 'worktree', canHandOff: false, projectName, branch: chat.branch } : null, settle };
  }

  // SessionWorktree.compute's rule: a trusted project with a repository source control has open (D9).
  private showsWorktreeState(projectPath: string): boolean {
    return this.deps.platform.trust.isTrusted(projectPath) && this.host()?.projectRepository(projectPath) !== undefined;
  }

  /** The panel moved to another folder outside a worktree move; its opt-in, and any first prompt it held, go. */
  folderChanged(panelId: string): void {
    const state = this.optIns.get(panelId);
    if (!state) return;
    this.optIns.delete(panelId);
    if (state.held) this.returnPrompt(panelId, state.held, 'heldPromptKept');
    void this.discardIfUnused(state);
    this.publish(panelId);
  }

  /** The panel left the folder it held (a move, a close): its registration goes, and the folder is released once unheld. */
  dropHold(panelId: string): void {
    const held = this.holds.get(panelId);
    if (!held) return;
    this.holds.delete(panelId);
    this.release(held.key, held.hold);
  }

  /** The panel closed: its opt-in and hold go, and a worktree it created that no session used is discarded. */
  panelClosed(panelId: string): void {
    const state = this.optIns.get(panelId);
    this.optIns.delete(panelId);
    this.dropHold(panelId);
    if (state) {
      const discarded = this.discardIfUnused(state);
      this.closedDiscards.set(panelId, discarded);
      void discarded.then(() => {
        if (this.closedDiscards.get(panelId) === discarded) this.closedDiscards.delete(panelId);
      });
    }
    this.publishOthers(panelId);
  }

  /**
   * Settles once the worktree a closed panel was creating or setting up for its first prompt is discarded, after its creation
   * ended, its Setup terminal stopped and its session there closed; at once when there is none. A discard git refuses is
   * logged and leaves the worktree for the leftover scan.
   */
  whenDiscarded(panelId: string): Promise<void> {
    return this.closedDiscards.get(panelId) ?? Promise.resolve();
  }

  // Never rejects. A creation in flight finishes first, so the discard never races the chat's move into the worktree.
  private discardIfUnused(state: OptInState): Promise<void> {
    const creating = state.creating;
    if (creating) return creating.then(() => this.discardMade(state), () => this.discardMade(state));
    return this.discardMade(state);
  }

  private async discardMade(state: OptInState): Promise<void> {
    if (!state.unused || state.worktreeId === undefined) return;
    const setup = this.setups.get(state.worktreeId);
    if (!setup) return;
    await this.discardUnused(setup.record).catch((err: unknown) => log('[PanelWorktrees] discarding the unused worktree %s failed: %O', setup.record.worktreeRoot, err));
  }

  private release(key: string, hold: Disposable): void {
    hold.dispose();
    if (this.deps.folderRegistry.resolve(key)) return;
    const pending = { cancelled: false };
    this.pendingReleases.set(key, pending);
    const previous = this.releasing.get(key) ?? Promise.resolve();
    const done = previous
      .then(() => this.deps.sessionsClosed())
      .then(() => {
        if (this.pendingReleases.get(key) === pending) this.pendingReleases.delete(key);
        // A chat bound to the folder again meanwhile keeps its services.
        if (pending.cancelled || this.deps.folderRegistry.resolve(key)) return;
        return this.deps.releaseFolder(key);
      })
      .catch((err: unknown) => log('[PanelWorktrees] releasing %s failed: %O', key, err));
    this.releasing.set(key, done);
    void done.then(() => {
      if (this.releasing.get(key) === done) this.releasing.delete(key);
    });
  }

  /** Settles once no panel holds `fsPath` and its per-folder services are released (rule 14); at once when nothing holds it. */
  async whenFolderReleased(fsPath: string): Promise<void> {
    const key = folderKey(fsPath);
    await this.deps.sessionsClosed();
    await (this.releasing.get(key) ?? Promise.resolve());
  }

  /** Core is shutting down and disposes every folder's services itself, so nothing is released here. */
  dispose(): void {
    for (const { hold } of this.holds.values()) hold.dispose();
    this.holds.clear();
    for (const pending of this.pendingReleases.values()) pending.cancelled = true;
    this.pendingReleases.clear();
    this.optIns.clear();
    this.closedDiscards.clear();
    this.setups.clear();
    this.finishing.clear();
    this.movingPanels.clear();
    this.movingWorktrees.clear();
    this.listeners.clear();
  }
}

// Fields a holding phase keeps from the one before it.
function keptFields(view: PanelWorktreeView): Pick<PanelWorktreeView, 'branch' | 'heldPrompt'> {
  return { ...(view.branch !== undefined ? { branch: view.branch } : {}), ...(view.heldPrompt !== undefined ? { heldPrompt: view.heldPrompt } : {}) };
}

function contentBlocks(content: string | UserContentBlock[]): UserContentBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

function heldSummary(message: SendMessage): { text: string; imageCount: number } {
  const blocks = contentBlocks(message.content);
  return {
    text: blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n').slice(0, MAX_HELD_TEXT),
    imageCount: blocks.filter((block) => block.type === 'image').length,
  };
}

function heldText(message: SendMessage | undefined): string {
  return message ? heldSummary(message).text : '';
}

// A stored session's file sits directly in its folder's session directory; one that does not exist holds none.
async function holdsSessionFile(dir: string): Promise<boolean> {
  try {
    return (await fs.promises.readdir(dir)).some((name) => name.endsWith('.jsonl'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
