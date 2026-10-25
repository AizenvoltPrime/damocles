// The core protocol's contract: what Damocles Core and desktop main send each other. Each side parses what it receives with
// these tables, so a message outside them is a protocol violation.

import type { PanelWorktreeStateEvent } from '../../core/chat-panel/panel-worktrees';
import type { ChatPermissions } from '../../core/permission-handler/types';
import type { ChatActivity } from '../../core/pi-session/session-state';
import type { EndedLeaseHolder } from '../../core/pi-session/session-store/session-lease';
import type { AskpassPaths } from '../../core/scm/askpass/askpass-server';
import type { RemoteOp, RemoteOutcome, RemoteOutcomeKind } from '../../core/scm/scm-service';
import type { WorkerName } from '../../platform/app-paths';
import type { PickFileOptions, PickFolderOptions, InputBoxOptions } from '../../platform/dialog-service';
import type { ActiveEditorContext, DiffSide, OpenFileOptions } from '../../platform/editor-service';
import type { OpenFolder } from '../../platform/workspace-folders';
import type { PageSpec } from '../../shared/panel-html';
import { MAX_BROKER_EXPIRES_IN_MS, type BrokerAnswer, type ClientAuth, type ClientPolicy, type ClientUser, type HeldAuth } from '../../shared/remote-user';
import { SETTINGS_ACCOUNT_IDS, SETTINGS_SECTION_IDS, type SettingsAccountId, type SettingsSectionId } from '../../shared/settings-sections';
import { WORKTREE_PHASES, type ChatPlace, type ChatReviewScope, type SettingsFileScope, type WorktreeFinishAction } from '../../shared/types/messages';
import { MAX_CALL_ARGS, REPOSITORY_CALLS, SCM_CALLS, WORKTREE_CALLS, type RepositoryCall, type ScmCall, type WorktreeCall } from './scm-calls';
import { arr, bool, bytes, data, dict, either, int, INVALID, maybe, nonEmpty, none, num, obj, oneOf, opt, str, type Parser } from './schema';

export const MAX_ID_CHARS = 128;
// secret and memento keys
export const MAX_KEY_CHARS = 1024;
export const MAX_PATH_CHARS = 32_767;
// titles, labels, prompts, language ids
export const MAX_LABEL_CHARS: number = 64 * 1024;
// notification and error messages, urls, secret values, typed answers
export const MAX_MESSAGE_CHARS: number = 1024 * 1024;
// html, file text, selections, webview messages, memento values; main's renderer relay takes 64 MiB of JSON (views.ts)
export const MAX_DATA_CHARS: number = 64 * 1024 * 1024;
export const MAX_ITEMS = 100_000;
export const MAX_ACTIONS = 64;

// The browser page messages main parses out of a core post to persist the page's state (views.ts); the rest it forwards unparsed.
export const PAGE_STATE_TYPES: ReadonlySet<string> = new Set(['urlChanged', 'navigationState', 'pickingStateChanged']);

// Stands in for the file name in a diff title template; main puts the file's current name in its place.
export const DIFF_TITLE_NAME = '\u0000name\u0000';

export type StateScope = 'global' | 'workspace';

// The key-value state that is the client's on a daemon's core, set in the User tab: the language preference
// (LANGUAGE_PREFERENCE_KEY) and the prefer-API-key flag (OPENAI_PREFER_API_KEY_STATE). A daemon's core never writes them.
export const CLIENT_STATE_KEYS: readonly string[] = ['userLanguagePreference', 'damocles.openai.preferApiKey'];

/**
 * A panel envelope's panelId is its view's id on both sides: core issues it for a panel core creates, main for a chat view
 * main creates and core attaches to (chats.restore, chats.startInWorktree).
 */
export interface PanelCreate {
  readonly kind: 'chat' | 'browser';
  readonly title: string;
  readonly localResourceRoots: readonly string[];
  readonly column?: number;
  // a browser page's chat, by its view id
  readonly owner?: string;
}

/** A folder a chat may work in, as WorkspaceFolderRegistry resolves it, with its checked-out branch. */
export interface FolderTargetEntry {
  readonly key: string;
  readonly fsPath: string;
  readonly name: string;
  readonly label: string;
  readonly projectScope: boolean;
  readonly ownerKey?: string;
  readonly branch?: string;
}

/** A chat core registered, as main reads it synchronously. panelId is PanelManager's; viewId names its view. */
export interface ChatEntry {
  readonly panelId: string;
  readonly viewId: string;
  // the stored session the chat is on or about to open
  readonly sessionId?: string;
  // the stored session a restore its lease refused opens once the lease turns stale; the chat restores until then
  readonly restoring?: string;
  readonly hasConversation: boolean;
  readonly folder: FolderTargetEntry;
  // the folder its settings read (settingsFolderOf); none for the home target
  readonly settingsFolder?: { readonly path: string; readonly personalPath?: string };
  // the first prompt the chat holds for its worktree
  readonly heldPrompt?: readonly unknown[];
  // main hands them to the next core's restore of the chat after this core ends (chats.restore)
  readonly permissions: ChatPermissions;
}

export type { ChatPermissions };

export interface DiffShow {
  // the tab title with DIFF_TITLE_NAME where the file name goes
  readonly titleTemplate: string;
  readonly filePath: string;
  readonly left: DiffSide;
  readonly right: DiffSide;
  readonly purpose: 'proposal' | 'checkpoint';
  readonly column?: number;
  readonly preserveFocus?: boolean;
  readonly preview?: boolean;
  readonly panelId?: string;
  readonly approvalId?: string;
}

export interface Call<P, R> {
  readonly params: P;
  readonly result: R;
}

