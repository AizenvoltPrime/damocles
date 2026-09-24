import * as vscode from "vscode";
import * as path from "path";
import { LOCAL_MCP_RELATIVE_PATH } from "../../../../shared/types/mcp";
import type { McpConfigError, McpServerConfig, McpServerSource, McpServerStatusInfo, McpToolInfo } from "../../../../shared/types/mcp";
import type { McpServerEntry } from "../types";
import type { McpScope } from "../../../session-types";
import type { FolderTarget } from "../../../workspace-folders/folder-registry";
import {
  mergeMcpEntries,
  orderMcpSources,
  readMcpConfigFile,
  readGlobalMcpSources,
  localMcpConfigPath,
  CODEX_CONFIG_PATH,
  DAMOCLES_MCP_CONFIG_PATH,
  REPO_AUTHORED_BY_SOURCE,
} from "./mcp-config-import";
import type { McpSourceServers } from "./mcp-config-import";
import { isLocalMcpFileUnignored } from "./mcp-local-gitignore";
import { isFormEditableMcpServerConfig } from "./mcp-config-validate";
import { getAssetSourcePrecedence } from "../../../asset-sources";
import { log } from "../../../logger";

/** workspaceState key for the disabled user-scope server names, window-wide. */
export const MCP_DISABLED_SERVERS_KEY = "damocles.mcp.disabledServers";
/** workspaceState key for the disabled folder-scope server names, `Record<folderKey, string[]>`. */
export const MCP_DISABLED_PROJECT_SERVERS_KEY = "damocles.mcp.disabledProjectServers";
/** workspaceState flag set once the pre-split disabled names have been copied into the project lists. */
export const MCP_DISABLED_SPLIT_MIGRATED_KEY = "damocles.mcp.disabledProjectServersMigrated";
/**
 * workspaceState progress of an unfinished split: the pre-split names, the folders already copied into,
 * and per folder the names the user has toggled there since, which the split no longer touches.
 */
export const MCP_DISABLED_SPLIT_PENDING_KEY = "damocles.mcp.disabledProjectServersMigrationPending";

interface DisabledSplitPending {
  names: string[];
  migratedFolders: string[];
  decided: Record<string, string[]>;
}

function readSplitPending(raw: unknown): DisabledSplitPending | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { names, migratedFolders, decided } = raw as Record<string, unknown>;
  if (!Array.isArray(names) || !Array.isArray(migratedFolders)) return undefined;
  const strings = (values: unknown[]): string[] => values.filter((value): value is string => typeof value === "string");
  const decidedByFolder: Record<string, string[]> = {};
  if (decided && typeof decided === "object" && !Array.isArray(decided)) {
    for (const [key, list] of Object.entries(decided)) {
      if (Array.isArray(list)) decidedByFolder[key] = strings(list);
    }
  }
  return { names: strings(names), migratedFolders: strings(migratedFolders), decided: decidedByFolder };
}

/** The pre-split names still in force for a folder the split has not reached. */
function legacyNamesFor(pending: DisabledSplitPending, folderKey: string): string[] {
  const decided = new Set(pending.decided[folderKey] ?? []);
  return pending.names.filter(name => !decided.has(name));
}

function isRepoAuthored(entry: McpServerEntry): boolean {
  return REPO_AUTHORED_BY_SOURCE[entry.source];
}

/**
 * The sources folded after `target`, so they overwrite it on a name collision. Taken from the fold
 * that actually ran rather than from the static precedence.
 */
function sourcesFoldedAbove(target: McpServerSource, folded: readonly McpSourceServers[]): ReadonlySet<McpServerSource> {
  const above = new Set<McpServerSource>();
  let reached = false;
  for (const { source } of folded) {
    if (reached) above.add(source);
    else reached = source === target;
  }
  return above;
}

