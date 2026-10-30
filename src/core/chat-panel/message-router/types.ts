import type { Disposable } from "../../../platform/disposable";
import type { Platform } from "../../../platform/platform";
import type { ChatSession } from "../../chat-session";
import type { PermissionHandler } from "../../permission-handler";
import type { IdeContextManager } from "../ide-context-manager";
import type { TerminalAttachmentManager } from "../terminal-attachment-manager";
import type { StorageManager } from "../storage-manager";
import type { SessionCatalog } from "../session-catalog";
import type { HistoryManager } from "../history-manager";
import type { SettingsManager } from "../settings-manager";
import type { WorkspaceManager } from "../workspace-manager";
import type { MemoryService } from "../../memory";
import type { BrowserService } from "../../browser";
import type { CompassRegistry } from "../../compass/compass-registry";
import type { VoiceService } from "../../voice/service";
import type { UsageStatsService } from "../../usage-stats";
import type { AttachedView, HostInstance, ViewJoinGate } from "../types";
import type { PanelHost } from "../../../platform/window-service";
import type { FolderTarget, WorkspaceFolderRegistry } from "../../workspace-folders/folder-registry";
import type { AfterFolderSwitch, FolderSwitchReason } from "../panel-manager";
import type { WebviewPrompts } from "../webview-prompts";
import type { PanelWorktrees } from "../panel-worktrees";
import type { WebviewToExtensionMessage, ExtensionToWebviewMessage } from "../../../shared/types/messages";

export interface HandlerContext {
  /** The panel's host: every view of the chat, which shared chat state (conversation, mode, effort) reaches; state read from the user layer or account goes per device (`forEachDevice`). */
  host: PanelHost;
  /** The sending view's host, for what answers the sender alone (a request's reply, an ack, an error, a refusal); `host` when the panel has one view. */
  reply: PanelHost;
  session: ChatSession;
  permissionHandler: PermissionHandler;
  ideContextManager: IdeContextManager;
  terminalAttachments: TerminalAttachmentManager;
  panelId: string;
  folder: FolderTarget;
  /** The attached settings view that sent the message, for a message from `PanelManager.dispatchFromView`; replies go to `reply`, its device's chat views, which copy the view's types to it. */
  view?: AttachedView;
  /** The chat view of several that sent the message (a daemon's client), whose host `reply` is; what core gives back from its send goes to it alone (send-senders.ts). */
  viewKey?: string;
}

export type MessageHandler = (
  message: WebviewToExtensionMessage,
  ctx: HandlerContext
) => Promise<void> | void;

export type HandlerRegistry = Record<string, MessageHandler>;

/** A remote chat view's message on this computer's core (VOICE_VIEW_MESSAGES) has no chat here: its handler reads only the host it replies to. */
export type ViewHandlerContext = Pick<HandlerContext, "host">;

export type ViewHandlerRegistry = Record<string, (message: WebviewToExtensionMessage, ctx: ViewHandlerContext) => Promise<void> | void>;

export type PostMessageFn = (
  host: PanelHost,
  message: ExtensionToWebviewMessage
) => void;

export interface HandlerDependencies {
  postMessage: PostMessageFn;
  getPanels: () => Map<string, HostInstance>;
  storageManager: StorageManager;
  sessionCatalog: SessionCatalog;
  historyManager: HistoryManager;
  settingsManager: SettingsManager;
  workspaceManager: WorkspaceManager;
  platform: Platform;
  // Disposed when the extension deactivates.
  subscriptions: Disposable[];
  // the language a device's views render core's text in; clientId names the device on a daemon's core
  getLanguagePreference: (clientId?: string) => string;
  setLanguagePreference: (locale: string) => Promise<void>;
  memoryService: MemoryService;
  browserService?: BrowserService;
  /** Compass handlers act on the service of the requesting panel's folder. */
  compassRegistry?: CompassRegistry;
  voiceService?: VoiceService;
  usageStatsService: UsageStatsService;
  markUserTypedDuringTurn?: () => void;
  postSettingsFileAvailability?: (ctx: HandlerContext) => void;
  /** Posts account state to every panel, on a daemon's core to each device's views read as that device's client (`ChatPanelProvider.broadcastAccountState`). */
  broadcastAccountState: (what: string, row: string, read: () => Promise<ExtensionToWebviewMessage | undefined>) => Promise<void>;
  postClaudeAuthState?: (host: PanelHost) => void;
  postProviderSignInState?: (host: PanelHost) => void;
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
  /** A panel's `restoreRetry` was set or cleared. */
  restoreRetryChanged: (panelId: string) => void;
  webviewPrompts: WebviewPrompts;
  /** `PanelManager.withViewGate`: runs a replay to one view of the panel `host` serves, queued behind its joins, while the panel's posts wait. */
  withViewGate: (host: PanelHost, joining: string | undefined, run: (gate: ViewJoinGate) => Promise<void>) => Promise<void>;
  /** The panels' worktree work (slice 12a), read when a handler runs. */
  worktrees: () => PanelWorktrees;
}
