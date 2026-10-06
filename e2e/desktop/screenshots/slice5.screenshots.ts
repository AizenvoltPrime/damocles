import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { OVERLAY_CHANNELS, type OverlayToast } from '../../../src/desktop/preload/overlay-channels';
import type { NotificationBody } from '../../../src/desktop/preload/notifications';
import { activeChat, expect, test } from '../support/fixtures';
import { seedStubModel } from '../support/hermetic';
import { startOpenAIStub } from '../support/openai-stub';
import { readyOverlay } from '../support/overlay';
import { openProjectChat, saveScreenshot, setPageSize, settled, showTheme, THEMES } from '../support/screenshots';
import { openSettingsModal, settingsRow } from '../support/settings';
import { NOTIFIER_URL, popupPage, setWindowFocused, shellPage, shellState } from '../support/shell';
import { answerOpenDialog, chatInput, clickMenu, sendAndAwaitEcho } from '../support/ui';

const WIDTH = 1280;
const HEIGHT = 820;

// The overlay and the popup window are transparent over what lies beneath; a capture paints the theme's background behind instead.
async function captureOverlay(overlay: Page, testInfo: Parameters<typeof saveScreenshot>[1], name: string): Promise<void> {
  await overlay.evaluate(() => {
    document.body.style.backgroundColor = 'var(--d-bg)';
  });
  await settled(overlay);
  await saveScreenshot(overlay, testInfo, name);
  await overlay.evaluate(() => {
    document.body.style.backgroundColor = '';
  });
}

// Toasts handed to the popup page as main sends them; main holds no timer for them, so they stay for the capture.
async function sendToasts(app: ElectronApplication, toasts: readonly OverlayToast[]): Promise<void> {
  await app.evaluate(({ webContents }, { url, channel, list }) => {
    const target = webContents.getAllWebContents().find((contents) => contents.getURL() === url)!;
    for (const toast of list) target.send(channel, toast);
  }, { url: NOTIFIER_URL, channel: OVERLAY_CHANNELS.toast, list: toasts });
}

function toast(id: string, body: NotificationBody, lifeMs: number, remainingMs: number): OverlayToast {
  return { id, at: Date.now() - 60_000, lifeMs, remainingMs, body };
}

test('notification toasts, the bell and its center in Dark and Light', async ({ home, launch }, testInfo) => {
  test.setTimeout(180_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const file = path.join(home.project, 'auth.ts');
    fs.writeFileSync(file, 'export const limit = 5;\n');
    const { app } = await launch();
    const alpha = await openProjectChat(app, home.project);
    const shell = await shellPage(app);
    const overlay = await readyOverlay(app);

    // Real entries: a finished turn, an approval in a chat that is not selected, and a core notice. The window stays away
    // until all are in, since a focused window selecting a chat reads that chat's entries.
    await setWindowFocused(app, false);
    await sendAndAwaitEcho(alpha, 'Rate-limit the /login route');
    const popup = await popupPage(app);
    await expect(popup.locator('[data-testid="overlay-toast"][data-kind="done"]')).toBeVisible({ timeout: 30_000 });
    let release!: () => void;
    stub.replies.push({
      chunks: ['Raising the limit.'],
      holdAfterFirst: new Promise<void>((resolve) => { release = resolve; }),
      toolCalls: [{ name: 'Edit', arguments: { file_path: file, old_string: 'limit = 5', new_string: 'limit = 7' } }],
    });
    await chatInput(alpha).fill('Raise the limit to 7');
    await chatInput(alpha).press('Enter');
    await shell.evaluate(() => window.damoclesShell!.newChat());
    let fresh: string | undefined;
    await expect.poll(async () => (fresh = (await shellState(app)).selected.chatId)).toMatch(/^new:/);
    release();
    await expect(popup.locator('[data-testid="overlay-toast"][data-kind="approval"]')).toBeVisible({ timeout: 30_000 });
    // A core notice: renaming a chat that has no saved conversation yet.
    await shell.evaluate((id) => window.damoclesShell!.renameChat(id, 'Notes'), fresh!);
    await expect.poll(async () => (await shellState(app)).notifications.unseen).toBeGreaterThanOrEqual(3);
    await setWindowFocused(app, undefined);

    for (const theme of THEMES) {
      await showTheme(app, shell, theme);
      await saveScreenshot(shell, testInfo, `slice5-bell-${theme}`, shell.getByTestId('title-bar'));
    }

    // The popup window's stack: four of the kinds, so the oldest collapses into "1 more · Dismiss all".
    // The real toasts make way first; their entries stay in the center.
    while (await popup.locator('[data-testid="overlay-toast"]:not([inert])').count() > 0) {
      await popup.locator('[data-testid="overlay-toast"]:not([inert])').last().getByTestId('overlay-toast-dismiss').click();
    }
    await expect(popup.getByTestId('overlay-toast')).toHaveCount(0);
    const chat = { project: { key: 'acme', name: 'acme' }, title: 'Per-account lockout' };
    await sendToasts(app, [
      toast('s-limit', { kind: 'limit', reason: 'usage', windowLabel: '5-hour window', threshold: 80, utilization: 85, planName: 'Max 20x', resetsAt: Date.now() + 72 * 60_000 }, 9000, 9000),
      toast('s-team', { kind: 'team', chat, agentName: 'Theo', summary: 'Mira’s lockout change is ready for your go-ahead.' }, 12_000, 9000),
      toast('s-error', { kind: 'error', chat: { project: { key: 'damocles', name: 'damocles' }, title: 'Compass: index Vue SFC' }, reason: 'rateLimit', resetsAt: Date.now() + 14 * 60_000 }, 12_000, 6000),
      toast('s-approval', { kind: 'approval', chat: { project: { key: 'acme', name: 'acme' }, title: 'Rate-limit the /login route' }, summary: 'edit src/routes/auth.ts (+7 lines).' }, 12_000, 11_000),
    ]);
    await expect(popup.getByTestId('overlay-toasts-more')).toHaveText('1 more · Dismiss all');
    for (const theme of THEMES) {
      await showTheme(app, popup, theme);
      await captureOverlay(popup, testInfo, `slice5-toasts-${theme}`);
    }
    await popup.getByTestId('overlay-toasts-more').click();
    await expect(popup.getByTestId('overlay-toast')).toHaveCount(0);

    // The bell's center over the window, with the real entries.
    await setPageSize(overlay, WIDTH, HEIGHT);
    for (const theme of THEMES) {
      await showTheme(app, shell, theme);
      await shell.getByTestId('notification-bell').click();
      await expect(overlay.getByTestId('notification-center')).toBeVisible();
      await expect(overlay.getByTestId('notification-row').first()).toBeVisible();
      await captureOverlay(overlay, testInfo, `slice5-center-${theme}`);
      if (theme === 'dark') {
        await overlay.getByTestId('notification-dnd').click();
        await expect(overlay.getByTestId('notification-dnd-subtitle')).toHaveText('No pop-ups. They still collect here');
        await captureOverlay(overlay, testInfo, 'slice5-center-dnd-dark');
        await saveScreenshot(shell, testInfo, 'slice5-bell-dnd-dark', shell.getByTestId('title-bar'));
        await overlay.getByTestId('notification-dnd').click();
      }
      await overlay.keyboard.press('Escape');
      await expect(overlay.getByTestId('notification-center')).toHaveCount(0);
    }
  } finally {
    await stub.close();
  }
});