/**
 * In an untrusted workspace the sources a repository could have authored are folded LOWEST instead
 * of at their rank, keeping their order relative to each other. Folded at rank they would overwrite
 * same-named user-global servers, and the trust gate would then withhold the merged entry for being
 * repo-authored, so opening an untrusted repo that happens to name a server `github` would silently
 * stop your own trusted `github` from connecting.
 */
function demoteRepoAuthored(ranked: readonly McpSourceServers[]): McpSourceServers[] {
  return [
    ...ranked.filter(entry => REPO_AUTHORED_BY_SOURCE[entry.source]),
    ...ranked.filter(entry => !REPO_AUTHORED_BY_SOURCE[entry.source]),
  ];
}

/** One open folder's merge: the user sources plus that folder's sources, each entry tagged with its scope. */
interface FolderMcpState {
  entries: McpServerEntry[];
  /** Names a source folded above `~/.damocles/mcp.json` wins in this folder, mapped to that source. */
  shadowingNames: ReadonlyMap<string, McpServerSource>;
  configErrors: McpConfigError[];
  localMcpUnignored: boolean;
}

/** The folder-scope batches read for one folder, before they are ranked among the user sources. */
interface FolderRead {
  target: FolderTarget;
  sources: McpSourceServers[];
  errors: McpConfigError[];
  /** False when a folder source exists but could not be read, so its server names are unknown. */
  complete: boolean;
  localMcpUnignored: boolean;
}

const FOLDER_WATCHED_FILES = [".mcp.json", LOCAL_MCP_RELATIVE_PATH, ".gitignore"] as const;

export class McpManager {
  private folderStates = new Map<string, FolderMcpState>();
  private configLoaded = false;
  private userServerNames: string[] = [];
  private loadGeneration = 0;
  private userWatchers: vscode.FileSystemWatcher[] = [];
  private readonly folderWatchers = new Map<string, vscode.FileSystemWatcher[]>();
  private toggleLock: Promise<void> = Promise.resolve();
  private onConfigChange?: () => void;
  private readonly workspaceState: vscode.Memento;
  private readonly folders: () => readonly FolderTarget[];

  constructor(workspaceState: vscode.Memento, folders: () => readonly FolderTarget[]) {
    this.workspaceState = workspaceState;
    this.folders = folders;
  }

  setOnConfigChange(callback: () => void): void {
    this.onConfigChange = callback;
  }

  /**
   * The user files Damocles or Codex own are watched once; each open folder's files are watched by
   * `syncFolderWatchers`. A watcher only reaches outside the workspace when its pattern has a base path.
   *
   * The two `~/.claude*` files are deliberately not watched: Claude Code rewrites its global file
   * continuously, and each event here reloads every source and re-feeds every panel. Claude Code's
   * local scope lives in that same file; the panel's Reload config action picks a change there up.
   */
  setupWatcher(): void {
    if (this.userWatchers.length === 0) {
      this.userWatchers = [DAMOCLES_MCP_CONFIG_PATH, CODEX_CONFIG_PATH].map(file =>
        this.watch(new vscode.RelativePattern(path.dirname(file), path.basename(file))));
    }
    this.syncFolderWatchers();
  }

  /**
   * Watch `.mcp.json`, `.damocles/mcp.local.json` and `.gitignore` in every open folder and drop the
   * watchers of folders no longer open. `.gitignore` is watched because the leak warning is sampled on
   * load, so adding the line the panel asks for would otherwise change nothing on screen.
   */
  syncFolderWatchers(): void {
    const open = new Map(this.folders().filter(target => target.projectScope).map(target => [target.key, target]));
    for (const [key, watchers] of this.folderWatchers) {
      if (open.has(key)) continue;
      for (const watcher of watchers) watcher.dispose();
      this.folderWatchers.delete(key);
    }
    for (const [key, target] of open) {
      if (this.folderWatchers.has(key)) continue;
      this.folderWatchers.set(key, FOLDER_WATCHED_FILES.map(file => this.watch(new vscode.RelativePattern(target.fsPath, file))));
    }
  }

