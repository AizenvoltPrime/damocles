import type { CatalogResult } from '../../core/chat-panel/session-catalog';
import type { PanelWorktreeStateEvent } from '../../core/chat-panel/panel-worktrees';
import type { ChatChangeTotals } from '../../core/pi-session/chat-review';
import type { ChatActivity, TurnOutcome } from '../../core/pi-session/session-state';
import type { UsageThresholdCrossing } from '../../core/pi-session/usage-thresholds';
import type { Disposable } from '../../platform/disposable';
import type { InputBoxOptions } from '../../platform/dialog-service';
import type { ChatAttachmentInput } from '../../shared/types/chat-attachment';
import type { UserContentBlock } from '../../shared/types/content';
import type { ChatPlace, ChatReviewScope, ExtensionToWebviewMessage, WebviewToExtensionMessage, WorktreeFinishAction } from '../../shared/types/messages';
import type { StoredSession } from '../../shared/types/session';
import type { ChatEntry, ChatPermissions, FolderTargetEntry, MainRequests, MentionTargetData, RepositoryCall, ScmCall, ScmMirrorPatch, WorktreeCall } from '../core-protocol';
import type { MainEndpoint } from '../core-protocol';
import type { ReviewSession } from './chat-review-host';
import type { RelayView } from './core-services/host-services';
import { finishHold, type FinishHold } from './worktrees/engine';

type Params<M extends keyof MainRequests> = MainRequests[M]['params'];
type Result<M extends keyof MainRequests> = MainRequests[M]['result'];

/**
 * Main's view of one running Damocles Core (docs/invariants.md "Desktop host"): the chats and folder targets core pushes,
 * read synchronously, core's events, and requests. A decision that needs core's exact state is a request core decides;
 * main never reads this mirror and then acts on the engine with it.
 */
export class CoreClient implements Disposable {
  private readonly endpoint: MainEndpoint;
  private readonly adoptView: <T>(view: RelayView, attach: () => Promise<T>) => Promise<T>;
  private readonly chatsById = new Map<string, ChatEntry>();
  private readonly chatsByView = new Map<string, ChatEntry>();
  private folders: { readonly defaultKey: string; readonly targets: ReadonlyMap<string, FolderTargetEntry> } | undefined;
  private readonly subscriptions: Disposable[];
  private readonly foldersListeners = new Set<() => void>();

  constructor(endpoint: MainEndpoint, adoptView: <T>(view: RelayView, attach: () => Promise<T>) => Promise<T>) {
    this.endpoint = endpoint;
    this.adoptView = adoptView;
    this.subscriptions = [
      endpoint.onMirror('chats', ({ panelId, entry }) => {
        const previous = this.chatsById.get(panelId);
        if (previous) this.chatsByView.delete(previous.viewId);
        if (!entry) {
          this.chatsById.delete(panelId);
          return;
        }
        this.chatsById.set(panelId, entry);
        this.chatsByView.set(entry.viewId, entry);
      }),
      endpoint.onMirror('folderTargets', ({ defaultKey, targets }) => {
        this.folders = { defaultKey, targets: new Map(targets.map((target) => [target.key, target])) };
        for (const listener of [...this.foldersListeners]) listener();
      }),
    ];
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.foldersListeners.clear();
  }

  // ---- the chats mirror

  /** A chat core registered, by core panel id. */
  chat(panelId: string): ChatEntry | undefined {
    return this.chatsById.get(panelId);
  }

  /** The chat core registered on a view, by view id. */
  chatOfView(viewId: string): ChatEntry | undefined {
    return this.chatsByView.get(viewId);
  }

  chats(): readonly ChatEntry[] {
    return [...this.chatsById.values()];
  }

  // ---- the folder targets mirror (WorkspaceFolderRegistry)

  defaultTarget(): FolderTargetEntry | undefined {
    return this.folders?.targets.get(this.folders.defaultKey);
  }

  // a project, or a working folder a loaded chat holds
  resolve(key: string): FolderTargetEntry | undefined {
    return this.folders?.targets.get(key);
  }

  // the project target holding key: itself for a project, its owner for an owned folder
  projectOf(key: string): FolderTargetEntry | undefined {
    const target = this.resolve(key);
    return target?.ownerKey !== undefined ? this.resolve(target.ownerKey) : target;
  }

  branchOf(key: string): string | undefined {
    return this.resolve(key)?.branch;
  }

  onFoldersChanged(listener: () => void): Disposable {
    this.foldersListeners.add(listener);
    return { dispose: () => { this.foldersListeners.delete(listener); } };
  }

  // ---- events

  onActivity(listener: (panelId: string, activity: ChatActivity) => void): Disposable {
    return this.endpoint.onEvent('chat.activity', ({ panelId, activity }) => listener(panelId, activity));
  }