/** Requests core sends and main serves: the proxied services and the writes of the mirrored ones. */
export interface CoreRequests {
  'secrets.get': Call<{ readonly key: string }, string | undefined>;
  'secrets.store': Call<{ readonly key: string; readonly value: string }, void>;
  'secrets.delete': Call<{ readonly key: string }, void>;
  'secrets.keys': Call<object, readonly string[]>;
  'notifications.show': Call<
    { readonly severity: 'info' | 'warn' | 'error'; readonly message: string; readonly modal?: boolean; readonly actions: readonly string[] },
    string | undefined
  >;
  'dialogs.pickFolder': Call<PickFolderOptions, string | undefined>;
  'dialogs.pickFile': Call<PickFileOptions, string | undefined>;
  'clipboard.writeText': Call<{ readonly text: string }, void>;
  'shell.openExternal': Call<{ readonly url: string }, boolean>;
  'shell.openFolder': Call<{ readonly path: string }, boolean>;
  'shell.revealPath': Call<{ readonly path: string }, void>;
  'editor.openFile': Call<{ readonly path: string; readonly options?: OpenFileOptions }, void>;
  'editor.openUntitled': Call<{ readonly content: string; readonly language: string; readonly panelId?: string }, void>;
  'editor.readText': Call<{ readonly path: string }, string>;
  'editor.showDiff': Call<DiffShow, { readonly viewId: string }>;
  'editor.closeDiff': Call<{ readonly viewId: string }, void>;
  'editor.showMarkdownPreview': Call<{ readonly path: string; readonly panelId?: string; readonly content?: string }, void>;
  'editor.openHostSettings': Call<{ readonly query?: string; readonly section?: SettingsSectionId }, void>;
  'editor.openSettingsFile': Call<{ readonly scope: SettingsFileScope; readonly key?: string }, void>;
  'editor.showChatReview': Call<{ readonly panelId: string; readonly scope: ChatReviewScope }, void>;
  'editor.searchHostExtensions': Call<{ readonly query: string }, void>;
  'trust.request': Call<{ readonly folderPath: string }, boolean>;
  // value undefined removes the key
  'state.update': Call<{ readonly scope: StateScope; readonly key: string; readonly value: unknown }, void>;
  'lifecycle.reload': Call<object, void>;
  'network.resolveProxy': Call<{ readonly url: string }, string>;
  // a log sink of core's (logs/<name>.log) as a read-only editor tab (D36)
  'logs.show': Call<{ readonly name: string; readonly preserveFocus: boolean }, void>;
  'shell.trash': Call<{ readonly path: string }, void>;
  // desktop's MessageQuestion (main/message-dialog.ts): the index of the chosen action, undefined for Cancel
  'dialogs.ask': Call<AskQuestion, number | undefined>;
  // a git or ssh credential prompt (core/scm/askpass); the answer is a credential and is never logged
  'askpass.prompt': Call<{ readonly kind: CredentialKind; readonly text: string }, { readonly answer?: string; readonly cancelled: boolean }>;
  // Commit to a New Branch's name input for the commit main passed this token with (scm.commit)
  'scm.branchName': Call<{ readonly token: string }, string | undefined>;
  // the worktree UI main keeps (core/worktrees/host.ts WorktreeHostServices)
  'worktrees.reviewSetup': Call<{ readonly projectPath: string; readonly projectName: string; readonly commands: readonly string[] }, 'run' | 'skip'>;
  // its steps arrive as worktrees.setupStep events for the worktree
  'worktrees.runSetup': Call<{ readonly worktreeId: string; readonly cwd: string; readonly commands: readonly string[]; readonly env: Readonly<Record<string, string>> }, { readonly exitCode: number }>;
  'worktrees.showSetupTerminal': Call<{ readonly worktreeId: string }, void>;
  'worktrees.stopSetup': Call<{ readonly worktreeId: string }, void>;
  'worktrees.confirmHandOff': Call<{ readonly direction: 'toWorktree' | 'toProject'; readonly branch?: string; readonly files: readonly HandOffFile[] }, boolean>;
  'worktrees.showRefusal': Call<{ readonly kind: 'handOff' | 'apply'; readonly files: readonly WorktreeFileEntry[] }, void>;
  'worktrees.showApplyConflicts': Call<{ readonly worktreeId: string; readonly files: readonly string[] }, void>;
  // a daemon's core: the token broker's ask, answered by the client clientId names and no other
  'user.credentials': Call<{ readonly provider: string; readonly clientId: string }, BrokerAnswer>;
  // a daemon's core: speak a chat's final reply on the client that shows the view
  'user.voice.speak': Call<{ readonly viewId: string; readonly text: string }, void>;
}

export type { BrokerAnswer, ClientAuth, ClientPolicy, ClientUser, HeldAuth };

export type CredentialKind = 'username' | 'password' | 'passphrase' | 'confirm' | 'notice';

export interface AskQuestion {
  readonly severity: 'info' | 'warning' | 'danger';
  readonly message: string;
  readonly detail?: string;
  readonly actions: readonly string[];
  readonly cancelLabel?: string;
  readonly defaultAction?: number;
  readonly preview?: readonly string[];
}

export interface WorktreeFileEntry {
  readonly path: string;
  readonly letter: string;
}

export interface HandOffFile extends WorktreeFileEntry {
  readonly alsoUserEdits: boolean;
}

/**
 * Requests main sends and core serves: the engine's actions, and each decision that needs core's exact state (an unload, a
 * lease check), which core makes instead of main acting on its mirror. Engine payloads (catalog rows, attachments, review
 * diffs, webview messages) are checked as bounded data; the ids and keys main or core act on are parsed field by field.
 */
