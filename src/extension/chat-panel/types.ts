import type * as vscode from "vscode";
import type { ClaudeSession } from "../claude-session";
import type { PermissionHandler } from "../permission-handler";
import type { IdeContextManager } from "./ide-context-manager";
import type { McpServerConfig } from "../../shared/types/mcp";
import type { HistoryMessage } from "../../shared/types/content";
import type { RewindHistoryItem, StoredSession } from "../../shared/types/session";

export const SESSIONS_PAGE_SIZE = 20;

export interface WebviewHost {
  readonly webview: vscode.Webview;
  readonly visible: boolean;
  readonly active: boolean;
  readonly onDidDispose: vscode.Event<void>;
  readonly onDidChangeVisibility: vscode.Event<void>;
  readonly onDidChangeActive: vscode.Event<void>;
  close(): void;
}

const NO_OP_EVENT: vscode.Event<void> = () => ({ dispose: () => {} });

export function createPanelHost(panel: vscode.WebviewPanel): WebviewHost {
  return {
    webview: panel.webview,
    get visible() { return panel.visible; },
    get active() { return panel.active; },
    onDidDispose: panel.onDidDispose,
    onDidChangeVisibility: (listener, thisArgs?, disposables?) => {
      let prev = panel.visible;
      return panel.onDidChangeViewState(() => {
        const now = panel.visible;
        if (now !== prev) {
          prev = now;
          listener();
        }
      }, thisArgs, disposables);
    },
    onDidChangeActive: (listener, thisArgs?, disposables?) => {
      let prev = panel.active;
      return panel.onDidChangeViewState(() => {
        const now = panel.active;
        if (now !== prev) {
          prev = now;
          listener();
        }
      }, thisArgs, disposables);
    },
    close: () => panel.dispose(),
  };
}

export function createViewHost(view: vscode.WebviewView): WebviewHost {
  return {
    webview: view.webview,
    get visible() { return view.visible; },
    get active() { return false; },
    onDidDispose: view.onDidDispose,
    onDidChangeVisibility: view.onDidChangeVisibility,
    onDidChangeActive: NO_OP_EVENT,
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
