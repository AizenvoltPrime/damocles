// What a daemon's core takes from each attached client, and the webview-facing constants of remote chats. Main and core
// both import this file.
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from './types/messages';
import type { PermissionMode } from './types/settings';

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
  | { readonly type: 'api_key'; readonly key: string }
  | { readonly type: 'none' };

/**
 * One provider's credential state on the client as it crosses machines, never a token or a key. hasKey: pi holds an API
 * key for the provider (Damocles' runtime key or a stored `api_key`; for OpenAI also the saved key), which the broker
 * answers and whose change drops its cached credential; keySaved: a key provider's key is saved in Damocles, applied or
 * outranked by a sign-in (absent before the client's first key sync); flatFee: the applied key bills a flat subscription;
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

/** Every provider pi knows on the client, by provider id. */
export interface ClientAuth {
  readonly providers: Readonly<Record<string, ClientAuthEntry>>;
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
}

/** A held snapshot as it is sent at `now`: each expiry becomes the ms left on this clock, never below 0. */
export function sentClientAuth(held: HeldAuth, now: number): ClientAuth {
  return {
    providers: Object.fromEntries(Object.entries(held.providers).map(([provider, { expires, ...entry }]) =>
      [provider, expires === undefined ? entry : { ...entry, expiresIn: Math.max(Math.floor(expires - now), 0) }])),
  };
}

/** A snapshot as it arrives at `now`: each expiresIn stamped on this clock. */
export function heldClientAuth(sent: ClientAuth, now: number): HeldAuth {
  return {
    providers: Object.fromEntries(Object.entries(sent.providers).map(([provider, { expiresIn, ...entry }]) =>
      [provider, expiresIn === undefined ? entry : { ...entry, expires: now + expiresIn }])),
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
 */
export interface ClientUser {
  readonly settings: Readonly<Record<string, unknown>>;
  readonly permissionRules: readonly PermissionRuleLists[];
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
 * transcribes and speaks. Voice settings change only on the settings overlay's User tab, this computer's core: a daemon's
 * core treats every voice key as the client's, so its host and Project tabs never list one.
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

/** The longest relayed request timeout: past it a Node timer fires at once. */
export const MAX_RELAYED_MCP_TIMEOUT_MS = 2_147_483_647;
