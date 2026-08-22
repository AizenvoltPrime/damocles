import * as vscode from "vscode";
import * as path from "path";
import { LOCAL_MCP_RELATIVE_PATH } from "../../../../shared/types/mcp";
import type { McpConfigError, McpServerConfig, McpServerSource, McpServerStatusInfo, McpToolInfo } from "../../../../shared/types/mcp";
import type { McpServerEntry } from "../types";
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

/** workspaceState key for the Damocles-owned disabled-server set (replaces CC's disabledMcpjsonServers). */
export const MCP_DISABLED_SERVERS_KEY = "damocles.mcp.disabledServers";

function isRepoAuthored(entry: McpServerEntry): boolean {
  return REPO_AUTHORED_BY_SOURCE[entry.source];
}

/**
 * The sources folded after `target`, so they overwrite it on a name collision. Taken from the fold
 * that actually ran rather than from the static precedence, because an untrusted workspace demotes
 * the repo-authored sources below it.
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

export class McpManager {
  private entries: McpServerEntry[] = [];
  private configLoaded = false;
  private configErrors: McpConfigError[] = [];
  private localMcpUnignored = false;
  private shadowingSources: ReadonlySet<McpServerSource> = new Set();
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

    // The files Damocles or Codex own, so hand-editing any of them refreshes the panel with no window
    // reload. A watcher only reaches outside the workspace when its pattern has a base path.
    //
    // The two `~/.claude*` files are deliberately NOT watched: Claude Code rewrites its global file
    // continuously, and each event here reloads every source and re-drives `setMcpServers()`, cycling
    // live connections. Those still need a window reload — the right trade for another tool's file.
    // Claude Code's local scope lives in that same `~/.claude.json`, so it is excluded for the same
    // reason; the panel's Reload config action is how a change there is picked up.
    //
    // `.gitignore` is watched because the leak warning is sampled here too. Without it, adding the
    // line the panel asks for changes nothing on screen until some other config file happens to move.
    const patterns = [
      new vscode.RelativePattern(workspacePath, ".mcp.json"),
      new vscode.RelativePattern(workspacePath, LOCAL_MCP_RELATIVE_PATH),
      new vscode.RelativePattern(workspacePath, ".gitignore"),
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
   * servers from a file in the working tree are withheld in an untrusted workspace; the sources living
   * in the user's home directory are unaffected, because the repository you just opened cannot have
   * authored them). The test is `REPO_AUTHORED_BY_SOURCE` rather than `!readonly` or a scope check:
   * `damocles` entries are editable *and* trusted, and `claude-local` is project-scoped but written in
   * `~/.claude.json`, so either substitute would withhold servers a repo had no hand in. This is the
   * single chokepoint feeding the live MCP client.
   */
  getEnabledServers(): Record<string, McpServerConfig> {
    if (!this.isMasterEnabled()) return {};
    const trusted = vscode.workspace.isTrusted;
    return Object.fromEntries(
      this.entries
        .filter(entry => entry.enabled)
        .filter(entry => trusted || !isRepoAuthored(entry))
        .map(entry => [entry.name, entry.config])
    );
  }

  private isMasterEnabled(): boolean {
    return vscode.workspace.getConfiguration("damocles.mcp").get<boolean>("enabled", true);
  }

  /** A server from a working-tree file, withheld from connecting because the workspace is untrusted (M3). */
  private isUntrustedRepoServer(entry: McpServerEntry): boolean {
    return isRepoAuthored(entry) && !vscode.workspace.isTrusted;
  }

  getServersForUI(): McpServerStatusInfo[] {
    return this.entries.map(entry => {
      const info = this.toStatusInfo(entry, entry.enabled ? "idle" : "disabled");
      if (this.isUntrustedRepoServer(entry)) info.untrusted = true;
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
   * The names currently defined by a source that outranks `~/.damocles/mcp.json`, mapped to that
   * source. The write path rejects these rather than persisting a server the merge would then hide,
   * and the mapped source is what lets the rejection name the offending file. Read off the merged
   * entries and the fold that produced them, so it reflects exactly what the panel shows and cannot
   * claim a precedence the merge did not grant.
   */
  getShadowingServerNames(): ReadonlyMap<string, McpServerSource> {
    const shadowing = new Map<string, McpServerSource>();
    for (const entry of this.entries) {
      if (this.shadowingSources.has(entry.source)) {
        shadowing.set(entry.name, entry.source);
      }
    }
    return shadowing;
  }

  /**
   * True when `<ws>/.damocles/mcp.local.json` exists and git is not ignoring it, so the credentials it
   * may hold are one `git add` away from being published. Sampled during `loadConfig()`.
   */
  getLocalMcpUnignored(): boolean {
    return this.localMcpUnignored;
  }

  /** Every merged server name, in merge order — the input `buildServerPrefixMap` sees at spawn time. */
  getServerNames(): string[] {
    return this.entries.map(entry => entry.name);
  }

  async loadConfig(): Promise<void> {
    // Three independent triggers reach this method: the panel write path, the file watchers and
    // session startup. Every config read and the git check complete before anything is assigned, so
    // without a generation stamp an older run can finish last and install a staler snapshot. Because
    // `getEnabledServers()` feeds the live MCP client, that does not merely show stale rows, it
    // disconnects servers.
    const generation = ++this.loadGeneration;

    // One knob governs every Claude-vs-Codex tie-break, so assets and MCP can never disagree about it.
    const precedence = getAssetSourcePrecedence();
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    const workspaceFiles: readonly (readonly [McpServerSource, string])[] = workspaceRoot === undefined
      ? []
      : [
        ["workspace", path.join(workspaceRoot, ".mcp.json")],
        ["damocles-local", localMcpConfigPath(workspaceRoot)],
      ];

    // Asking git runs the repository's own `.git/config`, and `core.fsmonitor` in it is a command git
    // executes, so an untrusted workspace never gets asked. Its repo-authored servers are withheld
    // from the client anyway, which is what the warning protects.
    const localMcpCheck: Promise<boolean> | boolean = workspaceRoot !== undefined && vscode.workspace.isTrusted
      ? isLocalMcpFileUnignored(workspaceRoot)
      : false;

    const [global, localMcpUnignored, workspaceReads] = await Promise.all([
      readGlobalMcpSources(workspaceRoot),
      localMcpCheck,
      Promise.all(workspaceFiles.map(async ([source, file]) => ({ source, read: await readMcpConfigFile(file) }))),
    ]);

    const configErrors = [...global.errors];
    const sources = [...global.sources];
    for (const { source, read } of workspaceReads) {
      sources.push({ source, servers: read.servers });
      if (read.error) configErrors.push(read.error);
    }

    const ranked = orderMcpSources(sources, precedence);
    // In an untrusted workspace the sources a repository could have authored are folded LOWEST instead
    // of at their rank, keeping their order relative to each other. Folded at rank they would overwrite
    // same-named user-global servers, and the trust gate would then withhold the merged entry for being
    // repo-authored, so opening an untrusted repo that happens to name a server `github` would silently
    // stop your own trusted `github` from connecting. A repository you have not trusted has no business
    // overriding your settings; folded lowest it can still contribute servers of its own, which stay
    // visible, tagged `untrusted`, and withheld from the client.
    const folded = vscode.workspace.isTrusted
      ? ranked
      : [
        ...ranked.filter(entry => REPO_AUTHORED_BY_SOURCE[entry.source]),
        ...ranked.filter(entry => !REPO_AUTHORED_BY_SOURCE[entry.source]),
      ];

    const disabled = new Set(this.getDisabledServers());
    const entries = mergeMcpEntries(folded, disabled);

    if (generation !== this.loadGeneration) return;
    this.configErrors = configErrors;
    this.entries = entries;
    this.shadowingSources = sourcesFoldedAbove("damocles", folded);
    this.localMcpUnignored = localMcpUnignored;
    this.configLoaded = true;
  }

  buildRuntimeStatus(sdkStatuses: McpServerStatusInfo[]): McpServerStatusInfo[] {
    const statusMap = new Map(sdkStatuses.map(s => [s.name, s]));
    return this.entries.map(entry => {
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
