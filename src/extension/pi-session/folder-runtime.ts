import type {
  AgentSession,
  AgentSessionServices,
  ExtensionFactory,
  ModelRuntime,
  SessionManager,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { Model, Api } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { existsSync } from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { log } from '../logger';
import type { PiCodingAgentModule } from './pi-loader';
import { overrideGlobalContextFile } from './context-files';
import { createDamoclesExtensionFactory, type PanelRegistryReader, type CheckpointRegistryReader } from './damocles-extension';
import { assetSourceDirs, assetSources, type AssetSourceName } from '../asset-sources';
import { HooksConfigService, type DispatchDeps } from './hooks';
import type { McpClientManager } from './mcp/mcp-client-manager';
import { FolderMcpView } from './mcp/folder-mcp-view';
import type { McpToolSource } from './mcp/tool-source';
import type { McpServerConfig } from '../../shared/types/mcp';
import { isMcpToolName } from './mcp/naming';
import { McpToolRegistrar } from './tools/mcp-tools';
import type { PanelGateContext } from './permission-gate';
import type { CheckpointService } from './checkpoint-service';
import { WorkspaceAgentRegistry } from './subagents';
import { TOOL_TOOL_SEARCH } from '../../shared/tool-names';
import { deferredToolNames, initialActiveToolNames } from './tools/deferred-tools';
import { folderKey } from '../workspace-folders/folder-key';

/** An existing asset resource directory plus its source attribution (for pi's resource source info). */
interface AssetResourceEntry {
  path: string;
  source: AssetSourceName;
  scope: 'project' | 'user';
}

/**
 * Existing asset resource directories for a given kind ('skills' | 'commands') across every source
 * (`.damocles` first, then `.claude` + `.codex` ordered by `damocles.assetSourcePrecedence`), project
 * (`<cwd>`) then user-global (`~`) within each. Codex maps 'commands' → `.codex/prompts`. Project dirs
 * are dropped in an untrusted workspace so a repo cannot inject system-prompt text through a `SKILL.md`.
 * Only existing dirs are returned so the loader never warns on a missing one. Additive to pi-native
 * dirs; pi-native sources outrank these, and earlier dirs in this list outrank later ones (pi's loader
 * is first-wins on a name collision).
 */
function assetResourceEntries(cwd: string, kind: 'skills' | 'commands'): AssetResourceEntry[] {
  const trusted = vscode.workspace.isTrusted;
  return assetSourceDirs(kind, { workspacePath: cwd, homeDir: os.homedir() })
    .filter((d) => trusted || d.scope !== 'project')
    .map((d) => ({ path: d.dir, source: d.source, scope: d.scope }))
    .filter((e) => existsSync(e.path));
}

function assetResourcePaths(cwd: string, kind: 'skills' | 'commands'): string[] {
  return assetResourceEntries(cwd, kind).map((e) => e.path);
}

/**
 * Inputs for a nested subagent session. The session reuses the shared `modelRuntime` (so auth
 * and the curated model list propagate with no second provider-registration pass) while carrying its
 * OWN system prompt, tool allowlist, and a per-subagent gate-routing extension factory.
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
  /** Where the nested session persists. `file` creates `<dir>/<ts>_<id>.jsonl`; `reopen` opens an
   *  existing session file. pi writes nothing until the session's first assistant message. */
  store: SubagentSessionStore;
}

/** `reopen` takes model and thinking level from the file, so it must not be given `model`/`thinkingLevel`.
 *  `agentId` names the agent in the error thrown when the recorded model is unavailable. */
export type SubagentSessionStore =
  | { kind: 'memory' }
  | { kind: 'file'; dir: string; id: string }
  | { kind: 'reopen'; path: string; agentId: string };

/**
 * The deferred tools a restored transcript had loaded: every successful ToolSearch result's `matches`,
 * plus every tool it called. The set is not persisted, and a fresh session's transcript is empty.
 */
