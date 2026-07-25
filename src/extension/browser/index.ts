import { promises as fsp } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';
import { get as httpGet } from 'http';
import * as vscode from 'vscode';
import type { BrowserContext, Page, CDPSession, Dialog, Route } from 'patchright';
import { launchBrowserContext } from './launcher';
import { PageController } from './page-controller';
import { BrowserPanel } from './browser-panel';
import { ScreencastHealth } from './screencast-health';
import { ConsoleCollector, NetworkCollector } from './collectors';
import { ElementPicker } from './element-picker';
import { isBlockedFaviconHost } from './net-guard';
import { BrowserAgentScope, type ScopeTabInfo } from './agent-scope';
import { log } from '../logger';
import { DAMOCLES_BROWSER_DOWNLOADS_DIR } from '../paths';
import type { BrowserSessionState, InterceptRule, RedactedInterceptRule } from './types';
import type { ElementAttachment, ConsoleEntry, NetworkError, DownloadEntry } from '../../shared/types/browser';

export { BrowserAgentScope } from './agent-scope';
export type { ScopeTabInfo } from './agent-scope';

/** Keep only the most-recent N per-launch download dirs to bound cross-launch on-disk growth. */
const DOWNLOAD_DIR_RETENTION = 10;

/**
 * A pattern is "over-broad" when it consists ONLY of glob wildcards and URL separators (for example a
 * bare double-star, a lone star, or a `scheme://` catch-all) — it matches every request. Used to
 * forbid blanket block/fulfill rules that would abort or stub the entire page.
 */
function isOverBroadPattern(pattern: string): boolean {
  return pattern.replace(/[*/:.\s]/g, '').length === 0;
}

interface CdpPageJson {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

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
  lastFrame: { data: string; deviceWidth: number; deviceHeight: number } | null;
  viewport: { width: number; height: number; dpr: number };
  faviconToken: number;
  ownerScopeId: string;
  consoleCollector: ConsoleCollector;
  networkCollector: NetworkCollector;
  pendingUploadPaths: string[] | null;
  /** Pending debounced viewport resize for this tab's panel; cleared when the page closes. */
  resizeTimer: ReturnType<typeof setTimeout> | null;
}

function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      let body = '';
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as T);
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

const GET_SELECTED_TEXT_EXPR = `(() => {
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.selectionStart === 'number') {
    return el.value.substring(el.selectionStart, el.selectionEnd);
  }
  return window.getSelection().toString();
})()`;

// Injected via context.addInitScript (runs in the page's main world under Patchright, which injects
// init scripts at the HTML-request level rather than via Runtime.enable). Chromium does not emit a
// title-change event, so the live tab title is pushed from the renderer: a MutationObserver on <head>
// reports document.title through the __damoclesTitle binding (context.exposeBinding) whenever it
// changes. The binding name here must match the exposeBinding name exactly.
const TITLE_OBSERVER_SCRIPT = `(() => {
  let lastTitle = null;
  const report = () => {
    const t = document.title;
    if (t !== lastTitle) { lastTitle = t; window.__damoclesTitle(t); }
  };
  const start = () => {
    report();
    const target = document.head || document.documentElement;
    if (!target) return;
    new MutationObserver(report).observe(target, { subtree: true, childList: true, characterData: true });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();`;

// Injected via context.addInitScript. Push-based cursor: reports the hovered element's cursor once per
// change through the __damoclesCursor binding, so hover feedback costs zero per-move CDP round trips
// and survives navigations. The binding name must match the exposeBinding name exactly.
const CURSOR_OBSERVER_SCRIPT = `(() => {
  let last = null;
  let pending = false;
  let latest = null;
  const compute = (el) => {
    if (!el || !(el instanceof Element)) return 'default';
    const cs = getComputedStyle(el).cursor;
    if (cs && cs !== 'auto') return cs;
    if (el.tagName === 'A' || el.closest('a') || el.closest('[role=button]')) return 'pointer';
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return 'text';
    return 'default';
  };
  const flush = () => {
    pending = false;
    const cursor = compute(latest);
    if (cursor !== last) {
      last = cursor;
      window.__damoclesCursor(cursor);
    }
  };
  document.addEventListener('mousemove', (e) => {
    latest = e.target;
    if (pending) return;
    pending = true;
    requestAnimationFrame(flush);
  }, { passive: true });
})();`;

/**
 * Installs Damocles' context-level cursor + title observers: the two `exposeBinding` endpoints and the
 * matching init scripts. Extracted so the exact same install path is shared by `launchAndAdopt` and
 * the env-gated integration test (which asserts the observers still fire alongside an active intercept
 * route) — the test drives the REAL scripts rather than duplicating their text. The init scripts run in
 * every current and future page/frame under Patchright (which injects at the HTML-request level, no
 * Runtime.enable). Binding names must match the names the scripts call.
 */
