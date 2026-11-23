import type { ElectronApplication } from '@playwright/test';
import { activeChat, expect, test } from './support/fixtures';
import { openSettingsModal, settingsRow } from './support/settings';
import { onMainWindow, SHELL_URL } from './support/shell';

// Position and content size, which Electron reads exactly; getBounds reads a DIP large at 150% on Windows, but must not drift.
function placement(app: ElectronApplication) {
  return onMainWindow(app, (win) => {
    const [x, y] = win.getPosition();
    const [width, height] = win.getContentSize();
    return { bounds: { x, y, width, height }, outer: win.getBounds(), maximized: win.isMaximized(), minimum: win.getMinimumSize() };
  });
}

// Each launch persists what the last one restored, so a restore that is not idempotent drifts a little more every launch.
test('window bounds survive restarts without drifting', async ({ launch }) => {
  const bounds = { x: 40, y: 50, width: 960, height: 640 };
  let desktop = await launch();
  await activeChat(desktop.app);
  await onMainWindow(desktop.app, (win, b) => win.setBounds(b), bounds);
  const left = await placement(desktop.app);
  expect(left).toMatchObject({ bounds, maximized: false, minimum: [900, 600] });
  await desktop.close();

  for (const restart of [1, 2, 3, 4]) {
    desktop = await launch();
    await activeChat(desktop.app);
    expect(await placement(desktop.app), `restart ${restart}`).toEqual(left);
    await desktop.close();
  }
});

// Whether the window lies wholly on the work area of the display it is on.
function onWorkArea(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow, screen }, shellUrl) => {
    const win = BrowserWindow.getAllWindows().find((each) => each.webContents.getURL().startsWith(shellUrl))!;
    const [x = 0, y = 0] = win.getPosition();
    const [width = 0, height = 0] = win.getContentSize();
    const area = screen.getDisplayMatching({ x, y, width, height }).workArea;
    return x >= area.x && y >= area.y && x + width <= area.x + area.width && y + height <= area.y + area.height;
  }, SHELL_URL);
}

// The default content size, 1280 by 820, fit to the work area of the window's display, which on a CI runner is smaller.
function defaultSize(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow, screen }, shellUrl) => {
    const { workArea } = screen.getDisplayMatching(BrowserWindow.getAllWindows().find((each) => each.webContents.getURL().startsWith(shellUrl))!.getBounds());
    return { width: Math.min(1280, workArea.width), height: Math.min(820, workArea.height) };
  }, SHELL_URL);
}

test('a first launch and Restore default layout give the window exactly the default content size on the work area', async ({ launch }) => {
  const { app } = await launch();
  await activeChat(app);
  expect((await placement(app)).bounds).toMatchObject(await defaultSize(app));
  expect(await onWorkArea(app)).toBe(true);

  await onMainWindow(app, (win) => win.setBounds({ x: 40, y: 50, width: 960, height: 640 }));
  const overlay = await openSettingsModal(app, 'appearance');
  await settingsRow(overlay, 'restore-default-layout').getByRole('button', { name: 'Restore defaults' }).click();
  const expected = await defaultSize(app);
  await expect.poll(async () => (await placement(app)).bounds).toMatchObject(expected);
  expect(await onWorkArea(app)).toBe(true);
});
