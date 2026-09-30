// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildCursorObserverScript,
  buildTitleObserverScript,
  buildConsoleBridgeScript,
  createBindingName,
  isolatedBridgeInstaller,
} from '../page-scripts';

/**
 * Unit suite for the in-page scripts.
 *
 * These tests EXECUTE the real built script strings in happy-dom rather than pattern-matching their
 * text — a regex over source proves nothing about behaviour.
 *
 * ── WHAT THIS SUITE CANNOT PROVE, AND WHY THAT MATTERS ─────────────────────────────────────────
 * happy-dom has ONE world. The bridge exists precisely because Chrome has two: the observers run in
 * the page's MAIN world and Playwright's binding exists only in the ISOLATED world. So this file can
 * prove the main-world half dispatches correctly and the isolated-world half forwards correctly, but
 * it CANNOT prove they meet across a real world boundary. The previous version of this suite passed
 * green against a bridge that was dead in every real browser, for exactly that reason.
 *
 * The world-crossing claim is therefore owned by `patchright-launch.integration.test.ts`, which
 * navigates (the binding is only main-world-visible on the initial about:blank) and covers `data:`
 * as well as `http:`. Treat a green run here as necessary, never sufficient.
 *
 * ── happy-dom fidelity, measured (not assumed) ──────────────────────────────────────────────────
 *  - `Function.prototype.toString.call(<Proxy over a native fn>)` → `[native code]`, and the Proxy
 *    preserves `.name`. So the stealth criterion IS expressible here.                    [FAITHFUL]
 *  - `ErrorEvent` carries message/filename/lineno/colno/error.                           [FAITHFUL]
 *  - `CustomEvent` + `document.dispatchEvent` behave as in Chrome.                       [FAITHFUL]
 *  - `PromiseRejectionEvent` is NOT a constructor in happy-dom, so the unhandled-rejection test
 *    dispatches a plain `Event('unhandledrejection')` with `.reason` assigned, which is what the
 *    bridge's listener actually reads.                                          [WORKAROUND, noted]
 *
 * ── The standard every negative assertion is held to ────────────────────────────────────────────
 * A "the value is absent / the count is bounded" assertion is worthless alone — a dead bridge
 * satisfies all of them. Every such test carries a POSITIVE CONTROL proving the harness observes a
 * LIVE bridge.
 */

type Spy = ReturnType<typeof vi.fn>;
type Mutable = Record<string, unknown>;

const g = globalThis as unknown as Mutable;

/** Names installed on the global by a test, cleaned up in afterEach. */
const installedNames: string[] = [];
/** Once-guard registry keys installed as global symbols, cleaned up in afterEach. */
const installedGuardKeys: string[] = [];

/** Execute a built script string for real. The builders emit a self-invoking IIFE statement. */
function runScript(source: string): void {
  new Function(source)();
}

/**
 * The three independent per-launch names one bridge uses. Independent BY DESIGN — deriving any from
 * another means whatever a page recovers leaks the rest — so a test that reuses one for another is
 * testing a bridge production never builds.
 */
function newBridgeNames(): { channel: string; binding: string; guardKey: string } {
  const guardKey = createBindingName();
  installedGuardKeys.push(guardKey);
  return { channel: createBindingName(), binding: createBindingName(), guardKey };
}

/**
 * Stand in for the ISOLATED world: install the real forwarder and point it at a spy, exactly as
 * `installContextObservers` does via `page.evaluate`. In Chrome this half runs in a different world;
 * here it necessarily shares one, which is the fidelity limit documented above.
 */
function installIsolatedHalf(names: { channel: string; binding: string; guardKey: string }): Spy {
  const spy = vi.fn();
  g[names.binding] = spy;
  installedNames.push(names.binding, `${names.guardKey}_installed`);
  isolatedBridgeInstaller()(names);
  return spy;
}

/**
 * Start a bridge in PRODUCTION ORDER: the main-world init script runs first (it is injected at
 * document_start), then the isolated-world installer (a `page.evaluate`, which can only run once the
 * document is committed). Getting this order wrong in a test proves nothing about production.
 */
function startBridge(scriptSource: string, names: { channel: string; binding: string; guardKey: string }): Spy {
  runScript(scriptSource);
  return installIsolatedHalf(names);
}

/**
 * Every message the binding has received, unwrapped from its envelope.
 *
 * The envelope (`doc`/`seq`) is what makes replay safe: the main world re-dispatches its buffer on
 * every `_ready`, and the HOST drops anything it has already seen. `installContextObservers` owns that
 * dedup, so this helper reproduces it — a test asserting on raw deliveries would be asserting on the
 * wire, not on what a collector receives.
 */
