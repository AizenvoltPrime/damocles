// What a daemon's core takes from each attached client, and the webview-facing constants of remote chats. Main and core
// both import this file.
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from './types/messages';
import type { PermissionMode } from './types/settings';
import type { LocalizedText } from './localized-text';
import { isSwitchableToolGroup, TOOL_GROUP_SETTINGS, TOOLS_DISABLED_SETTING, type ToolGroup } from './types/tools';

/** The client id a local core's init names for its one client, main. A daemon names each client by its hello's stable clientId. */
export const LOCAL_CLIENT_ID = 'local';

/** The most a broker answer's expiresIn may be (ms); the client clamps to it, so a token never stays cached longer. */
export const MAX_BROKER_EXPIRES_IN_MS: number = 24 * 60 * 60 * 1000;

/** A credential the client sends a daemon's core for one provider. An OAuth answer never carries the refresh token. */
export type BrokerAnswer =
  | {
      readonly type: 'oauth';
      readonly access: string;
      // ms of validity on the client's clock; the target stores Date.now() + expiresIn on its own
      readonly expiresIn: number;
      readonly refresh: '';
      // the non-secret extras pi's OAuth providers read (openai-chatgpt, github-copilot)
      readonly clientId?: string;
      readonly scopes?: readonly string[];
      readonly enterpriseUrl?: string;
      readonly accountId?: string;
      readonly availableModelIds?: readonly string[];
    }
  // env: the credential's own stored env (a Cloudflare account and gateway), never the sender's environment
  | { readonly type: 'api_key'; readonly key: string; readonly env?: Readonly<Record<string, string>> }
  | { readonly type: 'none' };

/** The most variables an API key answer's env carries, and the longest name and value. */
export const MAX_BROKER_ENV_VARS = 16;
export const MAX_BROKER_ENV_NAME_CHARS = 128;
export const MAX_BROKER_ENV_VALUE_CHARS = 4096;
const BROKER_ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * A stored credential's env as every sender and parser of a broker answer takes it: the whole record when it has 1 to
 * MAX_BROKER_ENV_VARS variables, each named by BROKER_ENV_NAME within the bounds with a string value, else none.
 */
export function brokerEnvOf(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_BROKER_ENV_VARS) return undefined;
  const fits = entries.every(([name, text]) => name.length <= MAX_BROKER_ENV_NAME_CHARS && BROKER_ENV_NAME.test(name) && typeof text === 'string' && text.length <= MAX_BROKER_ENV_VALUE_CHARS);
  return fits ? Object.fromEntries(entries) as Record<string, string> : undefined;
}

/**
 * One provider's credential state on the client as it crosses machines, never a token or a key. hasKey: the broker answers
 * the provider with an API key (`apiKeyAnswerOf` of pi's runtime key, else its stored `api_key` credential, which a key-less
 * one such as a Bedrock AWS profile is not), and its change drops the cached credential; keySaved: OpenAI's or a key
 * provider's key is saved in Damocles, applied or outranked by a sign-in (absent before the client's first key read);
 * flatFee: the applied key bills a flat subscription;
 * allowance: the client bills this OAuth sign-in to its subscription's included allowance (Claude's allowance plugin is
 * active there); availableModelIds: the models the OAuth sign-in lists for the user's plan (GitHub Copilot); preferApiKey:
 * the client prefers its key saved in Damocles over a sign-in for OpenAI or a key provider (absent: it does not).
 */
export interface ClientAuthEntry {
  readonly type: 'oauth' | 'api_key' | 'none';
  // ms an OAuth credential stays valid on the sender's clock when sent; the receiver stores Date.now() + expiresIn
  readonly expiresIn?: number;
  readonly hasKey: boolean;
  readonly keySaved?: boolean;
  readonly flatFee: boolean;
  readonly allowance?: boolean;
  readonly availableModelIds?: readonly string[];
  readonly preferApiKey?: boolean;
}

/** The most model ids a plan list carries across machines, and the longest id. */
export const MAX_PLAN_MODEL_IDS = 512;
export const MAX_PLAN_MODEL_ID_CHARS = 128;

