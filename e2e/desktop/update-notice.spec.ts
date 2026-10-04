import { OVERLAY_CHANNELS, type OverlayToast } from '../../src/desktop/preload/overlay-channels';
import { activeChat, expect, test } from './support/fixtures';
import { chatInput } from './support/ui';
import { noticeAction, OVERLAY_URL, RELEASE_PAGE_ACTION, RESTART_ACTION, SHELL_URL } from './update/update-notice.mjs';

// drive-update.mjs answers the update notice only in the release workflow, against a packaged install. The updater is
// off in a dev app, so main sends the overlay the notice the updater's toast would carry, and the driver's lookup runs on it.
test('the update driver finds the update notice actions on the pages the app renders them in', async ({ launch }) => {
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  const pageAt = (url: string) => app.windows().find((p) => p.url() === url);
  expect(pageAt(SHELL_URL)).toBeDefined();
  await expect.poll(() => pageAt(OVERLAY_URL)?.evaluate(() => window.damoclesOverlay !== undefined)).toBe(true);
  const overlay = pageAt(OVERLAY_URL)!;

  const notice: OverlayToast = { id: 'update-notice', severity: 'info', message: 'Damocles 9.9.9 is ready.', actions: [RESTART_ACTION, RELEASE_PAGE_ACTION] };
  await app.evaluate(({ webContents }, { url, channel, toast }) => {
    const target = webContents.getAllWebContents().find((c) => c.getURL() === url);
    if (!target) throw new Error(`no page at ${url}`);
    target.send(channel, toast);
  }, { url: OVERLAY_URL, channel: OVERLAY_CHANNELS.toast, toast: notice });

  await expect(noticeAction(overlay, RESTART_ACTION)).toBeVisible();
  await expect(noticeAction(overlay, RELEASE_PAGE_ACTION)).toBeVisible();
});
