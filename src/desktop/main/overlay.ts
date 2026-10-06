import { randomBytes, randomUUID } from 'node:crypto';
import { WebContentsView, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { HOST_THEME_STYLE_ID } from '../../shared/host-theme';
import {
  MAX_OVERLAY_COORDINATE,
  MAX_OVERLAY_ID_LENGTH,
  MAX_OVERLAY_ITEMS,
  MAX_OVERLAY_LABEL_LENGTH,
  MAX_OVERLAY_TAGS,
  MAX_MESSAGE_ACTIONS,
  MAX_OVERLAY_TEXT_LENGTH,
  MAX_RASTER_PNG_BYTES,
  OVERLAY_ACK_TIMEOUT_MS,
  OVERLAY_CHANNELS,
  OVERLAY_ICONS,
  type OverlayAnswer,
  type OverlayIcon,
  type OverlayMenuItem,
  type OverlayRasterRequest,
  type OverlayRect,
  type RasterArt,
  type OverlayRequest,
  type OverlayState,
} from '../preload/overlay-channels';
import type { PanelTheme } from '../preload/panel-channels';
import { MAX_TAG_LENGTH } from '../preload/shell-channels';
import { validPng } from './notification-art';
import { APP_ORIGIN, OVERLAY_PAGE_URL } from './protocol';
import { loadAppPage, loggableUrl } from './security';
import { isPanelSender } from './views';

export type OverlayMode = 'hidden' | 'full';

export interface OverlayHostDeps {
  readonly window: BrowserWindow;
  readonly preloadPath: string;
  readonly state: () => OverlayState;
  // moves keyboard focus out of the overlay when no popup names where it returns
  readonly focusOutside: () => void;
  // a popup opened while the window is unfocused; focusing a view activates its window on macOS and Linux, so the caller
  // draws attention and calls focus() once the window activates
  readonly awaitActivation: () => void;
  // rasterize can draw again: the page (re)loaded, or answered after a deadline for the first time since it loaded
  readonly canRasterize: () => void;
  readonly log: (line: string) => void;
}

// A rasterize request the overlay has not answered by then resolves undefined, and its caller falls back.
export const RASTER_TIMEOUT_MS = 2000;
// Requests waiting on the overlay at once; a further one resolves undefined at once.
const MAX_PENDING_RASTERS = 16;
// An overlay page that kills its renderer on every load is left dead rather than reloaded in a loop.
const MAX_CRASHES_IN_WINDOW = 3;
const CRASH_WINDOW_MS = 60_000;
const TRANSPARENT = '#00000000';
// Renderer deadlines count ticks of main's own timer, not wall-clock time: a stall of main's event loop costs one tick,
// and a reply that arrived during it is handled before the next.
const DEADLINE_TICK_MS = 250;

const ICONS: ReadonlySet<string> = new Set(OVERLAY_ICONS);

/** Runs `expire` after ceil(deadlineMs / DEADLINE_TICK_MS) ticks; the returned function cancels it. */
function tickDeadline(deadlineMs: number, expire: () => void): () => void {
  let ticksLeft = Math.ceil(deadlineMs / DEADLINE_TICK_MS);
  const timer = setInterval(() => {
    ticksLeft--;
    if (ticksLeft > 0) return;
    clearInterval(timer);
    expire();
  }, DEADLINE_TICK_MS);
  return () => clearInterval(timer);
}

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

function parseNotifications(raw: Record<string, unknown>): OverlayRequest | undefined {
  const anchor = parseRect(field(raw, 'anchor'));
  return anchor ? { kind: 'notifications', anchor } : undefined;
}

/** A clean copy of a popup request from a renderer, or undefined when any field is malformed or out of bounds; only main opens settings and asks messages. */
export function parseOverlayRequest(raw: unknown): OverlayRequest | undefined {
  if (!isRecord(raw)) return undefined;
  switch (field(raw, 'kind')) {
    case 'menu': return parseMenu(raw);
    case 'confirm': return parseConfirm(raw);
    case 'tagPicker': return parseTagPicker(raw);
    case 'notifications': return parseNotifications(raw);
    default: return undefined;
  }
}

function isIndexBelow(value: unknown, length: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < length;
}

/** A message dialog main asks (D41) within the overlay's bounds, or undefined, when main asks with the OS message box instead. */
export function parseMessageRequest(raw: unknown): Extract<OverlayRequest, { kind: 'message' }> | undefined {
  if (!isRecord(raw) || field(raw, 'kind') !== 'message') return undefined;
  const severity = field(raw, 'severity');
  const message = field(raw, 'message');
  const detail = field(raw, 'detail');
  const actions = field(raw, 'actions');
  const cancelLabel = field(raw, 'cancelLabel');
  const defaultAction = field(raw, 'defaultAction');
  if (severity !== 'info' && severity !== 'warning' && severity !== 'danger') return undefined;
  if (!isNonEmptyText(message, MAX_OVERLAY_TEXT_LENGTH) || !isNonEmptyText(cancelLabel, MAX_OVERLAY_LABEL_LENGTH)) return undefined;
  if (detail !== undefined && !isText(detail, MAX_OVERLAY_TEXT_LENGTH)) return undefined;
  if (!Array.isArray(actions) || actions.length > MAX_MESSAGE_ACTIONS) return undefined;
  if (!(actions as unknown[]).every((action) => isNonEmptyText(action, MAX_OVERLAY_LABEL_LENGTH))) return undefined;
  if (defaultAction !== undefined && !isIndexBelow(defaultAction, actions.length)) return undefined;
  return {
    kind: 'message',
    severity,
    message,
    ...(detail !== undefined && detail !== '' ? { detail } : {}),
    actions: [...(actions as string[])],
    cancelLabel,
    ...(defaultAction !== undefined ? { defaultAction } : {}),
  };
}

function parseNotificationsAnswer(raw: Record<string, unknown>): OverlayAnswer | undefined {
  const action = field(raw, 'action');
  const entryId = field(raw, 'entryId');
  return action === 'open' && isNonEmptyText(entryId, MAX_OVERLAY_ID_LENGTH) ? { kind: 'notifications', action: 'open', entryId } : undefined;
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
  if (request.kind === 'message') {
    const action = field(raw, 'action');
    if (action === null) return { kind: 'message', action: null };
    return isIndexBelow(action, request.actions.length) ? { kind: 'message', action } : undefined;
  }
  if (request.kind === 'notifications') return parseNotificationsAnswer(raw);
  const tag = field(raw, 'tag');
  if (tag === null) return { kind: 'tagPicker', tag: null };
  return isTag(tag) ? { kind: 'tagPicker', tag: tag.trim() } : undefined;
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
  readonly shown: (() => void) | undefined;
  cancelAckDeadline: (() => void) | undefined;
}

interface PendingRaster {
  readonly width: number;
  readonly height: number;
  readonly resolve: (png: Buffer | undefined) => void;
  readonly cancelDeadline: () => void;
}

/**
 * The window's top-most view: menus, dialogs and the settings modal drawn above every other view (plan AD1). It is
 * hidden, or covers the whole content area while a popup is open; toasts show in the desktop popup window (D52). A message
 * dialog stacks above whatever is open; any other new request dismisses every open request except those dialogs.
 */
export class OverlayHost {
  readonly view: WebContentsView;
  private readonly deps: OverlayHostDeps;
  private readonly invokeChannels: string[] = [];
  private readonly sendHandlers: Array<[string, (event: IpcMainEvent, ...args: unknown[]) => void]> = [];
  // in the order they opened
  private open: OpenRequest[] = [];
  // where keyboard focus returns when the last open popup closes; never the overlay itself
  private returnFocus: WebContents | undefined;
  private currentMode: OverlayMode = 'hidden';
  private loaded = false;
  private crashes: number[] = [];
  private disposed = false;
  private readonly rasters = new Map<string, PendingRaster>();
  // ids of requests that missed their deadline: a page's first draw can outlast it while it loads fonts under startup load
  private readonly lateRasters = new Set<string>();
  // only the first late answer since the page loaded asks for a redraw, so a page that is always slow cannot loop
  private lateAnswered = false;
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
      const open = this.openById(requestId);
      if (!open || open.cancelAckDeadline === undefined) return;
      open.cancelAckDeadline();
      open.cancelAckDeadline = undefined;
      open.shown?.();
    });
    this.on(OVERLAY_CHANNELS.answer, (requestId, raw) => {
      const open = this.openById(requestId);
      if (!open) {
        this.deps.log('[overlay] ignoring an answer to a request that is not open');
        return;
      }
      const answer = parseOverlayAnswer(raw, open.request);
      // The overlay closed its popup before answering, so a malformed answer must not leave the window covered.
      if (!answer) this.deps.log(`[overlay] a malformed ${open.request.kind} answer dismisses the request`);
      this.settle(open, answer ?? { kind: 'dismissed' });
    });
    this.on(OVERLAY_CHANNELS.rasterized, (id, raw) => {
      const pending = typeof id === 'string' ? this.rasters.get(id) : undefined;
      if (!pending) {
        if (typeof id === 'string' && this.lateRasters.delete(id)) {
          if (this.lateAnswered) return;
          this.lateAnswered = true;
          this.deps.log('[overlay] the overlay rasterized an image after its deadline; drawing again');
          this.deps.canRasterize();
          return;
        }
        this.deps.log('[overlay] ignoring a rasterized image main did not ask for');
        return;
      }
      this.rasters.delete(id as string);
      pending.cancelDeadline();
      const png = raw === null ? undefined : validPng(raw, pending.width, pending.height, MAX_RASTER_PNG_BYTES);
      if (raw !== null && !png) this.deps.log(`[overlay] refused a rasterized image that is not one ${pending.width}x${pending.height} PNG`);
      pending.resolve(png);
    });

    const contents = this.view.webContents;
    contents.on('did-finish-load', () => {
      this.loaded = true;
      this.lateRasters.clear();
      this.lateAnswered = false;
      this.deps.canRasterize();
    });
    contents.on('render-process-gone', (_event, details) => {
      this.loaded = false;
      this.deps.log(`[overlay] renderer gone (${details.reason})`);
      this.failAll(new Error('The overlay page stopped'));
      this.dropRasters();
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

  // A closing window destroys the view before its last blur events ask, and reading a destroyed view's webContents throws.
  get focused(): boolean {
    return !this.disposed && !this.deps.window.isDestroyed() && !this.view.webContents.isDestroyed() && this.view.webContents.isFocused();
  }

  // Whether a request of this kind is on screen, for channels that act only while their popup shows.
  isOpen(kind: OverlayRequest['kind']): boolean {
    return this.open.some((entry) => entry.request.kind === kind);
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

  /**
   * Shows a validated popup and resolves with the user's answer. Rejects when the overlay is not loaded, does not
   * acknowledge the request within OVERLAY_ACK_TIMEOUT_MS, or crashes; `shown` runs once the overlay acknowledges it.
   * Focus returns to returnFocus once every open request has closed.
   */
  request(request: OverlayRequest, returnFocus: WebContents | undefined, shown?: () => void): Promise<OverlayAnswer> {
    if (this.disposed || !this.loaded || this.view.webContents.isDestroyed() || this.view.webContents.isCrashed()) {
      return Promise.reject(new Error('The overlay is not available'));
    }
    // Focus returns where it was before the first of the requests that are open together.
    if (this.open.length === 0) this.returnFocus = returnFocus === this.view.webContents ? undefined : returnFocus;
    if (request.kind !== 'message') {
      for (const previous of this.open.filter((entry) => entry.request.kind !== 'message')) this.settle(previous, { kind: 'dismissed' }, { keepFocus: true });
    }
    return new Promise<OverlayAnswer>((resolve, reject) => {
      const open: OpenRequest = { id: randomUUID(), request, resolve, reject, shown, cancelAckDeadline: undefined };
      open.cancelAckDeadline = tickDeadline(OVERLAY_ACK_TIMEOUT_MS, () => {
        if (!this.open.includes(open)) return;
        this.deps.log(`[overlay] the overlay did not acknowledge a ${request.kind} request within ${OVERLAY_ACK_TIMEOUT_MS} ms; hiding it`);
        this.failAll(new Error('The overlay did not respond'));
      });
      this.open = [...this.open, open];
      this.applyMode();
      if (this.deps.window.isFocused()) this.focus();
      else this.deps.awaitActivation();
      this.send(OVERLAY_CHANNELS.request, { requestId: open.id, request });
    });
  }

  /** Gives the open popups keyboard focus; nothing while none is open. */
  focus(): void {
    if (this.open.length === 0 || this.disposed || this.view.webContents.isDestroyed()) return;
    this.view.webContents.focus();
  }

  /**
   * Has the overlay page draw main's art and resolves with its PNG once validPng accepts it; undefined when the page is not
   * loaded, crashes, answers null or a malformed image, or misses RASTER_TIMEOUT_MS.
   */
  rasterize(art: RasterArt): Promise<Buffer | undefined> {
    if (this.disposed || !this.loaded || this.view.webContents.isDestroyed() || this.view.webContents.isCrashed() || this.rasters.size >= MAX_PENDING_RASTERS) {
      return Promise.resolve(undefined);
    }
    const id = randomUUID();
    return new Promise((resolve) => {
      const cancelDeadline = tickDeadline(RASTER_TIMEOUT_MS, () => {
        if (!this.rasters.delete(id)) return;
        this.deps.log(`[overlay] the overlay did not rasterize an image within ${RASTER_TIMEOUT_MS} ms`);
        this.lateRasters.add(id);
        for (const oldest of this.lateRasters) {
          if (this.lateRasters.size <= MAX_PENDING_RASTERS) break;
          this.lateRasters.delete(oldest);
        }
        resolve(undefined);
      });
      this.rasters.set(id, { width: art.width, height: art.height, resolve, cancelDeadline });
      const request: OverlayRasterRequest = { id, art };
      this.send(OVERLAY_CHANNELS.rasterize, request);
    });
  }

  // Moves the overlay above every other view; call after any view is added or restacked.
  restack(): void {
    if (this.disposed || this.deps.window.isDestroyed()) return;
    this.deps.window.contentView.addChildView(this.view);
  }

  sendTheme(theme: PanelTheme): void {
    this.send(OVERLAY_CHANNELS.theme, theme);
  }

  // The UI language changed.
  stateChanged(): void {
    this.send(OVERLAY_CHANNELS.state, this.deps.state());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(new Error('The window closed'));
    this.dropRasters();
    if (!this.deps.window.isDestroyed()) this.deps.window.removeListener('resize', this.onResize);
    const contents = this.view.webContents;
    if (contents.isDestroyed()) return;
    for (const channel of this.invokeChannels) contents.ipc.removeHandler(channel);
    for (const [channel, handler] of this.sendHandlers) contents.ipc.removeListener(channel, handler);
    contents.close();
  }

  private openById(requestId: unknown): OpenRequest | undefined {
    return this.open.find((entry) => entry.id === requestId);
  }

  private settle(open: OpenRequest, answer: OverlayAnswer, options?: { readonly keepFocus: boolean }): void {
    if (!this.open.includes(open)) return;
    open.cancelAckDeadline?.();
    this.open = this.open.filter((entry) => entry !== open);
    if (options?.keepFocus) {
      this.send(OVERLAY_CHANNELS.cancel, open.id);
      open.resolve(answer);
      return;
    }
    this.applyMode();
    open.resolve(answer);
  }

  // A hung, crashed or closing overlay rejects every open request.
  private failAll(err: Error): void {
    const failed = this.open;
    if (failed.length === 0) return;
    this.open = [];
    for (const open of failed) {
      open.cancelAckDeadline?.();
      this.send(OVERLAY_CHANNELS.cancel, open.id);
    }
    this.applyMode();
    for (const open of failed) open.reject(err);
  }

  private dropRasters(): void {
    const dropped = [...this.rasters.values()];
    this.rasters.clear();
    for (const pending of dropped) {
      pending.cancelDeadline();
      pending.resolve(undefined);
    }
  }

  private releaseFocus(hadFocus: boolean): void {
    const target = this.returnFocus;
    this.returnFocus = undefined;
    if (target && !target.isDestroyed()) target.focus();
    else if (hadFocus) this.deps.focusOutside();
  }

  private applyMode(): void {
    if (this.disposed || this.deps.window.isDestroyed()) return;
    const previous = this.currentMode;
    // Read before the view hides: hiding it may blur it, and focus would then go nowhere.
    const hadFocus = this.focused;
    const mode: OverlayMode = this.open.length > 0 ? 'full' : 'hidden';
    this.currentMode = mode;
    if (mode === 'hidden') {
      this.view.setVisible(false);
    } else {
      // The overlay draws at the shell's zoom, so the shell's CSS-pixel anchors land unchanged.
      const zoom = this.deps.window.webContents.getZoomFactor();
      if (!this.view.webContents.isDestroyed()) this.view.webContents.setZoomFactor(zoom);
      const { width, height } = this.deps.window.getContentBounds();
      this.view.setBounds({ x: 0, y: 0, width, height });
      if (mode !== previous) this.restack();
      this.view.setVisible(true);
    }
    // A hidden view keeps keyboard focus, so focus leaves with the popup.
    if (previous === 'full' && mode === 'hidden') this.releaseFocus(hadFocus);
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
