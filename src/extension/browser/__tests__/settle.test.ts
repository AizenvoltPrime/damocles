// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Page } from 'patchright';
import * as logger from '../../logger';
import {
  settle,
  buildBrowserPiTools,
  buildSnapshotExpression,
} from '../../pi-session/tools/browser-tools';

/**
 * Slice-4 unit suite: `settle` (C5), the graceful snapshot (C6) and the numeric-interpolation
 * validation (C8). Everything here drives REAL production code — the exported `settle` and the real
 * tool closures from `buildBrowserPiTools` over a hand-rolled fake scope. No production logic is
 * duplicated into this file.
 *
 * ── The standard every assertion here is held to (the Slice-3 lesson) ───────────────────────────
 * A test that passes against BOTH the fixed and the broken code is worthless. So:
 *   • every "it resolves fast" is paired with a fake that CANNOT resolve fast, proving the cap binds;
 *   • every "nothing was logged" is paired with a case that DOES log, proving the spy is wired;
 *   • every "the emitted JS is clean" is paired with the PRE-FIX shape, evaluated in the same test,
 *     proving the checker distinguishes them;
 *   • every "no error result" is paired with the success shape, proving the result is not empty.
 * Controls are marked `POSITIVE CONTROL` inline.
 *
 * What this file deliberately does NOT claim: real-browser timing. happy-dom has no load event, no
 * compositor and no rAF cadence, so "BrowserOpen returns faster than the old 2s floor" and "a screenshot
 * with a known viewport issues exactly one CDP send against a real page" are asserted in the env-gated
 * `patchright-launch.integration.test.ts` instead.
 */

/** The cap `screenshotAfter`/`screenshotWithSnapshot` pass to `settle` (browser-tools.ts:106). */
const ACTION_TIMEOUT_MS = 15_000;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Fake page. Only the surface `settle` and the exercised tools actually touch.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

type EvalHandler = (expression: string) => unknown;

interface FakePage {
  page: Page;
  evaluate: ReturnType<typeof vi.fn>;
  waitForLoadState: ReturnType<typeof vi.fn>;
  isClosed: ReturnType<typeof vi.fn>;
  /** Every selector handed to `page.locator(...)`, in order. */
  locatorSelectors: string[];
  /** Every expression string handed to `page.evaluate(...)`, in order. */
  expressions: string[];
}

interface FakePageOptions {
  /** Resolve `waitForLoadState('load')` immediately (default) or never. */
  loadState?: 'immediate' | 'never' | Promise<void>;
  /** Routes an evaluate expression to a canned value. Return `undefined` to fall through. */
  onEvaluate?: EvalHandler;
  closed?: boolean;
}

const SNAPSHOT_DATA = {
  snapshot: '[0] button "OK"',
  refCount: 1,
  title: 'Fixture',
  url: 'http://fixture.test/',
  belowFold: 0,
  scrollInfo: [] as string[],
  emptyFields: [] as string[],
};

const SCROLL_RESULT = {
  container: 'window',
  dx: 0,
  dy: 0,
  atEnd: false,
  atStart: false,
  usedDefault: false,
};

/** Identify which production expression a fake `evaluate` call is carrying. */
function classify(expression: string): 'raf' | 'snapshot' | 'scroll' | 'readyState' | 'textPoll' | 'other' {
  if (expression.includes('requestAnimationFrame')) return 'raf';
  if (expression.includes('scrollBy')) return 'scroll';
  if (expression === 'document.readyState') return 'readyState';
  if (expression.includes('createTreeWalker')) return 'textPoll';
  if (expression.includes("querySelectorAll('[data-dq]')") || expression.includes('data-dq')) return 'snapshot';
  return 'other';
}

