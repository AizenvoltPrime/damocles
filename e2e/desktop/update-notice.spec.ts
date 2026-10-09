import { OVERLAY_CHANNELS, type OverlayToast } from '../../src/desktop/preload/overlay-channels';
import { activeChat, expect, test } from './support/fixtures';
import { chatInput, postFromWebview } from './support/ui';
import { NOTIFIER_URL, noticeAction, RELEASE_PAGE_ACTION, RESTART_ACTION, SHELL_URL } from './update/update-notice.mjs';

// String from src/core/chat-panel/message-router/handlers/workspace-handlers.ts.
const SESSION_LOG_NOTICE = 'No active session to view';

// drive-update.mjs answers the update notice only in the release workflow, against a packaged install. The updater is
// off in a dev app, so a real notice opens the popup window, main sends its page the notice the updater's toast would
// carry, and the driver's lookup runs on it.
test('the update driver finds the update notice actions on the pages the app renders them in', async ({ launch }) => {
  const { app } = await launch();
  const chat = await activeChat(app);
  await expect(chatInput(chat)).toBeVisible();
  const pageAt = (url: string) => app.windows().find((p) => p.url() === url);
  expect(pageAt(SHELL_URL)).toBeDefined();
  await postFromWebview(chat, { type: 'openSessionLog' });
  await expect.poll(() => pageAt(NOTIFIER_URL)?.evaluate(() => window.damoclesOverlay !== undefined)).toBe(true);
  const popup = pageAt(NOTIFIER_URL)!;
  // The preload's bridge exists before the page's toast stack subscribes, and a toast sent before that is dropped; main's
  // own notice renders only through that subscription.
  await expect(popup.getByTestId('overlay-toast').filter({ hasText: SESSION_LOG_NOTICE })).toBeVisible();

  const notice: OverlayToast = {
    id: 'update-notice',
    at: Date.now(),
    lifeMs: 120_000,
    remainingMs: 120_000,
    body: { kind: 'notice', severity: 'info', message: 'Damocles 9.9.9 is ready.', actions: [RESTART_ACTION, RELEASE_PAGE_ACTION] },
  };
  await app.evaluate(({ webContents }, { url, channel, toast }) => {
    const target = webContents.getAllWebContents().find((c) => c.getURL() === url);
    if (!target) throw new Error(`no page at ${url}`);
    target.send(channel, toast);
  }, { url: NOTIFIER_URL, channel: OVERLAY_CHANNELS.toast, toast: notice });

  await expect(noticeAction(popup, RESTART_ACTION)).toBeVisible();
  await expect(noticeAction(popup, RELEASE_PAGE_ACTION)).toBeVisible();
});
