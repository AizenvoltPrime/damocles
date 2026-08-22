// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BrowserService,
  STREAM_JPEG_QUALITY,
  TOOL_JPEG_QUALITY,
  MAX_DEVICE_SCALE,
  FRAME_ACK_FALLBACK_MS,
} from '../index';
import { BROWSER_WEBVIEW_SCRIPT } from '../browser-webview-script';
import { ScreencastHealth } from '../screencast-health';
import { __webviewPanels, type FakeWebviewPanel } from 'vscode';

/**
 * Slice 1 acceptance suite — the zero-overhead frame pipeline, end to end.
 *
 * Two halves, both driving REAL production code rather than restating it:
 *   - Host half: the real `BrowserService` against fake Playwright pages/CDP sessions, using the
 *     `Priv` cast idiom from `tab-panels-units.test.ts` to reach the private frame/ack machinery.
 *     `ackScreencastFrame` / `startScreencast` / `stopScreencast` are spied on the real
 *     `PageController` so every assertion is about observable CDP traffic, not internal fields.
 *   - Webview half: `BROWSER_WEBVIEW_SCRIPT` is `new Function`-evaluated under happy-dom against a
 *     stubbed `acquireVsCodeApi` / `createImageBitmap` / canvas context / rAF, so the decode-and-ack
 *     path that actually ships is the path under test. That extraction exists for exactly this.
 *
 * Every `describe` maps to an acceptance bullet in the mission brief; the bullet is quoted on it.
 */

// Kept inert: these suites never launch a real Chromium (they set `context` directly), but importing
// index.ts pulls the launcher in, and mocking it here matches tab-panels-units.test.ts.
vi.mock('../launcher', () => ({ launchBrowserContext: vi.fn() }));

type Handler = (...args: unknown[]) => unknown;

function fakePage(url = 'about:blank') {
  return {
    on: (_e: string, _h: Handler) => {},
    url: () => url,
    close: vi.fn(async () => {}),
    opener: async () => null,
  };
}

/** A CDP session whose `send` resolves — the real PageController runs on top of it, allow-list and all. */
function fakeSession() {
  return { on: (_e: string, _h: Handler) => {}, send: vi.fn(async () => ({})), detach: vi.fn(async () => {}) };
}

interface TestEntry {
  page: unknown;
  panel: {
    visible: boolean;
    pushFrame: (bytes: Buffer, w: number, h: number, frameId: number) => void;
    dispose: () => void;
  };
  controller: {
    ackScreencastFrame: (sessionId: number) => Promise<void>;
    startScreencast: (o?: unknown) => Promise<void>;
    stopScreencast: () => Promise<void>;
    setViewport: (w: number, h: number, dpr?: number) => Promise<void>;
  };
  health: {
    noteStart: (now?: number) => void;
    noteFrame: () => void;
    noteAckFailure: () => void;
    shouldRestart: (now: number, visible: boolean, connected: boolean) => boolean;
  };
  lastFrame: { bytes: Buffer; deviceWidth: number; deviceHeight: number } | null;
  pendingAck: { sessionId: number; frameId: number; timer: unknown } | null;
  nextFrameId: number;
  resizeChain: Promise<void>;
  viewport: { width: number; height: number; dpr: number };
}

