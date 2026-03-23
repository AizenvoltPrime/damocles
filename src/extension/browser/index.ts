import { spawn, execSync, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
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

function findBrowser(): string {
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
      if (existsSync(p)) return p;
    }
  } else if (process.platform === 'darwin') {
    const paths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    for (const p of paths) {
      if (existsSync(p)) return p;
    }
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium', 'microsoft-edge-stable', 'microsoft-edge']) {
      try {
        return execSync(`which ${name}`, { encoding: 'utf8' }).trim();
      } catch {
        /* next */
      }
    }
  }
  throw new Error('Chrome or Edge not found. Install Google Chrome or Microsoft Edge.');
}

function launchChrome(url: string, userDataDir: string): Promise<{ process: ChildProcess; port: number }> {
  const browserPath = findBrowser();

  const proc = spawn(
    browserPath,
    [
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
      '--disable-features=ThirdPartyCookiePhaseout,TrackingProtection3pcd,ThirdPartyStoragePartitioning,SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
      `--user-data-dir=${userDataDir}`,
      url,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

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

function discoverPageTarget(port: number, timeoutMs = 10_000): Promise<CdpPage> {
  const startTime = Date.now();
  const poll = (): Promise<CdpPage> =>
    fetchJson<CdpPage[]>(`http://127.0.0.1:${port}/json`)
      .then((pages) => {
        const page = pages.find((p) => p.type === 'page');
        if (page?.id) return page;
        if (Date.now() - startTime >= timeoutMs)
          throw new Error(`No page target found on port ${port} within ${timeoutMs}ms`);
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
  private cdp: CdpBridge | null = null;
  private cdpSocket: CdpSocket | null = null;
  private chromeProcess: ChildProcess | null = null;
  private userDataDir: string | null = null;
  private elementPicker: ElementPicker | null = null;
  private browserPanel: BrowserPanel | null = null;
  private consoleCollector = new ConsoleCollector();
  private networkCollector = new NetworkCollector();
  private mcpModules: { createSdkMcpServer: SdkCreateServer; tool: SdkTool; z: ZodZ } | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private cdpPort: number | null = null;
  private pageSessionId: string | null = null;
  private broadcastToChat: ((element: ElementAttachment) => void) | null = null;
  private devToolsReattachTimer: ReturnType<typeof setInterval> | null = null;
  private devToolsSafetyTimer: ReturnType<typeof setTimeout> | null = null;
  private pageTargetId: string | null = null;

  isConnected(): boolean {
    return this.state === 'connected';
  }

  getCdp(): CdpBridge | null {
    return this.cdp;
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

  async open(url: string): Promise<void> {
    if (this.state === 'connected' && this.cdp) {
      await this.cdp.navigate(url);
      this.currentUrl = url;
      this.showBrowserPanel(url);
      return;
    }

    if (this.chromeProcess) {
      await this.close();
    }

    this.currentUrl = url;
    this.ensureUserDataDir();
    this.showBrowserPanel(url);

    try {
      await this.launchAndConnect(url);
    } catch (err) {
      this.browserPanel?.dispose();
      this.browserPanel = null;
      this.currentUrl = null;
      throw err;
    }
  }

  async restorePanel(panel: vscode.WebviewPanel, url: string): Promise<void> {
    this.currentUrl = url;
    this.ensureUserDataDir();
    this.showBrowserPanel(url, panel);

    try {
      await this.launchAndConnect(url);
    } catch (err) {
      log(`[Browser] Failed to restore browser session — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async waitForCdp(timeoutMs: number): Promise<boolean> {
    if (this.isConnected()) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
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
    if (!this.elementPicker) {
      throw new Error('Browser is not connected — element picking requires an active CDP session');
    }
    return this.elementPicker.startPicking();
  }

  async cancelPicking(): Promise<void> {
    await this.elementPicker?.stopPicking();
  }

  private ensureUserDataDir(): void {
    if (this.userDataDir) return;
    const dir = join(homedir(), '.damocles', 'browser-profile');
    mkdirSync(dir, { recursive: true });
    this.userDataDir = dir;
  }

  private async launchAndConnect(url: string): Promise<void> {
    let proc: ChildProcess | null = null;
    try {
      const launch = await launchChrome(url, this.userDataDir!);
      proc = launch.process;
      this.chromeProcess = proc;
      this.cdpPort = launch.port;

      const [browserWsUrl, pageTarget] = await Promise.all([
        discoverBrowserWsUrl(launch.port),
        discoverPageTarget(launch.port),
      ]);
      this.pageTargetId = pageTarget.id;

      const socket = new CdpSocket();
      await socket.connect(browserWsUrl);
      this.cdpSocket = socket;

      const attachResult = await socket.send('Target.attachToTarget', {
        targetId: pageTarget.id,
        flatten: true,
      }) as { sessionId: string };
      this.pageSessionId = attachResult.sessionId;

      socket.onEvent((method, params, sessionId) => {
        if (sessionId === this.pageSessionId) {
          this.handleCdpEvent(method, params);
        }
      });
      socket.onClose(() => {
        this.cdp = null;
        this.cdpSocket = null;
        this.pageSessionId = null;
        this.elementPicker = null;
        if (this.state === 'connected') {
          this.state = 'disconnected';
        }
      });

      const bridge = new CdpBridge(socket, this.pageSessionId);
      await bridge.enableDomains();
      await this.maskAutomation();
      this.cdp = bridge;
      this.elementPicker = new ElementPicker(bridge, this.consoleCollector, this.networkCollector);
      this.state = 'connected';

      proc.on('close', () => this.cleanup());

      await this.startScreencast(bridge);
    } catch (err) {
      if (proc) {
        proc.removeAllListeners('close');
        proc.kill();
        this.chromeProcess = null;
      }
      this.cdpSocket?.close();
      this.cdpSocket = null;
      this.pageSessionId = null;
      this.state = 'disconnected';
      this.currentUrl = null;
      throw err;
    }
  }

  private handleCdpEvent(method: string, params: unknown): void {
    if (method === 'Page.screencastFrame') {
      const frame = params as { data: string; metadata: unknown; sessionId: number };
      this.browserPanel?.pushFrame(frame.data);
      this.cdp?.ackScreencastFrame(frame.sessionId).catch(() => {});
    } else if (method === 'Page.frameNavigated') {
      const p = params as { frame?: { url?: string; parentId?: string } };
      if (p.frame?.url && !p.frame.parentId) {
        this.currentUrl = p.frame.url;
        this.browserPanel?.updateTitle(p.frame.url);
        this.browserPanel?.updateUrl(p.frame.url);
      }
    } else if (method === 'Page.navigatedWithinDocument') {
      const p = params as { url?: string };
      if (p.url) {
        this.currentUrl = p.url;
        this.browserPanel?.updateTitle(p.url);
        this.browserPanel?.updateUrl(p.url);
      }
    } else if (method === 'Runtime.consoleAPICalled') {
      this.consoleCollector.handleEvent(params as Parameters<ConsoleCollector['handleEvent']>[0]);
    } else if (method === 'Network.responseReceived') {
      this.networkCollector.handleResponse(params as Parameters<NetworkCollector['handleResponse']>[0]);
    } else if (method === 'Network.loadingFailed') {
      this.networkCollector.handleLoadingFailed(
        params as Parameters<NetworkCollector['handleLoadingFailed']>[0],
      );
    } else if (method === 'Overlay.inspectNodeRequested') {
      const p = params as { backendNodeId: number };
      this.elementPicker?.handleInspectNodeRequested(p.backendNodeId);
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
        if (!this.cdp) return;
        if (this.elementPicker?.isPicking) {
          this.cdp.getNodeForLocation(x, y)
            .then(result => this.elementPicker?.handleInspectNodeRequested(result.backendNodeId))
            .catch(err => log(`[Browser] Pick click failed — ${err instanceof Error ? err.message : String(err)}`));
          return;
        }
        this.cdp.dispatchMouseEvent('mousePressed', x, y, {
          button: jsButtonToCdp(button),
          clickCount,
          buttons,
        }).catch(err => log(`[Browser] Mouse down failed — ${err instanceof Error ? err.message : String(err)}`));
      });
      this.browserPanel.onMouseUp((x, y, button, buttons, clickCount) => {
        if (!this.cdp || this.elementPicker?.isPicking) return;
        this.cdp.dispatchMouseEvent('mouseReleased', x, y, {
          button: jsButtonToCdp(button),
          clickCount,
          buttons,
        }).catch(err => log(`[Browser] Mouse up failed — ${err instanceof Error ? err.message : String(err)}`));
      });
      this.browserPanel.onPaste((text) => {
        if (!this.cdp) return;
        this.cdp.insertText(text).catch(err =>
          log(`[Browser] Paste failed — ${err instanceof Error ? err.message : String(err)}`),
        );
      });
      this.browserPanel.onCopy(() => {
        if (!this.cdp) return;
        this.cdp.evaluate(GET_SELECTED_TEXT_EXPR, true)
          .then(result => {
            const text = typeof result.value === 'string' ? result.value : '';
            if (text) vscode.env.clipboard.writeText(text);
          })
          .catch(() => {});
      });
      this.browserPanel.onCut(() => {
        if (!this.cdp) return;
        this.cdp.evaluate(GET_SELECTED_TEXT_EXPR, true)
          .then(result => {
            const text = typeof result.value === 'string' ? result.value : '';
            if (!text) return;
            vscode.env.clipboard.writeText(text);
            this.cdp!.evaluate("document.execCommand('delete')", false).catch(() => {});
          })
          .catch(() => {});
      });
      this.browserPanel.onKey((key, code, text, keyCode) => {
        if (!this.cdp) return;
        const vk = keyCode || 0;
        if (text) {
          this.cdp.dispatchKeyEvent('keyDown', { key, code, text, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }).then(() =>
            this.cdp!.dispatchKeyEvent('keyUp', { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }),
          ).catch(() => {});
        } else {
          this.cdp.dispatchKeyEvent('rawKeyDown', { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }).then(() =>
            this.cdp!.dispatchKeyEvent('keyUp', { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }),
          ).catch(() => {});
        }
      });
      this.browserPanel.onScroll((deltaX, deltaY) => {
        if (!this.cdp) return;
        this.cdp.evaluate(`window.scrollBy(${Number(deltaX)}, ${Number(deltaY)})`).catch(() => {});
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
        if (!this.cdp) return;
        const button = buttons & 1 ? 'left' : buttons & 2 ? 'right' : buttons & 4 ? 'middle' : 'none' as const;
        this.cdp.dispatchMouseEvent('mouseMoved', x, y, { button, buttons }).catch(() => {});
        if (buttons > 0) return;
        this.cdp.evaluate(`(() => {
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
        if (!this.cdp) return;
        this.cdp.navigate(navUrl).catch((err) =>
          log(`[Browser] Navigate failed — ${err instanceof Error ? err.message : String(err)}`),
        );
      });
      this.browserPanel.onGoBack(() => {
        if (!this.cdp) return;
        this.cdp.evaluate('history.back()').catch((err) =>
          log(`[Browser] Back failed — ${err instanceof Error ? err.message : String(err)}`),
        );
      });
      this.browserPanel.onGoForward(() => {
        if (!this.cdp) return;
        this.cdp.evaluate('history.forward()').catch((err) =>
          log(`[Browser] Forward failed — ${err instanceof Error ? err.message : String(err)}`),
        );
      });
      this.browserPanel.onReload(() => {
        if (!this.cdp) return;
        this.cdp.evaluate('location.reload()').catch((err) =>
          log(`[Browser] Reload failed — ${err instanceof Error ? err.message : String(err)}`),
        );
      });
      this.browserPanel.onPickElement(() => {
        if (!this.elementPicker || this.elementPicker.isPicking) return;
        this.browserPanel?.setPickingState(true);
        this.elementPicker.startPicking()
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
    if (!this.cdpPort || !this.pageTargetId) {
      log('[Browser] Cannot open DevTools — no CDP port or page target');
      return;
    }

    if (this.pageSessionId && this.cdpSocket?.connected) {
      try {
        await this.cdpSocket.send('Target.detachFromTarget', { sessionId: this.pageSessionId });
      } catch (err) {
        log(`[Browser] Detach failed — ${err instanceof Error ? err.message : String(err)}`);
      }
      this.cdp = null;
      this.pageSessionId = null;
      this.elementPicker = null;
    }

    const devtoolsUrl = `http://127.0.0.1:${this.cdpPort}/devtools/inspector.html?ws=127.0.0.1:${this.cdpPort}/devtools/page/${this.pageTargetId}`;
    await vscode.env.openExternal(vscode.Uri.parse(devtoolsUrl));

    this.monitorDevToolsDisconnect(this.pageTargetId);
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
      this.pageSessionId = result.sessionId;

      const bridge = new CdpBridge(this.cdpSocket, this.pageSessionId);
      await bridge.enableDomains();
      await this.maskAutomation();
      this.cdp = bridge;
      this.elementPicker = new ElementPicker(bridge, this.consoleCollector, this.networkCollector);
      this.state = 'connected';

      await this.startScreencast(bridge);
    } catch (err) {
      log(`[Browser] Reattach failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async maskAutomation(): Promise<void> {
    if (!this.cdpSocket?.connected || !this.pageSessionId) return;
    try {
      await this.cdpSocket.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: `Object.defineProperty(navigator, 'webdriver', { get: () => false });` },
        this.pageSessionId,
      );
      const version = await this.cdpSocket.send('Browser.getVersion') as { userAgent: string };
      const cleanUA = version.userAgent.replace(/HeadlessChrome/g, 'Chrome');
      await this.cdpSocket.send(
        'Emulation.setUserAgentOverride',
        { userAgent: cleanUA },
        this.pageSessionId,
      );
    } catch (err) {
      log(`[Browser] Failed to mask automation — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async startScreencast(bridge: CdpBridge): Promise<void> {
    try {
      await bridge.startScreencast({
        format: 'jpeg',
        quality: 80,
        everyNthFrame: 1,
        maxWidth: 1920 * 2,
        maxHeight: 1080 * 2,
      });
    } catch (err) {
      log(`[Browser] Failed to start screencast — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async resizeViewport(width: number, height: number): Promise<void> {
    if (!this.cdp) return;
    await this.cdp.setViewport(width, height, 2);
    this.browserPanel?.updateViewport(width, height);
    await this.cdp.stopScreencast();
    await this.cdp.startScreencast({
      format: 'jpeg',
      quality: 80,
      everyNthFrame: 1,
      maxWidth: width * 2,
      maxHeight: height * 2,
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
    this.cdp = null;
    this.elementPicker = null;
    this.pageSessionId = null;
    this.pageTargetId = null;
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
