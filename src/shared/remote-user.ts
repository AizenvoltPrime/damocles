// What a daemon's core takes from each attached client, and the webview-facing constants of remote chats. Main and core
// both import this file.
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from './types/messages';
import type { PermissionMode } from './types/settings';

/** The client id a local core's init names for its one client, main. A daemon's ids are its connection ids. */
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
 * active there); availableModelIds: the models the OAuth sign-in lists for the user's plan (GitHub Copilot).
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
 * What the client allows a daemon's core: its voice capability (HostCapabilities.voice), YOLO, and the host's default mode.
 * sharedLoopback: the target runs on the client's own machine (the loopback authority), so a loopback endpoint is reachable.
 */
export interface ClientPolicy {
  readonly voice: boolean;
  readonly allowBypass: boolean;
  readonly defaultPermissionMode?: PermissionMode;
  readonly sharedLoopback?: boolean;
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
