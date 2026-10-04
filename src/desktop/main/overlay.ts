import { randomBytes, randomUUID } from 'node:crypto';
import { WebContentsView, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type Rectangle, type WebContents } from 'electron';
import { HOST_THEME_STYLE_ID } from '../../shared/host-theme';
import {
  MAX_OVERLAY_COORDINATE,
  MAX_OVERLAY_ID_LENGTH,
  MAX_OVERLAY_ITEMS,
  MAX_OVERLAY_LABEL_LENGTH,
  MAX_OVERLAY_TAGS,
  MAX_OVERLAY_TEXT_LENGTH,
  OVERLAY_ACK_TIMEOUT_MS,
  OVERLAY_CHANNELS,
  OVERLAY_ICONS,
  type OverlayAnswer,
  type OverlayIcon,
  type OverlayMenuItem,
  type OverlayRect,
  type OverlayRequest,
  type OverlayState,
  type OverlayToast,
  type OverlayToastArea,
} from '../preload/overlay-channels';
import type { PanelTheme } from '../preload/panel-channels';
import { MAX_TAG_LENGTH } from '../preload/shell-channels';
import type { ToastSink } from './platform/notification-service';
import { APP_ORIGIN, OVERLAY_PAGE_URL } from './protocol';
import { loadAppPage, loggableUrl } from './security';
import { isPanelSender } from './views';

export type OverlayMode = 'hidden' | 'toasts' | 'full';

export interface OverlayHostDeps {
  readonly window: BrowserWindow;
  readonly preloadPath: string;
  readonly state: () => OverlayState;
  // the overlay's answer to a toast: an action label of that toast, or undefined for a dismissal
  readonly resolveToast: (id: string, action: string | undefined) => void;
  // toasts still waiting for an answer, replayed when the overlay page (re)loads
  readonly pendingToasts: () => readonly OverlayToast[];
  // moves keyboard focus out of the overlay when no popup names where it returns
  readonly focusOutside: () => void;
  readonly log: (line: string) => void;
}

// An overlay page that kills its renderer on every load is left dead rather than reloaded in a loop.
const MAX_CRASHES_IN_WINDOW = 3;
const CRASH_WINDOW_MS = 60_000;
const TRANSPARENT = '#00000000';
const MAX_TOAST_ACTION_LENGTH = 500;

const ICONS: ReadonlySet<string> = new Set(OVERLAY_ICONS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function isNonEmptyText(value: unknown, max: number): value is string {
  return isText(value, max) && value.length > 0;
}

function isCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_OVERLAY_COORDINATE;
}

function parseRect(raw: unknown): OverlayRect | undefined {
  if (!isRecord(raw)) return undefined;
  const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((key) => field(raw, key));
  if (!isCoordinate(x) || !isCoordinate(y) || !isCoordinate(width) || !isCoordinate(height)) return undefined;
  return { x, y, width, height };
}

function optionalFlag(raw: Record<string, unknown>, key: string): { ok: boolean; value?: boolean } {
  const value = field(raw, key);
  if (value === undefined) return { ok: true };
  return typeof value === 'boolean' ? { ok: true, value } : { ok: false };
}

function parseMenuItem(raw: unknown): OverlayMenuItem | undefined {
  if (!isRecord(raw)) return undefined;
  const kind = field(raw, 'kind');
  if (kind === 'separator') return { kind: 'separator' };
  if (kind !== 'item') return undefined;
  const id = field(raw, 'id');
  const label = field(raw, 'label');
  const icon = field(raw, 'icon');
  const shortcut = field(raw, 'shortcut');
  if (!isNonEmptyText(id, MAX_OVERLAY_ID_LENGTH) || !isNonEmptyText(label, MAX_OVERLAY_LABEL_LENGTH)) return undefined;
  if (icon !== undefined && !(typeof icon === 'string' && ICONS.has(icon))) return undefined;
  if (shortcut !== undefined && !isText(shortcut, MAX_OVERLAY_LABEL_LENGTH)) return undefined;
  const danger = optionalFlag(raw, 'danger');
  const disabled = optionalFlag(raw, 'disabled');
  const checked = optionalFlag(raw, 'checked');
  if (!danger.ok || !disabled.ok || !checked.ok) return undefined;
  return {
    kind: 'item',
    id,
    label,
    ...(icon !== undefined ? { icon: icon as OverlayIcon } : {}),
    ...(shortcut !== undefined ? { shortcut } : {}),
    ...(danger.value !== undefined ? { danger: danger.value } : {}),
    ...(disabled.value !== undefined ? { disabled: disabled.value } : {}),
    ...(checked.value !== undefined ? { checked: checked.value } : {}),
  };
}

