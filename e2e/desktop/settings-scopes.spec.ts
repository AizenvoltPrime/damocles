import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { seedStubModel, writeUserSettings } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { shellState } from './support/shell';
import { projectKeyOf, projectRow, readyShell } from './support/shell-ui';
import { closeSettingsModal, openSettingsModal, settingsNav, settingsRow } from './support/settings';
import { addProject, answerDialogs, chatInput, hostMessages, postFromWebview, recordHostMessages, sendAndAwaitEcho, TRUST_PROMPT } from './support/ui';

interface SettingsUpdate {
  settings: { maxTurns: number; maxBudgetUsd: number | null; taskBudget: number | null; defaultPermissionMode: string; cacheWarming: string };
  settingSources?: Record<string, { scope: string; path: string; value: unknown }>;
}

const readJson = (file: string): Record<string, unknown> => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> : {});

async function latestSettings(tab: Page): Promise<SettingsUpdate | undefined> {
  return (await hostMessages(tab, 'settingsUpdate')).at(-1) as SettingsUpdate | undefined;
}

test('settings scopes: an untrusted project is ignored, trust applies it live, and each section saves where D37 says, the badge naming the file', async ({ home, launch }) => {
  const userFile = path.join(home.damoclesDir, 'settings.json');
  const projectFile = path.join(home.project, '.damocles', 'settings.json');
  const localFile = path.join(home.project, '.damocles', 'settings.local.json');
  writeUserSettings(home, { 'damocles.maxTurns': 50, 'damocles.permissionMode': 'acceptEdits' });
  fs.mkdirSync(path.dirname(projectFile), { recursive: true });
  const projectSettings = {
    permissions: { allow: ['Read'] },
    'damocles.maxTurns': 7,
    'damocles.team.enabled': false,
    // restricted (capabilities.untrustedWorkspaces.restrictedConfigurations) and application scoped: never read from a project
    'damocles.permissionMode': 'plan',
    'damocles.cacheWarming': 'idle',
  };
  fs.writeFileSync(projectFile, JSON.stringify(projectSettings, null, 2));
  fs.writeFileSync(localFile, JSON.stringify({ 'damocles.maxBudgetUsd': 3 }, null, 2));

  const desktop = await launch();
  const homeTab = await activeChat(desktop.app);
  await expect(chatInput(homeTab)).toBeVisible();
  const opened = nextChat(desktop.app, [homeTab]);
  await addProject(desktop.app, home.project, false);
  const alpha = await opened;
  await expect(chatInput(alpha)).toBeVisible();
  await recordHostMessages(alpha);

  // An external edit of the user file reaches every chat; the untrusted project's files stay ignored.
  writeUserSettings(home, { 'damocles.taskBudget': 2000 });
  await expect.poll(async () => (await latestSettings(alpha))?.settings.taskBudget).toBe(2000);
  const untrusted = (await latestSettings(alpha))!;
  expect(untrusted.settings).toMatchObject({ maxTurns: 50, maxBudgetUsd: null, defaultPermissionMode: 'acceptEdits', cacheWarming: 'streaming' });
  expect(untrusted.settingSources).toEqual({});

  // Granting trust applies the project and local files with no restart; the user-only keys stay on the user file.
  await answerDialogs(desktop.app, { [TRUST_PROMPT]: 'Trust Folder' });
  await postFromWebview(alpha, { type: 'setProjectTrusted' });
  await expect.poll(async () => (await latestSettings(alpha))?.settings.maxTurns).toBe(7);
  const trusted = (await latestSettings(alpha))!;
  expect(trusted.settings).toMatchObject({ maxTurns: 7, maxBudgetUsd: 3, defaultPermissionMode: 'acceptEdits', cacheWarming: 'streaming' });
  expect(trusted.settingSources).toEqual({
    'damocles.maxTurns': { scope: 'project', path: projectFile, value: 7 },
    'damocles.team.enabled': { scope: 'project', path: projectFile, value: false },
    'damocles.maxBudgetUsd': { scope: 'local', path: localFile, value: 3 },
  });

  // Workspace saves in the chat folder's personal file.
  const overlay = await openSettingsModal(desktop.app, 'workspace');
  const budget = settingsRow(overlay, 'damocles.maxBudgetUsd');
  await budget.getByRole('textbox').fill('9');
  await budget.getByRole('textbox').press('Enter');
  await expect.poll(() => readJson(localFile)['damocles.maxBudgetUsd']).toBe(9);
  await expect(budget.getByTestId('setting-saved')).toHaveAttribute('title', /\.damocles[\\/]settings\.local\.json$/);
  await expect(budget.getByTestId('setting-source')).toContainText('.damocles/settings.local.json');

  // Defaults for new chats save in user settings.
  await settingsNav(overlay, 'defaults').click();
  const yolo = settingsRow(overlay, 'damocles.dangerouslySkipPermissions');
  await yolo.getByRole('switch').click();
  await expect.poll(() => readJson(userFile)['damocles.dangerouslySkipPermissions']).toBe(true);
  await expect(yolo.getByTestId('setting-saved')).toHaveAttribute('title', userFile);

  // Teams saves in user settings, except that the project file already sets the value, so the change lands there.
  await settingsNav(overlay, 'teams').click();
  const teams = settingsRow(overlay, 'damocles.team.enabled');
  await expect(teams.getByTestId('setting-source')).toContainText('.damocles/settings.json');
  await teams.getByRole('switch').click();
  await expect.poll(() => readJson(projectFile)['damocles.team.enabled']).toBe(true);
  expect(readJson(userFile)).not.toHaveProperty('damocles.team.enabled');
  await expect(teams.getByTestId('setting-source')).toContainText('.damocles/settings.json');
  await closeSettingsModal(overlay);

  expect(readJson(projectFile)).toEqual({ ...projectSettings, 'damocles.team.enabled': true });
  await expect.poll(async () => (await latestSettings(alpha))?.settings).toMatchObject({ maxBudgetUsd: 9 });

  // An external edit of the project file applies live.
  fs.writeFileSync(projectFile, JSON.stringify({ ...projectSettings, 'damocles.maxTurns': 11 }, null, 2));
  await expect.poll(async () => (await latestSettings(alpha))?.settings.maxTurns).toBe(11);
});

