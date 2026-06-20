import type {
  AgentSession,
  AgentSessionServices,
  ExtensionFactory,
  PackageManager,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { Model, Api, OAuthLoginCallbacks } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log } from '../logger';
import { initPiLoader, initPiAiLoader, getPiCodingAgent, type PiCodingAgentModule } from './pi-loader';
import { ensurePiAgentDir, PI_AGENT_DIR } from './agent-dir';
import { createDamoclesExtensionFactory, type PanelRegistryReader, type CheckpointRegistryReader } from './damocles-extension';
import { McpClientManager } from './mcp/mcp-client-manager';
import { McpToolRegistrar } from './tools/mcp-tools';
import { createMcpAuthProviderFactory } from './mcp/mcp-auth-flow';
import type { PanelGateContext } from './permission-gate';
import type { CheckpointService } from './checkpoint-service';
import { resolvePiModel, PI_SMALL_FAST_ANTHROPIC, PI_SMALL_FAST_OPENAI } from './pi-models';
import { WorkspaceAgentRegistry } from './subagents';
import { syncCustomProviders, type SecretResolver } from './custom-providers';
import { runStructuredCompletion, type PiCompleteFn, type StructuredCompletionRequest } from './structured-completion';
import { SUBSCRIPTION_SOURCE, type ClaudeAuthStatus } from './subscription';
import {
  OPENAI_API_PROVIDER,
  OPENAI_CODEX_PROVIDER,
  OPENAI_CODEX_BROWSER_LOGIN,
  type OpenAIAuthStatus,
} from './openai-auth';

/** Codex login callbacks supplied by the caller; `onSelect` is owned by PiRuntime (always browser). */
export type CodexLoginCallbacks = Omit<OAuthLoginCallbacks, 'onSelect'>;

/**
 * `.claude` compat directories for a given resource kind ('skills' | 'commands') — project (`<cwd>/.claude`)
 * then user-global (`~/.claude`). Only existing dirs are returned so the loader never warns on a missing
 * one. Additive to pi-native dirs; pi-native sources outrank these on a name collision.
 */
function claudeCompatPaths(cwd: string, kind: 'skills' | 'commands'): string[] {
  return [path.join(cwd, '.claude', kind), path.join(os.homedir(), '.claude', kind)].filter((p) => existsSync(p));
}

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

/**
 * Inputs for a nested subagent session (Phase 5). The session reuses the parent runtime's
 * `authStorage` + `modelRegistry` (so auth and the curated model list propagate with no second
 * provider-registration pass) while carrying its OWN system prompt, tool allowlist, and a per-subagent
 * gate-routing extension factory.
 */
export interface PiCreateSubagentSessionOptions {
  cwd: string;
  /** The fully-built system prompt — `buildAgentPrompt` already merged the parent prompt for append mode. */
  systemPrompt: string;
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  /** Resolved Damocles active-set tool names (mixed-case; see resolveAgentToolset). */
  tools: string[];
  /** Damocles custom tool definitions (Edit, PowerShell, Task tools, memory/compass/browser). */
  customTools: ToolDefinition[];
  /** pi built-in tool names to exclude (always ['edit'] — replaced by the custom Edit). */
  excludeTools?: string[];
  /** The per-subagent gate-routing extension factory (createSubagentExtensionFactory). */
  extensionFactory: ExtensionFactory;
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
/**
 * The live rename/tag surface a panel registers for its open session, so a mutation initiated from any
 * panel routes to the owning panel's live SessionManager rather than a second file-writer that would
 * fork the branch and drop messages (US-012). Satisfied structurally by `PiSession`.
 */
export interface LiveSessionMutator {
  renameActiveSession(newName: string): Promise<void>;
  setActiveSessionTag(tag: string | null): Promise<void>;
}

export class PiRuntime {
  private static _instance: PiRuntime | null = null;

