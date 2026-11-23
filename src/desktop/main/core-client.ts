import type { CatalogResult } from '../../core/chat-panel/session-catalog';
import type { PanelWorktreeStateEvent } from '../../core/chat-panel/panel-worktrees';
import type { ChatChangeTotals } from '../../core/pi-session/chat-review';
import type { ChatActivity, TurnOutcome } from '../../core/pi-session/session-state';
import type { SessionFileWrite } from '../../core/pi-session/session-store/session-file-write';
import type { UsageThresholdCrossing } from '../../core/pi-session/usage-thresholds';
import type { Coded, MovedFromCandidate, PreflightAnswer, PreflightRequest, RelocationRequest, RelocationView } from '../../core/project-relocation/types';
import type { ManagedServer } from '../../core/scm/askpass/credential-config';
import type { MatchableServer } from '../../core/forge/remote-url';
import type { ClientForgeServer } from '../../shared/git-credential';
import type { RemoteBranchProtection } from '../../shared/forge/branch-protection';
import type { Disposable } from '../../platform/disposable';
import type { InputBoxOptions } from '../../platform/dialog-service';
import type { ChatAttachmentInput } from '../../shared/types/chat-attachment';
import type { UserContentBlock } from '../../shared/types/content';
import type { ChatPlace, ChatReviewScope, ExtensionToWebviewMessage, WebviewToExtensionMessage, WorktreeFinishAction } from '../../shared/types/messages';
import type { StoredSession } from '../../shared/types/session';
import type { BrokerAnswer, GlobalMemorySearchFilters, HeldAuth, HeldMemoryQueue } from '../../shared/remote-user';
import type { ThemeShowEndReason } from '../../shared/themes/agent';
import type { ThemeShowEnded } from '../../shared/themes/relay';
import type { ThemeInstallPreview, ThemeInstallProgress } from '../../shared/themes/install';
import type { CoreEvents, MirrorHostOs, PushedCredential } from '../core-protocol/messages';
import type { DesignPreviewAnswer, DesignPreviewFile } from '../../shared/types/design';
import type { MarkupJsonInput } from '../../shared/design-markup';
import type { LocalizedText } from '../../shared/localized-text';
import type { ClientCertificateFilter } from '../../shared/client-certificate';
import type { ChatEntry, ChatPermissions, FolderTargetEntry, MainRequests, RepositoryCall, ScmCall, ScmMirrorPatch, WorktreeCall } from '../core-protocol';
import { parsedCallText, SCM_CALL_LOCALIZED_TEXT, WORKTREE_CALL_LOCALIZED_TEXT, type MainEndpoint, type ScmCommitOutcome } from '../core-protocol';
import type { ReviewSession } from './chat-review-host';
import type { RelayView } from './core-services/host-services';
import { finishHold, type FinishHold } from './worktrees/engine';
import type { AuthorityMentionTarget } from './mention-authority';
import { chatEntryToShell, folderTargetToShell, mentionToCore, scmEventToShell, scmPatchToShell, storedSessionToShell, type ProjectKeys } from './remote/remote-project-keys';

type Params<M extends keyof MainRequests> = MainRequests[M]['params'];
type Result<M extends keyof MainRequests> = MainRequests[M]['result'];

/**
 * Main's view of one running Damocles Core (docs/invariants.md "Desktop host"): the chats and folder targets core pushes,
 * read synchronously, core's events, and requests. A decision that needs core's exact state is a request core decides;
 * main never reads this mirror and then acts on the engine with it.
 */
export class CoreClient implements Disposable {
  private readonly endpoint: MainEndpoint;
  // every project key core sends or receives passes through these (remote-project-keys.ts)
  readonly keys: ProjectKeys;
  private readonly adoptView: <T>(view: RelayView, attach: () => Promise<T>) => Promise<T>;
  private readonly chatsById = new Map<string, ChatEntry>();
  private readonly chatsByView = new Map<string, ChatEntry>();
  // a folder key open as a project may also be a working folder another project owns, so the two roles are kept apart
  private folders: { readonly defaultKey: string; readonly projects: ReadonlyMap<string, FolderTargetEntry>; readonly owned: ReadonlyMap<string, FolderTargetEntry> } | undefined;
  private readonly subscriptions: Disposable[];
  private readonly foldersListeners = new Set<() => void>();
  private heldMemory: readonly HeldMemoryQueue[] = [];
  private readonly heldMemoryListeners = new Set<() => void>();
  // this computer's core: the avatar keys of its Git hosting accounts; a daemon's core publishes none
  private forgeAvatarKeys: ReadonlySet<string> = new Set();
  private forgeAuthorAvatarKeys: ReadonlySet<string> = new Set();
  // undefined until core's first forge mirror
  private forgeManaged: readonly ManagedServer[] | undefined;
  private forgeServerList: readonly ClientForgeServer[] | undefined;
  private forgeAccountServerList: readonly MatchableServer[] | undefined;
  private readonly forgeListeners = new Set<() => void>();
  private relocationViews: readonly RelocationView[] = [];
  private readonly relocationListeners = new Set<() => void>();
  // whether core serves the relocation requests and mirror: a local core always, a daemon's only when it lists projects.relocate
  readonly relocates: boolean;
  // whether core abandons a paused relocation: a local core always, a daemon's only when it lists projects.relocationAbandon
  readonly abandons: boolean;
  // whether core serves design.previewAnswer: a local core always, a daemon's only when it lists design.infoMissing
  readonly answersMissingPages: boolean;

