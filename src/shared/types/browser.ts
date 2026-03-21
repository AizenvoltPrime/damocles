export interface ElementAttachment {
  id: string;
  selector: string;
  tagName: string;
  attributes: Record<string, string>;
  outerHTML: string;
  computedStyles: Record<string, string>;
  boundingBox: { x: number; y: number; width: number; height: number };
  elementScreenshot: string;
  consoleMessages: ConsoleEntry[];
  networkErrors: NetworkError[];
  htmlPath?: string;
  matchedRules?: string;
  innerText?: string;
}

export interface ConsoleEntry {
  level: string;
  text: string;
  timestamp: number;
}

export interface NetworkError {
  url: string;
  status?: number;
  statusText?: string;
  type: "failed" | "error";
  timestamp: number;
}

export const BROWSER_SERVER_NAME = "DamoclesBrowser" as const;
export const BROWSER_MCP_SERVER_NAME = "damocles-browser" as const;