  /** A folder add or remove changes which files are read and which user servers are visible anywhere. */
  async handleFoldersChanged(): Promise<void> {
    this.syncFolderWatchers();
    await this.reload();
  }

  private watch(pattern: vscode.RelativePattern): vscode.FileSystemWatcher {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const fire = (): void => {
      this.reload().catch(err => log("[McpManager] Reload after a config file change failed:", err));
    };
    watcher.onDidCreate(fire);
    watcher.onDidChange(fire);
    watcher.onDidDelete(fire);
    return watcher;
  }

  private async reload(): Promise<void> {
    this.configLoaded = false;
    await this.loadConfig();
    this.onConfigChange?.();
  }

  dispose(): void {
    for (const watcher of this.userWatchers) watcher.dispose();
    this.userWatchers = [];
    for (const watchers of this.folderWatchers.values()) {
      for (const watcher of watchers) watcher.dispose();
    }
    this.folderWatchers.clear();
  }

  private getUserDisabled(): string[] {
    const raw = this.workspaceState.get<unknown>(MCP_DISABLED_SERVERS_KEY, []);
    return Array.isArray(raw) ? raw.filter((name): name is string => typeof name === "string") : [];
  }

  /** Keyed by folder key. Lists of folders not open stay stored, so re-adding the folder restores them. */
  private getProjectDisabled(): Map<string, string[]> {
    const raw = this.workspaceState.get<unknown>(MCP_DISABLED_PROJECT_SERVERS_KEY, {});
    const lists = new Map<string, string[]>();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return lists;
    for (const [key, names] of Object.entries(raw)) {
      if (Array.isArray(names)) lists.set(key, names.filter((name): name is string => typeof name === "string"));
    }
    return lists;
  }

  /**
   * Every read-modify-write of either disabled list runs under `toggleLock`, so a toggle, a rename and
   * the one-time migration cannot interleave and lose one another's change.
   */
  private async withToggleLock(critical: () => Promise<void>): Promise<void> {
    const previousLock = this.toggleLock;
    let releaseLock: () => void;
    this.toggleLock = new Promise(resolve => { releaseLock = resolve; });

    try {
      await previousLock;
      await critical();
    } finally {
      releaseLock!();
    }
  }

  private async mutateUserDisabled(mutate: (disabled: Set<string>) => void): Promise<void> {
    await this.withToggleLock(async () => {
      const disabled = new Set(this.getUserDisabled());
      mutate(disabled);
      await this.workspaceState.update(MCP_DISABLED_SERVERS_KEY, [...disabled]);
    });
  }

  /**
   * Write a folder-scope toggle. While the split has not reached the folder, the name is also recorded
   * as decided there, so neither the pending pre-split names nor the split's later copy overrides it.
   */
  private async mutateProjectDisabled(folderKey: string, serverName: string, mutate: (disabled: Set<string>) => void): Promise<void> {
    await this.withToggleLock(async () => {
      const lists = this.getProjectDisabled();
      const disabled = new Set(lists.get(folderKey) ?? []);
      mutate(disabled);
      if (disabled.size > 0) lists.set(folderKey, [...disabled]);
      else lists.delete(folderKey);
      await this.workspaceState.update(MCP_DISABLED_PROJECT_SERVERS_KEY, Object.fromEntries(lists));

      const pending = readSplitPending(this.workspaceState.get<unknown>(MCP_DISABLED_SPLIT_PENDING_KEY));
      if (!pending || pending.migratedFolders.includes(folderKey)) return;
      const decided = new Set(pending.decided[folderKey] ?? []);
      if (decided.has(serverName)) return;
      decided.add(serverName);
      await this.workspaceState.update(MCP_DISABLED_SPLIT_PENDING_KEY, {
        ...pending,
        decided: { ...pending.decided, [folderKey]: [...decided] },
      });
    });
  }