export interface MainRequests {
  // ChatPanelProvider.dispose, then every config write core queued
  'core.shutdown': Call<object, void>;
  // core attaches to a chat view main created and restores it there; settles once core set it up, registered or not
  'chats.restore': Call<{ readonly viewId: string; readonly folderKey?: string; readonly permissions?: ChatPermissions }, void>;
  'chats.startInWorktree': Call<{ readonly viewId: string; readonly projectKey: string; readonly worktreeId: string }, void>;
  // settles once core set up a chat it created itself, registered or not
  'chats.whenSetUp': Call<{ readonly viewId: string }, void>;
  'chats.setWorktreeOptIn': Call<{ readonly panelId: string; readonly startRef: string; readonly bringChanges: boolean }, void>;
  'chats.restoreDraft': Call<{ readonly panelId: string; readonly content: readonly unknown[] }, void>;
  'chats.restorePages': Call<{ readonly viewId: string; readonly urls: readonly string[]; readonly activePage?: number }, void>;
  'chats.mention': Call<{ readonly panelId: string; readonly target: MentionTargetData }, void>;
  // false: core refused it and told the user
  'chats.addAttachment': Call<{ readonly panelId: string; readonly attachment: unknown; readonly prompt?: string }, boolean>;
  'chats.handOff': Call<{ readonly panelId: string; readonly to: ChatPlace }, void>;
  'chats.open': Call<object, void>;
  'chats.newSession': Call<object, void>;
  'chats.cancelSession': Call<object, void>;
  'chats.postToActive': Call<{ readonly message: unknown }, void>;
  // only while the chat is loaded; never reveals or opens one
  'chats.post': Call<{ readonly panelId: string; readonly message: unknown }, void>;
  // the requested chat while loaded, else the selected chat, else the first loaded one (view ids, in load order), else a new one
  'chats.deliver': Call<{ readonly panelId?: string; readonly selected?: string; readonly chats: readonly string[]; readonly message: unknown }, string>;
  // false when the chat closed before its webview was ready
  'chats.whenReady': Call<{ readonly panelId: string }, boolean>;
  // core closes the chat only while it is still idle, and when empty is set, still has no conversation and no session file
  'chats.unload': Call<{ readonly viewId: string; readonly empty: boolean }, boolean>;
  // the chat a host prompt would render in (PanelManager.promptTarget)
  'chats.promptTarget': Call<object, string | undefined>;
  'chats.whenFolderReleased': Call<{ readonly fsPath: string }, void>;
  'chats.whenWorktreeDiscarded': Call<{ readonly panelId: string }, void>;
  // D33's busy rule over the project's loaded chats, its worktrees' included
  'chats.projectBusy': Call<{ readonly projectKey: string }, boolean>;
  // whether another holder keeps the session from opening here; announce tells the user, offering a takeover (chat.takeover)
  'chats.leaseRefusal': Call<{ readonly sessionId: string; readonly announce: boolean }, boolean>;
  'catalog.list': Call<{ readonly projectKey: string; readonly complete: boolean }, readonly unknown[]>;
  'catalog.search': Call<{ readonly projectKey: string; readonly query: string }, readonly unknown[]>;
  'catalog.rename': Call<{ readonly sessionId: string; readonly name: string }, unknown>;
  'catalog.tag': Call<{ readonly sessionId: string; readonly tag: string | null }, unknown>;
  'catalog.delete': Call<{ readonly sessionId: string }, unknown>;
  'folders.setDefault': Call<{ readonly key: string }, void>;
  'browser.newPage': Call<{ readonly chatViewId: string }, void>;
  'worktree.retrySetup': Call<{ readonly worktreeId: string }, void>;
  // the hold's id, or undefined when a chat working there is busy (D33)
  'worktree.beginFinish': Call<{ readonly worktreeId: string; readonly action: WorktreeFinishAction }, string | undefined>;
  'worktree.endFinish': Call<{ readonly hold: string }, void>;
  // ChatSession's review reads (D60), by core panel id; undefined when the chat is not loaded
  'review.snapshot': Call<{ readonly panelId: string; readonly scope: ChatReviewScope; readonly fresh: boolean }, unknown>;
  'review.fileDiff': Call<{ readonly panelId: string; readonly scope: ChatReviewScope; readonly path: string }, unknown>;
  'review.anchor': Call<{ readonly panelId: string; readonly comment: unknown }, string | undefined>;
  'review.stale': Call<{ readonly panelId: string; readonly checks: readonly unknown[] }, readonly unknown[]>;
  'review.submit': Call<{ readonly panelId: string; readonly drafts: readonly unknown[] }, unknown>;
  // the settings modal attached to a chat (PanelManager.attachView); its posts come back as settingsView.post
  // scope: the settings overlay tab it serves (absent: a local chat's overlay); the view shows only the keys that scope writes
  'settingsView.attach': Call<{ readonly panelId: string; readonly attachment: number; readonly scope?: SettingsViewScope }, void>;
  'settingsView.dispatch': Call<{ readonly attachment: number; readonly message: unknown }, void>;
  'settingsView.detach': Call<{ readonly attachment: number }, void>;
  // a view main made for a panel core holds, whose page holds the panel's token as viewKey; answers the panel's id, or null
  // when no panel holds that token. Core replays the conversation and live state to it, never changing the panel's token.
  'views.join': Call<{ readonly viewId: string; readonly viewKey: string }, { readonly panelId: string } | null>;
  // core's ScmService (scm-calls.ts): a method of SCM_CALLS with its arguments, answered with its result
  'scm.call': Call<{ readonly method: ScmCall; readonly args: readonly unknown[] }, unknown>;
  // ScmService.commit; branchName names the token core asks scm.branchName with, saved the documents saved just before
  'scm.commit': Call<{ readonly repoId: string; readonly message: string; readonly variant: unknown; readonly saved: readonly string[]; readonly branchName?: string }, unknown>;
  'scm.ignoredIn': Call<{ readonly projectKey: string; readonly relativeDir: string; readonly entries: readonly { readonly name: string; readonly dir: boolean }[] }, readonly string[]>;
  'scm.commitBlob': Call<{ readonly repoId: string; readonly commit: string; readonly path: string }, Uint8Array | 'tooLarge' | undefined>;
  // D24's message over the repository's changes, on the Background model
  'scm.generateMessage': Call<{ readonly repoId: string }, unknown>;
  // a read of an open repository (scm-calls.ts REPOSITORY_CALLS)
  'scm.repo': Call<{ readonly repoId: string; readonly method: RepositoryCall; readonly args: readonly unknown[] }, unknown>;
  // core's worktree git and registry work (scm-calls.ts WORKTREE_CALLS), records named by id
  'worktrees.call': Call<{ readonly method: WorktreeCall; readonly args: readonly unknown[] }, unknown>;
  // unpackaged builds with DAMOCLES_E2E_HOOKS=1 only
  'e2e.inputBox': Call<InputBoxOptions, string | undefined>;
  'e2e.routeBrowser': Call<{ readonly pattern: string; readonly toHost: string }, void>;
  'e2e.routedRequests': Call<object, readonly string[]>;
  // core's capabilities read this platform; null restores the real one, which is returned
  'e2e.setPlatform': Call<{ readonly platform: string | null }, string>;
  // from now on a rename to a file with this basename waits delayMs first
  'e2e.slowRenames': Call<{ readonly basename: string; readonly delayMs: number }, void>;
  'e2e.slowedRenames': Call<{ readonly basename: string }, number>;
  // core's next core.shutdown never settles
  'e2e.holdShutdown': Call<object, void>;
  // the first call starts core's recursive watch of folder; every call returns the paths it reported created
  'e2e.watchProbe': Call<{ readonly folder: string }, readonly string[]>;
  'e2e.stopWatchProbe': Call<{ readonly folder: string }, void>;
  // core's voice recording starts a stand-in recorder from now on and transcribes as transcript; pid is core's
  'e2e.fakeVoice': Call<{ readonly transcript: string }, { readonly pid: number }>;
  // how often core started a recorder since fakeVoice, and the last one's pid
  'e2e.voiceRecorder': Call<object, { readonly starts: number; readonly recorderPid: number | null }>;
  // this computer's core: a credential for a daemon's broker, resolved and refreshed by its own pi
  'user.resolveCredential': Call<{ readonly provider: string }, BrokerAnswer>;
  // this computer's core: every provider pi knows with its non-secret credential state, for the clientAuth mirror
  'user.clientAuth': Call<object, HeldAuth>;
  // this computer's core speaks a remote chat's reply; its voice consent applies
  'user.voice.speak': Call<{ readonly viewId: string; readonly text: string }, void>;
  // this computer's core: a proxy for a remote chat's view, which only VOICE_VIEW_MESSAGES reach
  'panels.attachForeign': Call<{ readonly authority: string; readonly viewId: string }, void>;
  'panels.detachForeign': Call<{ readonly viewId: string }, void>;
  'panels.foreignMessage': Call<{ readonly viewId: string; readonly message: unknown }, void>;
}

export type SettingsViewScope = 'user' | 'machine' | 'project';

export type MentionTargetData = { readonly projectKey: string; readonly relativePath: string } | { readonly path: string };

export interface CoreEvents {
  'window.openAppSettings': { readonly section?: SettingsSectionId; readonly account?: SettingsAccountId };
  'window.toggleTerminal': object;
  // after the chats mirror shows the change
  'chat.activity': { readonly panelId: string; readonly activity: ChatActivity };
  'chat.turnSettled': { readonly panelId: string; readonly outcome: unknown };
  'chat.changes': { readonly panelId: string; readonly totals: unknown; readonly generation: number };
  'chat.usageThreshold': { readonly crossing: unknown };
  'chat.worktreeState': { readonly event: PanelWorktreeStateEvent };
  'chat.allClosed': object;
  // the user chose Open here on a lease refusal chats.leaseRefusal announced
  'chat.takeover': { readonly sessionId: string };
  'catalog.changed': { readonly projectKey?: string };
  'settingsView.post': { readonly attachment: number; readonly message: unknown };
  'settingsView.detached': { readonly attachment: number };
  // a ScmService event, after the scm mirror shows it
  'scm.changed': { readonly event: unknown };
  'worktrees.newChatInWorktree': { readonly projectPath: string; readonly worktreeId: string };
  'worktrees.newChatInProject': { readonly projectPath: string };
  // a daemon's core: the providers a chat's runs read through the token broker, for the daemon's run registry
  'chat.providers': { readonly panelId: string; readonly providers: readonly string[] };
  // this computer's core: a foreign proxy's post to a remote chat's view, which main delivers after its own checks
  'panel.foreignPost': { readonly viewId: string; readonly message: unknown };
  // this computer's core: a credential changed, so user.clientAuth answers differently
  'user.clientAuthChanged': object;
}