test('the overlay dialogs: the trust question in Dark and Light, a folder switch over the settings modal, and a danger confirmation', async ({ home, launch }, testInfo) => {
  test.setTimeout(180_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const beta = path.join(path.dirname(home.project), 'beta');
    fs.mkdirSync(beta, { recursive: true });
    const { app } = await launch();
    await expect(chatInput(await activeChat(app))).toBeVisible();
    const shell = await shellPage(app);
    const overlay = await readyOverlay(app);

    await answerOpenDialog(app, beta);
    await clickMenu(app, 'damocles.addProject');
    const dialog = overlay.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    for (const theme of THEMES) {
      await showTheme(app, overlay, theme);
      await captureOverlay(overlay, testInfo, `slice5-dialog-trust-${theme}`);
    }
    await dialog.getByRole('button', { name: 'Trust Folder' }).click();
    await expect(dialog).toHaveCount(0);

    // A conversation in alpha, then This chat › Workspace folder asks above the settings modal.
    const alpha = await openProjectChat(app, home.project);
    await sendAndAwaitEcho(alpha, 'work in alpha');
    await showTheme(app, shell, 'dark');
    const modal = await openSettingsModal(app, 'chat');
    await settingsRow(modal, 'workspace-folder').getByRole('combobox').click();
    await modal.getByRole('option', { name: /^beta/ }).click();
    await expect(dialog).toBeVisible();
    await captureOverlay(modal, testInfo, 'slice5-dialog-switch-over-settings-dark');
    await modal.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await modal.keyboard.press('Escape');

    await expect.poll(async () => (await shellState(app)).selected.chatId).toBeDefined();
    const answered = shell.evaluate(() => window.damoclesShell!.requestOverlay({
      kind: 'confirm',
      title: 'Delete Session',
      message: 'Delete this session? This action cannot be undone.',
      detail: { label: 'Session:', text: 'work in alpha' },
      warning: { text: 'This chat is still running. Deleting it stops the agent.', running: true },
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    }));
    await expect(dialog).toBeVisible();
    for (const theme of THEMES) {
      await showTheme(app, overlay, theme);
      await captureOverlay(overlay, testInfo, `slice5-dialog-delete-${theme}`);
    }
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(answered).resolves.toEqual({ kind: 'confirm', confirmed: false });
  } finally {
    await stub.close();
  }
});

test('the trust question in Greek', async ({ home, launch }, testInfo) => {
  const { app } = await launch({ args: ['--lang=el-GR'] });
  await expect((await activeChat(app)).getByPlaceholder('Ρωτήστε τον Damocles οτιδήποτε…')).toBeVisible();
  const overlay = await readyOverlay(app);
  await answerOpenDialog(app, home.project);
  await clickMenu(app, 'damocles.addProject');
  const dialog = overlay.getByRole('alertdialog');
  await expect(dialog.getByRole('button', { name: 'Εμπιστοσύνη φακέλου' })).toBeVisible();
  await showTheme(app, overlay, 'dark');
  await captureOverlay(overlay, testInfo, 'slice5-dialog-trust-greek-dark');
  await dialog.getByRole('button', { name: 'Χωρίς εμπιστοσύνη' }).click();
});
