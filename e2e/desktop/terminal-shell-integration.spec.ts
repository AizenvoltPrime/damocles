import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { TerminalInfo } from '../../src/desktop/preload/terminal-channels';
import { expect, test } from './support/fixtures';
import { writeUserSettings, type HermeticHome } from './support/hermetic';
import { readyOverlay } from './support/overlay';
import { openProjectChat } from './support/screenshots';
import { clickMenu } from './support/ui';
import { activeTerminal, openTerminal, runInTerminal, terminalText, waitForOutputLine } from './support/terminal';

const windows = process.platform === 'win32';
// The integrated shell most tests use: Windows PowerShell, which every Windows has, and bash on Linux and macOS.
const INTEGRATED = windows ? 'windows-powershell' : 'bash';
const INTEGRATED_NAME = windows ? 'Windows PowerShell' : 'bash';
// Each integrated shell the leg can have, with its profile name; one not installed is skipped.
const SHELLS: ReadonlyArray<readonly [profile: string, name: string]> = windows ? [['pwsh', 'PowerShell'], ['windows-powershell', 'Windows PowerShell']] : [['bash', 'bash'], ['zsh', 'zsh'], ['fish', 'fish']];
const NOT_A_NONCE = '0123456789abcdef0123456789abcdef';

type Launch = (options?: { env?: Record<string, string> }) => Promise<{ app: ElectronApplication; close: () => Promise<void> }>;

