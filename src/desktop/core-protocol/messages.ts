// The core protocol's contract: what Damocles Core and desktop main send each other. Each side parses what it receives with
// these tables, so a message outside them is a protocol violation.

import type { PanelWorktreeStateEvent } from '../../core/chat-panel/panel-worktrees';
import type { ChatPermissions } from '../../core/permission-handler/types';
import type { CatalogResult } from '../../core/chat-panel/session-catalog';
import type { ChatActivity, TurnOutcome } from '../../core/pi-session/session-state';
import type { UsageThresholdCrossing } from '../../core/pi-session/usage-thresholds';
import type { EndedLeaseHolder } from '../../core/pi-session/session-store/session-lease';
import type { SessionFileWrite } from '../../core/pi-session/session-store/session-file-write';
import type { AskpassPaths } from '../../core/scm/askpass/askpass-server';
import type { CommitFailure } from '../../core/scm/repository';
import type { RemoteOp, RemoteOutcome, RemoteOutcomeKind } from '../../core/scm/scm-service';
import type { WorkerName } from '../../platform/app-paths';
import type { PickFileOptions, PickFolderOptions, InputBoxOptions } from '../../platform/dialog-service';
import type { ActiveEditorContext, DiffSide, OpenFileOptions } from '../../platform/editor-service';
import type { TerminalToggle } from '../../platform/window-service';
import type { OpenFolder } from '../../platform/workspace-folders';
import { parseCredentialFields, isCredentialValue, MAX_CREDENTIAL_PASSWORD_CHARS, MAX_CREDENTIAL_USERNAME_CHARS, type GitCredentialAnswer, type GitCredentialFields } from '../../shared/git-credential';
import type { PageSpec } from '../../shared/panel-html';
import { MAX_BROKER_EXPIRES_IN_MS, MAX_GLOBAL_MEMORY_CONTENT_CHARS, MAX_GLOBAL_MEMORY_ID_CHARS, MAX_GLOBAL_MEMORY_LABEL_CHARS, MAX_GLOBAL_MEMORY_TAGS, MAX_HELD_MEMORY_QUEUES, MAX_PLAN_MODEL_ID_CHARS, MAX_PLAN_MODEL_IDS, MAX_RELAYED_MCP_TIMEOUT_MS, MAX_RELAYED_MEMORIES, MAX_STANDING_GLOBALS, type BrokerAnswer, type BrowserToolAnswer, type ClientAuth, type ClientGlobalProfile, type ClientPolicy, type ClientUser, type GlobalMemoryListPage, type GlobalMemoryListRequest, type GlobalMemoryResolution, type GlobalMemorySearchFilters, type ListedGlobalMemory, type GlobalMemoryWrite, type HeldAuth, type HeldMemoryQueue, type RelayedGlobalMemory, type RelayedMcpServer, type SearchedGlobalMemory } from '../../shared/remote-user';
import type { UserProfile } from '../../shared/types/memory';
import { JOURNEY_FAILURES, type DesignCapture, type DesignJourneyRun, type DesignPreviewFile, type DesignPreviewInfo, type DesignProbeResult, type JourneyStep } from '../../shared/types/design';
import { MAX_JOURNEY_MESSAGE_CHARS, MAX_JOURNEY_OUTLINE_CHARS, MAX_JOURNEY_STEPS, parseJourneySteps } from '../../shared/design-journey';
import { MAX_TWEAK_CONTROLS, MAX_TWEAK_STOPS, MIN_TWEAK_CONTROLS, MIN_TWEAK_STOPS, TWEAK_TOKEN_NAME } from '../../shared/design-tweaks';
import { MAX_CHANGED_PATHS, MAX_CONSOLE_ERRORS, MAX_OVERFLOWING, MAX_PROBE_ELEMENTS, MAX_PROBE_LINE_CHARS, MAX_PROBE_PX, MAX_PROBE_WIDTHS, MAX_RENDER_SCALE, MAX_RENDER_WIDTH, MIN_RENDER_WIDTH, RENDER_FRAME_HEIGHT } from '../../shared/design-render';
import { MAX_DESIGN_ID_CHARS } from '../../shared/design-paths';
import { MAX_MARKUP_JSON_CHARS } from '../../shared/design-markup';
import { SETTINGS_ACCOUNT_IDS, SETTINGS_SECTION_IDS, type SettingsAccountId, type SettingsSectionId } from '../../shared/settings-sections';
import { EDITOR_HARD_MAX_DOCUMENT_BYTES, WORKTREE_PHASES, type ChatPlace, type ChatReviewScope, type SettingsFileScope, type WorktreeFinishAction } from '../../shared/types/messages';
import { MAX_CALL_ARGS, REPOSITORY_CALLS, SCM_CALLS, WORKTREE_CALLS, type RepositoryCall, type ScmCall, type WorktreeCall } from './scm-calls';
import { arr, bool, bytes, data, dict, either, finite, int, INVALID, localized, maybe, nonEmpty, none, num, obj, oneOf, opt, str, type Parser } from './schema';
import type { LocalizedText } from '../../shared/localized-text';
import { MAX_CERTIFICATE_FIELD_CHARS, type ClientCertificateFilter } from '../../shared/client-certificate';
import { MAX_IMAGE_BASE64_LENGTH } from '../../shared/types/content';

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

// The browser page messages main parses out of a core post to persist the page's state (views.ts).
export const PAGE_STATE_TYPES: ReadonlySet<string> = new Set(['urlChanged', 'navigationState', 'pickingStateChanged']);

// Stands in for the file name in a diff title template; main puts the file's current name in its place.
export const DIFF_TITLE_NAME = '\u0000name\u0000';

export type StateScope = 'global' | 'workspace';

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
  // a design chat's parent chat, by its view id
  readonly parent?: string;
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
  // the tab title with DIFF_TITLE_NAME as the argument where the file name goes
  readonly titleTemplate: LocalizedText;
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

/** The params and the result of request M of a request table. */
export type Params<T, M extends keyof T> = T[M] extends Call<infer P, unknown> ? P : never;
export type Result<T, M extends keyof T> = T[M] extends Call<unknown, infer R> ? R : never;