test('per-folder reads (D38): a chat in project B keeps B\'s budget while project A is selected', async ({ home, launch }) => {
  const alphaDir = home.project;
  const betaDir = path.join(path.dirname(home.project), 'beta');
  for (const [dir, budget] of [[alphaDir, 5], [betaDir, 2]] as const) {
    fs.mkdirSync(path.join(dir, '.damocles'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.damocles', 'settings.local.json'), JSON.stringify({ 'damocles.maxBudgetUsd': budget }));
  }

  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const homeTab = await activeChat(app);
    await expect(chatInput(homeTab)).toBeVisible();
    const alphaOpened = nextChat(app, [homeTab]);
    await addProject(app, alphaDir, true);
    const alpha = await alphaOpened;
    await expect(chatInput(alpha)).toBeVisible();
    const betaOpened = nextChat(app, [homeTab, alpha]);
    await addProject(app, betaDir, true);
    const beta = await betaOpened;
    await expect(chatInput(beta)).toBeVisible();
    // A chat with a conversation stays loaded when the user leaves it; an empty one is dropped.
    await sendAndAwaitEcho(beta, 'keep this chat');
    await recordHostMessages(beta);

    // Selecting alpha makes it the default project, which window-level reads follow; beta's chat keeps reading beta's file.
    const shell = await readyShell(app);
    const alphaKey = await projectKeyOf(app, 'alpha');
    await projectRow(shell, alphaKey).click();
    await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(alphaKey);
    writeUserSettings(home, { 'damocles.taskBudget': 1500 });
    await expect.poll(async () => (await latestSettings(beta))?.settings.taskBudget).toBe(1500);
    expect((await latestSettings(beta))!.settings.maxBudgetUsd).toBe(2);
    expect((await latestSettings(beta))!.settingSources?.['damocles.maxBudgetUsd']).toEqual({ scope: 'local', path: path.join(betaDir, '.damocles', 'settings.local.json'), value: 2 });
  } finally {
    await stub.close();
  }
});
