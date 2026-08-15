import * as vscode from "vscode";
import * as path from "path";
import type { McpConfigError, McpServerConfig, McpServerStatusInfo, McpToolInfo } from "../../../../shared/types/mcp";
import type { McpServerEntry } from "../types";
import {
  mergeMcpEntries,
  readMcpConfigFile,
  readGlobalMcpSources,
  CODEX_CONFIG_PATH,
  DAMOCLES_MCP_CONFIG_PATH,
} from "./mcp-config-import";
import { isFormEditableMcpServerConfig } from "./mcp-config-validate";
import { getAssetSourcePrecedence } from "../../../asset-sources";
import { log } from "../../../logger";

/** workspaceState key for the Damocles-owned disabled-server set (replaces CC's disabledMcpjsonServers). */
export const MCP_DISABLED_SERVERS_KEY = "damocles.mcp.disabledServers";

export class McpManager {
  private entries: McpServerEntry[] = [];
  private configLoaded = false;
  private configErrors: McpConfigError[] = [];
  private loadGeneration = 0;
  private watchers: vscode.FileSystemWatcher[] = [];
  private toggleLock: Promise<void> = Promise.resolve();
  private onConfigChange?: () => void;
  private readonly workspaceState: vscode.Memento;

  constructor(workspaceState: vscode.Memento) {
    this.workspaceState = workspaceState;
  }

  setOnConfigChange(callback: () => void): void {
    this.onConfigChange = callback;
  }