  private _services: AgentSessionServices | null = null;
  private _initPromise: Promise<void> | null = null;
  private _primaryCwd: string;
  private readonly _agentDir: string;
  private readonly _sessions = new Set<AgentSession>();
  /** Live nested subagent sessions (Phase 5), disposed on completion or on runtime dispose. */
  private readonly _subagentSessions = new Set<AgentSession>();
  /** Per-panel gate context, keyed by pi sessionId. The shared Damocles extension routes through it. */
  private readonly _panelRegistry = new Map<string, PanelGateContext>();
  /** Per-session checkpoint engine driver, keyed by pi sessionId (US-013b). Routed like the gate. */
  private readonly _checkpointRegistry = new Map<string, CheckpointService>();
  /** Per-session live rename/tag mutator, keyed by pi sessionId — lets a rename/tag from ANY panel
   *  route to the panel that owns the session (cross-panel anti-fork; US-012). */
  private readonly _sessionMutators = new Map<string, LiveSessionMutator>();
  /** The single workspace-level markdown-subagent source of truth (one watcher per agent dir), shared
   *  by every panel's subagent manager (Phase 5 §4.6). Built lazily — needs pi for `parseFrontmatter`. */
  private _workspaceAgents: WorkspaceAgentRegistry | null = null;
  /** Process/workspace-scoped MCP client (Phase 6), created in `_doInit`; eager-connects on setMcpServers. */
  private _mcpClientManager: McpClientManager | null = null;
  /** Registers MCP tools into the shared extension's live `pi` (reload-safe; mid-session top-up). */
  private _mcpRegistrar: McpToolRegistrar | null = null;
  /** Per-live-session active-set refreshers, keyed by pi sessionId — fired when MCP tools change. */
  private readonly _activeToolRefreshers = new Map<string, () => void>();
  /** Serializes resourceLoader reloads (web-search toggle + per-session refresh) so they can't race. */
  private _reloadSync: Promise<void> = Promise.resolve();
  /** Count of sessions bound off the shared services; the first uses the pristine init runtime. */
  private _sessionsCreated = 0;
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

  /** Register/replace the gate context for a panel's pi session (called on start + rebind). */
  registerPanel(sessionId: string, ctx: PanelGateContext): void {
    if (sessionId) this._panelRegistry.set(sessionId, ctx);
  }

  /** Drop a panel's gate context (called on session rebind for the old id, and on dispose). */
  unregisterPanel(sessionId: string): void {
    if (sessionId) this._panelRegistry.delete(sessionId);
  }

  /** Register/replace the checkpoint engine driver for a panel's pi session (US-013b). */
  registerCheckpointService(sessionId: string, service: CheckpointService): void {
    if (sessionId) this._checkpointRegistry.set(sessionId, service);
  }

  /** Drop a session's checkpoint driver (on session rebind for the old id, and on dispose). */
  unregisterCheckpointService(sessionId: string): void {
    if (sessionId) this._checkpointRegistry.delete(sessionId);
  }

  /** Register/replace the live rename/tag mutator for a panel's pi session (called on start + rebind). */
  registerSessionMutator(sessionId: string, mutator: LiveSessionMutator): void {
    if (sessionId) this._sessionMutators.set(sessionId, mutator);
  }

  /** Drop a session's live mutator (on session rebind for the old id, and on dispose). */
  unregisterSessionMutator(sessionId: string): void {
    if (sessionId) this._sessionMutators.delete(sessionId);
  }

  /** The live rename/tag mutator for a session currently open in some panel, or undefined if none. */
  getSessionMutator(sessionId: string): LiveSessionMutator | undefined {
    return this._sessionMutators.get(sessionId);
  }

  /** The process/workspace-scoped MCP client, or null before `init()` (Phase 6). */
  getMcpClientManager(): McpClientManager | null {
    return this._mcpClientManager;
  }

  /** Register a live session's active-tool refresher so MCP tool changes re-apply its active set. */
  registerActiveToolRefresher(sessionId: string, refresh: () => void): void {
    if (sessionId) this._activeToolRefreshers.set(sessionId, refresh);
  }

  /** Drop a session's active-tool refresher (on rebind for the old id, and on dispose). */
  unregisterActiveToolRefresher(sessionId: string): void {
    if (sessionId) this._activeToolRefreshers.delete(sessionId);
  }

  private _refreshAllActiveTools(): void {
    for (const refresh of this._activeToolRefreshers.values()) {
      try {
        refresh();
      } catch (err) {
        log('[PiRuntime] active-tool refresher threw: %O', err);
      }
    }
  }

  /** Reader handed to the shared extension factory so the process-global gate can route by sessionId. */
  private _panelRegistryReader(): PanelRegistryReader {
    return { get: (sessionId: string) => this._panelRegistry.get(sessionId) };
  }

