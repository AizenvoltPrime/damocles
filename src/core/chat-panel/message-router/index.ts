import type { Disposable } from "../../../platform/disposable";
import type { Platform } from "../../../platform/platform";
import type { StorageManager } from "../storage-manager";
import type { HistoryManager } from "../history-manager";
import type { SettingsManager } from "../settings-manager";
import type { WorkspaceManager } from "../workspace-manager";
import type { MemoryService } from "../../memory";
import type { BrowserService } from "../../browser";
import type { CompassRegistry } from "../../compass/compass-registry";
import type { VoiceService } from "../../voice/service";
import type { WebviewToExtensionMessage, ExtensionToWebviewMessage } from "../../../shared/types/messages";
import type { AttachedView, HostInstance, ViewJoinGate } from "../types";
import type { PanelHost } from "../../../platform/window-service";
import type { HandlerContext, HandlerDependencies, HandlerRegistry, ViewHandlerRegistry } from "./types";
import { createHandlerRegistry } from "./handler-registry";
import { createViewJoin } from "./handlers/session-handlers";
import { withSettingsViewScope } from "../settings-view-scope";
import { MEMORY_MESSAGE_TYPES, MEMORY_MESSAGE_SOURCES } from "./handlers/memory-handlers";
import { log } from "../../logger";
import { visibleLines } from "../../../shared/visible-text";
import { LANGUAGE_PREFERENCE_KEY } from "../../../shared/language-preference";
import { VOICE_VIEW_MESSAGES } from "../../../shared/remote-user";

export interface MessageRouterConfig {
  postMessage: (host: PanelHost, message: ExtensionToWebviewMessage) => void;
  getPanels: () => Map<string, HostInstance>;
  storageManager: StorageManager;
  sessionCatalog: HandlerDependencies["sessionCatalog"];
  historyManager: HistoryManager;
  settingsManager: SettingsManager;
  workspaceManager: WorkspaceManager;
  platform: Platform;
  // Disposed when the extension deactivates.
  subscriptions: Disposable[];
  memoryService: MemoryService;
  browserService?: BrowserService;
  compassRegistry?: CompassRegistry;
  voiceService?: VoiceService;
  usageStatsService: HandlerDependencies["usageStatsService"];
  folderRegistry: HandlerDependencies["folderRegistry"];
  switchPanelFolder: HandlerDependencies["switchPanelFolder"];
  postWorkspaceFolderState: HandlerDependencies["postWorkspaceFolderState"];
  restoreRetryChanged: HandlerDependencies["restoreRetryChanged"];
  webviewPrompts: HandlerDependencies["webviewPrompts"];
  worktrees: HandlerDependencies["worktrees"];
}

export class MessageRouter {
  private readonly handlers: HandlerRegistry;
  private readonly viewHandlers: ViewHandlerRegistry;
  private readonly viewJoin: ReturnType<typeof createViewJoin>;
  private readonly getPanels: MessageRouterConfig["getPanels"];
  private readonly postMessage: MessageRouterConfig["postMessage"];

  constructor(config: MessageRouterConfig) {
    this.getPanels = config.getPanels;
    this.postMessage = config.postMessage;

    const deps: HandlerDependencies = {
      postMessage: config.postMessage,
      getPanels: config.getPanels,
      storageManager: config.storageManager,
      sessionCatalog: config.sessionCatalog,
      historyManager: config.historyManager,
      settingsManager: config.settingsManager,
      workspaceManager: config.workspaceManager,
      platform: config.platform,
      subscriptions: config.subscriptions,
      getLanguagePreference: () => this.getLanguagePreference(config.platform),
      setLanguagePreference: (locale: string) => this.setLanguagePreference(config.platform, locale),
      memoryService: config.memoryService,
      ...(config.browserService ? { browserService: config.browserService } : {}),
      ...(config.compassRegistry ? { compassRegistry: config.compassRegistry } : {}),
      ...(config.voiceService ? { voiceService: config.voiceService } : {}),
      usageStatsService: config.usageStatsService,
      folderRegistry: config.folderRegistry,
      switchPanelFolder: config.switchPanelFolder,
      postWorkspaceFolderState: config.postWorkspaceFolderState,
      restoreRetryChanged: config.restoreRetryChanged,
      webviewPrompts: config.webviewPrompts,
      worktrees: config.worktrees,
    };
    ({ handlers: this.handlers, viewHandlers: this.viewHandlers } = createHandlerRegistry(deps));
    this.viewJoin = createViewJoin(deps);
  }

  /** A view joins the panel's chat (views.join); the panel's own posts wait behind `gate` while the join replays it. */
  async joinView(panelId: string, gate: ViewJoinGate): Promise<void> {
    const instance = this.getPanels().get(panelId);
    if (!instance) throw new Error(`No open chat panel ${panelId}`);
    await this.viewJoin({
      host: instance.host,
      session: instance.session,
      permissionHandler: instance.permissionHandler,
      ideContextManager: instance.ideContextManager,
      terminalAttachments: instance.terminalAttachments,
      panelId,
      folder: instance.folder,
    }, gate);
  }

  private getLanguagePreference(platform: Platform): string {
    return platform.state.global.get<string>(LANGUAGE_PREFERENCE_KEY) ?? platform.localization.language;
  }

  private async setLanguagePreference(platform: Platform, locale: string): Promise<void> {
    await platform.state.global.update(LANGUAGE_PREFERENCE_KEY, locale);
  }

  /** A remote chat view's voice message on this computer's core: only VOICE_VIEW_MESSAGES, whose handlers read only the host they reply to. */
  async dispatchForeign(host: PanelHost, message: WebviewToExtensionMessage): Promise<void> {
    const handler = this.viewHandlers[message.type];
    if (!VOICE_VIEW_MESSAGES.has(message.type) || !handler) throw new Error(`${message.type} does not reach this computer from a remote chat`);
    await handler(message, { host });
  }

  /** `view` is the attached settings view the message came from; the handler then runs with the chat's own context. */
  async handleWebviewMessage(message: WebviewToExtensionMessage, panelId: string, view?: AttachedView): Promise<void> {
    const instance = this.getPanels().get(panelId);
    if (!instance) {
      log("[MessageRouter] No panel instance found for", panelId);
      return;
    }

    const ctx: HandlerContext = {
      host: instance.host,
      session: instance.session,
      permissionHandler: instance.permissionHandler,
      ideContextManager: instance.ideContextManager,
      terminalAttachments: instance.terminalAttachments,
      panelId,
      folder: instance.folder,
      ...(view ? { view } : {}),
    };

    const handler = this.handlers[message.type];
    if (handler) {
      try {
        await withSettingsViewScope(view?.scope, () => handler(message, ctx));
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log("[MessageRouter] Handler for", message.type, "threw:", detail);
        // A failure can quote repository text (git's error, a path), so its hidden characters show as escapes.
        const failure = `Failed to handle ${message.type}: ${visibleLines(detail)}`;
        if (MEMORY_MESSAGE_TYPES.has(message.type)) {
          const source = MEMORY_MESSAGE_SOURCES.get(message.type);
          this.postMessage(instance.host, {
            type: "memoryError",
            message: failure,
            ...(source ? { source } : {}),
            ...(source === "audit" ? { code: "request-failed" as const } : {}),
          });
        } else {
          this.postMessage(instance.host, { type: "error", message: failure });
        }
      }
    } else {
      log("[MessageRouter] Unhandled message type:", message.type);
    }
  }
}
