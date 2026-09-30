import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chatTab, expect, nextTab, test } from './support/fixtures';
import { writeUserSettings } from './support/hermetic';
import { addProject, chatInput } from './support/ui';

test('compass: an index a newer Damocles upgraded while this one runs shows read only and explains the disabled rebuild', async ({ home, launch }) => {
  test.setTimeout(180_000);
  fs.writeFileSync(path.join(home.project, 'index.ts'), 'export function shared(): number {\n  return 1;\n}\n');
  writeUserSettings(home, { 'damocles.compass.enabled': true });
  const { app } = await launch();
  const homeTab = await chatTab(app);
  await expect(chatInput(homeTab)).toBeVisible();
  const opened = nextTab(app, [homeTab]);
  await addProject(app, home.project, true);
  const tab = await opened;
  await expect(chatInput(tab)).toBeVisible();

  const pill = tab.getByRole('button', { name: /\d+ nodes/ });
  await expect(pill).toBeVisible({ timeout: 120_000 });
  await pill.click();
  const reindex = tab.getByTestId('compass-reindex');
  await expect(reindex).toHaveText('Reindex');
  await expect(reindex).toBeEnabled();

  // A newer app migrates the shared index past this app's schema while this window holds it open.
  const [indexDir] = fs.readdirSync(path.join(home.damoclesDir, 'compass'));
  const db = new DatabaseSync(path.join(home.damoclesDir, 'compass', indexDir!, 'graph.db'));
  try {
    db.prepare("UPDATE metadata SET value = '999' WHERE key = 'schema_version'").run();
  } finally {
    db.close();
  }
  await reindex.click();

  await expect(tab.getByTestId('compass-read-only-state')).toHaveText('Read only', { timeout: 60_000 });
  await expect(tab.getByTestId('compass-read-only-pill')).toBeVisible();
  const notice = tab.getByTestId('compass-read-only-notice');
  await expect(notice).toHaveText('A newer Damocles updated this index, so this version can only read it. Update Damocles to rebuild it.');
  await expect(reindex).toBeDisabled();
  await expect(reindex).toHaveAccessibleDescription('A newer Damocles updated this index, so this version can only read it. Update Damocles to rebuild it.');
});
