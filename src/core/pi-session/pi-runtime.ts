import type { ModelRuntime, PackageManager, PackageSource, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { Api, AuthInteraction, ClassifierAnswer, ClassifierApi, ClassifierModel, ClassifierQuestion, JsonObject, Model, ModelThinkingLevel } from '@earendil-works/pi-ai';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log } from '../logger';
import { l } from '../l10n';
import { LocalizedError, type LocalizedText } from '../../shared/localized-text';
import { serializeSettingWrite } from '../settings-write-chain';
import { timed } from '../perf';
import { initPiLoader, getPiCodingAgent, loadPiAi, loadedPiAi, type PiCodingAgentModule } from './pi-loader';
import { cacheWarmingSetting, ensurePiAgentDir, PI_AGENT_DIR } from './agent-dir';
import { CONTEXT_FILE_CANDIDATES } from './context-files';
import { ASSET_SOURCE_PRECEDENCE_SETTING, assetSources } from '../asset-sources';
import { renamePiSession, type LiveSessionMetaSource } from './session-store';
import { writeUnderSessionLease } from './session-store/session-lease';
import { McpClientManager } from './mcp/mcp-client-manager';
import { createMcpAuthProviderFactory, shutdownOAuth } from './mcp/mcp-auth-flow';
import { removeSavedMcpOutputs } from './mcp/content';
import type { AdditionMemory, NoticeMemory, PersonalToolLists, RenamedRuleNoticeEntry, ToolNameList } from './mcp/tool-name-migration';
import { inertToolListEntry } from '../permission-handler/mcp-resource-rule';
import { piSupportedModels, type ModelLookup } from './pi-models';
import { piModelDollarBilled } from './account-billing';
import { KEYED_PROVIDER_DEFS, flatFeeKeyProviders, keyProviderOfSecret, syncCustomProviders, type SecretResolver } from './custom-providers';
import {
  resolveAutomaticModel,
  resolveBackgroundModel,
  resolvePickedModel,
  subCallLevel,
  subCallReasoning,
  type StructuredSubCallPurpose,
  type SubCallModel,
} from './subcall-model';
import { describeAuthError, describeCatalogError, isCredentialSyncError } from './describe-error';
import { piModelNetworkEnabled, savedCatalogCheckedAt } from './pi-model-catalog';
import { isAbortError } from './web-access/util';
import { CREDENTIAL_REFUSED, isPiCredentialError, runStructuredCompletion, UNREACHABLE, type CredentialRefused, type PiCompleteFn, type StructuredCompletionRequest, type StructuredCompletionResult } from './structured-completion';
import { appendSubCallUsage, type SubCallAttribution, type SubCallPurpose } from '../usage-stats/subcall-ledger';
import { httpStatusOf, isInputRefusal } from './http-status';
import {
  CLASSIFIER_MODELS,
  classifierCredential,
  classifierFailureCause,
  classifierModelOf,
  memoryJudgeOf,
  pickClassifierModel,
  type ClassifierModelRef,
} from './classifier-model';
import { CLASSIFIER_PROBE_AFTER_MS, createClassifierBreakers, credentialRejectionOf, type ClassifierOutcome } from './classifier-breaker';
import type { ClassifierCredential, ClassifierProvider, EffortLevel, MemoryJudge, MemoryJudgeUnavailable } from '../../shared/types/settings';
import { MEMORY_JUDGE_EFFORT_SETTING, MEMORY_JUDGE_SETTING, forcedClassifierOf, isKnownMemoryJudgeChoice } from '../../shared/memory-judge';
import { migrateLegacyModelValue } from '../../shared/types/constants';
import {
  LEGACY_SUBSCRIPTION_REPOS,
  SUBSCRIPTION_SOURCE,
  classifySubscriptionSource,
  listedSubscriptionKinds,
  readClaudeAuthFromDisk,
  type ClaudeAuthStatus,
} from './subscription';
import { forceRemoveDir } from './fs-remove';
import {
  OPENAI_API_KEY_SECRET,
  OPENAI_API_PROVIDER,
  OPENAI_CODEX_PROVIDER,
  OPENAI_PREFER_API_KEY_STATE,
  openaiAuthStatus,
  openaiRuntimeKeyWanted,
  readOpenAIAuthFromDisk,
  readPreferOpenAIApiKey,
  type OpenAIAuthInputs,
  type OpenAIAuthStatus,
} from './openai-auth';
import { syncOpenAIRuntimeKey } from './openai-runtime-key';
import { migrateOpenAIApiKey } from './openai-key-migration';
import { OPENAI_KEY_MOVED_MARKER_PATH, PROVIDER_KEY_SWEEP_MARKER_PATH } from '../paths';
import { planModelsOf, providerPreferApiKeyState, readPreferProviderApiKey, readProviderSignIns, type ProviderSignIns } from './provider-auth';
import { FolderRuntime, type ExtensionLoadError } from './folder-runtime';
import { MCP_RESOURCE_EXPOSURE_SETTING, MCP_TOOL_EXPOSURE_SETTING, renamedRuleNoticeKey, type McpRenamedToolRuleLocation } from '../../shared/types/mcp';
import { folderKey } from '../workspace-folders/folder-key';
import { isKeyProviderId, type ExternalKeySource, type KeyProviderId, type SignInProviderId } from '../../shared/settings-sections';
import { withSettingsPolicy } from './settings-policy';
import { platform } from '../platform-host';
import type { Platform } from '../../platform/platform';
import type { Disposable } from '../../platform/disposable';
import type { RemoteHost } from '../../platform/remote-host';
import type { FileWatcher, FileWatcherFactory } from '../../platform/file-watcher';
import { IMAGE_SETTINGS_SECTION } from './tools/image-tool-specs';
import { fetchSubscriptionUsage } from './subscription-usage';
import { UsageMonitor, type UsageThresholdCrossing } from './usage-thresholds';
import { BrokeredCredentialStore, oauthAnswerOf } from './credential-broker';
import { allowanceProvider, builtinAnthropicTransport, clientClaudeAuthStatus, loadAllowanceTransport, subscriptionPluginDir } from './allowance-transport';
import { logAuthReadFailure, readAuthFile } from './auth-file';
import { clientHasAuth, clientHasCredential, clientHasKey, clientPrefersApiKey, credentialSourceOf, outsidePins, runPinnedSubcall } from '../client-snapshots';
import { MODEL_PICKER_SETTING, MODEL_VENDORS, vendorPiProviders, type ModelVendor } from '../../shared/model-vendor';
import { planModelIdsOf, type BrokerAnswer, type HeldAuth, type HeldAuthEntry } from '../../shared/remote-user';

/**
 * How long the custom-provider credential sync may block before it is cancelled. The sync is offline
 * under 0.85, so the only blocking I/O left is the `auth.json` / `models-store.json` locks, shared with
 * every other VS Code window and any `pi` CLI, while this gates all user input at startup. Not a user
 * setting: it is not a value anyone can reason about correctly.
 */
const CUSTOM_PROVIDER_SYNC_TIMEOUT_MS = 3000;
const TOOLS_DISABLED_SETTING = 'damocles.tools.disabled';
/**
 * Bounds one attempt at the OpenRouter catalog: its wait for `_providerSync` to go idle, which a plugin install can
 * hold indefinitely, plus pi's pi.dev download and OpenRouter's `/models/user`.
 */
const OPENROUTER_CATALOG_REFRESH_TIMEOUT_MS = 30_000;

/** pi rewrites auth.json as a truncate then a write, which a watcher reports as more than one event. */
const AUTH_REPUBLISH_DEBOUNCE_MS = 150;

const clientAuthListeners = new Set<() => void>();
function notifyClientAuthListeners(): void {
  for (const listener of [...clientAuthListeners]) {
    try {
      listener();
    } catch (err) {
      log('[PiRuntime] client auth listener failed: %O', err);
    }
  }
}
const actingClientListeners = new Set<() => void>();
function notifyActingClientListeners(): void {
  for (const listener of [...actingClientListeners]) {
    try {
      listener();
    } catch (err) {
      log('[PiRuntime] acting client listener failed: %O', err);
    }
  }
}
/** Module-level so subscribing never creates the singleton: activation must leave `PiRuntime.exists` false. */
// clientId: on a daemon's core, the one device whose user layer changed an input
const memoryJudgeListeners = new Set<(clientId?: string) => void>();
function notifyMemoryJudgeListeners(clientId?: string): void {
  for (const listener of [...memoryJudgeListeners]) {
    try {
      listener(clientId);
    } catch (err) {
      log('[PiRuntime] memory judge listener failed: %O', err);
    }
  }
}
/** `accountChanged`: the sync may have changed an account input, so every panel's account state is stale. */
export interface CustomProvidersSynced {
  accountChanged: boolean;
}
const customProvidersSyncedListeners = new Set<(sync: CustomProvidersSynced) => void>();
/** What a custom-provider sync tells its caller; `notWired` is "configured, but not live". */
export interface CustomProviderSyncOutcome {
  wired: string[];
  notWired: string[];
  timedOut: boolean;
}
/** Every plan provider's models are refused while auth.json cannot be read, so an unreadable file never turns plan gating off. */
const NO_PLAN_MODELS: ReadonlySet<string> = new Set();
// keySynced: the runtime's key sync for the change published every account input but the Claude and OpenAI rows; else the runtime told the judge status alone
const authFileListeners = new Set<(keySynced: boolean) => void>();

function notifyAuthFileListeners(keySynced: boolean): void {
  for (const listener of [...authFileListeners]) {
    try {
      listener(keySynced);
    } catch (err) {
      log('[PiRuntime] auth file listener failed: %O', err);
    }
  }
}

/** An account input changed and no key sync publishes it: the judge status hears it here, and the auth-file listeners publish the rest. */
function notifyUnsyncedAccountChange(): void {
  notifyClientAuthListeners();
  notifyMemoryJudgeListeners();
  notifyAuthFileListeners(false);
}

const openaiCredentialListeners = new Set<() => void>();
function notifyOpenAICredentialListeners(): void {
  for (const listener of [...openaiCredentialListeners]) {
    try {
      listener();
    } catch (err) {
      log('[PiRuntime] OpenAI credential listener failed: %O', err);
    }
  }
}

/** A debounced watch on one agent dir's auth.json, shared by every holder. */
interface AuthFileWatch {
  watcher: FileWatcher;
  holders: number;
  debounce: NodeJS.Timeout | null;
  /** Each provider's entry digest as the account state was last published from it; undefined while that is not known. */
  published: Map<string, string> | undefined;
}

/** Each provider's auth.json entry as a SHA-256 digest, so no token is kept; undefined while the file cannot be parsed. */
function authEntryDigests(agentDir: string): Map<string, string> | undefined {
  let file: Record<string, unknown> | undefined;
  try {
    file = readAuthFile(agentDir, { lastGood: false });
  } catch {
    return undefined;
  }
  return new Map(Object.entries(file ?? {}).map(([provider, entry]) => [provider, createHash('sha256').update(JSON.stringify(entry)).digest('hex')]));
}

/** The OpenAI key secret as a digest, absence included, so a change of it is seen without keeping the key. */
function keySecretDigest(key: string | undefined): string {
  return key === undefined || key === '' ? 'absent' : createHash('sha256').update(key).digest('hex');
}

/** Sub-calls slower than this are logged even when they succeed. */
const SLOW_SUB_CALL_MS = 10_000;
const usageThresholdListeners = new Set<(crossing: UsageThresholdCrossing) => void>();

/** An `AuthInteraction` that non-interactively answers every prompt with a fixed key — used to drive
 *  `ModelRuntime.login(provider, 'api_key', …)` from a key the user already supplied out-of-band. */
function keyInteraction(key: string): AuthInteraction {
  return { prompt: async () => key, notify: () => {} };
}

/** Why a daemon's core changes no sign-in, key or billing bucket: they are the client's and change only there. */
export function remoteSignInRefusal(): LocalizedText {
  return l('Sign-ins change only in the User tab on your computer.');
}

/** One classifier request. Untrusted text (memories, prompts) goes only in `state`; `questions` are built from
 *  constants in code, the same data-position rule `runStructuredCompletion` keeps. */
export interface ClassificationRequest {
  state: JsonObject;
  questions: Record<string, ClassifierQuestion>;
  purpose: Extract<SubCallPurpose, 'memory-merge' | 'memory-rerank'>;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}

interface HotReloadResult {
  /** Provider name to the path of the extension whose registration succeeded. */
  registered: ReadonlyMap<string, string>;
  errors: readonly ExtensionLoadError[];
}

/** Every MCP manager, user or folder, gets the same OAuth wiring; elicitation is routed inside the manager. */
function newMcpManager(options: {
  clientVersion: string;
  shellPath: () => string | undefined;
  reservedToolNames?: () => ReadonlySet<string>;
}): McpClientManager {
  return new McpClientManager({
    clientVersion: options.clientVersion,
    shellPath: options.shellPath,
    authProviderFactoryBuilder: createMcpAuthProviderFactory,
    ...(options.reservedToolNames ? { reservedToolNames: options.reservedToolNames } : {}),
  });
}

/**
 * Workspace and global state key: renamed-tool notice entries already shown, `Record<location, entry[]>`, each
 * entry `JSON.stringify([rule, replacement])`, or the bare rule as earlier builds remembered it.
 */
const MCP_RENAMED_RULE_NOTICES_KEY = 'damocles.mcp.renamedToolRuleNotices';
/** Workspace and global state key: rules the migration added beside a rule, `Record<file, addition[]>`. */
const MCP_APPLIED_RULE_ADDITIONS_KEY = 'damocles.mcp.appliedRuleAdditions';

type StateMemento = Platform['state']['workspace'];

function readLocations(memento: StateMemento, stateKey: string): Record<string, string[]> {
  const raw = memento.get<unknown>(stateKey, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, string[]>) : {};
}

