import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { DEFAULT_GRID_LAYOUT } from '../../src/desktop/preload/shell-channels';
import { seedStubModel, writeAuth, writeUserSettings, type HermeticHome } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { listChats, projectKeyOf } from './support/shell-ui';
import { addProject, answerDialogs, askHostPassword, chatInput, askedDialogs, hostPromptAnswer, sendAndAwaitEcho } from './support/ui';
import { overlayViewState } from './support/overlay';
import { OVERLAY_URL, overlayPage, pressKeys, PRIMARY, shellPage, shellState, viewFocused } from './support/shell';
import { logBeforeQuit } from './support/app';
import { OVERLAY_ACK_TIMEOUT_MS } from '../../src/desktop/preload/overlay-channels';
import { chooseSegment, closeSettingsModal, openSettingsModal, settingsModal, settingsNav, settingsRow, waitForSettingsState } from './support/settings';

const userSettings = (dir: string): Record<string, unknown> => {
  const file = path.join(dir, 'settings.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> : {};
};

test('the title-bar gear opens settings over the window, and This chat changes the selected chat', async ({ foreground: _foreground, launch }) => {
  const { app } = await launch();
  const tab = await activeChat(app);
  await expect(chatInput(tab)).toBeVisible();

  const overlay = await openSettingsModal(app);
  const modal = settingsModal(overlay);
  await expect(modal).toHaveAttribute('aria-modal', 'true');
  await expect(overlay.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
  await expect(settingsNav(overlay, 'chat')).toHaveAttribute('aria-selected', 'true');
  expect((await overlayViewState(app)).focused).toBe(true);

  await chooseSegment(settingsRow(overlay, 'permission-mode'), 'Plan mode');
  await expect(tab.getByTitle('Plan mode (Shift+Tab to cycle)')).toBeVisible();

  // Up and Down move along the vertical tablist, and the page follows.
  await settingsNav(overlay, 'chat').focus();
  await overlay.keyboard.press('ArrowDown');
  await expect(settingsNav(overlay, 'defaults')).toHaveAttribute('aria-selected', 'true');
  await expect(settingsRow(overlay, 'damocles.model')).toBeVisible();

  await overlay.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect.poll(async () => (await overlayViewState(app)).visible).toBe(false);
});

test('Ctrl+, (Cmd+, on macOS) opens settings from the chat, and Escape returns focus to it', async ({ foreground: _foreground, launch }) => {
  const { app } = await launch();
  const tab = await activeChat(app);
  await expect(chatInput(tab)).toBeVisible();
  await pressKeys(app, '/panel/', ',', [PRIMARY]);
  const overlay = await overlayPage(app);
  await expect(settingsModal(overlay)).toBeVisible();
  await expect(overlay.getByTestId('settings-search')).toBeFocused();
  await overlay.keyboard.press('Escape');
  await expect(settingsModal(overlay)).toHaveCount(0);
  await expect.poll(() => viewFocused(app, tab)).toBe(true);
});

// A reload by any route (DevTools, Ctrl+R in a dev build) commits a new page that cannot take a request until it has loaded.
test('a reload of the overlay page closes the open modal, and settings opened while the reloaded page loads show once it has', async ({ home, launch }) => {
  const desktop = await launch();
  const { app } = desktop;
  await expect(chatInput(await activeChat(app))).toBeVisible();
  const overlay = await openSettingsModal(app);
  // Each new document of the page holds its renderer past main's acknowledgement deadline before any of its scripts run.
  await overlay.addInitScript((blockMs) => {
    const end = Date.now() + blockMs;
    while (Date.now() < end) { /* the page loads slowly */ }
  }, OVERLAY_ACK_TIMEOUT_MS + 1500);
  await app.evaluate(async ({ webContents }, url) => {
    const page = webContents.getAllWebContents().find((contents) => contents.getURL() === url)!;
    const committed = new Promise<void>((resolve) => page.once('did-navigate', () => resolve()));
    page.reload();
    await committed;
  }, OVERLAY_URL);
  await expect.poll(async () => (await overlayViewState(app)).visible).toBe(false);

  await (await shellPage(app)).getByTestId('open-settings').click();
  await expect(settingsModal(overlay)).toBeVisible({ timeout: 15_000 });
  await closeSettingsModal(overlay);
  await desktop.close();
  const log = logBeforeQuit(home);
  expect(log).toContain('[overlay] the page reloaded');
  expect(log).not.toContain('did not acknowledge');
  expect(log).not.toContain('Settings failed: Error: The overlay did not respond');
});

test('search filters every section and Escape clears it before it closes', async ({ launch }) => {
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  const overlay = await openSettingsModal(app);

  const search = overlay.getByTestId('settings-search');
  await search.fill('budget');
  await expect(overlay.getByRole('heading', { name: 'Search results' })).toBeVisible();
  await expect(settingsRow(overlay, 'damocles.maxBudgetUsd')).toBeVisible();
  await expect(settingsRow(overlay, 'permission-mode')).toHaveCount(0);
  await expect(settingsRow(overlay, 'damocles.maxBudgetUsd').locator('mark').first()).toHaveText(/budget/i);

  await search.fill('nothing matches this');
  await expect(overlay.getByText('No settings match "nothing matches this"')).toBeVisible();

  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(settingsModal(overlay)).toBeVisible();
  await closeSettingsModal(overlay);
});

test('a Workspace value lands in the project personal file and its badge names that file', async ({ home, launch }) => {
  const { app } = await launch();
  const first = await activeChat(app);
  await expect(chatInput(first)).toBeVisible();
  const opened = nextChat(app, [first]);
  await addProject(app, home.project, true);
  await expect(chatInput(await opened)).toBeVisible();

  const overlay = await openSettingsModal(app, 'workspace');
  const budget = settingsRow(overlay, 'damocles.maxBudgetUsd');
  await budget.getByRole('textbox').fill('7.5');
  await budget.getByRole('textbox').press('Enter');
  const local = path.join(home.project, '.damocles', 'settings.local.json');
  await expect.poll(() => (fs.existsSync(local) ? JSON.parse(fs.readFileSync(local, 'utf8'))['damocles.maxBudgetUsd'] : undefined)).toBe(7.5);
  await expect(budget.getByTestId('setting-saved')).toHaveAttribute('title', /\.damocles[\\/]settings\.local\.json$/);
  await expect(budget.getByTestId('setting-source')).toContainText('.damocles/settings.local.json');
  await closeSettingsModal(overlay);
});

test('Appearance applies live, and the modal re-attaches to the chat the user selects', async ({ home, launch }) => {
  const { app } = await launch();
  const first = await activeChat(app);
  await expect(chatInput(first)).toBeVisible();

  const overlay = await openSettingsModal(app, 'appearance');
  await chooseSegment(settingsRow(overlay, 'damocles.desktop.theme'), 'Light');
  await expect.poll(() => userSettings(home.damoclesDir)['damocles.desktop.theme']).toBe('light');
  await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light');
  await chooseSegment(settingsRow(overlay, 'damocles.desktop.theme'), 'Dark');
  await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark');

  // The first chat goes to plan mode; a new chat selected while the modal is open re-attaches it to that chat.
  await settingsNav(overlay, 'chat').click();
  const mode = settingsRow(overlay, 'permission-mode');
  await chooseSegment(mode, 'Plan mode');
  const firstId = (await shellState(app)).selected.chatId;
  const shell = await shellPage(app);
  const second = nextChat(app, [first]);
  await shell.evaluate(async () => window.damoclesShell!.newChat((await window.damoclesShell!.getState()).selected.projectKey));
  await expect(chatInput(await second)).toBeVisible();
  expect((await shellState(app)).selected.chatId).not.toBe(firstId);
  await expect(settingsModal(overlay)).toBeVisible();
  await expect(mode.getByRole('button', { name: 'Ask before edits', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await closeSettingsModal(overlay);
});

test('choosing Ελληνικά saves the language and offers Restart now', async ({ home, launch }) => {
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  const overlay = await openSettingsModal(app, 'application');
  await chooseSegment(settingsRow(overlay, 'damocles.desktop.language'), 'Ελληνικά');
  await expect.poll(() => userSettings(home.damoclesDir)['damocles.desktop.language']).toBe('el');
  const banner = overlay.getByTestId('settings-restart-banner');
  await expect(banner).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Restart now' })).toBeVisible();
  await banner.getByRole('button', { name: 'Later' }).click();
  await expect(banner).toHaveCount(0);
});

const CATALOG = ['Fable 5.1', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5', 'GPT-6 Astra', 'GPT-6.1 Sol', 'GPT-6 Luna', 'Step 5 Preview', 'DeepSeek V4 Pro', 'DeepSeek V4.1 Flash'];
const NOT_SIGNED_IN = 'Not signed in';

/** An Anthropic key in pi's auth.json, so Anthropic models are signed in and every other provider is not. */
function signInToAnthropic(home: HermeticHome): void {
  writeAuth(home, { anthropic: { type: 'api_key', key: 'e2e-anthropic-key' } });
}

/** The labels of the open select's options, without the reason a disabled option shows under its label. */
const optionLabels = (overlay: Page) => overlay.getByRole('option').locator('.sm-option-text > span:first-child');

test('Background work defaults to Automatic, marks signed-out models, and a picked model offers Per job and its own levels in user settings', async ({ home, launch }) => {
  signInToAnthropic(home);
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  const overlay = await openSettingsModal(app, 'accounts');
  await waitForSettingsState(overlay);
  const row = settingsRow(overlay, 'damocles.background.model');
  const model = row.getByRole('combobox', { name: 'Background model' });
  const effort = row.getByRole('combobox', { name: 'Background reasoning effort' });
  await expect(model).toHaveText('Automatic');
  await expect(effort).toHaveCount(0);

  await model.click();
  await expect(optionLabels(overlay)).toHaveText(['Automatic', ...CATALOG]);
  const stepfun = overlay.getByRole('option', { name: /^Step 5 Preview/ });
  await expect(stepfun).toHaveAttribute('aria-disabled', 'true');
  await expect(stepfun).toContainText(NOT_SIGNED_IN);
  await overlay.getByRole('option', { name: 'Haiku 5.5', exact: true }).click();
  await expect.poll(() => userSettings(home.damoclesDir)['damocles.background.model']).toBe('claude-haiku-5-5');
  await expect(effort).toHaveText('Per job');
  await effort.click();
  await expect(overlay.getByRole('option')).toHaveText(['Per job', 'Low', 'Medium', 'High', 'Extra High', 'Max', 'Ultracode']);
  await overlay.getByRole('option', { name: 'High', exact: true }).click();
  await expect.poll(() => userSettings(home.damoclesDir)['damocles.background.effort']).toBe('high');

  await model.click();
  await overlay.getByRole('option', { name: 'Automatic', exact: true }).click();
  await expect(effort).toHaveCount(0);
  await expect.poll(() => Object.keys(userSettings(home.damoclesDir)).filter((key) => key.startsWith('damocles.background.'))).toEqual([]);
  await closeSettingsModal(overlay);
});

test('Memory judge defaults to Automatic, lists a classifier without its key as unavailable, and a picked model offers its levels in user settings', async ({ home, launch }) => {
  signInToAnthropic(home);
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  const overlay = await openSettingsModal(app, 'accounts');
  await waitForSettingsState(overlay);
  const row = settingsRow(overlay, 'damocles.memory.judge');
  const judge = row.getByRole('combobox', { name: 'Memory judge', exact: true });
  const effort = row.getByRole('combobox', { name: 'Memory judge reasoning effort' });
  await expect(judge).toHaveText('Automatic');
  await expect(effort).toHaveCount(0);

  await judge.click();
  await expect(optionLabels(overlay)).toHaveText(['Automatic', 'Jev (TypeSafe)', 'Jev (OpenRouter)', 'GPT-6 Luna (Decisions API)', ...CATALOG]);
  for (const name of [/^Jev \(TypeSafe\)/, /^Jev \(OpenRouter\)/, /^GPT-6 Luna \(Decisions API\)/]) {
    const option = overlay.getByRole('option', { name });
    await expect(option).toHaveAttribute('aria-disabled', 'true');
    await expect(option).toContainText('No key saved');
  }
  await overlay.getByRole('option', { name: 'Sonnet 5.5', exact: true }).click();
  await expect.poll(() => userSettings(home.damoclesDir)['damocles.memory.judge']).toBe('claude-sonnet-5-5');
  await expect(effort).toHaveText('Per job');
  await effort.click();
  await expect(overlay.getByRole('option')).toHaveText(['Per job', 'Low', 'Medium', 'High', 'Extra High', 'Max', 'Ultracode']);
  await overlay.getByRole('option', { name: 'High', exact: true }).click();
  await expect.poll(() => userSettings(home.damoclesDir)['damocles.memory.judgeEffort']).toBe('high');
  // The Background row is a separate setting.
  expect(userSettings(home.damoclesDir)['damocles.background.model']).toBeUndefined();

  await judge.click();
  await overlay.getByRole('option', { name: 'Automatic', exact: true }).click();
  await expect(effort).toHaveCount(0);
  await expect.poll(() => Object.keys(userSettings(home.damoclesDir)).filter((key) => key.startsWith('damocles.memory.judge'))).toEqual([]);
  await closeSettingsModal(overlay);
});

test('a chosen memory judge whose key is missing says so in its row and shows no judge on the TypeSafe account', async ({ home, launch }) => {
  writeUserSettings(home, { 'damocles.memory.judge': 'jev-typesafe' });
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  const overlay = await openSettingsModal(app, 'accounts');
  const forced = 'Memory judge: none. Jev (TypeSafe) is the chosen judge but cannot run: its key is not set. Merges and reranks wait until it can.';
  const row = settingsRow(overlay, 'damocles.memory.judge');
  await expect(row.getByTestId('memory-judge-warning')).toHaveText(forced);
  const judge = row.getByRole('combobox', { name: 'Memory judge', exact: true });
  await expect(judge).toContainText('Jev (TypeSafe)');
  await expect(judge).toHaveAccessibleDescription('No key saved');

  await settingsRow(overlay, 'account-typesafe').getByRole('button', { name: /Add key/ }).click();
  await expect(overlay.getByTestId('memory-judge')).toHaveText(forced);
  await closeSettingsModal(overlay);
});

// With no StepFun key stored, the StepFun Explore ran on Default before the move, so it moves to Default.
test('Explore moves a StepFun selection with no StepFun key to Default, and offers Default or any model with its own levels in user settings', async ({ home, launch }) => {
  writeUserSettings(home, { 'damocles.explore.enabled': true, 'damocles.explore.provider': 'stepfun', 'damocles.explore.effort': 'high' });
  signInToAnthropic(home);
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  const exploreKeys = (): Record<string, unknown> => Object.fromEntries(Object.entries(userSettings(home.damoclesDir)).filter(([key]) => key.startsWith('damocles.explore.')));
  expect(exploreKeys()).toEqual({});

  const overlay = await openSettingsModal(app, 'accounts');
  await waitForSettingsState(overlay);
  const row = settingsRow(overlay, 'damocles.explore.model');
  const model = row.getByRole('combobox', { name: 'Explore model' });
  const effort = row.getByRole('combobox', { name: 'Explore reasoning effort' });
  await expect(model).toHaveText('Default');
  await expect(effort).toHaveCount(0);

  await model.click();
  await expect(optionLabels(overlay)).toHaveText(['Default', ...CATALOG]);
  await overlay.getByRole('option', { name: 'Sonnet 5.5', exact: true }).click();
  await expect.poll(() => exploreKeys()['damocles.explore.model']).toBe('claude-sonnet-5-5');
  await expect(effort).toHaveText('Default (Medium)');
  await effort.click();
  await expect(overlay.getByRole('option')).toHaveText(['Default (Medium)', 'Low', 'Medium', 'High', 'Extra High', 'Max', 'Ultracode']);
  await overlay.getByRole('option', { name: 'High', exact: true }).click();
  await expect.poll(() => exploreKeys()['damocles.explore.effort']).toBe('high');

  await model.click();
  await overlay.getByRole('option', { name: 'Default', exact: true }).click();
  await expect(effort).toHaveCount(0);
  await expect.poll(exploreKeys).toEqual({});
  await closeSettingsModal(overlay);
});

/** window-layout.json's sidebar, or undefined before main first writes the file. */
function readLayout(userData: string): { sidebarVisible: boolean; sidebarWidth: number } | undefined {
  const file = path.join(userData, 'window-layout.json');
  if (!fs.existsSync(file)) return undefined;
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { sidebar: { sidebarVisible: boolean; sidebarWidth: number } }).sidebar;
}

/** The session id main gives the selected chat once its first exchange wrote a session file. */
async function storedChatId(app: ElectronApplication): Promise<string> {
  let id: string | undefined;
  await expect.poll(async () => (id = (await shellState(app)).selected.chatId) ?? '').not.toMatch(/^(new:|$)/);
  return id!;
}

test('Restore default layout resets window-layout.json, and with Reopen where I left off off the next launch opens the default layout and no saved chat', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    let desktop = await launch();
    const tab = await activeChat(desktop.app);
    await expect(chatInput(tab)).toBeVisible();
    await sendAndAwaitEcho(tab, 'a chat worth reopening');
    const savedChat = await storedChatId(desktop.app);

    const shell = await shellPage(desktop.app);
    await shell.evaluate(() => window.damoclesShell!.toggleSidebar());
    await expect.poll(() => readLayout(home.userData)?.sidebarVisible).toBe(false);

    const overlay = await openSettingsModal(desktop.app, 'appearance');
    await settingsRow(overlay, 'restore-default-layout').getByRole('button', { name: 'Restore defaults' }).click();
    await expect.poll(() => readLayout(home.userData)).toEqual({
      sidebarVisible: true,
      sidebarWidth: 264,
      sections: { projects: { collapsed: false, size: 180 }, chats: { collapsed: false }, files: { collapsed: false, size: 230 }, search: { collapsed: true, size: 260 } },
      grid: DEFAULT_GRID_LAYOUT,
      search: {},
    });
    await expect.poll(async () => (await shellState(desktop.app)).layout.sidebarVisible).toBe(true);

    const reopen = settingsRow(overlay, 'damocles.desktop.restoreLayout').getByRole('switch');
    await expect(reopen).toHaveAttribute('aria-checked', 'true');
    await reopen.click();
    await expect.poll(() => userSettings(home.damoclesDir)['damocles.desktop.restoreLayout']).toBe(false);
    await closeSettingsModal(overlay);
    await shell.evaluate(() => window.damoclesShell!.toggleSidebar());
    await expect.poll(() => readLayout(home.userData)?.sidebarVisible).toBe(false);

    await desktop.close();
    desktop = await launch();
    await expect(chatInput(await activeChat(desktop.app))).toBeVisible();
    const state = await shellState(desktop.app);
    expect(state.layout.sidebarVisible).toBe(true);
    expect(state.layout.sidebarWidth).toBe(264);
    expect(state.selected.chatId).toMatch(/^new:/);
    // Not reopened, but kept: the chat is still in the Chats list.
    expect((await listChats(desktop.app)).chats.map((chat) => chat.id)).toContain(savedChat);
  } finally {
    await stub.close();
  }
});

test('on a fresh install with no project the modal opens on the chat main creates, and keys entered there are stored', async ({ launch }) => {
  const { app } = await launch({ env: { DAMOCLES_E2E_HOOKS: '1' } });
  const overlay = await openSettingsModal(app, 'accounts');
  const state = await shellState(app);
  expect(state.projects).toEqual([]);
  expect(state.selected.chatId).toMatch(/^new:/);

  const deepseek = settingsRow(overlay, 'account-deepseek');
  await deepseek.getByRole('button', { name: /Add key/ }).click();
  const key = deepseek.getByLabel('API Key', { exact: true });
  await key.fill('sk-e2e-fresh-install');
  await key.press('Enter');
  await expect(deepseek.getByRole('status').first()).toHaveText('Key saved');

  // A key the host asks for through its own prompt renders in the modal the same way.
  await askHostPassword(app, 'Enter the e2e API key');
  const dialog = overlay.getByRole('dialog', { name: 'Enter the e2e API key' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox')).toHaveAttribute('type', 'password');
  await dialog.getByRole('textbox').fill('sk-e2e-fresh-install-prompt');
  await dialog.getByRole('textbox').press('Enter');
  await expect(dialog).toBeHidden();
  expect(await hostPromptAnswer(app)).toBe('sk-e2e-fresh-install-prompt');
  await expect(settingsModal(overlay)).toBeVisible();
});

test('This chat › Workspace folder asks first, then starts a new conversation in the other folder, and the old one stays in the Chats list', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const beta = path.join(home.root, 'p', 'beta');
    fs.mkdirSync(beta, { recursive: true });
    const { app } = await launch();
    let known = [await activeChat(app)];
    for (const dir of [beta, home.project]) {
      const opened = nextChat(app, known);
      await addProject(app, dir, true);
      known = [...known, await opened];
    }
    const tab = known.at(-1)!;
    await expect(chatInput(tab)).toBeVisible();
    const alphaKey = await projectKeyOf(app, 'alpha');
    const betaKey = await projectKeyOf(app, 'beta');
    expect((await shellState(app)).selected.projectKey).toBe(alphaKey);
    await sendAndAwaitEcho(tab, 'work in alpha');
    const oldChat = await storedChatId(app);

    await answerDialogs(app, { 'Switch this panel': 'Start new conversation' });
    const overlay = await openSettingsModal(app, 'chat');
    const folder = settingsRow(overlay, 'workspace-folder');
    await expect(folder).toContainText('Switching starts a new conversation. This one stays in history.');
    await folder.getByRole('combobox').click();
    await overlay.getByRole('option', { name: /^beta/ }).click();

    await expect.poll(async () => (await askedDialogs(app)).map((box) => box.message)).toContainEqual(expect.stringContaining('beta'));
    await expect(folder.getByRole('combobox')).toContainText('beta');
    await expect(tab.getByText('Echo: work in alpha', { exact: true })).toHaveCount(0);
    await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(betaKey);
    expect((await listChats(app, alphaKey)).chats.map((chat) => chat.id)).toContain(oldChat);
    await closeSettingsModal(overlay);
  } finally {
    await stub.close();
  }
});