export interface MainEvents {
  'secrets.changed': { readonly key: string };
  // powerMonitor's suspend and resume: the machine went to sleep, and woke
  'power.suspend': object;
  'power.resume': object;
  // a command of the setup worktrees.runSetup runs started; index is 1-based
  'worktrees.setupStep': { readonly worktreeId: string; readonly index: number; readonly total: number; readonly command: string };
}

/** Mirror topics core publishes, each delta's patch; main starts each core's mirror empty. */
export interface CoreMirrorTopics {
  // entry undefined: the chat closed
  chats: { readonly panelId: string; readonly entry?: ChatEntry };
  folderTargets: { readonly defaultKey: string; readonly targets: readonly FolderTargetEntry[] };
  // every record of core's worktree registry; main checks each against its own registry folder (core/worktrees/records.ts)
  worktrees: { readonly records: readonly unknown[] };
  scm: ScmMirrorPatch;
}

/** The facts main reads off an open repository; the paths and kind it acts on are parsed field by field, the snapshot as data. */
export interface ScmRepositoryEntry {
  readonly projectKey: string;
  readonly projectPath: string;
  readonly kind: 'root' | 'nested' | 'submodule' | 'parent';
  readonly root: string;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly snapshot: unknown;
}

/** A repository's flags that change without a status landing, replacing those of the snapshot main holds for it. */
export interface ScmRepositoryState {
  readonly repoId: string;
  readonly busy: boolean;
  readonly running: RemoteOp | null;
  readonly lastRemote: RemoteOutcome | null;
}

/**
 * ScmService's synchronous reads, as main's ScmClient answers them: a project's view, a repository's snapshot and the facts
 * main reads off its Repository (whole once per status revision, else only its flags), a project's decorations, and the
 * clone state. An absent view or repository closed.
 */
export type ScmMirrorPatch =
  | { readonly kind: 'view'; readonly projectKey: string; readonly view?: unknown; readonly realPath?: string }
  | { readonly kind: 'repository'; readonly repoId: string; readonly repository?: ScmRepositoryEntry }
  | ({ readonly kind: 'repositoryState' } & ScmRepositoryState)
  | { readonly kind: 'decorations'; readonly projectKey: string; readonly files: unknown }
  | { readonly kind: 'clone'; readonly state: unknown };

/** Mirror topics main publishes, each delta's patch; a topic's version 0 value is in CoreInit.mirrors. */
export interface MirrorTopics {
  // value undefined: the key was removed
  state: { readonly scope: StateScope; readonly key: string; readonly value: unknown };
  // keys: every trusted folder's folderKey; granted: the folders the grant names, as TrustService.onDidGrantTrust delivers them
  trust: { readonly keys: readonly string[]; readonly granted: readonly string[] };
  folders: { readonly folders: readonly OpenFolder[] };
  panel: { readonly panelId: string; readonly visible: boolean; readonly active: boolean; readonly column?: number };
  editor: { readonly context?: ActiveEditorContext };
  terminal: { readonly shown: boolean; readonly shortcut: string };
  // the UI language core's localization follows
  language: { readonly language: 'en' | 'el' };
  // per client: a client publishes its own value; the daemon stamps its id for the client, value undefined when it detached
  clientAuth: ClientDelta<ClientAuth>;
  clientUser: ClientDelta<ClientUser>;
  clientPolicy: ClientDelta<ClientPolicy>;
  // the daemon's: the client that most recently sent core a message, published before that message; a client's is dropped
  actingClient: { readonly clientId?: string };
}

/** A client's value of a per-client mirror; clientId is the daemon's id for that client, and a client never sets it. */
export interface ClientDelta<T> {
  readonly clientId?: string;
  readonly value?: T;
}

/** Panel envelopes core sends, addressed to a view by its id. */
export interface CorePanelOps {
  create: PanelCreate;
  // main builds the page itself; core never sends HTML
  showPage: { readonly page: PageSpec };
  // a webview message as JSON text, which main forwards unparsed; type is the message's own
  post: { readonly type: string; readonly json: string };
  // a webview message holding binary (a browser page's frame), structured-cloned
  postBinary: { readonly message: unknown };
  setIcon: { readonly path?: string };
  setTitle: { readonly title: string };
  setFolderLabel: { readonly label?: string };
  reveal: { readonly column?: number };
  close: object;
}

/**
 * Panel envelopes main sends about a core panel's view. disposed.error: the view could not be created. reason: user, the
 * user closed the chat; detach, a quit, window teardown or disconnect took the view away (a daemon keeps a panel with a run).
 */
export interface MainPanelOps {
  message: { readonly message: unknown };
  disposed: { readonly error?: string; readonly reason: 'user' | 'detach' };
}

/** What core needs from main before its platform exists: static host facts and every mirror's value at version 0. */
export interface CoreInit {
  readonly appInfo: { readonly version: string; readonly host: 'desktop' };
  readonly secretsPersistent: boolean;
  readonly chatBrowserPane: boolean;
  // core serves the e2e.* requests (unpackaged, DAMOCLES_E2E_HOOKS=1)
  readonly e2eHooks: boolean;
  // main's startup probe of git, which checkpoints follow instead of probing per session and source control runs
  readonly git: { readonly available: boolean; readonly reason?: string; readonly path?: string; readonly version?: { readonly major: number; readonly minor: number; readonly patch: number } };
  // main's app paths (main/platform/app-paths.ts), which core has no way to compute
  readonly paths: {
    readonly resourceRoot: string;
    readonly unpackedRoot: string;
    readonly workers: Readonly<Record<WorkerName, string>>;
    readonly watchWorker: string;
    readonly askpass: AskpassPaths;
  };
  // <userData>/logs, and whether a sink mirrors its lines to stdout (the unpackaged app)
  readonly logs: { readonly dir: string; readonly echo: boolean };
  // the cores that crashed in this app run and when they ended (epoch ms), whose session leases no live process holds
  readonly endedCores: readonly EndedLeaseHolder[];
  // the worktree records main last read from a core, which the registry serves while registry.json does not parse
  readonly worktreeRecords: readonly unknown[];
  // set only for a daemon's core: it deletes permanently where it would trash and refuses every user-scope write
  readonly remote?: { readonly hostId: string };
  readonly mirrors: {
    readonly state: { readonly global: Readonly<Record<string, unknown>>; readonly workspace: Readonly<Record<string, unknown>> };
    readonly trust: { readonly keys: readonly string[] };
    readonly folders: MirrorTopics['folders'];
    readonly editor: MirrorTopics['editor'];
    readonly terminal: MirrorTopics['terminal'];
    readonly language: MirrorTopics['language'];
    // by client id: a daemon's attached clients; a local core's one client is LOCAL_CLIENT_ID, with allowBypass true
    readonly clientAuth: Readonly<Record<string, ClientAuth>>;
    readonly clientUser: Readonly<Record<string, ClientUser>>;
    readonly clientPolicy: Readonly<Record<string, ClientPolicy>>;
    readonly actingClient: MirrorTopics['actingClient'];
  };
}

