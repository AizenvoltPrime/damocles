import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { OVERLAY_CHANNELS, type ConnectFailure, type HostCardInfo, type HostOperations, type OverlayToast } from '../../../src/desktop/preload/overlay-channels';
import { activeChat, expect, test } from '../support/fixtures';
import { REPO_ROOT } from '../support/hermetic';
import { setReducedMotion, settled, showShellTheme, THEMES } from '../support/screenshots';
import { NOTIFIER_URL, OVERLAY_URL, overlayPage, popupPage, popupToasts } from '../support/shell';
import { chatInput, clickMenu } from '../support/ui';

// Review captures of a dev container without Damocles' data volume (its toast, its card and the Rebuild confirmation), the
// Rebuild failures that stopped nothing, and a paused container's connect failure, saved to DAMOCLES_SCREENSHOT_DIR in dark,
// light and reduced motion. Main's container states are delivered to the overlay as main sends them, since no engine runs here.
const OUT = process.env.DAMOCLES_SCREENSHOT_DIR ?? path.join(process.env.USERPROFILE ?? REPO_ROOT, '.damocles', 'screenshots', 'u6');
const CONTAINER: HostCardInfo = {
  hostId: 'c1',
  kind: 'container',
  name: 'web-app-dev',
  destinationLabel: 'docker · typescript-node:22',
  container: { origin: 'devcontainer', image: 'mcr.microsoft.com/devcontainers/typescript-node:22', state: 'running', engine: 'docker', workspaceFolder: 'C:\\work\\web-app', configPath: 'C:\\work\\web-app\\.devcontainer\\devcontainer.json', withoutDataVolume: true },
  connection: 'connected',
  signInNeeded: false,
  recentFolders: [],
  projectFolders: [],
  notices: [],
  allowBypass: false,
  passwordless: false,
  keyInstalledByDamocles: false,
  lingerEnabledByDamocles: false,
};
const NOTICE: OverlayToast['body'] = {
  kind: 'notice',
  severity: 'warning',
  title: 'Chats in web-app-dev are lost when it is rebuilt',
  message: 'Damocles did not create this container, so the chats and settings in it live inside it and a rebuild removes them. Rebuild it from Damocles once to keep them in its data volume from then on.',
  actions: ['Rebuild Container...'],
  host: 'web-app-dev',
};

test.setTimeout(300_000);

async function toOverlay(app: ElectronApplication, channel: string, payload: unknown): Promise<void> {
  await app.evaluate(({ webContents }, [url, name, value]) => {
    webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.send(name as string, value);
  }, [OVERLAY_URL, channel, payload] as const);
}

// Answers a host call of the overlay as main does for a saved host, which the fake container is not.
async function answer(app: ElectronApplication, channel: string, value: unknown): Promise<void> {
  await app.evaluate(({ webContents }, [url, name, result]) => {
    const overlay = webContents.getAllWebContents().find((contents) => contents.getURL() === url)!;
    overlay.ipc.removeHandler(name as string);
    overlay.ipc.handle(name as string, () => ({ ok: true, value: result }));
  }, [OVERLAY_URL, channel, value] as const);
}

async function capture(app: ElectronApplication, page: Page, name: string, target: Locator, motion: 'full' | 'reduced'): Promise<void> {
  for (const theme of THEMES) {
    await showShellTheme(app, theme);
    await settled(page);
    await target.screenshot({ path: path.join(OUT, `${name}-${theme}${motion === 'reduced' ? '-reduced' : ''}.png`) });
  }
}

