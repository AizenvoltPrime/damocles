import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '../support/fixtures';
import { REPO_ROOT } from '../support/hermetic';
import { openProjectChat, settled, showTheme, THEMES } from '../support/screenshots';
import { popupPage, popupToasts, selectedProjectKey, shellPage } from '../support/shell';
import { openTerminal, useTestProfile } from '../support/terminal';

// Review captures for a mention and an Add to Chat whose chat could not be loaded, saved to DAMOCLES_SCREENSHOT_DIR, dark and light.
const OUT = process.env.DAMOCLES_SCREENSHOT_DIR ?? path.join(process.env.USERPROFILE ?? REPO_ROOT, '.damocles', 'screenshots', 'v3b');

interface RestoreHold {
  readonly reached: boolean;
  fail(): void;
}
type HoldGlobals = typeof globalThis & {
  __damoclesE2e?: { reloadCore(): Promise<void>; holdChatRestore(): RestoreHold };
  __e2eRestoreHold?: RestoreHold;
};

test.setTimeout(300_000);

test('the toasts for a mention and an Add to Chat whose chat could not be loaded', async ({ home, launch }) => {
  fs.mkdirSync(OUT, { recursive: true });
  useTestProfile(home);
  fs.writeFileSync(path.join(home.project, 'NOTES.md'), '# Notes\n');
  const { app } = await launch({ env: { DAMOCLES_E2E_HOOKS: '1' } });
  await openProjectChat(app, home.project);
  await openTerminal(app);
  const shell = await shellPage(app);
  const projectKey = await selectedProjectKey(app);
  const terminalId = (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).terminals[0]!.id;

  await app.evaluate(() => {
    const globals = globalThis as HoldGlobals;
    globals.__e2eRestoreHold = globals.__damoclesE2e!.holdChatRestore();
    void globals.__damoclesE2e!.reloadCore();
  });
  await expect.poll(() => app.evaluate(() => (globalThis as HoldGlobals).__e2eRestoreHold!.reached)).toBe(true);
  await shell.evaluate(({ key, id }) => {
    void window.damoclesShell!.mentionFile({ projectKey: key, relativePath: 'NOTES.md' });
    window.damoclesShell!.terminal.addToChat({ id, source: 'selection', commandId: null, text: 'npm test', omittedLines: 0 });
  }, { key: projectKey, id: terminalId });
  await app.evaluate(() => (globalThis as HoldGlobals).__e2eRestoreHold!.fail());

  const popup = await popupPage(app);
  const toasts = {
    mention: popupToasts(popup).filter({ hasText: 'so the file was not mentioned in it.' }),
    output: popupToasts(popup).filter({ hasText: 'so the terminal output was not added to it.' }),
  };
  for (const toast of Object.values(toasts)) await expect(toast).toHaveCount(1);
  for (const theme of THEMES) {
    await showTheme(app, popup, theme);
    await popup.evaluate(() => {
      document.body.style.backgroundColor = 'var(--d-bg)';
    });
    await settled(popup);
    for (const [name, toast] of Object.entries(toasts)) await toast.screenshot({ path: path.join(OUT, `v3b-${name}-not-loaded-toast-${theme}.png`) });
  }
});
