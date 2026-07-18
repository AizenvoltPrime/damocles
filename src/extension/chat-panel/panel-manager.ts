import * as vscode from "vscode";
import { PermissionHandler } from "../permission-handler";
import { IdeContextManager } from "./ide-context-manager";
import { log } from "../logger";
import type { ChatSession } from "../chat-session";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../shared/types/messages";
import type { ForkContext, ForkSpawnArgs, StoredSession } from "../../shared/types/session";
import type { HostInstance, WebviewHost } from "./types";
import { createPanelHost } from "./types";

export interface PanelManagerConfig {
  extensionUri: vscode.Uri;
  createSessionForPanel: (
    host: WebviewHost,
    permissionHandler: PermissionHandler,
    panelId: string,
    forkContext?: ForkContext,
  ) => Promise<ChatSession>;
  handleWebviewMessage: (message: WebviewToExtensionMessage, panelId: string) => Promise<void>;
  sendCurrentSettings: (host: WebviewHost, permissionHandler: PermissionHandler) => Promise<void>;
  getStoredSessions: () => Promise<{ sessions: StoredSession[]; hasMore: boolean; nextOffset: number }>;
  invalidateSessionsCache: () => void;
  initPanelModel: (panelId: string) => void;
  cleanupPanelModel: (panelId: string) => void;
  cleanupPanelThinking: (panelId: string) => void;
  sendThinkingForPanel: (host: WebviewHost, panelId: string) => void;
  getInitialMessages: () => ExtensionToWebviewMessage[];
  inheritSettingsFromPanel: (sourcePanelId: string, newPanelId: string) => void;
  /** Full-session replay (pi fork resumes a pre-truncated branched session — US-013c). */
  loadHistory: (sessionId: string, host: WebviewHost) => Promise<void>;
}

export class PanelManager {
  private panels: Map<string, HostInstance> = new Map();
  private hostCounter = 0;
  private lastActivePanelId: string | null = null;
  private readonly allClosedListeners: Set<() => void> = new Set();
  private readonly extensionUri: vscode.Uri;
  private readonly createSessionForPanel: PanelManagerConfig["createSessionForPanel"];
  private readonly handleWebviewMessage: PanelManagerConfig["handleWebviewMessage"];
  private readonly sendCurrentSettings: PanelManagerConfig["sendCurrentSettings"];
  private readonly getStoredSessions: PanelManagerConfig["getStoredSessions"];
  private readonly initPanelModel: PanelManagerConfig["initPanelModel"];
  private readonly cleanupPanelModel: PanelManagerConfig["cleanupPanelModel"];
  private readonly cleanupPanelThinking: PanelManagerConfig["cleanupPanelThinking"];
  private readonly sendThinkingForPanel: PanelManagerConfig["sendThinkingForPanel"];
  private readonly getInitialMessages: PanelManagerConfig["getInitialMessages"];
  private readonly inheritSettingsFromPanel: PanelManagerConfig["inheritSettingsFromPanel"];
  private readonly loadHistory: PanelManagerConfig["loadHistory"];

  constructor(config: PanelManagerConfig) {
    this.extensionUri = config.extensionUri;
    this.createSessionForPanel = config.createSessionForPanel;
    this.handleWebviewMessage = config.handleWebviewMessage;
    this.sendCurrentSettings = config.sendCurrentSettings;
    this.getStoredSessions = config.getStoredSessions;
    this.initPanelModel = config.initPanelModel;
    this.cleanupPanelModel = config.cleanupPanelModel;
    this.cleanupPanelThinking = config.cleanupPanelThinking;
    this.sendThinkingForPanel = config.sendThinkingForPanel;
    this.getInitialMessages = config.getInitialMessages;
    this.inheritSettingsFromPanel = config.inheritSettingsFromPanel;
    this.loadHistory = config.loadHistory;
  }

  getPanels(): Map<string, HostInstance> {
    return this.panels;
  }

