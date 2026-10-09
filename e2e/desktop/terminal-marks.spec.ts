import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { TerminalAction, TerminalInfo, TerminalShellEvent } from '../../src/desktop/preload/terminal-channels';
import { expect, test } from './support/fixtures';
import { writeUserSettings, type HermeticHome } from './support/hermetic';
import { menuItem, overlayMenu, readyOverlay } from './support/overlay';
import { openProjectChat } from './support/screenshots';
import { SHELL_URL } from './support/shell';
import { activeTerminal, openTerminal, runInTerminal, waitForOutputLine } from './support/terminal';
import type { E2eClipboard } from './support/clipboard';

const windows = process.platform === 'win32';
// The integrated shells each leg has for sure: Windows PowerShell on Windows, bash on Linux and macOS.
const INTEGRATED = windows ? 'windows-powershell' : 'bash';

type Launch = (options?: { env?: Record<string, string> }) => Promise<{ app: ElectronApplication; close: () => Promise<void> }>;

// What each shell runs: a command that succeeds with known output, one that fails, the exit code its mark reports (Windows
// PowerShell reports 1 for any failure, as VS Code's script does), and one that runs a while.
interface ShellCommands {
  readonly ok: string;
  readonly okOutput: string;
  readonly fail: string;
  readonly failCode: number;
  readonly slow: string;
}
const POWERSHELL: ShellCommands = { ok: 'Write-Output marks-ok-7f', okOutput: 'marks-ok-7f', fail: 'cmd /c exit 3', failCode: 1, slow: 'Start-Sleep -Seconds 3' };
const POSIX: ShellCommands = { ok: 'echo marks-ok-7f', okOutput: 'marks-ok-7f', fail: "bash -c 'exit 3'", failCode: 3, slow: 'sleep 3' };

type ShellEventLog = { __e2eLastShellEvent: Record<string, TerminalShellEvent['kind']> };

async function launchWith(home: HermeticHome, launch: Launch, settings: Record<string, unknown> = {}): Promise<{ app: ElectronApplication; shell: Page; overlay: Page }> {
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': INTEGRATED, 'damocles.desktop.terminal.confirmOnKill': 'never', ...settings });
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await openTerminal(app);
  await shell.evaluate(() => {
    const last: ShellEventLog['__e2eLastShellEvent'] = {};
    (window as unknown as ShellEventLog).__e2eLastShellEvent = last;
    window.damoclesShell!.terminal.onData(({ id, events }) => {
      for (const { event } of events ?? []) last[id] = event.kind;
    });
  });
  return { app, shell, overlay: await readyOverlay(app) };
}

async function active(shell: Page): Promise<TerminalInfo> {
  const id = await activeTerminal(shell).getAttribute('data-terminal-id');
  const found = (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).terminals.find((terminal) => terminal.id === id);
  if (!found) throw new Error(`no terminal ${id}`);
  return found;
}

const marks = (shell: Page): Locator => activeTerminal(shell).getByTestId('terminal-mark');
const markHover = (shell: Page): Locator => activeTerminal(shell).locator('[data-testid="terminal-mark-hover"]:not([class*="-leave-active"])');
const announcement = (shell: Page): Locator => activeTerminal(shell).getByTestId('terminal-announcement');
const menuIds = (overlay: Page): Promise<string[]> => overlayMenu(overlay).locator('[data-menu-item], [role="separator"]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-item-id') ?? '-'));

/** Runs `command` and waits until its mark settles with `status` and the shell has drawn its next prompt. */
async function runToMark(shell: Page, command: string, status: 'success' | 'failure'): Promise<Locator> {
  const before = await marks(shell).count();
  const { id } = await active(shell);
  await runInTerminal(shell, command);
  const mark = marks(shell).nth(before);
  await expect(mark).toHaveAttribute('data-status', status, { timeout: 20_000 });
  // Git Bash reports the exit code (633 D) before it forks cygpath and expands PS1 (__git_ps1), so the prompt's rows can still
  // scroll the mark out from under the pointer until the prompt's end (633 B) arrives.
  await expect.poll(() => shell.evaluate((terminalId) => (window as unknown as ShellEventLog).__e2eLastShellEvent[terminalId], id)).toBe('commandStart');
  return mark;
}

