import { spawn } from 'node:child_process';
import type { ElectronApplication, Page } from '@playwright/test';
import { MAIN_SCRIPT } from './support/app';
import { activeChat, expect, panelIdOf, test } from './support/fixtures';
import { hermeticEnv } from './support/hermetic';
import { NOTIFIER_URL, OVERLAY_URL, overlayPage, popupPage, SHELL_URL, shellPage } from './support/shell';
import { chatInput, postFromWebview } from './support/ui';

// Records shell.openExternal in main instead of launching the OS browser.
async function recordOpenExternal(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __e2eOpened: string[] };
    g.__e2eOpened = [];
    shell.openExternal = ((url: string) => {
      g.__e2eOpened.push(url);
      return Promise.resolve();
    }) as typeof shell.openExternal;
  });
}

async function openedExternally(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { __e2eOpened: string[] }).__e2eOpened);
}

async function markDocument(tab: Page): Promise<void> {
  await tab.evaluate(() => {
    (window as unknown as { __e2eMarker: boolean }).__e2eMarker = true;
  });
}

async function documentSurvived(tab: Page): Promise<boolean> {
  return tab.evaluate(() => (window as unknown as { __e2eMarker?: boolean }).__e2eMarker === true);
}

test.describe('renderer security at runtime', () => {
  test('webPreferences, permission handlers, window.open, navigation lock and app:// containment', async ({ clipboard, launch }) => {
    // Without a capture device Chromium fails getUserMedia with NotFoundError before it asks the permission handler.
    const desktop = await launch({ args: ['--use-fake-device-for-media-stream'] });
    const { app } = desktop;
    const tab = await activeChat(app);
    await expect(chatInput(tab)).toBeVisible();
    const panelId = panelIdOf(tab);
    // The popup window and its view exist only once a popup shows: a notice for a chat with no conversation yet.
    await postFromWebview(tab, { type: 'openSessionLog' });
    await popupPage(app);

    const prefs = await app.evaluate(({ webContents, BrowserWindow }, pages) => {
      const views = webContents.getAllWebContents().filter((w) => w.getURL().startsWith('app://damocles/panel/') || pages.includes(w.getURL()));
      const windows = BrowserWindow.getAllWindows().map((w) => w.webContents);
      // Undocumented and absent from electron.d.ts, but it is how Electron's own spec suite reads applied preferences.
      type Prefs = { contextIsolation?: boolean; nodeIntegration?: boolean; sandbox?: boolean; webviewTag?: boolean };
      return [...views, ...windows].map((w) => {
        const p = (w as unknown as { getLastWebPreferences(): Prefs | null }).getLastWebPreferences();
        return { url: w.getURL(), contextIsolation: p?.contextIsolation, nodeIntegration: p?.nodeIntegration, sandbox: p?.sandbox, webviewTag: p?.webviewTag };
      });
    }, [OVERLAY_URL, NOTIFIER_URL]);
    expect(prefs.length).toBeGreaterThanOrEqual(3);
    expect(prefs.map((p) => p.url)).toContain(NOTIFIER_URL);
    for (const p of prefs) expect(p, p.url).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true });
    for (const p of prefs) expect(p.webviewTag, p.url).not.toBe(true);
    if (process.platform !== 'linux') {
      // OS-level sandbox of the tab's renderer process; Electron reports it on Windows and macOS only.
      const sandboxed = await app.evaluate(({ app: electronApp, webContents }, id) => {
        const pid = webContents.getAllWebContents().find((w) => w.getURL().includes(`/panel/${id}/`))!.getOSProcessId();
        return electronApp.getAppMetrics().find((m) => m.pid === pid)?.sandboxed;
      }, panelId);
      expect(sandboxed).toBe(true);
    }

    // The renderer has no Node and only the bridge crosses the isolation boundary.
    expect(await tab.evaluate(() => [typeof (window as unknown as { require?: unknown }).require, typeof (window as unknown as { process?: unknown }).process])).toEqual(['undefined', 'undefined']);
    expect(await tab.evaluate(() => Object.keys(window.damoclesBridge ?? {}).sort())).toEqual(['getState', 'onMessage', 'postMessage', 'setState']);

    // Deny-all permission handlers: request and check paths both refuse.
    const permissions = await tab.evaluate(async () => {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true }).then(
        () => 'granted',
        (e: unknown) => (e as Error).name,
      );
      const notification = await Notification.requestPermission();
      const query = (await navigator.permissions.query({ name: 'geolocation' })).state;
      return { media, notification, query };
    });
    expect(permissions.media).toBe('NotAllowedError');
    expect(permissions.notification).toBe('denied');
    expect(permissions.query).toBe('denied');

    // Only sanitized clipboard writes are allowed (copy buttons); reading the clipboard stays denied.
    await app.evaluate(({ BrowserWindow, webContents }, id) => {
      BrowserWindow.getAllWindows()[0]!.focus();
      webContents.getAllWebContents().find((w) => w.getURL().includes(`/panel/${id}/`))!.focus();
    }, panelId);
    const probe = await clipboard.probeFromPage(tab, 'copied by e2e');
    expect(probe.write).toBe('resolved');
    expect(probe.read).toBe('NotAllowedError');
    expect(await clipboard.readText(app)).toBe('copied by e2e');

    await recordOpenExternal(app);
    const windowsBefore = app.windows().length;
    const opened = await tab.evaluate(() => window.open('https://example.invalid/popup') === null);
    expect(opened).toBe(true);
    await expect.poll(() => openedExternally(app)).toEqual(['https://example.invalid/popup']);
    expect(await tab.evaluate(() => window.open('app://damocles/webview/index.html') === null)).toBe(true);
    await expect.poll(() => desktop.output()).toContain('[security] denied window.open to "app://damocles/webview/index.html"');
    expect(app.windows().length).toBe(windowsBefore);

    await markDocument(tab);
    await tab.evaluate(() => {
      location.href = 'app://damocles/webview/index.html';
    });
    await expect.poll(() => desktop.output()).toContain('[security] blocked navigation to "app://damocles/webview/index.html"');
    await tab.evaluate(() => {
      location.href = 'https://example.invalid/navigate';
    });
    await expect.poll(() => openedExternally(app)).toContain('https://example.invalid/navigate');
    expect(await documentSurvived(tab)).toBe(true);
    expect(tab.url()).toBe(`app://damocles/panel/${panelId}/index.html`);

    const statuses = await app.evaluate(async ({ session }, urls) => {
      const out: Record<string, { status: number; body: string }> = {};
      for (const url of urls) {
        const res = await session.defaultSession.fetch(url);
        out[url] = { status: res.status, body: (await res.text()).slice(0, 200) };
      }
      return out;
    }, [
      'app://damocles/webview/index.html',
      'app://damocles/webview/../../package.json',
      'app://damocles/webview/%2e%2e/%2e%2e/package.json',
      'app://damocles/webview/..%2f..%2fpackage.json',
      'app://damocles/webview/%2e%2e%2f%2e%2e%2fpackage.json',
      'app://damocles/webview/..%5c..%5cpackage.json',
      'app://damocles/webview/%252e%252e%252fpackage.json',
      'app://damocles/package.json',
      'app://damocles/panel/../../package.json',
    ]);
    // The built index.html has no CSP; every page the app shows is generated in memory under one.
    for (const [url, res] of Object.entries(statuses)) {
      expect(res.status, url).toBe(404);
      expect(res.body, url).not.toContain('"name": "damocles"');
    }
  });

  test('IPC sent to a chat channel from another view is rejected', async ({ launch }) => {
    const desktop = await launch();
    const { app } = desktop;
    const chat = await activeChat(app);
    await expect(chatInput(chat)).toBeVisible();
    const chatId = panelIdOf(chat);

    // Each view's messages reach only its own webContents.ipc. A message from the shell or the overlay view delivered to
    // the chat's handler anyway carries that view's real sender and frame, and the sender check refuses it.
    for (const fromUrl of [SHELL_URL, OVERLAY_URL]) {
      const delivered = await app.evaluate(({ webContents }, { targetId, from }) => {
        const all = webContents.getAllWebContents();
        const target = all.find((w) => w.getURL().includes(`/panel/${targetId}/`));
        const sender = all.find((w) => w.getURL() === from);
        if (!target || !sender) throw new Error('views not found');
        const event = { sender, senderFrame: sender.mainFrame, processId: sender.getProcessId(), frameId: sender.mainFrame.routingId, returnValue: undefined, reply: () => {} };
        return target.ipc.emit('damocles:panel:post', event, { type: 'sendMessage', content: 'injected from another view' });
      }, { targetId: chatId, from: fromUrl });
      expect(delivered).toBe(true);
      await expect.poll(() => desktop.output()).toContain(`[views] panel ${chatId}: rejected damocles:panel:post from "${fromUrl}"`);
    }
    await expect(chat.getByText('injected from another view')).toHaveCount(0);
  });

  test('the overlay page has only its own bridge, and its channels refuse every other view', async ({ launch }) => {
    const desktop = await launch();
    const { app } = desktop;
    const chat = await activeChat(app);
    await expect(chatInput(chat)).toBeVisible();
    const overlay = await overlayPage(app);
    expect(await overlay.evaluate(() => ({ shell: typeof window.damoclesShell, panel: typeof window.damoclesBridge, overlay: typeof window.damoclesOverlay }))).toEqual({ shell: 'undefined', panel: 'undefined', overlay: 'object' });
    expect(await chat.evaluate(() => typeof (window as { damoclesOverlay?: unknown }).damoclesOverlay)).toBe('undefined');
    const csp = await overlay.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '');
    expect(csp).toMatch(/^default-src 'none'; style-src app:\/\/damocles 'unsafe-inline'; script-src 'nonce-[^']+'; font-src app:\/\/damocles; img-src app:\/\/damocles data:; base-uri 'none'; form-action 'none';$/);

    const delivered = await app.evaluate(({ webContents }, { overlayUrl, fromId }) => {
      const all = webContents.getAllWebContents();
      const target = all.find((w) => w.getURL() === overlayUrl);
      const sender = all.find((w) => w.getURL().includes(`/panel/${fromId}/`));
      if (!target || !sender) throw new Error('views not found');
      const event = { sender, senderFrame: sender.mainFrame, processId: sender.getProcessId(), frameId: sender.mainFrame.routingId, returnValue: undefined, reply: () => {} };
      return target.ipc.emit('damocles:overlay:answer', event, 'forged-id', { kind: 'dismissed' });
    }, { overlayUrl: OVERLAY_URL, fromId: panelIdOf(chat) });
    expect(delivered).toBe(true);
    await expect.poll(() => desktop.output()).toContain(`[overlay] rejected damocles:overlay:answer from "app://damocles/panel/${panelIdOf(chat)}/index.html"`);
  });

  test('the window page opens the application menu only for a click main saw', async ({ launch }) => {
    const desktop = await launch();
    const { app } = desktop;
    await expect(chatInput(await activeChat(app))).toBeVisible();
    // Records each popup instead of opening the native menu, whose modal loop would hold the test.
    await app.evaluate(({ Menu }) => {
      const g = globalThis as unknown as { __e2eMenuPopups: number };
      g.__e2eMenuPopups = 0;
      Menu.prototype.popup = function popup(this: unknown) {
        g.__e2eMenuPopups++;
      };
    });
    const popups = (): Promise<number> => app.evaluate(() => (globalThis as unknown as { __e2eMenuPopups: number }).__e2eMenuPopups);
    const shell = await shellPage(app);

    await shell.evaluate(() => window.damoclesShell!.openAppMenu({ x: 0, y: 0 }));
    expect(await popups()).toBe(0);
    await expect.poll(() => desktop.output()).toContain('[shell] not opening the application menu: no click or key of the user asked for it');

    await shell.getByTestId('app-menu').click();
    await expect.poll(popups).toBe(1);
    await shell.evaluate(() => window.damoclesShell!.openAppMenu({ x: 0, y: 0 }));
    expect(await popups()).toBe(1);
  });

  test('the unpackaged app has its own name, neither "Electron" nor the installed app\'s', async ({ launch }) => {
    const { app } = await launch();
    expect(await app.evaluate(({ app: electronApp }) => electronApp.getName())).toBe('damocles-dev');
  });

  test('a second launch focuses the existing window and exits', async ({ home, launch }) => {
    const { app } = await launch();
    await expect(chatInput(await activeChat(app))).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.minimize());
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized())).toBe(true);
    // Read ahead of main's own handler, which restores the window: it must still be minimized when the second launch arrives.
    const minimizedOnArrival = app.evaluate(({ app: electronApp, BrowserWindow }) => new Promise<boolean>((resolve) => {
      electronApp.prependOnceListener('second-instance', () => resolve(BrowserWindow.getAllWindows()[0]!.isMinimized()));
    }));

    const electronBinary = (await import('electron')).default as unknown as string;
    const child = spawn(electronBinary, [MAIN_SCRIPT, '--user-data-dir', home.userData], { env: hermeticEnv(home), stdio: 'ignore' });
    const exitCode = await new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    expect(exitCode).toBe(0);
    expect(await minimizedOnArrival).toBe(true);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized())).toBe(false);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  });
});