test('a dev container without the data volume, the Rebuild failures that stopped nothing, and a paused container', async ({ foreground: _foreground, launch }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const { app } = await launch({ env: { DAMOCLES_E2E_HOOKS: '1' } });
  await expect(chatInput(await activeChat(app))).toBeVisible();
  const overlay = await overlayPage(app);
  const dialog = overlay.getByTestId('connect-dialog');
  let revision = 0;

  for (const motion of ['full', 'reduced'] as const) {
    await setReducedMotion(app, motion === 'reduced');
    await clickMenu(app, 'damocles.remote.connectToHost');
    await expect(dialog).toBeVisible();
    await answer(app, OVERLAY_CHANNELS.hostsRuns, []);
    await answer(app, OVERLAY_CHANNELS.hostsRebuildInfo, { runs: [] });
    await answer(app, OVERLAY_CHANNELS.hostsOperations, { hostId: 'c1', revision: 0 });
    await toOverlay(app, OVERLAY_CHANNELS.connectHosts, [CONTAINER]);
    await overlay.getByRole('button', { name: 'Details for web-app-dev' }).click();
    const note = dialog.getByTestId('rebuild-container-volume');
    await expect(note).toBeVisible();
    await capture(app, overlay, 'card-without-volume', dialog, motion);

    await dialog.getByTestId('rebuild-container').click();
    const confirm = overlay.getByTestId('rebuild-container-dialog');
    await expect(confirm.getByTestId('rebuild-container-keeps')).toContainText('no Damocles data volume');
    await capture(app, overlay, 'rebuild-confirm-without-volume', confirm, motion);
    await confirm.getByTestId('rebuild-container-cancel').click();
    await expect(confirm).toHaveCount(0);

    const stoppedNothing = { stopping: 'pending', building: 'pending', reconnecting: 'pending' } as const;
    const failures: ReadonlyArray<[string, 'configFailed' | 'stopFailed', HostOperations]> = [
      ['rebuild-config-failed', 'configFailed', { hostId: 'c1', revision: ++revision, rebuild: { steps: stoppedNothing, log: { lines: [], total: 0 }, result: { ok: false, code: 'configFailed', message: 'devcontainer.json: Expected comma or closing brace (line 12, column 5)' } } }],
      ['rebuild-stop-failed', 'stopFailed', { hostId: 'c1', revision: ++revision, rebuild: { steps: { ...stoppedNothing, stopping: 'failed' }, log: { lines: [], total: 0 }, result: { ok: false, code: 'stopFailed', message: 'The Damocles server did not answer shutdownNow' } } }],
    ];
    for (const [name, code, operations] of failures) {
      await toOverlay(app, OVERLAY_CHANNELS.hostsOperationsChanged, operations);
      await expect(dialog.getByTestId('rebuild-container-failure')).toHaveAttribute('data-code', code);
      await capture(app, overlay, name, dialog.getByTestId('container-rebuild'), motion);
    }
    await toOverlay(app, OVERLAY_CHANNELS.hostsOperationsChanged, { hostId: 'c1', revision: ++revision });

    const { withoutDataVolume: _withoutDataVolume, ...withVolume } = CONTAINER.container!;
    const paused: ConnectFailure = { code: 'containerPaused', params: { container: 'vigorous_turing', engine: 'docker' } };
    await toOverlay(app, OVERLAY_CHANNELS.connectHosts, [{ ...CONTAINER, connection: 'failed', container: { ...withVolume, state: 'stopped' }, failure: paused }]);
    await expect(dialog.getByRole('alert').filter({ hasText: 'is paused' })).toBeVisible();
    await capture(app, overlay, 'connect-paused', dialog, motion);
    await overlay.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }

  // The toast main raises once per container; a stand-in of main's notice opens the popup window, then main's exact body shows.
  await setReducedMotion(app, false);
  await app.evaluate(() => {
    void (globalThis as unknown as { __damoclesE2e: { notifications: { info(message: { message: string }): Promise<unknown> } } }).__damoclesE2e.notifications.info({ message: 'Opening the popup window' });
  });
  const popup = await popupPage(app, 30_000);
  for (const motion of ['full', 'reduced'] as const) {
    await popup.emulateMedia({ reducedMotion: motion === 'reduced' ? 'reduce' : null });
    const id = `u6-${motion}`;
    const toast: OverlayToast = { id, at: Date.now(), lifeMs: 60_000, remainingMs: 60_000, body: NOTICE };
    await app.evaluate(({ BaseWindow }, [url, name, value]) => {
      for (const window of BaseWindow.getAllWindows()) {
        const view = (window.contentView.children as Electron.WebContentsView[]).find((child) => child.webContents?.getURL() === url);
        view?.webContents.send(name as string, value);
      }
    }, [NOTIFIER_URL, OVERLAY_CHANNELS.toast, toast] as const);
    const card = popupToasts(popup).filter({ hasText: NOTICE.title! });
    await expect(card).toHaveCount(1);
    await card.hover();
    await popup.evaluate(() => {
      document.body.style.backgroundColor = 'var(--d-bg)';
    });
    await capture(app, popup, 'toast-without-volume', card, motion);
    await popup.mouse.move(0, 0);
    await card.getByTestId('overlay-toast-dismiss').click();
    await expect(card).toHaveCount(0);
  }
});