export function activatedToolsFromMessages(messages: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message['role'] === 'toolResult' && message['toolName'] === TOOL_TOOL_SEARCH && message['isError'] !== true) {
      const details = message['details'];
      const matches = isRecord(details) ? details['matches'] : undefined;
      if (Array.isArray(matches)) for (const name of matches) if (typeof name === 'string') out.add(name);
    } else if (message['role'] === 'assistant' && Array.isArray(message['content'])) {
      for (const block of message['content']) {
        if (isRecord(block) && block['type'] === 'toolCall' && typeof block['name'] === 'string') out.add(block['name']);
      }
    }
  }
  return out;
}

/**
 * Whether a session will bind the extension instance this reload mints. `'session-bound'` instances
 * retire themselves on `session_shutdown`; `'bare'` ones never receive it, so the folder runtime retires
 * them when the next reload supersedes them. Stated per call site because the reload itself does
 * identical work either way — the difference is only in what the caller does next.
 */
type ReloadBinding = 'session-bound' | 'bare';

/** An extension that threw while pi's loader imported or ran it. */
export interface ExtensionLoadError {
  path: string;
  error: string;
}

export interface FolderRuntimeOptions {
  pi: PiCodingAgentModule;
  /** The raw folder path: session dirs and hook payloads keep this exact string. */
  cwd: string;
  agentDir: string;
  /** Shared by every folder runtime; pi-ai's provider registries are process-global. */
  modelRuntime: ModelRuntime;
  /** The one process-wide manager for user-scope MCP servers, shared by every folder. */
  userMcp: McpClientManager;
  /** Builds this folder's own MCP manager, wired like the user one; `reservedPrefixes` keeps user tool names stable. */
  createFolderMcp: (reservedPrefixes: () => ReadonlySet<string>) => McpClientManager;
  /** Rename a session, preferring whichever panel holds it live (anti-fork). */
  renameSession: (sessionId: string, cwd: string, newName: string) => Promise<void>;
}

function disposeSessionSafe(session: AgentSession): void {
  try {
    session.dispose();
  } catch (err) {
    log('[FolderRuntime] session dispose error: %O', err);
  }
}

/**
 * The pi services for one workspace folder. pi binds cwd, context files, skills and project settings to
 * the services object rather than the session, so every folder a panel targets needs its own loader.
 * Everything a loader's extension instance reads (gate, checkpoint and active-tool registries, the
 * ToolSearch republishers, hooks, markdown agents) is scoped here with it. Provider registration and
 * auth stay on the shared `ModelRuntime` that `PiRuntime` owns.
 */
