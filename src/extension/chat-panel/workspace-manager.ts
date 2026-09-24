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
import type { HostInstance, WebviewHost } from "./types";
import type { FolderTarget } from "../workspace-folders/folder-registry";
import { log } from "../logger";

export interface WorkspaceManagerConfig {
  postMessage: (host: WebviewHost, message: ExtensionToWebviewMessage) => void;
  getPanels: () => Map<string, HostInstance>;
}

export class WorkspaceManager {
  private readonly postMessage: WorkspaceManagerConfig["postMessage"];
  private readonly getPanels: WorkspaceManagerConfig["getPanels"];
  /** One per folder a panel has targeted, keyed by folder key; each watches only its own project dirs. */
  private readonly slashCommandServices = new Map<string, SlashCommandService>();
  private readonly rewindDiffProvider: RewindDiffProvider;

  constructor(config: WorkspaceManagerConfig) {
    this.postMessage = config.postMessage;
    this.getPanels = config.getPanels;
    this.rewindDiffProvider = new RewindDiffProvider();
  }

  private slashCommandService(folder: FolderTarget): SlashCommandService {
    const existing = this.slashCommandServices.get(folder.key);
    if (existing) return existing;
    const service = new SlashCommandService(folder.projectScope ? folder.fsPath : null);
    service.setOnCacheInvalidate(() => {
      void this.broadcastSlashCommands(folder);
    });
    this.slashCommandServices.set(folder.key, service);
    return service;
  }

  broadcastToFolder(key: string, message: ExtensionToWebviewMessage): void {
    for (const [, instance] of this.getPanels()) {
      if (instance.folder.key === key) this.postMessage(instance.host, message);
    }
  }

  private async broadcastSlashCommands(folder: FolderTarget): Promise<void> {
    try {
      const commands = await this.getCustomSlashCommands(folder);
      this.broadcastToFolder(folder.key, { type: "customSlashCommands", commands });
    } catch (err) {
      log("[WorkspaceManager] Error broadcasting slash commands:", err);
    }
  }

  async findSkill(name: string, folder: FolderTarget): Promise<SkillInfo | undefined> {
    return this.slashCommandService(folder).findSkill(name);
  }

  async findCommand(name: string, folder: FolderTarget): Promise<CustomSlashCommandInfo | undefined> {
    return this.slashCommandService(folder).findCommand(name);
  }

  /**
   * The full menu, with one row per name. Precedence is builtin, then `.damocles`, then
   * `.claude`/`.codex`, and project before user within a source. A builtin always runs, so a custom
   * asset that collides with one would otherwise show a row that resolves to something else.
   */
  async getCustomSlashCommands(folder: FolderTarget): Promise<SlashCommandItem[]> {
    const service = this.slashCommandService(folder);
    const customCommands = await service.getCommands();
    const skills = await service.getSkills();
    const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((c) => c.name.toLowerCase()));
    const allCommands = [
      ...BUILTIN_SLASH_COMMANDS,
      ...customCommands.filter((c) => !builtinNames.has(c.name.toLowerCase())),
      ...skills.filter((s) => !builtinNames.has(s.name.toLowerCase())),
    ];
    return allCommands.sort((a, b) => a.name.localeCompare(b.name));
  }

  async customSlashCommandsMessage(folder: FolderTarget): Promise<ExtensionToWebviewMessage> {
    try {
      return { type: "customSlashCommands", commands: await this.getCustomSlashCommands(folder) };
    } catch (err) {
      log("[WorkspaceManager] Error fetching custom slash commands:", err);
      return { type: "customSlashCommands", commands: BUILTIN_SLASH_COMMANDS };
    }
  }

  async sendCustomSlashCommands(host: WebviewHost, folder: FolderTarget): Promise<void> {
    this.postMessage(host, await this.customSlashCommandsMessage(folder));
  }

  /**
   * The single `customAgents` source is `PiSession` (via the workspace-level WorkspaceAgentRegistry),
   * which pushes the live set. This panel-scoped request returns an empty set so the webview clears any
   * stale list until PiSession's own emit arrives.
   */
  sendCustomAgents(host: WebviewHost): void {
    this.postMessage(host, { type: "customAgents", agents: [] });
  }

  async getWorkspaceFiles(folder: FolderTarget): Promise<WorkspaceFileInfo[]> {
    if (!folder.projectScope) {
      log("[WorkspaceManager] getWorkspaceFiles: no workspace folder open, returning []");
      return [];
    }
    const files = await listWorkspaceFiles(folder.fsPath);
    return files.map((f: FileResult) => ({
      relativePath: f.relativePath,
      isDirectory: f.isDirectory,
    }));
  }

  async workspaceFilesMessage(folder: FolderTarget): Promise<ExtensionToWebviewMessage> {
    try {
      return { type: "workspaceFiles", files: await this.getWorkspaceFiles(folder) };
    } catch (err) {
      log("[WorkspaceManager] Error fetching workspace files:", err);
      return { type: "workspaceFiles", files: [] };
    }
  }

  async sendWorkspaceFiles(host: WebviewHost, folder: FolderTarget): Promise<void> {
    this.postMessage(host, await this.workspaceFilesMessage(folder));
  }

  async openFile(filePath: string, line: number | undefined, folder: FolderTarget): Promise<void> {
    // Tool cards carry the path the agent used, which for pi's write/edit tools is cwd-relative with no
    // `./` prefix. The agent's cwd is the panel's folder, so a relative path resolves against it and
    // `Uri.file` does not anchor it at the drive root (`\hello_world.ts`). Deliberately no containment
    // guard here (unlike the rewind diff): the agent legitimately reads/writes files outside the folder,
    // and this only opens a file in the editor (no write), so absolute and `..` paths must resolve to the
    // real file the card names.
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(folder.fsPath, filePath);

    const uri = vscode.Uri.file(resolvedPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);

    if (line && line > 0) {
      const position = new vscode.Position(line - 1, 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }
  }

  async handleOpenFile(_host: WebviewHost, filePath: string, line: number | undefined, folder: FolderTarget): Promise<void> {
    try {
      await this.openFile(filePath, line, folder);
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
   * Resolves a webview-supplied file path to an absolute path contained in the panel's folder.
   * Returns null if the path escapes that folder (path traversal defense).
   */
  resolveWorkspaceFilePath(filePath: string, folder: FolderTarget): string | null {
    if (!folder.fsPath) return null;
    const absolute = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(folder.fsPath, filePath);
    const workspaceRoot = path.resolve(folder.fsPath);
    const relative = path.relative(workspaceRoot, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return absolute;
  }

  /** Drop the slash-command service of a folder that left the workspace. */
  disposeFolder(key: string): void {
    this.slashCommandServices.get(key)?.dispose();
    this.slashCommandServices.delete(key);
  }

  dispose(): void {
    for (const service of this.slashCommandServices.values()) service.dispose();
    this.slashCommandServices.clear();
    this.rewindDiffProvider.dispose();
  }
}
