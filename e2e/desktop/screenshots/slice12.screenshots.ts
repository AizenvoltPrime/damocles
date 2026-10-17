import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeChat, expect, IPC_HANDLER_ERROR_ANNOTATION, nextChat, test } from '../support/fixtures';
import { git, initRepo } from '../support/git';
import { seedStubModel, writeUserSettings } from '../support/hermetic';
import { startOpenAIStub, type StubReply } from '../support/openai-stub';
import { menuItem, overlayMenu, readyOverlay } from '../support/overlay';
import { scmSection, setSection } from '../support/scm';
import { hideEditorPane, openProjectChat, setFont, setPageSize, setReducedMotion, shot, showShellTheme, THEMES, windowShot, type Theme } from '../support/screenshots';
import { openSettingsModal, closeSettingsModal, setContentSize, settingsRow } from '../support/settings';
import { selectedProjectKey, shellPage, shellState } from '../support/shell';
import { codeEditor, diffEditor, editorShows, openInEditor } from '../support/editor';
import { addProject, answerDialogs, answerOpenDialog, CHAT_PLACEHOLDER, chatInput, clickMenu } from '../support/ui';

// Review captures of slice 12 (quick diff, peek, blame, timeline, merge editor, lenses, chat review): Dark and Light, the 13px
// default and a 16px host font, and a reduced-motion pass of a surface right after it changed. Names: <surface>-<theme>-<px>.
const WIDTH = 1440;
const HEIGHT = 900;
const FONTS = [13, 16] as const;

test.describe.configure({ mode: 'serial' });
test.setTimeout(1_200_000);

const LINES = Array.from({ length: 36 }, (_, index) => `export const value${index + 1} = ${index + 1};`);
const text = (lines: readonly string[]): string => `${lines.join('\n')}\n`;
const passes = (): Array<{ theme: Theme; font: number }> => THEMES.flatMap((theme) => FONTS.map((font) => ({ theme, font })));

async function settle(app: ElectronApplication, theme: Theme, font: number): Promise<void> {
  await showShellTheme(app, theme);
  await setFont(app, font);
}

async function scmRun(shell: Page, request: Record<string, unknown>): Promise<void> {
  await shell.evaluate(async (req) => {
    const state = await window.damoclesShell!.scm.getState();
    const repoId = state.views[0]!.selectedRepoId!;
    await window.damoclesShell!.scm.run({ ...req, repoId } as never);
  }, request);
}

/** Grows the editor pane over the window (the focus overlay), so each surface shows at a working width. */
async function focusEditor(shell: Page): Promise<void> {
  const toggle = shell.getByTestId('editor-focus-toggle');
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
}

/** Points at the blame text's start; locator.hover() would scroll Monaco's clipped lines natively when the text runs past the edge. */
async function hoverBlame(shell: Page): Promise<void> {
  const box = await codeEditor(shell).locator('.qd-blame').boundingBox();
  if (!box) throw new Error('the blame text is not laid out');
  await shell.mouse.move(box.x + 8, box.y + box.height / 2);
}

async function openFile(app: ElectronApplication, shell: Page, relativePath: string, shows: string): Promise<void> {
  expect((await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath })).ok).toBe(true);
  await editorShows(shell, shows);
}

