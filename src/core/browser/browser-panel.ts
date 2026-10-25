import { randomBytes } from 'crypto';
import type { Disposable } from '../../platform/disposable';
import type { PanelHost, WindowService } from '../../platform/window-service';
import { browserPageHtml, type BrowserPageStrings } from '../../shared/browser-page-html';
import { isNotSecurePage } from '../../shared/typed-address';
import { t } from '../l10n';
import type { ElementOverlayInfo } from './types';

export class BrowserPanel {
  private readonly window: WindowService;
  private panel: PanelHost | null = null;
  private disposeListeners: Disposable[] = [];
  private disposing = false;
  // The webview posted `ready` and has not been discarded since, so a post to it lands.
  private listeningPage = false;
  private onMouseDownHandler: ((x: number, y: number, button: number, buttons: number, clickCount: number, modifiers: number) => void) | null = null;
  private onMouseUpHandler: ((x: number, y: number, button: number, buttons: number, clickCount: number, modifiers: number) => void) | null = null;
  private onKeyHandler: ((key: string, code: string, text: string, keyCode: number, modifiers: number, phase: KeyPhase) => void) | null = null;
  private onInsertTextHandler: ((text: string) => void) | null = null;
  private onReadyHandler: (() => void) | null = null;
  private onCloseHandler: (() => void) | null = null;
  private onScrollHandler: ((x: number, y: number, deltaX: number, deltaY: number) => void) | null = null;
  private onResizeHandler: ((width: number, height: number, dpr: number) => void) | null = null;
  private onNavigateHandler: ((typed: string) => void) | null = null;
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

  constructor(window: WindowService) {
    this.window = window;
  }

  get visible(): boolean {
    return this.panel?.visible ?? false;
  }

  get viewColumn(): number | undefined {
    return this.panel?.column;
  }

