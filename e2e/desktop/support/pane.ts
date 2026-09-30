import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { expect, type ElectronApplication, type Page } from '@playwright/test';
import type { PaneState } from '../../../src/desktop/preload/pane-channels';
import { postFromWebview } from './ui';

export const PANE_URL = 'app://damocles/pane/index.html';

// System-wide installs only: the app runs on the hermetic home, so a per-user Chrome under the runner's profile is invisible to it.
export function systemChrome(): string | undefined {
  const candidates = process.platform === 'win32'
    ? [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)']].flatMap((root) => (root ? [
      path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ] : []))
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

/** The Windows program folders, which the browser launcher needs to find an installed Chrome by channel. */
export function chromeEnv(): Record<string, string> {
  return Object.fromEntries(['PROGRAMFILES', 'PROGRAMFILES(X86)', 'ProgramW6432'].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])));
}

export interface Site {
  readonly url: string;
  close(): Promise<void>;
}

/** A loopback site whose every path is a page titled by `titleOf(path)`, plus the routes in `extra`. */
export function startSite(titleOf: (pathname: string) => string, extra: Record<string, (res: http.ServerResponse) => void> = {}): Promise<Site> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    const route = extra[pathname];
    if (route) {
      route(res);
      return;
    }
    const title = titleOf(pathname).replace(/[<&]/g, '');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${title}</title><body style="margin:0;font:16px sans-serif"><h1 style="margin:24px">${title}</h1><button id="target" style="margin:24px;width:240px;height:120px">Pick me</button></body>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}

/** The window's pane view page, which renders the side browser pane's chrome. */
export async function panePage(app: ElectronApplication): Promise<Page> {
  const isPane = (p: Page): boolean => p.url() === PANE_URL;
  const page = app.windows().find(isPane) ?? await app.waitForEvent('window', { predicate: isPane });
  await page.waitForFunction(() => window.damoclesPane !== undefined);
  return page;
}

/** The pane state main publishes, read through the pane's own preload API. */
export async function paneState(app: ElectronApplication): Promise<PaneState> {
  const pane = await panePage(app);
  return pane.evaluate(() => window.damoclesPane!.getState());
}

// A cold Chrome profile can take well past the default expect timeout to launch.
export const PAGE_TIMEOUT = 90_000;

/**
 * Opens `url` in the chat's pane: the first page as the human's toolbar open does, later ones through the pane's
 * New page button and address field (a toolbar open navigates the chat's existing page). `newPageName` is the
 * button's accessible name in the current locale.
 */
export async function openPage(app: ElectronApplication, tab: Page, url: string, newPageName = 'New page'): Promise<void> {
  const before = (await paneState(app)).pages.length;
  if (before === 0) {
    await postFromWebview(tab, { type: 'openBrowser', url });
  } else {
    const pane = await panePage(app);
    await pane.getByRole('button', { name: newPageName }).first().click();
    await expect.poll(async () => (await paneState(app)).pages.length, { timeout: PAGE_TIMEOUT }).toBe(before + 1);
    const address = pane.locator('#pane-address');
    await expect(address).toBeFocused();
    await address.fill(url);
    await address.press('Enter');
  }
  await expect.poll(async () => (await paneState(app)).pages.some((page) => page.url === url && !page.loading), { timeout: PAGE_TIMEOUT }).toBe(true);
}

export interface ViewInfo {
  readonly url: string;
  readonly bounds: { x: number; y: number; width: number; height: number };
  readonly visible: boolean;
  readonly focused: boolean;
}

/** Every native view of the window, bottom to top, with its bounds, visibility and keyboard focus. */
export async function windowViews(app: ElectronApplication): Promise<ViewInfo[]> {
  return app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    return win.contentView.children.flatMap((view) => {
      if (!(view instanceof WebContentsView)) return [];
      const contents = view.webContents;
      return [{ url: contents.getURL(), bounds: view.getBounds(), visible: view.getVisible(), focused: contents.isFocused() }];
    });
  });
}

export function viewOf(views: readonly ViewInfo[], urlPart: string): ViewInfo | undefined {
  return views.find((view) => view.url.includes(urlPart));
}

/**
 * A mouse event on the pane view for a pointer at (x, y) in the window's content area, with the screen position a real
 * pointer would have. Playwright's page.mouse derives the screen position from the view's bounds, which main moves while
 * the divider drags, and on Linux it stops reaching a view the pointer has left.
 */
export async function paneMouse(app: ElectronApplication, type: 'mouseDown' | 'mouseMove' | 'mouseUp', x: number, y: number, held = type !== 'mouseUp'): Promise<void> {
  await app.evaluate(({ BrowserWindow, WebContentsView }, [kind, windowX, windowY, url, down]) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const view = win.contentView.children.find((v): v is Electron.WebContentsView => v instanceof WebContentsView && v.webContents.getURL() === url);
    if (!view) throw new Error('no pane view');
    const bounds = view.getBounds();
    const content = win.getContentBounds();
    view.webContents.sendInputEvent({
      type: kind as 'mouseDown' | 'mouseMove' | 'mouseUp',
      x: windowX! - bounds.x,
      y: windowY! - bounds.y,
      globalX: content.x + windowX!,
      globalY: content.y + windowY!,
      button: 'left',
      clickCount: 1,
      modifiers: down ? ['leftbuttondown'] : [],
    });
  }, [type, x, y, PANE_URL, held] as const);
}

/** Resizes the window's content area, as the user dragging its frame would. */
export async function setWindowContentSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(w!, h!);
  }, [width, height] as const);
}

/** Types `text` through Electron's native input path into whichever webContents has keyboard focus, as the OS would. */
export async function typeIntoFocused(app: ElectronApplication, text: string): Promise<void> {
  await app.evaluate(async ({ webContents }, chars) => {
    for (const char of chars) {
      const target = webContents.getFocusedWebContents();
      if (!target) throw new Error('no webContents has keyboard focus');
      target.sendInputEvent({ type: 'char', keyCode: char });
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }, text);
}

/**
 * Saves the window as the user sees it: the shell page with every visible native view painted over it at its bounds,
 * bottom to top. Composited in the shell page's own canvas, because capturePage sees one webContents at a time.
 */
export async function captureWindow(app: ElectronApplication, file: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow, WebContentsView }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const [width, height] = win.getContentSize() as [number, number];
    const layers = [{ data: (await win.webContents.capturePage()).toDataURL(), x: 0, y: 0, width, height }];
    for (const view of win.contentView.children) {
      if (!(view instanceof WebContentsView) || !view.getVisible()) continue;
      const bounds = view.getBounds();
      if (bounds.width === 0 || bounds.height === 0) continue;
      layers.push({ data: (await view.webContents.capturePage()).toDataURL(), ...bounds });
    }
    const script = `(async (layers, width, height) => {
      const scale = window.devicePixelRatio;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const context = canvas.getContext('2d');
      for (const layer of layers) {
        const image = new Image();
        image.src = layer.data;
        await image.decode();
        context.drawImage(image, layer.x * scale, layer.y * scale, layer.width * scale, layer.height * scale);
      }
      return canvas.toDataURL('image/png');
    })(${JSON.stringify(layers)}, ${width}, ${height})`;
    return (await win.webContents.executeJavaScript(script)) as string;
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(png.slice(png.indexOf(',') + 1), 'base64'));
}
