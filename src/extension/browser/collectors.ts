import type { ConsoleEntry, NetworkError } from '../../shared/types/browser';
import { redactSecrets, redactUrl } from './redaction';

const MAX_ENTRIES = 100;

/**
 * Per-entry text cap enforced HOST-SIDE, on top of the bridge's in-page `MAX_TEXT`.
 *
 * The in-page cap bounds a WELL-BEHAVED page. It cannot bound a hostile one: the bridge runs in the
 * page's own main world, so its caps are the page's to edit. Every entry is re-capped here, where the
 * page has no reach, which is what turns "bounded" from a hope into a property. 100 uncapped entries
 * is both a heap problem and an unbounded model-context cost, since these are re-sent every turn.
 */
const MAX_ENTRY_TEXT = 4000;

/** Cap on a recorded URL. Page-controlled (a `data:` URL is arbitrarily long) and re-sent every turn. */
const MAX_URL_LENGTH = 500;

/** Cap on the transport error string that accompanies a failed request. */
const MAX_ERROR_TEXT = 200;

/**
 * Ceiling on the text redaction will scan in one call.
 *
 * Redaction is a synchronous pass over page-controlled text on the EXTENSION HOST, so its cost is the
 * editor's cost. The patterns are linear (see `redaction.ts`), but linear on an unbounded input is
 * still unbounded, and nothing above guarantees a bound before this point — `recordRequestFailed`
 * receives a raw `data:` URL straight from Chromium. Truncating first bounds the work absolutely.
 * The cap is above every other cap here, so it never truncates content that would otherwise survive.
 */
const MAX_REDACT_INPUT = 8000;

/** Truncate to `max`, marking the cut so a reader never mistakes a clipped value for the whole one. */
function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(truncated)`;
}

/** Redact page-produced text under a hard input bound. Order matters: truncating BEFORE redaction caps
 *  the scan, and a secret past the cut is discarded rather than exposed. */
function redactBounded(text: string, max: number): string {
  return redactSecrets(clamp(text, Math.min(max, MAX_REDACT_INPUT)));
}

/** Console entries carried by one `ElementAttachment`. */
const ATTACHMENT_MAX_ENTRIES = 20;
/** Per-entry text cap for an attachment. Tighter than the buffer's own cap: an attachment is broadcast
 *  into the transcript in full, where 20 entries at the buffer cap would dominate the message. */
const ATTACHMENT_MAX_TEXT = 2000;

/**
 * Bound a console buffer before it leaves the extension host. Pages routinely `console.log` tokens,
 * session ids and whole API responses, and an `ElementAttachment` is broadcast into the chat
 * transcript — so an unbounded buffer there turns element picking into an exfiltration path with an
 * unbounded context cost. Applying the caps here rather than trusting the producer keeps the
 * attachment's bound independent of where its entries came from.
 */
export function boundConsoleEntries(entries: ConsoleEntry[]): ConsoleEntry[] {
  return entries.slice(-ATTACHMENT_MAX_ENTRIES).map((entry) =>
    entry.text.length > ATTACHMENT_MAX_TEXT ? { ...entry, text: clamp(entry.text, ATTACHMENT_MAX_TEXT) } : entry,
  );
}

/**
 * Console message ring buffer.
 *
 * SOURCE OF TRUTH — THE IN-PAGE CONSOLE BRIDGE, NOT PLAYWRIGHT. Patchright patches out
 * `Console.enable` (a CDP bot-detection tell we still never send), which disables Playwright's console
 * pipeline: `page.on('console')` / `page.on('pageerror')` DO NOT FIRE and are deliberately not wired.
 * Entries instead arrive from the init-script bridge in `page-scripts.ts`, which wraps the page's own
 * `console.*` and its error/unhandledrejection events and pushes batches over an `exposeBinding`
 * endpoint into `BrowserService.onConsoleBinding`. We NEVER fabricate console output — `BrowserConsole`
 * truthfully returns "no messages" when the page produced none.
 */
export class ConsoleCollector {
  private entries: ConsoleEntry[] = [];

  /**
   * Record one console message, timestamped host-side (the bridge sends no timestamps on the wire).
   *
   * Redaction happens HERE, at capture, so a credential never enters the buffer and therefore cannot
   * be reached by any consumer — present or future. See `redaction.ts` for why that placement is the
   * point rather than an implementation detail.
   */
  record(level: string, text: string): void {
    this.entries.push({ level, text: redactBounded(text, MAX_ENTRY_TEXT), timestamp: Date.now() });
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
 * MAX_ENTRIES entries, shaped as the shared `NetworkError` type. URLs are credential-redacted on
 * record (a failing request routinely carries `?access_token=…`), for the reasons in `redaction.ts`.
 */
export class NetworkCollector {
  private errors: NetworkError[] = [];

  recordResponse(url: string, status: number, statusText: string): void {
    if (status < 400) return;
    this.errors.push({
      url: redactUrl(clamp(url, MAX_URL_LENGTH)),
      status,
      statusText: clamp(statusText, MAX_ERROR_TEXT),
      type: 'failed',
      timestamp: Date.now(),
    });
    this.trim();
  }

  recordRequestFailed(url: string, errorText: string): void {
    // The error text is bounded and redacted SEPARATELY, then interpolated: composing first would let a
    // failure string forge the ` (…)` boundary and disguise itself as part of the URL.
    const failure = redactBounded(errorText, MAX_ERROR_TEXT);
    this.errors.push({
      url: url ? `${redactUrl(clamp(url, MAX_URL_LENGTH))} (${failure})` : `(loading failed: ${failure})`,
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
