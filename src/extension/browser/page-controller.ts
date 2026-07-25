import type { Page, CDPSession } from 'patchright';
import type { BoxModel, RemoteObject, NodeDescription, ComputedStyleProperty, MatchedStyles } from './types';

const SDK_SAFE_MAX_DIMENSION = 1950;

/**
 * The COMPLETE set of CDP methods `PageController` is permitted to send over its leak-free
 * `CDPSession`. `Runtime.enable` is deliberately ABSENT — enabling the Runtime domain forces Chromium
 * to report execution contexts, which is the single biggest CDP bot-detection tell (Cloudflare /
 * DataDome / etc. key off it). Patchright's core patch is avoiding it, and this list is the enforced
 * mirror of that guarantee: the `send()` chokepoint below rejects anything not in this set, and a unit
 * guard (page-controller-no-runtime-enable.test.ts) asserts `Runtime.enable` is not present.
 *
 * Runtime.evaluate / Runtime.callFunctionOn / Runtime.addBinding all work WITHOUT Runtime.enable, so
 * JS execution and bindings are fully functional while the fingerprint stays clean.
 */
export const CDP_ALLOWED_METHODS = [
  // Domain enables. These are REQUIRED for the CSS/Overlay/Accessibility (and Page-screencast) methods
  // below to function at all — e.g. CSS.getComputedStyleForNode errors with "CSS agent was not enabled"
  // otherwise. Crucially, NONE of these is a bot-detection tell: only `Runtime.enable` (execution-context
  // reporting) and `Console.enable` are fingerprints, and BOTH are deliberately ABSENT from this list and
  // never sent. Enabling CSS/DOM/Overlay/Accessibility/Page is standard and page-invisible.
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
] as const;

export type CdpAllowedMethod = (typeof CDP_ALLOWED_METHODS)[number];

const CDP_ALLOWED_SET: ReadonlySet<string> = new Set<string>(CDP_ALLOWED_METHODS);

/**
 * Playwright-backed replacement for the old raw-CDP `CdpBridge`. It exposes the EXACT method surface
 * the 16 not-yet-migrated browser tools, the element picker, and the panel input handlers already use,
 * so they keep compiling and running unchanged (strangler-fig seam). DOM/CSS/Overlay/Accessibility/
 * Input/Emulation and JS evaluation all run over a single leak-free `CDPSession`
 * (`context.newCDPSession(page)`) which NEVER sends `Runtime.enable`.
 */
/**
 * Domains PageController may lazily `.enable` on demand. Enabling these is required for their query
 * methods to work and is NOT a detection concern. `Runtime` / `Console` / `Network` are intentionally
 * excluded — `Runtime.enable` (and `Console.enable`) are the fingerprints Patchright exists to avoid,
 * and network errors are collected via Playwright page events, not a CDP Network domain.
 */
const ENABLEABLE_DOMAINS = ['Page', 'DOM', 'CSS', 'Overlay', 'Accessibility'] as const;
type EnableableDomain = (typeof ENABLEABLE_DOMAINS)[number];

export class PageController {
  private readonly page: Page;
  private readonly session: CDPSession;
  private emulatedDpr = 1;
  private knownViewport: { width: number; height: number; dpr: number } | null = null;
  private readonly enabledDomains = new Set<EnableableDomain>();

  constructor(page: Page, session: CDPSession) {
    this.page = page;
    this.session = session;
  }

  /** The wrapped Playwright page (used by BrowserService for page-level events / lifecycle). */
  getPage(): Page {
    return this.page;
  }

  /**
   * The SINGLE chokepoint for raw CDP. INVARIANT: never send `Runtime.enable` (or anything outside
   * CDP_ALLOWED_METHODS). Enabling Runtime is the biggest CDP-automation fingerprint; keeping every raw
   * command funnelled through here — and asserted against the allow-list — is what makes the
   * no-Runtime.enable guarantee enforceable in exactly one place.
   */
  private async send<T = unknown>(method: CdpAllowedMethod, params?: Record<string, unknown>): Promise<T> {
    if (!CDP_ALLOWED_SET.has(method)) {
      throw new Error(`CDP method not permitted by PageController allow-list: ${method}`);
    }
    // Patchright's CDPSession.send is protocol-typed; the allow-list has already validated the method.
    return this.session.send(method as never, params as never) as Promise<T>;
  }

