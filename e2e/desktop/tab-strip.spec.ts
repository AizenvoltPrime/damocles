import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { chatTab, expect, nextTab, test } from './support/fixtures';
import { addProject, chatInput } from './support/ui';
import { pressKeys, shellPage } from './support/shell';

const MOVE_TAB_RIGHT = process.platform === 'darwin' ? 'Meta+Shift+ArrowRight' : 'Control+Shift+ArrowRight';

test('the tab strip exposes tab roles and names and works by keyboard alone', async ({ home, launch }) => {
  const { app } = await launch();
  const homeTab = await chatTab(app);
  await expect(chatInput(homeTab)).toBeVisible();
  const shell = await shellPage(app);
  const project = path.basename(home.project);

  const opened = nextTab(app, [homeTab]);
  await addProject(app, home.project, true);
  const alphaTab = await opened;
  await expect(chatInput(alphaTab)).toBeVisible();

  const tablist = shell.getByRole('tablist', { name: 'Open tabs' });
  const tabs = tablist.getByRole('tab');
  await expect(tabs).toHaveCount(2);
  // The home tab moves to the first project when one is added, so both tabs carry its name.
  await expect(tabs.nth(0)).toHaveAccessibleName(`New conversation, ${project}`);
  const alpha = tabs.nth(1);
  await expect(alpha).toHaveAccessibleName(`New conversation, ${project}`);
  await expect(alpha).toHaveAttribute('aria-selected', 'true');
  await expect(shell.getByRole('tabpanel', { name: `New conversation, ${project}` })).toBeAttached();
  await expect(tablist.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  await expect(shell.getByRole('navigation', { name: 'Projects' }).getByText(project, { exact: true })).toBeVisible();

  // F6 (View > Focus Next Part) from the chat view, with no pane shown, moves to the tab strip; Electron input events reach menu accelerators, CDP key presses do not.
  const pressF6 = (from: Page) => pressKeys(app, from.url(), 'F6');
  await pressF6(alphaTab);
  await expect(alpha).toBeFocused();

  // Arrows move focus without selecting; Enter selects.
  await shell.keyboard.press('ArrowLeft');
  const homeStripTab = tabs.nth(0);
  await expect(homeStripTab).toBeFocused();
  await expect(alpha).toHaveAttribute('aria-selected', 'true');
  await shell.keyboard.press('End');
  await expect(alpha).toBeFocused();
  await shell.keyboard.press('Home');
  await expect(homeStripTab).toBeFocused();
  await shell.keyboard.press('Enter');
  await expect(homeStripTab).toHaveAttribute('aria-selected', 'true');
  await expect(tablist.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);

  // Reorder by keyboard: the selected home tab moves after alpha.
  const homeId = await homeStripTab.getAttribute('id');
  await pressF6(homeTab);
  await expect(shell.locator(`[id="${homeId}"]`)).toBeFocused();
  await shell.keyboard.press(MOVE_TAB_RIGHT);
  await expect(tabs.nth(1)).toHaveAttribute('id', homeId!);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(shell.locator(`[id="${homeId}"]`)).toBeFocused();

  // Tab leaves the strip for the close and new-tab buttons; Enter on New tab opens a third tab.
  await shell.keyboard.press('Tab');
  await expect(shell.getByRole('button', { name: /^Close / })).toBeFocused();
  await shell.keyboard.press('Tab');
  await expect(shell.getByRole('button', { name: 'New tab', exact: true })).toBeFocused();
  const third = nextTab(app, app.windows());
  await shell.keyboard.press('Enter');
  const thirdTab = await third;
  await expect(chatInput(thirdTab)).toBeVisible();
  await expect(tabs).toHaveCount(3);

  // Delete closes the focused tab and keeps focus in the strip.
  await pressF6(thirdTab);
  const selected = tablist.getByRole('tab', { selected: true });
  await expect(selected).toBeFocused();
  await shell.keyboard.press('Delete');
  await expect(tabs).toHaveCount(2);
  await expect(tablist.locator('[role="tab"]:focus')).toHaveCount(1);
});
