import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { mainLog } from './support/app';
import { activeTab, DOCUMENT_END, editorShows, filesRow, openInEditor } from './support/editor';
import { activeChat, expect, test } from './support/fixtures';
import { writeUserSettings } from './support/hermetic';
import { openProjectChat } from './support/screenshots';
import { overlayPage, selectedProjectKey, shellPage } from './support/shell';
import { chatInput } from './support/ui';

// A quit takes about a second; its teardown is bounded at 10 s.
const QUIT_BUDGET_MS = 15_000;

interface FlushHold {
  readonly reached: boolean;
  release(): void;
}
type HoldGlobals = typeof globalThis & {
  __damoclesE2e?: { holdStoreFlush(): FlushHold };
  __e2eFlushHold?: FlushHold;
};

// The quit's store flush runs after the core disposed; held open, it shows what could still call into the disposed core.
test('a quit closes every page before the core disposes, so no request can reach a disposed service', async ({ home, launch }) => {
  const { app } = await launch({ env: { DAMOCLES_E2E_HOOKS: '1' } });
  await expect(chatInput(await activeChat(app))).toBeVisible();
  const proc = app.process();
  await app.evaluate(() => {
    const globals = globalThis as HoldGlobals;
    globals.__e2eFlushHold = globals.__damoclesE2e!.holdStoreFlush();
  });
  await app.evaluate(({ app: electronApp }) => {
    setImmediate(() => electronApp.quit());
  });
  await expect.poll(() => app.evaluate(() => (globalThis as HoldGlobals).__e2eFlushHold!.reached), { timeout: QUIT_BUDGET_MS }).toBe(true);

  await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().map((contents) => contents.getURL())), { timeout: 5_000 }).toEqual([]);
  await app.evaluate(() => (globalThis as HoldGlobals).__e2eFlushHold!.release());
  await expect.poll(() => proc.exitCode !== null || proc.signalCode !== null, { timeout: QUIT_BUDGET_MS, message: 'the app is still running' }).toBe(true);
  const log = mainLog(home);
  const shutdown = log.slice(log.indexOf('[shutdown] quitting'));
  expect(shutdown.indexOf('[window] closed')).toBeGreaterThan(0);
  expect(shutdown.indexOf('[window] closed')).toBeLessThan(shutdown.indexOf('Damocles core disposed'));
  // window-all-closed during a quit means Electron no longer counted it as quitting.
  expect(shutdown).not.toContain('[window] all windows closed');
  expect(shutdown).toContain('[shutdown] will-quit');
});

const windowVisible = (app: ElectronApplication): Promise<boolean> => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible());

test('a quit while the window is hidden to the tray shows it to ask, every close and quit meanwhile shares that one question, and Escape keeps the app running', async ({ home, launch }) => {
  fs.writeFileSync(path.join(home.project, 'draft.ts'), 'export const draft = 1;\n');
  writeUserSettings(home, { 'damocles.desktop.restoreLayout': false });
  const { app, close } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  expect(await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath: 'draft.ts' })).toMatchObject({ ok: true });
  await editorShows(shell, 'draft = 1');
  await shell.keyboard.press(DOCUMENT_END);
  await shell.keyboard.type('// unsaved');
  await expect.poll(async () => (await activeTab(app))?.dirty).toBe(true);
  const overlay = await overlayPage(app);
  const dialog = overlay.getByRole('alertdialog');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide());
  expect(await windowVisible(app)).toBe(false);
  // The tray's Quit, then Alt+F4 and a second Quit while the question is open.
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    setImmediate(() => {
      electronApp.quit();
      BrowserWindow.getAllWindows()[0]!.close();
      electronApp.quit();
    });
  });
  await expect(dialog).toContainText('draft.ts');
  await expect.poll(() => windowVisible(app)).toBe(true);
  await overlay.keyboard.press('Escape');
  await expect.poll(() => mainLog(home)).toContain('[shutdown] cancelled');
  await expect(dialog).toHaveCount(0);
  expect(await windowVisible(app)).toBe(true);
  expect(await activeTab(app)).toMatchObject({ dirty: true });

  // A later quit asks again and goes through.
  const quitting = close();
  await expect(dialog).toContainText('draft.ts');
  await dialog.getByRole('button', { name: "Don't Save", exact: true }).click();
  await quitting;
  expect(fs.readFileSync(path.join(home.project, 'draft.ts'), 'utf8')).not.toContain('// unsaved');
});

test('a quit while a page waits on a question dismisses it once the window closes, so the core still disposes and the stores flush', async ({ home, launch }) => {
  fs.mkdirSync(path.join(home.project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(home.project, 'src', 'kept.ts'), 'export {};\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  const dialog = (await overlayPage(app)).getByRole('alertdialog');
  await filesRow(shell, 'src').click();
  await filesRow(shell, 'src/kept.ts').focus();
  await shell.keyboard.press('Delete');
  await expect(dialog).toContainText('kept.ts');

  const proc = app.process();
  await app.evaluate(({ app: electronApp }) => {
    setImmediate(() => electronApp.quit());
  });
  await expect.poll(() => proc.exitCode !== null || proc.signalCode !== null, { timeout: QUIT_BUDGET_MS, message: 'the app is still running' }).toBe(true);
  const log = mainLog(home);
  const shutdown = log.slice(log.indexOf('[shutdown] quitting'));
  expect(shutdown).toContain('[dialog] the window closed for a quit; the question is dismissed');
  expect(shutdown).toContain('Damocles core disposed');
  expect(shutdown).not.toContain('teardown did not finish');
  expect(fs.existsSync(path.join(home.project, 'src', 'kept.ts'))).toBe(true);
});