export class FolderRuntime {
  readonly key: string;
  readonly cwd: string;
  private readonly _pi: PiCodingAgentModule;
  private readonly _agentDir: string;
  private readonly _modelRuntime: ModelRuntime;
  private readonly _renameSession: FolderRuntimeOptions['renameSession'];
  private _services: AgentSessionServices | null = null;
  /** Live nested subagent sessions, disposed on completion or on folder dispose. */
  private readonly _subagentSessions = new Set<AgentSession>();
  /** Per-panel gate context, keyed by pi sessionId. This folder's Damocles extension routes through it. */
  private readonly _panelRegistry = new Map<string, PanelGateContext>();
  /** Per-session checkpoint engine driver, keyed by pi sessionId. Routed like the gate. */
  private readonly _checkpointRegistry = new Map<string, CheckpointService>();
  /** The folder's markdown-subagent source of truth (one watcher per agent dir), shared by every panel
   *  on this folder. Built lazily — needs pi for `parseFrontmatter`. */
  private _workspaceAgents: WorkspaceAgentRegistry | null = null;
  /** This folder's folder-scope MCP servers only; user-scope servers live on `PiRuntime`. */
  private readonly _folderMcp: McpClientManager;
  /** The only MCP source this folder's panels and nested agents read. */
  private readonly _mcpView: FolderMcpView;
  /** Registers MCP tools into this folder's live extension `pi` (reload-safe; mid-session top-up). */
  private readonly _mcpRegistrar: McpToolRegistrar;
  private readonly _mcpUnsubscribe: () => void;
  /** Config-driven hooks (loads/watches `~/.damocles/hooks.json` + `<folder>/.damocles/hooks.json`). */
  private readonly _hooksConfig: HooksConfigService;
  /** Per-live-session active-set refreshers, keyed by pi sessionId — fired when MCP tools change. */
  private readonly _activeToolRefreshers = new Map<string, () => void>();
  /** Re-registers ToolSearch so pi re-wraps it and re-materializes its description getter. A SET, not a
   *  single slot: each reload mints a fresh instance while earlier panels keep their bound one, so a
   *  single slot would freeze every earlier panel's description — silently, its runtime being live
   *  rather than stale.
   *
   *  Retirement is deterministic, never inferred from a throw, and has exactly two owners:
   *  session-bound instances call their own disposer from `session_shutdown`; unbound ones (bare
   *  reload, or services creation before any session exists) are held in `_unboundRepublisherDisposer`
   *  and retired by this runtime when superseded — or released if a session binds them after all. */
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
  /** Serializes this loader's reloads (bare fan-outs + per-session refresh) so they can't race. */
  private _reloadSync: Promise<void> = Promise.resolve();
  /** Watchers on this folder's `.damocles`/`.claude`/`.codex` skill+command roots. */
  private readonly _assetWatchers: vscode.FileSystemWatcher[] = [];
  private _assetDebounce: NodeJS.Timeout | null = null;
  /** The additional resource roots handed to pi's loader. pi aliases these arrays rather than copying
   *  them and re-reads them on every `reload()`, so they are only ever updated in place. */
  private readonly _additionalSkillPaths: string[] = [];
  private readonly _additionalPromptTemplatePaths: string[] = [];
  /** Count of sessions bound off this folder's services; the first uses the pristine creation runtime. */
  private _sessionsCreated = 0;
  private _disposed = false;

  constructor(options: FolderRuntimeOptions) {
    this.cwd = options.cwd;
    this.key = folderKey(options.cwd);
    this._pi = options.pi;
    this._agentDir = options.agentDir;
    this._modelRuntime = options.modelRuntime;
    this._renameSession = options.renameSession;
    this._folderMcp = options.createFolderMcp(() => this._mcpView.reservedPrefixes());
    this._mcpView = new FolderMcpView(options.userMcp, this._folderMcp);
    this._mcpRegistrar = new McpToolRegistrar(options.pi, this._mcpView);
    this._mcpUnsubscribe = this._mcpView.onToolsChanged(() => {
      this._mcpRegistrar.syncRegistration();
      this.refreshActiveTools();
    });
    this._hooksConfig = new HooksConfigService(options.cwd);
  }

