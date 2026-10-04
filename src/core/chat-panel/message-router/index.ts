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
import type { AttachedView, HostInstance } from "../types";
import type { PanelHost } from "../../../platform/window-service";
import type { HandlerContext, HandlerDependencies, HandlerRegistry } from "./types";
import { createHandlerRegistry } from "./handler-registry";
import { MEMORY_MESSAGE_TYPES, MEMORY_MESSAGE_SOURCES } from "./handlers/memory-handlers";
import { log } from "../../logger";

export const LANGUAGE_PREFERENCE_KEY = "userLanguagePreference";

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
  webviewPrompts: HandlerDependencies["webviewPrompts"];
}

export class MessageRouter {
  private readonly handlers: HandlerRegistry;
  private readonly getPanels: MessageRouterConfig["getPanels"];
  private readonly postMessage: MessageRouterConfig["postMessage"];

  constructor(config: MessageRouterConfig) {
    this.getPanels = config.getPanels;
    this.postMessage = config.postMessage;

    this.handlers = createHandlerRegistry({
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
      webviewPrompts: config.webviewPrompts,
    });
  }

  private getLanguagePreference(platform: Platform): string {
    return platform.state.global.get<string>(LANGUAGE_PREFERENCE_KEY) ?? platform.localization.language;
  }

  private async setLanguagePreference(platform: Platform, locale: string): Promise<void> {
    await platform.state.global.update(LANGUAGE_PREFERENCE_KEY, locale);
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
      panelId,
      folder: instance.folder,
      ...(view ? { view } : {}),
    };

    const handler = this.handlers[message.type];
    if (handler) {
      try {
        await handler(message, ctx);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log("[MessageRouter] Handler for", message.type, "threw:", detail);
        const failure = `Failed to handle ${message.type}: ${detail}`;
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
