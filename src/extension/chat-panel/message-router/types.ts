import type * as vscode from "vscode";
import type { ChatSession } from "../../chat-session";
import type { PermissionHandler } from "../../permission-handler";
import type { IdeContextManager } from "../ide-context-manager";
import type { StorageManager } from "../storage-manager";
import type { HistoryManager } from "../history-manager";
import type { SettingsManager } from "../settings-manager";
import type { WorkspaceManager } from "../workspace-manager";
import type { MemoryService } from "../../memory";
import type { BrowserService } from "../../browser";
import type { CompassRegistry } from "../../compass/compass-registry";
import type { VoiceService } from "../../voice/service";
import type { UsageStatsService } from "../../usage-stats";
import type { HostInstance, WebviewHost } from "../types";
import type { FolderTarget, WorkspaceFolderRegistry } from "../../workspace-folders/folder-registry";
import type { AfterFolderSwitch, FolderSwitchReason } from "../panel-manager";
import type { WebviewToExtensionMessage, ExtensionToWebviewMessage } from "../../../shared/types/messages";

export interface HandlerContext {
  host: WebviewHost;
  session: ChatSession;
  permissionHandler: PermissionHandler;
  ideContextManager: IdeContextManager;
  panelId: string;
  folder: FolderTarget;
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
  /** Compass handlers act on the service of the requesting panel's folder. */
  compassRegistry?: CompassRegistry;
  voiceService?: VoiceService;
  usageStatsService: UsageStatsService;
  markUserTypedDuringTurn?: () => void;
  folderRegistry: WorkspaceFolderRegistry;
  /**
   * Resolves to the panel's instance on its new folder; a handler continues with it, never with `ctx.session`.
   * Work that must reach the new session before the webview's queued messages goes in `afterSwitch`.
   */
  switchPanelFolder: (
    panelId: string,
    folderKey: string,
    reason: FolderSwitchReason,
    afterSwitch?: AfterFolderSwitch,
  ) => Promise<HostInstance | undefined>;
  postWorkspaceFolderState: (panelId: string) => void;
}
