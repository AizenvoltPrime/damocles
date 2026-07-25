import { promises as fsp } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { get as httpGet } from 'http';
import * as vscode from 'vscode';
import type { BrowserContext, Page, CDPSession, Dialog } from 'patchright';
import { launchBrowserContext } from './launcher';
import { PageController } from './page-controller';
import { BrowserPanel } from './browser-panel';
import { ScreencastHealth } from './screencast-health';
import { ConsoleCollector, NetworkCollector } from './collectors';
import { ElementPicker } from './element-picker';
import {
  buildConsoleBridgeScript,
  buildCursorObserverScript,
  buildTitleObserverScript,
  createBindingName,
  isolatedBridgeInstaller,
} from './page-scripts';
import { resolveFavicon } from './favicon';
import { isNavigableUrl } from './net-guard';
import { DownloadManager } from './downloads';
import { InterceptManager } from './intercept';
import { ScreencastController, MAX_DEVICE_SCALE } from './screencast';
import { BrowserAgentScope, type ScopeTabInfo } from './agent-scope';
import { log } from '../logger';
import type { BrowserSessionState, InterceptRule, RedactedInterceptRule } from './types';
import type { ElementAttachment, ConsoleEntry, NetworkError, DownloadEntry, BrowserDialogRecord } from '../../shared/types/browser';

export { BrowserAgentScope } from './agent-scope';
export type { ScopeTabInfo } from './agent-scope';
export { DOWNLOAD_MAX_BYTES, DOWNLOAD_LAUNCH_MAX_BYTES } from './downloads';
export { STREAM_JPEG_QUALITY, TOOL_JPEG_QUALITY, MAX_DEVICE_SCALE, FRAME_ACK_FALLBACK_MS } from './screencast';

/**
 * Per-page state. Each open browser tab is its own VS Code editor tab: the Playwright page, its
 * leak-free CDP session, the PageController facade, the element picker, and the dedicated BrowserPanel
 * (WebviewPanel) that renders THIS page. Screencast follows the panel's visibility, so the last frame
 * and the CDP viewport are tracked per page (panels can differ in size under split view). The favicon
 * token guards this page's icon against a superseded same-page navigation.
 *
 * `ownerScopeId` attributes the tab to the agent scope that opened it (the primary scope for the main
 * agent + human, or a subagent/team-agent id) so per-agent tab isolation and success-only auto-close
 * work. The console/network collectors are per-tab (each tab records into its OWN buffers, unconditional
 * of which tab the human is watching), and `pendingUploadPaths` stages this tab's next native chooser.
 */
interface PageEntry {
  page: Page;
  session: CDPSession;
  controller: PageController;
  picker: ElementPicker;
  panel: BrowserPanel;
  lastUrl: string | null;
  lastTitle: string | null;
  lastFrame: { bytes: Buffer; deviceWidth: number; deviceHeight: number } | null;
  /** Last cursor the page pushed. The cursor binding is push-only, so without remembering it a
   *  re-shown panel would keep the default cursor until the next mouse move. */
  lastCursor: string | null;
  /** This panel is visible and should be streaming. `ready` is asynchronous, so the panel can be
   *  hidden again between the webview posting it and the host handling it; the ready handler consults
   *  this rather than starting a stream into a webview that is already gone. */
  wantsStream: boolean;
  /** The one screencast frame pushed to this panel and not yet acked back to Chromium. See
   *  {@link BrowserService.releasePendingAck} for the state machine that owns this field. */
  pendingAck: { sessionId: number; frameId: number; timer: ReturnType<typeof setTimeout> } | null;
  /** Monotonic frame id allocator; pairs a pushed frame with its `frameRendered` reply. */
  nextFrameId: number;
  /** This tab's OWN stall detector. Per-entry, not service-level: under split view several panels are
   *  visible and streaming at once, and `activePage` only tracks which one the human is focused on. */
  health: ScreencastHealth;
  watchdogFailureStreak: number;
  /** Watchdog ticks this entry must sit out before its next restart attempt. Counted in TICKS, not
   *  wall-clock: the watchdog can only ever act on a tick, so a millisecond deadline that happens to
   *  be an exact multiple of the interval races the tick it is supposed to permit. See
   *  {@link BrowserService.startWatchdog}. */
  watchdogSkipTicks: number;
  /** Debounces this tab's ack-failure-triggered screencast restart. Per-entry so a failure on one tab
   *  never swallows another tab's restart. */
  ackRestartTimer: ReturnType<typeof setTimeout> | null;
  viewport: { width: number; height: number; dpr: number };
  faviconToken: number;
  ownerScopeId: string;
  consoleCollector: ConsoleCollector;
  networkCollector: NetworkCollector;
  /** Dialogs auto-answered on this tab, bounded at {@link DIALOGS_MAX} (oldest dropped). */
  dialogs: BrowserDialogRecord[];
  /** How many LEADING records have already been reported to the agent. A count, not an index, so the
   *  ring buffer's `shift()` can keep it aligned by decrementing it. */
  dialogsReportedUpTo: number;
  pendingUploadPaths: string[] | null;
  /** Serializes this tab's resizes. `resizeEntry` performs several sequential awaits, so two
   *  overlapping invocations could interleave such that the earlier one's `stopScreencast` lands after
   *  the later one's `startScreencast`, leaving the stream dead. Latest-wins trailing run. */
  resizeChain: Promise<void>;
}

