import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { __webviewPanels, type FakeWebviewPanel } from 'vscode';
import { wrapBrowserPanel, wrapChatPanel, wrapSidebarView } from '../webview-hosts';

function makePanel(): FakeWebviewPanel {
  const panel = vscode.window.createWebviewPanel('damocles.chat', 'Damocles', 1) as unknown as FakeWebviewPanel;
  panel.reveal = vi.fn();
  panel.webview.asWebviewUri = (uri: unknown) => ({ toString: () => `webview:${(uri as { fsPath: string }).fsPath}` });
  panel.webview.cspSource = 'csp-source';
  return panel;
}

const asPanel = (panel: FakeWebviewPanel) => panel as unknown as vscode.WebviewPanel;

beforeEach(() => {
  __webviewPanels.length = 0;
});

describe('wrapChatPanel', () => {
  it('reads state and posts through the panel', async () => {
    const panel = makePanel();
    const host = wrapChatPanel(asPanel(panel));

    host.setHtml('<html></html>');
    await host.postMessage({ type: 'ping' });

    expect(panel.webview.html).toBe('<html></html>');
    expect(panel.posted).toEqual([{ type: 'ping' }]);
    expect(host.cspSource).toBe('csp-source');
    expect(host.column).toBe(1);
    expect(host.visible).toBe(true);
    expect(host.active).toBe(true);
    expect(host.asResourceUri('/ext/resources/icon.png')).toBe('webview:/ext/resources/icon.png');
  });

  it('names the folder in the tab title, and drops it for undefined', () => {
    const panel = makePanel();
    const host = wrapChatPanel(asPanel(panel));

    host.setFolderLabel('beta');
    expect(panel.title).toBe('Damocles · beta');
    host.setFolderLabel(undefined);
    expect(panel.title).toBe('Damocles');
  });

  it('reveals in place with no arguments', () => {
    const panel = makePanel();
    wrapChatPanel(asPanel(panel)).reveal();

    expect(panel.reveal).toHaveBeenCalledWith();
  });

  it('sets the icon from an absolute path and closes by disposing', () => {
    const panel = makePanel();
    const host = wrapChatPanel(asPanel(panel));
    const disposed = vi.fn();
    host.onDispose(disposed);

    host.setIcon('/ext/resources/icon.png');
    expect(panel.iconPath).toEqual(vscode.Uri.file('/ext/resources/icon.png'));
    host.close();
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it('delivers webview messages and every view-state event', () => {
    const panel = makePanel();
    const host = wrapChatPanel(asPanel(panel));
    const messages: unknown[] = [];
    const states = vi.fn();
    host.onMessage((m) => messages.push(m));
    host.onDidChangeViewState(states);

    panel.fireMessage({ type: 'ready' });
    panel.setVisible(true);
    panel.setVisible(false);

    expect(messages).toEqual([{ type: 'ready' }]);
    expect(states).toHaveBeenCalledTimes(2);
  });

  it('throws synchronously when the webview throws, so a caller catching the throw still sees it', () => {
    const panel = makePanel();
    panel.webview.postMessage = () => { throw new Error('disposed'); };

    expect(() => wrapChatPanel(asPanel(panel)).postMessage({})).toThrow('disposed');
  });
});

describe('wrapBrowserPanel', () => {
  it('reveals without focus in the given column, else its own column', () => {
    const panel = makePanel();
    const host = wrapBrowserPanel(asPanel(panel));

    host.reveal(3);
    host.reveal();

    expect(panel.reveal).toHaveBeenNthCalledWith(1, 3, true);
    expect(panel.reveal).toHaveBeenNthCalledWith(2, 1, true);
  });

  it('reveals in the active column when the panel has none', () => {
    const panel = makePanel();
    (panel as unknown as { viewColumn: number | undefined }).viewColumn = undefined;

    wrapBrowserPanel(asPanel(panel)).reveal();

    expect(panel.reveal).toHaveBeenCalledWith(vscode.ViewColumn.Active, true);
  });

  it('clears the tab icon for undefined and sets the title', () => {
    const panel = makePanel();
    const host = wrapBrowserPanel(asPanel(panel));

    host.setIcon('/cache/favicon.png');
    host.setIcon(undefined);
    host.setTitle('Example');

    expect(panel.iconPath).toBeUndefined();
    expect(panel.title).toBe('Example');
  });
});

describe('wrapSidebarView', () => {
  function makeView() {
    const panel = makePanel();
    const visibilityCbs: Array<() => void> = [];
    const view = {
      webview: panel.webview,
      visible: true,
      description: '',
      title: 'Damocles',
      onDidDispose: panel.onDidDispose,
      onDidChangeVisibility: (cb: () => void) => { visibilityCbs.push(cb); return { dispose: () => undefined }; },
      show: vi.fn(),
    };
    return { view, panel, fireVisibility: () => visibilityCbs.forEach((cb) => cb()) };
  }

  it('is never active, has no column, and names the folder in its description', () => {
    const { view } = makeView();
    const host = wrapSidebarView(view as unknown as vscode.WebviewView);

    host.setFolderLabel('beta');
    expect(view.description).toBe('beta');
    host.setFolderLabel(undefined);
    expect(view.description).toBe('');
    expect(host.active).toBe(false);
    expect(host.column).toBeUndefined();
  });

  it('reveals by showing the view, and reports visibility changes as view-state events', () => {
    const { view, fireVisibility } = makeView();
    const host = wrapSidebarView(view as unknown as vscode.WebviewView);
    const states = vi.fn();
    host.onDidChangeViewState(states);

    host.reveal();
    fireVisibility();

    expect(view.show).toHaveBeenCalledTimes(1);
    expect(states).toHaveBeenCalledTimes(1);
  });
});
