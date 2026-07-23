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
import { log } from '../logger';
import { DAMOCLES_BROWSER_DOWNLOADS_DIR } from '../paths';
import type { BrowserSessionState, InterceptRule, RedactedInterceptRule } from './types';
import type { ElementAttachment, ConsoleEntry, NetworkError, DownloadEntry } from '../../shared/types/browser';

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

/** Per-page state: the Playwright page, its leak-free CDP session, the PageController facade, picker. */
interface PageEntry {
  page: Page;
  session: CDPSession;
  controller: PageController;
  picker: ElementPicker;
  lastUrl: string | null;
  lastTitle: string | null;
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
 * matching init scripts. Extracted so the exact same install path is shared by `launchAndConnect` and
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
  private state: BrowserSessionState = 'disconnected';
  private currentUrl: string | null = null;
  private context: BrowserContext | null = null;
  private activePage: Page | null = null;
  private pages = new Map<Page, PageEntry>();
  // In-flight page registrations keyed by Page. A single popup can surface via BOTH context.on('page')
  // and page.on('popup'), and an explicit openNewTab races context.on('page') for its own page; sharing
  // one registration promise per page keeps registerPage idempotent (one CDPSession, one listener set).
  private pendingRegistrations = new Map<Page, Promise<PageEntry | null>>();
  // Pages whose one-time activation decision has already been made, so the two new-page events above
  // cannot double-activate (double screencast start / focus toggle) for the same page.
  private newPagesActivated = new WeakSet<Page>();
  private userDataDir: string | null = null;
  private browserPanel: BrowserPanel | null = null;
  private consoleCollector = new ConsoleCollector();
  private networkCollector = new NetworkCollector();
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private broadcastToChat: ((element: ElementAttachment) => void) | null = null;
  private cleanUserAgent: string | null = null;
  private viewport: { width: number; height: number; dpr: number } = { width: 1920, height: 1080, dpr: 1 };
  private lastFrame: { data: string; deviceWidth: number; deviceHeight: number } | null = null;
  private screencastHealth = new ScreencastHealth();
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogFailureStreak = 0;
  private watchdogBackoffUntil = 0;
  private ackRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private iconCacheDir: string | null = null;
  private faviconToken = 0;
  private openChain: Promise<void> = Promise.resolve();
  private closing = false;
  // Files to feed a native file chooser the next time one opens (staged by BrowserUpload). Single-shot:
  // the filechooser handler clears it after use. null = nothing staged.
  private pendingUploadPaths: string[] | null = null;
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

  getConsoleMessages(): ConsoleEntry[] {
    return this.consoleCollector.getMessages();
  }

  getNetworkErrors(): NetworkError[] {
    return this.networkCollector.getErrors();
  }

  /** Snapshot of the open tabs in registration order (index 0-based). Sync — reads tracked title/url. */
  listTabs(): { index: number; title: string; url: string; active: boolean }[] {
    let index = 0;
    const tabs: { index: number; title: string; url: string; active: boolean }[] = [];
    for (const entry of this.pages.values()) {
      tabs.push({
        index: index++,
        title: entry.lastTitle ?? '',
        url: entry.lastUrl ?? entry.page.url(),
        active: entry.page === this.activePage,
      });
    }
    return tabs;
  }

  /** Switch the active tab by index. Reuses setActivePage so screencast/collectors/observers re-bind. */
  async selectTab(index: number): Promise<void> {
    const page = [...this.pages.keys()][index];
    if (!page) {
      throw new Error(`Tab index ${index} out of range (${this.pages.size} tab(s) open)`);
    }
    await this.setActivePage(page);
  }

  /** Close a tab by index. handlePageClosed falls back to the most-recent remaining tab. */
  async closeTab(index: number): Promise<void> {
    const page = [...this.pages.keys()][index];
    if (!page) {
      throw new Error(`Tab index ${index} out of range (${this.pages.size} tab(s) open)`);
    }
    // Refuse to close the last tab: doing so would leave the session with no page (and no live
    // screencast) while still "connected". The agent ends the session via BrowserClose instead.
    if (this.pages.size === 1) {
      throw new Error('Cannot close the last remaining tab — use BrowserClose to end the session.');
    }
    await page.close();
  }