/**
 * A stored sign-in's plan list (`availableModelIds`) as every reader and sender takes it, so a local and a remote core
 * gate alike: the whole list when it is at most MAX_PLAN_MODEL_IDS non-empty ids of at most MAX_PLAN_MODEL_ID_CHARS,
 * else none, which gates nothing, as no list does.
 */
export function planModelIdsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_PLAN_MODEL_IDS) return undefined;
  const valid = value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_PLAN_MODEL_ID_CHARS);
  // a copy, so no holder shares the array a reader cached
  return valid ? [...(value as string[])] : undefined;
}

/**
 * Why a client's sign-ins or user rules are not known yet (feature client.pending): its first read is under way, its engine
 * is stopped, or its last read failed. A value carrying it holds nothing else and is never read as none.
 */
export type ClientPending = 'reading' | 'engineStopped' | 'readFailed';

export const CLIENT_PENDING_REASONS: readonly ClientPending[] = ['reading', 'engineStopped', 'readFailed'];

/** Every provider pi knows on the client, by provider id; pending: not known yet. */
export interface ClientAuth {
  readonly providers: Readonly<Record<string, ClientAuthEntry>>;
  readonly pending?: ClientPending;
}

/** A ClientAuthEntry as the machine holding it reads it: expires is epoch ms on that machine's own clock. */
export interface HeldAuthEntry {
  readonly type: ClientAuthEntry['type'];
  readonly expires?: number;
  readonly hasKey: boolean;
  readonly keySaved?: boolean;
  readonly flatFee: boolean;
  readonly allowance?: boolean;
  readonly availableModelIds?: readonly string[];
  readonly preferApiKey?: boolean;
}

export interface HeldAuth {
  readonly providers: Readonly<Record<string, HeldAuthEntry>>;
  readonly pending?: ClientPending;
}

/** A held snapshot as it is sent at `now`: each expiry becomes the ms left on this clock, never below 0. */
export function sentClientAuth(held: HeldAuth, now: number): ClientAuth {
  return {
    providers: Object.fromEntries(Object.entries(held.providers).map(([provider, { expires, ...entry }]) =>
      [provider, expires === undefined ? entry : { ...entry, expiresIn: Math.max(Math.floor(expires - now), 0) }])),
    ...(held.pending !== undefined ? { pending: held.pending } : {}),
  };
}

/** A snapshot as it arrives at `now`: each expiresIn stamped on this clock. */
export function heldClientAuth(sent: ClientAuth, now: number): HeldAuth {
  return {
    providers: Object.fromEntries(Object.entries(sent.providers).map(([provider, { expiresIn, ...entry }]) =>
      [provider, expiresIn === undefined ? entry : { ...entry, expires: now + expiresIn }])),
    ...(sent.pending !== undefined ? { pending: sent.pending } : {}),
  };
}

/** A user folder whose settings files hold permission rules; a `/path` rule in one of them is relative to that folder. */
export type UserRulesDir = '.damocles' | '.claude';

export interface PermissionRuleLists {
  readonly allow: readonly string[];
  readonly ask: readonly string[];
  readonly deny: readonly string[];
  readonly dir: UserRulesDir;
}

/**
 * The client's user layer as a daemon's core reads it: the contributed setting keys of its user settings, and the permission
 * rules of each of its user files (~/.damocles/settings*.json, ~/.claude/settings*.json), one entry per file in
 * loadPermissionsByPriority's order, so a `!` carve-out never crosses files. Never env, apiKeyHelper, hooks or tokens.
 * pending: not known yet.
 */
export interface ClientUser {
  readonly settings: Readonly<Record<string, unknown>>;
  readonly permissionRules: readonly PermissionRuleLists[];
  readonly pending?: ClientPending;
}

/**
 * What the client allows a daemon's core: its voice capability (HostCapabilities.voice), YOLO, the host's default mode and
 * agent forwarding.
 * sharedLoopback: the target runs on the client's own machine (the loopback authority), so a loopback endpoint is reachable.
 */
