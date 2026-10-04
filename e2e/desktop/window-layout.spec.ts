import { activeChat, expect, test } from './support/fixtures';

test('window bounds survive a restart', async ({ launch }) => {
  const bounds = { x: 40, y: 50, width: 960, height: 640 };
  let desktop = await launch();
  await activeChat(desktop.app);
  await desktop.app.evaluate(({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0]!.setBounds(b), bounds);
  await expect.poll(() => desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds())).toEqual(bounds);
  await desktop.close();

  desktop = await launch();
  await activeChat(desktop.app);
  const restored = await desktop.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    return { bounds: win.getBounds(), maximized: win.isMaximized(), minimum: win.getMinimumSize() };
  });
  expect(restored).toEqual({ bounds, maximized: false, minimum: [900, 600] });
});
