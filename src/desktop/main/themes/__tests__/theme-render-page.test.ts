import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeWindow {
  readonly options: { webPreferences: Record<string, unknown> };
  readonly webContents: { emit(event: string, ...args: unknown[]): boolean };
  destroyed: boolean;
  closedBeforeItsPage: boolean;
}
const fake = vi.hoisted(() => ({ session: undefined as unknown, partitions: [] as string[], windows: [] as FakeWindow[], loadFails: false }));

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
        this.pageDestroyed = true;
        this.destroy();
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
import { createThemeRenderSession, openThemeRenderPage, THEME_RENDER_PARTITION, themeRenderCsp } from '../theme-render-page';

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
}

beforeEach(() => {
  fake.session = new FakeSession();
  fake.partitions.length = 0;
  fake.windows.length = 0;
  fake.loadFails = false;
});

describe("the theme renderer's session", () => {
  it('answers the app scheme on its own in-memory partition, never on the default session, with no permission and no download', async () => {
    const session = createThemeRenderSession('/app', { themeRender: () => '<!DOCTYPE html>render', themeBlob: () => Promise.resolve(undefined) }) as unknown as FakeSession;
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
    page.close();
    page.close();
    expect(fake.windows[0]!.destroyed).toBe(true);
  });

  // WebContents.isFocused(), which every menu command calls on every WebContents, crashes main on an offscreen one whose window closed
  it('closes after its page on every path, never before it', async () => {
    fake.loadFails = true;
    await expect(openThemeRenderPage(THEME_RENDER_PAGE_URL, () => undefined)).rejects.toThrow('ERR_FAILED');
    fake.loadFails = false;
    await openThemeRenderPage(THEME_RENDER_PAGE_URL, () => undefined);
    fake.windows[1]!.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    (await openThemeRenderPage(THEME_RENDER_PAGE_URL, () => undefined)).close();
    expect(fake.windows.map((window) => [window.destroyed, window.closedBeforeItsPage])).toEqual([[true, false], [true, false], [true, false]]);
  });

  it('loads no media: a video is decoded from the bytes main feeds, never played', () => {
    expect(themeRenderCsp('n')).toBe("default-src 'none'; script-src 'nonce-n'; style-src app://damocles 'unsafe-inline'; img-src app://damocles data: blob:; font-src app://damocles; base-uri 'none'; form-action 'none';");
  });
});
