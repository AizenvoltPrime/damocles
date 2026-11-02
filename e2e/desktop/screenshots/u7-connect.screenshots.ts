import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { OVERLAY_CHANNELS, type ConnectStepEvent, type HostCardInfo, type WslDistroInfo } from '../../../src/desktop/preload/overlay-channels';
import { activeChat, expect, test } from '../support/fixtures';
import { setReducedMotion, settled, showShellTheme, THEMES } from '../support/screenshots';
import { OVERLAY_URL, overlayPage } from '../support/shell';
import { chatInput, clickMenu } from '../support/ui';

// Review captures of the Connect dialog: a saved WSL host whose distro is not listed, Forget host with and without container
// records on the SSH host, a dev container's connected timeline and the folder it could not open. Saved to
// DAMOCLES_SCREENSHOT_DIR, else the OS temp folder, in dark, light and reduced motion. Main's host lists and steps are replaced
// by stand-ins delivered as main sends them, since no WSL distro, SSH host or engine is set up here.
const OUT = process.env.DAMOCLES_SCREENSHOT_DIR ?? path.join(os.tmpdir(), 'damocles-screenshots', 'u7-connect');
const BASE = {
  signInNeeded: false,
  recentFolders: [],
  projectFolders: [],
  notices: [],
  allowBypass: false,
  passwordless: false,
  keyInstalledByDamocles: false,
  lingerEnabledByDamocles: false,
} as const;
const PROD: HostCardInfo = { ...BASE, hostId: 'h1', kind: 'ssh', name: 'prod-1', color: 'danger', destinationLabel: 'deploy@prod-1:22', connection: 'offline' };
const LAB: HostCardInfo = { ...BASE, hostId: 'h2', kind: 'ssh', name: 'lab', destinationLabel: 'astef@lab-02', connection: 'offline' };
const WSL: HostCardInfo = { ...BASE, hostId: 'w1', kind: 'wsl', name: 'ml-box', color: 'warning', destinationLabel: 'Ubuntu-22.04', wsl: { distro: 'Ubuntu-22.04', version: 2, state: 'stopped', isDefault: false }, connection: 'offline' };
const DEVCONTAINER: HostCardInfo = { ...BASE, hostId: 'c1', kind: 'container', name: 'web-app-dev', color: 'info', destinationLabel: 'docker · typescript-node:22', container: { origin: 'devcontainer', image: 'mcr.microsoft.com/devcontainers/typescript-node:22', state: 'stopped', engine: 'docker', workspaceFolder: 'C:\\work\\web-app', configPath: 'C:\\work\\web-app\\.devcontainer\\devcontainer.json' }, connection: 'offline' };
const ATTACHED: HostCardInfo = { ...BASE, hostId: 'c2', kind: 'container', name: 'api-shell', destinationLabel: 'api', container: { origin: 'attach', image: 'node:22-alpine', state: 'running', engine: 'docker', containerName: 'api', user: 'configured', via: { hostId: 'h1', name: 'prod-1' } }, connection: 'offline' };
const HOSTS = [PROD, LAB, WSL, DEVCONTAINER, ATTACHED];
const DISTROS: WslDistroInfo[] = [{ distro: 'Ubuntu-24.04', state: 'running', version: 2, isDefault: true }];
const CONNECTED: ConnectStepEvent = { attemptId: 'a1', hostId: 'c1', transport: 'container', step: 'connected', visited: ['building', 'connecting', 'checking', 'starting'], notices: [] };

test.setTimeout(300_000);

// Main's own host lists and steps stop reaching the overlay, so only the stand-ins show; the stand-ins go through the original send.
async function holdMainPushes(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ webContents }, [url, held]) => {
    const overlay = webContents.getAllWebContents().find((contents) => contents.getURL() === url)! as Electron.WebContents & { standIn?: Electron.WebContents['send'] };
    if (overlay.standIn) return;
    const send = overlay.send.bind(overlay);
    overlay.standIn = send;
    overlay.send = (channel: string, ...args: unknown[]) => {
      if (!(held as readonly string[]).includes(channel)) send(channel, ...args);
    };
  }, [OVERLAY_URL, [OVERLAY_CHANNELS.connectHosts, OVERLAY_CHANNELS.connectDistros, OVERLAY_CHANNELS.connectStep]] as const);
}