export interface ClientPolicy {
  readonly voice: boolean;
  readonly allowBypass: boolean;
  readonly defaultPermissionMode?: PermissionMode;
  readonly sharedLoopback?: boolean;
  // the host's Forward SSH agent switch: the daemon's agent socket reaches this client's processes only while it is on
  readonly agentForwarding?: boolean;
}

/** The daemon's request to a client whose connection is gone (user.credentials to an absent pinned client). */
export const CREDENTIAL_CLIENT_ABSENT = 'credential-client-absent';

/**
 * This computer's core's answer to a remote core's read made on an agent's request (user.memory.list, a search that is not an
 * injection's) while memory is off here; the remote core words it, never shows it.
 */
export const CLIENT_MEMORY_OFF = 'client-memory-off';

/** A user-scope service (browser, global memory), which runs on the client, that a chat on a remote host cannot reach in this version. */
export const USER_SCOPE_UNAVAILABLE = 'user-scope-unavailable';

/** The core-to-view voice messages; main delivers them to a remote chat's view only from this computer's foreign proxy. */
export const VOICE_VIEW_POSTS: ReadonlySet<string> = new Set([
  'voiceRecordingStarted',
  'transcriptionResult',
  'transcriptionError',
  'voiceConfigUpdate',
  'voiceRuntimeStatus',
  'voiceSidecarStatus',
  'voiceWakeDetected',
  'voiceWakeAborted',
  'voiceVadStarted',
  'voiceVadEnded',
  'voiceTranscriptFinal',
  'voiceTtsAudioChunk',
  'voiceTtsDone',
  'voiceMicUnavailable',
  'voiceModelDownloadProgress',
  'voiceModelDownloadAllDone',
  'voiceModelDownloadCancelled',
  'voiceModelUpgradeAvailable',
  'voiceFirstRunRequired',
  'voiceFilesSizeUpdate',
  'voiceCpuFallbackActive',
  'voiceTurnLost',
] satisfies ExtensionToWebviewMessage['type'][]);

/**
 * The webview-to-core message types a remote chat's page sends to this computer's core, whose voice service records,
 * transcribes and speaks; main routes them, with the rest of FOREIGN_VIEW_MESSAGES, to that core and never to the chat's
 * remote core (foreign-view-relay.ts). Voice settings change only on the settings overlay's User tab, this computer's core:
 * a daemon's core treats every voice key as the client's, so its host and Project tabs never list one.
 */
export const VOICE_VIEW_MESSAGES: ReadonlySet<string> = new Set([
  'startVoiceRecording',
  'stopVoiceRecording',
  'cancelVoiceRecording',
  'requestVoiceConfig',
  'voiceStreamEnable',
  'voiceStreamDisable',
  'voiceStreamMute',
  'voiceWebviewMicUnavailable',
  'voiceAcceptFirstRunModal',
  'voiceCancelFirstRunModal',
  'voiceAcceptModelUpgrade',
  'voiceDismissModelUpgrade',
  'voiceCancelModelDownload',
] satisfies WebviewToExtensionMessage['type'][]);

/**
 * The failure toast of each write a remote chat page makes of this computer's user settings, an l() message whose {0} is the
 * reason; this computer's core and main, when that core never answered, both word it so. It stays a plain object literal, so
 * the l10n bundle check reads each message through its property.
 */
export const REMOTE_CHAT_SETTING_FAILURES: Readonly<Record<RemoteChatSettingMessage, string>> = {
  setPinnedHeaderHidden: 'Failed to save pinned header setting: {0}',
  toggleToolGroup: 'Failed to save tool group setting: {0}',
  toggleTool: 'Failed to save tool setting: {0}',
};

export type RemoteChatSettingMessage = Extract<WebviewToExtensionMessage['type'], 'setPinnedHeaderHidden' | 'toggleToolGroup' | 'toggleTool'>;

/**
 * A remote chat page's writes of this computer's user settings: this computer's core writes its own user file, which the
 * daemon reads as clientUser, so the setting applies to local chats too. Even while the host is away they never reach the
 * remote core, which may not write that file.
 */
export const REMOTE_CHAT_USER_SETTING_MESSAGES: ReadonlySet<string> = new Set(Object.keys(REMOTE_CHAT_SETTING_FAILURES));