function messagesOf(spy: Spy): Array<{ kind: string; value: unknown }> {
  const lastSeqByDoc = new Map<string, number>();
  const out: Array<{ kind: string; value: unknown }> = [];
  for (const call of spy.mock.calls) {
    const envelope = JSON.parse(String(call[0])) as { doc: string; seq: number; kind: string; value: unknown };
    const seen = lastSeqByDoc.get(envelope.doc);
    if (seen !== undefined && envelope.seq <= seen) continue;
    lastSeqByDoc.set(envelope.doc, envelope.seq);
    out.push({ kind: envelope.kind, value: envelope.value });
  }
  return out;
}

/** Every `{ level, text }` console entry delivered so far, across all flushes. */
function consoleEntriesOf(spy: Spy): Array<{ level: string; text: string }> {
  return messagesOf(spy)
    .filter((m) => m.kind === 'console')
    .flatMap((m) => m.value as Array<{ level: string; text: string }>);
}

let originalConsole: Record<string, unknown>;

beforeEach(() => {
  originalConsole = { ...(console as unknown as Record<string, unknown>) };
});

afterEach(() => {
  vi.useRealTimers();
  for (const name of installedNames) delete g[name];
  installedNames.length = 0;
  // The once-guard registry hangs off a global Symbol.for key. happy-dom keeps ONE realm across tests,
  // whereas production gets a fresh one per document, so it must be cleared explicitly or the second
  // test using a key would see the first test's guard.
  for (const key of installedGuardKeys) delete g[Symbol.for(key) as unknown as string];
  installedGuardKeys.length = 0;
  Object.assign(console, originalConsole);
  document.title = '';
});

describe('createBindingName', () => {
  it('is random per call and carries nothing attributable to Damocles', () => {
    const a = createBindingName();
    const b = createBindingName();
    expect(a).not.toBe(b);
    for (const name of [a, b]) {
      expect(name).toMatch(/^__[0-9a-f]{16}$/);
      expect(name.toLowerCase()).not.toContain('damocles');
    }
  });

  it('appears in NO built script under a fixed, greppable name', () => {
    const names = newBridgeNames();
    for (const src of [
      buildCursorObserverScript(names.channel, names.guardKey),
      buildTitleObserverScript(names.channel, names.guardKey),
      buildConsoleBridgeScript(names.channel, names.guardKey),
    ]) {
      expect(src.toLowerCase()).not.toContain('damocles');
      // POSITIVE CONTROL: the script really was built with these names, so the absence above is a
      // statement about naming rather than about an empty string.
      expect(src).toContain(names.channel);
      expect(src).toContain(names.guardKey);
    }
  });

  it('derives the once-guard key from NOTHING the page can trade for the channel', () => {
    const names = newBridgeNames();
    // The guard registry key is the one bridge name a page can enumerate, via
    // Object.getOwnPropertySymbols(globalThis). If it contained the channel, reading it would hand the
    // page the channel and let it dispatch forged payloads straight at the isolated listener.
    expect(names.guardKey).not.toContain(names.channel);
    expect(names.guardKey).not.toContain(names.binding);
    runScript(buildConsoleBridgeScript(names.channel, names.guardKey));
    const symbols = Object.getOwnPropertySymbols(globalThis).map((s) => s.description ?? '');
    // POSITIVE CONTROL: the guard symbol really is on the global, so the absence of the channel below
    // is a statement about what it carries rather than about an empty list.
    expect(symbols).toContain(names.guardKey);
    for (const description of symbols) expect(description).not.toContain(names.channel);
    // And no STRING global names the channel either — a string key is reachable via
    // Object.getOwnPropertyNames no matter how it was defined.
    for (const name of Object.getOwnPropertyNames(globalThis)) expect(name).not.toContain(names.channel);
  });
});

