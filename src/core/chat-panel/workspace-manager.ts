import * as fs from "fs";
import { homedir } from "os";
import type { Platform } from "../../platform/platform";
import * as path from "path";
import { SlashCommandService } from "./slash-command-service";
import { BUILTIN_SLASH_COMMANDS } from "../../shared/slashCommands";
import { listWorkspaceFiles, type FileResult } from "./ripgrep";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import type {
  CustomSlashCommandInfo,
  SkillInfo,
  SlashCommandItem,
  WorkspaceFileInfo,
} from "../../shared/types/commands";
import type { HostInstance } from "./types";
import type { PanelHost } from "../../platform/window-service";
import type { FolderTarget } from "../workspace-folders/folder-registry";
import { log } from "../logger";
import { errorTextOf, l } from "../l10n";
import { isWithinRoot } from "../compass/util";
import { isInsideFolder, isUncOrDevicePath } from "../../shared/project-location";
import { LocalizedError } from "../../shared/localized-text";

/** `~`, `~/…` (and `~\…` on Windows) name this machine's home, as pi's `normalizePath` reads them. */
function expandHome(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/") || (process.platform === "win32" && filePath.startsWith("~\\"))) return path.join(homedir(), filePath.slice(2));
  return filePath;
}

export interface WorkspaceManagerConfig {
  postMessage: (host: PanelHost, message: ExtensionToWebviewMessage) => void;
  getPanels: () => Map<string, HostInstance>;
  platform: Platform;
}

export class WorkspaceManager {
  private readonly postMessage: WorkspaceManagerConfig["postMessage"];
  private readonly getPanels: WorkspaceManagerConfig["getPanels"];
  private readonly platform: Platform;
  /** One per folder a panel has targeted, keyed by folder key; each watches only its own project dirs. */
  private readonly slashCommandServices = new Map<string, SlashCommandService>();

  constructor(config: WorkspaceManagerConfig) {
    this.postMessage = config.postMessage;
    this.getPanels = config.getPanels;
    this.platform = config.platform;
  }

