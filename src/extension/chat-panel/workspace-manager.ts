import * as vscode from "vscode";
import * as path from "path";
import { SlashCommandService } from "../SlashCommandService";
import { CustomAgentService } from "../CustomAgentService";
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
  getEnabledPluginIds: () => Set<string>;
}

export class WorkspaceManager {
  private readonly workspacePath: string;
  private readonly postMessage: WorkspaceManagerConfig["postMessage"];
  private readonly broadcastToAllPanels: WorkspaceManagerConfig["broadcastToAllPanels"];
  private readonly getEnabledPluginIds: WorkspaceManagerConfig["getEnabledPluginIds"];
  private readonly slashCommandService: SlashCommandService;
  private readonly customAgentService: CustomAgentService;
  private readonly rewindDiffProvider: RewindDiffProvider;

  constructor(config: WorkspaceManagerConfig) {
    this.workspacePath = config.workspacePath;
    this.postMessage = config.postMessage;
    this.broadcastToAllPanels = config.broadcastToAllPanels;
    this.getEnabledPluginIds = config.getEnabledPluginIds;
    this.slashCommandService = new SlashCommandService(this.workspacePath);
    this.customAgentService = new CustomAgentService(this.workspacePath);
    this.rewindDiffProvider = new RewindDiffProvider();

    this.slashCommandService.setOnCacheInvalidate(() => {
      void this.broadcastSlashCommands();
    });

    this.customAgentService.setOnCacheInvalidate(() => {
      void this.broadcastCustomAgents();
    });
  }

  async broadcastSlashCommands(): Promise<void> {
    try {
      const commands = await this.getCustomSlashCommands(this.getEnabledPluginIds());
      this.broadcastToAllPanels({ type: "customSlashCommands", commands });
    } catch (err) {
      log("[WorkspaceManager] Error broadcasting slash commands:", err);
    }
  }

  async broadcastCustomAgents(): Promise<void> {
    try {
      const agents = await this.customAgentService.getCustomAgents();
      const pluginAgents = await this.customAgentService.getPluginAgents(this.getEnabledPluginIds());
      this.broadcastToAllPanels({ type: "customAgents", agents, pluginAgents });
    } catch (err) {
      log("[WorkspaceManager] Error broadcasting custom agents:", err);
    }
  }

  async isSkill(name: string, enabledPluginIds?: Set<string>): Promise<boolean> {
    return this.slashCommandService.isSkill(name, enabledPluginIds);
  }

  async getCustomSlashCommands(enabledPluginIds?: Set<string>): Promise<SlashCommandItem[]> {
    const customCommands = await this.slashCommandService.getCommands();
    const pluginCommands = await this.slashCommandService.getPluginCommands(enabledPluginIds);
    const skills = await this.slashCommandService.getSkills();
    const pluginSkills = await this.slashCommandService.getPluginSkills(enabledPluginIds);
    const allCommands = [
      ...BUILTIN_SLASH_COMMANDS,
      ...customCommands,
      ...pluginCommands,
      ...skills,
      ...pluginSkills,
    ];
    return allCommands.sort((a, b) => a.name.localeCompare(b.name));
  }

  async sendCustomSlashCommands(host: WebviewHost, enabledPluginIds?: Set<string>): Promise<void> {
    try {
      const commands = await this.getCustomSlashCommands(enabledPluginIds);
      this.postMessage(host, { type: "customSlashCommands", commands });
    } catch (err) {
      log("[WorkspaceManager] Error fetching custom slash commands:", err);
      this.postMessage(host, { type: "customSlashCommands", commands: BUILTIN_SLASH_COMMANDS });
    }
  }

  async getCustomAgents(): Promise<CustomAgentInfo[]> {
    return this.customAgentService.getCustomAgents();
  }

  async sendCustomAgents(host: WebviewHost, enabledPluginIds?: Set<string>): Promise<void> {
    try {
      const agents = await this.customAgentService.getCustomAgents();
      const pluginAgents = await this.customAgentService.getPluginAgents(enabledPluginIds);
      this.postMessage(host, { type: "customAgents", agents, pluginAgents });
    } catch (err) {
      log("[WorkspaceManager] Error fetching custom agents:", err);
      this.postMessage(host, { type: "customAgents", agents: [], pluginAgents: [] });
    }
  }

  async getWorkspaceFiles(): Promise<WorkspaceFileInfo[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
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
    let resolvedPath = filePath;

    if (filePath.startsWith("./") && this.workspacePath) {
      const absolutePath = path.resolve(this.workspacePath, filePath.slice(2));
      if (!absolutePath.startsWith(this.workspacePath)) {
        throw new Error("Path traversal attempt detected");
      }
      resolvedPath = absolutePath;
    }

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
    this.customAgentService.dispose();
    this.rewindDiffProvider.dispose();
  }
}
