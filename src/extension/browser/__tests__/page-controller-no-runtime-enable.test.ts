import { describe, it, expect } from 'vitest';
import { PageController, CDP_ALLOWED_METHODS } from '../page-controller';

/**
 * The single enforced invariant of the whole Patchright migration: the leak-free CDPSession inside
 * PageController must NEVER send `Runtime.enable` (the biggest CDP bot-detection tell), nor the other
 * fingerprinting enables `Console.enable` / `Network.enable`. This guard asserts both statically (the
 * exported allow-list excludes them) and dynamically (driving a representative set of PageController
 * calls through a fake CDPSession and asserting the forbidden methods are never issued, and that every
 * method actually sent is in the allow-list).
 */

const FORBIDDEN_METHODS = ['Runtime.enable', 'Console.enable', 'Network.enable'];

/** Canned CDP responses keyed by method so the exercised PageController calls resolve realistically. */
function fakeResponse(method: string): unknown {
  switch (method) {
    case 'DOM.getDocument':
      return { root: { nodeId: 1 } };
    case 'DOM.querySelector':
      return { nodeId: 2 };
    case 'DOM.getOuterHTML':
      return { outerHTML: '<div></div>' };
    case 'DOM.getBoxModel':
      return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10], padding: [], border: [], margin: [], width: 10, height: 10 } };
    case 'DOM.describeNode':
      return { node: { nodeId: 2, backendNodeId: 3, nodeName: 'DIV', localName: 'div', nodeValue: '' } };
    case 'DOM.resolveNode':
      return { object: { type: 'object', objectId: 'obj-1' } };
    case 'DOM.requestNode':
      return { nodeId: 2 };
    case 'DOM.getNodeForLocation':
      return { backendNodeId: 3, frameId: 'frame-1', nodeId: 2 };
    case 'CSS.getComputedStyleForNode':
      return { computedStyle: [{ name: 'display', value: 'block' }] };
    case 'CSS.getMatchedStylesForNode':
      return { matchedCSSRules: [] };
    case 'Accessibility.getFullAXTree':
      return { nodes: [] };
    case 'Accessibility.getPartialAXTree':
      return { nodes: [] };
    case 'Runtime.evaluate':
      // captureScreenshot's viewport probe expects a JSON string value.
      return { result: { type: 'string', value: JSON.stringify({ w: 800, h: 600, dpr: 1 }) } };
    case 'Runtime.callFunctionOn':
      return { result: { type: 'string', value: 'ok' } };
    case 'Page.captureScreenshot':
      return { data: 'BASE64DATA' };
    case 'Page.getLayoutMetrics':
      return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
    case 'Page.navigate':
      return { frameId: 'frame-1', loaderId: 'loader-1' };
    default:
      return {};
  }
}

class FakeCdpSession {
  readonly sent: string[] = [];
  /** Every (method, params) pair, so the C7 tests can assert on the screenshot's `clip`. */
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.sent.push(method);
    this.calls.push({ method, ...(params !== undefined ? { params } : {}) });
    return fakeResponse(method);
  }
  on(): this {
    return this;
  }
}

/** The screenshot params the controller actually put on the wire. */
function screenshotParams(session: FakeCdpSession): Record<string, unknown> {
  const call = session.calls.find((c) => c.method === 'Page.captureScreenshot');
  expect(call, 'no Page.captureScreenshot was ever sent').toBeDefined();
  return call!.params ?? {};
}

type Clip = { x: number; y: number; width: number; height: number; scale: number };

/** `SDK_SAFE_MAX_DIMENSION` in page-controller.ts — the cap the no-clip ladder decides against. */
const SDK_SAFE_MAX_DIMENSION = 1950;