  /** Whether the webview's message listener is attached. A host that discards a hidden page clears it on hide; the
   *  reloaded page's `ready` sets it again. A host that keeps the page keeps it set, and no `ready` follows a show. */
  get listening(): boolean {
    return this.listeningPage;
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
  // The address bar's text as the user typed it; the host reads it as a URL.
  onNavigate(handler: (typed: string) => void): void { this.onNavigateHandler = handler; }
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

  show(url: string, column?: number, owner?: PanelHost): void {
    if (this.panel) {
      this.panel.reveal(column);
      this.setTabTitle(null, url);
      return;
    }

    this.panel = this.window.createPanel({
      kind: 'browser',
      title: shortenUrl(url),
      localResourceRoots: [],
      ...(column !== undefined ? { column } : {}),
      ...(owner !== undefined ? { owner } : {}),
    });
    this.initPanel();
  }

  reveal(): void {
    this.panel?.reveal();
  }

  private showPage(panel: PanelHost): void {
    const toolbar = !this.window.chatBrowserPane;
    if (panel.showPage) {
      panel.showPage({ kind: 'browser', toolbar });
      return;
    }
    // Built here rather than at module load so the strings are resolved per panel construction, at a
    // point where the l10n bundle for the active display language is guaranteed loaded.
    const strings: BrowserPageStrings = {
      back: t('Back'),
      forward: t('Forward'),
      reload: t('Reload'),
      pickElement: t('Pick Element'),
      devTools: t('Open Developer Tools (F12)'),
      newTab: t('New Tab'),
      urlPlaceholder: t('Enter URL...'),
      notSecure: t('Not secure'),
      notSecureDetail: t('The connection to this site is not encrypted, so others on the network can read and change what it sends.'),
      waiting: t('Waiting for browser frames...'),
    };
    panel.setHtml(browserPageHtml({ nonce: randomBytes(16).toString('base64'), strings, toolbar, themeCss: panel.themeCssSource() }));
  }

  private initPanel(): void {
    this.showPage(this.panel!);

    const msgDisposable = this.panel!.onMessage((message) => {
      const msg = message as WebviewMessage;
      if (msg.type === 'mousedown') this.onMouseDownHandler?.(msg.x, msg.y, msg.button, msg.buttons, msg.clickCount, msg.modifiers);
      else if (msg.type === 'mouseup') this.onMouseUpHandler?.(msg.x, msg.y, msg.button, msg.buttons, msg.clickCount, msg.modifiers);
      else if (msg.type === 'key') this.onKeyHandler?.(msg.key, msg.code, msg.text, msg.keyCode, msg.modifiers, msg.phase);
      else if (msg.type === 'insertText') this.onInsertTextHandler?.(msg.text);
      else if (msg.type === 'ready') {
        this.listeningPage = true;
        this.onReadyHandler?.();
      }
      else if (msg.type === 'scroll') this.onScrollHandler?.(msg.x, msg.y, msg.deltaX, msg.deltaY);
      else if (msg.type === 'resize') this.onResizeHandler?.(msg.width, msg.height, msg.dpr);
      else if (msg.type === 'mousemove') this.onMouseMoveHandler?.(msg.x, msg.y, msg.buttons);
      else if (msg.type === 'navigate' && typeof msg.url === 'string') this.onNavigateHandler?.(msg.url);
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

    const panel = this.panel!;
    const visDisposable = panel.onDidChangeViewState(() => {
      if (!panel.visible && !panel.retainsContextWhenHidden) this.listeningPage = false;
      this.onVisibilityChangeHandler?.(panel.visible);
    });
    this.disposeListeners.push(visDisposable);

    const disposeDisposable = this.panel!.onDispose(() => {
      this.panel = null;
      this.listeningPage = false;
      this.disposeListeners.forEach(d => d.dispose());
      this.disposeListeners = [];
      if (!this.disposing) this.onCloseHandler?.();
    });
    this.disposeListeners.push(disposeDisposable);
  }

  // The ArrayBuffer copy is mandatory: VS Code *transfers* the buffer to the webview and detaches it,
  // so posting a slice of a cached Buffer a second time would throw on the detached backing store.
  pushFrame(bytes: Buffer, deviceWidth: number, deviceHeight: number, frameId: number): void {
    this.panel?.postMessage({
      type: 'frame',
      frameId,
      width: deviceWidth,
      height: deviceHeight,
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }

  setTabTitle(title: string | null, url: string): void {
    if (!this.panel) return;
    this.panel.setTitle(title && title.trim() ? title : shortenUrl(url));
  }

  setIcon(iconPath: string | undefined): void {
    this.panel?.setIcon(iconPath);
  }

  updateViewport(width: number, height: number): void {
    this.panel?.postMessage({ type: 'viewport', width, height });
  }

  updateUrl(url: string): void {
    this.panel?.postMessage({ type: 'urlChanged', url, notSecure: isNotSecurePage(url) });
  }

  // For a host that draws a page's navigation chrome itself (chatBrowserPane); the page script ignores it.
  updateNavigationState(state: NavigationState): void {
    this.panel?.postMessage({ type: 'navigationState', ...state });
  }

  showElementInfo(info: ElementOverlayInfo): void {
    this.panel?.postMessage({ type: 'elementInfo', info });
  }

  setPickingState(picking: boolean): void {
    this.panel?.postMessage({ type: 'pickingStateChanged', picking });
  }

  setCursor(cursor: string): void {
    this.panel?.postMessage({ type: 'cursor', cursor });
  }

  dispose(): void {
    this.disposing = true;
    this.panel?.close();
    this.panel = null;
    this.listeningPage = false;
    this.disposeListeners.forEach(d => d.dispose());
    this.disposeListeners = [];
    this.disposing = false;
  }
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

export interface NavigationState {
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.host === '') return url.slice(0, 40);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.host}${path}`.slice(0, 40);
  } catch {
    return url.slice(0, 40);
  }
}
