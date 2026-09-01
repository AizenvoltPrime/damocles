import * as vscode from "vscode";
import * as path from "path";
import { PanelManager } from "./panel-manager";
import { StorageManager } from "./storage-manager";
import { HistoryManager } from "./history-manager";
import { SettingsManager } from "./settings-manager";
import { WorkspaceManager } from "./workspace-manager";
import { SessionManager } from "./session-manager";
import { MessageRouter } from "./message-router/index";
import { MemoryService } from "../memory";
import { BrowserService } from "../browser";
import { CompassService } from "../compass";
import { VoiceService } from "../voice/service";
import { OPENAI_PREFER_API_KEY_STATE } from "../pi-session/openai-auth";
import type { WebviewHost } from "./types";
import type { ChatSession } from "../chat-session";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import { log } from "../logger";

export class ChatPanelProvider {
  private readonly panelManager: PanelManager;
  private readonly storageManager: StorageManager;
  private readonly historyManager: HistoryManager;
  private readonly settingsManager: SettingsManager;
  private readonly workspaceManager: WorkspaceManager;
  private readonly sessionManager: SessionManager;
  private readonly messageRouter: MessageRouter;
  private readonly memoryService: MemoryService;
  private readonly browserService: BrowserService;
  private readonly compassService: CompassService | null;
  private readonly voiceService: VoiceService;
  private readonly workspacePath: string;

  private readonly extensionUri: vscode.Uri;
  private readonly context: vscode.ExtensionContext;

  constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
    this.extensionUri = extensionUri;
    this.context = context;
    const homeDir = process.env["HOME"] || process.env["USERPROFILE"] || "";
    const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    // Session storage and history key on this path, so with no folder open they need the home dir.
    // Asset discovery must not follow them there: with no folder open there is no project scope, so
    // it takes `projectPath` and scans the user dirs alone.
    this.workspacePath = projectPath || homeDir;

    const postMessage = (host: WebviewHost, message: unknown) => {
      this.panelManager.postMessage(host, message as Parameters<typeof this.panelManager.postMessage>[1]);
    };

    this.settingsManager = new SettingsManager({
      postMessage,
      secrets: context.secrets,
      workspaceState: context.workspaceState,
    });

    this.storageManager = new StorageManager({
      workspacePath: this.workspacePath,
      postMessage,
      getPanels: () => this.panelManager.getPanels(),
    });

    this.historyManager = new HistoryManager({
      workspacePath: this.workspacePath,
      postMessage,
    });

    this.workspaceManager = new WorkspaceManager({
      workspacePath: this.workspacePath,
      projectPath,
      postMessage,
      broadcastToAllPanels: (message) => this.panelManager.broadcast(message),
    });

    this.memoryService = new MemoryService(extensionUri.fsPath);
    this.memoryService.setConsolidationBroadcast((msg) => this.panelManager.broadcast(msg));
    this.browserService = new BrowserService();
    this.voiceService = new VoiceService({ extensionRoot: extensionUri.fsPath });
    this.voiceService.registerWithExtension(context);
    const hasWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    if (hasWorkspaceFolder) {
      const damoclesDir = path.join(homeDir, '.damocles');
      this.compassService = new CompassService(this.workspacePath, damoclesDir, extensionUri.fsPath);
      this.compassService.onStatusChange((status) => {
        this.panelManager.broadcast({ type: 'compassStatusUpdate', status });
      });
      this.compassService.onProgress((event) => {
        this.panelManager.broadcast({
          type: 'compassBuildProgress',
          current: event.current,
          total: event.total,
          phase: event.phase,
          ...(event.label ? { label: event.label } : {}),
        });
      });
      this.compassService.registerViews(context);
    } else {
      this.compassService = null;
    }
    this.browserService.onElementPickedFromToolbar((element) => {
      const delivered = this.panelManager.postToActivePanel({ type: 'browserElementPicked', element });
      if (!delivered) {
        vscode.window.showWarningMessage("Damocles: No active chat panel — open a chat panel to receive picked elements.");
      }
    });

