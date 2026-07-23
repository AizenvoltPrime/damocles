import type { ConsoleEntry, NetworkError } from '../../shared/types/browser';

const MAX_ENTRIES = 100;

/**
 * Console message ring buffer.
 *
 * IMPORTANT — INERT UNDER PATCHRIGHT: Patchright patches out `Console.enable` (another CDP
 * bot-detection tell), which disables Playwright's console pipeline, so `page.on('console')` /
 * `page.on('pageerror')` DO NOT FIRE. This collector therefore stays wired but is expected to remain
 * empty. That is intentional and documented; we NEVER fabricate console output to paper over it —
 * `BrowserConsole` truthfully returns "no messages" rather than inventing any.
 */
export class ConsoleCollector {
  private entries: ConsoleEntry[] = [];

  /** Record one console message. Fed from `page.on('console')` in BrowserService (see inertness note). */
  record(level: string, text: string): void {
    this.entries.push({ level, text, timestamp: Date.now() });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }
  }

  getMessages(): ConsoleEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }
}

/**
 * Network error ring buffer, fed by Playwright page events via thin adapter shims in BrowserService:
 *  - `page.on('response')` → `recordResponse` (only HTTP status ≥ 400 is retained)
 *  - `page.on('requestfailed')` → `recordRequestFailed` (transport-level failures: DNS, aborted, etc.)
 *
 * Storage semantics are unchanged from the raw-CDP collector: a bounded ring buffer of the most recent
 * MAX_ENTRIES entries, shaped as the shared `NetworkError` type.
 */
export class NetworkCollector {
  private errors: NetworkError[] = [];

  recordResponse(url: string, status: number, statusText: string): void {
    if (status < 400) return;
    this.errors.push({
      url,
      status,
      statusText,
      type: 'failed',
      timestamp: Date.now(),
    });
    this.trim();
  }

  recordRequestFailed(url: string, errorText: string): void {
    this.errors.push({
      url: url ? `${url} (${errorText})` : `(loading failed: ${errorText})`,
      type: 'error',
      timestamp: Date.now(),
    });
    this.trim();
  }

  private trim(): void {
    if (this.errors.length > MAX_ENTRIES) {
      this.errors.shift();
    }
  }

  getErrors(): NetworkError[] {
    return [...this.errors];
  }

  clear(): void {
    this.errors = [];
  }
}
