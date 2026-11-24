import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeWindow {
  readonly options: { webPreferences: Record<string, unknown> };
  readonly webContents: { emit(event: string, ...args: unknown[]): boolean };
  destroyed: boolean;
  closedBeforeItsPage: boolean;
}
const fake = vi.hoisted(() => ({ session: undefined as unknown, partitions: [] as string[], windows: [] as FakeWindow[], loadFails: false, holdClose: false, frame: undefined as unknown }));

// the frame a capture takes; offscreen-frame.test.ts covers how it is waited for
vi.mock('../offscreen-frame', () => ({ freshFrames: () => ({ resize: () => undefined, fresh: async () => fake.frame }) }));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class BrowserWindow extends Emitter {
    private pageDestroyed = false;
    readonly webContents = Object.assign(new Emitter(), {
      setWebRTCIPHandlingPolicy: vi.fn(),
      loadURL: vi.fn(async () => {
        if (fake.loadFails) throw new Error('ERR_FAILED');
      }),
      executeJavaScript: vi.fn(),
      isDestroyed: () => this.pageDestroyed,
      // Electron's order: the WebContents goes, then BrowserWindow::WebContentsDestroyed closes the window
      close: () => {
        if (fake.holdClose) return;
        this.pageDestroyed = true;
        this.destroy();
        this.webContents.emit('destroyed');
      },
    });
    readonly options: { webPreferences: Record<string, unknown> };
    destroyed = false;
    closedBeforeItsPage = false;
    constructor(options: { webPreferences: Record<string, unknown> }) {
      super();
      this.options = options;
      fake.windows.push(this);
    }
    setContentSize(): void {}
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      if (this.destroyed) return;
      this.closedBeforeItsPage = !this.pageDestroyed;
      this.destroyed = true;
      this.emit('closed');
    }
  }
  return {
    BrowserWindow,
    session: {
      fromPartition: (partition: string) => {
        fake.partitions.push(partition);
        return fake.session;
      },
    },
    protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  };
});

import { protocol } from 'electron';
import { THEME_RENDER_PAGE_URL } from '../../protocol';
import { HOST_THEME_STYLE_ID, HOST_THEME_USER_STYLE_ID, HOST_TRUSTED_STYLE_ID } from '../../../../shared/host-theme';
import { THEME_RENDER_PARTITION } from '../../../preload/page-paths';
import { createThemeRenderSession, openThemeRenderPage, themeRenderCsp, themeRenderHtml } from '../theme-render-page';

class FakeSession extends EventEmitter {
  handler: ((request: Request) => Promise<Response>) | undefined;
  readonly protocol = {
    handle: vi.fn((_scheme: string, handler: (request: Request) => Promise<Response>) => {
      this.handler = handler;
    }),
  };
  readonly setPermissionRequestHandler = vi.fn();
  readonly setPermissionCheckHandler = vi.fn();
  readonly setDevicePermissionHandler = vi.fn();
  beforeRequest: ((details: { url: string }, answer: (verdict: { cancel: boolean }) => void) => void) | undefined;
  readonly webRequest = {
    onBeforeRequest: vi.fn((listener: FakeSession['beforeRequest']) => {
      this.beforeRequest = listener;
    }),
  };
}

beforeEach(() => {
  fake.session = new FakeSession();
  fake.partitions.length = 0;
  fake.windows.length = 0;
  fake.loadFails = false;
  fake.holdClose = false;
});