  /** Reader handed to the extension factory so checkpoint lifecycle hooks route by sessionId. */
  private _checkpointRegistryReader(): CheckpointRegistryReader {
    return { get: (sessionId: string) => this._checkpointRegistry.get(sessionId) };
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

    // Phase 6: the process/workspace-scoped MCP client + its tool registrar. Created before services so
    // the shared extension factory can register MCP tools on every runtime (reload-safe). The manager
    // loads the MCP SDK + eager-connects only once `setMcpServers` feeds it the enabled set.
    this._mcpClientManager = new McpClientManager({ authProviderFactoryBuilder: createMcpAuthProviderFactory });
    this._mcpRegistrar = new McpToolRegistrar(pi, this._mcpClientManager);
    this._mcpClientManager.onToolsChanged(() => {
      this._mcpRegistrar?.syncRegistration();
      this._refreshAllActiveTools();
    });

    this._services = await pi.createAgentSessionServices({
      cwd: this._primaryCwd,
      agentDir: this._agentDir,
      // The single shared Damocles extension (permission gate + plan-mode injection + MCP tool
      // registration). Registered via the shared services so there is exactly one per process (B1); pi
      // re-applies extensionFactories on `resourceLoader.reload()`, so it survives reloads (FR-7).
      resourceLoaderOptions: {
        extensionFactories: [
          createDamoclesExtensionFactory(
            this._panelRegistryReader(),
            this._checkpointRegistryReader(),
            (extensionApi) => this._mcpRegistrar?.registerAll(extensionApi),
          ),
        ],
        // US-016: surface `.claude/skills` + `.claude/commands` (Claude Code commands = pi prompt
        // templates) as additional resource roots, additive to pi-native dirs (agentDir + cwd/.pi);
        // pi-native sources outrank these on a name collision.
        additionalSkillPaths: claudeCompatPaths(this._primaryCwd, 'skills'),
        additionalPromptTemplatePaths: claudeCompatPaths(this._primaryCwd, 'commands'),
        // Damocles does not support user-installed pi extensions: drop any configured in pi so leftover
        // packages can't load tools/commands or fire event handlers. The inline factory extension (the
        // Damocles extension itself — permission gate, checkpoint hooks, MCP registration; tagged
        // `<inline:…>`) MUST be preserved, so filter only the path-loaded packages. Skills/prompts load
        // normally. (Wiping the whole array silently disabled checkpoints/gate/MCP — never do that.)
        extensionsOverride: (base) => ({
          ...base,
          extensions: base.extensions.filter((e) => e.path.startsWith('<inline:')),
        }),
      },
    });
    for (const diag of this._services.diagnostics) {
      log('[PiRuntime] services diagnostic (%s): %s', diag.type, diag.message);
    }
    log('[PiRuntime] initialized (agentDir=%s, cwd=%s)', this._agentDir, this._primaryCwd);
  }

  /**
   * Re-apply the active tool set to every open panel when `damocles.pi.webSearch.enabled` changes
   * (Phase 7). The web tools are native per-session tools built up front, so the toggle is purely an
   * active-set membership change — no install, no `resourceLoader.reload()`. Effective next turn.
   */
  async refreshWebSearch(): Promise<void> {
    if (this._disposed) return;
    await this.init();
    this._refreshAllActiveTools();
  }

