import * as vscode from "vscode";
import { PermissionHandler } from "../permission-handler";
import { IdeContextManager } from "./ide-context-manager";
import type { ClaudeSession } from "../claude-session";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../shared/types/messages";
import type { StoredSession } from "../../shared/types/session";
import type { HostInstance, WebviewHost } from "./types";
import { createPanelHost } from "./types";

export interface PanelManagerConfig {
  extensionUri: vscode.Uri;
  createSessionForPanel: (host: WebviewHost, permissionHandler: PermissionHandler, panelId: string) => Promise<ClaudeSession>;
  handleWebviewMessage: (message: WebviewToExtensionMessage, panelId: string) => Promise<void>;
  sendCurrentSettings: (host: WebviewHost, permissionHandler: PermissionHandler) => Promise<void>;
  getStoredSessions: () => Promise<{ sessions: StoredSession[]; hasMore: boolean; nextOffset: number }>;
  invalidateSessionsCache: () => void;
  initPanelProfile: (panelId: string) => void;
  cleanupPanelProfile: (panelId: string) => void;
}

export class PanelManager {
  private panels: Map<string, HostInstance> = new Map();
  private hostCounter = 0;
  private readonly extensionUri: vscode.Uri;
  private readonly createSessionForPanel: PanelManagerConfig["createSessionForPanel"];
  private readonly handleWebviewMessage: PanelManagerConfig["handleWebviewMessage"];
  private readonly sendCurrentSettings: PanelManagerConfig["sendCurrentSettings"];
  private readonly getStoredSessions: PanelManagerConfig["getStoredSessions"];
  private readonly initPanelProfile: PanelManagerConfig["initPanelProfile"];
  private readonly cleanupPanelProfile: PanelManagerConfig["cleanupPanelProfile"];

  constructor(config: PanelManagerConfig) {
    this.extensionUri = config.extensionUri;
    this.createSessionForPanel = config.createSessionForPanel;
    this.handleWebviewMessage = config.handleWebviewMessage;
    this.sendCurrentSettings = config.sendCurrentSettings;
    this.getStoredSessions = config.getStoredSessions;
    this.initPanelProfile = config.initPanelProfile;
    this.cleanupPanelProfile = config.cleanupPanelProfile;
  }

  getPanels(): Map<string, HostInstance> {
    return this.panels;
  }

  async show(): Promise<void> {
    let targetColumn: vscode.ViewColumn;
    let lockEditorGroup = false;

    const existingColumn = this.findExistingPanelColumn();
    if (existingColumn) {
      targetColumn = existingColumn;
    } else {
      targetColumn = this.findUnusedColumn();
      lockEditorGroup = true;
    }

    const panel = vscode.window.createWebviewPanel(
      "damocles.chat",
      "Damocles",
      { viewColumn: targetColumn, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: this.getLocalResourceRoots(),
      },
    );

    const host = createPanelHost(panel);
    panel.webview.html = this.getHtmlContent(panel.webview);
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "resources", "icon.png");

    if (lockEditorGroup) {
      await vscode.commands.executeCommand("workbench.action.lockEditorGroup");
    }