/** Requests core sends and main serves: the proxied services and the writes of the mirrored ones. */
export interface CoreRequests {
  'secrets.get': Call<{ readonly key: string }, string | undefined>;
  'secrets.store': Call<{ readonly key: string; readonly value: string }, void>;
  'secrets.delete': Call<{ readonly key: string }, void>;
  'secrets.keys': Call<object, readonly string[]>;
  // main renders the text in its own language; the answer is the chosen action's index
  'notifications.show': Call<
    { readonly severity: 'info' | 'warn' | 'error'; readonly message: LocalizedText; readonly modal?: boolean; readonly actions: readonly LocalizedText[] },
    number | undefined
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
  // a daemon's core: the git credential relay's get or erase, answered by the acting client; targetHelper: the target's
  // git has a credential helper of its own for the URL. The answer is a credential and is never logged.
  'askpass.credential': Call<{ readonly op: 'get' | 'erase'; readonly fields: GitCredentialFields; readonly targetHelper: boolean }, GitCredentialAnswer>;
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
  // a daemon's core: a browser tool of the chat's view, run by the client that shows it in that view's own browser scope
  // (scope: CHAT_BROWSER_SCOPE for the chat's agent, else a subagent's or team member's scope id)
  'user.browser.tool': Call<{ readonly viewId: string; readonly scope: string; readonly tool: string; readonly input: unknown }, BrowserToolAnswer>;
  // a daemon's core: a subagent's or team member's browser scope of the chat's view ended; the client showing the view
  // disposes that scope, closing its tabs when closeTabs (the agent succeeded)
  // discard: the conversation that handed the scope out ended, so the tabs a failed agent left open close too
  'user.browser.release': Call<{ readonly viewId: string; readonly scope: string; readonly closeTabs: boolean; readonly discard?: boolean }, void>;
  // a daemon's core: the global memory of exactly the client clientId names: its own ranked search of its global rows (with
  // injection, its injection's lexical gate over its global facts, preferences and episodes), its global profile, the
  // current version of ids it returned before, and writes it applies in order, each with its uuid recorded in the same
  // transaction; through is the end byte offset of the last entry it applied or had applied, ids each applied write's row
  'user.memory.search': Call<{ readonly clientId: string; readonly query: string; readonly k: number; readonly tiers: readonly ('global' | 'note')[]; readonly injection?: boolean } & GlobalMemorySearchFilters, readonly SearchedGlobalMemory[]>;
  'user.memory.profile': Call<{ readonly clientId: string }, ClientGlobalProfile>;
  'user.memory.resolve': Call<{ readonly clientId: string; readonly ids: readonly string[] }, readonly GlobalMemoryResolution[]>;
  'user.memory.apply': Call<{ readonly clientId: string; readonly entries: readonly { readonly end: number; readonly write: GlobalMemoryWrite }[] }, { readonly through: number; readonly ids?: readonly string[] }>;
  // a daemon's core: one page of exactly that client's latest global rows of the kinds and any of the tags asked for, below
  // the cursor in created_at DESC, id DESC order; routed only to a client whose attach listed user.memory.list
  'user.memory.list': Call<{ readonly clientId: string } & GlobalMemoryListRequest, GlobalMemoryListPage>;
  // a daemon's core: a personal MCP server of exactly the client clientId names, which runs it after checking the server is
  // one it marked available on remote hosts and, for a call, that the tool is one that server lists; the answer is the MCP result
  'user.mcp.call': Call<{ readonly clientId: string; readonly server: string; readonly tool: string; readonly args: Readonly<Record<string, unknown>> }, unknown>;
  'user.mcp.resources': Call<{ readonly clientId: string; readonly server: string; readonly kind: 'resources' | 'templates'; readonly cursor?: string }, unknown>;
  'user.mcp.readResource': Call<{ readonly clientId: string; readonly server: string; readonly uri: string }, unknown>;
  // answers once what core posted to the view before is within the flow window of the host's queue toward the page; with
  // viewKey, of that one view's page only, else of every view's
  'views.drained': Call<{ readonly viewId: string; readonly viewKey?: string }, void>;
  // a daemon's core, inside a client's work: the daemon shows the view on that client alone, opening it there when it shows
  // none; answers once it shows, false when it cannot show there
  'chats.reveal': Call<{ readonly viewId: string; readonly column?: number }, boolean>;
  // the daemon to a client: select the chat holding stored session sessionId, joining its panel when this client shows no view
  // of it; answers once it shows, and fails when it did not open
  'chats.showSession': Call<{ readonly sessionId: string }, void>;
  // the preview tab of a design file in the design chat panelId names, opened or shown; relPath is below the design folder
  'design.openPreview': Call<{ readonly panelId: string; readonly designId: string; readonly relPath: string }, void>;
  // a render of a design file a chat of this core holds, in a fresh offscreen page of the client (PD-41); main reads its
  // bytes through design.read; state: a declared state, null for the default; scale: an upper bound
  'design.capture': Call<{ readonly designId: string; readonly relPath: string; readonly width: number; readonly state: string | null; readonly scale: number }, DesignCapture>;
  // the visible data-ds elements and the overflow at each width, and with sweepTo the overflow sweep from 320 px to it
  'design.probe': Call<{ readonly designId: string; readonly relPath: string; readonly widths: readonly number[]; readonly state: string | null; readonly sweepTo?: number }, DesignProbeResult>;
  // the journey's steps in a fresh offscreen page per width (PD-13, PD-45); outline: each page's DOM outline where its run ended
  'design.journey': Call<{ readonly designId: string; readonly relPath: string; readonly widths: readonly number[]; readonly state: string | null; readonly steps: readonly JourneyStep[]; readonly outline?: boolean }, DesignJourneyRun>;
  // the steps replayed in the live preview tab of relPath in design chat panelId, opened or shown; answers once the replay ended
  'design.replayJourney': Call<{ readonly panelId: string; readonly designId: string; readonly relPath: string; readonly state: string | null; readonly steps: readonly JourneyStep[]; readonly reducedMotion: boolean }, void>;
}

export type { BrokerAnswer, BrowserToolAnswer, ClientAuth, ClientPolicy, ClientUser, HeldAuth };

/** A fresh OAuth access token main pushes to a daemon's core; a key is never pushed, since a cached one never expires. */
export type PushedCredential = Extract<BrokerAnswer, { readonly type: 'oauth' }>;

export type CredentialKind = 'username' | 'password' | 'passphrase' | 'confirm' | 'notice';