function makeFakePage(options: FakePageOptions = {}): FakePage {
  const expressions: string[] = [];
  const locatorSelectors: string[] = [];

  const waitForLoadState = vi.fn(async () => {
    if (options.loadState === 'never') return new Promise<void>(() => {});
    if (options.loadState instanceof Promise) return options.loadState;
    return undefined;
  });

  const evaluate = vi.fn(async (expression: string) => {
    expressions.push(expression);
    const routed = options.onEvaluate?.(expression);
    if (routed !== undefined) return routed instanceof Error ? Promise.reject(routed) : routed;
    switch (classify(expression)) {
      case 'raf': return undefined;
      case 'snapshot': return SNAPSHOT_DATA;
      case 'scroll': return SCROLL_RESULT;
      case 'readyState': return 'complete';
      case 'textPoll': return true;
      default: return undefined;
    }
  });

  const isClosed = vi.fn(() => options.closed === true);

  const locatorHandle = {
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    hover: vi.fn(async () => {}),
    pressSequentially: vi.fn(async () => {}),
    selectOption: vi.fn(async () => {}),
    setChecked: vi.fn(async () => {}),
    waitFor: vi.fn(async () => {}),
    count: vi.fn(async () => 1),
  };

  const page = {
    evaluate,
    waitForLoadState,
    isClosed,
    locator: vi.fn((selector: string) => {
      locatorSelectors.push(selector);
      return { first: () => locatorHandle };
    }),
    keyboard: { press: vi.fn(async () => {}), type: vi.fn(async () => {}) },
    mouse: { click: vi.fn(async () => {}) },
    url: () => 'http://fixture.test/',
  };

  return { page: page as unknown as Page, evaluate, waitForLoadState, isClosed, locatorSelectors, expressions };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tool harness — the REAL tool closures over a fake scope (console-dialogs.test.ts pattern, with the
// BrowserService swapped for a hand-rolled scope so a tool failure cannot be masked by service state).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface ToolLike {
  name: string;
  execute: (id: string, input: unknown, signal?: AbortSignal) => Promise<{
    content: Array<{ type: string; text?: string; data?: string }>;
    isError?: boolean;
  }>;
}

interface DialogRecord { type: string; message: string; answered: string; timestamp: number }

interface Harness {
  tools: Map<string, ToolLike>;
  fake: FakePage;
  captureScreenshot: ReturnType<typeof vi.fn>;
  /** Dialogs the ledger will hand out on the next drain. */
  pendingDialogs: DialogRecord[];
  drainCount: () => number;
}

function makeHarness(options: FakePageOptions = {}): Harness {
  const fake = makeFakePage(options);
  const captureScreenshot = vi.fn(async () => 'BASE64SHOT');
  let pendingDialogs: DialogRecord[] = [];
  let drains = 0;

  const cdp = { getPage: () => fake.page, captureScreenshot };
  const scope = {
    getController: () => cdp,
    getCurrentPage: () => fake.page,
    getCurrentUrl: () => 'http://fixture.test/',
    open: vi.fn(async () => {}),
    waitForController: vi.fn(async () => true),
    // Draining, exactly like the real BrowserAgentScope: a drained record is gone.
    takeUnreportedDialogs: () => { drains++; const out = pendingDialogs; pendingDialogs = []; return out; },
    getDialogs: () => pendingDialogs,
    getConsole: () => [],
    getNetwork: () => [],
    listTabs: () => [],
    stageUpload: vi.fn(),
    reveal: vi.fn(),
  };

  const tools = buildBrowserPiTools({ pi: { defineTool: (c: unknown) => c }, scope } as never) as unknown as ToolLike[];
  const harness: Harness = {
    tools: new Map(tools.map((t) => [t.name, t])),
    fake,
    captureScreenshot,
    get pendingDialogs() { return pendingDialogs; },
    set pendingDialogs(v: DialogRecord[]) { pendingDialogs = v; },
    drainCount: () => drains,
  } as Harness;
  return harness;
}

const textOf = (res: { content: Array<{ type: string; text?: string }> }): string =>
  res.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');

const hasImage = (res: { content: Array<{ type: string; data?: string }> }): boolean =>
  res.content.some((c) => c.type === 'image' && typeof c.data === 'string' && c.data.length > 0);

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// C5 — `settle`
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe('C5 — settle(page, capMs)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('resolves WITHOUT waiting out the cap on an already-loaded page, and awaits exactly one double-rAF', async () => {
    const { page, evaluate, waitForLoadState } = makeFakePage({ loadState: 'immediate' });

    let settled = false;
    const pending = settle(page, ACTION_TIMEOUT_MS).then(() => { settled = true; });
    // Flush microtasks only — advance the clock by ZERO. If settle needed the cap it would still be
    // pending here, which is exactly what the negative control below demonstrates.
    await vi.advanceTimersByTimeAsync(0);
    await pending;

    expect(settled).toBe(true);
    expect(waitForLoadState).toHaveBeenCalledWith('load');

    // The double-rAF frame guarantee: exactly one evaluate, and it is the rAF expression.
    expect(evaluate).toHaveBeenCalledTimes(1);
    const expression = String(evaluate.mock.calls[0]![0]);
    expect((expression.match(/requestAnimationFrame/g) ?? []).length).toBe(2);
    expect(expression).toContain('new Promise');
  });

  it('POSITIVE CONTROL: the cap genuinely bounds a page whose load event never fires', async () => {
    // Without this test the one above would pass against an implementation that simply never waits —
    // and against one that waits forever. This pins BOTH edges of the cap.
    const { page, evaluate } = makeFakePage({ loadState: 'never' });

    let settled = false;
    const pending = settle(page, 5_000).then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    expect(evaluate).not.toHaveBeenCalled(); // the rAF phase has not started — the race is still open

    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(settled).toBe(true);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('POSITIVE CONTROL: the cap ALSO bounds the rAF phase, whose promise can never resolve', async () => {
    // `requestAnimationFrame` is serviced by the RENDERER, which does not tick when the page is
    // throttled or backgrounded — so this phase resolves NEVER, not late, and `page.evaluate` has no
    // timeout of its own. It was outside the race and awaited unconditionally, which made a screenshot
    // hang the agent forever. Survivable today only because Patchright's default args disable renderer
    // backgrounding, and `launcher.ts` builds its own arg list with nothing asserting those flags.
    const { page, evaluate } = makeFakePage({
      loadState: 'immediate',
      onEvaluate: (e) => (classify(e) === 'raf' ? (new Promise(() => {}) as never) : undefined),
    });

    let settled = false;
    const pending = settle(page, 5_000).then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(4_999);
    // The rAF evaluate WAS issued and is still hanging — so what follows is the cap binding, not the
    // phase being skipped.
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });

  it('leaves NO pending timer when the rAF phase is capped, either', async () => {
    const { page } = makeFakePage({
      loadState: 'immediate',
      onEvaluate: (e) => (classify(e) === 'raf' ? (new Promise(() => {}) as never) : undefined),
    });

    const pending = settle(page, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;

    // The second cap timer must be cleared like the first: a 15s orphan per action keeps the host's
    // event loop busy and leaks across tests.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves NO pending timer once a fast page settles (the sleep handle is cleared)', async () => {
    const { page } = makeFakePage({ loadState: 'immediate' });

    await settle(page, ACTION_TIMEOUT_MS);
    // Nothing may outlive the race. A 15s orphan per action would keep the host's event loop busy and,
    // under fake timers in a test suite, leak across tests.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('POSITIVE CONTROL: an UNCLEARED sleep leaves a pending timer, so the count assertion is meaningful', async () => {
    // The pre-fix shape, written out here so the assertion above is provably able to fail. If
    // `getTimerCount()` could not observe the leak, this would read 0 too.
    const { page } = makeFakePage({ loadState: 'immediate' });
    const leakySettle = async (p: Page, capMs: number): Promise<void> => {
      await Promise.race([
        p.waitForLoadState('load'),
        new Promise((r) => setTimeout(r, capMs)),
      ]);
      await p.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    };

    await leakySettle(page, ACTION_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(1);

    vi.clearAllTimers();
  });

  it('clears the timer on the CAPPED path too (a slow page must not leave the fired timer re-armed)', async () => {
    const { page } = makeFakePage({ loadState: 'never' });
    const pending = settle(page, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    expect(vi.getTimerCount()).toBe(0);
  });

  // ── Error policy: NARROW, not blanket ──────────────────────────────────────────────────────────
  describe('error policy — closed pages are swallowed, live failures are LOGGED', () => {
    it('SWALLOWS a rejection when page.isClosed() is true, and logs NOTHING', async () => {
      const logSpy = vi.spyOn(logger, 'log').mockImplementation(() => {});
      const { page } = makeFakePage({
        loadState: 'immediate',
        closed: true,
        onEvaluate: () => new Error('Protocol error: Target closed'),
      });

      await expect(settle(page, ACTION_TIMEOUT_MS)).resolves.toBeUndefined();
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('SWALLOWS a closed-target rejection identified by MESSAGE even when isClosed() is false', async () => {
      // The race is genuinely observable: `isClosed()` can still read false the instant the target
      // goes away, so the message check is the second half of the same narrow rule.
      const logSpy = vi.spyOn(logger, 'log').mockImplementation(() => {});

      for (const message of [
        'Target closed',
        'Target page, context or browser has been closed',
        'Execution context was destroyed, most likely because of a navigation',
      ]) {
        const { page } = makeFakePage({
          loadState: 'immediate',
          closed: false,
          onEvaluate: () => new Error(message),
        });
        await expect(settle(page, ACTION_TIMEOUT_MS)).resolves.toBeUndefined();
      }

      expect(logSpy).not.toHaveBeenCalled();
    });

    it('LOGS a rejection from a LIVE page and still does not throw (the other half of the criterion)', async () => {
      // POSITIVE CONTROL for the two tests above, in the same shape: identical fake, identical call,
      // only the error and liveness differ. If `settle` had a blanket `catch {}` this would read zero
      // log lines while the swallow tests still passed — which is precisely the bug being guarded.
      const logSpy = vi.spyOn(logger, 'log').mockImplementation(() => {});
      const { page } = makeFakePage({
        loadState: 'immediate',
        closed: false,
        onEvaluate: () => new SyntaxError('boom'),
      });

      await expect(settle(page, ACTION_TIMEOUT_MS)).resolves.toBeUndefined();

      expect(logSpy).toHaveBeenCalled();
      const lines = logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
      // Diagnosable: the message survives into the log, so the mystery-timeout failure mode the brief
      // describes cannot happen silently.
      expect(lines).toContain('boom');
    });

    it('LOGS a live-page rejection coming from waitForLoadState, not just from evaluate', async () => {
      const logSpy = vi.spyOn(logger, 'log').mockImplementation(() => {});
      const { page, waitForLoadState } = makeFakePage({ loadState: 'immediate', closed: false });
      waitForLoadState.mockRejectedValueOnce(new Error('navigation interrupted by another one'));

      await expect(settle(page, ACTION_TIMEOUT_MS)).resolves.toBeUndefined();
      expect(logSpy).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0); // the timer is cleared on the failure path too
    });

    it('SWALLOWS a closed-target rejection coming from waitForLoadState', async () => {
      const logSpy = vi.spyOn(logger, 'log').mockImplementation(() => {});
      const { page, waitForLoadState } = makeFakePage({ loadState: 'immediate', closed: true });
      waitForLoadState.mockRejectedValueOnce(new Error('Target page, context or browser has been closed'));

      await expect(settle(page, ACTION_TIMEOUT_MS)).resolves.toBeUndefined();
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('POSITIVE CONTROL: a fully successful settle logs nothing (no over-logging)', async () => {
      const logSpy = vi.spyOn(logger, 'log').mockImplementation(() => {});
      const { page } = makeFakePage({ loadState: 'immediate' });

      await settle(page, ACTION_TIMEOUT_MS);
      expect(logSpy).not.toHaveBeenCalled();
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// C8 — numeric interpolation
// ═════════════════════════════════════════════════════════════════════════════════════════════════

/** Pull the `let dx = …, dy = …;` line out of the emitted scroll expression. */
function extractDxDyAssignment(expression: string): string {
  const match = /let\s+dx\s*=\s*[^;]*;/.exec(expression);
  if (!match) {
    throw new Error(
      `The scroll expression no longer contains a recognisable \`let dx = …, dy = …;\` assignment; ` +
      `this test can no longer verify C8 and must be updated. Expression head: ${expression.slice(0, 200)}`,
    );
  }
  return match[0];
}

/** Execute an isolated `let dx = …, dy = …;` line and report the values it actually binds. */
function evalDxDy(assignment: string): { dx: unknown; dy: unknown } {
  const fn = new Function(`${assignment} return { dx, dy };`) as () => { dx: unknown; dy: unknown };
  return fn();
}

describe('C8 — browser_scroll coerces non-finite coordinates', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  async function scrollWith(input: Record<string, unknown>): Promise<{ expression: string; result: Awaited<ReturnType<ToolLike['execute']>> }> {
    const h = makeHarness({ loadState: 'immediate' });
    const result = await h.tools.get('BrowserScroll')!.execute('t', input);
    const expression = h.fake.expressions.find((e) => classify(e) === 'scroll');
    expect(expression, 'browser_scroll never evaluated its scroll expression').toBeTypeOf('string');
    return { expression: expression!, result };
  }

  const nonFinite: Array<{ label: string; input: Record<string, unknown> }> = [
    { label: 'x: NaN', input: { x: NaN } },
    { label: 'y: Infinity', input: { y: Infinity } },
    { label: 'y: -Infinity', input: { y: -Infinity } },
    { label: 'x: NaN, y: Infinity', input: { x: NaN, y: Infinity } },
  ];

  for (const { label, input } of nonFinite) {
    it(`emits valid, finite JS for ${label} and binds dx/dy to 0`, async () => {
      const { expression, result } = await scrollWith(input);

      // (1) The whole emitted program parses. (Necessary, not sufficient — see (2).)
      expect(() => new Function(`return ${expression};`)).not.toThrow();

      // (2) The load-bearing check: no bare non-finite literal survived into the assignment, and the
      // values it actually binds are the finite 0/0 the contract specifies. `new Function` alone would
      // NOT catch this — `let dx = NaN` parses perfectly well, which is exactly why C8 went unnoticed.
      const assignment = extractDxDyAssignment(expression);
      expect(assignment).not.toMatch(/\bNaN\b/);
      expect(assignment).not.toMatch(/\bInfinity\b/);
      expect(evalDxDy(assignment)).toEqual({ dx: 0, dy: 0 });

      // (3) The tool still reports a normal, successful scroll — the coercion did not become an error.
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('Scrolled');
    });
  }

  it('POSITIVE CONTROL: the PRE-FIX raw interpolation produces exactly what the checker rejects', async () => {
    // This is the regression the checker exists to catch, reconstructed verbatim from the old source
    // (`let dx = ${scrollX}, dy = ${scrollY};`). If the assertions above could not distinguish the two
    // shapes, this test would fail — and the C8 suite would be worthless.
    const scrollX = NaN;
    const scrollY = Infinity;
    const preFix = `let dx = ${scrollX}, dy = ${scrollY};`;

    expect(preFix).toMatch(/\bNaN\b/);
    expect(preFix).toMatch(/\bInfinity\b/);
    const bound = evalDxDy(preFix);
    expect(Number.isNaN(bound.dx)).toBe(true);
    expect(bound.dy).toBe(Infinity);
    // ...and it parses, proving `new Function` alone is an inadequate guard.
    expect(() => new Function(preFix)).not.toThrow();
  });

  it('POSITIVE CONTROL: ordinary finite coordinates are passed through UNCHANGED (no over-coercion)', async () => {
    const { expression, result } = await scrollWith({ x: 25, y: -400 });

    expect(evalDxDy(extractDxDyAssignment(expression))).toEqual({ dx: 25, dy: -400 });
    expect(result.isError).toBeFalsy();
  });

  it('truncates a fractional coordinate rather than emitting a float', async () => {
    const { expression } = await scrollWith({ x: 12.9, y: -7.4 });
    // Math.trunc, per the contract — toward zero, so -7.4 → -7 (Math.floor would give -8).
    expect(evalDxDy(extractDxDyAssignment(expression))).toEqual({ dx: 12, dy: -7 });
  });

  it('ABSENT coordinates still bind 0/0 and still take the "no amount" default-scroll branch', async () => {
    const { expression, result } = await scrollWith({});

    const assignment = extractDxDyAssignment(expression);
    expect(evalDxDy(assignment)).toEqual({ dx: 0, dy: 0 });
    // `noAmount` is what makes the tool fall back to ~75% of the viewport height; a coercion that
    // accidentally set explicitX/explicitY would silently kill the documented default.
    expect(expression).toContain('const noAmount = true;');
    expect(result.isError).toBeFalsy();
  });

  it('a non-finite coordinate is still an EXPLICIT coordinate (noAmount stays false)', async () => {
    // The contract keeps `explicitX/explicitY` meaning "the caller supplied the key". A caller who
    // passed `y: NaN` asked for a scroll of a specific amount and got 0 — they did NOT ask for the
    // 75%-viewport default, and silently giving it to them would be a different bug.
    const { expression } = await scrollWith({ y: NaN });
    expect(expression).toContain('const noAmount = false;');
  });

  it('the selector is still JSON.stringify-escaped alongside the new numeric coercion', async () => {
    const { expression } = await scrollWith({ selector: '#a"b\\c', y: 10 });
    expect(expression).toContain(JSON.stringify('#a"b\\c'));
    expect(() => new Function(`return ${expression};`)).not.toThrow();
  });
});

describe('C8 — browser_wait clamps a non-finite timeout', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('does NOT return an instant timeout for timeout: NaN — it polls and finds the text', async () => {
    // Pre-fix: `Math.ceil(NaN / 100)` is NaN, `i < NaN` is false, the loop body never runs, and the
    // tool reports a timeout it never actually waited for. This is that exact case.
    const h = makeHarness({ loadState: 'immediate', onEvaluate: (e) => (classify(e) === 'textPoll' ? true : undefined) });

    const result = await h.tools.get('BrowserWait')!.execute('t', { text: 'Loading complete', timeout: NaN });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).not.toContain('Timeout');
    expect(textOf(result)).toContain('Text appeared');
    // The poll genuinely ran at least once — an implementation that returned success without polling
    // would satisfy the assertions above but not this one.
    expect(h.fake.expressions.some((e) => classify(e) === 'textPoll')).toBe(true);
  });

  it('clamps Infinity and negative/zero timeouts to the documented default rather than looping forever', async () => {
    for (const timeout of [Infinity, -1, 0, -Infinity]) {
      const h = makeHarness({ loadState: 'immediate', onEvaluate: (e) => (classify(e) === 'textPoll' ? true : undefined) });
      const result = await h.tools.get('BrowserWait')!.execute('t', { text: 'Loading complete', timeout });

      expect(result.isError, `timeout: ${timeout} produced an error result`).toBeFalsy();
      expect(textOf(result)).toContain('Text appeared');
    }
  });

  it('passes a clamped, FINITE timeout to the selector branch\'s locator.waitFor', async () => {
    // The mission section resolved this explicitly: the clamp is at the single point of derivation, so
    // BOTH branches are covered. A NaN reaching `waitFor({ timeout: NaN })` is a Playwright-level
    // landmine (it disables the timeout entirely on some versions).
    const h = makeHarness({ loadState: 'immediate' });
    let seen: unknown;
    const realLocator = (h.fake.page as unknown as { locator: (s: string) => unknown }).locator;
    (h.fake.page as unknown as { locator: (s: string) => unknown }).locator = (s: string) => {
      const handle = (realLocator as (x: string) => { first: () => Record<string, unknown> })(s).first();
      return { first: () => ({ ...handle, waitFor: async (o: { timeout?: number }) => { seen = o?.timeout; } }) };
    };

    const result = await h.tools.get('BrowserWait')!.execute('t', { selector: '#thing', timeout: NaN });

    expect(result.isError).toBeFalsy();
    expect(typeof seen).toBe('number');
    expect(Number.isFinite(seen as number)).toBe(true);
    expect(seen as number).toBeGreaterThan(0);
  });

  it('POSITIVE CONTROL: a FINITE timeout whose text never appears DOES report a timeout error', async () => {
    // Without this, "does not return an instant timeout" could be satisfied by a tool that had simply
    // stopped reporting timeouts at all.
    const h = makeHarness({ loadState: 'immediate', onEvaluate: (e) => (classify(e) === 'textPoll' ? false : undefined) });

    const result = await h.tools.get('BrowserWait')!.execute('t', { text: 'never-appears', timeout: 100 });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Timeout waiting for text');
  }, 10_000);

  it('POSITIVE CONTROL: an ordinary finite timeout with the text present still succeeds', async () => {
    const h = makeHarness({ loadState: 'immediate', onEvaluate: (e) => (classify(e) === 'textPoll' ? true : undefined) });
    const result = await h.tools.get('BrowserWait')!.execute('t', { text: 'Loading complete', timeout: 5_000 });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Text appeared');
  });
});

describe('C8 — browser_act validates ref before interpolating [data-dq="…"]', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  const badRefs: Array<{ label: string; ref: number }> = [
    { label: '-1 (negative)', ref: -1 },
    { label: '1.5 (fractional)', ref: 1.5 },
    { label: 'NaN', ref: NaN },
    { label: 'Infinity', ref: Infinity },
  ];

  for (const { label, ref } of badRefs) {
    it(`yields a per-action FAIL line for ref ${label}, never a malformed selector`, async () => {
      const h = makeHarness({ loadState: 'immediate' });

      const result = await h.tools.get('BrowserAct')!.execute('t', { actions: [{ action: 'click', ref }] });
      const text = textOf(result);

      // (1) The loop's own failure channel, not a thrown tool error. The batch semantics stay intact:
      // the agent gets a FAIL line, the stop marker, and a fresh snapshot to re-plan from.
      expect(result.isError).toBeFalsy();
      expect(text).toContain('FAIL click');
      expect(text).toContain('(stopped at action 0)');

      // (2) No malformed selector ever reached Playwright. `[data-dq="NaN"]` would match nothing and
      // surface 15s later as an unactionable-element timeout instead of an immediate, honest error.
      for (const sel of h.fake.locatorSelectors) {
        expect(sel).not.toMatch(/NaN|Infinity|-1|1\.5|undefined/);
      }
      expect(h.fake.locatorSelectors).toHaveLength(0);
    });
  }

  it('POSITIVE CONTROL: ref 0 is VALID (non-negative integer) and drives the real selector', async () => {
    // ref 0 is the first snapshot ref and a classic falsy-check casualty. If a validator rejected it,
    // every batch starting at [0] would break — so this is both the control and a regression guard.
    const h = makeHarness({ loadState: 'immediate' });

    const result = await h.tools.get('BrowserAct')!.execute('t', { actions: [{ action: 'click', ref: 0 }] });
    const text = textOf(result);

    expect(result.isError).toBeFalsy();
    expect(text).toContain('OK click [0]');
    expect(text).not.toContain('FAIL');
    expect(h.fake.locatorSelectors).toContain('[data-dq="0"]');
  }, 10_000);

  it('POSITIVE CONTROL: a large valid ref also drives the real selector', async () => {
    const h = makeHarness({ loadState: 'immediate' });
    const result = await h.tools.get('BrowserAct')!.execute('t', { actions: [{ action: 'hover', ref: 42 }] });

    expect(textOf(result)).toContain('OK hover [42]');
    expect(h.fake.locatorSelectors).toContain('[data-dq="42"]');
  }, 10_000);

  it('an invalid ref on the optional-ref "key" action also fails cleanly instead of being interpolated', async () => {
    // `key` treats ref as optional (focus-then-press). An invalid ref must not silently become a
    // no-ref keypress against whatever happens to be focused — that is a wrong action, not a failure.
    const h = makeHarness({ loadState: 'immediate' });
    const result = await h.tools.get('BrowserAct')!.execute('t', { actions: [{ action: 'key', text: 'Enter', ref: -5 }] });

    expect(result.isError).toBeFalsy();
    for (const sel of h.fake.locatorSelectors) expect(sel).not.toContain('-5');
  }, 10_000);

  it('still reports the pre-existing "ref is required" failure when ref is absent (no behaviour change)', async () => {
    const h = makeHarness({ loadState: 'immediate' });
    const result = await h.tools.get('BrowserAct')!.execute('t', { actions: [{ action: 'click' }] });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('FAIL click');
    expect(h.fake.locatorSelectors).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// C6 — a racing navigation must not turn a success into an error
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe('C6 — screenshotWithSnapshot degrades gracefully when takeSnapshot fails', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns the SCREENSHOT plus a degraded note, with isError falsy, when the snapshot throws', async () => {
    const h = makeHarness({
      loadState: 'immediate',
      onEvaluate: (e) => (classify(e) === 'snapshot'
        ? new Error('Execution context was destroyed, most likely because of a navigation')
        : undefined),
    });

    const result = await h.tools.get('BrowserOpen')!.execute('t', { url: 'http://fixture.test/' });

    // The action COMPLETED. Reporting it as a tool error would make the model retry a click it has
    // already performed — the precise failure C6 exists to remove.
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('(page snapshot unavailable)');
    expect(textOf(result)).toContain('Opened browser: http://fixture.test/');
    // The screenshot the user asked for is still there.
    expect(hasImage(result)).toBe(true);
    expect(h.captureScreenshot).toHaveBeenCalledTimes(1);
  });

  it('POSITIVE CONTROL: the same fake with a WORKING snapshot returns the full snapshot text', async () => {
    // Without this, "(page snapshot unavailable)" could be the tool's only output shape and the test
    // above would prove nothing about the failure path.
    const h = makeHarness({ loadState: 'immediate' });

    const result = await h.tools.get('BrowserOpen')!.execute('t', { url: 'http://fixture.test/' });
    const text = textOf(result);

    expect(result.isError).toBeFalsy();
    expect(text).not.toContain('(page snapshot unavailable)');
    expect(text).toContain('[Page] Fixture');
    expect(text).toContain('[0] button "OK"');
    expect(hasImage(result)).toBe(true);
  });

  it('degrades the same way on BrowserNavigate (the other screenshotWithSnapshot call site)', async () => {
    const h = makeHarness({
      loadState: 'immediate',
      onEvaluate: (e) => (classify(e) === 'snapshot' ? new Error('Target closed') : undefined),
    });

    const result = await h.tools.get('BrowserNavigate')!.execute('t', { url: 'http://fixture.test/next' });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Navigated to: http://fixture.test/next');
    expect(textOf(result)).toContain('(page snapshot unavailable)');
    expect(hasImage(result)).toBe(true);
  });

  it('a snapshot failure AND a screenshot failure still yields a success carrying both notes', async () => {
    const h = makeHarness({
      loadState: 'immediate',
      onEvaluate: (e) => (classify(e) === 'snapshot' ? new Error('Target closed') : undefined),
    });
    h.captureScreenshot.mockRejectedValue(new Error('capture failed'));

    const result = await h.tools.get('BrowserOpen')!.execute('t', { url: 'http://fixture.test/' });
    const text = textOf(result);

    // Both degradations are additive notes on a SUCCESS, mirroring the screenshot's existing policy
    // rather than inventing a new one.
    expect(result.isError).toBeFalsy();
    expect(text).toContain('(screenshot unavailable)');
    expect(text).toContain('(page snapshot unavailable)');
    expect(hasImage(result)).toBe(false);
  });

  // ── Slice-3 interaction: the dialog ledger drain ───────────────────────────────────────────────
  it('does NOT silently discard drained dialog records when the snapshot fails', async () => {
    // `takeSnapshot` DRAINS the ledger (browser-tools.ts, the `scope.takeUnreportedDialogs()` loop).
    // If a snapshot failure consumed the drain, an answered dialog would be reported to NOBODY —
    // the agent would never learn a confirm() it triggered was auto-accepted.
    const h = makeHarness({
      loadState: 'immediate',
      onEvaluate: (e) => (classify(e) === 'snapshot' ? new Error('Target closed') : undefined),
    });
    h.pendingDialogs = [{ type: 'confirm', message: 'Delete this item?', answered: 'accepted', timestamp: 1 }];

    const failed = await h.tools.get('BrowserOpen')!.execute('t', { url: 'http://fixture.test/' });
    expect(failed.isError).toBeFalsy();
    expect(textOf(failed)).toContain('(page snapshot unavailable)');

    // The record survived the failed snapshot and reaches the agent on the next successful one.
    const h2 = makeHarness({ loadState: 'immediate' });
    h2.pendingDialogs = h.pendingDialogs;
    const recovered = await h2.tools.get('BrowserSnapshot')!.execute('t', {});
    expect(textOf(recovered)).toContain('[Dialogs] confirm "Delete this item?" → accepted');

    // POSITIVE CONTROL: the drain really is destructive, so "it survived" is a real property and not
    // an artefact of a non-draining fake.
    const again = await h2.tools.get('BrowserSnapshot')!.execute('t', {});
    expect(textOf(again)).not.toContain('[Dialogs]');
  });

  it('BrowserAct keeps its completed actions when the trailing snapshot fails', async () => {
    // The asymmetry this closes: `screenshotWithSnapshot` guarded its snapshot, `browser_act` did not.
    // A navigation racing the trailing snapshot threw, and the catch turned the WHOLE call into an
    // error — discarding every `OK` line from actions that had already mutated the page. The model is
    // then told the batch failed and retries it. The final action of a batch is very often a submit,
    // and clicking Submit twice is a real, irreversible outcome.
    const h = makeHarness({
      loadState: 'immediate',
      onEvaluate: (e) => (classify(e) === 'snapshot' ? new Error('Target closed') : undefined),
    });

    const result = await h.tools.get('BrowserAct')!.execute('t', {
      actions: [{ action: 'click', ref: 0 }, { action: 'click', ref: 1 }],
    });
    const text = textOf(result);

    expect(result.isError).toBeFalsy();
    // What actually happened is reported, action by action...
    expect(text).toContain('OK click [0]');
    expect(text).toContain('OK click [1]');
    // ...and the degradation is an additive note, exactly as the sibling call site already does.
    expect(text).toContain('(page snapshot unavailable)');
  });

  it('POSITIVE CONTROL: a failing ACTION is still reported as a failure, not swallowed', async () => {
    // Guarding the snapshot must not have turned a genuine action failure into a silent success.
    const h = makeHarness({ loadState: 'immediate' });

    const result = await h.tools.get('BrowserAct')!.execute('t', { actions: [{ action: 'click', ref: -1 }] });
    const text = textOf(result);

    expect(text).toContain('FAIL click');
    expect(text).toContain('(stopped at action 0)');
    expect(text).not.toContain('(page snapshot unavailable)');
  });

  it('does not even CALL takeUnreportedDialogs when the snapshot evaluate rejects (pins the ordering)', async () => {
    // agent-tools' safety argument is structural: `takeSnapshot`'s only rejectable operation is its
    // leading `page.evaluate`, and the drain is synchronous string work AFTER it — so a rejection is
    // always BEFORE the drain. That holds only while no `await` is introduced between the two. This
    // test pins that invariant so a future reorder fails HERE, loudly, instead of silently eating an
    // answered dialog the agent was entitled to be told about.
    const h = makeHarness({
      loadState: 'immediate',
      onEvaluate: (e) => (classify(e) === 'snapshot' ? new Error('Target closed') : undefined),
    });
    h.pendingDialogs = [{ type: 'alert', message: 'Saved', answered: 'accepted', timestamp: 1 }];

    await h.tools.get('BrowserOpen')!.execute('t', { url: 'http://fixture.test/' });
    expect(h.drainCount()).toBe(0);

    // POSITIVE CONTROL: a SUCCEEDING snapshot does drain exactly once, so the zero above is an
    // ordering property and not a fake that never wires the drain at all.
    const ok = makeHarness({ loadState: 'immediate' });
    ok.pendingDialogs = [{ type: 'alert', message: 'Saved', answered: 'accepted', timestamp: 1 }];
    await ok.tools.get('BrowserOpen')!.execute('t', { url: 'http://fixture.test/' });
    expect(ok.drainCount()).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// C5, integration-in-the-small — every converted call site routes through settle
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe('C5 — the converted call sites wait on the LOAD STATE, not on a fixed clock', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  /** Every tool the brief lists as a pre-screenshot-sleep call site, with a minimal valid input. */
  const callSites: Array<{ tool: string; input: Record<string, unknown> }> = [
    { tool: 'BrowserOpen', input: { url: 'http://fixture.test/' } },
    { tool: 'BrowserNavigate', input: { url: 'http://fixture.test/next' } },
    { tool: 'BrowserClick', input: { selector: '#btn' } },
    { tool: 'BrowserType', input: { selector: '#in', text: 'hello' } },
    { tool: 'BrowserHover', input: { selector: '#btn' } },
    { tool: 'BrowserScroll', input: { y: 100 } },
    { tool: 'BrowserAct', input: { actions: [{ action: 'click', ref: 0 }] } },
  ];

  for (const { tool, input } of callSites) {
    it(`${tool} calls waitForLoadState('load') before its screenshot`, async () => {
      const h = makeHarness({ loadState: 'immediate' });
      const result = await h.tools.get(tool)!.execute('t', input);

      expect(result.isError, `${tool} errored: ${textOf(result)}`).toBeFalsy();
      // The observable signature of `settle`: the load state is consulted, and a double-rAF frame is
      // awaited. A fixed `setTimeout` sleep would do neither.
      expect(h.fake.waitForLoadState, `${tool} never consulted the load state`).toHaveBeenCalledWith('load');
      expect(
        h.fake.expressions.some((e) => classify(e) === 'raf'),
        `${tool} never awaited the double-rAF frame`,
      ).toBe(true);
    }, 20_000);
  }

  it('BrowserAct no longer runs its hand-rolled readyState poll loop', async () => {
    // The old tail polled `document.readyState` up to 10 times with 200ms sleeps after a 300ms nap.
    // `settle` replaces all of it; a surviving poll would show up as a `document.readyState` evaluate.
    const h = makeHarness({ loadState: 'immediate' });
    await h.tools.get('BrowserAct')!.execute('t', { actions: [{ action: 'click', ref: 0 }] });

    expect(h.fake.expressions.filter((e) => classify(e) === 'readyState')).toHaveLength(0);
    // POSITIVE CONTROL: the classifier DOES recognise that expression, so the emptiness above is a
    // real absence and not a broken matcher.
    expect(classify('document.readyState')).toBe('readyState');
    expect(h.fake.waitForLoadState).toHaveBeenCalledWith('load');
  }, 20_000);

  it('a screenshot-taking tool still completes when the load event never fires (the cap is wired)', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({ loadState: 'never' });
      const pending = h.tools.get('BrowserClick')!.execute('t', { selector: '#btn' });

      // Capped by ACTION_TIMEOUT_MS, so advancing past it must let the whole tool finish.
      await vi.advanceTimersByTimeAsync(ACTION_TIMEOUT_MS + 100);
      const result = await pending;

      expect(result.isError).toBeFalsy();
      expect(hasImage(result)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// Guard: the exported serializers this suite leans on still exist (a rename must fail loudly here
// rather than silently skipping a criterion).
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe('harness sanity', () => {
  it('settle is exported at module scope and buildSnapshotExpression still produces the classified shape', () => {
    expect(settle).toBeTypeOf('function');
    expect(settle.length).toBeGreaterThanOrEqual(2);
    expect(classify(buildSnapshotExpression())).toBe('snapshot');
  });
});