  /**
   * One-time split of the pre-folder disabled list: each name stays disabled as a user-scope name and
   * is also copied into every open folder whose own files define it. Decided from the raw folder files
   * rather than the merge, because an untrusted fold lets a same-named user server win and granting
   * trust later would bring the folder's server up enabled. Union-only, and the flag is written last.
   *
   * A folder whose files could not be read is retried on a later load. The pending record keeps the
   * pre-split names, so a later user-scope disable is not copied, the folders already done, so a
   * re-enable there is not undone, and the names toggled in a pending folder, which are not copied
   * there. Returns that record while any folder is still pending.
   */
  private async migrateDisabledSplit(folderReads: readonly FolderRead[]): Promise<DisabledSplitPending | undefined> {
    if (this.workspaceState.get<boolean>(MCP_DISABLED_SPLIT_MIGRATED_KEY, false) === true) return undefined;
    let stillPending: DisabledSplitPending | undefined;
    await this.withToggleLock(async () => {
      if (this.workspaceState.get<boolean>(MCP_DISABLED_SPLIT_MIGRATED_KEY, false) === true) return;
      const pending = readSplitPending(this.workspaceState.get<unknown>(MCP_DISABLED_SPLIT_PENDING_KEY))
        ?? { names: this.getUserDisabled(), migratedFolders: [], decided: {} };
      const migrated = new Set(pending.migratedFolders);
      const lists = this.getProjectDisabled();
      let incomplete = false;
      for (const read of folderReads) {
        if (migrated.has(read.target.key)) continue;
        if (!read.complete) {
          incomplete = true;
          continue;
        }
        migrated.add(read.target.key);
        const defined = new Set(read.sources.flatMap(batch => Object.keys(batch.servers)));
        const copied = legacyNamesFor(pending, read.target.key).filter(name => defined.has(name));
        if (copied.length === 0) continue;
        lists.set(read.target.key, [...new Set([...(lists.get(read.target.key) ?? []), ...copied])]);
      }
      await this.workspaceState.update(MCP_DISABLED_PROJECT_SERVERS_KEY, Object.fromEntries(lists));
      if (incomplete) {
        stillPending = { ...pending, migratedFolders: [...migrated] };
        await this.workspaceState.update(MCP_DISABLED_SPLIT_PENDING_KEY, stillPending);
        return;
      }
      await this.workspaceState.update(MCP_DISABLED_SPLIT_MIGRATED_KEY, true);
      await this.workspaceState.update(MCP_DISABLED_SPLIT_PENDING_KEY, undefined);
    });
    return stillPending;
  }

  private isOpenFolder(folderKey: string): boolean {
    return this.folders().some(target => target.key === folderKey);
  }

  /** The folder's loaded merge. A key that is not an open folder is logged and gets nothing. */
  private stateFor(folderKey: string, caller: string): FolderMcpState | undefined {
    if (!this.isOpenFolder(folderKey)) {
      log("[McpManager] %s: %s is not an open folder; ignored", caller, folderKey);
      return undefined;
    }
    return this.folderStates.get(folderKey);
  }

  /**
   * Write the toggle to the list of the name's scope in that folder: a folder-scope entry goes to the
   * folder's project list, anything else to the window-wide user list.
   */
  async setServerEnabled(folderKey: string, serverName: string, enabled: boolean): Promise<void> {
    if (!this.isOpenFolder(folderKey)) {
      log("[McpManager] setServerEnabled: %s is not an open folder; ignored", folderKey);
      return;
    }
    const toggle = (disabled: Set<string>): void => {
      if (enabled) disabled.delete(serverName);
      else disabled.add(serverName);
    };

    // Every user server has an entry in every folder, as a user entry or as the folder entry that owns
    // the name there, so a name with no entry is not this folder's to change.
    const entry = this.folderStates.get(folderKey)?.entries.find(e => e.name === serverName);
    if (!entry) {
      log("[McpManager] setServerEnabled: %s is not a server in %s; ignored", serverName, folderKey);
      return;
    }
    if (entry.scope === "folder") {
      await this.mutateProjectDisabled(folderKey, serverName, toggle);
      // Re-read after the await: a reload may have installed a state read before this write landed.
      const current = this.folderStates.get(folderKey)?.entries.find(e => e.name === serverName && e.scope === "folder");
      if (current) current.enabled = enabled;
      return;
    }

    await this.mutateUserDisabled(toggle);
    for (const state of this.folderStates.values()) {
      for (const userEntry of state.entries) {
        if (userEntry.scope === "user" && userEntry.name === serverName) userEntry.enabled = enabled;
      }
    }
  }

