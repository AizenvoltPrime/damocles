import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ChatPanelProvider } from "./chat-panel";
import { SidebarViewProvider } from "./chat-panel/sidebar-view-provider";
import { initLogger, log, showLog } from "./logger";
import { initSdkLoader } from "./shared/sdk-loader";
import { registerSignInCommand, registerSignOutCommand } from "./auth/login-command";
import { bootstrapDamoclesConfigDir } from "./auth/config-dir-bootstrap";
import { createVoiceStatusBarItem } from "./voice/status-bar";
import { setupAutoDisable } from "./voice/auto-disable";
import { DEFAULT_FALLBACK_MODEL } from "../shared/types/constants";
import type { EffortLevel } from "../shared/types/settings";

let chatPanelProvider: ChatPanelProvider | undefined;

async function fixPackagePermissions(extensionUri: vscode.Uri): Promise<void> {
  if (process.platform === "win32") return;

  const nodeModulesPath = path.join(extensionUri.fsPath, "node_modules");

  const entries: { file: string; mode: number }[] = [
    { file: path.join(nodeModulesPath, "@anthropic-ai", "claude-agent-sdk", "vendor", "ripgrep", "x64-linux", "rg"), mode: 0o755 },
    { file: path.join(nodeModulesPath, "@anthropic-ai", "claude-agent-sdk", "vendor", "ripgrep", "arm64-linux", "rg"), mode: 0o755 },
    { file: path.join(nodeModulesPath, "@anthropic-ai", "claude-agent-sdk", "vendor", "ripgrep", "x64-darwin", "rg"), mode: 0o755 },
    { file: path.join(nodeModulesPath, "@anthropic-ai", "claude-agent-sdk", "vendor", "ripgrep", "arm64-darwin", "rg"), mode: 0o755 },
    { file: path.join(nodeModulesPath, "sql.js-fts5", "dist", "sql-wasm.js"), mode: 0o644 },
    { file: path.join(nodeModulesPath, "sql.js-fts5", "dist", "sql-wasm.wasm"), mode: 0o644 },
  ];

  for (const { file, mode } of entries) {
    try {
      await fs.promises.chmod(file, mode);
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      log(`[Permissions] Failed to chmod ${file}: ${err}`);
    }
  }
}

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

  fixPackagePermissions(context.extensionUri).catch(err => log(`[Permissions] ${err}`));

  await migrateLegacyEffortSetting();
  await initSdkLoader();
  await bootstrapDamoclesConfigDir(context);

  chatPanelProvider = new ChatPanelProvider(context.extensionUri, context);

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
    registerSignInCommand(context, async () => {
      await chatPanelProvider?.reloadActiveSession();
    }),
    registerSignOutCommand(context, async () => {
      await chatPanelProvider?.reloadActiveSession();
    }),
  );

  log("Damocles extension activated");
}

export function deactivate(): void {
  chatPanelProvider?.dispose();
  log("Damocles extension deactivated");
}