    this.sessionManager = new SessionManager({
      workspacePath: this.workspacePath,
      getEnabledMcpServers: () => this.settingsManager.getEnabledMcpServers(),
      getMcpConfigLoaded: () => this.settingsManager.getMcpConfigLoaded(),
      loadMcpConfig: () => this.settingsManager.loadMcpConfig(),
      getActiveModelForPanel: (panelId) => this.settingsManager.getActiveModelForPanel(panelId),
      getDefaultModel: () => this.settingsManager.getDefaultModel(),
      getPreferOpenAIApiKey: () => this.context.workspaceState.get<boolean>(OPENAI_PREFER_API_KEY_STATE, false),
      resolveThinkingForPanel: (panelId, model) => {
        const config = vscode.workspace.getConfiguration("damocles");
        return {
          thinkingDisabled: this.settingsManager.resolveThinkingDisabled(panelId, config),
          effort: this.settingsManager.resolveThinkingEffort(panelId, model, config),
          maxThinkingTokens: this.settingsManager.resolveMaxThinkingTokens(panelId, model, config),
        };
      },
      postMessage,
      setupSessionWatcher: () => this.storageManager.setupSessionWatcher(),
      addOrUpdateSession: (sessionId) => this.storageManager.addOrUpdateSession(sessionId),
      getMemoryService: () => this.memoryService,
      getRawBrowserService: () => this.browserService,
      getCompassService: () => this.compassService,
      onAssistantTextFinal: (text) => this.dispatchTtsForReply(text),
      secrets: this.context.secrets,
    });

    this.messageRouter = new MessageRouter({
      workspacePath: this.workspacePath,
      postMessage,
      getPanels: () => this.panelManager.getPanels(),
      storageManager: this.storageManager,
      historyManager: this.historyManager,
      settingsManager: this.settingsManager,
      workspaceManager: this.workspaceManager,
      context: this.context,
      memoryService: this.memoryService,
      browserService: this.browserService,
      ...(this.compassService ? { compassService: this.compassService } : {}),
      voiceService: this.voiceService,
    });

    this.panelManager = new PanelManager({
      extensionUri: this.extensionUri,
      createSessionForPanel: async (host, permissionHandler, panelId, forkContext) => {
        const onSpawnFork = (args: import("../../shared/types/session").ForkSpawnArgs) =>
          this.panelManager.showForked(args).then(() => undefined);
        const session = await this.sessionManager.createSessionForPanel(
          host,
          permissionHandler,
          panelId,
          onSpawnFork,
          forkContext,
        );
        // Live MCP status: push fresh runtime status to this panel whenever a server connects/disconnects,
        // so the panel reflects connecting → connected automatically (no manual refresh).
        session.setMcpStatusListener(() => {
          this.pushMcpStatus(session, host);
        });
        return session;
      },
      handleWebviewMessage: (message, panelId) =>
        this.messageRouter.handleWebviewMessage(message, panelId),
      sendCurrentSettings: (host, permissionHandler) =>
        this.settingsManager.sendCurrentSettings(host, permissionHandler),
      getStoredSessions: () => this.storageManager.getStoredSessions(),
      invalidateSessionsCache: () => this.storageManager.invalidateSessionsCache(),
      initPanelModel: (panelId) => this.settingsManager.initPanelModel(panelId),
      cleanupPanelModel: (panelId) => this.settingsManager.cleanupPanelModel(panelId),
      cleanupPanelThinking: (panelId) => this.settingsManager.cleanupPanelThinking(panelId),
      sendThinkingForPanel: (host, panelId) => this.settingsManager.sendThinkingForPanel(host, panelId),
      getInitialMessages: () => {
        const msgs: ExtensionToWebviewMessage[] = [];
        if (this.compassService?.isEnabled) {
          msgs.push({ type: 'compassStatusUpdate', status: this.compassService.getStatus() });
        }
        return msgs;
      },
      inheritSettingsFromPanel: (sourcePanelId, newPanelId) => {
        this.settingsManager.setActiveModelForPanel(newPanelId, this.settingsManager.getActiveModelForPanel(sourcePanelId));
        this.settingsManager.copyPanelThinkingStateTo(sourcePanelId, newPanelId);
      },
      loadHistory: (sessionId, host, session) =>
        this.historyManager.loadSessionHistory(sessionId, host, session),
    });

    void this.storageManager.setupSessionWatcher();

    if (this.compassService?.isEnabled) {
      this.compassService.ensureInitialized().catch(err => {
        log('[ChatPanelProvider] Compass init failed: %O', err);
      });
    }

    this.settingsManager.setOnMcpConfigChange(() => {
      this.panelManager.broadcast(this.settingsManager.buildMcpConfigUpdate());
      // Reconcile live MCP connections on a .mcp.json change — no session restart (US-014.9).
      const enabled = this.settingsManager.getEnabledMcpServers();
      for (const [, instance] of this.panelManager.getPanels()) {
        instance.session.setMcpServers(enabled);
        // The broadcast above describes config only, so every enabled server reads as `idle`. Without
        // this the panel would sit on that placeholder until some unrelated event pushed real status.
        this.pushMcpStatus(instance.session, instance.host);
      }
    });