describe("the theme renderer's session", () => {
  it('answers the app scheme on its own in-memory partition, never on the default session, with no permission and no download', async () => {
    const session = createThemeRenderSession('/app', { themeRender: () => '<!DOCTYPE html>render', themeBlob: () => Promise.resolve(undefined), themeCache: () => Promise.resolve(undefined) }) as unknown as FakeSession;
    expect(fake.partitions).toEqual([THEME_RENDER_PARTITION]);
    expect(THEME_RENDER_PARTITION.startsWith('persist:')).toBe(false);
    expect(session.protocol.handle).toHaveBeenCalledWith('app', expect.any(Function));
    expect(protocol.handle).not.toHaveBeenCalled();
    expect(await (await session.handler!(new Request(THEME_RENDER_PAGE_URL))).text()).toBe('<!DOCTYPE html>render');
    expect(session.setPermissionRequestHandler).toHaveBeenCalledOnce();
    expect(session.setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(session.setDevicePermissionHandler).toHaveBeenCalledOnce();
    const download = { preventDefault: vi.fn() };
    session.emit('will-download', download);
    expect(download.preventDefault).toHaveBeenCalledOnce();
  });

  it('cancels every request but the app origin and its own data and blob URLs, so nothing reaches the network', () => {
    const session = createThemeRenderSession('/app', { themeRender: () => '', themeBlob: () => Promise.resolve(undefined), themeCache: () => Promise.resolve(undefined) }) as unknown as FakeSession;
    expect(session.webRequest.onBeforeRequest).toHaveBeenCalledOnce();
    const cancelled = (url: string): boolean => {
      let verdict: { cancel: boolean } | undefined;
      session.beforeRequest!({ url }, (answer) => {
        verdict = answer;
      });
      return verdict!.cancel;
    };
    for (const url of [THEME_RENDER_PAGE_URL, `app://damocles/theme-blob/${'a'.repeat(64)}`, 'data:image/png;base64,AAAA', 'blob:app://damocles/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed']) expect(cancelled(url), url).toBe(false);
    for (const url of ['https://example.com/x.png', 'http://127.0.0.1:8080/', 'wss://example.com/', 'file:///etc/passwd', 'app://damocles.example.com/x', 'app://other/x', 'devtools://devtools/', 'about:blank']) expect(cancelled(url), url).toBe(true);
  });

  it("is the session the renderer's window loads its page in", async () => {
    await openThemeRenderPage(THEME_RENDER_PAGE_URL, () => undefined);
    expect(fake.windows).toHaveLength(1);
    expect(fake.windows[0]!.options.webPreferences).toMatchObject({ partition: THEME_RENDER_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(fake.windows[0]!.options.webPreferences['preload']).toBeUndefined();
  });
});

describe("the theme renderer's window", () => {
  it('is destroyed when its page does not load, so no hidden window is left that nothing can close', async () => {
    fake.loadFails = true;
    await expect(openThemeRenderPage(THEME_RENDER_PAGE_URL, () => undefined)).rejects.toThrow('ERR_FAILED');
    expect(fake.windows).toHaveLength(1);
    expect(fake.windows[0]!.destroyed).toBe(true);
  });

  it('is destroyed when its renderer ends, after the job running on it was told why', async () => {
    const reasons: string[] = [];
    await openThemeRenderPage(THEME_RENDER_PAGE_URL, (reason) => reasons.push(reason));
    fake.windows[0]!.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(reasons[0]).toBe('crashed');
    expect(fake.windows[0]!.destroyed).toBe(true);
  });

  it('is destroyed by its close, once', async () => {
    const page = await openThemeRenderPage(THEME_RENDER_PAGE_URL, () => undefined);
    await page.close();
    // a page already gone answers at once
    await page.close();
    expect(fake.windows[0]!.destroyed).toBe(true);
  });

  it("answers its close only when its page's destroyed event fires", async () => {
    const page = await openThemeRenderPage(THEME_RENDER_PAGE_URL, () => undefined);
    fake.holdClose = true;
    let gone = false;
    const closed = page.close().then(() => {
      gone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(gone).toBe(false);
    fake.windows[0]!.webContents.emit('destroyed');
    await closed;
    expect(gone).toBe(true);
  });

  // WebContents.isFocused(), which every menu command calls on every WebContents, crashes main on an offscreen one whose window closed
  it('closes after its page on every path, never before it', async () => {
    fake.loadFails = true;
    await expect(openThemeRenderPage(THEME_RENDER_PAGE_URL, () => undefined)).rejects.toThrow('ERR_FAILED');
    fake.loadFails = false;
    await openThemeRenderPage(THEME_RENDER_PAGE_URL, () => undefined);
    fake.windows[1]!.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    await (await openThemeRenderPage(THEME_RENDER_PAGE_URL, () => undefined)).close();
    expect(fake.windows.map((window) => [window.destroyed, window.closedBeforeItsPage])).toEqual([[true, false], [true, false], [true, false]]);
  });

  it('loads no media, and takes scripts and style elements only by nonce: a video is decoded from the bytes main feeds, never played', () => {
    expect(themeRenderCsp('n')).toBe("default-src 'none'; script-src 'nonce-n'; style-src-elem app://damocles 'nonce-n'; style-src-attr 'unsafe-inline'; img-src app://damocles data: blob:; font-src app://damocles; base-uri 'none'; form-action 'none';");
  });

  it("carries the host theme, trusted and user style elements, empty, after the stylesheet and under the page's nonce", () => {
    const html = themeRenderHtml();
    const nonce = /script-src 'nonce-([^']+)'/.exec(html)?.[1];
    expect(nonce).toBeDefined();
    const styles = [...html.matchAll(/<style id="([^"]+)" nonce="([^"]+)"><\/style>/g)].map((match) => [match[1], match[2]]);
    expect(styles).toEqual([[HOST_THEME_STYLE_ID, nonce], [HOST_TRUSTED_STYLE_ID, nonce], [HOST_THEME_USER_STYLE_ID, nonce]]);
    expect(html.match(/<style/g)).toHaveLength(3);
    expect(html.indexOf('theme-render.css')).toBeLessThan(html.indexOf(HOST_THEME_STYLE_ID));
    expect(html).toContain(`<script nonce="${nonce}" type="module"`);
    expect(/script-src 'nonce-([^']+)'/.exec(themeRenderHtml())?.[1]).not.toBe(nonce);
  });

  it("captures a crop of the frame, at the frame's own pixels", async () => {
    const page = await openThemeRenderPage(THEME_RENDER_PAGE_URL, () => undefined);
    const region = { x: 0, y: 40, width: 280, height: 760 };
    const png = new Uint8Array([1]);
    const frame = { crop: vi.fn(() => ({ toPNG: () => png })), toPNG: vi.fn() };
    fake.frame = frame;
    expect(await page.capture(1280, 800, region)).toEqual(png);
    expect(frame.crop).toHaveBeenCalledWith(region);
    expect(frame.toPNG).not.toHaveBeenCalled();
  });
});