type Priv = {
  context: unknown;
  pages: Map<unknown, TestEntry>;
  state: string;
  activePage: unknown;
  registerPage: (p: unknown, ownerScopeId?: string) => Promise<TestEntry | null>;
  setActivePage: (p: unknown) => void;
  handlePageClosed: (p: unknown) => void;
  onScreencastFrame: (entry: unknown, frame: unknown) => void;
  onFrameRendered: (entry: unknown, frameId: number) => void;
  releasePendingAck: (entry: unknown, mode: 'ack' | 'drop') => void;
  screencastOptions: (entry: unknown) => Record<string, unknown>;
  resizeEntry: (entry: unknown, w: number, h: number, dpr: number) => Promise<void>;
  startWatchdog: () => void;
  clearWatchdog: () => void;
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

/** The BrowserPanel for an entry, plus the FakeWebviewPanel underneath it (mock test handles). */
function panelOf(entry: TestEntry): FakeWebviewPanel {
  const inner = (entry.panel as unknown as { panel: FakeWebviewPanel }).panel;
  return inner;
}

async function makeService(): Promise<BrowserService> {
  const service = new BrowserService();
  priv(service).context = { newCDPSession: async () => fakeSession(), close: async () => {} };
  priv(service).state = 'connected';
  return service;
}

/**
 * Register a page and return its entry with the CDP-facing controller methods spied. Panel visibility
 * is driven through the mock's `setVisible` so the real `onDidChangeViewState` → `onVisibilityChange`
 * wiring runs, exactly as in VS Code.
 */
async function addTab(service: BrowserService, url = 'http://a'): Promise<{
  entry: TestEntry;
  page: ReturnType<typeof fakePage>;
  ack: ReturnType<typeof vi.spyOn>;
  start: ReturnType<typeof vi.spyOn>;
  stop: ReturnType<typeof vi.spyOn>;
  push: ReturnType<typeof vi.spyOn>;
  calls: string[];
}> {
  const page = fakePage(url);
  await priv(service).registerPage(page, BrowserService.PRIMARY_SCOPE_ID);
  const entry = priv(service).pages.get(page)!;
  const calls: string[] = [];
  const ack = vi.spyOn(entry.controller, 'ackScreencastFrame').mockImplementation(async (sessionId: number) => {
    calls.push(`ack:${sessionId}`);
  });
  const start = vi.spyOn(entry.controller, 'startScreencast').mockImplementation(async () => {
    calls.push('start');
  });
  const stop = vi.spyOn(entry.controller, 'stopScreencast').mockImplementation(async () => {
    calls.push('stop');
  });
  vi.spyOn(entry.controller, 'setViewport').mockImplementation(async () => {
    calls.push('setViewport');
  });
  const push = vi.spyOn(entry.panel, 'pushFrame');
  return { entry, page, ack, start, stop, push, calls };
}

/** A CDP screencast frame as Chromium delivers it (base64 payload + its own ack sessionId). */
function cdpFrame(sessionId: number, deviceWidth = 800, deviceHeight = 600) {
  return { data: Buffer.from(`frame-${sessionId}`).toString('base64'), metadata: { deviceWidth, deviceHeight }, sessionId };
}

// happy-dom hands every test in this file the SAME `window`, so each evaluated copy of the webview
// script would otherwise keep listening for `message` events and decode frames meant for the next
// test's copy. Every mount records its listeners here and afterEach detaches them.
const mountedListeners: Array<[string, EventListenerOrEventListenerObject]> = [];

beforeEach(() => {
  __webviewPanels.length = 0;
});

afterEach(() => {
  for (const [type, listener] of mountedListeners.splice(0)) window.removeEventListener(type, listener);
  document.documentElement.className = '';
  document.body.removeAttribute('style');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Acceptance: constants are asserted on the SYMBOLS ────────────────────────────────────────────

describe('constants and screencast options (no quality/dpr/everyNthFrame reduction)', () => {
  it('exports the documented constant values', () => {
    expect(STREAM_JPEG_QUALITY).toBe(80);
    expect(TOOL_JPEG_QUALITY).toBe(70);
    expect(MAX_DEVICE_SCALE).toBe(2);
    expect(FRAME_ACK_FALLBACK_MS).toBe(1000);
  });

  it('screencastOptions streams jpeg at STREAM_JPEG_QUALITY with everyNthFrame 1 and an un-reduced size', async () => {
    const service = await makeService();
    const { entry } = await addTab(service);
    entry.viewport = { width: 1000, height: 800, dpr: 2 };

    const options = priv(service).screencastOptions(entry);

    expect(options).toEqual({
      format: 'jpeg',
      quality: STREAM_JPEG_QUALITY,
      everyNthFrame: 1,
      // Full dpr-scaled size: the slice explicitly must NOT shrink the stream.
      maxWidth: 2000,
      maxHeight: 1600,
    });
    service.dispose();
  });

  it('clamps the device scale to MAX_DEVICE_SCALE rather than a hardcoded 2', async () => {
    const service = await makeService();
    const { entry } = await addTab(service);

    await priv(service).resizeEntry(entry, 900, 700, 3);

    expect(entry.viewport.dpr).toBe(MAX_DEVICE_SCALE);
    service.dispose();
  });
});

// ── Acceptance: "no atob and no charCodeAt loop anywhere in the browser webview" ──────────────────

describe('P1 — base64 transport is gone from the webview', () => {
  it('the shipped webview script contains no atob and no charCodeAt byte loop', () => {
    expect(BROWSER_WEBVIEW_SCRIPT).not.toMatch(/\batob\b/);
    expect(BROWSER_WEBVIEW_SCRIPT).not.toMatch(/charCodeAt/);
  });

  it('decodes through Blob → createImageBitmap instead', () => {
    expect(BROWSER_WEBVIEW_SCRIPT).toMatch(/new Blob\(\[frame\.bytes\], \{ type: 'image\/jpeg' \}\)/);
    expect(BROWSER_WEBVIEW_SCRIPT).toMatch(/await createImageBitmap\(blob\)/);
  });

  it('stays free of backticks and ${ so buildHtml interpolation can never break', () => {
    // The script is injected into a template literal in browser-panel.ts's buildHtml().
    expect(BROWSER_WEBVIEW_SCRIPT).not.toContain('`');
    expect(BROWSER_WEBVIEW_SCRIPT).not.toContain('${');
  });

  it('pushes a Buffer (not a base64 string) on both push paths', async () => {
    const service = await makeService();
    const { entry, push } = await addTab(service);
    panelOf(entry).setVisible(true);

    priv(service).onScreencastFrame(entry, cdpFrame(1));

    const [bytes, w, h, frameId] = push.mock.calls[0] as [Buffer, number, number, number];
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.toString()).toBe('frame-1');
    expect([w, h]).toEqual([800, 600]);
    expect(typeof frameId).toBe('number');
    // The host decodes base64 exactly once, into lastFrame, so the webview never sees a string.
    expect(Buffer.isBuffer(entry.lastFrame!.bytes)).toBe(true);
    service.dispose();
  });
});

// ── Acceptance: "acked ONLY after that exact frame's frameRendered, or after FRAME_ACK_FALLBACK_MS" ──

describe('P2 — backpressure: a visible panel acks only on frameRendered or the fallback', () => {
  it('does not ack on arrival; acks exactly once when that frame reports painted', async () => {
    const service = await makeService();
    const { entry, ack } = await addTab(service);
    panelOf(entry).setVisible(true);

    priv(service).onScreencastFrame(entry, cdpFrame(41));

    // The whole point of the slice: Chromium is NOT told the frame is done on arrival.
    expect(ack).not.toHaveBeenCalled();
    expect(entry.pendingAck).toMatchObject({ sessionId: 41, frameId: 0 });

    priv(service).onFrameRendered(entry, entry.pendingAck!.frameId);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith(41);
    expect(entry.pendingAck).toBeNull();
    service.dispose();
  });

  it('ignores a frameRendered whose frameId does not match the outstanding frame', async () => {
    const service = await makeService();
    const { entry, ack } = await addTab(service);
    panelOf(entry).setVisible(true);
    priv(service).onScreencastFrame(entry, cdpFrame(41));

    priv(service).onFrameRendered(entry, entry.pendingAck!.frameId + 99);

    expect(ack).not.toHaveBeenCalled();
    expect(entry.pendingAck).not.toBeNull();
    service.dispose();
  });

  it('is a no-op when no frame is outstanding', async () => {
    const service = await makeService();
    const { entry, ack } = await addTab(service);
    panelOf(entry).setVisible(true);

    expect(() => priv(service).onFrameRendered(entry, 0)).not.toThrow();

    expect(ack).not.toHaveBeenCalled();
    service.dispose();
  });

  it('acks after FRAME_ACK_FALLBACK_MS when the webview never reports painted', async () => {
    vi.useFakeTimers();
    const service = await makeService();
    const { entry, ack } = await addTab(service);
    panelOf(entry).setVisible(true);
    priv(service).onScreencastFrame(entry, cdpFrame(41));

    // One tick short of the fallback: still silent, so the fallback is not merely an eager ack.
    vi.advanceTimersByTime(FRAME_ACK_FALLBACK_MS - 1);
    expect(ack).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith(41);
    service.dispose();
  });

  it('never acks a hidden panel twice: the frame is acked on arrival and never pushed', async () => {
    const service = await makeService();
    const { entry, ack, push } = await addTab(service);
    panelOf(entry).setVisible(false);

    priv(service).onScreencastFrame(entry, cdpFrame(55));

    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith(55);
    expect(push).not.toHaveBeenCalled();
    // Nothing is outstanding, so nothing can be released a second time.
    expect(entry.pendingAck).toBeNull();
    expect(entry.lastFrame).toBeNull();
    service.dispose();
  });

  it('acks two DISTINCT sessionIds when a frame arrives after the panel went hidden', async () => {
    const service = await makeService();
    const { entry, ack, push } = await addTab(service);
    // A frame is pushed while visible and left outstanding...
    panelOf(entry).setVisible(true);
    priv(service).onScreencastFrame(entry, cdpFrame(60));
    expect(entry.pendingAck).toMatchObject({ sessionId: 60 });

    // ...then VS Code marks the panel hidden and the next frame arrives before the view-state event
    // is dispatched. The hidden branch releases the stale frame AND acks the newly-arrived one.
    panelOf(entry).visible = false;
    push.mockClear();
    priv(service).onScreencastFrame(entry, cdpFrame(61));

    // Two acks, but for two DIFFERENT sessionIds — this is not a double-ack of one frame, which is
    // what would actually corrupt Chromium's in-flight count.
    const acked = ack.mock.calls.map((c: [number]) => c[0]);
    expect(acked).toEqual([60, 61]);
    expect(new Set(acked).size).toBe(2);
    expect(push).not.toHaveBeenCalled();
    expect(entry.pendingAck).toBeNull();
    service.dispose();
  });
});

// ── Acceptance: "a frameRendered arriving after the fallback already fired issues no second ack" ──

describe('a late frameRendered after the fallback fired issues NO second ack', () => {
  it('finds nothing to release because pendingAck is nulled before the ack', async () => {
    vi.useFakeTimers();
    const service = await makeService();
    const { entry, ack } = await addTab(service);
    panelOf(entry).setVisible(true);
    priv(service).onScreencastFrame(entry, cdpFrame(41));
    const frameId = entry.pendingAck!.frameId;

    vi.advanceTimersByTime(FRAME_ACK_FALLBACK_MS);
    expect(ack).toHaveBeenCalledTimes(1);

    // The slow decode finally finishes and reports the SAME frame as painted.
    priv(service).onFrameRendered(entry, frameId);

    // Exactly one ack for sessionId 41 — a duplicate would corrupt Chromium's in-flight count.
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack.mock.calls.filter((c: [number]) => c[0] === 41)).toHaveLength(1);
    service.dispose();
  });

  it('nulls pendingAck BEFORE issuing the ack, so a reentrant frameRendered cannot double-ack', async () => {
    const service = await makeService();
    const { entry } = await addTab(service);
    panelOf(entry).setVisible(true);
    priv(service).onScreencastFrame(entry, cdpFrame(41));
    const frameId = entry.pendingAck!.frameId;

    // Observe the field AT THE MOMENT the ack is issued. If the implementation acked first and nulled
    // after, `seen` would be the still-populated record and a reentrant release could ack twice.
    let seenAtAckTime: unknown = 'not-called';
    vi.spyOn(entry.controller, 'ackScreencastFrame').mockImplementation(async () => {
      seenAtAckTime = entry.pendingAck;
    });

    priv(service).onFrameRendered(entry, frameId);

    expect(seenAtAckTime).toBeNull();
    service.dispose();
  });
});

// ── Acceptance: "hiding a panel with a frame in flight issues an ack, THEN stops the screencast" ──

describe('hide/show edges never wedge the stream', () => {
  it('acks the outstanding sessionId BEFORE stopping the screencast', async () => {
    const service = await makeService();
    const { entry, ack, calls } = await addTab(service);
    panelOf(entry).setVisible(true);
    priv(service).onScreencastFrame(entry, cdpFrame(77));
    calls.length = 0;

    panelOf(entry).setVisible(false);
    await Promise.resolve();

    expect(ack).toHaveBeenCalledWith(77);
    // Ordering is the correctness requirement: the ack must reach a session that is still streaming.
    expect(calls).toEqual(['ack:77', 'stop']);
    expect(entry.pendingAck).toBeNull();
    service.dispose();
  });

  it('re-showing yields a live stream and a fresh repaint with no pendingAck armed', async () => {
    const service = await makeService();
    const { entry, ack, push, calls } = await addTab(service);
    panelOf(entry).setVisible(true);
    priv(service).onScreencastFrame(entry, cdpFrame(77));
    panelOf(entry).setVisible(false);
    await Promise.resolve();
    calls.length = 0;
    ack.mockClear();
    push.mockClear();

    panelOf(entry).setVisible(true);
    // Slice 2: the webview is destroyed on hide and rebuilt on show, so the resync + stream restart
    // hang off its `ready` handshake rather than the visibility event (a post issued before the
    // webview's listener is attached is silently dropped). Same hide→show cycle, real user path.
    panelOf(entry).fireMessage({ type: 'ready' });
    await Promise.resolve();

    // A live stream again (no wedge), and the cached last frame is repainted.
    expect(calls).toContain('start');
    expect(push).toHaveBeenCalledTimes(1);
    const [bytes, , , repaintId] = push.mock.calls[0] as [Buffer, number, number, number];
    expect(Buffer.isBuffer(bytes)).toBe(true);
    // It is a repaint of an ALREADY-ACKED frame, so no ack may be outstanding for it.
    expect(entry.pendingAck).toBeNull();

    priv(service).onFrameRendered(entry, repaintId);
    expect(ack).not.toHaveBeenCalled();
    service.dispose();
  });

  it('the next live frame after a hide/show cycle still acks normally', async () => {
    const service = await makeService();
    const { entry, ack } = await addTab(service);
    panelOf(entry).setVisible(true);
    priv(service).onScreencastFrame(entry, cdpFrame(77));
    panelOf(entry).setVisible(false);
    await Promise.resolve();
    panelOf(entry).setVisible(true);
    await Promise.resolve();
    ack.mockClear();

    priv(service).onScreencastFrame(entry, cdpFrame(78));
    priv(service).onFrameRendered(entry, entry.pendingAck!.frameId);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith(78);
    service.dispose();
  });
});

// ── Acceptance: "two frames in flight leave Chromium with zero unacked-but-abandoned frames" ─────

describe('two frames in flight leave zero unacked-but-abandoned frames', () => {
  it('acks the superseded frame before taking over with the new one', async () => {
    const service = await makeService();
    const { entry, ack, push, calls } = await addTab(service);
    panelOf(entry).setVisible(true);

    calls.length = 0; // drop the `start` from making the panel visible
    priv(service).onScreencastFrame(entry, cdpFrame(1));
    priv(service).onScreencastFrame(entry, cdpFrame(2));

    // Frame 1 was released the moment frame 2 superseded it, before frame 2 was pushed.
    expect(ack).toHaveBeenCalledWith(1);
    expect(calls).toEqual(['ack:1']);
    expect(entry.pendingAck).toMatchObject({ sessionId: 2 });

    priv(service).onFrameRendered(entry, entry.pendingAck!.frameId);

    // Both sessionIds acked, each exactly once: Chromium's in-flight count is balanced.
    expect(ack.mock.calls.map((c: [number]) => c[0])).toEqual([1, 2]);
    expect(push).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it('leaves no abandoned frame across a burst of five frames plus a final paint', async () => {
    const service = await makeService();
    const { entry, ack } = await addTab(service);
    panelOf(entry).setVisible(true);

    for (let sessionId = 1; sessionId <= 5; sessionId++) {
      priv(service).onScreencastFrame(entry, cdpFrame(sessionId));
    }
    priv(service).onFrameRendered(entry, entry.pendingAck!.frameId);

    const acked = ack.mock.calls.map((c: [number]) => c[0]);
    expect(acked).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(acked).size).toBe(acked.length); // no sessionId acked twice
    expect(entry.pendingAck).toBeNull();
    service.dispose();
  });

  it('drops (does not ack) an outstanding frame when the page closes — the session is already gone', async () => {
    const service = await makeService();
    const { entry, page, ack } = await addTab(service);
    await addTab(service, 'http://b'); // keep a second tab so closing does not tear the session down
    panelOf(entry).setVisible(true);
    priv(service).onScreencastFrame(entry, cdpFrame(9));
    ack.mockClear();

    priv(service).handlePageClosed(page);

    // Acking a detached session would reject and spuriously trip noteAckFailure on a dead entry.
    expect(ack).not.toHaveBeenCalled();
    expect(entry.pendingAck).toBeNull();
    service.dispose();
  });
});

// ── Acceptance: "with two visible panels, BOTH are health-monitored" ─────────────────────────────

describe('split view — every visible panel is health-monitored, not just the focused one', () => {
  it('restarts the NON-focused stalled panel (the service-level-health hole)', async () => {
    vi.useFakeTimers();
    const service = await makeService();
    const focused = await addTab(service, 'http://focused');
    const background = await addTab(service, 'http://background');
    panelOf(focused.entry).setVisible(true);
    panelOf(background.entry).setVisible(true);
    // The human is watching `focused`; `background` is visible in the other split, unfocused.
    priv(service).setActivePage(focused.page);
    priv(service).startWatchdog();

    // Both panels are visible and streaming. Only the BACKGROUND one stalls: a start with zero frames
    // ever. The focused one keeps delivering frames, so its own health object stays happy.
    focused.entry.health.noteStart(Date.now());
    background.entry.health.noteStart(Date.now());
    focused.start.mockClear();
    background.start.mockClear();
    // Run past the 10s zero-frame stall window (plus the tick that observes it) while the focused tab
    // keeps painting. Its own health object records those frames, so only `background` is stalled.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(3_000);
      priv(service).onScreencastFrame(focused.entry, cdpFrame(100 + i));
      priv(service).onFrameRendered(focused.entry, focused.entry.pendingAck!.frameId);
    }

    // The pre-slice design fed ONE service-level ScreencastHealth (gated on `entry.page ===
    // activePage`) and only ever inspected `getActiveEntry()`, so the unfocused split panel was
    // invisible to the watchdog and this assertion could never pass.
    expect(background.start).toHaveBeenCalled();
    expect(focused.start).not.toHaveBeenCalled();
    priv(service).clearWatchdog();
    service.dispose();
  });

  it('does not restart a hidden stalled panel', async () => {
    vi.useFakeTimers();
    const service = await makeService();
    const hidden = await addTab(service, 'http://hidden');
    panelOf(hidden.entry).setVisible(false);
    priv(service).startWatchdog();
    hidden.entry.health.noteStart(Date.now());
    hidden.start.mockClear();

    vi.advanceTimersByTime(60_000);

    expect(hidden.start).not.toHaveBeenCalled();
    priv(service).clearWatchdog();
    service.dispose();
  });

  it('keeps each tab health state independent — frames on A do not rescue a stalled B', async () => {
    vi.useFakeTimers();
    const service = await makeService();
    const a = await addTab(service, 'http://a');
    const b = await addTab(service, 'http://b');
    panelOf(a.entry).setVisible(true);
    panelOf(b.entry).setVisible(true);
    priv(service).startWatchdog();
    a.entry.health.noteStart(Date.now());
    b.entry.health.noteStart(Date.now());
    a.start.mockClear();
    b.start.mockClear();

    // A streams continuously; B never delivers a frame. A's frames must not clear B's stall state.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(3_000);
      priv(service).onScreencastFrame(a.entry, cdpFrame(200 + i));
      priv(service).onFrameRendered(a.entry, a.entry.pendingAck!.frameId);
    }

    expect(b.start).toHaveBeenCalled();
    expect(a.start).not.toHaveBeenCalled();
    priv(service).clearWatchdog();
    service.dispose();
  });
});

