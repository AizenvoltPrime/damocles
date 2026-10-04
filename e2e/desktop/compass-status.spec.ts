import * as fs from 'node:fs';
import * as path from 'node:path';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { writeUserSettings } from './support/hermetic';
import { addProject, chatInput } from './support/ui';

// The index of a one-file project finishes before the new tab's page loads, so no later status change re-posts it.
test('compass: a newly added project tab shows its index status, and again after the page reloads', async ({ home, launch }) => {
  test.setTimeout(180_000);
  fs.writeFileSync(path.join(home.project, 'index.ts'), 'export function shared(): number {\n  return 1;\n}\n');
  writeUserSettings(home, { 'damocles.compass.enabled': true });
  const { app } = await launch();
  const homeTab = await activeChat(app);
  await expect(chatInput(homeTab)).toBeVisible();
  const opened = nextChat(app, [homeTab]);
  await addProject(app, home.project, true);
  const tab = await opened;
  await expect(chatInput(tab)).toBeVisible();

  const pill = tab.getByRole('button', { name: /\d+ nodes/ });
  await expect(pill).toBeVisible({ timeout: 60_000 });

  await tab.reload();
  await expect(chatInput(tab)).toBeVisible();
  await expect(pill).toBeVisible();
});
