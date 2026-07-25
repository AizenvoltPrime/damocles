// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserService } from '../index';
import { BrowserPanel } from '../browser-panel';
import { BROWSER_WEBVIEW_SCRIPT } from '../browser-webview-script';
import { __webviewPanels, type FakeWebviewPanel } from 'vscode';

/**
 * Slice 2 acceptance suite — webview side: IME/dead-key/AltGr input (C2), mouse-capture unwinding
 * (C3) and the leaking overlay timer (C4).
 *
 * The SHIPPED `BROWSER_WEBVIEW_SCRIPT` is `new Function`-evaluated under happy-dom against the DOM
 * that the REAL `buildHtml` emits — the fixture is `BrowserPanel.show()`'s own html, not a
 * hand-written copy, so a markup/script drift (an id the script queries that buildHtml no longer
 * emits) fails these tests instead of shipping. Only the browser APIs happy-dom lacks (canvas 2d,
 * createImageBitmap, ResizeObserver) and the VS Code webview API are stubbed.
 *
 * Every `describe` maps to an acceptance bullet in the mission brief; the bullet is quoted on it.
 */

vi.mock('../launcher', () => ({ launchBrowserContext: vi.fn() }));

/** Canvas CSS size the harness pins, so coordinate math is exact and independent of happy-dom layout. */
const CANVAS_W = 800;
const CANVAS_H = 600;

// happy-dom hands every test in this file the SAME `window`/`document`, so each evaluated copy of the
// script would otherwise keep listening and react to the next test's events. Every mount records its
// listeners here and afterEach detaches them.
const mountedListeners: Array<[EventTarget, string, EventListenerOrEventListenerObject]> = [];

interface Harness {
  posted: Array<Record<string, unknown>>;
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
  urlInput: HTMLInputElement;
  /** Messages of one type, in order. */
  of: (type: string) => Array<Record<string, unknown>>;
  keys: () => Array<Record<string, unknown>>;
  flushRaf: () => void;
  send: (msg: Record<string, unknown>) => void;
  setViewport: (w: number, h: number) => void;
  clear: () => void;
}

/** The panel html the real buildHtml produces, minus its inline script (we evaluate that ourselves). */
function realPanelBody(): string {
  const panel = new BrowserPanel();
  panel.show('http://harness.test');
  const html = __webviewPanels[__webviewPanels.length - 1]!.webview.html;
  panel.dispose();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const script of [...doc.querySelectorAll('script')]) script.remove();
  return doc.body.innerHTML;
}

function mountWebview(): Harness {
  document.body.innerHTML = realPanelBody();

  const canvas = document.getElementById('screen') as HTMLCanvasElement;
  const overlay = document.getElementById('element-overlay') as HTMLElement;
  const urlInput = document.getElementById('url-input') as HTMLInputElement;
  const ctx2d = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn(), clearRect: vi.fn() };
  Object.defineProperty(canvas, 'getContext', { value: () => ctx2d, configurable: true });
  Object.defineProperty(canvas, 'clientWidth', { value: CANVAS_W, configurable: true });
  Object.defineProperty(canvas, 'clientHeight', { value: CANVAS_H, configurable: true });
  // happy-dom has no layout, so every rect is 0×0; pin the canvas at the viewport origin.
  Object.defineProperty(canvas, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, right: CANVAS_W, bottom: CANVAS_H, width: CANVAS_W, height: CANVAS_H, x: 0, y: 0 }),
    configurable: true,
  });

  const posted: Array<Record<string, unknown>> = [];
  const rafCbs: FrameRequestCallback[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  g['acquireVsCodeApi'] = () => ({
    postMessage: (m: Record<string, unknown>) => posted.push(m),
    getState: () => undefined,
    setState: () => {},
  });
  g['requestAnimationFrame'] = (cb: FrameRequestCallback) => rafCbs.push(cb);
  g['createImageBitmap'] = vi.fn(async () => ({ close: vi.fn() }));
  g['ResizeObserver'] = class {
    observe(): void {}
    disconnect(): void {}
  };

  // Capture the listeners this copy installs on the shared window/document so afterEach detaches them.
  const restores: Array<() => void> = [];
  for (const target of [window, document] as EventTarget[]) {
    const original = target.addEventListener.bind(target);
    const spy = vi.spyOn(target, 'addEventListener').mockImplementation(((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: unknown,
    ) => {
      mountedListeners.push([target, type, listener]);
      return original(type, listener as EventListener, options as never);
    }) as never);
    restores.push(() => spy.mockRestore());
  }

  new Function(BROWSER_WEBVIEW_SCRIPT)();
  for (const restore of restores) restore();

  const harness: Harness = {
    posted,
    canvas,
    overlay,
    urlInput,
    of: (type) => posted.filter((m) => m['type'] === type),
    keys: () => posted.filter((m) => m['type'] === 'key'),
    flushRaf: () => { for (const cb of rafCbs.splice(0)) cb(0); },
    send: (msg) => { window.dispatchEvent(new MessageEvent('message', { data: msg })); },
    setViewport: (w, h) => { harness.send({ type: 'viewport', width: w, height: h }); },
    clear: () => { posted.length = 0; },
  };
  return harness;
}