// ── Acceptance: "watchdog backoff follows 5s→10s→20s→40s→60s under fake timers" (C10) ────────────

describe('C10 — watchdog backoff series is 5s→10s→20s→40s→60s', () => {
  it('spaces successive restarts by the documented gaps, capped at 60s', async () => {
    vi.useFakeTimers({ now: 0 });
    const service = await makeService();
    const { entry, start } = await addTab(service);
    panelOf(entry).setVisible(true);
    priv(service).startWatchdog();
    // Isolate the BACKOFF schedule. `ScreencastHealth` also imposes its own 10s zero-frame stall
    // window, and each restart re-arms it (`startScreencast` calls `noteStart`), which would otherwise
    // dominate the observed spacing. Pinning the policy to "permanently stalled" leaves the backoff as
    // the only thing spacing the attempts — which is exactly what C10 is about.
    entry.health.shouldRestart = () => true;
    start.mockClear();

    const restartTimes: number[] = [];
    start.mockImplementation(async () => {
      restartTimes.push(Date.now());
    });

    // 5s ticks out to 225s — long enough to see the 60s cap engage twice.
    for (let t = 0; t < 45; t++) vi.advanceTimersByTime(5_000);

    const gaps = restartTimes.slice(1).map((t, i) => t - restartTimes[i]!);
    // First retry costs ONE tick (the C10 fix — it used to cost two), then doubling, then the cap.
    expect(restartTimes[0]).toBe(5_000);
    expect(gaps.slice(0, 5)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000]);
    // The cap holds rather than continuing to double.
    expect(gaps[5]).toBe(60_000);
    priv(service).clearWatchdog();
    service.dispose();
  });

  it('uses the real ScreencastHealth policy end to end: a stalled visible tab does get restarted', async () => {
    vi.useFakeTimers({ now: 0 });
    const service = await makeService();
    const { entry, start } = await addTab(service);
    panelOf(entry).setVisible(true);
    priv(service).startWatchdog();
    // Not stubbed here — this guards the backoff test above against having pinned away real behaviour.
    expect(entry.health).toBeInstanceOf(ScreencastHealth);
    entry.health.noteStart(Date.now());
    start.mockClear();

    vi.advanceTimersByTime(20_000);

    expect(start).toHaveBeenCalled();
    priv(service).clearWatchdog();
    service.dispose();
  });

  it('recovers a panel whose `ready` never arrives, which the watchdog used to be blind to', async () => {
    // `ready` is the SOLE trigger for screencast.start(), so a webview that never posts it means the
    // CDP call is never made. With the stall clock armed by that call, `startedAt` stayed null,
    // shouldRestart returned false on every tick forever, and the panel sat on "Waiting for browser
    // frames…" with the watchdog reporting healthy. Visibility alone must arm the clock.
    vi.useFakeTimers({ now: 0 });
    const service = await makeService();
    const { entry, start } = await addTab(service);

    // Visible, so the stream is WANTED — but no `ready` is ever fired, so nothing starts it.
    panelOf(entry).setVisible(true);
    priv(service).startWatchdog();
    expect(start).not.toHaveBeenCalled();

    vi.advanceTimersByTime(20_000);

    // The watchdog sees the stall and drives the start the lost handshake never did.
    expect(start).toHaveBeenCalled();
    priv(service).clearWatchdog();
    service.dispose();
  });

  it('a frame arriving clears the streak so the next stall backs off from 5s again', async () => {
    vi.useFakeTimers({ now: 0 });
    const service = await makeService();
    const { entry, start } = await addTab(service);
    panelOf(entry).setVisible(true);
    priv(service).startWatchdog();
    entry.health.shouldRestart = () => true;
    start.mockClear();
    const restartTimes: number[] = [];
    start.mockImplementation(async () => {
      restartTimes.push(Date.now());
    });

    // Build the streak out to the 40s backoff (restarts at t=5,10,20,40s).
    vi.advanceTimersByTime(40_000);
    expect(restartTimes).toEqual([5_000, 10_000, 20_000, 40_000]);

    // A real frame proves recovery. Asserted behaviourally: the next retry is ONE tick away again,
    // not the 40s the streak had reached. (The streak/backoff bookkeeping is private.)
    priv(service).onScreencastFrame(entry, cdpFrame(300));
    priv(service).onFrameRendered(entry, entry.pendingAck!.frameId);
    const restallAt = Date.now();

    vi.advanceTimersByTime(5_000);

    expect(restartTimes).toHaveLength(5);
    expect(restartTimes[4]! - restallAt).toBe(5_000);
    priv(service).clearWatchdog();
    service.dispose();
  });
});

