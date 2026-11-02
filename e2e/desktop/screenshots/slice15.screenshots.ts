import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { OVERLAY_CHANNELS, type OverlayToast } from '../../../src/desktop/preload/overlay-channels';
import type { NotificationBody } from '../../../src/desktop/preload/notifications';
import { commandLineSwitch } from '../../../src/desktop/cli/cli-protocol';
import { activeChat, expect, test } from '../support/fixtures';
import { expectNoAxeViolations } from '../support/axe';
import { setWindowContentSize } from '../support/browser';
import { openProjectChat, saveScreenshot, setReducedMotion, settled, showShellTheme, THEMES, windowShot } from '../support/screenshots';
import { NOTIFIER_URL, popupPage, shellPage } from '../support/shell';
import { postFromWebview } from '../support/ui';

// Review captures of the damocles command's UI: the link notice a target's terminal raises, at rest, with Open focused by
// F6, after Copy, a look-alike host and its entrance; and the --diff tab. Dark and Light, and with reduced motion.

test.setTimeout(600_000);

const VARIANTS = [...THEMES.map((theme) => [theme, false] as const), ['reduced', true] as const];

function linkToast(id: string, url: string): OverlayToast {
  const body: NotificationBody = { kind: 'link', host: 'prod-1', hostTone: 'danger', url };
  return { id, at: Date.now(), lifeMs: 0, remainingMs: 0, body, sticky: true };
}

async function sendToast(app: ElectronApplication, toast: OverlayToast): Promise<void> {
  await app.evaluate(({ webContents }, { url, channel, item }) => {
    webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.send(channel, item);
  }, { url: NOTIFIER_URL, channel: OVERLAY_CHANNELS.toast, item: toast });
}

async function dropToast(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ webContents }, { url, channel, item }) => {
    webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.send(channel, item);
  }, { url: NOTIFIER_URL, channel: OVERLAY_CHANNELS.toastDismiss, item: id });
}

// The popup page alone, its transparency kept: the cards float as they do over the desktop, and nothing is painted behind them.
async function popupShot(popup: Page, testInfo: TestInfo, name: string): Promise<void> {
  const dir = process.env.DAMOCLES_SCREENSHOT_DIR ?? testInfo.outputDir;
  fs.mkdirSync(dir, { recursive: true });
  await popup.screenshot({ path: path.join(dir, `${name}.png`), omitBackground: true });
}

test('slice 15: the link notice', async ({ clipboard: _clipboard, launch }, testInfo) => {
  const { app } = await launch();
  const tab = await activeChat(app);
  // a real notice opens the popup window; the link cards are then handed to its page as main sends them
  await postFromWebview(tab, { type: 'openSessionLog' });
  const popup = await popupPage(app);
  await expect(popup.getByTestId('overlay-toast')).toHaveCount(1);
  const card = (id: string) => popup.locator(`[data-toast-id="${id}"]`);
  let serial = 0;

  for (const [variant, reduced] of VARIANTS) {
    const theme = variant === 'reduced' ? 'dark' : variant;
    await showShellTheme(app, theme);
    await setReducedMotion(app, reduced);
    await popup.emulateMedia({ reducedMotion: reduced ? 'reduce' : null });
    await expect(popup.locator('body')).toHaveAttribute('data-vscode-theme-kind', `vscode-${theme}`);
    // the pointer off the cards, so no capture shows a hover
    await popup.mouse.move(0, 0);

    // its entrance held 90 ms in: sliding in from the right, or already in place with reduced motion
    const id = `link-${serial++}`;
    await sendToast(app, linkToast(id, 'https://github.com/login/device'));
    await expect(card(id)).toBeAttached();
    await popup.evaluate(() => {
      for (const animation of document.getAnimations()) {
        animation.pause();
        animation.currentTime = Math.min(90, Number(animation.effect?.getComputedTiming().endTime ?? 0));
      }
    });
    await popupShot(popup, testInfo, `link-notice-entering-${variant}`);
    await popup.evaluate(() => {
      for (const animation of document.getAnimations()) animation.play();
    });
    await expect(card(id)).toBeVisible();
    await settled(popup);
    await popupShot(popup, testInfo, `link-notice-${variant}`);
    await saveScreenshot(popup, testInfo, `link-notice-card-${variant}`, card(id));

    // F6 into the popups lands on Open
    await app.evaluate(({ webContents }, { url, channel }) => {
      webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.send(channel);
    }, { url: NOTIFIER_URL, channel: OVERLAY_CHANNELS.toastsFocus });
    await expect(card(id).getByTestId('link-open')).toBeFocused();
    await settled(popup);
    await saveScreenshot(popup, testInfo, `link-notice-open-focused-${variant}`, card(id));

    // Copy keeps the notice and says Copied
    await card(id).getByTestId('link-copy').click();
    await expect(card(id).getByTestId('link-copy')).toHaveText('Copied');
    await popup.mouse.move(0, 0);
    await settled(popup);
    await saveScreenshot(popup, testInfo, `link-notice-copied-${variant}`, card(id));
    await dropToast(app, id);
    await expect(card(id)).toHaveCount(0);

    // a look-alike host and a user name before the real host, then a long redirect URL with a forwarded port
    const lookalike = `lookalike-${serial++}`;
    await sendToast(app, linkToast(lookalike, 'https://github.com.evil.example/login/device?next=%2Fsettings'));
    const userinfo = `userinfo-${serial++}`;
    await sendToast(app, linkToast(userinfo, 'https://github.com@evil.example/login'));
    const long = `long-${serial++}`;
    await sendToast(app, linkToast(long, `http://localhost:54123/oauth/authorize?client_id=178c6fc778ccc68e1d6a&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2Fcallback&scope=repo%20read%3Aorg%20workflow&state=${'a1b2c3d4'.repeat(12)}`));
    await expect(card(long)).toBeVisible();
    await settled(popup);
    await popupShot(popup, testInfo, `link-notice-hosts-${variant}`);
    for (const each of [lookalike, userinfo, long]) await dropToast(app, each);
  }
});

