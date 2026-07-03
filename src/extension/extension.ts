import * as vscode from "vscode";
import { ChatPanelProvider } from "./chat-panel";
import { SidebarViewProvider } from "./chat-panel/sidebar-view-provider";
import { initLogger, log, showLog } from "./logger";
import { createVoiceStatusBarItem } from "./voice/status-bar";
import { setupAutoDisable } from "./voice/auto-disable";
import { PiRuntime } from "./pi-session/pi-runtime";
import { setMcpSecretStorage } from "./pi-session/mcp/mcp-auth";
import { DEFAULT_FALLBACK_MODEL } from "../shared/types/constants";
import type { EffortLevel } from "../shared/types/settings";
import { EXPLORE_SECRET_KEYS } from "./pi-session/explore-providers";

let chatPanelProvider: ChatPanelProvider | undefined;

async function migrateLegacyEffortSetting(): Promise<void> {
  const config = vscode.workspace.getConfiguration("damocles");
  const inspect = config.inspect<EffortLevel | null>("effort");
  if (!inspect) return;
  const scopes = [
    { target: vscode.ConfigurationTarget.Global, value: inspect.globalValue },
    { target: vscode.ConfigurationTarget.Workspace, value: inspect.workspaceValue },
    { target: vscode.ConfigurationTarget.WorkspaceFolder, value: inspect.workspaceFolderValue },
  ];
  const activeModel = config.get<string>("model", "") || DEFAULT_FALLBACK_MODEL;
  for (const { target, value } of scopes) {
    if (value === undefined || value === null) continue;
    const mapInspect = config.inspect<Record<string, EffortLevel | null>>("effortByModel");
    const currentMap = (target === vscode.ConfigurationTarget.Global
      ? mapInspect?.globalValue
      : target === vscode.ConfigurationTarget.Workspace
        ? mapInspect?.workspaceValue
        : mapInspect?.workspaceFolderValue) ?? {};
    if (!(activeModel in currentMap)) {
      const nextMap = { ...currentMap, [activeModel]: value };
      await config.update("effortByModel", nextMap, target);
      log(`[Migration] Moved damocles.effort=${value} → effortByModel[${activeModel}] (scope=${target})`);
    }
    await config.update("effort", undefined, target);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = initLogger();
  context.subscriptions.push(outputChannel);
  log("Damocles extension activating...");
  if (vscode.workspace.getConfiguration('damocles').get<boolean>('debug')) {
    showLog(true);
  }

  await migrateLegacyEffortSetting();
  // Back MCP OAuth credential storage with the OS keychain (M1); set before any MCP server connects.
  setMcpSecretStorage(context.secrets);

  chatPanelProvider = new ChatPanelProvider(context.extensionUri, context);

  // Refresh the pi web-tools active set live when the setting changes — no window reload (only when the
  // pi runtime already exists; otherwise its own init reads the current setting on first use).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("damocles.pi.webSearch.enabled") && PiRuntime.exists) {
        void PiRuntime.get().refreshWebSearch();
      }
    }),
  );

  const voiceService = chatPanelProvider.getVoiceService();
  const voiceStatusBar = createVoiceStatusBarItem(context, voiceService);
  context.subscriptions.push({ dispose: (): void => voiceStatusBar.dispose() });
  const panelManager = chatPanelProvider.getPanelManager();
  setupAutoDisable(voiceService, context, {
    onPanelsAllClosed: (callback: () => void): vscode.Disposable => panelManager.onAllPanelsClosed(callback),
  });

  const sidebarProvider = new SidebarViewProvider(
    chatPanelProvider.getPanelManager(),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "damocles.sidebarView",
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("damocles.chat", {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, _state: unknown) {
        try {
          await chatPanelProvider?.restorePanel(panel);
        } catch (err) {
          log(`[Deserializer] Panel restoration failed: ${err}`);
        }
      },
    })
  );

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("damocles-browser-view", {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
        try {
          const url = (state as { url?: string } | null)?.url || 'about:blank';
          await chatPanelProvider?.restoreBrowserPanel(panel, url);
        } catch (err) {
          log(`[Deserializer] Browser panel restoration failed: ${err}`);
        }
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("damocles.openChat", () => {
      chatPanelProvider?.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("damocles.newSession", () => {
      chatPanelProvider?.newSession();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("damocles.cancelSession", () => {
      chatPanelProvider?.cancelSession();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("damocles.showLog", () => {
      showLog();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("damocles.pickBrowserElement", async () => {
      const browserService = chatPanelProvider?.getBrowserService();
      if (!browserService?.isConnected()) {
        vscode.window.showWarningMessage("Damocles: No browser session active. Open a browser first.");
        return;
      }
      try {
        const element = await browserService.pickElement();
        const delivered = chatPanelProvider?.getPanelManager().postToActivePanel({ type: "browserElementPicked", element }) ?? false;
        if (!delivered) {
          vscode.window.showWarningMessage("Damocles: No active chat panel — open a chat panel to receive picked elements.");
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("cancelled")) return;
        vscode.window.showErrorMessage(`Damocles: Element pick failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("damocles.browser.toggleDevTools", () => {
      chatPanelProvider?.getBrowserService().toggleDevTools();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("damocles.togglePromptNavigator", () => {
      chatPanelProvider?.getPanelManager().postToActivePanel({ type: "togglePromptNavigator" });
    })
  );

  const EXPLORE_PROVIDER_UI = {
    openrouter: { label: "OpenRouter", prompt: "Enter your OpenRouter API key for Explore agents", placeholder: "sk-or-..." },
    gemini: { label: "Gemini", prompt: "Enter your Google Gemini API key", placeholder: "AIza..." },
    stepfun: { label: "StepFun", prompt: "Enter your StepFun (Step Plan) API key", placeholder: "" },
  } as const;
  type ExploreProviderId = keyof typeof EXPLORE_PROVIDER_UI;

  context.subscriptions.push(
    vscode.commands.registerCommand("damocles.setExploreApiKey", async () => {
      const raw = vscode.workspace.getConfiguration("damocles.explore").get<string>("provider", "openrouter");
      const providerId: ExploreProviderId = raw in EXPLORE_PROVIDER_UI ? raw as ExploreProviderId : "openrouter";
      const ui = EXPLORE_PROVIDER_UI[providerId];
      const secretKey = EXPLORE_SECRET_KEYS[providerId];
      const key = await vscode.window.showInputBox({
        prompt: ui.prompt,
        password: true,
        placeHolder: ui.placeholder,
      });
      if (key === undefined) return;
      if (key === "") {
        await context.secrets.delete(secretKey);
        vscode.window.showInformationMessage(`Damocles: ${ui.label} API key removed`);
      } else {
        await context.secrets.store(secretKey, key);
        vscode.window.showInformationMessage(`Damocles: ${ui.label} API key saved`);
      }
    })
  );

  log("Damocles extension activated");
}

export function deactivate(): void {
  if (PiRuntime.exists) {
    void PiRuntime.disposeInstance();
  }
  chatPanelProvider?.dispose();
  log("Damocles extension deactivated");
}
