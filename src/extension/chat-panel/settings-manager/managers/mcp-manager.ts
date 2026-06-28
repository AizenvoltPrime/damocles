import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import type { McpServerConfig, McpServerStatusInfo, McpToolInfo } from "../../../../shared/types/mcp";
import type { McpServerEntry } from "../types";
import { importClaudeMcpServers, mergeMcpEntries, coerceServerMap } from "./mcp-config-import";
import { log } from "../../../logger";

/** workspaceState key for the Damocles-owned disabled-server set (replaces CC's disabledMcpjsonServers). */
export const MCP_DISABLED_SERVERS_KEY = "damocles.mcp.disabledServers";

export class McpManager {
  private entries: McpServerEntry[] = [];
  private configLoaded = false;
  private watcher: vscode.FileSystemWatcher | null = null;
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
    if (this.watcher) return;

    const pattern = new vscode.RelativePattern(workspacePath, ".mcp.json");
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const reload = async () => {
      this.configLoaded = false;
      await this.loadConfig();
      this.onConfigChange?.();
    };

    this.watcher.onDidCreate(reload);
    this.watcher.onDidChange(reload);
    this.watcher.onDidDelete(reload);
  }

  dispose(): void {
    this.watcher?.dispose();
  }

  private getDisabledServers(): string[] {
    const raw = this.workspaceState.get<string[]>(MCP_DISABLED_SERVERS_KEY, []);
    return Array.isArray(raw) ? raw : [];
  }

  async setServerEnabled(serverName: string, enabled: boolean): Promise<void> {
    const previousLock = this.toggleLock;
    let releaseLock: () => void;
    this.toggleLock = new Promise(resolve => { releaseLock = resolve; });

    try {
      await previousLock;

      const disabled = new Set(this.getDisabledServers());
      if (enabled) disabled.delete(serverName);
      else disabled.add(serverName);
      await this.workspaceState.update(MCP_DISABLED_SERVERS_KEY, [...disabled]);

      const entry = this.entries.find(e => e.name === serverName);
      if (entry) {
        entry.enabled = enabled;
      } else {
        log("[McpManager] setServerEnabled: entry not found for", serverName);
      }
    } finally {
      releaseLock!();
    }
  }

  /**
   * The set of servers that should actually be connected. Gated by the master `damocles.mcp.enabled`
   * switch (M6: off ⇒ none, so disabling tears down live connections) and by workspace trust (M3:
   * workspace `.mcp.json` servers are withheld in an untrusted workspace; user-global Claude imports
   * are unaffected). This is the single chokepoint feeding the live MCP client.
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

  async loadConfig(): Promise<void> {
    const importServers = await importClaudeMcpServers();

    let workspaceServers: Record<string, McpServerConfig> = {};
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const mcpConfigPath = path.join(workspaceFolder.uri.fsPath, ".mcp.json");
      try {
        const config = JSON.parse(await fs.promises.readFile(mcpConfigPath, "utf-8"));
        // Read the `mcpServers` map only (matching the Claude-import path) and validate each entry, so a
        // bare top-level object or junk keys like `$schema` can't become phantom servers (M8/M9).
        workspaceServers = coerceServerMap((config as Record<string, unknown>)?.["mcpServers"]);
      } catch {
        workspaceServers = {};
      }
    }

    const disabled = new Set(this.getDisabledServers());
    this.entries = mergeMcpEntries(workspaceServers, importServers, disabled);
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
    return info;
  }
}
