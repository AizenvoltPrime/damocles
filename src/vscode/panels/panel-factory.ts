import * as vscode from 'vscode';
import type { PanelHost, PanelOptions } from '../../platform/window-service';
import { BROWSER_VIEW_TYPE, CHAT_VIEW_TYPE, wrapBrowserPanel, wrapChatPanel } from './webview-hosts';

function viewTypeOf(kind: PanelOptions['kind']): string {
  return kind === 'chat' ? CHAT_VIEW_TYPE : BROWSER_VIEW_TYPE;
}

function resourceRoots(opts: Pick<PanelOptions, 'localResourceRoots'>): vscode.Uri[] {
  return opts.localResourceRoots.map((root) => vscode.Uri.file(root));
}

function createAt(opts: Omit<PanelOptions, 'column'>, column: vscode.ViewColumn): PanelHost {
  if (opts.kind === 'chat') {
    const panel = vscode.window.createWebviewPanel(
      CHAT_VIEW_TYPE,
      opts.title,
      { viewColumn: column, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: resourceRoots(opts) },
    );
    return wrapChatPanel(panel);
  }
  const panel = vscode.window.createWebviewPanel(
    BROWSER_VIEW_TYPE,
    opts.title,
    { viewColumn: column, preserveFocus: true },
    { enableScripts: true, localResourceRoots: resourceRoots(opts) },
  );
  return wrapBrowserPanel(panel);
}

export function createPanel(opts: PanelOptions): PanelHost {
  return createAt(opts, opts.column ?? vscode.ViewColumn.Active);
}

function findExistingPanelColumn(viewType: string): vscode.ViewColumn | undefined {
  for (const group of vscode.window.tabGroups.all) {
    if (group.tabs.length === 0) continue;
    const allOfKind = group.tabs.every((tab) => {
      if (tab.input instanceof vscode.TabInputWebview) {
        return tab.input.viewType.includes(viewType);
      }
      return false;
    });
    if (allOfKind && group.viewColumn) {
      return group.viewColumn;
    }
  }
  return undefined;
}

function findUnusedColumn(): vscode.ViewColumn {
  const usedColumns = new Set<vscode.ViewColumn>();
  vscode.window.tabGroups.all.forEach((group) => {
    if (group.viewColumn !== undefined) {
      usedColumns.add(group.viewColumn);
    }
  });

  for (let col = vscode.ViewColumn.One; col <= vscode.ViewColumn.Nine; col++) {
    if (!usedColumns.has(col)) {
      return col;
    }
  }
  return vscode.ViewColumn.Beside;
}

export async function createPanelInOwnColumn(opts: Omit<PanelOptions, 'column'>): Promise<PanelHost> {
  const existingColumn = findExistingPanelColumn(viewTypeOf(opts.kind));
  const host = createAt(opts, existingColumn ?? findUnusedColumn());
  if (!existingColumn) {
    await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
  }
  return host;
}
