import * as vscode from "vscode";
import { BROWSER_SERVER_NAME, BROWSER_MCP_SERVER_NAME } from "../../../../shared/types/browser";
import type { McpServerStatusInfo, McpToolInfo } from "../../../../shared/types/mcp";
import { updateConfigAtEffectiveScope } from "../utils";

export class BrowserManager {
  private enabled = false;
  private configListener: vscode.Disposable | null = null;

  loadState(): void {
    this.enabled = vscode.workspace.getConfiguration("damocles.browser").get<boolean>("enabled", false);
    this.configListener ??= vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("damocles.browser.enabled")) {
        this.enabled = vscode.workspace.getConfiguration("damocles.browser").get<boolean>("enabled", false);
      }
    });
  }

  dispose(): void {
    this.configListener?.dispose();
    this.configListener = null;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    await updateConfigAtEffectiveScope("damocles.browser", "enabled", enabled);
  }

  getServerForUI(): McpServerStatusInfo {
    return {
      name: BROWSER_SERVER_NAME,
      displayName: "Damocles Browser",
      status: this.enabled ? "idle" : "disabled",
      enabled: this.enabled,
    };
  }

  mergeWithSdkStatus(sdkStatuses: McpServerStatusInfo[]): McpServerStatusInfo {
    if (!this.enabled) {
      return this.getServerForUI();
    }

    const sdkEntry = sdkStatuses.find(s => s.name === BROWSER_MCP_SERVER_NAME);
    if (!sdkEntry) {
      return {
        name: BROWSER_SERVER_NAME,
        displayName: "Damocles Browser",
        status: "pending",
        enabled: true,
      };
    }

    return {
      name: BROWSER_SERVER_NAME,
      displayName: "Damocles Browser",
      status: sdkEntry.status,
      enabled: true,
      ...(sdkEntry.serverInfo && { serverInfo: sdkEntry.serverInfo }),
      ...(sdkEntry.error && { error: sdkEntry.error }),
      ...(sdkEntry.tools && { tools: sdkEntry.tools as McpToolInfo[] }),
    };
  }
}