function parseMenu(raw: Record<string, unknown>): OverlayRequest | undefined {
  const label = field(raw, 'label');
  const anchor = parseRect(field(raw, 'anchor'));
  const rawItems = field(raw, 'items');
  const filterPlaceholder = field(raw, 'filterPlaceholder');
  if (!isNonEmptyText(label, MAX_OVERLAY_LABEL_LENGTH)) return undefined;
  if (!anchor || !Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > MAX_OVERLAY_ITEMS) return undefined;
  if (filterPlaceholder !== undefined && !isText(filterPlaceholder, MAX_OVERLAY_LABEL_LENGTH)) return undefined;
  const items: OverlayMenuItem[] = [];
  const ids = new Set<string>();
  for (const rawItem of rawItems as unknown[]) {
    const item = parseMenuItem(rawItem);
    if (!item) return undefined;
    if (item.kind === 'item') {
      if (ids.has(item.id)) return undefined;
      ids.add(item.id);
    }
    items.push(item);
  }
  return { kind: 'menu', label, anchor, items, ...(filterPlaceholder !== undefined ? { filterPlaceholder } : {}) };
}

function parseConfirm(raw: Record<string, unknown>): OverlayRequest | undefined {
  const title = field(raw, 'title');
  const message = field(raw, 'message');
  const warning = field(raw, 'warning');
  const detail = field(raw, 'detail');
  const confirmLabel = field(raw, 'confirmLabel');
  const cancelLabel = field(raw, 'cancelLabel');
  const danger = field(raw, 'danger');
  if (!isNonEmptyText(title, MAX_OVERLAY_LABEL_LENGTH) || !isText(message, MAX_OVERLAY_TEXT_LENGTH)) return undefined;
  if (!isNonEmptyText(confirmLabel, MAX_OVERLAY_LABEL_LENGTH) || !isNonEmptyText(cancelLabel, MAX_OVERLAY_LABEL_LENGTH)) return undefined;
  if (typeof danger !== 'boolean') return undefined;
  let parsedWarning: { text: string; running: boolean } | undefined;
  if (warning !== undefined) {
    if (!isRecord(warning)) return undefined;
    const text = field(warning, 'text');
    const running = field(warning, 'running');
    if (!isNonEmptyText(text, MAX_OVERLAY_TEXT_LENGTH) || typeof running !== 'boolean') return undefined;
    parsedWarning = { text, running };
  }
  let parsedDetail: { label: string; text: string } | undefined;
  if (detail !== undefined) {
    if (!isRecord(detail)) return undefined;
    const label = field(detail, 'label');
    const text = field(detail, 'text');
    if (!isText(label, MAX_OVERLAY_LABEL_LENGTH) || !isText(text, MAX_OVERLAY_TEXT_LENGTH)) return undefined;
    parsedDetail = { label, text };
  }
  return {
    kind: 'confirm',
    title,
    message,
    ...(parsedWarning ? { warning: parsedWarning } : {}),
    ...(parsedDetail ? { detail: parsedDetail } : {}),
    confirmLabel,
    cancelLabel,
    danger,
  };
}

function isTag(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TAG_LENGTH;
}

