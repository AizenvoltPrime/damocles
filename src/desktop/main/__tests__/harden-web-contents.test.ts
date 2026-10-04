import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

vi.mock('electron', () => ({ protocol: {} }));

import { hardenWebContents, loadAppPage } from '../security';

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
