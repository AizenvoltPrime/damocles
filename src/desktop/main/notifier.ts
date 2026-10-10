import { BaseWindow, screen, WebContentsView, type IpcMainEvent, type IpcMainInvokeEvent, type Rectangle, type WebContents } from 'electron';
import {
  MAX_OVERLAY_COORDINATE,
  MAX_OVERLAY_ID_LENGTH,
  MAX_TOAST_PARTS,
  OVERLAY_CHANNELS,
  type OverlayRect,
  type OverlayState,
  type OverlayToast,
  type OverlayToastArea,
} from '../preload/overlay-channels';
import { CHIME_URGENCY, type ChimeTone } from '../preload/notifications';
import type { PanelTheme } from '../preload/panel-channels';
import type { ToastSink } from './notification-center';
import { NOTIFIER_PAGE_URL } from './protocol';
import { loadAppPage, loggableUrl } from './security';
import { isPanelSender } from './views';

// A page that kills its renderer on every load is left dead rather than reloaded in a loop.
const MAX_CRASHES_IN_WINDOW = 3;
const CRASH_WINDOW_MS = 60_000;
const MAX_TOAST_ACTION_LENGTH = 500;
const TRANSPARENT = '#00000000';

// The window type that keeps the popups out of the task switcher and above full-screen apps. None on Linux: Electron 44.4
// aborts on X11 creating a window of any type (bad_variant_access).
const POPUP_WINDOW_TYPES: Readonly<Record<string, string>> = {
  // A non-activating panel that joins every Space over full-screen apps; setVisibleOnAllWorkspaces would hide the Dock icon.
  darwin: 'panel',
  // WS_EX_TOOLWINDOW keeps it out of Alt+Tab and Task View, which skipTaskbar alone does not.
  win32: 'toolbar',
};

export interface NotifierDeps {
  readonly platform: NodeJS.Platform;
  // the overlay preload: the popup page runs the overlay bundle's toast stack, and main answers only its toast channels here
  readonly preloadPath: string;
  readonly state: () => OverlayState;
  // an answer from a popup: an action label, or undefined for a dismissal
  readonly resolveToast: (id: string, action: string | undefined) => void;
  readonly holdToast: (id: string, held: boolean) => void;
  // Escape in the popups, or their last card going while they hold focus
  readonly leave: () => void;
  // the popup window lost focus to another window
  readonly blurred: () => void;
  // what the popups show, replayed when the page (re)loads
  readonly pendingToasts: () => readonly OverlayToast[];
  readonly log: (line: string) => void;
}

function isSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_OVERLAY_COORDINATE;
}

function record(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
}

function field(fields: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(fields, key) ? fields[key] : undefined;
}

function parseRect(raw: unknown): OverlayRect | undefined {
  const fields = record(raw);
  if (!fields) return undefined;
  const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((key) => field(fields, key));
  return isSize(x) && isSize(y) && isSize(width) && isSize(height) ? { x, y, width, height } : undefined;
}

/** The toast stack's measured area and parts from the popup page, or undefined when anything is malformed or out of bounds. */
export function parseToastArea(raw: unknown): OverlayToastArea | undefined {
  const fields = record(raw);
  if (!fields) return undefined;
  const width = field(fields, 'width');
  const height = field(fields, 'height');
  const rawParts = field(fields, 'parts');
  if (!isSize(width) || !isSize(height) || !Array.isArray(rawParts) || rawParts.length > MAX_TOAST_PARTS) return undefined;
  const parts = rawParts.map(parseRect);
  return parts.every((part) => part !== undefined) ? { width, height, parts } : undefined;
}

/** The popup window's bounds: the reported stack at the bottom-right of the work area, within it. */
export function popupBounds(area: OverlayToastArea, workArea: Rectangle): Rectangle {
  const width = Math.min(workArea.width, Math.ceil(area.width));
  const height = Math.min(workArea.height, Math.ceil(area.height));
  return { x: workArea.x + workArea.width - width, y: workArea.y + workArea.height - height, width, height };
}

