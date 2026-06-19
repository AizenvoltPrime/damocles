import * as vscode from "vscode";
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
}
