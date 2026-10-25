import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { corePid, isAlive } from './support/app';
import { activeTab, codeEditor, editorShows, editorTab, replaceText, saveWithKeyboard } from './support/editor';
import { expect, IPC_HANDLER_ERROR_ANNOTATION, test } from './support/fixtures';
import { OVERLAY_CHANNELS } from '../../src/desktop/preload/overlay-channels';
import { git, initRepo } from './support/git';
import type { HermeticHome } from './support/hermetic';
import { cleanUp, daemonPid, endLeftoverDaemon, LOCAL_DAEMON, loopbackHome, LOOPBACK_ENV, LOOPBACK_TAG, openThroughLocalDaemon, processTree, REVIEW_SHOTS, shutdownDaemon } from './support/loopback';
import { commitMessage, scmSection, setSection } from './support/scm';
import { setReducedMotion, showShellTheme, THEMES } from './support/screenshots';
import { settingsModal, settingsNav, settingsRow } from './support/settings';
import { overlayPage, shellPage, shellState } from './support/shell';
import { listChats } from './support/shell-ui';
import { awaitTurnEnd, chatInput, clickMenu } from './support/ui';

// The daemon's core: its state as control.coreState reports it, and the epoch and engine state main shows.
interface CoreState {
  readonly epoch: string | null;
  readonly phase: 'starting' | 'running' | 'restarting' | 'halted';
  readonly restarts: number;
  readonly pid: number | null;
  readonly ppid: number | null;
}

interface CoreHooks {
  __damoclesE2e: {
    loopback: {
      coreState(): Promise<CoreState>;
      engine(): { epoch: string | null; state: string | null };
      settingsGeneration(): number | undefined;
    };
  };
}

const SESSION_ID = '01a0e000-0000-7000-8000-00000000c0de';
const PROMPT = 'Where is the needle?';
const REPLY = 'The needle is in a.ts.';
// pi's own error text when the broker answers none and the target has no credential of its own
const NO_SIGN_IN = 'No API key found';

const coreState = (app: ElectronApplication): Promise<CoreState> => app.evaluate(() => (globalThis as unknown as CoreHooks).__damoclesE2e.loopback.coreState());
const engine = (app: ElectronApplication): Promise<{ epoch: string | null; state: string | null }> =>
  app.evaluate(() => (globalThis as unknown as CoreHooks).__damoclesE2e.loopback.engine());

