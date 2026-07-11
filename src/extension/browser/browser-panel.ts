import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import type { ElementOverlayInfo } from './types';

export class BrowserPanel {
  private panel: vscode.WebviewPanel | null = null;
  private disposeListeners: vscode.Disposable[] = [];
  private disposing = false;
  private onMouseDownHandler: ((x: number, y: number, button: number, buttons: number, clickCount: number, modifiers: number) => void) | null = null;
  private onMouseUpHandler: ((x: number, y: number, button: number, buttons: number, clickCount: number, modifiers: number) => void) | null = null;
  private onKeyHandler: ((key: string, code: string, text: string, keyCode: number, modifiers: number) => void) | null = null;
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

  get visible(): boolean {
    return this.panel?.visible ?? false;
  }

  onClose(handler: () => void): void { this.onCloseHandler = handler; }
  onMouseDown(handler: (x: number, y: number, button: number, buttons: number, clickCount: number, modifiers: number) => void): void { this.onMouseDownHandler = handler; }
  onMouseUp(handler: (x: number, y: number, button: number, buttons: number, clickCount: number, modifiers: number) => void): void { this.onMouseUpHandler = handler; }
  onKey(handler: (key: string, code: string, text: string, keyCode: number, modifiers: number) => void): void { this.onKeyHandler = handler; }
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