/** The area's parts in the window's own coordinates: the area's bottom-right corner is the window's, as on the page. */
export function popupShape(area: OverlayToastArea, bounds: Rectangle): Rectangle[] {
  const dx = bounds.width - area.width;
  const dy = bounds.height - area.height;
  return area.parts.map((part) => {
    const x = Math.floor(part.x + dx);
    const y = Math.floor(part.y + dy);
    return { x, y, width: Math.ceil(part.x + dx + part.width) - x, height: Math.ceil(part.y + dy + part.height) - y };
  });
}

/**
 * Desktop popups (D52): a frameless, transparent, always-on-top window at the bottom-right of the primary display that
 * shows every toast, whether or not the main window is focused; the app draws none inside its window. It is the app's own
 * window, so the OS notification settings do not hold it back; Do not disturb and Notify me still do. It shows without
 * taking focus, sizes itself to the stack the page reports, hides when the stack is empty and takes the pointer only over
 * a toast or the pill; only F6 focuses it. Opened by the first popup and closed with the main window (dispose). A
 * BaseWindow holding a WebContentsView, so it is never among BrowserWindow.getAllWindows().
 */
export class NotifierHost implements ToastSink {
  private readonly deps: NotifierDeps;
  // contents is kept apart from the view: reading a destroyed view's webContents throws.
  private popup: { readonly window: BaseWindow; readonly view: WebContentsView; readonly contents: WebContents } | undefined;
  private loaded = false;
  private area: OverlayToastArea = { width: 0, height: 0, parts: [] };
  // as the page last reported it; a fresh page starts with the pointer off its toasts
  private pointerOver = false;
  private crashes: number[] = [];
  // the sound of the popup that opened the window, played once its page has loaded
  private pendingChime: ChimeTone | undefined;
  private readonly onDisplays = (): void => this.place();

  constructor(deps: NotifierDeps) {
    this.deps = deps;
  }

  /** This host once its page can show popups; the first call opens the window, whose page replays what waits. */
  sink(): ToastSink | undefined {
    if (!this.popup) this.open();
    return this.loaded ? this : undefined;
  }

  // Whether a popup is on screen, which makes the popups an F6 stop.
  get showing(): boolean {
    const window = this.popup?.window;
    return window !== undefined && !window.isDestroyed() && window.isVisible();
  }

  // Whether the popup window is the active window and its page holds keyboard focus.
  get focused(): boolean {
    const popup = this.popup;
    if (!popup || popup.window.isDestroyed() || popup.contents.isDestroyed()) return false;
    return popup.window.isFocused() && popup.contents.isFocused();
  }

  owns(contents: WebContents): boolean {
    return this.popup?.contents === contents;
  }

  /** F6's popup stop: a user action, so the window takes focus, and the page focuses the newest card. */
  focusToasts(): void {
    const popup = this.popup;
    if (!popup || !this.showing || popup.contents.isDestroyed()) return;
    popup.window.focus();
    popup.contents.focus();
    this.send(OVERLAY_CHANNELS.toastsFocus, undefined);
  }

  show(toast: OverlayToast): void {
    this.send(OVERLAY_CHANNELS.toast, toast);
  }

  dismiss(id: string): void {
    this.send(OVERLAY_CHANNELS.toastDismiss, id);
  }

  // With no popup window open its popups wait for the main window, and play no sound when they show later.
  chime(tone: ChimeTone): void {
    if (this.loaded) this.send(OVERLAY_CHANNELS.chime, tone);
    else if (this.popup && (this.pendingChime === undefined || CHIME_URGENCY[tone] > CHIME_URGENCY[this.pendingChime])) this.pendingChime = tone;
  }

  // A page that loads later gets the current theme in its HTML.
  sendTheme(theme: PanelTheme): void {
    this.send(OVERLAY_CHANNELS.theme, theme);
  }