export interface AskQuestion {
  readonly severity: 'info' | 'warning' | 'danger';
  readonly message: LocalizedText;
  readonly detail?: LocalizedText;
  readonly actions: readonly LocalizedText[];
  readonly cancelLabel?: LocalizedText;
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
  // a local core shows the session mirror's copy of a remote chat on the view main created, read-only: file lies under
  // <userData>/remote/<hostId>/mirror/, which core checks again, and core writes nothing for it
  'chats.openTranscript': Call<{ readonly viewId: string; readonly hostId: string; readonly file: string }, void>;
  // a local core lists one project's chats of a host's session mirror (StoredSession rows, newest first), narrowed to query:
  // folder is <userData>/remote/<hostId>/mirror/<project folder>, which core checks again, and core writes nothing for it
  'chats.listMirrored': Call<{ readonly hostId: string; readonly folder: string; readonly query?: string }, readonly unknown[]>;
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
  // the Stop path of a chat's running turn, by core panel id, which records the turn stopped; refused for a chat that is not loaded
  'chats.stop': Call<{ readonly panelId: string }, void>;
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
  // whether another holder keeps the session from opening here; announce tells the user, offering a takeover (chat.takeover), and on a local core shows a chat holding it
  'chats.leaseRefusal': Call<{ readonly sessionId: string; readonly announce: boolean }, boolean>;
  'catalog.list': Call<{ readonly projectKey: string; readonly complete: boolean }, readonly unknown[]>;
  'catalog.search': Call<{ readonly projectKey: string; readonly query: string }, readonly unknown[]>;
  'catalog.rename': Call<{ readonly sessionId: string; readonly name: string }, CatalogResult>;
  'catalog.tag': Call<{ readonly sessionId: string; readonly tag: string | null }, CatalogResult>;
  'catalog.delete': Call<{ readonly sessionId: string }, CatalogResult>;
  // a session file of this core's own store, which only this core writes (session-file-write.ts); path is native to its
  // machine; expectedSha256: the bytes the editor last read, null for a file it found missing
  'sessionFiles.write': Call<{ readonly path: string; readonly bytes: Uint8Array; readonly expectedSha256: string | null }, SessionFileWrite>;
  'folders.setDefault': Call<{ readonly key: string }, void>;
  // url: an address of a forwarded port, which main checked; absent opens a blank page
  'browser.newPage': Call<{ readonly chatViewId: string; readonly url?: string }, void>;
  // local chats' browser profile only: Chrome sends the certificate filter names to origin (https://host:port) without asking,
  // for the rest of this app session
  'browser.useClientCertificate': Call<{ readonly origin: string; readonly filter: ClientCertificateFilter }, void>;
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
  // sessionId: another device's view of the panel holding that stored session, whatever its page's token (a daemon only).
  // joining: the daemon's key of the joining view, which alone gets the replay while the panel's other views go on live
  'views.join': Call<{ readonly viewId: string; readonly viewKey: string; readonly sessionId?: string; readonly joining?: string }, { readonly panelId: string } | null>;
  // core's ScmService (scm-calls.ts): a method of SCM_CALLS with its arguments, answered with its result
  'scm.call': Call<{ readonly method: ScmCall; readonly args: readonly unknown[] }, unknown>;
  // ScmService.commit; branchName names the token core asks scm.branchName with, saved the documents saved just before
  'scm.commit': Call<{ readonly repoId: string; readonly message: string; readonly variant: unknown; readonly saved: readonly string[]; readonly branchName?: string }, ScmCommitOutcome>;
  'scm.ignoredIn': Call<{ readonly projectKey: string; readonly relativeDir: string; readonly entries: readonly { readonly name: string; readonly dir: boolean }[] }, readonly string[]>;
  'scm.commitBlob': Call<{ readonly repoId: string; readonly commit: string; readonly path: string }, Uint8Array | 'tooLarge' | undefined>;
  // a file of a design a chat of this core holds (its role or own link), never another folder; nothing: not held, missing or outside
  'design.read': Call<{ readonly designId: string; readonly relPath: string }, DesignPreviewFile | 'tooLarge' | undefined>;
  // a held design's widths and one screen's declared states; nothing: not held, or the screen cannot be read
  'design.info': Call<{ readonly designId: string; readonly relPath: string }, DesignPreviewInfo | undefined>;
  // a preview's markup (PD-12) to design chat panelId: png is base64 with no data: prefix, json the shell's MarkupJsonInput,
  // both parsed by core; the markup's F<n>, or why core refused it
  'design.markup': Call<{ readonly panelId: string; readonly png: string; readonly json: unknown }, { readonly feedbackId: string } | { readonly refused: LocalizedText }>;
  // a tweak the user kept (PD-13) in design chat panelId: core checks it against the chat's latest DeclareTweaks and sends
  // "Keep: <label> → <token>" as its own prompt
  'design.tweak': Call<{ readonly panelId: string; readonly tweakId: string; readonly value: string }, { readonly kept: true } | { readonly refused: LocalizedText }>;
  // an editor tab's Open preview on path, a screen below this core's designs folder: its design chat, shown, opens the preview tab
  'design.previewScreen': Call<{ readonly path: string }, { readonly opened: true } | { readonly refused: LocalizedText }>;
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
  // this computer's core: each remote authority's client-network proxy resolves these names to the given answers in turn,
  // one answer per lookup, cycling (a name that rebinds); other names resolve as usual
  'e2e.clientNetworkAnswers': Call<{ readonly answers: Readonly<Record<string, readonly (readonly string[])[]>> }, void>;
  // this computer's core signs in to a stub OAuth account whose tokens expire after expiresInMs; offline: its refresh fails
  'e2e.stubOAuth': Call<{ readonly account: string; readonly expiresInMs: number; readonly offline?: boolean }, void>;
  // this computer's core: a credential for a daemon's broker, resolved and refreshed by its own pi
  // force: refreshed under pi's lock even while the token is not expiring (Keep running)
  'user.resolveCredential': Call<{ readonly provider: string; readonly force?: boolean }, BrokerAnswer>;
  // this computer's core: every provider pi knows with its non-secret credential state, for the clientAuth mirror
  'user.clientAuth': Call<object, HeldAuth>;
  // a daemon's core: a fresh credential of the pushing client (the request's actor), cached for that client alone; it resolves
  // the credential waits of turns pinned to it. An OAuth refresh token never crosses: refresh is always ''.
  'user.credentials.push': Call<{ readonly provider: string; readonly credential: PushedCredential }, void>;
  // this computer's core speaks a remote chat's reply; its voice consent applies
  'user.voice.speak': Call<{ readonly viewId: string; readonly text: string }, void>;
  // this computer's core runs a remote chat's browser tool in authority's context, the scope keyed by the chat's view;
  // main rewrote and checked its addresses first
  'user.browser.tool': Call<{ readonly authority: string; readonly viewId: string; readonly scope: string; readonly tool: string; readonly input: unknown }, BrowserToolAnswer>;
  // this computer's core closes the authority's browser context and its client-network proxy (Forget host), settling once both
  // did; with agentScope, only that agent's scope of a remote chat's view, closing its tabs when closeTabs
  'user.browser.release': Call<{ readonly authority: string; readonly agentScope?: { readonly viewId: string; readonly scope: string; readonly closeTabs: boolean; readonly discard?: boolean } }, void>;
  // this computer's core: its global memory for a remote core (user.memory.*); apply skips a write whose uuid it applied
  // before and answers how many leading writes it applied or skipped, and the row each of them is in (ids)
  'user.memory.search': Call<{ readonly query: string; readonly k: number; readonly tiers: readonly ('global' | 'note')[]; readonly injection?: boolean } & GlobalMemorySearchFilters, readonly SearchedGlobalMemory[]>;
  'user.memory.profile': Call<object, ClientGlobalProfile>;
  'user.memory.resolve': Call<{ readonly ids: readonly string[] }, readonly GlobalMemoryResolution[]>;
  'user.memory.apply': Call<{ readonly writes: readonly GlobalMemoryWrite[] }, { readonly applied: number; readonly ids?: readonly string[] }>;
  'user.memory.list': Call<GlobalMemoryListRequest, GlobalMemoryListPage>;
  // this computer's core: the personal MCP servers marked available on remote hosts, and their calls, refused for any other
  // a daemon's core: Deliver here takes a held outbox for the asking client (the request's actor), Discard deletes it; false:
  // the queue is no longer held
  'memory.deliverHeld': Call<{ readonly queueId: string }, boolean>;
  'memory.discardHeld': Call<{ readonly queueId: string }, boolean>;
  'user.mcp.servers': Call<object, readonly RelayedMcpServer[]>;
  'user.mcp.call': Call<{ readonly server: string; readonly tool: string; readonly args: Readonly<Record<string, unknown>> }, unknown>;
  'user.mcp.resources': Call<{ readonly server: string; readonly kind: 'resources' | 'templates'; readonly cursor?: string }, unknown>;
  'user.mcp.readResource': Call<{ readonly server: string; readonly uri: string }, unknown>;
  // this computer's core: a proxy for a remote chat's view, which only FOREIGN_VIEW_MESSAGES reach
  'panels.attachForeign': Call<{ readonly authority: string; readonly viewId: string }, void>;
  'panels.detachForeign': Call<{ readonly viewId: string }, void>;
  'panels.foreignMessage': Call<{ readonly viewId: string; readonly message: unknown }, void>;
}

/** ScmService.commit's outcome as scm.commit answers it: a failure carries the text main shows, git's own words verbatim. */
export type ScmCommitOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: Exclude<CommitFailure, 'failed'> }
  | { readonly ok: false; readonly reason: 'failed'; readonly error: LocalizedText };

export type SettingsViewScope = 'user' | 'machine' | 'project';

export type MentionTargetData = { readonly projectKey: string; readonly relativePath: string } | { readonly path: string };

