import type {
  AgentSession,
  AgentSessionServices,
  ExtensionFactory,
  PackageManager,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { Model, Api, AuthInteraction } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from '../logger';
import { initPiLoader, getPiCodingAgent, type PiCodingAgentModule } from './pi-loader';
import { ensurePiAgentDir, PI_AGENT_DIR } from './agent-dir';
import { createDamoclesExtensionFactory, type PanelRegistryReader, type CheckpointRegistryReader } from './damocles-extension';
import { compatSources, type AssetSourcePrecedence } from '../asset-sources';
import { HooksConfigService, type DispatchDeps } from './hooks';
import { renamePiSession } from './session-store';
import { McpClientManager } from './mcp/mcp-client-manager';
import { isMcpToolName } from './mcp/naming';
import { McpToolRegistrar } from './tools/mcp-tools';
import { createMcpAuthProviderFactory } from './mcp/mcp-auth-flow';
import type { PanelGateContext } from './permission-gate';
import type { CheckpointService } from './checkpoint-service';
import { resolvePiModel, PI_SMALL_FAST_ANTHROPIC, PI_SMALL_FAST_OPENAI } from './pi-models';
import { WorkspaceAgentRegistry } from './subagents';
import { syncCustomProviders, resolveExploreSectionModel, exploreThinkingLevel, type SecretResolver } from './custom-providers';
import { runStructuredCompletion, type PiCompleteFn, type StructuredCompletionRequest } from './structured-completion';
import {
  SUBSCRIPTION_SOURCE,
  isStaleSubscriptionPin,
  readClaudeAuthFromDisk,
  type ClaudeAuthStatus,
} from './subscription';
import { forceRemoveDir } from './fs-remove';
import { TOOL_TOOL_SEARCH } from '../../shared/tool-names';
import { deferredToolNames, initialActiveToolNames } from './tools/deferred-tools';
import {
  OPENAI_API_PROVIDER,
  OPENAI_CODEX_PROVIDER,
  OPENAI_CODEX_BROWSER_LOGIN,
  readOpenAIAuthFromDisk,
  type OpenAIAuthStatus,
} from './openai-auth';

/** An `AuthInteraction` that non-interactively answers every prompt with a fixed key — used to drive
 *  `ModelRuntime.login(provider, 'api_key', …)` from a key the user already supplied out-of-band. */
function keyInteraction(key: string): AuthInteraction {
  return { prompt: async () => key, notify: () => {} };
}

/** An existing compat resource directory plus its source attribution (for pi's resource source info). */
interface CompatResourceEntry {
  path: string;
  source: AssetSourcePrecedence;
  scope: 'project' | 'user';
}

/**
 * Existing compat resource directories for a given kind ('skills' | 'commands') across every configured
 * source (`.claude` + `.codex`, ordered by `damocles.assetSourcePrecedence`), project (`<cwd>`) then
 * user-global (`~`) within each. Codex maps 'commands' → `.codex/prompts`. Only existing dirs are
 * returned so the loader never warns on a missing one. Additive to pi-native dirs; pi-native sources
 * outrank these, and earlier dirs in this list outrank later ones (pi's loader is first-wins on a name
 * collision).
 */
function compatResourceEntries(cwd: string, kind: 'skills' | 'commands'): CompatResourceEntry[] {
  const entries: CompatResourceEntry[] = [];
  for (const source of compatSources()) {
    const sub = kind === 'skills' ? source.skills : source.commands;
    entries.push({ path: path.join(cwd, sub), source: source.name, scope: 'project' });
    entries.push({ path: path.join(os.homedir(), sub), source: source.name, scope: 'user' });
  }
  return entries.filter((e) => existsSync(e.path));
}

function compatResourcePaths(cwd: string, kind: 'skills' | 'commands'): string[] {
  return compatResourceEntries(cwd, kind).map((e) => e.path);
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
 * `modelRuntime` (so auth and the curated model list propagate with no second provider-registration
 * pass) while carrying its OWN system prompt, tool allowlist, and a per-subagent gate-routing
 * extension factory.
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

/** A nested session has no durable activated set at construction — nothing has been activated yet. */
const NO_ACTIVATED_TOOLS: ReadonlySet<string> = new Set();

/**
 * Whether a session will bind the extension instance this reload mints. `'session-bound'` instances
 * retire themselves on `session_shutdown`; `'bare'` ones never receive it, so the runtime retires them
 * when the next reload supersedes them. Stated per call site because the reload itself does identical
 * work either way — the difference is only in what the caller does next.
 */
type ReloadBinding = 'session-bound' | 'bare';

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
  /** Stop writing to the session because its file is being deleted; rejects if the panel could not
   *  let go, which must abort the delete rather than orphan a live writer on a removed path. */
  detachFromDeletedSession(): Promise<void>;
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
  /** Config-driven hooks (loads/watches `~/.damocles/hooks.json` + `<ws>/.damocles/hooks.json`). */
  private _hooksConfig: HooksConfigService | null = null;
  /** Per-live-session active-set refreshers, keyed by pi sessionId — fired when MCP tools change. */
  private readonly _activeToolRefreshers = new Map<string, () => void>();
  /** Re-registers ToolSearch so pi re-wraps it and re-materializes its description getter. A SET, not a
   *  single slot: each reload mints a fresh instance while earlier panels keep their bound one, so a
   *  single slot would freeze every earlier panel's description — silently, its runtime being live
   *  rather than stale.
   *
   *  Retirement is deterministic, never inferred from a throw, and has exactly two owners:
   *  session-bound instances call their own disposer from `session_shutdown`; unbound ones (bare
   *  reload, or `_doInit` before any session exists) are held in `_unboundRepublisherDisposer` and
   *  retired by the runtime when superseded — or released if a session binds them after all. */
  private readonly _toolSearchRepublishers = new Set<() => void>();
  /** The disposer handed to the extension instance the loader currently holds, WHEN nothing has bound
   *  that instance. Non-null means "this instance is unowned: retire it when it is superseded". Null
   *  means the current instance is session-bound (or about to be) and owns its own retirement. */
  private _unboundRepublisherDisposer: (() => void) | null = null;
  /** Scratch slot letting a reload identify the instance IT just minted — the factory runs inside
   *  `resourceLoader.reload()`, which hands nothing back. Only valid immediately after an awaited
   *  reload, hence `_reloadSync`: an overlapping reload could adopt the other's instance, and adopting
   *  a session-bound one as unbound would retire a live panel and freeze its menu. */
  private _lastRegisteredRepublisherDisposer: (() => void) | null = null;
  /** Serializes resourceLoader reloads (web-search toggle + per-session refresh) so they can't race. */
  private _reloadSync: Promise<void> = Promise.resolve();
  /** Watchers on the `.claude`/`.codex` skill+command roots — fire `_reloadResources` so the agent's
   *  loaded skills/prompts hot-reload when a compat dir is created/edited/deleted (no window reload). */
  private readonly _compatWatchers: vscode.FileSystemWatcher[] = [];
  private _compatDebounce: NodeJS.Timeout | null = null;
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

  /** Register/replace the live mutator for a panel's pi session (called on start + rebind). NOTE: a
   *  Map, so two panels holding the SAME session id (both resuming one file — the id comes from the
   *  header) leave only the last registrant reachable; a caller that must reach every holder has to
   *  union this with its own session. */
  registerSessionMutator(sessionId: string, mutator: LiveSessionMutator): void {
    if (sessionId) this._sessionMutators.set(sessionId, mutator);
  }

  /** Drop a session's live mutator (on session rebind for the old id, and on dispose). */
  unregisterSessionMutator(sessionId: string): void {
    if (sessionId) this._sessionMutators.delete(sessionId);
  }

  /** The live mutator for a session currently open in some panel, or undefined if none. */
  getSessionMutator(sessionId: string): LiveSessionMutator | undefined {
    return this._sessionMutators.get(sessionId);
  }

  /** The process/workspace-scoped MCP client, or null before `init()` (Phase 6). */
  getMcpClientManager(): McpClientManager | null {
    return this._mcpClientManager;
  }

  /** The configured-hooks dispatch deps (US-008): threaded into subagent/team gate factories so PreToolUse/
   *  PostToolUse + subagent_end fire for nested agents too. Null before `init()`. */
  getHooksDispatchDeps(): DispatchDeps | null {
    return this._hooksConfig ? { config: this._hooksConfig, workspaceRoot: this._primaryCwd, userHome: os.homedir() } : null;
  }

  /** Register a live session's active-tool refresher so MCP tool changes re-apply its active set. */
  registerActiveToolRefresher(sessionId: string, refresh: () => void): void {
    if (sessionId) this._activeToolRefreshers.set(sessionId, refresh);
  }

  /** Drop a session's active-tool refresher (on rebind for the old id, and on dispose). */
  unregisterActiveToolRefresher(sessionId: string): void {
    if (sessionId) this._activeToolRefreshers.delete(sessionId);
  }

  /**
   * Register one instance's ToolSearch republisher and hand back a disposer for exactly that entry.
   * Ownership is explicit rather than inferred from a failed call. Double-disposal is inert and the
   * entry is keyed by closure identity, so a disposer can never evict a peer's.
   */
  registerToolSearchRepublisher(republish: () => void): () => void {
    this._toolSearchRepublishers.add(republish);
    const dispose = (): void => {
      this._toolSearchRepublishers.delete(republish);
    };
    this._lastRegisteredRepublisherDisposer = dispose;
    return dispose;
  }

  /**
   * Take ownership of the instance the loader currently holds, no session having bound it. Called after
   * `createAgentSessionServices` (the first session may be minutes away, and `_reconcileSubscriptionPin`
   * can supersede it first) and after a bare reload. Such an instance can never receive
   * `session_shutdown`, so the runtime is the only party left that can retire it.
   */
  private _trackCurrentInstanceAsUnbound(): void {
    this._unboundRepublisherDisposer = this._lastRegisteredRepublisherDisposer;
    this._lastRegisteredRepublisherDisposer = null;
  }

  /**
   * Ask pi to re-wrap ToolSearch so its description getter runs again. Needed because a wrap copies
   * `description` as a plain string (`wrapToolDefinition`), so the model keeps reading the inventory
   * captured at the last wrap — a subsystem toggled off mid-session would stay advertised otherwise.
   * The catch exists solely so one failing republisher cannot abort its peers or the toggle that
   * triggered it. It is NOT a retirement mechanism — entries leave only through their disposer — so a
   * throw here is unexpected, and the entry stays registered to be retried next time.
   */
  republishToolSearch(): void {
    for (const republish of [...this._toolSearchRepublishers]) {
      try {
        republish();
      } catch (err) {
        log('[PiRuntime] ToolSearch republish threw unexpectedly for a registered extension instance: %O', err);
      }
    }
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

  /**
   * Push the current `.claude`/`.codex` skill + command directories into the live resource loader via
   * `extendResources` (which re-scans immediately). `additionalSkillPaths`/`additionalPromptTemplatePaths`
   * are frozen at services-construction and `reload()` recomputes the active set from them — so a compat
   * dir created AFTER init (or wiped by a reload) would otherwise never reach the agent without a window
   * reload. Re-applied after init, after every `reload()` (via `_reloadResources`), and on the compat
   * watcher. existsSync-filtered, so absent dirs add nothing and produce no "path does not exist" warning.
   */
  private applyCompatResources(): void {
    const loader = this._services?.resourceLoader;
    if (!loader) return;
    const toEntries = (kind: 'skills' | 'commands') =>
      compatResourceEntries(this._primaryCwd, kind).map((e) => ({
        path: e.path,
        metadata: { source: e.source, scope: e.scope, origin: 'top-level' as const },
      }));
    const skillPaths = toEntries('skills');
    const promptPaths = toEntries('commands');
    if (skillPaths.length === 0 && promptPaths.length === 0) return;
    try {
      loader.extendResources({ skillPaths, promptPaths });
    } catch (err) {
      log('[PiRuntime] applyCompatResources failed: %O', err);
    }
  }

  /**
   * Reload the resource loader, serialized against every other reload. `binding` tells the reload
   * whether a session will bind the instance it is about to mint — see `ReloadBinding`.
   *
   * Serialization lives here, not at the call sites, so no caller can forget it: the scratch slot
   * identifying "the instance this reload minted" holds one value, and overlapping reloads would let
   * one adopt the other's. The rejection still reaches the caller; the chain is kept alive with a
   * swallowing continuation so one failed reload can't poison later ones.
   */
  private _reloadResources(binding: ReloadBinding): Promise<void> {
    const run = this._reloadSync.then(() => this._runResourceReload(binding));
    this._reloadSync = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Reload the resource loader, retire/adopt the republisher of the instance the reload replaces or
   *  mints, then re-apply the compat dirs (reload recomputes from the frozen additional paths and drops
   *  `extendResources` additions, so they must be re-pushed each time). */
  private async _runResourceReload(binding: ReloadBinding): Promise<void> {
    if (this._disposed || !this._services) return;
    // Cleared BEFORE the reload: a leftover value may belong to a session-BOUND instance, and adopting
    // that below would hand the runtime a disposer for a live panel.
    this._lastRegisteredRepublisherDisposer = null;
    await this._services.resourceLoader.reload();
    // Only past here is the outgoing instance definitively superseded. On a throw we never arrive — pi
    // never rebuilt, so that instance is still live and stays tracked rather than retired.
    this._unboundRepublisherDisposer?.();
    this._unboundRepublisherDisposer = null;
    if (binding === 'bare') this._trackCurrentInstanceAsUnbound();
    else this._lastRegisteredRepublisherDisposer = null;
    this.applyCompatResources();
  }

  /**
   * Watch the `.claude`/`.codex` skill + command roots (project + user) so the agent's loaded resources
   * hot-reload when a compat dir is created, edited, or deleted — matching the slash-command menu's own
   * watcher and giving `.codex` skills the same no-reload refresh as `.claude`. Routes through a full
   * `_reloadResources()` (not a bare `applyCompatResources()`): `extendResources` is additive and can never
   * drop a resource, so deletions — of a single file or a whole compat dir — only take effect once the
   * loader's base set is recomputed and the surviving dirs re-extended. Debounced; `_reloadResources`
   * serializes it so an `extendResources` can't interleave with an in-flight reload, and the `.catch`
   * keeps a failed reload from surfacing as an unhandled rejection.
   *
   * BARE: a skill-file edit starts no session, so the runtime owns retiring the instance this mints.
   */
  private _setupCompatWatchers(): void {
    const onChange = () => {
      if (this._compatDebounce) clearTimeout(this._compatDebounce);
      this._compatDebounce = setTimeout(() => {
        this._reloadResources('bare').catch((err) => log('[PiRuntime] compat watcher reload failed: %O', err));
      }, 300);
    };
    for (const source of compatSources()) {
      for (const sub of [source.skills, source.commands]) {
        this._compatWatchers.push(vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this._primaryCwd, `${sub}/**`)));
        const userGlob = `${path.join(os.homedir(), sub).replace(/\\/g, '/')}/**`;
        this._compatWatchers.push(vscode.workspace.createFileSystemWatcher(userGlob));
      }
    }
    for (const watcher of this._compatWatchers) {
      watcher.onDidCreate(onChange);
      watcher.onDidChange(onChange);
      watcher.onDidDelete(onChange);
    }
  }

  /** Reader handed to the shared extension factory so the process-global gate can route by sessionId. */
  private _panelRegistryReader(): PanelRegistryReader {
    return {
      get: (sessionId: string) => this._panelRegistry.get(sessionId),
      values: () => this._panelRegistry.values(),
    };
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

    // Config-driven hooks (US-001..009): one workspace-scoped service per runtime, watching the global +
    // project `hooks.json`. The rename callback prefers the live session mutator (anti-fork) so a
    // UserPromptSubmit `sessionTitle` hook never forks the open session's branch.
    this._hooksConfig = new HooksConfigService(this._primaryCwd);
    const hooksWiring = {
      config: this._hooksConfig,
      workspaceRoot: this._primaryCwd,
      userHome: os.homedir(),
      renameSession: async (sessionId: string, cwd: string, newName: string): Promise<void> => {
        const mutator = this.getSessionMutator(sessionId);
        if (mutator) await mutator.renameActiveSession(newName);
        else await renamePiSession(cwd, sessionId, newName);
      },
    };

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
            hooksWiring,
            (republish) => this.registerToolSearchRepublisher(republish),
          ),
        ],
        // US-016: surface `.claude` + `.codex` skills and slash commands (Claude/Codex commands = pi
        // prompt templates; Codex commands live under `.codex/prompts`) as additional resource roots,
        // additive to pi-native dirs (agentDir + cwd/.pi); pi-native sources outrank these on a name
        // collision, and `damocles.assetSourcePrecedence` orders Claude vs Codex among them.
        additionalSkillPaths: compatResourcePaths(this._primaryCwd, 'skills'),
        additionalPromptTemplatePaths: compatResourcePaths(this._primaryCwd, 'commands'),
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
    // `createAgentSessionServices` already ran the factory above, so an extension instance exists with
    // no session bound to it and none guaranteed to arrive: `_reconcileSubscriptionPin` below can
    // supersede it with a bare reload before the first panel ever opens. Adopt it now — otherwise that
    // very first startup reload strands its republisher for the life of the window.
    this._trackCurrentInstanceAsUnbound();
    for (const diag of this._services.diagnostics) {
      log('[PiRuntime] services diagnostic (%s): %s', diag.type, diag.message);
    }
    // Push compat (`.claude`/`.codex`) skills + prompts into the loader and watch their dirs so they
    // hot-reload — the additional paths captured above are frozen, so dirs created later need this.
    this.applyCompatResources();
    this._setupCompatWatchers();
    // Runs after services exist (the package manager needs their settingsManager), so the stale plugin
    // has already loaded — `_installSubscriptionPlugin` hot-reloads extensions to swap it out.
    await this._reconcileSubscriptionPin(pi);
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
   *
   * It is also the only announcement that a bind is coming, so it is where ownership of that instance's
   * republisher passes from the runtime to the instance (see `ReloadBinding`). The handover must happen
   * on EVERY exit path, including the two that never reload — otherwise the runtime keeps a disposer
   * for a now-live instance and the next reload freezes that panel's menu, silently.
   */
  async prepareSessionExtensions(): Promise<void> {
    await this.init();
    if (this._sessionsCreated++ === 0) {
      // The first session binds the pristine `init()` runtime without reloading — possibly the instance
      // a startup bare reload (`_reconcileSubscriptionPin`) minted. Release WITHOUT retiring: it is
      // about to go session-bound and will retire itself on `session_shutdown`.
      this._unboundRepublisherDisposer = null;
      return;
    }
    try {
      await this._reloadResources('session-bound');
    } catch (err) {
      // The reload never completed, so the instance the loader holds is the one about to be bound.
      this._unboundRepublisherDisposer = null;
      log('[PiRuntime] per-session extension reload failed (web tools may be unavailable): %O', err);
    }
  }

  /**
   * Create an `AgentSession` from the shared services. Auto-compaction is force-disabled at the
   * session layer too (runtime half of B3, complementing the seeded settings.json).
   *
   * CALLERS MUST call `prepareSessionExtensions()` first — it is the only announcement that a bind is
   * coming, and skipping it leaves the runtime claiming a now-live instance as unbound, so the next
   * bare reload silently freezes that panel's ToolSearch menu. `PiSession`'s session factory calls it;
   * nested subagent/team sessions need not, as `createSubagentSession` builds its own services.
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
   * REUSE the parent runtime's `modelRuntime` (so auth and the curated model list propagate; the
   * provider-registration pass inside `createAgentSessionServices` only re-upserts the already-present
   * provider configs on the shared runtime — no duplicate providers) while carrying
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
      modelRuntime: this._services.modelRuntime,
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

    // This agent's MCP set, DERIVED from `tools` rather than passed alongside it. Both spawn paths
    // build `tools` as `[...nonMcpNames, ...snapshot.names]`, so the filter reproduces the snapshot
    // exactly — and unlike a parallel option it cannot be forgotten, which would silently hand the
    // agent every MCP tool active from turn one.
    const mcpToolNames = opts.tools.filter(isMcpToolName);

    // A name in `tools:` with no matching `customTools` definition is dropped by pi with NO error, no
    // warning and no log — the single failure mode this whole delivery mechanism has. Every nested
    // spawn funnels through here, so this is the one place the class is observable at runtime. It is a
    // diagnostic, not a guard: the spawn proceeds (a missing tool must not kill an agent), but the
    // "can't happen" state stops being invisible when it happens.
    const defined = new Set(opts.customTools.map((tool) => tool.name));
    const orphans = mcpToolNames.filter((name) => !defined.has(name));
    if (orphans.length > 0) {
      log('[PiRuntime] %d mcp name(s) in tools: with no customTool definition (pi drops these silently): %o', orphans.length, orphans);
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

    // Seed the deferred baseline: browser/compass/web AND this agent's frozen `mcp__*` set start
    // INACTIVE, ToolSearch loads them on demand.
    // Post-construction and not a create-time option because `CreateAgentSessionFromServicesOptions`
    // exposes only `tools`/`excludeTools`/`noTools`/`customTools` — `initialActiveToolNames` exists
    // solely on the lower-level `AgentSessionConfig`, which this factory does not surface (it derives
    // that field from `options.tools` itself). `setActiveToolsByName` is therefore the correct seam.
    //
    // The deferred names MUST stay in `opts.tools`: pi freezes `options.tools` into `_allowedToolNames`
    // and `_refreshToolRegistry` filters the REGISTRY by it. Dropping browser/compass/web — or any
    // `mcp__*` name — from `tools:` would remove it from the registry entirely, and
    // `setActiveToolsByName` silently ignores unknown names, so it could never be brought back.
    // `tools:` stays the full ELIGIBLE set; only the ACTIVE set narrows here. For MCP the same name
    // must ALSO appear in `customTools` (that is where its definition comes from in a nested session);
    // a name in `tools:` with no matching definition is dropped with no error at all.
    //
    // Residual fragility: with `allowedToolNames` set, `_refreshToolRegistry` takes the
    // `if (allowedToolNames)` branch (agent-session.js:1996) and force-activates every allowed tool,
    // undoing this baseline. Verified it still cannot fire after this line in a nested session:
    //  - `customTools` are captured at construction (`this._customTools = config.customTools ?? []`,
    //    agent-session.js:143) and merged into the registry INSIDE `_refreshToolRegistry` itself
    //    (line 1949), which the constructor's `_buildRuntime` runs (line 2047). So the MCP tools are
    //    force-activated during construction and this `setActiveToolsByName` still lands LAST.
    //  - The only `registerTool` in a nested session is ToolSearch, during extension LOAD, where pi's
    //    `runtime.refreshTools` is still a no-op stub (extensions/loader.js:151-152 "registerTool() is
    //    valid during extension load; refresh is only needed post-bind").
    //  - There is no MCP registrar here by design: nested sessions never bind the shared Damocles
    //    extension factory, and MCP arrives as `customTools` precisely to keep it that way.
    // If a future change registers a tool into a LIVE nested session (post-bind `registerTool`, or
    // anything calling `session.reload()`), re-apply this baseline after it.
    //
    // Gated on ToolSearch being REGISTERED, not merely allowed: the subagent factory registers it
    // fail-soft, so a registration that threw would otherwise strip every browser/compass/web tool from the
    // active set while deleting the only mechanism that could bring them back — a permanent, silent
    // capability loss for the agent's whole lifetime. Deferral is only ever safe when the loader
    // actually exists. This also covers the empty-deferrable case (the factory skips registration).
    const hasToolSearch = session.getAllTools().some((tool) => tool.name === TOOL_TOOL_SEARCH);
    if (hasToolSearch) {
      session.setActiveToolsByName(
        initialActiveToolNames(opts.tools, deferredToolNames(opts.tools, mcpToolNames), NO_ACTIVATED_TOOLS),
      );
    }

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
        modelRuntime: this._services.modelRuntime,
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
   * flushes `pendingProviderRegistrations`, so installing the subscription plugin mid-session does not
   * tear down Team/btw/subagent conversations (B1: re-register providers on the shared runtime).
   * Finishes with a non-networked refresh so the new providers become resolvable at once.
   *
   * NOTE: as of `@earendil-works/pi-coding-agent@0.82.0` the shipped build also exposes the native-provider
   * channel (`pendingNativeProviderRegistrations` / `registerNativeProvider`), not just
   * `pendingProviderRegistrations`. No Damocles extension registers a native provider, so there is nothing
   * to flush on that channel — the provider-config pass below stays the only one needed. Do not add a
   * native-provider flush pass unless a Damocles extension starts registering native providers; it would
   * otherwise loop over a permanently empty array.
   */
  private async _hotReloadExtensions(): Promise<void> {
    if (!this._services) return;
    // BARE: a plugin install is not a session start, so nothing binds the instance this mints.
    await this._reloadResources('bare');
    const { modelRuntime } = this._services;
    const extensionsResult = this._services.resourceLoader.getExtensions();
    for (const { name, config } of extensionsResult.runtime.pendingProviderRegistrations) {
      try {
        modelRuntime.registerProvider(name, config);
      } catch (err) {
        log('[PiRuntime] provider re-register failed (%s): %O', name, err);
      }
    }
    extensionsResult.runtime.pendingProviderRegistrations = [];
    await modelRuntime.refresh({ allowNetwork: false });
  }

  /**
   * Store an Anthropic API key (bills the API account). Clears any OAuth grant first so the mode is
   * unambiguous.
   */
  async setAnthropicApiKey(key: string): Promise<ClaudeAuthStatus> {
    await this.init();
    if (!this._services) throw new Error('PiRuntime.setAnthropicApiKey: runtime not initialized');
    // `login` persists the api_key credential (overwriting any OAuth grant under 'anthropic') and
    // refreshes the runtime — no explicit refresh needed.
    await this._services.modelRuntime.login('anthropic', 'api_key', keyInteraction(key));
    return this.getClaudeAuthStatus();
  }

  /**
   * Sign in to the Claude Pro/Max subscription via pi's native OAuth (the `interaction` opens the
   * browser / collects a pasted code). `useAllowance` selects the billing bucket: with the plugin the
   * request looks like the Claude Code CLI (included allowance); without it pi-ai's built-in provider
   * meters the same token as extra usage. `login` persists and refreshes the grant itself.
   */
  async signInSubscription(useAllowance: boolean, interaction: AuthInteraction): Promise<ClaudeAuthStatus> {
    await this.init();
    const pi = getPiCodingAgent();
    if (!pi || !this._services) throw new Error('PiRuntime.signInSubscription: runtime not initialized');

    await this._setPluginInstalled(pi, useAllowance);
    if (!this._services) throw new Error('PiRuntime.signInSubscription: services missing after plugin change');
    await this._services.modelRuntime.login('anthropic', 'oauth', interaction);
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
    log('[PiRuntime] subscription billing set (allowance=%s)', useAllowance);
    return this.getClaudeAuthStatus();
  }

  /** Clear any stored Anthropic credential (API key or OAuth grant). */
  async signOutAnthropic(): Promise<ClaudeAuthStatus> {
    if (this._services) {
      await this._services.modelRuntime.logout('anthropic');
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
    return (await this._services!.modelRuntime.getAuth('anthropic'))?.auth.apiKey;
  }

  /** OAuth access token for the Codex usage endpoint. Gated on the codex grant. */
  async getCodexAccessToken(): Promise<string | undefined> {
    await this.init();
    if (!this.getOpenAIAuthStatus().codex) return undefined;
    return (await this._services!.modelRuntime.getAuth(OPENAI_CODEX_PROVIDER))?.auth.apiKey;
  }

  /**
   * Store an OpenAI API key (bills the API account). Independent of the codex OAuth grant — both can
   * be configured, and the settings panel chooses which to use via the prefer-api-key flag.
   */
  async setOpenAIApiKey(key: string): Promise<OpenAIAuthStatus> {
    await this.init();
    if (!this._services) throw new Error('PiRuntime.setOpenAIApiKey: runtime not initialized');
    // `login` persists the api_key credential under 'openai' and refreshes; the 'openai-codex' grant
    // is a separate provider and is left intact.
    await this._services.modelRuntime.login(OPENAI_API_PROVIDER, 'api_key', keyInteraction(key));
    return this.getOpenAIAuthStatus();
  }

  /** Clear the stored OpenAI API key, leaving any codex OAuth grant intact. */
  async clearOpenAIApiKey(): Promise<OpenAIAuthStatus> {
    if (this._services) {
      // `logout('openai')` clears only the API-key provider; 'openai-codex' is untouched.
      await this._services.modelRuntime.logout(OPENAI_API_PROVIDER);
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
    if (!this._services) throw new Error('PiRuntime.signInCodex: runtime not initialized');
    const wrapped: AuthInteraction = {
      ...(interaction.signal ? { signal: interaction.signal } : {}),
      prompt: (prompt) => (prompt.type === 'select' ? Promise.resolve(OPENAI_CODEX_BROWSER_LOGIN) : interaction.prompt(prompt)),
      notify: (event) => interaction.notify(event),
    };
    await this._services.modelRuntime.login(OPENAI_CODEX_PROVIDER, 'oauth', wrapped);
    log('[PiRuntime] codex sign-in complete');
    return this.getOpenAIAuthStatus();
  }

  /** Clear the stored codex OAuth grant, leaving any OpenAI API key intact. */
  async signOutCodex(): Promise<OpenAIAuthStatus> {
    if (this._services) {
      await this._services.modelRuntime.logout(OPENAI_CODEX_PROVIDER);
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

  /**
   * Whether a clone dir holds a loadable plugin rather than the debris of a partially-failed removal.
   * `_removeSubscriptionPlugin`'s retrying delete can still lose a locked subtree on Windows, leaving
   * a directory that satisfies `existsSync` while `src/index.ts` — the entry pi loads — is gone.
   */
  private _isSubscriptionCloneIntact(cloneDir: string): boolean {
    return existsSync(path.join(cloneDir, 'package.json')) && existsSync(path.join(cloneDir, 'src', 'index.ts'));
  }

  private async _installSubscriptionPlugin(pi: PiCodingAgentModule): Promise<void> {
    const pm = this._packageManager(pi);
    // pi's installGit treats any existing dir as a working clone and switches to `git fetch`, which
    // aborts on debris (no repo to fetch into). Clear it so the plain `git clone` path runs instead.
    const cloneDir = pm.getInstalledPath(SUBSCRIPTION_SOURCE, 'user');
    if (cloneDir && !this._isSubscriptionCloneIntact(cloneDir)) {
      await forceRemoveDir(cloneDir);
      log('[PiRuntime] cleared unusable subscription clone at %s', cloneDir);
    }
    await pm.installAndPersist(SUBSCRIPTION_SOURCE);
    log('[PiRuntime] installed %s', SUBSCRIPTION_SOURCE);
    await this._hotReloadExtensions();
  }

  /**
   * Repair the allowance plugin on startup when what is on disk no longer matches what is pinned —
   * either an older committish or a clone that cannot load. `settings.json` listing the package is the
   * gate, so extra-usage and api-key users are untouched.
   *
   * Neither drift self-heals otherwise. A sha bump is invisible because pi keys git packages by a
   * ref-agnostic identity: the clone dir still exists, so `_setPluginInstalled` early-returns,
   * `installAndPersist` never runs, `settings.json` keeps the old committish, and pi's startup
   * `resolve()` fetches the clone back down to it. Removal debris hides the same way — the dir exists,
   * so every "installed?" check says yes while requests quietly stream as `claude-cli/…` (metered extra
   * usage) under a UI that still reads "allowance". `addSourceToSettings` rewrites a same-identity entry
   * in place, so re-installing re-pins without leaving a duplicate.
   *
   * Fail-soft: this clones over the network, and an unreachable GitHub must not take the runtime down.
   */
  private async _reconcileSubscriptionPin(pi: PiCodingAgentModule): Promise<void> {
    if (!this._services) return;
    const pinned = this._services.settingsManager
      .getPackages()
      .map((pkg) => (typeof pkg === 'string' ? pkg : pkg.source))
      .find((source) => source === SUBSCRIPTION_SOURCE || isStaleSubscriptionPin(source));
    if (!pinned) return;

    const cloneDir = this._packageManager(pi).getInstalledPath(SUBSCRIPTION_SOURCE, 'user');
    const healthy = pinned === SUBSCRIPTION_SOURCE && cloneDir !== undefined && this._isSubscriptionCloneIntact(cloneDir);
    if (healthy) return;

    try {
      await this._installSubscriptionPlugin(pi);
      log('[PiRuntime] reconciled subscription plugin to %s (was %s)', SUBSCRIPTION_SOURCE, pinned);
    } catch (err) {
      log('[PiRuntime] subscription reconcile failed (allowance may be billing as extra usage): %O', err);
    }
  }

  /**
   * Remove the plugin and restore pi-ai's built-in anthropic provider on the live runtime, so the
   * stored OAuth token streams as `claude-cli/…` (extra usage). `unregisterProvider` drops the
   * plugin's override; its internal refresh is fire-and-forget, so an explicit awaited refresh
   * follows — the caller returns an auth status the UI acts on immediately, and the next request
   * must already stream through the plugin-free provider set (no racing snapshot).
   */
  private async _removeSubscriptionPlugin(pi: PiCodingAgentModule): Promise<void> {
    if (!this._services) throw new Error('PiRuntime._removeSubscriptionPlugin: runtime not initialized');
    const pm = this._packageManager(pi);
    // pi's removeGit does a single `rmSync(cloneDir, { force: true })` with no `maxRetries`, so on
    // Windows a transient handle on the git tree (Search indexer / antivirus / a lingering git child)
    // surfaces as EPERM and aborts the whole toggle — settings never get cleaned. Clear the clone
    // ourselves with a retrying remove first; pi's removeGit then early-returns on the missing dir and
    // proceeds straight to pruning the settings entry.
    const cloneDir = pm.getInstalledPath(SUBSCRIPTION_SOURCE, 'user');
    if (cloneDir) await forceRemoveDir(cloneDir);
    await pm.removeAndPersist(SUBSCRIPTION_SOURCE);
    log('[PiRuntime] removed %s', SUBSCRIPTION_SOURCE);
    // BARE: a billing-bucket switch is not a session start, so nothing binds the instance this mints.
    await this._reloadResources('bare');
    this._services.modelRuntime.unregisterProvider('anthropic');
    await this._services.modelRuntime.refresh({ allowNetwork: false });
  }

  /**
   * Whether the pi-anthropic-oauth plugin is installed AND loadable in pi's user scope. Debris from a
   * partially-failed removal must read as absent, otherwise switching back to allowance early-returns
   * on it and silently leaves the user on extra-usage billing.
   */
  private _isSubscriptionInstalled(pi: PiCodingAgentModule): boolean {
    if (!this._isPackageInstalled(pi, SUBSCRIPTION_SOURCE)) return false;
    const cloneDir = this._packageManager(pi).getInstalledPath(SUBSCRIPTION_SOURCE, 'user');
    return cloneDir !== undefined && this._isSubscriptionCloneIntact(cloneDir);
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
   * Resolve the small/fast model for internal sub-calls (query expansion, rerank, memory
   * consolidation extraction + profile summaries). Prefers the Settings → Explore section model when
   * the user configured one (the same `damocles.explore.*` config the Explore subagent uses). Memory
   * work uses the explore MODEL but a fixed `medium` effort (injected in `runStructuredCompletion`),
   * NOT the user's Explore effort setting. Falls back to a Haiku-class model
   * when Anthropic is authed, else a mini-class model on an authed OpenAI path. `null` when nothing is
   * configured, so callers fail soft. Routed through `resolvePiModel`, so the fallback lands on the
   * canonical provider — never a gateway/reseller duplicate.
   */
  private _resolveSmallFastModel(): Model<Api> | null {
    if (!this._services) return null;
    const registry = this._services.modelRuntime;
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
    // Only run when the runtime is already live (a session initialized the shared services). We do NOT
    // boot pi here — sub-calls happen during/after a session, so `_services` is set in practice; this
    // keeps background memory tasks fail-soft (and never spins up pi from a test). Fully guarded.
    try {
      if (!this._services) return null;
      const model = this._resolveSmallFastModel();
      if (!model) return null;
      // Fail soft when the model's provider has no configured credential (mirrors the old "no API key"
      // guard) — completeSimple would otherwise error trying to resolve auth.
      if (!this._services.modelRuntime.hasConfiguredAuth(model.provider)) {
        log('[PiRuntime] runStructuredCompletion: no configured credential for provider %s', model.provider);
        return null;
      }
      // pi thinking level for the fixed background `medium` — only a catalog custom-provider model
      // (step-3.7-flash today) yields one; Haiku/mini fallbacks yield undefined and pass no `reasoning`.
      // `off` maps to "no reasoning", so it is likewise not forwarded (also narrows the pi-agent-core
      // ThinkingLevel to the pi-ai one `completeSimple` accepts, which has no `off`).
      const reasoning = exploreThinkingLevel(model, 'medium');
      const complete: PiCompleteFn = (m, c, o) =>
        this._services!.modelRuntime.completeSimple(m, c, {
          ...o,
          ...(reasoning && reasoning !== 'off' ? { reasoning } : {}),
        });
      return await runStructuredCompletion<T>(complete, model, req);
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
    this._hooksConfig?.dispose();
    this._hooksConfig = null;
    if (this._compatDebounce) {
      clearTimeout(this._compatDebounce);
      this._compatDebounce = null;
    }
    for (const watcher of this._compatWatchers) watcher.dispose();
    this._compatWatchers.length = 0;
    this._activeToolRefreshers.clear();
    // Cleared alongside the refreshers, not left behind: both are per-live-instance registries, and a
    // half-cleared pair invites the inference that republishers are somehow exempt from teardown.
    this._toolSearchRepublishers.clear();
    this._unboundRepublisherDisposer = null;
    this._lastRegisteredRepublisherDisposer = null;
    this._services = null;
    this._initPromise = null;
  }
}
