export type BrowserSessionState = 'disconnected' | 'browsing' | 'connected';

/**
 * A network-interception rule applied to the browser context via Playwright `context.route`. Patterns
 * MUST be narrow (e.g. `**\/*.png`, `**\/analytics.js`, `https://api.example.com/**`) — a blanket `**`
 * would swallow the main-document request Patchright needs for its stealth init-script injection.
 */
export interface InterceptRule {
  /** Generated id: `ir_${base36 time}${base36 rand}`. */
  id: string;
  /** Narrow glob/regex passed to context.route (NEVER a blanket `**`). */
  pattern: string;
  /** block → abort; continue → fallback/continue-with-headers; fulfill → stub response. */
  action: 'block' | 'continue' | 'fulfill';
  /** For `fulfill`: the stub response returned to the page. */
  fulfill?: { status: number; headers?: Record<string, string>; body?: string };
  /** For `continue`: request headers to merge/override before the request proceeds. */
  modify?: { headers?: Record<string, string> };
}

/**
 * Redacted list view of an intercept rule. The raw fulfill body is NEVER exposed (it may carry
 * secrets) — only its byte length is reported as `bodyBytes`.
 */
export interface RedactedInterceptRule {
  id: string;
  pattern: string;
  action: 'block' | 'continue' | 'fulfill';
  status?: number;
  bodyBytes?: number;
  modifyHeaderKeys?: string[];
  fulfillHeaderKeys?: string[];
}

export interface BoxModel {
  content: number[];
  padding: number[];
  border: number[];
  margin: number[];
  width: number;
  height: number;
}

export interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  objectId?: string;
}

export interface NodeDescription {
  nodeId: number;
  backendNodeId: number;
  nodeName: string;
  localName: string;
  nodeValue: string;
  attributes?: string[];
}

export interface ComputedStyleProperty {
  name: string;
  value: string;
}

export interface MatchedStyleRule {
  rule: {
    selectorList?: { selectors?: { text: string }[] };
    style: { cssProperties: { name: string; value: string; text?: string }[] };
    origin: string;
  };
}

export interface MatchedStyles {
  matchedCSSRules?: MatchedStyleRule[];
  inherited?: { matchedCSSRules?: MatchedStyleRule[] }[];
  inlineStyle?: { cssProperties: { name: string; value: string; text?: string }[] };
}

export interface ElementOverlayInfo {
  selector: string;
  tagName: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  padding: string;
}
