import * as vscode from "vscode";
import type { StorageManager } from "../storage-manager";
import type { HistoryManager } from "../history-manager";
import type { SettingsManager } from "../settings-manager";
import type { WorkspaceManager } from "../workspace-manager";
import type { MemoryService } from "../../memory";
import type { BrowserService } from "../../browser";
import type { CompassService } from "../../compass";
import type { VoiceService } from "../../voice/service";
import type { WebviewToExtensionMessage, ExtensionToWebviewMessage } from "../../../shared/types/messages";
import type { HostInstance, WebviewHost } from "../types";
import type { HandlerContext, HandlerRegistry } from "./types";
import { createHandlerRegistry } from "./handler-registry";
import { MEMORY_MESSAGE_TYPES, MEMORY_MESSAGE_SOURCES } from "./handlers/memory-handlers";
import { log } from "../../logger";

const LANGUAGE_PREFERENCE_KEY = "userLanguagePreference";

export interface MessageRouterConfig {
  workspacePath: string;
  postMessage: (host: WebviewHost, message: ExtensionToWebviewMessage) => void;
  getPanels: () => Map<string, HostInstance>;
  storageManager: StorageManager;
  historyManager: HistoryManager;
  settingsManager: SettingsManager;
  workspaceManager: WorkspaceManager;
  context: vscode.ExtensionContext;
  memoryService: MemoryService;
  browserService?: BrowserService;
  compassService?: CompassService;
  voiceService?: VoiceService;
}

export class MessageRouter {
  private readonly handlers: HandlerRegistry;
  private readonly getPanels: MessageRouterConfig["getPanels"];
  private readonly postMessage: MessageRouterConfig["postMessage"];

  constructor(config: MessageRouterConfig) {
    this.getPanels = config.getPanels;
    this.postMessage = config.postMessage;

    this.handlers = createHandlerRegistry({
      workspacePath: config.workspacePath,
      postMessage: config.postMessage,
      getPanels: config.getPanels,
      storageManager: config.storageManager,
      historyManager: config.historyManager,
      settingsManager: config.settingsManager,
      workspaceManager: config.workspaceManager,
      context: config.context,
      getLanguagePreference: () => this.getLanguagePreference(config.context),
      setLanguagePreference: (locale: string) => this.setLanguagePreference(config.context, locale),
      memoryService: config.memoryService,
      ...(config.browserService ? { browserService: config.browserService } : {}),
      ...(config.compassService ? { compassService: config.compassService } : {}),
      ...(config.voiceService ? { voiceService: config.voiceService } : {}),
    });
  }

  private getLanguagePreference(context: vscode.ExtensionContext): string {
    return context.globalState.get<string>(LANGUAGE_PREFERENCE_KEY) ?? vscode.env.language;
  }

  private async setLanguagePreference(context: vscode.ExtensionContext, locale: string): Promise<void> {
    await context.globalState.update(LANGUAGE_PREFERENCE_KEY, locale);
  }

  async handleWebviewMessage(message: WebviewToExtensionMessage, panelId: string): Promise<void> {
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
          this.postMessage(instance.host, { type: "memoryError", message: failure, ...(source ? { source } : {}) });
        } else {
          this.postMessage(instance.host, { type: "error", message: failure });
        }
      }
    } else {
      log("[MessageRouter] Unhandled message type:", message.type);
    }
  }
}
