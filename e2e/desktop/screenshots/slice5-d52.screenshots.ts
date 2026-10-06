import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { OVERLAY_CHANNELS, type OverlayToast, type RasterArt } from '../../../src/desktop/preload/overlay-channels';
import type { NotificationBody } from '../../../src/desktop/preload/notifications';
import { badgeArt } from '../../../src/desktop/main/notification-art';
import { activeChat, expect, test } from '../support/fixtures';
import { readyOverlay } from '../support/overlay';
import { saveScreenshot, settled, THEMES } from '../support/screenshots';
import { NOTIFIER_URL, OVERLAY_URL, popupPage, popupWindowState, SHELL_URL } from '../support/shell';
import { chatInput, postFromWebview, setThemeSource } from '../support/ui';

// Sends main's art to the overlay page on main's own channel and catches the PNG it answers with (main ignores an id it
// did not issue), so the capture is exactly what the running app's rasterizer draws.
async function rasterize(app: ElectronApplication, art: RasterArt, id: string): Promise<Buffer> {
  await app.evaluate(({ webContents }, { url, request, answer, rasterId, rasterArt }) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
    const g = globalThis as unknown as { __rasters?: Map<string, string | null> };
    if (!g.__rasters) {
      const rasters = new Map<string, string | null>();
      g.__rasters = rasters;
      contents.ipc.on(answer, (_event, answeredId: string, png: Uint8Array | null) => {
        rasters.set(answeredId, png ? Buffer.from(png).toString('base64') : null);
      });
    }
    contents.send(request, { id: rasterId, art: rasterArt });
  }, { url: OVERLAY_URL, request: OVERLAY_CHANNELS.rasterize, answer: OVERLAY_CHANNELS.rasterized, rasterId: id, rasterArt: art });
  let png: string | null | undefined;
  await expect.poll(async () => (png = await app.evaluate((_electron, rasterId) => {
    const value = (globalThis as unknown as { __rasters: Map<string, string | null> }).__rasters.get(rasterId);
    return value === undefined ? 'pending' : value;
  }, id))).not.toBe('pending');
  expect(png).not.toBeNull();
  return Buffer.from(png!, 'base64');
}