  constructor(endpoint: MainEndpoint, adoptView: <T>(view: RelayView, attach: () => Promise<T>) => Promise<T>, keys: ProjectKeys, relocates: boolean = keys.authorityKey === 'local', abandons: boolean = keys.authorityKey === 'local', answersMissingPages: boolean = keys.authorityKey === 'local') {
    this.endpoint = endpoint;
    this.adoptView = adoptView;
    this.keys = keys;
    this.relocates = relocates;
    this.abandons = relocates && abandons;
    this.answersMissingPages = answersMissingPages;
    this.subscriptions = [
      endpoint.onMirror('chats', ({ panelId, entry }) => {
        const previous = this.chatsById.get(panelId);
        if (previous) this.chatsByView.delete(previous.viewId);
        if (!entry) {
          this.chatsById.delete(panelId);
          return;
        }
        const shown = chatEntryToShell(keys, entry);
        this.chatsById.set(panelId, shown);
        this.chatsByView.set(shown.viewId, shown);
      }),
      endpoint.onMirror('folderTargets', ({ defaultKey, targets }) => {
        const shown = targets.map((target) => folderTargetToShell(keys, target));
        this.folders = {
          defaultKey: keys.toShell(defaultKey),
          projects: new Map(shown.filter((target) => target.ownerKey === undefined).map((target) => [target.key, target])),
          owned: new Map(shown.filter((target) => target.ownerKey !== undefined).map((target) => [target.key, target])),
        };
        for (const listener of [...this.foldersListeners]) listener();
      }),
      endpoint.onMirror('heldMemory', ({ queues }) => {
        this.heldMemory = queues;
        for (const listener of [...this.heldMemoryListeners]) listener();
      }),
      endpoint.onMirror('forge', ({ avatarKeys, servers }) => {
        this.forgeAvatarKeys = new Set(avatarKeys);
        this.forgeManaged = servers.filter((server) => server.hasAccount).map(({ webUrl, gitHosts }) => ({ webUrl, gitHosts }));
        this.forgeServerList = servers.map(({ id, webUrl, gitHosts, hasAccount }) => ({ id, webUrl, gitHosts, hasAccount }));
        this.forgeAccountServerList = servers.filter((server) => server.hasAccount).map(({ id, kind, webUrl, gitHosts }) => ({ id, kind, webUrl, record: { gitHosts } }));
        for (const listener of [...this.forgeListeners]) listener();
      }),
      // served like the account keys, but a new history page refreshes no view
      endpoint.onMirror('forgeAuthorAvatars', ({ keys: authorKeys }) => {
        this.forgeAuthorAvatarKeys = new Set(authorKeys);
      }),
    ];
    if (relocates) {
      this.subscriptions.push(endpoint.onMirror('relocations', ({ records }) => {
        this.relocationViews = records;
        for (const listener of [...this.relocationListeners]) listener();
      }));
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.foldersListeners.clear();
    this.heldMemoryListeners.clear();
    this.forgeListeners.clear();
    this.relocationListeners.clear();
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
    return this.resolve(this.folders?.defaultKey ?? '');
  }

  // a project, or a working folder a loaded chat holds; a key open in both roles answers the project, as core's resolve
  resolve(key: string): FolderTargetEntry | undefined {
    return this.folders?.projects.get(key) ?? this.folders?.owned.get(key);
  }

  // a project core holds open, never a working folder
  project(key: string): FolderTargetEntry | undefined {
    return this.folders?.projects.get(key);
  }

  // the project target holding key: itself for a project, its owner for a working folder only a chat holds
  projectOf(key: string): FolderTargetEntry | undefined {
    const target = this.resolve(key);
    return target?.ownerKey !== undefined ? this.folders?.projects.get(target.ownerKey) : target;
  }

  branchOf(key: string): string | undefined {
    return this.resolve(key)?.branch;
  }

  onFoldersChanged(listener: () => void): Disposable {
    this.foldersListeners.add(listener);
    return { dispose: () => { this.foldersListeners.delete(listener); } };
  }

  // ---- events

  // sessionId: the stored session the chat is on, when core names it
  onActivity(listener: (panelId: string, activity: ChatActivity, sessionId: string | undefined) => void): Disposable {
    return this.endpoint.onEvent('chat.activity', ({ panelId, activity, sessionId }) => listener(panelId, activity, sessionId));
  }

  onTurnSettled(listener: (panelId: string, outcome: TurnOutcome) => void): Disposable {
    return this.endpoint.onEvent('chat.turnSettled', ({ panelId, outcome }) => listener(panelId, outcome));
  }

  onChatChanges(listener: (panelId: string, totals: ChatChangeTotals, generation: number) => void): Disposable {
    return this.endpoint.onEvent('chat.changes', ({ panelId, totals, generation }) => listener(panelId, totals as ChatChangeTotals, generation));
  }

  onUsageThreshold(listener: (crossing: UsageThresholdCrossing) => void): Disposable {
    return this.endpoint.onEvent('chat.usageThreshold', ({ crossing }) => listener(crossing));
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

  onDesignChanged(listener: (designId: string, paths: readonly string[]) => void): Disposable {
    return this.endpoint.onEvent('design.changed', ({ designId, paths }) => listener(designId, paths));
  }

  onCatalogChanged(listener: (projectKey: string | undefined) => void): Disposable {
    return this.endpoint.onEvent('catalog.changed', ({ projectKey }) => listener(projectKey === undefined ? undefined : this.keys.toShell(projectKey)));
  }

  // ---- chats

  /**
   * Core attaches to a chat view main created and restores it there; main relays the view's traffic from then on.
   * permissions: what the core before this one published for the chat (KeptPermissions), in place of the defaults.
   */
  async restoreChat(view: RelayView, folderKey: string | undefined, permissions?: ChatPermissions): Promise<void> {
    const coreKey = folderKey === undefined ? undefined : this.keys.toCore(folderKey);
    return this.adoptView(view, () => this.request('chats.restore', {
      viewId: view.panelId,
      ...(coreKey !== undefined ? { folderKey: coreKey } : {}),
      ...(permissions ? { permissions } : {}),
    }));
  }

  /** This computer's core shows a remote chat's session mirror copy on the view, read-only; file is under that host's mirror. */
  openTranscript(view: RelayView, hostId: string, file: string): Promise<void> {
    return this.adoptView(view, () => this.request('chats.openTranscript', { viewId: view.panelId, hostId, file }));
  }

  /** A rejoining view (already relayed, its ready held) joins the panel its page token names; null: none, so main restores it. */
  // sessionId: another device's view, which names the panel by the stored session it holds
  joinView(viewId: string, viewKey: string, sessionId?: string): Promise<{ readonly panelId: string } | null> {
    return this.request('views.join', { viewId, viewKey, ...(sessionId !== undefined ? { sessionId } : {}) });
  }

  /** chats.restore for a view main already relays (a rejoin core refused). */
  restoreRelayed(viewId: string, permissions?: ChatPermissions): Promise<void> {
    return this.request('chats.restore', { viewId, ...(permissions ? { permissions } : {}) });
  }

  async startInWorktree(view: RelayView, projectKey: string, worktreeId: string): Promise<void> {
    const coreKey = this.keys.toCore(projectKey);
    return this.adoptView(view, () => this.request('chats.startInWorktree', { viewId: view.panelId, projectKey: coreKey, worktreeId }));
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

  async mention(panelId: string, target: AuthorityMentionTarget): Promise<void> {
    return this.request('chats.mention', { panelId, target: mentionToCore(this.keys, target) });
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
  async projectBusy(projectKey: string): Promise<boolean> {
    return this.request('chats.projectBusy', { projectKey: this.keys.toCore(projectKey) });
  }

  /** Whether another holder keeps the session from opening here; announce tells the user, with a takeover (onTakeover), and on a local core shows a chat holding it. */
  leaseRefused(sessionId: string, announce: boolean): Promise<boolean> {
    return this.request('chats.leaseRefusal', { sessionId, announce });
  }

  // ---- the session catalog

  async listSessions(projectKey: string, complete = false): Promise<readonly StoredSession[]> {
    return ((await this.request('catalog.list', { projectKey: this.keys.toCore(projectKey), complete })) as readonly StoredSession[]).map((row) => storedSessionToShell(this.keys, row));
  }

  /** This computer's core lists one project's chats of a host's session mirror, read-only; folder is under that host's mirror. */
  async listMirroredSessions(hostId: string, folder: string, query: string, os: MirrorHostOs | undefined, project: string): Promise<readonly StoredSession[]> {
    return (await this.request('chats.listMirrored', { hostId, folder, project, ...(query !== '' ? { query } : {}), ...(os !== undefined ? { os } : {}) })) as readonly StoredSession[];
  }

  async searchSessions(projectKey: string, query: string): Promise<readonly StoredSession[]> {
    return ((await this.request('catalog.search', { projectKey: this.keys.toCore(projectKey), query })) as readonly StoredSession[]).map((row) => storedSessionToShell(this.keys, row));
  }

  renameSession(sessionId: string, name: string): Promise<CatalogResult> {
    return this.request('catalog.rename', { sessionId, name });
  }

  tagSession(sessionId: string, tag: string | null): Promise<CatalogResult> {
    return this.request('catalog.tag', { sessionId, tag });
  }

  deleteSession(sessionId: string): Promise<CatalogResult> {
    return this.request('catalog.delete', { sessionId });
  }

  // ---- the session store's files, which only their core writes

  writeSessionFile(path: string, bytes: Uint8Array, expectedSha256: string | null): Promise<SessionFileWrite> {
    return this.request('sessionFiles.write', { path, bytes, expectedSha256 });
  }

  // ---- folders, browser pages, worktrees

  async setDefaultFolder(key: string): Promise<void> {
    return this.request('folders.setDefault', { key: this.keys.toCore(key) });
  }

  newBrowserPage(chatViewId: string, url?: string): Promise<void> {
    return this.request('browser.newPage', { chatViewId, ...(url !== undefined ? { url } : {}) });
  }

  /** Local chats' browser sends the certificate filter names to origin for the rest of this app session; a running browser restarts. */
  useClientCertificate(origin: string, filter: ClientCertificateFilter): Promise<void> {
    return this.request('browser.useClientCertificate', { origin, filter });
  }

  // this computer's core: a remote chat's browser tool in its authority's context
  browserTool(params: Params<'user.browser.tool'>, signal: AbortSignal): Promise<Result<'user.browser.tool'>> {
    return this.endpoint.request('user.browser.tool', params, signal);
  }

  // this computer's core: the authority's browser context and proxy close (Forget host), or only one agent's scope of a remote chat
  releaseBrowser(authority: string, agentScope?: Params<'user.browser.release'>['agentScope']): Promise<void> {
    return this.request('user.browser.release', { authority, ...(agentScope !== undefined ? { agentScope } : {}) });
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
  attachSettingsView(panelId: string, attachment: number, view: { post(message: ExtensionToWebviewMessage): void; detached(): void }, scope?: 'user' | 'machine' | 'project'): Promise<Disposable> {
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
    return this.request('settingsView.attach', { panelId, attachment, ...(scope !== undefined ? { scope } : {}) }).then(() => handle, (err: unknown) => {
      for (const subscription of subscriptions) subscription.dispose();
      throw err;
    });
  }

  dispatchSettingsView(attachment: number, message: WebviewToExtensionMessage): Promise<void> {
    return this.request('settingsView.dispatch', { attachment, message });
  }

  // ---- source control and worktrees, which core runs (core-host/scm.ts, worktrees.ts)

  onScmMirror(listener: (patch: ScmMirrorPatch) => void): Disposable {
    return this.endpoint.onMirror('scm', (patch) => listener(scmPatchToShell(this.keys, patch)));
  }

  // a ScmService event, after the scm mirror shows it
  onScmChanged(listener: (event: unknown) => void): Disposable {
    return this.endpoint.onEvent('scm.changed', ({ event }) => listener(scmEventToShell(this.keys, event)));
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

  async scmCall(method: ScmCall, args: readonly unknown[]): Promise<unknown> {
    return parsedCallText('scm.call', method, SCM_CALL_LOCALIZED_TEXT[method], await this.request('scm.call', { method, args }));
  }

  scmCommit(repoId: string, message: string, variant: unknown, saved: readonly string[], branchName: string | undefined, protectedBranches?: readonly RemoteBranchProtection[]): Promise<ScmCommitOutcome> {
    return this.request('scm.commit', { repoId, message, variant, saved, ...(branchName !== undefined ? { branchName } : {}), ...(protectedBranches !== undefined ? { protectedBranches } : {}) });
  }

  async scmIgnoredIn(projectKey: string, relativeDir: string, entries: readonly { readonly name: string; readonly dir: boolean }[]): Promise<readonly string[]> {
    return this.request('scm.ignoredIn', { projectKey: this.keys.toCore(projectKey), relativeDir, entries });
  }

  scmCommitBlob(repoId: string, commit: string, path: string): Promise<Uint8Array | 'tooLarge' | undefined> {
    return this.request('scm.commitBlob', { repoId, commit, path });
  }

  designRead(designId: string, relPath: string): Promise<DesignPreviewFile | 'tooLarge' | undefined> {
    return this.request('design.read', { designId, relPath });
  }

  // an older core answers a missing page as nothing, which reads as a page it cannot read
  designInfo(designId: string, relPath: string): Promise<DesignPreviewAnswer> {
    return this.answersMissingPages ? this.request('design.previewAnswer', { designId, relPath }) : this.request('design.info', { designId, relPath });
  }

  // png: base64 with no data: prefix, at most 1950 px a side
  designMarkup(panelId: string, png: string, json: MarkupJsonInput): Promise<{ readonly feedbackId: string } | { readonly refused: LocalizedText }> {
    return this.request('design.markup', { panelId, png, json });
  }

  designTweak(panelId: string, tweakId: string, value: string): Promise<{ readonly kept: true } | { readonly refused: LocalizedText }> {
    return this.request('design.tweak', { panelId, tweakId, value });
  }

  designPreviewScreen(screenPath: string): Promise<{ readonly opened: true } | { readonly refused: LocalizedText }> {
    return this.request('design.previewScreen', { path: screenPath });
  }

  scmGenerateMessage(repoId: string): Promise<unknown> {
    return this.request('scm.generateMessage', { repoId });
  }

  scmRepo(repoId: string, method: RepositoryCall, args: readonly unknown[]): Promise<unknown> {
    return this.request('scm.repo', { repoId, method, args });
  }

  async worktreeCall(method: WorktreeCall, args: readonly unknown[]): Promise<unknown> {
    return parsedCallText('worktrees.call', method, WORKTREE_CALL_LOCALIZED_TEXT[method], await this.request('worktrees.call', { method, args }));
  }

  // ---- this computer's user scope, which the local core serves to remote chats

  /** The Stop path of a chat's running turn, by core panel id (Stop agents). */
  stopChat(panelId: string): Promise<void> {
    return this.request('chats.stop', { panelId });
  }

  // force: refreshed even while the token is not expiring (Keep running)
  resolveCredential(provider: string, force?: boolean): Promise<BrokerAnswer> {
    return this.request('user.resolveCredential', { provider, ...(force ? { force } : {}) });
  }

  // a daemon's core: this computer's fresh OAuth token, cached for this client alone
  pushCredential(provider: string, credential: PushedCredential, signal?: AbortSignal): Promise<void> {
    return this.endpoint.request('user.credentials.push', { provider, credential }, signal);
  }

  clientAuth(): Promise<HeldAuth> {
    return this.request('user.clientAuth', {});
  }

  onClientAuthChanged(listener: () => void): Disposable {
    return this.endpoint.onEvent('user.clientAuthChanged', () => listener());
  }

  // this computer's core: its global memory and personal MCP servers, for a remote core through main's checks
  memorySearch(query: string, k: number, tiers: readonly ('global' | 'note')[], injection: boolean, filters: GlobalMemorySearchFilters): Promise<Result<'user.memory.search'>> {
    return this.request('user.memory.search', { query, k, tiers, ...(injection ? { injection } : {}), ...filters });
  }

  // ---- a daemon's core: the outboxes it holds for devices long away

  heldMemoryQueues(): readonly HeldMemoryQueue[] {
    return this.heldMemory;
  }

  onHeldMemoryChanged(listener: () => void): Disposable {
    this.heldMemoryListeners.add(listener);
    return { dispose: () => { this.heldMemoryListeners.delete(listener); } };
  }

  // false: the queue is no longer held
  deliverHeldMemory(queueId: string): Promise<boolean> {
    return this.request('memory.deliverHeld', { queueId });
  }

  discardHeldMemory(queueId: string): Promise<boolean> {
    return this.request('memory.discardHeld', { queueId });
  }

  memoryProfile(): Promise<Result<'user.memory.profile'>> {
    return this.request('user.memory.profile', {});
  }

  memoryResolve(ids: readonly string[]): Promise<Result<'user.memory.resolve'>> {
    return this.request('user.memory.resolve', { ids });
  }

  memoryApply(writes: Params<'user.memory.apply'>['writes']): Promise<Result<'user.memory.apply'>> {
    return this.request('user.memory.apply', { writes });
  }

  memoryList(request: Params<'user.memory.list'>): Promise<Result<'user.memory.list'>> {
    return this.request('user.memory.list', request);
  }

  mcpServers(): Promise<Result<'user.mcp.servers'>> {
    return this.request('user.mcp.servers', {});
  }

  // a remote chat's GitHub or GitLab tool on this computer's accounts; the remote caller's signal ends it
  forgeTool(params: Params<'user.forge.tool'>, signal: AbortSignal): Promise<Result<'user.forge.tool'>> {
    return this.endpoint.request('user.forge.tool', params, signal);
  }

  forgeDescribe(params: Params<'user.forge.describe'>, signal: AbortSignal): Promise<Result<'user.forge.describe'>> {
    return this.endpoint.request('user.forge.describe', params, signal);
  }

  // a remote chat's theme tool on this computer's store, after main's checks (remote/theme-relay.ts); the remote caller's signal ends it
  themeRelay<M extends Extract<keyof MainRequests, `themes.relay.${string}`>>(method: M, params: Params<M>, signal: AbortSignal): Promise<Result<M>> {
    return (this.endpoint.request as (name: M, params: Params<M>, signal: AbortSignal) => Promise<Result<M>>)(method, params, signal);
  }

  // the remote caller's signal ends the request on this computer's core
  mcpCall(server: string, tool: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown> {
    return this.endpoint.request('user.mcp.call', { server, tool, args }, signal);
  }

  mcpResources(server: string, kind: 'resources' | 'templates', cursor: string | undefined, signal: AbortSignal): Promise<unknown> {
    return this.endpoint.request('user.mcp.resources', { server, kind, ...(cursor !== undefined ? { cursor } : {}) }, signal);
  }

  mcpReadResource(server: string, uri: string, signal: AbortSignal): Promise<unknown> {
    return this.endpoint.request('user.mcp.readResource', { server, uri }, signal);
  }

  onRelayedMcpChanged(listener: () => void): Disposable {
    return this.endpoint.onEvent('user.mcpChanged', () => listener());
  }

  speak(viewId: string, text: string): Promise<void> {
    return this.request('user.voice.speak', { viewId, text });
  }

  attachForeign(authority: string, viewId: string): Promise<void> {
    return this.request('panels.attachForeign', { authority, viewId });
  }

  detachForeign(viewId: string): Promise<void> {
    return this.request('panels.detachForeign', { viewId });
  }

  foreignMessage(viewId: string, message: unknown): Promise<void> {
    return this.request('panels.foreignMessage', { viewId, message });
  }

  onForeignPost(listener: (viewId: string, message: unknown) => void): Disposable {
    return this.endpoint.onEvent('panel.foreignPost', ({ viewId, message }) => listener(viewId, message));
  }

  // ---- project relocation (docs/invariants.md "Project relocation"); a daemon's core only when it lists projects.relocate

  /** The relocations mirror: pending relocations and those that reached coreDone in this core's run. */
  relocations(): readonly RelocationView[] {
    return this.relocationViews;
  }

  onRelocationsChanged(listener: () => void): Disposable {
    this.relocationListeners.add(listener);
    return { dispose: () => { this.relocationListeners.delete(listener); } };
  }

  relocationPreflight(request: PreflightRequest): Promise<PreflightAnswer> {
    return this.relocationRequest('projects.relocationPreflight', request);
  }

  /** Settles once the journal record is written, with its id, or with preflight's refusal. */
  relocate(request: RelocationRequest): Promise<{ readonly id: string } | { readonly refusal: Coded }> {
    return this.relocationRequest('projects.relocate', request);
  }

  relocationRetry(id: string): Promise<void> {
    return this.relocationRequest('projects.relocationRetry', { id });
  }

  /** Stop moving a paused relocation; its refusal when core holds it otherwise. */
  async relocationAbandon(id: string): Promise<Coded | undefined> {
    if (!this.abandons) throw new Error(`The core on ${this.keys.authorityKey} does not stop moving project folders`);
    const answer = await this.request('projects.relocationAbandon', { id });
    return 'refusal' in answer ? answer.refusal : undefined;
  }

  /** The relocations from the projects these shell keys name. */
  relocationsFrom(keys: readonly string[]): Promise<readonly RelocationView[]> {
    return this.relocationRequest('projects.relocationsFrom', { keys: keys.map((key) => this.keys.toCore(key)) });
  }

  applyRelocationHostState(id: string): Promise<void> {
    return this.relocationRequest('projects.applyHostState', { id });
  }

  movedFrom(to: string): Promise<readonly MovedFromCandidate[]> {
    return this.relocationRequest('projects.movedFrom', { to });
  }

  /** This computer's core: a moved remote project's Git hosting bindings follow its project key. */
  relocateForgeBindings(fromKey: string, toKey: string): Promise<void> {
    return this.request('forge.relocateProject', { fromKey, toKey });
  }

  /** This computer's core: /stats counts a moved remote project's sessions under its new path on that host. */
  addHostAlias(alias: { readonly hostId: string; readonly from: string; readonly to: string; readonly startedAt?: number }): Promise<void> {
    return this.request('projects.addHostAlias', alias);
  }

  // a daemon that did not list projects.relocate closes the connection on these names, so none is sent to it
  private relocationRequest<M extends 'projects.relocationPreflight' | 'projects.relocate' | 'projects.relocationRetry' | 'projects.relocationsFrom' | 'projects.applyHostState' | 'projects.movedFrom'>(method: M, params: Params<M>): Promise<Result<M>> {
    if (!this.relocates) return Promise.reject(new Error(`The core on ${this.keys.authorityKey} does not move project folders`));
    return this.request(method, params);
  }

  // ---- lifecycle and the e2e namespace

  shutdown(): Promise<void> {
    return this.request('core.shutdown', {});
  }

  e2eInputBox(options: InputBoxOptions): Promise<string | undefined> {
    return this.request('e2e.inputBox', options);
  }

  e2eClientNetworkAnswers(answers: Readonly<Record<string, readonly (readonly string[])[]>>): Promise<void> {
    return this.request('e2e.clientNetworkAnswers', { answers });
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

  e2eRelocationPauseAfter(sessions: number | null, mode: 'pause' | 'hang'): Promise<void> {
    return this.request('e2e.relocationPauseAfter', { sessions, mode });
  }

  e2eThemeStoreFetches(): Promise<Result<'e2e.themeStoreFetches'>> {
    return this.request('e2e.themeStoreFetches', {});
  }

  e2eFakeVoice(transcript: string): Promise<{ readonly pid: number }> {
    return this.request('e2e.fakeVoice', { transcript });
  }

  e2eVoiceRecorder(): Promise<{ readonly starts: number; readonly recorderPid: number | null }> {
    return this.request('e2e.voiceRecorder', {});
  }

  e2eWatchProbe(folder: string): Promise<readonly string[]> {
    return this.request('e2e.watchProbe', { folder });
  }

  e2eStopWatchProbe(folder: string): Promise<void> {
    return this.request('e2e.stopWatchProbe', { folder });
  }

  // ---- this computer's core: Git hosting account pictures

  /** Core listed this avatar key, for an account's picture or a commit author's, and avatars are on. */
  forgeAvatarKnown(key: string): boolean {
    return this.forgeAvatarKeys.has(key) || this.forgeAuthorAvatarKeys.has(key);
  }

  forgeAvatar(key: string): Promise<Result<'forge.avatar'>> {
    return this.request('forge.avatar', { key });
  }

  // ---- this computer's core: Git hosting accounts of projects; project keys are the shell's, which bindings.json stores

  /** The forge mirror changed: a server, an account, or the avatars setting. */
  onForgeChanged(listener: () => void): Disposable {
    this.forgeListeners.add(listener);
    return { dispose: () => this.forgeListeners.delete(listener) };
  }

  onForgeBindingsChanged(listener: (change: CoreEvents['forge.bindingsChanged']) => void): Disposable {
    return this.endpoint.onEvent('forge.bindingsChanged', listener);
  }

  onForgeChooseAccountRows(listener: (rows: CoreEvents['forge.chooseAccountRows']) => void): Disposable {
    return this.endpoint.onEvent('forge.chooseAccountRows', listener);
  }

  // this computer's core wrote a theme file
  onThemesChanged(listener: () => void): Disposable {
    return this.endpoint.onEvent('themes.changed', () => listener());
  }

  themesList(): Promise<Result<'themes.list'>> {
    return this.request('themes.list', {});
  }

  themesDuplicate(themeId: string, name: string): Promise<Result<'themes.duplicate'>> {
    return this.request('themes.duplicate', { themeId, name });
  }

  themesDelete(themeId: string): Promise<void> {
    return this.request('themes.delete', { themeId });
  }

  themesRename(themeId: string, name: string): Promise<void> {
    return this.request('themes.rename', { themeId, name });
  }

  themesPick(params: Params<'themes.pick'>): Promise<{ readonly recorded: boolean }> {
    return this.request('themes.pick', params);
  }

  themesReset(projectKey?: string): Promise<void> {
    return this.request('themes.reset', projectKey !== undefined ? { projectKey } : {});
  }

  themesProjectLooks(): Promise<Result<'themes.projectLooks'>> {
    return this.request('themes.projectLooks', {});
  }

  themesSetProjectLook(params: Params<'themes.setProjectLook'>): Promise<void> {
    return this.request('themes.setProjectLook', params);
  }

  themesRelocateProject(fromKey: string, toKey: string): Promise<void> {
    return this.request('themes.relocateProject', { fromKey, toKey });
  }

  themesForgetProject(projectKey: string): Promise<void> {
    return this.request('themes.forgetProject', { projectKey });
  }

  themesForgetHost(authorityKey: string): Promise<void> {
    return this.request('themes.forgetHost', { authorityKey });
  }

  themesKeepHosts(authorityKeys: readonly string[]): Promise<void> {
    return this.request('themes.keepHosts', { authorityKeys });
  }

  themesSetMode(params: Params<'themes.setMode'>): Promise<void> {
    return this.request('themes.setMode', params);
  }

  themesSetScheduleMode(params: Params<'themes.setScheduleMode'>): Promise<void> {
    return this.request('themes.setScheduleMode', params);
  }

  themesSetScheduleRules(params: Params<'themes.setScheduleRules'>): Promise<void> {
    return this.request('themes.setScheduleRules', params);
  }

  themesResumeSchedule(): Promise<void> {
    return this.request('themes.resumeSchedule', {});
  }

  themesHold(params: Params<'themes.hold'>): Promise<void> {
    return this.request('themes.hold', params);
  }

  themesSaveTheme(params: Params<'themes.saveTheme'>): Promise<Result<'themes.saveTheme'>> {
    return this.request('themes.saveTheme', params);
  }

  themesBaseHash(themeId: string): Promise<Result<'themes.baseHash'>> {
    return this.request('themes.baseHash', { themeId });
  }

  themesHistory(): Promise<Result<'themes.history'>> {
    return this.request('themes.history', {});
  }

  // expected: the entry the caller means, refused when another change was made since
  themesUndo(expected?: string): Promise<Result<'themes.undo'>> {
    return this.request('themes.undo', expected === undefined ? {} : { expected });
  }

  // the keep-changes banner's revert of its own entry
  themesUndoPending(entryId: string): Promise<Result<'themes.undoPending'>> {
    return this.request('themes.undoPending', { entryId });
  }

  // the keep-changes banner's Keep
  themesKeep(entryId: string): Promise<void> {
    return this.request('themes.keep', { entryId });
  }

  // a card's Show in window ended in main
  themesShowEnded(promptId: string, reason: ThemeShowEndReason): Promise<void> {
    return this.request('themes.showEnded', { promptId, reason });
  }

  // main let go of a screenshot to hold newer ones, while its card may still show it
  themesScreenshotGone(shotId: string): Promise<void> {
    return this.request('themes.screenshotGone', { shotId });
  }

  // a daemon's core: this computer's window let go of a screenshot it took for a card that core raised
  themeScreenshotGoneRemote(shotId: string): Promise<void> {
    return this.endpoint.request('user.theme.screenshotGone', { shotId });
  }

  // a daemon's core: this computer's window ended the Show in window of a card that core raised
  themeShowEndedRemote(ended: ThemeShowEnded): Promise<void> {
    return this.endpoint.request('user.theme.showEnded', ended);
  }

  // a remote core's ThemeSet install this computer staged: its new preview and its flash checks' progress
  themeInstallUpdatedRemote(preview: ThemeInstallPreview): Promise<void> {
    return this.endpoint.request('user.theme.installUpdated', { preview });
  }

  themeInstallProgressRemote(progress: ThemeInstallProgress): Promise<void> {
    return this.endpoint.request('user.theme.installProgress', progress);
  }

  themeInstallExpiredRemote(installId: string): Promise<void> {
    return this.endpoint.request('user.theme.installExpired', { installId });
  }

  themesAnalyzeProgress(sha256: string, fraction: number): Promise<void> {
    return this.request('themes.analyzeProgress', { sha256, fraction });
  }

  themesInstallAllowFlash(installId: string, sha256: string): Promise<Result<'themes.install.allowFlash'>> {
    return this.request('themes.install.allowFlash', { installId, sha256 });
  }

  onThemesInstallProgress(listener: (progress: CoreEvents['themes.install.progress']) => void): Disposable {
    return this.endpoint.onEvent('themes.install.progress', listener);
  }

  themesRestore(params: Params<'themes.restore'>): Promise<Result<'themes.restore'>> {
    return this.request('themes.restore', params);
  }

  themesImportFont(bytes: Uint8Array): Promise<Result<'themes.importFont'>> {
    return this.request('themes.importFont', { bytes });
  }

  themesImportImage(file: string): Promise<Result<'themes.importImage'>> {
    return this.request('themes.importImage', { file });
  }

  themesImportSprite(params: Params<'themes.importSprite'>): Promise<Result<'themes.importSprite'>> {
    return this.request('themes.importSprite', params);
  }

  themesAllowFlash(sha256: string): Promise<Result<'themes.allowFlash'>> {
    return this.request('themes.allowFlash', { sha256 });
  }

  themesInstallPrepare(params: Params<'themes.install.prepare'>, signal?: AbortSignal): Promise<Result<'themes.install.prepare'>> {
    return this.endpoint.request('themes.install.prepare', params, signal);
  }

  themesInstallCommit(params: Params<'themes.install.commit'>): Promise<Result<'themes.install.commit'>> {
    return this.request('themes.install.commit', params);
  }

  themesInstallCancel(installId: string): Promise<Result<'themes.install.cancel'>> {
    return this.request('themes.install.cancel', { installId });
  }

  themesExportPlan(params: Params<'themes.export.plan'>): Promise<Result<'themes.export.plan'>> {
    return this.request('themes.export.plan', params);
  }

  themesExportWrite(params: Params<'themes.export.write'>): Promise<Result<'themes.export.write'>> {
    return this.request('themes.export.write', params);
  }

  // a staged install waited too long and core dropped it
  onThemesInstallExpired(listener: (installId: string) => void): Disposable {
    return this.endpoint.onEvent('themes.install.expired', ({ installId }) => listener(installId));
  }

  // a staged install's preview changed, as a wallpaper's flash check ended
  onThemesInstallUpdated(listener: (preview: CoreEvents['themes.install.updated']['preview']) => void): Disposable {
    return this.endpoint.onEvent('themes.install.updated', ({ preview }) => listener(preview));
  }

  themesStoreList(refresh: boolean): Promise<Result<'themes.store.list'>> {
    return this.request('themes.store.list', { refresh });
  }

  themesStoreInstall(entryId: string, signal?: AbortSignal): Promise<Result<'themes.store.install'>> {
    return this.endpoint.request('themes.store.install', { entryId }, signal);
  }

  themesStoreBackgroundCheck(): Promise<Result<'themes.store.backgroundCheck'>> {
    return this.request('themes.store.backgroundCheck', {});
  }

  themesStoreSetEnabled(enabled: boolean): Promise<Result<'themes.store.setEnabled'>> {
    return this.request('themes.store.setEnabled', { enabled });
  }

  // the store view after a list was read (listRead) or an installed theme changed
  onThemesStoreUpdated(listener: (view: CoreEvents['themes.store.updated']['view'], listRead: boolean) => void): Disposable {
    return this.endpoint.onEvent('themes.store.updated', ({ view, listRead }) => listener(view, listRead === true));
  }

  forgeRepoAccounts(input: Params<'forge.repoAccounts'>): Promise<Result<'forge.repoAccounts'>> {
    return this.request('forge.repoAccounts', input);
  }

  forgeBindAccount(projectKey: string, serverId: string, accountId: string | null): Promise<boolean> {
    return this.request('forge.bindAccount', { projectKey, serverId, accountId });
  }

  forgeHostDefaults(authorityKey: string): Promise<Result<'forge.hostDefaults'>> {
    return this.request('forge.hostDefaults', { authorityKey });
  }

  forgeSetHostDefault(authorityKey: string, serverId: string, accountId: string | null): Promise<boolean> {
    return this.request('forge.setHostDefault', { authorityKey, serverId, accountId });
  }

  forgePrepareGitOperation(input: Params<'forge.prepareGitOperation'>): Promise<Result<'forge.prepareGitOperation'>> {
    return this.request('forge.prepareGitOperation', input);
  }

  forgeForgetProject(projectKey: string): Promise<void> {
    return this.request('forge.forgetProject', { projectKey });
  }

  forgeForgetHost(authorityKey: string): Promise<void> {
    return this.request('forge.forgetHost', { authorityKey });
  }

  forgeCiWatch(params: Params<'forge.ci.watch'>): Promise<Result<'forge.ci.watch'>> {
    return this.request('forge.ci.watch', params);
  }

  forgeCiUnwatch(id: string): Promise<void> {
    return this.request('forge.ci.unwatch', { id });
  }

  forgeCiJobs(id: string): Promise<Result<'forge.ci.jobs'>> {
    return this.request('forge.ci.jobs', { id });
  }

  forgeCiJobLog(params: Params<'forge.ci.jobLog'>): Promise<Result<'forge.ci.jobLog'>> {
    return this.request('forge.ci.jobLog', params);
  }

  forgeCiJobAction(params: Params<'forge.ci.jobAction'>): Promise<Result<'forge.ci.jobAction'>> {
    return this.request('forge.ci.jobAction', params);
  }

  forgeCiCommitStatus(params: Params<'forge.ci.commitStatus'>): Promise<Result<'forge.ci.commitStatus'>> {
    return this.request('forge.ci.commitStatus', params);
  }

  forgeCiWebUrl(params: Params<'forge.ci.webUrl'>): Promise<Result<'forge.ci.webUrl'>> {
    return this.request('forge.ci.webUrl', params);
  }

  forgeLink(params: Params<'forge.link'>): Promise<Result<'forge.link'>> {
    return this.request('forge.link', params);
  }

  forgeHistoryContext(params: Params<'forge.history.context'>): Promise<Result<'forge.history.context'>> {
    return this.request('forge.history.context', params);
  }

  forgeHistoryAvatars(params: Params<'forge.history.avatars'>): Promise<Result<'forge.history.avatars'>> {
    return this.request('forge.history.avatars', params);
  }

  forgeHistoryContaining(params: Params<'forge.history.containing'>): Promise<Result<'forge.history.containing'>> {
    return this.request('forge.history.containing', params);
  }

  forgeBranchProtection(params: Params<'forge.branchProtection'>): Promise<Result<'forge.branchProtection'>> {
    return this.request('forge.branchProtection', params);
  }

  forgeCloneAccounts(): Promise<Result<'forge.clone.accounts'>> {
    return this.request('forge.clone.accounts', {});
  }

  // signal: a newer search of the same section, or the picker closing, ends this one on core
  forgeCloneSearch(params: Params<'forge.clone.search'>, signal: AbortSignal): Promise<Result<'forge.clone.search'>> {
    return this.endpoint.request('forge.clone.search', params, signal);
  }

  forgeClonePaste(text: string): Promise<Result<'forge.clone.paste'>> {
    return this.request('forge.clone.paste', { text });
  }

  forgeCloneTarget(params: Params<'forge.clone.target'>): Promise<Result<'forge.clone.target'>> {
    return this.request('forge.clone.target', params);
  }

  forgePublishAccounts(): Promise<Result<'forge.publishAccounts'>> {
    return this.request('forge.publishAccounts', {});
  }

  forgePublishOwners(params: Params<'forge.publishOwners'>, signal: AbortSignal): Promise<Result<'forge.publishOwners'>> {
    return this.endpoint.request('forge.publishOwners', params, signal);
  }

  forgePushProtection(params: Params<'forge.pushProtection'>, signal: AbortSignal): Promise<Result<'forge.pushProtection'>> {
    return this.endpoint.request('forge.pushProtection', params, signal);
  }

  /** The managed servers once core read its forge files or failed to; the mirror's forgeServers() may be empty before that. */
  forgeServersRead(): Promise<Result<'forge.servers'>> {
    return this.request('forge.servers', {});
  }

  /** The authorities this computer still holds; core drops the account bindings and host defaults of every other. */
  forgeKeepHosts(authorityKeys: readonly string[]): Promise<Result<'forge.keepHosts'>> {
    return this.request('forge.keepHosts', { authorityKeys });
  }

  forgeCreateRepository(params: Params<'forge.createRepository'>): Promise<Result<'forge.createRepository'>> {
    return this.request('forge.createRepository', params);
  }

  forgePushAccess(params: Params<'forge.pushAccess'>, signal: AbortSignal): Promise<Result<'forge.pushAccess'>> {
    return this.endpoint.request('forge.pushAccess', params, signal);
  }

  // signal: the fork dialog's Cancel ends the fork's polls on core
  forgeFork(params: Params<'forge.fork'>, signal: AbortSignal): Promise<Result<'forge.fork'>> {
    return this.endpoint.request('forge.fork', params, signal);
  }

  forgeOpenMergeRequest(params: Params<'forge.openMergeRequest'>): Promise<Result<'forge.openMergeRequest'>> {
    return this.request('forge.openMergeRequest', params);
  }

  forgeOpenOrgAccess(params: Params<'forge.openOrgAccess'>): Promise<Result<'forge.openOrgAccess'>> {
    return this.request('forge.openOrgAccess', params);
  }

  onForgeCiChanged(listener: (event: CoreEvents['forge.ci.changed']) => void): Disposable {
    return this.endpoint.onEvent('forge.ci.changed', listener);
  }

  // ---- this computer's core: git credentials of the takeover (docs/invariants.md "GitHub and GitLab accounts")

  /** The servers with an account, as the forge mirror lists them now; undefined before core's first forge mirror. */
  forgeManagedServers(): readonly ManagedServer[] | undefined {
    return this.forgeManaged;
  }

  /** Every server of the forge mirror and whether it has an account; undefined before core's first forge mirror. */
  forgeServers(): readonly ClientForgeServer[] | undefined {
    return this.forgeServerList;
  }

  /** The servers with an account, with their kind, as remote matching reads them; undefined before core's first forge mirror. */
  forgeAccountServers(): readonly MatchableServer[] | undefined {
    return this.forgeAccountServerList;
  }

  /** A terminal's or a target's git credential request; the answer holds a credential, which is never logged. */
  forgeGitCredential(params: Params<'forge.gitCredential'>, signal?: AbortSignal): Promise<Result<'forge.gitCredential'>> {
    return this.endpoint.request('forge.gitCredential', params, signal);
  }

  e2eStubOAuth(account: string, expiresInMs: number, offline?: boolean): Promise<void> {
    return this.request('e2e.stubOAuth', { account, expiresInMs, ...(offline !== undefined ? { offline } : {}) });
  }

  private request<M extends keyof MainRequests>(method: M, params: Params<M>): Promise<Result<M>> {
    return this.endpoint.request(method, params as never) as Promise<Result<M>>;
  }
}