    await this.initializeHost(host);
  }

  async restorePanel(panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.html = this.getHtmlContent(panel.webview);
    const host = createPanelHost(panel);
    await this.initializeHost(host);
  }

  async initializeHost(host: WebviewHost): Promise<string> {
    const panelId = `host-${++this.hostCounter}`;
    const disposables: vscode.Disposable[] = [];

    const pendingMessages: WebviewToExtensionMessage[] = [];
    let ready = false;

    disposables.push(
      host.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
        if (ready) {
          this.handleWebviewMessage(message, panelId);
        } else {
          pendingMessages.push(message);
        }
      }),
    );

    const permissionHandler = new PermissionHandler(this.extensionUri);
    permissionHandler.setPostMessage((msg) => this.postMessage(host, msg));

    const ideContextManager = new IdeContextManager("vscode-webview", (context) => {
      this.postMessage(host, { type: "ideContextUpdate", context });
    });

    this.initPanelProfile(panelId);

    const session = await this.createSessionForPanel(host, permissionHandler, panelId);

    permissionHandler.setOnPlanModeActivated(async () => {
      await session.setPermissionMode("plan");
      await this.sendCurrentSettings(host, permissionHandler);
    });

    this.panels.set(panelId, { host, session, permissionHandler, ideContextManager, disposables });

    ready = true;
    for (const msg of pendingMessages) {
      this.handleWebviewMessage(msg, panelId);
    }

    disposables.push(
      host.onDidChangeVisibility(() => {
        if (host.visible) {
          this.postMessage(host, { type: "panelFocused" });
          this.getStoredSessions()
            .then(({ sessions, hasMore, nextOffset }) => {
              this.postMessage(host, {
                type: "storedSessions",
                sessions,
                hasMore,
                nextOffset,
                isFirstPage: true,
              });
            })
            .catch(() => {});
        }
      }),
    );

    disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("damocles")) {
          void this.sendCurrentSettings(host, permissionHandler);
        }
      }),
    );

    disposables.push(
      host.onDidDispose(() => {
        const instance = this.panels.get(panelId);
        if (instance) {
          void instance.session.dispose();
          void instance.permissionHandler.dispose();
          instance.ideContextManager.dispose();
          instance.disposables.forEach((d) => d.dispose());
          this.cleanupPanelProfile(panelId);
          this.panels.delete(panelId);
        }
      }),
    );

    return panelId;
  }

  postMessage(host: WebviewHost, message: ExtensionToWebviewMessage): void {
    try {
      host.webview.postMessage(message);
    } catch {
      // Host was disposed - will be cleaned up by onDidDispose handler
    }
  }

  broadcast(message: ExtensionToWebviewMessage): void {
    for (const [, instance] of this.panels) {
      this.postMessage(instance.host, message);
    }
  }

  getLocalResourceRoots(): vscode.Uri[] {
    return [
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview"),
      vscode.Uri.joinPath(this.extensionUri, "resources"),
    ];
  }

  getHtmlContent(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "assets", "index.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "assets", "index.css"));
    const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "resources", "icon.png"));

    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
  <link href="${styleUri}" rel="stylesheet">
  <title>Damocles</title>
</head>
<body>
  <div id="app" data-logo-uri="${logoUri}"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }

  newSession(): void {
    for (const [, instance] of this.panels) {
      instance.session.reset();
      this.postMessage(instance.host, { type: "processing", isProcessing: false });
      this.postMessage(instance.host, { type: "sessionCleared" });
    }
  }

  cancelSession(): void {
    for (const [, instance] of this.panels) {
      instance.session.cancel();
    }
  }

  dispose(): void {
    for (const [, instance] of this.panels) {
      void instance.session.dispose();
      void instance.permissionHandler.dispose();
      instance.ideContextManager.dispose();
      instance.disposables.forEach((d) => d.dispose());
      instance.host.close();
    }
    this.panels.clear();
  }

  private findExistingPanelColumn(): vscode.ViewColumn | undefined {
    for (const group of vscode.window.tabGroups.all) {
      if (group.tabs.length === 0) continue;
      const allClaudePanels = group.tabs.every((tab) => {
        if (tab.input instanceof vscode.TabInputWebview) {
          return tab.input.viewType.includes("damocles.chat");
        }
        return false;
      });
      if (allClaudePanels && group.viewColumn) {
        return group.viewColumn;
      }
    }
    return undefined;
  }

  private findUnusedColumn(): vscode.ViewColumn {
    const usedColumns = new Set<vscode.ViewColumn>();
    vscode.window.tabGroups.all.forEach((group) => {
      if (group.viewColumn !== undefined) {
        usedColumns.add(group.viewColumn);
      }
    });

    for (let col = vscode.ViewColumn.One; col <= vscode.ViewColumn.Nine; col++) {
      if (!usedColumns.has(col)) {
        return col;
      }
    }
    return vscode.ViewColumn.Beside;
  }

  private getNonce(): string {
    let text = "";
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