    // Granting workspace trust unblocks workspace `.mcp.json` servers (M3). The re-read has to come
    // first: trust decides what `loadConfig` samples, not only what the trust gate withholds
    // afterwards. It picks the fold that ranks repo-authored sources, runs the gitignore check that
    // an untrusted workspace skips, and records which sources actually outrank `~/.damocles/mcp.json`.
    // None of those recover on their own, so the re-feed and the broadcast below both wait for it.
    // A watcher firing in the same window takes the later generation and this load then assigns
    // nothing, so the broadcast can carry the pre-grant snapshot until that load's own change
    // notification lands.
    this.context.subscriptions.push(
      vscode.workspace.onDidGrantWorkspaceTrust(async () => {
        await this.settingsManager.loadMcpConfig();
        this.panelManager.broadcast(this.settingsManager.buildMcpConfigUpdate());
        const enabled = this.settingsManager.getEnabledMcpServers();
        for (const [, instance] of this.panelManager.getPanels()) {
          instance.session.setMcpServers(enabled);
          this.pushMcpStatus(instance.session, instance.host);
        }
      }),
    );

    this.settingsManager.onDefaultModelChanged(() => {
      for (const [panelId, instance] of this.panelManager.getPanels()) {
        this.settingsManager.sendModelForPanel(instance.host, panelId);
        this.settingsManager.sendThinkingForPanel(instance.host, panelId);
      }
    });
    this.settingsManager.setupMcpWatcher(this.workspacePath);

    this.settingsManager.loadMcpConfig().catch((err) => {
      log("[ChatPanelProvider] Error pre-loading MCP config:", err);
    });
    this.settingsManager.loadBrowserState();
  }

  getPanelManager(): PanelManager {
    return this.panelManager;
  }

  getBrowserService(): BrowserService {
    return this.browserService;
  }

  getVoiceService(): VoiceService {
    return this.voiceService;
  }

  /**
   * Push runtime MCP status to one panel. `sendMcpStatus` awaits a live SDK round-trip, so it can
   * reject on a server that is mid-teardown; every caller here is a fire-and-forget listener, and an
   * unhandled rejection from one would be an unhandled promise rejection in the extension host.
   */
  private pushMcpStatus(session: ChatSession, host: WebviewHost): void {
    this.settingsManager.sendMcpStatus(session, host).catch(err => {
      log('[ChatPanelProvider] Failed to push MCP status: %s', err instanceof Error ? err.message : 'Unknown error');
    });
  }

  private dispatchTtsForReply(text: string): void {
    const cfg = vscode.workspace.getConfiguration("damocles");
    if (!cfg.get<boolean>("voice.tts.enabled", false)) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    void (async () => {
      try {
        if (!this.voiceService.isReady()) await this.voiceService.start();
        if (!this.voiceService.isReady()) {
          log("[ChatPanelProvider] tts dispatch: voice service did not become ready");
          return;
        }
        const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        log(`[ChatPanelProvider] tts dispatch reply: req=${reqId} chars=${trimmed.length}`);
        this.voiceService.ttsRequest(reqId, trimmed);
      } catch (err) {
        log("[ChatPanelProvider] tts dispatch failed:", err);
      }
    })();
  }

  async show(): Promise<void> {
    await this.panelManager.show();
  }

  async restorePanel(panel: vscode.WebviewPanel): Promise<void> {
    await this.panelManager.restorePanel(panel);
  }

  async restoreBrowserPanel(panel: vscode.WebviewPanel, url: string): Promise<void> {
    await this.browserService.restorePanel(panel, url);
  }

  newSession(): void {
    this.panelManager.newSession();
  }

  cancelSession(): void {
    this.panelManager.cancelSession();
  }

  async reloadActiveSession(): Promise<void> {
    for (const [, instance] of this.panelManager.getPanels()) {
      instance.session.reset();
      this.panelManager.postMessage(instance.host, { type: "processing", isProcessing: false });
      this.panelManager.postMessage(instance.host, { type: "authFailureCleared" });
    }
  }

  /**
   * Tear down every owned service.
   *
   * RETURNS A PROMISE BECAUSE ONE OBLIGATION IS GENUINELY ASYNC. `BrowserService.dispose()` waits for
   * Chrome to exit so it does not outlive the extension host, and that guarantee only holds if the
   * wait is actually awaited — dropping the promise here (and again in `deactivate`) made the comment
   * asserting it false, leaving a headful Chromium running against the logged-in profile after the
   * host went away. The synchronous disposals still run first and unconditionally.
   */
  async dispose(): Promise<void> {
    this.compassService?.dispose()?.catch?.((err: unknown) => log('[ChatPanelProvider] compass dispose error: %O', err));
    this.memoryService.dispose();
    const browserClosed = this.browserService.dispose().catch((err: unknown) => log('[ChatPanelProvider] browser dispose error: %O', err));
    this.storageManager.dispose();
    this.workspaceManager.dispose();
    this.settingsManager.dispose();
    this.voiceService.dispose();
    this.panelManager.dispose();
    await browserClosed;
  }
}
