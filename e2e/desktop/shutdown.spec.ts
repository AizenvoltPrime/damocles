import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { isAlive, mainLog, readyCorePid } from './support/app';
import { activeTab, DOCUMENT_END, editorShows, filesRow, openInEditor } from './support/editor';
import { activeChat, expect, test } from './support/fixtures';
import { writeUserSettings } from './support/hermetic';
import { openProjectChat } from './support/screenshots';
import { overlayPage, selectedProjectKey, shellPage } from './support/shell';
import { chatInput } from './support/ui';

// A quit takes about a second; its teardown is bounded at 10 s.
const QUIT_BUDGET_MS = 15_000;
// CLOSE_TIMEOUT_MS in src/desktop/main/index.ts: how long main waits for core.shutdown's reply before it kills core.
const CORE_SHUTDOWN_BOUND_MS = 3_000;
// The OS removes a killed process a moment after main exits.
const CORE_EXIT_MS = 5_000;

interface FlushHold {
  readonly reached: boolean;
  release(): void;
}
type HoldGlobals = typeof globalThis & {
  __damoclesE2e?: { holdStoreFlush(): FlushHold; holdCoreShutdown(): Promise<void> };
  __e2eFlushHold?: FlushHold;
};

// The quit's store flush runs after the core disposed; held open, it shows what could still call into the disposed core.
test('a quit closes every page before the core disposes, so no request can reach a disposed service', async ({ home, launch }) => {
  const { app } = await launch({ env: { DAMOCLES_E2E_HOOKS: '1' } });
  await expect(chatInput(await activeChat(app))).toBeVisible();
  const proc = app.process();
  const core = await readyCorePid(app, home);
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
  expect(shutdown.indexOf('[window] closed')).toBeLessThan(shutdown.search(new RegExp(`\\[core\\] shut down in \\d+ ms \\(pid ${core}\\)`)));
  // window-all-closed during a quit means Electron no longer counted it as quitting.
  expect(shutdown).not.toContain('[window] all windows closed');
  expect(shutdown).toContain('[shutdown] will-quit');
  await expect.poll(() => isAlive(core), { timeout: CORE_EXIT_MS, message: `Damocles Core (pid ${core}) outlived the app` }).toBe(false);
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
  expect(shutdown).toContain('[core] shut down in ');
  expect(shutdown).not.toContain('teardown did not finish');
  expect(fs.existsSync(path.join(home.project, 'src', 'kept.ts'))).toBe(true);
});

test('a quit whose engine dispose hangs kills Damocles Core at the bound and still exits cleanly', async ({ home, launch }) => {
  const desktop = await launch({ env: { DAMOCLES_E2E_HOOKS: '1' } });
  await expect(chatInput(await activeChat(desktop.app))).toBeVisible();
  const proc = desktop.app.process();
  const core = await readyCorePid(desktop.app, home);
  await desktop.app.evaluate(() => (globalThis as HoldGlobals).__damoclesE2e!.holdCoreShutdown());
  await desktop.app.evaluate(({ app: electronApp }) => {
    setImmediate(() => electronApp.quit());
  });
  await expect.poll(() => proc.exitCode !== null || proc.signalCode !== null, { timeout: QUIT_BUDGET_MS, message: 'the app is still running' }).toBe(true);
  expect(proc.exitCode).toBe(0);
  const log = mainLog(home);
  const shutdown = log.slice(log.indexOf('[shutdown] quitting'));
  expect(shutdown).toContain(`[core] shutdown did not finish within ${CORE_SHUTDOWN_BOUND_MS} ms; killing Damocles Core (pid ${core})`);
  expect(shutdown).toContain(`[core] exited (pid ${core},`);
  expect(shutdown).not.toContain('[core] shut down in');
  // A kill main asked for is no crash: nothing restarts during the quit.
  expect(shutdown).not.toContain('[core] stopped unexpectedly');
  expect(shutdown).not.toContain('[core] started');
  expect(shutdown).toContain('[shutdown] will-quit');
  await expect.poll(() => isAlive(core), { timeout: CORE_EXIT_MS, message: `Damocles Core (pid ${core}) outlived the app` }).toBe(false);
});
