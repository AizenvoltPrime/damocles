import { activeChat, expect, test } from './support/fixtures';
import { shellPage, shellState } from './support/shell';
import { chatInput } from './support/ui';

test('the title bar draws the window controls off macOS, and maximize toggles to restore and back', async ({ launch }) => {
  test.skip(process.platform === 'darwin', 'macOS keeps its traffic lights');
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  const shell = await shellPage(app);
  const maximize = shell.getByTestId('window-maximize');
  await expect(maximize).toHaveAttribute('aria-label', 'Maximize');

  await maximize.click();
  await expect.poll(async () => (await shellState(app)).windowState).toBe('maximized');
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized())).toBe(true);
  await expect(maximize).toHaveAttribute('aria-label', 'Restore');

  await maximize.click();
  await expect.poll(async () => (await shellState(app)).windowState).toBe('normal');
  await expect(maximize).toHaveAttribute('aria-label', 'Maximize');
});