/** A KeyboardEvent with the read-only fields happy-dom's constructor ignores forced on. */
function keyEvent(
  type: 'keydown' | 'keyup',
  init: KeyboardEventInit & { isComposing?: boolean; keyCode?: number },
): KeyboardEvent {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  if (init.isComposing !== undefined) {
    Object.defineProperty(event, 'isComposing', { value: init.isComposing, configurable: true });
  }
  if (init.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: init.keyCode, configurable: true });
  }
  return event;
}

/** A CompositionEvent with `data` forced on (happy-dom's constructor drops it). */
function compositionEvent(type: 'compositionstart' | 'compositionupdate' | 'compositionend', data: string): Event {
  const Ctor = (globalThis as unknown as { CompositionEvent: typeof Event & (new (t: string, i?: object) => Event) })
    .CompositionEvent;
  const event = new Ctor(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'data', { value: data, configurable: true });
  return event;
}

function mouseEvent(type: string, init: MouseEventInit & { detail?: number }): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
}

/**
 * A WheelEvent carrying client coordinates. happy-dom's `WheelEvent extends UIEvent` and assigns only
 * the four delta fields, so `clientX`/`clientY` are dropped by the constructor and read back
 * `undefined` — a deviation from the DOM spec, where `WheelEvent extends MouseEvent`. Left undefined
 * they reach `screenCoords` as `undefined - rect.left`, and NaN propagates through `Math.min`/`Math.max`
 * so the clamp cannot pin it to 0, making the assertion test the harness instead of the clamp.
 */
