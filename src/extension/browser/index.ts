import { spawn, execFile, type ChildProcess } from 'child_process';
import { promises as fsp } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';
import { promisify } from 'util';
import { get as httpGet } from 'http';
import * as vscode from 'vscode';
import { CdpSocket } from './cdp-socket';
import { CdpBridge } from './cdp-bridge';
import { BrowserPanel } from './browser-panel';
import { ScreencastHealth } from './screencast-health';
import { ConsoleCollector, NetworkCollector } from './collectors';
import { ElementPicker } from './element-picker';
import { isBlockedFaviconHost } from './net-guard';
import { log } from '../logger';
import type { BrowserSessionState } from './types';
import type { ElementAttachment, ConsoleEntry, NetworkError } from '../../shared/types/browser';

interface CdpPage {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
}

interface CdpVersion {
  webSocketDebuggerUrl: string;
}

interface CdpTargetInfo {
  targetId: string;
  type: string;
  title?: string;
  url?: string;
  attached?: boolean;
  openerId?: string;
  browserContextId?: string;
}

interface PageSession {
  targetId: string;
  sessionId: string;
  bridge: CdpBridge;
  picker: ElementPicker;
  openerId: string | undefined;
  lastUrl: string | null;
  lastTitle: string | null;
}

const execFileAsync = promisify(execFile);

let cachedBrowserPath: string | null = null;

async function fileExists(filePath: string): Promise<boolean> {
  return fsp.access(filePath).then(() => true, () => false);
}

async function findBrowser(): Promise<string> {
  if (cachedBrowserPath) return cachedBrowserPath;

  if (process.platform === 'win32') {
    const env = process.env;
    const paths = [
      join(env['PROGRAMFILES'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(env['PROGRAMFILES(X86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(env['LOCALAPPDATA'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(env['PROGRAMFILES'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(env['PROGRAMFILES(X86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
    for (const p of paths) {
      if (await fileExists(p)) {
        cachedBrowserPath = p;
        return p;
      }
    }
  } else if (process.platform === 'darwin') {
    const paths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    for (const p of paths) {
      if (await fileExists(p)) {
        cachedBrowserPath = p;
        return p;
      }
    }
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium', 'microsoft-edge-stable', 'microsoft-edge']) {
      try {
        const { stdout } = await execFileAsync('which', [name]);
        const resolved = stdout.trim();
        if (resolved) {
          cachedBrowserPath = resolved;
          return resolved;
        }
      } catch {
      }
    }
  }
  throw new Error('Chrome or Edge not found. Install Google Chrome or Microsoft Edge.');
}

async function launchChrome(url: string, userDataDir: string): Promise<{ process: ChildProcess; port: number }> {
  const browserPath = await findBrowser();

  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-popup-blocking',
    '--disable-translate',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=ThirdPartyCookiePhaseout,TrackingProtection3pcd,ThirdPartyStoragePartitioning,SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure,FedCm,FedCmIdpSigninStatusEnabled,FedCmAutoSelectedFlag',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1920,1080',
    // Chromium's new headless mode (Chrome 129+) still creates a platform window on Windows that
    // briefly grabs focus and flashes a blank frame (crbug.com/40269650). Parking it far off-screen
    // keeps it invisible and prevents the focus steal without leaving headless mode.
    '--window-position=-32000,-32000',
    `--user-data-dir=${userDataDir}`,
    url,
  ];

  if (process.getuid?.() === 0) {
    args.unshift('--no-sandbox');
  }

  const proc = spawn(browserPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  return new Promise((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        proc.kill();
        reject(new Error('Chrome failed to start within 15s'));
      }
    }, 15_000);

    const onStderr = (data: Buffer) => {
      const text = data.toString();
      const match = text.match(/DevTools listening on ws:\/\/[\w.]+:(\d+)/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        proc.stderr?.off('data', onStderr);
        resolve({ process: proc, port: parseInt(match[1]!, 10) });
      }
    };

    proc.stderr?.on('data', onStderr);
    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`Failed to launch Chrome: ${err.message}`));
      }
    });
    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`Chrome exited with code ${code} before ready`));
      }
    });
  });
}

