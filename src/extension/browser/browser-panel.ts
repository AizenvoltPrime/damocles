import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import type { ElementOverlayInfo } from './types';

export class BrowserPanel {
  private panel: vscode.WebviewPanel | null = null;
  private disposeListeners: vscode.Disposable[] = [];
  private disposing = false;
  private onMouseDownHandler: ((x: number, y: number, button: number, buttons: number, clickCount: number) => void) | null = null;
  private onMouseUpHandler: ((x: number, y: number, button: number, buttons: number, clickCount: number) => void) | null = null;
  private onKeyHandler: ((key: string, code: string, text: string, keyCode: number) => void) | null = null;
  private onCloseHandler: (() => void) | null = null;
  private onScrollHandler: ((deltaX: number, deltaY: number) => void) | null = null;
  private onResizeHandler: ((width: number, height: number) => void) | null = null;
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

  get visible(): boolean {
    return this.panel?.visible ?? false;
  }

  onClose(handler: () => void): void { this.onCloseHandler = handler; }
  onMouseDown(handler: (x: number, y: number, button: number, buttons: number, clickCount: number) => void): void { this.onMouseDownHandler = handler; }
  onMouseUp(handler: (x: number, y: number, button: number, buttons: number, clickCount: number) => void): void { this.onMouseUpHandler = handler; }
  onKey(handler: (key: string, code: string, text: string, keyCode: number) => void): void { this.onKeyHandler = handler; }
  onScroll(handler: (deltaX: number, deltaY: number) => void): void { this.onScrollHandler = handler; }
  onResize(handler: (width: number, height: number) => void): void { this.onResizeHandler = handler; }
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