// pi's session folder for a cwd under an agent dir (src/core/pi-session/session-store/session-dir.ts)
function sessionDir(agentDir: string, cwd: string): string {
  return path.join(agentDir, 'sessions', `--${path.resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
}

// A stored conversation in the daemon's home, which only the daemon's core reads: one prompt and its reply.
function seedRemoteSession(home: HermeticHome, folder: string): void {
  const dir = sessionDir(path.join(loopbackHome(home), '.damocles', 'pi', 'agent'), folder);
  fs.mkdirSync(dir, { recursive: true });
  const at = '2026-01-02T03:04:05.000Z';
  const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
  fs.writeFileSync(path.join(dir, `${at.replace(/[:.]/g, '-')}_${SESSION_ID}.jsonl`),
    line({ type: 'session', version: 3, id: SESSION_ID, timestamp: at, cwd: folder })
    + line({ type: 'message', id: 'u1', parentId: null, timestamp: at, message: { role: 'user', content: [{ type: 'text', text: PROMPT }], timestamp: Date.parse(at) } })
    + line({ type: 'message', id: 'a1', parentId: 'u1', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: REPLY }], provider: 'anthropic', model: 'claude-opus-4-8', timestamp: Date.parse(at) } }));
}

const chatPages = (app: ElectronApplication): Page[] => app.windows().filter((page) => !page.isClosed() && page.url().includes('/panel/'));

// The chat page whose webview state holds the session and which shows its reply: a reopened chat is a new page.
async function remoteChat(app: ElectronApplication, except?: Page): Promise<Page> {
  let found: Page | undefined;
  await expect.poll(async () => {
    found = undefined;
    for (const page of chatPages(app)) {
      if (page === except) continue;
      const sessionId = await page.evaluate(() => (window.damoclesBridge?.getState() as { sessionId?: string } | null | undefined)?.sessionId).catch(() => undefined);
      if (sessionId === SESSION_ID && (await page.getByText(REPLY, { exact: true }).count().catch(() => 0)) > 0) found = page;
    }
    return found !== undefined;
  }, { timeout: 60_000, message: 'the loopback chat with its replayed history' }).toBe(true);
  return found!;
}

// A new epoch, running, once main attached to it again.
async function untilRunning(app: ElectronApplication, after: string | null): Promise<CoreState> {
  let state!: CoreState;
  await expect.poll(async () => {
    state = await coreState(app);
    const shown = await engine(app);
    return state.phase === 'running' && state.epoch !== after && shown.epoch === state.epoch && shown.state === 'running';
  }, { timeout: 90_000 }).toBe(true);
  return state;
}

async function killCore(pid: number): Promise<void> {
  process.kill(pid, 'SIGKILL');
  await expect.poll(() => isAlive(pid), { timeout: 30_000 }).toBe(false);
}

async function expectPlanMode(tab: Page): Promise<void> {
  await expect(tab.getByTestId('composer-mode')).toHaveAccessibleName(/^Plan mode/);
}

async function shoot(page: Page, name: string): Promise<void> {
  if (REVIEW_SHOTS === undefined) return;
  fs.mkdirSync(REVIEW_SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(REVIEW_SHOTS, `${name}.png`), animations: 'disabled' });
}

// Each theme in turn, when review screenshots are asked for.
async function eachTheme(app: ElectronApplication, capture: (theme: (typeof THEMES)[number], dir: string) => Promise<void>): Promise<void> {
  if (REVIEW_SHOTS === undefined) return;
  fs.mkdirSync(REVIEW_SHOTS, { recursive: true });
  for (const theme of THEMES) {
    await showShellTheme(app, theme);
    await capture(theme, REVIEW_SHOTS);
  }
}

test('a loopback project\'s git, chats and engine run in the daemon\'s core: status, commit and Git output, a replayed chat that has no sign-in, restarts with a new epoch, and the halt', { tag: LOOPBACK_TAG }, async ({ foreground: _foreground, home, launch }, testInfo) => {
  test.setTimeout(600_000);
  const folder = path.join(home.root, 'p', 'remote');
  fs.mkdirSync(folder, { recursive: true });
  await initRepo(home, folder, { 'a.ts': 'export const a = 1;\n' });
  seedRemoteSession(home, folder);
  const { app } = await launch(LOOPBACK_ENV);
  let failure: unknown;
  try {
    const shell = await shellPage(app);
    const key = await openThroughLocalDaemon(app, folder);
    let state = await untilRunning(app, null);

    // Adding the project opens a chat of its own, as adding a local one does, and the title bar names that chat beside it.
    await expect.poll(async () => {
      const shown = await shellState(app);
      const chatId = shown.selected.chatId;
      return shown.selected.projectKey === key && chatId !== undefined && shown.selectedChat?.id === chatId
        && (await listChats(app, key)).chats.some((chat) => chat.id === chatId);
    }, { timeout: 60_000, message: 'a chat of the loopback project, selected with it' }).toBe(true);
    await expect(shell.getByTestId('breadcrumb-chat')).toHaveText('New chat');

    // Core is the daemon's child: its parent is the pid the daemon's pid file names.
    expect(state.pid).not.toBeNull();
    expect(state.ppid).toBe(await daemonPid(home));
    expect(await processTree(await daemonPid(home))).toContain(state.pid);

    // Git status and commit through the daemon's core, and its Git log through control logs.read.
    fs.writeFileSync(path.join(folder, 'a.ts'), 'export const a = 2;\n');
    await setSection(shell, 'scm-section', true);
    const change = scmSection(shell).locator('[data-testid="scm-change"][data-group="workingTree"][data-path="a.ts"]');
    await expect(change).toHaveAttribute('data-letter', 'M', { timeout: 60_000 });
    await change.focus();
    await change.getByTestId('scm-row-stage').click();
    await expect(scmSection(shell).locator('[data-testid="scm-change"][data-group="index"][data-path="a.ts"]')).toBeVisible();
    await commitMessage(shell).fill('Bump a through the daemon');
    await commitMessage(shell).press('ControlOrMeta+Enter');
    await expect.poll(() => git(home, folder, 'log', '-1', '--format=%s')).toBe('Bump a through the daemon');
    await clickMenu(app, 'damocles.git.showOutput');
    await expect(editorTab(shell, `${LOCAL_DAEMON}: Git.log`)).toBeVisible();
    await editorShows(shell, 'commit');
    // closed, so no source control request waits on the engine the kills below take down
    await setSection(shell, 'scm-section', false);

    // The stored conversation opens from the loopback project's list and replays; with no sign-in here the broker answers none,
    // so a send shows the message and pi's error card.
    expect((await shellState(app)).selected.projectKey).toBe(key);
    expect(await shell.evaluate((id) => window.damoclesShell!.selectChat(id), SESSION_ID)).toEqual({ ok: true });
    let tab = await remoteChat(app);
    await expect(tab.getByText(PROMPT, { exact: true }).first()).toBeVisible();
    await chatInput(tab).fill('hello from this computer');
    await chatInput(tab).press('Enter');
    await expect(tab.getByRole('region', { name: 'Error' })).toContainText(NO_SIGN_IN, { timeout: 30_000 });
    await expect(tab.getByText('hello from this computer', { exact: true })).toBeVisible();
    await awaitTurnEnd(tab);
    for (let clicks = 0; clicks < 3 && !/^Plan mode/.test((await tab.getByTestId('composer-mode').getAttribute('aria-label')) ?? ''); clicks++) {
      await tab.getByTestId('composer-mode').click();
    }
    await expectPlanMode(tab);
    await eachTheme(app, (theme) => shoot(tab, `chat-replayed-${theme}`));

    // Three kills within the daemon's budget: each a new epoch, and the chat reopens in the mode it had.
    for (let kill = 1; kill <= 3; kill++) {
      const before = state;
      await killCore(before.pid!);
      state = await untilRunning(app, before.epoch);
      expect(state.restarts).toBe(kill);
      const reopened = await remoteChat(app, tab);
      await expectPlanMode(reopened);
      tab = reopened;
    }

    // The fourth kill within 5 minutes halts the engine: the pill names the host, and its Restart starts a new core.
    const halted = state;
    await killCore(halted.pid!);
    await expect.poll(async () => (await coreState(app)).phase, { timeout: 60_000 }).toBe('halted');
    const pill = shell.getByTestId('engine-host-pill');
    await expect(pill).toHaveText(`Engine stopped on ${LOCAL_DAEMON}`);
    await expect(pill).toHaveAttribute('data-state', 'halted');
    await eachTheme(app, async (theme, dir) => {
      await shell.getByTestId('title-bar').screenshot({ path: path.join(dir, `engine-halted-${theme}.png`), animations: 'disabled' });
    });
    await pill.click();
    state = await untilRunning(app, halted.epoch);
    await expect(pill).toHaveCount(0);
    tab = await remoteChat(app, tab);
    await expectPlanMode(tab);

    // Restart Engine acts on the selected project's host: the loopback core gets a new epoch, the local core keeps running.
    expect((await shellState(app)).selected.projectKey).toBe(key);
    const localCore = await corePid(app);
    expect(localCore).toBeDefined();
    const beforeMenu = state;
    await clickMenu(app, 'damocles.restartEngine');
    state = await untilRunning(app, beforeMenu.epoch);
    expect(await corePid(app)).toBe(localCore);
    tab = await remoteChat(app, tab);
    await expectPlanMode(tab);

    // Settings on the loopback chat: User, Local daemon and Project tabs, on the host tab first.
    await shell.getByTestId('open-settings').click();
    const overlay = await overlayPage(app);
    await expect(settingsModal(overlay)).toBeVisible();
    const tabs = overlay.getByTestId('settings-scope-tabs');
    await expect(tabs.getByRole('tab')).toHaveText(['User', LOCAL_DAEMON, 'Project']);
    await expect(overlay.getByTestId('settings-scope-host')).toHaveAttribute('aria-selected', 'true');
    // The host tab is the remote chat's own panel: its This chat rows change that chat, and say so.
    await settingsNav(overlay, 'chat').click();
    await expect(settingsRow(overlay, 'permission-mode')).toBeVisible();
    await expect(overlay.getByTestId('settings-scope-banner')).toContainText(`Changes only this chat on ${LOCAL_DAEMON}`);
    await eachTheme(app, (theme) => shoot(overlay, `settings-host-tab-chat-${theme}`));
    // Each tab lists the keys its scope may write: the host tab a no-scope key and a resource key, Project the resource keys a
    // project file holds, which leaves out the user-only permission mode.
    await settingsNav(overlay, 'defaults').click();
    await expect(settingsRow(overlay, 'damocles.model')).toBeVisible();
    await expect(settingsRow(overlay, 'damocles.permissionMode')).toBeVisible();
    await expect(overlay.getByTestId('settings-nav-appearance')).toHaveCount(0);
    await eachTheme(app, (theme) => shoot(overlay, `settings-host-tab-${theme}`));
    const generation = (): Promise<number | undefined> => app.evaluate(() => (globalThis as unknown as CoreHooks).__damoclesE2e.loopback.settingsGeneration());
    const send = async (message: Record<string, unknown>): Promise<void> => {
      const attachment = await generation();
      await overlay.evaluate(([at, m]) => window.damoclesOverlay!.settingsSend(at as number, m as never), [attachment, message] as const);
    };
    const userFile = path.join(home.damoclesDir, 'settings.json');
    const hostFile = path.join(loopbackHome(home), '.damocles', 'settings.json');
    const read = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

    // While main attaches a clicked tab the page lists nothing; a tab main cannot attach leaves the tab and attachment as
    // they were, and says so.
    type SettingsHold = { reached: boolean; release(): void; fail(): void };
    type HoldGlobals = typeof globalThis & { __damoclesE2e: { loopback: { holdSettingsAttach(): SettingsHold } }; __e2eSettingsHold?: SettingsHold };
    const holdAttach = (): Promise<void> => app.evaluate(() => {
      const globals = globalThis as HoldGlobals;
      globals.__e2eSettingsHold = globals.__damoclesE2e.loopback.holdSettingsAttach();
    });
    const attachWaits = (): Promise<boolean> => app.evaluate(() => (globalThis as HoldGlobals).__e2eSettingsHold!.reached);
    const loading = overlay.getByTestId('settings-scope-loading');
    const held = await generation();
    await holdAttach();
    await overlay.getByTestId('settings-scope-project').click();
    await expect.poll(attachWaits).toBe(true);
    await expect(loading).toHaveText('Loading the Project settings…');
    await expect(settingsRow(overlay, 'damocles.model')).toHaveCount(0);
    await expect(overlay.getByTestId('settings-scope-project')).toHaveAttribute('aria-selected', 'true');
    await eachTheme(app, (theme) => shoot(overlay, `settings-tab-pending-${theme}`));
    test.info().annotations.push({ type: IPC_HANDLER_ERROR_ANNOTATION, description: OVERLAY_CHANNELS.settingsScope });
    await app.evaluate(() => (globalThis as HoldGlobals).__e2eSettingsHold!.fail());
    await expect(overlay.getByTestId('settings-scope-failed')).toHaveText('The Project settings could not be opened.');
    await expect(overlay.getByTestId('settings-scope-host')).toHaveAttribute('aria-selected', 'true');
    await expect(settingsRow(overlay, 'damocles.model')).toBeVisible();
    expect(await generation()).toBe(held);
    await eachTheme(app, (theme) => shoot(overlay, `settings-tab-failed-${theme}`));
    await holdAttach();
    await app.evaluate(() => (globalThis as HoldGlobals).__e2eSettingsHold!.release());

    // A write from the Project tab lands in the project's settings.json, the file its banner names: never in its
    // settings.local.json, this computer's user file or the host's.
    const projectFile = path.join(folder, '.damocles', 'settings.json');
    const localFile = path.join(folder, '.damocles', 'settings.local.json');
    const holds9 = (): boolean => [userFile, hostFile, localFile].some((file) => read(file).includes('"damocles.maxBudgetUsd": 9'));
    const before = await generation();
    await overlay.getByTestId('settings-scope-project').click();
    await expect(overlay.getByTestId('settings-scope-project')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(generation).not.toBe(before);
    await expect(overlay.getByTestId('settings-scope-failed')).toHaveText('');
    await expect(settingsRow(overlay, 'damocles.thinkingDisabled')).toBeVisible();
    await expect(settingsRow(overlay, 'damocles.permissionMode')).toHaveCount(0);
    await expect(settingsRow(overlay, 'damocles.model')).toHaveCount(0);
    await settingsNav(overlay, 'workspace').click();
    const budget = settingsRow(overlay, 'damocles.maxBudgetUsd');
    await expect(budget).toBeVisible();
    await expect(overlay.getByTestId('settings-scope-banner')).toContainText(path.join('.damocles', 'settings.json'));
    await send({ type: 'setBudgetLimit', budgetUsd: 9 });
    await expect(budget.getByTestId('setting-saved')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => read(projectFile)).toContain('"damocles.maxBudgetUsd": 9');
    expect(holds9()).toBe(false);
    await eachTheme(app, (theme) => shoot(overlay, `settings-project-tab-${theme}`));

    // The User tab is the local core's: its write lands in this computer's user settings, and it changes no chat.
    const project = await generation();
    await overlay.getByTestId('settings-scope-user').click();
    await expect.poll(generation).not.toBe(project);
    await settingsNav(overlay, 'chat').click();
    await expect(settingsRow(overlay, 'permission-mode')).toHaveCount(0);
    await expect(overlay.getByTestId('settings-scope-empty')).toHaveText(`This chat runs on ${LOCAL_DAEMON}. Change its settings on the ${LOCAL_DAEMON} tab.`);
    await settingsNav(overlay, 'defaults').click();
    await expect(settingsRow(overlay, 'damocles.model')).toBeVisible();
    await expect(overlay.getByTestId('settings-nav-appearance')).toBeVisible();
    await eachTheme(app, (theme) => shoot(overlay, `settings-user-tab-${theme}`));
    await send({ type: 'setBudgetLimit', budgetUsd: 7 });
    await expect.poll(() => read(userFile)).toContain('"damocles.maxBudgetUsd": 7');
    expect(read(hostFile)).not.toContain('"damocles.maxBudgetUsd": 7');
    expect(holds9()).toBe(false);
    await setReducedMotion(app, true);
    const userTab = await generation();
    await overlay.getByTestId('settings-scope-host').click();
    await expect.poll(generation).not.toBe(userTab);
    await shoot(overlay, 'settings-host-tab-reduced-motion');
    await setReducedMotion(app, false);

    // The host tab's Edit settings.json opens the host's own settings file, editable, and a save lands in that file.
    fs.mkdirSync(path.dirname(hostFile), { recursive: true });
    fs.writeFileSync(hostFile, '{}\n');
    await overlay.getByTestId('settings-footer').click();
    await overlay.getByTestId('settings-edit-json-user').click();
    await expect(settingsModal(overlay)).toHaveCount(0);
    await expect(editorTab(shell, `${LOCAL_DAEMON}: settings.json`)).toHaveAttribute('aria-selected', 'true');
    expect(await activeTab(app)).toMatchObject({ kind: 'settings', settingsScope: 'user', readOnly: false });
    const editor = codeEditor(shell);
    await expect(editor).toHaveAttribute('data-monaco-ready', 'true');
    const edited = '{\n  "damocles.maxBudgetUsd": 5\n}\n';
    await replaceText(editor, edited);
    await saveWithKeyboard(app);
    await expect.poll(() => read(hostFile)).toBe(edited);
    await expect.poll(async () => (await activeTab(app))?.dirty).toBe(false);
    expect(read(userFile)).not.toContain('"damocles.maxBudgetUsd": 5');

    await shutdownDaemon(app, home);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => endLeftoverDaemon(app, home));
  }
});