  /**
   * Follow a rename in the user disabled list. Only `~/.damocles/mcp.json` servers can be renamed, and
   * they are user-scope. Without this a disabled server comes back enabled under its new name, which
   * for stdio means spawning a process the user deliberately switched off.
   */
  async carryDisabledServerThroughRename(oldName: string, newName: string): Promise<void> {
    if (oldName === newName) return;
    await this.mutateUserDisabled(disabled => {
      if (!disabled.delete(oldName)) return;
      disabled.add(newName);
    });
  }

  /**
   * Drop a deleted `~/.damocles/mcp.json` server from the user disabled list, so re-adding the same
   * name later does not come back switched off by a decision about a server that no longer exists.
   */
  async pruneDisabledServer(name: string): Promise<void> {
    await this.mutateUserDisabled(disabled => { disabled.delete(name); });
  }

  /**
   * What a panel in `folderKey` should connect. Gated by the master `damocles.mcp.enabled` switch (M6:
   * off means none, so disabling tears down live connections) and by workspace trust (M3: servers from
   * a file in the working tree are withheld in an untrusted workspace). The trust test is
   * `REPO_AUTHORED_BY_SOURCE`, read live: `claude-local` is folder-scope but written in `~/.claude.json`,
   * so a repository had no hand in it. This is the single chokepoint feeding the live MCP clients.
   */
  getEnabledServers(folderKey: string): McpScope {
    if (!this.isMasterEnabled()) return { userUnion: {}, userVisible: [], folder: {} };
    const userUnion = this.userUnion();
    const state = this.stateFor(folderKey, "getEnabledServers");
    if (!state) return { userUnion, userVisible: [], folder: {} };

    const trusted = vscode.workspace.isTrusted;
    const enabled = state.entries.filter(entry => entry.enabled);
    return {
      userUnion,
      userVisible: enabled.filter(entry => entry.scope === "user").map(entry => entry.name),
      folder: Object.fromEntries(
        enabled
          .filter(entry => entry.scope === "folder")
          .filter(entry => trusted || !isRepoAuthored(entry))
          .map(entry => [entry.name, entry.config]),
      ),
    };
  }

  /** Enabled user-scope servers visible in at least one open folder; one connection each, window-wide. */
  private userUnion(): Record<string, McpServerConfig> {
    const union = new Map<string, McpServerConfig>();
    for (const target of this.folders()) {
      for (const entry of this.folderStates.get(target.key)?.entries ?? []) {
        if (entry.scope === "user" && entry.enabled) union.set(entry.name, entry.config);
      }
    }
    return Object.fromEntries(union);
  }

  private isMasterEnabled(): boolean {
    return vscode.workspace.getConfiguration("damocles.mcp").get<boolean>("enabled", true);
  }

  /** A server from a working-tree file, withheld from connecting because the workspace is untrusted (M3). */
  private isUntrustedRepoServer(entry: McpServerEntry): boolean {
    return isRepoAuthored(entry) && !vscode.workspace.isTrusted;
  }