function discoverBrowserWsUrl(port: number, timeoutMs = 10_000): Promise<string> {
  const startTime = Date.now();
  const poll = (): Promise<string> =>
    fetchJson<CdpVersion>(`http://127.0.0.1:${port}/json/version`)
      .then((v) => {
        if (v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl;
        if (Date.now() - startTime >= timeoutMs)
          throw new Error(`No browser WS URL on port ${port} within ${timeoutMs}ms`);
        return new Promise<void>((r) => setTimeout(r, 300)).then(poll);
      })
      .catch((err) => {
        if (Date.now() - startTime >= timeoutMs) throw err;
        return new Promise<void>((r) => setTimeout(r, 300)).then(poll);
      });
  return poll();
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

// Runs in the '__damocles' isolated world. Chromium does NOT emit Target.targetInfoChanged when
// document.title changes (verified: it fires only on URL/lifecycle changes and carries a placeholder
// title before load), so the live tab title is pushed from the renderer instead: a MutationObserver
// on <head> reports document.title through the __damoclesTitle binding whenever it changes.
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

// Runs in the '__damocles' isolated world. Push based cursor: reports the hovered element's cursor
// once per change through the __damoclesCursor binding, so hover feedback costs zero per move CDP
// round trips and survives navigations.
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
  private cdpSocket: CdpSocket | null = null;
  private chromeProcess: ChildProcess | null = null;
  private userDataDir: string | null = null;
  private browserPanel: BrowserPanel | null = null;
  private consoleCollector = new ConsoleCollector();
  private networkCollector = new NetworkCollector();
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private cdpPort: number | null = null;
  private broadcastToChat: ((element: ElementAttachment) => void) | null = null;
  private devToolsReattachTimer: ReturnType<typeof setInterval> | null = null;
  private devToolsSafetyTimer: ReturnType<typeof setTimeout> | null = null;
  private sessions = new Map<string, PageSession>();
  private focusStack: string[] = [];
  private cleanUserAgent: string | null = null;
  private viewport: { width: number; height: number; dpr: number } = { width: 1920, height: 1080, dpr: 1 };
  private firstSessionResolver: (() => void) | null = null;
  private firstSessionRejecter: ((err: Error) => void) | null = null;
  private lastFrame: { data: string; deviceWidth: number; deviceHeight: number } | null = null;
  private screencastHealth = new ScreencastHealth();
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogFailureStreak = 0;
  private watchdogBackoffUntil = 0;
  private ackRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private iconCacheDir: string | null = null;
  private faviconToken = 0;
  private openChain: Promise<void> = Promise.resolve();

  isConnected(): boolean {
    return this.state === 'connected';
  }

  private getActiveSession(): PageSession | null {
    for (let i = this.focusStack.length - 1; i >= 0; i--) {
      const session = this.sessions.get(this.focusStack[i]!);
      if (session) return session;
    }
    return null;
  }

  private settleFirstSessionWait(err?: Error): void {
    if (err) {
      this.firstSessionRejecter?.(err);
    } else {
      this.firstSessionResolver?.();
    }
    this.firstSessionResolver = null;
    this.firstSessionRejecter = null;
  }

  getCdp(): CdpBridge | null {
    return this.getActiveSession()?.bridge ?? null;
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

  onElementPickedFromToolbar(handler: (element: ElementAttachment) => void): void {
    this.broadcastToChat = handler;
  }

  // Serializes concurrent open() calls (double Enter, or Reload during a browser_open tool call).
  // Without this, a second open() would call close() and tear down the first launch's Chrome while
  // the first launch's catch disposes the panel/currentUrl the second is already using. Each call
  // queues behind the previous one, so by the time it runs the earlier launch is fully settled.
  async open(url: string, signal?: AbortSignal): Promise<void> {
    const run = this.openChain.then(() => this.openInternal(url, signal));
    this.openChain = run.then(() => {}, () => {});
    return run;
  }

  private async openInternal(url: string, signal?: AbortSignal): Promise<void> {
    const active = this.getActiveSession();
    if (this.state === 'connected' && active) {
      await active.bridge.navigate(url);
      this.currentUrl = url;
      this.showBrowserPanel(url);
      return;
    }

    if (this.chromeProcess) {
      await this.close();
    }

    // Only a panel this call creates may be torn down on failure. A panel already present belongs to
    // the disconnected-recovery UI (kept alive by handleProcessGone); disposing it would make a second
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
    this.cdpSocket?.close();
    if (this.chromeProcess) {
      this.chromeProcess.kill();
      this.chromeProcess = null;
    }
    this.cleanup();
  }

  async pickElement(): Promise<ElementAttachment> {
    const active = this.getActiveSession();
    if (!active) {
      throw new Error('Browser is not connected — element picking requires an active CDP session');
    }
    return active.picker.startPicking();
  }

  async cancelPicking(): Promise<void> {
    await this.getActiveSession()?.picker.stopPicking();
  }

  private async ensureUserDataDir(): Promise<void> {
    if (this.userDataDir) return;
    const dir = join(homedir(), '.damocles', 'browser-profile');
    await fsp.mkdir(dir, { recursive: true });
    this.userDataDir = dir;
    const iconDir = join(dir, 'tab-icons');
    await fsp.mkdir(iconDir, { recursive: true });
    this.iconCacheDir = iconDir;
  }

  private async launchAndConnect(url: string, signal?: AbortSignal): Promise<void> {
    let proc: ChildProcess | null = null;
    try {
      if (signal?.aborted) throw new Error('Browser open aborted');
      const launch = await launchChrome(url, this.userDataDir!);
      proc = launch.process;
      this.chromeProcess = proc;
      this.cdpPort = launch.port;

      const browserWsUrl = await discoverBrowserWsUrl(launch.port);

      const socket = new CdpSocket();
      await socket.connect(browserWsUrl);
      this.cdpSocket = socket;

      socket.onEvent((method, params, sessionId) => {
        this.handleCdpEvent(method, params, sessionId);
      });
      socket.onClose(() => {
        this.cdpSocket = null;
        for (const session of this.sessions.values()) session.picker.stopPicking().catch(() => {});
        this.sessions.clear();
        this.focusStack = [];
        this.lastFrame = null;
        this.clearWatchdog();
        this.settleFirstSessionWait(new Error('CDP socket closed before first page attached'));
        if (this.state === 'connected') {
          this.state = 'disconnected';
        }
        if (this.browserPanel) {
          this.browserPanel.setConnectionState(false);
        }
      });

      const version = await socket.send('Browser.getVersion') as { userAgent: string };
      this.cleanUserAgent = version.userAgent.replace(/HeadlessChrome/g, 'Chrome');

      const firstSessionReady = new Promise<void>((resolve, reject) => {
        this.firstSessionResolver = resolve;
        this.firstSessionRejecter = reject;
      });

      await socket.send('Target.setDiscoverTargets', { discover: true });
      await socket.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });

      // Wait for the first page target, racing a 10s deadline AND the abort signal so an ESC mid-launch
      // unblocks immediately instead of hanging until the deadline (or until the user closes the browser).
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('Browser open aborted'));
        const timer = setTimeout(() => reject(new Error('No page target attached within 10s')), 10_000);
        const onAbort = (): void => { clearTimeout(timer); reject(new Error('Browser open aborted')); };
        signal?.addEventListener('abort', onAbort, { once: true });
        firstSessionReady.then(
          () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(); },
          (err) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(err); },
        );
      });

      this.state = 'connected';
      this.startWatchdog();
      proc.on('close', () => this.handleProcessGone());
    } catch (err) {
      if (proc) {
        proc.removeAllListeners('close');
        proc.kill();
        this.chromeProcess = null;
      }
      this.cdpSocket?.close();
      this.cdpSocket = null;
      this.sessions.clear();
      this.focusStack = [];
      this.settleFirstSessionWait();
      this.state = 'disconnected';
      // currentUrl is intentionally preserved: the caller (openInternal / restorePanel) decides
      // whether to clear it, and a kept-alive recovery panel needs it so Reload can relaunch.
      throw err;
    }
  }

  private async attachPage(targetInfo: CdpTargetInfo, sessionId: string): Promise<void> {
    if (!this.cdpSocket?.connected) return;
    if (this.sessions.has(sessionId)) return;

    const isFirstSession = this.sessions.size === 0;
    const bridge = new CdpBridge(this.cdpSocket, sessionId);
    let hydrated: CdpTargetInfo = targetInfo;
    try {
      await bridge.enableDomains();
      await this.cdpSocket.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: `Object.defineProperty(navigator, 'webdriver', { get: () => false });` },
        sessionId,
      );
      // Isolated world observers ('__damocles'): cursor + live title pushed through bindings. The
      // binding names and world name must stay identical across the addBinding calls, the
      // addScriptToEvaluateOnNewDocument worldName, and the Runtime.bindingCalled handler.
      await this.cdpSocket.send(
        'Runtime.addBinding',
        { name: '__damoclesCursor', executionContextName: '__damocles' },
        sessionId,
      );
      await this.cdpSocket.send(
        'Runtime.addBinding',
        { name: '__damoclesTitle', executionContextName: '__damocles' },
        sessionId,
      );
      await this.cdpSocket.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: CURSOR_OBSERVER_SCRIPT, worldName: '__damocles' },
        sessionId,
      );
      await this.cdpSocket.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: TITLE_OBSERVER_SCRIPT, worldName: '__damocles' },
        sessionId,
      );
      // addScriptToEvaluateOnNewDocument only affects FUTURE documents; the page we attach to is
      // usually already loaded (the launch URL), so bootstrap the observers into the current document
      // through an explicitly created isolated world.
      try {
        const tree = await this.cdpSocket.send('Page.getFrameTree', undefined, sessionId) as { frameTree: { frame: { id: string } } };
        const world = await this.cdpSocket.send(
          'Page.createIsolatedWorld',
          { frameId: tree.frameTree.frame.id, worldName: '__damocles' },
          sessionId,
        ) as { executionContextId: number };
        await this.cdpSocket.send('Runtime.evaluate', { expression: CURSOR_OBSERVER_SCRIPT, contextId: world.executionContextId }, sessionId);
        await this.cdpSocket.send('Runtime.evaluate', { expression: TITLE_OBSERVER_SCRIPT, contextId: world.executionContextId }, sessionId);
      } catch (err) {
        log(`[Browser] Observer bootstrap failed — ${err instanceof Error ? err.message : String(err)}`);
      }
      if (this.cleanUserAgent) {
        await this.cdpSocket.send(
          'Emulation.setUserAgentOverride',
          { userAgent: this.cleanUserAgent },
          sessionId,
        );
      }
      await bridge.setViewport(this.viewport.width, this.viewport.height, this.viewport.dpr);
      if (!hydrated.url) {
        const fresh = await this.cdpSocket.send('Target.getTargetInfo', { targetId: targetInfo.targetId }) as { targetInfo: CdpTargetInfo };
        hydrated = fresh.targetInfo;
      }
    } catch (err) {
      const initErr = err instanceof Error ? err : new Error(String(err));
      log(`[Browser] Failed to initialise session ${sessionId} — ${initErr.message}`);
      if (isFirstSession) this.settleFirstSessionWait(initErr);
      return;
    }

    const picker = new ElementPicker(bridge, this.consoleCollector, this.networkCollector);
    const session: PageSession = {
      targetId: targetInfo.targetId,
      sessionId,
      bridge,
      picker,
      openerId: hydrated.openerId ?? targetInfo.openerId,
      lastUrl: hydrated.url ?? null,
      lastTitle: hydrated.title ?? null,
    };
    this.sessions.set(sessionId, session);

    const previousActive = this.getActiveSession();
    const shouldFocus = previousActive === null
      || (session.openerId !== undefined && previousActive.targetId === session.openerId);

    if (shouldFocus) {
      if (previousActive) {
        await previousActive.bridge.stopScreencast().catch(() => {});
        this.lastFrame = null;
      }
      this.focusStack.push(sessionId);

      if (hydrated.url) {
        this.currentUrl = hydrated.url;
        this.applyTabIdentity(session);
        this.browserPanel?.updateUrl(hydrated.url);
      }
      this.resolveFavicon(session);

      if (this.browserPanel?.visible) await this.startScreencast(bridge);
    }

    if (isFirstSession) this.settleFirstSessionWait();
  }

  private detachPage(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.picker.stopPicking().catch(() => {});

    const wasActive = this.focusStack[this.focusStack.length - 1] === sessionId;
    this.focusStack = this.focusStack.filter((id) => id !== sessionId);

    if (!wasActive) return;

    this.lastFrame = null;

    const newActive = this.getActiveSession();
    if (newActive) {
      if (this.browserPanel?.visible) {
        this.startScreencast(newActive.bridge).catch((err) =>
          log(`[Browser] Resume screencast failed — ${err instanceof Error ? err.message : String(err)}`),
        );
      }
      if (newActive.lastUrl) {
        this.currentUrl = newActive.lastUrl;
        this.applyTabIdentity(newActive);
        this.browserPanel?.updateUrl(newActive.lastUrl);
      }
      this.resolveFavicon(newActive);
    }
  }

  private handleCdpEvent(method: string, params: unknown, sessionId?: string): void {
    if (method === 'Target.attachedToTarget') {
      const p = params as { sessionId: string; targetInfo: CdpTargetInfo };
      if (p.targetInfo.type === 'page') {
        this.attachPage(p.targetInfo, p.sessionId).catch((err) =>
          log(`[Browser] attachPage failed — ${err instanceof Error ? err.message : String(err)}`),
        );
      }
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      const p = params as { sessionId: string };
      this.detachPage(p.sessionId);
      return;
    }
    if (method === 'Target.targetDestroyed') {
      const p = params as { targetId: string };
      for (const session of this.sessions.values()) {
        if (session.targetId === p.targetId) {
          this.detachPage(session.sessionId);
          break;
        }
      }
      return;
    }


    const sourceSession = sessionId ? this.sessions.get(sessionId) : null;
    const active = this.getActiveSession();
    const isActive = sourceSession !== null && sourceSession === active;

    if (method === 'Page.screencastFrame') {
      const frame = params as { data: string; metadata: { deviceWidth: number; deviceHeight: number }; sessionId: number };
      if (isActive) {
        this.lastFrame = { data: frame.data, deviceWidth: frame.metadata.deviceWidth, deviceHeight: frame.metadata.deviceHeight };
        this.screencastHealth.noteFrame();
        this.resetWatchdogBackoff();
        this.browserPanel?.pushFrame(frame.data, frame.metadata.deviceWidth, frame.metadata.deviceHeight);
      }
      if (sessionId) {
        this.cdpSocket?.send('Page.screencastFrameAck', { sessionId: frame.sessionId }, sessionId).catch((err) => {
          log(`[Browser] Screencast frame ack failed: ${err instanceof Error ? err.message : String(err)}`);
          // Only the active session's stream drives the panel; a stale/background session's ack
          // failure must not trigger a restart of the healthy active stream.
          if (isActive) {
            this.screencastHealth.noteAckFailure();
            this.scheduleAckRestart();
          }
        });
      }
    } else if (method === 'Page.frameNavigated') {
      const p = params as { frame?: { url?: string; parentId?: string } };
      if (!sourceSession || !p.frame?.url || p.frame.parentId) return;
      sourceSession.lastUrl = p.frame.url;
      // A main-frame navigation invalidates the old title and favicon; clear the title so the URL is
      // shown until Target.targetInfoChanged reports the new one, and refetch the favicon.
      sourceSession.lastTitle = null;
      if (isActive) {
        this.currentUrl = p.frame.url;
        this.applyTabIdentity(sourceSession);
        this.browserPanel?.updateUrl(p.frame.url);
      }
      this.resolveFavicon(sourceSession);
    } else if (method === 'Page.navigatedWithinDocument') {
      const p = params as { url?: string };
      if (!sourceSession || !p.url) return;
      sourceSession.lastUrl = p.url;
      if (isActive) {
        this.currentUrl = p.url;
        this.applyTabIdentity(sourceSession);
        this.browserPanel?.updateUrl(p.url);
      }
      this.resolveFavicon(sourceSession);
    } else if (method === 'Runtime.consoleAPICalled') {
      if (!isActive) return;
      this.consoleCollector.handleEvent(params as Parameters<ConsoleCollector['handleEvent']>[0]);
    } else if (method === 'Network.responseReceived') {
      if (!isActive) return;
      this.networkCollector.handleResponse(params as Parameters<NetworkCollector['handleResponse']>[0]);
    } else if (method === 'Network.loadingFailed') {
      if (!isActive) return;
      this.networkCollector.handleLoadingFailed(
        params as Parameters<NetworkCollector['handleLoadingFailed']>[0],
      );
    } else if (method === 'Overlay.inspectNodeRequested') {
      if (!isActive || !active) return;
      const p = params as { backendNodeId: number };
      active.picker.handleInspectNodeRequested(p.backendNodeId);
    } else if (method === 'Runtime.bindingCalled') {
      const p = params as { name: string; payload: string; executionContextId: number };
      if (p.name === '__damoclesTitle' && sourceSession) {
        sourceSession.lastTitle = p.payload || null;
        if (isActive) this.applyTabIdentity(sourceSession);
        return;
      }
      if (!isActive) return;
      if (p.name === '__damoclesCursor') {
        this.browserPanel?.setCursor(p.payload);
      }
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
        const active = this.getActiveSession();
        if (!active) return;
        if (active.picker.isPicking) {
          active.bridge.getNodeForLocation(x, y)
            .then(result => active.picker.handleInspectNodeRequested(result.backendNodeId))
            .catch(err => log(`[Browser] Pick click failed — ${err instanceof Error ? err.message : String(err)}`));
          return;
        }
        active.bridge.dispatchMouseEvent('mousePressed', x, y, {
          button: jsButtonToCdp(button),
          clickCount,
          buttons,
          modifiers,
        }).catch(err => log(`[Browser] Mouse down failed — ${err instanceof Error ? err.message : String(err)}`));
      });
      this.browserPanel.onMouseUp((x, y, button, buttons, clickCount, modifiers) => {
        const active = this.getActiveSession();
        if (!active || active.picker.isPicking) return;
        active.bridge.dispatchMouseEvent('mouseReleased', x, y, {
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
        const active = this.getActiveSession();
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
          this.getActiveSession()?.bridge.stopScreencast().catch((err) =>
            log(`[Browser] Stop screencast on hide failed: ${err instanceof Error ? err.message : String(err)}`),
          );
          return;
        }
        this.browserPanel?.updateViewport(this.viewport.width, this.viewport.height);
        if (this.lastFrame) {
          this.browserPanel?.pushFrame(this.lastFrame.data, this.lastFrame.deviceWidth, this.lastFrame.deviceHeight);
        }
        const active = this.getActiveSession();
        if (active) {
          this.startScreencast(active.bridge).catch((err) =>
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

  private async openDevToolsInBrowserView(): Promise<void> {
    const active = this.getActiveSession();
    if (!this.cdpPort || !active) {
      log('[Browser] Cannot open DevTools — no CDP port or page target');
      return;
    }

    const targetId = active.targetId;
    if (this.cdpSocket?.connected) {
      try {
        await this.cdpSocket.send('Target.detachFromTarget', { sessionId: active.sessionId });
      } catch (err) {
        log(`[Browser] Detach failed — ${err instanceof Error ? err.message : String(err)}`);
      }
      this.detachPage(active.sessionId);
    }

    const devtoolsUrl = `http://127.0.0.1:${this.cdpPort}/devtools/inspector.html?ws=127.0.0.1:${this.cdpPort}/devtools/page/${targetId}`;
    await vscode.env.openExternal(vscode.Uri.parse(devtoolsUrl));

    this.monitorDevToolsDisconnect(targetId);
  }

  private monitorDevToolsDisconnect(targetId: string): void {
    this.stopDevToolsMonitor();

    this.devToolsReattachTimer = setInterval(async () => {
      if (!this.cdpPort || !this.cdpSocket?.connected) {
        this.stopDevToolsMonitor();
        return;
      }
      try {
        const pages = await fetchJson<CdpPage[]>(`http://127.0.0.1:${this.cdpPort}/json`);
        const page = pages.find(p => p.id === targetId);
        if (page?.webSocketDebuggerUrl) {
          this.stopDevToolsMonitor();
          await this.reattachToTarget(targetId);
        }
      } catch {
        this.stopDevToolsMonitor();
      }
    }, 3_000);

    this.devToolsSafetyTimer = setTimeout(() => this.stopDevToolsMonitor(), 10 * 60 * 1_000);
  }

  private stopDevToolsMonitor(): void {
    if (this.devToolsReattachTimer) {
      clearInterval(this.devToolsReattachTimer);
      this.devToolsReattachTimer = null;
    }
    if (this.devToolsSafetyTimer) {
      clearTimeout(this.devToolsSafetyTimer);
      this.devToolsSafetyTimer = null;
    }
  }

  private async reattachToTarget(targetId: string): Promise<void> {
    if (!this.cdpSocket?.connected) return;
    try {
      const result = await this.cdpSocket.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      }) as { sessionId: string };
      await this.attachPage({ targetId, type: 'page' }, result.sessionId);
      this.state = 'connected';
    } catch (err) {
      log(`[Browser] Reattach failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Sets the panel tab label to the session's page title, falling back to its URL until a title exists.
  private applyTabIdentity(session: PageSession): void {
    if (!session.lastUrl) return;
    this.browserPanel?.setTabTitle(session.lastTitle, session.lastUrl);
  }

  // Resolves the active page's favicon: candidate URLs come from a page context DOM scan, the bytes
  // are downloaded extension side (immune to the page's CSP connect-src), cached to a local file
  // (VS Code tab icons require a file path, not a URL), and applied. A monotonic token guards against
  // a slow resolution from a prior page overwriting the icon of a newer navigation.
  private resolveFavicon(session: PageSession): void {
    if (session !== this.getActiveSession() || !this.iconCacheDir) return;
    const token = ++this.faviconToken;
    session.bridge.evaluate(GET_FAVICON_CANDIDATES_EXPR, true)
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
    // to loopback/link-local/private ranges before issuing the extension-host GET.
    if (await isBlockedFaviconHost(url.hostname)) return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(url, { signal: controller.signal, redirect: 'follow' }).finally(() => clearTimeout(timer));
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

  private async startScreencast(bridge: CdpBridge): Promise<void> {
    // Arm the zero-frame stall detector BEFORE the CDP call. If the send itself rejects (or times
    // out), the watchdog still sees a start with no frames and retries; noting the start only on
    // success would leave a failed start invisible and freeze the panel forever.
    this.screencastHealth.noteStart();
    try {
      await bridge.startScreencast(this.screencastOptions());
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
      const active = this.getActiveSession();
      if (active && this.browserPanel?.visible) {
        this.startScreencast(active.bridge).catch((err) =>
          log(`[Browser] Ack triggered screencast restart failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }, 500);
  }

  private async resizeViewport(width: number, height: number, dpr: number): Promise<void> {
    this.viewport = { width, height, dpr: Math.min(dpr, 2) };
    const active = this.getActiveSession();
    if (!active) return;
    for (const session of this.sessions.values()) {
      try {
        await session.bridge.setViewport(width, height, this.viewport.dpr);
      } catch (err) {
        log(`[Browser] Viewport propagate failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.browserPanel?.updateViewport(width, height);
    // Guard the stop: a rejected stopScreencast (e.g. the CDP send timed out) must not skip the
    // restart, or the panel would be left with a stale-sized stream and no recovery.
    await active.bridge.stopScreencast().catch((err) =>
      log(`[Browser] Stop screencast on resize failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    if (this.browserPanel?.visible) await this.startScreencast(active.bridge);
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
      const active = this.getActiveSession();
      if (!active) return;
      if (!this.screencastHealth.shouldRestart(Date.now(), this.browserPanel?.visible ?? false, this.isConnected())) return;
      if (Date.now() < this.watchdogBackoffUntil) return;
      const backoffMs = Math.min(5_000 * 2 ** this.watchdogFailureStreak, 60_000);
      this.watchdogBackoffUntil = Date.now() + backoffMs;
      this.watchdogFailureStreak++;
      this.startScreencast(active.bridge).catch((err) =>
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

  // Chrome exited on its own (crash or external kill). When a panel is open we keep it alive to show
  // the disconnected placeholder and preserve currentUrl so Reload can relaunch. We tear down only the
  // live CDP resources here. When there is no panel there is nothing to recover into, so we fully clean up.
  private handleProcessGone(): void {
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
    this.cdpSocket?.close();
    this.cdpSocket = null;
    for (const session of this.sessions.values()) session.picker.stopPicking().catch(() => {});
    this.sessions.clear();
    this.focusStack = [];
    this.lastFrame = null;
    this.chromeProcess = null;
    this.state = 'disconnected';
  }

  private cleanup(): void {
    this.stopDevToolsMonitor();
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
    this.cdpSocket?.close();
    this.cdpSocket = null;
    for (const session of this.sessions.values()) session.picker.stopPicking().catch(() => {});
    this.sessions.clear();
    this.focusStack = [];
    this.settleFirstSessionWait(new Error('Browser session cleaned up before first page attached'));
    this.cleanUserAgent = null;
    this.consoleCollector.clear();
    this.networkCollector.clear();
    this.state = 'disconnected';
    this.currentUrl = null;
    this.cdpPort = null;
    this.browserPanel?.dispose();
    this.browserPanel = null;
    this.userDataDir = null;
  }

  dispose(): void {
    this.browserPanel?.dispose();
    this.browserPanel = null;
    this.cdpSocket?.close();
    if (this.chromeProcess) {
      this.chromeProcess.kill();
      this.chromeProcess = null;
    }
    this.cleanup();
  }
}