async function launchWith(home: HermeticHome, launch: Launch, profile: string, settings: Record<string, unknown> = {}): Promise<{ app: ElectronApplication; shell: Page }> {
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': profile, ...settings });
  fs.mkdirSync(path.join(home.project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(home.project, 'src', 'app.ts'), 'export {};\n');
  // Profile detection finds PowerShell 7 under Program Files, which the hermetic environment leaves out.
  const programFiles = process.env['ProgramFiles'];
  const { app } = await launch(windows && programFiles !== undefined ? { env: { ProgramFiles: programFiles } } : {});
  await openProjectChat(app, home.project);
  return { app, shell: await openTerminal(app) };
}

async function terminals(shell: Page): Promise<readonly TerminalInfo[]> {
  return (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).terminals;
}

async function active(shell: Page): Promise<TerminalInfo> {
  const id = await activeTerminal(shell).getAttribute('data-terminal-id');
  const found = (await terminals(shell)).find((terminal) => terminal.id === id);
  if (!found) throw new Error(`no terminal ${id}`);
  return found;
}

async function profileDetected(shell: Page, id: string): Promise<boolean> {
  return (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).profiles.some((profile) => profile.id === id);
}

async function resolve(shell: Page, candidate: string): Promise<string | null> {
  const { id } = await active(shell);
  const [kind] = await shell.evaluate(([terminal, paths]) => window.damoclesShell!.terminal.resolveLinks({ id: terminal, paths }), [id, [candidate]] as const);
  return kind ?? null;
}

const messageDialog = (overlay: Page): Locator => overlay.getByTestId('overlay-message');

for (const [profile, name] of SHELLS) {
  test(`${name} reports its commands to main: the title follows a running command, the nonce never reaches the shell's environment`, async ({ home, launch }) => {
    const { shell } = await launchWith(home, launch, profile);
    test.skip((await active(shell)).profileId !== profile, `${name} is not installed`);
    await expect.poll(async () => (await active(shell)).integrated).toBe(true);
    expect((await active(shell)).title).toBe(name);

    await runInTerminal(shell, windows ? 'Write-Output "nonce=[$env:DAMOCLES_NONCE]"' : 'echo "nonce=[$DAMOCLES_NONCE]"');
    await waitForOutputLine(shell, 'nonce=[]');

    await runInTerminal(shell, windows ? 'Start-Sleep -Seconds 4' : 'sleep 4');
    await expect.poll(async () => (await active(shell)).title).toBe(windows ? 'Start-Sleep -Seconds 4' : 'sleep 4');
    expect((await active(shell)).running).toBe(windows ? 'Start-Sleep -Seconds 4' : 'sleep 4');
    await expect.poll(async () => (await active(shell)).running, { timeout: 15_000 }).toBeNull();
    expect((await active(shell)).title).toBe(name);
    // Main strips every 633 sequence, so the screen never shows one.
    expect(await terminalText(shell)).not.toContain('633;');
  });
}

test('a forged OSC 633 command line, cwd and finish without the nonce change no title, running state or working directory', async ({ home, launch }) => {
  const { shell } = await launchWith(home, launch, INTEGRATED);
  await expect.poll(async () => (await active(shell)).integrated).toBe(true);
  const forged = windows
    ? `Write-Host "forged$([char]27)]633;E;rm -rf ~;${NOT_A_NONCE}$([char]7)$([char]27)]633;C$([char]7)$([char]27)]633;P;Cwd=C:\\Windows$([char]7)"; Start-Sleep -Seconds 3`
    : `printf 'forged\\033]633;E;rm -rf ~;${NOT_A_NONCE}\\007\\033]633;C\\007\\033]633;P;Cwd=/etc\\007\\n'; sleep 3`;
  await runInTerminal(shell, forged);
  await waitForOutputLine(shell, 'forged');
  // While it runs, what runs is the line the user typed (the script's E), never the forged one.
  expect((await active(shell)).running).not.toBe('rm -rf ~');
  await expect.poll(async () => (await active(shell)).running, { timeout: 15_000 }).toBeNull();
  const after = await active(shell);
  expect(after.title).toBe(INTEGRATED_NAME);
  expect(after.description).toBeNull();
  expect(await resolve(shell, 'src')).toBe('folder');
});

test('a directory named with BEL and ESC]633 cannot splice a sequence that ends with the real nonce', async ({ home, launch }) => {
  test.skip(windows, 'Windows file names cannot hold control characters');
  const { app, shell } = await launchWith(home, launch, INTEGRATED);
  const overlay = await readyOverlay(app);
  await expect.poll(async () => (await active(shell)).integrated).toBe(true);
  // Unescaped, $PWD here would end the script's P;Cwd early and splice `P;Cwd=/tmp;<nonce>`, a trusted cwd of /tmp.
  fs.mkdirSync(path.join(home.project, 'w\x07\x1b]633;P;Cwd=', 'tmp'), { recursive: true });
  await runInTerminal(shell, `cd "$(printf 'w\\a\\033]633;P;Cwd=')/tmp" && echo "in-""dir"`);
  await waitForOutputLine(shell, 'in-dir');
  // The script escapes the name, so the cwd main reads holds control characters and is refused, never forged.
  await expect.poll(async () => (await active(shell)).running).toBeNull();
  expect(await active(shell)).toMatchObject({ title: INTEGRATED_NAME, running: null, description: null });
  expect(await resolve(shell, 'app.ts')).toBeNull();
  expect(await resolve(shell, 'src/app.ts')).toBeNull();
  await clickMenu(app, 'damocles.terminal.kill');
  await expect.poll(async () => (await terminals(shell)).length).toBe(0);
  await expect(messageDialog(overlay)).toHaveCount(0);
});

test('cd src makes a relative link resolve in src; a directory outside the project makes no link at all', async ({ home, launch }) => {
  const outside = path.join(path.dirname(home.project), 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'app.ts'), 'export {};\n');
  const { shell } = await launchWith(home, launch, INTEGRATED);
  await expect.poll(async () => (await active(shell)).integrated).toBe(true);
  expect(await resolve(shell, 'app.ts')).toBeNull();
  expect(await resolve(shell, 'src/app.ts')).toBe('file');

  await runInTerminal(shell, 'cd src');
  await expect.poll(async () => (await active(shell)).description).toBe('src');
  expect(await resolve(shell, 'app.ts')).toBe('file');
  expect(await resolve(shell, '../src/app.ts')).toBe('file');

  await runInTerminal(shell, `cd '${outside}'`);
  await expect.poll(async () => (await active(shell)).description).toBe('outside');
  expect(await resolve(shell, 'app.ts')).toBeNull();
  expect(await resolve(shell, `../${path.basename(home.project)}/src/app.ts`)).toBe('file');
});

