import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { REPO_ROOT, writeUserSettings } from '../support/hermetic';
import { openProjectChat, settled, showTheme, THEMES } from '../support/screenshots';
import { closeSettingsModal, openSettingsModal, setContentSize, settingsRow } from '../support/settings';
import { answerToast, popupPage, recordedToasts, recordToasts, shellPage, shellState } from '../support/shell';
import { activeTab, codeEditor, editorShows, openInEditor, saveWithKeyboard } from '../support/editor';
import { installPrettierStub } from '../support/prettier';
import { addProject } from '../support/ui';

// Review captures for format on save (D29): the settings row, the untrusted and timeout notices, the Formatting… chip and
// the Format log tab, dark and light, saved to DAMOCLES_SCREENSHOT_DIR.
const OUT = process.env.DAMOCLES_SCREENSHOT_DIR ?? path.join(process.env.USERPROFILE ?? REPO_ROOT, '.damocles', 'screenshots', 'slice7b');

test.describe.configure({ mode: 'serial' });
test.setTimeout(600_000);

async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  await settled(page);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.png`), await (target ?? page).screenshot());
}

function seed(dir: string, stubDelayMs?: number): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'limits.ts'), [
    "import { rateLimit } from 'express-rate-limit';",
    '',
    '// Five attempts per IP every fifteen minutes.',
    'export const loginLimiter=rateLimit({ windowMs: 15 * 60 * 1000, limit: 5 })',
    '',
  ].join('\n'));
  if (stubDelayMs !== undefined) installPrettierStub(dir, '3.3.3', stubDelayMs);
}

async function projectKey(app: ElectronApplication, dir: string): Promise<string> {
  return (await shellState(app)).projects.find((project) => project.fsPath === dir)!.key;
}

async function editAndSave(app: ElectronApplication, shell: Page, key: string): Promise<void> {
  expect(await openInEditor(app, { projectKey: key, relativePath: 'src/limits.ts' })).toMatchObject({ ok: true });
  await editorShows(shell, 'loginLimiter');
  await codeEditor(shell).locator('.view-lines').click();
  await shell.keyboard.press('Control+End');
  await shell.keyboard.type('// edited');
  await saveWithKeyboard(app);
}

/** The newest toast whose message holds `text` and whose id is not in `seen`, once the popup shows it. */
async function toastCard(app: ElectronApplication, text: string, seen: ReadonlySet<string> = new Set()): Promise<{ id: string; card: Locator; popup: Page }> {
  const matching = async (): Promise<string[]> => (await recordedToasts(app)).filter((notice) => notice.message.includes(text) && !seen.has(notice.id)).map((notice) => notice.id);
  await expect.poll(async () => (await matching()).length).toBeGreaterThan(0);
  const id = (await matching()).at(-1)!;
  const popup = await popupPage(app);
  const card = popup.locator(`[data-testid="overlay-toast"][data-toast-id="${id}"]`);
  await expect(card).toBeVisible();
  await popup.mouse.move(0, 0);
  return { id, card, popup };
}

test('slice 7b captures', async ({ home, launch }) => {
  const trusted = home.project;
  const untrusted = path.join(path.dirname(home.project), 'bookshelf');
  seed(trusted, 5000);
  seed(untrusted);
  writeUserSettings(home, { 'damocles.desktop.editor.formatOnSave': true });
  const { app } = await launch();
  await openProjectChat(app, trusted);
  await addProject(app, untrusted, false);
  await setContentSize(app, 1440, 900);
  await recordToasts(app);
  const shell = await shellPage(app);

  // timeout notices already answered with Show Output
  const answered = new Set<string>();
  for (const theme of THEMES) {
    await showTheme(app, shell, theme);
    const t = (name: string): string => `${name}-${theme}`;

    // The Editor section with the Format on save row, switched on.
    const overlay = await openSettingsModal(app, 'editor');
    await settingsRow(overlay, 'damocles.desktop.editor.formatOnSave').scrollIntoViewIfNeeded();
    await shot(overlay, t('settings-editor-format-on-save'));
    await shot(overlay, t('settings-format-on-save-row'), settingsRow(overlay, 'damocles.desktop.editor.formatOnSave'));
    await closeSettingsModal(overlay);

    // A save in the untrusted project: the notice with Trust (once per run, so the light capture re-themes the same card).
    if (theme === 'dark') await editAndSave(app, shell, await projectKey(app, untrusted));
    const untrustedToast = await toastCard(app, 'Format on save is off in untrusted folders');
    await shot(untrustedToast.popup, t('notice-untrusted-trust'), untrustedToast.card);

    // A save in the trusted project whose Prettier takes 5 s: the Formatting… chip, then the timeout notice.
    await editAndSave(app, shell, await projectKey(app, trusted));
    await expect(shell.getByTestId('editor-formatting')).toBeVisible();
    await shot(shell, t('formatting-indicator'), shell.getByTestId('editor-pane'));
    const timeout = await toastCard(app, 'took longer than 3 seconds', answered);
    answered.add(timeout.id);
    await expect(shell.getByTestId('editor-formatting')).toBeHidden();
    await shot(timeout.popup, t('notice-timeout-show-output'), timeout.card);

    // Show Output: the Format log as a read-only log tab.
    await answerToast(app, timeout.id, 'Show Output');
    await expect.poll(async () => (await activeTab(app))?.kind).toBe('log');
    await editorShows(shell, 'took longer than 3000 ms');
    // Maximized, so the log's lines show whole.
    await shell.evaluate(() => window.damoclesShell!.toggleMaximize('editor'));
    await shot(shell, t('format-log-tab'), shell.getByTestId('editor-pane'));
    await shell.evaluate(() => window.damoclesShell!.toggleMaximize('editor'));
  }
});
