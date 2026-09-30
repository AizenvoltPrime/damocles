import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { chatTab, expect, test } from './support/fixtures';
import { REPO_ROOT } from './support/hermetic';
import { chatInput } from './support/ui';
import { shellPage } from './support/shell';
import { menuLabels } from './support/shell-ui';

const nlsEl = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.nls.el.json'), 'utf8')) as Record<string, string>;
const GREEK_PLACEHOLDER = 'Ρωτήστε τον Damocles οτιδήποτε...';

async function menuLabel(app: ElectronApplication, id: string): Promise<string | undefined> {
  return (await menuLabels(app)).find((item) => item.id === id)?.label;
}

async function expectGreek(app: ElectronApplication, tab: Page): Promise<void> {
  await expect(tab.getByPlaceholder(GREEK_PLACEHOLDER)).toBeVisible();
  const shell = await shellPage(app);
  await expect(shell.getByRole('tablist', { name: 'Ανοιχτές καρτέλες' })).toBeVisible();
  await expect(shell.getByRole('navigation', { name: 'Έργα' })).toBeVisible();
  await expect(shell.locator('html')).toHaveAttribute('lang', 'el');
  // A package.nls.el.json command title and a host l10n bundle string.
  await expect.poll(() => menuLabel(app, 'damocles.showLog')).toBe(nlsEl['command.showLog.title']);
  expect((await menuLabels(app)).map((item) => item.label)).toContain('Προβολή');
}

test('switching to Greek localizes the webview, the shell and the menus, and survives a restart', async ({ launch }) => {
  let desktop = await launch({ args: ['--lang=en-US'] });
  let tab = await chatTab(desktop.app);
  await expect(chatInput(tab)).toBeVisible();
  const shell = await shellPage(desktop.app);
  await expect(shell.getByRole('tablist', { name: 'Open tabs' })).toBeVisible();
  expect(await menuLabel(desktop.app, 'damocles.showLog')).toBe('Show Log');

  await tab.getByRole('button', { name: 'Settings', exact: true }).click();
  await tab.getByRole('combobox').filter({ hasText: 'English' }).click();
  await tab.getByRole('option', { name: 'Ελληνικά' }).click();
  await expect(tab.getByText('Γλώσσα', { exact: true })).toBeVisible();
  await expectGreek(desktop.app, tab);

  await desktop.close();
  desktop = await launch({ args: ['--lang=en-US'] });
  tab = await chatTab(desktop.app);
  await expectGreek(desktop.app, tab);
});

test('a first launch takes its language from the OS locale', async ({ launch }) => {
  const { app } = await launch({ args: ['--lang=el-GR'] });
  expect(await app.evaluate(({ app: electronApp }) => electronApp.getLocale())).toMatch(/^el/);
  const tab = await chatTab(app);
  await expectGreek(app, tab);
});
