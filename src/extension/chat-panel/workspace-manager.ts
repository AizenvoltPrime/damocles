import * as vscode from "vscode";
import * as path from "path";
import { SlashCommandService } from "../SlashCommandService";
import { CustomAgentService } from "../CustomAgentService";
import { getEffectiveHarness } from "../pi-session/harness";
import { RewindDiffProvider } from "./rewind-diff-provider";
import { BUILTIN_SLASH_COMMANDS } from "../../shared/slashCommands";
import { listWorkspaceFiles, type FileResult } from "../ripgrep";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import type { SlashCommandItem, WorkspaceFileInfo, CustomAgentInfo } from "../../shared/types/commands";
import type { WebviewHost } from "./types";
import { log } from "../logger";

export interface WorkspaceManagerConfig {
  workspacePath: string;
  postMessage: (host: WebviewHost, message: ExtensionToWebviewMessage) => void;
  broadcastToAllPanels: (message: ExtensionToWebviewMessage) => void;
}

export class WorkspaceManager {
  private readonly workspacePath: string;
  private readonly postMessage: WorkspaceManagerConfig["postMessage"];
  private readonly broadcastToAllPanels: WorkspaceManagerConfig["broadcastToAllPanels"];
  private readonly slashCommandService: SlashCommandService;
  /** Workspace-level markdown-agent source ONLY on the SDK fallback harness. On the pi harness the
   *  single `customAgents` source is `PiSession` (via the workspace-level WorkspaceAgentRegistry), so
   *  this stays null to avoid a divergent second source and a duplicate filesystem watcher (§4.6). */
  private readonly customAgentService: CustomAgentService | null;
  private readonly rewindDiffProvider: RewindDiffProvider;

  constructor(config: WorkspaceManagerConfig) {
    this.workspacePath = config.workspacePath;
    this.postMessage = config.postMessage;
    this.broadcastToAllPanels = config.broadcastToAllPanels;
    this.slashCommandService = new SlashCommandService(this.workspacePath);
    this.customAgentService =
      getEffectiveHarness() === "sdk" ? new CustomAgentService(this.workspacePath) : null;
    this.rewindDiffProvider = new RewindDiffProvider();

    this.slashCommandService.setOnCacheInvalidate(() => {
      void this.broadcastSlashCommands();
    });

    this.customAgentService?.setOnCacheInvalidate(() => {
      void this.broadcastCustomAgents();
    });
  }

  async broadcastSlashCommands(): Promise<void> {
    try {
      const commands = await this.getCustomSlashCommands();
      this.broadcastToAllPanels({ type: "customSlashCommands", commands });
    } catch (err) {
      log("[WorkspaceManager] Error broadcasting slash commands:", err);
    }
  }

  async broadcastCustomAgents(): Promise<void> {
    if (!this.customAgentService) return;
    try {
      const agents = await this.customAgentService.getCustomAgents();
      this.broadcastToAllPanels({ type: "customAgents", agents });
    } catch (err) {
      log("[WorkspaceManager] Error broadcasting custom agents:", err);
    }
  }

  async isSkill(name: string): Promise<boolean> {
    return this.slashCommandService.isSkill(name);
  }

  async getCustomSlashCommands(): Promise<SlashCommandItem[]> {
    const customCommands = await this.slashCommandService.getCommands();
    const skills = await this.slashCommandService.getSkills();
    const allCommands = [
      ...BUILTIN_SLASH_COMMANDS,
      ...customCommands,
      ...skills,
    ];
    return allCommands.sort((a, b) => a.name.localeCompare(b.name));
  }

  async sendCustomSlashCommands(host: WebviewHost): Promise<void> {
    try {
      const commands = await this.getCustomSlashCommands();
      this.postMessage(host, { type: "customSlashCommands", commands });
    } catch (err) {
      log("[WorkspaceManager] Error fetching custom slash commands:", err);
      this.postMessage(host, { type: "customSlashCommands", commands: BUILTIN_SLASH_COMMANDS });
    }
  }

  async getCustomAgents(): Promise<CustomAgentInfo[]> {
    return this.customAgentService?.getCustomAgents() ?? [];
  }

  async sendCustomAgents(host: WebviewHost): Promise<void> {
    if (!this.customAgentService) {
      this.postMessage(host, { type: "customAgents", agents: [] });
      return;
    }
    try {
      const agents = await this.customAgentService.getCustomAgents();
      this.postMessage(host, { type: "customAgents", agents });
    } catch (err) {
      log("[WorkspaceManager] Error fetching custom agents:", err);
      this.postMessage(host, { type: "customAgents", agents: [] });
    }
  }

  async getWorkspaceFiles(): Promise<WorkspaceFileInfo[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      log("[WorkspaceManager] getWorkspaceFiles: no workspace folder open, returning []");
      return [];
    }
    const files = await listWorkspaceFiles(workspaceFolder.uri.fsPath);
    return files.map((f: FileResult) => ({
      relativePath: f.relativePath,
      isDirectory: f.isDirectory,
    }));
  }

  async sendWorkspaceFiles(host: WebviewHost): Promise<void> {
    try {
      const files = await this.getWorkspaceFiles();
      this.postMessage(host, { type: "workspaceFiles", files });
    } catch (err) {
      log("[WorkspaceManager] Error fetching workspace files:", err);
      this.postMessage(host, { type: "workspaceFiles", files: [] });
    }
  }

  async openFile(filePath: string, line?: number): Promise<void> {
    // Tool cards carry the path the agent used, which for pi's write/edit tools is cwd-relative with no
    // `./` prefix. Resolve any relative path against the workspace so `Uri.file` doesn't anchor it at the
    // drive root (`\hello_world.ts`). DELIBERATELY no workspace-containment guard here (unlike the rewind
    // diff): the agent legitimately reads/writes files outside the workspace, and this only opens a file
    // in the editor (no write), so absolute and `..` paths must resolve to the real file the card names.
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(this.workspacePath, filePath);

    const uri = vscode.Uri.file(resolvedPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);

    if (line && line > 0) {
      const position = new vscode.Position(line - 1, 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }
  }

  async handleOpenFile(_host: WebviewHost, filePath: string, line?: number): Promise<void> {
    try {
      await this.openFile(filePath, line);
    } catch (err) {
      log("[WorkspaceManager] Error opening file:", err);
      vscode.window.showErrorMessage(vscode.l10n.t("Could not open file: {0}", filePath));
    }
  }

  async showRewindDiff(filePath: string, beforeContent: string): Promise<void> {
    const fileName = path.basename(filePath);
    const title = vscode.l10n.t("{0} (At checkpoint ↔ Current)", fileName);
    await this.rewindDiffProvider.showDiff(filePath, beforeContent, title);
  }

  /**
   * Resolves a webview-supplied file path to an absolute path contained in the workspace.
   * Returns null if the path escapes the workspace (path traversal defense).
   */
  resolveWorkspaceFilePath(filePath: string): string | null {
    if (!this.workspacePath) return null;
    const absolute = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(this.workspacePath, filePath);
    const workspaceRoot = path.resolve(this.workspacePath);
    const relative = path.relative(workspaceRoot, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return absolute;
  }

  dispose(): void {
    this.slashCommandService.dispose();
    this.customAgentService?.dispose();
    this.rewindDiffProvider.dispose();
  }
}