  setupWatcher(workspacePath: string): void {
    if (this.watchers.length > 0) return;

    const reload = async () => {
      this.configLoaded = false;
      await this.loadConfig();
      this.onConfigChange?.();
    };

    // The three files Damocles or Codex own, so hand-editing any of them refreshes the panel with no
    // window reload. A watcher only reaches outside the workspace when its pattern has a base path.
    //
    // The two `~/.claude*` files are deliberately NOT watched: Claude Code rewrites its global file
    // continuously, and each event here reloads every source and re-drives `setMcpServers()`, cycling
    // live connections. Those still need a window reload — the right trade for another tool's file.
    const patterns = [
      new vscode.RelativePattern(workspacePath, ".mcp.json"),
      new vscode.RelativePattern(path.dirname(DAMOCLES_MCP_CONFIG_PATH), path.basename(DAMOCLES_MCP_CONFIG_PATH)),
      new vscode.RelativePattern(path.dirname(CODEX_CONFIG_PATH), path.basename(CODEX_CONFIG_PATH)),
    ];

    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidCreate(reload);
      watcher.onDidChange(reload);
      watcher.onDidDelete(reload);
      this.watchers.push(watcher);
    }
  }

  dispose(): void {
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
  }

  private getDisabledServers(): string[] {
    const raw = this.workspaceState.get<string[]>(MCP_DISABLED_SERVERS_KEY, []);
    return Array.isArray(raw) ? raw : [];
  }

  /**
   * Read-modify-write the disabled-server set under `toggleLock`. Every mutation goes through here so
   * a toggle and a rename cannot interleave and lose one another's change.
   */
  private async mutateDisabledServers(mutate: (disabled: Set<string>) => void): Promise<void> {
    const previousLock = this.toggleLock;
    let releaseLock: () => void;
    this.toggleLock = new Promise(resolve => { releaseLock = resolve; });

    try {
      await previousLock;
      const disabled = new Set(this.getDisabledServers());
      mutate(disabled);
      await this.workspaceState.update(MCP_DISABLED_SERVERS_KEY, [...disabled]);
    } finally {
      releaseLock!();
    }
  }

  async setServerEnabled(serverName: string, enabled: boolean): Promise<void> {
    await this.mutateDisabledServers(disabled => {
      if (enabled) disabled.delete(serverName);
      else disabled.add(serverName);
    });

    const entry = this.entries.find(e => e.name === serverName);
    if (entry) {
      entry.enabled = enabled;
    } else {
      log("[McpManager] setServerEnabled: entry not found for", serverName);
    }
  }

  /**
   * Follow a rename in the disabled set. The set is keyed by server name and the write path only
   * rewrites the config file, so without this a disabled server comes back enabled under its new name
   * — which for stdio means spawning a process the user deliberately switched off.
   */
  async carryDisabledServerThroughRename(oldName: string, newName: string): Promise<void> {
    if (oldName === newName) return;
    await this.mutateDisabledServers(disabled => {
      if (!disabled.delete(oldName)) return;
      disabled.add(newName);
    });
  }

  /**
   * Drop a deleted server from the disabled set, so re-adding the same name later does not come back
   * mysteriously switched off by a decision about a server that no longer exists.
   */
  async pruneDisabledServer(name: string): Promise<void> {
    await this.mutateDisabledServers(disabled => { disabled.delete(name); });
  }

  /**
   * The set of servers that should actually be connected. Gated by the master `damocles.mcp.enabled`
   * switch (M6: off ⇒ none, so disabling tears down live connections) and by workspace trust (M3:
   * workspace `.mcp.json` servers are withheld in an untrusted workspace; the user-global sources —
   * `~/.damocles/mcp.json`, the Claude imports and the Codex import — are unaffected, because none of
   * them is authored by the repository you just opened). The test stays an explicit `source ===
   * "workspace"` one rather than `!readonly`: `damocles` entries are editable *and* trusted, so routing
   * trust through `readonly` would silently start withholding them. This is the single chokepoint
   * feeding the live MCP client.
   */
  getEnabledServers(): Record<string, McpServerConfig> {
    if (!this.isMasterEnabled()) return {};
    const trusted = vscode.workspace.isTrusted;
    return Object.fromEntries(
      this.entries
        .filter(entry => entry.enabled)
        .filter(entry => trusted || entry.source !== "workspace")
        .map(entry => [entry.name, entry.config])
    );
  }

  private isMasterEnabled(): boolean {
    return vscode.workspace.getConfiguration("damocles.mcp").get<boolean>("enabled", true);
  }

  /** A workspace-sourced server withheld from connecting because the workspace is untrusted (M3). */
  private isUntrustedWorkspaceServer(entry: McpServerEntry): boolean {
    return entry.source === "workspace" && !vscode.workspace.isTrusted;
  }

  getServersForUI(): McpServerStatusInfo[] {
    return this.entries.map(entry => {
      const info = this.toStatusInfo(entry, entry.enabled ? "idle" : "disabled");
      if (this.isUntrustedWorkspaceServer(entry)) info.untrusted = true;
      return info;
    });
  }

  getConfigLoaded(): boolean {
    return this.configLoaded;
  }

  /** Config files that exist but could not be used, so their servers are missing from the list. */
  getConfigErrors(): McpConfigError[] {
    return [...this.configErrors];
  }

  /**
   * The names the workspace `.mcp.json` defines in the currently-merged set. That source outranks
   * `~/.damocles/mcp.json`, so the write path rejects these names rather than persisting a server the
   * merge would then hide. Read off the merged entries, so it reflects exactly what the panel shows.
   */
  getWorkspaceServerNames(): ReadonlySet<string> {
    return new Set(this.entries.filter(entry => entry.source === "workspace").map(entry => entry.name));
  }

  /** Every merged server name, in merge order — the input `buildServerPrefixMap` sees at spawn time. */
  getServerNames(): string[] {
    return this.entries.map(entry => entry.name);
  }

  async loadConfig(): Promise<void> {
    // Three independent triggers reach this method — the panel write path, the file watchers and
    // session startup — and it awaits five reads before assigning. Without a generation stamp an older
    // read can finish last and install a staler snapshot; because `getEnabledServers()` feeds the live
    // MCP client, that does not merely show stale rows, it disconnects servers.
    const generation = ++this.loadGeneration;

    // Lowest precedence first: {claude, codex} ordered by `damocles.assetSourcePrecedence` (the loser
    // folded first so the configured winner overwrites it), then `~/.damocles/mcp.json`, then the
    // workspace `.mcp.json` folded below as the highest. Reusing the asset-precedence setting keeps
    // one knob governing every Claude-vs-Codex tie-break, so assets and MCP can never disagree.
    const { sources, errors } = await readGlobalMcpSources(getAssetSourcePrecedence());
    const configErrors = [...errors];

    let workspaceServers: Record<string, McpServerConfig> = {};
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const read = await readMcpConfigFile(path.join(workspaceFolder.uri.fsPath, ".mcp.json"));
      workspaceServers = read.servers;
      if (read.error) configErrors.push(read.error);
    }

    // An untrusted workspace's `.mcp.json` is folded LOWEST instead of highest. Folded highest it would
    // overwrite a same-named user-global server, and `getEnabledServers()` would then withhold the
    // merged entry for being workspace-sourced — so opening an untrusted repo that happens to name a
    // server `github` would silently stop your own trusted `github` from connecting. A repository you
    // have not trusted has no business overriding your settings; folded lowest it can still contribute
    // servers of its own, which stay visible, tagged `untrusted`, and withheld from the client.
    if (vscode.workspace.isTrusted) sources.push({ source: "workspace", servers: workspaceServers });
    else sources.unshift({ source: "workspace", servers: workspaceServers });

    const disabled = new Set(this.getDisabledServers());
    const entries = mergeMcpEntries(sources, disabled);

    if (generation !== this.loadGeneration) return;
    this.configErrors = configErrors;
    this.entries = entries;
    this.configLoaded = true;
  }

  buildRuntimeStatus(sdkStatuses: McpServerStatusInfo[]): McpServerStatusInfo[] {
    const statusMap = new Map(sdkStatuses.map(s => [s.name, s]));
    return this.entries.map(entry => {
      const sdkServer = statusMap.get(entry.name);
      const untrusted = this.isUntrustedWorkspaceServer(entry);
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
    // whenever the form can represent it losslessly — which is exactly when the write path would take
    // it back. Everything else (imports, and hand-authored keys the form cannot render) is withheld,
    // which is what makes Edit structurally incapable of destroying a definition it cannot show.
    //
    // Copied rather than aliased: the same object sits in `this.entries` and is handed to
    // `setMcpServers()`, so an in-extension consumer mutating what it received here would corrupt the
    // definition feeding the spawn chokepoint. (`postMessage` structured-clones, so the webview never
    // shared it in the first place.)
    if (entry.source === "damocles" && isFormEditableMcpServerConfig(entry.config)) {
      info.editableConfig = { ...entry.config };
    }
    return info;
  }
}