export const isRemoteChatSettingMessage = (type: string): type is RemoteChatSettingMessage => Object.hasOwn(REMOTE_CHAT_SETTING_FAILURES, type);

export type UserMemoryViewRequest = Extract<WebviewToExtensionMessage['type'],
  | 'requestUserMemories' | 'getUserMemoryHistory' | 'getUserRelatedMemories' | 'getUserProfile' | 'createUserMemory' | 'deleteUserMemory'
  | 'pinUserMemory' | 'unpinUserMemory' | 'forgetUserMemory' | 'unforgetUserMemory' | 'setUserProfileSection'>;

/**
 * A remote chat page's reads and changes of this computer's notes and global memories, each 'panel' when it changes a row and
 * undefined for a read, whose failure must not settle a pending create. Ids are this computer's own rows.
 */
export const USER_MEMORY_VIEW_SOURCES: Readonly<Record<UserMemoryViewRequest, 'panel' | undefined>> = {
  requestUserMemories: undefined,
  getUserMemoryHistory: undefined,
  getUserRelatedMemories: undefined,
  getUserProfile: undefined,
  createUserMemory: 'panel',
  deleteUserMemory: 'panel',
  pinUserMemory: 'panel',
  unpinUserMemory: 'panel',
  forgetUserMemory: 'panel',
  unforgetUserMemory: 'panel',
  setUserProfileSection: 'panel',
};

export type RemoteChatLocalRequest = Extract<WebviewToExtensionMessage['type'], 'requestSubscriptionUsage'> | UserMemoryViewRequest;

/**
 * A remote chat page's reads and changes of this computer's user scope. This computer's core answers them from its own data,
 * so main sends them there whether or not the host is attached, and the remote core never receives them.
 */
export const REMOTE_CHAT_LOCAL_REQUESTS: ReadonlySet<string> = new Set([
  'requestSubscriptionUsage',
  ...Object.keys(USER_MEMORY_VIEW_SOURCES),
]);

export const isRemoteChatLocalRequest = (type: string): type is RemoteChatLocalRequest => REMOTE_CHAT_LOCAL_REQUESTS.has(type);

/**
 * The posts that answer REMOTE_CHAT_LOCAL_REQUESTS; main delivers them while the view is live, attached host or not. No core
 * posts one of these types for its own data, so main refuses every one from a remote core and the page trusts them as this
 * computer's.
 */
export const REMOTE_CHAT_LOCAL_POSTS: ReadonlySet<string> = new Set([
  'subscriptionUsage',
  'userMemoriesUpdate',
  'userProfileData',
  'userMemoryHistory',
  'userRelatedMemories',
  'userMemoryCreated',
  'userMemoryDeleted',
  'userMemoryPinned',
  'userMemoryUnpinned',
  'userMemoryForgotten',
  'userMemoryUnforgotten',
  'userMemoryError',
  'userProfileSectionError',
  // this computer's Git hosting accounts, which a remote chat's refused notice lists, and its notice's bind result
  'forgeAccountsChanged',
  'forgeRefusedBindResult',
] satisfies ExtensionToWebviewMessage['type'][]);

export type RemoteChatForgeMessage = Extract<WebviewToExtensionMessage['type'], 'forgeRefusedBind' | 'forgeRefusedOpenSettings' | 'forgeRefusedOrgAction'>;

/**
 * A remote chat page's actions on a refused notice a GitHub or GitLab tool raised: the refusal and the accounts are this
 * computer's (user.forge.*), so its core acts on them, whether or not the host is attached, and the remote core never sees them.
 */
export const REMOTE_CHAT_FORGE_MESSAGES: ReadonlySet<string> = new Set([
  'forgeRefusedBind',
  'forgeRefusedOpenSettings',
  'forgeRefusedOrgAction',
] satisfies RemoteChatForgeMessage[]);

export const isRemoteChatForgeMessage = (type: string): type is RemoteChatForgeMessage => REMOTE_CHAT_FORGE_MESSAGES.has(type);

