import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { OVERLAY_CHANNELS, type OverlayToast } from '../../../src/desktop/preload/overlay-channels';
import type { NotificationBody, NotificationCenterState } from '../../../src/desktop/preload/notifications';
import { activeChat, expect, test } from '../support/fixtures';
import { readyOverlay } from '../support/overlay';
import { saveScreenshot, setPageSize, settled, showTheme, THEMES } from '../support/screenshots';
import { NOTIFIER_URL, OVERLAY_URL, popupPage, shellPage } from '../support/shell';
import { chatInput, postFromWebview } from '../support/ui';

// Sends main's messages to one page on main's own channel, as main does.
async function sendTo(app: ElectronApplication, url: string, channel: string, payloads: readonly unknown[]): Promise<void> {
  await app.evaluate(({ webContents }, { target, name, list }) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === target)!;
    for (const payload of list) contents.send(name, payload);
  }, { target: url, name: channel, list: payloads });
}

// The overlay and the popup window are transparent; a capture paints the theme's background behind them.
async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.evaluate(() => {
    document.body.style.backgroundColor = 'var(--d-bg)';
  });
  await settled(page);
  await saveScreenshot(page, testInfo, name);
  await page.evaluate(() => {
    document.body.style.backgroundColor = '';
  });
}

const CHAT = { project: { key: 'acme', name: 'acme' }, title: 'Rate-limit the /login route' };

// A reset later today, and one three days on.
function resets(): { today: number; later: number } {
  const now = new Date();
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59).getTime();
  const later = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3, 9, 30).getTime();
  return { today: Math.min(Date.now() + 2 * 3_600_000, endOfToday), later };
}

test('D55 rate-limit pauses naming their window in the popups in Dark and Light, and a hovered center row in Light', async ({ foreground: _foreground, launch }, testInfo) => {
  test.setTimeout(120_000);
  const { app } = await launch();
  const tab = await activeChat(app);
  await expect(chatInput(tab)).toBeVisible();
  const shell = await shellPage(app);
  const overlay = await readyOverlay(app);
  const { today, later } = resets();
  const pauses: NotificationBody[] = [
    { kind: 'error', chat: CHAT, reason: 'rateLimit', windowLabel: 'Session (5hr)', resetsAt: today },
    { kind: 'error', chat: { project: { key: 'damocles', name: 'damocles' }, title: 'Compass: index Vue SFC' }, reason: 'rateLimit', windowLabel: 'Weekly', resetsAt: later },
  ];

  // A real notice opens the popup window, then makes way for the pauses, which go to its page as main sends them.
  await postFromWebview(tab, { type: 'openSessionLog' });
  const popup = await popupPage(app);
  await expect(popup.getByTestId('overlay-toast')).toHaveCount(1);
  await popup.getByTestId('overlay-toast-dismiss').click();
  await expect(popup.getByTestId('overlay-toast')).toHaveCount(0);
  const toasts = pauses.map((body, index): OverlayToast => ({ id: `s-pause-${index}`, at: Date.now() - 60_000, lifeMs: 12_000, remainingMs: 9_000, body }));
  await sendTo(app, NOTIFIER_URL, OVERLAY_CHANNELS.toast, toasts);
  await expect(popup.getByTestId('overlay-toast')).toHaveCount(2);
  await expect(popup.getByTestId('overlay-toast').first()).toContainText('The Session (5hr) limit was reached. Resets at');
  for (const theme of THEMES) {
    await showTheme(app, popup, theme);
    await capture(popup, testInfo, `d55-rate-limit-popups-${theme}`);
  }

  // The center under the bell, holding the pauses beside other kinds, with the pointer on a row.
  await setPageSize(overlay, 1280, 820);
  await showTheme(app, overlay, 'light');
  await shell.getByTestId('notification-bell').click();
  await expect(overlay.getByTestId('notification-center')).toBeVisible();
  const minutesAgo = (minutes: number): number => Date.now() - minutes * 60_000;
  const state: NotificationCenterState = {
    entries: [
      { id: 'e-pause-today', at: minutesAgo(1), read: false, body: pauses[0]! },
      { id: 'e-pause-later', at: minutesAgo(4), read: false, body: pauses[1]! },
      { id: 'e-approval', at: minutesAgo(9), read: false, body: { kind: 'approval', chat: CHAT, summary: 'edit src/routes/auth.ts (+7 lines).' } },
      { id: 'e-question', at: minutesAgo(20), read: true, body: { kind: 'question', chat: { project: { key: 'bks', name: 'bookshelf' }, title: 'OCR pipeline retries' }, summary: 'Retry on 5xx responses too, or only on timeouts?' } },
      { id: 'e-done', at: minutesAgo(45), read: true, body: { kind: 'done', chat: CHAT, durationMs: 252_000 } },
    ],
    doNotDisturb: false,
    popupsOff: false,
  };
  await sendTo(app, OVERLAY_URL, OVERLAY_CHANNELS.notificationsState, [state]);
  const rows = overlay.getByTestId('notification-row');
  await expect(rows).toHaveCount(5);
  await rows.first().hover();
  await capture(overlay, testInfo, 'd55-center-row-hover-light');
  await saveScreenshot(overlay, testInfo, 'd55-center-row-hover-light-row', rows.first());
  await overlay.keyboard.press('Escape');
  await expect(overlay.getByTestId('notification-center')).toHaveCount(0);
});