describe('PageController no-Runtime.enable invariant', () => {
  it('excludes the fingerprinting enables from the exported allow-list', () => {
    for (const forbidden of FORBIDDEN_METHODS) {
      expect(CDP_ALLOWED_METHODS).not.toContain(forbidden);
    }
    // Sanity: the safe domain enables the controller genuinely needs ARE present.
    for (const allowed of ['Page.enable', 'DOM.enable', 'CSS.enable', 'Overlay.enable', 'Accessibility.enable']) {
      expect(CDP_ALLOWED_METHODS).toContain(allowed);
    }
  });

  it('never sends a forbidden enable and only sends allow-listed methods across a representative exercise', async () => {
    const session = new FakeCdpSession();
    const controller = new PageController({} as never, session as never);

    // Exercise every routing category: navigation, screenshot, JS eval, DOM, CSS, Overlay,
    // Accessibility, Input, Emulation, screencast.
    await controller.navigate('https://example.com');
    await controller.captureScreenshot({ format: 'jpeg', quality: 70 });
    await controller.evaluate('1 + 1');
    await controller.callFunctionOn('obj-1', 'function() { return 1; }');
    const doc = await controller.getDocument();
    const nodeId = await controller.querySelector(doc.root.nodeId, 'div');
    await controller.getOuterHTML(nodeId);
    await controller.getBoxModel(nodeId);
    await controller.describeNode(3);
    await controller.resolveNode(3);
    await controller.requestNode('obj-1');
    await controller.focus(nodeId);
    await controller.getComputedStyleForNode(nodeId);
    await controller.getMatchedStylesForNode(nodeId);
    await controller.getNodeForLocation(5, 5);
    await controller.setInspectMode('searchForNode');
    await controller.setInspectMode('none');
    await controller.getFullAXTree();
    await controller.getPartialAXTree(3);
    await controller.dispatchMouseEvent('mousePressed', 1, 1, { clickCount: 1 });
    await controller.dispatchWheelEvent(0, 0, 0, 100);
    await controller.dispatchKeyEvent('keyDown', { key: 'a', text: 'a' });
    await controller.insertText('hello');
    await controller.setViewport(1024, 768, 1);
    await controller.setUserAgentOverride('Mozilla/5.0 Chrome');
    await controller.startScreencast();
    await controller.stopScreencast();
    await controller.ackScreencastFrame(1);

    expect(session.sent.length).toBeGreaterThan(0);

    // No forbidden enable was ever sent.
    for (const forbidden of FORBIDDEN_METHODS) {
      expect(session.sent).not.toContain(forbidden);
    }
    // Belt-and-suspenders: no `*.enable` outside the safe set slipped through.
    const allowedSet = new Set<string>(CDP_ALLOWED_METHODS);
    for (const method of session.sent) {
      expect(allowedSet.has(method)).toBe(true);
    }
  });

  it('never sends a forbidden enable across the NEW Slice-4 known-viewport screenshot path', async () => {
    // The C7 ladder added a branch that skips the Runtime.evaluate probe. The invariant is asserted
    // again ON THAT BRANCH: a path that issues fewer calls must not have gained a different one.
    const session = new FakeCdpSession();
    const controller = new PageController({} as never, session as never);

    controller.setKnownViewport({ width: 1280, height: 720, dpr: 1 });   // under the cap
    await controller.captureScreenshot({ format: 'jpeg', quality: 70 });
    controller.setKnownViewport({ width: 3000, height: 2000, dpr: 1 });  // over the cap
    await controller.captureScreenshot({ format: 'jpeg', quality: 70 });
    await controller.setViewport(1024, 768, 2);                          // the seeding path
    await controller.captureScreenshot({ format: 'jpeg', quality: 70 });

    for (const forbidden of FORBIDDEN_METHODS) {
      expect(session.sent).not.toContain(forbidden);
    }
    const allowedSet = new Set<string>(CDP_ALLOWED_METHODS);
    for (const method of session.sent) {
      expect(allowedSet.has(method)).toBe(true);
    }
  });

  it('rejects any method not in the allow-list at the send chokepoint', async () => {
    const session = new FakeCdpSession();
    const controller = new PageController({} as never, session as never);
    // Reach the private send() via a public method that would route a disallowed method only if the
    // allow-list were bypassed; here we assert the guard directly by attempting a raw enable through
    // the typed surface is impossible — instead verify the allow-list gate rejects unknown methods.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const send = (controller as any).send.bind(controller) as (m: string) => Promise<unknown>;
    await expect(send('Runtime.enable')).rejects.toThrow(/allow-list/);
    expect(session.sent).not.toContain('Runtime.enable');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// Slice 4 / C7 — the known-viewport screenshot skips the per-call Runtime.evaluate probe.
//
// The acceptance criterion is a COUNT ("exactly one CDP call"), so every assertion here counts the
// fake session's sends. Each is paired with a control that makes the count differ, because
// `toEqual(['Page.captureScreenshot'])` would also pass against a fake that never recorded anything,
// or against a controller that had stopped probing for an unrelated reason.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe('C7 — captureScreenshot with a known viewport', () => {
  it('issues EXACTLY ONE send — Page.captureScreenshot — and no clip when under the cap', async () => {
    const session = new FakeCdpSession();
    const controller = new PageController({} as never, session as never);

    controller.setKnownViewport({ width: 1280, height: 720, dpr: 1 }); // 1280 < 1950

    const data = await controller.captureScreenshot({ format: 'jpeg', quality: 70 });

    // The criterion, mechanically: one round trip, and it is the capture itself.
    expect(session.sent).toEqual(['Page.captureScreenshot']);

    // Under the cap the params must not carry a `clip` KEY at all — an explicit `clip: undefined`
    // would still be serialized onto the wire by some transports.
    const params = screenshotParams(session);
    expect(params).not.toHaveProperty('clip');
    expect(params['format']).toBe('jpeg');
    expect(params['quality']).toBe(70);

    // The screenshot still came back — a "zero sends" implementation would also satisfy a
    // not.toContain('Runtime.evaluate') assertion while returning nothing useful.
    expect(data).toBe('BASE64DATA');
  });

  it('POSITIVE CONTROL: WITHOUT the seed the same call probes first (send count > 1)', async () => {
    // This is what makes the test above meaningful. If captureScreenshot never probed under any
    // circumstances, the one-send assertion would be vacuous.
    const session = new FakeCdpSession();
    const controller = new PageController({} as never, session as never);

    await controller.captureScreenshot({ format: 'jpeg', quality: 70 });

    expect(session.sent.length).toBeGreaterThan(1);
    expect(session.sent).toEqual(['Runtime.evaluate', 'Page.captureScreenshot']);
  });

  it('POSITIVE CONTROL: a nonsense cache (0/0/0) falls THROUGH to the probe (the sanity gate holds)', async () => {
    // A cache of zeros must not be trusted into a degenerate clip; the ladder's width>0 && height>0
    // && dpr>0 gate is what prevents that, and this is its executable proof.
    const session = new FakeCdpSession();
    const controller = new PageController({} as never, session as never);

    controller.setKnownViewport({ width: 0, height: 0, dpr: 0 });
    await controller.captureScreenshot({ format: 'jpeg', quality: 70 });

    expect(session.sent).toEqual(['Runtime.evaluate', 'Page.captureScreenshot']);
  });

  it('a known viewport OVER the cap still produces a clip — and STILL only one send', async () => {
    const session = new FakeCdpSession();
    const controller = new PageController({} as never, session as never);

    controller.setKnownViewport({ width: 3000, height: 2000, dpr: 1 });
    await controller.captureScreenshot({ format: 'jpeg', quality: 70 });

    expect(session.sent).toEqual(['Page.captureScreenshot']);

    const clip = screenshotParams(session)['clip'] as Clip;
    expect(clip).toBeDefined();
    // The cap is applied against the widest dimension: 3000 * 1 > 1950 ⇒ scale = 1950/3000.
    expect(clip.scale).toBeCloseTo(SDK_SAFE_MAX_DIMENSION / 3000, 10);
    // The clip is expressed in CSS units at the origin (the SDK downscales, it does not crop).
    expect(clip).toMatchObject({ x: 0, y: 0, width: 3000, height: 2000 });
    // The scaled result actually fits the cap — the point of the whole branch.
    expect(3000 * clip.scale).toBeLessThanOrEqual(SDK_SAFE_MAX_DIMENSION);
  });

  it('applies the cap against PHYSICAL pixels, so a hi-dpi viewport under the CSS cap still clips', async () => {
    // 1024 CSS px looks safe; at dpr 2 it is 2048 physical px and must be capped. A ladder that
    // forgot dpr would emit no clip here and silently exceed the SDK limit.
    const session = new FakeCdpSession();
    const controller = new PageController({} as never, session as never);

    controller.setKnownViewport({ width: 1024, height: 768, dpr: 2 });
    await controller.captureScreenshot({ format: 'jpeg', quality: 70 });

    expect(session.sent).toEqual(['Page.captureScreenshot']);
    const clip = screenshotParams(session)['clip'] as Clip;
    expect(clip.scale).toBeCloseTo(SDK_SAFE_MAX_DIMENSION / 2048, 10);
  });

  it('setViewport SEEDS the cache, so the very next screenshot is probe-free', async () => {
    // The refresh path resizeEntry relies on (index.ts:1878 → setViewport). controller-service
    // deliberately added no second setKnownViewport call there; this asserts that decision is sound
    // rather than an omission.
    const session = new FakeCdpSession();
    const controller = new PageController({} as never, session as never);

    await controller.setViewport(1024, 768, 2);
    await controller.captureScreenshot({ format: 'jpeg', quality: 70 });

    expect(session.sent).toEqual(['Emulation.setDeviceMetricsOverride', 'Page.captureScreenshot']);
    expect(session.sent).not.toContain('Runtime.evaluate');
    const clip = screenshotParams(session)['clip'] as Clip;
    expect(clip.scale).toBeCloseTo(SDK_SAFE_MAX_DIMENSION / 2048, 10);
  });

  it('a STALE cache changes only the clip — a screenshot is still returned', async () => {
    // The WHY comment's claim, made executable: an undersized/oversized cache mis-decides the cap and
    // nothing else. Both directions return real image data in exactly one send.
    const undersized = new FakeCdpSession();
    const c1 = new PageController({} as never, undersized as never);
    c1.setKnownViewport({ width: 100, height: 100, dpr: 1 }); // page is really much larger
    expect(await c1.captureScreenshot({ format: 'jpeg', quality: 70 })).toBe('BASE64DATA');
    expect(undersized.sent).toEqual(['Page.captureScreenshot']);
    expect(screenshotParams(undersized)).not.toHaveProperty('clip');

    const oversized = new FakeCdpSession();
    const c2 = new PageController({} as never, oversized as never);
    c2.setKnownViewport({ width: 9000, height: 9000, dpr: 1 }); // page is really much smaller
    expect(await c2.captureScreenshot({ format: 'jpeg', quality: 70 })).toBe('BASE64DATA');
    expect(oversized.sent).toEqual(['Page.captureScreenshot']);
    expect(screenshotParams(oversized)['clip']).toBeDefined();
  });

  it('tier 1 and tier 2 agree GIVEN THE SAME w/h/dpr (tier 1 caches tier 2 answer)', async () => {
    // Scoped per controller-service + agent-tools: the two tiers share one formula but NOT one input
    // (tier 2 reads clientWidth/Height, which excludes a classic scrollbar). So this exercises the
    // shared formula with identical numbers rather than asserting a cross-tier equality that would
    // flake the day a page shows classic scrollbars.
    const W = 2400, H = 1600, DPR = 1;

    const tier1Session = new FakeCdpSession();
    const tier1 = new PageController({} as never, tier1Session as never);
    tier1.setKnownViewport({ width: W, height: H, dpr: DPR });
    await tier1.captureScreenshot({ format: 'jpeg', quality: 70 });

    // Drive tier 2 with the SAME numbers (the shared fake answers 800x600 by default).
    const tier2Session = new FakeCdpSession();
    const baseSend = tier2Session.send.bind(tier2Session);
    tier2Session.send = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      const out = await baseSend(method, params);
      return method === 'Runtime.evaluate'
        ? { result: { type: 'string', value: JSON.stringify({ w: W, h: H, dpr: DPR }) } }
        : out;
    };
    const tier2 = new PageController({} as never, tier2Session as never);
    await tier2.captureScreenshot({ format: 'jpeg', quality: 70 });

    expect(screenshotParams(tier1Session)['clip']).toEqual(screenshotParams(tier2Session)['clip']);
    // POSITIVE CONTROL: tier 2 really did take its probe path, so the equality is cross-tier and not
    // tier 1 compared against itself.
    expect(tier2Session.sent).toEqual(['Runtime.evaluate', 'Page.captureScreenshot']);
    expect(tier1Session.sent).toEqual(['Page.captureScreenshot']);
  });

  it('leaves the explicit-clip branch completely unchanged', async () => {
    // C7 touched only the no-clip branch. A caller-supplied clip must still be honoured, with no
    // probe and no interference from the cache.
    const session = new FakeCdpSession();
    const controller = new PageController({} as never, session as never);
    controller.setKnownViewport({ width: 3000, height: 2000, dpr: 1 });

    await controller.captureScreenshot({
      format: 'jpeg',
      quality: 70,
      clip: { x: 10, y: 20, width: 100, height: 50, scale: 1 },
    });

    expect(session.sent).toEqual(['Page.captureScreenshot']);
    expect(screenshotParams(session)['clip']).toEqual({ x: 10, y: 20, width: 100, height: 50, scale: 1 });
  });

  it('setKnownViewport is PURE — it issues no CDP of its own', () => {
    const session = new FakeCdpSession();
    const controller = new PageController({} as never, session as never);

    controller.setKnownViewport({ width: 1280, height: 720, dpr: 1 });
    controller.setKnownViewport({ width: 800, height: 600, dpr: 2 });

    expect(session.sent).toEqual([]);
  });

  it('COPIES its argument, so a later mutation of the caller object cannot corrupt the cache', async () => {
    // doRegisterPage passes entry.viewport, which the service reassigns on resize. Aliasing would let
    // the cache drift silently; the copy makes setViewport the single writer.
    const session = new FakeCdpSession();
    const controller = new PageController({} as never, session as never);

    const live = { width: 1280, height: 720, dpr: 1 };
    controller.setKnownViewport(live);
    live.width = 9000; // an over-cap value that WOULD introduce a clip if the cache aliased it
    live.height = 9000;

    await controller.captureScreenshot({ format: 'jpeg', quality: 70 });

    expect(session.sent).toEqual(['Page.captureScreenshot']);
    expect(screenshotParams(session)).not.toHaveProperty('clip');
  });

  it('CDP_ALLOWED_METHODS gained NO entries for this slice', () => {
    // The brief's hard constraint. Pinned as an exact list so ANY addition — not merely a forbidden
    // one — fails here and has to be justified. The length is asserted separately so a swap cannot
    // hide inside a reordering.
    expect([...CDP_ALLOWED_METHODS]).toEqual([
      'Page.enable',
      'DOM.enable',
      'CSS.enable',
      'Overlay.enable',
      'Accessibility.enable',
      'Page.navigate',
      'Page.captureScreenshot',
      'Page.getLayoutMetrics',
      'Page.startScreencast',
      'Page.stopScreencast',
      'Page.screencastFrameAck',
      'Runtime.evaluate',
      'Runtime.callFunctionOn',
      'Runtime.addBinding',
      'DOM.getDocument',
      'DOM.querySelector',
      'DOM.getOuterHTML',
      'DOM.getBoxModel',
      'DOM.describeNode',
      'DOM.resolveNode',
      'DOM.requestNode',
      'DOM.focus',
      'DOM.getNodeForLocation',
      'CSS.getComputedStyleForNode',
      'CSS.getMatchedStylesForNode',
      'Overlay.setInspectMode',
      'Accessibility.getFullAXTree',
      'Accessibility.getPartialAXTree',
      'Input.dispatchMouseEvent',
      'Input.dispatchKeyEvent',
      'Input.insertText',
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setUserAgentOverride',
    ]);
    expect(CDP_ALLOWED_METHODS).toHaveLength(33);
  });
});