/** The types of what one side sends. */
export interface Contract {
  readonly requests: object;
  readonly events: object;
  readonly mirrors: object;
  readonly panelOps: object;
}

export interface CoreToMain extends Contract {
  readonly requests: CoreRequests;
  readonly events: CoreEvents;
  readonly mirrors: CoreMirrorTopics;
  readonly panelOps: CorePanelOps;
}

export interface MainToCore extends Contract {
  readonly requests: MainRequests;
  readonly events: MainEvents;
  readonly mirrors: MirrorTopics;
  readonly panelOps: MainPanelOps;
}

export interface Method<P, R> {
  readonly params: Parser<P>;
  readonly result: Parser<R>;
}

type Parsers<T> = { readonly [K in keyof T]: Parser<T[K]> };

/** The parsers of one direction's messages. */
export interface Tables<C extends Contract> {
  readonly requests: { readonly [M in keyof C['requests']]: C['requests'][M] extends Call<infer P, infer R> ? Method<P, R> : never };
  readonly events: Parsers<C['events']>;
  readonly mirrors: Parsers<C['mirrors']>;
  readonly panelOps: Parsers<C['panelOps']>;
}

const method = <P, R>(params: Parser<P>, result: Parser<R>): Method<P, R> => ({ params, result });

const id = nonEmpty(MAX_ID_CHARS);
const key = nonEmpty(MAX_KEY_CHARS);
const filePath = nonEmpty(MAX_PATH_CHARS);
const label = str(MAX_LABEL_CHARS);
const message = str(MAX_MESSAGE_CHARS);
const text = str(MAX_DATA_CHARS);
const value = data(MAX_DATA_CHARS);
const done = none;
const section = oneOf(SETTINGS_SECTION_IDS);
const account = oneOf(SETTINGS_ACCOUNT_IDS);
const stateScope = oneOf(['global', 'workspace'] as const);
const reviewScope = oneOf(['chat', 'turn'] as const);
const nul: Parser<null> = (raw) => (raw === null ? null : INVALID);
const column = opt(int(-2, 64));
const trustedKeys = arr(filePath, MAX_ITEMS);

const openFolder = obj({ fsPath: filePath, name: label, ownerKey: opt(str(MAX_PATH_CHARS)) });
const editorContext = obj({
  filePath: maybe(filePath),
  selection: maybe(obj({ startLine: num, endLine: num, text })),
});
const diffSide = either(obj({ path: filePath }), obj({ name: label, content: text }));
const panelCreate: Parser<PanelCreate> = obj({
  kind: oneOf(['chat', 'browser'] as const),
  title: label,
  localResourceRoots: arr(filePath, MAX_ACTIONS),
  column,
  owner: opt(id),
});
const folderTarget: Parser<FolderTargetEntry> = obj({
  key: filePath,
  fsPath: filePath,
  name: label,
  label,
  projectScope: bool,
  ownerKey: opt(filePath),
  branch: opt(label),
});
const chatPermissions: Parser<ChatPermissions> = obj({
  permissionMode: oneOf(['default', 'acceptEdits', 'plan'] as const),
  dangerouslySkipPermissions: bool,
});
const chatEntry: Parser<ChatEntry> = obj({
  panelId: id,
  viewId: id,
  sessionId: opt(id),
  restoring: opt(id),
  hasConversation: bool,
  folder: folderTarget,
  settingsFolder: opt(obj({ path: filePath, personalPath: opt(filePath) })),
  heldPrompt: opt(arr(value, MAX_ITEMS)),
  permissions: chatPermissions,
});
// A prompt id is a provider's tool call id, of no fixed length, so it takes a key's bound.
const pendingKind = oneOf(['approval', 'question', 'plan', 'input'] as const);
const promptOwner = either(
  obj({ kind: oneOf(['main'] as const) }),
  either(
    obj({ kind: oneOf(['subagent'] as const), agentId: key }),
    obj({ kind: oneOf(['team'] as const), teamId: key, agentId: key, teamTitle: opt(label), agentName: opt(label) }),
  ),
);
const chatActivity: Parser<ChatActivity> = obj({
  state: oneOf(['idle', 'running', 'requires_action'] as const),
  pendingKinds: arr(pendingKind, MAX_ITEMS),
  pendingPrompts: arr(obj({ id: key, kind: pendingKind, owner: promptOwner, summary: opt(label) }), MAX_ITEMS),
  background: bool,
});
const count = int(0, Number.MAX_SAFE_INTEGER);
const worktreeStateEvent: Parser<PanelWorktreeStateEvent> = obj({
  panelId: id,
  sessionId: opt(id),
  projectPath: filePath,
  worktreeId: opt(id),
  workingFolder: filePath,
  busy: bool,
  state: obj({
    phase: oneOf(WORKTREE_PHASES),
    place: oneOf(['project', 'worktree'] as const),
    canHandOff: bool,
    branch: opt(label),
    baseBranch: opt(label),
    uncommittedCount: opt(count),
    behind: opt(count),
    targetRewritten: opt(bool),
    exitCode: opt(int(-(2 ** 31), 2 ** 32)),
    error: opt(message),
    projectName: opt(label),
    sharedWith: opt(count),
    setupStep: opt(obj({ command: text, index: int(1, MAX_ITEMS), total: int(1, MAX_ITEMS) })),
    heldPrompt: opt(obj({ text, imageCount: count })),
    finishing: opt(oneOf(['apply', 'merge', 'update', 'delete'] as const)),
  }),
});
const mentionTarget: Parser<MentionTargetData> = either(obj({ projectKey: filePath, relativePath: filePath }), obj({ path: filePath }));
const rows = arr(value, MAX_ITEMS);
const viewRef = obj({ viewId: id });
const panelRef = obj({ panelId: id });
const attachmentRef = obj({ attachment: int(1, Number.MAX_SAFE_INTEGER) });
const nothing = obj({});
const postText = obj({ type: label, json: text });
// a page-state post must hold a JSON object, since main parses it
const panelPost: Parser<{ readonly type: string; readonly json: string }> = (raw) => {
  const post = postText(raw);
  if (post === INVALID || !PAGE_STATE_TYPES.has(post.type)) return post;
  try {
    const parsed: unknown = JSON.parse(post.json);
    return typeof parsed === 'object' && parsed !== null ? post : INVALID;
  } catch {
    return INVALID;
  }
};
const worktreeFile = obj({ path: filePath, letter: label });
const scmRepository: Parser<ScmRepositoryEntry> = obj({
  projectKey: filePath,
  projectPath: filePath,
  kind: oneOf(['root', 'nested', 'submodule', 'parent'] as const),
  root: filePath,
  gitDir: filePath,
  commonDir: filePath,
  snapshot: value,
});
const nullable = <T>(parser: Parser<T>): Parser<T | null> => (raw) => (raw === null ? null : parser(raw));
const REMOTE_OPS = Object.keys({ fetch: 0, pull: 0, push: 0, sync: 0, deleteRemoteBranch: 0, deleteRemoteTag: 0 } satisfies Record<RemoteOp, 0>) as readonly RemoteOp[];
const REMOTE_OUTCOMES = Object.keys({ ok: 0, failed: 0, cancelled: 0 } satisfies Record<RemoteOutcomeKind, 0>) as readonly RemoteOutcomeKind[];
const scmRepositoryState = obj({
  kind: oneOf(['repositoryState'] as const),
  repoId: id,
  busy: bool,
  running: nullable(oneOf(REMOTE_OPS)),
  lastRemote: nullable(obj({ op: oneOf(REMOTE_OPS), outcome: oneOf(REMOTE_OUTCOMES), stashKept: bool, seq: int(0, Number.MAX_SAFE_INTEGER) })),
});
const callArgs = arr(value, MAX_CALL_ARGS);
const strings = arr(label, MAX_ITEMS);
const brokerAnswer: Parser<BrokerAnswer> = either(
  obj({
    type: oneOf(['oauth'] as const),
    access: nonEmpty(MAX_MESSAGE_CHARS),
    expiresIn: int(0, MAX_BROKER_EXPIRES_IN_MS),
    refresh: oneOf([''] as const),
    clientId: opt(label),
    scopes: opt(strings),
    enterpriseUrl: opt(message),
    accountId: opt(label),
    availableModelIds: opt(strings),
  }),
  either(obj({ type: oneOf(['api_key'] as const), key: nonEmpty(MAX_MESSAGE_CHARS) }), obj({ type: oneOf(['none'] as const) })),
);
const authType = oneOf(['oauth', 'api_key', 'none'] as const);
const clientAuth: Parser<ClientAuth> = obj({
  providers: dict(obj({ type: authType, expiresIn: opt(int(0, Number.MAX_SAFE_INTEGER)), hasKey: bool, flatFee: bool, allowance: opt(bool) }), MAX_ID_CHARS, MAX_ITEMS),
});
const heldAuth: Parser<HeldAuth> = obj({
  providers: dict(obj({ type: authType, expires: opt(num), hasKey: bool, flatFee: bool, allowance: opt(bool) }), MAX_ID_CHARS, MAX_ITEMS),
});
const clientUser: Parser<ClientUser> = obj({
  settings: dict(value, MAX_KEY_CHARS, MAX_ITEMS),
  permissionRules: arr(obj({ allow: strings, ask: strings, deny: strings, dir: oneOf(['.damocles', '.claude'] as const) }), MAX_ACTIONS),
});
const clientPolicy: Parser<ClientPolicy> = obj({
  voice: bool,
  allowBypass: bool,
  defaultPermissionMode: opt(oneOf(['default', 'acceptEdits', 'plan'] as const)),
  sharedLoopback: opt(bool),
});
const clientDelta = <T>(parser: Parser<T>) => obj({ clientId: opt(id), value: opt(parser) });
const actingClient = obj({ clientId: opt(id) });
const pageSpec: Parser<PageSpec> = either(
  obj({ kind: oneOf(['chat', 'error'] as const) }),
  obj({ kind: oneOf(['browser'] as const), toolbar: bool }),
);

