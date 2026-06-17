import { spawn, execFile, type ChildProcess } from 'child_process';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { promisify } from 'util';
import { get as httpGet } from 'http';
import * as vscode from 'vscode';
import { CdpSocket } from './cdp-socket';
import { CdpBridge } from './cdp-bridge';
import { BrowserPanel } from './browser-panel';
import { ConsoleCollector, NetworkCollector } from './collectors';
import { ElementPicker } from './element-picker';
import { createBrowserMcpServer } from './mcp-server';
import { log } from '../logger';
import type { BrowserSessionState } from './types';
import type { ElementAttachment, ConsoleEntry, NetworkError } from '../../shared/types/browser';

type SdkCreateServer = typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer;
type SdkTool = typeof import('@anthropic-ai/claude-agent-sdk').tool;
type ZodZ = typeof import('zod').z;

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
  private mcpModules: { createSdkMcpServer: SdkCreateServer; tool: SdkTool; z: ZodZ } | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private cdpPort: number | null = null;
  private broadcastToChat: ((element: ElementAttachment) => void) | null = null;
  private devToolsReattachTimer: ReturnType<typeof setInterval> | null = null;
  private devToolsSafetyTimer: ReturnType<typeof setTimeout> | null = null;
  private sessions = new Map<string, PageSession>();
  private focusStack: string[] = [];
  private cleanUserAgent: string | null = null;
  private viewport: { width: number; height: number; dpr: number } = { width: 1920, height: 1080, dpr: 2 };
  private firstSessionResolver: (() => void) | null = null;
  private firstSessionRejecter: ((err: Error) => void) | null = null;

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

  async open(url: string, signal?: AbortSignal): Promise<void> {
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

    this.currentUrl = url;
    await this.ensureUserDataDir();
    this.showBrowserPanel(url);

    try {
      await this.launchAndConnect(url, signal);
    } catch (err) {
      this.browserPanel?.dispose();
      this.browserPanel = null;
      this.currentUrl = null;
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
        this.settleFirstSessionWait(new Error('CDP socket closed before first page attached'));
        if (this.state === 'connected') {
          this.state = 'disconnected';
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
      proc.on('close', () => this.cleanup());
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
      this.currentUrl = null;
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
    };
    this.sessions.set(sessionId, session);

    const previousActive = this.getActiveSession();
    const shouldFocus = previousActive === null
      || (session.openerId !== undefined && previousActive.targetId === session.openerId);

    if (shouldFocus) {
      if (previousActive) await previousActive.bridge.stopScreencast().catch(() => {});
      this.focusStack.push(sessionId);

      if (hydrated.url) {
        this.currentUrl = hydrated.url;
        this.browserPanel?.updateTitle(hydrated.url);
        this.browserPanel?.updateUrl(hydrated.url);
      }

      await this.startScreencast(bridge);
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

    const newActive = this.getActiveSession();
    if (newActive) {
      this.startScreencast(newActive.bridge).catch((err) =>
        log(`[Browser] Resume screencast failed — ${err instanceof Error ? err.message : String(err)}`),
      );
      if (newActive.lastUrl) {
        this.currentUrl = newActive.lastUrl;
        this.browserPanel?.updateTitle(newActive.lastUrl);
        this.browserPanel?.updateUrl(newActive.lastUrl);
      }
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
      const frame = params as { data: string; metadata: unknown; sessionId: number };
      if (isActive) {
        this.browserPanel?.pushFrame(frame.data);
      }
      if (sessionId) {
        this.cdpSocket?.send('Page.screencastFrameAck', { sessionId: frame.sessionId }, sessionId).catch(() => {});
      }
    } else if (method === 'Page.frameNavigated') {
      const p = params as { frame?: { url?: string; parentId?: string } };
      if (!sourceSession || !p.frame?.url || p.frame.parentId) return;
      sourceSession.lastUrl = p.frame.url;
      if (isActive) {
        this.currentUrl = p.frame.url;
        this.browserPanel?.updateTitle(p.frame.url);
        this.browserPanel?.updateUrl(p.frame.url);
      }
    } else if (method === 'Page.navigatedWithinDocument') {
      const p = params as { url?: string };
      if (!sourceSession || !p.url) return;
      sourceSession.lastUrl = p.url;
      if (isActive) {
        this.currentUrl = p.url;
        this.browserPanel?.updateTitle(p.url);
        this.browserPanel?.updateUrl(p.url);
      }
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
      this.browserPanel.onMouseDown((x, y, button, buttons, clickCount) => {
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
        }).catch(err => log(`[Browser] Mouse down failed — ${err instanceof Error ? err.message : String(err)}`));
      });
      this.browserPanel.onMouseUp((x, y, button, buttons, clickCount) => {
        const active = this.getActiveSession();
        if (!active || active.picker.isPicking) return;
        active.bridge.dispatchMouseEvent('mouseReleased', x, y, {
          button: jsButtonToCdp(button),
          clickCount,
          buttons,
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
      this.browserPanel.onKey((key, code, text, keyCode) => {
        const cdp = this.getCdp();
        if (!cdp) return;
        const vk = keyCode || 0;
        if (text) {
          cdp.dispatchKeyEvent('keyDown', { key, code, text, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }).then(() =>
            cdp.dispatchKeyEvent('keyUp', { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }),
          ).catch(() => {});
        } else {
          cdp.dispatchKeyEvent('rawKeyDown', { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }).then(() =>
            cdp.dispatchKeyEvent('keyUp', { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }),
          ).catch(() => {});
        }
      });
      this.browserPanel.onScroll((deltaX, deltaY) => {
        const cdp = this.getCdp();
        if (!cdp) return;
        cdp.evaluate(`window.scrollBy(${Number(deltaX)}, ${Number(deltaY)})`).catch(() => {});
      });
      this.browserPanel.onResize((width, height) => {
        if (this.resizeTimer) clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => {
          this.resizeViewport(width, height).catch((err) =>
            log(`[Browser] Viewport resize failed — ${err instanceof Error ? err.message : String(err)}`),
          );
        }, 200);
      });
      this.browserPanel.onMouseMove((x, y, buttons) => {
        const cdp = this.getCdp();
        if (!cdp) return;
        const button = buttons & 1 ? 'left' : buttons & 2 ? 'right' : buttons & 4 ? 'middle' : 'none' as const;
        cdp.dispatchMouseEvent('mouseMoved', x, y, { button, buttons }).catch(() => {});
        if (buttons > 0) return;
        cdp.evaluate(`(() => {
          const el = document.elementFromPoint(${Number(x)}, ${Number(y)});
          if (!el) return 'default';
          const cs = getComputedStyle(el).cursor;
          if (cs && cs !== 'auto') return cs;
          const tag = el.tagName;
          if (tag === 'A' || el.closest('a') || el.closest('[role=button]')) return 'pointer';
          if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return 'text';
          return 'default';
        })()`, true).then(result => {
          const cursor = typeof result.value === 'string' ? result.value : 'default';
          this.browserPanel?.setCursor(cursor);
        }).catch(() => {});
      });
      this.browserPanel.onNavigate((navUrl) => {
        const cdp = this.getCdp();
        if (!cdp) return;
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
        if (!cdp) return;
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

  private async startScreencast(bridge: CdpBridge): Promise<void> {
    try {
      await bridge.startScreencast({
        format: 'jpeg',
        quality: 80,
        everyNthFrame: 1,
        maxWidth: this.viewport.width * this.viewport.dpr,
        maxHeight: this.viewport.height * this.viewport.dpr,
      });
    } catch (err) {
      log(`[Browser] Failed to start screencast — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async resizeViewport(width: number, height: number): Promise<void> {
    this.viewport = { width, height, dpr: this.viewport.dpr };
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
    await active.bridge.stopScreencast();
    await active.bridge.startScreencast({
      format: 'jpeg',
      quality: 80,
      everyNthFrame: 1,
      maxWidth: width * this.viewport.dpr,
      maxHeight: height * this.viewport.dpr,
    });
  }

  private cleanup(): void {
    this.stopDevToolsMonitor();
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

  getMcpServerConfig(): unknown {
    try {
      if (!this.mcpModules) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const sdk = require('@anthropic-ai/claude-agent-sdk') as typeof import('@anthropic-ai/claude-agent-sdk');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const zod = require('zod') as typeof import('zod');
        this.mcpModules = { createSdkMcpServer: sdk.createSdkMcpServer, tool: sdk.tool, z: zod.z };
      }
      const { createSdkMcpServer, tool, z } = this.mcpModules;
      return createBrowserMcpServer(this, createSdkMcpServer, tool, z);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[BrowserService] Failed to create MCP server: ${message}`);
      return null;
    }
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