export interface CoreEvents {
  'window.openAppSettings': { readonly section?: SettingsSectionId; readonly account?: SettingsAccountId; readonly scope?: 'machine' };
  'window.toggleTerminal': object;
  // after the chats mirror shows the change; sessionId: the stored session the chat is on, which lets a client that does not
  // view the chat (another device) show it running in its chat list
  'chat.activity': { readonly panelId: string; readonly activity: ChatActivity; readonly sessionId?: string };
  'chat.turnSettled': { readonly panelId: string; readonly outcome: TurnOutcome };
  'chat.changes': { readonly panelId: string; readonly totals: unknown; readonly generation: number };
  'chat.usageThreshold': { readonly crossing: UsageThresholdCrossing };
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
  // this computer's core: the personal MCP servers marked available on remote hosts or their tools changed, so user.mcp.servers answers differently
  'user.mcpChanged': object;
  // a daemon's core: a URL an agent shell printed, for the daemon's port detection
  'ports.urlSeen': { readonly host: 'localhost' | '127.0.0.1' | '0.0.0.0'; readonly port: number };
  // files of a held design a Write or Edit changed, debounced; '/' separated below the design folder
  'design.changed': { readonly designId: string; readonly paths: readonly string[] };
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
  // a daemon's core: the outboxes it holds for devices long away, whole on every change
  heldMemory: { readonly queues: readonly HeldMemoryQueue[] };
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
  // a local core's one client's; a daemon's core reads clientEditor and clientTerminal instead
  editor: EditorMirror;
  terminal: TerminalToggle;
  // a local core's one client's UI language; a daemon's core reads clientLanguage instead
  language: { readonly language: 'en' | 'el' };
  // per client: a client publishes its own value; the daemon stamps its id for the client, value undefined when it detached
  clientAuth: ClientDelta<ClientAuth>;
  clientUser: ClientDelta<ClientUser>;
  clientPolicy: ClientDelta<ClientPolicy>;
  // the daemon's: each client's editor and terminal patches under its id, value undefined when it detached; a client's is dropped
  clientEditor: ClientDelta<EditorMirror>;
  clientTerminal: ClientDelta<TerminalToggle>;
  // the daemon's: each client's language patches under its id, value undefined when it detached; a client's is dropped
  clientLanguage: ClientDelta<MirrorTopics['language']>;
  // per client, as clientUser: the personal MCP servers it marked available on remote hosts, names and schemas only
  clientMcp: ClientDelta<{ readonly servers: readonly RelayedMcpServer[] }>;
  // the daemon's: the client that most recently sent core a message, published before that message; a client's is dropped
  actingClient: { readonly clientId?: string };
  // the daemon's, after a removed socket folder was made again: its agent folder (CoreInit.remote.agentFolder) and the git
  // credential relay's handle (CoreInit.paths.askpass.credentialRelay), which core listens at from then on; a client's is dropped
  hostSockets: { readonly agentFolder?: string; readonly relayHandle?: string };
  // this computer's core: a remote authority's forwarded local ports and its local-network switch, which its browser
  // context's client-network proxy applies; a daemon drops a client's
  clientNetwork: { readonly authority: string; readonly allowedPorts: readonly number[]; readonly allowLocalNetwork: boolean };
}

/** The focused text editor's context; undefined when none has focus. */
export interface EditorMirror {
  readonly context?: ActiveEditorContext;
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
  // a webview message as JSON text; type is the message's own, which main checks against the JSON for a core with refused
  // posts (host-services.ts). viewKey: the daemon's key of the one view it goes to; without it every view of the panel gets
  // it but those except names (a daemon's views only)
  post: { readonly type: string; readonly json: string; readonly viewKey?: string; readonly except?: readonly string[] };
  // a webview message holding binary (a browser page's frame), structured-cloned; viewKey and except as post's
  postBinary: { readonly message: unknown; readonly viewKey?: string; readonly except?: readonly string[] };
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
  // viewKey: the daemon's key of the view that sent it, which a client never sets
  message: { readonly message: unknown; readonly viewKey?: string };
  disposed: { readonly error?: string; readonly reason: 'user' | 'detach' };
  // a daemon's: that view of the panel is gone while the panel stays, so core forgets its key; a client never sends it
  viewDetached: { readonly viewKey: string };
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
    // this computer's core: <userData>/remote, holding each host's session mirror, which /stats indexes
    readonly remoteMirrors?: string;
    readonly askpass: AskpassPaths;
  };
  // <userData>/logs, and whether a sink mirrors its lines to stdout (the unpackaged app)
  readonly logs: { readonly dir: string; readonly echo: boolean };
  // the cores that crashed in this app run and when they ended (epoch ms), whose session leases no live process holds
  readonly endedCores: readonly EndedLeaseHolder[];
  // the worktree records main last read from a core, which the registry serves while registry.json does not parse
  readonly worktreeRecords: readonly unknown[];
  // set only for a daemon's core: it deletes permanently where it would trash and refuses every user-scope write
  // agentFolder: the daemon's forwarded-agent proxy folder, holding agentSocketFile(agentFolder, clientId) for each client
  // that forwards its agent; absent on a Windows target
  readonly remote?: { readonly hostId: string; readonly agentFolder?: string };
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
    // by client id: a daemon's attached clients; a local core reads editor and terminal
    readonly clientEditor?: Readonly<Record<string, EditorMirror>>;
    readonly clientTerminal?: Readonly<Record<string, TerminalToggle>>;
    readonly clientLanguage?: Readonly<Record<string, MirrorTopics['language']>>;
    readonly clientMcp?: Readonly<Record<string, { readonly servers: readonly RelayedMcpServer[] }>>;
    // this computer's core: each remote authority's, by authority
    readonly clientNetwork?: Readonly<Record<string, { readonly allowedPorts: readonly number[]; readonly allowLocalNetwork: boolean }>>;
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
const localizedLabel = localized(MAX_LABEL_CHARS);
const localizedMessage = localized(MAX_MESSAGE_CHARS);
const value = data(MAX_DATA_CHARS);
const done = none;
const certificateField = opt(nonEmpty(MAX_CERTIFICATE_FIELD_CHARS));
const certificatePrincipal = obj({ CN: certificateField, L: certificateField, O: certificateField, OU: certificateField });
const section = oneOf(SETTINGS_SECTION_IDS);
const account = oneOf(SETTINGS_ACCOUNT_IDS);
const stateScope = oneOf(['global', 'workspace'] as const);
const reviewScope = oneOf(['chat', 'turn'] as const);
const nul: Parser<null> = (raw) => (raw === null ? null : INVALID);
const column = opt(int(-2, 64));
const trustedKeys = arr(filePath, MAX_ITEMS);
// an index into at most MAX_ACTIONS actions
const actionIndex = int(0, MAX_ACTIONS - 1);
const clientNetworkShape = { allowedPorts: arr(int(1, 65535), 65535), allowLocalNetwork: bool };
const browserToolAnswer: Parser<BrowserToolAnswer> = obj({
  content: arr(either(obj({ type: oneOf(['text'] as const), text }), obj({ type: oneOf(['image'] as const), data: text, mimeType: id })), MAX_ACTIONS),
  isError: opt(bool),
});
const globalMemoryKind = oneOf(['fact', 'preference', 'episode', 'note'] as const);
const memoryId = nonEmpty(MAX_GLOBAL_MEMORY_ID_CHARS);
const memoryLabel = str(MAX_GLOBAL_MEMORY_LABEL_CHARS);
const memoryContent = str(MAX_GLOBAL_MEMORY_CONTENT_CHARS);
const memoryTags = opt(arr(memoryLabel, MAX_GLOBAL_MEMORY_TAGS));
const memoryTime = int(0, Number.MAX_SAFE_INTEGER);
const relayedMemoryShape = {
  id: memoryId, kind: globalMemoryKind, title: opt(memoryLabel), content: memoryContent, contentHash: memoryId, tags: memoryTags, createdAt: memoryTime, updatedAt: memoryTime,
};
const relayedGlobalMemory: Parser<RelayedGlobalMemory> = obj(relayedMemoryShape);
const searchedGlobalMemory: Parser<SearchedGlobalMemory> = obj({ ...relayedMemoryShape, fullAllowed: opt(bool), matchedTerms: opt(arr(memoryLabel, MAX_RELAYED_MEMORIES)) });
const globalMemoryResolution: Parser<GlobalMemoryResolution> = either(
  obj({ id: memoryId, memory: relayedGlobalMemory }),
  obj({ id: memoryId, gone: (raw): true | typeof INVALID => (raw === true ? true : INVALID), byUser: bool }),
);
const globalMemoryWrite: Parser<GlobalMemoryWrite> = obj({ uuid: memoryId, kind: globalMemoryKind, content: memoryContent, title: opt(memoryLabel), tags: memoryTags });
const searchedMemories = arr(searchedGlobalMemory, MAX_RELAYED_MEMORIES);
// a client lists only its notes; its other global rows reach a remote core only through a search
const memoryKinds = arr(oneOf(['note'] as const), 1, 1);
const memoryListCursor = opt(obj({ createdAt: memoryTime, id: memoryId }));
const listedGlobalMemory: Parser<ListedGlobalMemory> = obj({ ...relayedMemoryShape, forgotten: opt((raw): true | typeof INVALID => (raw === true ? true : INVALID)) });
const globalMemoryListPage: Parser<GlobalMemoryListPage> = obj({ rows: arr(listedGlobalMemory, MAX_RELAYED_MEMORIES), next: memoryListCursor });
const relayedIds = arr(memoryId, MAX_RELAYED_MEMORIES);
const searchCount = int(1, MAX_RELAYED_MEMORIES);
const userProfile: Parser<UserProfile> = obj({ static: text, dynamic: text });
const clientGlobalProfile: Parser<ClientGlobalProfile> = obj({
  profile: userProfile,
  pinned: arr(relayedGlobalMemory, MAX_STANDING_GLOBALS),
  preferences: arr(relayedGlobalMemory, MAX_STANDING_GLOBALS),
});
const memoryTiers = arr(oneOf(['global', 'note'] as const), 2);
const relayedMcpServer: Parser<RelayedMcpServer> = obj({
  name: label,
  description: opt(label),
  tools: arr(obj({
    name: label,
    title: opt(label),
    description: opt(text),
    inputSchema: opt(value),
    annotations: opt(obj({ readOnlyHint: opt(bool), destructiveHint: opt(bool), idempotentHint: opt(bool), openWorldHint: opt(bool) })),
    exposure: opt(oneOf(['deferred', 'direct'] as const)),
  }), MAX_ITEMS),
  resources: bool,
  timeoutMs: opt(int(1, MAX_RELAYED_MCP_TIMEOUT_MS)),
});
const mcpServers = obj({ servers: arr(relayedMcpServer, MAX_ITEMS) });
const mcpResourceKind = oneOf(['resources', 'templates'] as const);
const mcpArgs = dict(value, MAX_KEY_CHARS, MAX_ITEMS);