// ── Acceptance: "exactly one resize debounce; two overlapping resizes never leave the stream stopped" ──

describe('P4 — one resize debounce, serialized per tab', () => {
  it('has no extension-side debounce timer left: a single resize reaches CDP without advancing timers', async () => {
    vi.useFakeTimers();
    const service = await makeService();
    const { entry, calls } = await addTab(service);
    panelOf(entry).setVisible(true);
    calls.length = 0;

    // The webview already debounced (150ms ResizeObserver); the host must not debounce again.
    panelOf(entry).fireMessage({ type: 'resize', width: 1024, height: 768, dpr: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await entry.resizeChain;

    expect(calls).toContain('setViewport');
    expect(entry.viewport).toMatchObject({ width: 1024, height: 768 });
    service.dispose();
  });

  it('has no PageEntry.resizeTimer field at all', async () => {
    const service = await makeService();
    const { entry } = await addTab(service);

    expect(entry).not.toHaveProperty('resizeTimer');
    expect(entry.resizeChain).toBeInstanceOf(Promise);
    service.dispose();
  });

  it('serializes overlapping resizes so the stream is never left stopped', async () => {
    const service = await makeService();
    const { entry, calls } = await addTab(service);
    panelOf(entry).setVisible(true);

    // Make the FIRST stopScreencast hang until released. Unserialized, the second resize would run its
    // full stop→start while the first is parked, and the first's stop would then land last — the exact
    // interleaving that kills the stream.
    let releaseFirstStop: (() => void) | null = null;
    let stopCount = 0;
    vi.spyOn(entry.controller, 'stopScreencast').mockImplementation(async () => {
      stopCount++;
      calls.push('stop');
      if (stopCount === 1) await new Promise<void>((resolve) => { releaseFirstStop = resolve; });
    });
    calls.length = 0;

    panelOf(entry).fireMessage({ type: 'resize', width: 800, height: 600, dpr: 1 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // Second resize arrives while the first is parked inside stopScreencast.
    panelOf(entry).fireMessage({ type: 'resize', width: 1200, height: 900, dpr: 1 });
    await Promise.resolve();
    expect(releaseFirstStop).not.toBeNull();
    (releaseFirstStop as unknown as () => void)();
    await entry.resizeChain;
    await entry.resizeChain;

    // Whatever the interleaving, the stream must END started.
    expect(calls[calls.length - 1]).toBe('start');
    expect(calls.lastIndexOf('start')).toBeGreaterThan(calls.lastIndexOf('stop'));
    // Latest-wins: the final viewport is the newest requested size, not the stale one.
    expect(entry.viewport).toMatchObject({ width: 1200, height: 900 });
    service.dispose();
  });

  it('collapses a burst of resizes into a single trailing run at the newest size', async () => {
    const service = await makeService();
    const { entry, calls } = await addTab(service);
    panelOf(entry).setVisible(true);

    let releaseFirstStop: (() => void) | null = null;
    let stopCount = 0;
    vi.spyOn(entry.controller, 'stopScreencast').mockImplementation(async () => {
      stopCount++;
      if (stopCount === 1) await new Promise<void>((resolve) => { releaseFirstStop = resolve; });
    });
    calls.length = 0;

    panelOf(entry).fireMessage({ type: 'resize', width: 800, height: 600, dpr: 1 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    for (const width of [900, 1000, 1100, 1280]) {
      panelOf(entry).fireMessage({ type: 'resize', width, height: 720, dpr: 1 });
    }
    await Promise.resolve();
    (releaseFirstStop as unknown as () => void)();
    for (let i = 0; i < 6; i++) await entry.resizeChain;

    // 5 events, but only the in-flight run + ONE trailing run at the newest size.
    expect(calls.filter((c) => c === 'setViewport')).toHaveLength(2);
    expect(entry.viewport).toMatchObject({ width: 1280, height: 720 });
    service.dispose();
  });

  it('releases the pending ack BEFORE stopping the stream on resize', async () => {
    const service = await makeService();
    const { entry, ack, calls } = await addTab(service);
    panelOf(entry).setVisible(true);
    priv(service).onScreencastFrame(entry, cdpFrame(31));
    calls.length = 0;

    await priv(service).resizeEntry(entry, 1024, 768, 1);

    expect(ack).toHaveBeenCalledWith(31);
    expect(calls.indexOf('ack:31')).toBeLessThan(calls.indexOf('stop'));
    expect(entry.pendingAck).toBeNull();
    service.dispose();
  });

  it('does not touch a page that closed while its resize was queued', async () => {
    const service = await makeService();
    const { entry, page, calls } = await addTab(service);
    await addTab(service, 'http://b');
    panelOf(entry).setVisible(true);
    calls.length = 0;

    panelOf(entry).fireMessage({ type: 'resize', width: 1024, height: 768, dpr: 1 });
    priv(service).handlePageClosed(page); // closes before the chained work runs
    await entry.resizeChain;

    expect(calls).not.toContain('setViewport');
    service.dispose();
  });
});

// ── Webview half: the real BROWSER_WEBVIEW_SCRIPT under happy-dom ────────────────────────────────

interface Harness {
  posted: Array<Record<string, unknown>>;
  ctx2d: { fillStyle: string; fillRect: ReturnType<typeof vi.fn>; drawImage: ReturnType<typeof vi.fn>; clearRect: ReturnType<typeof vi.fn> };
  getContext: ReturnType<typeof vi.fn>;
  createImageBitmap: ReturnType<typeof vi.fn>;
  bitmaps: Array<{ close: ReturnType<typeof vi.fn> }>;
  flushRaf: () => void;
  rafCount: () => number;
  sendFrame: (frameId: number, width?: number, height?: number) => void;
  fireResize: (width: number, height: number) => void;
  canvas: HTMLCanvasElement;
  errors: unknown[][];
}

/**
 * Evaluate the SHIPPED webview script against a stubbed webview host. Nothing about the pipeline is
 * reimplemented here — only the browser APIs happy-dom lacks (canvas 2d, createImageBitmap) and the
 * VS Code webview API are stubbed, so the assertions land on real production behaviour.
 */
function mountWebview(opts: { decode?: () => Promise<{ close: ReturnType<typeof vi.fn> }> } = {}): Harness {
  document.body.innerHTML = `
    <div id="toolbar">
      <button id="btn-back"></button><button id="btn-forward"></button><button id="btn-reload"></button>
      <input id="url-input" /><button id="btn-pick"></button><button id="btn-devtools"></button>
      <button id="btn-newtab"></button>
    </div>
    <div id="content-area">
      <div id="placeholder"></div>
      <canvas id="screen" style="display:none"></canvas>
      <div id="element-overlay"></div><div id="disconnected-overlay"></div>
    </div>`;
  const canvas = document.getElementById('screen') as HTMLCanvasElement;
  const ctx2d = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn(), clearRect: vi.fn() };
  const getContext = vi.fn(() => ctx2d);
  Object.defineProperty(canvas, 'getContext', { value: getContext, configurable: true });
  Object.defineProperty(canvas, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(canvas, 'clientHeight', { value: 600, configurable: true });

  const posted: Array<Record<string, unknown>> = [];
  const bitmaps: Array<{ close: ReturnType<typeof vi.fn> }> = [];
  const rafCbs: FrameRequestCallback[] = [];
  const errors: unknown[][] = [];
  let roCb: ((entries: unknown[]) => void) | null = null;

  const g = globalThis as unknown as Record<string, unknown>;
  g['acquireVsCodeApi'] = () => ({
    postMessage: (m: Record<string, unknown>) => posted.push(m),
    getState: () => undefined,
    setState: () => {},
  });
  g['requestAnimationFrame'] = (cb: FrameRequestCallback) => rafCbs.push(cb);
  const decode = opts.decode ?? (async () => {
    const bitmap = { close: vi.fn() };
    bitmaps.push(bitmap);
    return bitmap;
  });
  const createImageBitmapStub = vi.fn(decode);
  g['createImageBitmap'] = createImageBitmapStub;
  g['ResizeObserver'] = class {
    constructor(cb: (entries: unknown[]) => void) { roCb = cb; }
    observe() {}
    disconnect() {}
  };
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });

  // Capture the `message` listener this copy of the script installs so afterEach can detach it —
  // happy-dom shares one `window` across the whole file.
  const originalAddEventListener = window.addEventListener.bind(window);
  const spy = vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
    mountedListeners.push([type, listener]);
    return originalAddEventListener(type, listener as EventListener, options as never);
  }) as never);

  new Function(BROWSER_WEBVIEW_SCRIPT)();
  spy.mockRestore();

  return {
    posted,
    ctx2d,
    getContext,
    createImageBitmap: createImageBitmapStub,
    bitmaps,
    errors,
    canvas,
    rafCount: () => rafCbs.length,
    flushRaf: () => { const pending = rafCbs.splice(0); for (const cb of pending) cb(0); },
    sendFrame: (frameId, width = 100, height = 50) => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'frame', frameId, width, height, bytes: new ArrayBuffer(8) },
      }));
    },
    fireResize: (width, height) => roCb?.([{ contentRect: { width, height } }]),
  };
}