function wheelEvent(init: { clientX: number; clientY: number; deltaY?: number; deltaMode?: number }): WheelEvent {
  const event = new WheelEvent('wheel', {
    deltaY: init.deltaY ?? 100,
    deltaMode: init.deltaMode ?? 0,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, 'clientX', { value: init.clientX, configurable: true });
  Object.defineProperty(event, 'clientY', { value: init.clientY, configurable: true });
  return event;
}

beforeEach(() => {
  __webviewPanels.length = 0;
});

afterEach(() => {
  for (const [target, type, listener] of mountedListeners.splice(0)) target.removeEventListener(type, listener);
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Acceptance: "A simulated IME composition sequence produces ONE insertText of the composed string
//    and ZERO per-keystroke key events." (C2) ──────────────────────────────────────────────────────

describe('C2 — IME composition', () => {
  /**
   * A real Windows/macOS IME sequence for typing 你好: every physical keystroke fires a `keydown`
   * whose `isComposing` is true (Chromium reports `key: 'Process'` for the ones the IME swallows),
   * interleaved with composition events, and the committed string arrives only on `compositionend`.
   */
  function typeWithIme(canvas: HTMLElement, composed: string): void {
    canvas.dispatchEvent(keyEvent('keydown', { key: 'n', code: 'KeyN', keyCode: 229, isComposing: false }));
    canvas.dispatchEvent(compositionEvent('compositionstart', ''));
    canvas.dispatchEvent(keyEvent('keydown', { key: 'Process', code: 'KeyI', keyCode: 229, isComposing: true }));
    canvas.dispatchEvent(compositionEvent('compositionupdate', 'ni'));
    canvas.dispatchEvent(keyEvent('keydown', { key: 'Process', code: 'KeyH', keyCode: 229, isComposing: true }));
    canvas.dispatchEvent(compositionEvent('compositionupdate', 'niha'));
    canvas.dispatchEvent(keyEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: true }));
    canvas.dispatchEvent(compositionEvent('compositionend', composed));
  }

  it('posts exactly ONE insertText of the composed string and ZERO key messages', () => {
    const h = mountWebview();

    typeWithIme(h.canvas, '你好');

    // The whole point of C2: pre-slice, every keydown was preventDefault'd and forwarded, so the IME
    // never received the keystrokes and CJK text could not be typed into the panel at all.
    expect(h.of('insertText')).toEqual([{ type: 'insertText', text: '你好' }]);
    expect(h.keys()).toEqual([]);
  });

  it('does not preventDefault the composing keydowns — the IME needs them', () => {
    const h = mountWebview();
    h.canvas.dispatchEvent(compositionEvent('compositionstart', ''));

    const composing = keyEvent('keydown', { key: 'Process', code: 'KeyA', keyCode: 229, isComposing: true });
    h.canvas.dispatchEvent(composing);

    // preventDefault here is exactly what stopped the IME candidate window from ever opening.
    expect(composing.defaultPrevented).toBe(false);
    expect(h.keys()).toEqual([]);
  });

  it('resumes normal key forwarding after the composition ends', () => {
    const h = mountWebview();
    typeWithIme(h.canvas, '你好');
    h.clear();

    h.canvas.dispatchEvent(keyEvent('keydown', { key: 'x', code: 'KeyX', keyCode: 88, isComposing: false }));

    // A composition must not wedge the panel into a permanent "swallow everything" state.
    expect(h.keys()).toHaveLength(1);
    expect(h.keys()[0]).toMatchObject({ key: 'x', text: 'x', phase: 'press' });
    expect(h.of('insertText')).toEqual([]);
  });

  it('posts nothing for an ABANDONED composition (compositionend with an empty string)', () => {
    const h = mountWebview();

    h.canvas.dispatchEvent(compositionEvent('compositionstart', ''));
    h.canvas.dispatchEvent(keyEvent('keydown', { key: 'Process', code: 'KeyA', keyCode: 229, isComposing: true }));
    h.canvas.dispatchEvent(compositionEvent('compositionend', ''));

    // The user pressed Escape and discarded the candidate; inserting '' would be a no-op CDP round trip.
    expect(h.of('insertText')).toEqual([]);
    expect(h.keys()).toEqual([]);
  });

  it('handles two consecutive compositions as two separate inserts', () => {
    const h = mountWebview();

    typeWithIme(h.canvas, '你好');
    typeWithIme(h.canvas, '世界');

    expect(h.of('insertText')).toEqual([
      { type: 'insertText', text: '你好' },
      { type: 'insertText', text: '世界' },
    ]);
    expect(h.keys()).toEqual([]);
  });

  it('never forwards a Dead key (the dead-key accent path)', () => {
    const h = mountWebview();

    // A dead key produces no character on its own; forwarding it makes the accent unproducible.
    h.canvas.dispatchEvent(keyEvent('keydown', { key: 'Dead', code: 'Quote', keyCode: 222 }));

    expect(h.keys()).toEqual([]);
  });

  it('never forwards a keydown whose isComposing is true, even without a composition event', () => {
    const h = mountWebview();

    h.canvas.dispatchEvent(keyEvent('keydown', { key: 'a', code: 'KeyA', keyCode: 229, isComposing: true }));

    expect(h.keys()).toEqual([]);
  });
});

// ── Acceptance: "an AltGr keydown (ctrlKey && altKey, printable key) forwards its character." (C2) ─

describe('C2 — AltGr produces its character', () => {
  it.each([['@', 'Digit2'], ['{', 'Digit7'], ['}', 'Digit0'], ['\\', 'Minus'], ['€', 'KeyE'], ['~', 'Digit4']])(
    'forwards %s typed with AltGr as text',
    (char, code) => {
      const h = mountWebview();

      // Windows reports AltGr as ctrlKey && altKey. The pre-slice `!e.altKey` guard dropped the
      // character silently, so these were unproducible on many European layouts.
      h.canvas.dispatchEvent(keyEvent('keydown', { key: char, code, ctrlKey: true, altKey: true, keyCode: 0 }));

      expect(h.keys()).toHaveLength(1);
      expect(h.keys()[0]).toMatchObject({ type: 'key', key: char, code, text: char, phase: 'press' });
    },
  );

  it('still sends NO text for a real Ctrl shortcut (Ctrl without Alt)', () => {
    const h = mountWebview();

    h.canvas.dispatchEvent(keyEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, keyCode: 65 }));

    // Ctrl+A must select-all in the page, not insert the letter "a".
    expect(h.keys()).toHaveLength(1);
    expect(h.keys()[0]).toMatchObject({ key: 'a', text: '', phase: 'press' });
  });

  it('sends NO text for a Meta shortcut', () => {
    const h = mountWebview();

    h.canvas.dispatchEvent(keyEvent('keydown', { key: 'a', code: 'KeyA', metaKey: true, keyCode: 65 }));

    expect(h.keys()[0]).toMatchObject({ text: '' });
  });

  it('sends text for a plain Alt+key (Alt alone is not a text-suppressing modifier here)', () => {
    const h = mountWebview();

    h.canvas.dispatchEvent(keyEvent('keydown', { key: 'ü', code: 'KeyU', altKey: true, keyCode: 0 }));

    expect(h.keys()[0]).toMatchObject({ text: 'ü' });
  });

  it('sends no text for a multi-character key name like ArrowLeft', () => {
    const h = mountWebview();

    h.canvas.dispatchEvent(keyEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }));

    expect(h.keys()[0]).toMatchObject({ key: 'ArrowLeft', text: '', phase: 'press' });
  });

  it('carries the CDP modifier bitmask (alt 1 | ctrl 2 | meta 4 | shift 8)', () => {
    const h = mountWebview();

    h.canvas.dispatchEvent(keyEvent('keydown', { key: '@', code: 'Digit2', ctrlKey: true, altKey: true, shiftKey: true }));

    expect(h.keys()[0]!['modifiers']).toBe(1 | 2 | 8);
  });
});