function parseTagPicker(raw: Record<string, unknown>): OverlayRequest | undefined {
  const anchor = parseRect(field(raw, 'anchor'));
  const current = field(raw, 'current');
  const tags = field(raw, 'tags');
  const placeholder = field(raw, 'placeholder');
  if (!anchor || !isText(placeholder, MAX_OVERLAY_LABEL_LENGTH)) return undefined;
  if (current !== undefined && !isTag(current)) return undefined;
  if (!Array.isArray(tags) || tags.length > MAX_OVERLAY_TAGS || !(tags as unknown[]).every(isTag)) return undefined;
  return { kind: 'tagPicker', anchor, ...(current !== undefined ? { current } : {}), tags: [...(tags as string[])], placeholder };
}

/** A clean copy of a popup request from a renderer, or undefined when any field is malformed or out of bounds; only main opens settings. */
export function parseOverlayRequest(raw: unknown): OverlayRequest | undefined {
  if (!isRecord(raw)) return undefined;
  switch (field(raw, 'kind')) {
    case 'menu': return parseMenu(raw);
    case 'confirm': return parseConfirm(raw);
    case 'tagPicker': return parseTagPicker(raw);
    default: return undefined;
  }
}

/** The overlay's answer as a clean copy, when it answers this request; a menu answer must name one of its enabled items. */
export function parseOverlayAnswer(raw: unknown, request: OverlayRequest): OverlayAnswer | undefined {
  if (!isRecord(raw)) return undefined;
  const kind = field(raw, 'kind');
  if (kind === 'dismissed') return { kind: 'dismissed' };
  if (kind !== request.kind) return undefined;
  if (request.kind === 'menu') {
    const itemId = field(raw, 'itemId');
    const enabled = request.items.some((item) => item.kind === 'item' && item.id === itemId && item.disabled !== true);
    return enabled ? { kind: 'menu', itemId: itemId as string } : undefined;
  }
  if (request.kind === 'confirm') {
    const confirmed = field(raw, 'confirmed');
    return typeof confirmed === 'boolean' ? { kind: 'confirm', confirmed } : undefined;
  }
  if (request.kind === 'settings') return field(raw, 'closed') === true ? { kind: 'settings', closed: true } : undefined;
  const tag = field(raw, 'tag');
  if (tag === null) return { kind: 'tagPicker', tag: null };
  return isTag(tag) ? { kind: 'tagPicker', tag: tag.trim() } : undefined;
}

export function parseToastArea(raw: unknown): OverlayToastArea | undefined {
  if (!isRecord(raw)) return undefined;
  const width = field(raw, 'width');
  const height = field(raw, 'height');
  return isCoordinate(width) && isCoordinate(height) ? { width, height } : undefined;
}

/** The overlay page main serves at OVERLAY_PAGE_URL: the built overlay app under a fresh script nonce and the current theme. */
export function overlayHtml(theme: PanelTheme): string {
  const nonce = randomBytes(16).toString('base64');
  const assets = `${APP_ORIGIN}/desktop-shell/assets`;
  return `<!DOCTYPE html>
<html lang="en"${theme.reducedMotion ? ' data-reduced-motion' : ''}>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${APP_ORIGIN} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${APP_ORIGIN}; img-src ${APP_ORIGIN} data:; base-uri 'none'; form-action 'none';">
  <link href="${assets}/overlay.css" rel="stylesheet">
  <style id="${HOST_THEME_STYLE_ID}">${theme.css}</style>
  <title>Damocles</title>
</head>
<body class="vscode-${theme.kind}" data-vscode-theme-kind="vscode-${theme.kind}">
  <div id="app"></div>
  <script nonce="${nonce}" type="module" src="${assets}/overlay.js"></script>
</body>
</html>`;
}

interface OpenRequest {
  readonly id: string;
  readonly request: OverlayRequest;
  readonly resolve: (answer: OverlayAnswer) => void;
  readonly reject: (err: Error) => void;
  ackTimer: NodeJS.Timeout | undefined;
}