describe('webview decode path — the shipped script under happy-dom', () => {
  it('creates the canvas context with { alpha: false, desynchronized: true }', () => {
    const h = mountWebview();
    expect(h.getContext).toHaveBeenCalledWith('2d', { alpha: false, desynchronized: true });
  });

  it('decodes an ArrayBuffer frame via Blob → createImageBitmap and draws it', async () => {
    const h = mountWebview();

    h.sendFrame(7);
    await vi.waitFor(() => expect(h.createImageBitmap).toHaveBeenCalledTimes(1));

    const blob = h.createImageBitmap.mock.calls[0]![0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/jpeg');
    expect(blob.size).toBe(8);
    expect(h.ctx2d.drawImage).toHaveBeenCalled();
  });

  it('posts exactly one frameRendered per drawn frame, from inside rAF, after the draw', async () => {
    const h = mountWebview();

    h.sendFrame(7);
    await vi.waitFor(() => expect(h.ctx2d.drawImage).toHaveBeenCalled());

    // Drawn already, but NOT yet acked: the ack is deferred into rAF so it reports actual compositing.
    expect(h.posted.filter((m) => m['type'] === 'frameRendered')).toHaveLength(0);

    h.flushRaf();

    expect(h.posted.filter((m) => m['type'] === 'frameRendered')).toEqual([{ type: 'frameRendered', frameId: 7 }]);
  });

  it('draws immediately without a pre-draw rAF hop (P3)', async () => {
    const h = mountWebview();

    h.sendFrame(1);
    await vi.waitFor(() => expect(h.ctx2d.drawImage).toHaveBeenCalled());

    // The draw happened with ZERO rAF callbacks executed: the old pipeline awaited a rAF before
    // drawing an already-decoded frame. The single outstanding rAF is the post-draw ack, not a hop.
    expect(h.ctx2d.drawImage).toHaveBeenCalledTimes(1);
    expect(h.rafCount()).toBe(1);
    expect(h.posted.filter((m) => m['type'] === 'frameRendered')).toHaveLength(0);
  });

  it('discards a superseded frame: closes its bitmap and posts NOTHING for it', async () => {
    let releaseFirst: ((b: { close: ReturnType<typeof vi.fn> }) => void) | null = null;
    const first = { close: vi.fn() };
    const second = { close: vi.fn() };
    let call = 0;
    const h = mountWebview({
      decode: () => {
        call++;
        if (call === 1) return new Promise((resolve) => { releaseFirst = resolve as never; });
        return Promise.resolve(second);
      },
    });

    h.sendFrame(1);
    await vi.waitFor(() => expect(releaseFirst).not.toBeNull());
    h.sendFrame(2); // supersedes frame 1 mid-decode
    (releaseFirst as unknown as (b: unknown) => void)(first);
    await vi.waitFor(() => expect(h.ctx2d.drawImage).toHaveBeenCalled());
    h.flushRaf();

    expect(first.close).toHaveBeenCalledTimes(1);
    // Only the frame actually drawn reports back; the host already released frame 1's ack.
    expect(h.posted.filter((m) => m['type'] === 'frameRendered')).toEqual([{ type: 'frameRendered', frameId: 2 }]);
  });

  it('LOGS a decode failure AND still acks it, so backpressure is released', async () => {
    const boom = new Error('decode exploded');
    let fail = true;
    const good = { close: vi.fn() };
    const h = mountWebview({ decode: () => (fail ? Promise.reject(boom) : Promise.resolve(good)) });

    h.sendFrame(1);
    await vi.waitFor(() => expect(h.errors.length).toBeGreaterThan(0));

    expect(h.errors[0]).toEqual(['frame decode failed', boom]);
    // The ack is what paces Chromium. Withholding it on a frame we will never draw costs the host's
    // full FRAME_ACK_FALLBACK_MS per frame, so a persistently failing decoder degrades the live stream
    // to 1fps with no signal anywhere. It is posted directly rather than from inside rAF: there is no
    // painted frame to wait for.
    expect(h.posted.filter((m) => m['type'] === 'frameRendered')).toEqual([{ type: 'frameRendered', frameId: 1 }]);

    // `pumping` must reset, or one bad frame would wedge the panel forever.
    fail = false;
    h.sendFrame(2);
    await vi.waitFor(() => expect(h.ctx2d.drawImage).toHaveBeenCalled());
    h.flushRaf();
    expect(h.posted.filter((m) => m['type'] === 'frameRendered')).toEqual([
      { type: 'frameRendered', frameId: 1 },
      { type: 'frameRendered', frameId: 2 },
    ]);
  });

  it('fills the letterbox with the editor background instead of clearRect (opaque canvas)', async () => {
    document.body.style.backgroundColor = 'rgb(30, 30, 30)';
    const h = mountWebview();

    h.sendFrame(1);
    await vi.waitFor(() => expect(h.ctx2d.drawImage).toHaveBeenCalled());

    // clearRect on an alpha:false canvas paints BLACK bars; fillRect with the theme colour does not.
    expect(h.ctx2d.clearRect).not.toHaveBeenCalled();
    expect(h.ctx2d.fillRect).toHaveBeenCalledWith(0, 0, h.canvas.width, h.canvas.height);
    expect(h.ctx2d.fillStyle).toBe('rgb(30, 30, 30)');
  });

  it('follows a theme switch via the MutationObserver on documentElement', async () => {
    document.body.style.backgroundColor = 'rgb(30, 30, 30)';
    const h = mountWebview();
    h.sendFrame(1);
    await vi.waitFor(() => expect(h.ctx2d.drawImage).toHaveBeenCalled());
    expect(h.ctx2d.fillStyle).toBe('rgb(30, 30, 30)');

    // VS Code signals a theme change by rewriting documentElement's class/style.
    document.body.style.backgroundColor = 'rgb(255, 255, 255)';
    document.documentElement.className = 'vscode-light';
    await vi.waitFor(() => expect(document.documentElement.className).toBe('vscode-light'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    h.sendFrame(2);
    await vi.waitFor(() => expect(h.ctx2d.drawImage).toHaveBeenCalledTimes(2));

    expect(h.ctx2d.fillStyle).toBe('rgb(255, 255, 255)');
  });

  it('does not read getComputedStyle per frame — the colour is cached', async () => {
    document.body.style.backgroundColor = 'rgb(30, 30, 30)';
    const h = mountWebview();
    const spy = vi.spyOn(window, 'getComputedStyle');

    for (let i = 1; i <= 4; i++) {
      h.sendFrame(i);
      await vi.waitFor(() => expect(h.ctx2d.drawImage).toHaveBeenCalledTimes(i));
      h.flushRaf();
    }

    expect(spy).not.toHaveBeenCalled();
  });

  it('debounces resize by exactly 150ms — the only debounce in the path', () => {
    vi.useFakeTimers();
    const h = mountWebview();

    h.fireResize(1024, 768);
    vi.advanceTimersByTime(149);
    expect(h.posted.filter((m) => m['type'] === 'resize')).toHaveLength(0);

    vi.advanceTimersByTime(1);

    expect(h.posted.filter((m) => m['type'] === 'resize')).toEqual([
      { type: 'resize', width: 1024, height: 768, dpr: window.devicePixelRatio },
    ]);
  });

  it('coalesces a burst of resizes into one post', () => {
    vi.useFakeTimers();
    const h = mountWebview();

    for (const width of [800, 900, 1000, 1100]) h.fireResize(width, 600);
    vi.advanceTimersByTime(150);

    const resizes = h.posted.filter((m) => m['type'] === 'resize');
    expect(resizes).toHaveLength(1);
    expect(resizes[0]).toMatchObject({ width: 1100, height: 600 });
  });
});

// ── End-to-end: host and webview wired together through the real BrowserPanel ────────────────────

describe('end-to-end — host frame reaches the webview and its ack returns', () => {
  it('a host push arrives as an ArrayBuffer and its frameRendered acks that exact sessionId', async () => {
    const service = await makeService();
    const { entry, ack } = await addTab(service);
    const mockPanel = panelOf(entry);
    mockPanel.setVisible(true);

    priv(service).onScreencastFrame(entry, cdpFrame(88, 1024, 768));

    // The protocol payload the webview actually receives.
    const framePost = mockPanel.posted.filter((m) => (m as { type: string }).type === 'frame').pop() as {
      type: string; frameId: number; width: number; height: number; bytes: ArrayBuffer;
    };
    expect(framePost.bytes).toBeInstanceOf(ArrayBuffer);
    expect(framePost).toMatchObject({ type: 'frame', width: 1024, height: 768 });
    expect(Buffer.from(framePost.bytes).toString()).toBe('frame-88');

    // The webview replies through the real onDidReceiveMessage → BrowserPanel dispatch chain.
    mockPanel.fireMessage({ type: 'frameRendered', frameId: framePost.frameId });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith(88);
    service.dispose();
  });

  it('posts a FRESH ArrayBuffer copy per push, so a re-post of a cached frame cannot use a detached buffer', async () => {
    const service = await makeService();
    const { entry } = await addTab(service);
    const mockPanel = panelOf(entry);
    mockPanel.setVisible(true);

    priv(service).onScreencastFrame(entry, cdpFrame(88));
    // Hide + re-show re-posts the CACHED lastFrame — the second post of the same bytes. Slice 2 moved
    // that repaint into resyncPanel, which fires on the webview's `ready` handshake rather than on the
    // visibility event, so the cycle is hide→show→ready. The buffer-detach property under test is
    // unchanged; only the trigger moved.
    mockPanel.setVisible(false);
    await Promise.resolve();
    mockPanel.setVisible(true);
    mockPanel.fireMessage({ type: 'ready' });
    await Promise.resolve();

    const frames = mockPanel.posted.filter((m) => (m as { type: string }).type === 'frame') as Array<{ bytes: ArrayBuffer }>;
    expect(frames).toHaveLength(2);
    // Distinct buffers: VS Code TRANSFERS (detaches) the posted ArrayBuffer, so sharing one would throw.
    expect(frames[0]!.bytes).not.toBe(frames[1]!.bytes);
    expect(frames[0]!.bytes.byteLength).toBe(frames[1]!.bytes.byteLength);
    // And neither is a view onto the Buffer pool: the copy must be exactly the frame's bytes.
    expect(Buffer.from(frames[1]!.bytes).toString()).toBe('frame-88');
    service.dispose();
  });

  it('survives pushing the SAME Buffer twice — the detach regression guard', async () => {
    const service = await makeService();
    const { entry } = await addTab(service);
    const mockPanel = panelOf(entry);
    mockPanel.setVisible(true);
    // Buffer.from(base64) can be a VIEW into Node's shared 8KB pool, so a bare `bytes.buffer` would
    // post the whole pool (leaking neighbouring frames) and detach it for every other view.
    const shared = Buffer.from('frame-shared');
    expect(shared.byteLength).toBeLessThan(shared.buffer.byteLength + 1);

    entry.panel.pushFrame(shared, 640, 480, 1);
    expect(() => entry.panel.pushFrame(shared, 640, 480, 2)).not.toThrow();

    const frames = mockPanel.posted.filter((m) => (m as { type: string }).type === 'frame') as Array<{ bytes: ArrayBuffer }>;
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      // byteLength 0 would mean a detached buffer; a pool-sized buffer would mean a missing byteOffset.
      expect(frame.bytes.byteLength).toBe(shared.byteLength);
      expect(Buffer.from(frame.bytes).toString()).toBe('frame-shared');
    }
    service.dispose();
  });

  it('the webview drives the host ack when both halves run together', async () => {
    const service = await makeService();
    const { entry, ack } = await addTab(service);
    const mockPanel = panelOf(entry);
    mockPanel.setVisible(true);
    const h = mountWebview();
    // Bridge the real panel's posts into the real webview script, and its replies back to the host.
    const originalPost = mockPanel.webview.postMessage;
    mockPanel.webview.postMessage = (msg: unknown) => {
      const result = originalPost.call(mockPanel.webview, msg);
      window.dispatchEvent(new MessageEvent('message', { data: msg }));
      return result;
    };

    priv(service).onScreencastFrame(entry, cdpFrame(99));
    await vi.waitFor(() => expect(h.ctx2d.drawImage).toHaveBeenCalled());
    expect(ack).not.toHaveBeenCalled(); // not acked until it is actually on screen
    h.flushRaf();
    const rendered = h.posted.filter((m) => m['type'] === 'frameRendered')[0] as { frameId: number };
    mockPanel.fireMessage(rendered);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith(99);
    service.dispose();
  });
});

// ── Inviolable invariant + Slice 2 boundary ─────────────────────────────────────────────────────

describe('slice boundaries hold', () => {
  it('never asks Chromium to enable Runtime or Console across a real frame + resize cycle', async () => {
    // NOT via `addTab`: that helper spies out startScreencast/stopScreencast/ackScreencastFrame/
    // setViewport, so the controller never reaches its CDP session and `session.send` is called ZERO
    // times. An emptiness assertion over zero calls passes no matter what the code sends — this
    // guard would have stayed green with `Runtime.enable` on every frame, while claiming to protect
    // the project's single most important invariant.
    const service = await makeService();
    const page = fakePage('http://a');
    await priv(service).registerPage(page, BrowserService.PRIMARY_SCOPE_ID);
    const entry = priv(service).pages.get(page)! as TestEntry;
    const session = (entry as unknown as { session: { send: ReturnType<typeof vi.fn> } }).session;
    panelOf(entry).setVisible(true);

    priv(service).onScreencastFrame(entry, cdpFrame(1));
    priv(service).onFrameRendered(entry, entry.pendingAck!.frameId);
    await priv(service).resizeEntry(entry, 800, 600, 1);

    const methods = session.send.mock.calls.map((c) => c[0]) as string[];
    // POSITIVE CONTROL: the unspied controller really did drive the session, so the absences below
    // are statements about WHAT was sent rather than about an empty list.
    expect(methods.length).toBeGreaterThan(0);
    expect(methods).toContain('Page.startScreencast');
    expect(methods).toContain('Page.screencastFrameAck');
    expect(methods).not.toContain('Runtime.enable');
    expect(methods).not.toContain('Console.enable');
    service.dispose();
  });
});
