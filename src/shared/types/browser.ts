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

/** One dialog Damocles answered on the agent's behalf, so an auto-accepted `confirm()` leaves a trace. */
export interface BrowserDialogRecord {
  /** `dialog.type()`: alert | confirm | prompt | beforeunload. */
  type: string;
  message: string;
  answered: "accepted" | "accept-failed";
  timestamp: number;
}

export interface DownloadEntry {
  filename: string;
  /** Absolute path to the saved file on disk. Empty when the download was rejected and never written. */
  savedPath: string;
  url: string;
  state: "completed" | "failed" | "rejected";
  /** Size of the download as measured on Playwright's temp file, when it could be measured. */
  sizeBytes?: number;
}