const openFolder = obj({ fsPath: filePath, name: label, ownerKey: opt(str(MAX_PATH_CHARS)) });
const editorContext = obj({
  filePath: maybe(filePath),
  selection: maybe(obj({ startLine: num, endLine: num, text })),
});
const editorMirror: Parser<EditorMirror> = obj({ context: opt(editorContext) });
const terminalMirror: Parser<TerminalToggle> = obj({ shown: bool, shortcut: label });
const diffSide = either(obj({ path: filePath }), obj({ name: label, content: text }));
const panelCreate: Parser<PanelCreate> = obj({
  kind: oneOf(['chat', 'browser'] as const),
  title: label,
  localResourceRoots: arr(filePath, MAX_ACTIONS),
  column,
  owner: opt(id),
  parent: opt(id),
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
const pendingKind = oneOf(['approval', 'question', 'plan', 'input', 'signIn', 'designVersion', 'designApproval'] as const);
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
  pendingPrompts: arr(obj({ id: key, kind: pendingKind, owner: promptOwner, summary: opt(localizedLabel) }), MAX_ITEMS),
  background: bool,
});
const count = int(0, Number.MAX_SAFE_INTEGER);
const yes: Parser<true> = (raw) => (raw === true ? true : INVALID);
const no: Parser<false> = (raw) => (raw === false ? false : INVALID);
// main renders the LocalizedText these carry, so it is parsed as such, never passed on as opaque data
const turnOutcome: Parser<TurnOutcome> = either(
  either(obj({ kind: oneOf(['completed'] as const), durationMs: opt(num) }), obj({ kind: oneOf(['error'] as const), message: opt(localizedMessage) })),
  either(obj({ kind: oneOf(['budget', 'cancelled'] as const) }), obj({ kind: oneOf(['rateLimit'] as const), windowId: opt(label), windowLabel: opt(localizedLabel), resetsAt: opt(num) })),
);
const USAGE_THRESHOLDS: readonly number[] = Object.keys({ 80: 0, 95: 0 } satisfies Record<UsageThresholdCrossing['threshold'], 0>).map(Number);
const usageCrossing: Parser<UsageThresholdCrossing> = obj({
  provider: oneOf(['anthropic', 'openai'] as const),
  windowId: label,
  windowLabel: localizedLabel,
  threshold: (raw: unknown) => (typeof raw === 'number' && USAGE_THRESHOLDS.includes(raw) ? (raw as UsageThresholdCrossing['threshold']) : INVALID),
  utilization: num,
  resetsAt: opt(num),
  planName: opt(label),
});
const catalogResult: Parser<CatalogResult> = either(
  obj({ ok: yes }),
  either(obj({ ok: no, reason: oneOf(['leased', 'missing'] as const) }), obj({ ok: no, reason: oneOf(['invalid', 'failed'] as const), message: localizedMessage })),
);
const sha256Hex: Parser<string> = (raw) => (typeof raw === 'string' && /^[0-9a-f]{64}$/.test(raw) ? raw : INVALID);
const sessionFileWrite: Parser<SessionFileWrite> = either(
  either(obj({ kind: oneOf(['written'] as const), mtimeMs: finite }), obj({ kind: oneOf(['changed', 'outside'] as const) })),
  obj({ kind: oneOf(['refused'] as const), reason: oneOf(['held', 'otherProcess'] as const) }),
);
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
    error: opt(localizedMessage),
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
// the daemon's key of one client's view of a panel
const viewKey = opt(id);
const postText = obj({ type: label, json: text, viewKey, except: opt(arr(id, MAX_ACTIONS)) });
// a page-state post must hold a JSON object, since main parses it
const panelPost: Parser<CorePanelOps['post']> = (raw) => {
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
const COMMIT_REFUSALS = Object.keys({ emptyMessage: 0, nothingToCommit: 0, unresolvedConflicts: 0, missingUserConfig: 0, cancelled: 0 } satisfies Record<Exclude<CommitFailure, 'failed'>, 0>) as ReadonlyArray<Exclude<CommitFailure, 'failed'>>;
const commitOutcome: Parser<ScmCommitOutcome> = either(
  obj({ ok: yes }),
  either(obj({ ok: no, reason: oneOf(COMMIT_REFUSALS) }), obj({ ok: no, reason: oneOf(['failed'] as const), error: localizedMessage })),
);
const scmRepositoryState = obj({
  kind: oneOf(['repositoryState'] as const),
  repoId: id,
  busy: bool,
  running: nullable(oneOf(REMOTE_OPS)),
  lastRemote: nullable(obj({ op: oneOf(REMOTE_OPS), outcome: oneOf(REMOTE_OUTCOMES), stashKept: bool, seq: int(0, Number.MAX_SAFE_INTEGER) })),
});
const callArgs = arr(value, MAX_CALL_ARGS);
const strings = arr(label, MAX_ITEMS);
// accepts exactly what planModelIdsOf accepts, so a list a sender keeps never closes the channel
const planModelIds = arr(nonEmpty(MAX_PLAN_MODEL_ID_CHARS), MAX_PLAN_MODEL_IDS);
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
    availableModelIds: opt(planModelIds),
  }),
  either(obj({ type: oneOf(['api_key'] as const), key: nonEmpty(MAX_MESSAGE_CHARS) }), obj({ type: oneOf(['none'] as const) })),
);
// a pushed token's bounds (security's credential-wire): a provider id as pi names one, extras at most 2048 characters
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const providerId: Parser<string> = (raw) => (typeof raw === 'string' && PROVIDER_ID.test(raw) ? raw : INVALID);
const extra = nonEmpty(2048);
const extras = arr(extra, 512);
const pushedCredential: Parser<PushedCredential> = obj({
  type: oneOf(['oauth'] as const),
  access: nonEmpty(64 * 1024),
  expiresIn: int(0, MAX_BROKER_EXPIRES_IN_MS),
  refresh: oneOf([''] as const),
  clientId: opt(extra),
  scopes: opt(extras),
  enterpriseUrl: opt(extra),
  accountId: opt(extra),
  availableModelIds: opt(planModelIds),
});
const authType = oneOf(['oauth', 'api_key', 'none'] as const);
const clientAuth: Parser<ClientAuth> = obj({
  providers: dict(obj({ type: authType, expiresIn: opt(int(0, Number.MAX_SAFE_INTEGER)), hasKey: bool, keySaved: opt(bool), flatFee: bool, allowance: opt(bool), availableModelIds: opt(planModelIds), preferApiKey: opt(bool) }), MAX_ID_CHARS, MAX_ITEMS),
});
const heldAuth: Parser<HeldAuth> = obj({
  providers: dict(obj({ type: authType, expires: opt(num), hasKey: bool, keySaved: opt(bool), flatFee: bool, allowance: opt(bool), availableModelIds: opt(planModelIds), preferApiKey: opt(bool) }), MAX_ID_CHARS, MAX_ITEMS),
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
  agentForwarding: opt(bool),
});
const credentialFields: Parser<GitCredentialFields> = (raw) => parseCredentialFields(raw) ?? INVALID;
const credentialAnswer: Parser<GitCredentialAnswer> = either(
  obj({ kind: oneOf(['none', 'notConnected'] as const) }),
  obj({
    kind: oneOf(['credential'] as const),
    username: (raw) => (isCredentialValue(raw, MAX_CREDENTIAL_USERNAME_CHARS) ? raw : INVALID),
    password: (raw) => (isCredentialValue(raw, MAX_CREDENTIAL_PASSWORD_CHARS) && raw !== '' ? raw : INVALID),
  }),
);
const credentialNonce: Parser<string> = (raw) => (typeof raw === 'string' && /^[0-9a-f]{64}$/.test(raw) ? raw : INVALID);
const clientDelta = <T>(parser: Parser<T>) => obj({ clientId: opt(id), value: opt(parser) });
const actingClient = obj({ clientId: opt(id) });
const pageSpec: Parser<PageSpec> = either(
  obj({ kind: oneOf(['chat', 'error'] as const) }),
  obj({ kind: oneOf(['browser'] as const), toolbar: bool }),
);