  getServersForUI(folderKey: string): McpServerStatusInfo[] {
    const state = this.stateFor(folderKey, "getServersForUI");
    return (state?.entries ?? []).map(entry => {
      const info = this.toStatusInfo(entry, entry.enabled ? "idle" : "disabled");
      if (this.isUntrustedRepoServer(entry)) info.untrusted = true;
      return info;
    });
  }

  getConfigLoaded(): boolean {
    return this.configLoaded;
  }

  /** Config files that exist but could not be used: the user files and this folder's own. */
  getConfigErrors(folderKey: string): McpConfigError[] {
    return [...(this.stateFor(folderKey, "getConfigErrors")?.configErrors ?? [])];
  }

  /**
   * The names a source folded above `~/.damocles/mcp.json` wins in `folderKey`, mapped to that source.
   * The write path refuses these for a panel in that folder, where the written server would be hidden.
   * Read off the folder's actual fold, so an untrusted folder's demoted files refuse nothing.
   */
  getShadowingServerNames(folderKey: string): ReadonlyMap<string, McpServerSource> {
    return this.stateFor(folderKey, "getShadowingServerNames")?.shadowingNames ?? new Map();
  }

  /**
   * True when `<folder>/.damocles/mcp.local.json` exists and git is not ignoring it, so the credentials
   * it may hold are one `git add` away from being published. Sampled during `loadConfig()`.
   */
  getLocalMcpUnignored(folderKey: string): boolean {
    return this.stateFor(folderKey, "getLocalMcpUnignored")?.localMcpUnignored ?? false;
  }

  /**
   * Every user-scope server name, enabled or not. A rename remaps tool names over this set, because a
   * disabled server's tools stay in `damocles.tools.disabled` under the prefix they had while enabled.
   */
  getUserServerNames(): string[] {
    return [...this.userServerNames];
  }

  async loadConfig(): Promise<void> {
    // Three independent triggers reach this method: the panel write path, the file watchers and
    // session startup. Without a generation stamp an older run can finish last and install a staler
    // snapshot, which disconnects servers because `getEnabledServers()` feeds the live MCP clients.
    const generation = ++this.loadGeneration;

    // One knob governs every Claude-vs-Codex tie-break, so assets and MCP can never disagree about it.
    const precedence = getAssetSourcePrecedence();
    const trusted = vscode.workspace.isTrusted;
    const targets = [...this.folders()];
    const projectTargets = targets.filter(target => target.projectScope);

    const [global, fileReads] = await Promise.all([
      readGlobalMcpSources(projectTargets.map(target => target.fsPath)),
      Promise.all(projectTargets.map(target => this.readFolderFiles(target, trusted))),
    ]);

    const folderReads: FolderRead[] = fileReads.map(read => ({
      ...read,
      sources: [...read.sources, { source: "claude-local", servers: global.claudeLocal.get(read.target.fsPath)! }],
      complete: read.complete && !global.claudeLocalUnreadable,
    }));
    const pendingSplit = await this.migrateDisabledSplit(folderReads);

    const userDisabled = new Set(this.getUserDisabled());
    const projectDisabled = this.getProjectDisabled();
    const readsByKey = new Map(folderReads.map(read => [read.target.key, read]));
    const folderStates = new Map<string, FolderMcpState>();
    for (const target of targets) {
      // The home target of a window with no folder open has no project files, only user servers.
      const read = readsByKey.get(target.key);
      const ranked = orderMcpSources([...global.sources, ...(read?.sources ?? [])], precedence);
      const folded = trusted ? ranked : demoteRepoAuthored(ranked);
      // A folder the split has not reached yet still honours every pre-split name, so nothing disabled
      // before the upgrade connects while its files are unreadable.
      const folderDisabled = new Set(projectDisabled.get(target.key) ?? []);
      if (pendingSplit && !pendingSplit.migratedFolders.includes(target.key)) {
        for (const name of legacyNamesFor(pendingSplit, target.key)) folderDisabled.add(name);
      }
      const entries = mergeMcpEntries(folded, { user: userDisabled, folder: folderDisabled });
      const shadowingSources = sourcesFoldedAbove("damocles", folded);
      folderStates.set(target.key, {
        entries,
        shadowingNames: new Map(entries.filter(entry => shadowingSources.has(entry.source)).map(entry => [entry.name, entry.source])),
        configErrors: [...global.errors, ...(read?.errors ?? [])],
        localMcpUnignored: read?.localMcpUnignored ?? false,
      });
    }
    const userServerNames = [...new Set(global.sources.flatMap(batch => Object.keys(batch.servers)))];

    if (generation !== this.loadGeneration) return;
    this.folderStates = folderStates;
    this.userServerNames = userServerNames;
    this.configLoaded = true;
  }

