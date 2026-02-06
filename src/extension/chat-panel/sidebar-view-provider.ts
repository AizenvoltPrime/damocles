import * as vscode from "vscode";
import type { PanelManager } from "./panel-manager";
import { createViewHost } from "./types";

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  private readonly panelManager: PanelManager;

  constructor(panelManager: PanelManager) {
    this.panelManager = panelManager;
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: this.panelManager.getLocalResourceRoots(),
    };

    webviewView.webview.html = this.panelManager.getHtmlContent(webviewView.webview);

    const host = createViewHost(webviewView);
    await this.panelManager.initializeHost(host);
  }
}
