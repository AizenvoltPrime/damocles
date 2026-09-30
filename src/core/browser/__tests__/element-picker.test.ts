import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ElementPicker } from '../element-picker';
import { ConsoleCollector, NetworkCollector } from '../collectors';
import * as logger from '../../logger';

/**
 * Slice-3 unit suite for the element picker (brief step 9 → acceptance criterion 9, plus C11).
 *
 * C1 is a WEDGE bug, so every test here asserts RECOVERY, not just the immediate failure: after the
 * abandoned pick / the navigation / the concurrent events, a fresh `startPicking()` must SUCCEED.
 * A test that only asserted "it rejected" would pass against an implementation that rejects and then
 * leaves `picking === true` forever — which is the exact defect being fixed.
 */

const PICK_TIMEOUT_MS = 60_000;

type Mock = ReturnType<typeof vi.fn>;

/**
 * A fake PageController covering every method `handleInspectNodeRequested` touches. `describeNode`
 * returns a shape `buildSelector` can consume; the `callFunctionOn` responses drive the collectors.
 */
function fakeCdp(): Record<string, Mock> {
  return {
    setInspectMode: vi.fn(async () => {}),
    getDocument: vi.fn(async () => ({ root: { nodeId: 1 } })),
    describeNode: vi.fn(async () => ({ localName: 'div', attributes: ['id', 'target'] })),
    getOuterHTML: vi.fn(async () => '<div id="target">hi</div>'),
    getBoxModel: vi.fn(async () => ({ content: [0, 0, 100, 0, 100, 50, 0, 50] })),
    resolveNode: vi.fn(async () => ({ objectId: 'obj-1' })),
    requestNode: vi.fn(async () => 42),
    callFunctionOn: vi.fn(async () => ({ value: {} })),
    getMatchedStylesForNode: vi.fn(async () => ({ matchedCSSRules: [] })),
    captureScreenshot: vi.fn(async () => 'BASE64'),
  };
}

function makePicker(cdp: Record<string, Mock> = fakeCdp()): {
  picker: ElementPicker;
  cdp: Record<string, Mock>;
  console: ConsoleCollector;
} {
  const consoleCollector = new ConsoleCollector();
  const networkCollector = new NetworkCollector();
  const picker = new ElementPicker(
    cdp as never,
    consoleCollector,
    networkCollector,
  );
  return { picker, cdp, console: consoleCollector };
}

