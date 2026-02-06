import type * as vscode from "vscode";
import type { ClaudeSession } from "../claude-session";
import type { PermissionHandler } from "../permission-handler";
import type { IdeContextManager } from "./ide-context-manager";
import type { McpServerConfig } from "../../shared/types/mcp";
import type { HistoryMessage } from "../../shared/types/content";
import type { RewindHistoryItem, StoredSession } from "../../shared/types/session";

export const SESSIONS_PAGE_SIZE = 20;
export const HISTORY_PAGE_SIZE = 30;

export interface WebviewHost {
  readonly webview: vscode.Webview;
  readonly visible: boolean;
  readonly onDidDispose: vscode.Event<void>;
  readonly onDidChangeVisibility: vscode.Event<void>;
  close(): void;
}

export function createPanelHost(panel: vscode.WebviewPanel): WebviewHost {
  return {
    webview: panel.webview,
    get visible() { return panel.visible; },
    onDidDispose: panel.onDidDispose,
    onDidChangeVisibility: (listener, thisArgs?, disposables?) =>
      panel.onDidChangeViewState(() => listener(), thisArgs, disposables),
    close: () => panel.dispose(),
  };
}

export function createViewHost(view: vscode.WebviewView): WebviewHost {
  return {
    webview: view.webview,
    get visible() { return view.visible; },
    onDidDispose: view.onDidDispose,
    onDidChangeVisibility: view.onDidChangeVisibility,
    close: () => {},
  };
}

export interface HostInstance {
  host: WebviewHost;
  session: ClaudeSession;
  permissionHandler: PermissionHandler;
  ideContextManager: IdeContextManager;
  disposables: vscode.Disposable[];
}

export type { StoredSession, HistoryMessage, RewindHistoryItem, McpServerConfig };