  onTurnSettled(listener: (panelId: string, outcome: TurnOutcome) => void): Disposable {
    return this.endpoint.onEvent('chat.turnSettled', ({ panelId, outcome }) => listener(panelId, outcome as TurnOutcome));
  }

  onChatChanges(listener: (panelId: string, totals: ChatChangeTotals, generation: number) => void): Disposable {
    return this.endpoint.onEvent('chat.changes', ({ panelId, totals, generation }) => listener(panelId, totals as ChatChangeTotals, generation));
  }

  onUsageThreshold(listener: (crossing: UsageThresholdCrossing) => void): Disposable {
    return this.endpoint.onEvent('chat.usageThreshold', ({ crossing }) => listener(crossing as UsageThresholdCrossing));
  }

  onWorktreeState(listener: (event: PanelWorktreeStateEvent) => void): Disposable {
    return this.endpoint.onEvent('chat.worktreeState', ({ event }) => listener(event));
  }

  onAllChatsClosed(listener: () => void): Disposable {
    return this.endpoint.onEvent('chat.allClosed', () => listener());
  }

  onTakeover(listener: (sessionId: string) => void): Disposable {
    return this.endpoint.onEvent('chat.takeover', ({ sessionId }) => listener(sessionId));
  }

  onCatalogChanged(listener: (projectKey: string | undefined) => void): Disposable {
    return this.endpoint.onEvent('catalog.changed', ({ projectKey }) => listener(projectKey));
  }

  // ---- chats

  /**
   * Core attaches to a chat view main created and restores it there; main relays the view's traffic from then on.
   * permissions: what the core before this one published for the chat (KeptPermissions), in place of the defaults.
   */
  restoreChat(view: RelayView, folderKey: string | undefined, permissions?: ChatPermissions): Promise<void> {
    return this.adoptView(view, () => this.request('chats.restore', {
      viewId: view.panelId,
      ...(folderKey !== undefined ? { folderKey } : {}),
      ...(permissions ? { permissions } : {}),
    }));
  }

  startInWorktree(view: RelayView, projectKey: string, worktreeId: string): Promise<void> {
    return this.adoptView(view, () => this.request('chats.startInWorktree', { viewId: view.panelId, projectKey, worktreeId }));
  }

  whenSetUp(viewId: string): Promise<void> {
    return this.request('chats.whenSetUp', { viewId });
  }

  setWorktreeOptIn(panelId: string, startRef: string, bringChanges: boolean): Promise<void> {
    return this.request('chats.setWorktreeOptIn', { panelId, startRef, bringChanges });
  }

  restoreDraft(panelId: string, content: readonly UserContentBlock[]): Promise<void> {
    return this.request('chats.restoreDraft', { panelId, content });
  }

  restorePages(viewId: string, urls: readonly string[], activePage: number | undefined): Promise<void> {
    return this.request('chats.restorePages', { viewId, urls, ...(activePage !== undefined ? { activePage } : {}) });
  }

  mention(panelId: string, target: MentionTargetData): Promise<void> {
    return this.request('chats.mention', { panelId, target });
  }

  addAttachment(panelId: string, attachment: ChatAttachmentInput, prompt: string | undefined): Promise<boolean> {
    return this.request('chats.addAttachment', { panelId, attachment, ...(prompt !== undefined ? { prompt } : {}) });
  }

  handOff(panelId: string, to: ChatPlace): Promise<void> {
    return this.request('chats.handOff', { panelId, to });
  }

  openChat(): Promise<void> {
    return this.request('chats.open', {});
  }

  newSession(): Promise<void> {
    return this.request('chats.newSession', {});
  }

  cancelSession(): Promise<void> {
    return this.request('chats.cancelSession', {});
  }

  postToActive(message: ExtensionToWebviewMessage): Promise<void> {
    return this.request('chats.postToActive', { message });
  }

  post(panelId: string, message: ExtensionToWebviewMessage): Promise<void> {
    return this.request('chats.post', { panelId, message });
  }

  deliver(panelId: string | undefined, selected: string | undefined, chats: readonly string[], message: ExtensionToWebviewMessage): Promise<string> {
    return this.request('chats.deliver', { ...(panelId !== undefined ? { panelId } : {}), ...(selected !== undefined ? { selected } : {}), chats, message });
  }

  whenReady(panelId: string): Promise<boolean> {
    return this.request('chats.whenReady', { panelId });
  }

  /** Core closes the chat only while it still may (idle; with empty set, still without a conversation or file). */
  unload(viewId: string, empty: boolean): Promise<boolean> {
    return this.request('chats.unload', { viewId, empty });
  }

