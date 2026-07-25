import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { BROWSER_WEBVIEW_SCRIPT } from './browser-webview-script';
import type { ElementOverlayInfo } from './types';

export class BrowserPanel {
  private panel: vscode.WebviewPanel | null = null;
  private disposeListeners: vscode.Disposable[] = [];
  private disposing = false;
  private onMouseDownHandler: ((x: number, y: number, button: number, buttons: number, clickCount: number, modifiers: number) => void) | null = null;
  private onMouseUpHandler: ((x: number, y: number, button: number, buttons: number, clickCount: number, modifiers: number) => void) | null = null;
  private onKeyHandler: ((key: string, code: string, text: string, keyCode: number, modifiers: number, phase: KeyPhase) => void) | null = null;
  private onInsertTextHandler: ((text: string) => void) | null = null;
  private onReadyHandler: (() => void) | null = null;
  private onCloseHandler: (() => void) | null = null;
  private onScrollHandler: ((x: number, y: number, deltaX: number, deltaY: number) => void) | null = null;
  private onResizeHandler: ((width: number, height: number, dpr: number) => void) | null = null;
  private onNavigateHandler: ((url: string) => void) | null = null;
  private onGoBackHandler: (() => void) | null = null;
  private onGoForwardHandler: (() => void) | null = null;
  private onReloadHandler: (() => void) | null = null;
  private onPickElementHandler: (() => void) | null = null;
  private onMouseMoveHandler: ((x: number, y: number, buttons: number) => void) | null = null;
  private onPasteHandler: ((text: string) => void) | null = null;
  private onCopyHandler: (() => void) | null = null;
  private onCutHandler: (() => void) | null = null;
  private onOpenDevToolsHandler: (() => void) | null = null;
  private onVisibilityChangeHandler: ((visible: boolean) => void) | null = null;
  private onTabNewHandler: (() => void) | null = null;
  private onFrameRenderedHandler: ((frameId: number) => void) | null = null;

  get visible(): boolean {
    return this.panel?.visible ?? false;
  }

  get viewColumn(): vscode.ViewColumn | undefined {
    return this.panel?.viewColumn;
  }

  onClose(handler: () => void): void { this.onCloseHandler = handler; }
  onMouseDown(handler: (x: number, y: number, button: number, buttons: number, clickCount: number, modifiers: number) => void): void { this.onMouseDownHandler = handler; }
  onMouseUp(handler: (x: number, y: number, button: number, buttons: number, clickCount: number, modifiers: number) => void): void { this.onMouseUpHandler = handler; }
  onKey(handler: (key: string, code: string, text: string, keyCode: number, modifiers: number, phase: KeyPhase) => void): void { this.onKeyHandler = handler; }
  onInsertText(handler: (text: string) => void): void { this.onInsertTextHandler = handler; }
  /** The webview posts `ready` as the last statement of its script. Until it fires, the webview's
   *  message listener is not attached and every post to it is silently dropped, so this — not the
   *  visibility event — is the only sound trigger for replaying panel state. */
  onReady(handler: () => void): void { this.onReadyHandler = handler; }
  onScroll(handler: (x: number, y: number, deltaX: number, deltaY: number) => void): void { this.onScrollHandler = handler; }
  onResize(handler: (width: number, height: number, dpr: number) => void): void { this.onResizeHandler = handler; }
  onNavigate(handler: (url: string) => void): void { this.onNavigateHandler = handler; }
  onGoBack(handler: () => void): void { this.onGoBackHandler = handler; }
  onGoForward(handler: () => void): void { this.onGoForwardHandler = handler; }
  onReload(handler: () => void): void { this.onReloadHandler = handler; }
  onPickElement(handler: () => void): void { this.onPickElementHandler = handler; }
  onMouseMove(handler: (x: number, y: number, buttons: number) => void): void { this.onMouseMoveHandler = handler; }
  onPaste(handler: (text: string) => void): void { this.onPasteHandler = handler; }
  onCopy(handler: () => void): void { this.onCopyHandler = handler; }
  onCut(handler: () => void): void { this.onCutHandler = handler; }
  onOpenDevTools(handler: () => void): void { this.onOpenDevToolsHandler = handler; }
  onVisibilityChange(handler: (visible: boolean) => void): void { this.onVisibilityChangeHandler = handler; }
  onTabNew(handler: () => void): void { this.onTabNewHandler = handler; }
  onFrameRendered(handler: (frameId: number) => void): void { this.onFrameRenderedHandler = handler; }