  /**
   * Refresh the shared extension runtime before a new `AgentSession` binds to it. pi binds every
   * session to the resourceLoader's single extension runtime (we share one services per process — B1),
   * and `AgentSession.dispose()` marks that runtime stale on session replacement (reset/clear →
   * `newSession`). Without a fresh runtime, the replacement session's extension-registered MCP tools
   * (`mcp__{server}__{tool}`) throw "extension ctx is stale". `reload()` mints a fresh runtime and
   * re-applies the Damocles extension factory (which re-registers MCP tools) (FR-7). `_sessionsCreated` is on the
   * process singleton, so only the process's first-ever session reuses the pristine `init()` runtime
   * and is skipped — every later session, including the first in a second panel, reloads. reload()
   * only swaps the loader's current runtime; it does NOT invalidate other panels' already-bound live
   * sessions (they keep their captured runner; invalidation happens solely on AgentSession.dispose()),
   * so the per-session reload is what gives concurrent panels runtime isolation. Serialized with
   * web-search toggles; non-fatal on error (a failed reload just risks the stale-ctx error rather than
   * aborting session creation).
   */
  async prepareSessionExtensions(): Promise<void> {
    await this.init();
    if (this._sessionsCreated++ === 0) return;
    this._reloadSync = this._reloadSync
      .then(async () => {
        if (this._disposed || !this._services) return;
        await this._services.resourceLoader.reload();
      })
      .catch((err) => log('[PiRuntime] per-session extension reload failed (web tools may be unavailable): %O', err));
    await this._reloadSync;
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
   * Create a nested subagent `AgentSession` (Phase 5, US-018.2). Builds per-subagent services that
   * REUSE the parent runtime's `authStorage` + `modelRegistry` (so auth and the curated model list
   * propagate; the provider-registration pass inside `createAgentSessionServices` only re-upserts the
   * already-present provider configs on the shared registry — no duplicate providers) while carrying
   * the subagent's own `systemPromptOverride`, tool allowlist, and gate-routing extension factory.
   *
   * `noContextFiles/noSkills/noPromptTemplates/noThemes` prevent AGENTS.md/CLAUDE.md re-appending after
   * the system-prompt override — required for `prompt_mode: replace` and read-only agents to behave.
   * The session uses an in-memory store (not persisted to the pi tree — v1) and has auto-compaction off.
   */
  async createSubagentSession(opts: PiCreateSubagentSessionOptions): Promise<AgentSession> {
    await this.init();
    const pi = getPiCodingAgent();
    if (!pi || !this._services) throw new Error('PiRuntime.createSubagentSession: runtime not initialized');

    // Isolate compaction (US-030): pi's auto-compaction flag lives on the settings manager, shared by
    // every session. A nested subagent/team/btw session must NEVER inherit the main panel's toggle, so
    // it gets its own in-memory settings manager seeded from the shared config with compaction forced off
    // (all other user settings — thinking budgets, packages, enabled models — are preserved).
    const shared = this._services.settingsManager;
    const isolatedSettings = pi.SettingsManager.inMemory({
      ...shared.getGlobalSettings(),
      ...shared.getProjectSettings(),
      compaction: { enabled: false },
    });

    const services = await pi.createAgentSessionServices({
      cwd: opts.cwd,
      agentDir: this._agentDir,
      authStorage: this._services.authStorage,
      modelRegistry: this._services.modelRegistry,
      settingsManager: isolatedSettings,
      resourceLoaderOptions: {
        extensionFactories: [opts.extensionFactory],
        systemPromptOverride: () => opts.systemPrompt,
        // Suppress the AGENTS.md/CLAUDE.md re-append that would otherwise follow systemPromptOverride.
        appendSystemPromptOverride: () => [],
        noContextFiles: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      },
    });
    for (const diag of services.diagnostics) {
      log('[PiRuntime] subagent services diagnostic (%s): %s', diag.type, diag.message);
    }

    const { session } = await pi.createAgentSessionFromServices({
      services,
      sessionManager: pi.SessionManager.inMemory(),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
      tools: opts.tools,
      customTools: opts.customTools,
      ...(opts.excludeTools ? { excludeTools: opts.excludeTools } : {}),
    });

    session.setAutoCompactionEnabled(false);
    this._subagentSessions.add(session);
    return session;
  }

  /** Dispose and forget a nested subagent session (called on completion / manager dispose). */
  forgetSubagentSession(session: AgentSession): void {
    if (this._subagentSessions.delete(session)) {
      disposeSessionSafe(session);
    }
  }

  /**
   * The single workspace-level markdown-subagent registry, built once on first access (Phase 5 §4.6).
   * Requires the runtime to be initialized and pi loaded (for `parseFrontmatter`). Shared by every
   * panel's subagent manager so there is exactly one source of truth and one watcher per agent dir.
   */
  getWorkspaceAgentRegistry(): WorkspaceAgentRegistry {
    if (!this._workspaceAgents) {
      const pi = getPiCodingAgent();
      if (!pi || !this._services) {
        throw new Error('PiRuntime.getWorkspaceAgentRegistry: runtime not initialized');
      }
      this._workspaceAgents = new WorkspaceAgentRegistry(this._primaryCwd, pi.parseFrontmatter);
    }
    return this._workspaceAgents;
  }