const designWidth = int(1, 100_000);
const designId = nonEmpty(MAX_DESIGN_ID_CHARS);
const tokenName: Parser<string> = (raw) => (typeof raw === 'string' && TWEAK_TOKEN_NAME.test(raw) ? raw : INVALID);
const designPreviewInfo: Parser<DesignPreviewInfo> = obj({
  path: filePath,
  screenId: nullable(label),
  title: nullable(label),
  breakpoints: arr(obj({ name: id, width: designWidth }), MAX_ACTIONS),
  primary: designWidth,
  checked: arr(designWidth, MAX_ACTIONS),
  journey: arr(designWidth, MAX_ACTIONS),
  states: arr(id, MAX_ACTIONS),
  tweaks: opt(nullable(obj({
    toolCallId: key,
    controls: arr(obj({
      id,
      label,
      property: tokenName,
      kind: oneOf(['swatch', 'segment'] as const),
      stops: arr(obj({ token: tokenName, value: label }), MAX_TWEAK_STOPS, MIN_TWEAK_STOPS),
      locked: nullable(obj({ decisionId: id, value: label })),
    }), MAX_TWEAK_CONTROLS, MIN_TWEAK_CONTROLS),
  }))),
});

const renderWidth = int(MIN_RENDER_WIDTH, MAX_RENDER_WIDTH);
const px = (raw: unknown): number | typeof INVALID => (typeof raw === 'number' && Number.isFinite(raw) && Math.abs(raw) <= MAX_PROBE_PX ? raw : INVALID);
const probeLine = str(MAX_PROBE_LINE_CHARS);
const renderScaleOf: Parser<number> = (raw) => (typeof raw === 'number' && raw > 0 && raw <= MAX_RENDER_SCALE ? raw : INVALID);
const probeText = nullable(probeLine);
const designProbeResult: Parser<DesignProbeResult> = obj({
  widths: arr(obj({
    width: renderWidth,
    contentHeight: px,
    scrollWidth: px,
    clientWidth: px,
    overflow: bool,
    overflowing: arr(obj({ element: probeLine, width: px }), MAX_OVERFLOWING),
    elements: arr(obj({ tag: id, id: probeText, component: probeText, variant: probeText, bind: probeText, rect: obj({ x: px, y: px, w: px, h: px }), visible: bool }), MAX_PROBE_ELEMENTS),
  }), MAX_PROBE_WIDTHS),
  consoleErrors: arr(probeLine, MAX_CONSOLE_ERRORS),
  sweep: opt(obj({ from: renderWidth, to: renderWidth, step: int(1, MAX_RENDER_WIDTH), overflowAt: arr(obj({ width: renderWidth, scrollWidth: px }), MAX_RENDER_WIDTH) })),
});

// a journey's steps, validated again on the receiving side as they were by core's tool (parseJourneySteps)
const journeySteps: Parser<readonly JourneyStep[]> = (raw) => {
  const parsed = parseJourneySteps(raw);
  return 'steps' in parsed ? parsed.steps : INVALID;
};
const journeyStepResult = obj({ ok: bool, hiddenAt: opt(renderWidth), failure: opt(oneOf(JOURNEY_FAILURES)), message: opt(str(MAX_JOURNEY_MESSAGE_CHARS)) });
const designJourneyRun: Parser<DesignJourneyRun> = obj({
  widths: arr(obj({ width: renderWidth, passed: bool, steps: arr(journeyStepResult, MAX_JOURNEY_STEPS), outline: opt(str(MAX_JOURNEY_OUTLINE_CHARS)) }), MAX_PROBE_WIDTHS),
  consoleErrors: arr(probeLine, MAX_CONSOLE_ERRORS),
});