  show(url: string, column?: vscode.ViewColumn): void {
    if (this.panel) {
      this.panel.reveal(column ?? this.panel.viewColumn ?? vscode.ViewColumn.Active, true);
      this.setTabTitle(null, url);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'damocles-browser-view',
      shortenUrl(url),
      { viewColumn: column ?? vscode.ViewColumn.Active, preserveFocus: true },
      { enableScripts: true, localResourceRoots: [] },
    );
    this.initPanel();
  }

  reveal(): void {
    this.panel?.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active, true);
  }

  private initPanel(): void {
    const nonce = randomBytes(16).toString('base64');
    // Built here rather than at module load so the strings are resolved per panel construction, at a
    // point where the l10n bundle for the active display language is guaranteed loaded.
    const strings: PanelStrings = {
      back: vscode.l10n.t('Back'),
      forward: vscode.l10n.t('Forward'),
      reload: vscode.l10n.t('Reload'),
      pickElement: vscode.l10n.t('Pick Element'),
      devTools: vscode.l10n.t('Open Developer Tools (F12)'),
      newTab: vscode.l10n.t('New Tab'),
      urlPlaceholder: vscode.l10n.t('Enter URL...'),
      waiting: vscode.l10n.t('Waiting for browser frames...'),
    };
    this.panel!.webview.html = buildHtml(nonce, strings);

    const msgDisposable = this.panel!.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      if (msg.type === 'mousedown') this.onMouseDownHandler?.(msg.x, msg.y, msg.button, msg.buttons, msg.clickCount, msg.modifiers);
      else if (msg.type === 'mouseup') this.onMouseUpHandler?.(msg.x, msg.y, msg.button, msg.buttons, msg.clickCount, msg.modifiers);
      else if (msg.type === 'key') this.onKeyHandler?.(msg.key, msg.code, msg.text, msg.keyCode, msg.modifiers, msg.phase);
      else if (msg.type === 'insertText') this.onInsertTextHandler?.(msg.text);
      else if (msg.type === 'ready') this.onReadyHandler?.();
      else if (msg.type === 'scroll') this.onScrollHandler?.(msg.x, msg.y, msg.deltaX, msg.deltaY);
      else if (msg.type === 'resize') this.onResizeHandler?.(msg.width, msg.height, msg.dpr);
      else if (msg.type === 'mousemove') this.onMouseMoveHandler?.(msg.x, msg.y, msg.buttons);
      else if (msg.type === 'navigate') this.onNavigateHandler?.(msg.url);
      else if (msg.type === 'goBack') this.onGoBackHandler?.();
      else if (msg.type === 'goForward') this.onGoForwardHandler?.();
      else if (msg.type === 'reload') this.onReloadHandler?.();
      else if (msg.type === 'pickElement') this.onPickElementHandler?.();
      else if (msg.type === 'openDevTools') this.onOpenDevToolsHandler?.();
      else if (msg.type === 'paste') this.onPasteHandler?.(msg.text);
      else if (msg.type === 'copy') this.onCopyHandler?.();
      else if (msg.type === 'cut') this.onCutHandler?.();
      else if (msg.type === 'tabNew') this.onTabNewHandler?.();
      else if (msg.type === 'frameRendered') this.onFrameRenderedHandler?.(msg.frameId);
    });
    this.disposeListeners.push(msgDisposable);

    const visDisposable = this.panel!.onDidChangeViewState(e => this.onVisibilityChangeHandler?.(e.webviewPanel.visible));
    this.disposeListeners.push(visDisposable);

    const disposeDisposable = this.panel!.onDidDispose(() => {
      this.panel = null;
      this.disposeListeners.forEach(d => d.dispose());
      this.disposeListeners = [];
      if (!this.disposing) this.onCloseHandler?.();
    });
    this.disposeListeners.push(disposeDisposable);
  }

  // The ArrayBuffer copy is mandatory: VS Code *transfers* the buffer to the webview and detaches it,
  // so posting a slice of a cached Buffer a second time would throw on the detached backing store.
  pushFrame(bytes: Buffer, deviceWidth: number, deviceHeight: number, frameId: number): void {
    this.panel?.webview.postMessage({
      type: 'frame',
      frameId,
      width: deviceWidth,
      height: deviceHeight,
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }

  setTabTitle(title: string | null, url: string): void {
    if (!this.panel) return;
    this.panel.title = title && title.trim() ? title : shortenUrl(url);
  }

  setIcon(iconPath: vscode.Uri | undefined): void {
    // Assigning undefined clears the tab icon; the cast helper sidesteps exactOptionalPropertyTypes,
    // which rejects `undefined` on the non-optional iconPath setter.
    if (this.panel) asIconPathSettable(this.panel).iconPath = iconPath;
  }

  updateViewport(width: number, height: number): void {
    this.panel?.webview.postMessage({ type: 'viewport', width, height });
  }

  updateUrl(url: string): void {
    this.panel?.webview.postMessage({ type: 'urlChanged', url });
  }

  showElementInfo(info: ElementOverlayInfo): void {
    this.panel?.webview.postMessage({ type: 'elementInfo', info });
  }

  setPickingState(picking: boolean): void {
    this.panel?.webview.postMessage({ type: 'pickingStateChanged', picking });
  }

  setCursor(cursor: string): void {
    this.panel?.webview.postMessage({ type: 'cursor', cursor });
  }

  dispose(): void {
    this.disposing = true;
    this.panel?.dispose();
    this.panel = null;
    this.disposeListeners.forEach(d => d.dispose());
    this.disposeListeners = [];
    this.disposing = false;
  }
}

// VS Code types iconPath as a required property, so assigning `undefined` (to clear it) trips
// exactOptionalPropertyTypes. This narrows the panel to a view where iconPath explicitly accepts
// undefined, keeping the unsafe cast in one named place.
function asIconPathSettable(panel: vscode.WebviewPanel): { iconPath: vscode.Uri | undefined } {
  return panel as unknown as { iconPath: vscode.Uri | undefined };
}

/** Which half of a physical key press the webview forwarded. Modifier keys report `down`/`up`
 *  separately so a held Shift stays held; every other key reports a single `press`. */
export type KeyPhase = 'press' | 'down' | 'up';

type WebviewMessage = InputMessage | { type: 'frameRendered'; frameId: number } | { type: 'ready' };

interface InputMessage {
  type: 'mousedown' | 'mouseup' | 'key' | 'scroll' | 'resize' | 'mousemove' | 'navigate' | 'goBack' | 'goForward' | 'reload' | 'pickElement' | 'paste' | 'copy' | 'cut' | 'openDevTools' | 'tabNew' | 'insertText';
  x: number;
  y: number;
  button: number;
  buttons: number;
  key: string;
  code: string;
  text: string;
  keyCode: number;
  deltaX: number;
  deltaY: number;
  modifiers: number;
  width: number;
  height: number;
  dpr: number;
  url: string;
  clickCount: number;
  phase: KeyPhase;
}

export interface PanelStrings {
  back: string;
  forward: string;
  reload: string;
  pickElement: string;
  devTools: string;
  newTab: string;
  urlPlaceholder: string;
  waiting: string;
}

// The webview script's own escapeHtml is unreachable from the extension host, and these strings land
// in `title="…"` / `placeholder="…"` attributes, so the single quote must be escaped too.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.host}${path}`.slice(0, 40);
  } catch {
    return url.slice(0, 40);
  }
}

