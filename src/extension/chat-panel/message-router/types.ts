import type * as vscode from "vscode";
import type { ClaudeSession } from "../../claude-session";
import type { PermissionHandler } from "../../permission-handler";
import type { IdeContextManager } from "../ide-context-manager";
import type { StorageManager } from "../storage-manager";
import type { HistoryManager } from "../history-manager";
import type { SettingsManager } from "../settings-manager";
import type { WorkspaceManager } from "../workspace-manager";
import type { MemoryService } from "../../memory";
import type { BrowserService } from "../../browser";
import type { TeamService } from "../../team";
import type { HostInstance, WebviewHost } from "../types";
import type { WebviewToExtensionMessage, ExtensionToWebviewMessage } from "../../../shared/types/messages";

export interface HandlerContext {
  host: WebviewHost;
  session: ClaudeSession;
  permissionHandler: PermissionHandler;
  ideContextManager: IdeContextManager;
  panelId: string;
}

export type MessageHandler = (
  message: WebviewToExtensionMessage,
  ctx: HandlerContext
) => Promise<void> | void;

export type HandlerRegistry = Record<string, MessageHandler>;

export type PostMessageFn = (
  host: WebviewHost,
  message: ExtensionToWebviewMessage
) => void;

export interface HandlerDependencies {
  workspacePath: string;
  postMessage: PostMessageFn;
  getPanels: () => Map<string, HostInstance>;
  storageManager: StorageManager;
  historyManager: HistoryManager;
  settingsManager: SettingsManager;
  workspaceManager: WorkspaceManager;
  context: vscode.ExtensionContext;
  getLanguagePreference: () => string;
  setLanguagePreference: (locale: string) => Promise<void>;
  memoryService: MemoryService;
  browserService?: BrowserService;
  teamService?: TeamService;
}