describe('cross-world bridge', () => {
  it('forwards a main-world dispatch to the binding', () => {
    const names = newBridgeNames();
    const spy = installIsolatedHalf(names);

    document.dispatchEvent(new CustomEvent(names.channel, { detail: JSON.stringify({ kind: 'title', value: 'x' }) }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(messagesOf(spy)[0]).toEqual({ kind: 'title', value: 'x' });
  });

  it('is idempotent: a second install does not double-deliver', () => {
    const names = newBridgeNames();
    const spy = installIsolatedHalf(names);
    isolatedBridgeInstaller()(names);

    document.dispatchEvent(new CustomEvent(names.channel, { detail: JSON.stringify({ kind: 'title', value: 'y' }) }));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('ignores a non-string detail rather than passing a page-controlled object through', () => {
    const names = newBridgeNames();
    const spy = installIsolatedHalf(names);

    document.dispatchEvent(new CustomEvent(names.channel, { detail: { kind: 'title', value: 'z' } }));
    expect(spy).not.toHaveBeenCalled();
    // POSITIVE CONTROL: the listener is live and would have fired for a well-formed payload.
    document.dispatchEvent(new CustomEvent(names.channel, { detail: JSON.stringify({ kind: 'title', value: 'z' }) }));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('resolves the binding per event, so a binding installed LATE still receives', () => {
    const names = newBridgeNames();
    installedNames.push(names.binding, `${names.guardKey}_installed`);
    // Install the listener with NO binding present — the ordering Playwright actually produces.
    isolatedBridgeInstaller()(names);
    document.dispatchEvent(new CustomEvent(names.channel, { detail: JSON.stringify({ kind: 'title', value: 'early' }) }));

    const spy = vi.fn();
    g[names.binding] = spy;
    document.dispatchEvent(new CustomEvent(names.channel, { detail: JSON.stringify({ kind: 'title', value: 'late' }) }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(messagesOf(spy)[0]).toEqual({ kind: 'title', value: 'late' });
  });
});

describe('double injection (Patchright runs every init script TWICE per document)', () => {
  it('installs the console bridge only once, so one console.log yields ONE entry', () => {
    const names = newBridgeNames();

    vi.useFakeTimers();
    // Execute the SAME built script twice, exactly as Patchright does: doAddInitScript registers it
    // and pushes it onto page.initScripts, then _initSession iterates both script lists.
    const source = buildConsoleBridgeScript(names.channel, names.guardKey);
    runScript(source);
    runScript(source);
    const spy = installIsolatedHalf(names);

    console.log('logged once');
    vi.advanceTimersByTime(150);

    const entries = consoleEntriesOf(spy);
    expect(entries.filter((e) => e.text === 'logged once')).toHaveLength(1);
    // POSITIVE CONTROL: the entry really is captured, so the count above is de-duplication rather
    // than a guard that suppressed the bridge outright.
    expect(entries).toHaveLength(1);
  });

  it('serializes a logged object ONCE — two wrappers would read every getter twice', () => {
    const names = newBridgeNames();

    vi.useFakeTimers();
    const source = buildConsoleBridgeScript(names.channel, names.guardKey);
    runScript(source);
    runScript(source);
    installIsolatedHalf(names);

    let reads = 0;
    console.log({ get probe(): number { reads++; return 1; } });
    vi.advanceTimersByTime(150);

    // This is the assertion that actually distinguishes one wrapper from two: a second wrapper has
    // its OWN closure state, so it serializes the same object again and the getter fires twice.
    expect(reads).toBe(1);
  });

  it('guards each observer INDEPENDENTLY, so sharing one channel does not suppress the others', () => {
    const names = newBridgeNames();

    // Production order: main-world scripts at document_start, isolated half afterwards.
    document.title = 'guarded';
    runScript(buildConsoleBridgeScript(names.channel, names.guardKey));
    runScript(buildTitleObserverScript(names.channel, names.guardKey));
    const spy = installIsolatedHalf(names);

    // A per-channel marker would have let the console script block the title observer entirely.
    const titles = messagesOf(spy).filter((m) => m.kind === 'title').map((m) => m.value);
    expect(titles).toEqual(['guarded']);
  });
});

describe('a hostile page cannot kill or forge the bridge', () => {
  /**
   * EVERY MAIN↔ISOLATED SIGNAL IS PAGE-FORGEABLE — the two worlds share only the DOM, and any DOM
   * signal is something the page can dispatch itself. So the design goal is not "the page cannot
   * forge" but "forgery is harmless": the host validates and bounds everything, and the main world
   * replays rather than gating on a one-shot handshake.
   */
  it('survives a forged _ready dispatched at document_start', () => {
    const names = newBridgeNames();
    vi.useFakeTimers();
    runScript(buildConsoleBridgeScript(names.channel, names.guardKey));

    // The page fires the handshake itself, before any listener exists. Under the one-shot gate this
    // flipped `listening` and drained the queue into an event nobody heard — killing the console
    // bridge permanently and silently, with no host-side signal at all.
    document.dispatchEvent(new CustomEvent(`${names.channel}_ready`));
    console.log('logged after the forged ready');
    vi.advanceTimersByTime(200);

    const spy = installIsolatedHalf(names);
    const entries = consoleEntriesOf(spy);
    expect(entries.map((e) => e.text)).toContain('logged after the forged ready');
    // Replayed, not duplicated: the envelope's doc/seq is what the host dedups on.
    expect(entries.filter((e) => e.text === 'logged after the forged ready')).toHaveLength(1);
  });

  it('keeps delivering after a burst of forged _ready events', () => {
    const names = newBridgeNames();
    vi.useFakeTimers();
    runScript(buildConsoleBridgeScript(names.channel, names.guardKey));
    const spy = installIsolatedHalf(names);

    for (let i = 0; i < 20; i++) document.dispatchEvent(new CustomEvent(`${names.channel}_ready`));
    console.log('still alive');
    vi.advanceTimersByTime(200);

    const entries = consoleEntriesOf(spy);
    expect(entries.filter((e) => e.text === 'still alive')).toHaveLength(1);
  });

  it('cannot suppress an observer by pre-seeding the guard registry with a plausible name', () => {
    const names = newBridgeNames();
    // A page that guessed the marker naming rule would pre-set it and silence us. The registry key is
    // per-launch random and independent of the channel, so there is nothing to guess from.
    (g as Mutable)[Symbol.for(`${names.channel}_console`) as unknown as string] = { console: true };
    (g as Mutable)[`${names.channel}_console`] = true;
    installedNames.push(`${names.channel}_console`);

    vi.useFakeTimers();
    runScript(buildConsoleBridgeScript(names.channel, names.guardKey));
    const spy = installIsolatedHalf(names);
    console.log('not suppressed');
    vi.advanceTimersByTime(200);

    expect(consoleEntriesOf(spy).map((e) => e.text)).toContain('not suppressed');
  });
});

describe('main-world queue handshake', () => {
  it('holds entries emitted BEFORE the isolated listener exists, then delivers them once', () => {
    const names = newBridgeNames();

    // Main world first, with nothing listening yet.
    vi.useFakeTimers();
    runScript(buildConsoleBridgeScript(names.channel, names.guardKey));
    console.log('logged before the listener existed');
    vi.advanceTimersByTime(200);

    // Now the isolated half arrives (as it does after a navigation).
    const spy = installIsolatedHalf(names);

    const entries = consoleEntriesOf(spy);
    expect(entries.some((e) => e.text === 'logged before the listener existed')).toBe(true);
    // Delivered EXACTLY once — a naive drain-plus-live-emit duplicated every early entry.
    expect(entries.filter((e) => e.text === 'logged before the listener existed')).toHaveLength(1);
  });
});

describe('console bridge', () => {
  it('delivers level and text for each console method', () => {
    const names = newBridgeNames();
    vi.useFakeTimers();
    const spy = startBridge(buildConsoleBridgeScript(names.channel, names.guardKey), names);

    console.log('a log');
    console.warn('a warn');
    console.error('an error');
    vi.advanceTimersByTime(150);

    const entries = consoleEntriesOf(spy);
    expect(entries).toEqual([
      { level: 'log', text: 'a log' },
      { level: 'warn', text: 'a warn' },
      { level: 'error', text: 'an error' },
    ]);
  });

  it('batches a burst into ONE message per 100ms window', () => {
    const names = newBridgeNames();
    vi.useFakeTimers();
    const spy = startBridge(buildConsoleBridgeScript(names.channel, names.guardKey), names);

    for (let i = 0; i < 5; i++) console.log(`burst ${i}`);
    vi.advanceTimersByTime(150);
    expect(spy).toHaveBeenCalledTimes(1);

    // POSITIVE CONTROL: a SECOND burst produces exactly one more message, so the count above is a
    // batching property rather than a bridge that stopped after its first delivery.
    for (let i = 0; i < 5; i++) console.log(`second ${i}`);
    vi.advanceTimersByTime(150);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(consoleEntriesOf(spy)).toHaveLength(10);
  });

  it('caps the queue at 50 and reports the overflow explicitly', () => {
    const names = newBridgeNames();
    vi.useFakeTimers();
    const spy = startBridge(buildConsoleBridgeScript(names.channel, names.guardKey), names);

    for (let i = 0; i < 60; i++) console.log(`msg ${i}`);
    vi.advanceTimersByTime(150);

    const entries = consoleEntriesOf(spy);
    const marker = entries.filter((e) => /\(\d+ console messages dropped\)/.test(e.text));
    expect(marker).toHaveLength(1);
    expect(marker[0]!.text).toBe('(10 console messages dropped)');
    // 50 real entries + 1 honest marker — bounded, never silently lossy.
    expect(entries).toHaveLength(51);
  });

  it('reports an uncaught error with its source location', () => {
    const names = newBridgeNames();
    vi.useFakeTimers();
    const spy = startBridge(buildConsoleBridgeScript(names.channel, names.guardKey), names);

    window.dispatchEvent(new ErrorEvent('error', {
      message: 'boom', filename: 'http://x/app.js', lineno: 12, colno: 34,
    }));
    vi.advanceTimersByTime(150);

    const entries = consoleEntriesOf(spy);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe('error');
    expect(entries[0]!.text).toContain('boom');
    expect(entries[0]!.text).toContain('http://x/app.js:12:34');
  });

  it('reports an unhandled rejection', () => {
    const names = newBridgeNames();
    vi.useFakeTimers();
    const spy = startBridge(buildConsoleBridgeScript(names.channel, names.guardKey), names);

    // happy-dom has no PromiseRejectionEvent constructor; the listener reads `.reason`.
    const event = new Event('unhandledrejection') as Event & { reason?: unknown };
    event.reason = 'nope';
    window.dispatchEvent(event);
    vi.advanceTimersByTime(150);

    const entries = consoleEntriesOf(spy);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe('Unhandled promise rejection: nope');
  });

  it('keeps console.log looking native and does NOT patch Function.prototype.toString', () => {
    const names = newBridgeNames();
    runScript(buildConsoleBridgeScript(names.channel, names.guardKey));

    expect(Function.prototype.toString.call(console.log)).toContain('[native code]');
    expect(console.log.name).toBe('log');
    // Patching Function.prototype.toString is itself a classic detection tell.
    expect(Function.prototype.toString.toString()).toContain('[native code]');
  });

  it('still calls through to the original console method', () => {
    const names = newBridgeNames();
    const original = vi.fn();
    (console as unknown as Mutable)['log'] = original;
    runScript(buildConsoleBridgeScript(names.channel, names.guardKey));

    console.log('passthrough');
    expect(original).toHaveBeenCalledWith('passthrough');
  });

  it('bounds a single entry and survives an unserializable argument', () => {
    const names = newBridgeNames();
    vi.useFakeTimers();
    const spy = startBridge(buildConsoleBridgeScript(names.channel, names.guardKey), names);

    console.log('x'.repeat(5000));
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    console.log(circular);
    const thrower = { get boom(): never { throw new Error('getter'); } };
    console.log(thrower);
    vi.advanceTimersByTime(150);

    const entries = consoleEntriesOf(spy);
    expect(entries).toHaveLength(3);
    // Bounded AND marked. An unmarked cut reads to the model as the page's complete output, so it
    // concludes the log ended where the buffer did — the payload is bounded and the reader is misled.
    expect(entries[0]!.text.startsWith('x'.repeat(2000))).toBe(true);
    expect(entries[0]!.text).toContain('truncated');
    expect(entries[0]!.text.length).toBeLessThan(2050);
    expect(entries[1]!.text).toContain('[Circular]');
    // A throwing getter must not kill the bridge — the entry still lands.
    expect(entries[2]).toBeDefined();
  });
});

describe('title observer', () => {
  it('reports the title once per change', () => {
    const names = newBridgeNames();
    document.title = 'first';
    const spy = startBridge(buildTitleObserverScript(names.channel, names.guardKey), names);

    const titles = (): unknown[] => messagesOf(spy).filter((m) => m.kind === 'title').map((m) => m.value);
    expect(titles()).toEqual(['first']);

    // An unchanged title is NOT re-reported.
    document.dispatchEvent(new Event('x'));
    expect(titles()).toEqual(['first']);
  });
});

describe('cursor observer', () => {
  it('reports a pointer cursor for an anchor and does not repeat an unchanged value', async () => {
    const names = newBridgeNames();
    const spy = startBridge(buildCursorObserverScript(names.channel, names.guardKey), names);

    const anchor = document.createElement('a');
    anchor.href = 'http://example.test';
    document.body.appendChild(anchor);

    const move = (target: Element): void => {
      const event = new Event('mousemove') as Event & { target?: unknown };
      Object.defineProperty(event, 'target', { value: target, configurable: true });
      document.dispatchEvent(event);
    };

    move(anchor);
    await new Promise((r) => setTimeout(r, 50));
    const cursors = (): unknown[] => messagesOf(spy).filter((m) => m.kind === 'cursor').map((m) => m.value);
    expect(cursors()).toEqual(['pointer']);

    // Same element again → suppressed (change-driven, so hover costs nothing while static).
    move(anchor);
    await new Promise((r) => setTimeout(r, 50));
    expect(cursors()).toEqual(['pointer']);
  });
});