  /**
   * Enable a domain once per session before its first query. NEVER used for Runtime/Console/Network —
   * `ENABLEABLE_DOMAINS` is the compile-time guard for that, and the `.enable` methods live in the
   * allow-list. Idempotent: subsequent calls for an already-enabled domain are no-ops.
   */
  private async ensureDomain(domain: EnableableDomain): Promise<void> {
    if (this.enabledDomains.has(domain)) return;
    this.enabledDomains.add(domain);
    try {
      await this.send(`${domain}.enable` as CdpAllowedMethod);
    } catch (err) {
      // A failed enable must not be silently treated as enabled — surface it so the caller's query
      // fails loudly rather than with a confusing "agent not enabled" downstream.
      this.enabledDomains.delete(domain);
      throw err;
    }
  }

  async navigate(url: string): Promise<{ frameId: string; loaderId: string }> {
    return this.send('Page.navigate', { url });
  }

  async captureScreenshot(
    options?: { clip?: { x: number; y: number; width: number; height: number; scale: number } } & (
      | { format?: 'png' }
      | { format: 'jpeg'; quality?: number }
    ),
  ): Promise<string> {
    const params: Record<string, unknown> = { format: options?.format ?? 'png' };
    // CDP rejects the quality param for png captures; only send it for jpeg.
    if (options?.format === 'jpeg') {
      params['quality'] = options.quality ?? 70;
    }

    if (options?.clip) {
      const { x, y, width, height, scale } = options.clip;
      if (width > 0 && height > 0) {
        const maxScale = Math.min(scale, SDK_SAFE_MAX_DIMENSION / (width * this.emulatedDpr), SDK_SAFE_MAX_DIMENSION / (height * this.emulatedDpr));
        params['clip'] = { x, y, width, height, scale: maxScale };
      }
    } else if (
      this.knownViewport &&
      this.knownViewport.width > 0 &&
      this.knownViewport.height > 0 &&
      this.knownViewport.dpr > 0
    ) {
      // The service already knows the emulated viewport, so the per-screenshot Runtime.evaluate probe
      // is pure overhead. Safe even if the cache lags a resize: it feeds ONLY the SDK_SAFE_MAX_DIMENSION
      // cap decision, so a stale value can at worst mis-size the downscale clip — it can never corrupt
      // the captured image, which is always the live frame.
      const { width, height, dpr } = this.knownViewport;
      const pixelW = width * dpr;
      const pixelH = height * dpr;
      if (pixelW > SDK_SAFE_MAX_DIMENSION || pixelH > SDK_SAFE_MAX_DIMENSION) {
        const scale = Math.min(SDK_SAFE_MAX_DIMENSION / pixelW, SDK_SAFE_MAX_DIMENSION / pixelH);
        params['clip'] = { x: 0, y: 0, width, height, scale };
      }
    } else {
      try {
        const info = await this.evaluate(
          'JSON.stringify({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight, dpr: window.devicePixelRatio })',
        );
        const { w, h, dpr } = JSON.parse(info.value as string) as { w: number; h: number; dpr: number };
        if (w > 0 && h > 0 && dpr > 0) {
          const pixelW = w * dpr;
          const pixelH = h * dpr;
          if (pixelW > SDK_SAFE_MAX_DIMENSION || pixelH > SDK_SAFE_MAX_DIMENSION) {
            const scale = Math.min(SDK_SAFE_MAX_DIMENSION / pixelW, SDK_SAFE_MAX_DIMENSION / pixelH);
            params['clip'] = { x: 0, y: 0, width: w, height: h, scale };
          }
        }
      } catch {
        try {
          const metrics = await this.send<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>(
            'Page.getLayoutMetrics',
          );
          const w = metrics.cssLayoutViewport.clientWidth;
          const h = metrics.cssLayoutViewport.clientHeight;
          if (w > 0 && h > 0) {
            const scale = Math.min(1, SDK_SAFE_MAX_DIMENSION / (w * this.emulatedDpr), SDK_SAFE_MAX_DIMENSION / (h * this.emulatedDpr));
            params['clip'] = { x: 0, y: 0, width: w, height: h, scale };
          }
        } catch {
          // Last resort — unconstrained capture
        }
      }
    }

    const result = await this.send<{ data: string }>('Page.captureScreenshot', params);
    return result.data;
  }

  async getDocument(): Promise<{ root: { nodeId: number } }> {
    await this.ensureDomain('DOM');
    return this.send('DOM.getDocument', { depth: 0 });
  }

