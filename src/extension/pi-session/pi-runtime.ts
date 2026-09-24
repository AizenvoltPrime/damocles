import type { ModelRuntime, PackageManager, PackageSource, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { Model, Api, AuthInteraction } from '@earendil-works/pi-ai';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from '../logger';
import { initPiLoader, getPiCodingAgent, type PiCodingAgentModule } from './pi-loader';
import { cacheWarmingSetting, ensurePiAgentDir, PI_AGENT_DIR } from './agent-dir';
import { CONTEXT_FILE_CANDIDATES } from './context-files';
import { assetSources } from '../asset-sources';
import { renamePiSession } from './session-store';
import { McpClientManager } from './mcp/mcp-client-manager';
import { createMcpAuthProviderFactory, shutdownOAuth } from './mcp/mcp-auth-flow';
import { resolvePiModel, PI_SMALL_FAST_ANTHROPIC, PI_SMALL_FAST_OPENAI } from './pi-models';
import { syncCustomProviders, resolveExploreSectionModel, exploreThinkingLevel, type SecretResolver } from './custom-providers';
import { describeAuthError } from './describe-error';
import { isAbortError } from './web-access/util';
import { runStructuredCompletion, type PiCompleteFn, type StructuredCompletionRequest } from './structured-completion';
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
  OPENAI_API_PROVIDER,
  OPENAI_CODEX_PROVIDER,
  OPENAI_CODEX_BROWSER_LOGIN,
  readOpenAIAuthFromDisk,
  type OpenAIAuthStatus,
} from './openai-auth';
import { FolderRuntime, type ExtensionLoadError } from './folder-runtime';
import { folderKey } from '../workspace-folders/folder-key';

/**
 * How long the custom-provider credential sync may block before it is cancelled. The sync is offline
 * under 0.85, so the only blocking I/O left is the `auth.json` / `models-store.json` locks, shared with
 * every other VS Code window and any `pi` CLI, while this gates all user input at startup. Not a user
 * setting: it is not a value anyone can reason about correctly.
 */
const CUSTOM_PROVIDER_SYNC_TIMEOUT_MS = 3000;

/** An `AuthInteraction` that non-interactively answers every prompt with a fixed key — used to drive
 *  `ModelRuntime.login(provider, 'api_key', …)` from a key the user already supplied out-of-band. */
function keyInteraction(key: string): AuthInteraction {
  return { prompt: async () => key, notify: () => {} };
}

interface HotReloadResult {
  /** Provider name to the path of the extension whose registration succeeded. */
  registered: ReadonlyMap<string, string>;
  errors: readonly ExtensionLoadError[];
}