/** Every webview message a remote chat's page sends to this computer's core instead of its own. */
export const FOREIGN_VIEW_MESSAGES: ReadonlySet<string> = new Set([...VOICE_VIEW_MESSAGES, ...REMOTE_CHAT_USER_SETTING_MESSAGES, ...REMOTE_CHAT_LOCAL_REQUESTS, ...REMOTE_CHAT_FORGE_MESSAGES]);

/** The longest requestId a createUserMemory carries; this computer's core and main's fallback echo none longer. */
export const MAX_VIEW_REQUEST_ID_CHARS = 128;

/** A view message's requestId when it is a string of 1..MAX_VIEW_REQUEST_ID_CHARS, else undefined. */
export function viewRequestIdOf(message: unknown): string | undefined {
  const requestId = (message as { readonly requestId?: unknown } | null)?.requestId;
  return typeof requestId === 'string' && requestId.length > 0 && requestId.length <= MAX_VIEW_REQUEST_ID_CHARS ? requestId : undefined;
}

/**
 * The failure answer of a REMOTE_CHAT_LOCAL_REQUESTS message: this computer's core's when it refuses one, main's when that core
 * never answered, so the page never waits on it. It echoes only fields it checked: a bounded requestId and a section of static
 * or dynamic.
 */
export function remoteChatLocalFailure(type: RemoteChatLocalRequest, message: unknown, detail: LocalizedText): ExtensionToWebviewMessage {
  switch (type) {
    case 'requestSubscriptionUsage': {
      const failed = { status: 'error' as const, bars: [], error: detail };
      return { type: 'subscriptionUsage', data: { claude: failed, gpt: { ...failed, bars: [] }, fetchedAt: Date.now() } };
    }
    case 'setUserProfileSection': {
      const section = (message as { readonly section?: unknown } | null)?.section;
      if (section === 'static' || section === 'dynamic') return { type: 'userProfileSectionError', section, message: detail };
      return { type: 'userMemoryError', request: type, message: detail };
    }
    case 'createUserMemory': {
      const requestId = viewRequestIdOf(message);
      return { type: 'userMemoryError', request: type, message: detail, ...(requestId !== undefined ? { requestId } : {}) };
    }
    default:
      return { type: 'userMemoryError', request: type, message: detail };
  }
}

/** The key a remote chat page's setting write reports its settingWriteResult under; undefined for a group that has no switch. */
export function remoteChatSettingKey(type: RemoteChatSettingMessage, group: unknown): string | undefined {
  switch (type) {
    case 'setPinnedHeaderHidden':
      return 'damocles.pinnedHeaderHidden';
    case 'toggleToolGroup': {
      const named = group as ToolGroup;
      return typeof group === 'string' && isSwitchableToolGroup(named) ? TOOL_GROUP_SETTINGS[named] : undefined;
    }
    case 'toggleTool':
      return TOOLS_DISABLED_SETTING;
  }
}

/** Why this computer's core refused a message for a remote chat view it holds no proxy for, as main matches it. */
export const FOREIGN_VIEW_NOT_ATTACHED = 'The remote chat view is not attached';

/** The posts that answer REMOTE_CHAT_USER_SETTING_MESSAGES; while the host is not attached main delivers them only while a write of that view waits for its answer. */
export const FOREIGN_SETTING_POSTS: ReadonlySet<string> = new Set([
  'settingWriteResult',
  'notification',
] satisfies ExtensionToWebviewMessage['type'][]);

/** A browser tool's result as this computer's core runs it for a remote chat (user.browser.tool): pi's text and image blocks. */
export interface BrowserToolAnswer {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string } | { readonly type: 'image'; readonly data: string; readonly mimeType: string }>;
  readonly isError?: boolean;
}

// the agent's scope id of a chat's main agent and its human, as a relayed browser tool names it
export const CHAT_BROWSER_SCOPE = 'chat';

/** The kinds of a global memory a remote core may read or write on its client. */
export type GlobalMemoryKind = 'fact' | 'preference' | 'episode' | 'note';