  show(url: string): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active, true);
      this.updateTitle(url);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'damocles-browser-view',
      `Browser: ${shortenUrl(url)}`,
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
      if (msg.type === 'mousedown') this.onMouseDownHandler?.(msg.x, msg.y, msg.button, msg.buttons, msg.clickCount);
      else if (msg.type === 'mouseup') this.onMouseUpHandler?.(msg.x, msg.y, msg.button, msg.buttons, msg.clickCount);
      else if (msg.type === 'key') this.onKeyHandler?.(msg.key, msg.code, msg.text, msg.keyCode);
      else if (msg.type === 'scroll') this.onScrollHandler?.(msg.deltaX, msg.deltaY);
      else if (msg.type === 'resize') this.onResizeHandler?.(msg.width, msg.height);
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

    this.panel!.onDidDispose(() => {
      this.panel = null;
      this.disposeListeners.forEach(d => d.dispose());
      this.disposeListeners = [];
      if (!this.disposing) this.onCloseHandler?.();
    });
  }

  pushFrame(base64Data: string): void {
    this.panel?.webview.postMessage({ type: 'frame', data: base64Data });
  }

  updateTitle(url: string): void {
    if (this.panel) this.panel.title = `Browser: ${shortenUrl(url)}`;
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
  width: number;
  height: number;
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;">
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
    object-fit: contain;
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
    <img id="screen" style="display:none" tabindex="0" />
    <div id="element-overlay"></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const screen = document.getElementById('screen');
    const placeholder = document.getElementById('placeholder');
    const urlInput = document.getElementById('url-input');
    const btnBack = document.getElementById('btn-back');
    const btnForward = document.getElementById('btn-forward');
    const btnReload = document.getElementById('btn-reload');
    const btnPick = document.getElementById('btn-pick');
    const btnDevTools = document.getElementById('btn-devtools');
    const contentArea = document.getElementById('content-area');
    const overlay = document.getElementById('element-overlay');
    let viewportW = 1920;
    let viewportH = 1080;
    let overlayTimer = null;
    let isPicking = false;
    let mouseMoveTimer = null;
    let mouseIsDown = false;

    const savedState = vscode.getState();
    if (savedState && savedState.url) {
      urlInput.value = savedState.url;
    }

    function screenCoords(e) {
      const rect = screen.getBoundingClientRect();
      const scaleX = viewportW / rect.width;
      const scaleY = viewportH / rect.height;
      return {
        x: Math.round((e.clientX - rect.left) * scaleX),
        y: Math.round((e.clientY - rect.top) * scaleY)
      };
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
        screen.focus();
      }
    });

    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d.type === 'frame') {
        screen.src = 'data:image/jpeg;base64,' + d.data;
        screen.style.display = 'block';
        placeholder.style.display = 'none';
      } else if (d.type === 'viewport') {
        viewportW = d.width;
        viewportH = d.height;
      } else if (d.type === 'urlChanged') {
        urlInput.value = d.url;
        vscode.setState({ url: d.url });
      } else if (d.type === 'pickingStateChanged') {
        isPicking = d.picking;
        btnPick.classList.toggle('active', d.picking);
        screen.style.cursor = d.picking ? 'crosshair' : 'default';
      } else if (d.type === 'cursor') {
        if (!isPicking) screen.style.cursor = d.cursor;
      } else if (d.type === 'elementInfo') {
        showElementOverlay(d.info);
      } else if (d.type === 'clipboardWrite') {
        navigator.clipboard.writeText(d.text).catch(() => {});
      }
    });

    function showElementOverlay(info) {
      if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null; }
      const rect = screen.getBoundingClientRect();
      const scaleX = rect.width / viewportW;
      const scaleY = rect.height / viewportH;
      const box = info.boundingBox;
      const elCenterX = rect.left + (box.x + box.width / 2) * scaleX;
      const elBottomY = rect.top + (box.y + box.height) * scaleY;
      const elTopY = rect.top + box.y * scaleY;

      const w = Math.round(box.width);
      const h = Math.round(box.height);
      overlay.innerHTML =
        '<span class="selector">' + escapeHtml(info.selector) + '</span>' +
        '<span class="dims">' + w + ' \\u00d7 ' + h + '</span>';

      overlay.classList.remove('visible', 'fading');
      overlay.style.display = 'block';
      overlay.style.left = Math.max(0, Math.min(elCenterX - overlay.offsetWidth / 2, rect.right - overlay.offsetWidth)) + 'px';

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

    screen.addEventListener('mousedown', (e) => {
      e.preventDefault();
      mouseIsDown = true;
      const { x, y } = screenCoords(e);
      vscode.postMessage({ type: 'mousedown', x, y, button: e.button, buttons: e.buttons, clickCount: e.detail });
      screen.focus();
    });

    document.addEventListener('mouseup', (e) => {
      if (!mouseIsDown) return;
      mouseIsDown = false;
      const { x, y } = screenCoords(e);
      vscode.postMessage({ type: 'mouseup', x, y, button: e.button, buttons: e.buttons, clickCount: e.detail });
    });

    screen.addEventListener('mousemove', (e) => {
      if (mouseMoveTimer) return;
      const throttleMs = mouseIsDown ? 16 : 100;
      mouseMoveTimer = setTimeout(() => { mouseMoveTimer = null; }, throttleMs);
      const { x, y } = screenCoords(e);
      vscode.postMessage({ type: 'mousemove', x, y, buttons: e.buttons });
    });

    document.addEventListener('mousemove', (e) => {
      if (!mouseIsDown || e.target === screen) return;
      if (mouseMoveTimer) return;
      mouseMoveTimer = setTimeout(() => { mouseMoveTimer = null; }, 16);
      const { x, y } = screenCoords(e);
      vscode.postMessage({ type: 'mousemove', x, y, buttons: e.buttons });
    });

    screen.addEventListener('keydown', (e) => {
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
      vscode.postMessage({ type: 'key', key: e.key, code: e.code, text, keyCode: e.keyCode });
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

    screen.addEventListener('wheel', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'scroll', deltaX: e.deltaX, deltaY: e.deltaY });
    }, { passive: false });

    let resizeTimer;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            vscode.postMessage({ type: 'resize', width: Math.round(width), height: Math.round(height) });
          }, 150);
        }
      }
    });
    ro.observe(contentArea);
  </script>
</body>
</html>`;
}
