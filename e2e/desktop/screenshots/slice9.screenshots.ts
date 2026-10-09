import * as fs from 'node:fs';
import * as path from 'node:path';
import { activeChat, expect, test } from '../support/fixtures';
import { REPO_ROOT } from '../support/hermetic';
import { setWindowContentSize } from '../support/browser';
import { captureThemes, openProjectChat } from '../support/screenshots';
import { overlayPage, pressKeys, PRIMARY } from '../support/shell';
import { closeSettingsModal, openSettingsModal } from '../support/settings';
import { quickPick } from '../support/editor';
import { addProject, chatInput } from '../support/ui';
import { activeTerminal, openTerminal, runInTerminal, terminalRows, terminalText, useTestProfile } from '../support/terminal';

// Review captures for slice 9 (the integrated terminal), saved to DAMOCLES_SCREENSHOT_DIR, dark and light.
const OUT = process.env.DAMOCLES_SCREENSHOT_DIR ?? path.join(process.env.USERPROFILE ?? REPO_ROOT, '.damocles', 'screenshots', 'slice9');
const WIDTH = 1440;
const HEIGHT = 900;

test.setTimeout(600_000);

// A test run's colored report and the sixteen ANSI colors, so the capture shows the --d-ansi-* palette on the pane.
const COLORS_SCRIPT = String.raw`const e = (code, text) => '\x1b[' + code + 'm' + text + '\x1b[0m';
console.log(e('2', '> vitest run test/auth.spec.ts'));
console.log('');
console.log(' ' + e('32', '✓') + ' auth › accepts a fresh token ' + e('2', '(12 ms)'));
console.log(' ' + e('32', '✓') + ' auth › rejects an expired token ' + e('2', '(9 ms)'));
console.log(' ' + e('31', '✗') + ' lockout › locks after 10 failures');
console.log('   ' + e('31', 'AssertionError: expected 9 to equal 10'));
console.log('');
console.log(' ' + e('1', 'Tests') + '  ' + e('32', '2 passed') + ', ' + e('31', '1 failed') + ' ' + e('2', '(3)'));
console.log(' ' + e('33', 'warn') + ' coverage below 80% in ' + e('36', 'src/auth/session.ts'));
console.log(' ' + e('34', 'info') + ' see ' + e('4;36', 'https://vitest.dev/guide/') + ' for options');
console.log('');
console.log([0, 1, 2, 3, 4, 5, 6, 7].map((i) => '\x1b[4' + i + 'm   \x1b[0m').join('') + '  normal');
console.log([0, 1, 2, 3, 4, 5, 6, 7].map((i) => '\x1b[10' + i + 'm   \x1b[0m').join('') + '  bright');
`;

test('slice 9 captures', async ({ home, launch }) => {
  fs.mkdirSync(OUT, { recursive: true });
  useTestProfile(home);
  fs.writeFileSync(path.join(home.project, 'colors.js'), COLORS_SCRIPT);
  const beta = path.join(path.dirname(home.project), 'beta');
  fs.mkdirSync(beta, { recursive: true });

  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  await setWindowContentSize(app, WIDTH, HEIGHT);
  await addProject(app, beta, true);
  await openProjectChat(app, home.project);
  const shell = await openTerminal(app);
  const overlay = await overlayPage(app);

  // One terminal: its tab in the pane header, colored output, and the chat header's Terminal toggle pressed.
  await runInTerminal(shell, 'node colors.js');
  await expect.poll(() => terminalText(shell)).toContain('2 passed');
  await captureThemes(app, OUT, 'one-terminal-colored-output');

  // The new-terminal quick pick: the profiles with the default marked, then the project step.
  await shell.getByTestId('terminal-new').click();
  await expect(quickPick(overlay)).toBeVisible();
  await captureThemes(app, OUT, 'new-terminal-quick-pick');
  await overlay.keyboard.press('Enter');
  await expect(quickPick(overlay)).toHaveAttribute('data-step', 'project');
  await captureThemes(app, OUT, 'new-terminal-quick-pick-project');
  await overlay.keyboard.press('ArrowDown');
  await overlay.keyboard.press('Enter');
  await expect(terminalRows(shell)).toHaveCount(2);

  // Several terminals across two projects: the vertical list with project names, the active row's sliding indicator.
  await shell.getByTestId('terminal-new').click({ modifiers: ['Shift'] });
  await expect(terminalRows(shell)).toHaveCount(3);
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running');
  await runInTerminal(shell, 'node colors.js');
  await expect.poll(() => terminalText(shell)).toContain('2 passed');
  await captureThemes(app, OUT, 'several-terminals-list');

  // Find: Ctrl+F (Cmd+F) in the terminal opens the find widget over it.
  await activeTerminal(shell).locator('.xterm-screen').click();
  await pressKeys(app, '/shell/', 'F', [PRIMARY]);
  await expect(shell.getByTestId('terminal-find')).toBeVisible();
  await shell.getByTestId('terminal-find-input').fill('auth');
  await expect(shell.getByTestId('terminal-find-status')).not.toHaveText('');
  await captureThemes(app, OUT, 'find-open');
  await shell.getByTestId('terminal-find-input').press('Escape');
  await expect(shell.getByTestId('terminal-find')).toHaveCount(0);

  // Maximized: the pane fills the grid.
  await shell.getByTestId('terminal-maximize').click();
  await expect(shell.getByTestId('terminal-maximize')).toHaveAttribute('aria-pressed', 'true');
  await captureThemes(app, OUT, 'terminal-maximized');
  await shell.getByTestId('terminal-maximize').click();
  await expect(shell.getByTestId('terminal-maximize')).toHaveAttribute('aria-pressed', 'false');

  // An exited terminal: the exit code and Restart.
  await runInTerminal(shell, 'exit 1');
  await expect(shell.getByTestId('terminal-exited')).toBeVisible();
  await captureThemes(app, OUT, 'exited-terminal-restart');
  await shell.getByTestId('terminal-restart').click();
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running');

  // The chat header's Terminal toggle, pressed while the pane shows and released once it hides.
  await shell.getByTestId('terminal-hide').click();
  await expect(shell.getByTestId('grid-pane-terminal')).toBeHidden();
  await captureThemes(app, OUT, 'chat-header-terminal-toggle-off');

  // Settings › Terminal.
  await openSettingsModal(app, 'terminal');
  await captureThemes(app, OUT, 'settings-terminal-section');
  await closeSettingsModal(overlay);
});