  promptTarget(): Promise<string | undefined> {
    return this.request('chats.promptTarget', {});
  }

  whenFolderReleased(fsPath: string): Promise<void> {
    return this.request('chats.whenFolderReleased', { fsPath });
  }

  whenWorktreeDiscarded(panelId: string): Promise<void> {
    return this.request('chats.whenWorktreeDiscarded', { panelId });
  }

  /** D33's busy rule: a loaded chat of the project, its worktrees' included, is processing or active. */
  projectBusy(projectKey: string): Promise<boolean> {
    return this.request('chats.projectBusy', { projectKey });
  }

  /** Whether another holder keeps the session from opening here; announce tells the user, with a takeover (onTakeover). */
  leaseRefused(sessionId: string, announce: boolean): Promise<boolean> {
    return this.request('chats.leaseRefusal', { sessionId, announce });
  }

  // ---- the session catalog

  async listSessions(projectKey: string, complete = false): Promise<readonly StoredSession[]> {
    return (await this.request('catalog.list', { projectKey, complete })) as readonly StoredSession[];
  }

  async searchSessions(projectKey: string, query: string): Promise<readonly StoredSession[]> {
    return (await this.request('catalog.search', { projectKey, query })) as readonly StoredSession[];
  }

  async renameSession(sessionId: string, name: string): Promise<CatalogResult> {
    return (await this.request('catalog.rename', { sessionId, name })) as CatalogResult;
  }

  async tagSession(sessionId: string, tag: string | null): Promise<CatalogResult> {
    return (await this.request('catalog.tag', { sessionId, tag })) as CatalogResult;
  }

  async deleteSession(sessionId: string): Promise<CatalogResult> {
    return (await this.request('catalog.delete', { sessionId })) as CatalogResult;
  }

  // ---- folders, browser pages, worktrees

  setDefaultFolder(key: string): Promise<void> {
    return this.request('folders.setDefault', { key });
  }

  newBrowserPage(chatViewId: string): Promise<void> {
    return this.request('browser.newPage', { chatViewId });
  }

  retrySetup(worktreeId: string): Promise<void> {
    return this.request('worktree.retrySetup', { worktreeId });
  }

  /**
   * D33's hold of the worktree for a finish action, whose finish calls go to this core alone; undefined, holding nothing,
   * while a chat working there is busy. stopped: this core no longer runs, which a failed finish call is then told as.
   */
  async beginWorktreeFinish(worktreeId: string, action: WorktreeFinishAction, stopped: () => boolean): Promise<FinishHold | undefined> {
    const hold = await this.request('worktree.beginFinish', { worktreeId, action });
    if (hold === undefined) return undefined;
    return finishHold({
      call: (method, args) => this.worktreeCall(method, args),
      stopped,
      worktreeId,
      hold,
      // a core that stopped let go of its holds as it went
      release: () => void this.request('worktree.endFinish', { hold }).catch(() => undefined),
    });
  }

  // ---- chat review (D60) and the settings modal

  /** The chat's review reads while the mirror lists it as loaded. */
  reviewSession(panelId: string): ReviewSession | undefined {
    if (!this.chatsById.has(panelId)) return undefined;
    return {
      chatReviewSnapshot: async (scope, opts) => (await this.request('review.snapshot', { panelId, scope, fresh: opts?.fresh === true })) as Awaited<ReturnType<ReviewSession['chatReviewSnapshot']>>,
      chatReviewFileDiff: async (scope: ChatReviewScope, path) => (await this.request('review.fileDiff', { panelId, scope, path })) as Awaited<ReturnType<ReviewSession['chatReviewFileDiff']>>,
      chatReviewAnchor: (comment) => this.request('review.anchor', { panelId, comment }),
      chatReviewStale: async (checks) => (await this.request('review.stale', { panelId, checks })) as Awaited<ReturnType<ReviewSession['chatReviewStale']>>,
      submitReview: async (drafts) => (await this.request('review.submit', { panelId, drafts })) as Awaited<ReturnType<ReviewSession['submitReview']>>,
    };
  }

  /** Attaches the settings modal to a chat; its posts and its detach arrive for that attachment id until it detaches. */
  attachSettingsView(panelId: string, attachment: number, view: { post(message: ExtensionToWebviewMessage): void; detached(): void }): Promise<Disposable> {
    const subscriptions = [
      this.endpoint.onEvent('settingsView.post', (event) => {
        if (event.attachment === attachment) view.post(event.message as ExtensionToWebviewMessage);
      }),
      this.endpoint.onEvent('settingsView.detached', (event) => {
        if (event.attachment !== attachment) return;
        for (const subscription of subscriptions) subscription.dispose();
        view.detached();
      }),
    ];
    const handle: Disposable = {
      dispose: () => {
        void this.request('settingsView.detach', { attachment }).catch(() => undefined);
      },
    };
    return this.request('settingsView.attach', { panelId, attachment }).then(() => handle, (err: unknown) => {
      for (const subscription of subscriptions) subscription.dispose();
      throw err;
    });
  }

