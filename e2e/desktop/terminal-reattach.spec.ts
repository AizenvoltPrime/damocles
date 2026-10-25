import type { Locator, Page } from '@playwright/test';
import type { TerminalInfo } from '../../src/desktop/preload/terminal-channels';
import { expect, test } from './support/fixtures';
import { writeUserSettings } from './support/hermetic';
import { openProjectChat } from './support/screenshots';
import { activeTerminal, openTerminal, runInTerminal, terminalText, waitForOutputLine } from './support/terminal';

const windows = process.platform === 'win32';
// An integrated shell each leg has for sure, so finished commands carry marks.
const INTEGRATED = windows ? 'windows-powershell' : 'bash';
const RED = windows ? 'Write-Host reattach-red-7f -ForegroundColor Red' : "printf '\\033[31mreattach-red-7f\\033[0m\\n'";
const OK = windows ? 'Write-Output reattach-ok-7f' : 'echo reattach-ok-7f';
// Prints [1] to [16] on one line, a fifth of a second apart, so a reload lands while it prints.
const TICKS = windows
  ? '1..16 | % { Write-Host -NoNewline "[$_]"; Start-Sleep -Milliseconds 200 }; Write-Host \'\''
  : 'for i in $(seq 1 16); do printf "[$i]"; sleep 0.2; done; echo';

const marks = (shell: Page): Locator => activeTerminal(shell).getByTestId('terminal-mark');

async function active(shell: Page): Promise<TerminalInfo> {
  const id = await activeTerminal(shell).getAttribute('data-terminal-id');
  const found = (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).terminals.find((terminal) => terminal.id === id);
  if (!found) throw new Error(`no terminal ${id}`);
  return found;
}

// Each rendered row as its cells' text, classes and inline colours, the cursor's cell included; its style follows focus, which
// a reload moves, so only where it is counts.
function screenCells(shell: Page): Promise<string[]> {
  return activeTerminal(shell).locator('.xterm-rows').evaluate((rows) => [...rows.children].map((row) => [...row.childNodes].map((node) => {
    if (!(node instanceof HTMLElement)) return node.textContent ?? '';
    const classes = [...node.classList].filter((name) => !name.startsWith('xterm-cursor-')).join('.');
    return `<${classes}${node.style.color ? `|${node.style.color}` : ''}>${node.textContent ?? ''}`;
  }).join('')));
}

const ticks = (text: string): string => text.split('\n').join('').match(/(\[\d+\])+/g)?.join('') ?? '';

test('a reloaded shell page shows each terminal\'s screen again, with its colors, cursor and marks, and no output twice', async ({ home, launch }) => {
  test.setTimeout(180_000);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': INTEGRATED, 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await openTerminal(app);
  await expect.poll(async () => (await active(shell)).integrated, { timeout: 30_000 }).toBe(true);

  await runInTerminal(shell, RED);
  await waitForOutputLine(shell, 'reattach-red-7f');
  await runInTerminal(shell, OK);
  await waitForOutputLine(shell, 'reattach-ok-7f');
  await expect(marks(shell)).toHaveCount(2, { timeout: 20_000 });
  await expect(marks(shell).last()).toHaveAttribute('data-status', 'success', { timeout: 20_000 });
  // the prompt after the last command is drawn and the cursor sits on it
  await expect.poll(async () => (await active(shell)).running).toBeNull();
  await shell.waitForTimeout(500);
  const before = await screenCells(shell);
  const statuses = await marks(shell).evaluateAll((elements) => elements.map((element) => element.getAttribute('data-status')));
  expect(before.join('\n')).toContain('xterm-cursor');

  await shell.reload();
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running');
  await expect(activeTerminal(shell).locator('.terminal-host')).not.toHaveClass(/invisible/);
  // xterm draws a fresh terminal's cursor once it has focus, as before the reload
  await activeTerminal(shell).locator('.xterm-helper-textarea').focus();
  await expect.poll(() => screenCells(shell)).toEqual(before);
  await expect(marks(shell)).toHaveCount(statuses.length);
  expect(await marks(shell).evaluateAll((elements) => elements.map((element) => element.getAttribute('data-status')))).toEqual(statuses);
  expect((await terminalText(shell)).split('\n').filter((row) => row === 'reattach-ok-7f')).toHaveLength(1);

  // Output printed across a reload arrives once, with no gap.
  await runInTerminal(shell, TICKS);
  await expect.poll(async () => ticks(await terminalText(shell)), { timeout: 20_000 }).toMatch(/\[3\]/);
  await shell.reload();
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running');
  const all = Array.from({ length: 16 }, (_, n) => `[${n + 1}]`).join('');
  await expect.poll(async () => ticks(await terminalText(shell)), { timeout: 20_000 }).toBe(all);
  await expect(marks(shell).last()).toHaveAttribute('data-status', 'success', { timeout: 20_000 });

  // The restored terminal is live: its next command runs, and gets its mark.
  const count = await marks(shell).count();
  await runInTerminal(shell, OK);
  await expect(marks(shell)).toHaveCount(count + 1, { timeout: 20_000 });
  await expect.poll(async () => (await terminalText(shell)).split('\n').filter((row) => row === 'reattach-ok-7f').length).toBe(2);
});