test('slice 12 editor captures: gutter, peek, blame, diff glyphs and timeline', async ({ foreground: _foreground, home, launch }, testInfo) => {
  // HEAD, then a staged change (line 5 modified, line 30 removed), then unstaged ones (an added line, a removal, a change)
  await initRepo(home, home.project, { 'src/app.ts': text(LINES) });
  for (let index = 1; index <= 3; index++) {
    fs.writeFileSync(path.join(home.project, 'src/app.ts'), text([...LINES, `// revision ${index}`]));
    await git(home, home.project, 'commit', '-q', '-am', `Tune the values, round ${index}`);
  }
  const staged = LINES.map((line, index) => (index === 4 ? 'export const value5 = 50;' : line)).filter((_line, index) => index !== 29);
  fs.writeFileSync(path.join(home.project, 'src/app.ts'), text([...staged, '// revision 3']));
  await git(home, home.project, 'add', 'src/app.ts');
  const working = [...staged];
  working.splice(11, 0, 'export const added = true;');
  working.splice(21, 1);
  working[24] = 'export const changed = "yes";';
  fs.writeFileSync(path.join(home.project, 'src/app.ts'), text([...working, '// revision 3']));
  fs.writeFileSync(path.join(home.project, 'fresh.ts'), 'export const fresh = 1;\n');

  const { app } = await launch();
  await openProjectChat(app, home.project);
  await setContentSize(app, WIDTH, HEIGHT);
  const shell = await shellPage(app);
  await setSection(shell, 'files-section', false);
  await setSection(shell, 'scm-section', true);
  await expect(scmSection(shell).getByTestId('scm-commit-message')).toBeVisible({ timeout: 30_000 });
  const pane = shell.getByTestId('editor-pane');

  for (const { theme, font } of passes()) {
    await settle(app, theme, font);
    const t = (name: string): string => `${name}-${theme}-${font}`;

    await openFile(app, shell, 'src/app.ts', 'export const value1 = 1;');
    await focusEditor(shell);
    await codeEditor(shell).locator('.view-line', { hasText: 'export const value3 = 3;' }).click();
    await shell.keyboard.press('End');
    await expect(codeEditor(shell).locator('.qd-mark.qd-staged')).not.toHaveCount(0);
    await shot(shell, testInfo, t('quick-diff-gutter'), pane);

    // The peek on the changed line.
    await codeEditor(shell).locator('.qd-mark.qd-modified:not(.qd-staged)').first().click();
    await expect(codeEditor(shell).getByTestId('quick-diff-peek')).toBeVisible();
    await shot(shell, testInfo, t('peek'), pane);
    await codeEditor(shell).getByTestId('peek-close').click();
    await expect(codeEditor(shell).getByTestId('quick-diff-peek')).toHaveCount(0);

    // Blame on an unchanged line, then its card.
    await codeEditor(shell).locator('.view-line', { hasText: 'export const value2 = 2;' }).click();
    await shell.keyboard.press('End');
    await expect(codeEditor(shell).locator('.qd-blame')).toBeVisible();
    await shot(shell, testInfo, t('blame-text'), pane);
    await hoverBlame(shell);
    await expect(shell.getByTestId('blame-card')).toBeVisible();
    await shot(shell, testInfo, t('blame-card'), pane);
    await shell.mouse.move(5, HEIGHT - 5);
    await expect(shell.getByTestId('blame-card')).toHaveCount(0);
    // The same card with the pane back in its slot, outside the focus overlay.
    await shell.getByTestId('editor-focus-toggle').click();
    await expect(shell.getByTestId('editor-focus-toggle')).toHaveAttribute('aria-pressed', 'false');
    // the pane keeps the overlay's size until its zoom-out ends
    await expect(pane).not.toHaveAttribute('data-focus-overlay');
    await hoverBlame(shell);
    await expect(shell.getByTestId('blame-card')).toBeVisible();
    await shot(shell, testInfo, t('blame-card-docked'), pane);
    await shell.mouse.move(5, HEIGHT - 5);
    await expect(shell.getByTestId('blame-card')).toHaveCount(0);
    await focusEditor(shell);

    // The diff against the index, with Stage Block on each hunk and Stage Selection on a selection.
    await scmRun(shell, { op: 'openChanges', path: 'src/app.ts', group: 'workingTree' });
    await expect(diffEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');
    await diffEditor(shell).locator('.editor.modified .view-line', { hasText: 'export const changed' }).click({ clickCount: 3 });
    await expect(diffEditor(shell).locator('.qd-stage-selection')).toBeVisible();
    await shot(shell, testInfo, t('diff-stage-glyphs'), pane);

    // The timeline, led by Staged Changes, with one commit selected for compare, and an uncommitted file's.
    await scmRun(shell, { op: 'openTimeline', path: 'src/app.ts' });
    await expect(shell.getByTestId('timeline-entry')).not.toHaveCount(0);
    await shell.getByTestId('timeline-entry').nth(1).getByTestId('timeline-compare').click({ force: true });
    await shot(shell, testInfo, t('timeline'), pane);
    await scmRun(shell, { op: 'openTimeline', path: 'fresh.ts' });
    await expect(shell.getByTestId('timeline-empty')).toBeVisible();
    await shot(shell, testInfo, t('timeline-empty'), pane);
  }

  // Reduced motion: the peek just opened shows its final frame.
  await settle(app, 'dark', 13);
  await setReducedMotion(app, true);
  await openFile(app, shell, 'src/app.ts', 'export const value1 = 1;');
  await codeEditor(shell).locator('.qd-mark.qd-modified:not(.qd-staged)').first().click();
  await saveNow(testInfo, 'peek-dark-13-reduced', pane);
  await setReducedMotion(app, false);
});

/** A capture taken at once, without waiting for animations, so a reduced-motion frame shows whatever is on screen now. */
async function saveNow(testInfo: Parameters<typeof shot>[1], name: string, target: Locator): Promise<void> {
  const dir = process.env.DAMOCLES_SCREENSHOT_DIR;
  const file = dir ? path.join(dir, `${name}.png`) : testInfo.outputPath(`${name}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await target.screenshot({ path: file });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
}

// two edits far enough apart that git keeps them two conflicts
const BASE = 'import express from "express";\nimport { env } from "./env";\n\nconst app = express();\napp.use("/health", healthRouter);\napp.use("/auth", authRouter);\napp.use("/files", filesRouter);\napp.use("/search", searchRouter);\napp.use(errorHandler);\napp.use(notFound);\n\napp.listen(3000);\n';

test('slice 12 merge captures: the merge editor open, mid-resolve and resolved, and the inline lenses', async ({ foreground: _foreground, home, launch }, testInfo) => {
  await initRepo(home, home.project, { 'src/app.ts': BASE, 'src/routes.ts': BASE });
  await git(home, home.project, 'checkout', '-q', '-b', 'feat/users-docs');
  fs.writeFileSync(path.join(home.project, 'src/app.ts'), BASE.replace('"/health", healthRouter', '"/docs", docsRouter').replace('3000', 'env.PORT ?? 3000'));
  fs.writeFileSync(path.join(home.project, 'src/routes.ts'), BASE.replace('"/health", healthRouter', '"/users", usersRouter'));
  await git(home, home.project, 'commit', '-q', '-am', 'Document the users endpoints');
  await git(home, home.project, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(home.project, 'src/app.ts'), BASE.replace('"/health", healthRouter', 'requestId()').replace('3000', 'env.PORT ?? 8080'));
  fs.writeFileSync(path.join(home.project, 'src/routes.ts'), BASE.replace('"/health", healthRouter', '"/admin", adminRouter'));
  await git(home, home.project, 'commit', '-q', '-am', 'Add request ids');
  await expect(git(home, home.project, 'merge', 'feat/users-docs')).rejects.toThrow();

  const { app } = await launch();
  await openProjectChat(app, home.project);
  await setContentSize(app, WIDTH, HEIGHT);
  const shell = await shellPage(app);
  await setSection(shell, 'files-section', false);
  await setSection(shell, 'scm-section', true);
  const row = (file: string): Locator => scmSection(shell).locator(`[data-testid="scm-change"][data-group="merge"][data-path="${file}"]`);
  await expect(row('src/app.ts')).toBeVisible({ timeout: 30_000 });
  const pane = shell.getByTestId('editor-pane');
  const editor = shell.getByTestId('merge-editor');

  for (const { theme, font } of passes()) {
    await settle(app, theme, font);
    const t = (name: string): string => `${name}-${theme}-${font}`;
    await scmRun(shell, { op: 'openMergeEditor', path: 'src/app.ts' });
    await focusEditor(shell);
    await expect(editor.getByTestId('merge-status')).toHaveText('2 of 2 conflicts left');
    await shot(shell, testInfo, t('merge-open'), pane);
    await editor.getByTestId('merge-incoming').getByTestId('merge-accept-incoming').first().click();
    await expect(editor.getByTestId('merge-status')).toHaveText('1 of 2 conflicts left');
    await shot(shell, testInfo, t('merge-one-resolved'), pane);
    await editor.getByTestId('merge-current').getByTestId('merge-accept-current').last().click();
    await expect(editor.getByTestId('merge-status')).toHaveText('All conflicts resolved');
    await shot(shell, testInfo, t('merge-resolved'), pane);
    // Reset Result brings both conflicts back for the next pass
    const overlay = await readyOverlay(app);
    await editor.getByTestId('merge-more').click();
    await expect(overlayMenu(overlay)).toBeVisible();
    await windowShot(app, testInfo, t('merge-more-actions'));
    await menuItem(overlay, 'reset').click();
    await expect(overlayMenu(overlay)).toHaveCount(0);
    await expect(editor.getByTestId('merge-status')).toHaveText('2 of 2 conflicts left');

    // Inline lenses on the second conflicted file, then its Compare zone.
    await scmRun(shell, { op: 'openFile', path: 'src/routes.ts' });
    await editorShows(shell, '<<<<<<<');
    await expect(codeEditor(shell).locator('.codelens-decoration a').first()).toBeVisible();
    await shot(shell, testInfo, t('conflict-lenses'), pane);
    await codeEditor(shell).locator('.codelens-decoration a', { hasText: 'Compare Changes' }).click();
    await expect(codeEditor(shell).getByTestId('conflict-compare')).toBeVisible();
    await shot(shell, testInfo, t('conflict-compare'), pane);
    await codeEditor(shell).getByTestId('conflict-compare-close').click();
  }

  // Reduced motion: a region just resolved shows its final tint.
  await settle(app, 'dark', 13);
  await setReducedMotion(app, true);
  await scmRun(shell, { op: 'openMergeEditor', path: 'src/app.ts' });
  await editor.getByTestId('merge-incoming').getByTestId('merge-accept-incoming').first().click();
  await saveNow(testInfo, 'merge-one-resolved-dark-13-reduced', pane);
  await setReducedMotion(app, false);
});

// a file git merges with nine-character conflict markers (conflict-marker-size), as git suggests for one with heading underlines
const NOTES = '# Notes\n\nTitle\n=======\n\nshared line\n';

test('slice 12 review captures: the rebase pane order, long-marker lenses, the peek following an edit and the blame card left', async ({ foreground: _foreground, home, launch }, testInfo) => {
  await initRepo(home, home.project, { 'src/app.ts': BASE, 'notes.md': NOTES, '.gitattributes': 'notes.md conflict-marker-size=9\n', 'src/values.ts': text(LINES) });
  await git(home, home.project, 'checkout', '-q', '-b', 'feat/users-docs');
  fs.writeFileSync(path.join(home.project, 'src/app.ts'), BASE.replace('"/health", healthRouter', '"/docs", docsRouter'));
  fs.writeFileSync(path.join(home.project, 'notes.md'), NOTES.replace('shared line', 'feature line'));
  await git(home, home.project, 'commit', '-q', '-am', 'Document the users endpoints');
  await git(home, home.project, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(home.project, 'src/app.ts'), BASE.replace('"/health", healthRouter', 'requestId()'));
  fs.writeFileSync(path.join(home.project, 'notes.md'), NOTES.replace('shared line', 'main line'));
  await git(home, home.project, 'commit', '-q', '-am', 'Add request ids');
  await git(home, home.project, 'checkout', '-q', 'feat/users-docs');
  await expect(git(home, home.project, 'rebase', 'main')).rejects.toThrow();
  fs.writeFileSync(path.join(home.project, 'src/values.ts'), text(LINES.map((line, index) => (index === 9 ? 'export const value10 = 100;' : line))));

  const { app } = await launch();
  await openProjectChat(app, home.project);
  await setContentSize(app, WIDTH, HEIGHT);
  const shell = await shellPage(app);
  await setSection(shell, 'files-section', false);
  await setSection(shell, 'scm-section', true);
  const row = (file: string): Locator => scmSection(shell).locator(`[data-testid="scm-change"][data-group="merge"][data-path="${file}"]`);
  await expect(row('src/app.ts')).toBeVisible({ timeout: 30_000 });
  const pane = shell.getByTestId('editor-pane');
  const editor = shell.getByTestId('merge-editor');

  for (const theme of THEMES) {
    await settle(app, theme, 13);
    const t = (name: string): string => `${name}-${theme}-13`;

    // During a rebase Current, the branch rebased onto, shows first.
    await scmRun(shell, { op: 'openMergeEditor', path: 'src/app.ts' });
    await focusEditor(shell);
    await expect(editor.getByTestId('merge-current').getByTestId('merge-accept-current').first()).toBeVisible();
    await shot(shell, testInfo, t('merge-rebase-order'), pane);

    // Nine-character markers read as a conflict, so its lenses show.
    await scmRun(shell, { op: 'openFile', path: 'notes.md' });
    await editorShows(shell, '<<<<<<<<<');
    await expect(codeEditor(shell).locator('.codelens-decoration a').first()).toBeVisible();
    await shot(shell, testInfo, t('conflict-lenses-marker-size'), pane);

    // The peek stays in place while its change is edited.
    await openFile(app, shell, 'src/values.ts', 'export const value1 = 1;');
    await codeEditor(shell).locator('.qd-mark.qd-modified').first().click();
    await expect(codeEditor(shell).getByTestId('quick-diff-peek')).toBeVisible();
    // the peek's inline diff shows the line too; the first is the editor's own
    await codeEditor(shell).locator('.view-line', { hasText: 'export const value10 = 100;' }).first().click();
    await shell.keyboard.press('End');
    await shell.keyboard.type('0');
    await expect(codeEditor(shell)).toHaveAttribute('data-quick-diff', '10-10');
    await expect(codeEditor(shell).getByTestId('quick-diff-peek')).toBeVisible();
    await shot(shell, testInfo, t('peek-after-edit'), pane);
    await codeEditor(shell).getByTestId('peek-close').click();
    await expect(codeEditor(shell).getByTestId('quick-diff-peek')).toHaveCount(0);
    await shell.keyboard.press('Backspace');

    // The blame card goes once the pointer leaves it for the code.
    await codeEditor(shell).locator('.view-line', { hasText: 'export const value2 = 2;' }).click();
    await shell.keyboard.press('End');
    await expect(codeEditor(shell).locator('.qd-blame')).toBeVisible();
    await hoverBlame(shell);
    const card = shell.getByTestId('blame-card');
    await expect(card).toBeVisible();
    const box = (await card.boundingBox())!;
    await shell.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const line = (await codeEditor(shell).locator('.view-line', { hasText: 'export const value1 = 1;' }).boundingBox())!;
    await shell.mouse.move(line.x + 4, line.y + line.height / 2);
    await expect(card).toHaveCount(0);
    await shot(shell, testInfo, t('blame-card-left'), pane);
  }
});

test('slice 12 chat review captures: the header counter and its fold, the review tab with comments and the bar, and its empty state', async ({ foreground: _foreground, home, launch }, testInfo) => {
  fs.mkdirSync(path.join(home.project, 'src'), { recursive: true });
  const files = ['src/auth.ts', 'src/limits.ts', 'src/logger.ts'].map((name) => path.join(home.project, name));
  for (const [index, file] of files.entries()) fs.writeFileSync(file, `export const limit${index} = 5;\nexport const window${index} = 60;\nexport function check${index}() {\n  return true;\n}\n`);
  const edit = (file: string, from: string, to: string): StubReply => ({ chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: file, old_string: from, new_string: to } }] });
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    writeUserSettings(home, { 'damocles.dangerouslySkipPermissions': true });
    stub.replies.push(
      edit(files[0]!, 'limit0 = 5', 'limit0 = 10;\nexport const lockout0 = 15'),
      edit(files[1]!, 'window1 = 60', 'window1 = 900'),
      edit(files[2]!, '  return true;', '  log("checked");\n  return true;'),
      { chunks: ['Limits raised'] },
      { chunks: ['Nothing to change this time'] },
    );
    const { app } = await launch();
    const first = await activeChat(app);
    await expect(chatInput(first)).toBeVisible();
    const opened = nextChat(app, [first]);
    await addProject(app, home.project, false);
    const tab = await opened;
    await setContentSize(app, WIDTH, HEIGHT);
    await chatInput(tab).fill('raise the limits');
    await chatInput(tab).press('Enter');
    await expect(tab.getByText('Limits raised')).toBeVisible();
    fs.writeFileSync(files[1]!, fs.readFileSync(files[1]!, 'utf8').replace('return true', 'return false'));
    const shell = await shellPage(app);

    // The counter in the header, then folded into More at 34rem.
    await hideEditorPane(app, tab);
    await expect(tab.getByTestId('chat-header-changes')).toBeVisible();
    for (const theme of THEMES) {
      await showShellTheme(app, theme);
      await setPageSize(tab, 36 * 16, 600);
      await shot(tab, testInfo, `review-counter-${theme}-13`, tab.getByTestId('chat-header'));
      await setPageSize(tab, 34 * 16, 600);
      await tab.getByTestId('chat-header-more').click();
      await expect(tab.getByTestId('chat-header-more-menu')).toBeVisible();
      await shot(tab, testInfo, `review-counter-fold-${theme}-13`);
      await tab.keyboard.press('Escape');
    }
    await setPageSize(tab, 900, HEIGHT - 60);

    await tab.getByTestId('chat-header-changes').click();
    const review = shell.getByTestId('review-tab');
    await expect(review).toBeVisible();
    await focusEditor(shell);
    const pane = shell.getByTestId('editor-pane');
    for (const { theme, font } of passes()) {
      await settle(app, theme, font);
      const t = (name: string): string => `${name}-${theme}-${font}`;
      await review.getByTestId('review-scope-chat').click();
      await review.locator('[data-testid="changes-entry"][data-path="src/auth.ts"]').click();
      await expect(review.locator('[data-testid="changes-diff"][data-path="src/auth.ts"]')).toBeVisible();
      if (await review.getByTestId('review-comment').count() === 0) {
        await review.locator('[data-testid="changes-line"][data-type="addition"]').first().getByTestId('review-line-number').click();
        await review.getByTestId('review-comment-input').fill('Keep the lockout under the rate limit window.');
        await review.getByTestId('review-comment-input').press('Enter');
      }
      await review.locator('[data-testid="changes-line"][data-type="deletion"]').first().click({ position: { x: 150, y: 4 } });
      await shell.keyboard.press('Enter');
      await review.getByTestId('review-comment-input').fill('Why drop the old limit?');
      await shot(shell, testInfo, t('review-comments'), pane);
      await shell.keyboard.press('Escape');
      await review.locator('[data-testid="changes-entry"][data-path="src/limits.ts"]').click();
      await expect(review.locator('[data-testid="changes-diff"][data-path="src/limits.ts"]')).toBeVisible();
      await expect(review.getByTestId('changes-note')).toBeVisible();
      await shot(shell, testInfo, t('review-outside-edits'), pane);
    }
    // The last turn changed nothing.
    await selectAndSend(tab, 'anything else?', 'Nothing to change this time');
    for (const { theme, font } of passes()) {
      await settle(app, theme, font);
      await review.getByTestId('review-scope-turn').click();
      await expect(review.getByTestId('changes-empty')).toBeVisible();
      await shot(shell, testInfo, `review-last-turn-empty-${theme}-${font}`, pane);
    }
    // Reduced motion: the bar right after the first comment.
    await review.getByTestId('review-scope-chat').click();
    await review.getByTestId('review-discard').click();
    await setReducedMotion(app, true);
    await review.locator('[data-testid="changes-line"][data-type="addition"]').first().getByTestId('review-line-number').click();
    await review.getByTestId('review-comment-input').fill('One comment');
    await review.getByTestId('review-comment-input').press('Enter');
    await saveNow(testInfo, 'review-bar-dark-16-reduced', pane);
    await setReducedMotion(app, false);
  } finally {
    await stub.close();
  }
});

async function selectAndSend(tab: Page, prompt: string, reply: string): Promise<void> {
  await chatInput(tab).fill(prompt);
  await chatInput(tab).press('Enter');
  await expect(tab.getByText(reply)).toBeVisible();
}

test('slice 12 settings capture: Settings › Source control Inline blame row', async ({ foreground: _foreground, home, launch }, testInfo) => {
  await initRepo(home, home.project);
  const { app } = await launch();
  await openProjectChat(app, home.project);
  await setContentSize(app, WIDTH, HEIGHT);
  for (const { theme, font } of passes()) {
    await settle(app, theme, font);
    const overlay = await openSettingsModal(app, 'sourceControl');
    const row = settingsRow(overlay, 'damocles.desktop.git.blame.editorDecoration.enabled');
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeVisible();
    await windowShot(app, testInfo, `settings-inline-blame-${theme}-${font}`);
    await closeSettingsModal(overlay);
  }
});

/** Replaces main's handler of a review channel, so a capture can show a refused or failed send. */
async function answerReviewSend(app: ElectronApplication, answer: 'throw' | 'unsent'): Promise<void> {
  if (answer === 'throw') test.info().annotations.push({ type: IPC_HANDLER_ERROR_ANNOTATION, description: 'damocles:review:send' });
  await app.evaluate(({ ipcMain }, how) => {
    ipcMain.removeHandler('damocles:review:send');
    ipcMain.handle('damocles:review:send', () => {
      if (how === 'throw') throw new Error('The review could not be sent');
      return { ok: false, reason: how };
    });
  }, answer);
}

/** addProject in the Greek UI: the trust question answered Don't Trust in its Greek words. */
async function addGreekProject(app: ElectronApplication, dir: string): Promise<void> {
  await answerOpenDialog(app, dir);
  await answerDialogs(app, { 'Εμπιστεύεστε τους συντάκτες των αρχείων στο': 'Χωρίς εμπιστοσύνη' });
  await clickMenu(app, 'damocles.addProject');
  await expect.poll(async () => (await shellState(app)).projects.some((candidate) => candidate.fsPath === dir), { timeout: 30_000 }).toBe(true);
}

for (const lang of ['en', 'el'] as const) {
  test(`chat review keyboard and refusal captures (${lang}): focus past a comment card, the comment cap, a failed and an unsent send, a patches row`, async ({ foreground: _foreground, home, launch }, testInfo) => {
    const suffix = lang === 'en' ? '' : `-${lang}`;
    // the composer's placeholder in the launch language
    const composer = (page: Page): Locator => page.getByPlaceholder(lang === 'en' ? CHAT_PLACEHOLDER : 'Ρωτήστε τον Damocles οτιδήποτε…');
    fs.mkdirSync(path.join(home.project, 'src'), { recursive: true });
    const main = path.join(home.project, 'src', 'main.ts');
    fs.writeFileSync(main, `${Array.from({ length: 12 }, (_, index) => `export const value${index + 1} = ${index + 1};`).join('\n')}\n`);
    const outside = path.join(home.home, 'notes.txt');
    fs.writeFileSync(outside, 'first note\nsecond note\n');
    const edit = (file: string, from: string, to: string): StubReply => ({ chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: file, old_string: from, new_string: to } }] });
    const stub = await startOpenAIStub();
    try {
      seedStubModel(home, stub.baseUrl);
      writeUserSettings(home, { 'damocles.dangerouslySkipPermissions': true });
      stub.replies.push(
        edit(main, 'value3 = 3;', 'value3 = 30;\nexport const extra3 = 3;'),
        edit(main, 'value8 = 8;', 'value8 = 80;'),
        edit(outside, 'second note', 'second note, edited'),
        { chunks: ['Values raised'] },
      );
      const { app } = await launch({ args: [lang === 'en' ? '--lang=en-US' : '--lang=el-GR'] });
      const first = await activeChat(app);
      await expect(composer(first)).toBeVisible();
      const opened = nextChat(app, [first]);
      if (lang === 'en') await addProject(app, home.project, false);
      else await addGreekProject(app, home.project);
      const tab = await opened;
      await setContentSize(app, WIDTH, HEIGHT);
      await composer(tab).fill('raise the values');
      await composer(tab).press('Enter');
      await expect(tab.getByText('Values raised')).toBeVisible();
      // the patches no longer undo from what is on disk, so the row shows the recorded patches
      fs.writeFileSync(outside, 'rewritten\nby hand\n');
      const shell = await shellPage(app);
      await hideEditorPane(app, tab);
      await tab.getByTestId('chat-header-changes').click();
      const review = shell.getByTestId('review-tab');
      await expect(review).toBeVisible();
      await focusEditor(shell);
      const pane = shell.getByTestId('editor-pane');
      const mainEntry = review.locator('[data-testid="changes-entry"][data-path="src/main.ts"]');

      // A comment on the first added line, then ArrowDown from that line twice.
      await mainEntry.click();
      await expect(review.locator('[data-testid="changes-diff"][data-path="src/main.ts"]')).toBeVisible();
      await review.locator('[data-testid="changes-line"][data-type="addition"]').first().getByTestId('review-line-number').click();
      await review.getByTestId('review-comment-input').fill('Why thirty?');
      await review.getByTestId('review-comment-input').press('Enter');
      await expect(review.getByTestId('review-comment')).toHaveCount(1);
      for (const theme of THEMES) {
        await settle(app, theme, 13);
        await review.locator('[data-testid="changes-line"][data-type="addition"]').first().click({ position: { x: 150, y: 4 } });
        await shell.keyboard.press('ArrowDown');
        await shell.keyboard.press('ArrowDown');
        await shot(shell, testInfo, `review-focus-past-comment${suffix}-${theme}`, pane);
      }

      // A failed send, then a send the chat could not take, at full width and in a narrow window.
      await answerReviewSend(app, 'throw');
      for (const theme of THEMES) {
        await settle(app, theme, 13);
        await review.getByTestId('review-send').click();
        await shot(shell, testInfo, `review-send-failed${suffix}-${theme}`, pane);
      }
      await answerReviewSend(app, 'unsent');
      for (const theme of THEMES) {
        await settle(app, theme, 13);
        await review.getByTestId('review-send').click();
        await shot(shell, testInfo, `review-send-unsent${suffix}-${theme}`, pane);
      }
      await setContentSize(app, 760, HEIGHT);
      await settle(app, 'dark', 13);
      await shot(shell, testInfo, `review-send-unsent-narrow${suffix}-dark`, pane);
      await setContentSize(app, WIDTH, HEIGHT);

      // The comment cap: main holds 200 drafts, and the tab opened again shows them.
      await review.getByTestId('review-discard').click();
      await shell.evaluate(async () => {
        const state = await window.damoclesShell!.getEditorState();
        const tabReview = state.tabs.find((each) => each.review)!.review!;
        const revision = tabReview.entries.find((entry) => entry.path === 'src/main.ts')!.revision;
        const comments = Array.from({ length: 200 }, (_, index) => ({ path: 'src/main.ts', line: 9, side: 'added' as const, scope: 'chat' as const, text: `Comment ${index + 1}`, revision }));
        await window.damoclesShell!.review.setDrafts({ reviewId: tabReview.reviewId, comments });
      });
      await pane.getByTestId('editor-tab-close').first().click();
      await expect(review).toHaveCount(0);
      await tab.getByTestId('chat-header-changes').click();
      await expect(review.getByTestId('review-bar')).toContainText('200');
      await focusEditor(shell);
      await mainEntry.click();
      await expect(review.locator('[data-testid="changes-diff"][data-path="src/main.ts"]')).toBeVisible();
      for (const theme of THEMES) {
        await settle(app, theme, 13);
        await review.locator('[data-testid="changes-line"][data-type="addition"]').first().getByTestId('review-line-number').click();
        await review.getByTestId('review-comment-input').fill('One more comment');
        await review.getByTestId('review-comment-input').press('Enter');
        await shot(shell, testInfo, `review-comment-cap${suffix}-${theme}`, pane);
        if (await review.getByTestId('review-comment-input').count() > 0) await review.getByTestId('review-comment-input').press('Escape');
      }

      // A file whose recorded patches no longer undo: its diff is the patches.
      const outsideEntry = review.getByTestId('changes-entry').filter({ hasText: 'notes.txt' });
      await outsideEntry.click();
      await expect(review.locator('[data-testid="changes-diff"][data-path$="notes.txt"]')).toBeVisible();
      for (const theme of THEMES) {
        await settle(app, theme, 13);
        await shot(shell, testInfo, `review-patches-row${suffix}-${theme}`, pane);
      }
    } finally {
      await stub.close();
    }
  });
}
