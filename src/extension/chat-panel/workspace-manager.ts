import * as vscode from "vscode";
import * as path from "path";
import { SlashCommandService } from "./slash-command-service";
import { RewindDiffProvider } from "./rewind-diff-provider";
import { BUILTIN_SLASH_COMMANDS } from "../../shared/slashCommands";
import { listWorkspaceFiles, type FileResult } from "./ripgrep";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import type {
  CustomSlashCommandInfo,
  SkillInfo,
  SlashCommandItem,
  WorkspaceFileInfo,
} from "../../shared/types/commands";
import type { WebviewHost } from "./types";
import { log } from "../logger";

export interface WorkspaceManagerConfig {
  workspacePath: string;
  /** The open workspace folder, or null when none is open. Asset discovery skips project scope then. */
  projectPath: string | null;
  postMessage: (host: WebviewHost, message: ExtensionToWebviewMessage) => void;
  broadcastToAllPanels: (message: ExtensionToWebviewMessage) => void;
}

export class WorkspaceManager {
  private readonly workspacePath: string;
  private readonly postMessage: WorkspaceManagerConfig["postMessage"];
  private readonly broadcastToAllPanels: WorkspaceManagerConfig["broadcastToAllPanels"];
  private readonly slashCommandService: SlashCommandService;
  private readonly rewindDiffProvider: RewindDiffProvider;

  constructor(config: WorkspaceManagerConfig) {
    this.workspacePath = config.workspacePath;
    this.postMessage = config.postMessage;
    this.broadcastToAllPanels = config.broadcastToAllPanels;
    this.slashCommandService = new SlashCommandService(config.projectPath);
    this.rewindDiffProvider = new RewindDiffProvider();

    this.slashCommandService.setOnCacheInvalidate(() => {
      void this.broadcastSlashCommands();
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

  async findSkill(name: string): Promise<SkillInfo | undefined> {
    return this.slashCommandService.findSkill(name);
  }

  async findCommand(name: string): Promise<CustomSlashCommandInfo | undefined> {
    return this.slashCommandService.findCommand(name);
  }

  /**
   * The full menu, with one row per name. Precedence is builtin, then `.damocles`, then
   * `.claude`/`.codex`, and project before user within a source. A builtin always runs, so a custom
   * asset that collides with one would otherwise show a row that resolves to something else.
   */
  async getCustomSlashCommands(): Promise<SlashCommandItem[]> {
    const customCommands = await this.slashCommandService.getCommands();
    const skills = await this.slashCommandService.getSkills();
    const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((c) => c.name.toLowerCase()));
    const allCommands = [
      ...BUILTIN_SLASH_COMMANDS,
      ...customCommands.filter((c) => !builtinNames.has(c.name.toLowerCase())),
      ...skills.filter((s) => !builtinNames.has(s.name.toLowerCase())),
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

  /**
   * The single `customAgents` source is `PiSession` (via the workspace-level WorkspaceAgentRegistry),
   * which pushes the live set. This panel-scoped request returns an empty set so the webview clears any
   * stale list until PiSession's own emit arrives.
   */
  sendCustomAgents(host: WebviewHost): void {
    this.postMessage(host, { type: "customAgents", agents: [] });
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
    this.rewindDiffProvider.dispose();
  }
}
