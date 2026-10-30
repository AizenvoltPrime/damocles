import * as vscode from 'vscode';
import type { Disposable } from '../../platform/disposable';
import { randomBytes } from 'node:crypto';
import type { PanelHost } from '../../platform/window-service';
import { browserPageHtml, type BrowserPageStrings } from '../../shared/browser-page-html';
import { ERROR_PAGE_STRINGS, type ErrorPageStrings } from '../../shared/panel-html';

export const CHAT_VIEW_TYPE = 'damocles.chat';
export const BROWSER_VIEW_TYPE = 'damocles-browser-view';

// vscode types iconPath as required, so exactOptionalPropertyTypes rejects assigning undefined to clear it.
function asIconPathSettable(panel: vscode.WebviewPanel): { iconPath: vscode.Uri | undefined } {
  return panel as unknown as { iconPath: vscode.Uri | undefined };
}

function wrapWebviewPanel(
  panel: vscode.WebviewPanel,
  behavior: Pick<PanelHost, 'reveal' | 'setFolderLabel' | 'retainsContextWhenHidden' | 'showPage' | 'errorPageStrings'>,
): PanelHost {
  const webview = panel.webview;
  // Built as one literal: spreading it into another would copy each getter's value once and freeze it.
  return {
    ...(behavior.showPage ? { showPage: behavior.showPage } : {}),
    ...(behavior.errorPageStrings ? { errorPageStrings: behavior.errorPageStrings } : {}),
    get visible() { return panel.visible; },
    get active() { return panel.active; },
    retainsContextWhenHidden: behavior.retainsContextWhenHidden,
    get column() { return panel.viewColumn; },
    get cspSource() { return webview.cspSource; },
    // VS Code injects its --vscode-* variables into every webview itself, and tokens.css maps them to --d-*.
    themeCssSource: () => '',
    setHtml: (html) => { webview.html = html; },
    // Not async, so a synchronous throw from webview.postMessage still reaches the caller's try/catch.
    postMessage: (message) => Promise.resolve(webview.postMessage(message)),
    onMessage: (listener): Disposable => webview.onDidReceiveMessage(listener),
    onDispose: (listener): Disposable => panel.onDidDispose(listener),
    onDidChangeViewState: (listener): Disposable => panel.onDidChangeViewState(() => listener()),
    asResourceUri: (absolutePath) => webview.asWebviewUri(vscode.Uri.file(absolutePath)).toString(),
    setIcon: (iconPath) => { asIconPathSettable(panel).iconPath = iconPath === undefined ? undefined : vscode.Uri.file(iconPath); },
    setTitle: (title) => { panel.title = title; },
    setFolderLabel: behavior.setFolderLabel,
    reveal: behavior.reveal,
    close: () => panel.dispose(),
  };
}

// retainsContextWhenHidden must equal the retainContextWhenHidden panel-factory.ts creates each kind with.
export function wrapChatPanel(panel: vscode.WebviewPanel): PanelHost {
  return wrapWebviewPanel(panel, {
    retainsContextWhenHidden: true,
    reveal: (column) => { if (column === undefined) panel.reveal(); else panel.reveal(column); },
    setFolderLabel: (label) => { panel.title = label === undefined ? 'Damocles' : `Damocles · ${label}`; },
    errorPageStrings,
  });
}

// Read per page, so a page shows the display language VS Code runs in.
export function errorPageStrings(): ErrorPageStrings {
  return { title: vscode.l10n.t(ERROR_PAGE_STRINGS.title), detail: vscode.l10n.t(ERROR_PAGE_STRINGS.detail) };
}

// Read per page, so a page shows the display language VS Code runs in.
export function browserPageStrings(): BrowserPageStrings {
  return {
    back: vscode.l10n.t('Back'),
    forward: vscode.l10n.t('Forward'),
    reload: vscode.l10n.t('Reload'),
    pickElement: vscode.l10n.t('Pick Element'),
    devTools: vscode.l10n.t('Open Developer Tools (F12)'),
    newTab: vscode.l10n.t('New Tab'),
    urlPlaceholder: vscode.l10n.t('Enter URL...'),
    notSecure: vscode.l10n.t('Not secure'),
    notSecureDetail: vscode.l10n.t('The connection to this site is not encrypted, so others on the network can read and change what it sends.'),
    waiting: vscode.l10n.t('Waiting for browser frames...'),
  };
}

export function wrapBrowserPanel(panel: vscode.WebviewPanel): PanelHost {
  return wrapWebviewPanel(panel, {
    retainsContextWhenHidden: false,
    reveal: (column) => panel.reveal(column ?? panel.viewColumn ?? vscode.ViewColumn.Active, true),
    setFolderLabel: () => {},
    showPage: (page) => {
      if (page.kind !== 'browser') throw new Error(`A browser panel shows no ${page.kind} page`);
      panel.webview.html = browserPageHtml({ nonce: randomBytes(16).toString('base64'), strings: browserPageStrings(), toolbar: page.toolbar, themeCss: '' });
    },
  });
}

export function wrapSidebarView(view: vscode.WebviewView): PanelHost {
  const webview = view.webview;
  return {
    get visible() { return view.visible; },
    get active() { return false; },
    // extension.ts registers the view with retainContextWhenHidden.
    retainsContextWhenHidden: true,
    get column() { return undefined; },
    get cspSource() { return webview.cspSource; },
    themeCssSource: () => '',
    setHtml: (html) => { webview.html = html; },
    postMessage: (message) => Promise.resolve(webview.postMessage(message)),
    onMessage: (listener): Disposable => webview.onDidReceiveMessage(listener),
    onDispose: (listener): Disposable => view.onDidDispose(listener),
    onDidChangeViewState: (listener): Disposable => view.onDidChangeVisibility(() => listener()),
    asResourceUri: (absolutePath) => webview.asWebviewUri(vscode.Uri.file(absolutePath)).toString(),
    setIcon: () => {},
    setTitle: (title) => { view.title = title; },
    setFolderLabel: (label) => { view.description = label ?? ''; },
    reveal: () => view.show(),
    close: () => {},
    errorPageStrings,
  };
}
