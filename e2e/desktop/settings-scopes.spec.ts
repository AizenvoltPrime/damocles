import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { chatTab, expect, nextTab, test } from './support/fixtures';
import { writeUserSettings } from './support/hermetic';
import { addProject, answerMessageBoxes, chatInput, hostMessages, postFromWebview, recordHostMessages, TRUST_PROMPT } from './support/ui';

interface SettingsUpdate {
  settings: { maxTurns: number; maxBudgetUsd: number | null; taskBudget: number | null; defaultPermissionMode: string; cacheWarming: string };
  settingSources?: Record<string, { scope: string; path: string }>;
}

const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

async function latestSettings(tab: Page): Promise<SettingsUpdate | undefined> {
  return (await hostMessages(tab, 'settingsUpdate')).at(-1) as SettingsUpdate | undefined;
}

test('settings scopes: an untrusted project is ignored, trust applies it live, user-only keys never come from it, writes land in the right file', async ({ home, launch }) => {
  const userFile = path.join(home.damoclesDir, 'settings.json');
  const projectFile = path.join(home.project, '.damocles', 'settings.json');
  const localFile = path.join(home.project, '.damocles', 'settings.local.json');
  writeUserSettings(home, { 'damocles.maxTurns': 50, 'damocles.permissionMode': 'acceptEdits' });
  fs.mkdirSync(path.dirname(projectFile), { recursive: true });
  const projectSettings = {
    permissions: { allow: ['Read'] },
    'damocles.maxTurns': 7,
    // restricted (capabilities.untrustedWorkspaces.restrictedConfigurations) and application scoped: never read from a project
    'damocles.permissionMode': 'plan',
    'damocles.cacheWarming': 'idle',
  };
  fs.writeFileSync(projectFile, JSON.stringify(projectSettings, null, 2));
  fs.writeFileSync(localFile, JSON.stringify({ 'damocles.maxBudgetUsd': 3 }, null, 2));

  const desktop = await launch();
  const homeTab = await chatTab(desktop.app);
  await expect(chatInput(homeTab)).toBeVisible();
  const opened = nextTab(desktop.app, [homeTab]);
  await addProject(desktop.app, home.project, false);
  const alpha = await opened;
  await expect(chatInput(alpha)).toBeVisible();
  await recordHostMessages(alpha);

  // An external edit of the user file reaches every panel; the untrusted project's files stay ignored.
  writeUserSettings(home, { 'damocles.taskBudget': 2000 });
  await expect.poll(async () => (await latestSettings(alpha))?.settings.taskBudget).toBe(2000);
  const untrusted = (await latestSettings(alpha))!;
  expect(untrusted.settings).toMatchObject({ maxTurns: 50, maxBudgetUsd: null, defaultPermissionMode: 'acceptEdits', cacheWarming: 'streaming' });
  expect(untrusted.settingSources).toEqual({});

  // Granting trust applies the project and local files with no restart; the user-only keys stay on the user file.
  await answerMessageBoxes(desktop.app, { [TRUST_PROMPT]: 'Trust Folder' });
  await postFromWebview(alpha, { type: 'setProjectTrusted' });
  await expect.poll(async () => (await latestSettings(alpha))?.settings.maxTurns).toBe(7);
  const trusted = (await latestSettings(alpha))!;
  expect(trusted.settings).toMatchObject({ maxTurns: 7, maxBudgetUsd: 3, defaultPermissionMode: 'acceptEdits', cacheWarming: 'streaming' });
  expect(trusted.settingSources).toEqual({
    'damocles.maxTurns': { scope: 'project', path: projectFile },
    'damocles.maxBudgetUsd': { scope: 'local', path: localFile },
  });

  // A value the local file supplies is written back there; a user-only key and an unset key go to the user file.
  await postFromWebview(alpha, { type: 'setBudgetLimit', budgetUsd: 9 });
  await expect.poll(() => readJson(localFile)['damocles.maxBudgetUsd']).toBe(9);
  await postFromWebview(alpha, { type: 'setDefaultPermissionMode', mode: 'default' });
  await expect.poll(() => readJson(userFile)['damocles.permissionMode']).toBe('default');
  expect(readJson(projectFile)).toEqual(projectSettings);
  await expect.poll(async () => (await latestSettings(alpha))?.settings).toMatchObject({ maxBudgetUsd: 9, defaultPermissionMode: 'default' });

  // An external edit of the project file applies live.
  fs.writeFileSync(projectFile, JSON.stringify({ ...projectSettings, 'damocles.maxTurns': 11 }, null, 2));
  await expect.poll(async () => (await latestSettings(alpha))?.settings.maxTurns).toBe(11);
});
