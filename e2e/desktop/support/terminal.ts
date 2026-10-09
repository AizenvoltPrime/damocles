import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect } from './fixtures';
import { writeUserSettings, type HermeticHome } from './hermetic';
import { menuItem, overlayMenu } from './overlay';
import { shellPage } from './shell';
import { clickMenu } from './ui';

// The shell each terminal test starts: cmd on Windows starts fastest, bash is on every Linux image the suite runs on.
export const TEST_PROFILE = process.platform === 'win32' ? 'cmd' : 'bash';

/**
 * Makes TEST_PROFILE the default profile; call before launch. These suites quit with programs still running in their
 * terminals, so kills never ask here; terminal-shell-integration.spec.ts covers the confirmation.
 */
export function useTestProfile(home: HermeticHome): void {
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': TEST_PROFILE, 'damocles.desktop.terminal.confirmOnKill': 'never' });
}

export const terminalPane = (shell: Page): Locator => shell.getByTestId('terminal-pane');
// The active terminal's view; the others stay mounted but hidden.
export const activeTerminal = (shell: Page): Locator => shell.locator('[data-testid="terminal-view"]:visible');
export const terminalRows = (shell: Page): Locator => shell.getByTestId('terminal-row');

/** Toggle Terminal from the menu: with no terminal it starts one in the current project and focuses it. */
export async function openTerminal(app: ElectronApplication): Promise<Page> {
  const shell = await shellPage(app);
  await clickMenu(app, 'damocles.toggleTerminal');
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running');
  return shell;
}

/** The active terminal's screen as xterm renders it, one line per row. */
export async function terminalText(shell: Page): Promise<string> {
  return activeTerminal(shell).locator('.xterm-rows').evaluate((rows) => [...rows.children].map((row) => (row.textContent ?? '').replace(/\u00a0/g, ' ').trimEnd()).join('\n'));
}

/** Types a command line into the active terminal and presses Enter, as a user at the keyboard does. */
export async function runInTerminal(shell: Page, command: string): Promise<void> {
  await activeTerminal(shell).locator('.xterm-screen').click();
  await shell.keyboard.type(command);
  await shell.keyboard.press('Enter');
}

/** A command that prints `marker` while its own text does not contain it, so the marker on screen is the shell's output. */
export function echoCommand(marker: string): string {
  const cut = Math.floor(marker.length / 2);
  return process.platform === 'win32' ? `echo ${marker.slice(0, cut)}^${marker.slice(cut)}` : `echo ${marker.slice(0, cut)}''${marker.slice(cut)}`;
}

/** Waits for `pattern` in the active terminal's output and returns its first group. */
export async function readFromTerminal(shell: Page, pattern: RegExp): Promise<string> {
  let found: string | undefined;
  await expect.poll(async () => {
    found = pattern.exec(await terminalText(shell))?.[1];
    return found;
  }).toBeDefined();
  return found!;
}

/** Hovers the middle of `needle` in the last visible terminal row that reads exactly `line`, moving there in steps as a hand does. */
export async function hoverTerminalText(shell: Page, line: string, needle: string): Promise<void> {
  const point = await activeTerminal(shell).evaluate((view, [wanted, part]) => {
    const screen = view.querySelector('.xterm-screen')!;
    const rows = [...view.querySelectorAll('.xterm-rows > div')].reverse();
    const row = rows.find((candidate) => (candidate.textContent ?? '').replace(/\u00a0/g, ' ').trimEnd() === wanted);
    if (!row) return null;
    const box = screen.getBoundingClientRect();
    const cell = box.width / Number(view.getAttribute('data-cols'));
    const rowBox = row.getBoundingClientRect();
    return { x: box.left + (wanted.indexOf(part) + part.length / 2) * cell, y: rowBox.top + rowBox.height / 2 };
  }, [line, needle] as const);
  if (!point) throw new Error(`no terminal row reads ${line}`);
  await shell.mouse.move(point.x, point.y - 40);
  await shell.mouse.move(point.x, point.y, { steps: 4 });
}

export const linkUnderline = (shell: Page): Locator => activeTerminal(shell).getByTestId('terminal-link-underline');
// The hint on screen, not one still playing its exit after the pointer left an earlier link.
export const linkHint = (shell: Page): Locator => activeTerminal(shell).locator('[data-testid="terminal-link-hint"]:not([class*="-leave-active"])');

/** Adds the output of the active terminal's last finished command to the chat through its mark's menu. */
export async function addLastOutputToChat(shell: Page, overlay: Page): Promise<void> {
  const mark = activeTerminal(shell).getByTestId('terminal-mark').last();
  await expect(mark).toHaveAttribute('data-status', /^(success|failure)$/, { timeout: 20_000 });
  await mark.click();
  await expect(overlayMenu(overlay)).toBeVisible();
  await menuItem(overlay, 'addOutputToChat').click();
}

/** Waits until the active terminal's last screen line reads `line`, a command's output rather than its command line. */
export async function waitForOutputLine(shell: Page, line: string): Promise<void> {
  await expect.poll(async () => (await terminalText(shell)).split('\n').some((row) => row === line)).toBe(true);
}