/** Main's palette sends a buffer command to the active terminal as this push. */
async function paletteAction(app: ElectronApplication, shell: Page, action: TerminalAction): Promise<void> {
  const id = (await active(shell)).id;
  await app.evaluate(({ webContents }, [url, request]) => {
    const page = webContents.getAllWebContents().find((wc) => wc.getURL() === url);
    if (!page) throw new Error('no shell page');
    page.send('damocles:terminal:run-action', request);
  }, [SHELL_URL, { id, action }] as const);
}

async function markScenario(app: ElectronApplication, shell: Page, overlay: Page, commands: ShellCommands, clipboard: E2eClipboard): Promise<void> {
  await expect.poll(async () => (await active(shell)).integrated, { timeout: 30_000 }).toBe(true);

  // A running command pulses, then settles into a check.
  await runInTerminal(shell, commands.slow);
  await expect(marks(shell).last()).toHaveAttribute('data-status', 'running', { timeout: 10_000 });
  await expect(marks(shell).last()).toHaveAttribute('data-status', 'success', { timeout: 20_000 });

  const ok = await runToMark(shell, commands.ok, 'success');
  await waitForOutputLine(shell, commands.okOutput);
  const fail = await runToMark(shell, commands.fail, 'failure');
  await expect(fail).toHaveAttribute('aria-label', `${commands.fail}, failed with exit code ${commands.failCode}`);
  await expect(ok).toHaveAttribute('aria-label', `${commands.ok}, succeeded`);

  // Hover names the command, its exit code and how long it took, with a 24-hour start time.
  await fail.hover();
  await expect(markHover(shell)).toBeVisible();
  await expect(markHover(shell)).toContainText(commands.fail);
  await expect(markHover(shell).getByTestId('terminal-mark-hover-status')).toHaveText(new RegExp(`^Failed with exit code ${commands.failCode} after (\\d+ ms|\\d+(\\.\\d)? s)$`));
  await expect(markHover(shell)).toContainText(/Started at \d{2}:\d{2}:\d{2}/);
  await activeTerminal(shell).locator('.xterm-screen').hover({ position: { x: 200, y: 10 } });

  // Ctrl+Up (Cmd+Up) walks back through the commands, announcing each; Ctrl+Down walks forward again.
  await activeTerminal(shell).locator('.xterm-screen').click();
  const up = windows || process.platform === 'linux' ? 'Control+ArrowUp' : 'Meta+ArrowUp';
  const down = up.replace('Up', 'Down');
  await shell.keyboard.press(up);
  await expect(announcement(shell)).toHaveText(`${commands.fail}, failed with exit code ${commands.failCode}`);
  await expect(activeTerminal(shell).locator('.terminal-nav-highlight')).toBeAttached();
  await shell.keyboard.press(up);
  await expect(announcement(shell)).toHaveText(`${commands.ok}, succeeded`);
  await shell.keyboard.press(down);
  await expect(announcement(shell)).toHaveText(`${commands.fail}, failed with exit code ${commands.failCode}`);

  // Shift+F10 on a navigated command leads the terminal menu with that command's actions. The clipboard is set first, so the
  // poll waits for this copy, which main runs only once the menu has left (OverlayApp's onAfterLeave).
  await clipboard.writeText(app, 'before');
  await shell.keyboard.press('Shift+F10');
  await expect(overlayMenu(overlay)).toBeVisible();
  expect((await menuIds(overlay)).slice(0, 6)).toEqual(['rerunCommand', '-', 'copyCommand', 'copyOutput', '-', 'addOutputToChat']);
  await menuItem(overlay, 'copyCommand').click();
  await expect.poll(() => clipboard.readText(app)).toBe(commands.fail);

  // A mark's click opens its menu: Copy Output copies that command's output from the buffer.
  await ok.click();
  await expect(overlayMenu(overlay)).toBeVisible();
  expect(await menuIds(overlay)).toEqual(['rerunCommand', '-', 'copyCommand', 'copyOutput', '-', 'addOutputToChat']);
  await menuItem(overlay, 'copyOutput').click();
  await expect.poll(() => clipboard.readText(app)).toBe(commands.okOutput);

  // Rerun Command runs the command line again, which gets a mark of its own.
  const count = await marks(shell).count();
  await ok.click();
  await menuItem(overlay, 'rerunCommand').click();
  await expect(marks(shell)).toHaveCount(count + 1, { timeout: 20_000 });
  await expect(marks(shell).last()).toHaveAttribute('data-status', 'success', { timeout: 20_000 });

  // The context menu and the palette copy the last command and its output.
  await clipboard.writeText(app, 'before');
  await activeTerminal(shell).locator('.xterm-screen').click({ button: 'right' });
  await menuItem(overlay, 'copyLastCommand').click();
  await expect.poll(() => clipboard.readText(app)).toBe(commands.ok);
  await clipboard.writeText(app, 'before');
  await paletteAction(app, shell, 'copyLastCommandOutput');
  await expect.poll(() => clipboard.readText(app)).toBe(commands.okOutput);
}

