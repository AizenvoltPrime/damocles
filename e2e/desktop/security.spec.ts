import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, panelIdOf, test } from './support/fixtures';
import { writeUserSettings } from './support/hermetic';
import { openSettingsModal } from './support/settings';
import { NOTIFIER_URL, onMainWindow, OVERLAY_URL, overlayPage, popupPage, SHELL_URL, shellPage, shellState, THEME_RENDER_URL } from './support/shell';
import { openThemeEditor, writeTheme } from './support/themes';
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
    // calls into main are postMessage, setState, the init read, and hostAction and queueAction, which main takes only from a
    // remote chat, allowYolo, which main takes only from a remote chat page on a user gesture, and setModalOpen, a boolean main
    // takes only from a chat page's own frame (views.ts); the getters and on* listeners only read what main's init and pushes name
    expect(await tab.evaluate(() => Object.keys(window.damoclesBridge ?? {}).sort())).toEqual([
      'allowYolo',
      'getConnection',
      'getHost',
      'getHostNames',
      'getOffline',
      'getState',
      'hostAction',
      'onConnection',
      'onHost',
      'onHostNames',
      'onMessage',
      'postMessage',
      'queueAction',
      'setModalOpen',
      'setState',
    ]);

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
    await app.evaluate(({ BrowserWindow, webContents }, [id, shellUrl]) => {
      BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith(shellUrl))!.focus();
      webContents.getAllWebContents().find((w) => w.getURL().includes(`/panel/${id}/`))!.focus();
    }, [panelId, SHELL_URL] as const);
    const probe = await clipboard.probeFromPage(tab, 'copied by e2e');
    expect(probe.write).toBe('resolved');
    expect(probe.read).toBe('NotAllowedError');
    expect(await clipboard.readText(app)).toBe('copied by e2e');

    await recordOpenExternal(app);
    // the theme renderer's page opens and closes on its own, so it counts as no page a script opened
    const openPages = (): number => app.windows().filter((page) => !page.isClosed() && page.url() !== THEME_RENDER_URL).length;
    const windowsBefore = openPages();
    const opened = await tab.evaluate(() => window.open('https://example.invalid/popup') === null);
    expect(opened).toBe(true);
    await expect.poll(() => openedExternally(app)).toEqual(['https://example.invalid/popup']);
    expect(await tab.evaluate(() => window.open('app://damocles/webview/index.html') === null)).toBe(true);
    await expect.poll(() => desktop.output()).toContain('[security] denied window.open to "app://damocles/webview/index.html"');
    expect(openPages()).toBe(windowsBefore);

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

  test('only the theme editor dock and the overlay may list the installed fonts: queryLocalFonts is denied in chat pages, the shell and the popup window', async ({ home, launch }) => {
    const id = '5d0c1a4e-2b7d-4c1e-8a2f-5d6e7f809a1c';
    writeTheme(home, id, { schemaVersion: 1, id, name: 'Fonts', looks: { dark: { colors: { background: '#141413', panel: '#1f1e1c', text: '#ece8df', accent: '#d97757', success: '#7fb069', warning: '#f0b429', danger: '#f2555a', info: '#6a9bcc' } } } });
    const { app } = await launch();
    const tab = await activeChat(app);
    await expect(chatInput(tab)).toBeVisible();
    // Chromium answers a denied queryLocalFonts() with no fonts rather than an error, so the count and the permission state tell
    const query = (page: Page): Promise<{ readonly fonts: number | string; readonly state: string }> => page.evaluate(async () => {
      const fn = (window as unknown as { queryLocalFonts?: () => Promise<unknown[]> }).queryLocalFonts;
      const fonts = typeof fn !== 'function' ? 'absent' : await fn().then((list) => list.length, (err: unknown) => (err as Error).name);
      const state = await navigator.permissions.query({ name: 'local-fonts' as PermissionName }).then((status) => status.state, (err: unknown) => (err as Error).name);
      return { fonts, state };
    });
    const shell = await shellPage(app);
    // a notice opens the popup window, whose page runs the overlay's bundle and preload but is not the overlay view
    await postFromWebview(tab, { type: 'openSessionLog' });
    const popup = await popupPage(app);
    for (const page of [tab, shell, popup]) {
      const answer = await query(page);
      expect(answer.state, page.url()).toBe('denied');
      expect(typeof answer.fonts === 'number' ? answer.fonts : 0, page.url()).toBe(0);
    }

    // the overlay reads a theme's installed fonts for its export
    const overlay = await openSettingsModal(app, 'appearance');
    const shared = await query(overlay);
    expect(shared.state).toBe('granted');
    expect(shared.fonts as number).toBeGreaterThan(0);

    // Chromium refuses the list to a page that is not shown, so the dock is asked once main shows it
    const dock = await openThemeEditor(app, 'Fonts', { from: overlay });
    const answer = await query(dock);
    expect(answer.state).toBe('granted');
    expect(answer.fonts).toEqual(expect.any(Number));
    expect(answer.fonts as number).toBeGreaterThan(0);
  });

  test('custom theme CSS never enters a page\'s HTML: the preload sets it as text on the chat page and the shell only', async ({ home, launch }) => {
    const id = '6e1d2b5f-3c8e-4d2f-9b30-6e7f8091ab2d';
    const colors = { background: '#141413', panel: '#1f1e1c', text: '#ece8df', accent: '#d97757', success: '#7fb069', warning: '#f0b429', danger: '#f2555a', info: '#6a9bcc' };
    // stored as core stores it: only what the sanitizer keeps
    writeTheme(home, id, { schemaVersion: 1, id, name: 'Styled', looks: { dark: { colors } }, css: { transcript: 'p { color: rgb(1, 2, 3) }', sidebar: 'li { color: rgb(4, 5, 6) }', titlebar: 'span { color: rgb(7, 8, 9) }' } });
    writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': id });
    const { app } = await launch();
    const tab = await activeChat(app);
    await expect(chatInput(tab)).toBeVisible();
    const shell = await shellPage(app);
    const userStyle = (page: Page): Promise<{ readonly text: string; readonly attributes: string[]; readonly afterTrusted: boolean; readonly afterStylesheet: boolean } | null> => page.evaluate(() => {
      const style = document.getElementById('damocles-theme-user');
      if (!style) return null;
      const follows = (earlier: Element | null): boolean => earlier !== null && (earlier.compareDocumentPosition(style) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      return {
        text: style.textContent ?? '',
        attributes: [...style.attributes].map((attribute) => attribute.name),
        afterTrusted: follows(document.getElementById('damocles-host-trusted')),
        // after the page's stylesheet link, so the damocles-user layer is never declared before the stylesheet's own
        afterStylesheet: follows(document.querySelector('link[rel="stylesheet"]')),
      };
    });
    await expect.poll(async () => (await userStyle(tab))?.text ?? '').toContain('[data-theme-scope~="transcript"]');
    const chatStyle = (await userStyle(tab))!;
    expect(chatStyle.attributes).toEqual(['id']);
    expect(chatStyle.afterTrusted).toBe(true);
    expect(chatStyle.afterStylesheet).toBe(true);
    expect(chatStyle.text).toContain('p{color:rgb(1,2,3)}');
    expect(chatStyle.text).not.toMatch(/sidebar|titlebar|rgb\(4,5,6\)/);
    await expect.poll(async () => (await userStyle(shell))?.text ?? '').toContain('[data-theme-scope~="sidebar"]');
    const shellStyle = (await userStyle(shell))!;
    expect(shellStyle.attributes).toEqual(['id']);
    expect(shellStyle.afterTrusted).toBe(true);
    expect(shellStyle.afterStylesheet).toBe(true);
    expect(shellStyle.text).toContain('[data-theme-scope~="titlebar"]');
    expect(shellStyle.text).not.toMatch(/transcript|rgb\(1,2,3\)/);

    // the HTML main serves for each page carries the palette and never the custom CSS
    const pages = await app.evaluate(async ({ session }, urls) => {
      const out: Record<string, string> = {};
      for (const url of urls) out[url] = await (await session.defaultSession.fetch(url)).text();
      return out;
    }, [tab.url(), SHELL_URL, OVERLAY_URL, NOTIFIER_URL]);
    for (const [url, html] of Object.entries(pages)) {
      expect(html, url).toContain('damocles-host-theme');
      // each region's color in the stored and in the regenerated spelling
      expect(html, url).not.toMatch(/damocles-user|damocles-theme-user|rgb\(\s*1,\s*2,\s*3\s*\)|rgb\(\s*4,\s*5,\s*6\s*\)|rgb\(\s*7,\s*8,\s*9\s*\)/);
    }

    // trusted UI whole gets none: the overlay, the notifier and the theme editor dock
    const dock = await openThemeEditor(app, 'Styled');
    const overlay = await overlayPage(app);
    // the notifier's window exists once a popup shows: a notice for a chat with no conversation yet
    await postFromWebview(tab, { type: 'openSessionLog' });
    const notifier = await popupPage(app);
    for (const page of [overlay, dock, notifier]) {
      expect(await userStyle(page), page.url()).toBeNull();
      expect(await page.evaluate(() => [...document.querySelectorAll('style')].some((style) => (style.textContent ?? '').includes('damocles-user'))), page.url()).toBe(false);
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

    // the modal report, which dims the shell's chat gutter: main takes it from the chat page's own frame and from no other view
    for (const fromUrl of [SHELL_URL, OVERLAY_URL]) {
      await app.evaluate(({ webContents }, { targetId, from }) => {
        const all = webContents.getAllWebContents();
        const target = all.find((w) => w.getURL().includes(`/panel/${targetId}/`));
        const sender = all.find((w) => w.getURL() === from);
        if (!target || !sender) throw new Error('views not found');
        const event = { sender, senderFrame: sender.mainFrame, processId: sender.getProcessId(), frameId: sender.mainFrame.routingId, returnValue: undefined, reply: () => {} };
        target.ipc.emit('damocles:panel:modal', event, true);
      }, { targetId: chatId, from: fromUrl });
      await expect.poll(() => desktop.output()).toContain(`[views] panel ${chatId}: rejected damocles:panel:modal from "${fromUrl}"`);
      expect((await shellState(app)).chatModal).toBe(false);
    }
    // the same report from the chat page itself is taken, so the refusals above are the sender check's
    await chat.evaluate(() => window.damoclesBridge!.setModalOpen(true));
    await expect.poll(async () => (await shellState(app)).chatModal).toBe(true);
    await chat.evaluate(() => window.damoclesBridge!.setModalOpen(false));
    await expect.poll(async () => (await shellState(app)).chatModal).toBe(false);
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

  test('a second launch focuses the existing window and exits', async ({ launch, secondLaunch }) => {
    const { app } = await launch();
    await expect(chatInput(await activeChat(app))).toBeVisible();
    await onMainWindow(app, (win) => win.minimize());
    await expect.poll(() => onMainWindow(app, (win) => win.isMinimized())).toBe(true);
    // Read ahead of main's own handler, which restores the window: it must still be minimized when the second launch arrives.
    const minimizedOnArrival = app.evaluate(({ app: electronApp, BrowserWindow }, shellUrl) => new Promise<boolean>((resolve) => {
      electronApp.prependOnceListener('second-instance', () => resolve(BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith(shellUrl))!.isMinimized()));
    }), SHELL_URL);

    expect(await secondLaunch()).toBe(0);
    expect(await minimizedOnArrival).toBe(true);
    await expect.poll(() => onMainWindow(app, (win) => win.isMinimized())).toBe(false);
    // the theme renderer's offscreen window may come and go, so only windows showing the shell count
    expect(await app.evaluate(({ BrowserWindow }, shellUrl) => BrowserWindow.getAllWindows().filter((win) => win.webContents.getURL().startsWith(shellUrl)).length, SHELL_URL)).toBe(1);
  });
});