  dispatchSettingsView(attachment: number, message: WebviewToExtensionMessage): Promise<void> {
    return this.request('settingsView.dispatch', { attachment, message });
  }

  // ---- source control and worktrees, which core runs (core-host/scm.ts, worktrees.ts)

  onScmMirror(listener: (patch: ScmMirrorPatch) => void): Disposable {
    return this.endpoint.onMirror('scm', listener);
  }

  // a ScmService event, after the scm mirror shows it
  onScmChanged(listener: (event: unknown) => void): Disposable {
    return this.endpoint.onEvent('scm.changed', ({ event }) => listener(event));
  }

  onWorktreeRecords(listener: (records: readonly unknown[]) => void): Disposable {
    return this.endpoint.onMirror('worktrees', ({ records }) => listener(records));
  }

  onNewChatInWorktree(listener: (projectPath: string, worktreeId: string) => void): Disposable {
    return this.endpoint.onEvent('worktrees.newChatInWorktree', ({ projectPath, worktreeId }) => listener(projectPath, worktreeId));
  }

  onNewChatInProject(listener: (projectPath: string) => void): Disposable {
    return this.endpoint.onEvent('worktrees.newChatInProject', ({ projectPath }) => listener(projectPath));
  }

  /** Commit to a New Branch's name input, for the commit main passed the token with. */
  serveBranchNames(ask: (token: string) => Promise<string | undefined>): void {
    this.endpoint.serve('scm.branchName', ({ token }) => ask(token));
  }

  scmCall(method: ScmCall, args: readonly unknown[]): Promise<unknown> {
    return this.request('scm.call', { method, args });
  }

  scmCommit(repoId: string, message: string, variant: unknown, saved: readonly string[], branchName: string | undefined): Promise<unknown> {
    return this.request('scm.commit', { repoId, message, variant, saved, ...(branchName !== undefined ? { branchName } : {}) });
  }

  scmIgnoredIn(projectKey: string, relativeDir: string, entries: readonly { readonly name: string; readonly dir: boolean }[]): Promise<readonly string[]> {
    return this.request('scm.ignoredIn', { projectKey, relativeDir, entries });
  }

  scmCommitBlob(repoId: string, commit: string, path: string): Promise<Uint8Array | 'tooLarge' | undefined> {
    return this.request('scm.commitBlob', { repoId, commit, path });
  }

  scmGenerateMessage(repoId: string): Promise<unknown> {
    return this.request('scm.generateMessage', { repoId });
  }

  scmRepo(repoId: string, method: RepositoryCall, args: readonly unknown[]): Promise<unknown> {
    return this.request('scm.repo', { repoId, method, args });
  }

  worktreeCall(method: WorktreeCall, args: readonly unknown[]): Promise<unknown> {
    return this.request('worktrees.call', { method, args });
  }

  // ---- lifecycle and the e2e namespace

  shutdown(): Promise<void> {
    return this.request('core.shutdown', {});
  }

  e2eInputBox(options: InputBoxOptions): Promise<string | undefined> {
    return this.request('e2e.inputBox', options);
  }

  e2eRouteBrowser(pattern: string, toHost: string): Promise<void> {
    return this.request('e2e.routeBrowser', { pattern, toHost });
  }

  e2eRoutedRequests(): Promise<readonly string[]> {
    return this.request('e2e.routedRequests', {});
  }

  e2eSetPlatform(platform: string | null): Promise<string> {
    return this.request('e2e.setPlatform', { platform });
  }

  e2eSlowRenames(basename: string, delayMs: number): Promise<void> {
    return this.request('e2e.slowRenames', { basename, delayMs });
  }

  e2eSlowedRenames(basename: string): Promise<number> {
    return this.request('e2e.slowedRenames', { basename });
  }

  e2eHoldShutdown(): Promise<void> {
    return this.request('e2e.holdShutdown', {});
  }

  e2eWatchProbe(folder: string): Promise<readonly string[]> {
    return this.request('e2e.watchProbe', { folder });
  }

  e2eStopWatchProbe(folder: string): Promise<void> {
    return this.request('e2e.stopWatchProbe', { folder });
  }

  private request<M extends keyof MainRequests>(method: M, params: Params<M>): Promise<Result<M>> {
    return this.endpoint.request(method, params as never) as Promise<Result<M>>;
  }
}