// ── Acceptance: "`Shift` alone does not produce a synthetic press+release pair." (C2) ─────────────

describe('C2 — modifier keys send a real down/up pair, not a synthetic one', () => {
  it.each([['Shift', 'ShiftLeft', 16], ['Control', 'ControlLeft', 17], ['Alt', 'AltLeft', 18], ['Meta', 'MetaLeft', 91]])(
    '%s posts one down on keydown and one up on the real keyup',
    (key, code, keyCode) => {
      const h = mountWebview();

      h.canvas.dispatchEvent(keyEvent('keydown', { key, code, keyCode }));
      const afterDown = h.keys().map((m) => m['phase']);
      h.canvas.dispatchEvent(keyEvent('keyup', { key, code, keyCode }));

      // Pre-slice, the host turned every key message into keyDown+keyUp immediately, so holding Shift
      // to shift-click released it before the click ever landed.
      expect(afterDown).toEqual(['down']);
      expect(h.keys().map((m) => m['phase'])).toEqual(['down', 'up']);
      expect(h.keys()[0]).toMatchObject({ type: 'key', key, code });
    },
  );

  it('posts NOTHING extra for an auto-repeated keydown while the modifier is held', () => {
    const h = mountWebview();

    h.canvas.dispatchEvent(keyEvent('keydown', { key: 'Shift', code: 'ShiftLeft', keyCode: 16 }));
    // Windows auto-repeats a held modifier's keydown; a stream of duplicate rawKeyDowns is exactly the
    // unnatural input signature this codebase avoids.
    for (let i = 0; i < 5; i++) {
      h.canvas.dispatchEvent(keyEvent('keydown', { key: 'Shift', code: 'ShiftLeft', keyCode: 16, repeat: true }));
    }

    expect(h.keys()).toHaveLength(1);
    expect(h.keys()[0]).toMatchObject({ phase: 'down' });
  });

  it('re-arms after release: press → release → press posts down, up, down', () => {
    const h = mountWebview();

    h.canvas.dispatchEvent(keyEvent('keydown', { key: 'Shift', code: 'ShiftLeft', keyCode: 16 }));
    h.canvas.dispatchEvent(keyEvent('keyup', { key: 'Shift', code: 'ShiftLeft', keyCode: 16 }));
    h.canvas.dispatchEvent(keyEvent('keydown', { key: 'Shift', code: 'ShiftLeft', keyCode: 16 }));

    expect(h.keys().map((m) => m['phase'])).toEqual(['down', 'up', 'down']);
  });

  it('tracks left and right modifiers independently — releasing one does not release the other', () => {
    const h = mountWebview();

    h.canvas.dispatchEvent(keyEvent('keydown', { key: 'Shift', code: 'ShiftLeft', keyCode: 16 }));
    h.canvas.dispatchEvent(keyEvent('keydown', { key: 'Shift', code: 'ShiftRight', keyCode: 16 }));
    h.canvas.dispatchEvent(keyEvent('keyup', { key: 'Shift', code: 'ShiftLeft', keyCode: 16 }));

    expect(h.keys().map((m) => [m['code'], m['phase']])).toEqual([
      ['ShiftLeft', 'down'],
      ['ShiftRight', 'down'],
      ['ShiftLeft', 'up'],
    ]);
  });

  it('posts NO keyup for a non-modifier key — its press already carried its release', () => {
    const h = mountWebview();

    h.canvas.dispatchEvent(keyEvent('keydown', { key: 'a', code: 'KeyA', keyCode: 65 }));
    h.canvas.dispatchEvent(keyEvent('keyup', { key: 'a', code: 'KeyA', keyCode: 65 }));

    // `phase: 'press'` already expands to keyDown+keyUp on the host; a second up would double-type.
    expect(h.keys().map((m) => m['phase'])).toEqual(['press']);
  });

  it('stamps a phase on EVERY key message — the field is required, never defaulted', () => {
    const h = mountWebview();

    h.canvas.dispatchEvent(keyEvent('keydown', { key: 'a', code: 'KeyA', keyCode: 65 }));
    h.canvas.dispatchEvent(keyEvent('keydown', { key: 'Shift', code: 'ShiftLeft', keyCode: 16 }));
    h.canvas.dispatchEvent(keyEvent('keyup', { key: 'Shift', code: 'ShiftLeft', keyCode: 16 }));
    h.canvas.dispatchEvent(keyEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13 }));

    expect(h.keys()).toHaveLength(4);
    for (const message of h.keys()) {
      expect(Object.keys(message)).toContain('phase');
      expect(['press', 'down', 'up']).toContain(message['phase']);
    }
  });

  it('keeps the url bar independent: typing there posts no key messages at all', () => {
    const h = mountWebview();

    h.urlInput.dispatchEvent(keyEvent('keydown', { key: 'a', code: 'KeyA', keyCode: 65 }));
    h.urlInput.dispatchEvent(keyEvent('keydown', { key: 'Shift', code: 'ShiftLeft', keyCode: 16 }));

    expect(h.keys()).toEqual([]);
  });
});