  async querySelector(nodeId: number, selector: string): Promise<number> {
    const result = await this.send<{ nodeId: number }>('DOM.querySelector', { nodeId, selector });
    return result.nodeId;
  }

  async getOuterHTML(nodeId?: number, backendNodeId?: number): Promise<string> {
    const params: Record<string, unknown> = {};
    if (nodeId !== undefined) params['nodeId'] = nodeId;
    if (backendNodeId !== undefined) params['backendNodeId'] = backendNodeId;
    const result = await this.send<{ outerHTML: string }>('DOM.getOuterHTML', params);
    return result.outerHTML;
  }

  async describeNode(backendNodeId: number): Promise<NodeDescription> {
    const result = await this.send<{ node: NodeDescription }>('DOM.describeNode', { backendNodeId });
    return result.node;
  }

  async getBoxModel(nodeId?: number, backendNodeId?: number): Promise<BoxModel> {
    const params: Record<string, unknown> = {};
    if (nodeId !== undefined) params['nodeId'] = nodeId;
    if (backendNodeId !== undefined) params['backendNodeId'] = backendNodeId;
    const result = await this.send<{ model: BoxModel }>('DOM.getBoxModel', params);
    return result.model;
  }

  async resolveNode(backendNodeId: number): Promise<RemoteObject> {
    const result = await this.send<{ object: RemoteObject }>('DOM.resolveNode', { backendNodeId });
    return result.object;
  }

  async focus(nodeId?: number, backendNodeId?: number): Promise<void> {
    const params: Record<string, unknown> = {};
    if (nodeId !== undefined) params['nodeId'] = nodeId;
    if (backendNodeId !== undefined) params['backendNodeId'] = backendNodeId;
    await this.send('DOM.focus', params);
  }

  async requestNode(objectId: string): Promise<number> {
    const result = await this.send<{ nodeId: number }>('DOM.requestNode', { objectId });
    return result.nodeId;
  }

  async getComputedStyleForNode(nodeId: number): Promise<ComputedStyleProperty[]> {
    await this.ensureDomain('DOM');
    await this.ensureDomain('CSS');
    const result = await this.send<{ computedStyle: ComputedStyleProperty[] }>(
      'CSS.getComputedStyleForNode',
      { nodeId },
    );
    return result.computedStyle;
  }

  async getMatchedStylesForNode(nodeId: number): Promise<MatchedStyles> {
    await this.ensureDomain('DOM');
    await this.ensureDomain('CSS');
    return this.send<MatchedStyles>('CSS.getMatchedStylesForNode', { nodeId });
  }

