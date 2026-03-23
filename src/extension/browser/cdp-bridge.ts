import type { CdpSocket } from './cdp-socket';
import type { BoxModel, RemoteObject, NodeDescription, ComputedStyleProperty, MatchedStyles } from './types';

const DOMAIN_TIMEOUT_MS = 5_000;
const SDK_SAFE_MAX_DIMENSION = 1950;

export class CdpBridge {
  private readonly socket: CdpSocket;
  private readonly sessionId: string | undefined;

  constructor(socket: CdpSocket, sessionId?: string) {
    this.socket = socket;
    this.sessionId = sessionId;
  }

  private async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.socket.send(method, params, this.sessionId) as Promise<T>;
  }

  async enableDomains(): Promise<void> {
    const enableWithTimeout = (domain: string) =>
      Promise.race([
        this.send(`${domain}.enable`),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`CDP ${domain}.enable timed out after ${DOMAIN_TIMEOUT_MS}ms`)), DOMAIN_TIMEOUT_MS),
        ),
      ]);
    await Promise.all([
      enableWithTimeout('Page'),
      enableWithTimeout('DOM'),
      enableWithTimeout('CSS'),
      enableWithTimeout('Runtime'),
      enableWithTimeout('Network'),
      enableWithTimeout('Overlay'),
      enableWithTimeout('Accessibility'),
    ]);
  }

  async navigate(url: string): Promise<{ frameId: string; loaderId: string }> {
    return this.send('Page.navigate', { url });
  }

  async captureScreenshot(options?: {
    clip?: { x: number; y: number; width: number; height: number; scale: number };
  }): Promise<string> {
    const params: Record<string, unknown> = { format: 'png' };

    if (options?.clip) {
      const { x, y, width, height, scale } = options.clip;
      if (width > 0 && height > 0) {
        const maxScale = Math.min(scale, SDK_SAFE_MAX_DIMENSION / width, SDK_SAFE_MAX_DIMENSION / height);
        params['clip'] = { x, y, width, height, scale: maxScale };
      }
    } else {
      try {
        const info = await this.evaluate(
          'JSON.stringify({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight, dpr: window.devicePixelRatio })',
        );
        const { w, h, dpr } = JSON.parse(info.value as string) as { w: number; h: number; dpr: number };
        if (w > 0 && h > 0 && dpr > 0) {
          const maxScale = Math.min(dpr, SDK_SAFE_MAX_DIMENSION / w, SDK_SAFE_MAX_DIMENSION / h);
          if (maxScale < dpr) {
            params['clip'] = { x: 0, y: 0, width: w, height: h, scale: maxScale };
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
            const safeScale = Math.min(1, SDK_SAFE_MAX_DIMENSION / w, SDK_SAFE_MAX_DIMENSION / h);
            params['clip'] = { x: 0, y: 0, width: w, height: h, scale: safeScale };
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
    const result = await this.send<{ computedStyle: ComputedStyleProperty[] }>(
      'CSS.getComputedStyleForNode',
      { nodeId },
    );
    return result.computedStyle;
  }

  async getMatchedStylesForNode(nodeId: number): Promise<MatchedStyles> {
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

  async evaluate(expression: string, returnByValue = true): Promise<RemoteObject> {
    const result = await this.send<{ result: RemoteObject; exceptionDetails?: unknown }>(
      'Runtime.evaluate',
      {
        expression,
        returnByValue,
        awaitPromise: true,
      },
    );
    if (result.exceptionDetails) {
      throw new Error(`JS evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result;
  }

  async dispatchMouseEvent(
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
    x: number,
    y: number,
    options?: { button?: 'none' | 'left' | 'right' | 'middle'; clickCount?: number; buttons?: number },
  ): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: options?.button ?? 'left',
      clickCount: options?.clickCount ?? 1,
      ...(options?.buttons !== undefined && { buttons: options.buttons }),
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
    return this.send('DOM.getNodeForLocation', { x, y });
  }

  async setInspectMode(
    mode: 'searchForNode' | 'none',
    highlightConfig?: Record<string, unknown>,
  ): Promise<void> {
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

  async setViewport(width: number, height: number, deviceScaleFactor = 1): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile: false,
    });
  }

  async getFullAXTree(): Promise<unknown> {
    return this.send('Accessibility.getFullAXTree');
  }

  async getPartialAXTree(backendNodeId: number): Promise<unknown> {
    return this.send('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: true });
  }

  async resolveSelector(selector: string): Promise<{ nodeId: number; x: number; y: number }> {
    const doc = await this.getDocument();
    const nodeId = await this.querySelector(doc.root.nodeId, selector);
    if (!nodeId) throw new Error(`Element not found: ${selector}`);
    await this.evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'nearest', inline: 'nearest' })`,
    );
    const box = await this.getBoxModel(nodeId);
    const quad = box.content;
    const x = ((quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4);
    const y = ((quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4);
    return { nodeId, x, y };
  }

  async clickSelector(selector: string): Promise<void> {
    const { x, y } = await this.resolveSelector(selector);
    await this.dispatchMouseEvent('mousePressed', x, y, { clickCount: 1 });
    await this.dispatchMouseEvent('mouseReleased', x, y, { clickCount: 1 });
  }

  async typeText(text: string): Promise<void> {
    for (const char of text) {
      await this.dispatchKeyEvent('keyDown', { key: char, text: char });
      await this.dispatchKeyEvent('keyUp', { key: char });
    }
  }

  async insertText(text: string): Promise<void> {
    await this.send('Input.insertText', { text });
  }

  async selectAllAndDelete(): Promise<void> {
    await this.evaluate(`(() => {
      const el = document.activeElement;
      if (!el) return;
      if ('select' in el && typeof el.select === 'function') el.select();
      else if (el.isContentEditable) {
        const r = document.createRange();
        r.selectNodeContents(el);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      }
    })()`);
    await this.dispatchKeyEvent('keyDown', { key: 'Backspace', code: 'Backspace' });
    await this.dispatchKeyEvent('keyUp', { key: 'Backspace', code: 'Backspace' });
  }

  async waitForSelector(selector: string, timeoutMs = 10000): Promise<number> {
    const pollInterval = 100;
    const maxAttempts = Math.ceil(timeoutMs / pollInterval);
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const doc = await this.getDocument();
        const nodeId = await this.querySelector(doc.root.nodeId, selector);
        if (nodeId) return nodeId;
      } catch {
        /* polling */
      }
      await new Promise(r => setTimeout(r, pollInterval));
    }
    throw new Error(`Timeout waiting for selector: ${selector}`);
  }
}