/**
 * The window's top-most view: menus, dialogs and toasts drawn above every other view (plan AD1). It is hidden, covers
 * the toast stack's rectangle, or covers the whole content area while a popup is open. One popup is open at a time; a
 * new request dismisses the open one.
 */
export class OverlayHost implements ToastSink {
  readonly view: WebContentsView;
  private readonly deps: OverlayHostDeps;
  private readonly invokeChannels: string[] = [];
  private readonly sendHandlers: Array<[string, (event: IpcMainEvent, ...args: unknown[]) => void]> = [];
  private open: OpenRequest | undefined;
  // where keyboard focus returns when the popup closes; never the overlay itself
  private returnFocus: WebContents | undefined;
  private toastArea: OverlayToastArea = { width: 0, height: 0 };
  private currentMode: OverlayMode = 'hidden';
  private loaded = false;
  private crashes: number[] = [];
  private disposed = false;
  private readonly onResize = (): void => this.applyMode();

  constructor(deps: OverlayHostDeps) {
    this.deps = deps;
    this.view = new WebContentsView({
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        // Loading the overlay page must not move keyboard focus out of the chat.
        focusOnNavigation: false,
      },
    });
    this.view.setBackgroundColor(TRANSPARENT);
    this.view.setVisible(false);
    deps.window.contentView.addChildView(this.view);
    deps.window.on('resize', this.onResize);

    this.handle(OVERLAY_CHANNELS.getState, () => this.deps.state());
    this.on(OVERLAY_CHANNELS.ack, (requestId) => {
      const open = this.open;
      if (!open || requestId !== open.id) return;
      clearTimeout(open.ackTimer);
      open.ackTimer = undefined;
    });
    this.on(OVERLAY_CHANNELS.answer, (requestId, raw) => {
      const open = this.open;
      if (!open || requestId !== open.id) {
        this.deps.log('[overlay] ignoring an answer to a request that is not open');
        return;
      }
      const answer = parseOverlayAnswer(raw, open.request);
      // The overlay closed its popup before answering, so a malformed answer must not leave the window covered.
      if (!answer) this.deps.log(`[overlay] a malformed ${open.request.kind} answer dismisses the request`);
      this.settle(open, answer ?? { kind: 'dismissed' });
    });
    this.on(OVERLAY_CHANNELS.resolveToast, (id, action) => {
      if (!isNonEmptyText(id, MAX_OVERLAY_ID_LENGTH) || !(action === undefined || isText(action, MAX_TOAST_ACTION_LENGTH))) {
        this.deps.log('[overlay] ignoring a malformed toast answer');
        return;
      }
      this.deps.resolveToast(id, action);
    });
    this.on(OVERLAY_CHANNELS.toastArea, (raw) => {
      const area = parseToastArea(raw);
      if (!area) {
        this.deps.log('[overlay] ignoring a malformed toast area');
        return;
      }
      this.toastArea = area;
      this.applyMode();
    });
    this.on(OVERLAY_CHANNELS.toastsLeave, () => {
      if (this.currentMode === 'toasts') this.releaseFocus(this.focused);
    });

    const contents = this.view.webContents;
    contents.on('did-finish-load', () => {
      this.loaded = true;
      for (const toast of this.deps.pendingToasts()) this.show(toast);
    });
    contents.on('render-process-gone', (_event, details) => {
      this.loaded = false;
      this.deps.log(`[overlay] renderer gone (${details.reason})`);
      this.toastArea = { width: 0, height: 0 };
      this.failOpen(new Error('The overlay page stopped'));
      this.applyMode();
      if (this.disposed || details.reason === 'clean-exit') return;
      const now = Date.now();
      this.crashes = [...this.crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
      if (this.crashes.length > MAX_CRASHES_IN_WINDOW) {
        this.deps.log(`[overlay] crashed ${this.crashes.length} times within ${CRASH_WINDOW_MS / 1000} s; not reloading it`);
        return;
      }
      this.load();
    });
  }