export async function installContextObservers(
  context: BrowserContext,
  handlers: {
    onCursor: (page: Page | undefined, cursor: string) => void;
    onTitle: (page: Page | undefined, title: string) => void;
  },
): Promise<void> {
  await context.exposeBinding('__damoclesCursor', (source, cursor: string) => handlers.onCursor(source.page, cursor));
  await context.exposeBinding('__damoclesTitle', (source, title: string) => handlers.onTitle(source.page, title));
  await context.addInitScript(CURSOR_OBSERVER_SCRIPT);
  await context.addInitScript(TITLE_OBSERVER_SCRIPT);
}

// Collects favicon candidate URLs from the page. This is a pure DOM read (no fetch): downloading
// in the page context is governed by the page's CSP connect-src, which on strict sites blocks
// script-initiated fetches of icon URLs even though the browser itself may load them, so the actual
// download happens extension side. Waits for DOMContentLoaded first because callers evaluate this
// right after navigation commit, before <head> is parsed; if the scan finds no declared links it
// retries once after the window load event (capped at 8s to stay under the CDP send timeout),
// covering SPAs that inject the icon link late. Returns a JSON array of absolute URLs, declared
// icons first (largest sizes first), always ending with the /favicon.ico fallback.
const GET_FAVICON_CANDIDATES_EXPR = `(async () => {
  const scan = () => Array.from(document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]'))
    .map((l) => {
      const sizes = (l.getAttribute('sizes') || '').split('x')[0];
      return { href: l.href, size: parseInt(sizes, 10) || 0 };
    })
    .filter((c) => c.href)
    .sort((a, b) => b.size - a.size)
    .map((c) => c.href);
  if (document.readyState === 'loading') {
    await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
  }
  let candidates = scan();
  if (candidates.length === 0 && document.readyState !== 'complete') {
    await new Promise((r) => {
      const timer = setTimeout(r, 8000);
      window.addEventListener('load', () => { clearTimeout(timer); r(); }, { once: true });
    });
    candidates = scan();
  }
  candidates.push(new URL('/favicon.ico', location.origin).href);
  return JSON.stringify(candidates);
})()`;

const FAVICON_MAX_BYTES = 512 * 1024;
const FAVICON_CACHE_MAX_FILES = 256;

// Ring-buffer cap for captured downloads. Bounded so a long session that downloads many files never
// grows the in-memory list unbounded; the oldest entry is dropped once the cap is exceeded.
const DOWNLOADS_MAX = 50;

