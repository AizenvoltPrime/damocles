import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { cleanUp, endLeftoverDaemon, LOCAL_DAEMON, LOOPBACK_ENV, LOOPBACK_TAG, openThroughLocalDaemon, shutdownDaemon } from './support/loopback';
import { overlayPage } from './support/shell';

type PickHooks = { __damoclesE2e: { remote: { pick(authority: string, kind: 'file' | 'folder', options: object): Promise<string | undefined> } } };

/** Asks the loopback authority's picker as its core's dialogs.pickFile or dialogs.pickFolder does; settles once answered. */
const pick = (app: ElectronApplication, kind: 'file' | 'folder', options: object = {}): Promise<string | undefined> =>
  app.evaluate((_electron, [k, o]) => (globalThis as unknown as PickHooks).__damoclesE2e.remote.pick('loopback', k, o), [kind, options] as const);
const browser = (overlay: Page, mode: 'file' | 'folder'): Locator => overlay.locator(`[data-testid="connect-dialog"][data-pick-mode="${mode}"]`);
const entry = (scope: Locator, name: string): Locator => scope.getByTestId('folder-list').getByRole('option', { name, exact: true });

test('the loopback core\'s pickFolder and pickFile open the daemon\'s folder browser inside its project and answer the chosen path; cancel answers undefined', { tag: LOOPBACK_TAG }, async ({ foreground: _foreground, home, launch }, testInfo) => {
  test.setTimeout(300_000);
  const folder = path.join(home.root, 'p', 'remote');
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'plan.md'), '# Plan\n');
  const { app } = await launch(LOOPBACK_ENV);
  let failure: unknown;
  try {
    await openThroughLocalDaemon(app, folder);
    const overlay = await overlayPage(app);

    // pickFolder lists folders only, from the project, and answers the folder the user entered.
    let answer = pick(app, 'folder', { defaultPath: folder, buttonLabel: 'Use Folder' });
    const folders = browser(overlay, 'folder');
    await expect(folders).toHaveAccessibleName(`Choose a folder on ${LOCAL_DAEMON}`);
    await expect(folders.getByTestId('folder-browser-confirm')).toHaveText('Use Folder');
    await expect(entry(folders, 'plan.md')).toHaveCount(0);
    await entry(folders, 'src').dblclick();
    await folders.getByTestId('folder-browser-confirm').click();
    expect(await answer).toBe(path.join(folder, 'src'));

    // pickFile with the core's title: a file chosen with Enter; then Cancel answers undefined.
    answer = pick(app, 'file', { title: 'Select Plan File to Inject', defaultPath: folder });
    const files = browser(overlay, 'file');
    await expect(files).toHaveAccessibleName(`${LOCAL_DAEMON}: Select Plan File to Inject`);
    await expect(files.getByTestId('folder-browser-confirm')).toHaveText('Choose');
    await entry(files, 'plan.md').click();
    await entry(files, 'plan.md').press('Enter');
    expect(await answer).toBe(path.join(folder, 'plan.md'));
    answer = pick(app, 'file', { defaultPath: folder });
    await files.getByTestId('folder-browser-cancel').click();
    expect(await answer).toBeUndefined();
    answer = pick(app, 'folder', { defaultPath: folder });
    await expect(folders).toBeVisible();
    await overlay.keyboard.press('Escape');
    expect(await answer).toBeUndefined();
    await expect(folders).toHaveCount(0);

    await shutdownDaemon(app, home);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => endLeftoverDaemon(app, home));
  }
});
