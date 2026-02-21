import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import type { ClaudeSession } from "../../../claude-session";
import type { WebviewHost } from "../../types";
import type { McpServerConfig, McpServerStatusInfo, McpToolInfo } from "../../../../shared/types/mcp";
import type { PostMessageFn, McpServerEntry } from "../types";
import { syncDisabledServersToClaudeSettings } from "../utils";
import { readClaudeSettings } from "../../../claude-settings";
import { log } from "../../../logger";

export class McpManager {
  private entries: McpServerEntry[] = [];
  private configLoaded = false;
  private watcher: vscode.FileSystemWatcher | null = null;
  private toggleLock: Promise<void> = Promise.resolve();
  private onConfigChange?: () => void;
  private readonly postMessage: PostMessageFn;

  constructor(postMessage: PostMessageFn) {
    this.postMessage = postMessage;
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

  async setServerEnabled(serverName: string, enabled: boolean): Promise<void> {
    const previousLock = this.toggleLock;
    let releaseLock: () => void;
    this.toggleLock = new Promise(resolve => { releaseLock = resolve; });

    try {
      await previousLock;

      await syncDisabledServersToClaudeSettings(serverName, !enabled);

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

  getEnabledServers(): Record<string, McpServerConfig> {
    return Object.fromEntries(
      this.entries
        .filter(entry => entry.enabled)
        .map(entry => [entry.name, entry.config])
    );
  }

  getServersForUI(): McpServerStatusInfo[] {
    return this.entries.map(entry => ({
      name: entry.name,
      status: entry.enabled ? "idle" : "disabled",
      enabled: entry.enabled,
    }));
  }

  getConfigLoaded(): boolean {
    return this.configLoaded;
  }

  async loadConfig(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      this.entries = [];
      this.configLoaded = true;
      return;
    }

    const mcpConfigPath = path.join(workspaceFolder.uri.fsPath, ".mcp.json");
    try {
      const content = await fs.promises.readFile(mcpConfigPath, "utf-8");
      const config = JSON.parse(content);
      const servers: Record<string, McpServerConfig> = config.mcpServers || config;
      const claudeSettings = await readClaudeSettings();
      const disabledServers = Array.isArray(claudeSettings["disabledMcpjsonServers"])
        ? claudeSettings["disabledMcpjsonServers"] as string[]
        : [];

      this.entries = Object.entries(servers).map(([name, serverConfig]) => ({
        name,
        config: serverConfig,
        enabled: !disabledServers.includes(name),
      }));
    } catch {
      this.entries = [];
    }
    this.configLoaded = true;
  }

  async sendStatus(session: ClaudeSession, host: WebviewHost): Promise<void> {
    const sdkStatus = await session.getMcpServerStatus();
    if (sdkStatus) {
      const statusMap = new Map(sdkStatus.map(s => [s.name, s]));
      const mergedServers: McpServerStatusInfo[] = this.entries.map(entry => {
        const sdkServer = statusMap.get(entry.name);
        return {
          name: entry.name,
          status: entry.enabled
            ? (sdkServer?.status as McpServerStatusInfo["status"]) || "pending"
            : "disabled",
          enabled: entry.enabled,
          ...(sdkServer?.serverInfo && { serverInfo: sdkServer.serverInfo }),
          ...(sdkServer?.error && { error: sdkServer.error }),
          ...(sdkServer?.tools && { tools: sdkServer.tools as McpToolInfo[] }),
        };
      });
      this.postMessage(host, { type: "mcpServerStatus", servers: mergedServers });
    }
  }

  sendConfig(host: WebviewHost): void {
    this.postMessage(host, { type: "mcpConfigUpdate", servers: this.getServersForUI() });
  }
}