function save(testInfo: TestInfo, name: string, png: Buffer): void {
  const dir = process.env.DAMOCLES_SCREENSHOT_DIR;
  const file = dir ? path.join(dir, `${name}.png`) : testInfo.outputPath(`${name}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
}

// Each badge on a taskbar-like app icon at 16 px, then magnified 8x without smoothing.
async function badgeSheet(page: Page, badges: Array<{ name: string; png: string }>): Promise<Buffer> {
  const dataUrl = await page.evaluate(async (list) => {
    const canvas = document.createElement('canvas');
    canvas.width = 20 + list.length * 180;
    canvas.height = 190;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = '12px sans-serif';
    for (const [column, entry] of list.entries()) {
      const image = new Image();
      image.src = `data:image/png;base64,${entry.png}`;
      await image.decode();
      const x = 20 + column * 180;
      context.fillStyle = '#202020';
      context.fillRect(x, 10, 48, 48);
      context.fillStyle = '#4cc2ff';
      context.fillRect(x + 8, 18, 32, 32);
      context.drawImage(image, x + 26, 36, 16, 16);
      context.imageSmoothingEnabled = false;
      context.drawImage(image, x + 60, 10, 128, 128);
      context.imageSmoothingEnabled = true;
      context.fillStyle = '#000000';
      context.fillText(entry.name, x, 165);
    }
    return canvas.toDataURL('image/png');
  }, badges);
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

function toast(id: string, body: NotificationBody): OverlayToast {
  return { id, at: Date.now() - 60_000, lifeMs: 12_000, remainingMs: 9_000, body };
}

test('D52: popups over the focused app window, captured from the primary screen', async ({ launch }, testInfo) => {
  const { app } = await launch();
  const tab = await activeChat(app);
  await expect(chatInput(tab)).toBeVisible();
  await app.evaluate(({ BrowserWindow }, url) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === url)!;
    win.maximize();
    win.show();
    win.focus();
  }, SHELL_URL);
  await expect.poll(() => app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === url)!.isFocused(), SHELL_URL)).toBe(true);

  // A real notice opens the popup window while the main window has focus; two kinds join it on its page.
  await postFromWebview(tab, { type: 'openSessionLog' });
  const popup = await popupPage(app);
  await expect(popup.getByTestId('overlay-toast')).toHaveCount(1);
  await app.evaluate(({ webContents }, { url, channel, list }) => {
    const target = webContents.getAllWebContents().find((contents) => contents.getURL() === url)!;
    for (const item of list) target.send(channel, item);
  }, {
    url: NOTIFIER_URL,
    channel: OVERLAY_CHANNELS.toast,
    list: [
      toast('s-done', { kind: 'done', chat: { project: { key: 'damocles', name: 'damocles' }, title: 'Compass: index Vue SFC' }, durationMs: 252_000 }),
      toast('s-approval', { kind: 'approval', chat: { project: { key: 'acme', name: 'acme' }, title: 'Rate-limit the /login route' }, summary: 'edit src/routes/auth.ts (+7 lines).' }),
    ],
  });
  await expect(popup.getByTestId('overlay-toast')).toHaveCount(3);
  await settled(popup);
  const windows = [
    await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === url)!.getBounds(), SHELL_URL),
    (await popupWindowState(app))!.bounds,
  ];
  // The screen holds other apps too; the capture keeps only the box around the app's two windows, inside the work area.
  const png = await app.evaluate(async ({ desktopCapturer, screen }, boxes) => {
    const display = screen.getPrimaryDisplay();
    const thumbnailSize = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
    const source = sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0]!;
    const area = display.workArea;
    const left = Math.max(area.x, Math.min(...boxes.map((box) => box.x)));
    const top = Math.max(area.y, Math.min(...boxes.map((box) => box.y)));
    const right = Math.min(area.x + area.width, Math.max(...boxes.map((box) => box.x + box.width)));
    const bottom = Math.min(area.y + area.height, Math.max(...boxes.map((box) => box.y + box.height)));
    const pixelsPerDip = source.thumbnail.getSize().width / display.bounds.width;
    const crop = {
      x: Math.round((left - display.bounds.x) * pixelsPerDip),
      y: Math.round((top - display.bounds.y) * pixelsPerDip),
      width: Math.round((right - left) * pixelsPerDip),
      height: Math.round((bottom - top) * pixelsPerDip),
    };
    return source.thumbnail.crop(crop).toPNG().toString('base64');
  }, windows);
  save(testInfo, 'd52-popups-over-focused-window', Buffer.from(png, 'base64'));
});

test('D52 desktop popups in Dark and Light, and the taskbar badges 1, 4 and 9+', async ({ launch }, testInfo) => {
  test.setTimeout(120_000);
  const { app } = await launch();
  const tab = await activeChat(app);
  await expect(chatInput(tab)).toBeVisible();
  const overlay = await readyOverlay(app);

  const badges: Array<{ name: string; png: string }> = [];
  let next = 0;
  for (const [label, name] of [['1', '1'], ['4', '4'], ['9+', '9plus']] as const) {
    const colors = { fill: '#cd333a', text: '#ffffff' };
    const single = await rasterize(app, badgeArt(label, 1, colors), `e2e-${next++}`);
    const double = await rasterize(app, badgeArt(label, 2, colors), `e2e-${next++}`);
    save(testInfo, `d52-badge-${name}`, single);
    save(testInfo, `d52-badge-${name}@2x`, double);
    badges.push({ name: `${label} @1x`, png: single.toString('base64') }, { name: `${label} @2x`, png: double.toString('base64') });
  }
  save(testInfo, 'd52-badges', await badgeSheet(overlay, badges));

  // A real popup opens the window (a notice), then the kinds are handed to its page.
  await postFromWebview(tab, { type: 'openSessionLog' });
  const popup = await popupPage(app);
  await expect(popup.getByTestId('overlay-toast')).toHaveCount(1);
  const chat = { project: { key: 'acme', name: 'acme' }, title: 'Rate-limit the /login route' };
  await app.evaluate(({ webContents }, { url, channel, list }) => {
    const target = webContents.getAllWebContents().find((contents) => contents.getURL() === url)!;
    for (const item of list) target.send(channel, item);
  }, {
    url: NOTIFIER_URL,
    channel: OVERLAY_CHANNELS.toast,
    list: [
      toast('s-done', { kind: 'done', chat: { project: { key: 'damocles', name: 'damocles' }, title: 'Compass: index Vue SFC' }, durationMs: 252_000 }),
      toast('s-question', { kind: 'question', chat: { project: { key: 'bks', name: 'bookshelf' }, title: 'OCR pipeline retries' }, summary: 'Retry on 5xx responses too, or only on timeouts?' }),
      toast('s-approval', { kind: 'approval', chat, summary: 'edit src/routes/auth.ts (+7 lines).' }),
    ],
  });
  await expect(popup.getByTestId('overlay-toasts-more')).toBeVisible();
  for (const theme of THEMES) {
    await setThemeSource(app, theme);
    await expect(popup.locator('body')).toHaveAttribute('data-vscode-theme-kind', `vscode-${theme}`);
    // The window is transparent over the desktop; the capture paints a desktop-like backdrop behind it.
    await popup.evaluate((dark) => {
      document.body.style.backgroundColor = dark ? '#1b2633' : '#c9d6e3';
    }, theme === 'dark');
    await settled(popup);
    await saveScreenshot(popup, testInfo, `d52-popup-${theme}`);
  }
});