interface CdpPageJson {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** How long a DevTools endpoint probe may take before it is abandoned. */
const DEVTOOLS_PROBE_TIMEOUT_MS = 2_000;
/** Ceiling on a DevTools endpoint response. `/json` lists every target, so it is not tiny — but it is
 *  also not unbounded, and the process answering may not be Chrome at all. */
const DEVTOOLS_PROBE_MAX_BYTES = 1024 * 1024;

/**
 * GET and parse JSON from the local DevTools endpoint, under a hard time and size bound.
 *
 * BOUNDED BECAUSE THE CALLER HAS ALREADY DECLARED THE PORT SUSPECT. `DevToolsActivePort` survives a
 * crashed launch, so the port it names may now belong to an unrelated local process — which is exactly
 * why the probe exists. An unbounded, untimed request to a port we suspect is not ours hangs
 * `openDevToolsFor` forever the moment that process accepts the connection and never answers, or
 * answers with an endless stream.
 */
function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > DEVTOOLS_PROBE_MAX_BYTES) {
          req.destroy(new Error(`DevTools endpoint response exceeded ${DEVTOOLS_PROBE_MAX_BYTES} bytes`));
        }
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as T);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(DEVTOOLS_PROBE_TIMEOUT_MS, () => {
      req.destroy(new Error(`DevTools endpoint did not respond within ${DEVTOOLS_PROBE_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
  });
}

const GET_SELECTED_TEXT_EXPR = `(() => {
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.selectionStart === 'number') {
    return el.value.substring(el.selectionStart, el.selectionEnd);
  }
  return window.getSelection().toString();
})()`;

/**
 * Host-side bounds on the page bridge. Each mirrors an in-page cap that a hostile page can edit out,
 * so these are the ones that actually hold. Sized above the in-page values, so a well-behaved page is
 * never clipped twice and a breach of these is unambiguously a page misbehaving.
 */
const BRIDGE_PAYLOAD_MAX_CHARS = 256 * 1024;
const BRIDGE_DOC_ID_MAX_CHARS = 64;
const BRIDGE_TRACKED_DOCS_MAX = 200;
const BRIDGE_CURSOR_MAX_CHARS = 64;
const BRIDGE_TITLE_MAX_CHARS = 300;
/** Console entries accepted from ONE bridge batch (in-page `MAX_QUEUE` is 50, plus an overflow note). */
const BRIDGE_CONSOLE_BATCH_MAX = 64;
/** A level is one of six known words; the cap only stops a forged one from being unbounded. */
const BRIDGE_CONSOLE_LEVEL_MAX_CHARS = 16;

/**
 * Installs Damocles' context-level cursor, title and console observers: the three `exposeBinding`
 * endpoints and the matching init scripts. Extracted so the exact same install path is shared by
 * `launchAndAdopt` and the env-gated integration test (which asserts the observers still fire
 * alongside an active intercept route) — the test drives the REAL scripts rather than duplicating
 * their text. The init scripts run in every current and future page/frame under Patchright (which
 * injects at the HTML-request level, no Runtime.enable).
 *
 * Each binding gets a fresh random name per launch, and the names exist ONLY as locals here: nothing
 * stores, logs or persists them, so no page can find a Damocles-attributable global. `exposeBinding`
 * must precede its `addInitScript` so `globalThis[name]` already exists when our script relocates it.
 *
 * EVERYTHING ARRIVING HERE IS PAGE-CONTROLLED. The main-world half of the bridge runs in the page's
 * own realm, so its caps and its `kind` tags are the page's to edit — a page that recovers the channel
 * dispatches straight at the isolated listener. Validation and bounding therefore live HERE, on the
 * host, where the page has no reach. The in-page caps stay as a first line that keeps the common case
 * cheap; this is the one that holds.
 */
export async function installContextObservers(
  context: BrowserContext,
  handlers: {
    onCursor: (page: Page | undefined, cursor: string) => void;
    onTitle: (page: Page | undefined, title: string) => void;
    onConsole: (page: Page | undefined, payloadJson: string) => void;
  },
): Promise<void> {
  const binding = createBindingName();
  const channel = createBindingName();
  // Independent of `channel`: the once-guard registry key is the one bridge name a page can enumerate
  // (via Object.getOwnPropertySymbols), so deriving it from the channel would hand the channel over.
  const guardKey = createBindingName();
  // A page can replay a payload it captured, and the main world re-dispatches its replay buffer on every
  // `_ready`. Envelope ids make both harmless: `doc` is per-document, `seq` is monotonic within it, so
  // anything not strictly newer than what this document has already delivered is dropped.
  const lastSeqByDoc = new Map<string, number>();
  // ONE binding and ONE channel for all three observers. Three of each would be three DOM listeners
  // and three globals for a page to notice; the payload's `kind` tag separates them instead.
  await context.exposeBinding(binding, (source, raw: unknown) => {
    if (typeof raw !== 'string' || raw.length > BRIDGE_PAYLOAD_MAX_CHARS) {
      log('[Browser] Page bridge payload was not a bounded string — ignored.');
      return;
    }
    let message: { doc?: unknown; seq?: unknown; kind?: unknown; value?: unknown };
    try {
      message = JSON.parse(raw) as { doc?: unknown; seq?: unknown; kind?: unknown; value?: unknown };
    } catch (err) {
      log(`[Browser] Page bridge payload parse failed — ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (typeof message.doc !== 'string' || message.doc.length > BRIDGE_DOC_ID_MAX_CHARS || typeof message.seq !== 'number') {
      log('[Browser] Page bridge envelope was malformed — ignored.');
      return;
    }
    const seen = lastSeqByDoc.get(message.doc);
    if (seen !== undefined && message.seq <= seen) return;
    lastSeqByDoc.set(message.doc, message.seq);
    // Documents come and go for the life of the context, so the dedup map is itself a growth surface.
    if (lastSeqByDoc.size > BRIDGE_TRACKED_DOCS_MAX) {
      // Map preserves insertion order, so the oldest document is the first key.
      lastSeqByDoc.delete(lastSeqByDoc.keys().next().value!);
    }
    if (message.kind === 'cursor' && typeof message.value === 'string') {
      handlers.onCursor(source.page, message.value.slice(0, BRIDGE_CURSOR_MAX_CHARS));
    } else if (message.kind === 'title' && typeof message.value === 'string') {
      // The title becomes the editor TAB LABEL, so an unbounded one is a VS Code UI problem, and a
      // newline would let a page forge what looks like separate UI text.
      handlers.onTitle(source.page, message.value.replace(/[\r\n]+/g, ' ').slice(0, BRIDGE_TITLE_MAX_CHARS));
    } else if (message.kind === 'console') {
      handlers.onConsole(source.page, JSON.stringify(message.value));
    } else {
      log('[Browser] Page bridge payload had an unknown kind — ignored.');
    }
  });
  await context.addInitScript(buildCursorObserverScript(channel, guardKey));
  await context.addInitScript(buildTitleObserverScript(channel, guardKey));
  await context.addInitScript(buildConsoleBridgeScript(channel, guardKey));

  // The isolated-world half installs itself for the life of the context, rather than handing the
  // caller a token it must remember to re-apply per page and per navigation. That obligation is
  // invisible at the call site and silently yields a bridge that works only on a page's FIRST
  // document — the exact defect this rewrite fixes, which two of this function's three call sites
  // had already made.
  const install = (page: Page): void => {
    void page.evaluate(isolatedBridgeInstaller(), { binding, channel, guardKey }).catch((err) => {
      // A page that navigates or closes mid-install simply gets the next one; anything else is worth
      // seeing, because a persistently failing install means a silently deaf bridge.
      if (page.isClosed()) return;
      log(`[Browser] Isolated bridge install failed — ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  const track = (page: Page): void => {
    install(page);
    // A new document is a new isolated world, so the listener must be reinstalled. `addInitScript`
    // cannot do this: init scripts run in the MAIN world, which never holds the binding.
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) install(page);
    });
  };
  for (const page of context.pages()) track(page);
  context.on('page', track);
}

// Ring-buffer cap for auto-answered dialogs retained per tab.
const DIALOGS_MAX = 20;

/** Cap on a stored dialog message. The PAGE controls this string entirely and it is re-emitted into
 *  the model context on every snapshot, so 20 unbounded messages is an unbounded context cost. */
const DIALOG_MESSAGE_MAX = 200;

function jsButtonToCdp(button: number): 'left' | 'middle' | 'right' | 'none' {
  if (button === 0) return 'left';
  if (button === 1) return 'middle';
  if (button === 2) return 'right';
  return 'none';
}

export class BrowserService {
  /** The shared scope id for the main agent + human. Every panel's main agent and every human-initiated
   *  open resolve through it, so "the human opens a page, the main agent continues on it" keeps working. */
  static readonly PRIMARY_SCOPE_ID = '__primary__';

  private state: BrowserSessionState = 'disconnected';
  private currentUrl: string | null = null;
  private context: BrowserContext | null = null;
  // Human screencast-panel focus ONLY (which tab the live screencast/watchdog/favicon key off). It is
  // NO LONGER what agent tools read — each scope tracks its own current tab (see `scopes`). Set by panel
  // visibility / presentPanel / a human-driven reveal; NEVER moves a scope's current tab (decision #2).
  private activePage: Page | null = null;
  private pages = new Map<Page, PageEntry>();
  // Per-agent scope registry: id → its current tab. The primary scope (main + human) is pre-registered;
  // subagent/team scopes are added on demand (createAgentScope) and removed on agent completion
  // (disposeScope). Globally-unique ids never collide on the one shared service.
  private scopes = new Map<string, { currentPage: Page | null }>([
    [BrowserService.PRIMARY_SCOPE_ID, { currentPage: null }],
  ]);
  // The scope that triggered the context launch, captured for popup owner-attribution fallback (a popup
  // whose opener maps to no known tab is attributed here, then to the primary scope). Cleared on cleanup.
  private launchOwnerScopeId: string | null = null;
  // In-flight page registrations keyed by Page. A single popup can surface via BOTH context.on('page')
  // and page.on('popup'), and an explicit openNewTab races context.on('page') for its own page; sharing
  // one registration promise per page keeps registerPage idempotent (one CDPSession, one listener set).
  private pendingRegistrations = new Map<Page, Promise<PageEntry | null>>();
  private userDataDir: string | null = null;
  // The editor column the browser tabs live in. Captured from the first tab and reused for the rest, so
  // every browser tab groups together (the "group with active editor" placement).
  private browserColumn: vscode.ViewColumn | undefined = undefined;
  // Guards restore so only the first persisted browser tab relaunches the session; extras are disposed.
  private restoreClaimed = false;
  private broadcastToChat: ((element: ElementAttachment) => void) | null = null;
  private cleanUserAgent: string | null = null;
  // Most-recent viewport, used to size the NEXT launch context. Deliberately NOT used to seed a new
  // page: it tracks the last resize of whichever tab was resized last, which is a size that page never
  // had.
  private viewport: { width: number; height: number; dpr: number } = { width: 1920, height: 1080, dpr: 1 };
  // The viewport the LIVE context was launched with — the size Playwright actually applies to every
  // page it creates, and therefore the only honest seed for a tab that has not been resized yet.
  private launchViewport: { width: number; height: number; dpr: number } = { width: 1920, height: 1080, dpr: 1 };
  private readonly screencast = new ScreencastController(
    () => this.pages.values(),
    () => this.isConnected(),
    (entry) => this.pages.has(entry.page),
  );
  private iconCacheDir: string | null = null;
  private openChain: Promise<void> = Promise.resolve();
  private closing = false;
  private readonly downloadManager = new DownloadManager();
  // Active network-interception rules (BrowserIntercept), cleared on cleanup() (close + dispose).
  private readonly interceptManager = new InterceptManager(() => this.context);

  isConnected(): boolean {
    return this.state === 'connected';
  }

  private getActiveEntry(): PageEntry | null {
    if (!this.activePage) return null;
    return this.pages.get(this.activePage) ?? null;
  }

  getCdp(): PageController | null {
    return this.getActiveEntry()?.controller ?? null;
  }

  getActivePage(): Page | null {
    return this.activePage;
  }

  getCurrentUrl(): string | null {
    return this.currentUrl;
  }

  // ── Per-agent scope machinery ─────────────────────────────────────────────────────────────────

  /** Register the scope id (if new) and return a thin handle over this service for it. This is the ONLY
   *  place a registry entry is born — see {@link setScopeCurrentPage}. Idempotent, so a rebuild (per
   *  session / per subagent spawn / per team agent) reuses the entry. Primary is pre-registered. */
  createAgentScope(id: string): BrowserAgentScope {
    if (!this.scopes.has(id)) this.scopes.set(id, { currentPage: null });
    return new BrowserAgentScope(this, id);
  }

  /**
   * Point a LIVE scope at `page`, reporting whether the scope still exists.
   *
   * Mutating paths must NEVER create the registry entry. A tool call can outlive its agent: `abortableTool`
   * resolves the moment the turn's signal fires while the underlying `openTabForScope` promise keeps
   * running, and `disposeScope` deletes the entry in between. A create-on-demand write here would
   * resurrect the dead scope and strand the tab it just opened, so callers close what they created and
   * fail instead.
   */
  private setScopeCurrentPage(scopeId: string, page: Page | null): boolean {
    const state = this.scopes.get(scopeId);
    if (!state) return false;
    state.currentPage = page;
    return true;
  }

  /** The error a scope-mutating path fails with once its agent has settled and the scope was disposed. */
  private static disposedScopeError(scopeId: string): Error {
    return new Error(`Browser scope ${scopeId} was disposed — its agent has already finished.`);
  }

  /** The scope's own tabs in registration order (index 0-based). */
  private scopeTabs(scopeId: string): Page[] {
    return [...this.pages.keys()].filter((p) => this.pages.get(p)!.ownerScopeId === scopeId);
  }

  /** The PageController the scope's tools drive (null when the scope has no live current tab). */
  getScopeController(scopeId: string): PageController | null {
    const page = this.scopes.get(scopeId)?.currentPage;
    if (!page) return null;
    return this.pages.get(page)?.controller ?? null;
  }

  /** The scope's current live page, or null. */
  getScopePage(scopeId: string): Page | null {
    const page = this.scopes.get(scopeId)?.currentPage ?? null;
    return page && this.pages.has(page) ? page : null;
  }

  /** The scope's current tab URL (tracked last-url, else the live page url), or null. Reads only a LIVE
   *  tab: `page.url()` on a closed page throws, so an unregistered page reports no url. */
  getScopeCurrentUrl(scopeId: string): string | null {
    const page = this.scopes.get(scopeId)?.currentPage;
    if (!page) return null;
    const entry = this.pages.get(page);
    if (!entry) return null;
    return entry.lastUrl ?? page.url() ?? null;
  }

  /** Poll the SCOPE's controller readiness (not global isConnected) so a scope waits for its own tab. */
  async waitForController(scopeId: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (this.getScopeController(scopeId)) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) return false;
      await new Promise<void>((r) => setTimeout(r, 200));
      if (this.getScopeController(scopeId)) return true;
    }
    return false;
  }

  getConsoleMessages(scopeId: string): ConsoleEntry[] {
    const page = this.scopes.get(scopeId)?.currentPage;
    if (!page) return [];
    return this.pages.get(page)?.consoleCollector.getMessages() ?? [];
  }

  getNetworkErrors(scopeId: string): NetworkError[] {
    const page = this.scopes.get(scopeId)?.currentPage;
    if (!page) return [];
    return this.pages.get(page)?.networkCollector.getErrors() ?? [];
  }

  /** DRAINING read of this scope's auto-answered dialogs: each caller sees only what happened since the
   *  last call, so a snapshot reports a dialog exactly once instead of repeating it forever. */
  takeUnreportedDialogs(scopeId: string): BrowserDialogRecord[] {
    const page = this.scopes.get(scopeId)?.currentPage;
    if (!page) return [];
    const entry = this.pages.get(page);
    if (!entry) return [];
    const out = entry.dialogs.slice(entry.dialogsReportedUpTo);
    entry.dialogsReportedUpTo = entry.dialogs.length;
    return out;
  }

  /** NON-DRAINING read of this scope's auto-answered dialogs, for an explicit "what happened?" query. */
  getDialogs(scopeId: string): BrowserDialogRecord[] {
    const page = this.scopes.get(scopeId)?.currentPage;
    if (!page) return [];
    return [...(this.pages.get(page)?.dialogs ?? [])];
  }

  /** Snapshot of a SCOPE's own open tabs in registration order (index 0-based). Sync. */
  listTabs(scopeId: string): ScopeTabInfo[] {
    const current = this.scopes.get(scopeId)?.currentPage ?? null;
    const tabs: ScopeTabInfo[] = [];
    let index = 0;
    for (const entry of this.pages.values()) {
      if (entry.ownerScopeId !== scopeId) continue;
      tabs.push({
        index: index++,
        title: entry.lastTitle ?? '',
        url: entry.lastUrl ?? entry.page.url(),
        active: entry.page === current,
      });
    }
    return tabs;
  }

  /** Switch a scope's current tab by its per-scope index. Only the PRIMARY scope (main agent + human)
   * also reveals the tab: a background subagent switching its own tab must not yank the human's
   * screencast away from whatever they are watching (same rule as `openForScope`). */
  async selectTab(scopeId: string, index: number): Promise<void> {
    const own = this.scopeTabs(scopeId);
    const page = own[index];
    if (!page) {
      throw new Error(`Tab index ${index} out of range (${own.length} tab(s) open)`);
    }
    if (!this.setScopeCurrentPage(scopeId, page)) throw BrowserService.disposedScopeError(scopeId);
    if (scopeId !== BrowserService.PRIMARY_SCOPE_ID) return;
    this.pages.get(page)?.panel.reveal();
    this.setActivePage(page);
  }

  /** Close a scope's tab by its per-scope index. handlePageClosed re-points the scope to another owned
   * tab (most-recent) or null; last tab overall tears the session down. */
  async closeTab(scopeId: string, index: number): Promise<void> {
    const own = this.scopeTabs(scopeId);
    const page = own[index];
    if (!page) {
      throw new Error(`Tab index ${index} out of range (${own.length} tab(s) open)`);
    }
    // Refuse to close the last tab OVERALL: doing so would leave the session with no page (and no live
    // screencast) while still "connected". The agent ends its own tab(s) via BrowserClose instead.
    if (this.pages.size === 1) {
      throw new Error('Cannot close the last remaining tab — use BrowserClose to end the session.');
    }
    await page.close();
  }

  /**
   * Open a new tab OWNED BY `scopeId`, register it, make it that scope's current tab, and optionally
   * navigate it. context.newPage() also fires context.on('page'); registration is idempotent so the tab
   * is set up exactly once, and the explicit scope authoritatively owns it. Only the PRIMARY scope
   * reveals the new tab to the human (a subagent opening a tab must not steal the screencast).
   */
  async openNewTab(scopeId: string, url?: string): Promise<void> {
    if (!this.context) {
      throw new Error('Browser is not connected. Use browser_open first.');
    }
    const page = await this.claimNewTabForScope(scopeId);
    const entry = this.pages.get(page)!;
    if (scopeId === BrowserService.PRIMARY_SCOPE_ID) {
      entry.panel.reveal();
      this.setActivePage(page);
    }
    if (url) {
      await entry.controller.navigate(url);
      entry.lastUrl = url;
      if (page === this.activePage) this.currentUrl = url;
    }
  }

  /**
   * Create + register a tab and hand it to `scopeId`, or throw if the scope was disposed while the tab
   * was being built. Both `newPage()` and `registerPage()` await, and an agent can settle across either,
   * so the scope is re-checked after each: the early check avoids even creating an editor tab, and the
   * `setScopeCurrentPage` result is the authoritative one. A tab claimed by nobody is closed rather than
   * left behind as an unowned editor tab.
   */
  private async claimNewTabForScope(scopeId: string): Promise<Page> {
    const page = await this.context!.newPage();
    if (!this.scopes.has(scopeId)) {
      await page.close().catch(() => {});
      throw BrowserService.disposedScopeError(scopeId);
    }
    const entry = await this.registerPage(page, scopeId);
    if (!entry) {
      await page.close().catch(() => {});
      throw new Error('Failed to initialise the browser page');
    }
    entry.ownerScopeId = scopeId;
    if (!this.setScopeCurrentPage(scopeId, page)) {
      await page.close().catch(() => {});
      throw BrowserService.disposedScopeError(scopeId);
    }
    return page;
  }

  /** Close ONLY this scope's tab(s) (BrowserClose), keeping its registry entry (the agent may reopen).
   * If that empties `pages`, the existing last-tab teardown fires; the context stays up otherwise. */
  async closeScopeTabs(scopeId: string): Promise<void> {
    const own = this.scopeTabs(scopeId);
    await Promise.all(own.map((p) => p.close().catch(() => {})));
  }

  /**
   * Agent-completion cleanup for a subagent/team-agent scope. When `closeTabs` (SUCCESS), close the
   * scope's tabs; on error/stop the tabs stay open for inspection. ALWAYS remove the scope from the
   * registry — kept tabs live on as owned-by-a-dead-id editor tabs the human closes manually (no leak;
   * handlePageClosed guards on `scopes.get(id)`). Never touches the primary scope.
   */
  disposeScope(scopeId: string, closeTabs: boolean): void {
    if (scopeId === BrowserService.PRIMARY_SCOPE_ID) return;
    // Idempotent: an agent can settle down more than one path (its own promise AND the team's
    // drain-timeout sweep). Without this the second call would find no registry entry but still resolve
    // the scope's kept tabs by owner id and close them — destroying the pages kept for inspection.
    if (!this.scopes.has(scopeId)) return;
    const own = closeTabs ? this.scopeTabs(scopeId) : [];
    this.scopes.delete(scopeId);
    for (const p of own) p.close().catch(() => {});
  }

  /**
   * Session teardown counterpart to {@link disposeScope}: release a scope for good — drop its registry
   * entry AND close every tab it owns, including tabs a failed agent deliberately left open.
   *
   * Those kept tabs outlive their scope on purpose so the human can inspect the page that broke, but
   * nothing owns them afterwards. The session that handed out the scope reclaims them when the
   * conversation ends; unlike `disposeScope` this runs even when the entry is already gone. Never
   * touches the primary scope.
   */
  discardScope(scopeId: string): void {
    if (scopeId === BrowserService.PRIMARY_SCOPE_ID) return;
    const own = this.scopeTabs(scopeId);
    this.scopes.delete(scopeId);
    for (const p of own) p.close().catch(() => {});
  }

  /** Bring a scope's current tab to the human's screencast focus (BrowserRequestInput reveal). */
  revealScope(scopeId: string): void {
    const page = this.scopes.get(scopeId)?.currentPage;
    if (!page) return;
    const entry = this.pages.get(page);
    if (!entry) return;
    entry.panel.reveal();
    this.setActivePage(page);
  }

  /** Stage (or clear with null) the files a subsequent native file chooser should receive on the SCOPE's
   * current tab. Single-shot: that tab's filechooser handler consumes + clears it. */
  stagePendingUpload(scopeId: string, paths: string[] | null): void {
    const page = this.scopes.get(scopeId)?.currentPage;
    if (!page) return;
    const entry = this.pages.get(page);
    if (entry) entry.pendingUploadPaths = paths;
  }

  /** A copy of the captured-downloads ring buffer (newest last). */
  getDownloads(): DownloadEntry[] {
    return this.downloadManager.list();
  }

  /** Register a network-interception rule (BrowserIntercept). Throws if the browser is not connected
   *  or the rule is malformed; returns the new rule id. */
  addInterceptRule(rule: Omit<InterceptRule, 'id'>): string {
    return this.interceptManager.add(rule);
  }

  /** A REDACTED view of the active intercept rules — the raw fulfill body is never returned (bodyBytes only). */
  listInterceptRules(): RedactedInterceptRule[] {
    return this.interceptManager.list();
  }

  /** Remove every intercept rule (unroute each pattern/handler) and empty the registry. Null-safe. */
  clearInterceptRules(): void {
    this.interceptManager.clear();
  }

  onElementPickedFromToolbar(handler: (element: ElementAttachment) => void): void {
    this.broadcastToChat = handler;
  }

  private readHeadlessSetting(): boolean {
    try {
      return vscode.workspace.getConfiguration('damocles').get<boolean>('browser.headless', true);
    } catch {
      return true;
    }
  }

  private readDevToolsPortSetting(): boolean {
    try {
      return vscode.workspace.getConfiguration('damocles').get<boolean>('browser.devToolsPort', true);
    } catch {
      return true;
    }
  }

  /** The live `damocles.browser.enabled` flag. Read at use rather than cached, so disabling the feature
   *  takes effect on the next window reload without a restart. */
  private readEnabledSetting(): boolean {
    try {
      return vscode.workspace.getConfiguration('damocles').get<boolean>('browser.enabled', false);
    } catch {
      return false;
    }
  }

  /** Convenience: open/navigate the PRIMARY scope's tab (human toolbar "open browser" + window reload). */
  openPrimary(url: string, signal?: AbortSignal): Promise<void> {
    return this.openForScope(BrowserService.PRIMARY_SCOPE_ID, url, signal);
  }

  // Serializes context LAUNCH (double Enter, or Reload during a browser_open tool call) on openChain:
  // without it a second first-open would tear down the first launch's Chrome while the first launch's
  // catch disposes the panel the second is already using. Per-scope tab creation and every per-page CDP
  // action run OUTSIDE this chain, so concurrent scopes open tabs and drive their pages in parallel.
  private async ensureContext(launchScopeId: string, signal?: AbortSignal): Promise<void> {
    const run = this.openChain.then(() => this.ensureContextInternal(launchScopeId, signal));
    this.openChain = run.then(() => {}, () => {});
    return run;
  }

  private async ensureContextInternal(launchScopeId: string, signal?: AbortSignal): Promise<void> {
    if (this.state === 'connected' && this.context) return; // idempotent: a concurrent first-open awaited
    if (this.context) await this.close(); // lingering/failed context — tear it down before relaunch
    await this.ensureUserDataDir();
    await this.launchAndAdopt(launchScopeId, signal);
  }

  /**
   * Open a URL for a scope: launch the shared context if needed (the launcher's scope adopts the initial
   * tab in ensureContext), then reuse the scope's current tab (navigate it) or open a fresh tab owned by
   * the scope. Replaces the old global `open`.
   */
  async openForScope(scopeId: string, url: string, signal?: AbortSignal): Promise<void> {
    await this.ensureContext(scopeId, signal);
    // ensureContext awaits a launch that can outlast the calling agent — never re-create the entry here.
    const state = this.scopes.get(scopeId);
    if (!state) throw BrowserService.disposedScopeError(scopeId);
    const current = state.currentPage;
    if (current && this.pages.has(current)) {
      // Reuse: navigate the scope's own current tab. The launcher's first open lands here on the adopted
      // initial page (set by ensureContext), so no orphan blank tab is ever left behind.
      const entry = this.pages.get(current)!;
      await this.raceAbort(entry.controller.navigate(url), signal);
      entry.lastUrl = url;
      if (current === this.activePage) this.currentUrl = url;
      // Only the primary (main + human) scope follows the human's focus on navigate; a subagent
      // navigating its background tab must not steal the human's screencast from a sibling scope.
      if (scopeId === BrowserService.PRIMARY_SCOPE_ID) entry.panel.reveal();
      return;
    }
    await this.openTabForScope(scopeId, url, signal);
  }

  /**
   * Always context.newPage() (the initial page was already adopted by ensureContext), then register,
   * authoritatively assign the owner, set the scope's current tab, and navigate. Runs OUTSIDE openChain
   * so multiple scopes create tabs concurrently; each holds its OWN resolved page, so the owner
   * assignment never cross-contaminates a sibling create (page identity disambiguates the
   * context.on('page') race). Do NOT serialize tab creation.
   */
  private async openTabForScope(scopeId: string, url: string, signal?: AbortSignal): Promise<void> {
    if (!this.context) throw new Error('Browser is not connected. Use browser_open first.');
    const page = await this.claimNewTabForScope(scopeId);
    const entry = this.pages.get(page)!;
    await this.raceAbort(entry.controller.navigate(url), signal);
    entry.lastUrl = url;
    if (page === this.activePage) this.currentUrl = url;
  }

  // Called once per persisted browser editor tab when the window reloads. Only the first restored panel
  // relaunches the session; extras are disposed, since the fresh Chromium context cannot be reconnected
  // to the previously-open pages.
  async restorePanel(panel: vscode.WebviewPanel, url: string): Promise<void> {
    // Always disposed, never adopted: a panel persisted by an older extension version carries that
    // version's WebviewPanelOptions (notably retainContextWhenHidden), which is fixed at creation time
    // and cannot be reassigned. Recreating costs one flash on window reload and buys exactly one
    // construction path with no version-dependent behaviour.
    panel.dispose();
    // A persisted tab must not resurrect a feature the user has since turned off. Without this, the
    // first window reload after disabling `damocles.browser.enabled` relaunches Chromium against the
    // logged-in profile — the one thing turning the setting off is meant to prevent.
    if (!this.readEnabledSetting()) return;
    if (this.context || this.restoreClaimed) return;
    this.restoreClaimed = true;
    this.currentUrl = url;
    try {
      // The primary scope owns the restored tab (main agent + human share it).
      await this.openForScope(BrowserService.PRIMARY_SCOPE_ID, url);
    } catch (err) {
      log(`[Browser] Failed to restore browser session — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async close(): Promise<void> {
    await this.teardown(true);
  }

  async pickElement(): Promise<ElementAttachment> {
    const active = this.getActiveEntry();
    if (!active) {
      throw new Error('Browser is not connected — element picking requires an active page');
    }
    return active.picker.startPicking();
  }

  async cancelPicking(): Promise<void> {
    await this.getActiveEntry()?.picker.stopPicking();
  }

  private async ensureUserDataDir(): Promise<void> {
    if (this.userDataDir) return;
    const dir = join(homedir(), '.damocles', 'browser-profile');
    await fsp.mkdir(dir, { recursive: true });
    this.userDataDir = dir;
    const iconDir = join(dir, 'tab-icons');
    await fsp.mkdir(iconDir, { recursive: true });
    this.iconCacheDir = iconDir;

    await this.downloadManager.prepareLaunchDir();
  }

  private async launchAndAdopt(launchScopeId: string, signal?: AbortSignal): Promise<void> {
    try {
      if (signal?.aborted) throw new Error('Browser open aborted');
      const headless = this.readHeadlessSetting();
      const devToolsPort = this.readDevToolsPortSetting();

      // Pinned before the launch: every page this context creates gets exactly this size, so it is what
      // a not-yet-resized tab's viewport cache must be seeded with.
      this.launchViewport = { ...this.viewport };
      const contextPromise = launchBrowserContext({
        userDataDir: this.userDataDir!,
        headless,
        viewport: { width: this.launchViewport.width, height: this.launchViewport.height },
        deviceScaleFactor: this.launchViewport.dpr,
        devToolsPort,
      });
      // If an ESC aborts the launch, the context may still finish opening in the background; make sure
      // a late-arriving one is torn down rather than leaked.
      if (signal) {
        contextPromise.then(
          (ctx) => { if (signal.aborted || this.closing) ctx.close().catch(() => {}); },
          () => {},
        );
      }
      const context = await this.raceAbort(contextPromise, signal);
      this.context = context;
      this.closing = false;
      // Capture the launching scope for popup owner-attribution fallback. Set BEFORE wiring
      // context.on('page') so a spontaneous popup can resolve it.
      this.launchOwnerScopeId = launchScopeId;

      // Context-level observers: the cursor, title and console bindings and their init scripts install
      // once for every current and future page/frame — no per-page Runtime.addBinding /
      // createIsolatedWorld.
      await installContextObservers(context, {
        onCursor: (page, cursor) => this.onCursorBinding(page, cursor),
        onTitle: (page, title) => this.onTitleBinding(page, title),
        onConsole: (page, payloadJson) => this.onConsoleBinding(page, payloadJson),
      });

      context.on('page', (page) => {
        this.handleNewPage(page).catch((err) =>
          log(`[Browser] handleNewPage failed — ${err instanceof Error ? err.message : String(err)}`),
        );
      });
      context.on('close', () => this.handleContextGone(context));

      // Atomically adopt + register the initial page to the launching scope (still inside the serialized
      // ensureContext section): no orphan blank tab, and by the time this resolves the launcher already
      // owns exactly one tab so no second concurrent caller can re-adopt the initial page.
      const initial = context.pages()[0] ?? await context.newPage();
      const entry = await this.registerPage(initial, launchScopeId);
      if (!entry) throw new Error('Failed to initialise the first browser page');
      // The launching agent can settle while Chromium is still starting. The context is up and must keep
      // exactly one live tab (closing the last one tears the session down), so hand the adopted tab to
      // the human's primary scope rather than leaving it owned by a scope that no longer exists.
      const owner = this.setScopeCurrentPage(launchScopeId, initial) ? launchScopeId : BrowserService.PRIMARY_SCOPE_ID;
      if (owner !== launchScopeId) this.setScopeCurrentPage(owner, initial);
      entry.ownerScopeId = owner;
      this.launchOwnerScopeId = owner;
      this.setActivePage(initial);

      // UA scrub (#6): branded system Chrome (channel:'chrome') reports a normal Chrome UA even under
      // new headless, so this is a no-op safety net; it only rewrites if HeadlessChrome survives (e.g.
      // an Edge/bundled fallback). Done before navigation so the first request carries the clean UA.
      await this.maybeScrubUserAgent(entry);

      // NOTE: no navigation here — the caller (openForScope) navigates the adopted tab after this
      // resolves. This keeps launch (serialized on openChain) and navigation (concurrent) separate.
      this.state = 'connected';
      this.screencast.syncWatchdog();
    } catch (err) {
      await this.releaseContext();
      this.closing = false;
      this.state = 'disconnected';
      this.launchOwnerScopeId = null;
      // currentUrl is intentionally preserved: the caller (openForScope / restorePanel) decides
      // whether to clear it, and a kept-alive recovery panel needs it so Reload can relaunch.
      throw err;
    }
  }

  /** Resolve `work`, but reject immediately if `signal` aborts (keeps ESC responsive mid-launch). */
  private raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return work;
    if (signal.aborted) return Promise.reject(new Error('Browser open aborted'));
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(new Error('Browser open aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
        (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
      );
    });
  }

  /**
   * Idempotent, concurrency-safe page registration. A page can arrive via context.on('page'),
   * page.on('popup'), or an explicit openNewTab — sometimes several at once for the same Page. All
   * callers share ONE registration promise, so a page gets exactly one CDPSession and one set of
   * listeners, never a duplicate that would leak a session or double-wire the dialog/download handlers.
   */
  private registerPage(page: Page, ownerScopeId?: string): Promise<PageEntry | null> {
    const existing = this.pages.get(page);
    if (existing) {
      // An explicit opener (openTabForScope/openNewTab/launch adoption) authoritatively owns its page,
      // overriding any provisional owner a racing context.on('page') registration assigned.
      if (ownerScopeId) existing.ownerScopeId = ownerScopeId;
      return Promise.resolve(existing);
    }
    const inflight = this.pendingRegistrations.get(page);
    if (inflight) {
      return ownerScopeId
        ? inflight.then((e) => { if (e) e.ownerScopeId = ownerScopeId; return e; })
        : inflight;
    }
    const registration = this.doRegisterPage(page, ownerScopeId).finally(() => this.pendingRegistrations.delete(page));
    this.pendingRegistrations.set(page, registration);
    return registration;
  }

  /**
   * Resolve the owner for a page registered WITHOUT an explicit scope (a spontaneous popup via
   * context.on('page') / page.on('popup')): inherit the opener's scope when the opener maps to a known
   * tab (the popup belongs to whichever scope's page spawned it), else the launch owner, else primary.
   */
  private async resolveOwnerScope(page: Page): Promise<string> {
    try {
      const opener = await page.opener();
      if (opener) {
        // Inherit only a LIVE scope. A tab kept open for inspection after its agent failed can still
        // spawn popups; attributing those to the dead id would create a tab nothing can list, drive, or
        // close, so they fall through to the human instead.
        const openerScope = this.pages.get(opener)?.ownerScopeId;
        if (openerScope && this.scopes.has(openerScope)) return openerScope;
      }
    } catch { /* opener() can reject on an already-closed page — fall through to the launch owner */ }
    const launchOwner = this.launchOwnerScopeId;
    if (launchOwner && this.scopes.has(launchOwner)) return launchOwner;
    return BrowserService.PRIMARY_SCOPE_ID;
  }

  private async doRegisterPage(page: Page, ownerScopeId?: string): Promise<PageEntry | null> {
    const context = this.context;
    if (!context) return null;

    let session: CDPSession;
    try {
      session = await context.newCDPSession(page);
    } catch (err) {
      log(`[Browser] newCDPSession failed — ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    const owner = ownerScopeId ?? await this.resolveOwnerScope(page);

    // Both awaits above can straddle a teardown (teardownContext clears `pages` and disposes every
    // panel). Committing now would re-populate the map with an entry nobody will ever dispose and open a
    // fresh editor tab for a page whose context is already gone, so bail once the context has moved on.
    if (this.context !== context || this.closing) {
      await session.detach().catch(() => {});
      return null;
    }
    const consoleCollector = new ConsoleCollector();
    const networkCollector = new NetworkCollector();
    const controller = new PageController(page, session);
    const picker = new ElementPicker(controller, consoleCollector, networkCollector);
    const entry: PageEntry = {
      page,
      session,
      controller,
      picker,
      panel: new BrowserPanel(),
      lastUrl: page.url() || null,
      lastTitle: null,
      lastFrame: null,
      lastCursor: null,
      wantsStream: false,
      pendingAck: null,
      nextFrameId: 0,
      health: new ScreencastHealth(),
      watchdogFailureStreak: 0,
      watchdogSkipTicks: 0,
      ackRestartTimer: null,
      // Seeded from the LAUNCH size, not the most-recent resize: this page has been created at the
      // context's viewport and nothing has resized it yet. Seeding it with another tab's size feeds
      // captureScreenshot's SDK_SAFE_MAX_DIMENSION check a viewport this page never had, so a
      // screenshot taken before the first resize could emit a clip sized for a different tab.
      viewport: { ...this.launchViewport },
      faviconToken: 0,
      ownerScopeId: owner,
      consoleCollector,
      networkCollector,
      dialogs: [],
      dialogsReportedUpTo: 0,
      pendingUploadPaths: null,
      resizeChain: Promise.resolve(),
    };
    this.pages.set(page, entry);
    controller.setKnownViewport(entry.viewport);

    // Explicit default dialog policy (decision #3): Playwright auto-dismisses dialogs by default,
    // silently changing page behavior and potentially stranding flows. Accept every dialog type
    // (alert/confirm/prompt/beforeunload) so navigation/interaction never hang.
    page.on('dialog', (dialog) => this.handleDialog(entry, dialog));

    // Per-tab collectors: each tab records into its OWN ring buffers unconditionally (no active-page
    // gate) so a scope reads its own tab's console/network regardless of which tab the human is watching.
    // Console is NOT wired here — `page.on('console')` is inert under Patchright and the in-page bridge
    // (onConsoleBinding) is the sole source; wiring both would double-record if Patchright ever restored it.
    page.on('response', (res) => {
      const status = res.status();
      if (status >= 400) entry.networkCollector.recordResponse(res.url(), status, res.statusText());
    });
    page.on('requestfailed', (req) => {
      entry.networkCollector.recordRequestFailed(req.url(), req.failure()?.errorText ?? 'failed');
    });

    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      this.onMainFrameNavigated(entry, frame.url());
    });

    // Screencast frames arrive on this page's own CDP session (only started for the active page).
    session.on('Page.screencastFrame', (frame) => this.screencast.onFrame(entry, frame));
    // Chrome's inspect-overlay click path. Mostly dormant under headless (the panel-click path drives
    // picking), but wired for parity; only fires once Overlay is enabled via picker.startPicking().
    session.on('Overlay.inspectNodeRequested', (p) => {
      if (this.activePage === page && entry.picker.isPicking) {
        entry.picker.handleInspectNodeRequested(p.backendNodeId).catch((err) =>
          log(`[Browser] Inspect node failed — ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    });

    page.on('close', () => this.handlePageClosed(page));

    // Page-initiated popups (window.open AND <a target="_blank"> navigations) surface via the
    // page-scoped 'popup' event in addition to the context-level 'page' event. Route both through
    // handleNewPage so a popup is captured regardless of which event the engine emits — stealth-patched
    // Chromium (Patchright) reliably emits 'popup' for anchor-target navigations that do not always
    // reach context.on('page'). Registration is idempotent, so a popup that fires both is set up once.
    page.on('popup', (popup) => {
      this.handleNewPage(popup).catch((err) =>
        log(`[Browser] handlePopup failed — ${err instanceof Error ? err.message : String(err)}`),
      );
    });

    // Native file-chooser safety net. BrowserUpload's primary path is setInputFiles(selector); this
    // handler covers a click-triggered native chooser. Single-shot: consume + clear the staged paths so
    // a later unrelated chooser is not accidentally auto-filled. With nothing staged, setFiles([])
    // resolves the chooser harmlessly instead of leaving the page hung on an open dialog.
    page.on('filechooser', async (chooser) => {
      const staged = entry.pendingUploadPaths;
      entry.pendingUploadPaths = null;
      try {
        await chooser.setFiles(staged ?? []);
      } catch (err) {
        log(`[Browser] filechooser setFiles failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    page.on('download', (download) => this.downloadManager.handleDownload(download));

    if (this.cleanUserAgent) {
      await controller.setUserAgentOverride(this.cleanUserAgent).catch((err) =>
        log(`[Browser] UA override failed — ${err instanceof Error ? err.message : String(err)}`),
      );
    }

    // Bind this page's own editor tab (toolbar/input/screencast) and show it. presentPanel adopts a
    // restored panel when one is pending, otherwise opens a new editor tab in the browser column.
    this.wirePanel(entry);
    this.presentPanel(entry);

    return entry;
  }

  // A page surfaced via context.on('page') or page.on('popup') (a spontaneous popup). Registration is
  // idempotent and resolves the owner from the popup's opener (doRegisterPage → resolveOwnerScope), so
  // the popup belongs to the scope whose page spawned it. It creates its own editor tab and shows it;
  // VS Code reveals the new panel, whose visibility handler starts its screencast and marks it the
  // human's active tab. It is NOT made any scope's current tab (only the opener's tab stays current).
  private async handleNewPage(page: Page): Promise<void> {
    await this.registerPage(page);
  }

  // Marks `page` as the primary active page for agent tools + collectors + currentUrl. Screencast
  // start/stop is NOT done here — each page's panel owns its stream via its visibility handler. Sync.
  private setActivePage(page: Page): void {
    this.activePage = page;
    const entry = this.pages.get(page);
    if (!entry) return;
    if (entry.lastUrl) this.currentUrl = entry.lastUrl;
  }

  private handlePageClosed(page: Page): void {
    const entry = this.pages.get(page);
    if (!entry) return;
    const ownerScopeId = entry.ownerScopeId;
    // Capture the closed tab's position BEFORE deleting so we can pick its right neighbor as the next
    // active page (survivors after it shift left by one).
    const closedIndex = [...this.pages.keys()].indexOf(page);
    this.pages.delete(page);
    this.screencast.releasePendingAck(entry, 'drop');
    if (entry.ackRestartTimer) clearTimeout(entry.ackRestartTimer);
    entry.picker.stopPicking().catch(() => {});
    // Dispose this page's editor tab. If the user closed the tab, the panel is already disposing and
    // this is a harmless no-op; if the page closed programmatically (window.close / closeTab), this
    // removes the now-orphaned editor tab.
    entry.panel.dispose();

    // Re-point the OWNING scope's current tab to another tab it owns (most-recent) or null — independent
    // of the human activePage neighbor logic below. Guarded on scopes.get(ownerScopeId) so a kept tab of
    // an already-disposed scope (errored subagent) closes safely with no registry entry.
    const scopeState = this.scopes.get(ownerScopeId);
    if (scopeState && scopeState.currentPage === page) {
      const remainingOwn = this.scopeTabs(ownerScopeId);
      scopeState.currentPage = remainingOwn.length > 0 ? remainingOwn[remainingOwn.length - 1]! : null;
    }

    // Placed before the early returns below so every exit path re-evaluates: this tab may have been the
    // only visible one, in which case the watchdog now has nothing to watch.
    this.screencast.syncWatchdog();

    // Last tab gone → end the whole session (unless we are already tearing down).
    if (this.pages.size === 0) {
      if (!this.closing) {
        this.close().catch((err) =>
          log(`[Browser] Close after last tab failed — ${err instanceof Error ? err.message : String(err)}`),
        );
      }
      return;
    }

    if (this.activePage !== page) return;
    this.activePage = null;
    // Right neighbor (else the new last tab). Bookkeeping only — VS Code focuses an adjacent editor
    // tab on close, and if that is a browser tab its visibility handler re-binds the screencast.
    const remaining = [...this.pages.keys()];
    const next = remaining[closedIndex] ?? remaining[remaining.length - 1];
    if (next) this.setActivePage(next);
  }

  private onMainFrameNavigated(entry: PageEntry, url: string): void {
    entry.lastUrl = url;
    // A main-frame navigation invalidates the old title and favicon; clear the title so the URL shows
    // until the title binding reports the new one, and refetch the favicon.
    entry.lastTitle = null;
    entry.panel.updateUrl(url);
    this.applyTabIdentity(entry);
    if (entry.page === this.activePage) this.currentUrl = url;
    if (this.iconCacheDir) resolveFavicon(this.iconCacheDir, entry, (icon) => entry.panel.setIcon(icon));
    // `Overlay.setInspectMode` is per-DOCUMENT, so after a navigation `Overlay.inspectNodeRequested`
    // can never fire for an in-flight pick. Left alone, `picking` stays true forever: the toolbar pick
    // button (`if (entry.picker.isPicking) return;`) goes permanently dead for this tab and every
    // programmatic pick throws 'Element picker is already active'.
    entry.picker.stopPicking().catch((err) =>
      log(`[Browser] Picker stop after navigation failed — ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  private handleDialog(entry: PageEntry, dialog: Dialog): void {
    // Read type/message BEFORE accepting: once the accept settles the dialog is answered and gone.
    const type = dialog.type();
    const raw = dialog.message();
    const message = raw.length > DIALOG_MESSAGE_MAX ? `${raw.slice(0, DIALOG_MESSAGE_MAX)}…(truncated)` : raw;
    // See registerPage: accept every dialog so flows never hang. Best-effort — a dialog can be
    // superseded by a navigation before we answer it, which rejects harmlessly but is still recorded:
    // the agent needs to know a dialog appeared even when our answer did not land.
    dialog.accept().then(
      () => this.recordDialog(entry, type, message, 'accepted'),
      (err) => {
        log(`[Browser] Dialog accept failed — ${err instanceof Error ? err.message : String(err)}`);
        this.recordDialog(entry, type, message, 'accept-failed');
      },
    );
  }

  private recordDialog(entry: PageEntry, type: string, message: string, answered: BrowserDialogRecord['answered']): void {
    entry.dialogs.push({ type, message, answered, timestamp: Date.now() });
    if (entry.dialogs.length > DIALOGS_MAX) {
      entry.dialogs.shift();
      // Dropping the oldest record shifts every remaining one down by one slot; without this the
      // watermark would point past already-reported records and re-report or skip them.
      entry.dialogsReportedUpTo = Math.max(0, entry.dialogsReportedUpTo - 1);
    }
  }

  private onCursorBinding(page: Page | undefined, cursor: string): void {
    if (!page) return;
    const entry = this.pages.get(page);
    if (!entry) return;
    entry.lastCursor = cursor;
    entry.panel.setCursor(cursor);
  }

  private onTitleBinding(page: Page | undefined, title: string): void {
    if (!page) return;
    const entry = this.pages.get(page);
    if (!entry) return;
    entry.lastTitle = title || null;
    this.applyTabIdentity(entry);
  }

  /** Receives one batch from a page's in-page console bridge and records it into THAT tab's collector.
   *  The payload is page-controlled, so every field is validated before it is trusted. */
  private onConsoleBinding(page: Page | undefined, payloadJson: string): void {
    if (!page) {
      log('[Browser] Console bridge payload from an unknown page — ignored.');
      return;
    }
    const entry = this.pages.get(page);
    if (!entry) {
      log('[Browser] Console bridge payload for an unregistered page — ignored.');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadJson);
    } catch (err) {
      log(`[Browser] Console bridge payload parse failed — ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!Array.isArray(parsed)) {
      log('[Browser] Console bridge payload was not an array — ignored.');
      return;
    }
    if (parsed.length > BRIDGE_CONSOLE_BATCH_MAX) {
      log(`[Browser] Console bridge batch of ${parsed.length} exceeded the cap — truncated.`);
    }
    for (const item of parsed.slice(0, BRIDGE_CONSOLE_BATCH_MAX)) {
      const { level, text } = (item ?? {}) as { level?: unknown; text?: unknown };
      if (typeof level !== 'string' || typeof text !== 'string') {
        log('[Browser] Console bridge entry had a non-string level/text — skipped.');
        continue;
      }
      // The per-entry text bound belongs to the collector, which caps and redacts on record — that
      // placement is what keeps the bound true for every producer, not just this one.
      entry.consoleCollector.record(level.slice(0, BRIDGE_CONSOLE_LEVEL_MAX_CHARS), text);
    }
  }

  private async maybeScrubUserAgent(entry: PageEntry): Promise<void> {
    try {
      const ua = await entry.page.evaluate(() => navigator.userAgent);
      if (typeof ua === 'string' && ua.includes('HeadlessChrome')) {
        this.cleanUserAgent = ua.replace(/HeadlessChrome/g, 'Chrome');
        await entry.controller.setUserAgentOverride(this.cleanUserAgent);
      }
    } catch (err) {
      log(`[Browser] UA scrub check failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Bind a page's dedicated editor tab (toolbar/input/screencast) to its OWN entry — every handler
  // acts on `entry`, never a shared "active" panel. Runs once per page in doRegisterPage.
  private wirePanel(entry: PageEntry): void {
    const panel = entry.panel;
    const controller = entry.controller;

    // Closing THIS editor tab closes THIS page. handlePageClosed disposes the panel and, when it was
    // the last tab, ends the whole session.
    panel.onClose(() => {
      entry.page.close().catch((err) =>
        log(`[Browser] Tab close failed — ${err instanceof Error ? err.message : String(err)}`),
      );
    });
    panel.onMouseDown((x, y, button, buttons, clickCount, modifiers) => {
      if (entry.picker.isPicking) {
        controller.getNodeForLocation(x, y)
          .then(result => entry.picker.handleInspectNodeRequested(result.backendNodeId))
          .catch(err => log(`[Browser] Pick click failed — ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      controller.dispatchMouseEvent('mousePressed', x, y, {
        button: jsButtonToCdp(button),
        clickCount,
        buttons,
        modifiers,
      }).catch(err => log(`[Browser] Mouse down failed — ${err instanceof Error ? err.message : String(err)}`));
    });
    panel.onMouseUp((x, y, button, buttons, clickCount, modifiers) => {
      if (entry.picker.isPicking) return;
      controller.dispatchMouseEvent('mouseReleased', x, y, {
        button: jsButtonToCdp(button),
        clickCount,
        buttons,
        modifiers,
      }).catch(err => log(`[Browser] Mouse up failed — ${err instanceof Error ? err.message : String(err)}`));
    });
    panel.onPaste((text) => {
      controller.insertText(text).catch(err =>
        log(`[Browser] Paste failed — ${err instanceof Error ? err.message : String(err)}`),
      );
    });
    panel.onInsertText((text) => {
      controller.insertText(text).catch(err =>
        log(`[Browser] Composed text insert failed — ${err instanceof Error ? err.message : String(err)}`),
      );
    });
    panel.onCopy(() => {
      // DOM-only read → Patchright's ISOLATED world via page.evaluate (no raw Runtime.evaluate in the
      // main world). page.evaluate returns the value DIRECTLY — no `{ value }` unwrapping.
      controller.getPage().evaluate(GET_SELECTED_TEXT_EXPR)
        .then(result => {
          const text = typeof result === 'string' ? result : '';
          if (text) vscode.env.clipboard.writeText(text);
        })
        .catch(err => log(`[Browser] Copy failed — ${err instanceof Error ? err.message : String(err)}`));
    });
    panel.onCut(() => {
      controller.getPage().evaluate(GET_SELECTED_TEXT_EXPR)
        .then(result => {
          const text = typeof result === 'string' ? result : '';
          if (!text) return;
          vscode.env.clipboard.writeText(text);
          // INTENTIONAL ASYMMETRY — do not "tidy" this to page.evaluate like the read above. Reading
          // the selection is a pure DOM read and the DOM is shared across worlds, but execCommand
          // operates on the MAIN world's selection/editing state, which the isolated world does not
          // share. This one stays on the main world because it is a WRITE.
          controller.evaluate("document.execCommand('delete')", false).catch(err =>
            log(`[Browser] Cut delete failed — ${err instanceof Error ? err.message : String(err)}`),
          );
        })
        .catch(err => log(`[Browser] Cut failed — ${err instanceof Error ? err.message : String(err)}`));
    });
    panel.onKey((key, code, text, keyCode, modifiers, phase) => {
      const vk = keyCode || 0;
      // Modifier keys arrive as separate down/up halves so a held Shift stays held for the keys typed
      // under it; synthesising an immediate pair would release it before the next keystroke.
      if (phase === 'down') {
        controller.dispatchKeyEvent('rawKeyDown', { key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
          .catch(err => log(`[Browser] Key down failed — ${err instanceof Error ? err.message : String(err)}`));
      } else if (phase === 'up') {
        controller.dispatchKeyEvent('keyUp', { key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
          .catch(err => log(`[Browser] Key up failed — ${err instanceof Error ? err.message : String(err)}`));
      } else if (key === 'Enter') {
        // Enter must carry text '\r' on keyDown (Puppeteer behavior) so it commits in inputs.
        controller.dispatchKeyEvent('keyDown', { key, code, text: '\r', modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }).then(() =>
          controller.dispatchKeyEvent('keyUp', { key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }),
        ).catch(() => {});
      } else if (text) {
        controller.dispatchKeyEvent('keyDown', { key, code, text, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }).then(() =>
          controller.dispatchKeyEvent('keyUp', { key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }),
        ).catch(() => {});
      } else {
        controller.dispatchKeyEvent('rawKeyDown', { key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }).then(() =>
          controller.dispatchKeyEvent('keyUp', { key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }),
        ).catch(() => {});
      }
    });
    panel.onScroll((x, y, deltaX, deltaY) => {
      controller.dispatchWheelEvent(x, y, deltaX, deltaY).catch(() => {});
    });
    panel.onFrameRendered((frameId) => this.screencast.onFrameRendered(entry, frameId));
    // The webview already debounces (ResizeObserver, 150ms), so this runs straight through — but it is
    // serialized per tab: resizeEntry awaits several CDP calls, and two overlapping runs could land A's
    // stopScreencast after B's startScreencast, leaving the stream dead. Latest-wins: sizes requested
    // during an in-flight run collapse into one trailing run at the newest size, so a slow drag costs
    // one extra resize, not one per event. The page-closed guard covers a run that outlived the tab.
    let latestResize: { width: number; height: number; dpr: number } | null = null;
    panel.onResize((width, height, dpr) => {
      latestResize = { width, height, dpr };
      entry.resizeChain = entry.resizeChain.then(() => {
        const target = latestResize;
        latestResize = null;
        if (!target || !this.pages.has(entry.page)) return;
        return this.resizeEntry(entry, target.width, target.height, target.dpr).catch((err) =>
          log(`[Browser] Viewport resize failed — ${err instanceof Error ? err.message : String(err)}`),
        );
      });
    });
    panel.onMouseMove((x, y, buttons) => {
      const button = buttons & 1 ? 'left' : buttons & 2 ? 'right' : buttons & 4 ? 'middle' : 'none' as const;
      controller.dispatchMouseEvent('mouseMoved', x, y, { button, buttons }).catch(() => {});
    });
    // Enforced HOST-side, not in the webview's input handler: the webview is the untrusted end of this
    // channel, so a check that lives only there is a check an attacker-controlled message skips.
    panel.onNavigate((navUrl) => {
      if (!isNavigableUrl(navUrl)) {
        log(`[Browser] Refused address-bar navigation to a non-web scheme — ${navUrl.slice(0, 120)}`);
        panel.updateUrl(entry.lastUrl ?? this.currentUrl ?? '');
        return;
      }
      controller.navigate(navUrl).catch((err) =>
        log(`[Browser] Navigate failed — ${err instanceof Error ? err.message : String(err)}`),
      );
    });
    // Driven through Playwright rather than main-world JS: a page can override history.back /
    // location.reload and hijack the toolbar, and this issues no Runtime.evaluate at all.
    panel.onGoBack(() => {
      entry.page.goBack().catch((err) =>
        log(`[Browser] Back failed — ${err instanceof Error ? err.message : String(err)}`),
      );
    });
    panel.onGoForward(() => {
      entry.page.goForward().catch((err) =>
        log(`[Browser] Forward failed — ${err instanceof Error ? err.message : String(err)}`),
      );
    });
    panel.onReload(() => {
      entry.page.reload().catch((err) =>
        log(`[Browser] Reload failed — ${err instanceof Error ? err.message : String(err)}`),
      );
    });
    panel.onPickElement(() => {
      if (entry.picker.isPicking) return;
      panel.setPickingState(true);
      entry.picker.startPicking()
        .then((attachment) => {
          panel.setPickingState(false);
          panel.showElementInfo({
            selector: attachment.selector,
            tagName: attachment.tagName,
            boundingBox: attachment.boundingBox,
            padding: attachment.computedStyles['padding'] ?? '',
          });
          this.broadcastToChat?.(attachment);
        })
        .catch((err) => {
          panel.setPickingState(false);
          log(`[Browser] Toolbar pick failed — ${err instanceof Error ? err.message : String(err)}`);
        });
    });
    panel.onOpenDevTools(() => {
      this.openDevToolsFor(entry).catch(err =>
        log(`[Browser] DevTools failed — ${err instanceof Error ? err.message : String(err)}`),
      );
    });
    panel.onTabNew(() => {
      // `+` is a HUMAN action, so the tab belongs to the human's primary scope regardless of which
      // panel it was clicked on. Opening it in the panel's own scope would re-point a running
      // subagent's current tab at a blank page the human, not the agent, asked for.
      this.openNewTab(BrowserService.PRIMARY_SCOPE_ID).catch(err =>
        log(`[Browser] New tab failed — ${err instanceof Error ? err.message : String(err)}`),
      );
    });
    // Visibility only records INTENT. Nothing is posted here and no stream is started: at this point
    // the webview is still being (re)built and its message listener is not attached, so every post
    // would be silently dropped and a frame arriving in that window would be lost. `ready` below is
    // the ordering authority.
    panel.onVisibilityChange((visible) => {
      if (!visible) {
        entry.wantsStream = false;
        entry.health.noteStopped();
        // The webview is being torn down asynchronously and the frame we posted may never paint, so
        // settle the outstanding ack HERE rather than waiting on a frameRendered that will never come.
        this.screencast.releasePendingAck(entry, 'ack');
        controller.stopScreencast().catch((err) =>
          log(`[Browser] Stop screencast on hide failed: ${err instanceof Error ? err.message : String(err)}`),
        );
        this.screencast.syncWatchdog();
        return;
      }
      entry.wantsStream = true;
      // Arms the stall clock HERE, where the intent is formed, not in `start()` below. `ready` is the
      // only thing that calls `start()`, so a webview that never posts it would otherwise leave the
      // watchdog with nothing to measure and the panel waiting on frames forever.
      entry.health.noteWanted();
      this.setActivePage(entry.page);
      this.screencast.syncWatchdog();
    });
    // The webview's listener is now attached, so this is the first moment a post can actually land.
    // Replaying state before starting the stream is what makes "the viewport is known before the first
    // frame" true rather than hoped for.
    panel.onReady(() => {
      this.resyncPanel(entry);
      if (!entry.wantsStream) return;
      this.screencast.start(entry).catch((err) =>
        log(`[Browser] Restart screencast on ready failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    });
  }

  /** Replay every piece of panel state the host owns into a freshly-listening webview. Idempotent:
   *  a panel can go through any number of hide→show→ready cycles. */
  private resyncPanel(entry: PageEntry): void {
    const panel = entry.panel;
    panel.updateUrl(entry.lastUrl ?? this.currentUrl ?? '');
    panel.updateViewport(entry.viewport.width, entry.viewport.height);
    panel.setPickingState(entry.picker.isPicking);
    panel.setCursor(entry.lastCursor ?? 'default');
    // A repaint of an already-acked frame, not a live CDP frame: it gets a fresh id but no pendingAck,
    // so its frameRendered reply lands on a null pendingAck and no-ops.
    if (entry.lastFrame) {
      panel.pushFrame(entry.lastFrame.bytes, entry.lastFrame.deviceWidth, entry.lastFrame.deviceHeight, entry.nextFrameId++);
    }
  }

  // The ONLY panel-construction path — a deserialized panel is disposed and rebuilt here rather than
  // adopted, because retainContextWhenHidden is fixed at createWebviewPanel time and cannot be cleared
  // on a live panel. No state is posted and no stream is started: the panel's webview is not listening
  // yet, so both belong to the `ready` handler.
  private presentPanel(entry: PageEntry): void {
    const panel = entry.panel;
    const url = entry.lastUrl ?? this.currentUrl ?? 'about:blank';
    panel.show(url, this.browserColumn);
    this.browserColumn = panel.viewColumn ?? this.browserColumn;
    this.applyTabIdentity(entry);
    if (panel.visible) {
      entry.wantsStream = true;
      entry.health.noteWanted();
      this.setActivePage(entry.page);
    }
    this.screencast.syncWatchdog();
  }

  // Opens DevTools for the active tab (used by the extension command). Per-tab toolbar buttons call
  // openDevToolsFor directly with their own entry.
  toggleDevTools(): void {
    const active = this.getActiveEntry();
    if (!active) {
      log('[Browser] Cannot open DevTools — no active page');
      return;
    }
    this.openDevToolsFor(active).catch(err =>
      log(`[Browser] DevTools failed — ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  // Chrome is launched with --remote-debugging-port=0, so it writes the chosen port to the
  // DevToolsActivePort file in the user-data-dir (line 1 = port). Playwright drives its own connection
  // over a pipe, so the port coexists and the external DevTools can attach to the same targets. We read
  // the port from that file (no child_process stderr parse), find the given page's target, and open
  // the localhost DevTools URL — no detach/reattach dance, which is unnecessary now Playwright owns the
  // persistent connection.
  private async openDevToolsFor(entry: PageEntry): Promise<void> {
    // A relaunch is required because --remote-debugging-port is a launch-time Chromium flag: there is
    // no way to open the port on a running browser, and offering a live retry would be a lie.
    if (!this.readDevToolsPortSetting()) {
      const OPEN_SETTINGS = vscode.l10n.t('Open Settings');
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t('DevTools is unavailable because the debugging port is disabled by damocles.browser.devToolsPort. Enable the setting and relaunch the browser — the port is a launch-time flag and cannot be turned on for a running browser.'),
        OPEN_SETTINGS,
      );
      if (choice === OPEN_SETTINGS) {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'damocles.browser.devToolsPort');
      }
      return;
    }
    const port = await this.readDevToolsPort();
    if (!port) {
      log('[Browser] Cannot open DevTools — DevToolsActivePort unavailable');
      return;
    }

    let targetId: string | null = null;
    try {
      const targets = await fetchJson<CdpPageJson[]>(`http://127.0.0.1:${port}/json`);
      const currentUrl = entry.page.url();
      const match = targets.find((t) => t.type === 'page' && t.url === currentUrl)
        ?? targets.find((t) => t.type === 'page');
      targetId = match?.id ?? null;
    } catch (err) {
      log(`[Browser] DevTools target lookup failed — ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!targetId) {
      log('[Browser] Cannot open DevTools — no page target found');
      return;
    }

    const devtoolsUrl = `http://127.0.0.1:${port}/devtools/inspector.html?ws=127.0.0.1:${port}/devtools/page/${targetId}`;
    await vscode.env.openExternal(vscode.Uri.parse(devtoolsUrl));
  }

  private async readDevToolsPort(): Promise<number | null> {
    if (!this.userDataDir) return null;
    try {
      const content = await fsp.readFile(join(this.userDataDir, 'DevToolsActivePort'), 'utf8');
      const firstLine = content.split('\n')[0]?.trim();
      const port = firstLine ? parseInt(firstLine, 10) : NaN;
      if (!Number.isFinite(port)) return null;
      // DevToolsActivePort survives a crashed launch, so the port it names may now belong to an
      // unrelated local process that openExternal would aim the user at. Only a Chrome-shaped
      // /json/version payload proves the port is still our browser.
      const version = await fetchJson<{ Browser?: unknown }>(`http://127.0.0.1:${port}/json/version`);
      if (typeof version?.Browser === 'string' && /^(Headless)?Chrome\//.test(version.Browser)) return port;
      log(`[Browser] Ignoring stale DevToolsActivePort ${port} — not a Chrome DevTools endpoint`);
      return null;
    } catch (err) {
      log(`[Browser] DevTools port probe failed — ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // Sets this page's editor-tab label to its title, falling back to its URL until a title exists.
  private applyTabIdentity(entry: PageEntry): void {
    if (!entry.lastUrl) return;
    entry.panel.setTabTitle(entry.lastTitle, entry.lastUrl);
  }

  // Resize a single page to its own editor tab's size (panels can differ under split view). Restarts
  // that page's screencast at the new size if the panel is visible.
  private async resizeEntry(entry: PageEntry, width: number, height: number, dpr: number): Promise<void> {
    entry.viewport = { width, height, dpr: Math.min(dpr, MAX_DEVICE_SCALE) };
    // Track the most-recent size as the default for the NEXT launch. Not applied to existing tabs or
    // to `launchViewport`, neither of which this resize changes.
    this.viewport = { ...entry.viewport };
    try {
      await entry.controller.setViewport(width, height, entry.viewport.dpr);
    } catch (err) {
      log(`[Browser] Viewport set failed — ${err instanceof Error ? err.message : String(err)}`);
    }
    entry.panel.updateViewport(width, height);
    // Stopping the stream abandons any frame the webview has not painted yet, so settle it first.
    this.screencast.releasePendingAck(entry, 'ack');
    // Guard the stop: a rejected stopScreencast (e.g. the CDP send timed out) must not skip the
    // restart, or the panel would be left with a stale-sized stream and no recovery.
    await entry.controller.stopScreencast().catch((err) =>
      log(`[Browser] Stop screencast on resize failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    if (entry.panel.visible) await this.screencast.start(entry);
  }

  // The persistent context closed on its own (Chrome crashed or was killed externally). With one editor
  // tab per page, there is no single recovery panel to keep alive, so the session is torn down: every
  // browser editor tab closes and the service is reset. The user/agent reopens the browser to recover.
  private handleContextGone(context: BrowserContext): void {
    // Only the LIVE context triggers teardown. A superseded context (torn down, or replaced by a
    // relaunch) firing 'close' must not be misrouted — every intentional teardown nulls/replaces
    // `this.context` before closing.
    if (this.context !== context) return;
    if (this.closing) return;
    log('[Browser] Browser context closed unexpectedly — tearing down the session.');
    // Every browser editor tab is about to vanish; without this the user has no way to tell an
    // unexpected Chrome exit from the extension losing their tabs for no reason.
    vscode.window.showWarningMessage(vscode.l10n.t('The browser closed unexpectedly. Open it again to continue.'));
    this.close().catch((err) =>
      log(`[Browser] Cleanup after context loss failed — ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  /**
   * Release everything one page owns. Its own method because every teardown path owes the SAME set of
   * obligations — the pending screencast ack, the debounced ack-restart, the picker and the editor tab
   * — and duplicating them is how one path quietly ends up missing one.
   */
  private disposeEntry(entry: PageEntry): void {
    this.screencast.releasePendingAck(entry, 'drop');
    if (entry.ackRestartTimer) clearTimeout(entry.ackRestartTimer);
    entry.picker.stopPicking().catch(() => {});
    entry.panel.dispose();
  }

  /**
   * The ONE teardown path: every page released, the context closed, the service reset to a reusable
   * disconnected state. `close()`, `dispose()` and the unexpected-exit handler all route through here,
   * so each obligation is written down exactly once.
   *
   * `awaitContextClose` is the only difference between the callers. An explicit `close()` waits for
   * Chrome to actually exit; `dispose()` on extension shutdown also waits, so Chrome does not outlive
   * the extension host — the state reset before it is synchronous either way, so the service is
   * immediately reusable regardless.
   */
  private async teardown(awaitContextClose: boolean): Promise<void> {
    const closed = this.releaseContext();
    this.resetState();
    if (awaitContextClose) await closed;
  }

  /**
   * Release every page and the context itself, WITHOUT resetting the service's own state. Returns the
   * context-close promise so the caller decides whether to wait.
   *
   * Split from {@link BrowserService.resetState} for the failed-launch path alone: that one tears the
   * half-built context down but must keep `currentUrl`, because its caller decides whether to clear it
   * and a recovery panel needs it to relaunch on Reload.
   */
  private releaseContext(): Promise<void> {
    // Marked first so the context 'close' event handler treats this as an intentional teardown rather
    // than a crash to recover from.
    this.closing = true;
    for (const entry of this.pages.values()) this.disposeEntry(entry);
    this.pages.clear();
    this.activePage = null;
    const ctx = this.context;
    this.context = null;
    // The rules are routes on a context that is going away, so drop them WITHOUT unrouting. Done
    // synchronously so listInterceptRules() never reports phantoms while the close settles.
    this.interceptManager.forget();
    if (!ctx) return Promise.resolve();
    return ctx.close().catch((err) => log(`[Browser] Context close failed — ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Return the service to a fresh, reusable disconnected state. Synchronous, and never touches the
   *  context or the pages — {@link BrowserService.teardown} owns those. */
  private resetState(): void {
    // Collectors + upload staging are per-tab (disposed with their entries) — nothing service-level to
    // clear. Reset the scope registry to a fresh primary-only map; orphaned subagent scopes (no live
    // tabs after teardown) drop out, and a scope's tool closure self-heals via scopeState on next use.
    this.scopes = new Map<string, { currentPage: Page | null }>([
      [BrowserService.PRIMARY_SCOPE_ID, { currentPage: null }],
    ]);
    this.launchOwnerScopeId = null;
    this.cleanUserAgent = null;
    this.state = 'disconnected';
    // Must follow the state reset above (and teardown's pages.clear()): syncWatchdog reads both, and
    // running it any earlier would see a populated map of visible panels and keep the interval alive
    // across teardown.
    this.screencast.syncWatchdog();
    this.currentUrl = null;
    this.browserColumn = undefined;
    this.restoreClaimed = false;
    this.userDataDir = null;
    this.iconCacheDir = null;
    this.downloadManager.reset();
    this.closing = false;
  }

  /** Extension shutdown. Awaits the context close so Chrome does not outlive the extension host —
   *  a guarantee that holds only because every caller up to `deactivate` awaits this promise. */
  dispose(): Promise<void> {
    return this.teardown(true);
  }
}