  /**
   * Open a new tab, register it, make it active, and optionally navigate it. This is the deterministic
   * way for the agent to open a tab, independent of whether a page spontaneously spawns a popup.
   * context.newPage() also fires context.on('page'); registration is idempotent so the tab is set up
   * exactly once. A context.newPage() has no opener, so handleNewPage will not auto-focus it — this
   * method owns the activation.
   */
  async openNewTab(url?: string): Promise<void> {
    if (!this.context) {
      throw new Error('Browser is not connected. Use browser_open first.');
    }
    const page = await this.context.newPage();
    const entry = await this.registerPage(page);
    if (!entry) throw new Error('Failed to initialise the new tab.');
    await this.setActivePage(page);
    if (url) {
      await entry.controller.navigate(url);
      this.currentUrl = url;
    }
  }

  /** Stage (or clear with null) the files a subsequent native file chooser should receive. */
  stagePendingUpload(paths: string[] | null): void {
    this.pendingUploadPaths = paths;
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
  // name gets `name (1).ext`, `name (2).ext`, ... — never a silent overwrite. Reservation is synchronous
  // (in-memory Set) so concurrent downloads can't race onto the same name; the Set is cleared on cleanup.
  private async reserveDownloadPath(dir: string, filename: string): Promise<{ path: string; filename: string }> {
    const dot = filename.lastIndexOf('.');
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : '';
    for (let i = 0; ; i++) {
      const name = i === 0 ? filename : `${base} (${i})${ext}`;
      const full = join(dir, name);
      if (this.takenDownloadPaths.has(full)) continue;
      try {
        await fsp.access(full);
        continue; // exists on disk — try the next suffix
      } catch {
        // free
      }
      this.takenDownloadPaths.add(full);
      return { path: full, filename: name };
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

  // Serializes concurrent open() calls (double Enter, or Reload during a browser_open tool call).
  // Without this, a second open() would tear down the first launch's Chrome while the first launch's
  // catch disposes the panel/currentUrl the second is already using. Each call queues behind the
  // previous one, so by the time it runs the earlier launch is fully settled.
  async open(url: string, signal?: AbortSignal): Promise<void> {
    const run = this.openChain.then(() => this.openInternal(url, signal));
    this.openChain = run.then(() => {}, () => {});
    return run;
  }

  private async openInternal(url: string, signal?: AbortSignal): Promise<void> {
    const active = this.getActiveEntry();
    if (this.state === 'connected' && active) {
      await active.controller.navigate(url);
      this.currentUrl = url;
      this.showBrowserPanel(url);
      return;
    }

    if (this.context) {
      await this.close();
    }

    // Only a panel this call creates may be torn down on failure. A panel already present belongs to
    // the disconnected-recovery UI (kept alive by handleContextGone); disposing it would make a second
    // Reload impossible, so leave it — and its currentUrl — intact so the user can retry.
    const createdPanel = !this.browserPanel;
    this.currentUrl = url;
    await this.ensureUserDataDir();
    this.showBrowserPanel(url);

    try {
      await this.launchAndConnect(url, signal);
    } catch (err) {
      if (createdPanel) {
        this.browserPanel?.dispose();
        this.browserPanel = null;
        this.currentUrl = null;
      }
      throw err;
    }
  }

  async restorePanel(panel: vscode.WebviewPanel, url: string): Promise<void> {
    this.currentUrl = url;
    await this.ensureUserDataDir();
    this.showBrowserPanel(url, panel);

    try {
      await this.launchAndConnect(url);
    } catch (err) {
      log(`[Browser] Failed to restore browser session — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async waitForCdp(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (this.isConnected()) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) return false;
      await new Promise<void>(r => setTimeout(r, 200));
      if (this.isConnected()) return true;
    }
    return false;
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

  private async launchAndConnect(url: string, signal?: AbortSignal): Promise<void> {
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

      const initial = context.pages()[0] ?? await context.newPage();
      const entry = await this.registerPage(initial);
      if (!entry) throw new Error('Failed to initialise the first browser page');
      await this.setActivePage(initial);

      // UA scrub (#6): branded system Chrome (channel:'chrome') reports a normal Chrome UA even under
      // new headless, so this is a no-op safety net; it only rewrites if HeadlessChrome survives (e.g.
      // an Edge/bundled fallback). Done before navigation so the first request carries the clean UA.
      await this.maybeScrubUserAgent(entry);

      await this.raceAbort(entry.controller.navigate(url), signal);
      this.currentUrl = url;
      this.state = 'connected';
      this.startWatchdog();
    } catch (err) {
      await this.teardownContext();
      this.state = 'disconnected';
      // currentUrl is intentionally preserved: the caller (openInternal / restorePanel) decides
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
  private registerPage(page: Page): Promise<PageEntry | null> {
    const existing = this.pages.get(page);
    if (existing) return Promise.resolve(existing);
    const inflight = this.pendingRegistrations.get(page);
    if (inflight) return inflight;
    const registration = this.doRegisterPage(page).finally(() => this.pendingRegistrations.delete(page));
    this.pendingRegistrations.set(page, registration);
    return registration;
  }

  private async doRegisterPage(page: Page): Promise<PageEntry | null> {
    if (!this.context) return null;

    let session: CDPSession;
    try {
      session = await this.context.newCDPSession(page);
    } catch (err) {
      log(`[Browser] newCDPSession failed — ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    const controller = new PageController(page, session);
    const picker = new ElementPicker(controller, this.consoleCollector, this.networkCollector);
    const entry: PageEntry = {
      page,
      session,
      controller,
      picker,
      lastUrl: page.url() || null,
      lastTitle: null,
    };
    this.pages.set(page, entry);

    // Explicit default dialog policy (decision #3): Playwright auto-dismisses dialogs by default,
    // silently changing page behavior and potentially stranding flows. Accept every dialog type
    // (alert/confirm/prompt/beforeunload) so navigation/interaction never hang.
    page.on('dialog', (dialog) => this.handleDialog(dialog));

    // Collectors. Only the active page feeds the ring buffers (matches the old active-session filter).
    // ConsoleCollector is wired but expected INERT under Patchright (Console API disabled); never fabricated.
    page.on('console', (msg) => {
      if (this.activePage === page) this.consoleCollector.record(msg.type(), msg.text());
    });
    page.on('response', (res) => {
      if (this.activePage !== page) return;
      const status = res.status();
      if (status >= 400) this.networkCollector.recordResponse(res.url(), status, res.statusText());
    });
    page.on('requestfailed', (req) => {
      if (this.activePage !== page) return;
      this.networkCollector.recordRequestFailed(req.url(), req.failure()?.errorText ?? 'failed');
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
      const staged = this.pendingUploadPaths;
      this.pendingUploadPaths = null;
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

    return entry;
  }

  private async handleNewPage(page: Page): Promise<void> {
    const entry = await this.registerPage(page);
    if (!entry) return;
    // Activate at most once per page. Both context.on('page') and page.on('popup') can fire for the
    // same popup; the WeakSet is marked SYNCHRONOUSLY (single-threaded) before the next await, so the
    // second handler observes it and skips — no double screencast start, no focus toggle race.
    if (this.newPagesActivated.has(page)) return;
    this.newPagesActivated.add(page);
    // Focus a popup opened by the current active page, or any page when nothing is active yet. A page
    // from an explicit openNewTab has no opener, so it is not stolen here — openNewTab activates it.
    const opener = await page.opener().catch(() => null);
    if (this.activePage === null || opener === this.activePage) {
      await this.setActivePage(page);
    }
  }

  private async setActivePage(page: Page): Promise<void> {
    const prev = this.activePage;
    if (prev && prev !== page) {
      const prevEntry = this.pages.get(prev);
      await prevEntry?.controller.stopScreencast().catch(() => {});
      this.lastFrame = null;
    }
    this.activePage = page;
    const entry = this.pages.get(page);
    if (!entry) return;

    if (entry.lastUrl) {
      this.currentUrl = entry.lastUrl;
      this.applyTabIdentity(entry);
      this.browserPanel?.updateUrl(entry.lastUrl);
    }
    this.resolveFavicon(entry);

    if (this.browserPanel?.visible) await this.startScreencast(entry.controller);
  }

  private handlePageClosed(page: Page): void {
    const entry = this.pages.get(page);
    if (!entry) return;
    this.pages.delete(page);
    entry.picker.stopPicking().catch(() => {});

    if (this.activePage !== page) return;
    this.activePage = null;
    this.lastFrame = null;

    // Fall back to the most-recently-registered surviving page.
    const remaining = [...this.pages.keys()];
    const next = remaining[remaining.length - 1];
    if (next) {
      this.setActivePage(next).catch((err) =>
        log(`[Browser] Reactivate page failed — ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }

  private onMainFrameNavigated(entry: PageEntry, url: string): void {
    entry.lastUrl = url;
    // A main-frame navigation invalidates the old title and favicon; clear the title so the URL shows
    // until the title binding reports the new one, and refetch the favicon.
    entry.lastTitle = null;
    if (entry.page === this.activePage) {
      this.currentUrl = url;
      this.applyTabIdentity(entry);
      this.browserPanel?.updateUrl(url);
    }
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
    const isActive = entry.page === this.activePage;
    if (isActive) {
      this.lastFrame = { data: frame.data, deviceWidth: frame.metadata.deviceWidth, deviceHeight: frame.metadata.deviceHeight };
      this.screencastHealth.noteFrame();
      this.resetWatchdogBackoff();
      this.browserPanel?.pushFrame(frame.data, frame.metadata.deviceWidth, frame.metadata.deviceHeight);
    }
    entry.controller.ackScreencastFrame(frame.sessionId).catch((err) => {
      log(`[Browser] Screencast frame ack failed: ${err instanceof Error ? err.message : String(err)}`);
      // Only the active stream drives the panel; a background page's ack failure must not restart the
      // healthy active stream.
      if (isActive) {
        this.screencastHealth.noteAckFailure();
        this.scheduleAckRestart();
      }
    });
  }

  private onCursorBinding(page: Page | undefined, cursor: string): void {
    if (page && page === this.activePage) this.browserPanel?.setCursor(cursor);
  }

  private onTitleBinding(page: Page | undefined, title: string): void {
    if (!page) return;
    const entry = this.pages.get(page);
    if (!entry) return;
    entry.lastTitle = title || null;
    if (page === this.activePage) this.applyTabIdentity(entry);
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

  private showBrowserPanel(url: string, existingPanel?: vscode.WebviewPanel): void {
    if (!this.browserPanel) {
      this.browserPanel = new BrowserPanel();
      this.browserPanel.onClose(() => {
        this.close().catch(err =>
          log(`[Browser] Close failed — ${err instanceof Error ? err.message : String(err)}`),
        );
      });
      this.browserPanel.onMouseDown((x, y, button, buttons, clickCount, modifiers) => {
        const active = this.getActiveEntry();
        if (!active) return;
        if (active.picker.isPicking) {
          active.controller.getNodeForLocation(x, y)
            .then(result => active.picker.handleInspectNodeRequested(result.backendNodeId))
            .catch(err => log(`[Browser] Pick click failed — ${err instanceof Error ? err.message : String(err)}`));
          return;
        }
        active.controller.dispatchMouseEvent('mousePressed', x, y, {
          button: jsButtonToCdp(button),
          clickCount,
          buttons,
          modifiers,
        }).catch(err => log(`[Browser] Mouse down failed — ${err instanceof Error ? err.message : String(err)}`));
      });
      this.browserPanel.onMouseUp((x, y, button, buttons, clickCount, modifiers) => {
        const active = this.getActiveEntry();
        if (!active || active.picker.isPicking) return;
        active.controller.dispatchMouseEvent('mouseReleased', x, y, {
          button: jsButtonToCdp(button),
          clickCount,
          buttons,
          modifiers,
        }).catch(err => log(`[Browser] Mouse up failed — ${err instanceof Error ? err.message : String(err)}`));
      });
      this.browserPanel.onPaste((text) => {
        const cdp = this.getCdp();
        if (!cdp) return;
        cdp.insertText(text).catch(err =>
          log(`[Browser] Paste failed — ${err instanceof Error ? err.message : String(err)}`),
        );
      });
      this.browserPanel.onCopy(() => {
        const cdp = this.getCdp();
        if (!cdp) return;
        cdp.evaluate(GET_SELECTED_TEXT_EXPR, true)
          .then(result => {
            const text = typeof result.value === 'string' ? result.value : '';
            if (text) vscode.env.clipboard.writeText(text);
          })
          .catch(() => {});
      });
      this.browserPanel.onCut(() => {
        const cdp = this.getCdp();
        if (!cdp) return;
        cdp.evaluate(GET_SELECTED_TEXT_EXPR, true)
          .then(result => {
            const text = typeof result.value === 'string' ? result.value : '';
            if (!text) return;
            vscode.env.clipboard.writeText(text);
            cdp.evaluate("document.execCommand('delete')", false).catch(() => {});
          })
          .catch(() => {});
      });
      this.browserPanel.onKey((key, code, text, keyCode, modifiers) => {
        const cdp = this.getCdp();
        if (!cdp) return;
        const vk = keyCode || 0;
        if (key === 'Enter') {
          // Enter must carry text '\r' on keyDown (Puppeteer behavior) so it commits in inputs.
          cdp.dispatchKeyEvent('keyDown', { key, code, text: '\r', modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }).then(() =>
            cdp.dispatchKeyEvent('keyUp', { key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }),
          ).catch(() => {});
        } else if (text) {
          cdp.dispatchKeyEvent('keyDown', { key, code, text, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }).then(() =>
            cdp.dispatchKeyEvent('keyUp', { key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }),
          ).catch(() => {});
        } else {
          cdp.dispatchKeyEvent('rawKeyDown', { key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }).then(() =>
            cdp.dispatchKeyEvent('keyUp', { key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }),
          ).catch(() => {});
        }
      });
      this.browserPanel.onScroll((x, y, deltaX, deltaY) => {
        const cdp = this.getCdp();
        if (!cdp) return;
        cdp.dispatchWheelEvent(x, y, deltaX, deltaY).catch(() => {});
      });
      this.browserPanel.onResize((width, height, dpr) => {
        if (this.resizeTimer) clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => {
          this.resizeViewport(width, height, dpr).catch((err) =>
            log(`[Browser] Viewport resize failed — ${err instanceof Error ? err.message : String(err)}`),
          );
        }, 200);
      });
      this.browserPanel.onMouseMove((x, y, buttons) => {
        const cdp = this.getCdp();
        if (!cdp) return;
        const button = buttons & 1 ? 'left' : buttons & 2 ? 'right' : buttons & 4 ? 'middle' : 'none' as const;
        cdp.dispatchMouseEvent('mouseMoved', x, y, { button, buttons }).catch(() => {});
      });
      this.browserPanel.onNavigate((navUrl) => {
        const cdp = this.getCdp();
        if (!cdp) {
          if (navUrl) {
            this.open(navUrl)
              .then(() => this.browserPanel?.setConnectionState(true))
              .catch((err) => log(`[Browser] Navigate relaunch failed: ${err instanceof Error ? err.message : String(err)}`));
          }
          return;
        }
        cdp.navigate(navUrl).catch((err) =>
          log(`[Browser] Navigate failed — ${err instanceof Error ? err.message : String(err)}`),
        );
      });
      this.browserPanel.onGoBack(() => {
        const cdp = this.getCdp();
        if (!cdp) return;
        cdp.evaluate('history.back()').catch((err) =>
          log(`[Browser] Back failed — ${err instanceof Error ? err.message : String(err)}`),
        );
      });
      this.browserPanel.onGoForward(() => {
        const cdp = this.getCdp();
        if (!cdp) return;
        cdp.evaluate('history.forward()').catch((err) =>
          log(`[Browser] Forward failed — ${err instanceof Error ? err.message : String(err)}`),
        );
      });
      this.browserPanel.onReload(() => {
        const cdp = this.getCdp();
        if (!cdp) {
          if (this.currentUrl) {
            this.open(this.currentUrl)
              .then(() => this.browserPanel?.setConnectionState(true))
              .catch((err) => log(`[Browser] Reload relaunch failed: ${err instanceof Error ? err.message : String(err)}`));
          }
          return;
        }
        cdp.evaluate('location.reload()').catch((err) =>
          log(`[Browser] Reload failed — ${err instanceof Error ? err.message : String(err)}`),
        );
      });
      this.browserPanel.onPickElement(() => {
        const active = this.getActiveEntry();
        if (!active || active.picker.isPicking) return;
        this.browserPanel?.setPickingState(true);
        active.picker.startPicking()
          .then((attachment) => {
            this.browserPanel?.setPickingState(false);
            this.browserPanel?.showElementInfo({
              selector: attachment.selector,
              tagName: attachment.tagName,
              boundingBox: attachment.boundingBox,
              padding: attachment.computedStyles['padding'] ?? '',
            });
            this.broadcastToChat?.(attachment);
          })
          .catch((err) => {
            this.browserPanel?.setPickingState(false);
            log(`[Browser] Toolbar pick failed — ${err instanceof Error ? err.message : String(err)}`);
          });
      });
      this.browserPanel.onOpenDevTools(() => {
        this.toggleDevTools();
      });
      this.browserPanel.onVisibilityChange((visible) => {
        if (!visible) {
          this.getActiveEntry()?.controller.stopScreencast().catch((err) =>
            log(`[Browser] Stop screencast on hide failed: ${err instanceof Error ? err.message : String(err)}`),
          );
          return;
        }
        this.browserPanel?.updateViewport(this.viewport.width, this.viewport.height);
        if (this.lastFrame) {
          this.browserPanel?.pushFrame(this.lastFrame.data, this.lastFrame.deviceWidth, this.lastFrame.deviceHeight);
        }
        const active = this.getActiveEntry();
        if (active) {
          this.startScreencast(active.controller).catch((err) =>
            log(`[Browser] Restart screencast on show failed: ${err instanceof Error ? err.message : String(err)}`),
          );
        }
      });
    }

    if (existingPanel) {
      this.browserPanel.restore(existingPanel);
    } else {
      this.browserPanel.show(url);
    }
    this.browserPanel.updateUrl(url);
  }

  toggleDevTools(): void {
    this.openDevToolsInBrowserView().catch(err =>
      log(`[Browser] DevTools failed — ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  // Chrome is launched with --remote-debugging-port=0, so it writes the chosen port to the
  // DevToolsActivePort file in the user-data-dir (line 1 = port). Playwright drives its own connection
  // over a pipe, so the port coexists and the external DevTools can attach to the same targets. We read
  // the port from that file (no child_process stderr parse), find the active page's target, and open
  // the localhost DevTools URL — no detach/reattach dance, which is unnecessary now Playwright owns the
  // persistent connection.
  private async openDevToolsInBrowserView(): Promise<void> {
    const active = this.getActiveEntry();
    if (!active) {
      log('[Browser] Cannot open DevTools — no active page');
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
      const currentUrl = active.page.url();
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

  // Sets the panel tab label to the active page's title, falling back to its URL until a title exists.
  private applyTabIdentity(entry: PageEntry): void {
    if (!entry.lastUrl) return;
    this.browserPanel?.setTabTitle(entry.lastTitle, entry.lastUrl);
  }

  // Resolves the active page's favicon: candidate URLs come from a page-context DOM scan, the bytes
  // are downloaded extension side (immune to the page's CSP connect-src), cached to a local file
  // (VS Code tab icons require a file path, not a URL), and applied. A monotonic token guards against
  // a slow resolution from a prior page overwriting the icon of a newer navigation.
  private resolveFavicon(entry: PageEntry): void {
    if (entry.page !== this.activePage || !this.iconCacheDir) return;
    const token = ++this.faviconToken;
    entry.controller.evaluate(GET_FAVICON_CANDIDATES_EXPR, true)
      .then(async (result) => {
        if (token !== this.faviconToken) return;
        const raw = typeof result.value === 'string' ? result.value : '[]';
        let candidates: string[];
        try {
          const parsed = JSON.parse(raw) as unknown;
          candidates = Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
        } catch {
          candidates = [];
        }
        for (const href of candidates) {
          if (token !== this.faviconToken) return;
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
          if (token !== this.faviconToken) return;
          this.browserPanel?.setIcon(vscode.Uri.file(filePath));
          return;
        }
        if (token === this.faviconToken) this.browserPanel?.setIcon(undefined);
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

  private screencastOptions() {
    return {
      format: 'jpeg' as const,
      quality: 80,
      everyNthFrame: 1,
      maxWidth: Math.round(this.viewport.width * this.viewport.dpr),
      maxHeight: Math.round(this.viewport.height * this.viewport.dpr),
    };
  }

  private async startScreencast(controller: PageController): Promise<void> {
    // Arm the zero-frame stall detector BEFORE the CDP call. If the send itself rejects (or times
    // out), the watchdog still sees a start with no frames and retries; noting the start only on
    // success would leave a failed start invisible and freeze the panel forever.
    this.screencastHealth.noteStart();
    try {
      await controller.startScreencast(this.screencastOptions());
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
      if (active && this.browserPanel?.visible) {
        this.startScreencast(active.controller).catch((err) =>
          log(`[Browser] Ack triggered screencast restart failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }, 500);
  }

  private async resizeViewport(width: number, height: number, dpr: number): Promise<void> {
    this.viewport = { width, height, dpr: Math.min(dpr, 2) };
    const active = this.getActiveEntry();
    if (!active) return;
    for (const entry of this.pages.values()) {
      try {
        await entry.controller.setViewport(width, height, this.viewport.dpr);
      } catch (err) {
        log(`[Browser] Viewport propagate failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.browserPanel?.updateViewport(width, height);
    // Guard the stop: a rejected stopScreencast (e.g. the CDP send timed out) must not skip the
    // restart, or the panel would be left with a stale-sized stream and no recovery.
    await active.controller.stopScreencast().catch((err) =>
      log(`[Browser] Stop screencast on resize failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    if (this.browserPanel?.visible) await this.startScreencast(active.controller);
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
      if (!this.screencastHealth.shouldRestart(Date.now(), this.browserPanel?.visible ?? false, this.isConnected())) return;
      if (Date.now() < this.watchdogBackoffUntil) return;
      const backoffMs = Math.min(5_000 * 2 ** this.watchdogFailureStreak, 60_000);
      this.watchdogBackoffUntil = Date.now() + backoffMs;
      this.watchdogFailureStreak++;
      this.startScreencast(active.controller).catch((err) =>
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

  // The persistent context closed on its own (Chrome crashed or was killed externally). When a panel
  // is open we keep it alive to show the disconnected placeholder and preserve currentUrl so Reload can
  // relaunch, tearing down only the live resources here. With no panel there is nothing to recover
  // into, so we fully clean up.
  private handleContextGone(context: BrowserContext): void {
    // Only the LIVE context triggers crash recovery. A superseded context (torn down, or replaced by a
    // relaunch) firing 'close' must not be misrouted into recovery even if `closing` was already reset
    // by the next launch — every intentional teardown nulls/replaces `this.context` before closing.
    if (this.context !== context) return;
    if (this.closing) return;
    if (!this.browserPanel) {
      this.cleanup();
      return;
    }
    this.browserPanel.setConnectionState(false);
    this.clearWatchdog();
    if (this.ackRestartTimer) {
      clearTimeout(this.ackRestartTimer);
      this.ackRestartTimer = null;
    }
    for (const entry of this.pages.values()) entry.picker.stopPicking().catch(() => {});
    this.pages.clear();
    this.activePage = null;
    this.lastFrame = null;
    this.context = null;
    // Intercept rules are routes on the now-dead context; drop them so listInterceptRules() does not
    // report phantom rules that no longer intercept and are never re-applied to the relaunched context.
    this.interceptRules = [];
    this.state = 'disconnected';
  }

  // Intentionally closes the Playwright context (which terminates Chrome). Marked `closing` first so
  // the context 'close' event handler treats it as an intentional teardown, not a crash to recover from.
  private async teardownContext(): Promise<void> {
    this.closing = true;
    for (const entry of this.pages.values()) entry.picker.stopPicking().catch(() => {});
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
    this.lastFrame = null;
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    for (const entry of this.pages.values()) entry.picker.stopPicking().catch(() => {});
    this.pages.clear();
    this.activePage = null;
    this.cleanUserAgent = null;
    this.consoleCollector.clear();
    this.networkCollector.clear();
    this.state = 'disconnected';
    this.currentUrl = null;
    this.browserPanel?.dispose();
    this.browserPanel = null;
    this.userDataDir = null;
    this.iconCacheDir = null;
    this.pendingUploadPaths = null;
    this.downloads = [];
    this.takenDownloadPaths.clear();
    this.downloadsDir = null;
    this.closing = false;
  }

  dispose(): void {
    this.closing = true;
    this.browserPanel?.dispose();
    this.browserPanel = null;
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
