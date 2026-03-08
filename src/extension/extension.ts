import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ChatPanelProvider } from "./chat-panel";
import { SidebarViewProvider } from "./chat-panel/sidebar-view-provider";
import { initSqlEngine } from "./memory/database";
import { initLogger, log, showLog } from "./logger";

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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = initLogger();
  context.subscriptions.push(outputChannel);
  log("Damocles extension activating...");
  if (vscode.workspace.getConfiguration('damocles').get<boolean>('debug')) {
    showLog(true);
  }

  await fixPackagePermissions(context.extensionUri);
  const sqlReady = await initSqlEngine(context.extensionUri.fsPath);
  if (!sqlReady) {
    vscode.window.showWarningMessage('Damocles: Memory system unavailable — SQL engine failed to initialize.');
  }

  chatPanelProvider = new ChatPanelProvider(context.extensionUri, context);

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

  log("Damocles extension activated");
}

export function deactivate(): void {
  chatPanelProvider?.dispose();
  log("Damocles extension deactivated");
}