  private slashCommandService(folder: FolderTarget): SlashCommandService {
    const existing = this.slashCommandServices.get(folder.key);
    if (existing) return existing;
    const service = new SlashCommandService(folder.projectScope ? folder.fsPath : null, this.platform);
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

  async sendCustomSlashCommands(host: PanelHost, folder: FolderTarget): Promise<void> {
    this.postMessage(host, await this.customSlashCommandsMessage(folder));
  }

  /**
   * The single `customAgents` source is `PiSession` (via the workspace-level WorkspaceAgentRegistry),
   * which pushes the live set. This panel-scoped request returns an empty set so the webview clears any
   * stale list until PiSession's own emit arrives.
   */
  sendCustomAgents(host: PanelHost): void {
    this.postMessage(host, { type: "customAgents", agents: [] });
  }

  async getWorkspaceFiles(folder: FolderTarget): Promise<WorkspaceFileInfo[]> {
    if (!folder.projectScope) {
      log("[WorkspaceManager] getWorkspaceFiles: no workspace folder open, returning []");
      return [];
    }
    const files = await listWorkspaceFiles(this.platform, folder.fsPath);
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

  async sendWorkspaceFiles(host: PanelHost, folder: FolderTarget): Promise<void> {
    this.postMessage(host, await this.workspaceFilesMessage(folder));
  }

  async openFile(filePath: string, line: number | undefined, folder: FolderTarget, panelId: string): Promise<void> {
    // Tool cards carry the path the agent used, which for pi's write/edit tools is cwd-relative with no
    // `./` prefix. The agent's cwd is the panel's folder, so a relative path resolves against it rather
    // than against the drive root (`\hello_world.ts`). Deliberately no containment
    // guard here (unlike the rewind diff): the agent legitimately reads/writes files outside the folder,
    // and this only opens a file in the editor (no write), so absolute and `..` paths must resolve to the
    // real file the card names. A leading `~` is this machine's home, the chat's, as pi's tools expand it.
    const expanded = expandHome(filePath);
    const resolvedPath = path.isAbsolute(expanded) ? expanded : path.resolve(folder.fsPath, expanded);

    // A stat of a share or device path contacts that machine with the user's credentials: the host's editor decides it, unless
    // a workspace folder holds it as written.
    if (process.platform === "win32" && isUncOrDevicePath(resolvedPath) && !this.platform.workspaceFolders.folders().some((f) => isInsideFolder({ os: "win32" }, f.fsPath, resolvedPath))) {
      await this.platform.editor.openFile(resolvedPath, { ...(line && line > 0 ? { line } : {}), panelId });
      return;
    }
    const editorOptions = { ...(line && line > 0 ? { line } : {}), panelId };
    const absolute = path.resolve(resolvedPath);
    const holder = this.platform.workspaceFolders.folders().filter((f) => isWithinRoot(absolute, f.fsPath)).sort((a, b) => b.fsPath.length - a.fsPath.length)[0];
    // The host's confinement resolves the path before the stat (desktop's walks it first, so no stat follows a link on it to a
    // share); a path it does not confine there, a link leading out or a realpath that fails, is the host's editor's to decide.
    const walkedFrom = holder?.fsPath ?? path.parse(absolute).root;
    const confined = await this.platform.confinement.confineExisting(walkedFrom, path.relative(walkedFrom, absolute).split(path.sep).join("/"));
    if (!confined.ok) {
      if (confined.reason === "missing") throw new LocalizedError(l("Could not open file: {0}", filePath));
      await this.platform.editor.openFile(resolvedPath, editorOptions);
      return;
    }
    // a mapped drive's realpath is its share, which only a workspace folder's own makes safe to stat
    if (!holder && process.platform === "win32" && isUncOrDevicePath(confined.path)) {
      await this.platform.editor.openFile(resolvedPath, editorOptions);
      return;
    }
    const stats = await fs.promises.stat(confined.path);
    if (stats.isDirectory()) {
      // VS Code's explorer reveal silently does nothing for a folder outside every workspace folder.
      if (!holder) throw new LocalizedError(l("Could not open file: {0}", filePath));
      await this.platform.shell.revealPath(absolute);
      return;
    }
    // The default editor for the file type: image preview for images, the text editor for text.
    await this.platform.editor.openFile(resolvedPath, editorOptions);
  }

  async handleOpenFile(panelId: string, filePath: string, line: number | undefined, folder: FolderTarget): Promise<void> {
    try {
      await this.openFile(filePath, line, folder, panelId);
    } catch (err) {
      log("[WorkspaceManager] Error opening file:", err);
      void this.platform.notifications.error(err instanceof LocalizedError ? err.text : l("Could not open {0}: {1}", filePath, errorTextOf(err)));
    }
  }

  async showRewindDiff(filePath: string, beforeContent: string, panelId: string): Promise<void> {
    const fileName = path.basename(filePath);
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await this.platform.editor.showDiff({
      title: (name) => l("{0} (At checkpoint ↔ Current)", name),
      filePath,
      left: { name: `${id}-${fileName}`, content: beforeContent },
      right: { path: filePath },
      purpose: "checkpoint",
      preview: true,
      panelId,
    });
  }

  /**
   * Resolves a webview-supplied file path to an absolute path contained in the panel's folder.
   * Returns null if the path escapes that folder (path traversal defense).
   */
  resolveWorkspaceFilePath(filePath: string, folder: FolderTarget): string | null {
    return folder.fsPath ? this.resolveFileWithin(filePath, folder.fsPath) : null;
  }

  /** Resolves a webview-supplied file path to an absolute path contained in `root`, or null when it escapes it. */
  resolveFileWithin(filePath: string, root: string): string | null {
    const absolute = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
    const relative = path.relative(path.resolve(root), absolute);
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
  }
}