/** A promise plus its resolver — used to hold a CDP call open mid-sequence. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// (a) An abandoned pick must not hang pickElement() forever.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('criterion 9(a) — an abandoned pick rejects after 60s instead of hanging', () => {
  it('rejects with a clear message and leaves the picker usable again', async () => {
    const { picker, cdp } = makePicker();

    const pending = picker.startPicking();
    // Attach the rejection handler immediately; an unhandled rejection would fail the run.
    const settled = pending.then(() => 'resolved').catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(0);
    expect(picker.isPicking).toBe(true);

    // Just before the deadline the pick is still open — the timeout is a real 60s bound, not instant.
    await vi.advanceTimersByTimeAsync(PICK_TIMEOUT_MS - 1000);
    expect(picker.isPicking).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    const result = await settled;

    expect(result).toBeInstanceOf(Error);
    // A bare 'Error' would leave the human with no idea why the picker closed.
    expect((result as Error).message).toMatch(/timed out|timeout|60/i);

    // THE POINT OF THE FIX: the tab is not wedged.
    expect(picker.isPicking).toBe(false);
    // Inspect mode was turned back off, so Chrome's overlay is not left armed.
    expect(cdp['setInspectMode']!).toHaveBeenCalledWith('none');

    // POSITIVE CONTROL: a fresh pick genuinely starts (it does not throw 'already active').
    const second = picker.startPicking();
    const secondSettled = second.then(() => 'resolved').catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(0);
    expect(picker.isPicking).toBe(true);

    await picker.stopPicking();
    await secondSettled;
  });

  it('does not reject a pick that completed normally (timer hygiene)', async () => {
    const { picker } = makePicker();

    const pending = picker.startPicking();
    await vi.advanceTimersByTimeAsync(0);

    await picker.handleInspectNodeRequested(7);
    const attachment = await pending;
    expect(attachment.selector).toBe('div#target');
    expect(picker.isPicking).toBe(false);

    // A stale 60s timer would reject an already-settled promise (harmless) OR, worse, tear down a
    // NEW pick started in the meantime. Advancing well past the deadline must be a no-op.
    let lateRejection: unknown = null;
    const second = picker.startPicking().catch((err: unknown) => { lateRejection = err; });
    await vi.advanceTimersByTimeAsync(0);

    // Advance past the FIRST pick's original deadline. The second pick began later, so its own 60s
    // window has not closed; only a leaked first timer could fire here.
    await vi.advanceTimersByTimeAsync(PICK_TIMEOUT_MS - 1);
    expect(lateRejection).toBeNull();
    expect(picker.isPicking).toBe(true);

    await picker.stopPicking();
    await second;
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// (b) A navigation mid-pick must leave the toolbar button usable.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('criterion 9(b) — a navigation mid-pick leaves the pick button usable', () => {
  it('stopPicking() clears isPicking so panel.onPickElement\'s guard no longer blocks', async () => {
    const { picker } = makePicker();

    const pending = picker.startPicking();
    const settled = pending.catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(0);
    expect(picker.isPicking).toBe(true);

    // The path `onMainFrameNavigated` now takes. Overlay.setInspectMode is per-document, so after a
    // navigation `Overlay.inspectNodeRequested` can never fire for the old document.
    await picker.stopPicking();

    // `panel.onPickElement` reads exactly this: `if (entry.picker.isPicking) return;`
    expect(picker.isPicking).toBe(false);
    const err = await settled;
    expect(err).toBeInstanceOf(Error);

    // POSITIVE CONTROL: the toolbar button works again — a fresh pick does not throw 'already active'.
    let threw: unknown = null;
    const second = picker.startPicking().catch((e: unknown) => { threw = e; });
    await vi.advanceTimersByTimeAsync(0);
    expect(threw).toBeNull();
    expect(picker.isPicking).toBe(true);

    await picker.stopPicking();
    await second;
  });

  it('stopPicking() on an idle picker is a harmless no-op', async () => {
    const { picker } = makePicker();
    expect(picker.isPicking).toBe(false);
    await expect(picker.stopPicking()).resolves.toBeUndefined();
    expect(picker.isPicking).toBe(false);
  });

  it('a navigation after the timeout already fired does not double-reject', async () => {
    const { picker } = makePicker();
    const settled = picker.startPicking().catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(PICK_TIMEOUT_MS);
    expect(await settled).toBeInstanceOf(Error);

    await expect(picker.stopPicking()).resolves.toBeUndefined();
    expect(picker.isPicking).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// (c) Two concurrent inspect events must resolve the pick exactly once.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('criterion 9(c) — two concurrent inspect events resolve the pick exactly once', () => {
  it('claims the resolver SYNCHRONOUSLY so a second event arriving mid-sequence is a no-op', async () => {
    const cdp = fakeCdp();
    // Hold the FIRST await open. Without this the first call would run to completion before the
    // second event arrived and the test would prove nothing about concurrency.
    const gate = deferred<void>();
    let describeCalls = 0;
    cdp['describeNode'] = vi.fn(async () => {
      describeCalls++;
      if (describeCalls === 1) await gate.promise;
      return { localName: 'div', attributes: ['id', 'target'] };
    });

    const { picker } = makePicker(cdp);

    let resolveCount = 0;
    let rejectCount = 0;
    const pending = picker.startPicking();
    pending.then(() => { resolveCount++; }, () => { rejectCount++; });
    await vi.advanceTimersByTimeAsync(0);

    // Fire BOTH events without awaiting the first — it is parked inside describeNode.
    const firstCall = picker.handleInspectNodeRequested(11);
    await vi.advanceTimersByTimeAsync(0);
    expect(describeCalls).toBe(1);

    // The second event arrives genuinely mid-sequence.
    const secondCall = picker.handleInspectNodeRequested(22);
    await vi.advanceTimersByTimeAsync(0);

    // The synchronous claim at the top of the handler means the second event bailed immediately —
    // it never ran the ~8-call collection sequence against an already-claimed resolver.
    expect(describeCalls).toBe(1);

    gate.resolve();
    await firstCall;
    await secondCall;
    await vi.advanceTimersByTimeAsync(0);

    const attachment = await pending;
    expect(attachment).toBeDefined();
    // Exactly one settlement, and it was a resolve.
    expect(resolveCount).toBe(1);
    expect(rejectCount).toBe(0);
    // The whole sequence ran ONCE: one describeNode, one screenshot, one resolve.
    expect(describeCalls).toBe(1);
    expect(cdp['captureScreenshot']!).toHaveBeenCalledTimes(1);
    expect(picker.isPicking).toBe(false);
  });

  it('an inspect event with no pick in progress is ignored', async () => {
    const { picker, cdp } = makePicker();
    expect(picker.isPicking).toBe(false);

    await expect(picker.handleInspectNodeRequested(5)).resolves.toBeUndefined();
    expect(cdp['describeNode']!).not.toHaveBeenCalled();
  });

  it('clears the timeout on a successful pick even under the concurrent path', async () => {
    const { picker } = makePicker();
    const pending = picker.startPicking();
    await vi.advanceTimersByTimeAsync(0);

    await picker.handleInspectNodeRequested(1);
    await picker.handleInspectNodeRequested(2);
    await pending;

    // No leaked timer fires later: with the pick settled and no new one started, there is nothing
    // left scheduled at all, so advancing far past the deadline is inert.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(PICK_TIMEOUT_MS * 2);
    expect(picker.isPicking).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// C11 — a CDP failure must be distinguishable from a legitimately empty result.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('C11 — the five bare catch {} blocks are now logged', () => {
  /** Assert the collector returned its empty default AND said so in the log. */
  async function expectLoggedFailure(
    breaking: (cdp: Record<string, Mock>) => void,
    assertion: (attachment: Awaited<ReturnType<ElementPicker['startPicking']>>) => void,
  ): Promise<string[]> {
    const logSpy = vi.spyOn(logger, 'log').mockImplementation(() => {});
    const cdp = fakeCdp();
    breaking(cdp);
    const { picker } = makePicker(cdp);

    const pending = picker.startPicking();
    await vi.advanceTimersByTimeAsync(0);
    await picker.handleInspectNodeRequested(9);
    const attachment = await pending;

    assertion(attachment);
    const lines = logSpy.mock.calls.map((c) => c.map(String).join(' '));
    // The point of C11: a failure is VISIBLE, not silently indistinguishable from "no styles".
    expect(lines.length).toBeGreaterThan(0);
    return lines;
  }

  it('logs when computed-style collection fails, and still returns the empty default', async () => {
    const lines = await expectLoggedFailure(
      (cdp) => {
        cdp['callFunctionOn'] = vi.fn(async (_id: unknown, fn: unknown) => {
          if (String(fn).includes('getComputedStyle')) throw new Error('CSS agent gone');
          return { value: '' };
        }) as Mock;
      },
      (attachment) => { expect(attachment.computedStyles).toEqual({}); },
    );
    expect(lines.join('\n')).toMatch(/CSS agent gone|comput/i);
  });

  it('logs when matched-rule collection fails, and still returns the empty default', async () => {
    const lines = await expectLoggedFailure(
      (cdp) => { cdp['getMatchedStylesForNode'] = vi.fn(async () => { throw new Error('no matched styles'); }); },
      (attachment) => { expect(attachment.matchedRules ?? '').toBe(''); },
    );
    expect(lines.join('\n')).toMatch(/no matched styles|matched/i);
  });

  it('logs when the element screenshot fails, and still returns the empty default', async () => {
    const lines = await expectLoggedFailure(
      (cdp) => { cdp['captureScreenshot'] = vi.fn(async () => { throw new Error('screenshot failed'); }); },
      (attachment) => { expect(attachment.elementScreenshot).toBe(''); },
    );
    expect(lines.join('\n')).toMatch(/screenshot/i);
  });

  it('POSITIVE CONTROL: a fully successful pick logs NO failure and returns real data', async () => {
    const logSpy = vi.spyOn(logger, 'log').mockImplementation(() => {});
    const cdp = fakeCdp();
    cdp['callFunctionOn'] = vi.fn(async (_id: unknown, fn: unknown) => {
      if (String(fn).includes('getComputedStyle')) return { value: { color: 'rgb(1, 2, 3)' } };
      if (String(fn).includes('chain')) return { value: 'html > body > div#target' };
      return { value: 'inner text' };
    }) as Mock;
    const { picker } = makePicker(cdp);

    const pending = picker.startPicking();
    await vi.advanceTimersByTimeAsync(0);
    await picker.handleInspectNodeRequested(3);
    const attachment = await pending;

    // Real data came back — so the "empty default" assertions above are genuinely about failure,
    // not about the harness never producing anything.
    expect(attachment.computedStyles).toEqual({ color: 'rgb(1, 2, 3)' });
    expect(attachment.elementScreenshot).toBe('BASE64');
    expect(attachment.selector).toBe('div#target');
    // ...and nothing was logged as a failure on the happy path.
    const failureLines = logSpy.mock.calls
      .map((c) => c.map(String).join(' '))
      .filter((l) => /fail|error/i.test(l));
    expect(failureLines).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// S2 — the attachment must not carry an unbounded console buffer into the chat transcript.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('acceptance criterion 2 — the ElementAttachment console buffer is bounded', () => {
  it('carries at most 20 entries, and they are the most recent ones', async () => {
    const { picker, console: collector } = makePicker();
    for (let i = 0; i < 100; i++) collector.record('log', `entry-${i}`);

    const pending = picker.startPicking();
    await vi.advanceTimersByTimeAsync(0);
    await picker.handleInspectNodeRequested(1);
    const attachment = await pending;

    // element-picker.ts:117 used to embed the FULL buffer into every attachment broadcast to chat.
    expect(attachment.consoleMessages).toHaveLength(20);
    expect(attachment.consoleMessages[0]!.text).toBe('entry-80');
    expect(attachment.consoleMessages[19]!.text).toBe('entry-99');
  });

  it('caps each entry at 2000 chars', async () => {
    const { picker, console: collector } = makePicker();
    collector.record('log', 'q'.repeat(5000));

    const pending = picker.startPicking();
    await vi.advanceTimersByTimeAsync(0);
    await picker.handleInspectNodeRequested(1);
    const attachment = await pending;

    expect(attachment.consoleMessages[0]!.text.length).toBeLessThan(2050);
    // POSITIVE CONTROL: truncated, not dropped — and the cut is MARKED, so a reader cannot mistake a
    // clipped entry for the whole one.
    expect(attachment.consoleMessages[0]!.text.startsWith('qqq')).toBe(true);
    expect(attachment.consoleMessages[0]!.text).toContain('truncated');
  });

  it('POSITIVE CONTROL: a small buffer passes through intact (the bound is a cap, not a filter)', async () => {
    const { picker, console: collector } = makePicker();
    collector.record('log', 'only-message');

    const pending = picker.startPicking();
    await vi.advanceTimersByTimeAsync(0);
    await picker.handleInspectNodeRequested(1);
    const attachment = await pending;

    expect(attachment.consoleMessages).toHaveLength(1);
    expect(attachment.consoleMessages[0]!.text).toBe('only-message');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The attachment is broadcast to chat and persisted, so BOUNDED is not the same as SAFE.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('the attachment is credential-free, not merely bounded', () => {
  it('never ships a password field value, in attributes or in markup', async () => {
    const cdp = fakeCdp();
    cdp['describeNode'] = vi.fn(async () => ({
      localName: 'input',
      attributes: ['type', 'password', 'value', 'hunter2-SECRET', 'id', 'pw'],
    })) as Mock;
    cdp['getOuterHTML'] = vi.fn(async () => '<input type=password value=hunter2-SECRET id=pw>') as Mock;
    const { picker } = makePicker(cdp);

    const pending = picker.startPicking();
    await vi.advanceTimersByTimeAsync(0);
    await picker.handleInspectNodeRequested(1);
    const attachment = await pending;

    // The whole attachment is serialized into the transcript, so the secret must be absent from ALL of
    // it — not just from the field the fix happened to think of.
    expect(JSON.stringify(attachment)).not.toContain('hunter2-SECRET');
    // POSITIVE CONTROL: the element really was captured, so the absence above is redaction rather
    // than a pick that returned nothing.
    expect(attachment.tagName).toBe('input');
    expect(attachment.attributes['id']).toBe('pw');
    expect(attachment.outerHTML).toContain('input');
  });

  it('redacts credentials in inner text and in non-sensitive attributes', async () => {
    const cdp = fakeCdp();
    cdp['describeNode'] = vi.fn(async () => ({
      localName: 'a',
      attributes: ['href', '/callback?access_token=abc123def456', 'class', 'link'],
    })) as Mock;
    cdp['callFunctionOn'] = vi.fn(async (_id: unknown, fn: unknown) => {
      if (String(fn).includes('getComputedStyle')) return { value: {} };
      if (String(fn).includes('chain')) return { value: 'html > body > a' };
      return { value: 'api_key=abc123def456' };
    }) as Mock;
    const { picker } = makePicker(cdp);

    const pending = picker.startPicking();
    await vi.advanceTimersByTimeAsync(0);
    await picker.handleInspectNodeRequested(1);
    const attachment = await pending;

    expect(JSON.stringify(attachment)).not.toContain('abc123def456');
    expect(attachment.attributes['class']).toBe('link');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Every settle path must settle, including the ones where the CDP target is already gone.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('stopPicking settles the pick even when the CDP call fails', () => {
  it('rejects the pending pick when setInspectMode throws (closed page / disposed entry)', async () => {
    // The callers that matter — handlePageClosed and disposeEntry — run when the target is ALREADY
    // GONE, so setInspectMode rejects. Awaiting it BEFORE settling meant the rejection escaped past
    // pickReject, both call sites swallowed it, and pickElement() stayed pending forever with the
    // toolbar stuck in picking state. The old fake always resolved, so this was unreachable.
    const cdp = fakeCdp();
    const { picker } = makePicker(cdp);

    const pending = picker.startPicking();
    let settled = false;
    const result = pending.then(() => 'resolved').catch((err: Error) => err).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);

    cdp['setInspectMode'] = vi.fn(async () => { throw new Error('Target closed'); }) as Mock;
    // stopPicking itself must not reject either — every caller treats it as best-effort cleanup.
    await expect(picker.stopPicking()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    expect(await result).toBeInstanceOf(Error);
    expect(picker.isPicking).toBe(false);

    // POSITIVE CONTROL: not wedged — a fresh pick starts rather than throwing 'already active'.
    cdp['setInspectMode'] = vi.fn(async () => {}) as Mock;
    const second = picker.startPicking();
    const secondSettled = second.then(() => 'resolved').catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(0);
    expect(picker.isPicking).toBe(true);
    await picker.stopPicking();
    await secondSettled;
  });
});

describe('a failing in-flight collection cannot kill a LATER pick', () => {
  it('settles only its own promise, leaving a fresh pick armed', async () => {
    // The claim at the top of handleInspectNodeRequested cleared pickResolve but LEFT pickReject
    // pointing at the in-flight pick. A failure later in that ~8-round-trip sequence then rejected
    // whatever pick was armed BY THEN — killing a fresh, unrelated one — and stopPicking early-returned
    // on `picking === false`, so nothing ever cleared it: isPicking stuck true forever.
    const cdp = fakeCdp();
    const held = deferred<{ objectId: string }>();
    cdp['resolveNode'] = vi.fn(() => held.promise) as Mock;
    const { picker } = makePicker(cdp);

    const first = picker.startPicking();
    const firstSettled = first.then(() => 'resolved').catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(0);

    // Collection starts and parks mid-sequence, exactly as a real one does across CDP round trips.
    const collecting = picker.handleInspectNodeRequested(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(picker.isPicking).toBe(false);

    // The human starts a NEW pick while the stale collection is still in flight.
    const second = picker.startPicking();
    const secondSettled = second.then((a) => a).catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(0);
    expect(picker.isPicking).toBe(true);

    // Now the stale collection fails (the page navigated away under it).
    held.resolve(undefined as never);
    await collecting;
    await vi.advanceTimersByTimeAsync(0);

    // The FIRST pick took the failure...
    expect(await firstSettled).toBeInstanceOf(Error);
    // ...and the second is untouched and still armed.
    expect(picker.isPicking).toBe(true);

    // POSITIVE CONTROL: the second pick still completes normally, so it was genuinely alive.
    cdp['resolveNode'] = vi.fn(async () => ({ objectId: 'obj-2' })) as Mock;
    await picker.handleInspectNodeRequested(2);
    const attachment = await secondSettled;
    expect(attachment).not.toBeInstanceOf(Error);
    expect((attachment as { selector: string }).selector).toBe('div#target');
    expect(picker.isPicking).toBe(false);
  });
});