test('slice 15: the --diff tab', async ({ home, launch }, testInfo) => {
  const left = path.join(home.project, 'config', 'app.v1.json');
  const right = path.join(home.project, 'config', 'app.v2.json');
  fs.mkdirSync(path.dirname(left), { recursive: true });
  const config = (port: number, extra: string): string => `{\n  "name": "billing",\n  "port": ${port},\n  "retries": 3,\n  "timeoutMs": 5000,${extra}\n  "log": "info"\n}\n`;
  fs.writeFileSync(left, config(8080, ''));
  fs.writeFileSync(right, config(8443, '\n  "tls": true,\n  "cert": "/etc/billing/cert.pem",'));
  const { app } = await launch();
  await openProjectChat(app, home.project);
  await setWindowContentSize(app, 1440, 900);
  const shell = await shellPage(app);
  const request = commandLineSwitch({ request: { kind: 'diff', cwd: home.project, left, right, wait: false } });
  await app.evaluate(({ app: electronApp }, { argv, cwd }) => {
    electronApp.emit('second-instance', { preventDefault: () => undefined }, argv, cwd, {});
  }, { argv: [process.execPath, request], cwd: home.project });
  await expect(shell.getByTestId('changes-tab')).toBeVisible();
  await expect(shell.getByTestId('changes-diff')).toBeVisible();

  for (const [variant, reduced] of VARIANTS) {
    const theme = variant === 'reduced' ? 'dark' : variant;
    await showShellTheme(app, theme);
    await setReducedMotion(app, reduced);
    await settled(shell);
    await windowShot(app, testInfo, `diff-tab-window-${variant}`);
    await saveScreenshot(shell, testInfo, `diff-tab-${variant}`, shell.getByTestId('changes-tab'));
  }
});

test('slice 15: the popups float on the desktop with nothing painted behind the cards', async ({ launch }, testInfo) => {
  const { app } = await launch();
  const tab = await activeChat(app);
  await postFromWebview(tab, { type: 'openSessionLog' });
  const popup = await popupPage(app);
  await expect(popup.getByTestId('overlay-toast')).toHaveCount(1);
  await sendToast(app, { id: 'kind-done', at: Date.now(), lifeMs: 600_000, remainingMs: 600_000, body: { kind: 'done', chat: { project: { key: 'acme', name: 'acme' }, title: 'Rate-limit the /login route' }, durationMs: 252_000 } });
  await sendToast(app, linkToast('kind-link', 'https://github.com/login/device'));
  await expect(popup.getByTestId('overlay-toast')).toHaveCount(3);
  for (const theme of THEMES) {
    await showShellTheme(app, theme);
    await expect(popup.locator('body')).toHaveAttribute('data-vscode-theme-kind', `vscode-${theme}`);
    await popup.mouse.move(0, 0);
    await settled(popup);
    // the page alone with its transparency kept, and the window as the screen composites it
    await popupShot(popup, testInfo, `popups-page-alpha-${theme}`);
    const bounds = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find((each) => each.isAlwaysOnTop())!.getBounds());
    const png = await app.evaluate(async ({ desktopCapturer, screen }, box) => {
      const display = screen.getPrimaryDisplay();
      const thumbnailSize = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
      const source = sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0]!;
      const scale = source.thumbnail.getSize().width / display.bounds.width;
      const margin = 24;
      return source.thumbnail.crop({
        x: Math.round((box.x - margin - display.bounds.x) * scale),
        y: Math.round((box.y - margin - display.bounds.y) * scale),
        width: Math.round((box.width + margin * 2) * scale),
        height: Math.round((box.height + margin * 2) * scale),
      }).toPNG().toString('base64');
    }, bounds);
    fs.writeFileSync(path.join(process.env.DAMOCLES_SCREENSHOT_DIR ?? testInfo.outputDir, `popups-on-screen-${theme}.png`), Buffer.from(png, 'base64'));
  }
});

test('slice 15: the link notice is axe-clean, at rest and after Copy, in Dark and Light', async ({ clipboard: _clipboard, launch }) => {
  const { app } = await launch();
  const tab = await activeChat(app);
  await postFromWebview(tab, { type: 'openSessionLog' });
  const popup = await popupPage(app);
  await expect(popup.getByTestId('overlay-toast')).toHaveCount(1);
  for (const theme of THEMES) {
    await showShellTheme(app, theme);
    await expect(popup.locator('body')).toHaveAttribute('data-vscode-theme-kind', `vscode-${theme}`);
    const id = `axe-${theme}`;
    await sendToast(app, linkToast(id, 'https://github.com@evil.example:8443/login/device?next=%2Fsettings'));
    const card = popup.locator(`[data-toast-id="${id}"]`);
    await expect(card).toBeVisible();
    await expectNoAxeViolations(popup, '[data-testid="overlay-toasts"]');
    await card.getByTestId('link-copy').click();
    await expect(card.getByTestId('link-copy')).toHaveText('Copied');
    await expectNoAxeViolations(popup, '[data-testid="overlay-toasts"]');
    await dropToast(app, id);
    await expect(card).toHaveCount(0);
  }
});