  // The UI language changed.
  stateChanged(): void {
    this.send(OVERLAY_CHANNELS.state, this.deps.state());
  }

  /** Closes the window, so it never keeps the app running once the main window is gone; the next popup opens it again. */
  dispose(): void {
    const popup = this.popup;
    if (!popup) return;
    this.forget();
    // A view's page outlives its window unless closed.
    if (!popup.contents.isDestroyed()) popup.contents.close();
    if (!popup.window.isDestroyed()) popup.window.destroy();
  }

  // The window is gone or going: the next popup opens a new one.
  private forget(): void {
    this.popup = undefined;
    this.loaded = false;
    this.area = { width: 0, height: 0, parts: [] };
    this.pointerOver = false;
    this.pendingChime = undefined;
    screen.removeListener('display-metrics-changed', this.onDisplays);
    screen.removeListener('display-added', this.onDisplays);
    screen.removeListener('display-removed', this.onDisplays);
  }

  private open(): void {
    const type = POPUP_WINDOW_TYPES[this.deps.platform];
    const window = new BaseWindow({
      ...(type === undefined ? {} : { type }),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: TRANSPARENT,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'Damocles',
    });
    const view = new WebContentsView({
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        // A popup's sound plays with no click in this window.
        autoplayPolicy: 'no-user-gesture-required',
        // Loading the page must not move keyboard focus out of the app the user is in.
        focusOnNavigation: false,
      },
    });
    view.setBackgroundColor(TRANSPARENT);
    window.contentView.addChildView(view);
    // Above full-screen windows, as the OS's own notifications are.
    window.setAlwaysOnTop(true, 'screen-saver');
    const contents = view.webContents;
    const popup = { window, view, contents };
    this.popup = popup;
    window.on('blur', () => this.deps.blurred());
    // Quitting closes every window, this one included, before main disposes it.
    window.on('closed', () => {
      if (this.popup !== popup) return;
      this.forget();
      if (!contents.isDestroyed()) contents.close();
    });
    this.handle(contents, OVERLAY_CHANNELS.getState, () => this.deps.state());
    this.on(contents, OVERLAY_CHANNELS.resolveToast, (id, action) => {
      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_OVERLAY_ID_LENGTH) return this.deps.log('[notifier] ignoring a malformed toast answer');
      if (!(action === undefined || (typeof action === 'string' && action.length <= MAX_TOAST_ACTION_LENGTH))) return this.deps.log('[notifier] ignoring a malformed toast answer');
      this.deps.resolveToast(id, action);
    });
    this.on(contents, OVERLAY_CHANNELS.toastHold, (id, held) => {
      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_OVERLAY_ID_LENGTH || typeof held !== 'boolean') return this.deps.log('[notifier] ignoring a malformed toast hold');
      this.deps.holdToast(id, held);
    });
    this.on(contents, OVERLAY_CHANNELS.toastArea, (raw) => {
      const area = parseToastArea(raw);
      if (!area) return this.deps.log('[notifier] ignoring a malformed toast area');
      this.area = area;
      this.place();
    });
    this.on(contents, OVERLAY_CHANNELS.toastsPointer, (over) => {
      if (typeof over !== 'boolean') return this.deps.log('[notifier] ignoring a malformed toast pointer report');
      this.pointerOver = over;
      this.takePointer(this.showing);
    });
    this.on(contents, OVERLAY_CHANNELS.toastsLeave, () => this.deps.leave());
    // A reload by any route commits a new document that shows no toast until main replays them once it has loaded.
    contents.on('did-navigate', () => {
      if (this.popup !== popup || !this.loaded) return;
      this.loaded = false;
      this.area = { width: 0, height: 0, parts: [] };
      this.pointerOver = false;
      this.place();
    });
    contents.on('did-finish-load', () => {
      this.loaded = true;
      this.pointerOver = false;
      for (const toast of this.deps.pendingToasts()) this.show(toast);
      if (this.pendingChime) this.send(OVERLAY_CHANNELS.chime, this.pendingChime);
      this.pendingChime = undefined;
    });
    contents.on('render-process-gone', (_event, details) => {
      if (this.popup !== popup) return;
      this.loaded = false;
      this.area = { width: 0, height: 0, parts: [] };
      this.pointerOver = false;
      this.place();
      this.deps.log(`[notifier] renderer gone (${details.reason})`);
      if (details.reason === 'clean-exit') return;
      const now = Date.now();
      this.crashes = [...this.crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
      if (this.crashes.length > MAX_CRASHES_IN_WINDOW) {
        this.deps.log(`[notifier] crashed ${this.crashes.length} times within ${CRASH_WINDOW_MS / 1000} s; not reloading it`);
        return;
      }
      this.load(contents);
    });
    screen.on('display-metrics-changed', this.onDisplays);
    screen.on('display-added', this.onDisplays);
    screen.on('display-removed', this.onDisplays);
    this.load(contents);
  }

  private load(contents: WebContents): void {
    loadAppPage(contents, NOTIFIER_PAGE_URL).catch((err: unknown) => {
      this.deps.log(`[notifier] failed to load: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // Shown without taking focus from whatever the user is doing; hidden while no popup shows.
  private place(): void {
    const popup = this.popup;
    if (!popup || popup.window.isDestroyed()) return;
    const { window, view } = popup;
    if (!(this.area.width > 0 && this.area.height > 0)) {
      if (window.isVisible()) window.hide();
      this.takePointer(false);
      return;
    }
    const bounds = popupBounds(this.area, screen.getPrimaryDisplay().workArea);
    window.setBounds(bounds);
    view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
    // Linux has no pointer forwarding: the window's shape is its toasts and pill, which clips their shadows too.
    if (this.deps.platform === 'linux') window.setShape(popupShape(this.area, bounds));
    this.takePointer(true);
    if (!window.isVisible()) window.showInactive();
  }

  // Windows and macOS: the shown window ignores the pointer, except while the page reports it over a toast or the pill,
  // and forwards its moves to the page so it can tell. Forwarding hooks every mouse move on Windows, so it stops on hide.
  private takePointer(shown: boolean): void {
    const window = this.popup?.window;
    if (!window || window.isDestroyed() || this.deps.platform === 'linux') return;
    if (shown && !this.pointerOver) window.setIgnoreMouseEvents(true, { forward: true });
    else window.setIgnoreMouseEvents(false);
  }

  private send(channel: string, payload: unknown): void {
    const contents = this.popup?.contents;
    if (!this.loaded || !contents || contents.isDestroyed() || contents.isCrashed()) return;
    contents.send(channel, payload);
  }

  // Only the popup page's main frame on its exact URL; webContents.ipc already receives only this window's messages.
  private accepts(event: IpcMainEvent | IpcMainInvokeEvent, contents: WebContents, channel: string): boolean {
    const accepted = isPanelSender(event, contents, NOTIFIER_PAGE_URL);
    if (!accepted) this.deps.log(`[notifier] rejected ${channel} from ${event.senderFrame ? loggableUrl(event.senderFrame.url) : 'a destroyed frame'} (webContents ${event.sender.id})`);
    return accepted;
  }

  // The page of a window that quitting closed can still ask while it loads; it gets its answer, as refusing throws in main.
  private handle(contents: WebContents, channel: string, handler: () => unknown): void {
    contents.ipc.handle(channel, (event) => {
      if (!this.accepts(event, contents, channel)) throw new Error('Rejected');
      return handler();
    });
  }

  // Only the current window's page reports; a closing window's page would leave its state to the next window.
  private on(contents: WebContents, channel: string, handler: (...args: unknown[]) => void): void {
    contents.ipc.on(channel, (event, ...args: unknown[]) => {
      if (this.accepts(event, contents, channel) && this.popup?.contents === contents) handler(...args);
    });
  }
}