const CORE_REQUESTS: Tables<CoreToMain>['requests'] = {
  'secrets.get': method(obj({ key }), maybe(message)),
  'secrets.store': method(obj({ key, value: message }), done),
  'secrets.delete': method(obj({ key }), done),
  'secrets.keys': method(obj({}), arr(key, MAX_ITEMS)),
  'notifications.show': method(
    obj({ severity: oneOf(['info', 'warn', 'error'] as const), message, modal: opt(bool), actions: arr(label, MAX_ACTIONS) }),
    maybe(label),
  ),
  'dialogs.pickFolder': method(obj({ title: opt(label), defaultPath: opt(filePath), buttonLabel: opt(label) }), maybe(filePath)),
  'dialogs.pickFile': method(
    obj({ title: opt(label), defaultPath: opt(filePath), filters: opt(dict(arr(label, MAX_ACTIONS), MAX_LABEL_CHARS, MAX_ACTIONS)) }),
    maybe(filePath),
  ),
  'clipboard.writeText': method(obj({ text }), done),
  'shell.openExternal': method(obj({ url: message }), bool),
  'shell.openFolder': method(obj({ path: filePath }), bool),
  'shell.revealPath': method(obj({ path: filePath }), done),
  'editor.openFile': method(
    obj({
      path: filePath,
      options: opt(obj({ line: opt(num), preview: opt(bool), editor: opt(oneOf(['text'] as const)), panelId: opt(id), preserveFocus: opt(bool) })),
    }),
    done,
  ),
  'editor.openUntitled': method(obj({ content: text, language: label, panelId: opt(id) }), done),
  'editor.readText': method(obj({ path: filePath }), text),
  'editor.showDiff': method(
    obj({
      titleTemplate: label,
      filePath,
      left: diffSide,
      right: diffSide,
      purpose: oneOf(['proposal', 'checkpoint'] as const),
      column,
      preserveFocus: opt(bool),
      preview: opt(bool),
      panelId: opt(id),
      approvalId: opt(label),
    }),
    obj({ viewId: id }),
  ),
  'editor.closeDiff': method(obj({ viewId: id }), done),
  'editor.showMarkdownPreview': method(obj({ path: filePath, panelId: opt(id), content: opt(text) }), done),
  'editor.openHostSettings': method(obj({ query: opt(label), section: opt(section) }), done),
  'editor.openSettingsFile': method(obj({ scope: oneOf(['user', 'project', 'local'] as const), key: opt(label) }), done),
  'editor.showChatReview': method(obj({ panelId: id, scope: reviewScope }), done),
  'editor.searchHostExtensions': method(obj({ query: label }), done),
  'trust.request': method(obj({ folderPath: filePath }), bool),
  'state.update': method(obj({ scope: stateScope, key, value }), done),
  'lifecycle.reload': method(obj({}), done),
  'network.resolveProxy': method(obj({ url: message }), label),
  'logs.show': method(obj({ name: id, preserveFocus: bool }), done),
  'shell.trash': method(obj({ path: filePath }), done),
  'dialogs.ask': method(
    obj({
      severity: oneOf(['info', 'warning', 'danger'] as const),
      message,
      detail: opt(message),
      actions: arr(label, MAX_ACTIONS),
      cancelLabel: opt(label),
      defaultAction: opt(int(0, MAX_ACTIONS)),
      preview: opt(arr(text, MAX_ITEMS)),
    }),
    maybe(int(0, MAX_ACTIONS)),
  ),
  'askpass.prompt': method(
    obj({ kind: oneOf(['username', 'password', 'passphrase', 'confirm', 'notice'] as const), text: message }),
    obj({ answer: opt(message), cancelled: bool }),
  ),
  'scm.branchName': method(obj({ token: id }), maybe(label)),
  'worktrees.reviewSetup': method(obj({ projectPath: filePath, projectName: label, commands: arr(text, MAX_ITEMS) }), oneOf(['run', 'skip'] as const)),
  'worktrees.runSetup': method(
    obj({ worktreeId: id, cwd: filePath, commands: arr(text, MAX_ITEMS), env: dict(message, MAX_KEY_CHARS, MAX_ACTIONS) }),
    obj({ exitCode: int(-(2 ** 31), 2 ** 32) }),
  ),
  'worktrees.showSetupTerminal': method(obj({ worktreeId: id }), done),
  'worktrees.stopSetup': method(obj({ worktreeId: id }), done),
  'worktrees.confirmHandOff': method(
    obj({ direction: oneOf(['toWorktree', 'toProject'] as const), branch: opt(label), files: arr(obj({ path: filePath, letter: label, alsoUserEdits: bool }), MAX_ITEMS) }),
    bool,
  ),
  'worktrees.showRefusal': method(obj({ kind: oneOf(['handOff', 'apply'] as const), files: arr(worktreeFile, MAX_ITEMS) }), done),
  'worktrees.showApplyConflicts': method(obj({ worktreeId: id, files: arr(filePath, MAX_ITEMS) }), done),
  'user.credentials': method(obj({ provider: id, clientId: id }), brokerAnswer),
  'user.voice.speak': method(obj({ viewId: id, text }), done),
};

