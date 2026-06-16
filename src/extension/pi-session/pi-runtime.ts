import type {
  AgentSession,
  AgentSessionServices,
  PackageManager,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { Model, Api, OAuthLoginCallbacks } from '@earendil-works/pi-ai';
import { log } from '../logger';
import { initPiLoader, getPiCodingAgent, type PiCodingAgentModule } from './pi-loader';
import { ensurePiAgentDir, PI_AGENT_DIR } from './agent-dir';
import { SUBSCRIPTION_SOURCE, type ClaudeAuthStatus } from './subscription';
import {
  OPENAI_API_PROVIDER,
  OPENAI_CODEX_PROVIDER,
  OPENAI_CODEX_BROWSER_LOGIN,
  type OpenAIAuthStatus,
} from './openai-auth';

/** Codex login callbacks supplied by the caller; `onSelect` is owned by PiRuntime (always browser). */
export type CodexLoginCallbacks = Omit<OAuthLoginCallbacks, 'onSelect'>;

export interface PiCreateSessionOptions {
  /** Working directory for the session. Defaults to the runtime's primary cwd. */
  cwd?: string;
  /** Model to run. When omitted, pi falls back to settings/first-available. */
  model?: Model<Api>;
  /** Damocles-supplied tools (Claude-Code-named), added to pi's built-ins. */
  customTools?: ToolDefinition[];
  /** pi built-in tool names to exclude (e.g. its lowercase bash/grep/find/ls). */
  excludeTools?: string[];
  /** When true, use an in-memory session store (no JSONL persistence). */
  ephemeral?: boolean;
}

function disposeSessionSafe(session: AgentSession): void {
  try {
    session.dispose();
  } catch (err) {
    log('[PiRuntime] session dispose error: %O', err);
  }
}

/**
 * The single per-process owner of pi's runtime (blocker B1).
 *
 * pi's API/OAuth provider registries are module-level process-global singletons; provider
 * registration happens once, during `createAgentSessionServices` (which loads extensions from
 * the agent dir and flushes their pending provider registrations). One Node process hosts every
 * VS Code extension and may host several Damocles windows/sessions, so exactly one PiRuntime
 * must own that registration. Multiple concurrent `AgentSession`s (Team agents, btw, subagents)
 * are expected and supported — they all share this runtime's one `AgentSessionServices`.
 *
 * Subscription auth is owned entirely by pi + the user-installed pi-anthropic-oauth plugin:
 * `signInSubscription` drives pi's native OAuth login and persists the grant; pi refreshes it
 * itself. Damocles never copies or refreshes the token, so the subscription is self-sufficient on
 * every platform and unaffected by removal of the Claude SDK.
 */
export class PiRuntime {
  private static _instance: PiRuntime | null = null;

  private _services: AgentSessionServices | null = null;
  private _initPromise: Promise<void> | null = null;
  private _primaryCwd: string;
  private readonly _agentDir: string;
  private readonly _sessions = new Set<AgentSession>();
  private _disposed = false;

  private constructor(primaryCwd: string, agentDir: string) {
    if (PiRuntime._instance) {
      throw new Error('PiRuntime already constructed — there must be exactly one per process (B1)');
    }
    this._primaryCwd = primaryCwd;
    this._agentDir = agentDir;
  }

  /** Get (lazily creating) the process-wide PiRuntime singleton. */
  static get(primaryCwd: string = process.cwd(), agentDir: string = PI_AGENT_DIR): PiRuntime {
    if (!PiRuntime._instance) {
      PiRuntime._instance = new PiRuntime(primaryCwd, agentDir);
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

  /** The shared services, or `null` before `init()` resolves. */
  get services(): AgentSessionServices | null {
    return this._services;
  }

  /**
   * Load pi, seed the Damocles-owned agent dir, and create the one shared services object.
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
    ensurePiAgentDir(this._agentDir);
    this._services = await pi.createAgentSessionServices({
      cwd: this._primaryCwd,
      agentDir: this._agentDir,
    });
    for (const diag of this._services.diagnostics) {
      log('[PiRuntime] services diagnostic (%s): %s', diag.type, diag.message);
    }
    log('[PiRuntime] initialized (agentDir=%s, cwd=%s)', this._agentDir, this._primaryCwd);
  }

  /**
   * Create an `AgentSession` from the shared services. Auto-compaction is force-disabled at the
   * session layer too (runtime half of B3, complementing the seeded settings.json).
   */
  async createSession(options: PiCreateSessionOptions = {}): Promise<AgentSession> {
    await this.init();
    const pi = getPiCodingAgent();
    if (!pi || !this._services) throw new Error('PiRuntime.createSession: runtime not initialized');

    const cwd = options.cwd ?? this._primaryCwd;
    const sessionManager = options.ephemeral
      ? pi.SessionManager.inMemory()
      : pi.SessionManager.create(cwd);

    const { session } = await pi.createAgentSessionFromServices({
      services: this._services,
      sessionManager,
      ...(options.model ? { model: options.model } : {}),
      ...(options.customTools ? { customTools: options.customTools } : {}),
      ...(options.excludeTools ? { excludeTools: options.excludeTools } : {}),
    });

    session.setAutoCompactionEnabled(false);
    this._sessions.add(session);
    return session;
  }

  /**
   * Re-discover extensions and register any newly-added providers into the LIVE services, without
   * recreating services or disposing in-flight sessions. Mirrors how `createAgentSessionServices`
   * flushes `pendingProviderRegistrations`, so installing the subscription plugin mid-session does
   * not tear down Team/btw/subagent conversations (B1: re-register providers on the shared registry).
   */
  private async _hotReloadExtensions(): Promise<void> {
    if (!this._services) return;
    await this._services.resourceLoader.reload();
    const extensionsResult = this._services.resourceLoader.getExtensions();
    for (const { name, config } of extensionsResult.runtime.pendingProviderRegistrations) {
      try {
        this._services.modelRegistry.registerProvider(name, config);
      } catch (err) {
        log('[PiRuntime] provider re-register failed (%s): %O', name, err);
      }
    }
    extensionsResult.runtime.pendingProviderRegistrations = [];
  }

  /**
   * Store an Anthropic API key (bills the API account). Clears any OAuth grant first so the mode is
   * unambiguous.
   */
  async setAnthropicApiKey(key: string): Promise<ClaudeAuthStatus> {
    await this.init();
    if (!this._services) throw new Error('PiRuntime.setAnthropicApiKey: runtime not initialized');
    this._services.authStorage.set('anthropic', { type: 'api_key', key });
    this._services.modelRegistry.refresh();
    return this.getClaudeAuthStatus();
  }

  /**
   * Sign in to the Claude Pro/Max subscription via pi's native OAuth (the `callbacks` open the
   * browser / collect a pasted code). `useAllowance` selects the billing bucket: with the plugin the
   * request looks like the Claude Code CLI (included allowance); without it pi-ai's built-in provider
   * meters the same token as extra usage. pi persists and refreshes the grant itself.
   */
  async signInSubscription(useAllowance: boolean, callbacks: OAuthLoginCallbacks): Promise<ClaudeAuthStatus> {
    await this.init();
    const pi = getPiCodingAgent();
    if (!pi || !this._services) throw new Error('PiRuntime.signInSubscription: runtime not initialized');

    await this._setPluginInstalled(pi, useAllowance);
    if (!this._services) throw new Error('PiRuntime.signInSubscription: services missing after plugin change');
    await this._services.authStorage.login('anthropic', callbacks);
    this._services.modelRegistry.refresh();
    log('[PiRuntime] subscription sign-in complete (allowance=%s)', useAllowance);
    return this.getClaudeAuthStatus();
  }

  /**
   * Switch the subscription billing bucket WITHOUT re-login: install/remove the plugin to flip
   * allowance ↔ extra usage on the already-stored token.
   */
  async setSubscriptionBilling(useAllowance: boolean): Promise<ClaudeAuthStatus> {
    await this.init();
    const pi = getPiCodingAgent();
    if (!pi || !this._services) throw new Error('PiRuntime.setSubscriptionBilling: runtime not initialized');
    await this._setPluginInstalled(pi, useAllowance);
    if (this._services) this._services.modelRegistry.refresh();
    log('[PiRuntime] subscription billing set (allowance=%s)', useAllowance);
    return this.getClaudeAuthStatus();
  }

  /** Clear any stored Anthropic credential (API key or OAuth grant). */
  signOutAnthropic(): ClaudeAuthStatus {
    if (this._services) {
      this._services.authStorage.logout('anthropic');
      this._services.modelRegistry.refresh();
      log('[PiRuntime] anthropic signed out');
    }
    return this.getClaudeAuthStatus();
  }

  /** Current Claude auth mode (credential type + plugin presence). */
  getClaudeAuthStatus(): ClaudeAuthStatus {
    const pi = getPiCodingAgent();
    if (!pi || !this._services) return { mode: 'none' };
    const credType = this._services.authStorage.get('anthropic')?.type;
    if (credType === 'api_key') return { mode: 'apikey' };
    if (credType === 'oauth') return { mode: this._isSubscriptionInstalled(pi) ? 'allowance' : 'extra' };
    return { mode: 'none' };
  }

  /**
   * Store an OpenAI API key (bills the API account). Independent of the codex OAuth grant — both can
   * be configured, and the settings panel chooses which to use via the prefer-api-key flag.
   */
  async setOpenAIApiKey(key: string): Promise<OpenAIAuthStatus> {
    await this.init();
    if (!this._services) throw new Error('PiRuntime.setOpenAIApiKey: runtime not initialized');
    this._services.authStorage.set(OPENAI_API_PROVIDER, { type: 'api_key', key });
    this._services.modelRegistry.refresh();
    return this.getOpenAIAuthStatus();
  }

  /** Clear the stored OpenAI API key, leaving any codex OAuth grant intact. */
  clearOpenAIApiKey(): OpenAIAuthStatus {
    if (this._services) {
      this._services.authStorage.remove(OPENAI_API_PROVIDER);
      this._services.modelRegistry.refresh();
      log('[PiRuntime] openai api key cleared');
    }
    return this.getOpenAIAuthStatus();
  }

  /**
   * Sign in to ChatGPT (Codex subscription) via pi's native codex OAuth. Unlike Anthropic, the codex
   * provider requires an `onSelect` callback to pick a login method — PiRuntime always selects the
   * browser / local-callback PKCE flow (127.0.0.1:1455). pi owns the callback server, PKCE, and token
   * refresh.
   */
  async signInCodex(callbacks: CodexLoginCallbacks): Promise<OpenAIAuthStatus> {
    await this.init();
    if (!this._services) throw new Error('PiRuntime.signInCodex: runtime not initialized');
    await this._services.authStorage.login(OPENAI_CODEX_PROVIDER, {
      ...callbacks,
      onSelect: async () => OPENAI_CODEX_BROWSER_LOGIN,
    });
    this._services.modelRegistry.refresh();
    log('[PiRuntime] codex sign-in complete');
    return this.getOpenAIAuthStatus();
  }

  /** Clear the stored codex OAuth grant, leaving any OpenAI API key intact. */
  signOutCodex(): OpenAIAuthStatus {
    if (this._services) {
      this._services.authStorage.logout(OPENAI_CODEX_PROVIDER);
      this._services.modelRegistry.refresh();
      log('[PiRuntime] codex signed out');
    }
    return this.getOpenAIAuthStatus();
  }

  /**
   * Current OpenAI auth state — API key and codex grant are reported independently. Derived strictly
   * from the Damocles-owned stored credentials (auth.json), NOT pi's `hasAuth`/`has` (which also
   * report `true` for ambient `OPENAI_API_KEY` env vars / runtime overrides). This keeps the live
   * status in lockstep with `readOpenAIAuthFromDisk` and ensures `clearOpenAIApiKey` actually flips
   * the reported state.
   */
  getOpenAIAuthStatus(): OpenAIAuthStatus {
    if (!this._services) return { apiKey: false, codex: false };
    const apiCred = this._services.authStorage.get(OPENAI_API_PROVIDER);
    const codexCred = this._services.authStorage.get(OPENAI_CODEX_PROVIDER);
    return {
      apiKey: apiCred?.type === 'api_key',
      codex: codexCred?.type === 'oauth',
      ...(codexCred?.type === 'oauth' ? { codexExpires: codexCred.expires } : {}),
    };
  }

  /** Install (allowance) or remove (extra usage) the pi-anthropic-oauth plugin to match the target. */
  private async _setPluginInstalled(pi: PiCodingAgentModule, installed: boolean): Promise<void> {
    const installedNow = this._isSubscriptionInstalled(pi);
    if (installed && !installedNow) await this._installSubscriptionPlugin(pi);
    else if (!installed && installedNow) await this._removeSubscriptionPlugin(pi);
  }

  private _packageManager(pi: PiCodingAgentModule): PackageManager {
    if (!this._services) throw new Error('PiRuntime._packageManager: runtime not initialized');
    return new pi.DefaultPackageManager({
      cwd: this._primaryCwd,
      agentDir: this._agentDir,
      settingsManager: this._services.settingsManager,
    });
  }

  private async _installSubscriptionPlugin(pi: PiCodingAgentModule): Promise<void> {
    await this._packageManager(pi).installAndPersist(SUBSCRIPTION_SOURCE);
    log('[PiRuntime] installed %s', SUBSCRIPTION_SOURCE);
    await this._hotReloadExtensions();
  }

  /**
   * Remove the plugin and restore pi-ai's built-in anthropic provider on the live registry, so the
   * stored OAuth token streams as `claude-cli/…` (extra usage). `unregisterProvider` drops the
   * plugin's override from `registeredProviders`; `refresh()` then resets to built-ins and re-applies
   * the remaining (plugin-free) provider set.
   */
  private async _removeSubscriptionPlugin(pi: PiCodingAgentModule): Promise<void> {
    if (!this._services) throw new Error('PiRuntime._removeSubscriptionPlugin: runtime not initialized');
    await this._packageManager(pi).removeAndPersist(SUBSCRIPTION_SOURCE);
    log('[PiRuntime] removed %s', SUBSCRIPTION_SOURCE);
    await this._services.resourceLoader.reload();
    this._services.modelRegistry.unregisterProvider('anthropic');
    this._services.modelRegistry.refresh();
  }

  /** Whether the pi-anthropic-oauth plugin is installed in pi's user scope. */
  private _isSubscriptionInstalled(pi: PiCodingAgentModule): boolean {
    if (!this._services) return false;
    try {
      return this._packageManager(pi).getInstalledPath(SUBSCRIPTION_SOURCE, 'user') !== undefined;
    } catch (err) {
      log('[PiRuntime] subscription-installed check failed: %O', err);
      return false;
    }
  }

  /** Stop tracking and dispose a session created by this runtime. */
  forgetSession(session: AgentSession): void {
    if (this._sessions.delete(session)) {
      disposeSessionSafe(session);
    }
  }

  async dispose(): Promise<void> {
    this._disposed = true;
    if (this._initPromise) {
      try {
        await this._initPromise;
      } catch {
        // init failure already surfaced to its own caller
      }
    }
    for (const session of this._sessions) disposeSessionSafe(session);
    this._sessions.clear();
    this._services = null;
    this._initPromise = null;
  }
}