/** A client's global memory as its own core returns it to a remote core (user.memory.*); id is the client's own id. */
export interface RelayedGlobalMemory {
  readonly id: string;
  readonly kind: GlobalMemoryKind;
  readonly title?: string;
  readonly content: string;
  readonly contentHash: string;
  readonly tags?: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A remote core's search_memories filters, which the client applies to its global rows as its own search does (epoch ms). */
export interface GlobalMemorySearchFilters {
  readonly since?: number;
  readonly until?: number;
  readonly includeForgotten?: boolean;
}

/** A memory a search answers; an injection search's also says whether the client's gate lets it render full, and the terms it matched. */
export interface SearchedGlobalMemory extends RelayedGlobalMemory {
  readonly fullAllowed?: boolean;
  readonly matchedTerms?: readonly string[];
}

// The user.memory.* tables' bounds (core-protocol/messages.ts parses with them); a request or answer past one is a protocol
// violation, so every producer keeps within them.
/** The most global memories one user.memory request names or one answer lists, and the most terms an answer's memory matched. */
export const MAX_RELAYED_MEMORIES = 64;
/** The most tags a relayed global memory carries. */
export const MAX_GLOBAL_MEMORY_TAGS = 64;
/** The longest title or tag of a relayed global memory. */
export const MAX_GLOBAL_MEMORY_LABEL_CHARS: number = 64 * 1024;
/** The longest content of a relayed global memory. */
export const MAX_GLOBAL_MEMORY_CONTENT_CHARS: number = 64 * 1024 * 1024;
/** The longest id, content hash or write uuid of a relayed global memory. */
export const MAX_GLOBAL_MEMORY_ID_CHARS = 128;

/** Whether a write fits user.memory.apply's table, so sending it cannot be a protocol violation. */
export function globalMemoryWriteFits(write: GlobalMemoryWrite): boolean {
  return write.uuid.length > 0 && write.uuid.length <= MAX_GLOBAL_MEMORY_ID_CHARS
    && write.content.length <= MAX_GLOBAL_MEMORY_CONTENT_CHARS
    && (write.title === undefined || write.title.length <= MAX_GLOBAL_MEMORY_LABEL_CHARS)
    && (write.tags === undefined || (write.tags.length <= MAX_GLOBAL_MEMORY_TAGS && write.tags.every((tag) => tag.length <= MAX_GLOBAL_MEMORY_LABEL_CHARS)));
}

/** The most pinned and preference globals a client sends with its profile. */
export const MAX_STANDING_GLOBALS = 64;

/**
 * A client's global profile and the globals a remote core injects once per context whatever the prompt says: its pinned
 * global memories and its global preferences (user.memory.profile), read once per attach.
 */
export interface ClientGlobalProfile {
  readonly profile: { readonly static: string; readonly dynamic: string };
  readonly pinned: readonly RelayedGlobalMemory[];
  readonly preferences: readonly RelayedGlobalMemory[];
}

/** What a client's core says of a global memory a remote core injected earlier: its current version, or that it is gone. */
export type GlobalMemoryResolution =
  | { readonly id: string; readonly memory: RelayedGlobalMemory }
  | { readonly id: string; readonly gone: true; readonly byUser: boolean };

/** The JSON bytes of the writes one user.memory.apply carries, far below the core channel's message bound; a larger write goes alone. */
export const MAX_GLOBAL_MEMORY_APPLY_BYTES: number = 16 * 1024 * 1024;

/** The JSON bytes of the rows one user.memory.list page carries, as the apply budget; a larger row goes alone. */
export const MAX_GLOBAL_MEMORY_LIST_BYTES: number = 16 * 1024 * 1024;

/** A user.memory.list keyset position: the last row of a page, in created_at DESC, id DESC order. */
export interface GlobalMemoryListCursor {
  readonly createdAt: number;
  readonly id: string;
}

/** A remote core's user.memory.list: the client's latest notes, with any of the tags, below the cursor. */
export interface GlobalMemoryListRequest {
  readonly kinds: readonly 'note'[];
  readonly tags?: readonly string[];
  readonly cursor?: GlobalMemoryListCursor;
}

/** A listed global memory: forgotten rows are listed too, as the client's own notes list shows them. */
export interface ListedGlobalMemory extends RelayedGlobalMemory {
  readonly forgotten?: true;
}

/** One user.memory.list page: at most MAX_RELAYED_MEMORIES rows below the cursor asked for; next is the last row's key while more rows remain. */
export interface GlobalMemoryListPage {
  readonly rows: readonly ListedGlobalMemory[];
  readonly next?: GlobalMemoryListCursor;
}

const utf8 = new TextEncoder();

/** A listed row's size against MAX_GLOBAL_MEMORY_LIST_BYTES: its JSON's UTF-8 bytes, as the client and main both count it. */
export function listedMemoryBytes(row: ListedGlobalMemory): number {
  return utf8.encode(JSON.stringify(row)).length;
}

/**
 * Whether a row's key comes strictly after the cursor in created_at DESC, id DESC order. Ids compare by their UTF-8 bytes, as
 * SQLite's BINARY collation orders them, so main checks a page in the order the client's query produced it.
 */
export function listedAfter(key: GlobalMemoryListCursor, cursor: GlobalMemoryListCursor): boolean {
  if (key.createdAt !== cursor.createdAt) return key.createdAt < cursor.createdAt;
  const a = utf8.encode(key.id), b = utf8.encode(cursor.id);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return a.length < b.length;
}

// SQLite's LIKE, which the notes list's tag rule runs, folds ASCII letters only
const asciiFold = (tag: string): string => tag.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** Whether a row carries any of the tags asked for, as the notes list's tag rule matches them. */
export function carriesAnyTag(rowTags: readonly string[] | undefined, asked: readonly string[]): boolean {
  const wanted = new Set(asked.map(asciiFold));
  return rowTags?.some((tag) => wanted.has(asciiFold(tag))) === true;
}

/** The daemon's answer to a pinnedClient request whose client's attach did not list the route's feature. */
export const CLIENT_FEATURE_MISSING = 'client-feature-missing';

/** How long main waits for this computer's core to answer a user.memory read (search, profile, resolve) of a remote core. */
export const GLOBAL_MEMORY_READ_TIMEOUT_MS = 10_000;
/** How long main waits for this computer's core to apply one user.memory.apply batch, each write's conflict check included. */
export const GLOBAL_MEMORY_APPLY_TIMEOUT_MS: number = 5 * 60_000;

/**
 * An outbox a daemon's core holds for a device that has not attached for GLOBAL_MEMORY_HOLD_MS, which another attached device
 * may take or discard: queueId is the held device's client id, count its entries, lastSeen when it was last attached (epoch ms).
 */
export interface HeldMemoryQueue {
  readonly queueId: string;
  readonly count: number;
  readonly lastSeen: number;
}

export const GLOBAL_MEMORY_HOLD_MS: number = 30 * 24 * 60 * 60 * 1000;
/** The most held queues a daemon's core lists, oldest lastSeen first. */
export const MAX_HELD_MEMORY_QUEUES = 100;

/** A global memory write of a remote core: applied once on its client, its uuid recorded in the same transaction. */
export interface GlobalMemoryWrite {
  readonly uuid: string;
  readonly kind: GlobalMemoryKind;
  readonly content: string;
  readonly title?: string;
  readonly tags?: readonly string[];
}

/** One personal MCP server a client marked available on remote hosts: its name and schemas only, never env or headers. */
export interface RelayedMcpServer {
  readonly name: string;
  readonly description?: string;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly title?: string;
    readonly description?: string;
    readonly inputSchema?: unknown;
    readonly annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean; readonly idempotentHint?: boolean; readonly openWorldHint?: boolean };
    // the client's config exposure of the tool; absent: deferred
    readonly exposure?: 'deferred' | 'direct';
  }>;
  readonly resources: boolean;
  // how long the client waits on one request of the server (its config's timeout), so the remote side waits as long
  readonly timeoutMs?: number;
}

/** A client's clientMcp mirror; pending (feature client.pending): not read yet, so `servers` is empty and never read as none. */
export interface ClientMcp {
  readonly servers: readonly RelayedMcpServer[];
  readonly pending?: ClientPending;
}

/** The longest relayed request timeout: past it a Node timer fires at once. */
export const MAX_RELAYED_MCP_TIMEOUT_MS = 2_147_483_647;