function buildHtml(nonce: string, strings: PanelStrings): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--vscode-editor-background, #1e1e1e);
    overflow: hidden;
    width: 100vw;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }

  #toolbar {
    height: 36px;
    min-height: 36px;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 6px;
    background: var(--vscode-titleBar-activeBackground, #3c3c3c);
    border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b);
    user-select: none;
  }

  #toolbar button {
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-icon-foreground, #c5c5c5);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  #toolbar button:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
  }
  #toolbar button svg {
    width: 16px;
    height: 16px;
    stroke: currentColor;
    fill: none;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  #toolbar button.active {
    color: var(--vscode-focusBorder, #007fd4);
    background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
  }

  #url-input {
    flex: 1;
    height: 24px;
    min-width: 0;
    padding: 0 8px;
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: 4px;
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #cccccc);
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 12px;
    outline: none;
  }
  #url-input:focus {
    border-color: var(--vscode-focusBorder, #007fd4);
  }

  #content-area {
    flex: 1;
    position: relative;
    overflow: hidden;
    background: var(--vscode-editor-background, #1e1e1e);
  }

  #screen {
    width: 100%;
    height: 100%;
    display: block;
    cursor: default;
    outline: none;
    -webkit-user-drag: none;
    user-select: none;
  }

  #placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    color: var(--vscode-descriptionForeground, #666);
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 14px;
  }

  #element-overlay {
    position: absolute;
    pointer-events: none;
    z-index: 100;
    background: var(--vscode-editor-background, #1e1e1e);
    border: 1px solid var(--vscode-focusBorder, #007fd4);
    border-radius: 4px;
    padding: 6px 10px;
    font-family: monospace;
    font-size: 11px;
    color: var(--vscode-editor-foreground, #cccccc);
    box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    opacity: 0;
    transition: opacity 0.3s ease;
    max-width: 300px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: none;
  }
  #element-overlay.visible { display: block; opacity: 1; }
  #element-overlay.fading { opacity: 0; }
  #element-overlay .selector {
    color: var(--vscode-focusBorder, #007fd4);
    font-weight: bold;
  }
  #element-overlay .dims {
    color: var(--vscode-descriptionForeground, #888);
    margin-left: 6px;
  }

</style>
</head>
<body>
  <div id="toolbar">
    <button id="btn-back" title="${escapeHtml(strings.back)}">
      <svg viewBox="0 0 16 16"><polyline points="10 2 4 8 10 14"/></svg>
    </button>
    <button id="btn-forward" title="${escapeHtml(strings.forward)}">
      <svg viewBox="0 0 16 16"><polyline points="6 2 12 8 6 14"/></svg>
    </button>
    <button id="btn-reload" title="${escapeHtml(strings.reload)}">
      <svg viewBox="0 0 16 16"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><polyline points="13.5 2 13.5 5.5 10 5.5"/></svg>
    </button>
    <input id="url-input" type="text" placeholder="${escapeHtml(strings.urlPlaceholder)}" spellcheck="false" />
    <button id="btn-pick" title="${escapeHtml(strings.pickElement)}">
      <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><line x1="8" y1="1" x2="8" y2="3"/><line x1="8" y1="13" x2="8" y2="15"/><line x1="1" y1="8" x2="3" y2="8"/><line x1="13" y1="8" x2="15" y2="8"/></svg>
    </button>
    <button id="btn-devtools" title="${escapeHtml(strings.devTools)}">
      <svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="12" rx="1" fill="none"/><line x1="1" y1="5" x2="15" y2="5"/><polyline points="4 8 6 10 4 12"/><line x1="8" y1="12" x2="12" y2="12"/></svg>
    </button>
    <button id="btn-newtab" title="${escapeHtml(strings.newTab)}">
      <svg viewBox="0 0 16 16"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>
    </button>
  </div>
  <div id="content-area">
    <div id="placeholder">${escapeHtml(strings.waiting)}</div>
    <canvas id="screen" style="display:none" tabindex="0"></canvas>
    <div id="element-overlay"></div>
  </div>
  <script nonce="${nonce}">${BROWSER_WEBVIEW_SCRIPT}</script>
</body>
</html>`;
}
