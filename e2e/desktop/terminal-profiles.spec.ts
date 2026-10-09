import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import type { TerminalCreateResult, TerminalProfileReport, TerminalState } from '../../src/desktop/preload/terminal-channels';
import { expect, test } from './support/fixtures';
import { readUserSettings, writeUserSettings, type HermeticHome } from './support/hermetic';
import { openProjectChat } from './support/screenshots';
import { closeSettingsModal, openSettingsModal } from './support/settings';
import { activeTerminal, openTerminal, terminalText, TEST_PROFILE } from './support/terminal';

const windows = process.platform === 'win32';
const PROFILES = 'damocles.desktop.terminal.profiles';
const USER_PROFILE = 'E2E Dev Shell';
// A real shell started with args that print a marker no typed command shows: the args reached the pty as separate argv entries.
const LAUNCH = windows
  ? {
    path: ['C:\\nowhere\\shell.exe', path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
    args: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', "Write-Output ('e2e-user-' + 'profile-ok')"],
  }
  : { path: ['/nowhere/sh', 'bash'], args: ['--norc', '--noprofile', '-c', 'echo e2e-user-profile-$((40+2)); exec bash --norc --noprofile -i'] };
const MARKER = windows ? 'e2e-user-profile-ok' : 'e2e-user-profile-42';
// Refused before any file system call: a UNC share on Windows; on POSIX, where `\` is an ordinary character, a `~` path.
const REFUSED_PATH = windows ? '\\\\server\\share\\sh.exe' : '~/sh';

type Launch = () => Promise<{ app: ElectronApplication; close: () => Promise<void> }>;

const state = (shell: Page): Promise<TerminalState> => shell.evaluate(() => window.damoclesShell!.terminal.getState());
const profileNames = async (shell: Page): Promise<string[]> => (await state(shell)).profiles.map((profile) => profile.name);
// The renderer's own create, which takes a profile id only; main resolves it against the profiles it lists.
const create = (shell: Page, profileId: string): Promise<TerminalCreateResult> => shell.evaluate((id) => window.damoclesShell!.terminal.create({ profileId: id, projectKey: null }), profileId);

function writeSettings(home: HermeticHome, profiles: unknown): void {
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': TEST_PROFILE, 'damocles.desktop.terminal.confirmOnKill': 'never', [PROFILES]: profiles });
}

async function launchWithTerminal(home: HermeticHome, launch: Launch): Promise<{ app: ElectronApplication; shell: Page }> {
  const { app } = await launch();
  await openProjectChat(app, home.project);
  return { app, shell: await openTerminal(app) };
}

test('a user profile with a path list and args is listed in its icon and color and launches with those args', async ({ home, launch }) => {
  writeSettings(home, { [USER_PROFILE]: { ...LAUNCH, icon: 'rocket', color: 'green' } });
  const { shell } = await launchWithTerminal(home, launch);
  const listed = (await state(shell)).profiles.find((profile) => profile.name === USER_PROFILE);
  expect(listed).toMatchObject({ id: `user:${USER_PROFILE}`, source: 'user', customIcon: 'rocket', color: 'green', args: LAUNCH.args });
  expect(listed!.path).toEqual(windows ? LAUNCH.path[1] : expect.stringMatching(/\/bash$/));

  const created = await create(shell, listed!.id);
  expect(created).toMatchObject({ ok: true });
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running');
  await expect.poll(() => terminalText(shell), { timeout: 30_000 }).toContain(MARKER);
  const terminal = (await state(shell)).terminals.find((candidate) => candidate.id === (created as { id: string }).id);
  expect(terminal).toMatchObject({ profileId: `user:${USER_PROFILE}`, customIcon: 'rocket', color: 'green' });
});

test('null hides a detected profile, and the change applies when the user settings file changes', async ({ home, launch }) => {
  writeSettings(home, {});
  const { shell } = await launchWithTerminal(home, launch);
  const detected = (await state(shell)).profiles.find((profile) => profile.id !== TEST_PROFILE && profile.source === 'detected');
  test.skip(detected === undefined, 'this machine detects only the test shell');
  writeUserSettings(home, { ...readUserSettings(home), [PROFILES]: { [detected!.name]: null } });
  await expect.poll(() => profileNames(shell)).not.toContain(detected!.name);
  expect(await create(shell, detected!.id)).toEqual({ ok: false, reason: 'unknownProfile' });
  writeUserSettings(home, { ...readUserSettings(home), [PROFILES]: {} });
  await expect.poll(() => profileNames(shell)).toContain(detected!.name);
});

test('a profile in the project or local settings file of a trusted project is ignored and never launches', async ({ home, launch }) => {
  writeSettings(home, {});
  const planted = { 'Planted Shell': LAUNCH, [windows ? 'Command Prompt' : 'bash']: null };
  fs.mkdirSync(path.join(home.project, '.damocles'), { recursive: true });
  fs.writeFileSync(path.join(home.project, '.damocles', 'settings.json'), JSON.stringify({ [PROFILES]: planted }));
  fs.writeFileSync(path.join(home.project, '.damocles', 'settings.local.json'), JSON.stringify({ [PROFILES]: planted }));
  const { shell } = await launchWithTerminal(home, launch);
  const names = await profileNames(shell);
  expect(names).not.toContain('Planted Shell');
  expect(names).toContain(windows ? 'Command Prompt' : 'bash');
  expect(await create(shell, 'user:Planted Shell')).toEqual({ ok: false, reason: 'unknownProfile' });
});

test('an invalid profile is listed in Settings › Terminal with its reason and never launches', async ({ home, launch }) => {
  writeSettings(home, { 'Bad Share Shell': { path: REFUSED_PATH }, 'Bad Env Shell': { path: LAUNCH.path, env: { PATH: 'x' } } });
  const { app, shell } = await launchWithTerminal(home, launch);
  expect(await profileNames(shell)).not.toContain('Bad Share Shell');
  expect(await create(shell, 'user:Bad Share Shell')).toEqual({ ok: false, reason: 'unknownProfile' });
  const overlay = await openSettingsModal(app, 'terminal');
  const report = await overlay.evaluate(() => window.damoclesOverlay!.getTerminalProfiles()) as TerminalProfileReport;
  expect(report.problems).toEqual(expect.arrayContaining([
    { name: 'Bad Share Shell', reason: 'pathNotAllowed', detail: REFUSED_PATH },
    { name: 'Bad Env Shell', reason: 'unknownField', detail: 'env' },
  ]));
  await expect(overlay.getByText('Bad Share Shell')).toBeVisible();
  await expect(overlay.getByText('Bad Env Shell')).toBeVisible();
  await closeSettingsModal(overlay);
});
