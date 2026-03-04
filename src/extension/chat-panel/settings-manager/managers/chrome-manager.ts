import * as vscode from "vscode";
import { CHROME_SERVER_NAME, CHROME_SDK_SERVER_NAME, type McpServerStatusInfo, type McpToolInfo } from "../../../../shared/types/mcp";
import { updateConfigAtEffectiveScope } from "../utils";

export class ChromeManager {
  private enabled = false;
  private configListener: vscode.Disposable | null = null;

  loadState(): void {
    this.enabled = vscode.workspace.getConfiguration("damocles.chrome").get<boolean>("enabled", false);
    this.configListener ??= vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("damocles.chrome.enabled")) {
        this.enabled = vscode.workspace.getConfiguration("damocles.chrome").get<boolean>("enabled", false);
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
    await updateConfigAtEffectiveScope("damocles.chrome", "enabled", enabled);
  }

  getServerForUI(): McpServerStatusInfo {
    return {
      name: CHROME_SERVER_NAME,
      displayName: "Chrome",
      status: this.enabled ? "idle" : "disabled",
      enabled: this.enabled,
    };
  }

  mergeWithSdkStatus(sdkStatuses: McpServerStatusInfo[]): McpServerStatusInfo {
    if (!this.enabled) {
      return this.getServerForUI();
    }

    const sdkEntry = sdkStatuses.find(s => s.name === CHROME_SDK_SERVER_NAME);
    if (!sdkEntry) {
      return {
        name: CHROME_SERVER_NAME,
        displayName: "Chrome",
        status: "pending",
        enabled: true,
      };
    }

    return {
      name: CHROME_SERVER_NAME,
      displayName: "Chrome",
      status: sdkEntry.status,
      enabled: true,
      ...(sdkEntry.serverInfo && { serverInfo: sdkEntry.serverInfo }),
      ...(sdkEntry.error && { error: sdkEntry.error }),
      ...(sdkEntry.tools && { tools: sdkEntry.tools as McpToolInfo[] }),
    };
  }
}