async function toOverlay(app: ElectronApplication, channel: string, payload: unknown): Promise<void> {
  await app.evaluate(({ webContents }, [url, name, value]) => {
    (webContents.getAllWebContents().find((contents) => contents.getURL() === url)! as Electron.WebContents & { standIn: Electron.WebContents['send'] }).standIn(name as string, value);
  }, [OVERLAY_URL, channel, payload] as const);
}

// Answers a host call of the overlay as main does for a saved host, which the stand-ins are not.
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

async function openConnect(app: ElectronApplication, overlay: Page): Promise<Locator> {
  await clickMenu(app, 'damocles.remote.connectToHost');
  const dialog = overlay.getByTestId('connect-dialog');
  await expect(dialog).toBeVisible();
  await toOverlay(app, OVERLAY_CHANNELS.connectHosts, HOSTS);
  await toOverlay(app, OVERLAY_CHANNELS.connectDistros, DISTROS);
  await expect(dialog.locator('[data-testid="host-card-button"]')).toHaveCount(3);
  return dialog;
}

test('the Connect dialog: an unlisted WSL host, Forget host with containers, and a dev container\'s connected and failed folder', async ({ foreground: _foreground, launch }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const { app } = await launch({ env: { DAMOCLES_E2E_HOOKS: '1' } });
  await expect(chatInput(await activeChat(app))).toBeVisible();
  const overlay = await overlayPage(app);
  await holdMainPushes(app);
  await answer(app, OVERLAY_CHANNELS.hostsRuns, []);
  await answer(app, OVERLAY_CHANNELS.connectStart, { ok: true, attemptId: 'a1', hostId: 'c1' });

  for (const motion of ['full', 'reduced'] as const) {
    await setReducedMotion(app, motion === 'reduced');
    let dialog = await openConnect(app, overlay);
    await expect(dialog.locator('[data-host-id="w1"] [data-testid="host-card-button"]')).toHaveCount(1);
    await capture(app, overlay, 'hosts-unlisted-wsl', dialog, motion);

    for (const [host, name] of [[PROD, 'forget-with-containers'], [LAB, 'forget-without-containers']] as const) {
      await answer(app, OVERLAY_CHANNELS.hostsOperations, { hostId: host.hostId, revision: 0 });
      await overlay.getByRole('button', { name: `Details for ${host.name}` }).click();
      await dialog.getByTestId('forget-host').click();
      const forget = overlay.locator('[data-testid="forget-host-dialog"][data-state="open"]');
      await expect(forget).toBeVisible();
      await capture(app, overlay, name, forget, motion);
      await forget.getByTestId('forget-host-cancel').click();
      await expect(forget).toHaveCount(0);
      await expect(dialog.getByTestId('forget-host')).toBeFocused();
      await overlay.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      dialog = await openConnect(app, overlay);
    }

    // main pushes the step of the attempt the card's start joins before it answers
    await toOverlay(app, OVERLAY_CHANNELS.connectStep, CONNECTED);
    await dialog.locator('[data-testid="container-card"][data-host-id="c1"]').click();
    const progress = dialog.getByTestId('connect-progress');
    await expect(progress).toHaveAttribute('aria-valuetext', 'Connected');
    await capture(app, overlay, 'devcontainer-connected', dialog, motion);

    await toOverlay(app, OVERLAY_CHANNELS.connectStep, { ...CONNECTED, folderFailure: { code: 'containerFolderFailed', params: {} } });
    await expect(dialog.getByTestId('connect-failure')).toHaveAttribute('data-code', 'containerFolderFailed');
    await capture(app, overlay, 'devcontainer-folder-failed', dialog, motion);
    await overlay.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
});