const CORE_REQUESTS: Tables<CoreToMain>['requests'] = {
  'secrets.get': method(obj({ key }), maybe(message)),
  'secrets.store': method(obj({ key, value: message }), done),
  'secrets.delete': method(obj({ key }), done),
  'secrets.keys': method(obj({}), arr(key, MAX_ITEMS)),
  'notifications.show': method(
    obj({ severity: oneOf(['info', 'warn', 'error'] as const), message: localizedMessage, modal: opt(bool), actions: arr(localizedLabel, MAX_ACTIONS) }),
    maybe(actionIndex),
  ),
  'dialogs.pickFolder': method(obj({ title: opt(localizedLabel), defaultPath: opt(filePath), buttonLabel: opt(localizedLabel) }), maybe(filePath)),
  'dialogs.pickFile': method(
    obj({ title: opt(localizedLabel), defaultPath: opt(filePath), filters: opt(dict(arr(label, MAX_ACTIONS), MAX_LABEL_CHARS, MAX_ACTIONS)) }),
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
      titleTemplate: localizedLabel,
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
      message: localizedMessage,
      detail: opt(localizedMessage),
      actions: arr(localizedLabel, MAX_ACTIONS),
      cancelLabel: opt(localizedLabel),
      defaultAction: opt(actionIndex),
      preview: opt(arr(text, MAX_ITEMS)),
    }),
    maybe(actionIndex),
  ),
  'askpass.prompt': method(
    obj({ kind: oneOf(['username', 'password', 'passphrase', 'confirm', 'notice'] as const), text: message }),
    obj({ answer: opt(message), cancelled: bool }),
  ),
  'askpass.credential': method(obj({ op: oneOf(['get', 'erase'] as const), fields: credentialFields, targetHelper: bool }), credentialAnswer),
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
  'user.browser.tool': method(obj({ viewId: id, scope: id, tool: id, input: value }), browserToolAnswer),
  'user.browser.release': method(obj({ viewId: id, scope: id, closeTabs: bool, discard: opt(bool) }), done),
  'user.memory.search': method(obj({ clientId: id, query: text, k: searchCount, tiers: memoryTiers, injection: opt(bool), since: opt(memoryTime), until: opt(memoryTime), includeForgotten: opt(bool) }), searchedMemories),
  'user.memory.profile': method(obj({ clientId: id }), clientGlobalProfile),
  'user.memory.resolve': method(obj({ clientId: id, ids: relayedIds }), arr(globalMemoryResolution, MAX_RELAYED_MEMORIES)),
  'user.memory.apply': method(obj({ clientId: id, entries: arr(obj({ end: int(0, Number.MAX_SAFE_INTEGER), write: globalMemoryWrite }), MAX_ITEMS) }), obj({ through: int(0, Number.MAX_SAFE_INTEGER), ids: opt(arr(memoryId, MAX_ITEMS)) })),
  'user.memory.list': method(obj({ clientId: id, kinds: memoryKinds, tags: memoryTags, cursor: memoryListCursor }), globalMemoryListPage),
  'user.mcp.call': method(obj({ clientId: id, server: label, tool: label, args: mcpArgs }), value),
  'user.mcp.resources': method(obj({ clientId: id, server: label, kind: mcpResourceKind, cursor: opt(message) }), value),
  'user.mcp.readResource': method(obj({ clientId: id, server: label, uri: message }), value),
  'views.drained': method(obj({ viewId: id, viewKey }), done),
  'chats.reveal': method(obj({ viewId: id, column }), bool),
  'chats.showSession': method(obj({ sessionId: id }), done),
  'design.openPreview': method(obj({ panelId: id, designId, relPath: filePath }), done),
  'design.capture': method(
    obj({ designId, relPath: filePath, width: renderWidth, state: nullable(id), scale: renderScaleOf }),
    obj({ png: bytes(MAX_DATA_CHARS), cssWidth: renderWidth, cssHeight: int(1, RENDER_FRAME_HEIGHT), contentHeight: int(0, MAX_PROBE_PX), scale: renderScaleOf }),
  ),
  'design.probe': method(obj({ designId, relPath: filePath, widths: arr(renderWidth, MAX_PROBE_WIDTHS, 1), state: nullable(id), sweepTo: opt(renderWidth) }), designProbeResult),
  'design.journey': method(obj({ designId, relPath: filePath, widths: arr(renderWidth, MAX_PROBE_WIDTHS, 1), state: nullable(id), steps: journeySteps, outline: opt(bool) }), designJourneyRun),
  'design.replayJourney': method(obj({ panelId: id, designId, relPath: filePath, state: nullable(id), steps: journeySteps, reducedMotion: bool }), done),
};

const MIRROR_TOPICS: Tables<MainToCore>['mirrors'] = {
  state: obj({ scope: stateScope, key, value }),
  trust: obj({ keys: trustedKeys, granted: arr(filePath, MAX_ITEMS) }),
  folders: obj({ folders: arr(openFolder, MAX_ITEMS) }),
  panel: obj({ panelId: id, visible: bool, active: bool, column }),
  editor: editorMirror,
  terminal: terminalMirror,
  language: obj({ language: oneOf(['en', 'el'] as const) }),
  clientAuth: clientDelta(clientAuth),
  clientUser: clientDelta(clientUser),
  clientPolicy: clientDelta(clientPolicy),
  actingClient,
  hostSockets: obj({ agentFolder: opt(filePath), relayHandle: opt(filePath) }),
  clientEditor: clientDelta(editorMirror),
  clientTerminal: clientDelta(terminalMirror),
  clientLanguage: clientDelta(obj({ language: oneOf(['en', 'el'] as const) })),
  clientMcp: clientDelta(mcpServers),
  clientNetwork: obj({ authority: filePath, ...clientNetworkShape }),
};

