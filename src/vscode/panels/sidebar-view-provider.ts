import * as vscode from "vscode";
import { restoredWorkspaceFolderKey, type PanelManager } from "../../core/chat-panel/panel-manager";
import { wrapSidebarView } from "./webview-hosts";

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  private readonly panelManager: PanelManager;

  constructor(panelManager: PanelManager) {
    this.panelManager = panelManager;
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: this.panelManager.getLocalResourceRoots().map((root) => vscode.Uri.file(root)),
    };

    const host = wrapSidebarView(webviewView);
    host.setHtml(this.panelManager.getHtmlContent(host));
    // The view has no serializer, so its saved folder arrives here, before its first session is created.
    const initialFolderKey = restoredWorkspaceFolderKey(context.state);
    await this.panelManager.initializeHost(host, initialFolderKey !== undefined ? { initialFolderKey } : undefined);
  }
}