  async callFunctionOn(objectId: string, functionDeclaration: string, returnByValue = true): Promise<RemoteObject> {
    const result = await this.send<{ result: RemoteObject; exceptionDetails?: unknown }>(
      'Runtime.callFunctionOn',
      { objectId, functionDeclaration, returnByValue },
    );
    if (result.exceptionDetails) {
      throw new Error(`callFunctionOn failed: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result;
  }

  /**
   * Evaluate JS in the page's MAIN world (decision #2 — reads page globals like window.__NUXT__),
   * replicating the old CdpBridge.evaluate byte-for-byte: `Runtime.evaluate` with returnByValue and
   * awaitPromise, exceptionDetails → throw `JS evaluation failed: ...`, returns the RemoteObject
   * `{ type, subtype?, value?, description?, objectId? }`. Sent over the leak-free CDPSession — with no
   * `contextId`, `Runtime.evaluate` targets the top frame's default (main) context and needs NO
   * `Runtime.enable`.
   *
   * `timeoutMs`, when provided, bounds the await (the tool layer clamps it 1000–120000ms); when omitted
   * the call resolves whenever the evaluation settles (Playwright's CDP transport imposes no artificial
   * per-command timeout, and the tool boundary already races the turn's abort signal).
   */
  async evaluate(expression: string, returnByValue = true, timeoutMs?: number): Promise<RemoteObject> {
    const call = this.send<{ result: RemoteObject; exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression,
      returnByValue,
      awaitPromise: true,
    });
    const result = timeoutMs !== undefined ? await withTimeout(call, timeoutMs, expression) : await call;
    if (result.exceptionDetails) {
      throw new Error(`JS evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result;
  }

  async dispatchMouseEvent(
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
    x: number,
    y: number,
    options?: { button?: 'none' | 'left' | 'right' | 'middle'; clickCount?: number; buttons?: number; modifiers?: number },
  ): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: options?.button ?? 'left',
      clickCount: options?.clickCount ?? 1,
      ...(options?.buttons !== undefined && { buttons: options.buttons }),
      ...(options?.modifiers !== undefined && { modifiers: options.modifiers }),
    });
  }

  // Wheel deltas follow the DOM convention (positive deltaY = scroll down) and are forwarded to CDP
  // UNCHANGED. This method is the single future negation point if a Chromium build ever inverts the
  // wheel sign; do not flip signs at the call sites.
  async dispatchWheelEvent(x: number, y: number, deltaX: number, deltaY: number, modifiers?: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
      pointerType: 'mouse',
      ...(modifiers !== undefined && { modifiers }),
    });
  }

  async dispatchKeyEvent(
    type: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char',
    options: {
      text?: string;
      key?: string;
      code?: string;
      unmodifiedText?: string;
      modifiers?: number;
      windowsVirtualKeyCode?: number;
      nativeVirtualKeyCode?: number;
    },
  ): Promise<void> {
    await this.send('Input.dispatchKeyEvent', { type, ...options });
  }

  async getNodeForLocation(x: number, y: number): Promise<{ backendNodeId: number; frameId: string; nodeId: number }> {
    await this.ensureDomain('DOM');
    return this.send('DOM.getNodeForLocation', { x, y });
  }

  async setInspectMode(
    mode: 'searchForNode' | 'none',
    highlightConfig?: Record<string, unknown>,
  ): Promise<void> {
    await this.ensureDomain('DOM');
    await this.ensureDomain('Overlay');
    await this.send('Overlay.setInspectMode', {
      mode,
      highlightConfig: highlightConfig ?? {
        showInfo: true,
        contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
        paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
        borderColor: { r: 255, g: 229, b: 153, a: 0.75 },
        marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
      },
    });
  }

  async startScreencast(options?: {
    format?: 'jpeg' | 'png';
    quality?: number;
    maxWidth?: number;
    maxHeight?: number;
    everyNthFrame?: number;
  }): Promise<void> {
    await this.ensureDomain('Page');
    await this.send('Page.startScreencast', {
      format: options?.format ?? 'jpeg',
      quality: options?.quality ?? 60,
      maxWidth: options?.maxWidth ?? 1280,
      maxHeight: options?.maxHeight ?? 720,
      everyNthFrame: options?.everyNthFrame ?? 1,
    });
  }

  async stopScreencast(): Promise<void> {
    await this.send('Page.stopScreencast');
  }

  async ackScreencastFrame(sessionId: number): Promise<void> {
    await this.send('Page.screencastFrameAck', { sessionId });
  }

  /** Pure: records the CSS viewport BrowserService already knows. Issues NO CDP. */
  setKnownViewport(viewport: { width: number; height: number; dpr: number }): void {
    this.knownViewport = { ...viewport };
  }

  async setViewport(width: number, height: number, deviceScaleFactor = 1): Promise<void> {
    this.emulatedDpr = deviceScaleFactor;
    this.setKnownViewport({ width, height, dpr: deviceScaleFactor });
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile: false,
    });
  }

  async setUserAgentOverride(userAgent: string): Promise<void> {
    await this.send('Emulation.setUserAgentOverride', { userAgent });
  }

  async getFullAXTree(): Promise<unknown> {
    await this.ensureDomain('Accessibility');
    return this.send('Accessibility.getFullAXTree');
  }

  async getPartialAXTree(backendNodeId: number): Promise<unknown> {
    await this.ensureDomain('Accessibility');
    return this.send('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: true });
  }

  // Panel live-input handlers (src/extension/browser/index.ts) drive keystrokes/paste through
  // insertText; the action tools now use Playwright locators (auto-wait), so the old composite
  // helpers (clickSelector/typeText/selectAllAndDelete/resolveSelector/waitForSelector) were removed.
  async insertText(text: string): Promise<void> {
    await this.send('Input.insertText', { text });
  }
}

/**
 * Bound an in-flight CDP evaluation. Unlike the old raw socket (which imposed a per-request timeout),
 * Playwright's CDPSession has none, so `browser_evaluate`'s explicit `timeoutMs` is honoured here.
 * Rejects — never resolves with a masked/empty value — so a genuine hang surfaces as an error.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, expression: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const preview = expression.length > 80 ? expression.slice(0, 77) + '...' : expression;
      reject(new Error(`JS evaluation timed out after ${timeoutMs}ms: ${preview}`));
    }, timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