  /** This folder's services. Throws before `createServices()` resolves. */
  get services(): AgentSessionServices {
    if (!this._services) throw new Error(`FolderRuntime(${this.cwd}): services not created`);
    return this._services;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  /** The MCP tools this folder's panels may use: its folder-scope servers plus the user servers visible here. */
  get mcp(): McpToolSource {
    return this._mcpView;
  }

  /** Feed this folder's MCP partition. An unchanged `folder` set is a no-op, so no server reconnects. */
  async reconcileFolder(folder: Record<string, McpServerConfig>, userVisible: readonly string[]): Promise<void> {
    if (this._disposed) return;
    // Visibility first, so the folder manager's prefixes are computed against the user servers now shown here.
    this._mcpView.setUserVisible(userVisible);
    await this._folderMcp.reconcile(folder);
  }

  /**
   * Build this folder's services on the shared `ModelRuntime`. pi flushes the loader's pending provider
   * registrations into that shared runtime here, which is why `PiRuntime` serializes this call against
   * every subscription operation.
   */
  async createServices(): Promise<void> {
    const pi = this._pi;
    const hooksWiring = {
      config: this._hooksConfig,
      workspaceRoot: this.cwd,
      userHome: os.homedir(),
      renameSession: this._renameSession,
    };
    this._refreshAdditionalResourcePaths();
    this._services = await pi.createAgentSessionServices({
      cwd: this.cwd,
      agentDir: this._agentDir,
      modelRuntime: this._modelRuntime,
      // pi trusts project settings by default, and they can install and run code (`.pi/settings.json`
      // packages, `.pi/extensions`). The subscription plugin is user-scope, so this does not affect it.
      settingsManager: pi.SettingsManager.create(this.cwd, this._agentDir, { projectTrusted: vscode.workspace.isTrusted }),
      // The Damocles extension (permission gate + plan-mode injection + MCP tool registration). pi
      // re-applies extensionFactories on `resourceLoader.reload()`, so it survives reloads.
      resourceLoaderOptions: {
        extensionFactories: [
          createDamoclesExtensionFactory(
            this._panelRegistryReader(),
            this._checkpointRegistryReader(),
            (extensionApi) => this._mcpRegistrar.registerAll(extensionApi),
            hooksWiring,
            (republish) => this.registerToolSearchRepublisher(republish),
          ),
        ],
        // Surface `.damocles` + `.claude` + `.codex` skills and slash commands (commands = pi
        // prompt templates; Codex commands live under `.codex/prompts`) as additional resource roots,
        // additive to pi-native dirs (agentDir + cwd/.pi); pi-native sources outrank these on a name
        // collision, `.damocles` outranks the other two, and `damocles.assetSourcePrecedence` orders
        // Claude vs Codex among them.
        additionalSkillPaths: this._additionalSkillPaths,
        additionalPromptTemplatePaths: this._additionalPromptTemplatePaths,
        agentsFilesOverride: (base) => ({
          agentsFiles: overrideGlobalContextFile(base.agentsFiles, {
            agentDir: this._agentDir,
            homeDir: os.homedir(),
            // Read per call, never captured: the trust-grant reload re-runs this closure, and that is
            // what surfaces the project instructions file with no window reload.
            trusted: vscode.workspace.isTrusted,
          }),
        }),
        // Damocles does not support user-installed pi extensions: drop any configured in pi so leftover
        // packages can't load tools/commands or fire event handlers. The inline factory extension (the
        // Damocles extension itself — permission gate, checkpoint hooks, MCP registration; tagged
        // `<inline:…>`) MUST be preserved, so filter only the path-loaded packages. Skills/prompts load
        // normally.
        extensionsOverride: (base) => ({
          ...base,
          extensions: base.extensions.filter((e) => e.path.startsWith('<inline:')),
        }),
      },
    });
    // `createAgentSessionServices` already ran the factory above, so an extension instance exists with
    // no session bound to it and none guaranteed to arrive: the subscription reconcile can supersede it
    // with a bare reload before the first panel ever binds. Adopt it now — otherwise that reload strands
    // its republisher for the life of the folder.
    this._trackCurrentInstanceAsUnbound();
    for (const diag of this._services.diagnostics) {
      log('[FolderRuntime] services diagnostic (%s): %s', diag.type, diag.message);
    }
    // pi does not copy extension load errors into `diagnostics`.
    for (const { path: extPath, error } of this.getExtensionErrors()) {
      log('[FolderRuntime] extension failed to load (%s): %s', extPath, error);
    }
    // Attach the source/scope metadata for the `.damocles`/`.claude`/`.codex` roots, and watch the
    // project ones so a skill or command created later reaches the agent with no window reload.
    this.applyAssetResources();
    this._setupProjectAssetWatchers();
    log('[FolderRuntime] created (cwd=%s)', this.cwd);
  }

  /** Register/replace the gate context for a panel's pi session (called on start + rebind). */
  registerPanel(sessionId: string, ctx: PanelGateContext): void {
    if (sessionId) this._panelRegistry.set(sessionId, ctx);
  }

  /** Drop a panel's gate context (called on session rebind for the old id, and on dispose). Only the
   *  registrant's own entry goes: another panel may since have registered the same session id. */
  unregisterPanel(sessionId: string, ctx: PanelGateContext): void {
    if (sessionId && this._panelRegistry.get(sessionId) === ctx) this._panelRegistry.delete(sessionId);
  }

  /** Register/replace the checkpoint engine driver for a panel's pi session. */
  registerCheckpointService(sessionId: string, service: CheckpointService): void {
    if (sessionId) this._checkpointRegistry.set(sessionId, service);
  }

  /** Drop a session's checkpoint driver (on session rebind for the old id, and on dispose), only if it
   *  is still `service`. */
  unregisterCheckpointService(sessionId: string, service: CheckpointService): void {
    if (sessionId && this._checkpointRegistry.get(sessionId) === service) this._checkpointRegistry.delete(sessionId);
  }

  /** Register a live session's active-tool refresher so MCP tool changes re-apply its active set. */
  registerActiveToolRefresher(sessionId: string, refresh: () => void): void {
    if (sessionId) this._activeToolRefreshers.set(sessionId, refresh);
  }

  /** Drop a session's active-tool refresher (on rebind for the old id, and on dispose), only if it is
   *  still `refresh`. */
  unregisterActiveToolRefresher(sessionId: string, refresh: () => void): void {
    if (sessionId && this._activeToolRefreshers.get(sessionId) === refresh) this._activeToolRefreshers.delete(sessionId);
  }

  /** The configured-hooks dispatch deps, threaded into subagent/team gate factories so PreToolUse/
   *  PostToolUse + subagent_end fire for nested agents too. */
  getHooksDispatchDeps(): DispatchDeps {
    return { config: this._hooksConfig, workspaceRoot: this.cwd, userHome: os.homedir() };
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
   * services creation (the first session may be minutes away, and the subscription reconcile can
   * supersede it first) and after a bare reload. Such an instance can never receive `session_shutdown`,
   * so this runtime is the only party left that can retire it.
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
        log('[FolderRuntime] ToolSearch republish threw unexpectedly for a registered extension instance: %O', err);
      }
    }
  }

  /** Re-apply every live session's active tool set on this folder. */
  refreshActiveTools(): void {
    for (const refresh of this._activeToolRefreshers.values()) {
      try {
        refresh();
      } catch (err) {
        log('[FolderRuntime] active-tool refresher threw: %O', err);
      }
    }
  }

  /** Errors this folder's loader recorded while importing or running extensions. */
  getExtensionErrors(): readonly ExtensionLoadError[] {
    return this.services.resourceLoader.getExtensions().errors;
  }

  /**
   * Recompute the additional resource roots in place, so the next `reload()` rebuilds its base set
   * from the dirs that exist right now, in `assetSourceDirs` order (project ahead of user within a
   * source). pi aliases these arrays rather than copying them
   * (`resource-loader.ts:264-265`) and re-reads them per reload (`:468`, `:483`), which is what makes
   * an in-place splice reach it. Reassigning the fields, or handing pi a fresh array, would leave the
   * loader on the stale one.
   *
   * This has to happen before the reload rather than after it. `extendResources` merges primary-first
   * (`resource-loader.ts:355-358`), so a dir that reaches the loader only through that call lands
   * BEHIND the base entries and loses a name collision it should win. That is reachable two ways: a
   * trust grant admitting the project dirs, and a project asset dir created after creation, which is the
   * case the asset watchers exist for.
   */
  private _refreshAdditionalResourcePaths(): void {
    const skills = assetResourcePaths(this.cwd, 'skills');
    this._additionalSkillPaths.splice(0, this._additionalSkillPaths.length, ...skills);
    const commands = assetResourcePaths(this.cwd, 'commands');
    this._additionalPromptTemplatePaths.splice(0, this._additionalPromptTemplatePaths.length, ...commands);
  }

  /**
   * Push the current `.damocles`/`.claude`/`.codex` skill + command directories into the live resource
   * loader via `extendResources` (which re-scans immediately). Every reload already rebuilds the base
   * set from the same recomputed dirs, so this is a no-op on the path list itself. What it adds is the
   * per-dir source/scope metadata pi's resource-source info reports, which `reload()` does not carry.
   * Re-applied after creation and after every `reload()` (via `_reloadResources`). existsSync-filtered,
   * so absent dirs add nothing and produce no "path does not exist" warning.
   */
  private applyAssetResources(): void {
    const loader = this._services?.resourceLoader;
    if (!loader) return;
    const toEntries = (kind: 'skills' | 'commands') =>
      assetResourceEntries(this.cwd, kind).map((e) => ({
        path: e.path,
        metadata: { source: e.source, scope: e.scope, origin: 'top-level' as const },
      }));
    const skillPaths = toEntries('skills');
    const promptPaths = toEntries('commands');
    if (skillPaths.length === 0 && promptPaths.length === 0) return;
    try {
      loader.extendResources({ skillPaths, promptPaths });
    } catch (err) {
      log('[FolderRuntime] applyAssetResources failed: %O', err);
    }
  }

  /**
   * Reload the resource loader, serialized against every other reload of this loader. `binding` tells
   * the reload whether a session will bind the instance it is about to mint — see `ReloadBinding`.
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

  /** Recompute the additional resource roots, reload the resource loader, retire/adopt the republisher
   *  of the instance the reload replaces or mints, then re-apply the asset dirs (the reload drops the
   *  `extendResources` source/scope metadata, so it has to be re-pushed each time). */
  private async _runResourceReload(binding: ReloadBinding): Promise<void> {
    if (this._disposed || !this._services) return;
    this._refreshAdditionalResourcePaths();
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
    this.applyAssetResources();
  }

  /**
   * Reload with no session about to bind (asset edits, trust grant, plugin swaps), so this runtime owns
   * retiring the instance it mints. Pending provider registrations stay on the loader for the caller.
   */
  reloadBare(): Promise<void> {
    return this._reloadResources('bare');
  }

  /**
   * Watch this folder's `.damocles`/`.claude`/`.codex` skill + command roots so the agent's loaded
   * resources hot-reload when an asset dir is created, edited, or deleted, matching the slash-command
   * menu's own watcher. Routes through a full reload (not a bare `applyAssetResources()`):
   * `extendResources` is additive and can never drop a resource, so a deletion only takes effect once
   * the loader's base set is recomputed and the surviving dirs re-extended. Debounced, and the `.catch`
   * keeps a failed reload from surfacing as an unhandled rejection. The user-scope roots are watched
   * once by `PiRuntime`.
   *
   * These stay registered in an untrusted workspace: the reload they fire still excludes project dirs,
   * so the only cost is a redundant reload.
   */
  private _setupProjectAssetWatchers(): void {
    const onChange = () => {
      if (this._assetDebounce) clearTimeout(this._assetDebounce);
      this._assetDebounce = setTimeout(() => {
        this.reloadBare().catch((err) => log('[FolderRuntime] asset watcher reload failed: %O', err));
      }, 300);
    };
    for (const source of assetSources()) {
      for (const sub of [source.skills, source.commands]) {
        this._assetWatchers.push(vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.cwd, `${sub}/**`)));
      }
    }
    for (const watcher of this._assetWatchers) {
      watcher.onDidCreate(onChange);
      watcher.onDidChange(onChange);
      watcher.onDidDelete(onChange);
    }
  }

  /** Reader handed to this folder's extension factory so the gate can route by sessionId. */
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
   * Refresh this folder's extension runtime before a new `AgentSession` binds to it. pi binds every
   * session to the resourceLoader's single extension runtime, and `AgentSession.dispose()` marks that
   * runtime stale on session replacement (reset/clear → `newSession`). Without a fresh runtime, the
   * replacement session's extension-registered MCP tools (`mcp__{server}__{tool}`) throw "extension ctx
   * is stale". `reload()` mints a fresh runtime and re-applies the Damocles extension factory (which
   * re-registers MCP tools). `_sessionsCreated` is per folder, so only the folder's first session
   * reuses the pristine creation runtime and is skipped — every later session on this folder, including
   * the first in a second panel, reloads. reload() only swaps the loader's current runtime; it does NOT
   * invalidate other panels' already-bound live sessions (they keep their captured runner; invalidation
   * happens solely on AgentSession.dispose()), so the per-session reload is what gives concurrent panels
   * runtime isolation. Non-fatal on error (a failed reload just risks the stale-ctx error rather than
   * aborting session creation).
   *
   * It is also the only announcement that a bind is coming, so it is where ownership of that instance's
   * republisher passes from the runtime to the instance (see `ReloadBinding`). The handover must happen
   * on EVERY exit path, including the one that never reloads — otherwise the runtime keeps a disposer
   * for a now-live instance and the next reload freezes that panel's menu, silently.
   */
  async prepareSessionExtensions(): Promise<void> {
    if (this._sessionsCreated++ === 0) {
      // The first session binds the pristine creation runtime without reloading — possibly the instance
      // a startup bare reload (the subscription reconcile) minted. Release WITHOUT retiring: it is about
      // to go session-bound and will retire itself on `session_shutdown`.
      this._unboundRepublisherDisposer = null;
      return;
    }
    try {
      await this._reloadResources('session-bound');
    } catch (err) {
      // The reload never completed, so the instance the loader holds is the one about to be bound.
      this._unboundRepublisherDisposer = null;
      log('[FolderRuntime] per-session extension reload failed (web tools may be unavailable): %O', err);
    }
  }

  /**
   * Create a nested subagent `AgentSession`. Builds per-subagent services that
   * REUSE the shared `modelRuntime` (so auth and the curated model list propagate; the
   * provider-registration pass inside `createAgentSessionServices` only re-upserts the already-present
   * provider configs on the shared runtime — no duplicate providers) while carrying
   * the subagent's own `systemPromptOverride`, tool allowlist, and gate-routing extension factory.
   *
   * `noContextFiles/noSkills/noPromptTemplates/noThemes` prevent AGENTS.md/CLAUDE.md re-appending after
   * the system-prompt override — required for `prompt_mode: replace` and read-only agents to behave.
   * The session persists per `opts.store` and has auto-compaction off.
   */
  async createSubagentSession(opts: PiCreateSubagentSessionOptions): Promise<AgentSession> {
    const pi = this._pi;

    // Isolate compaction: pi's auto-compaction flag lives on the settings manager, shared by
    // every session on this folder. A nested subagent/team/btw session must NEVER inherit the main
    // panel's toggle, so it gets its own in-memory settings manager seeded from this folder's config with
    // compaction forced off (all other user settings — thinking budgets, packages, enabled models — are
    // preserved).
    const shared = this.services.settingsManager;
    // Untrusted, the subagent's own `opts.cwd` must not auto-discover `.pi/extensions`.
    const isolatedSettings = pi.SettingsManager.inMemory(
      {
        ...shared.getGlobalSettings(),
        ...shared.getProjectSettings(),
        compaction: { enabled: false },
      },
      { projectTrusted: vscode.workspace.isTrusted },
    );

    const services = await pi.createAgentSessionServices({
      cwd: opts.cwd,
      agentDir: this._agentDir,
      modelRuntime: this._modelRuntime,
      settingsManager: isolatedSettings,
      resourceLoaderOptions: {
        extensionFactories: [opts.extensionFactory],
        systemPromptOverride: () => opts.systemPrompt,
        // Suppress the AGENTS.md/CLAUDE.md re-append that would otherwise follow systemPromptOverride.
        appendSystemPromptOverride: () => [],
        noContextFiles: true,
        // No `agentsFilesOverride` here: pi applies it AFTER the `noContextFiles` check
        // (resource-loader.ts:515-524), so an override would repopulate the list `noContextFiles`
        // just emptied and hand `prompt_mode: replace` agents the context they must not see.
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      },
    });
    for (const diag of services.diagnostics) {
      log('[FolderRuntime] subagent services diagnostic (%s): %s', diag.type, diag.message);
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
      log('[FolderRuntime] %d mcp name(s) in tools: with no customTool definition (pi drops these silently): %o', orphans.length, orphans);
    }

    const store = opts.store;
    if (store.kind === 'reopen' && (opts.model || opts.thinkingLevel)) {
      throw new Error('FolderRuntime.createSubagentSession: a reopened session takes its model and thinking level from its file');
    }
    // Same cwd the services above were built with, so `getCwd()` and the agent's cwd agree.
    const sessionManager =
      store.kind === 'file' ? pi.SessionManager.create(opts.cwd, store.dir, { id: store.id })
      : store.kind === 'reopen' ? pi.SessionManager.open(store.path, undefined, opts.cwd)
      : pi.SessionManager.inMemory(opts.cwd);
    // Resolved here because pi, given no model, falls back to another one with only a
    // `modelFallbackMessage`; thinking signatures are model-specific, so a resume must not switch models.
    // With no `thinkingLevel`, pi restores the file's last thinking_level_change entry.
    const model = store.kind === 'reopen' ? this.resolveRecordedModel(sessionManager, store.agentId) : opts.model;

    const { session } = await pi.createAgentSessionFromServices({
      services,
      sessionManager,
      ...(model ? { model } : {}),
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
    //  - There is no MCP registrar here by design: nested sessions never bind the Damocles extension
    //    factory, and MCP arrives as `customTools` precisely to keep it that way.
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
        initialActiveToolNames(opts.tools, deferredToolNames(opts.tools, mcpToolNames), activatedToolsFromMessages(session.messages)),
      );
    }

    session.setAutoCompactionEnabled(false);
    this._subagentSessions.add(session);
    return session;
  }

  /** Throw the resume error unless the model recorded in the agent session file `path` is usable. */
  assertResumableModel(path: string, agentId: string): void {
    this.resolveRecordedModel(this._pi.SessionManager.open(path, undefined, this.cwd), agentId);
  }

  /** The model a session file last recorded (pi's own rule: last model change or assistant message). */
  private resolveRecordedModel(sessionManager: SessionManager, agentId: string): Model<Api> {
    const recorded = sessionManager.buildSessionContext().model;
    if (!recorded) throw new Error(`Cannot resume "${agentId}": its session records no model.`);
    const model = this._modelRuntime.getModel(recorded.provider, recorded.modelId);
    if (!model || !this._modelRuntime.hasConfiguredAuth(model.provider)) {
      throw new Error(`Cannot resume "${agentId}": its model ${recorded.provider}/${recorded.modelId} is not configured or not signed in.`);
    }
    return model;
  }

  /** Dispose and forget a nested subagent session (called on completion / manager dispose). */
  forgetSubagentSession(session: AgentSession): void {
    if (this._subagentSessions.delete(session)) {
      disposeSessionSafe(session);
    }
  }

  /**
   * This folder's markdown-subagent registry, built once on first access. Shared by
   * every panel's subagent manager on this folder so there is one source of truth and one watcher per
   * agent dir.
   */
  getWorkspaceAgentRegistry(): WorkspaceAgentRegistry {
    if (!this._workspaceAgents) {
      this._workspaceAgents = new WorkspaceAgentRegistry(this.cwd, this._pi.parseFrontmatter);
    }
    return this._workspaceAgents;
  }

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    // A reload already queued returns early on `_disposed`; wait for one in flight so nothing re-adopts
    // a republisher after the registries below are cleared.
    await this._reloadSync;
    for (const session of this._subagentSessions) disposeSessionSafe(session);
    this._subagentSessions.clear();
    this._workspaceAgents?.dispose();
    this._workspaceAgents = null;
    this._mcpUnsubscribe();
    this._mcpView.dispose();
    try {
      await this._folderMcp.dispose();
    } catch (err) {
      log('[FolderRuntime] folder MCP dispose error: %O', err);
    }
    this._hooksConfig.dispose();
    if (this._assetDebounce) {
      clearTimeout(this._assetDebounce);
      this._assetDebounce = null;
    }
    for (const watcher of this._assetWatchers) watcher.dispose();
    this._assetWatchers.length = 0;
    this._panelRegistry.clear();
    this._checkpointRegistry.clear();
    this._activeToolRefreshers.clear();
    // Cleared alongside the refreshers, not left behind: both are per-live-instance registries, and a
    // half-cleared pair invites the inference that republishers are somehow exempt from teardown.
    this._toolSearchRepublishers.clear();
    this._unboundRepublisherDisposer = null;
    this._lastRegisteredRepublisherDisposer = null;
    log('[FolderRuntime] disposed (cwd=%s)', this.cwd);
  }
}