function isInFolder(folder: string, file: string): boolean {
  const relative = path.relative(folderKey(folder), folderKey(file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * An entry is remembered per workspace when its location is the workspace's own (a file inside the folder, the
 * workspace's setting) or its replacement holds only in this folder; any other globally, since it reads the same
 * in every workspace. A bare-rule entry counts as shown in the state it was written to, and is replaced by the
 * content it stands for the next time the migration finds that rule.
 */
export function renamedRuleNoticeMemory(state: Platform['state'], folder: string): NoticeMemory {
  const stateFor = (location: McpRenamedToolRuleLocation, entry: RenamedRuleNoticeEntry): StateMemento => {
    const workspaceOwned = 'path' in location ? isInFolder(folder, location.path) : location.scope !== 'user';
    return workspaceOwned || entry.perFolder ? state.workspace : state.global;
  };
  const content = (entry: RenamedRuleNoticeEntry): string => JSON.stringify([entry.old, entry.new]);
  return {
    has: (location, entry) => {
      const known = readLocations(stateFor(location, entry), MCP_RENAMED_RULE_NOTICES_KEY)[renamedRuleNoticeKey(location)];
      return Array.isArray(known) && (known.includes(content(entry)) || known.includes(entry.old));
    },
    add: async (location, entries) => {
      const key = renamedRuleNoticeKey(location);
      for (const memento of new Set(entries.map((entry) => stateFor(location, entry)))) {
        const mine = entries.filter((entry) => stateFor(location, entry) === memento);
        const all = readLocations(memento, MCP_RENAMED_RULE_NOTICES_KEY);
        const known = Array.isArray(all[key]) ? all[key] : [];
        const bare = new Set(mine.map((entry) => entry.old));
        const next = [...new Set([...known.filter((entry) => !bare.has(entry)), ...mine.map(content)])];
        if (next.length === known.length && next.every((entry, index) => entry === known[index])) continue;
        await memento.update(MCP_RENAMED_RULE_NOTICES_KEY, { ...all, [key]: next });
      }
    },
  };
}

/** Rules added beside a rule of an owned file: per workspace for a file inside the folder, globally for a home file. */
export function appliedRuleAdditionMemory(state: Platform['state'], folder: string): AdditionMemory {
  const stateFor = (file: string): StateMemento => (isInFolder(folder, file) ? state.workspace : state.global);
  return {
    has: (file, addition) => {
      const known = readLocations(stateFor(file), MCP_APPLIED_RULE_ADDITIONS_KEY)[file];
      return Array.isArray(known) && known.includes(addition);
    },
    add: async (file, additions) => {
      const memento = stateFor(file);
      const all = readLocations(memento, MCP_APPLIED_RULE_ADDITIONS_KEY);
      const known = Array.isArray(all[file]) ? all[file] : [];
      await memento.update(MCP_APPLIED_RULE_ADDITIONS_KEY, { ...all, [file]: [...new Set([...known, ...additions])] });
    },
  };
}

function packageSourceString(pkg: PackageSource): string {
  return typeof pkg === 'string' ? pkg : pkg.source;
}

function namesCurrentRepo(source: string): boolean {
  const kind = classifySubscriptionSource(source);
  return kind === 'current' || kind === 'stale';
}

function isInsideDir(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

type PiSettingsError = ReturnType<SettingsManager['drainErrors']>[number];

/** A settings error's code or name, never its message, which for a parse error can quote the file's text. */
function settingsErrorName(error: Error): string {
  return (error as NodeJS.ErrnoException).code ?? error.name;
}

/** Logs the load errors pi recorded and returns the user settings file's (its global scope). */
function userSettingsLoadError(errors: readonly PiSettingsError[]): PiSettingsError | null {
  for (const err of errors) log('[PiRuntime] pi could not load the %s settings file %s (%s)', err.scope, err.path ?? '', settingsErrorName(err.error));
  return errors.find((e) => e.scope === 'global') ?? null;
}

/**
 * The live rename/tag surface a panel registers for its open session, so a mutation initiated from any
 * panel routes to the owning panel's live SessionManager rather than a second file-writer that would
 * fork the branch and drop messages (US-012). The session list also reads a live session's metadata
 * from it rather than re-parsing the file. Satisfied structurally by `PiSession`.
 */
export interface LiveSessionMutator extends LiveSessionMetaSource {
  renameActiveSession(newName: string): Promise<void>;
  setActiveSessionTag(tag: string | null): Promise<void>;
  /**
   * Synchronous, so a caller's liveness check and the write share one tick. False, logged, when it writes nothing:
   * `sessionId` is no longer bound there, its lease was lost, or it already has a name.
   */
  applyAiTitle(sessionId: string, title: string): boolean;
  /** Stop writing to the session because its file is being deleted; rejects if the panel could not
   *  let go, which must abort the delete rather than orphan a live writer on a removed path. */
  detachFromDeletedSession(): Promise<void>;
  publishAccountInfo(): void;
}

/**
 * The one answer to "what do merge and rerank run on" (`damocles.memory.judge*`). `fallback` is the model a
 * classifier judge hands an undecided or failed question to: Automatic's small model, none for a chosen classifier.
 */
export type MemoryJudgeResolution =
  | { kind: 'classifier'; ref: ClassifierModelRef; model: ClassifierModel<ClassifierApi>; fallback: SubCallModel | null }
  | { kind: 'model'; model: Model<Api>; effort?: EffortLevel }
  | { kind: 'none'; forced?: { choice: string; reason: MemoryJudgeUnavailable } };

/**
 * The single per-process owner of pi's runtime (blocker B1).
 *
 * pi's API/OAuth provider registries are module-level process-global singletons, and one Node process
 * hosts every VS Code extension and may host several Damocles windows/sessions, so exactly one
 * `ModelRuntime` must own provider registration and auth. Every workspace folder a panel targets gets a
 * `FolderRuntime` (its own loader, context files, skills, hooks) built on that shared `ModelRuntime`.
 *
 * Subscription auth is owned by pi: `signInSubscription` drives pi's native OAuth login and pi
 * refreshes the grant; the subscription plugin only selects the billing bucket.
 */
export class PiRuntime {
  private static _instance: PiRuntime | null = null;
  private static _retired = false;

  private _initPromise: Promise<void> | null = null;
  private readonly _agentDir: string;
  private _modelRuntime: ModelRuntime | null = null;
  /** `modelRuntimeReady()` callers waiting for init to create the model runtime. */
  private readonly _modelRuntimeWaiters = new Set<(models: ModelRuntime) => void>();
  /** User-scope settings for package operations; the subscription plugin is only ever listed there. */
  private _userSettings: SettingsManager | null = null;
  /** The error pi recorded at its latest load of the user settings file, which it writes nothing to while set. */
  private _userSettingsLoadError: PiSettingsError | null = null;
  /** Creation promises by folder key, so concurrent `folder()` calls share one creation. */
  private readonly _folderPromises = new Map<string, Promise<FolderRuntime>>();
  /** Folder runtimes whose creation (including its subscription check) has finished. */
  private readonly _folders = new Map<string, FolderRuntime>();
  /** Folder creation flushes provider registrations into the shared `ModelRuntime`, and subscription
   *  operations unregister and re-register them, so all of them run one at a time on this chain. */
  private _providerSync: Promise<void> = Promise.resolve();
  /** Subscription switches run one at a time, download included, so they apply in request order and
   *  never write the clone dir concurrently: pi's `installGit` has no lock of its own. */
  private _subscriptionSync: Promise<void> = Promise.resolve();
  /** The startup subscription repair runs once, when the first folder runtime has a loader to check. */
  private _pinReconciled = false;
  /** Per-session live rename/tag mutator, keyed by pi sessionId — lets a rename/tag from ANY panel
   *  route to the panel that owns the session (cross-panel anti-fork; US-012). */
  private readonly _sessionMutators = new Map<string, LiveSessionMutator>();
  /** The one manager for user-scope MCP servers, created in `init()`; every folder's view reads it. */
  private _userMcp: McpClientManager | null = null;
  /** Watchers on the user-scope skill/command roots and the global instructions file. */
  private readonly _userWatchers: FileWatcher[] = [];
  private _userDebounce: NodeJS.Timeout | null = null;
  /** This runtime's hold on the shared auth.json watch; set once init has applied the OpenAI key, so changes route here. */
  private _authWatch: Disposable | null = null;
  /** The auth.json entries an own change of this process is writing (`ownAuthFileChange`), each with the count of such changes running. */
  private readonly _authEntriesOwned = new Map<string, number>();
  /** A daemon's core's credential store; null on this computer's core, which reads auth.json. */
  private _broker: BrokeredCredentialStore | null = null;
  /** OpenAI credential changes, the key migration and every runtime-key sync run one at a time on this
   *  chain, so a sync reads the state it applies and no sign-in lands between the migration's check and delete. */
  private _openaiCredentialSync: Promise<void> = Promise.resolve();
  /** ChatGPT sign-ins queued or running on `_openaiCredentialSync`, each holding it until the user ends its flow. */
  private _openaiSignInsPending = 0;
  /** Whether the OpenAI key secret is present: read at construction and on every secret change, so status stays synchronous. */
  private _openaiKeyPresent = false;
  /** The key secret as the runtime last read it (`keySecretDigest`), the record every account publication read; null before a read succeeded. */
  private _openaiKeyRead: string | null = null;
  /** Whether `getOpenAIAuthStatus` reflects the key secret: set once a read of it succeeded or init's first key sync has run. */
  private _openaiStatusReady = false;
  /** The record holds the construction read's value, which no publication followed: a secret change it already caught is still its event's to publish. */
  private _openaiKeyReadUnpublished = false;
  /** This computer's core: the runtime's first read of the key secret, until it settled; an account publication waits for it. */
  private _openaiKeyRecording: Promise<void> | null = null;
  /** This computer's core: hears the OpenAI key secret from construction, so the record never misses a change. */
  private _openaiKeyListener: Disposable | null = null;
  /** The prefer-API-key value the last runtime key sync applied; null before the first. */
  private _appliedPreferApiKey: boolean | null = null;
  private _preferResyncPending = false;
  /** This process's own writes of the OpenAI prefer flag running, each publishing its own sync. */
  private _openaiPreferWrites = 0;
  /** Key providers whose prefer flag this process is writing, each with the count of such writes running; that write's own sync applies it. */
  private readonly _providerPreferWrites = new Map<KeyProviderId, number>();
  /** Each key provider's prefer-API-key value the last custom-provider sync applied; absent before the first. */
  private readonly _appliedProviderPrefer = new Map<KeyProviderId, boolean>();
  /** Whether each key provider's key is saved, from the last custom-provider sync that read its secret; absent before. */
  private readonly _providerKeySaved = new Map<KeyProviderId, boolean>();
  /** Key providers whose pi sign-in is running; the custom-provider sync leaves them alone until it ends. */
  private readonly _signingIn = new Set<SignInProviderId>();
  /** Each provider's plan model ids from auth.json's last read; null until read, and cleared when auth.json or a sign-in changes. */
  private _planModels: ReadonlyMap<string, ReadonlySet<string>> | null = null;
  private _providerPreferResyncPending = false;
  /** The custom-provider sync running now; syncs never overlap, since each decides from inputs read before its awaits. */
  private _customProviderSyncRun: Promise<CustomProviderSyncOutcome> | null = null;
  /** The one sync queued behind the running one, which every call made meanwhile shares; it reads with the newest call's resolver. */
  private _customProviderSyncFollowUp: { getSecret: SecretResolver; outcome: Promise<CustomProviderSyncOutcome> } | null = null;
  private _secretsListener: Disposable | null = null;
  /** A daemon's core: a new acting client refreshes pi's availability snapshot. */
  private _clientsListener: Disposable | null = null;
  /** The availability refreshes client changes started, each until it settled (`clientSnapshotSettling`). */
  private readonly _clientRefreshes = new Set<Promise<void>>();
  private _clientSnapshotSettled: Promise<void> | null = null;
  /** Bumped by each acting client change, so only the latest one's refresh republishes. */
  private _actingChanges = 0;
  /** A daemon's core: the bundled subscription plugin did not load, so an allowance client's Claude requests bill extra usage. */
  private _allowanceUnavailable = false;
  /** Granting trust admits a folder's project layer, which needs a reload to reach its loader. */
  private _trustListener: Disposable | null = null;
  /** `damocles.imageGeneration.*` decides whether GenerateImage is eligible. */
  private _imageSettingsListener: Disposable | null = null;
  /** `damocles.mcp.toolExposure` decides which MCP tools are eligible, active and on the ToolSearch menu. */
  private _toolExposureListener: Disposable | null = null;
  /** `damocles.mcp.resourceExposure` decides which servers the resource tools reach and whether they are Always loaded. */
  private _resourceExposureListener: Disposable | null = null;
  /** Logs the `damocles.tools.disabled` entries that can turn nothing off, at init and on each change. */
  private _disabledToolsListener: Disposable | null = null;
  /** `damocles.assetSourcePrecedence` orders every loader's `.claude` and `.codex` roots. */
  private _assetPrecedenceListener: Disposable | null = null;
  /** Set once a custom-provider sync has applied the stored keys, which `hasConfiguredAuth` reads. */
  private _customProvidersSynced = false;
  /** A sign-in or sign-out changed the account state; the next custom-provider sync's end publishes it with its own changes. */
  private _accountChangeUnpublished = false;
  /** Read once from the host-installed accessor: this process singleton has no owner to inject it. */
  private readonly _platform: Platform;
  /** Cancels an in-flight custom-provider credential sync on dispose, so a closing window does not
   *  leave a credential operation running against the shared `auth.json` lock. */
  private readonly _syncAbort = new AbortController();
  /** The running OpenRouter catalog refresh, aborted when the key changes or is removed. */
  private _openRouterCatalogAbort: AbortController | null = null;
  private readonly _classifierBreakers = createClassifierBreakers();
  private _disposed = false;
  /** The subscription usage refresh, its threshold crossings and the full window a rate limit names, shared by every session. */
  readonly usage: UsageMonitor = new UsageMonitor({
    fetchUsage: () => fetchSubscriptionUsage(this),
    now: () => Date.now(),
    onCrossing: (crossing) => {
      if (this._disposed) return;
      for (const listener of [...usageThresholdListeners]) {
        try {
          listener(crossing);
        } catch (err) {
          log('[PiRuntime] usage threshold listener failed: %O', err);
        }
      }
    },
  });

  private constructor(agentDir: string) {
    if (PiRuntime._instance) {
      throw new Error('PiRuntime already constructed — there must be exactly one per process (B1)');
    }
    this._agentDir = agentDir;
    this._platform = platform();
    this._classifierBreakers.onChange(() => notifyMemoryJudgeListeners());
    this._clientsListener = this._platform.remote ? this._watchClients(this._platform.remote) : null;
    // a daemon's core never reads the secret: its key presence is each client's clientAuth
    if (!this._platform.remote) {
      // heard before the first read is queued, so a change after that read always reaches `_openaiKeySecretChanged`
      this._openaiKeyListener = this._platform.secrets.onDidChange((key) => {
        if (key === OPENAI_API_KEY_SECRET) void this._openaiKeySecretChanged();
      });
      const recording = this._withOpenAICredentialSync(() => this._recordOpenAIKeySecret());
      this._openaiKeyRecording = recording;
      void recording.finally(() => {
        this._openaiKeyRecording = null;
      });
    }
  }

  /** Get (lazily creating) the process-wide PiRuntime singleton. */
  static get(agentDir: string = PI_AGENT_DIR): PiRuntime {
    if (!PiRuntime._instance) {
      PiRuntime._instance = new PiRuntime(agentDir);
      PiRuntime._retired = false;
    }
    return PiRuntime._instance;
  }

  /**
   * The singleton, created if needed, or null once `disposeInstance` retired it and nothing has created
   * one since. For work that may run late at shutdown, where a new runtime's watchers would outlive it.
   */
  static unlessRetired(): PiRuntime | null {
    return PiRuntime._retired ? null : PiRuntime.get();
  }

  /** Whether the singleton has been created. */
  static get exists(): boolean {
    return PiRuntime._instance !== null;
  }

  /** Whether the runtime hears secret changes itself (from init until dispose), so a classifier key change reaches the judge status through its sync. */
  static get observesSecrets(): boolean {
    return PiRuntime._instance?._secretsListener != null;
  }

  /** This computer's core: whether the runtime hears the OpenAI key secret itself (from construction until dispose), so it publishes each change. */
  static get observesOpenAIKey(): boolean {
    return PiRuntime._instance?._openaiKeyListener != null;
  }

  /** A daemon's core: whether the runtime hears acting client changes itself (from construction until dispose), so it republishes each one. */
  static get observesActingClient(): boolean {
    return PiRuntime._instance?._clientsListener != null;
  }

  /**
   * A daemon's core: whether the runtime hears clientAuth changes itself (its broker, from init until dispose), so `credentialsChanged`
   * publishes each one that changes a provider, through its key sync or, while init has not succeeded, through the auth-file listeners.
   */
  static get observesClientAuth(): boolean {
    return PiRuntime._instance?._broker != null;
  }

  /** One watch per watcher factory and agent dir, so the pre-runtime holder and the runtime never watch auth.json twice. */
  private static readonly _authFileWatches = new WeakMap<FileWatcherFactory, Map<string, AuthFileWatch>>();

  /**
   * Watch auth.json from activation, before any runtime exists. A sign-in in another app or the pi CLI lands only
   * there: until the runtime has taken the watch over, a change notifies judge and auth-file listeners directly.
   * Does not create the singleton.
   */
  static watchAuthFile(): Disposable {
    // a daemon's core reads account state from its clients' clientAuth, never its host's auth.json
    if (platform().remote) return { dispose: () => undefined };
    return PiRuntime._holdAuthFileWatch(platform().fileWatchers, PI_AGENT_DIR);
  }

  private static _holdAuthFileWatch(factory: FileWatcherFactory, agentDir: string): Disposable {
    let byDir = PiRuntime._authFileWatches.get(factory);
    if (!byDir) {
      byDir = new Map();
      PiRuntime._authFileWatches.set(factory, byDir);
    }
    const watches = byDir;
    let watch = watches.get(agentDir);
    if (!watch) {
      const watcher = factory.watch(agentDir, 'auth.json');
      // read once the watch runs, so a write after this read always reaches the comparison as an event
      const created: AuthFileWatch = { watcher, holders: 0, debounce: null, published: authEntryDigests(agentDir) };
      const onChange = (): void => {
        if (created.debounce) clearTimeout(created.debounce);
        created.debounce = setTimeout(() => {
          created.debounce = null;
          PiRuntime._authFileChanged(created, agentDir);
        }, AUTH_REPUBLISH_DEBOUNCE_MS);
      };
      created.watcher.onDidCreate(onChange);
      created.watcher.onDidChange(onChange);
      created.watcher.onDidDelete(onChange);
      watches.set(agentDir, created);
      watch = created;
    }
    const held = watch;
    held.holders++;
    let released = false;
    return {
      dispose: () => {
        if (released) return;
        released = true;
        if (--held.holders > 0) return;
        if (held.debounce) clearTimeout(held.debounce);
        held.watcher.dispose();
        watches.delete(agentDir);
      },
    };
  }

  /**
   * Reacts to a change of state, never to the event: an entry the account state was already published from, or one this
   * process's own change holds (`ownAuthFileChange`), whose flow publishes it, changes nothing here.
   */
  private static _authFileChanged(watch: AuthFileWatch, agentDir: string): void {
    const runtime = PiRuntime._instance?._agentDir === agentDir ? PiRuntime._instance : null;
    if (runtime) runtime._planModels = null;
    if (!PiRuntime._takeUnpublishedEntries(watch, agentDir, runtime?._authEntriesOwned)) return;
    if (runtime?._authWatch) {
      void runtime._applyAuthFileChange();
      return;
    }
    notifyUnsyncedAccountChange();
  }

  /** Whether auth.json holds an entry no publication has read, outside `owned`; marks every entry outside `owned` published. An unreadable file counts as one. */
  private static _takeUnpublishedEntries(watch: AuthFileWatch, agentDir: string, owned: ReadonlyMap<string, number> | undefined): boolean {
    const current = authEntryDigests(agentDir);
    const published = watch.published;
    if (current === undefined) {
      watch.published = undefined;
      return true;
    }
    let unpublished = published === undefined;
    const next = new Map<string, string>();
    for (const provider of new Set([...current.keys(), ...(published?.keys() ?? [])])) {
      const held = (owned?.get(provider) ?? 0) > 0;
      const digest = held ? published?.get(provider) : current.get(provider);
      if (digest !== undefined) next.set(provider, digest);
      if (!held && published?.get(provider) !== current.get(provider)) unpublished = true;
    }
    watch.published = next;
    return unpublished;
  }

  /**
   * Fires after auth.json changed in a way no flow of this process publishes (another app, the pi CLI, pi's own token refresh),
   * or on a daemon's core a clientAuth delta the broker observed, once the account state was republished. Subscribing does
   * not create the singleton.
   */
  static onAuthFileChange(listener: (keySynced: boolean) => void): () => void {
    authFileListeners.add(listener);
    return () => {
      authFileListeners.delete(listener);
    };
  }

  /**
   * Fires once the runtime published the sessions it holds and the judge status for an OpenAI credential change no Settings
   * handler publishes: another window's write of the key secret or of the prefer flag, or init's move of an auth.json key into
   * the secret. Subscribing does not create the singleton.
   */
  static onOpenAICredentialChange(listener: () => void): () => void {
    openaiCredentialListeners.add(listener);
    return () => {
      openaiCredentialListeners.delete(listener);
    };
  }

  /**
   * A daemon's core: fires once pi's availability snapshot holds the acting client's credentials after the acting client
   * changed, only for the latest change, which is when its account state is republished. Subscribing does not create the singleton.
   */
  static onActingClientRefreshed(listener: () => void): () => void {
    actingClientListeners.add(listener);
    return () => {
      actingClientListeners.delete(listener);
    };
  }

  /** Fires whenever an input of `clientAuthSnapshot()` may have changed. Subscribing does not create the singleton. */
  static onClientAuthChange(listener: () => void): () => void {
    clientAuthListeners.add(listener);
    return () => {
      clientAuthListeners.delete(listener);
    };
  }

  /** Fires when a subscription usage window crosses a threshold. Subscribing does not create the singleton. */
  static onUsageThreshold(listener: (crossing: UsageThresholdCrossing) => void): () => void {
    usageThresholdListeners.add(listener);
    return () => {
      usageThresholdListeners.delete(listener);
    };
  }

  /** Fires when a runtime input of `describeMemoryJudge()` may have changed; the judge settings' listener is the panels' own. Subscribing does not create the singleton. */
  static onMemoryJudgeChange(listener: (clientId?: string) => void): () => void {
    memoryJudgeListeners.add(listener);
    return () => {
      memoryJudgeListeners.delete(listener);
    };
  }

  /**
   * Fires after every key-provider sync that ran, failed ones included, once the folders' tools reflect it; a call before
   * init or after dispose runs none. Subscribing does not create the singleton.
   */
  static onCustomProvidersSynced(listener: (sync: CustomProvidersSynced) => void): () => void {
    customProvidersSyncedListeners.add(listener);
    return () => {
      customProvidersSyncedListeners.delete(listener);
    };
  }

  /** For judge inputs that change outside the runtime: a Claude or OpenAI credential change republishes the account. */
  static notifyMemoryJudgeChange(clientId?: string): void {
    notifyClientAuthListeners();
    notifyMemoryJudgeListeners(clientId);
  }

  /** Tear down and clear the singleton (extension deactivation and tests). */
  static async disposeInstance(): Promise<void> {
    PiRuntime._retired = true;
    if (PiRuntime._instance) {
      await PiRuntime._instance.dispose();
      PiRuntime._instance = null;
    }
  }

  get agentDir(): string {
    return this._agentDir;
  }

  /** The model runtime every folder shares, or `null` before `init()` resolves. */
  get modelRuntime(): ModelRuntime | null {
    return this._modelRuntime;
  }

  /** The model runtime as resolution reads it, with each provider's plan from its stored sign-in; `null` before `init()` resolves. */
  get modelLookup(): ModelLookup | null {
    const runtime = this._modelRuntime;
    if (!runtime) return null;
    return {
      getModel: (provider, modelId) => runtime.getModel(provider, modelId),
      hasConfiguredAuth: (provider) => runtime.hasConfiguredAuth(provider),
      planModelIds: (provider) => this.planModelIds(provider),
    };
  }

  /**
   * The model ids a provider's stored sign-in lists for the user's plan (`availableModelIds`), never pi's available list,
   * which pi's getModel and setModel ignore. Empty, and not cached, while auth.json cannot be read. A daemon's core reads
   * the pinned (else acting) client's clientAuth.
   */
  planModelIds(provider: string): ReadonlySet<string> | undefined {
    if (this._platform.remote) return planModelsOf(readProviderSignIns(this._agentDir)).get(provider);
    // pi's login may write a new list at any point before it returns, so that provider's reads bypass the cache meanwhile.
    const signingIn = (this._signingIn as ReadonlySet<string>).has(provider);
    if (this._planModels && !signingIn) return this._planModels.get(provider);
    const signIns = readProviderSignIns(this._agentDir);
    if (signIns === undefined) return NO_PLAN_MODELS;
    const plans = planModelsOf(signIns);
    if (!signingIn) this._planModels = plans;
    return plans.get(provider);
  }

  /**
   * The model registry as soon as `init()` has built it from local files, without waiting for init's
   * credential sync, which can sit behind pi's cross-process auth lock. Starts init when it has not
   * started; null when init fails or the runtime is disposed.
   */
  modelRuntimeReady(): Promise<ModelRuntime | null> {
    if (this._modelRuntime) return Promise.resolve(this._modelRuntime);
    return new Promise((resolve) => {
      this._modelRuntimeWaiters.add(resolve);
      this.init().then(
        () => resolve(this._modelRuntime),
        () => resolve(null),
      ).finally(() => this._modelRuntimeWaiters.delete(resolve));
    });
  }

  /** Register/replace the live mutator for a panel's pi session (called on start + rebind). A panel
   *  that holds the session only as a not-yet-started resume or fork target has no entry here, so a
   *  caller that must reach every holder has to union this with that panel's session, and a file write
   *  outside a panel refuses while one holds it (`isSessionHeldByPanelHere`). */
  registerSessionMutator(sessionId: string, mutator: LiveSessionMutator): void {
    if (sessionId) this._sessionMutators.set(sessionId, mutator);
  }

  /** Drop a session's live mutator (on session rebind for the old id, and on dispose), only if it is
   *  still `mutator`. */
  unregisterSessionMutator(sessionId: string, mutator: LiveSessionMutator): void {
    if (sessionId && this._sessionMutators.get(sessionId) === mutator) this._sessionMutators.delete(sessionId);
  }

  /** The live mutator for a session currently open in some panel, or undefined if none. */
  getSessionMutator(sessionId: string): LiveSessionMutator | undefined {
    return this._sessionMutators.get(sessionId);
  }

  /**
   * A configured hook's `sessionTitle` rename of `sessionId`: through its live holder, else in its stored file under
   * its lease, as the session list's rename. Rejects when the lease refuses the write.
   */
  async renameSession(sessionId: string, cwd: string, newName: string): Promise<void> {
    const mutator = this.getSessionMutator(sessionId);
    if (mutator) return mutator.renameActiveSession(newName);
    const refusal = await writeUnderSessionLease(sessionId, () => renamePiSession(cwd, sessionId, newName));
    if (refusal) throw new Error(`Session ${sessionId} was not renamed: its lease refused the write (${refusal.kind})`);
  }

  /** `getSessionMutator` without creating the runtime, which never exists before a panel has started pi. */
  static liveSessionMutator(sessionId: string): LiveSessionMutator | undefined {
    return PiRuntime._instance?.getSessionMutator(sessionId);
  }

  /** The user-scope MCP manager, or null before `init()`. Panels read tools through their folder's view instead. */
  getUserMcp(): McpClientManager | null {
    return this._userMcp;
  }

  /** Every folder runtime whose creation has finished. */
  folders(): FolderRuntime[] {
    return [...this._folders.values()];
  }

  /**
   * The folder runtime for `cwd`, created on first request. `cwd` is kept raw, since session dirs and
   * hook payloads use that exact string; the map key is its `folderKey`.
   */
  folder(cwd: string): Promise<FolderRuntime> {
    if (this._disposed) return Promise.reject(new Error('PiRuntime has been disposed'));
    const key = folderKey(cwd);
    const existing = this._folderPromises.get(key);
    if (existing) return existing;
    const created: Promise<FolderRuntime> = this.init().then(() =>
      this._withProviderSync(() =>
        timed('folderRuntime.create', () => this._createFolder(cwd, () => this._folderPromises.get(key) === created)),
      ),
    );
    this._folderPromises.set(key, created);
    // A failed creation must not stick, so a later request retries; its caller still sees the rejection.
    created.catch(() => {
      if (this._folderPromises.get(key) === created) this._folderPromises.delete(key);
    });
    return created;
  }

  /** Dispose the folder runtime for `key` (its folder left the workspace). Waits out an in-flight creation. */
  async disposeFolder(key: string): Promise<void> {
    const pending = this._folderPromises.get(key);
    if (!pending) return;
    this._folderPromises.delete(key);
    this._folders.delete(key);
    let folder: FolderRuntime;
    try {
      folder = await pending;
    } catch {
      // The creation failure already surfaced to its own caller, and there is nothing to dispose.
      return;
    }
    await folder.dispose();
  }

  private _withProviderSync<T>(op: () => Promise<T>): Promise<T> {
    const run = this._providerSync.then(op);
    // Kept alive past a failure so one rejected operation cannot block every later one; the caller still
    // sees the rejection through `run`.
    this._providerSync = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private _withSubscriptionSync<T>(op: () => Promise<T>): Promise<T> {
    const run = this._subscriptionSync.then(op);
    this._subscriptionSync = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private _withOpenAICredentialSync<T>(op: () => Promise<T>): Promise<T> {
    const run = this._openaiCredentialSync.then(op);
    this._openaiCredentialSync = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Build a folder's services on the shared `ModelRuntime`, then check the subscription plugin against
   * its loader before anyone can start a session on it. Runs on `_providerSync`.
   */
  private async _createFolder(cwd: string, isCurrent: () => boolean): Promise<FolderRuntime> {
    if (this._disposed) throw new Error('PiRuntime has been disposed');
    const pi = getPiCodingAgent();
    if (!pi || !this._modelRuntime || !this._userMcp) throw new Error('PiRuntime.folder: runtime not initialized');
    const folder = new FolderRuntime({
      pi,
      cwd,
      agentDir: this._agentDir,
      modelRuntime: this._modelRuntime,
      planModelIds: (provider) => this.planModelIds(provider),
      userMcp: this._userMcp,
      createFolderMcp: (reservedToolNames, shellPath) =>
        newMcpManager({ clientVersion: this._platform.appInfo.version, shellPath, reservedToolNames }),
      noticeMemory: renamedRuleNoticeMemory(this._platform.state, cwd),
      additionMemory: appliedRuleAdditionMemory(this._platform.state, cwd),
      projectDisabledTools: () => this.projectDisabledToolList(),
      personalDisabledTools: (trusted) => this.personalDisabledToolLists(trusted ? ['user', 'local'] : ['user']),
      toolExposureSetting: () => this._platform.settings.inspect<unknown>(MCP_TOOL_EXPOSURE_SETTING),
      resourceExposureSetting: () => this._platform.settings.inspect<unknown>(MCP_RESOURCE_EXPOSURE_SETTING),
      trust: this._platform.trust,
      fileWatchers: this._platform.fileWatchers,
    });
    try {
      await folder.createServices();
    } catch (err) {
      await folder.dispose();
      throw err;
    }
    // A window closing mid-creation disposes every folder it finds; stop before touching the plugin.
    if (this._disposed) return folder;
    const folders = [...this.folders(), folder];
    // a daemon's core bills by its bundled plugin and never touches the host's pi packages
    const local = !this._platform.remote;
    if (local && !this._pinReconciled) {
      this._pinReconciled = true;
      await this._reconcileSubscriptionPin(pi, folders, folder);
    } else if (local) {
      await this._unlistFailedPluginLoad(pi, folders, folder);
    }
    // A trust grant during creation reached only the folders already published.
    const settings = folder.services.settingsManager;
    if (this._platform.trust.isTrusted(folder.cwd) && !settings.isProjectTrusted()) {
      settings.setProjectTrusted(true);
      await folder.reloadBare().catch((err) => log('[PiRuntime] trust-grant reload failed (%s): %O', folder.cwd, err));
    }
    // A folder removed mid-creation stays out of the map; `disposeFolder` disposes it once this resolves.
    if (isCurrent()) {
      this._folders.set(folder.key, folder);
      notifyMemoryJudgeListeners();
    }
    return folder;
  }

  /**
   * Watch the user-scope skill + command roots and the user-global instructions file
   * (`~/.damocles/AGENTS.md` and its siblings), and reload every folder's loader when they change: each
   * loader carries the user dirs and re-runs the context-file override on reload. A full reload, not
   * `extendResources`, because only a reload can drop a deleted resource.
   *
   * The user dirs sit outside every workspace folder, and a workspace glob reports no event from
   * there. Anchoring the watcher on the dir itself is what makes these fire.
   */
  private _setupUserWatchers(): void {
    for (const watcher of this._userWatchers.splice(0)) watcher.dispose();
    const onChange = () => this._scheduleFolderReloads();
    for (const source of assetSources()) {
      for (const sub of [source.skills, source.commands]) {
        this._userWatchers.push(this._platform.fileWatchers.watch(path.join(os.homedir(), sub), '**'));
      }
    }
    this._userWatchers.push(
      this._platform.fileWatchers.watch(path.join(os.homedir(), '.damocles'), `{${CONTEXT_FILE_CANDIDATES.join(',')}}`),
    );
    for (const watcher of this._userWatchers) {
      watcher.onDidCreate(onChange);
      watcher.onDidChange(onChange);
      watcher.onDidDelete(onChange);
    }
  }

  /** Reloads every folder's loader once a burst of user asset or precedence changes settles. */
  private _scheduleFolderReloads(): void {
    if (this._userDebounce) clearTimeout(this._userDebounce);
    this._userDebounce = setTimeout(() => {
      for (const folder of this.folders()) {
        folder.reloadBare().catch((err) => log('[PiRuntime] user asset reload failed (%s): %O', folder.cwd, err));
      }
    }, 300);
  }

  /**
   * Re-sync the OpenAI and key-provider runtime keys and republish every live session's account state when auth.json
   * changes: a login or logout in another Damocles app or a pi CLI, or a token refresh anywhere, lands
   * only in that file.
   */
  private _setupAuthWatcher(): void {
    if (this._platform.remote) return;
    this._authWatch?.dispose();
    this._authWatch = PiRuntime._holdAuthFileWatch(this._platform.fileWatchers, this._agentDir);
  }

  /**
   * A login, logout or token refresh outside this process. pi's stored-credential snapshot, which `getProviderAuthStatus`
   * and both key syncs read, follows auth.json only after an offline availability refresh, so that runs first.
   */
  private async _applyAuthFileChange(): Promise<void> {
    const modelRuntime = this._modelRuntime;
    if (modelRuntime) {
      try {
        await modelRuntime.getAvailable();
      } catch (err) {
        log('[PiRuntime] availability refresh after an auth.json change failed: %s', describeAuthError(err));
      }
    }
    if (this._disposed) return;
    await this._resyncOpenAI('auth.json change');
    // a sign-in made outside Damocles need not change a key the sync applies, so its end publishes the account state regardless
    this._accountChangeUnpublished = true;
    await this.syncCustomProviders((key) => this._platform.secrets.get(key));
    if (this._disposed) return;
    notifyAuthFileListeners(true);
  }

  /**
   * Runs `op`, this process's own write of `providers`' auth.json entries, whose caller publishes once it settled (a failure too when
   * `failurePublished`), so the watcher leaves those entries to that publication (docs/invariants.md "Agent auth store").
   */
  async ownAuthFileChange<T>(providers: readonly string[], failurePublished: boolean, op: () => Promise<T>): Promise<T> {
    if (this._platform.remote) return op();
    for (const provider of providers) this._authEntriesOwned.set(provider, (this._authEntriesOwned.get(provider) ?? 0) + 1);
    let succeeded = false;
    try {
      const result = await op();
      succeeded = true;
      return result;
    } finally {
      for (const provider of providers) {
        const count = (this._authEntriesOwned.get(provider) ?? 1) - 1;
        if (count > 0) this._authEntriesOwned.set(provider, count);
        else this._authEntriesOwned.delete(provider);
      }
      const watch = PiRuntime._authFileWatches.get(this._platform.fileWatchers)?.get(this._agentDir);
      if (succeeded || failurePublished) {
        // the usage plans, which the watch's handling of the write would have reset
        if (!watch || PiRuntime._markEntriesPublished(watch, this._agentDir, providers, this._authEntriesOwned)) this.usage.credentialsChanged();
      } else if (watch) {
        PiRuntime._authFileChanged(watch, this._agentDir);
      }
    }
  }

  /**
   * Records `providers`' entries before the caller's publication reads the file, so a write after this read reaches the watcher as
   * unpublished; after an unreadable read that publication reads the whole file, so every entry `owned` does not hold is recorded too.
   * Whether any of `providers`' entries differs from the one last published, unknown included.
   */
  private static _markEntriesPublished(watch: AuthFileWatch, agentDir: string, providers: readonly string[], owned: ReadonlyMap<string, number>): boolean {
    const current = authEntryDigests(agentDir);
    if (!current) {
      watch.published = undefined;
      return true;
    }
    const published = watch.published;
    if (!published) {
      watch.published = new Map([...current].filter(([provider]) => providers.includes(provider) || !owned.has(provider)));
      return true;
    }
    let changed = false;
    for (const provider of providers) {
      const digest = current.get(provider);
      if (digest !== published.get(provider)) changed = true;
      if (digest === undefined) published.delete(provider);
      else published.set(provider, digest);
    }
    return changed;
  }

  /**
   * The caller publishes after the sync, failed or not; `credentialChanged` resets the OpenAI breaker only once the sync settled
   * (docs/invariants.md "Agent auth store" and "Memory judges").
   */
  private async _resyncOpenAI(reason: string, credentialChanged = false): Promise<void> {
    this.usage.credentialsChanged();
    if (this._openaiSignInsPending > 0) this._publishAccountStateToSessions();
    try {
      // never through `syncOpenAIRuntimeKey`, whose init an event must not start
      await this._withOpenAICredentialSync(() => this._syncOpenAIRuntimeKeyNow());
    } catch (err) {
      log('[PiRuntime] OpenAI runtime key sync after %s failed: %s', reason, describeAuthError(err));
    }
    if (credentialChanged) this._openaiCredentialChanged();
  }

  /**
   * Another window's prefer flag, read here first: `_resyncOpenAI`, then the sessions' account state and the judge status, which
   * read the key rule the sync applied, and the OpenAI row and every other panel through `onOpenAICredentialChange`.
   */
  private async _resyncOpenAIAndRepublish(reason: string): Promise<void> {
    await this._resyncOpenAI(reason, true);
    if (this._disposed) return;
    this._publishAccountInfoToSessions();
    notifyOpenAICredentialListeners();
  }

  /** Whether init has succeeded, waiting for the attempt in flight; starts none, since init runs only for a caller that needs the runtime. */
  private async _initSucceeded(): Promise<boolean> {
    const init = this._initPromise;
    return init !== null && init.then(() => true, () => false);
  }

  /**
   * A daemon's core: a client's clientAuth changed, after the broker dropped its cached credentials for the changed providers.
   * The one publisher of the change once the broker exists (`observesClientAuth`): the key sync's end, or, while init has not
   * succeeded, the auth-file listeners. A credential never decides whether init succeeds, so a delta never retries it.
   */
  async credentialsChanged(): Promise<void> {
    const initialized = await this._initSucceeded();
    if (this._disposed) return;
    if (!initialized) {
      notifyUnsyncedAccountChange();
      return;
    }
    const modelRuntime = this._modelRuntime!;
    try {
      // pi's availability snapshot reads the broker's status answers again, outside any turn
      const refreshed = await this._trackClientRefresh(outsidePins(() => modelRuntime.refresh({ allowNetwork: false })));
      for (const [provider, err] of refreshed.errors) log('[PiRuntime] clientAuth refresh: provider %s failed: %s', provider, describeAuthError(err));
    } catch (err) {
      log('[PiRuntime] availability refresh after a clientAuth change failed: %s', describeAuthError(err));
    }
    if (this._disposed) return;
    await this._resyncOpenAI('a clientAuth change', true);
    // its end publishes the account state and the judge status, and its listeners every key provider's status, read from clientAuth
    this._accountChangeUnpublished = true;
    await this.syncCustomProviders((key) => this._platform.secrets.get(key));
    if (this._disposed) return;
    notifyAuthFileListeners(true);
  }

  /** Outside a run, pi's availability snapshot reads the acting client's credentials, so a new acting client refreshes it and republishes the account state. */
  private _watchClients(remote: RemoteHost): Disposable {
    return remote.clients.onDidChange((change) => {
      if (change.topic !== 'actingClient') return;
      const generation = ++this._actingChanges;
      // a refresh a newer acting change overtook holds the older client's snapshot, so it republishes nothing
      const republish = (): void => {
        if (generation !== this._actingChanges || this._disposed) return;
        notifyClientAuthListeners();
        notifyActingClientListeners();
      };
      const modelRuntime = this._modelRuntime;
      if (!modelRuntime) {
        republish();
        return;
      }
      void this._trackClientRefresh(outsidePins(() => modelRuntime.refresh({ allowNetwork: false }))).then(
        (refreshed) => {
          for (const [provider, err] of refreshed.errors) log('[PiRuntime] acting client refresh: provider %s failed: %s', provider, describeAuthError(err));
          republish();
        },
        (err: unknown) => {
          log('[PiRuntime] acting client refresh failed: %s', describeAuthError(err));
          republish();
        },
      );
    });
  }

  /** Holds the client snapshot unsettled until `refresh` settles; returns `refresh`. */
  private _trackClientRefresh<T>(refresh: Promise<T>): Promise<T> {
    const settled = refresh.then(() => undefined, () => undefined);
    this._clientRefreshes.add(settled);
    void settled.then(() => this._clientRefreshes.delete(settled));
    this._clientSnapshotSettled ??= this._settleClientRefreshes();
    return refresh;
  }

  private async _settleClientRefreshes(): Promise<void> {
    // a refresh a newer client change started meanwhile is waited for too
    while (this._clientRefreshes.size > 0) await Promise.all(this._clientRefreshes);
    this._clientSnapshotSettled = null;
  }

  /**
   * A daemon's core: settles once every availability refresh a client change started has settled, so pi's snapshot holds
   * the acting client's credentials; null while none runs, and always on a local core. One promise while pending, so waiters keep their order.
   */
  clientSnapshotSettling(): Promise<void> | null {
    return this._clientSnapshotSettled;
  }

  private _publishAccountInfoToSessions(): void {
    this._publishAccountStateToSessions();
    notifyMemoryJudgeListeners();
  }

  /** Whether the runtime's own account publications reach `session`'s panel: it holds every started session (`registerSessionMutator`). */
  publishesAccountInfoOf(session: object): boolean {
    for (const held of this._sessionMutators.values()) if (held === session) return true;
    return false;
  }

  private _publishAccountStateToSessions(): void {
    for (const session of new Set(this._sessionMutators.values())) {
      try {
        session.publishAccountInfo();
      } catch (err) {
        log('[PiRuntime] publishing a session\'s account state failed: %O', err);
      }
    }
    notifyClientAuthListeners();
  }

  /**
   * Load pi, seed the Damocles-owned agent dir, and create the shared model runtime, user settings and
   * MCP client. No folder services are built here; `folder()` builds them on demand.
   * Idempotent: concurrent and repeat callers share a single in-flight initialization.
   */
  init(): Promise<void> {
    if (this._disposed) return Promise.reject(new Error('PiRuntime has been disposed'));
    if (this._initPromise) return this._initPromise;
    this._initPromise = timed('runtime.init', () => this._doInit()).catch((err) => {
      this._initPromise = null;
      throw err;
    });
    return this._initPromise;
  }

  /** Init stops at each await a dispose happened across, so it installs nothing the dispose already released. */
  private _throwIfDisposed(): void {
    if (this._disposed) throw new Error('PiRuntime has been disposed');
  }

  private async _doInit(): Promise<void> {
    const pi = await initPiLoader();
    this._throwIfDisposed();
    if (!pi) throw new Error('PiRuntime.init: pi coding-agent failed to load');
    ensurePiAgentDir(this._agentDir, cacheWarmingSetting());
    const remote = this._platform.remote;
    this._broker?.dispose();
    // a daemon's core never reads the target's AI login, which is user scope and lives on the client
    this._broker = remote
      ? new BrokeredCredentialStore({
          remote,
          credentialsChanged: () => {
            this.credentialsChanged().catch((err: unknown) => log('[PiRuntime] applying a clientAuth change failed: %s', describeAuthError(err)));
          },
        })
      : null;
    // pi's availability checks read every provider's credential, so they must never run inside a turn's pin
    const modelRuntime = await outsidePins(() => pi.ModelRuntime.create({
      ...(this._broker ? { credentials: this._broker } : { authPath: path.join(this._agentDir, 'auth.json') }),
      modelsPath: path.join(this._agentDir, 'models.json'),
      modelsStorePath: this._modelsStorePath(),
    }));
    if (remote) {
      // pi also starts this pass itself, from every provider (un)registration and session bind, in its caller's context
      const refresh = modelRuntime.refresh.bind(modelRuntime);
      modelRuntime.refresh = (options) => outsidePins(() => refresh(options));
      const shaped = await loadAllowanceTransport(pi, subscriptionPluginDir(this._platform.paths.resourceRoot));
      this._allowanceUnavailable = shaped === undefined;
      modelRuntime.registerProvider('anthropic', allowanceProvider(remote, await builtinAnthropicTransport(), shaped));
    }
    this._throwIfDisposed();
    this._modelRuntime = modelRuntime;
    for (const resolve of this._modelRuntimeWaiters) resolve(this._modelRuntime);
    this._modelRuntimeWaiters.clear();
    const userSettings = withSettingsPolicy(pi.SettingsManager.create(this._agentDir, this._agentDir));
    this._userSettings = userSettings;
    // A new manager has written nothing, so every error it holds is from its load.
    this._userSettingsLoadError = userSettingsLoadError(userSettings.drainErrors());
    if (this._userSettingsLoadError) {
      void this._platform.notifications.warn(
        l('Damocles could not read {0}, so pi runs without the settings and packages it holds. Fix or delete the file; Damocles reads it again the next time it starts.', this._userSettingsPath(this._userSettingsLoadError)),
      );
    }
    // Before the first key sync, so a change between its secret read and init's end is not missed.
    this._secretsListener?.dispose();
    // Fires for a key changed in another window too, so that window's change reaches this runtime and its breakers.
    this._secretsListener = this._platform.secrets.onDidChange((key) => {
      if (keyProviderOfSecret(key)) void this.syncCustomProviders((k) => this._platform.secrets.get(k));
    });
    // Before the auth.json watcher and before init resolves, which every OpenAI sign-in awaits.
    const keyChangeToPublish = await this._withOpenAICredentialSync(async () => {
      // the key presence every account publication before init read
      const presentBefore = this._openaiKeyPresent;
      const [readBefore, readUnpublished] = [this._openaiKeyRead, this._openaiKeyReadUnpublished];
      let moved = false;
      // a daemon's core holds no key to move: its keys are the clients'
      if (!remote) {
        try {
          moved = await migrateOpenAIApiKey({
            modelRuntime: this._modelRuntime!,
            secrets: this._platform.secrets,
            agentDir: this._agentDir,
            markerPath: OPENAI_KEY_MOVED_MARKER_PATH,
            host: this._platform.appInfo.host,
            // a move publishes below; a delete that failed before pi committed it is the watcher's
            ownAuthFileChange: (op) => this.ownAuthFileChange([OPENAI_API_PROVIDER], false, op),
          });
        } catch (err) {
          log('[PiRuntime] OpenAI API key migration failed; it runs again at the next start: %s', describeAuthError(err));
        }
      }
      try {
        await this._syncOpenAIRuntimeKeyNow();
      } catch (err) {
        log('[PiRuntime] OpenAI runtime key sync at init failed: %s', describeAuthError(err));
      }
      this._openaiStatusReady = true;
      // a daemon's core reads each client's key live; here a plain-text key in auth.json already counts as one
      const publish = moved || (!remote && this._openaiKeyPresent !== presentBefore && !readOpenAIAuthFromDisk(this._agentDir).storedApiKey);
      // init publishes no unchanged status, so a value the construction read caught and this sync read again stays its event's to publish
      if (!publish) this._openaiKeyReadUnpublished = readUnpublished && this._openaiKeyRead === readBefore;
      return publish;
    });
    this._throwIfDisposed();
    if (keyChangeToPublish) {
      this._publishAccountInfoToSessions();
      notifyOpenAICredentialListeners();
    }
    // The manager loads pi-mcp and eager-connects only once `setMcpServers` feeds it the enabled set, which no folder of a
    // failed init did, so a retried init keeps it. Each input below is released first: a retry follows a failure past it.
    this._userMcp ??= newMcpManager({
      clientVersion: this._platform.appInfo.version,
      shellPath: () => this._userSettings?.getShellPath(),
    });
    this._setupUserWatchers();
    this._setupAuthWatcher();
    // Folder settings managers were created with the trust state of their creation, which excluded the
    // project layer in a restricted window; each reload re-reads it once trusted.
    this._trustListener?.dispose();
    this._trustListener = this._platform.trust.onDidGrantTrust((folderPaths) => {
      const granted = new Set(folderPaths.map(folderKey));
      for (const folder of this.folders()) {
        if (!granted.has(folder.key)) continue;
        folder.services.settingsManager.setProjectTrusted(true);
        folder.reloadBare().catch((err) => log('[PiRuntime] trust-grant reload failed (%s): %O', folder.cwd, err));
      }
    });
    this._imageSettingsListener?.dispose();
    this._imageSettingsListener = this._platform.settings.onDidChange(IMAGE_SETTINGS_SECTION, () => {
      for (const folder of this.folders()) folder.refreshActiveTools();
    });
    // Every writer reaches the panels here: the MCP panel, a settings.json edit, Settings Sync, another window.
    // Each session's refresher also re-sends its panel's MCP status.
    this._toolExposureListener?.dispose();
    this._toolExposureListener = this._platform.settings.onDidChange(MCP_TOOL_EXPOSURE_SETTING, () => {
      for (const folder of this.folders()) folder.refreshActiveTools();
    });
    this._resourceExposureListener?.dispose();
    this._resourceExposureListener = this._platform.settings.onDidChange(MCP_RESOURCE_EXPOSURE_SETTING, () => {
      for (const folder of this.folders()) folder.refreshActiveTools();
    });
    this.logInertDisabledToolEntries();
    this._disabledToolsListener?.dispose();
    this._disabledToolsListener = this._platform.settings.onDidChange(TOOLS_DISABLED_SETTING, () => this.logInertDisabledToolEntries());
    this._assetPrecedenceListener?.dispose();
    this._assetPrecedenceListener = this._platform.settings.onDidChange(ASSET_SOURCE_PRECEDENCE_SETTING, () => this._scheduleFolderReloads());
    log('[PiRuntime] initialized (agentDir=%s)', this._agentDir);
  }

  /** Logs each `damocles.tools.disabled` entry that turns nothing off, by scope, file and index, as dead permission rules are. */
  private logInertDisabledToolEntries(): void {
    const inspection = this._platform.settings.inspect<unknown>(TOOLS_DISABLED_SETTING);
    for (const scope of ['user', 'project', 'local'] as const) {
      const list = scope === 'user' ? inspection.userValue : scope === 'project' ? inspection.projectValue : inspection.localValue;
      if (!Array.isArray(list)) continue;
      const where = this._platform.settings.scopeFile(scope) ?? `${scope} settings`;
      list.forEach((entry: unknown, index) => {
        const inert = typeof entry === 'string' ? inertToolListEntry(entry) : null;
        if (inert !== null) log('[PiRuntime] %s %s[%d] %s; it turns nothing off', where, TOOLS_DISABLED_SETTING, index, inert);
      });
    }
  }

  /** The project scope's `damocles.tools.disabled`, in its file or, where the host keeps no file, as the setting; null when it holds none. */
  private projectDisabledToolList(): ToolNameList | null {
    const names = this._platform.settings.inspect<unknown>(TOOLS_DISABLED_SETTING).projectValue;
    if (!Array.isArray(names)) return null;
    const entries = names.filter((name): name is string => typeof name === 'string');
    const file = this._platform.settings.scopeFile('project');
    return file === undefined ? { setting: TOOLS_DISABLED_SETTING, names: entries } : { path: file, names: entries };
  }

  /**
   * The personal scopes' `damocles.tools.disabled`. Both are window-level, read and written with no folder, so
   * every folder of the window shares them: the user scope everywhere, the local one on desktop (the default
   * project's local file; VS Code reports no local value for a window-level key).
   */
  private personalDisabledToolLists(scopes: readonly ('user' | 'local')[]): PersonalToolLists {
    return {
      rewrite: (rename) => this.rewriteDisabledToolLists(scopes, rename),
      lists: () => {
        const inspection = this._platform.settings.inspect<unknown>(TOOLS_DISABLED_SETTING);
        return scopes.flatMap((scope): ToolNameList[] => {
          const value = scope === 'user' ? inspection.userValue : inspection.localValue;
          if (!Array.isArray(value)) return [];
          const names = value.filter((name): name is string => typeof name === 'string');
          const file = this._platform.settings.scopeFile(scope);
          if (file !== undefined) return [{ path: file, names }];
          return scope === 'user' ? [{ setting: TOOLS_DISABLED_SETTING, scope: 'user', names }] : [];
        });
      },
    };
  }

  /**
   * Rewrites `damocles.tools.disabled` at each of `scopes` entry by entry, in place, from what it holds when the
   * write runs, on the process-wide settings write chain the settings panel's setters share. A list `rename`
   * leaves unchanged is not written.
   */
  private async rewriteDisabledToolLists(scopes: readonly ('user' | 'local')[], rename: (name: string) => string): Promise<void> {
    for (const scope of scopes) {
      await serializeSettingWrite(async () => {
        const inspection = this._platform.settings.inspect<unknown>(TOOLS_DISABLED_SETTING);
        const list = scope === 'user' ? inspection.userValue : inspection.localValue;
        if (!Array.isArray(list)) return;
        const renamed = list.map((item: unknown) => (typeof item === 'string' ? rename(item) : item));
        if (renamed.every((item, index) => item === list[index])) return;
        await this._platform.settings.update(TOOLS_DISABLED_SETTING, renamed, scope);
        log('[PiRuntime] rewrote retired MCP resource tools in %s at %s scope', TOOLS_DISABLED_SETTING, scope);
      });
    }
  }

  /**
   * Re-apply the active tool set to every open panel when `damocles.pi.webSearch.enabled` changes
   * (Phase 7). The web tools are native per-session tools built up front, so the toggle is purely an
   * active-set membership change — no install, no `resourceLoader.reload()`. Effective next turn. Starts no init: a folder
   * exists only once init succeeded, and one created later reads the setting itself.
   */
  async refreshWebSearch(): Promise<void> {
    if (this._disposed) return;
    for (const folder of this.folders()) folder.refreshActiveTools();
  }

  /**
   * Register/authenticate the key-backed providers (`KEYED_PROVIDER_DEFS`) on the shared registry
   * from each one's secret (Phase 5, US-018.8). Idempotent and fail-soft: called on
   * session start and on secret change so subagents can reach those models by explicit id (no loopback
   * proxy). No-op when the runtime is not yet initialized.
   *
   * Syncs run one at a time: a call while one runs queues a single follow-up, which every call made meanwhile
   * shares and resolves with.
   *
   * Bounded and cancellable: pi's credential operations take cross-process locks and this gates startup,
   * so each sync is cancelled after `CUSTOM_PROVIDER_SYNC_TIMEOUT_MS` and on dispose. `timedOut` covers
   * the timeout leg only — a disposal abort is not a timeout — so callers can tell "nothing configured"
   * from "gave up", which is what lets `PiSession.start` surface a downgrade instead of hiding it.
   * `notWired` means "configured, but not live"; a provider in NEITHER list has no secret, or a stored sign-in outranks its key.
   */
  syncCustomProviders(getSecret: SecretResolver): Promise<CustomProviderSyncOutcome> {
    const queued = this._customProviderSyncFollowUp;
    if (queued) {
      queued.getSecret = getSecret;
      return queued.outcome;
    }
    const running = this._customProviderSyncRun;
    if (!running) return this._startCustomProviderRun(getSecret);
    const start = (): Promise<CustomProviderSyncOutcome> => {
      this._customProviderSyncFollowUp = null;
      return this._startCustomProviderRun(followUp.getSecret);
    };
    const followUp = { getSecret, outcome: running.then(start, start) };
    this._customProviderSyncFollowUp = followUp;
    return followUp.outcome;
  }

  private _startCustomProviderRun(getSecret: SecretResolver): Promise<CustomProviderSyncOutcome> {
    const run = this._runCustomProviders(getSecret);
    this._customProviderSyncRun = run;
    const settled = (): void => {
      if (this._customProviderSyncRun === run) this._customProviderSyncRun = null;
    };
    run.then(settled, settled);
    return run;
  }

  private async _runCustomProviders(getSecret: SecretResolver): Promise<CustomProviderSyncOutcome> {
    if (this._disposed || !this._modelRuntime) return { wired: [], notWired: [], timedOut: false };
    // A changed credential can change a key kind's billing (`flatFeeKeyProviders`), and a failed sync may have changed one unreported.
    let republishAccount = true;
    // `clientAuthSnapshot` sends the saved keys and prefer flags, and one a sign-in outranks changes nothing else it carries
    let snapshotChanged = false;
    const modelRuntime = this._modelRuntime;
    // read directly, not through `this.flatFeeKeyProviders()`, whose prefer check would schedule a second sync
    const flatFeeBefore = flatFeeKeyProviders(modelRuntime, this._platform.remote);
    const preferRead = new Map<KeyProviderId, boolean>();
    try {
      const { wired, aborted, notWired, changed, keysSaved } = await syncCustomProviders({
        modelRuntime,
        getSecret,
        signal: AbortSignal.any([this._syncAbort.signal, AbortSignal.timeout(CUSTOM_PROVIDER_SYNC_TIMEOUT_MS)]),
        ...(this._platform.remote ? { remote: this._platform.remote } : {}),
        beforeCredentialChange: (provider) => {
          if (provider === 'openrouter') this._openRouterCatalogAbort?.abort();
        },
        agentDir: this._agentDir,
        preferApiKey: (provider) => {
          const prefer = readPreferProviderApiKey(this._platform.state, provider);
          preferRead.set(provider, prefer);
          return prefer;
        },
        sweepMarkerPath: PROVIDER_KEY_SWEEP_MARKER_PATH,
        // this sync's end publishes a sweep pi committed
        ownAuthFileChange: (providers, op) => this.ownAuthFileChange(providers, false, op),
        signingIn: this._signingIn,
      });
      if (!aborted) {
        for (const [provider, prefer] of preferRead) {
          if (this._appliedProviderPrefer.get(provider) !== prefer) snapshotChanged = true;
          this._appliedProviderPrefer.set(provider, prefer);
        }
      }
      for (const [provider, saved] of keysSaved) {
        if (this._providerKeySaved.get(provider) !== saved) snapshotChanged = true;
        this._providerKeySaved.set(provider, saved);
      }
      // The first sync is the first time the picker providers are known, so panels that have not started hear them too.
      republishAccount = changed.length > 0 || !this._customProvidersSynced;
      for (const provider of changed) this._classifierBreakers.reset(provider);
      if (changed.includes('openrouter') && wired.includes('openrouter')) this._refreshOpenRouterCatalog();
      if (wired.length > 0) log('[PiRuntime] custom providers wired: %s', wired.join(', '));
      const timedOut = aborted && !this._syncAbort.signal.aborted;
      if (timedOut) {
        log('[PiRuntime] custom provider sync timed out after %dms; not wired: %s', CUSTOM_PROVIDER_SYNC_TIMEOUT_MS, notWired.join(', ') || '(none configured)');
      }
      return { wired, notWired, timedOut };
    } catch (err) {
      // Nothing is known about any provider here, so `notWired` stays empty — but the caller must still
      // learn that Damocles gave up, or it silently skips the model-downgrade warning.
      const timedOut = !this._syncAbort.signal.aborted && isAbortError(err);
      log('[PiRuntime] syncCustomProviders failed (non-fatal): %s', describeAuthError(err));
      return { wired: [], notWired: [], timedOut };
    } finally {
      // a sync the dispose aborted ends with nothing published
      if (!this._disposed) this._endCustomProviderRun(modelRuntime, flatFeeBefore, republishAccount, snapshotChanged);
    }
  }

  /** A sync's end: the folders' tools and the account state, judge status and key statuses its changes reach. */
  private _endCustomProviderRun(modelRuntime: ModelRuntime, flatFeeBefore: ReadonlySet<string>, republishAccount: boolean, snapshotChanged: boolean): void {
    // GenerateImage's eligibility reads `hasConfiguredAuth('openrouter')`, which only now reflects the secret.
    for (const folder of this.folders()) folder.refreshActiveTools();
    this._customProvidersSynced = true;
    // A removal drops its cache entry before pi takes it, so a failure there changes billing without a `changed` entry.
    const flatFeeAfter = flatFeeKeyProviders(modelRuntime, this._platform.remote);
    const signInChanged = this._accountChangeUnpublished;
    this._accountChangeUnpublished = false;
    const accountChanged = signInChanged || republishAccount || flatFeeAfter.size !== flatFeeBefore.size || [...flatFeeAfter].some((p) => !flatFeeBefore.has(p));
    if (accountChanged) this._publishAccountInfoToSessions();
    else {
      if (snapshotChanged) notifyClientAuthListeners();
      notifyMemoryJudgeListeners();
    }
    // Isolated: a throw here would replace the sync's result and skip the listeners after it.
    for (const listener of [...customProvidersSyncedListeners]) {
      try {
        listener({ accountChanged });
      } catch (err) {
        log('[PiRuntime] custom provider sync listener failed: %O', err);
      }
    }
  }

  /**
   * A refresh of the OpenRouter catalog for the key just applied, never awaited: pi narrows it to the chat models,
   * limits and prices the key may use and saves the result for offline refreshes. pi's own `PI_OFFLINE` switch
   * decides whether it reaches the network.
   */
  private _refreshOpenRouterCatalog(): void {
    const abort = new AbortController();
    this._openRouterCatalogAbort = abort;
    void this._runOpenRouterCatalogRefresh(AbortSignal.any([abort.signal, this._syncAbort.signal]))
      .catch((err: unknown) => log('[PiRuntime] OpenRouter catalog refresh failed: %s', describeCatalogError(err)))
      .finally(() => {
        if (this._openRouterCatalogAbort === abort) this._openRouterCatalogAbort = null;
      });
  }

  /**
   * pi aborts a provider's running refresh whenever any refresh of it starts, as every provider registration does,
   * and reports nothing (pi-ai models.js `beginProviderRefresh`). So each attempt starts once `_providerSync` is idle,
   * without holding it, and an attempt that ended without error or abort but saved no catalog was superseded.
   */
  private async _runOpenRouterCatalogRefresh(cancel: AbortSignal): Promise<void> {
    if (this._modelRuntime && !piModelNetworkEnabled(this._modelRuntime)) {
      log('[PiRuntime] OpenRouter catalog not refreshed: pi is offline (PI_OFFLINE)');
      return;
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      const clock = AbortSignal.timeout(OPENROUTER_CATALOG_REFRESH_TIMEOUT_MS);
      const signal = AbortSignal.any([cancel, clock]);
      await this._whenProviderSyncIdle(signal);
      const modelRuntime = this._modelRuntime;
      if (clock.aborted) {
        log('[PiRuntime] OpenRouter catalog refresh gave up after %dms waiting for provider registrations', OPENROUTER_CATALOG_REFRESH_TIMEOUT_MS);
        return;
      }
      if (signal.aborted || !modelRuntime) return;
      const startedAt = Date.now();
      const refreshed = await outsidePins(() => modelRuntime.refresh({ providers: ['openrouter'], signal }));
      const failure = refreshed.errors.get('openrouter');
      if (failure) {
        log('[PiRuntime] OpenRouter catalog refresh failed: %s', describeCatalogError(failure));
        return;
      }
      if (clock.aborted) {
        log('[PiRuntime] OpenRouter catalog refresh timed out after %dms', OPENROUTER_CATALOG_REFRESH_TIMEOUT_MS);
        return;
      }
      if (refreshed.aborted) {
        log('[PiRuntime] OpenRouter catalog refresh aborted before completing');
        return;
      }
      let checkedAt: number | undefined;
      try {
        checkedAt = await savedCatalogCheckedAt(this._modelsStorePath(), 'openrouter');
      } catch (err) {
        log('[PiRuntime] OpenRouter catalog refresh ended, but its saved catalog could not be read: %s', describeCatalogError(err));
        return;
      }
      if (checkedAt !== undefined && checkedAt >= startedAt) return;
      log(
        attempt === 1
          ? '[PiRuntime] OpenRouter catalog refresh was superseded by another refresh of the provider; retrying once provider registrations are idle'
          : '[PiRuntime] OpenRouter catalog refresh was superseded again; the saved or shipped list stays until the next applied key',
      );
    }
  }

  /** Resolves once `_providerSync` has nothing queued, or once `signal` fires. */
  private async _whenProviderSyncIdle(signal: AbortSignal): Promise<void> {
    const aborted = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    let tail: Promise<void>;
    do {
      tail = this._providerSync;
      await Promise.race([tail, aborted]);
    } while (!signal.aborted && tail !== this._providerSync);
  }

  /** pi's models store, where a networked catalog refresh saves what it fetched. */
  private _modelsStorePath(): string {
    return path.join(this._agentDir, 'models-store.json');
  }

  /**
   * Re-discover extensions in every folder's loader and flush their provider registrations into the
   * shared model runtime, without recreating services or disposing in-flight sessions, so a plugin swap
   * does not tear down Team/btw/subagent conversations. No Damocles extension registers a native
   * provider, so only the provider-config channel is flushed.
   */
  private async _hotReloadExtensions(folders: readonly FolderRuntime[]): Promise<HotReloadResult> {
    const modelRuntime = this._modelRuntime;
    if (!modelRuntime) return { registered: new Map(), errors: [] };
    for (const folder of folders) await folder.reloadBare();
    const loaded = folders.filter((f) => !f.disposed).map((f) => f.services.resourceLoader.getExtensions());
    // `registerProvider` merges over the previous registration, so a replaced plugin's fields would
    // survive; unregistering first gives cold-start parity. No await may separate the unregister loop
    // from the register loop, or the built-in provider would serve a request in between.
    const names = new Set(loaded.flatMap((ext) => ext.runtime.pendingProviderRegistrations.map((p) => p.name)));
    for (const name of names) modelRuntime.unregisterProvider(name);
    const registered = new Map<string, string>();
    for (const ext of loaded) {
      for (const { name, config, extensionPath } of ext.runtime.pendingProviderRegistrations) {
        try {
          modelRuntime.registerProvider(name, config);
          registered.set(name, extensionPath);
        } catch (err) {
          log('[PiRuntime] provider re-register failed (%s): %s', name, describeAuthError(err));
        }
      }
      ext.runtime.pendingProviderRegistrations = [];
    }
    const errors = loaded.flatMap((ext) => ext.errors);
    for (const { path: extPath, error } of errors) {
      log('[PiRuntime] extension failed to load (%s): %s', extPath, error);
    }
    // pi reports per-provider composition failures instead of throwing.
    const refreshed = await outsidePins(() => modelRuntime.refresh({ allowNetwork: false }));
    for (const [provider, err] of refreshed.errors) log('[PiRuntime] hot-reload refresh: provider %s failed: %s', provider, describeAuthError(err));
    if (refreshed.aborted) log('[PiRuntime] hot-reload refresh aborted before completing');
    return { registered, errors };
  }

  // sign-ins, keys and the subscription's billing bucket are the client's on a daemon's core, so they are refused before any pi call, probe or network use
  private _refuseRemoteSignIn(): void {
    if (this._platform.remote) throw new LocalizedError(remoteSignInRefusal());
  }

  /**
   * Store an Anthropic API key (bills the API account). Clears any OAuth grant first so the mode is
   * unambiguous.
   */
  async setAnthropicApiKey(key: string): Promise<ClaudeAuthStatus> {
    this._refuseRemoteSignIn();
    await this.init();
    if (!this._modelRuntime) throw new Error('PiRuntime.setAnthropicApiKey: runtime not initialized');
    // `login` persists the api_key credential (overwriting any OAuth grant under 'anthropic') and
    // refreshes the runtime — no explicit refresh needed.
    await this._modelRuntime.login('anthropic', 'api_key', keyInteraction(key));
    return this.getClaudeAuthStatus();
  }

  /**
   * Sign in to the Claude Pro/Max subscription via pi's native OAuth (the `interaction` opens the
   * browser / collects a pasted code). `useAllowance` selects the billing bucket: the subscription
   * plugin bills the included allowance, pi-ai's built-in provider meters the same token as extra usage.
   * `cwd` is the requesting panel's folder: the plugin switch verifies against a live loader.
   */
  async signInSubscription(cwd: string, useAllowance: boolean, interaction: AuthInteraction): Promise<ClaudeAuthStatus> {
    this._refuseRemoteSignIn();
    await this.folder(cwd);
    const pi = getPiCodingAgent();
    if (!pi || !this._modelRuntime) throw new Error('PiRuntime.signInSubscription: runtime not initialized');
    await this._setPluginInstalled(pi, useAllowance);
    await this._modelRuntime.login('anthropic', 'oauth', interaction);
    log('[PiRuntime] subscription sign-in complete (allowance=%s)', useAllowance);
    return this.getClaudeAuthStatus();
  }

  /**
   * Switch the subscription billing bucket on the already-stored token, with no re-login. `cwd` is the
   * requesting panel's folder: the plugin switch verifies against a live loader.
   */
  async setSubscriptionBilling(cwd: string, useAllowance: boolean): Promise<ClaudeAuthStatus> {
    this._refuseRemoteSignIn();
    await this.folder(cwd);
    const pi = getPiCodingAgent();
    if (!pi) throw new Error('PiRuntime.setSubscriptionBilling: runtime not initialized');
    await this._setPluginInstalled(pi, useAllowance);
    log('[PiRuntime] subscription billing set (allowance=%s)', useAllowance);
    return this.getClaudeAuthStatus();
  }

  /** Clear any stored Anthropic credential (API key or OAuth grant). */
  async signOutAnthropic(): Promise<ClaudeAuthStatus> {
    this._refuseRemoteSignIn();
    if (this._modelRuntime) {
      await this._modelRuntime.logout('anthropic');
      log('[PiRuntime] anthropic signed out');
    }
    return this.getClaudeAuthStatus();
  }

  /** Current Claude auth mode (credential type + plugin presence). Read from disk (auth.json), which
   *  every login/logout persists before resolving — so it stays in lockstep with the stored grant. A daemon's core reads
   *  the pinned (else acting) client's sign-in and choice, and whether its bundled plugin loaded, never the host's files. */
  getClaudeAuthStatus(): ClaudeAuthStatus {
    const remote = this._platform.remote;
    return remote ? clientClaudeAuthStatus(remote, !this._allowanceUnavailable) : readClaudeAuthFromDisk(this._agentDir);
  }

  /**
   * The Claude auth mode without creating the runtime: a local core reads it from disk, a daemon's core from the pinned
   * (else acting) client as `getClaudeAuthStatus` does, where no bundled plugin has failed to load before the runtime exists.
   */
  static claudeAuthStatus(remote: RemoteHost | undefined): ClaudeAuthStatus {
    if (!remote) return readClaudeAuthFromDisk(PI_AGENT_DIR);
    return PiRuntime._instance ? PiRuntime._instance.getClaudeAuthStatus() : clientClaudeAuthStatus(remote, true);
  }

  /**
   * OAuth access token for the Claude subscription usage endpoint. Gated on subscription mode so an
   * api_key credential is never returned as a bearer token. `getAuth` resolves the OAuth grant,
   * refreshing the token under a lock when needed.
   */
  async getClaudeAccessToken(): Promise<string | undefined> {
    await this.init();
    const mode = this.getClaudeAuthStatus().mode;
    if (mode !== 'allowance' && mode !== 'extra') return undefined;
    return (await this._modelRuntime!.getAuth('anthropic'))?.auth.apiKey;
  }

  /** OAuth access token for the Codex usage endpoint. Gated on the codex grant. */
  async getCodexAccessToken(): Promise<string | undefined> {
    await this.init();
    if (!this.getOpenAIAuthStatus().codex) return undefined;
    return (await this._modelRuntime!.getAuth(OPENAI_CODEX_PROVIDER))?.auth.apiKey;
  }

  /**
   * The ChatGPT access token, only while ChatGPT is the active `openai` credential. pi resolves the runtime
   * key before the stored grant, so without both gates this would return the API key.
   */
  async getChatGPTAccessToken(): Promise<string | undefined> {
    await this.init();
    const status = this.getOpenAIAuthStatus();
    if (!status.chatgpt || openaiRuntimeKeyWanted(status, this.preferOpenAIApiKey())) return undefined;
    const resolved = await this._modelRuntime!.getAuth(OPENAI_API_PROVIDER);
    return resolved?.source === 'OAuth' ? resolved.auth.apiKey : undefined;
  }

  /**
   * The prefer-API-key toggle. It is global state, which another VS Code window can change with no event, so a read
   * that differs from what the last runtime key sync applied re-applies it here and republishes. A daemon's core applies
   * no key and reads the pinned (else acting) client's flag.
   */
  preferOpenAIApiKey(): boolean {
    const remote = this._platform.remote;
    if (remote) return clientPrefersApiKey(remote, OPENAI_API_PROVIDER);
    const prefer = readPreferOpenAIApiKey(this._platform.state);
    // while this process writes the flag, a new value is that write's, whose own sync applies it and whose caller publishes
    if (this._openaiPreferWrites > 0 || this._disposed) return prefer;
    if (this._appliedPreferApiKey !== null && prefer !== this._appliedPreferApiKey && !this._preferResyncPending) {
      this._preferResyncPending = true;
      void this._resyncOpenAIAndRepublish('a prefer-API-key change in another window').finally(() => {
        this._preferResyncPending = false;
      });
    }
    return prefer;
  }

  /**
   * A key provider's prefer-API-key flag, global state like the OpenAI one: a read that differs from what the last
   * custom-provider sync applied (another window changed it) re-applies the keys, whose listeners republish. A daemon's
   * core applies no key and reads the pinned (else acting) client's flag.
   */
  preferProviderApiKey(provider: KeyProviderId): boolean {
    const remote = this._platform.remote;
    if (remote) return clientPrefersApiKey(remote, provider);
    const prefer = readPreferProviderApiKey(this._platform.state, provider);
    // The sync skips a provider while it signs in, so a resync would not apply the flag; the sign-in's own final sync does.
    if ((this._signingIn as ReadonlySet<string>).has(provider)) return prefer;
    // a value this process is writing is applied by that write's own sync
    if (this._providerPreferWrites.has(provider)) return prefer;
    const applied = this._appliedProviderPrefer.get(provider);
    if (applied !== undefined && prefer !== applied && !this._providerPreferResyncPending) {
      this._providerPreferResyncPending = true;
      void this.syncCustomProviders((key) => this._platform.secrets.get(key)).finally(() => {
        this._providerPreferResyncPending = false;
      });
    }
    return prefer;
  }

  /** Prefer the saved key over a stored sign-in for `provider`, or not, and re-apply the keys. */
  async setProviderPreferApiKey(provider: KeyProviderId, preferApiKey: boolean): Promise<void> {
    this._refuseRemoteSignIn();
    // Written only after init succeeded: a failed init acks failure, and no sync runs to rebroadcast a written flag.
    await this.init();
    this._providerPreferWrites.set(provider, (this._providerPreferWrites.get(provider) ?? 0) + 1);
    try {
      await this._platform.state.global.update(providerPreferApiKeyState(provider), preferApiKey);
      await this.syncCustomProviders((key) => this._platform.secrets.get(key));
    } finally {
      const writes = (this._providerPreferWrites.get(provider) ?? 1) - 1;
      if (writes > 0) this._providerPreferWrites.set(provider, writes);
      else this._providerPreferWrites.delete(provider);
    }
  }

  /**
   * Sign in to a key provider with pi's OAuth flow, driven by `interaction`. pi's login keeps the runtime key Damocles
   * applied, so the custom-provider sync that follows applies the precedence rule. pi's error text can carry an OAuth
   * response, so a failure is rethrown for the caller to classify and never logged here.
   */
  async signInProvider(provider: SignInProviderId, interaction: AuthInteraction): Promise<void> {
    this._refuseRemoteSignIn();
    await this.init();
    const modelRuntime = this._modelRuntime;
    if (!modelRuntime) throw new Error('PiRuntime.signInProvider: runtime not initialized');
    if (this._signingIn.has(provider)) throw new Error(`A ${provider} sign-in is already running`);
    this._signingIn.add(provider);
    let signedIn = false;
    try {
      // the sync below publishes a sign-in that succeeded; one that failed or was cancelled is the watcher's
      await this.ownAuthFileChange([provider], false, async () => {
        try {
          await modelRuntime.login(provider, 'oauth', interaction);
        } catch (err) {
          if (!isCredentialSyncError(err)) throw err;
          log('[PiRuntime] %s sign-in is stored, but pi could not resynchronize its model snapshot', provider);
        }
      });
      log('[PiRuntime] %s sign-in complete', provider);
      signedIn = true;
    } finally {
      this._signingIn.delete(provider);
      this._planModels = null;
      if (signedIn) this._accountChangeUnpublished = true;
      await this.syncCustomProviders((key) => this._platform.secrets.get(key));
    }
    // The sync reports no change when no saved key was applied, so the minted key's catalog and breaker are refreshed here.
    if (signedIn && provider === 'openrouter') {
      this._classifierBreakers.reset(provider);
      this._refreshOpenRouterCatalog();
    }
  }

  /** Remove a key provider's stored sign-in, never a stored key, then re-apply the saved key the sign-in outranked. */
  async signOutProvider(provider: SignInProviderId): Promise<void> {
    this._refuseRemoteSignIn();
    await this.init();
    const modelRuntime = this._modelRuntime;
    if (!modelRuntime) throw new Error('PiRuntime.signOutProvider: runtime not initialized');
    const stored = readProviderSignIns(this._agentDir);
    if (stored === undefined) throw new Error('auth.json could not be read, so the sign-in was left in place');
    if (stored[provider]?.type === 'oauth') {
      // the sync below publishes a sign-out that succeeded; a failed one is the watcher's
      await this.ownAuthFileChange([provider], false, async () => {
        try {
          await modelRuntime.logout(provider);
        } catch (err) {
          if (!isCredentialSyncError(err)) throw err;
          log('[PiRuntime] %s sign-out is stored, but pi could not resynchronize its model snapshot', provider);
        }
      });
      log('[PiRuntime] %s signed out', provider);
    }
    this._planModels = null;
    this._accountChangeUnpublished = true;
    await this.syncCustomProviders((key) => this._platform.secrets.get(key));
  }

  /**
   * Runs on `_openaiCredentialSync`. A key other than the one the last sync read is a new request credential: the usage plans
   * and the `openai` breaker reset once the sync settled, since a request claimed before then may carry the old key.
   */
  private async _syncOpenAIRuntimeKeyNow(): Promise<void> {
    if (!this._modelRuntime) throw new Error('PiRuntime: runtime not initialized');
    const remote = this._platform.remote;
    const preferApiKey = remote ? clientPrefersApiKey(remote, OPENAI_API_PROVIDER) : readPreferOpenAIApiKey(this._platform.state);
    let keyChanged = false;
    try {
      await syncOpenAIRuntimeKey({
        modelRuntime: this._modelRuntime,
        secrets: this._platform.secrets,
        agentDir: this._agentDir,
        preferApiKey,
        onKeyPresence: (present) => {
          this._openaiKeyPresent = present;
        },
        onKeyRead: (key) => {
          const read = keySecretDigest(key);
          keyChanged = this._openaiKeyRead !== null && read !== this._openaiKeyRead;
          this._openaiKeyRead = read;
          this._openaiKeyReadUnpublished = false;
        },
        ...(this._platform.remote ? { remote: this._platform.remote } : {}),
      });
      this._appliedPreferApiKey = preferApiKey;
    } finally {
      if (keyChanged) {
        this.usage.credentialsChanged();
        this._openaiCredentialChanged();
      }
    }
  }

  /**
   * The key secret changed, by this process's own write or another window's; decided on the credential chain, so this process's own
   * write, which its setter's sync recorded, publishes nothing here (docs/invariants.md "Agent auth store").
   */
  private _openaiKeySecretChanged(): Promise<void> {
    return this._withOpenAICredentialSync(async () => {
      if (this._disposed) return;
      let key: string | undefined;
      try {
        key = await this._platform.secrets.get(OPENAI_API_KEY_SECRET);
      } catch (err) {
        log('[PiRuntime] reading the OpenAI key secret after its change failed: %s', describeAuthError(err));
        return;
      }
      if (this._disposed) return;
      // a value a sync recorded is that sync's caller's to publish, so every caller of the sync must publish after it
      const recorded = this._openaiKeyRead !== null && keySecretDigest(key) === this._openaiKeyRead;
      if (recorded && !this._openaiKeyReadUnpublished) return;
      // a value the construction read recorded is applied already, and only its publication is owed
      if (!recorded && this._modelRuntime) {
        try {
          await this._syncOpenAIRuntimeKeyNow();
        } catch (err) {
          log('[PiRuntime] OpenAI runtime key sync after a key secret change failed: %s', describeAuthError(err));
        }
        if (this._disposed) return;
      } else if (!recorded) {
        // before init only the record changes, which init's own sync applies to pi
        this._recordOpenAIKey(key);
      }
      this._openaiKeyReadUnpublished = false;
      // the key presence the account state and the judge status read is the one just recorded
      this._publishAccountInfoToSessions();
      notifyOpenAICredentialListeners();
    }).catch((err: unknown) => log('[PiRuntime] applying an OpenAI key secret change failed: %s', describeAuthError(err)));
  }

  /** The runtime's first read of the key secret, which every account publication waits for. A failed read leaves the key unread, for init's sync. */
  private async _recordOpenAIKeySecret(): Promise<void> {
    try {
      this._recordOpenAIKey(await this._platform.secrets.get(OPENAI_API_KEY_SECRET));
      this._openaiKeyReadUnpublished = true;
    } catch (err) {
      log('[PiRuntime] reading the OpenAI key secret failed; init reads it again: %s', describeAuthError(err));
    }
  }

  private _recordOpenAIKey(key: string | undefined): void {
    this._openaiKeyPresent = key !== undefined && key !== '';
    this._openaiKeyRead = keySecretDigest(key);
    this._openaiStatusReady = true;
  }

  /** Re-apply the OpenAI runtime key from the secret, auth.json and the prefer toggle. */
  async syncOpenAIRuntimeKey(): Promise<void> {
    await this.init();
    await this._withOpenAICredentialSync(() => this._syncOpenAIRuntimeKeyNow());
  }

  /** The user changed which OpenAI credential pi sends, so a refusal of the old one no longer stands. A token refresh is not such a change. */
  private _openaiCredentialChanged(): void {
    this._classifierBreakers.reset(OPENAI_API_PROVIDER);
  }

  /**
   * This window's prefer-API-key toggle: writes the flag and applies it; the caller publishes the result, failed or not. A failure
   * leaves the flag as it was, so the stored flag agrees with the failure the caller reports and no later read resyncs it.
   */
  async setOpenAIPreferApiKey(preferApiKey: boolean): Promise<void> {
    this._refuseRemoteSignIn();
    await this.init();
    const stored = this._platform.state.global.get<unknown>(OPENAI_PREFER_API_KEY_STATE);
    this._openaiPreferWrites++;
    try {
      await this._platform.state.global.update(OPENAI_PREFER_API_KEY_STATE, preferApiKey);
      try {
        await this.applyOpenAIPreferApiKey();
      } catch (err) {
        await this._platform.state.global.update(OPENAI_PREFER_API_KEY_STATE, stored);
        throw err;
      }
    } finally {
      this._openaiPreferWrites--;
    }
  }

  /** Apply the prefer-API-key toggle, which switches the `openai` request credential even when the sync fails. */
  async applyOpenAIPreferApiKey(): Promise<void> {
    try {
      await this.syncOpenAIRuntimeKey();
    } finally {
      this._openaiCredentialChanged();
    }
  }

  /**
   * Store the OpenAI API key in the host secret store. No network validation. Where that store is not
   * persistent, auth.json is the durable copy the migration leaves in place, so the key goes there, or a
   * restart would bring back the previous one. auth.json has one `openai` slot: while it holds a ChatGPT
   * grant, which writing a key would delete, the key lasts until restart.
   */
  async setOpenAIApiKey(key: string): Promise<OpenAIAuthStatus> {
    this._refuseRemoteSignIn();
    await this.init();
    await this._withOpenAICredentialSync(() =>
      this._resyncOpenAIAfter(async () => {
        if (this._platform.secrets.isPersistent || readOpenAIAuthFromDisk(this._agentDir).chatgpt) {
          await this._platform.secrets.store(OPENAI_API_KEY_SECRET, key);
        } else {
          await this._platform.secrets.delete(OPENAI_API_KEY_SECRET);
          try {
            await this._modelRuntime!.login(OPENAI_API_PROVIDER, 'api_key', keyInteraction(key));
          } catch (err) {
            if (!isCredentialSyncError(err)) throw err;
            log('[PiRuntime] openai api key is stored, but pi could not resynchronize its model snapshot: %s', describeAuthError(err));
          }
        }
      }),
    );
    this._openaiCredentialChanged();
    return this.getOpenAIAuthStatus();
  }

  /**
   * Delete the OpenAI API key secret, and a plain-text key still in auth.json, which a start with a
   * non-persistent secret store leaves there. Any ChatGPT or Codex grant stays intact.
   */
  async clearOpenAIApiKey(): Promise<OpenAIAuthStatus> {
    this._refuseRemoteSignIn();
    await this.init();
    await this._withOpenAICredentialSync(() =>
      this._resyncOpenAIAfter(async () => {
        await this._platform.secrets.delete(OPENAI_API_KEY_SECRET);
        // auth.json holds one `openai` credential, so an api_key there means no ChatGPT grant to lose.
        if (readOpenAIAuthFromDisk(this._agentDir).storedApiKey) await this._modelRuntime!.logout(OPENAI_API_PROVIDER);
      }),
    );
    this._openaiCredentialChanged();
    log('[PiRuntime] openai api key cleared');
    return this.getOpenAIAuthStatus();
  }

  /**
   * Sign in with ChatGPT on pi's `openai` provider. pi races its 127.0.0.1:1455 callback against a
   * `manual_code` paste-the-redirect-URL prompt, and fails before opening the browser when 1455 is taken. The
   * device id comes from the user settings. On success the legacy Codex grant is removed.
   */
  async signInChatGPT(interaction: AuthInteraction): Promise<OpenAIAuthStatus> {
    this._refuseRemoteSignIn();
    await this.init();
    const settings = this._settings();
    this._openaiSignInsPending++;
    try {
      await this._withOpenAICredentialSync(() =>
        this._resyncOpenAIAfter(async () => {
          const modelRuntime = this._modelRuntime!;
          try {
            await modelRuntime.login(OPENAI_API_PROVIDER, 'oauth', interaction, {
              getDeviceId: () => settings.getOrCreateDeviceId(),
              agentName: 'Damocles',
            });
          } catch (err) {
            if (!isCredentialSyncError(err)) throw err;
            log('[PiRuntime] chatgpt sign-in is stored, but pi could not resynchronize its model snapshot: %s', describeAuthError(err));
          }
          log('[PiRuntime] chatgpt sign-in complete');
          try {
            await modelRuntime.logout(OPENAI_CODEX_PROVIDER);
          } catch (err) {
            // The sign-in succeeded; a Codex grant left behind stays visible in the auth panel with its own sign-out.
            log('[PiRuntime] removing the legacy Codex grant after the ChatGPT sign-in failed: %s', describeAuthError(err));
          }
        }),
      );
    } finally {
      this._openaiSignInsPending--;
    }
    this._openaiCredentialChanged();
    return this.getOpenAIAuthStatus();
  }

  /** Remove the ChatGPT grant, leaving the API key secret intact. */
  async signOutChatGPT(): Promise<OpenAIAuthStatus> {
    this._refuseRemoteSignIn();
    await this.init();
    await this._withOpenAICredentialSync(() =>
      this._resyncOpenAIAfter(async () => {
        await this._modelRuntime!.logout(OPENAI_API_PROVIDER);
        log('[PiRuntime] chatgpt signed out');
      }),
    );
    this._openaiCredentialChanged();
    return this.getOpenAIAuthStatus();
  }

  /**
   * Run an OpenAI credential write, then apply the runtime key rule again even when it failed: pi's login keeps the runtime key,
   * its logout drops it, and a failed write may still have changed auth.json or the key secret, whose record this sync updates.
   */
  private async _resyncOpenAIAfter(op: () => Promise<void>): Promise<void> {
    try {
      await op();
    } catch (err) {
      await this._syncOpenAIRuntimeKeyNow().catch((syncErr: unknown) =>
        log('[PiRuntime] OpenAI runtime key sync after a failed credential change failed: %s', describeAuthError(syncErr)),
      );
      throw err;
    }
    await this._syncOpenAIRuntimeKeyNow();
  }

  /** Remove the legacy Codex grant, leaving the API key secret intact. */
  async signOutCodex(): Promise<OpenAIAuthStatus> {
    this._refuseRemoteSignIn();
    await this.init();
    await this._withOpenAICredentialSync(() =>
      this._resyncOpenAIAfter(async () => {
        await this._modelRuntime!.logout(OPENAI_CODEX_PROVIDER);
        log('[PiRuntime] codex signed out');
      }),
    );
    return this.getOpenAIAuthStatus();
  }

  /**
   * This computer's core: the credential a daemon's token broker asked for (`user.resolveCredential`), resolved by this
   * runtime, so an expiring OAuth token is refreshed under pi's lock first, and any OAuth token with `force` (Keep
   * running). A provider this computer has only from its environment answers none, and the target then uses its own.
   */
  async resolveCredentialForBroker(provider: string, force = false): Promise<BrokerAnswer> {
    // a daemon's core holds only what its pinned client sent, and answers no other core
    if (this._platform.remote) throw new Error('A remote host\'s core resolves no credential for a broker');
    await this.init();
    const runtime = this._modelRuntime!;
    if (!runtime.getProvider(provider)) throw new Error(`pi knows no provider ${provider}`);
    if (!(await runtime.listCredentials()).some((credential) => credential.providerId === provider)) return { type: 'none' };
    const held = force ? readAuthFile(this._agentDir)?.[provider] as { type?: unknown; expires?: unknown } | undefined : undefined;
    // asking for more validity than the stored token has makes pi refresh it under its lock
    const resolved = await runtime.getAuth(provider, held?.type === 'oauth' && typeof held.expires === 'number' ? { minOAuthValidityMs: Math.max(held.expires - Date.now() + 1, 0) } : {});
    if (!resolved) return { type: 'none' };
    if (resolved.source === 'OAuth') {
      // pi's refresh persisted the credential before releasing its lock
      const stored = readAuthFile(this._agentDir)?.[provider];
      if (typeof stored !== 'object' || stored === null) throw new Error(`The ${provider} sign-in changed while it was read`);
      return oauthAnswerOf(stored as Record<string, unknown>, Date.now());
    }
    const key = resolved.auth.apiKey;
    return key ? { type: 'api_key', key } : { type: 'none' };
  }

  /** A daemon's core: an access token the client `actor` pushed for itself, which only that client's turns read. */
  async acceptPushedCredential(actor: string | undefined, provider: string, credential: BrokerAnswer & { readonly type: 'oauth' }): Promise<void> {
    if (!this._platform.remote) throw new Error('Only a remote host\'s core takes a pushed credential');
    if (actor === undefined) throw new Error('A pushed credential names no client');
    if (credential.refresh !== '') throw new Error('A pushed credential carries a refresh token');
    await this.init();
    if (!this._modelRuntime!.getProvider(provider)) throw new Error(`pi knows no provider ${provider}`);
    this._broker!.push(actor, provider, credential);
  }

  /** This computer's core: every provider pi knows with its credential type, expiry, whether a key is stored and bills flat, and whether Claude's sign-in bills the allowance; never a secret. */
  async clientAuthSnapshot(): Promise<HeldAuth> {
    await this.init();
    const runtime = this._modelRuntime!;
    let file: Record<string, unknown> | undefined;
    try {
      file = readAuthFile(this._agentDir);
    } catch (err) {
      logAuthReadFailure('PiRuntime', err, 'its sign-ins read as absent for remote hosts');
    }
    const listed = new Map((await runtime.listCredentials()).map((credential) => [credential.providerId, credential.type]));
    const providers: Record<string, HeldAuthEntry> = {};
    const flatFee = this.flatFeeKeyProviders();
    const claudeAllowance = this.getClaudeAuthStatus().mode === 'allowance';
    for (const { id } of runtime.getProviders()) {
      const stored = file?.[id] as { type?: unknown; expires?: unknown; availableModelIds?: unknown } | undefined;
      const plan = stored?.type === 'oauth' ? planModelIdsOf(stored.availableModelIds) : undefined;
      const type = stored?.type === 'oauth' ? 'oauth' : (listed.get(id) ?? 'none');
      const hasKey = listed.get(id) === 'api_key' || stored?.type === 'api_key' || (id === OPENAI_API_PROVIDER && this._openaiKeyPresent);
      const keySaved = this._providerKeySaved.get(id as KeyProviderId);
      const preferApiKey = id === OPENAI_API_PROVIDER ? readPreferOpenAIApiKey(this._platform.state) : isKeyProviderId(id) && readPreferProviderApiKey(this._platform.state, id);
      providers[id] = {
        type,
        hasKey,
        ...(keySaved !== undefined ? { keySaved } : {}),
        flatFee: flatFee.has(id),
        ...(stored?.type === 'oauth' && typeof stored.expires === 'number' ? { expires: stored.expires } : {}),
        ...(id === 'anthropic' && type === 'oauth' && claudeAllowance ? { allowance: true } : {}),
        ...(plan ? { availableModelIds: plan } : {}),
        ...(preferApiKey ? { preferApiKey: true } : {}),
      };
    }
    return { providers };
  }

  /**
   * Current OpenAI auth state: the grants from auth.json and the key secret's cached presence. Not pi's
   * `hasConfiguredAuth`, which also counts ambient `OPENAI_API_KEY` env vars and runtime overrides; only a daemon's core,
   * whose client holds no `openai` credential, reads it as `hostKey`.
   */
  getOpenAIAuthStatus(): OpenAIAuthStatus {
    const remote = this._platform.remote;
    // a daemon's core reads the pinned (else acting) client's key, never the one its last sync saw
    const status = openaiAuthStatus(readOpenAIAuthFromDisk(this._agentDir), remote ? clientHasKey(remote, OPENAI_API_PROVIDER) : this._openaiKeyPresent);
    if (!remote || clientHasCredential(remote, OPENAI_API_PROVIDER) || !this.hostHasOwnAuth(OPENAI_API_PROVIDER)) return status;
    return { ...status, hostKey: true };
  }

  /**
   * Whether a daemon's core has a credential of its own for a provider, which only pi's snapshot knows. That snapshot also
   * counts the acting client's credentials, so a provider the acting client holds reads as the client's, never the host's.
   */
  hostHasOwnAuth(provider: string): boolean {
    const remote = this._platform.remote;
    const registry = this._modelRuntime;
    if (!remote || !registry) return false;
    return registry.hasConfiguredAuth(provider) && !clientHasAuth(remote, provider, remote.clients.acting());
  }

  /** A sub-call's ledger attribution, with the host as payer when a daemon's core billed the host's own credential. */
  private _billedTo(provider: string, attribution: SubCallAttribution = {}): SubCallAttribution {
    const credentialSource = credentialSourceOf(this._platform.remote, provider);
    return credentialSource ? { ...attribution, credentialSource } : attribution;
  }

  /** Whether `getOpenAIAuthStatus` reflects the key secret: false until a read of it succeeded or init's first key sync has run. */
  get openaiStatusReady(): boolean {
    return this._openaiStatusReady;
  }

  /** This computer's core: the runtime's first read of the key secret while it runs, else null. Settles, never rejects. */
  get openaiKeyRecording(): Promise<void> | null {
    return this._openaiKeyRecording;
  }

  /**
   * Switch to allowance (the pinned plugin) or extra usage (no subscription plugin). The clone download
   * runs before the switch joins `_providerSync`, so a folder opened meanwhile is not held up by the
   * network. The startup reconcile, the only other clone writer, has finished by then: every caller
   * first awaits `folder(cwd)`.
   */
  private _setPluginInstalled(pi: PiCodingAgentModule, installed: boolean): Promise<void> {
    return this._withSubscriptionSync(async () => {
      const acquired = installed && (await this._prefetchSubscriptionPlugin(pi));
      await this._withProviderSync(() => this._applyPluginInstalled(pi, installed, acquired));
    });
  }

  /**
   * Download the pinned plugin unless the pin already looks healthy; returns whether it downloaded.
   * Reads the in-memory settings, since a reload here would race `_providerSync`'s writes; the queued
   * switch reloads and re-checks, and downloads there if this guessed wrong.
   */
  private async _prefetchSubscriptionPlugin(pi: PiCodingAgentModule): Promise<boolean> {
    const pm = this._packageManager(pi);
    if (this._isAllowancePinHealthy(pm)) return false;
    try {
      await this._acquireSubscriptionPlugin(pm);
    } catch (err) {
      await this._withProviderSync(async () => {
        await this._reloadSettings();
        await this._unlistMissingClone(pm, this.folders());
      });
      throw err;
    }
    return true;
  }

  /** Runs on `_providerSync`. `acquired`: the pinned clone was just downloaded and is not listed yet. */
  private async _applyPluginInstalled(pi: PiCodingAgentModule, installed: boolean, acquired: boolean): Promise<void> {
    await this._reloadSettings();
    const folders = this.folders();
    const pm = this._packageManager(pi);
    const kinds = listedSubscriptionKinds(this._userPackages());
    if (installed) {
      if (this._isAllowancePinHealthy(pm) && !kinds.has('legacy')) return;
      await this._switchToAllowancePlugin(pi, folders, acquired);
    } else if (kinds.size > 0 || pm.getInstalledPath(SUBSCRIPTION_SOURCE, 'user') || this._hasLegacyClone(pm)) {
      await this._removeSubscriptionPlugin(pi, folders);
    }
  }

  private _settings(): SettingsManager {
    if (!this._userSettings) throw new Error('PiRuntime._settings: runtime not initialized');
    return this._userSettings;
  }

  private _packageManager(pi: PiCodingAgentModule): PackageManager {
    return new pi.DefaultPackageManager({
      cwd: this._agentDir,
      agentDir: this._agentDir,
      settingsManager: this._settings(),
    });
  }

  // User scope only: Damocles writes only there.
  private _userPackages(): PackageSource[] {
    return [...(this._settings().getGlobalSettings().packages ?? [])];
  }

  private _listedSources(): string[] {
    return this._userPackages().map(packageSourceString);
  }

  /** The agent `settings.json`, which the user-scope manager loads as its global scope. */
  private _userSettingsPath(err: PiSettingsError): string {
    return err.path ?? path.join(this._agentDir, 'settings.json');
  }

  // pi records a load error only when it loads (at creation and in reload), so each load's outcome is kept
  // here. Queued writes settle first, so what pi records during the reload is its load's. Every Damocles write
  // drains its own errors, so one left now is another writer's (a ChatGPT sign-in's device id) and only logged.
  private async _reloadSettings(): Promise<void> {
    const settings = this._settings();
    await settings.flush();
    for (const err of settings.drainErrors()) log('[PiRuntime] settings write failed (%s): %s', err.scope, settingsErrorName(err.error));
    await settings.reload();
    this._userSettingsLoadError = userSettingsLoadError(settings.drainErrors());
  }

  // pi reports a failed write only through drainErrors and drops every write while its last load failed
  // (settings-manager.js:474-478), so this refuses first: no step may change, reload or delete on top of a dropped write.
  private async _writeUserSettings(write: () => void): Promise<void> {
    if (this._userSettingsLoadError) {
      throw new LocalizedError(
        l('Damocles could not read {0}, so pi cannot save this change to it. Fix or delete the file, then try again.', this._userSettingsPath(this._userSettingsLoadError)),
      );
    }
    const settings = this._settings();
    write();
    await settings.flush();
    const errors = settings.drainErrors();
    for (const err of errors) log('[PiRuntime] settings write failed (%s): %s', err.scope, settingsErrorName(err.error));
    const userErrors = errors.filter((e) => e.scope === 'global');
    if (userErrors.length > 0) throw new Error(`settings write failed (${userErrors.map((e) => settingsErrorName(e.error)).join('; ')})`);
  }

  /**
   * Whether a clone dir holds a loadable plugin rather than the debris of a partially-failed removal,
   * which on Windows can satisfy `existsSync` while `src/index.ts` is gone.
   */
  private _isSubscriptionCloneIntact(cloneDir: string): boolean {
    return existsSync(path.join(cloneDir, 'package.json')) && existsSync(path.join(cloneDir, 'src', 'index.ts'));
  }

  private _isAllowancePinHealthy(pm: PackageManager): boolean {
    if (!this._listedSources().includes(SUBSCRIPTION_SOURCE)) return false;
    return this._isCurrentCloneIntact(pm);
  }

  private _isCurrentCloneIntact(pm: PackageManager): boolean {
    const cloneDir = pm.getInstalledPath(SUBSCRIPTION_SOURCE, 'user');
    return cloneDir !== undefined && this._isSubscriptionCloneIntact(cloneDir);
  }

  private _hasLegacyClone(pm: PackageManager): boolean {
    return LEGACY_SUBSCRIPTION_REPOS.some((repo) => pm.getInstalledPath(repo, 'user') !== undefined);
  }

  private async _acquireSubscriptionPlugin(pm: PackageManager): Promise<void> {
    // pi's installGit treats any existing dir as a working clone and runs `git fetch`, which aborts on debris.
    const cloneDir = pm.getInstalledPath(SUBSCRIPTION_SOURCE, 'user');
    if (cloneDir && !this._isSubscriptionCloneIntact(cloneDir)) {
      await forceRemoveDir(cloneDir);
      log('[PiRuntime] cleared unusable subscription clone at %s', cloneDir);
    }
    await pm.install(SUBSCRIPTION_SOURCE);
    log('[PiRuntime] installed %s', SUBSCRIPTION_SOURCE);
  }

  // A listed entry whose clone is gone loads nothing; a stale clone that is still intact keeps working.
  private async _unlistMissingClone(pm: PackageManager, folders: readonly FolderRuntime[]): Promise<void> {
    if (!this._listedSources().some(namesCurrentRepo) || this._isCurrentCloneIntact(pm)) return;
    await this._writeUserSettings(() => pm.removeSourceFromSettings(SUBSCRIPTION_SOURCE));
    await this._reloadAfterUnlist(folders);
  }

  // Best-effort: pi loads only listed packages, so a leftover clone is inert until the next reconcile.
  private async _evictLegacyClones(pm: PackageManager): Promise<void> {
    for (const repo of LEGACY_SUBSCRIPTION_REPOS) {
      try {
        const cloneDir = pm.getInstalledPath(repo, 'user');
        if (!cloneDir) continue;
        await forceRemoveDir(cloneDir);
        // Prunes the update marker and empty parent dirs.
        await pm.remove(repo);
        log('[PiRuntime] deleted legacy subscription clone %s', cloneDir);
      } catch (err) {
        log('[PiRuntime] legacy subscription clone delete failed (%s): %O', repo, err);
      }
    }
  }

  /** Errors the loader recorded for files inside the current plugin's clone. */
  private _subscriptionLoadErrors(pm: PackageManager, errors: readonly ExtensionLoadError[]): ExtensionLoadError[] {
    const cloneDir = pm.getInstalledPath(SUBSCRIPTION_SOURCE, 'user');
    return cloneDir ? errors.filter((e) => isInsideDir(e.path, cloneDir)) : [];
  }

  /**
   * Hot-reload every folder after a plugin was unlisted; unless the reload re-registers `anthropic`, fall
   * back to the built-in provider. Every loader reloads first: one still holding the plugin would
   * re-flush it at its next session bind.
   */
  private async _reloadAfterUnlist(folders: readonly FolderRuntime[]): Promise<void> {
    let registered = false;
    try {
      registered = (await this._hotReloadExtensions(folders)).registered.has('anthropic');
    } finally {
      if (!registered && this._modelRuntime) {
        const modelRuntime = this._modelRuntime;
        // `unregisterProvider`'s own refresh is fire-and-forget; the caller reports status right after.
        outsidePins(() => modelRuntime.unregisterProvider('anthropic'));
        const refreshed = await outsidePins(() => modelRuntime.refresh({ allowNetwork: false }));
        for (const [provider, err] of refreshed.errors) log('[PiRuntime] provider-reset refresh: provider %s failed: %s', provider, describeAuthError(err));
        if (refreshed.aborted) log('[PiRuntime] provider-reset refresh aborted before completing');
      }
    }
  }

  /**
   * Make the pinned plugin the only listed subscription plugin. Legacy entries stay on disk until the
   * new plugin is verified registered, so a failure rolls back to them with no network; a failure
   * before the swap leaves them untouched. Settings never list a plugin that did not register.
   * `acquired` skips the download when the caller already made it outside `_providerSync`.
   */
  private async _switchToAllowancePlugin(pi: PiCodingAgentModule, folders: readonly FolderRuntime[], acquired = false): Promise<void> {
    const pm = this._packageManager(pi);
    if (!acquired && !this._isAllowancePinHealthy(pm)) {
      try {
        await this._acquireSubscriptionPlugin(pm);
      } catch (err) {
        await this._unlistMissingClone(pm, folders);
        throw err;
      }
    }

    const legacyEntries = this._userPackages().filter((p) => classifySubscriptionSource(packageSourceString(p)) === 'legacy');
    await this._writeUserSettings(() => {
      pm.addSourceToSettings(SUBSCRIPTION_SOURCE);
      for (const repo of LEGACY_SUBSCRIPTION_REPOS) pm.removeSourceFromSettings(repo);
    });

    let failure: string;
    try {
      const { registered, errors } = await this._hotReloadExtensions(folders);
      const cloneDir = pm.getInstalledPath(SUBSCRIPTION_SOURCE, 'user');
      const pluginErrors = this._subscriptionLoadErrors(pm, errors);
      const registeredFrom = registered.get('anthropic');
      const listed = listedSubscriptionKinds(this._userPackages());
      if (registeredFrom && cloneDir && isInsideDir(registeredFrom, cloneDir) && pluginErrors.length === 0 && listed.has('current') && !listed.has('legacy')) {
        await this._evictLegacyClones(pm);
        log('[PiRuntime] subscription plugin active: %s', SUBSCRIPTION_SOURCE);
        return;
      }
      failure =
        pluginErrors.length > 0 ? pluginErrors.map((e) => e.error).join('; ')
        : registeredFrom ? `anthropic was registered by ${registeredFrom}`
        : 'registered no anthropic provider';
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    await this._writeUserSettings(() => {
      pm.removeSourceFromSettings(SUBSCRIPTION_SOURCE);
      // Another window may have deleted a legacy clone meanwhile; relisting it would make pi re-clone it.
      const restorable = legacyEntries.filter((e) => pm.getInstalledPath(packageSourceString(e), 'user') !== undefined);
      if (restorable.length > 0) this._settings().setPackages([...this._userPackages(), ...restorable]);
    });
    await this._reloadAfterUnlist(folders);
    throw new Error(`subscription plugin failed to load: ${failure}`);
  }

  /**
   * Unlist a current plugin that `created`'s loader failed to load, or that left `anthropic`
   * unregistered: it would bill as extra usage while the settings report allowance. Returns whether it
   * unlisted.
   */
  private async _unlistBrokenPlugin(pi: PiCodingAgentModule, folders: readonly FolderRuntime[], created: FolderRuntime): Promise<boolean> {
    const pm = this._packageManager(pi);
    const kinds = listedSubscriptionKinds(this._userPackages());
    if (!kinds.has('current') || !this._isAllowancePinHealthy(pm)) return false;
    const loadErrors = this._subscriptionLoadErrors(pm, created.getExtensionErrors());
    const unregistered = !kinds.has('legacy') && !this._modelRuntime?.getRegisteredProviderConfig('anthropic');
    if (loadErrors.length === 0 && !unregistered) return false;
    for (const e of loadErrors) log('[PiRuntime] subscription plugin failed to load, switching to extra usage (%s): %s', e.path, e.error);
    if (unregistered) log('[PiRuntime] subscription plugin registered no anthropic provider, switching to extra usage');
    await this._writeUserSettings(() => pm.removeSourceFromSettings(SUBSCRIPTION_SOURCE));
    await this._reloadAfterUnlist(folders);
    return true;
  }

  /**
   * Repair the subscription plugin once per process, against the first folder runtime's loader. pi keys
   * git packages by repo identity, so neither a re-pin nor a replaced repo self-heals: the old entry
   * stays listed and pi resets the clone to it. Fail-soft, since it clones over the network.
   */
  private async _reconcileSubscriptionPin(pi: PiCodingAgentModule, folders: readonly FolderRuntime[], created: FolderRuntime): Promise<void> {
    try {
      await this._reloadSettings();
      if (await this._unlistBrokenPlugin(pi, folders, created)) return;
      const pm = this._packageManager(pi);
      const kinds = listedSubscriptionKinds(this._userPackages());

      if (kinds.has('stale') || kinds.has('legacy') || (kinds.has('current') && !this._isAllowancePinHealthy(pm))) {
        await this._switchToAllowancePlugin(pi, folders);
        log('[PiRuntime] reconciled subscription plugin to %s', SUBSCRIPTION_SOURCE);
        return;
      }

      if (kinds.size === 0 && this._hasLegacyClone(pm)) await this._evictLegacyClones(pm);
    } catch (err) {
      log('[PiRuntime] subscription reconcile failed: %O', err);
    }
  }

  /** A later folder's loader may fail to load the plugin the first one loaded; the same unlist applies. */
  private async _unlistFailedPluginLoad(pi: PiCodingAgentModule, folders: readonly FolderRuntime[], created: FolderRuntime): Promise<void> {
    try {
      await this._reloadSettings();
      await this._unlistBrokenPlugin(pi, folders, created);
    } catch (err) {
      log('[PiRuntime] subscription load check failed (%s): %O', created.cwd, err);
    }
  }

  /**
   * Unlist every subscription plugin and fall back to pi-ai's built-in anthropic provider (extra usage).
   * Settings change before any directory is deleted, so a Windows EPERM on the clone cannot leave the
   * plugin listed.
   */
  private async _removeSubscriptionPlugin(pi: PiCodingAgentModule, folders: readonly FolderRuntime[]): Promise<void> {
    const pm = this._packageManager(pi);
    await this._writeUserSettings(() => {
      pm.removeSourceFromSettings(SUBSCRIPTION_SOURCE);
      for (const repo of LEGACY_SUBSCRIPTION_REPOS) pm.removeSourceFromSettings(repo);
    });
    try {
      const cloneDir = pm.getInstalledPath(SUBSCRIPTION_SOURCE, 'user');
      if (cloneDir) {
        // pi's removeGit uses a single non-retrying rmSync, which hits EPERM on Windows.
        await forceRemoveDir(cloneDir);
        await pm.remove(SUBSCRIPTION_SOURCE);
      }
    } catch (err) {
      log('[PiRuntime] subscription clone delete failed: %O', err);
    }
    await this._evictLegacyClones(pm);
    log('[PiRuntime] removed subscription plugin');
    await this._reloadAfterUnlist(folders);
  }

  /**
   * The Background model (`resolveBackgroundModel`) and its explicit effort. `null` until a folder runtime exists:
   * subscription plugin providers are flushed into the model runtime when the first folder's services are created.
   */
  private _resolveBackgroundModel(): SubCallModel | null {
    const registry = this.modelLookup;
    if (!registry || this._folders.size === 0) return null;
    return resolveBackgroundModel(registry, this._platform.settings, this.getOpenAIAuthStatus(), this.preferOpenAIApiKey());
  }

  /** The one place a structured sub-call's model is chosen by purpose: the judging jobs follow the Memory judge, the rest the Background model. */
  private subCallModelFor(purpose: StructuredSubCallPurpose): SubCallModel | null {
    if (purpose !== 'memory-merge' && purpose !== 'memory-rerank') return this._resolveBackgroundModel();
    const judge = this.resolveMemoryJudge();
    if (judge.kind === 'classifier') return judge.fallback;
    if (judge.kind === 'none') return null;
    return judge.effort === undefined ? { model: judge.model } : { model: judge.model, effort: judge.effort };
  }

  /** Whether a sub-call of `purpose` has a signed-in model (lets callers tell no-auth from a transient miss). */
  hasAuthedSubCallModel(purpose: StructuredSubCallPurpose): boolean {
    return this.subCallModelFor(purpose) !== null;
  }

  /**
   * Key providers whose applied key bills a flat subscription (on a daemon's core, the pinned client's); empty before the
   * model runtime exists. Every account and billing read passes here, so it also picks up a prefer flag another window changed.
   */
  flatFeeKeyProviders(): ReadonlySet<string> {
    if (!this._modelRuntime) return new Set();
    // The flag decides only between a key and a sign-in, so a provider with no sign-in cannot change billing through it.
    for (const def of KEYED_PROVIDER_DEFS) if (def.signIn) this.preferProviderApiKey(def.provider);
    return flatFeeKeyProviders(this._modelRuntime, this._platform.remote);
  }

  /**
   * Where the credential pi sends `provider` comes from when Damocles did not apply it, or null. pi reports Damocles'
   * runtime key ahead of any other, and a models.json key naming an environment variable as `environment` (model-runtime.js:441-450).
   * A stored sign-in is no key, and pi resolves it before an environment or models.json key, so it reads as none.
   */
  externalKeySource(provider: string, signIns: ProviderSignIns | undefined = readProviderSignIns(this._agentDir)): ExternalKeySource | null {
    const status = this._modelRuntime?.getProviderAuthStatus(provider);
    if (!status?.configured || status.source === 'runtime') return null;
    if (signIns?.[provider]?.type === 'oauth') return null;
    return status.source === 'environment' ? 'environment' : 'piConfig';
  }

  /**
   * The model a memory audit sub-call would use now, with its API rates in USD per million tokens,
   * whether its credential bills dollars, and the level it thinks at (unclamped until pi-ai has loaded).
   * `null` when no sub-call model is configured.
   */
  describeSubCallModel(): { provider: string; id: string; inputPerMTok: number; outputPerMTok: number; dollarBilled: boolean; effort: ModelThinkingLevel } | null {
    const choice = this.subCallModelFor('memory-audit');
    if (!choice) return null;
    const { model } = choice;
    const level = subCallLevel('memory-audit', choice.effort);
    const clamp = loadedPiAi()?.clampThinkingLevel;
    const effort = clamp ? clamp(model, level) : model.reasoning ? level : 'off';
    // The API key and ChatGPT share `openai`, so the provider alone does not name the credential; the rule does.
    const dollarBilled = piModelDollarBilled(model, {
      supportedModels: piSupportedModels(),
      claudeAuthMode: this.getClaudeAuthStatus().mode,
      openai: this.getOpenAIAuthStatus(),
      preferApiKey: this.preferOpenAIApiKey(),
      registry: this.modelLookup ?? undefined,
      flatFeeKeyProviders: this.flatFeeKeyProviders(),
    });
    return { provider: model.provider, id: model.id, inputPerMTok: model.cost.input, outputPerMTok: model.cost.output, dollarBilled, effort };
  }

  /**
   * Run a one-shot structured-output completion on the model `subCallModelFor` picks for its purpose.
   * Used by titles and memory's internal sub-calls (query expansion, rerank, extraction). Resolves to
   * `unreachable` when no provider is authed or the model never saw the request (cause `credential` when
   * the credential is missing or refused), `rejected` when the
   * provider refused the request as sent, and `unanswered` when the model replied without a valid
   * result, so memory degrades gracefully.
   * Inference runs through `ModelRuntime.completeSimple`, which resolves the request credential
   * (OAuth bearer token or API key, incl. refresh) and provider headers itself.
   */
  runStructuredCompletion<T>(req: StructuredCompletionRequest): Promise<StructuredCompletionResult<T>> {
    return runPinnedSubcall(this._platform.remote, () => this._runStructuredCompletion<T>(req));
  }

  private async _runStructuredCompletion<T>(req: StructuredCompletionRequest): Promise<StructuredCompletionResult<T>> {
    // Only run once a session's folder runtime is live. We do NOT boot pi here — sub-calls happen
    // during/after a session, so a folder exists in practice; this keeps background memory tasks
    // fail-soft (and never spins up pi from a test). Fully guarded.
    try {
      const modelRuntime = this._modelRuntime;
      const choice = this.subCallModelFor(req.purpose);
      if (!modelRuntime || !choice) return UNREACHABLE;
      const { model } = choice;
      // Fail soft when the model's provider has no configured credential (mirrors the old "no API key"
      // guard) — completeSimple would otherwise error trying to resolve auth.
      if (!modelRuntime.hasConfiguredAuth(model.provider)) {
        log('[PiRuntime] runStructuredCompletion: no configured credential for provider %s', model.provider);
        return CREDENTIAL_REFUSED;
      }
      // Without the clamp no level can be sent, and a request with none runs a Claude model that cannot disable thinking at high effort.
      const piAi = await loadPiAi();
      if (!piAi) {
        log('[PiRuntime] runStructuredCompletion: pi-ai unavailable, sub-call %s skipped', req.purpose);
        return UNREACHABLE;
      }
      const reasoning = subCallReasoning(piAi.clampThinkingLevel, model, subCallLevel(req.purpose, choice.effort));
      const complete: PiCompleteFn = async (m, c, o) => {
        const startedAt = performance.now();
        const message = await modelRuntime.completeSimple(m, c, { ...o, ...(reasoning ? { reasoning } : {}) });
        const elapsedMs = Math.round(performance.now() - startedAt);
        if (elapsedMs >= SLOW_SUB_CALL_MS || message.stopReason === 'error' || message.stopReason === 'aborted') {
          log('[PiRuntime] sub-call %s on %s/%s at %s ended with %s in %dms', req.purpose, m.provider, m.id, reasoning ?? 'off', message.stopReason, elapsedMs);
        }
        // Billed whatever the stop reason; a throw carries no usage to record.
        appendSubCallUsage(message, req.purpose, this._billedTo(message.provider, req.attribution));
        return message;
      };
      // pi resolves the credential exactly as completeSimple did; only its error code is read, never its text.
      const credentialRefused: CredentialRefused = async () => {
        try {
          return (await modelRuntime.getAuth(model, req.abortSignal ? { signal: req.abortSignal } : {})) === undefined;
        } catch (err) {
          return isPiCredentialError(err);
        }
      };
      return await runStructuredCompletion<T>(complete, model, req, piAi.isRetryableAssistantError, credentialRefused);
    } catch (err) {
      log('[PiRuntime] runStructuredCompletion failed: %s', describeAuthError(err));
      return UNREACHABLE;
    }
  }

  /** The OpenAI inputs of one judge resolution, read once: the status reads auth.json synchronously, retrying with sleeps. */
  private _openaiAuthInputs(): OpenAIAuthInputs {
    return { status: this.getOpenAIAuthStatus(), preferApiKey: this.preferOpenAIApiKey() };
  }

  /** Whether `provider`'s credential can serve a classifier: OpenAI only while its request credential is the API key. */
  private _classifierCredential(provider: ClassifierProvider, openai: OpenAIAuthInputs): ClassifierCredential {
    const registry = this._modelRuntime;
    if (!registry) return 'no-key';
    return classifierCredential(provider, this._hasCredential(registry), openai);
  }

  /**
   * Whether a provider has a credential. On a daemon's core it is the pinned (else acting) client's, read from its
   * clientAuth at once, or the target's own, which only pi's snapshot knows; that snapshot also counts the acting client's
   * credentials (its status reads), so a provider that client holds counts only for its own views.
   */
  private _hasCredential(registry: ModelRuntime): (provider: string) => boolean {
    const remote = this._platform.remote;
    return remote
      ? (provider) => clientHasAuth(remote, provider) || this.hostHasOwnAuth(provider)
      : (provider) => registry.hasConfiguredAuth(provider);
  }

  /** The vendors the chat's model picker lists: each one the setting names, else each with a credential (`_hasCredential`); undefined before the model runtime exists. */
  pickerProviders(): ModelVendor[] | undefined {
    const registry = this._modelRuntime;
    if (!registry) return undefined;
    const configured = this._hasCredential(registry);
    const stored = this._platform.settings.get<unknown>(MODEL_PICKER_SETTING, {});
    const explicit = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
    return MODEL_VENDORS.filter((vendor) => {
      const shown = explicit[vendor];
      return typeof shown === 'boolean' ? shown : vendorPiProviders(vendor).some(configured);
    });
  }

  /** Each classifier provider's credential, for the Memory judge choices. */
  classifierCredentials(): Record<ClassifierProvider, ClassifierCredential> {
    const openai = this._openaiAuthInputs();
    return Object.fromEntries(CLASSIFIER_MODELS.map(({ provider }) => [provider, this._classifierCredential(provider, openai)])) as Record<ClassifierProvider, ClassifierCredential>;
  }

  /**
   * The Memory judge, through `damocles.memory.judge*` (user settings only). Automatic is the first classifier whose
   * credential serves it, whose breaker `isOpen` does not report and whose model is in the catalog, else Automatic's small model. A chosen classifier
   * or model that cannot run gives `none`, never another judge. Models need a folder runtime, as the Background model does.
   */
  private _resolveMemoryJudge(isOpen: (provider: ClassifierProvider) => boolean, openai: OpenAIAuthInputs): MemoryJudgeResolution {
    const registry = this._modelRuntime;
    const settings = this._platform.settings;
    const choice = migrateLegacyModelValue(settings.get<string>(MEMORY_JUDGE_SETTING, ''));
    if (!isKnownMemoryJudgeChoice(choice)) return { kind: 'none', forced: { choice, reason: 'unrecognized' } };
    const models = this._folders.size > 0 ? this.modelLookup : null;
    const classifierOf = (ref: ClassifierModelRef) => registry?.getModelOfType('classifier', ref.provider, ref.id);
    if (choice === '') {
      const automatic = models ? resolveAutomaticModel(models, openai.status, openai.preferApiKey) : null;
      const ref = pickClassifierModel(
        (candidate) => this._classifierCredential(candidate.provider, openai) === 'ok' && !isOpen(candidate.provider) && classifierOf(candidate) !== undefined,
      );
      const model = ref ? classifierOf(ref) : undefined;
      if (ref && model) return { kind: 'classifier', ref, model, fallback: automatic };
      return automatic ? { kind: 'model', ...automatic } : { kind: 'none' };
    }
    const forcedProvider = forcedClassifierOf(choice);
    if (forcedProvider) {
      const credential = this._classifierCredential(forcedProvider, openai);
      if (credential !== 'ok') return { kind: 'none', forced: { choice, reason: credential } };
      if (isOpen(forcedProvider)) return { kind: 'none', forced: { choice, reason: 'rejected' } };
      const ref = classifierModelOf(forcedProvider);
      const model = classifierOf(ref);
      return model ? { kind: 'classifier', ref, model, fallback: null } : { kind: 'none', forced: { choice, reason: 'not-in-catalog' } };
    }
    if (!models) return { kind: 'none', forced: { choice, reason: 'signed-out' } };
    const picked = resolvePickedModel(choice, settings.get<string>(MEMORY_JUDGE_EFFORT_SETTING, ''), models, openai.status, openai.preferApiKey);
    return 'unavailable' in picked ? { kind: 'none', forced: { choice, reason: picked.unavailable } } : { kind: 'model', ...picked };
  }

  /** The Memory judge the next merge or rerank runs on; a breaker past its cooldown admits its probe. */
  resolveMemoryJudge(): MemoryJudgeResolution {
    return this._resolveMemoryJudge((provider) => !this._classifierBreakers.admits(provider), this._openaiAuthInputs());
  }

  /** Whether the memory judges may send their next request to a classifier. */
  hasClassifier(): boolean {
    return this.resolveMemoryJudge().kind === 'classifier';
  }

  /**
   * The judge the next merge or rerank runs on, for the settings status line: the same resolution, so a provider due
   * for its probe is named as the judge, and the fallback while the probe is in flight. `rejected` lists every other
   * configured provider whose refusal stands.
   */
  describeMemoryJudge(): MemoryJudge {
    const openai = this._openaiAuthInputs();
    const judge = this._resolveMemoryJudge((provider) => !this._classifierBreakers.admits(provider), openai);
    const judgedBy = judge.kind === 'classifier' ? judge.ref.provider : undefined;
    const rejected = CLASSIFIER_MODELS.flatMap(({ provider }) => {
      if (provider === judgedBy || this._classifierCredential(provider, openai) !== 'ok') return [];
      const reason = this._classifierBreakers.rejection(provider);
      return reason ? [{ via: provider, reason }] : [];
    });
    if (judge.kind === 'classifier') return memoryJudgeOf(judge.ref, null, rejected);
    if (judge.kind === 'model') return memoryJudgeOf(null, judge.model, rejected);
    return memoryJudgeOf(null, null, rejected, judge.forced);
  }

  /**
   * Whether `describeMemoryJudge()` reflects the credentials: the stored keys were applied once, and a folder
   * runtime exists, which the sub-call model needs.
   */
  get memoryJudgeKnown(): boolean {
    return this._modelRuntime !== null && this._folders.size > 0 && this._customProvidersSynced;
  }

  /** The user saved `provider`'s key again: a 402 can clear with the same key, so the refusal no longer stands. */
  resetClassifierBreaker(provider: string): void {
    this._classifierBreakers.reset(provider);
  }

  /**
   * One classification on the Memory judge's classifier through `ModelRuntime.classify()`. Resolves to the answers,
   * or `null` when the judge is no classifier, the request did not stop normally, or an answer is missing; never throws.
   * Appends a ledger line whenever the service reported usage, including for a failed request.
   */
  runClassification(req: ClassificationRequest): Promise<Record<string, ClassifierAnswer> | null> {
    return runPinnedSubcall(this._platform.remote, () => this._runClassification(req));
  }

  private async _runClassification(req: ClassificationRequest): Promise<Record<string, ClassifierAnswer> | null> {
    const modelRuntime = this._modelRuntime;
    const picked = this.resolveMemoryJudge();
    if (!modelRuntime || picked.kind !== 'classifier') return null;
    // Claimed in the same tick as the pick, so a breaker past its cooldown hands out exactly one probe.
    const ticket = this._classifierBreakers.claim(picked.ref.provider);
    let outcome: ClassifierOutcome = { kind: 'failed' };
    try {
      const deadline = AbortSignal.timeout(req.timeoutMs);
      const signal = req.abortSignal ? AbortSignal.any([req.abortSignal, deadline]) : deadline;
      const result = await modelRuntime.classify(picked.model, { state: req.state, questions: req.questions }, { signal, timeoutMs: req.timeoutMs });
      if (result.usage) {
        appendSubCallUsage({ provider: result.provider, model: result.model, stopReason: result.stopReason, usage: result.usage }, req.purpose, this._billedTo(result.provider));
      }
      if (result.stopReason !== 'stop') {
        const rejection = isInputRefusal(result.errorMessage) ? null : credentialRejectionOf(httpStatusOf(result.errorMessage));
        if (rejection) outcome = { kind: 'rejected', reason: rejection };
        log(
          '[PiRuntime] runClassification (%s) on %s/%s ended with %s: %s',
          req.purpose, result.provider, result.model, result.stopReason, classifierFailureCause(result.errorMessage),
        );
        return null;
      }
      outcome = { kind: 'answered' };
      for (const [id, question] of Object.entries(req.questions)) {
        if (!Object.hasOwn(result.answers, id) || result.answers[id]?.type !== question.type) return null;
      }
      return result.answers;
    } catch (err) {
      log('[PiRuntime] runClassification failed: %s', describeAuthError(err));
      return null;
    } finally {
      const before = this._classifierBreakers.rejection(ticket.provider);
      this._classifierBreakers.settle(ticket, outcome);
      const after = this._classifierBreakers.rejection(ticket.provider);
      if (after !== undefined && after !== before) {
        log('[PiRuntime] memory judges skip %s (%s) until its key changes or a probe in %d min succeeds', ticket.provider, after, CLASSIFIER_PROBE_AFTER_MS / 60_000);
      }
    }
  }

  async dispose(): Promise<void> {
    this._disposed = true;
    // Cancel any in-flight credential sync so a closing window releases the auth.json lock at once.
    this._syncAbort.abort();
    // Every input first, so nothing arriving while the rest winds down reaches the runtime; init installs none after this.
    this._releaseInputs();
    if (this._initPromise) {
      try {
        await this._initPromise;
      } catch {
        // init failure already surfaced to its own caller
      }
    }
    const pending = [...this._folderPromises.values()];
    this._folderPromises.clear();
    this._folders.clear();
    for (const creation of pending) {
      let folder: FolderRuntime;
      try {
        folder = await creation;
      } catch {
        // creation failure already surfaced to its own caller
        continue;
      }
      await folder.dispose();
    }
    if (this._userMcp) {
      try {
        await this._userMcp.dispose();
      } catch (err) {
        log('[PiRuntime] MCP client dispose error: %O', err);
      }
    }
    this._userMcp = null;
    // OAuth state is process-global; only after every manager is gone can no login still need it.
    try {
      await shutdownOAuth();
    } catch (err) {
      log('[PiRuntime] OAuth shutdown error: %O', err);
    }
    try {
      await removeSavedMcpOutputs();
    } catch (err) {
      log('[PiRuntime] Removing saved MCP outputs failed: %O', err);
    }
    this._modelRuntime = null;
    this._userSettings = null;
    this._initPromise = null;
  }

  /** The watchers, listeners, timers and token broker the runtime made; the broker drops every device's credentials it held. */
  private _releaseInputs(): void {
    this._broker?.dispose();
    this._broker = null;
    this._openaiKeyListener?.dispose();
    this._openaiKeyListener = null;
    if (this._userDebounce) {
      clearTimeout(this._userDebounce);
      this._userDebounce = null;
    }
    for (const watcher of this._userWatchers) watcher.dispose();
    this._userWatchers.length = 0;
    this._authWatch?.dispose();
    this._authWatch = null;
    this._classifierBreakers.dispose();
    this._secretsListener?.dispose();
    this._secretsListener = null;
    this._clientsListener?.dispose();
    this._clientsListener = null;
    this._trustListener?.dispose();
    this._trustListener = null;
    this._imageSettingsListener?.dispose();
    this._imageSettingsListener = null;
    this._toolExposureListener?.dispose();
    this._toolExposureListener = null;
    this._disabledToolsListener?.dispose();
    this._disabledToolsListener = null;
    this._resourceExposureListener?.dispose();
    this._resourceExposureListener = null;
    this._assetPrecedenceListener?.dispose();
    this._assetPrecedenceListener = null;
  }
}