const MAIN_REQUESTS: Tables<MainToCore>['requests'] = {
  'core.shutdown': method(nothing, done),
  'chats.restore': method(obj({ viewId: id, folderKey: opt(filePath), permissions: opt(chatPermissions) }), done),
  'chats.startInWorktree': method(obj({ viewId: id, projectKey: filePath, worktreeId: id }), done),
  'chats.openTranscript': method(obj({ viewId: id, hostId: id, file: filePath }), done),
  'chats.listMirrored': method(obj({ hostId: id, folder: filePath, query: opt(label) }), rows),
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
  'chats.stop': method(panelRef, done),
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
  'catalog.rename': method(obj({ sessionId: id, name: label }), catalogResult),
  'catalog.tag': method(obj({ sessionId: id, tag: either(label, nul) }), catalogResult),
  'catalog.delete': method(obj({ sessionId: id }), catalogResult),
  'sessionFiles.write': method(obj({ path: filePath, bytes: bytes(EDITOR_HARD_MAX_DOCUMENT_BYTES), expectedSha256: either(sha256Hex, nul) }), sessionFileWrite),
  'folders.setDefault': method(obj({ key: filePath }), done),
  'browser.newPage': method(obj({ chatViewId: id, url: opt(message) }), done),
  'browser.useClientCertificate': method(obj({ origin: key, filter: obj({ ISSUER: certificatePrincipal, SUBJECT: certificatePrincipal }) }), done),
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
  'views.join': method(obj({ viewId: id, viewKey: key, sessionId: opt(id), joining: viewKey }), either(obj({ panelId: id }), nul)),
  'scm.call': method(obj({ method: oneOf(SCM_CALLS), args: callArgs }), value),
  'scm.commit': method(obj({ repoId: id, message: text, variant: value, saved: arr(filePath, MAX_ITEMS), branchName: opt(id) }), commitOutcome),
  'scm.ignoredIn': method(obj({ projectKey: filePath, relativeDir: str(MAX_PATH_CHARS), entries: arr(obj({ name: filePath, dir: bool }), MAX_ITEMS) }), arr(filePath, MAX_ITEMS)),
  'scm.commitBlob': method(obj({ repoId: id, commit: label, path: filePath }), maybe(either(oneOf(['tooLarge'] as const), bytes(MAX_DATA_CHARS)))),
  'design.read': method(obj({ designId, relPath: filePath }), maybe(either(oneOf(['tooLarge'] as const), obj({ bytes: bytes(MAX_DATA_CHARS), fidelity: nullable(oneOf(['static', 'interactive'] as const)) })))),
  'design.info': method(obj({ designId, relPath: filePath }), maybe(designPreviewInfo)),
  'design.markup': method(obj({ panelId: id, png: str(MAX_IMAGE_BASE64_LENGTH), json: data(MAX_MARKUP_JSON_CHARS) }), either(obj({ feedbackId: id }), obj({ refused: localizedMessage }))),
  'design.tweak': method(obj({ panelId: id, tweakId: id, value: tokenName }), either(obj({ kept: yes }), obj({ refused: localizedMessage }))),
  'design.previewScreen': method(obj({ path: filePath }), either(obj({ opened: yes }), obj({ refused: localizedMessage }))),
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
  // each name takes its answers in turn, so a name has at least one
  'e2e.clientNetworkAnswers': method(obj({ answers: dict(arr(arr(nonEmpty(MAX_LABEL_CHARS), MAX_ACTIONS), MAX_ACTIONS, 1), MAX_KEY_CHARS, MAX_ACTIONS) }), done),
  'e2e.stubOAuth': method(obj({ account: (raw) => (typeof raw === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(raw) ? raw : INVALID), expiresInMs: int(1000, 3_600_000), offline: opt(bool) }), done),
  'user.resolveCredential': method(obj({ provider: id, force: opt(bool) }), brokerAnswer),
  'user.clientAuth': method(nothing, heldAuth),
  'user.credentials.push': method(obj({ provider: providerId, credential: pushedCredential }), done),
  'user.voice.speak': method(obj({ viewId: id, text }), done),
  'user.browser.tool': method(obj({ authority: filePath, viewId: id, scope: id, tool: id, input: value }), browserToolAnswer),
  'user.browser.release': method(obj({ authority: filePath, agentScope: opt(obj({ viewId: id, scope: id, closeTabs: bool, discard: opt(bool) })) }), done),
  'user.memory.search': method(obj({ query: text, k: searchCount, tiers: memoryTiers, injection: opt(bool), since: opt(memoryTime), until: opt(memoryTime), includeForgotten: opt(bool) }), searchedMemories),
  'user.memory.profile': method(nothing, clientGlobalProfile),
  'user.memory.resolve': method(obj({ ids: relayedIds }), arr(globalMemoryResolution, MAX_RELAYED_MEMORIES)),
  'user.memory.apply': method(obj({ writes: arr(globalMemoryWrite, MAX_ITEMS) }), obj({ applied: int(0, MAX_ITEMS), ids: opt(arr(memoryId, MAX_ITEMS)) })),
  'user.memory.list': method(obj({ kinds: memoryKinds, tags: memoryTags, cursor: memoryListCursor }), globalMemoryListPage),
  'memory.deliverHeld': method(obj({ queueId: memoryId }), bool),
  'memory.discardHeld': method(obj({ queueId: memoryId }), bool),
  'user.mcp.servers': method(nothing, arr(relayedMcpServer, MAX_ITEMS)),
  'user.mcp.call': method(obj({ server: label, tool: label, args: mcpArgs }), value),
  'user.mcp.resources': method(obj({ server: label, kind: mcpResourceKind, cursor: opt(message) }), value),
  'user.mcp.readResource': method(obj({ server: label, uri: message }), value),
  'panels.attachForeign': method(obj({ authority: filePath, viewId: id }), done),
  'panels.detachForeign': method(viewRef, done),
  'panels.foreignMessage': method(obj({ viewId: id, message: value }), done),
};

export const CORE_TO_MAIN: Tables<CoreToMain> = {
  requests: CORE_REQUESTS,
  events: {
    'window.openAppSettings': obj({ section: opt(section), account: opt(account), scope: opt(oneOf(['machine'] as const)) }),
    'window.toggleTerminal': nothing,
    'chat.activity': obj({ panelId: id, activity: chatActivity, sessionId: opt(id) }),
    'chat.turnSettled': obj({ panelId: id, outcome: turnOutcome }),
    'chat.changes': obj({ panelId: id, totals: value, generation: num }),
    'chat.usageThreshold': obj({ crossing: usageCrossing }),
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
    'user.mcpChanged': nothing,
    'ports.urlSeen': obj({ host: oneOf(['localhost', '127.0.0.1', '0.0.0.0'] as const), port: int(1, 65535) }),
    'design.changed': obj({ designId, paths: arr(filePath, MAX_CHANGED_PATHS) }),
  },
  mirrors: {
    chats: obj({ panelId: id, entry: opt(chatEntry) }),
    folderTargets: obj({ defaultKey: filePath, targets: arr(folderTarget, MAX_ITEMS) }),
    worktrees: obj({ records: rows }),
    scm: either(
      either(obj({ kind: oneOf(['view'] as const), projectKey: filePath, view: opt(value), realPath: opt(filePath) }), either(obj({ kind: oneOf(['repository'] as const), repoId: id, repository: opt(scmRepository) }), scmRepositoryState)),
      either(obj({ kind: oneOf(['decorations'] as const), projectKey: filePath, files: value }), obj({ kind: oneOf(['clone'] as const), state: value })),
    ),
    heldMemory: obj({ queues: arr(obj({ queueId: memoryId, count: int(1, Number.MAX_SAFE_INTEGER), lastSeen: memoryTime }), MAX_HELD_MEMORY_QUEUES) }),
  },
  panelOps: {
    create: panelCreate,
    showPage: obj({ page: pageSpec }),
    post: panelPost,
    postBinary: obj({ message: value, viewKey, except: opt(arr(id, MAX_ACTIONS)) }),
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
    message: obj({ message: value, viewKey }),
    disposed: obj({ error: opt(message), reason: oneOf(['user', 'detach'] as const) }),
    viewDetached: obj({ viewKey: id }),
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
    remoteMirrors: opt(filePath),
    askpass: obj({ askpass: filePath, sshAskpass: filePath, node: filePath, main: filePath, credentialRelay: opt(obj({ helper: filePath, handle: filePath, nonce: credentialNonce })) }),
  }),
  logs: obj({ dir: filePath, echo: bool }),
  endedCores: arr(obj({ pid: int(1, 2 ** 32), endedAt: int(0, Number.MAX_SAFE_INTEGER) }), MAX_ITEMS),
  worktreeRecords: rows,
  remote: opt(obj({ hostId: id, agentFolder: opt(filePath) })),
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
    clientEditor: opt(dict(editorMirror, MAX_ID_CHARS, MAX_ITEMS)),
    clientTerminal: opt(dict(terminalMirror, MAX_ID_CHARS, MAX_ITEMS)),
    clientLanguage: opt(dict(MIRROR_TOPICS.language, MAX_ID_CHARS, MAX_ITEMS)),
    clientMcp: opt(dict(mcpServers, MAX_ID_CHARS, MAX_ITEMS)),
    clientNetwork: opt(dict(obj(clientNetworkShape), MAX_PATH_CHARS, MAX_ITEMS)),
  }),
});

/** A client's version-0 values of the per-client mirrors, as control.attachCore carries them. */
export const parseClientValues: { readonly clientAuth: Parser<ClientAuth>; readonly clientUser: Parser<ClientUser>; readonly clientPolicy: Parser<ClientPolicy> } = { clientAuth, clientUser, clientPolicy };

/** ScmService.setProjects' argument as main sends it in scm.call: each listed root's key and folder. */
export const parseScmProjects: Parser<readonly { readonly key: string; readonly path: string }[]> = arr(obj({ key: filePath, path: filePath }), MAX_ITEMS);