  onAllPanelsClosed(callback: () => void): vscode.Disposable {
    this.allClosedListeners.add(callback);
    return { dispose: (): void => { this.allClosedListeners.delete(callback); } };
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

  async showForked(args: ForkSpawnArgs): Promise<HostInstance | null> {
    const forkContext: ForkContext = {
      sourceSdkSessionId: args.sourceSdkSessionId,
      forkAtUuid: args.forkAtUuid,
      consumed: false,
      ...(args.piBranchedSessionId ? { piBranchedSessionId: args.piBranchedSessionId } : {}),
    };

    const sourceInstance = this.panels.get(args.sourcePanelId);
    const targetColumn = sourceInstance?.host.viewColumn ?? vscode.ViewColumn.Active;

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

    const newPanelId = await this.initializeHost(host, {
      forkContext,
      sourcePanelId: args.sourcePanelId,
    });

    // Detached on purpose: the source rewind awaits showForked, so it must not block on the new panel's
    // webview mounting (replayForkedHistory awaits that internally).
    void this.replayForkedHistory(host, newPanelId, args);

    return this.panels.get(newPanelId) ?? null;
  }

  /**
   * Replay a forked panel's branched transcript (and prefill) once its webview has mounted — gated on
   * `webviewReady` so the extension-initiated push isn't dropped before the webview's listener exists.
   * The gate settles on dispose, so a panel closed before mount just makes this bail.
   */
  private async replayForkedHistory(host: WebviewHost, panelId: string, args: ForkSpawnArgs): Promise<void> {
    await this.panels.get(panelId)?.webviewReady;
    if (!this.panels.has(panelId)) return; // closed before it mounted

    try {
      // A first-message fork has no branched session (fresh panel + prefill only).
      if (args.piBranchedSessionId) await this.loadHistory(args.piBranchedSessionId, host);
    } catch (err) {
      log("[PanelManager.replayForkedHistory] history replay failed: %O", err);
      this.postMessage(host, {
        type: "rewindError",
        message: `Failed to replay forked history: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (args.promptContent && args.promptContent.length > 0) {
      this.postMessage(host, { type: "prefillInput", text: args.promptContent });
    }
  }

  async restorePanel(panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.html = this.getHtmlContent(panel.webview);
    const host = createPanelHost(panel);
    try {
      await this.initializeHost(host);
    } catch (err) {
      log(`[PanelManager] Failed to restore panel: ${err}`);
      panel.webview.html = this.getErrorHtml(panel.webview);
    }
  }

  async initializeHost(
    host: WebviewHost,
    options?: { forkContext?: ForkContext; sourcePanelId?: string },
  ): Promise<string> {
    const panelId = `host-${++this.hostCounter}`;
    const disposables: vscode.Disposable[] = [];

    const pendingMessages: WebviewToExtensionMessage[] = [];
    let ready = false;

    // Resolves when the webview posts its first `ready` message (mounted + listener live). VS Code drops
    // extension→webview posts sent before that, so only extension-INITIATED pushes (the fork replay) await
    // this gate; every other push is already triggered BY the webview's own `ready`.
    let signalWebviewReady!: () => void;
    const webviewReady = new Promise<void>((resolve) => { signalWebviewReady = resolve; });
    // Settle via the disposables list so BOTH teardown paths (onDidDispose and dispose()) release a
    // detached replay still awaiting a webview that never mounted.
    disposables.push({ dispose: () => signalWebviewReady() });

    disposables.push(
      host.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
        if (message.type === "ready") signalWebviewReady();
        if (ready) {
          this.handleWebviewMessage(message, panelId);
        } else {
          pendingMessages.push(message);
        }
      }),
    );

    const permissionHandler = new PermissionHandler(this.extensionUri);
    permissionHandler.setPostMessage((msg) => this.postMessage(host, msg));

    if (options?.sourcePanelId) {
      const source = this.panels.get(options.sourcePanelId);
      if (source) {
        permissionHandler.setPermissionMode(source.permissionHandler.getPermissionMode());
        permissionHandler.setDangerouslySkipPermissions(source.permissionHandler.getDangerouslySkipPermissions());
      }
    }

    const ideContextManager = new IdeContextManager("vscode-webview", (context) => {
      this.postMessage(host, { type: "ideContextUpdate", context });
    });

    this.initPanelModel(panelId);

    if (options?.sourcePanelId) {
      this.inheritSettingsFromPanel(options.sourcePanelId, panelId);
    }

    for (const msg of this.getInitialMessages()) {
      this.postMessage(host, msg);
    }

    const session = await this.createSessionForPanel(host, permissionHandler, panelId, options?.forkContext);

    permissionHandler.setOnPlanModeActivated(async () => {
      await session.setPermissionMode("plan");
      await this.sendCurrentSettings(host, permissionHandler);
    });

    this.panels.set(panelId, {
      host,
      session,
      permissionHandler,
      ideContextManager,
      disposables,
      webviewReady,
      ...(options?.forkContext ? { forkContext: options.forkContext } : {}),
    });

    if (host.active) {
      this.lastActivePanelId = panelId;
    }

    disposables.push(
      host.onDidChangeActive(() => {
        if (host.active) {
          this.lastActivePanelId = panelId;
        }
      }),
    );

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
        if (
          e.affectsConfiguration("damocles.thinkingDisabled") ||
          e.affectsConfiguration("damocles.effortByModel") ||
          e.affectsConfiguration("damocles.maxThinkingTokens")
        ) {
          this.sendThinkingForPanel(host, panelId);
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
          this.cleanupPanelModel(panelId);
          this.cleanupPanelThinking(panelId);
          this.panels.delete(panelId);
          if (this.lastActivePanelId === panelId) {
            this.lastActivePanelId = this.findFallbackActivePanelId();
          }
          if (this.panels.size === 0) {
            for (const cb of this.allClosedListeners) {
              try {
                cb();
              } catch (err) {
                log("[PanelManager] allClosed listener error:", err);
              }
            }
          }
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

  postToActivePanel(message: ExtensionToWebviewMessage): boolean {
    if (this.lastActivePanelId) {
      const instance = this.panels.get(this.lastActivePanelId);
      if (instance) {
        this.postMessage(instance.host, message);
        return true;
      }
    }
    if (this.panels.size === 1) {
      const first = this.panels.values().next();
      if (!first.done) {
        this.postMessage(first.value.host, message);
        return true;
      }
    }
    for (const [, instance] of this.panels) {
      if (instance.host.visible) {
        this.postMessage(instance.host, message);
        return true;
      }
    }
    return false;
  }

  private findFallbackActivePanelId(): string | null {
    for (const [id, instance] of this.panels) {
      if (instance.host.active) return id;
    }
    for (const [id, instance] of this.panels) {
      if (instance.host.visible) return id;
    }
    return null;
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

    // CSP: `script-src` stays nonce-locked (no inline/remote script — no RCE). `img-src ... https:` is
    // a deliberate widening so WebFetch can render inline images from extracted web pages. The tradeoff
    // is that any rendered markdown can load remote https images (a tracking/IP-leak vector); this is the
    // standard posture for chat webviews that render web content, and the web tools are opt-in.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data: https:;">
  <link href="${styleUri}" rel="stylesheet">
  <title>Damocles</title>
</head>
<body>
  <div id="app" data-logo-uri="${logoUri}"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private getErrorHtml(webview: vscode.Webview): string {
    const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "resources", "icon.png"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${webview.cspSource};">
  <title>Damocles</title>
  <style>
    body { display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
    .error-container { text-align: center; max-width: 360px; }
    img { width: 48px; height: 48px; opacity: 0.5; margin-bottom: 16px; }
    h2 { font-size: 14px; font-weight: 600; margin: 0 0 8px; }
    p { font-size: 12px; opacity: 0.7; margin: 0; }
  </style>
</head>
<body>
  <div class="error-container">
    <img src="${logoUri}" alt="">
    <h2>Session failed to restore</h2>
    <p>Close this tab and open a new Damocles panel.</p>
  </div>
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
    for (const [panelId, instance] of this.panels) {
      void instance.session.dispose();
      void instance.permissionHandler.dispose();
      instance.ideContextManager.dispose();
      instance.disposables.forEach((d) => d.dispose());
      this.cleanupPanelModel(panelId);
      this.cleanupPanelThinking(panelId);
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
