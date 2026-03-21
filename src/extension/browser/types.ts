export type BrowserSessionState = 'disconnected' | 'browsing' | 'connected';

export interface CdpResponse<T = unknown> {
  result: T;
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