const FAVICON_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/svg+xml': 'svg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
};

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
  // A VS Code panel handed to us by the deserializer (window reload) that the next registered page must
  // adopt instead of creating a fresh WebviewPanel. Single-shot: consumed by the first presentPanel.
  private pendingAdoptPanel: vscode.WebviewPanel | null = null;
  // Guards restore so only the first persisted browser tab relaunches the session; extras are disposed.
  private restoreClaimed = false;
  private broadcastToChat: ((element: ElementAttachment) => void) | null = null;
  private cleanUserAgent: string | null = null;
  // Default/most-recent viewport, used to size the launch context and seed each new page's viewport.
  private viewport: { width: number; height: number; dpr: number } = { width: 1920, height: 1080, dpr: 1 };
  private screencastHealth = new ScreencastHealth();
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogFailureStreak = 0;
  private watchdogBackoffUntil = 0;
  private ackRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private iconCacheDir: string | null = null;
  private openChain: Promise<void> = Promise.resolve();
  private closing = false;
  // Per-launch downloads directory (set in ensureUserDataDir, nulled in cleanup) + bounded capture list.
  private downloadsDir: string | null = null;
  private downloads: DownloadEntry[] = [];
  // Saved download paths reserved this launch, so concurrent same-name downloads never collide on disk.
  private takenDownloadPaths = new Set<string>();
  // Active network-interception rules (BrowserIntercept). Each entry keeps the Playwright route handler
  // reference so it can be removed via context.unroute. Cleared on cleanup() (close + dispose).
  private interceptRules: { rule: InterceptRule; handler: (route: Route) => Promise<void> }[] = [];

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
    return [...this.downloads];
  }

  /**
   * Register a network-interception rule against the context via context.route. Validates the rule,
   * generates an id, installs the handler, records it (with its handler reference for later unroute),
   * and returns the id. Throws if the browser is not connected or the rule is malformed. Synchronous by
   * contract: the route() CDP round-trip is fire-and-forget (interception applies to future requests).
   */
  addInterceptRule(rule: Omit<InterceptRule, 'id'>): string {
    if (!this.context) {
      throw new Error('Browser is not connected — open a page before adding an intercept rule.');
    }
    if (!rule.pattern) {
      throw new Error('An intercept rule requires a pattern.');
    }
    // A blanket pattern (only glob wildcards/separators) with block or fulfill would abort or stub
    // EVERY request — breaking the page and risking bot detection. Only continue/modify rules, which
    // pass requests through, may target everything; block/fulfill must name a specific URL/resource.
    if (rule.action !== 'continue' && isOverBroadPattern(rule.pattern)) {
      throw new Error(
        `An over-broad pattern ("${rule.pattern}") is not allowed for ${rule.action} rules — target a specific URL or resource pattern.`,
      );
    }
    if (rule.action === 'fulfill' && (!rule.fulfill || typeof rule.fulfill.status !== 'number')) {
      throw new Error('A fulfill rule requires fulfill.status.');
    }
    if (rule.action === 'continue' && rule.modify && !rule.modify.headers) {
      throw new Error('A modify rule requires modify.headers.');
    }
    const id = `ir_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const fullRule: InterceptRule = { ...rule, id };
    const handler = this.makeInterceptHandler(fullRule);
    // Fire-and-forget the route() CDP round-trip (the public method is synchronous by contract); log
    // only pattern/action on failure — NEVER any body.
    Promise.resolve(this.context.route(fullRule.pattern, handler)).catch((err) =>
      log(`[Browser] Intercept route registration failed for ${fullRule.action} ${fullRule.pattern} — ${err instanceof Error ? err.message : String(err)}`),
    );
    this.interceptRules.push({ rule: fullRule, handler });
    return id;
  }

  /** A REDACTED view of the active intercept rules — the raw fulfill body is never returned (bodyBytes only). */
  listInterceptRules(): RedactedInterceptRule[] {
    return this.interceptRules.map(({ rule }) => {
      const redacted: RedactedInterceptRule = { id: rule.id, pattern: rule.pattern, action: rule.action };
      if (rule.fulfill) {
        redacted.status = rule.fulfill.status;
        if (rule.fulfill.body !== undefined) redacted.bodyBytes = Buffer.byteLength(rule.fulfill.body, 'utf8');
        if (rule.fulfill.headers) redacted.fulfillHeaderKeys = Object.keys(rule.fulfill.headers);
      }
      if (rule.modify?.headers) redacted.modifyHeaderKeys = Object.keys(rule.modify.headers);
      return redacted;
    });
  }

  /** Remove every intercept rule (unroute each pattern/handler) and empty the registry. Null-safe. */
  clearInterceptRules(): void {
    for (const entry of this.interceptRules) {
      // Fire-and-forget the unroute CDP round-trip; skipped entirely when the context is already gone.
      Promise.resolve(this.context?.unroute(entry.rule.pattern, entry.handler)).catch((err) =>
        log(`[Browser] Intercept unroute failed for ${entry.rule.action} ${entry.rule.pattern} — ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    this.interceptRules = [];
  }

  /**
   * Build the Playwright route handler for a rule. It ALWAYS terminates in EXACTLY ONE terminal so a
   * request can NEVER hang: block→abort, fulfill→fulfill, continue+headers→continue (merged headers),
   * pure let-through→fallback (so Patchright's earlier-registered stealth route still runs). The
   * try/catch is the ONE deliberate never-hang guard: on any error it falls back so the request
   * proceeds, logging ONLY pattern/action — NEVER request/response bodies (they may carry secrets).
   */
  private makeInterceptHandler(rule: InterceptRule): (route: Route) => Promise<void> {
    return async (route: Route) => {
      try {
        if (rule.action === 'block') {
          await route.abort();
          return;
        }
        if (rule.action === 'fulfill') {
          const opts: Parameters<Route['fulfill']>[0] = { status: rule.fulfill!.status };
          if (rule.fulfill!.headers) opts.headers = rule.fulfill!.headers;
          if (rule.fulfill!.body !== undefined) opts.body = rule.fulfill!.body;
          await route.fulfill(opts);
          return;
        }
        // action === 'continue'
        if (rule.modify?.headers) {
          await route.continue({ headers: { ...route.request().headers(), ...rule.modify.headers } });
          return;
        }
        // Pure let-through: fallback() defers to Patchright's earlier-registered route so its
        // stealth init-script injection still runs. NEVER continue() here — that would terminate the
        // chain and clobber Patchright's route.
        await route.fallback();
      } catch (err) {
        // DELIBERATE never-hang guard (the ONE place we swallow): a handler that throws without a
        // terminal would hang the request forever, so fall back to let it proceed. Log ONLY the
        // pattern/action — NEVER any body.
        log(`[Browser] Intercept handler error for ${rule.action} ${rule.pattern} — ${err instanceof Error ? err.message : String(err)}`);
        await route.fallback().catch(() => {});
      }
    };
  }

  // Reduce an untrusted suggested filename to a bare, path-safe basename: strip any directory
  // separators (so a download cannot escape the downloads dir) and control characters, and fall back
  // to 'download' when nothing usable remains.
  private sanitizeDownloadFilename(suggested: string): string {
    const cleaned = (suggested || '')
      .replace(/[/\\]/g, '_') // path separators (traversal)
      .replace(/:/g, '_') // Windows drive / NTFS alternate-data-stream colon
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f]/g, '') // control chars
      .trim();
    // A name that is only dots resolves to the current/parent directory under join() — never a file.
    if (cleaned === '' || /^\.+$/.test(cleaned)) return 'download';
    return cleaned;
  }

  // Reserve a collision-free path under `dir` for a sanitized filename. A second download with the same
  // name gets `name (1).ext`, `name (2).ext`, ... — never a silent overwrite. The claim is made BEFORE
  // the disk probe: with per-agent tabs two scopes really can download the same name at once, and a
  // check-then-await-then-claim would let both pass the Set check and reserve the same path. A candidate
  // that turns out to exist on disk stays claimed (it is taken either way) and the loop moves on.
  private async reserveDownloadPath(dir: string, filename: string): Promise<{ path: string; filename: string }> {
    const dot = filename.lastIndexOf('.');
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : '';
    for (let i = 0; ; i++) {
      const name = i === 0 ? filename : `${base} (${i})${ext}`;
      const full = join(dir, name);
      if (this.takenDownloadPaths.has(full)) continue;
      this.takenDownloadPaths.add(full);
      try {
        await fsp.access(full);
        continue; // exists on disk — keep it claimed and try the next suffix
      } catch {
        return { path: full, filename: name };
      }
    }
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
  // relaunches the session (adopting that panel for the first page); extras are disposed, since the
  // fresh Chromium context cannot be reconnected to the previously-open pages.
  async restorePanel(panel: vscode.WebviewPanel, url: string): Promise<void> {
    if (this.context || this.restoreClaimed) {
      panel.dispose();
      return;
    }
    this.restoreClaimed = true;
    this.currentUrl = url;
    this.pendingAdoptPanel = panel;
    try {
      // The primary scope owns the restored tab (main agent + human share it).
      await this.openForScope(BrowserService.PRIMARY_SCOPE_ID, url);
    } catch (err) {
      // Dispose the panel we were handed if no page ever adopted it: it has no message handler, no page,
      // and no owner, so leaving it would strand a dead browser tab in the editor. Already null when
      // presentPanel consumed it (the failure came later).
      const unadopted = this.pendingAdoptPanel;
      this.pendingAdoptPanel = null;
      unadopted?.dispose();
      log(`[Browser] Failed to restore browser session — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async close(): Promise<void> {
    await this.teardownContext();
    this.cleanup();
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

    // Deviation from the plan's <sessionId> downloads subdir (open question #8): BrowserService is a
    // panel-level singleton constructed with NO pi sessionId, so a per-launch id is used instead.
    // ensureUserDataDir already runs once per launch (userDataDir nulled in cleanup), so this isolates
    // each launch's downloads without threading pi's sessionId into the browser singleton — equivalent
    // isolation for the agent, and the ONLY id available at this layer.
    // Bound cross-launch disk growth: cleanup() only nulls the ref, so without this each launch's dir
    // would accumulate forever. Prune stale sibling launch dirs BEFORE creating this launch's (so the
    // new one is never a prune target). Best-effort — never blocks a launch.
    await this.pruneOldDownloadDirs();
    const launchId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const downloadsDir = join(DAMOCLES_BROWSER_DOWNLOADS_DIR, launchId);
    await fsp.mkdir(downloadsDir, { recursive: true });
    this.downloadsDir = downloadsDir;
  }

  /**
   * Keep only the most-recent {@link DOWNLOAD_DIR_RETENTION} per-launch download dirs, deleting older
   * ones by modification time. Fully fail-soft: a missing parent (first launch) or any I/O error is
   * logged and swallowed so pruning never blocks or fails a launch.
   */
  private async pruneOldDownloadDirs(): Promise<void> {
    try {
      const entries = await fsp.readdir(DAMOCLES_BROWSER_DOWNLOADS_DIR, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory());
      if (dirs.length <= DOWNLOAD_DIR_RETENTION) return;
      const withMtime = await Promise.all(
        dirs.map(async (d) => {
          const full = join(DAMOCLES_BROWSER_DOWNLOADS_DIR, d.name);
          try {
            return { full, mtime: (await fsp.stat(full)).mtimeMs };
          } catch {
            return { full, mtime: 0 };
          }
        }),
      );
      withMtime.sort((a, b) => b.mtime - a.mtime);
      const stale = withMtime.slice(DOWNLOAD_DIR_RETENTION);
      await Promise.all(stale.map((s) => fsp.rm(s.full, { recursive: true, force: true }).catch(() => {})));
    } catch (err) {
      log(`[Browser] Download-dir prune skipped — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async launchAndAdopt(launchScopeId: string, signal?: AbortSignal): Promise<void> {
    try {
      if (signal?.aborted) throw new Error('Browser open aborted');
      const headless = this.readHeadlessSetting();

      const contextPromise = launchBrowserContext({
        userDataDir: this.userDataDir!,
        headless,
        viewport: { width: this.viewport.width, height: this.viewport.height },
        deviceScaleFactor: this.viewport.dpr,
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

      // Context-level observers: the cursor + title bindings and their init scripts install once for
      // every current and future page/frame — no per-page Runtime.addBinding / createIsolatedWorld.
      await installContextObservers(context, {
        onCursor: (page, cursor) => this.onCursorBinding(page, cursor),
        onTitle: (page, title) => this.onTitleBinding(page, title),
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
      this.startWatchdog();
    } catch (err) {
      await this.teardownContext();
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
      viewport: { ...this.viewport },
      faviconToken: 0,
      ownerScopeId: owner,
      consoleCollector,
      networkCollector,
      pendingUploadPaths: null,
      resizeTimer: null,
    };
    this.pages.set(page, entry);

    // Explicit default dialog policy (decision #3): Playwright auto-dismisses dialogs by default,
    // silently changing page behavior and potentially stranding flows. Accept every dialog type
    // (alert/confirm/prompt/beforeunload) so navigation/interaction never hang.
    page.on('dialog', (dialog) => this.handleDialog(dialog));

    // Per-tab collectors: each tab records into its OWN ring buffers unconditionally (no active-page
    // gate) so a scope reads its own tab's console/network regardless of which tab the human is watching.
    // ConsoleCollector is wired but expected INERT under Patchright (Console API disabled); never fabricated.
    page.on('console', (msg) => entry.consoleCollector.record(msg.type(), msg.text()));
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
    session.on('Page.screencastFrame', (frame) => this.onScreencastFrame(entry, frame));
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

    // Download capture. acceptDownloads is set on the context (launcher), so every download resolves
    // to a Playwright Download we can persist. Save under the per-launch downloads dir with a sanitized
    // filename, then record a bounded ring-buffer entry. NEVER log file contents — only the metadata.
    page.on('download', async (download) => {
      const dir = this.downloadsDir;
      if (!dir) return;
      // Two downloads with the same suggested name must not silently overwrite each other; reserve a
      // unique path (`name (1).ext`, `name (2).ext`, ...) before saving.
      const { path: savedPath, filename } = await this.reserveDownloadPath(dir, this.sanitizeDownloadFilename(download.suggestedFilename()));
      let state: DownloadEntry['state'] = 'completed';
      try {
        await download.saveAs(savedPath);
      } catch (err) {
        state = 'failed';
        log(`[Browser] Download save failed — ${err instanceof Error ? err.message : String(err)}`);
      }
      this.downloads.push({ filename, savedPath, url: download.url(), state });
      if (this.downloads.length > DOWNLOADS_MAX) this.downloads.shift();
    });

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
    if (entry.resizeTimer) {
      clearTimeout(entry.resizeTimer);
      entry.resizeTimer = null;
    }
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
    this.resolveFavicon(entry);
  }

  private handleDialog(dialog: Dialog): void {
    // See registerPage: accept every dialog so flows never hang. Best-effort — a dialog can be
    // superseded by a navigation before we answer it, which rejects harmlessly.
    dialog.accept().catch((err) =>
      log(`[Browser] Dialog accept failed — ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  private onScreencastFrame(
    entry: PageEntry,
    frame: { data: string; metadata: { deviceWidth: number; deviceHeight: number }; sessionId: number },
  ): void {
    // Each page's frames go to its OWN panel (so a visible background/split panel still renders).
    entry.lastFrame = { data: frame.data, deviceWidth: frame.metadata.deviceWidth, deviceHeight: frame.metadata.deviceHeight };
    entry.panel.pushFrame(frame.data, frame.metadata.deviceWidth, frame.metadata.deviceHeight);
    // Health/watchdog track the single active stream only.
    const isActive = entry.page === this.activePage;
    if (isActive) {
      this.screencastHealth.noteFrame();
      this.resetWatchdogBackoff();
    }
    entry.controller.ackScreencastFrame(frame.sessionId).catch((err) => {
      log(`[Browser] Screencast frame ack failed: ${err instanceof Error ? err.message : String(err)}`);
      if (isActive) {
        this.screencastHealth.noteAckFailure();
        this.scheduleAckRestart();
      }
    });
  }

  private onCursorBinding(page: Page | undefined, cursor: string): void {
    if (!page) return;
    this.pages.get(page)?.panel.setCursor(cursor);
  }

  private onTitleBinding(page: Page | undefined, title: string): void {
    if (!page) return;
    const entry = this.pages.get(page);
    if (!entry) return;
    entry.lastTitle = title || null;
    this.applyTabIdentity(entry);
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
    panel.onCopy(() => {
      controller.evaluate(GET_SELECTED_TEXT_EXPR, true)
        .then(result => {
          const text = typeof result.value === 'string' ? result.value : '';
          if (text) vscode.env.clipboard.writeText(text);
        })
        .catch(() => {});
    });
    panel.onCut(() => {
      controller.evaluate(GET_SELECTED_TEXT_EXPR, true)
        .then(result => {
          const text = typeof result.value === 'string' ? result.value : '';
          if (!text) return;
          vscode.env.clipboard.writeText(text);
          controller.evaluate("document.execCommand('delete')", false).catch(() => {});
        })
        .catch(() => {});
    });
    panel.onKey((key, code, text, keyCode, modifiers) => {
      const vk = keyCode || 0;
      if (key === 'Enter') {
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
    // Per-tab resize debounce (each editor tab reports its own size independently). The timer lives on
    // the entry so handlePageClosed can cancel a pending resize instead of letting it fire CDP calls at
    // a controller whose page is already gone.
    panel.onResize((width, height, dpr) => {
      if (entry.resizeTimer) clearTimeout(entry.resizeTimer);
      entry.resizeTimer = setTimeout(() => {
        entry.resizeTimer = null;
        this.resizeEntry(entry, width, height, dpr).catch((err) =>
          log(`[Browser] Viewport resize failed — ${err instanceof Error ? err.message : String(err)}`),
        );
      }, 200);
    });
    panel.onMouseMove((x, y, buttons) => {
      const button = buttons & 1 ? 'left' : buttons & 2 ? 'right' : buttons & 4 ? 'middle' : 'none' as const;
      controller.dispatchMouseEvent('mouseMoved', x, y, { button, buttons }).catch(() => {});
    });
    panel.onNavigate((navUrl) => {
      controller.navigate(navUrl).catch((err) =>
        log(`[Browser] Navigate failed — ${err instanceof Error ? err.message : String(err)}`),
      );
    });
    panel.onGoBack(() => {
      controller.evaluate('history.back()').catch((err) =>
        log(`[Browser] Back failed — ${err instanceof Error ? err.message : String(err)}`),
      );
    });
    panel.onGoForward(() => {
      controller.evaluate('history.forward()').catch((err) =>
        log(`[Browser] Forward failed — ${err instanceof Error ? err.message : String(err)}`),
      );
    });
    panel.onReload(() => {
      controller.evaluate('location.reload()').catch((err) =>
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
    // Screencast follows this tab's visibility: start (and mark active) when shown, stop when hidden.
    panel.onVisibilityChange((visible) => {
      if (!visible) {
        controller.stopScreencast().catch((err) =>
          log(`[Browser] Stop screencast on hide failed: ${err instanceof Error ? err.message : String(err)}`),
        );
        return;
      }
      this.setActivePage(entry.page);
      panel.updateViewport(entry.viewport.width, entry.viewport.height);
      if (entry.lastFrame) panel.pushFrame(entry.lastFrame.data, entry.lastFrame.deviceWidth, entry.lastFrame.deviceHeight);
      this.startScreencast(entry).catch((err) =>
        log(`[Browser] Restart screencast on show failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    });
  }

  // Show a page's editor tab: adopt a restored VS Code panel when one is pending (window reload),
  // otherwise open a new editor tab in the shared browser column. Also does a belt-and-suspenders
  // screencast start in case the panel is already visible before its view-state event fires.
  private presentPanel(entry: PageEntry): void {
    const panel = entry.panel;
    const adopt = this.pendingAdoptPanel;
    this.pendingAdoptPanel = null;
    const url = entry.lastUrl ?? this.currentUrl ?? 'about:blank';
    if (adopt) {
      panel.restore(adopt);
    } else {
      panel.show(url, this.browserColumn);
      this.browserColumn = panel.viewColumn ?? this.browserColumn;
    }
    panel.updateUrl(entry.lastUrl ?? this.currentUrl ?? '');
    this.applyTabIdentity(entry);
    if (panel.visible) {
      this.setActivePage(entry.page);
      this.startScreencast(entry).catch((err) =>
        log(`[Browser] Initial screencast start failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
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
      return Number.isFinite(port) ? port : null;
    } catch {
      return null;
    }
  }

  // Sets this page's editor-tab label to its title, falling back to its URL until a title exists.
  private applyTabIdentity(entry: PageEntry): void {
    if (!entry.lastUrl) return;
    entry.panel.setTabTitle(entry.lastTitle, entry.lastUrl);
  }

  // Resolves a page's favicon and applies it to that page's OWN editor tab: candidate URLs come from a
  // page-context DOM scan, the bytes are downloaded extension side (immune to the page's CSP
  // connect-src), cached to a local file (VS Code tab icons require a file path, not a URL), and set on
  // the entry's panel. A per-entry token guards against a slow resolution from a superseded same-page
  // navigation overwriting a newer one.
  private resolveFavicon(entry: PageEntry): void {
    if (!this.iconCacheDir) return;
    const token = ++entry.faviconToken;
    entry.controller.evaluate(GET_FAVICON_CANDIDATES_EXPR, true)
      .then(async (result) => {
        if (token !== entry.faviconToken) return;
        const raw = typeof result.value === 'string' ? result.value : '[]';
        let candidates: string[];
        try {
          const parsed = JSON.parse(raw) as unknown;
          candidates = Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
        } catch {
          candidates = [];
        }
        for (const href of candidates) {
          if (token !== entry.faviconToken) return;
          const icon = await this.downloadFavicon(href);
          if (!icon) continue;
          const name = createHash('sha1').update(icon.bytes).digest('hex').slice(0, 16);
          const filePath = join(this.iconCacheDir!, `${name}.${icon.ext}`);
          try {
            await fsp.writeFile(filePath, icon.bytes);
          } catch (err) {
            log(`[Browser] Favicon cache write failed — ${err instanceof Error ? err.message : String(err)}`);
            return;
          }
          this.pruneIconCache();
          if (token !== entry.faviconToken) return;
          entry.panel.setIcon(vscode.Uri.file(filePath));
          return;
        }
        if (token === entry.faviconToken) entry.panel.setIcon(undefined);
      })
      .catch(() => { /* page closed or eval blocked; keep the previous icon */ });
  }

  // Downloads one favicon candidate from the extension host. Returns null on any failure so the
  // caller can try the next candidate. Sniffs ICO/PNG signatures when the server omits or mislabels
  // the content type (common for /favicon.ico served as application/octet-stream or text/plain).
  private async downloadFavicon(href: string): Promise<{ bytes: Buffer; ext: string } | null> {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // SSRF guard: the candidate URLs come from an untrusted page's DOM, so refuse hosts that resolve
    // to loopback/link-local/private ranges before issuing the extension-host GET. `redirect: 'error'`
    // closes the redirect bypass — only the validated host is ever contacted, so a 3xx to
    // 169.254.169.254/localhost can't slip past the guard. A favicon served via redirect just won't show.
    if (await isBlockedFaviconHost(url.hostname)) return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(url, { signal: controller.signal, redirect: 'error' }).finally(() => clearTimeout(timer));
      if (!res.ok) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0 || bytes.length > FAVICON_MAX_BYTES) return null;
      const declaredType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      let ext = FAVICON_EXTENSIONS[declaredType];
      if (!ext) {
        if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) ext = 'png';
        else if (bytes.length >= 4 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1) ext = 'ico';
        else if (bytes.length >= 5 && bytes.toString('ascii', 0, 5).toLowerCase() === '<svg ') ext = 'svg';
        else return null;
      }
      return { bytes, ext };
    } catch {
      return null;
    }
  }

  // Content-addressed favicon files accumulate one per distinct icon across every site visited. Cap
  // the directory at a bounded size, deleting the oldest files by mtime. Best-effort: cache-only data,
  // so any IO error is swallowed.
  private pruneIconCache(): void {
    const dir = this.iconCacheDir;
    if (!dir) return;
    void (async () => {
      try {
        const names = await fsp.readdir(dir);
        if (names.length <= FAVICON_CACHE_MAX_FILES) return;
        const stats = await Promise.all(
          names.map(async (name) => {
            const full = join(dir, name);
            const st = await fsp.stat(full);
            return { full, mtime: st.mtimeMs };
          }),
        );
        stats.sort((a, b) => a.mtime - b.mtime);
        const toDelete = stats.slice(0, stats.length - FAVICON_CACHE_MAX_FILES);
        await Promise.all(toDelete.map((f) => fsp.rm(f.full, { force: true })));
      } catch (err) {
        log(`[Browser] Favicon cache prune failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }

  private screencastOptions(entry: PageEntry) {
    return {
      format: 'jpeg' as const,
      quality: 80,
      everyNthFrame: 1,
      maxWidth: Math.round(entry.viewport.width * entry.viewport.dpr),
      maxHeight: Math.round(entry.viewport.height * entry.viewport.dpr),
    };
  }

  private async startScreencast(entry: PageEntry): Promise<void> {
    // Arm the zero-frame stall detector BEFORE the CDP call, but only for the active stream (the one
    // the watchdog monitors). If the send itself rejects (or times out), the watchdog still sees a
    // start with no frames and retries; noting the start only on success would leave a failed start
    // invisible and freeze the panel forever.
    if (entry.page === this.activePage) this.screencastHealth.noteStart();
    try {
      await entry.controller.startScreencast(this.screencastOptions(entry));
    } catch (err) {
      log(`[Browser] Failed to start screencast — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // A burst of ack failures collapses into a single screencast restart. The debounce timer coalesces
  // repeated failures so Chromium is not hammered with concurrent restart calls while the stream is
  // already being rebuilt.
  private scheduleAckRestart(): void {
    if (this.ackRestartTimer) return;
    this.ackRestartTimer = setTimeout(() => {
      this.ackRestartTimer = null;
      const active = this.getActiveEntry();
      if (active && active.panel.visible) {
        this.startScreencast(active).catch((err) =>
          log(`[Browser] Ack triggered screencast restart failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }, 500);
  }

  // Resize a single page to its own editor tab's size (panels can differ under split view). Restarts
  // that page's screencast at the new size if the panel is visible.
  private async resizeEntry(entry: PageEntry, width: number, height: number, dpr: number): Promise<void> {
    entry.viewport = { width, height, dpr: Math.min(dpr, 2) };
    // Track the most-recent size as the default for the next launch / new tab.
    this.viewport = { ...entry.viewport };
    try {
      await entry.controller.setViewport(width, height, entry.viewport.dpr);
    } catch (err) {
      log(`[Browser] Viewport set failed — ${err instanceof Error ? err.message : String(err)}`);
    }
    entry.panel.updateViewport(width, height);
    // Guard the stop: a rejected stopScreencast (e.g. the CDP send timed out) must not skip the
    // restart, or the panel would be left with a stale-sized stream and no recovery.
    await entry.controller.stopScreencast().catch((err) =>
      log(`[Browser] Stop screencast on resize failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    if (entry.panel.visible) await this.startScreencast(entry);
  }

  // Polls screencast health every 5s and restarts a stalled stream. A wedged Chromium can fail every
  // restart; capped exponential backoff (5s→10s→20s→40s→max 60s) stops hammering it while still
  // recovering promptly from a transient stall. The streak is NOT cleared just because a tick sees a
  // healthy start window (each restart resets the stall clock, which would falsely look healthy for a
  // tick or two); only a frame actually arriving (resetWatchdogBackoff, called from the frame handler)
  // proves recovery and clears the backoff.
  private startWatchdog(): void {
    this.clearWatchdog();
    this.watchdogTimer = setInterval(() => {
      const active = this.getActiveEntry();
      if (!active) return;
      if (!this.screencastHealth.shouldRestart(Date.now(), active.panel.visible, this.isConnected())) return;
      if (Date.now() < this.watchdogBackoffUntil) return;
      const backoffMs = Math.min(5_000 * 2 ** this.watchdogFailureStreak, 60_000);
      this.watchdogBackoffUntil = Date.now() + backoffMs;
      this.watchdogFailureStreak++;
      this.startScreencast(active).catch((err) =>
        log(`[Browser] Watchdog screencast restart failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }, 5_000);
  }

  private resetWatchdogBackoff(): void {
    this.watchdogFailureStreak = 0;
    this.watchdogBackoffUntil = 0;
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.watchdogFailureStreak = 0;
    this.watchdogBackoffUntil = 0;
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
    // Drop intercept rules synchronously: they are routes on the now-dead context and must not linger
    // in listInterceptRules() as phantoms even before the async teardown settles.
    this.interceptRules = [];
    this.close().catch((err) =>
      log(`[Browser] Cleanup after context loss failed — ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  // Intentionally closes the Playwright context (which terminates Chrome). Marked `closing` first so
  // the context 'close' event handler treats it as an intentional teardown, not a crash to recover from.
  // Disposes every page's editor tab so no orphaned browser tabs linger.
  private async teardownContext(): Promise<void> {
    this.closing = true;
    for (const entry of this.pages.values()) {
      if (entry.resizeTimer) clearTimeout(entry.resizeTimer);
      entry.picker.stopPicking().catch(() => {});
      entry.panel.dispose();
    }
    const ctx = this.context;
    this.context = null;
    this.pages.clear();
    this.activePage = null;
    if (ctx) {
      try {
        await ctx.close();
      } catch (err) {
        log(`[Browser] Context close failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private cleanup(): void {
    this.clearInterceptRules();
    this.clearWatchdog();
    if (this.ackRestartTimer) {
      clearTimeout(this.ackRestartTimer);
      this.ackRestartTimer = null;
    }
    // teardownContext already disposed the panels and cleared pages; this loop is a safety net for any
    // direct cleanup() path (dispose without a prior teardown).
    for (const entry of this.pages.values()) {
      if (entry.resizeTimer) clearTimeout(entry.resizeTimer);
      entry.picker.stopPicking().catch(() => {});
      entry.panel.dispose();
    }
    this.pages.clear();
    this.activePage = null;
    // Collectors + upload staging are per-tab now (disposed with their entries) — nothing service-level
    // to clear. Reset the scope registry to a fresh primary-only map; orphaned subagent scopes (no live
    // tabs after teardown) drop out, and a scope's tool closure self-heals via scopeState on next use.
    this.scopes = new Map<string, { currentPage: Page | null }>([
      [BrowserService.PRIMARY_SCOPE_ID, { currentPage: null }],
    ]);
    this.launchOwnerScopeId = null;
    this.cleanUserAgent = null;
    this.state = 'disconnected';
    this.currentUrl = null;
    this.browserColumn = undefined;
    this.pendingAdoptPanel = null;
    this.restoreClaimed = false;
    this.userDataDir = null;
    this.iconCacheDir = null;
    this.downloads = [];
    this.takenDownloadPaths.clear();
    this.downloadsDir = null;
    this.closing = false;
  }

  dispose(): void {
    this.closing = true;
    for (const entry of this.pages.values()) entry.panel.dispose();
    // Fire-and-forget the context close; cleanup() runs synchronously so the service is immediately
    // reusable. A pending close settles harmlessly in the background.
    if (this.context) {
      const ctx = this.context;
      this.context = null;
      ctx.close().catch(() => {});
    }
    this.cleanup();
  }
}
