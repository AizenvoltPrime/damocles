import type * as vscode from "vscode";
import type { ClaudeSession } from "../../claude-session";
import type { PermissionHandler } from "../../permission-handler";
import type { IdeContextManager } from "../ide-context-manager";
import type { StorageManager } from "../storage-manager";
import type { HistoryManager } from "../history-manager";
import type { SettingsManager } from "../settings-manager";
import type { WorkspaceManager } from "../workspace-manager";
import type { MemoryService } from "../../memory";
import type { PanelInstance } from "../types";
import type { WebviewToExtensionMessage, ExtensionToWebviewMessage } from "../../../shared/types/messages";

export interface HandlerContext {
  panel: vscode.WebviewPanel;
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
  panel: vscode.WebviewPanel,
  message: ExtensionToWebviewMessage
) => void;

export interface HandlerDependencies {
  workspacePath: string;
  postMessage: PostMessageFn;
  getPanels: () => Map<string, PanelInstance>;
  storageManager: StorageManager;
  historyManager: HistoryManager;
  settingsManager: SettingsManager;
  workspaceManager: WorkspaceManager;
  context: vscode.ExtensionContext;
  getLanguagePreference: () => string;
  setLanguagePreference: (locale: string) => Promise<void>;
  memoryService: MemoryService;
}