  show(url: string): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active, true);
      this.setTabTitle(null, url);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'damocles-browser-view',
      shortenUrl(url),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.initPanel();
  }

  restore(panel: vscode.WebviewPanel): void {
    if (this.panel) return;
    this.panel = panel;
    this.initPanel();
  }

  private initPanel(): void {
    const nonce = randomBytes(16).toString('base64');
    this.panel!.webview.html = buildHtml(nonce);

    const msgDisposable = this.panel!.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      if (msg.type === 'mousedown') this.onMouseDownHandler?.(msg.x, msg.y, msg.button, msg.buttons, msg.clickCount, msg.modifiers);
      else if (msg.type === 'mouseup') this.onMouseUpHandler?.(msg.x, msg.y, msg.button, msg.buttons, msg.clickCount, msg.modifiers);
      else if (msg.type === 'key') this.onKeyHandler?.(msg.key, msg.code, msg.text, msg.keyCode, msg.modifiers);
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

  pushFrame(base64Data: string, deviceWidth: number, deviceHeight: number): void {
    this.panel?.webview.postMessage({ type: 'frame', data: base64Data, width: deviceWidth, height: deviceHeight });
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

  setConnectionState(connected: boolean): void {
    this.panel?.webview.postMessage({ type: 'connectionState', connected });
  }

  writeClipboard(text: string): void {
    this.panel?.webview.postMessage({ type: 'clipboardWrite', text });
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

interface WebviewMessage {
  type: 'mousedown' | 'mouseup' | 'key' | 'scroll' | 'resize' | 'mousemove' | 'navigate' | 'goBack' | 'goForward' | 'reload' | 'pickElement' | 'paste' | 'copy' | 'cut' | 'openDevTools';
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

function buildHtml(nonce: string): string {
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

  #disconnected-overlay {
    position: absolute;
    inset: 0;
    z-index: 200;
    display: none;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 0 24px;
    background: rgba(30, 30, 30, 0.82);
    background: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 82%, transparent);
    color: var(--vscode-descriptionForeground, #cccccc);
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 14px;
    line-height: 1.5;
  }
  #disconnected-overlay.visible { display: flex; }

  #toolbar button.dimmed {
    opacity: 0.35;
    pointer-events: none;
  }
</style>
</head>
<body>
  <div id="toolbar">
    <button id="btn-back" title="Back">
      <svg viewBox="0 0 16 16"><polyline points="10 2 4 8 10 14"/></svg>
    </button>
    <button id="btn-forward" title="Forward">
      <svg viewBox="0 0 16 16"><polyline points="6 2 12 8 6 14"/></svg>
    </button>
    <button id="btn-reload" title="Reload">
      <svg viewBox="0 0 16 16"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><polyline points="13.5 2 13.5 5.5 10 5.5"/></svg>
    </button>
    <input id="url-input" type="text" placeholder="Enter URL..." spellcheck="false" />
    <button id="btn-pick" title="Pick Element">
      <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><line x1="8" y1="1" x2="8" y2="3"/><line x1="8" y1="13" x2="8" y2="15"/><line x1="1" y1="8" x2="3" y2="8"/><line x1="13" y1="8" x2="15" y2="8"/></svg>
    </button>
    <button id="btn-devtools" title="Open Developer Tools (F12)">
      <svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="12" rx="1" fill="none"/><line x1="1" y1="5" x2="15" y2="5"/><polyline points="4 8 6 10 4 12"/><line x1="8" y1="12" x2="12" y2="12"/></svg>
    </button>
  </div>
  <div id="content-area">
    <div id="placeholder">Waiting for browser frames...</div>
    <canvas id="screen" style="display:none" tabindex="0"></canvas>
    <div id="element-overlay"></div>
    <div id="disconnected-overlay">Browser disconnected. Press reload or Enter in the URL bar to restart.</div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('screen');
    const placeholder = document.getElementById('placeholder');
    const urlInput = document.getElementById('url-input');
    const btnBack = document.getElementById('btn-back');
    const btnForward = document.getElementById('btn-forward');
    const btnReload = document.getElementById('btn-reload');
    const btnPick = document.getElementById('btn-pick');
    const btnDevTools = document.getElementById('btn-devtools');
    const contentArea = document.getElementById('content-area');
    const overlay = document.getElementById('element-overlay');
    const disconnectedOverlay = document.getElementById('disconnected-overlay');
    const ctx = canvas.getContext('2d');
    let viewportW = 1920;
    let viewportH = 1080;
    let overlayTimer = null;
    let isPicking = false;
    let mouseIsDown = false;

    // rAF-coalesced hover: store the freshest pointer position and post at most one
    // mousemove message per frame. moveRafScheduled guards a single in-flight rAF.
    let latestMove = null;
    let moveRafScheduled = false;
    function scheduleMove(x, y, buttons) {
      latestMove = { x, y, buttons };
      if (moveRafScheduled) return;
      moveRafScheduled = true;
      requestAnimationFrame(() => {
        moveRafScheduled = false;
        const m = latestMove;
        vscode.postMessage({ type: 'mousemove', x: m.x, y: m.y, buttons: m.buttons });
      });
    }

    // Frame pipeline: pendingFrame holds only the latest frame (latest-wins coalescing).
    // lastBitmap holds the most recently decoded bitmap so we can redraw on resize.
    let pendingFrame = null;
    let lastBitmap = null;
    let pumping = false;

    const savedState = vscode.getState();
    if (savedState && savedState.url) {
      urlInput.value = savedState.url;
    }

    // Contain-fit letterbox rect of viewportW/H inside the canvas client area, in CSS px.
    // Single source of truth for the draw call, screenCoords, and showElementOverlay.
    function computeDrawRect() {
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      const scale = Math.min(cw / viewportW, ch / viewportH);
      const width = viewportW * scale;
      const height = viewportH * scale;
      return { x: (cw - width) / 2, y: (ch - height) / 2, width, height };
    }

    function screenCoords(e) {
      const canvasRect = canvas.getBoundingClientRect();
      const rect = computeDrawRect();
      const relX = (e.clientX - canvasRect.left - rect.x) / rect.width;
      const relY = (e.clientY - canvasRect.top - rect.y) / rect.height;
      // Clamp to the last addressable pixel: viewportW/H are counts, so the max valid coordinate is
      // width-1 / height-1. Clamping to the count itself lands one pixel outside the page.
      const x = Math.round(Math.min(Math.max(relX * viewportW, 0), viewportW - 1));
      const y = Math.round(Math.min(Math.max(relY * viewportH, 0), viewportH - 1));
      return { x, y };
    }

    // Draw lastBitmap into the letterbox rect on the dpr-scaled backing store.
    function redraw() {
      if (!lastBitmap) return;
      const dpr = window.devicePixelRatio;
      const bw = Math.round(canvas.clientWidth * dpr);
      const bh = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      const rect = computeDrawRect();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(lastBitmap, rect.x * dpr, rect.y * dpr, rect.width * dpr, rect.height * dpr);
    }

    async function pump() {
      if (pumping) return;
      pumping = true;
      try {
        while (pendingFrame) {
          const frame = pendingFrame;
          pendingFrame = null;
          const binary = atob(frame.data);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const blob = new Blob([bytes], { type: 'image/jpeg' });
          const bitmap = await createImageBitmap(blob);
          if (pendingFrame) {
            // A newer frame arrived while decoding; discard this one and loop.
            bitmap.close();
            continue;
          }
          await new Promise(resolve => requestAnimationFrame(resolve));
          viewportW = frame.width;
          viewportH = frame.height;
          if (lastBitmap) lastBitmap.close();
          lastBitmap = bitmap;
          redraw();
          if (canvas.style.display === 'none') {
            canvas.style.display = 'block';
            placeholder.style.display = 'none';
          }
        }
      } catch (err) {
        console.error('frame decode/draw failed', err);
      } finally {
        pumping = false;
      }
    }

    btnBack.addEventListener('click', () => vscode.postMessage({ type: 'goBack' }));
    btnForward.addEventListener('click', () => vscode.postMessage({ type: 'goForward' }));
    btnReload.addEventListener('click', () => vscode.postMessage({ type: 'reload' }));
    btnPick.addEventListener('click', () => vscode.postMessage({ type: 'pickElement' }));
    btnDevTools.addEventListener('click', () => vscode.postMessage({ type: 'openDevTools' }));

    urlInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        let url = urlInput.value.trim();
        if (!url) return;
        if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) url = 'https://' + url;
        vscode.postMessage({ type: 'navigate', url });
        vscode.setState({ url });
        canvas.focus();
      }
    });

    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d.type === 'frame') {
        pendingFrame = { data: d.data, width: d.width, height: d.height };
        pump();
      } else if (d.type === 'viewport') {
        viewportW = d.width;
        viewportH = d.height;
      } else if (d.type === 'urlChanged') {
        urlInput.value = d.url;
        vscode.setState({ url: d.url });
      } else if (d.type === 'pickingStateChanged') {
        isPicking = d.picking;
        btnPick.classList.toggle('active', d.picking);
        canvas.style.cursor = d.picking ? 'crosshair' : 'default';
      } else if (d.type === 'cursor') {
        if (!isPicking) canvas.style.cursor = d.cursor;
      } else if (d.type === 'elementInfo') {
        showElementOverlay(d.info);
      } else if (d.type === 'clipboardWrite') {
        navigator.clipboard.writeText(d.text).catch(() => {});
      } else if (d.type === 'connectionState') {
        if (d.connected === false) {
          disconnectedOverlay.classList.add('visible');
          btnBack.classList.add('dimmed');
          btnBack.disabled = true;
          btnForward.classList.add('dimmed');
          btnForward.disabled = true;
        } else if (d.connected === true) {
          disconnectedOverlay.classList.remove('visible');
          btnBack.classList.remove('dimmed');
          btnBack.disabled = false;
          btnForward.classList.remove('dimmed');
          btnForward.disabled = false;
        }
      }
    });

    function showElementOverlay(info) {
      if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null; }
      const canvasRect = canvas.getBoundingClientRect();
      const rect = computeDrawRect();
      const scaleX = rect.width / viewportW;
      const scaleY = rect.height / viewportH;
      const box = info.boundingBox;
      const elCenterX = canvasRect.left + rect.x + (box.x + box.width / 2) * scaleX;
      const elBottomY = canvasRect.top + rect.y + (box.y + box.height) * scaleY;
      const elTopY = canvasRect.top + rect.y + box.y * scaleY;

      const w = Math.round(box.width);
      const h = Math.round(box.height);
      overlay.innerHTML =
        '<span class="selector">' + escapeHtml(info.selector) + '</span>' +
        '<span class="dims">' + w + ' \\u00d7 ' + h + '</span>';

      overlay.classList.remove('visible', 'fading');
      overlay.style.display = 'block';
      overlay.style.left = Math.max(0, Math.min(elCenterX - overlay.offsetWidth / 2, canvasRect.right - overlay.offsetWidth)) + 'px';

      const spaceBelow = window.innerHeight - elBottomY;
      if (spaceBelow > 40) {
        overlay.style.top = (elBottomY + 6) + 'px';
      } else {
        overlay.style.top = (elTopY - overlay.offsetHeight - 6) + 'px';
      }

      requestAnimationFrame(() => overlay.classList.add('visible'));
      overlayTimer = setTimeout(() => {
        overlay.classList.add('fading');
        setTimeout(() => {
          overlay.classList.remove('visible', 'fading');
          overlay.style.display = 'none';
        }, 300);
      }, 3000);
    }

    function escapeHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    canvas.addEventListener('mousedown', (e) => {
      e.preventDefault();
      mouseIsDown = true;
      const { x, y } = screenCoords(e);
      const modifiers = (e.altKey?1:0) | (e.ctrlKey?2:0) | (e.metaKey?4:0) | (e.shiftKey?8:0);
      vscode.postMessage({ type: 'mousedown', x, y, button: e.button, buttons: e.buttons, clickCount: e.detail, modifiers });
      canvas.focus();
    });

    // Suppress the webview's native editor context menu over the canvas. The right click is forwarded
    // to the page via CDP, which renders the page's own context menu inside the screencast; without this
    // the host menu (Cut/Copy/Paste) would stack on top of it. Scoped to the canvas so the URL bar keeps
    // its native menu.
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('mouseup', (e) => {
      if (!mouseIsDown) return;
      mouseIsDown = false;
      const { x, y } = screenCoords(e);
      const modifiers = (e.altKey?1:0) | (e.ctrlKey?2:0) | (e.metaKey?4:0) | (e.shiftKey?8:0);
      vscode.postMessage({ type: 'mouseup', x, y, button: e.button, buttons: e.buttons, clickCount: e.detail, modifiers });
    });

    canvas.addEventListener('mousemove', (e) => {
      const { x, y } = screenCoords(e);
      scheduleMove(x, y, e.buttons);
    });

    document.addEventListener('mousemove', (e) => {
      if (!mouseIsDown || e.target === canvas) return;
      const { x, y } = screenCoords(e);
      scheduleMove(x, y, e.buttons);
    });

    canvas.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        e.preventDefault();
        vscode.postMessage({ type: 'copy' });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
        e.preventDefault();
        vscode.postMessage({ type: 'cut' });
        return;
      }
      e.preventDefault();
      const text = (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) ? e.key : '';
      const modifiers = (e.altKey?1:0) | (e.ctrlKey?2:0) | (e.metaKey?4:0) | (e.shiftKey?8:0);
      vscode.postMessage({ type: 'key', key: e.key, code: e.code, text, keyCode: e.keyCode, modifiers });
    });

    document.addEventListener('copy', (e) => {
      if (document.activeElement === urlInput) return;
      e.preventDefault();
      vscode.postMessage({ type: 'copy' });
    });

    document.addEventListener('cut', (e) => {
      if (document.activeElement === urlInput) return;
      e.preventDefault();
      vscode.postMessage({ type: 'cut' });
    });

    document.addEventListener('paste', (e) => {
      if (document.activeElement === urlInput) return;
      e.preventDefault();
      const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
      if (text) vscode.postMessage({ type: 'paste', text });
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { x, y } = screenCoords(e);
      const scale = e.deltaMode === 1 ? 16 : 1;
      vscode.postMessage({ type: 'scroll', x, y, deltaX: e.deltaX * scale, deltaY: e.deltaY * scale });
    }, { passive: false });

    let resizeTimer;
    let contentW = 0;
    let contentH = 0;

    function postResize(width, height) {
      vscode.postMessage({ type: 'resize', width: Math.round(width), height: Math.round(height), dpr: window.devicePixelRatio });
    }

    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          contentW = width;
          contentH = height;
          // Redraw immediately so the panel never blanks while resizing.
          redraw();
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            postResize(width, height);
          }, 150);
        }
      }
    });
    ro.observe(contentArea);

    // Re-arming resolution listener: monitor moves or zoom changes shift devicePixelRatio,
    // which ResizeObserver does not observe. Re-post a resize and re-arm on the new dpr.
    let dprMediaQuery = null;
    function armDprListener() {
      dprMediaQuery = window.matchMedia('(resolution: ' + window.devicePixelRatio + 'dppx)');
      dprMediaQuery.addEventListener('change', onDprChange, { once: true });
    }
    function onDprChange() {
      if (contentW > 0 && contentH > 0) postResize(contentW, contentH);
      redraw();
      armDprListener();
    }
    armDprListener();
  </script>
</body>
</html>`;
}