// Switches to the alternate screen and prints there, then waits for Enter before switching back, as a full-screen program does.
const FULL_SCREEN = windows
  ? '[Console]::Write("$([char]27)[?1049h$([char]27)[Hreattach-full-7f"); [void][Console]::ReadLine(); [Console]::Write("$([char]27)[?1049l")'
  : "printf '\\033[?1049h\\033[Hreattach-full-7f'; read x; printf '\\033[?1049l'";

test('a reload brings back every terminal: one in another tab never shown since, on a full-screen program\'s alternate screen', async ({ home, launch }) => {
  test.setTimeout(180_000);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': INTEGRATED, 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await openTerminal(app);
  await expect.poll(async () => (await active(shell)).integrated, { timeout: 30_000 }).toBe(true);
  const first = (await active(shell)).id;
  await runInTerminal(shell, OK);
  await waitForOutputLine(shell, 'reattach-ok-7f');
  await expect(marks(shell).last()).toHaveAttribute('data-status', 'success', { timeout: 20_000 });
  await runInTerminal(shell, FULL_SCREEN);
  await waitForOutputLine(shell, 'reattach-full-7f');

  // A second terminal in its own tab takes the pane, and prints there.
  await shell.evaluate(() => window.damoclesShell!.terminal.create({ profileId: null, target: { current: true } }));
  await expect(activeTerminal(shell)).not.toHaveAttribute('data-terminal-id', first);
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running');
  const second = (await active(shell)).id;
  await runInTerminal(shell, windows ? 'Write-Output second-tab-7f' : 'echo second-tab-7f');
  await waitForOutputLine(shell, 'second-tab-7f');

  await shell.reload();
  await expect(activeTerminal(shell)).toHaveAttribute('data-terminal-id', second);
  await expect(activeTerminal(shell).locator('.terminal-host')).not.toHaveClass(/invisible/);
  await expect.poll(async () => (await terminalText(shell)).split('\n').filter((row) => row === 'second-tab-7f')).toHaveLength(1);

  // The first terminal's view was never shown since the reload; it holds the full-screen program's screen.
  await shell.evaluate((id) => window.damoclesShell!.terminal.select(id), first);
  await expect(activeTerminal(shell)).toHaveAttribute('data-terminal-id', first);
  await expect(activeTerminal(shell).locator('.terminal-host')).not.toHaveClass(/invisible/);
  await expect.poll(() => terminalText(shell)).toContain('reattach-full-7f');
  expect(await terminalText(shell)).not.toContain('reattach-ok-7f');

  // The program ends: the normal screen comes back with the output and the mark from before the reload, once each.
  await activeTerminal(shell).locator('.xterm-helper-textarea').focus();
  await shell.keyboard.press('Enter');
  await expect.poll(async () => (await terminalText(shell)).split('\n').filter((row) => row === 'reattach-ok-7f'), { timeout: 20_000 }).toHaveLength(1);
  await expect(marks(shell).first()).toHaveAttribute('data-status', 'success');
  await expect(marks(shell)).toHaveCount(2, { timeout: 20_000 });
});
