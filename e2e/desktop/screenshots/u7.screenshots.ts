import * as fs from 'node:fs';
import * as path from 'node:path';
import { activeChat, expect, test } from '../support/fixtures';
import { REPO_ROOT } from '../support/hermetic';
import { setWindowContentSize } from '../support/browser';
import { captureThemes, openProjectChat } from '../support/screenshots';
import { chatInput } from '../support/ui';
import { activeTerminal, hoverTerminalText, linkHint, openTerminal, runInTerminal, useTestProfile, waitForOutputLine } from '../support/terminal';

// Review captures for the terminal's Find with an invalid regular expression and an OSC 8 hyperlink's hint, saved to
// DAMOCLES_SCREENSHOT_DIR, dark and light.
const OUT = process.env.DAMOCLES_SCREENSHOT_DIR ?? path.join(process.env.USERPROFILE ?? REPO_ROOT, '.damocles', 'screenshots', 'u7');
const MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';
const HYPERLINK_LINE = 'see docs page for more';

test.setTimeout(300_000);

test('the terminal Find with an invalid regular expression, and an OSC 8 hyperlink hovered', async ({ foreground: _foreground, home, launch }) => {
  fs.mkdirSync(OUT, { recursive: true });
  useTestProfile(home);
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  await setWindowContentSize(app, 1440, 900);
  await openProjectChat(app, home.project);
  const shell = await openTerminal(app);

  await runInTerminal(shell, 'node -e "process.stdout.write(\'see \\x1b]8;;https://example.com/docs\\x1b\\x5cdocs page\\x1b]8;;\\x1b\\x5c for more\\n\')"');
  await waitForOutputLine(shell, HYPERLINK_LINE);
  await hoverTerminalText(shell, HYPERLINK_LINE, 'docs page');
  await expect(linkHint(shell)).toHaveAttribute('data-kind', 'web');
  await captureThemes(app, OUT, 'osc8-hyperlink-hint');

  await activeTerminal(shell).locator('.xterm-screen').click();
  await shell.keyboard.press(`${MODIFIER}+F`);
  await shell.getByTestId('terminal-find-regex').click();
  await shell.getByTestId('terminal-find-input').fill('(unclosed');
  await expect(shell.getByTestId('terminal-find-input')).toHaveAttribute('aria-invalid', 'true');
  await captureThemes(app, OUT, 'find-invalid-regex');
});