const MIRROR_TOPICS: Tables<MainToCore>['mirrors'] = {
  state: obj({ scope: stateScope, key, value }),
  trust: obj({ keys: trustedKeys, granted: arr(filePath, MAX_ITEMS) }),
  folders: obj({ folders: arr(openFolder, MAX_ITEMS) }),
  panel: obj({ panelId: id, visible: bool, active: bool, column }),
  editor: obj({ context: opt(editorContext) }),
  terminal: obj({ shown: bool, shortcut: label }),
  language: obj({ language: oneOf(['en', 'el'] as const) }),
  clientAuth: clientDelta(clientAuth),
  clientUser: clientDelta(clientUser),
  clientPolicy: clientDelta(clientPolicy),
  actingClient,
};

const MAIN_REQUESTS: Tables<MainToCore>['requests'] = {
  'core.shutdown': method(nothing, done),
  'chats.restore': method(obj({ viewId: id, folderKey: opt(filePath), permissions: opt(chatPermissions) }), done),
  'chats.startInWorktree': method(obj({ viewId: id, projectKey: filePath, worktreeId: id }), done),
  'chats.whenSetUp': method(viewRef, done),
  'chats.setWorktreeOptIn': method(obj({ panelId: id, startRef: label, bringChanges: bool }), done),
  'chats.restoreDraft': method(obj({ panelId: id, content: rows }), done),
  'chats.restorePages': method(obj({ viewId: id, urls: arr(message, MAX_ITEMS), activePage: opt(int(0, MAX_ITEMS)) }), done),
  'chats.mention': method(obj({ panelId: id, target: mentionTarget }), done),
  'chats.addAttachment': method(obj({ panelId: id, attachment: value, prompt: opt(text) }), bool),
  'chats.handOff': method(obj({ panelId: id, to: oneOf(['project', 'worktree'] as const) }), done),
  'chats.open': method(nothing, done),
  'chats.newSession': method(nothing, done),
  'chats.cancelSession': method(nothing, done),
  'chats.postToActive': method(obj({ message: value }), done),
  'chats.post': method(obj({ panelId: id, message: value }), done),
  'chats.deliver': method(obj({ panelId: opt(id), selected: opt(id), chats: arr(id, MAX_ITEMS), message: value }), id),
  'chats.whenReady': method(panelRef, bool),
  'chats.unload': method(obj({ viewId: id, empty: bool }), bool),
  'chats.promptTarget': method(nothing, maybe(id)),
  'chats.whenFolderReleased': method(obj({ fsPath: filePath }), done),
  'chats.whenWorktreeDiscarded': method(panelRef, done),
  'chats.projectBusy': method(obj({ projectKey: filePath }), bool),
  'chats.leaseRefusal': method(obj({ sessionId: id, announce: bool }), bool),
  'catalog.list': method(obj({ projectKey: filePath, complete: bool }), rows),
  'catalog.search': method(obj({ projectKey: filePath, query: label }), rows),
  'catalog.rename': method(obj({ sessionId: id, name: label }), value),
  'catalog.tag': method(obj({ sessionId: id, tag: either(label, nul) }), value),
  'catalog.delete': method(obj({ sessionId: id }), value),
  'folders.setDefault': method(obj({ key: filePath }), done),
  'browser.newPage': method(obj({ chatViewId: id }), done),
  'worktree.retrySetup': method(obj({ worktreeId: id }), done),
  'worktree.beginFinish': method(obj({ worktreeId: id, action: oneOf(['apply', 'merge', 'update', 'delete'] as const) }), maybe(id)),
  'worktree.endFinish': method(obj({ hold: id }), done),
  'review.snapshot': method(obj({ panelId: id, scope: reviewScope, fresh: bool }), value),
  'review.fileDiff': method(obj({ panelId: id, scope: reviewScope, path: filePath }), value),
  'review.anchor': method(obj({ panelId: id, comment: value }), maybe(text)),
  'review.stale': method(obj({ panelId: id, checks: rows }), rows),
  'review.submit': method(obj({ panelId: id, drafts: rows }), value),
  'settingsView.attach': method(obj({ panelId: id, attachment: int(1, Number.MAX_SAFE_INTEGER), scope: opt(oneOf(['user', 'machine', 'project'] as const)) }), done),
  'settingsView.dispatch': method(obj({ attachment: int(1, Number.MAX_SAFE_INTEGER), message: value }), done),
  'settingsView.detach': method(attachmentRef, done),
  'views.join': method(obj({ viewId: id, viewKey: key }), either(obj({ panelId: id }), nul)),
  'scm.call': method(obj({ method: oneOf(SCM_CALLS), args: callArgs }), value),
  'scm.commit': method(obj({ repoId: id, message: text, variant: value, saved: arr(filePath, MAX_ITEMS), branchName: opt(id) }), value),
  'scm.ignoredIn': method(obj({ projectKey: filePath, relativeDir: str(MAX_PATH_CHARS), entries: arr(obj({ name: filePath, dir: bool }), MAX_ITEMS) }), arr(filePath, MAX_ITEMS)),
  'scm.commitBlob': method(obj({ repoId: id, commit: label, path: filePath }), maybe(either(oneOf(['tooLarge'] as const), bytes(MAX_DATA_CHARS)))),
  'scm.generateMessage': method(obj({ repoId: id }), value),
  'scm.repo': method(obj({ repoId: id, method: oneOf(REPOSITORY_CALLS), args: callArgs }), value),
  'worktrees.call': method(obj({ method: oneOf(WORKTREE_CALLS), args: callArgs }), value),
  'e2e.inputBox': method(obj({ prompt: opt(label), placeholder: opt(label), password: opt(bool), ignoreFocusOut: opt(bool) }), maybe(message)),
  'e2e.routeBrowser': method(obj({ pattern: label, toHost: label }), done),
  'e2e.routedRequests': method(nothing, arr(message, MAX_ITEMS)),
  'e2e.setPlatform': method(obj({ platform: either(label, nul) }), label),
  'e2e.slowRenames': method(obj({ basename: filePath, delayMs: int(0, 60_000) }), done),
  'e2e.slowedRenames': method(obj({ basename: filePath }), int(0, Number.MAX_SAFE_INTEGER)),
  'e2e.holdShutdown': method(nothing, done),
  'e2e.watchProbe': method(obj({ folder: filePath }), arr(filePath, MAX_ITEMS)),
  'e2e.stopWatchProbe': method(obj({ folder: filePath }), done),
  'e2e.fakeVoice': method(obj({ transcript: text }), obj({ pid: int(1, 2 ** 32) })),
  'e2e.voiceRecorder': method(nothing, obj({ starts: count, recorderPid: nullable(int(1, 2 ** 32)) })),
  'user.resolveCredential': method(obj({ provider: id }), brokerAnswer),
  'user.clientAuth': method(nothing, heldAuth),
  'user.voice.speak': method(obj({ viewId: id, text }), done),
  'panels.attachForeign': method(obj({ authority: filePath, viewId: id }), done),
  'panels.detachForeign': method(viewRef, done),
  'panels.foreignMessage': method(obj({ viewId: id, message: value }), done),
};

