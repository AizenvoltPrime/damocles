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
  async send(method: string): Promise<unknown> {
    this.sent.push(method);
    return fakeResponse(method);
  }
  on(): this {
    return this;
  }
}

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