/** Every MCP manager, user or folder, gets the same OAuth wiring; elicitation is routed inside the manager. */
function newMcpManager(reservedPrefixes?: () => ReadonlySet<string>): McpClientManager {
  return new McpClientManager({
    authProviderFactoryBuilder: createMcpAuthProviderFactory,
    ...(reservedPrefixes ? { reservedPrefixes } : {}),
  });
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

/**
 * The live rename/tag surface a panel registers for its open session, so a mutation initiated from any
 * panel routes to the owning panel's live SessionManager rather than a second file-writer that would
 * fork the branch and drop messages (US-012). Satisfied structurally by `PiSession`.
 */
export interface LiveSessionMutator {
  renameActiveSession(newName: string): Promise<void>;
  setActiveSessionTag(tag: string | null): Promise<void>;
  /** Stop writing to the session because its file is being deleted; rejects if the panel could not
   *  let go, which must abort the delete rather than orphan a live writer on a removed path. */
  detachFromDeletedSession(): Promise<void>;
}

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

  private _initPromise: Promise<void> | null = null;
  private readonly _agentDir: string;
  private _modelRuntime: ModelRuntime | null = null;
  /** User-scope settings for package operations; the subscription plugin is only ever listed there. */
  private _userSettings: SettingsManager | null = null;
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
  private readonly _userWatchers: vscode.FileSystemWatcher[] = [];
  private _userDebounce: NodeJS.Timeout | null = null;
  /** Granting trust admits every folder's project layer, which needs a reload to reach its loader. */
  private _trustListener: vscode.Disposable | null = null;
  /** Cancels an in-flight custom-provider credential sync on dispose, so a closing window does not
   *  leave a credential operation running against the shared `auth.json` lock. */
  private readonly _syncAbort = new AbortController();
  private _disposed = false;

  private constructor(agentDir: string) {
    if (PiRuntime._instance) {
      throw new Error('PiRuntime already constructed — there must be exactly one per process (B1)');
    }
    this._agentDir = agentDir;
  }

  /** Get (lazily creating) the process-wide PiRuntime singleton. */
  static get(agentDir: string = PI_AGENT_DIR): PiRuntime {
    if (!PiRuntime._instance) {
      PiRuntime._instance = new PiRuntime(agentDir);
    }
    return PiRuntime._instance;
  }

  /** Whether the singleton has been created. */
  static get exists(): boolean {
    return PiRuntime._instance !== null;
  }

  /** Tear down and clear the singleton (extension deactivation and tests). */
  static async disposeInstance(): Promise<void> {
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

  /** Register/replace the live mutator for a panel's pi session (called on start + rebind). A panel
   *  that holds the session only as a not-yet-started resume or fork target has no entry here, so a
   *  caller that must reach every holder has to union this with that panel's session. */
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
      this._withProviderSync(() => this._createFolder(cwd, () => this._folderPromises.get(key) === created)),
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
      userMcp: this._userMcp,
      createFolderMcp: (reservedPrefixes) => newMcpManager(reservedPrefixes),
      renameSession: async (sessionId, sessionCwd, newName) => {
        const mutator = this.getSessionMutator(sessionId);
        if (mutator) await mutator.renameActiveSession(newName);
        else await renamePiSession(sessionCwd, sessionId, newName);
      },
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
    if (!this._pinReconciled) {
      this._pinReconciled = true;
      await this._reconcileSubscriptionPin(pi, folders, folder);
    } else {
      await this._unlistFailedPluginLoad(pi, folders, folder);
    }
    // A trust grant during creation reached only the folders already published.
    const settings = folder.services.settingsManager;
    if (vscode.workspace.isTrusted && !settings.isProjectTrusted()) {
      settings.setProjectTrusted(true);
      await folder.reloadBare().catch((err) => log('[PiRuntime] trust-grant reload failed (%s): %O', folder.cwd, err));
    }
    // A folder removed mid-creation stays out of the map; `disposeFolder` disposes it once this resolves.
    if (isCurrent()) this._folders.set(folder.key, folder);
    return folder;
  }

  /**
   * Watch the user-scope skill + command roots and the user-global instructions file
   * (`~/.damocles/AGENTS.md` and its siblings), and reload every folder's loader when they change: each
   * loader carries the user dirs and re-runs the context-file override on reload. A full reload, not
   * `extendResources`, because only a reload can drop a deleted resource.
   *
   * The user dirs sit outside every workspace folder, and a plain string glob reports no event from
   * there. Anchoring the pattern on the dir's own Uri is what makes these fire.
   */
  private _setupUserWatchers(): void {
    const onChange = () => {
      if (this._userDebounce) clearTimeout(this._userDebounce);
      this._userDebounce = setTimeout(() => {
        for (const folder of this.folders()) {
          folder.reloadBare().catch((err) => log('[PiRuntime] user asset watcher reload failed (%s): %O', folder.cwd, err));
        }
      }, 300);
    };
    for (const source of assetSources()) {
      for (const sub of [source.skills, source.commands]) {
        const userDir = vscode.Uri.file(path.join(os.homedir(), sub));
        this._userWatchers.push(vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(userDir, '**')));
      }
    }
    const globalContextDir = vscode.Uri.file(path.join(os.homedir(), '.damocles'));
    this._userWatchers.push(
      vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(globalContextDir, `{${CONTEXT_FILE_CANDIDATES.join(',')}}`),
      ),
    );
    for (const watcher of this._userWatchers) {
      watcher.onDidCreate(onChange);
      watcher.onDidChange(onChange);
      watcher.onDidDelete(onChange);
    }
  }

  /**
   * Load pi, seed the Damocles-owned agent dir, and create the shared model runtime, user settings and
   * MCP client. No folder services are built here; `folder()` builds them on demand.
   * Idempotent: concurrent and repeat callers share a single in-flight initialization.
   */
  init(): Promise<void> {
    if (this._disposed) return Promise.reject(new Error('PiRuntime has been disposed'));
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit().catch((err) => {
      this._initPromise = null;
      throw err;
    });
    return this._initPromise;
  }

  private async _doInit(): Promise<void> {
    const pi = await initPiLoader();
    if (!pi) throw new Error('PiRuntime.init: pi coding-agent failed to load');
    ensurePiAgentDir(this._agentDir, cacheWarmingSetting());
    this._modelRuntime = await pi.ModelRuntime.create({
      authPath: path.join(this._agentDir, 'auth.json'),
      modelsPath: path.join(this._agentDir, 'models.json'),
    });
    this._userSettings = pi.SettingsManager.create(this._agentDir, this._agentDir);
    // The manager loads the MCP SDK + eager-connects only once `setMcpServers` feeds it the enabled set.
    this._userMcp = newMcpManager();
    this._setupUserWatchers();
    // Folder settings managers were created with the trust state of their creation, which excluded the
    // project layer in a restricted window; each reload re-reads it once trusted.
    this._trustListener =
      vscode.workspace.onDidGrantWorkspaceTrust?.(() => {
        for (const folder of this.folders()) {
          folder.services.settingsManager.setProjectTrusted(true);
          folder.reloadBare().catch((err) => log('[PiRuntime] trust-grant reload failed (%s): %O', folder.cwd, err));
        }
      }) ?? null;
    log('[PiRuntime] initialized (agentDir=%s)', this._agentDir);
  }

  /**
   * Re-apply the active tool set to every open panel when `damocles.pi.webSearch.enabled` changes
   * (Phase 7). The web tools are native per-session tools built up front, so the toggle is purely an
   * active-set membership change — no install, no `resourceLoader.reload()`. Effective next turn.
   */
  async refreshWebSearch(): Promise<void> {
    if (this._disposed) return;
    await this.init();
    for (const folder of this.folders()) folder.refreshActiveTools();
  }

  /**
   * Register/authenticate the native custom providers (StepFun/OpenRouter/Gemini) on the shared registry
   * from the `damocles.explore.apiKey.*` secrets (Phase 5, US-018.8). Idempotent and fail-soft: called on
   * session start and on secret change so subagents can reach those models by explicit id (no loopback
   * proxy). No-op when the runtime is not yet initialized.
   *
   * Bounded and cancellable: pi's credential operations take cross-process locks and this gates startup,
   * so the sync is cancelled after `CUSTOM_PROVIDER_SYNC_TIMEOUT_MS` and on dispose. `timedOut` covers
   * the timeout leg only — a disposal abort is not a timeout — so callers can tell "nothing configured"
   * from "gave up", which is what lets `PiSession.start` surface a downgrade instead of hiding it.
   * `notWired` means "configured, but not live"; a provider in NEITHER list simply has no secret.
   */
  async syncCustomProviders(getSecret: SecretResolver): Promise<{ wired: string[]; notWired: string[]; timedOut: boolean }> {
    if (this._disposed || !this._modelRuntime) return { wired: [], notWired: [], timedOut: false };
    try {
      const { wired, aborted, notWired } = await syncCustomProviders({
        modelRuntime: this._modelRuntime,
        getSecret,
        signal: AbortSignal.any([this._syncAbort.signal, AbortSignal.timeout(CUSTOM_PROVIDER_SYNC_TIMEOUT_MS)]),
      });
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
    }
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
    const refreshed = await modelRuntime.refresh({ allowNetwork: false });
    for (const [provider, err] of refreshed.errors) log('[PiRuntime] hot-reload refresh: provider %s failed: %s', provider, describeAuthError(err));
    if (refreshed.aborted) log('[PiRuntime] hot-reload refresh aborted before completing');
    return { registered, errors };
  }

  /**
   * Store an Anthropic API key (bills the API account). Clears any OAuth grant first so the mode is
   * unambiguous.
   */
  async setAnthropicApiKey(key: string): Promise<ClaudeAuthStatus> {
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
    await this.folder(cwd);
    const pi = getPiCodingAgent();
    if (!pi) throw new Error('PiRuntime.setSubscriptionBilling: runtime not initialized');
    await this._setPluginInstalled(pi, useAllowance);
    log('[PiRuntime] subscription billing set (allowance=%s)', useAllowance);
    return this.getClaudeAuthStatus();
  }

  /** Clear any stored Anthropic credential (API key or OAuth grant). */
  async signOutAnthropic(): Promise<ClaudeAuthStatus> {
    if (this._modelRuntime) {
      await this._modelRuntime.logout('anthropic');
      log('[PiRuntime] anthropic signed out');
    }
    return this.getClaudeAuthStatus();
  }

  /** Current Claude auth mode (credential type + plugin presence). Read from disk (auth.json), which
   *  every login/logout persists before resolving — so it stays in lockstep with the stored grant. */
  getClaudeAuthStatus(): ClaudeAuthStatus {
    return readClaudeAuthFromDisk(this._agentDir);
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
   * Store an OpenAI API key (bills the API account). Independent of the codex OAuth grant — both can
   * be configured, and the settings panel chooses which to use via the prefer-api-key flag.
   */
  async setOpenAIApiKey(key: string): Promise<OpenAIAuthStatus> {
    await this.init();
    if (!this._modelRuntime) throw new Error('PiRuntime.setOpenAIApiKey: runtime not initialized');
    // `login` persists the api_key credential under 'openai' and refreshes; the 'openai-codex' grant
    // is a separate provider and is left intact.
    await this._modelRuntime.login(OPENAI_API_PROVIDER, 'api_key', keyInteraction(key));
    return this.getOpenAIAuthStatus();
  }

  /** Clear the stored OpenAI API key, leaving any codex OAuth grant intact. */
  async clearOpenAIApiKey(): Promise<OpenAIAuthStatus> {
    if (this._modelRuntime) {
      // `logout('openai')` clears only the API-key provider; 'openai-codex' is untouched.
      await this._modelRuntime.logout(OPENAI_API_PROVIDER);
      log('[PiRuntime] openai api key cleared');
    }
    return this.getOpenAIAuthStatus();
  }

  /**
   * Sign in to ChatGPT (Codex subscription) via pi's native codex OAuth. Unlike Anthropic, the codex
   * provider emits a `select` prompt to pick a login method — PiRuntime intercepts it and always
   * selects the browser / local-callback PKCE flow (127.0.0.1:1455), so the caller's interaction never
   * sees it; all other prompts/notifications delegate to the caller. pi owns the callback server, PKCE,
   * and token refresh.
   */
  async signInCodex(interaction: AuthInteraction): Promise<OpenAIAuthStatus> {
    await this.init();
    if (!this._modelRuntime) throw new Error('PiRuntime.signInCodex: runtime not initialized');
    const wrapped: AuthInteraction = {
      ...(interaction.signal ? { signal: interaction.signal } : {}),
      prompt: (prompt) => (prompt.type === 'select' ? Promise.resolve(OPENAI_CODEX_BROWSER_LOGIN) : interaction.prompt(prompt)),
      notify: (event) => interaction.notify(event),
    };
    await this._modelRuntime.login(OPENAI_CODEX_PROVIDER, 'oauth', wrapped);
    log('[PiRuntime] codex sign-in complete');
    return this.getOpenAIAuthStatus();
  }

  /** Clear the stored codex OAuth grant, leaving any OpenAI API key intact. */
  async signOutCodex(): Promise<OpenAIAuthStatus> {
    if (this._modelRuntime) {
      await this._modelRuntime.logout(OPENAI_CODEX_PROVIDER);
      log('[PiRuntime] codex signed out');
    }
    return this.getOpenAIAuthStatus();
  }

  /**
   * Current OpenAI auth state — API key and codex grant are reported independently. Derived strictly
   * from the Damocles-owned stored credentials on disk (auth.json), NOT pi's `hasConfiguredAuth`
   * (which also reports `true` for ambient `OPENAI_API_KEY` env vars / runtime overrides). Every
   * login/logout persists to auth.json before resolving, so reading disk keeps the live status in
   * lockstep and ensures `clearOpenAIApiKey` actually flips the reported state ("disk truth" contract).
   */
  getOpenAIAuthStatus(): OpenAIAuthStatus {
    return readOpenAIAuthFromDisk(this._agentDir);
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
        await this._settings().reload();
        await this._unlistMissingClone(pm, this.folders());
      });
      throw err;
    }
    return true;
  }

  /** Runs on `_providerSync`. `acquired`: the pinned clone was just downloaded and is not listed yet. */
  private async _applyPluginInstalled(pi: PiCodingAgentModule, installed: boolean, acquired: boolean): Promise<void> {
    await this._settings().reload();
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

  // pi queues settings writes and reports failures through drainErrors, never by throwing. A step must
  // not reload or delete on top of a write that never reached disk, because reload re-reads the disk.
  private async _flushSettings(): Promise<void> {
    const settings = this._settings();
    await settings.flush();
    const errors = settings.drainErrors();
    for (const err of errors) log('[PiRuntime] settings write failed (%s): %s', err.scope, err.error.message);
    const userErrors = errors.filter((e) => e.scope === 'global');
    if (userErrors.length > 0) throw new Error(`settings write failed: ${userErrors.map((e) => e.error.message).join('; ')}`);
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
    pm.removeSourceFromSettings(SUBSCRIPTION_SOURCE);
    await this._flushSettings();
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
        this._modelRuntime.unregisterProvider('anthropic');
        // `unregisterProvider`'s own refresh is fire-and-forget; the caller reports status right after.
        const refreshed = await this._modelRuntime.refresh({ allowNetwork: false });
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
    pm.addSourceToSettings(SUBSCRIPTION_SOURCE);
    for (const repo of LEGACY_SUBSCRIPTION_REPOS) pm.removeSourceFromSettings(repo);
    await this._flushSettings();

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

    pm.removeSourceFromSettings(SUBSCRIPTION_SOURCE);
    // Another window may have deleted a legacy clone meanwhile; relisting it would make pi re-clone it.
    const restorable = legacyEntries.filter((e) => pm.getInstalledPath(packageSourceString(e), 'user') !== undefined);
    if (restorable.length > 0) this._settings().setPackages([...this._userPackages(), ...restorable]);
    await this._flushSettings();
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
    pm.removeSourceFromSettings(SUBSCRIPTION_SOURCE);
    await this._flushSettings();
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
      await this._settings().reload();
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
      await this._settings().reload();
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
    pm.removeSourceFromSettings(SUBSCRIPTION_SOURCE);
    for (const repo of LEGACY_SUBSCRIPTION_REPOS) pm.removeSourceFromSettings(repo);
    await this._flushSettings();
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
   * Resolve the small/fast model for internal sub-calls (query expansion, rerank, memory
   * consolidation extraction + profile summaries). Prefers the Settings → Explore section model when
   * the user configured one (the same `damocles.explore.*` config the Explore subagent uses). Memory
   * work uses the explore MODEL but a fixed `medium` effort (injected in `runStructuredCompletion`),
   * NOT the user's Explore effort setting. Falls back to a Haiku-class model
   * when Anthropic is authed, else a mini-class model on an authed OpenAI path. `null` when nothing is
   * configured, so callers fail soft. Routed through `resolvePiModel`, so the fallback lands on the
   * canonical provider — never a gateway/reseller duplicate.
   *
   * Also `null` until a folder runtime exists: subscription plugin providers are flushed into the model
   * runtime when the first folder's services are created.
   */
  private _resolveSmallFastModel(): Model<Api> | null {
    const registry = this._modelRuntime;
    if (!registry || this._folders.size === 0) return null;
    const explore = resolveExploreSectionModel(registry);
    // The user's Explore effort setting intentionally does NOT apply to background memory sub-calls;
    // those run at a fixed medium (injected in runStructuredCompletion). Consume the model only.
    if (explore) return explore.model;
    const openai = this.getOpenAIAuthStatus();
    const anthropic = resolvePiModel(PI_SMALL_FAST_ANTHROPIC, registry, openai);
    if (anthropic.model && anthropic.authed) return anthropic.model;
    const openaiModel = resolvePiModel(PI_SMALL_FAST_OPENAI, registry, openai);
    if (openaiModel.model && openaiModel.authed) return openaiModel.model;
    return null;
  }

  /** Whether a small/fast sub-call model is currently authed (lets callers tell no-auth from a transient miss). */
  hasAuthedSubCallModel(): boolean {
    return this._resolveSmallFastModel() !== null;
  }

  /**
   * Run a one-shot structured-output completion on the small/fast model of the active provider.
   * Used by memory's internal sub-calls (query expansion, rerank, extraction). Resolves to
   * `null` when no provider is authed or the completion fails, so memory degrades gracefully.
   * Inference runs through `ModelRuntime.completeSimple`, which resolves the request credential
   * (OAuth bearer token or API key, incl. refresh) and provider headers itself.
   */
  async runStructuredCompletion<T>(req: StructuredCompletionRequest): Promise<T | null> {
    // Only run once a session's folder runtime is live. We do NOT boot pi here — sub-calls happen
    // during/after a session, so a folder exists in practice; this keeps background memory tasks
    // fail-soft (and never spins up pi from a test). Fully guarded.
    try {
      const modelRuntime = this._modelRuntime;
      const model = this._resolveSmallFastModel();
      if (!modelRuntime || !model) return null;
      // Fail soft when the model's provider has no configured credential (mirrors the old "no API key"
      // guard) — completeSimple would otherwise error trying to resolve auth.
      if (!modelRuntime.hasConfiguredAuth(model.provider)) {
        log('[PiRuntime] runStructuredCompletion: no configured credential for provider %s', model.provider);
        return null;
      }
      // pi thinking level for the fixed background `medium` — only a catalog custom-provider model
      // (step-3.7-flash today) yields one; Haiku/mini fallbacks yield undefined and pass no `reasoning`.
      // `off` maps to "no reasoning", so it is likewise not forwarded (also narrows the pi-agent-core
      // ThinkingLevel to the pi-ai one `completeSimple` accepts, which has no `off`).
      const reasoning = exploreThinkingLevel(model, 'medium');
      const complete: PiCompleteFn = (m, c, o) =>
        modelRuntime.completeSimple(m, c, {
          ...o,
          ...(reasoning && reasoning !== 'off' ? { reasoning } : {}),
        });
      return await runStructuredCompletion<T>(complete, model, req);
    } catch (err) {
      log('[PiRuntime] runStructuredCompletion failed: %s', describeAuthError(err));
      return null;
    }
  }

  async dispose(): Promise<void> {
    this._disposed = true;
    // Cancel any in-flight credential sync so a closing window releases the auth.json lock at once.
    this._syncAbort.abort();
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
    if (this._userDebounce) {
      clearTimeout(this._userDebounce);
      this._userDebounce = null;
    }
    for (const watcher of this._userWatchers) watcher.dispose();
    this._userWatchers.length = 0;
    this._trustListener?.dispose();
    this._trustListener = null;
    this._modelRuntime = null;
    this._userSettings = null;
    this._initPromise = null;
  }
}
