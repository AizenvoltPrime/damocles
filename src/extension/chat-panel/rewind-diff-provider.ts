import * as vscode from "vscode";
import * as path from "path";

const SCHEME = "damocles-rewind";

class RewindContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();

  setContent(key: string, content: string): void {
    this.contents.set(key, content);
  }

  deleteContent(key: string): void {
    this.contents.delete(key);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.path) ?? "";
  }

  clear(): void {
    this.contents.clear();
  }
}

export class RewindDiffProvider {
  private readonly provider = new RewindContentProvider();
  private readonly registration: vscode.Disposable;
  private readonly tabListener: vscode.Disposable;
  private readonly activeKeys = new Set<string>();

  constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, this.provider);
    this.tabListener = vscode.window.tabGroups.onDidChangeTabs((e) => this.onTabsChanged(e));
  }

  async showDiff(filePath: string, beforeContent: string, title: string): Promise<void> {
    this.reconcileWithOpenTabs();
    const fileName = path.basename(filePath);
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const key = `/${id}-${fileName}`;
    this.provider.setContent(key, beforeContent);
    this.activeKeys.add(key);

    const beforeUri = vscode.Uri.parse(`${SCHEME}:${key}`);
    const afterUri = vscode.Uri.file(filePath);

    await vscode.commands.executeCommand("vscode.diff", beforeUri, afterUri, title, {
      preview: true,
    });
  }

  private onTabsChanged(e: vscode.TabChangeEvent): void {
    for (const closed of e.closed) {
      if (!(closed.input instanceof vscode.TabInputTextDiff)) continue;
      const original = closed.input.original;
      if (original.scheme !== SCHEME) continue;
      if (!this.activeKeys.has(original.path)) continue;
      this.provider.deleteContent(original.path);
      this.activeKeys.delete(original.path);
    }
  }

  private reconcileWithOpenTabs(): void {
    const openKeys = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!(tab.input instanceof vscode.TabInputTextDiff)) continue;
        if (tab.input.original.scheme !== SCHEME) continue;
        openKeys.add(tab.input.original.path);
      }
    }
    for (const key of this.activeKeys) {
      if (!openKeys.has(key)) {
        this.provider.deleteContent(key);
        this.activeKeys.delete(key);
      }
    }
  }

  dispose(): void {
    this.registration.dispose();
    this.tabListener.dispose();
    this.provider.clear();
    this.activeKeys.clear();
  }
}
