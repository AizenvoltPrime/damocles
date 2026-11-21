import type {
  AgentSession,
  AgentSessionServices,
  ExtensionAPI,
  ExtensionFactory,
  ModelRuntime,
  PromptTemplate,
  ResourceDiagnostic,
  SessionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { Model, Api } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import * as os from 'os';
import { log } from '../logger';
import { installedPlatform } from '../platform-host';
import { browserReachable } from '../user-scope';
import { outsidePins } from '../client-snapshots';
import type { PiCodingAgentModule } from './pi-loader';
import { overrideGlobalContextFile, type ContextWorktree } from './context-files';
import { agentConfigBases, configLinkPolicy, type ConfigNotices } from '../config/local-config-path';
import { createDamoclesExtensionFactory, type PanelRegistryReader, type CheckpointRegistryReader } from './damocles-extension';
import { assetSourceDirs, assetSources, type AssetSourceDir } from '../asset-sources';
import { boundedLog, discoverCommands, isRunnable, LinkTargetWatchers, mergeAssets, skillLinkTargets, toPromptTemplate, type CommandAsset, type WatchTarget } from '../assets';
import { HooksConfigService, type DispatchDeps } from './hooks';
import type { McpClientManager } from './mcp/mcp-client-manager';
import type { McpModule } from './mcp/mcp-client-loader';
import { FolderMcpView } from './mcp/folder-mcp-view';
import type { McpToolSource, McpUserResourcePort } from './mcp/tool-source';
import type { McpRenamedToolRuleNotice } from '../../shared/types/mcp';
import type { McpServerSpec } from './mcp/types';
import {
  legacyToCurrentToolNames,
  migrateRenamedToolRules,
  noticeForDisplay,
  retiredResourceToolNames,
  toolRenames,
  type AdditionMemory,
  type FoundRuleNotice,
  type MigrationMemory,
  type NoticeMemory,
  type PersonalToolLists,
  type ToolNameList,
  type ToolRenames,
} from './mcp/tool-name-migration';
import { isNestedMcpName } from './mcp/naming';
import { McpToolRegistrar } from './tools/mcp-tools';
import { NO_RESOURCE_READ } from './mcp/content';
import type { PanelGateContext } from './permission-gate';
import type { CheckpointService } from './checkpoint-service';
import { WorkspaceAgentRegistry } from './subagents';
import { TOOL_TOOL_SEARCH } from '../../shared/tool-names';
import { deferredToolNames, initialActiveToolNames } from './tools/deferred-tools';
import { restoredDeferredTools } from './tools/restored-tools';
import { folderKey } from '../workspace-folders/folder-key';
import { withSettingsPolicy } from './settings-policy';
import type { TrustService } from '../../platform/trust-service';
import type { Disposable } from '../../platform/disposable';
import type { SettingInspection } from '../../platform/settings-store';
import type { FileWatcher, FileWatcherFactory } from '../../platform/file-watcher';
import { personalConfigRoot, personalFilesTrusted, worktreeWalkOf } from '../worktrees/personal-config';
import { modelInPlan, notInPlanClause } from './pi-models';
import { clearTerminatedCalls } from './terminated-calls';
import { readSessionFileEntries } from './session-store/session-file-entries';

/**
 * What this folder's pi loader gets from the `.damocles`/`.claude`/`.codex` roots, taken before each services creation and
 * reload. prompts: every runnable command as a pi template, in `assetSourceDirs` order (first wins on a name). skillRoots: the
 * skill roots the link policy admits, untrusted project ones left out, so a repo cannot inject system-prompt text through a
 * `SKILL.md`. followed: the project-scope link targets behind both, which this runtime watches.
 */
interface AssetSnapshot {
  readonly prompts: PromptTemplate[];
  readonly skillRoots: readonly AssetSourceDir[];
  readonly followed: readonly WatchTarget[];
}

// Equal for two snapshots that would give pi the same templates, skill roots and watches.
function snapshotKey(snapshot: AssetSnapshot): string {
  return JSON.stringify([
    snapshot.prompts.map((prompt) => [prompt.name, prompt.filePath, prompt.description, prompt.argumentHint ?? null, prompt.content]),
    snapshot.skillRoots.map((root) => [root.dir, root.source, root.scope]),
    snapshot.followed,
  ]);
}

/** The user roots' commands and admitted skill roots, each in walk order, as one scan of the user roots found them. */
export interface UserAssets {
  readonly commands: readonly CommandAsset[];
  readonly skillRoots: readonly AssetSourceDir[];
}

/** Rows from separate scans of the project and user roots, ordered as one scan of both lists them. */
function inRootOrder<T extends { readonly source: AssetSourceDir['source']; readonly scope: AssetSourceDir['scope'] }>(
  kind: 'commands' | 'skills',
  workspacePath: string,
  homeDir: string,
  rows: readonly T[],
): T[] {
  return assetSourceDirs(kind, { workspacePath, homeDir }).flatMap((dir) => rows.filter((row) => row.source === dir.source && row.scope === dir.scope));
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
  /** The `mcp__*` names in `tools` whose exposure is Always loaded; every other one starts deferred. */
  directMcpToolNames?: readonly string[];
  /** Where the nested session persists. `file` creates `<dir>/<ts>_<id>.jsonl`; `reopen` opens an
   *  existing session file. pi writes nothing until the session's first user or assistant message. */
  store: SubagentSessionStore;
  /** The run's stop: it ends a `reopen`'s read of the file, which then rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** `reopen` takes model and thinking level from the file, so it must not be given `model`/`thinkingLevel`.
 *  `agentId` names the agent in the error thrown when the recorded model is unavailable. */
export type SubagentSessionStore =
  | { kind: 'memory' }
  | { kind: 'file'; dir: string; id: string }
  | { kind: 'reopen'; path: string; agentId: string };

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
  mcpModule: McpModule;
  /** The raw folder path: session dirs and hook payloads keep this exact string. */
  cwd: string;
  agentDir: string;
  /** Shared by every folder runtime; pi-ai's provider registries are process-global. */
  modelRuntime: ModelRuntime;
  /** The model ids a provider's stored sign-in allows (`PiRuntime.planModelIds`); undefined when it lists none. */
  planModelIds: (provider: string) => ReadonlySet<string> | undefined;
  /** The one process-wide manager for user-scope MCP servers, shared by every folder. */
  userMcp: McpClientManager;
  /** Builds this folder's own MCP manager, wired like the user one; `reservedToolNames` keeps user tool names stable. */
  createFolderMcp: (reservedToolNames: () => ReadonlySet<string>, shellPath: () => string | undefined) => McpClientManager;
  /** Which renamed-tool notice entries were already shown, by location and replacement. */
  noticeMemory: NoticeMemory;
  /** Which rules the migration already added beside a rule of an owned file. */
  additionMemory: AdditionMemory;
  /** The project scope's `damocles.tools.disabled`, in its file or as a setting where the host keeps no file, or null when it holds none. */
  projectDisabledTools: () => ToolNameList | null;
  /** `damocles.tools.disabled` at the user scope, and at the local scope in a trusted folder; `stillTrusted` is read again inside the local write. */
  personalDisabledTools: (trusted: boolean, stillTrusted: () => boolean) => PersonalToolLists;
  /** `inspect()` of `damocles.mcp.toolExposure`, read on every use. */
  toolExposureSetting: () => SettingInspection<unknown>;
  /** `inspect()` of `damocles.mcp.resourceExposure`, read on every use. */
  resourceExposureSetting: () => SettingInspection<unknown>;
  trust: TrustService;
  fileWatchers: FileWatcherFactory;
  /** Where a config file this folder reads and refuses (hooks.json, the global instruction file) is reported. */
  notifications: ConfigNotices;
}

// pi's warnings carry repository paths and names
const logPiWarning = boundedLog((line) => log('%s', line));

function disposeSessionSafe(session: AgentSession): void {
  try {
    session.dispose();
  } catch (err) {
    log('[FolderRuntime] session dispose error: %O', err);
  }
}

function disposeNestedSession(session: AgentSession): void {
  clearTerminatedCalls(session.sessionId);
  disposeSessionSafe(session);
}

/**
 * The pi services for one workspace folder. pi binds cwd, context files, skills and project settings to
 * the services object rather than the session, so every folder a panel targets needs its own loader.
 * Everything a loader's extension instance reads (gate, checkpoint and active-tool registries, the
 * instance attachments: ToolSearch republishers and MCP registrations, hooks, markdown agents) is scoped
 * here with it. Provider registration and
 * auth stay on the shared `ModelRuntime` that `PiRuntime` owns.
 */
export class FolderRuntime {
  readonly key: string;
  readonly cwd: string;
  private readonly _pi: PiCodingAgentModule;
  private readonly _mcpModule: McpModule;
  private readonly _agentDir: string;
  /** pi's link policy for this folder's loaders and settings: links judged from the folder, the home folder, the agent dir's
   *  scope root and the personal config root, whichever deepest holds the path. */
  private readonly _linkPolicy: (file: string) => boolean;
  private readonly _modelRuntime: ModelRuntime;
  private readonly _planModelIds: FolderRuntimeOptions['planModelIds'];
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
  /** Registers MCP tools into every attached extension instance of this folder (mid-session top-up included). */
  private readonly _mcpRegistrar: McpToolRegistrar;
  private readonly _mcpUnsubscribe: () => void;
  private readonly _ruleMemory: MigrationMemory;
  private readonly _projectDisabledTools: () => ToolNameList | null;
  private readonly _personalDisabledTools: FolderRuntimeOptions['personalDisabledTools'];
  /** Per-live-session posters of renamed-tool notices, keyed by pi sessionId. */
  private readonly _ruleNoticePosters = new Map<string, (notices: McpRenamedToolRuleNotice[]) => void>();
  /** Notices found while no panel was registered to show them. */
  private _pendingRuleNotices: FoundRuleNotice[] = [];
  /** Serializes renamed-tool rule migrations; the signature of the last completed run (trust state and
   *  rename map) skips a rerun with the same inputs. */
  private _ruleMigration: Promise<void> = Promise.resolve();
  private _ruleMigrationSignature = '';
  private readonly _trustListener: Disposable;
  /** Config-driven hooks (loads/watches `~/.damocles/hooks.json` + `<folder>/.damocles/hooks.json`). */
  private readonly _hooksConfig: HooksConfigService;
  /** Per-live-session active-set refreshers, keyed by pi sessionId — fired when MCP tools change. */
  private readonly _activeToolRefreshers = new Map<string, () => void>();
  /** Per-live-session setters of the values Damocles holds on the shared settings manager, keyed by pi sessionId. */
  private readonly _settingsReappliers = new Map<string, () => void>();
  /** Re-registers ToolSearch so pi re-wraps it and re-materializes its description getter. A SET, not a
   *  single slot: each reload mints a fresh instance while earlier panels keep their bound one, so a
   *  single slot would freeze every earlier panel's description — silently, its runtime being live
   *  rather than stale. Entries arrive and leave with their instance's attachment
   *  (`attachExtensionInstance`), as do the instance's MCP registrations.
   *
   *  Retirement is deterministic, never inferred from a throw, and has exactly two owners:
   *  session-bound instances call their own detach from `session_shutdown`; unbound ones (bare
   *  reload, or services creation before any session exists) are held in `_unboundInstanceDetach`
   *  and retired by this runtime when superseded — or released if a session binds them after all. */
  private readonly _toolSearchRepublishers = new Set<() => void>();
  /** The detach handed to the extension instance the loader currently holds, WHEN nothing has bound
   *  that instance. Non-null means "this instance is unowned: retire it when it is superseded". Null
   *  means the current instance is session-bound (or about to be) and owns its own retirement. */
  private _unboundInstanceDetach: (() => void) | null = null;
  /** Scratch slot letting a reload identify the instance IT just minted — the factory runs inside
   *  `resourceLoader.reload()`, which hands nothing back. Only valid immediately after an awaited
   *  reload, hence `_reloadSync`: an overlapping reload could adopt the other's instance, and adopting
   *  a session-bound one as unbound would retire a live panel, freezing its menu and its MCP tools. */
  private _lastAttachedInstanceDetach: (() => void) | null = null;
  /** Serializes this loader's reloads (bare fan-outs + per-session refresh) so they can't race. */
  private _reloadSync: Promise<void> = Promise.resolve();
  /** Watchers on this folder's `.damocles`/`.claude`/`.codex` skill+command roots. */
  private readonly _assetWatchers: FileWatcher[] = [];
  private readonly _trust: TrustService;
  private readonly _fileWatchers: FileWatcherFactory;
  private readonly _notifications: ConfigNotices;
  private _assetDebounce: NodeJS.Timeout | null = null;
  /** The skill roots handed to pi's loader. pi aliases this array rather than copying it and re-reads it on every
   *  `reload()`, so it is only ever updated in place. */
  private readonly _additionalSkillPaths: string[] = [];
  private _assetSnapshot: AssetSnapshot = { prompts: [], skillRoots: [], followed: [] };
  /** The warnings of pi's last resource load, by kind, path and message, so one that persists is logged only once. */
  private _loggedPiWarnings = new Set<string>();
  private readonly _assetTargets: LinkTargetWatchers;
  /** Count of sessions bound off this folder's services; the first uses the pristine creation runtime. */
  private _sessionsCreated = 0;
  private _disposed = false;
  private readonly _browserReachListener: { dispose(): void } | undefined;

  constructor(options: FolderRuntimeOptions) {
    this.cwd = options.cwd;
    this.key = folderKey(options.cwd);
    this._pi = options.pi;
    this._mcpModule = options.mcpModule;
    this._agentDir = options.agentDir;
    this._linkPolicy = configLinkPolicy([options.cwd, ...agentConfigBases(options.agentDir, os.homedir()), personalConfigRoot(options.cwd)]);
    this._modelRuntime = options.modelRuntime;
    this._planModelIds = options.planModelIds;
    this._trust = options.trust;
    this._fileWatchers = options.fileWatchers;
    this._notifications = options.notifications;
    this._assetTargets = new LinkTargetWatchers(
      options.fileWatchers,
      () => this._scheduleAssetReload(),
      () => {
        this._retryAssetScan().catch((err) => log('[FolderRuntime] asset retry scan failed: %O', err));
      },
    );
    this._ruleMemory = { notices: options.noticeMemory, additions: options.additionMemory };
    this._projectDisabledTools = options.projectDisabledTools;
    this._personalDisabledTools = options.personalDisabledTools;
    this._folderMcp = options.createFolderMcp(
      () => this._mcpView.reservedToolNames(),
      () => this._services?.settingsManager.getShellPath(),
    );
    this._mcpView = new FolderMcpView(options.userMcp, this._folderMcp, () => ({
      inspection: options.toolExposureSetting(),
      resourceInspection: options.resourceExposureSetting(),
      trusted: options.trust.isTrusted(options.cwd),
    }));
    // A call from a session with no registered panel gets no read hint, so a link never names a tool its caller may lack.
    this._mcpRegistrar = new McpToolRegistrar(options.pi, options.mcpModule, this._mcpView, (ctx) => {
      const sessionId = ctx?.sessionManager?.getSessionId();
      return async (server) => (sessionId ? await this._panelRegistry.get(sessionId)?.mcpResourceReach?.(server) : undefined) ?? NO_RESOURCE_READ;
    });
    this._mcpUnsubscribe = this._mcpView.onToolsChanged(() => {
      this._mcpRegistrar.syncRegistration();
      this.refreshActiveTools();
      this.queueRenamedToolRuleMigration();
    });
    this._trustListener = options.trust.onDidChangeTrust(() => this.queueRenamedToolRuleMigration());
    this._hooksConfig = new HooksConfigService(options.cwd, options.trust, options.fileWatchers, options.notifications);
    // a daemon's core: the browser tools join ToolSearch's menu when the first client attaches and leave it with the last
    let browserReach = browserReachable();
    this._browserReachListener = installedPlatform()?.remote?.clients.onDidChange(() => {
      if (browserReachable() === browserReach) return;
      browserReach = !browserReach;
      this.republishToolSearch();
    });
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

  /** pi-mcp, which the MCP tools of this folder's panels and nested agents are built with. */
  get mcpModule(): McpModule {
    return this._mcpModule;
  }

  /** The MCP panel's own resource requests (D13); never an agent's. */
  get mcpUserResources(): McpUserResourcePort {
    return this._mcpView.userResources();
  }

  /** Feed this folder's MCP partition. An unchanged `folder` set is a no-op, so no server reconnects. */
  async reconcileFolder(folder: Record<string, McpServerSpec>, userVisible: readonly string[]): Promise<void> {
    if (this._disposed) return;
    // Visibility first, so the folder manager's tool names are computed against the user servers now shown here.
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
    };
    // The settings take the trust the snapshot was taken under, so a change during the scan shows as a mismatch, which
    // PiRuntime's post-creation check answers with a reload.
    const snapshotTrusted = await this._refreshAssetSnapshot();
    // its availability refresh reads every provider's credential, so it must never run inside a turn's pin
    this._services = await outsidePins(() => pi.createAgentSessionServices({
      cwd: this.cwd,
      agentDir: this._agentDir,
      modelRuntime: this._modelRuntime,
      // pi trusts project settings by default, and they can install and run code (`.pi/settings.json`
      // packages, `.pi/extensions`). The subscription plugin is user-scope, so this does not affect it.
      settingsManager: withSettingsPolicy(pi.SettingsManager.create(this.cwd, this._agentDir, { projectTrusted: snapshotTrusted, linkPolicy: this._linkPolicy })),
      // The Damocles extension (permission gate + plan-mode injection + MCP tool registration). pi
      // re-applies extensionFactories on `resourceLoader.reload()`, so it survives reloads.
      resourceLoaderOptions: {
        // pi asks before it follows a link in its resource walks and before it reads a context file (patch 007)
        linkPolicy: this._linkPolicy,
        extensionFactories: [
          createDamoclesExtensionFactory(
            this._panelRegistryReader(),
            this._checkpointRegistryReader(),
            hooksWiring,
            (extensionApi, republishToolSearch) => this.attachExtensionInstance(extensionApi, republishToolSearch),
          ),
        ],
        // `.damocles` + `.claude` + `.codex` skill roots, additive to pi-native dirs (agentDir + cwd/.pi), which outrank them.
        additionalSkillPaths: this._additionalSkillPaths,
        // Commands reach pi only from the snapshot (pi's own prompt walk never sees their roots); pi-native templates win a name,
        // compared exactly as pi's expandPromptTemplate matches it, so every menu row pi did not shadow still expands.
        promptsOverride: (base) => {
          const names = new Set(base.prompts.map((prompt) => prompt.name));
          return { prompts: [...base.prompts, ...this._assetSnapshot.prompts.filter((prompt) => !names.has(prompt.name))], diagnostics: base.diagnostics };
        },
        agentsFilesOverride: (base) => ({
          agentsFiles: overrideGlobalContextFile(base.agentsFiles, {
            agentDir: this._agentDir,
            homeDir: os.homedir(),
            // Read per call, never captured: a trust-change reload re-runs this closure, and that is
            // what surfaces or withdraws the project instructions file with no window reload.
            trusted: this._trust.isTrusted(this.cwd),
            notifications: this._notifications,
            ...this._contextWorktree(),
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
    }));
    // `createAgentSessionServices` already ran the factory above, so an extension instance exists with
    // no session bound to it and none guaranteed to arrive: the subscription reconcile can supersede it
    // with a bare reload before the first panel ever binds. Adopt it now — otherwise that reload strands
    // its attachment for the life of the folder.
    this._trackCurrentInstanceAsUnbound();
    for (const diag of this._services.diagnostics) {
      log('[FolderRuntime] services diagnostic (%s): %s', diag.type, diag.message);
    }
    // pi does not copy extension load errors into `diagnostics`.
    for (const { path: extPath, error } of this.getExtensionErrors()) {
      log('[FolderRuntime] extension failed to load (%s): %s', extPath, error);
    }
    // Attach the source/scope metadata for the `.damocles`/`.claude`/`.codex` skill roots, and watch the
    // project roots so a skill or command created later reaches the agent with no window reload.
    this.applyAssetResources();
    this.logPiWarnings();
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

  /**
   * Rewrite permission rules naming renamed MCP tools in the files Damocles owns, and retired resource tools in
   * the personal scopes' `damocles.tools.disabled`, and queue a one-time notice for what it must not rewrite:
   * other files, agent `disallowed_tools`, the project scope's `damocles.tools.disabled`, and a folder server's
   * retired tools in places other folders share. Runs whenever the folder's tools change, so a server that
   * connects later is handled then, and on a trust change. Folder files and the local scope are read or touched
   * only in a trusted folder, and its personal files only while personalFilesTrusted admits them. A run whose personal-list rewrite failed, or that could not check, read or rewrite a rules file, is not done, so the next one retries it.
   */
  private queueRenamedToolRuleMigration(): void {
    // Inputs are read in the queued step, after every trust listener (the agent registry's reload) ran.
    this._ruleMigration = this._ruleMigration
      .then(async () => {
        if (this._disposed) return;
        const renamesNow = (): ToolRenames => {
          const input = this._mcpView.legacyToolNameInput();
          return toolRenames(legacyToCurrentToolNames(input), retiredResourceToolNames(input));
        };
        if (renamesNow().rules.size === 0) return;
        // Trust and every other input are read together after this wait, so none is older than the agents read with them.
        const lists = await this.agentDisallowedToolLists();
        if (this._disposed) return;
        const renames = renamesNow();
        if (renames.rules.size === 0) return;
        const isTrusted = (target: string): boolean => this._trust.isTrusted(target);
        const folder = isTrusted(this.cwd) ? { path: this.cwd, personalFiles: personalFilesTrusted(isTrusted, this.cwd), trusted: () => personalFilesTrusted(isTrusted, this.cwd) } : null;
        const entries = (map: ReadonlyMap<string, string>) => [...map].map(([legacy, current]) => `${legacy}>${current}`).sort();
        const signature = [`trusted=${folder !== null}`, `personal=${folder?.personalFiles === true}`, ...entries(renames.rules), 'shared:', ...entries(renames.shared.rules)].join('\n');
        if (signature === this._ruleMigrationSignature) return;
        const projectDisabled = folder ? this._projectDisabledTools() : null;
        if (projectDisabled) lists.push(projectDisabled);
        // A renamed tool's personal entries move into toolExposure elsewhere (`McpManager.migrateDisabledMcpTools`).
        const { notices, complete } = await migrateRenamedToolRules(folder, renames, this._ruleMemory, lists, this._personalDisabledTools(folder !== null, () => isTrusted(this.cwd)));
        if (complete) this._ruleMigrationSignature = signature;
        await this.deliverRuleNotices(notices);
      })
      .catch((err: unknown) => log('[FolderRuntime] renamed-tool rule migration failed: %O', err));
  }

  /** The `disallowed_tools` of the markdown agents this folder loads (project agents only when trusted). */
  private async agentDisallowedToolLists(): Promise<ToolNameList[]> {
    const agents = this.getWorkspaceAgentRegistry();
    await agents.whenLoaded();
    return agents
      .getRegistry()
      .getAvailableConfigs()
      .flatMap((agent) => (agent.filePath && agent.disallowedTools ? [{ path: agent.filePath, names: agent.disallowedTools }] : []));
  }

  /** Post to every registered panel and remember what was shown; with no panel yet, hold them. */
  private async deliverRuleNotices(notices: FoundRuleNotice[]): Promise<void> {
    if (notices.length === 0 || this._disposed) return;
    if (this._ruleNoticePosters.size === 0) {
      this._pendingRuleNotices = notices;
      return;
    }
    this._pendingRuleNotices = [];
    const shown = notices.map(noticeForDisplay);
    for (const post of this._ruleNoticePosters.values()) post(shown);
    for (const notice of notices) await this._ruleMemory.notices.add(notice, notice.rules);
  }

  /** Register a live session's renamed-tool notice poster; notices found before any panel existed go to it now. */
  registerRuleNoticePoster(sessionId: string, post: (notices: McpRenamedToolRuleNotice[]) => void): void {
    if (!sessionId) return;
    this._ruleNoticePosters.set(sessionId, post);
    const pending = this._pendingRuleNotices;
    if (pending.length === 0) return;
    this._pendingRuleNotices = [];
    this._ruleMigration = this._ruleMigration
      .then(() => this.deliverRuleNotices(pending))
      .catch((err: unknown) => log('[FolderRuntime] renamed-tool notice delivery failed: %O', err));
  }

  /** Drop a session's notice poster, only if it is still `post`. */
  unregisterRuleNoticePoster(sessionId: string, post: (notices: McpRenamedToolRuleNotice[]) => void): void {
    if (sessionId && this._ruleNoticePosters.get(sessionId) === post) this._ruleNoticePosters.delete(sessionId);
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

  /** Register a live session's setter for what it holds on the shared settings manager, run after each loader reload. */
  registerSettingsReapplier(sessionId: string, reapply: () => void): void {
    if (sessionId) this._settingsReappliers.set(sessionId, reapply);
  }

  /** Drop a session's settings setter, only if it is still `reapply`. */
  unregisterSettingsReapplier(sessionId: string, reapply: () => void): void {
    if (sessionId && this._settingsReappliers.get(sessionId) === reapply) this._settingsReappliers.delete(sessionId);
  }

  /** The configured-hooks dispatch deps, threaded into subagent/team gate factories so PreToolUse/
   *  PostToolUse + subagent_end fire for nested agents too. */
  getHooksDispatchDeps(): DispatchDeps {
    return { config: this._hooksConfig, workspaceRoot: this.cwd, userHome: os.homedir() };
  }

  /**
   * Attach one Damocles extension instance: register this folder's MCP tools on it (and every tool that
   * connects later, until detached) and, when given, its ToolSearch republisher. Returns the detach for
   * exactly this instance. Ownership is explicit rather than inferred from a failed call. Double-detach
   * is inert and both registries key by instance identity, so a detach can never evict a peer's entry.
   */
  attachExtensionInstance(extensionApi: ExtensionAPI, republishToolSearch: (() => void) | null): () => void {
    const detachMcp = this._mcpRegistrar.attach(extensionApi);
    if (republishToolSearch) this._toolSearchRepublishers.add(republishToolSearch);
    const detach = (): void => {
      detachMcp();
      if (republishToolSearch) this._toolSearchRepublishers.delete(republishToolSearch);
    };
    this._lastAttachedInstanceDetach = detach;
    return detach;
  }

  /**
   * Take ownership of the instance the loader currently holds, no session having bound it. Called after
   * services creation (the first session may be minutes away, and the subscription reconcile can
   * supersede it first) and after a bare reload. Such an instance can never receive `session_shutdown`,
   * so this runtime is the only party left that can retire it.
   */
  private _trackCurrentInstanceAsUnbound(): void {
    this._unboundInstanceDetach = this._lastAttachedInstanceDetach;
    this._lastAttachedInstanceDetach = null;
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
   * Take the asset snapshot and update the skill roots in place, so the next `reload()` rebuilds from what the link policy
   * admits right now, in `assetSourceDirs` order. pi aliases `additionalSkillPaths` rather than copying it
   * (`resource-loader.ts:418-419` in pi 1.5.2) and re-reads it per reload (`:632`), so only an in-place splice reaches it.
   *
   * This has to happen before the reload rather than after it. `extendResources` merges primary-first
   * (`resource-loader.ts:508-512`), so a root that reaches the loader only through that call lands BEHIND the base entries
   * and loses a name collision it should win (a trust grant admitting the project roots, a root created after creation).
   * Returns the trust the snapshot was taken under. `user`, PiRuntime's one scan of the user roots for a burst of user asset
   * changes, stands in for this folder's own walk of them.
   */
  private async _refreshAssetSnapshot(user?: Promise<UserAssets | null>): Promise<boolean> {
    const pi = this._pi;
    const userAssets = (await user) ?? null;
    let trusted: boolean;
    let scan: { commands: CommandAsset[]; skillRoots: AssetSourceDir[]; followed: WatchTarget[] };
    // Scanned again until trust held for a whole scan, so the snapshot, the skill roots and the watched targets are one trust's.
    do {
      trusted = this._trust.isTrusted(this.cwd);
      scan = await this._scanAssets(trusted, userAssets);
    } while (this._trust.isTrusted(this.cwd) !== trusted);
    this._assetSnapshot = {
      prompts: mergeAssets(scan.commands).filter(isRunnable).map((command) => toPromptTemplate(command, pi.createSyntheticSourceInfo)),
      skillRoots: scan.skillRoots,
      followed: scan.followed,
    };
    this._additionalSkillPaths.splice(0, this._additionalSkillPaths.length, ...scan.skillRoots.map((root) => root.dir));
    this._assetTargets.sync(this._assetSnapshot.followed);
    return trusted;
  }

  /** The commands and skill roots in `assetSourceDirs` order, and the project roots' link targets; `user` replaces the walk of the user roots. */
  private async _scanAssets(trusted: boolean, user: UserAssets | null): Promise<{ commands: CommandAsset[]; skillRoots: AssetSourceDir[]; followed: WatchTarget[] }> {
    const homeDir = os.homedir();
    const scopes = { workspacePath: this.cwd, homeDir, trusted, log: (line: string) => log('%s', line), ...(user ? { skipUserRoots: true as const } : {}) };
    const [{ commands, followed: commandTargets }, skills] = await Promise.all([
      discoverCommands({ ...scopes, parseFrontmatter: this._pi.parseFrontmatter }),
      skillLinkTargets(scopes),
    ]);
    const followed = [...commandTargets.project, ...skills.followed.project];
    if (!user) return { commands, skillRoots: skills.roots, followed };
    return {
      commands: inRootOrder('commands', this.cwd, homeDir, [...commands, ...user.commands]),
      skillRoots: inRootOrder('skills', this.cwd, homeDir, [...skills.roots, ...user.skillRoots]),
      followed,
    };
  }

  /** The chat worktree walk of this folder's instruction files, with this folder's link policy; none outside a chat worktree. */
  private _contextWorktree(): { worktree?: ContextWorktree } {
    const { worktree } = worktreeWalkOf(this.cwd);
    return worktree ? { worktree: { ...worktree, linkPolicy: this._linkPolicy } } : {};
  }

  /**
   * Push the snapshot's skill roots into the live loader via `extendResources` (which re-scans immediately). The reload
   * already loaded the same roots; what this adds is the per-root source/scope metadata pi's resource-source info reports,
   * which `reload()` does not carry, so it is re-applied after creation and after every reload.
   */
  private applyAssetResources(): void {
    const loader = this._services?.resourceLoader;
    if (!loader) return;
    const skillPaths = this._assetSnapshot.skillRoots.map((root) => ({
      path: root.dir,
      metadata: { source: root.source, scope: root.scope, origin: 'top-level' as const },
    }));
    if (skillPaths.length === 0) return;
    try {
      loader.extendResources({ skillPaths });
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
  private _reloadResources(binding: ReloadBinding, user?: Promise<UserAssets | null>): Promise<void> {
    const run = this._reloadSync.then(() => this._runResourceReload(binding, user));
    this._reloadSync = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Retake the asset snapshot, reload the resource loader, retire/adopt the attachment of the instance the reload
   *  replaces or mints, then re-apply the skill roots (the reload drops the `extendResources` source/scope metadata). */
  private async _runResourceReload(binding: ReloadBinding, user?: Promise<UserAssets | null>): Promise<void> {
    if (this._disposed || !this._services) return;
    await this._refreshAssetSnapshot(user);
    if (this._disposed) return;
    // Cleared BEFORE the reload: a leftover value may belong to a session-BOUND instance, and adopting
    // that below would hand the runtime a disposer for a live panel.
    this._lastAttachedInstanceDetach = null;
    try {
      await this._services.resourceLoader.reload();
    } finally {
      // pi's loader reload re-reads the settings manager (resource-loader.js:382 in pi-coding-agent 1.5.2) before work that can still throw.
      for (const reapply of this._settingsReappliers.values()) reapply();
    }
    // Only past here is the outgoing instance definitively superseded. On a throw we never arrive — pi
    // never rebuilt, so that instance is still live and stays tracked rather than retired.
    this._unboundInstanceDetach?.();
    this._unboundInstanceDetach = null;
    if (binding === 'bare') this._trackCurrentInstanceAsUnbound();
    else this._lastAttachedInstanceDetach = null;
    this.applyAssetResources();
    this.logPiWarnings();
  }

  /**
   * Log the warnings of pi's last resource load (skills, prompts, themes, context files, extensions; its link policy's
   * refusals among them), each one only when the previous load did not have it. Call it after every reload of this
   * folder's loader, a session's own `reload()` included.
   */
  logPiWarnings(): void {
    const loader = this.services.resourceLoader;
    const diagnostics: Array<[string, readonly ResourceDiagnostic[]]> = [
      ['skills', loader.getSkills().diagnostics],
      ['prompts', loader.getPrompts().diagnostics],
      ['themes', loader.getThemes().diagnostics],
      ['context', loader.getContextDiagnostics?.() ?? []],
    ];
    const warnings = diagnostics.flatMap(([kind, found]) =>
      found.filter((diagnostic) => diagnostic.type === 'warning').map((diagnostic) => ({ kind, path: diagnostic.path ?? '', message: diagnostic.message })));
    for (const { path, warning } of loader.getExtensions().warnings ?? []) warnings.push({ kind: 'extensions', path, message: warning });
    const current = new Set<string>();
    for (const { kind, path, message } of warnings) {
      const key = JSON.stringify([kind, path, message]);
      if (!this._loggedPiWarnings.has(key) && !current.has(key)) logPiWarning(`[FolderRuntime] pi ${kind} warning (${path}): ${message}`);
      current.add(key);
    }
    this._loggedPiWarnings = current;
  }

  /**
   * Reload with no session about to bind (asset edits, trust change, plugin swaps), so this runtime owns
   * retiring the instance it mints. Pending provider registrations stay on the loader for the caller. `user` is PiRuntime's
   * scan of the user roots for this reload; a null scan, one that did not run, leaves this folder to walk them itself.
   */
  reloadBare(user?: Promise<UserAssets | null>): Promise<void> {
    return this._reloadResources('bare', user);
  }

  /**
   * Asks a verdict the last scan found transient (a drive that did not answer) again with the probed scan alone, queued with
   * the reloads, and reloads pi only when the snapshot changed: pi's own walk judges links synchronously with no drive probe,
   * so a reload while the drive still does not answer would block this thread on it.
   */
  private _retryAssetScan(): Promise<void> {
    const run = this._reloadSync.then(async () => {
      if (this._disposed || !this._services) return;
      const before = snapshotKey(this._assetSnapshot);
      await this._refreshAssetSnapshot();
      if (snapshotKey(this._assetSnapshot) !== before) this._scheduleAssetReload();
    });
    this._reloadSync = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private _scheduleAssetReload(): void {
    if (this._disposed) return;
    if (this._assetDebounce) clearTimeout(this._assetDebounce);
    this._assetDebounce = setTimeout(() => {
      this.reloadBare().catch((err) => log('[FolderRuntime] asset watcher reload failed: %O', err));
    }, 300);
  }

  /**
   * Watch this folder's `.damocles`/`.claude`/`.codex` skill + command roots so the agent's loaded
   * resources hot-reload when an asset dir is created, edited, or deleted, matching the slash-command
   * menu's own watcher. Routes through a full reload (not a bare `applyAssetResources()`):
   * `extendResources` is additive and can never drop a resource, so a deletion only takes effect once
   * the loader's base set is recomputed and the surviving dirs re-extended. Debounced, and the `.catch`
   * keeps a failed reload from surfacing as an unhandled rejection. The user-scope roots are watched
   * once by `PiRuntime`, and so are the user-scope link targets; the project-scope ones are synced after each snapshot.
   *
   * These stay registered in an untrusted workspace: the reload they fire still excludes project dirs,
   * so the only cost is a redundant reload.
   */
  private _setupProjectAssetWatchers(): void {
    const onChange = () => this._scheduleAssetReload();
    for (const source of assetSources()) {
      for (const sub of [source.skills, source.commands]) {
        this._assetWatchers.push(this._fileWatchers.watch(this.cwd, `${sub}/**`));
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
   * attachment passes from the runtime to the instance (see `ReloadBinding`). The handover must happen
   * on EVERY exit path, including the one that never reloads — otherwise the runtime keeps a detach
   * for a now-live instance and the next reload freezes that panel's menu and MCP tools, silently.
   */
  async prepareSessionExtensions(): Promise<void> {
    if (this._sessionsCreated++ === 0) {
      // The first session binds the pristine creation runtime without reloading — possibly the instance
      // a startup bare reload (the subscription reconcile) minted. Release WITHOUT retiring: it is about
      // to go session-bound and will retire itself on `session_shutdown`.
      this._unboundInstanceDetach = null;
      return;
    }
    try {
      await this._reloadResources('session-bound');
    } catch (err) {
      // The reload never completed, so the instance the loader holds is the one about to be bound.
      this._unboundInstanceDetach = null;
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
    const isolatedSettings = withSettingsPolicy(pi.SettingsManager.inMemory(
      {
        ...shared.getGlobalSettings(),
        ...shared.getProjectSettings(),
        compaction: { enabled: false },
      },
      { projectTrusted: this._trust.isTrusted(opts.cwd) },
    ));

    // its availability refresh reads every provider's credential; the subagent's own prompt runs in the caller's pin
    const services = await outsidePins(() => pi.createAgentSessionServices({
      cwd: opts.cwd,
      agentDir: this._agentDir,
      modelRuntime: this._modelRuntime,
      settingsManager: isolatedSettings,
      resourceLoaderOptions: {
        // pi's package walk runs before the no* flags apply
        linkPolicy: this._linkPolicy,
        extensionFactories: [opts.extensionFactory],
        systemPromptOverride: () => opts.systemPrompt,
        // Suppress the AGENTS.md/CLAUDE.md re-append that would otherwise follow systemPromptOverride.
        appendSystemPromptOverride: () => [],
        noContextFiles: true,
        // No `agentsFilesOverride` here: pi applies it AFTER the `noContextFiles` check
        // (resource-loader.ts:678-686 in pi 1.5.2), so an override would repopulate the list `noContextFiles`
        // just emptied and hand `prompt_mode: replace` agents the context they must not see.
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      },
    }));
    for (const diag of services.diagnostics) {
      log('[FolderRuntime] subagent services diagnostic (%s): %s', diag.type, diag.message);
    }

    // This agent's MCP set, DERIVED from `tools` rather than passed alongside it. Both spawn paths
    // build `tools` as `[...nonMcpNames, ...snapshot.names]`, so the filter reproduces the snapshot
    // exactly — and unlike a parallel option it cannot be forgotten, which would silently hand the
    // agent every MCP tool active from turn one. `directMcpToolNames` only subtracts from it, so
    // omitting that option defers every MCP tool rather than activating any.
    const mcpToolNames = opts.tools.filter(isNestedMcpName);
    const directMcp = new Set(opts.directMcpToolNames);
    const deferrableMcpToolNames = mcpToolNames.filter((name) => !directMcp.has(name));

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
      : store.kind === 'reopen' ? await pi.SessionManager.openAsync(store.path, undefined, opts.cwd, opts.signal ? { signal: opts.signal } : undefined)
      : pi.SessionManager.inMemory(opts.cwd);
    // Resolved here because pi, given no model, falls back to another one with only a
    // `modelFallbackMessage`; thinking signatures are model-specific, so a resume must not switch models.
    // With no `thinkingLevel`, pi restores the file's last thinking_level_change entry.
    const model = store.kind === 'reopen' ? this.resolveRecordedModel(sessionManager.buildSessionContext().model, store.agentId) : opts.model;

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
    // The deferred names MUST stay in `opts.tools`: pi turns `options.tools` into its allowlist and
    // `_refreshToolRegistry` filters the REGISTRY by it. Dropping browser/compass/web from `tools:`
    // removes it from the registry entirely, and `setActiveToolsByName` silently ignores unknown names,
    // so it could never be brought back. An `mcp__*` name left out of `tools:` is unregistered when
    // `tools:` names any `mcp__` entry; otherwise pi keeps it registered, but `_isActivatable` refuses a
    // `direct` tool without pi's `tool_search`, so it can never be activated either.
    // `tools:` stays the full ELIGIBLE set; only the ACTIVE set narrows here. For MCP the same name
    // must ALSO appear in `customTools` (that is where its definition comes from in a nested session);
    // a name in `tools:` with no matching definition is dropped with no error at all.
    //
    // Residual fragility: with an allowlist set, `_refreshToolRegistry` takes the
    // `if (allowedTools)` branch (agent-session.js:3024, pi 1.5.2) and force-activates every allowed
    // `direct` tool, undoing this baseline. Verified it still cannot fire after this line in a nested session:
    //  - `customTools` are captured at construction (`this._customTools = config.customTools ?? []`,
    //    agent-session.js:208) and merged into the registry INSIDE `_refreshToolRegistry` itself
    //    (line 2975), which the constructor's `_buildRuntime` runs (line 3089). So the MCP tools are
    //    force-activated during construction and this `setActiveToolsByName` still lands LAST.
    //  - The only `registerTool` in a nested session is ToolSearch, during extension LOAD, where pi's
    //    `runtime.refreshTools` is still a no-op stub (extensions/loader.js:133-134 "registerTool() is
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
    // Tracked before anything below can throw, so a spawn that fails still has its session disposed with the folder.
    this._subagentSessions.add(session);
    const hasToolSearch = session.getAllTools().some((tool) => tool.name === TOOL_TOOL_SEARCH);
    if (hasToolSearch) {
      const deferred = deferredToolNames(opts.tools, deferrableMcpToolNames);
      // Nested MCP is frozen at spawn, so a restored name not deferrable now never becomes so.
      const restored = restoredDeferredTools(session.sessionManager.getBranch(), new Set(deferred)).active;
      session.setActiveToolsByName(initialActiveToolNames(opts.tools, deferred, restored));
    }

    session.setAutoCompactionEnabled(false);
    return session;
  }

  /**
   * Reject with the resume error unless the model recorded in the agent session file `path` is usable. Read without writing,
   * since the file may still belong to a stopped run.
   */
  async assertResumableModel(path: string, agentId: string): Promise<void> {
    const entries = await readSessionFileEntries(path);
    const stored = this._pi.SessionManager.inMemory(this.cwd, undefined, entries as Parameters<typeof this._pi.SessionManager.inMemory>[2]);
    this.resolveRecordedModel(stored.buildSessionContext().model, agentId);
  }

  /** The model a session file last recorded (pi's own rule: last model change or assistant message), checked for a resume. */
  private resolveRecordedModel(recorded: SessionContext['model'], agentId: string): Model<Api> {
    if (!recorded) throw new Error(`Cannot resume "${agentId}": its session records no model.`);
    const model = this._modelRuntime.getModel(recorded.provider, recorded.modelId);
    if (!model || !this._modelRuntime.hasConfiguredAuth(model.provider)) {
      throw new Error(`Cannot resume "${agentId}": its model ${recorded.provider}/${recorded.modelId} is not configured or not signed in.`);
    }
    if (!modelInPlan(model.provider, model.id, { planModelIds: this._planModelIds })) {
      throw new Error(`Cannot resume "${agentId}": ${notInPlanClause(model)}, the model its session recorded.`);
    }
    return model;
  }

  /** Dispose and forget a nested subagent session (called on completion / manager dispose). */
  forgetSubagentSession(session: AgentSession): void {
    if (this._subagentSessions.delete(session)) {
      disposeNestedSession(session);
    }
  }

  /**
   * This folder's markdown-subagent registry, built once on first access. Shared by
   * every panel's subagent manager on this folder so there is one source of truth and one watcher per
   * agent dir.
   */
  getWorkspaceAgentRegistry(): WorkspaceAgentRegistry {
    if (this._disposed) throw new Error(`FolderRuntime(${this.cwd}): agent registry used after dispose`);
    if (!this._workspaceAgents) {
      this._workspaceAgents = new WorkspaceAgentRegistry(this.cwd, this._pi.parseFrontmatter, this._trust, this._fileWatchers);
    }
    return this._workspaceAgents;
  }

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    // A reload already queued returns early on `_disposed`; wait for one in flight so nothing re-adopts
    // an instance attachment after the registries below are cleared.
    await this._reloadSync;
    for (const session of this._subagentSessions) disposeNestedSession(session);
    this._subagentSessions.clear();
    this._workspaceAgents?.dispose();
    this._workspaceAgents = null;
    this._mcpUnsubscribe();
    this._trustListener.dispose();
    this._browserReachListener?.dispose();
    this._ruleNoticePosters.clear();
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
    this._assetTargets.dispose();
    this._panelRegistry.clear();
    this._checkpointRegistry.clear();
    this._activeToolRefreshers.clear();
    this._settingsReappliers.clear();
    // Cleared alongside the refreshers, not left behind: all are per-live-instance registries, and a
    // half-cleared set invites the inference that instance attachments are somehow exempt from teardown.
    this._toolSearchRepublishers.clear();
    this._mcpRegistrar.clear();
    this._unboundInstanceDetach = null;
    this._lastAttachedInstanceDetach = null;
    log('[FolderRuntime] disposed (cwd=%s)', this.cwd);
  }
}