test('a command in the integrated shell gets a mark that settles to its exit code, with hover, navigation, its menu and the copies', async ({ clipboard, home, launch }) => {
  test.setTimeout(180_000);
  const { app, shell, overlay } = await launchWith(home, launch);
  await markScenario(app, shell, overlay, windows ? POWERSHELL : POSIX, clipboard);
});

test('Git Bash commands get marks with their exit codes too', async ({ clipboard, home, launch }) => {
  test.skip(!windows, 'Git Bash is Windows only');
  test.setTimeout(180_000);
  const { app, shell, overlay } = await launchWith(home, launch);
  const detected = (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).profiles.some((profile) => profile.id === 'git-bash');
  test.skip(!detected, 'Git Bash is not installed');
  await shell.evaluate(() => window.damoclesShell!.terminal.create({ profileId: 'git-bash', projectKey: null }));
  await expect.poll(async () => (await active(shell)).profileId).toBe('git-bash');
  await markScenario(app, shell, overlay, POSIX, clipboard);
});

for (const shellName of ['zsh', 'fish']) {
  test(`${shellName} commands get marks with their exit codes too`, async ({ clipboard, home, launch }) => {
    test.skip(windows, `${shellName} runs on macOS and Linux`);
    test.setTimeout(180_000);
    const { app, shell, overlay } = await launchWith(home, launch);
    const detected = (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).profiles.some((profile) => profile.id === shellName);
    test.skip(!detected, `${shellName} is not installed`);
    await shell.evaluate((profileId) => window.damoclesShell!.terminal.create({ profileId, projectKey: null }), shellName);
    await expect.poll(async () => (await active(shell)).profileId).toBe(shellName);
    await markScenario(app, shell, overlay, POSIX, clipboard);
  });
}

test('with command marks hidden, commands draw no mark and Ctrl+Up still reaches them', async ({ home, launch }) => {
  const { shell } = await launchWith(home, launch, { 'damocles.desktop.terminal.shellIntegration.decorationsEnabled': false });
  const commands = windows ? POWERSHELL : POSIX;
  await expect.poll(async () => (await active(shell)).integrated, { timeout: 30_000 }).toBe(true);
  await runInTerminal(shell, commands.ok);
  await waitForOutputLine(shell, commands.okOutput);
  await expect(marks(shell)).toHaveCount(0);
  await activeTerminal(shell).locator('.xterm-screen').click();
  await shell.keyboard.press(windows || process.platform === 'linux' ? 'Control+ArrowUp' : 'Meta+ArrowUp');
  await expect(announcement(shell)).toHaveText(`${commands.ok}, succeeded`);
  await expect(marks(shell)).toHaveCount(0);
});
