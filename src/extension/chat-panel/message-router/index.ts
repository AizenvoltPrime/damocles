import * as vscode from "vscode";
import type { StorageManager } from "../storage-manager";
import type { HistoryManager } from "../history-manager";
import type { SettingsManager } from "../settings-manager";
import type { WorkspaceManager } from "../workspace-manager";
import type { MemoryService } from "../../memory";
import type { WebviewToExtensionMessage, ExtensionToWebviewMessage } from "../../../shared/types/messages";
import type { HostInstance, WebviewHost } from "../types";
import type { HandlerContext, HandlerRegistry } from "./types";
import { createHandlerRegistry } from "./handler-registry";
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
}

export class MessageRouter {
  private readonly handlers: HandlerRegistry;
  private readonly getPanels: MessageRouterConfig["getPanels"];

  constructor(config: MessageRouterConfig) {
    this.getPanels = config.getPanels;

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
      await handler(message, ctx);
    } else {
      log("[MessageRouter] Unhandled message type:", message.type);
    }
  }
}