// ── Acceptance: "A drag leaving the canvas forwards UNCLAMPED coordinates, and a blur mid-drag
//    forwards a mouseReleased." (C3) ───────────────────────────────────────────────────────────────

describe('C3 — mouse capture unwinds correctly', () => {
  /** Press the button down on the canvas so the webview is in its dragging state. */
  function startDrag(h: Harness, clientX = 400, clientY = 300): void {
    h.canvas.dispatchEvent(mouseEvent('mousedown', { clientX, clientY, button: 0, buttons: 1, detail: 1 }));
  }

  it('forwards NEGATIVE coordinates when a drag leaves the canvas to the left/top', () => {
    const h = mountWebview();
    h.setViewport(CANVAS_W, CANVAS_H); // 1:1, so a client coord maps to the same page coord
    startDrag(h);
    h.clear();

    document.dispatchEvent(mouseEvent('mousemove', { clientX: -120, clientY: -60, buttons: 1 }));
    h.flushRaf();

    const move = h.of('mousemove')[0]!;
    // Clamped, the page saw the pointer pinned at (0,0) and every drag handler mis-tracked. The true
    // position is out of range BY DESIGN.
    expect(move['x'] as number).toBeLessThan(0);
    expect(move['y'] as number).toBeLessThan(0);
    expect(move).toMatchObject({ x: -120, y: -60 });
  });

  it('forwards coordinates PAST the far edge when a drag leaves right/bottom', () => {
    const h = mountWebview();
    h.setViewport(CANVAS_W, CANVAS_H);
    startDrag(h);
    h.clear();

    document.dispatchEvent(mouseEvent('mousemove', { clientX: CANVAS_W + 200, clientY: CANVAS_H + 90, buttons: 1 }));
    h.flushRaf();

    const move = h.of('mousemove')[0]!;
    expect(move['x'] as number).toBeGreaterThan(CANVAS_W - 1);
    expect(move['y'] as number).toBeGreaterThan(CANVAS_H - 1);
  });

  it('the final mouseup of a drag is unclamped too', () => {
    const h = mountWebview();
    h.setViewport(CANVAS_W, CANVAS_H);
    startDrag(h);
    h.clear();

    document.dispatchEvent(mouseEvent('mouseup', { clientX: -75, clientY: 320, button: 0, buttons: 0, detail: 1 }));

    expect(h.of('mouseup')[0]).toMatchObject({ x: -75 });
  });

  it('still CLAMPS a hover, a mousedown and a wheel — only a drag is unclamped', () => {
    const h = mountWebview();
    h.setViewport(CANVAS_W, CANVAS_H);

    h.canvas.dispatchEvent(mouseEvent('mousemove', { clientX: -50, clientY: -50, buttons: 0 }));
    h.flushRaf();
    h.canvas.dispatchEvent(mouseEvent('mousedown', { clientX: -50, clientY: -50, button: 0, buttons: 1, detail: 1 }));
    h.canvas.dispatchEvent(wheelEvent({ clientX: -50, clientY: -50 }));

    // A page must never receive a hover at a coordinate that is not inside it.
    expect(h.of('mousemove')[0]).toMatchObject({ x: 0, y: 0 });
    expect(h.of('mousedown')[0]).toMatchObject({ x: 0, y: 0 });
    expect(h.of('scroll')[0]).toMatchObject({ x: 0, y: 0 });
  });

  it('clamps a wheel past the FAR edge too, and still forwards the scroll delta', () => {
    const h = mountWebview();
    h.setViewport(CANVAS_W, CANVAS_H);

    h.canvas.dispatchEvent(wheelEvent({ clientX: CANVAS_W + 300, clientY: CANVAS_H + 300, deltaY: 120 }));

    // Clamped to the last addressable pixel, not the viewport count (which is one pixel outside).
    expect(h.of('scroll')[0]).toMatchObject({ x: CANVAS_W - 1, y: CANVAS_H - 1, deltaY: 120 });
  });

  it('a blur mid-drag forwards a mouseup so the page unwinds its drag state', () => {
    const h = mountWebview();
    h.setViewport(CANVAS_W, CANVAS_H);
    startDrag(h, 250, 150);
    h.clear();

    window.dispatchEvent(new Event('blur'));

    // Pre-slice, a mouseup landing outside the webview left mouseIsDown set forever and every later
    // move forwarded a phantom button-held event.
    expect(h.of('mouseup')).toHaveLength(1);
    expect(h.of('mouseup')[0]).toMatchObject({ type: 'mouseup', button: 0, buttons: 0 });
  });

  it('a document visibilitychange to hidden mid-drag forwards a mouseup too', () => {
    const h = mountWebview();
    h.setViewport(CANVAS_W, CANVAS_H);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    startDrag(h);
    h.clear();

    document.dispatchEvent(new Event('visibilitychange'));

    expect(h.of('mouseup')).toHaveLength(1);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('CLEARS the drag state on blur, so no phantom button-held move follows', () => {
    const h = mountWebview();
    h.setViewport(CANVAS_W, CANVAS_H);
    startDrag(h);
    window.dispatchEvent(new Event('blur'));
    h.clear();

    // The pointer keeps moving outside the canvas after the drag was unwound.
    document.dispatchEvent(mouseEvent('mousemove', { clientX: 900, clientY: 700, buttons: 1 }));
    h.flushRaf();

    expect(h.of('mousemove')).toEqual([]);
  });

  it('does NOT forward a spurious mouseup on blur when no drag is in progress', () => {
    const h = mountWebview();
    h.setViewport(CANVAS_W, CANVAS_H);
    // Prove the blur handler exists and fires at all, so the silence below is the mouseIsDown guard
    // and not simply an unhandled event.
    startDrag(h);
    window.dispatchEvent(new Event('blur'));
    expect(h.of('mouseup')).toHaveLength(1);
    h.clear();

    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('blur'));

    expect(h.of('mouseup')).toEqual([]);
  });

  it('forwards the LAST known position on the synthetic mouseup, not a zero', () => {
    const h = mountWebview();
    h.setViewport(CANVAS_W, CANVAS_H);
    startDrag(h, 100, 100);
    document.dispatchEvent(mouseEvent('mousemove', { clientX: 640, clientY: 480, buttons: 1 }));
    h.flushRaf();
    h.clear();

    window.dispatchEvent(new Event('blur'));

    // Releasing at (0,0) would look to the page like the pointer teleported to the corner first.
    expect(h.of('mouseup')[0]).toMatchObject({ x: 640, y: 480 });
  });

  it('a real mouseup already ends the drag, so a later blur adds nothing', () => {
    const h = mountWebview();
    h.setViewport(CANVAS_W, CANVAS_H);
    startDrag(h);
    document.dispatchEvent(mouseEvent('mouseup', { clientX: 300, clientY: 300, button: 0, buttons: 0, detail: 1 }));
    // The real mouseup was forwarded once; a blur must not duplicate it into a second release.
    expect(h.of('mouseup')).toHaveLength(1);
    h.clear();

    window.dispatchEvent(new Event('blur'));

    expect(h.of('mouseup')).toEqual([]);
  });
});

// ── Acceptance: "The overlay's nested 300ms timeout no longer leaks." (C4) ───────────────────────

describe('C4 — the overlay fade timer cannot hide a freshly shown overlay', () => {
  const elementInfo = (selector: string) => ({
    type: 'elementInfo',
    info: { selector, tagName: 'DIV', boundingBox: { x: 10, y: 20, width: 100, height: 40 }, padding: '0px' },
  });

  it('a LATE nested fire does not hide an overlay shown after it was armed', () => {
    vi.useFakeTimers();
    const h = mountWebview();
    h.setViewport(CANVAS_W, CANVAS_H);

    h.send(elementInfo('#first'));
    h.flushRaf();
    // t+3000: the outer timer fires, adds `fading`, and arms the nested 300ms hide.
    vi.advanceTimersByTime(3_000);
    expect(h.overlay.classList.contains('fading')).toBe(true);

    // t+3100: a new element is picked. The nested hide from the FIRST overlay is still pending.
    vi.advanceTimersByTime(100);
    h.send(elementInfo('#second'));
    h.flushRaf();
    expect(h.overlay.classList.contains('visible')).toBe(true);

    // t+3400: the orphaned nested timer would have fired here.
    vi.advanceTimersByTime(300);

    expect(h.overlay.classList.contains('visible')).toBe(true);
    expect(h.overlay.classList.contains('fading')).toBe(false);
    expect(h.overlay.style.display).toBe('block');
    expect(h.overlay.textContent).toContain('#second');
  });

  it('still hides normally when nothing supersedes it (the fix does not disable the fade)', () => {
    vi.useFakeTimers();
    const h = mountWebview();
    h.setViewport(CANVAS_W, CANVAS_H);

    h.send(elementInfo('#only'));
    h.flushRaf();
    // Shown first, so "hidden at the end" is a real transition rather than an overlay that never
    // appeared — the failure mode a clearing bug would otherwise hide behind.
    expect(h.overlay.classList.contains('visible')).toBe(true);
    vi.advanceTimersByTime(3_000);
    expect(h.overlay.classList.contains('fading')).toBe(true);
    vi.advanceTimersByTime(300);

    expect(h.overlay.classList.contains('visible')).toBe(false);
    expect(h.overlay.style.display).toBe('none');
  });

  it('a burst of picks leaves exactly one live fade, which still completes', () => {
    vi.useFakeTimers();
    const h = mountWebview();
    h.setViewport(CANVAS_W, CANVAS_H);

    for (const selector of ['#a', '#b', '#c', '#d']) {
      h.send(elementInfo(selector));
      h.flushRaf();
      vi.advanceTimersByTime(3_100);
    }
    expect(h.overlay.classList.contains('visible')).toBe(true);
    vi.advanceTimersByTime(3_000 + 300);

    expect(h.overlay.style.display).toBe('none');
  });
});

// ── Security regression guard: `escapeHtml(info.selector)` is LOAD-BEARING ───────────────────────

describe('the element-overlay selector escape survives the rewrite', () => {
  it('renders a hostile selector as TEXT, never as markup', () => {
    const h = mountWebview();
    h.setViewport(CANVAS_W, CANVAS_H);
    // `selector` is built from raw page `id`/`class` values and lands in innerHTML, so a page that
    // names an element `<img src=x onerror=...>` would otherwise get script into the webview.
    const hostile = '<img src=x onerror=alert(1)>&<b>';

    h.send({
      type: 'elementInfo',
      info: { selector: hostile, tagName: 'DIV', boundingBox: { x: 0, y: 0, width: 10, height: 10 }, padding: '' },
    });

    expect(h.overlay.querySelector('img')).toBeNull();
    expect(h.overlay.querySelector('b')).toBeNull();
    expect(h.overlay.querySelector('.selector')!.textContent).toBe(hostile);
  });

  it('the script still calls escapeHtml on the selector', () => {
    expect(BROWSER_WEBVIEW_SCRIPT).toContain('escapeHtml(info.selector)');
  });
});

// ── Acceptance: "A mousedown at a known client coordinate maps to the expected PAGE coordinate
//    immediately after a re-show (proves the viewport was replayed before input)." ────────────────

describe('a mousedown right after a re-show lands on the correct page coordinate', () => {
  type TestEntry = {
    page: unknown;
    panel: BrowserPanel;
    controller: { startScreencast: () => Promise<void>; stopScreencast: () => Promise<void>; setViewport: () => Promise<void>; ackScreencastFrame: () => Promise<void>; dispatchMouseEvent: (t: string, x: number, y: number, o?: unknown) => Promise<void> };
    viewport: { width: number; height: number; dpr: number };
    lastUrl: string | null;
    picker: { isPicking: boolean };
  };
  type Priv = {
    context: unknown;
    state: string;
    pages: Map<unknown, TestEntry>;
    registerPage: (p: unknown, s?: string) => Promise<TestEntry | null>;
  };

  it('uses the REPLAYED viewport, not the webview default, for the very first click', async () => {
    // End-to-end across both layers: the real BrowserService resyncs a real BrowserPanel, whose posts
    // are bridged into the real webview script, whose mousedown is bridged back to the host.
    const service = new BrowserService();
    const priv = service as unknown as Priv;
    priv.context = {
      newCDPSession: async () => ({ on: () => {}, send: vi.fn(async () => ({})), detach: async () => {} }),
      close: async () => {},
    };
    priv.state = 'connected';
    const page = { on: () => {}, url: () => 'http://a', close: async () => {}, opener: async () => null };
    await priv.registerPage(page, BrowserService.PRIMARY_SCOPE_ID);
    const entry = priv.pages.get(page)!;
    vi.spyOn(entry.controller, 'startScreencast').mockImplementation(async () => {});
    vi.spyOn(entry.controller, 'stopScreencast').mockImplementation(async () => {});
    const dispatch = vi.spyOn(entry.controller, 'dispatchMouseEvent').mockImplementation(async () => {});
    // The page is 1600×1200 — deliberately NOT the webview's 1920×1080 boot default, so a click that
    // lands correctly proves the viewport was replayed rather than defaulted.
    entry.viewport = { width: 1600, height: 1200, dpr: 1 };
    entry.lastUrl = 'http://a';

    const mockPanel = (entry.panel as unknown as { panel: FakeWebviewPanel }).panel;
    mockPanel.setVisible(true);
    mockPanel.fireMessage({ type: 'ready' });
    mockPanel.setVisible(false);
    await Promise.resolve();

    // The tab comes back: VS Code builds a FRESH webview, which boots at 1920×1080.
    mockPanel.setVisible(true);
    const h = mountWebview();
    const originalPost = mockPanel.webview.postMessage;
    mockPanel.webview.postMessage = (msg: unknown) => {
      const result = originalPost.call(mockPanel.webview, msg);
      window.dispatchEvent(new MessageEvent('message', { data: msg }));
      return result;
    };

    mockPanel.fireMessage({ type: 'ready' });
    // The human clicks immediately, before any live frame has arrived.
    h.canvas.dispatchEvent(mouseEvent('mousedown', { clientX: 200, clientY: 150, button: 0, buttons: 1, detail: 1 }));
    const down = h.of('mousedown')[0]!;
    mockPanel.fireMessage(down);
    await Promise.resolve();

    // canvas 800×600 showing a 1600×1200 page: contain-fit scale 0.5, no letterbox, so client×2.
    expect(down).toMatchObject({ x: 400, y: 300 });
    expect(dispatch).toHaveBeenCalledWith('mousePressed', 400, 300, expect.anything());
    service.dispose();
  });
});

// ── The ready handshake itself (contract §A) ─────────────────────────────────────────────────────

describe('the ready handshake', () => {
  it('is posted exactly once per mount', () => {
    const h = mountWebview();

    expect(h.of('ready')).toEqual([{ type: 'ready' }]);
  });

  it('is the LAST statement of the script, after every listener is attached', () => {
    const h = mountWebview();

    // Verified behaviourally, not by reading the source: a frame delivered on the very next tick is
    // handled, which is only true if the message listener was attached before `ready` went out.
    expect(h.posted[h.posted.length - 1]).toEqual({ type: 'ready' });
    h.send({ type: 'urlChanged', url: 'http://after-ready' });
    expect(h.urlInput.value).toBe('http://after-ready');
  });

  it('carries no payload', () => {
    const h = mountWebview();

    expect(Object.keys(h.of('ready')[0]!)).toEqual(['type']);
  });
});

// ── Slice 1 regression guards that this slice must not break ─────────────────────────────────────

describe('Slice 1 behaviour is untouched', () => {
  it('the script still contains no backtick and no ${ (buildHtml interpolates it into a template)', () => {
    expect(BROWSER_WEBVIEW_SCRIPT).not.toContain('`');
    expect(BROWSER_WEBVIEW_SCRIPT).not.toContain('${');
  });

  it('still has no atob and no charCodeAt byte loop', () => {
    expect(BROWSER_WEBVIEW_SCRIPT).not.toMatch(/\batob\b/);
    expect(BROWSER_WEBVIEW_SCRIPT).not.toMatch(/charCodeAt/);
  });

  it('every element id the script queries is still emitted by buildHtml', () => {
    const h = mountWebview();

    // A null here would throw inside the script on mount; asserting explicitly names the culprit.
    for (const id of ['screen', 'placeholder', 'url-input', 'btn-back', 'btn-forward', 'btn-reload',
      'btn-pick', 'btn-devtools', 'btn-newtab', 'content-area', 'element-overlay']) {
      expect(`${id}:${document.getElementById(id) !== null}`).toBe(`${id}:true`);
    }
    expect(h.of('ready')).toHaveLength(1); // it mounted cleanly, so no query threw
  });

  it('the toolbar buttons still post their messages', () => {
    const h = mountWebview();

    for (const id of ['btn-back', 'btn-forward', 'btn-reload', 'btn-pick', 'btn-devtools', 'btn-newtab']) {
      document.getElementById(id)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    expect(h.posted.map((m) => m['type'])).toEqual(
      expect.arrayContaining(['goBack', 'goForward', 'reload', 'pickElement', 'openDevTools', 'tabNew']),
    );
  });
});