  /**
   * Register/authenticate the native custom providers (StepFun/OpenRouter/Gemini) on the shared registry
   * from the `damocles.explore.apiKey.*` secrets (Phase 5, US-018.8). Idempotent and fail-soft: called on
   * session start and on secret change so subagents can reach those models by explicit id (no loopback
   * proxy). No-op when the runtime is not yet initialized.
   */
  async syncCustomProviders(getSecret: SecretResolver): Promise<void> {
    if (this._disposed || !this._services) return;
    try {
      const wired = await syncCustomProviders({
        modelRegistry: this._services.modelRegistry,
        authStorage: this._services.authStorage,
        getSecret,
      });
      if (wired.length > 0) log('[PiRuntime] custom providers wired: %s', wired.join(', '));
    } catch (err) {
      log('[PiRuntime] syncCustomProviders failed (non-fatal): %O', err);
    }
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
    return this._isPackageInstalled(pi, SUBSCRIPTION_SOURCE);
  }

  /** Whether a package `source` is installed in pi's user scope (safe: false on any failure). */
  private _isPackageInstalled(pi: PiCodingAgentModule, source: string): boolean {
    if (!this._services) return false;
    try {
      return this._packageManager(pi).getInstalledPath(source, 'user') !== undefined;
    } catch (err) {
      log('[PiRuntime] installed check failed for %s: %O', source, err);
      return false;
    }
  }

  /**
   * Resolve the small/fast model for internal sub-calls (US-006b): a Haiku-class model when Anthropic
   * is authed, else a mini-class model when an OpenAI path is authed. `null` when no provider is
   * configured, so callers fail soft. Routed through `resolvePiModel`, so it lands on the canonical
   * provider — never a gateway/reseller duplicate.
   */
  private _resolveSmallFastModel(): Model<Api> | null {
    if (!this._services) return null;
    const registry = this._services.modelRegistry;
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
   * Run a one-shot structured-output completion on the small/fast model of the active provider
   * (US-006b). Used by memory's internal sub-calls (query expansion, rerank, extraction). Resolves to
   * `null` when no provider is authed or the completion fails, so memory degrades gracefully. The
   * pi-ai inference layer is loaded lazily on first use.
   */
  async runStructuredCompletion<T>(req: StructuredCompletionRequest): Promise<T | null> {
    // Only run when the runtime is already live (a session initialized the shared services). We do NOT
    // boot pi here — sub-calls happen during/after a session, so `_services` is set in practice; this
    // keeps background memory tasks fail-soft (and never spins up pi from a test). Fully guarded.
    try {
      if (!this._services) return null;
      const piAi = await initPiAiLoader();
      if (!piAi) return null;
      const model = this._resolveSmallFastModel();
      if (!model) return null;
      // `complete()` only auto-fills the API key from the environment (forbidden here); it does not
      // resolve OAuth grants. Resolve the request credential (OAuth bearer token or API key) + headers
      // the same way pi's agent session does, else subscription/allowance modes fail "No API key".
      const resolvedAuth = await this._services.modelRegistry.getApiKeyAndHeaders(model);
      if (!resolvedAuth.ok || !resolvedAuth.apiKey) {
        log('[PiRuntime] runStructuredCompletion: no resolved credential for provider %s', model.provider);
        return null;
      }
      return await runStructuredCompletion<T>(piAi.complete as PiCompleteFn, model, req, {
        apiKey: resolvedAuth.apiKey,
        ...(resolvedAuth.headers ? { headers: resolvedAuth.headers } : {}),
      });
    } catch (err) {
      log('[PiRuntime] runStructuredCompletion failed: %O', err);
      return null;
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
    for (const session of this._subagentSessions) disposeSessionSafe(session);
    this._subagentSessions.clear();
    this._workspaceAgents?.dispose();
    this._workspaceAgents = null;
    if (this._mcpClientManager) {
      try {
        await this._mcpClientManager.dispose();
      } catch (err) {
        log('[PiRuntime] MCP client dispose error: %O', err);
      }
    }
    this._mcpClientManager = null;
    this._mcpRegistrar = null;
    this._activeToolRefreshers.clear();
    this._services = null;
    this._initPromise = null;
  }
}
