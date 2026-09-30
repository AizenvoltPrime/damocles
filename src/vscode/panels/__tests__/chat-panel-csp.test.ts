import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { __webviewPanels, type FakeWebviewPanel } from 'vscode';
import { wrapChatPanel, wrapSidebarView } from '../webview-hosts';
import { createHarness, folderEntry, type Harness } from '../../../core/chat-panel/__tests__/panel-manager-harness';

// The VS Code chat panel CSP as shipped before the desktop Monaco editor existed; any change to it is a VS Code-visible change.
const VSCODE_CHAT_PANEL_CSP =
  "default-src 'none'; style-src vscode-csp-source 'unsafe-inline'; script-src 'nonce-<nonce>' 'wasm-unsafe-eval'; font-src vscode-csp-source; img-src vscode-csp-source data: https:;";

function cspOf(html: string): string {
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
  if (csp === undefined) throw new Error('no CSP meta tag in the panel HTML');
  const nonce = /<script nonce="([^"]+)"/.exec(html)?.[1];
  if (nonce === undefined) throw new Error('no nonce on the panel script');
  return csp.replace(`'nonce-${nonce}'`, "'nonce-<nonce>'");
}

let harness: Harness | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
  __webviewPanels.length = 0;
});

describe('VS Code chat panel CSP', () => {
  it('is byte-identical to the shipped policy for an editor panel', () => {
    harness = createHarness([folderEntry('/ws')]);
    const panel = vscode.window.createWebviewPanel('damocles.chat', 'Damocles', 1) as unknown as FakeWebviewPanel;
    panel.webview.cspSource = 'vscode-csp-source';
    panel.webview.asWebviewUri = (uri: unknown) => ({ toString: () => `webview:${(uri as { fsPath: string }).fsPath}` });

    const html = harness.manager.getHtmlContent(wrapChatPanel(panel as unknown as vscode.WebviewPanel));

    expect(cspOf(html)).toBe(VSCODE_CHAT_PANEL_CSP);
  });

  it('is byte-identical to the shipped policy for the sidebar view', () => {
    harness = createHarness([folderEntry('/ws')]);
    const view = {
      webview: {
        cspSource: 'vscode-csp-source',
        asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => `webview:${uri.fsPath}` }),
      },
    };

    const html = harness.manager.getHtmlContent(wrapSidebarView(view as unknown as vscode.WebviewView));

    expect(cspOf(html)).toBe(VSCODE_CHAT_PANEL_CSP);
  });
});