  /**
   * One folder's working-tree files. Asking git runs the repository's own `.git/config`, and
   * `core.fsmonitor` in it is a command git executes, so an untrusted workspace never gets asked.
   */
  private async readFolderFiles(target: FolderTarget, trusted: boolean): Promise<FolderRead> {
    const files: readonly (readonly [McpServerSource, string])[] = [
      ["workspace", path.join(target.fsPath, ".mcp.json")],
      ["damocles-local", localMcpConfigPath(target.fsPath)],
    ];
    const [reads, localMcpUnignored] = await Promise.all([
      Promise.all(files.map(async ([source, file]) => ({ source, read: await readMcpConfigFile(file) }))),
      trusted ? isLocalMcpFileUnignored(target.fsPath) : false,
    ]);
    return {
      target,
      sources: reads.map(({ source, read }) => ({ source, servers: read.servers })),
      errors: reads.flatMap(({ read }) => (read.error ? [read.error] : [])),
      complete: reads.every(({ read }) => read.error === null),
      localMcpUnignored,
    };
  }

  buildRuntimeStatus(folderKey: string, sdkStatuses: McpServerStatusInfo[]): McpServerStatusInfo[] {
    const statusMap = new Map(sdkStatuses.map(s => [s.name, s]));
    const state = this.stateFor(folderKey, "buildRuntimeStatus");
    return (state?.entries ?? []).map(entry => {
      const sdkServer = statusMap.get(entry.name);
      const untrusted = this.isUntrustedRepoServer(entry);
      const status = untrusted
        ? "disabled"
        : entry.enabled
          ? (sdkServer?.status as McpServerStatusInfo["status"]) || "pending"
          : "disabled";
      const info = this.toStatusInfo(entry, status);
      if (untrusted) info.untrusted = true;
      if (sdkServer?.serverInfo) info.serverInfo = sdkServer.serverInfo;
      if (sdkServer?.error && !untrusted) info.error = sdkServer.error;
      if (sdkServer?.tools) info.tools = sdkServer.tools as McpToolInfo[];
      if (entry.enabled && !untrusted && sdkServer?.supportsOAuth) info.supportsOAuth = true;
      return info;
    });
  }

  private toStatusInfo(entry: McpServerEntry, status: McpServerStatusInfo["status"]): McpServerStatusInfo {
    const info: McpServerStatusInfo = { name: entry.name, status, enabled: entry.enabled };
    if (entry.source) info.source = entry.source;
    if (entry.readonly !== undefined) info.readonly = entry.readonly;
    // The edit form has nothing else to pre-populate from, so a Damocles-owned definition is sent
    // whenever the form can represent it losslessly, which is exactly when the write path would take
    // it back. Everything else is withheld, so Edit cannot destroy a definition it cannot show.
    //
    // Copied rather than aliased: the same object sits in the folder merge and is handed to
    // `setMcpServers()`, so an in-extension consumer mutating what it received here would corrupt the
    // definition feeding the spawn chokepoint.
    if (entry.source === "damocles" && isFormEditableMcpServerConfig(entry.config)) {
      info.editableConfig = { ...entry.config };
    }
    return info;
  }
}