  get mode(): OverlayMode {
    return this.currentMode;
  }

  get focused(): boolean {
    return !this.disposed && !this.view.webContents.isDestroyed() && this.view.webContents.isFocused();
  }

  load(): void {
    this.loaded = false;
    loadAppPage(this.view.webContents, OVERLAY_PAGE_URL).catch((err: unknown) => {
      this.deps.log(`[overlay] failed to load: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Resolves once the overlay page has loaded, at once when it already has; request() refuses until then. */
  whenLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    return new Promise((resolve) => this.view.webContents.once('did-finish-load', () => resolve()));
  }

  // F6's toast stop: keyboard focus moves to the toast stack, which only shows in toasts mode.
  focusToasts(): void {
    if (this.currentMode !== 'toasts') return;
    this.view.webContents.focus();
    this.send(OVERLAY_CHANNELS.toastsFocus, undefined);
  }

  /**
   * Shows a validated popup and resolves with the user's answer. Rejects when the overlay is not loaded, does not
   * acknowledge the request within OVERLAY_ACK_TIMEOUT_MS, or crashes. Focus returns to returnFocus when it closes.
   */
  request(request: OverlayRequest, returnFocus: WebContents | undefined): Promise<OverlayAnswer> {
    if (this.disposed || !this.loaded || this.view.webContents.isDestroyed() || this.view.webContents.isCrashed()) {
      return Promise.reject(new Error('The overlay is not available'));
    }
    const previous = this.open;
    if (previous) this.settle(previous, { kind: 'dismissed' }, { keepFocus: true });
    else this.returnFocus = returnFocus === this.view.webContents ? undefined : returnFocus;
    return new Promise<OverlayAnswer>((resolve, reject) => {
      const open: OpenRequest = { id: randomUUID(), request, resolve, reject, ackTimer: undefined };
      open.ackTimer = setTimeout(() => {
        if (this.open !== open) return;
        this.deps.log(`[overlay] the overlay did not acknowledge a ${request.kind} request within ${OVERLAY_ACK_TIMEOUT_MS} ms; hiding it`);
        this.failOpen(new Error('The overlay did not respond'));
      }, OVERLAY_ACK_TIMEOUT_MS);
      this.open = open;
      this.applyMode();
      this.view.webContents.focus();
      this.send(OVERLAY_CHANNELS.request, { requestId: open.id, request });
    });
  }

  // Moves the overlay above every other view; call after any view is added or restacked.
  restack(): void {
    if (this.disposed || this.deps.window.isDestroyed()) return;
    this.deps.window.contentView.addChildView(this.view);
  }

  show(toast: OverlayToast): void {
    this.send(OVERLAY_CHANNELS.toast, toast);
  }

  dismiss(id: string): void {
    this.send(OVERLAY_CHANNELS.toastDismiss, id);
  }

  sendTheme(theme: PanelTheme): void {
    this.send(OVERLAY_CHANNELS.theme, theme);
  }

  // The UI language changed.
  stateChanged(): void {
    this.send(OVERLAY_CHANNELS.state, this.deps.state());
  }

  // Undefined until the page has loaded, so toasts wait in the notification service and replay on load.
  get toastSink(): ToastSink | undefined {
    return this.loaded && !this.disposed ? this : undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failOpen(new Error('The window closed'));
    if (!this.deps.window.isDestroyed()) this.deps.window.removeListener('resize', this.onResize);
    const contents = this.view.webContents;
    if (contents.isDestroyed()) return;
    for (const channel of this.invokeChannels) contents.ipc.removeHandler(channel);
    for (const [channel, handler] of this.sendHandlers) contents.ipc.removeListener(channel, handler);
    contents.close();
  }

  private settle(open: OpenRequest, answer: OverlayAnswer, options?: { readonly keepFocus: boolean }): void {
    if (this.open !== open) return;
    clearTimeout(open.ackTimer);
    this.open = undefined;
    if (options?.keepFocus) {
      this.send(OVERLAY_CHANNELS.cancel, open.id);
      open.resolve(answer);
      return;
    }
    this.applyMode();
    open.resolve(answer);
  }

  private failOpen(err: Error): void {
    const open = this.open;
    if (!open) return;
    clearTimeout(open.ackTimer);
    this.open = undefined;
    this.send(OVERLAY_CHANNELS.cancel, open.id);
    this.applyMode();
    open.reject(err);
  }

  private releaseFocus(hadFocus: boolean): void {
    const target = this.returnFocus;
    this.returnFocus = undefined;
    if (target && !target.isDestroyed()) target.focus();
    else if (hadFocus) this.deps.focusOutside();
  }

  private targetMode(): OverlayMode {
    if (this.open) return 'full';
    if (this.loaded && this.toastArea.width > 0 && this.toastArea.height > 0) return 'toasts';
    return 'hidden';
  }

  private applyMode(): void {
    if (this.disposed || this.deps.window.isDestroyed()) return;
    const previous = this.currentMode;
    // Read before the view hides: hiding it may blur it, and focus would then go nowhere.
    const hadFocus = this.focused;
    const mode = this.targetMode();
    this.currentMode = mode;
    if (mode === 'hidden') {
      this.view.setVisible(false);
    } else {
      // The overlay draws at the shell's zoom, so the shell's CSS-pixel anchors land unchanged.
      const zoom = this.deps.window.webContents.getZoomFactor();
      if (!this.view.webContents.isDestroyed()) this.view.webContents.setZoomFactor(zoom);
      this.view.setBounds(this.boundsFor(mode, zoom));
      if (mode !== previous) this.restack();
      this.view.setVisible(true);
    }
    // A hidden view keeps keyboard focus, so focus leaves with the popup and with the last toast.
    if ((previous === 'full' && mode !== 'full') || (previous !== 'hidden' && mode === 'hidden')) this.releaseFocus(hadFocus);
  }

  private boundsFor(mode: 'toasts' | 'full', zoom: number): Rectangle {
    const { width, height } = this.deps.window.getContentBounds();
    if (mode === 'full') return { x: 0, y: 0, width, height };
    const areaWidth = Math.min(width, Math.ceil(this.toastArea.width * zoom));
    const areaHeight = Math.min(height, Math.ceil(this.toastArea.height * zoom));
    return { x: width - areaWidth, y: height - areaHeight, width: areaWidth, height: areaHeight };
  }

  // Main's own overlay features (the settings modal) post and listen on the overlay page through these.
  send(channel: string, payload: unknown): void {
    if (this.disposed || !this.loaded) return;
    const contents = this.view.webContents;
    if (contents.isDestroyed() || contents.isCrashed()) return;
    contents.send(channel, payload);
  }

  // webContents.ipc receives only this view's messages; the check still pins them to its main frame on the exact overlay page.
  private accepts(event: IpcMainEvent | IpcMainInvokeEvent, channel: string): boolean {
    const accepted = !this.disposed && isPanelSender(event, this.view.webContents, OVERLAY_PAGE_URL);
    if (!accepted) this.deps.log(`[overlay] rejected ${channel} from ${event.senderFrame ? loggableUrl(event.senderFrame.url) : 'a destroyed frame'} (webContents ${event.sender.id})`);
    return accepted;
  }

  handle(channel: string, handler: (...args: unknown[]) => unknown): void {
    this.view.webContents.ipc.handle(channel, async (event, ...args: unknown[]) => {
      if (!this.accepts(event, channel)) throw new Error('Rejected');
      return handler(...args);
    });
    this.invokeChannels.push(channel);
  }

  on(channel: string, handler: (...args: unknown[]) => void): void {
    const guarded = (event: IpcMainEvent, ...args: unknown[]): void => {
      if (this.accepts(event, channel)) handler(...args);
    };
    this.view.webContents.ipc.on(channel, guarded);
    this.sendHandlers.push([channel, guarded]);
  }
}
