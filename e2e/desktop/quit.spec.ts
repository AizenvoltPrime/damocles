import * as fs from 'node:fs';
import * as path from 'node:path';
import { mainLog } from './support/app';
import { activeChat, expect, panelIdOf, test } from './support/fixtures';
import { chatInput } from './support/ui';

// A quit takes about a second; the core's own dispose is bounded at 10 s.
const QUIT_BUDGET_MS = 15_000;

// Cmd+Q, the Dock and logout start a quit in native code, as CDP Browser.close does. Playwright's own close calls app.quit()
// from JavaScript, which never exercises that path.
test('a quit started in native code exits in one pass', async ({ home, launch }) => {
  const desktop = await launch();
  const tab = await activeChat(desktop.app);
  await expect(chatInput(tab)).toBeVisible();
  const proc = desktop.app.process();
  const session = await desktop.app.context().newCDPSession(tab);
  // The app exits before it answers.
  session.send('Browser.close').catch(() => undefined);
  await expect.poll(() => proc.exitCode !== null || proc.signalCode !== null, { timeout: QUIT_BUDGET_MS, message: 'the app is still running' }).toBe(true);
  const log = mainLog(home);
  expect(log).toContain('[shutdown] quitting');
  const shutdown = log.slice(log.indexOf('[shutdown] quitting'));
  // window-all-closed during a quit means Electron no longer counted it as quitting; only Windows and Linux then quit again.
  expect(shutdown).not.toContain('[window] all windows closed');
  expect(shutdown).toContain('[shutdown] will-quit');
});

test('a version 1 panels.json migrates: its tabs come back as chats and the file is rewritten as version 2', async ({ home, launch }) => {
  const panelsFile = path.join(home.userData, 'panels.json');
  fs.mkdirSync(home.userData, { recursive: true });
  fs.writeFileSync(panelsFile, JSON.stringify({
    version: 1,
    panels: [{ panelId: 'legacy-tab', kind: 'chat', state: null, pane: { open: false, maximized: false, pages: [] } }],
    selectedPanelId: 'legacy-tab',
  }));
  const { app } = await launch();
  const chat = await activeChat(app);
  expect(panelIdOf(chat)).toBe('legacy-tab');
  await expect(chatInput(chat)).toBeVisible();
  await expect.poll(() => (JSON.parse(fs.readFileSync(panelsFile, 'utf8')) as { version: number }).version).toBe(2);
  await expect.poll(() => mainLog(home)).toContain('[panels] migrated panels.json from version 1 (1 chats)');
});