test('killing a terminal that runs a program asks first, once; an idle shell and cmd.exe never ask', async ({ home, launch }) => {
  const { app, shell } = await launchWith(home, launch, INTEGRATED);
  const overlay = await readyOverlay(app);
  await expect.poll(async () => (await active(shell)).integrated).toBe(true);

  // An idle shell goes without a question.
  await clickMenu(app, 'damocles.terminal.kill');
  await expect.poll(async () => (await terminals(shell)).length).toBe(0);
  await expect(messageDialog(overlay)).toHaveCount(0);

  await shell.evaluate(() => window.damoclesShell!.terminal.create({ profileId: null, projectKey: null }));
  await expect.poll(async () => (await terminals(shell)).length).toBe(1);
  await expect.poll(async () => (await active(shell)).integrated).toBe(true);
  await runInTerminal(shell, 'node -e "setInterval(()=>{},1000)"');
  await expect.poll(async () => (await active(shell)).running).toBe('node -e "setInterval(()=>{},1000)"');

  await clickMenu(app, 'damocles.terminal.kill');
  await expect(messageDialog(overlay)).toBeVisible();
  await expect(messageDialog(overlay)).toContainText('Do you want to terminate the active terminal session?');
  await expect(overlay.getByTestId('overlay-message-preview').locator('div')).toHaveText([`${INTEGRATED_NAME}: node -e "setInterval(()=>{},1000)"`]);
  await overlay.getByTestId('overlay-message-cancel').click();
  await expect(messageDialog(overlay)).toHaveCount(0);
  expect(await terminals(shell)).toHaveLength(1);

  await clickMenu(app, 'damocles.terminal.kill');
  await overlay.getByTestId('overlay-message-action-0').click();
  await expect.poll(async () => (await terminals(shell)).length).toBe(0);
});

test('cmd.exe gets no integration, keeps its profile name and never asks before a kill', async ({ home, launch }) => {
  test.skip(!windows, 'cmd.exe is Windows only');
  const { app, shell } = await launchWith(home, launch, 'cmd');
  const overlay = await readyOverlay(app);
  await runInTerminal(shell, 'ping -n 30 127.0.0.1');
  await waitForOutputLine(shell, 'Pinging 127.0.0.1 with 32 bytes of data:');
  const info = await active(shell);
  expect(info).toMatchObject({ title: 'Command Prompt', running: null, integrated: false, description: null });
  await clickMenu(app, 'damocles.terminal.kill');
  await expect.poll(async () => (await terminals(shell)).length).toBe(0);
  await expect(messageDialog(overlay)).toHaveCount(0);
});

test('Git Bash reports its commands and its working directory too', async ({ home, launch }) => {
  test.skip(!windows, 'Git Bash is Windows only');
  const { shell } = await launchWith(home, launch, 'cmd');
  test.skip(!(await profileDetected(shell, 'git-bash')), 'Git Bash is not installed');
  await shell.evaluate(() => window.damoclesShell!.terminal.create({ profileId: 'git-bash', projectKey: null }));
  await expect.poll(async () => (await active(shell)).profileId).toBe('git-bash');
  await expect.poll(async () => (await active(shell)).integrated, { timeout: 30_000 }).toBe(true);
  await runInTerminal(shell, 'cd src && sleep 3');
  await expect.poll(async () => (await active(shell)).title).toBe('cd src && sleep 3');
  await expect.poll(async () => (await active(shell)).description, { timeout: 15_000 }).toBe('src');
  expect(await resolve(shell, 'app.ts')).toBe('file');
  await runInTerminal(shell, `printf 'x\\033]633;P;Cwd=C:/Windows;${NOT_A_NONCE}\\007y\\n'`);
  await waitForOutputLine(shell, 'xy');
  expect((await active(shell)).description).toBe('src');
  // Git Bash ends on its own before the teardown removes the project it stands in, which Windows refuses while it runs.
  await runInTerminal(shell, 'exit');
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'exited');
});

test('with shell integration off, the shell starts without the script', async ({ home, launch }) => {
  const { shell } = await launchWith(home, launch, INTEGRATED, { 'damocles.desktop.terminal.shellIntegration.enabled': false });
  await runInTerminal(shell, windows ? 'Write-Output "inj=[$env:DAMOCLES_INJECTION]"' : 'echo "inj=[$DAMOCLES_INJECTION]"');
  await waitForOutputLine(shell, 'inj=[]');
  expect((await active(shell)).integrated).toBe(false);
});
