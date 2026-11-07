import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

vi.mock('electron', () => ({ protocol: {} }));

import { hardenWebContents, loadAppPage, registerDesignContents } from '../security';

function contents(): EventEmitter & { openHandler?: (details: { url: string }) => { action: string }; loadURL: () => Promise<void> } {
  const fake = Object.assign(new EventEmitter(), {
    loadURL: async () => undefined,
    setWindowOpenHandler: (handler: (details: { url: string }) => { action: string }) => {
      fake.openHandler = handler;
    },
  }) as EventEmitter & { openHandler?: (details: { url: string }) => { action: string }; loadURL: () => Promise<void> };
  return fake;
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('hardenWebContents', () => {
  it('keeps a design view within its own view-token origin and opens nothing outside, registered after construction (PD-7)', () => {
    const web = contents();
    const opened: string[] = [];
    // app.on('web-contents-created') hardens the contents as it is built, before the view registers it
    hardenWebContents(web as unknown as WebContents, async (url) => {
      opened.push(url);
      return true;
    }, () => undefined);
    registerDesignContents(web as unknown as WebContents, 'damocles-design://0123456789abcdef0123456789abcdef');

    const navigation = (url: string) => ({ url, preventDefault: vi.fn() });
    const sameOrigin = navigation('damocles-design://0123456789abcdef0123456789abcdef/screens/S2.html');
    const otherView = navigation('damocles-design://fedcba9876543210fedcba9876543210/screens/S1.html');
    const web1 = navigation('https://example.com/');
    const file = navigation('file:///C:/Windows/win.ini');
    const app = navigation('app://damocles/shell/index.html');
    web.emit('will-navigate', sameOrigin);
    for (const event of [otherView, web1, file, app]) web.emit('will-navigate', event);
    const redirect = navigation('https://example.com/');
    web.emit('will-redirect', redirect);

    expect(sameOrigin.preventDefault).not.toHaveBeenCalled();
    for (const event of [otherView, web1, file, app, redirect]) expect(event.preventDefault, event.url).toHaveBeenCalled();
    expect(web.openHandler!({ url: 'https://example.com/' })).toEqual({ action: 'deny' });
    expect(web.openHandler!({ url: 'damocles-design://0123456789abcdef0123456789abcdef/screens/S2.html' })).toEqual({ action: 'deny' });
    expect(opened).toEqual([]);
  });

  it('logs a design view\'s blocked navigations once, so a page navigating away in a loop cannot flood the log', () => {
    const first = contents();
    const second = contents();
    const lines: string[] = [];
    for (const [web, token] of [[first, 'a'.repeat(32)], [second, 'b'.repeat(32)]] as const) {
      hardenWebContents(web as unknown as WebContents, async () => true, (line) => lines.push(line));
      registerDesignContents(web as unknown as WebContents, `damocles-design://${token}`);
    }
    const blocked = Array.from({ length: 50 }, () => ({ url: 'https://example.com/', preventDefault: vi.fn() }));
    for (const event of blocked) first.emit('will-navigate', event);
    second.emit('will-redirect', { url: 'https://example.com/', preventDefault: vi.fn() });
    expect(blocked.every((event) => event.preventDefault.mock.calls.length === 1)).toBe(true);
    expect(lines).toHaveLength(2);
  });

  it('judges a navigation by the event url, allowing only the page main loaded', async () => {
    const web = contents();
    const opened: string[] = [];
    hardenWebContents(web as unknown as WebContents, async (url) => {
      opened.push(url);
      return true;
    }, () => undefined);
    await loadAppPage(web as unknown as WebContents, 'app://damocles/panel/a/index.html');

    const reload = { url: 'app://damocles/panel/a/index.html', preventDefault: vi.fn() };
    const away = { url: 'https://example.test/', preventDefault: vi.fn() };
    const redirect = { url: 'app://damocles/webview/index.html', preventDefault: vi.fn() };
    web.emit('will-navigate', reload);
    web.emit('will-navigate', away);
    web.emit('will-redirect', redirect);

    expect(reload.preventDefault).not.toHaveBeenCalled();
    expect(away.preventDefault).toHaveBeenCalled();
    expect(redirect.preventDefault).toHaveBeenCalled();
    expect(opened).toEqual(['https://example.test/']);
  });

  it('locks the overlay page to its own URL and refuses a <webview> in it', async () => {
    const web = contents();
    hardenWebContents(web as unknown as WebContents, async () => true, () => undefined);
    await loadAppPage(web as unknown as WebContents, 'app://damocles/overlay/index.html');

    const reload = { url: 'app://damocles/overlay/index.html', preventDefault: vi.fn() };
    const shell = { url: 'app://damocles/shell/index.html', preventDefault: vi.fn() };
    const attach = { preventDefault: vi.fn() };
    web.emit('will-navigate', reload);
    web.emit('will-navigate', shell);
    web.emit('will-attach-webview', attach);

    expect(reload.preventDefault).not.toHaveBeenCalled();
    expect(shell.preventDefault).toHaveBeenCalled();
    expect(attach.preventDefault).toHaveBeenCalled();
  });

  it('logs a link the OS could not open instead of leaving an unhandled rejection', async () => {
    const web = contents();
    const lines: string[] = [];
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    hardenWebContents(web as unknown as WebContents, () => Promise.reject(new Error('no xdg-open')), (line) => lines.push(line));

    expect(web.openHandler!({ url: 'https://example.test/popup' })).toEqual({ action: 'deny' });
    web.emit('will-navigate', { url: 'https://example.test/nav', preventDefault: () => undefined });
    await flush();
    process.off('unhandledRejection', unhandled);

    expect(unhandled).not.toHaveBeenCalled();
    expect(lines.filter((line) => line.includes('no xdg-open'))).toHaveLength(2);
  });
});