export const CORE_TO_MAIN: Tables<CoreToMain> = {
  requests: CORE_REQUESTS,
  events: {
    'window.openAppSettings': obj({ section: opt(section), account: opt(account) }),
    'window.toggleTerminal': nothing,
    'chat.activity': obj({ panelId: id, activity: chatActivity }),
    'chat.turnSettled': obj({ panelId: id, outcome: value }),
    'chat.changes': obj({ panelId: id, totals: value, generation: num }),
    'chat.usageThreshold': obj({ crossing: value }),
    'chat.worktreeState': obj({ event: worktreeStateEvent }),
    'chat.allClosed': nothing,
    'chat.takeover': obj({ sessionId: id }),
    'catalog.changed': obj({ projectKey: opt(filePath) }),
    'settingsView.post': obj({ attachment: int(1, Number.MAX_SAFE_INTEGER), message: value }),
    'settingsView.detached': attachmentRef,
    'scm.changed': obj({ event: value }),
    'worktrees.newChatInWorktree': obj({ projectPath: filePath, worktreeId: id }),
    'worktrees.newChatInProject': obj({ projectPath: filePath }),
    'chat.providers': obj({ panelId: id, providers: arr(id, MAX_ACTIONS) }),
    'panel.foreignPost': obj({ viewId: id, message: value }),
    'user.clientAuthChanged': nothing,
  },
  mirrors: {
    chats: obj({ panelId: id, entry: opt(chatEntry) }),
    folderTargets: obj({ defaultKey: filePath, targets: arr(folderTarget, MAX_ITEMS) }),
    worktrees: obj({ records: rows }),
    scm: either(
      either(obj({ kind: oneOf(['view'] as const), projectKey: filePath, view: opt(value), realPath: opt(filePath) }), either(obj({ kind: oneOf(['repository'] as const), repoId: id, repository: opt(scmRepository) }), scmRepositoryState)),
      either(obj({ kind: oneOf(['decorations'] as const), projectKey: filePath, files: value }), obj({ kind: oneOf(['clone'] as const), state: value })),
    ),
  },
  panelOps: {
    create: panelCreate,
    showPage: obj({ page: pageSpec }),
    post: panelPost,
    postBinary: obj({ message: value }),
    setIcon: obj({ path: opt(filePath) }),
    setTitle: obj({ title: label }),
    setFolderLabel: obj({ label: opt(label) }),
    reveal: obj({ column }),
    close: obj({}),
  },
};

export const MAIN_TO_CORE: Tables<MainToCore> = {
  requests: MAIN_REQUESTS,
  events: {
    'secrets.changed': obj({ key }),
    'power.suspend': nothing,
    'power.resume': nothing,
    'worktrees.setupStep': obj({ worktreeId: id, index: int(1, MAX_ITEMS), total: int(1, MAX_ITEMS), command: text }),
  },
  mirrors: MIRROR_TOPICS,
  panelOps: {
    message: obj({ message: value }),
    disposed: obj({ error: opt(message), reason: oneOf(['user', 'detach'] as const) }),
  },
};

export const parseCoreInit: Parser<CoreInit> = obj({
  appInfo: obj({ version: label, host: oneOf(['desktop'] as const) }),
  secretsPersistent: bool,
  chatBrowserPane: bool,
  e2eHooks: bool,
  git: obj({ available: bool, reason: opt(message), path: opt(filePath), version: opt(obj({ major: int(0, 1_000_000), minor: int(0, 1_000_000), patch: int(0, 1_000_000) })) }),
  paths: obj({
    resourceRoot: filePath,
    unpackedRoot: filePath,
    workers: obj({
      compass: filePath,
      usageStats: filePath,
      sentinel: filePath,
      processLauncher: filePath,
      memoryIntegrity: filePath,
      sessionMetaIndex: filePath,
      voiceExtract: filePath,
    }),
    watchWorker: filePath,
    askpass: obj({ askpass: filePath, sshAskpass: filePath, node: filePath, main: filePath }),
  }),
  logs: obj({ dir: filePath, echo: bool }),
  endedCores: arr(obj({ pid: int(1, 2 ** 32), endedAt: int(0, Number.MAX_SAFE_INTEGER) }), MAX_ITEMS),
  worktreeRecords: rows,
  remote: opt(obj({ hostId: id })),
  mirrors: obj({
    state: obj({ global: dict(value, MAX_KEY_CHARS, MAX_ITEMS), workspace: dict(value, MAX_KEY_CHARS, MAX_ITEMS) }),
    trust: obj({ keys: trustedKeys }),
    folders: MIRROR_TOPICS.folders,
    editor: MIRROR_TOPICS.editor,
    terminal: MIRROR_TOPICS.terminal,
    language: MIRROR_TOPICS.language,
    clientAuth: dict(clientAuth, MAX_ID_CHARS, MAX_ITEMS),
    clientUser: dict(clientUser, MAX_ID_CHARS, MAX_ITEMS),
    clientPolicy: dict(clientPolicy, MAX_ID_CHARS, MAX_ITEMS),
    actingClient,
  }),
});

/** A client's version-0 values of the per-client mirrors, as control.attachCore carries them. */
export const parseClientValues: { readonly clientAuth: Parser<ClientAuth>; readonly clientUser: Parser<ClientUser>; readonly clientPolicy: Parser<ClientPolicy> } = { clientAuth, clientUser, clientPolicy };

/** ScmService.setProjects' argument as main sends it in scm.call: each listed root's key and folder. */
export const parseScmProjects: Parser<readonly { readonly key: string; readonly path: string }[]> = arr(obj({ key: filePath, path: filePath }), MAX_ITEMS);
