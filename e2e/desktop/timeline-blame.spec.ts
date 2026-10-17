import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { overlayPage, pressKeys, PRIMARY, selectedProjectKey, shellPage, shellState } from './support/shell';
import { activeTab, bufferText, codeEditor, editorShows, editorTab, openInEditor, quickPick } from './support/editor';
import { menuItem, overlayMenu, readyOverlay } from './support/overlay';
import { openScmProject } from './support/scm';
import { git, initRepo } from './support/git';
import { readUserSettings, type HermeticHome } from './support/hermetic';

// The Timeline tab (B30, B47) and inline blame (B31), against real git in the hermetic home.

const timeline = (shell: Page): Locator => shell.getByTestId('timeline-tab');
const entries = (shell: Page): Locator => timeline(shell).getByTestId('timeline-entry');
const blameText = (shell: Page): Locator => codeEditor(shell).locator('.qd-blame');

/** Runs a palette command by id, as Ctrl+Shift+P and Enter do. */
async function runCommand(app: ElectronApplication, query: string, id: string): Promise<void> {
  const overlay = await overlayPage(app);
  await expect(quickPick(overlay)).toHaveCount(0);
  await pressKeys(app, '/shell/', 'P', [PRIMARY, 'shift']);
  await expect(quickPick(overlay)).toBeVisible();
  await overlay.getByTestId('quick-pick-input').fill(`>${query}`);
  const item = overlay.locator(`[data-testid="quick-pick-item"][data-item-id="${id}"]`);
  await expect(item).toBeVisible();
  await item.click();
  await expect(quickPick(overlay)).toHaveCount(0);
}

/** Points at the blame text's start; locator.hover() would scroll Monaco's clipped lines natively when the text runs past the edge. */
async function hoverBlame(shell: Page): Promise<void> {
  const box = await blameText(shell).boundingBox();
  if (!box) throw new Error('the blame text is not laid out');
  await shell.mouse.move(box.x + 8, box.y + box.height / 2);
}

/**
 * The card shows whole inside the editor, its top within the host's 0.375rem gap below the line. Its left edge is the
 * text's when the card fits there; otherwise Monaco moves it left until it fits.
 */
async function expectCardUnderText(shell: Page): Promise<void> {
  await expect(async () => {
    const text = await blameText(shell).boundingBox({ timeout: 2000 });
    const card = await shell.getByTestId('blame-card').boundingBox({ timeout: 2000 });
    const editor = await codeEditor(shell).locator('.monaco-editor').first().boundingBox({ timeout: 2000 });
    if (!text || !card || !editor) throw new Error('the blame text, its card or the editor is not laid out');
    expect(card.x).toBeGreaterThanOrEqual(editor.x);
    expect(card.x + card.width).toBeLessThanOrEqual(editor.x + editor.width);
    if (text.x + card.width <= editor.x + editor.width - 32) expect(Math.abs(card.x - text.x)).toBeLessThanOrEqual(2);
    expect(card.y - (text.y + text.height)).toBeGreaterThanOrEqual(0);
    expect(card.y - (text.y + text.height)).toBeLessThanOrEqual(12);
  }).toPass();
}

/** Rests the caret on a line and waits for its blame text, which is one node that moves from line to line. */
async function blameOnLine(shell: Page, line: Locator): Promise<void> {
  await line.click({ position: { x: 1, y: 2 } });
  await expect.poll(async () => {
    const text = await blameText(shell).boundingBox();
    const box = await line.boundingBox();
    return text !== null && box !== null && Math.abs(text.y + text.height / 2 - (box.y + box.height / 2)) < 2;
  }).toBe(true);
}

async function openFile(app: ElectronApplication, shell: Page, relativePath: string, text: string): Promise<void> {
  expect((await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath })).ok).toBe(true);
  await editorShows(shell, text);
}

/** A file committed `count` times as old.ts, then renamed to new.ts and committed twice more, each commit one line longer. */
async function renamedHistory(home: HermeticHome, count: number): Promise<void> {
  await initRepo(home, home.project, { 'old.ts': 'export const v = 0;\n' });
  let text = 'export const v = 0;\n';
  for (let index = 1; index < count; index++) {
    text += `export const v${index} = ${index};\n`;
    fs.writeFileSync(path.join(home.project, 'old.ts'), text);
    await git(home, home.project, 'commit', '-q', '-am', `Grow old ${index}`);
  }
  await git(home, home.project, 'mv', 'old.ts', 'new.ts');
  await git(home, home.project, 'commit', '-q', '-m', 'Rename old to new');
  fs.writeFileSync(path.join(home.project, 'new.ts'), `${text}export const renamed = true;\n`);
  await git(home, home.project, 'commit', '-q', '-am', 'Grow new');
}

test('the timeline follows a rename 50 entries at a time, Open Changes before the rename opens the old path, and Compare with Selected diffs two versions', async ({ foreground: _foreground, home, launch }) => {
  await renamedHistory(home, 55);
  const expected = (await git(home, home.project, 'log', '--follow', '--format=%H', '--', 'new.ts')).split('\n');
  expect(expected).toHaveLength(57);
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);
  await openFile(app, shell, 'new.ts', 'export const v = 0;');

  await runCommand(app, 'Open Timeline', 'damocles.git.openTimeline');
  await expect(timeline(shell)).toBeVisible();
  await expect(editorTab(shell, 'Timeline: new.ts')).toHaveAttribute('aria-selected', 'true');
  await expect(entries(shell)).not.toHaveCount(0);
  const hashes = async (): Promise<string[]> => {
    const list = timeline(shell).getByTestId('timeline-list');
    const seen = new Set<string>();
    // virtualized: scroll the whole list through, collecting each row's hash
    for (let top = 0; ; top += 200) {
      await list.evaluate((element, y) => element.scrollTo({ top: y }), top);
      for (const hash of await entries(shell).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-hash')!))) seen.add(hash);
      if (await list.evaluate((element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1)) break;
    }
    return [...seen];
  };
  await expect.poll(hashes).toEqual(expected.slice(0, 50));
  await expect(timeline(shell).getByTestId('timeline-count')).toHaveText('50+ commits');

  // Load more brings the next page, which ends the list.
  await timeline(shell).getByTestId('timeline-more').click();
  await expect.poll(hashes).toEqual(expected);
  await expect(timeline(shell).getByTestId('timeline-more')).toHaveCount(0);

  // Open Changes on the first commit, before the rename, opens old.ts at that commit.
  const oldest = timeline(shell).locator(`[data-testid="timeline-entry"][data-hash="${expected.at(-1)}"]`);
  await oldest.click();
  await expect.poll(async () => (await activeTab(app))?.displayPath ?? '').toContain('old.ts');

  // Select for Compare on the newest, Compare with Selected on the rename commit: one diff of the two versions.
  await editorTab(shell, 'Timeline: new.ts').click();
  await timeline(shell).getByTestId('timeline-list').evaluate((element) => element.scrollTo({ top: 0 }));
  const newest = timeline(shell).locator(`[data-testid="timeline-entry"][data-hash="${expected[0]}"]`);
  const rename = timeline(shell).locator(`[data-testid="timeline-entry"][data-hash="${expected[1]}"]`);
  await newest.getByTestId('timeline-compare').click({ force: true });
  await expect(newest).toHaveAttribute('aria-selected', 'true');
  await rename.getByTestId('timeline-compare').click({ force: true });
  await expect.poll(async () => (await activeTab(app))?.kind).toBe('diff');
});

test('a timeline leads with Staged Changes while the file has some, offers its commit actions in a menu, and an uncommitted file says so', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project, { 'a.ts': 'export const a = 1;\n' });
  fs.writeFileSync(path.join(home.project, 'a.ts'), 'export const a = 2;\n');
  await git(home, home.project, 'add', 'a.ts');
  fs.writeFileSync(path.join(home.project, 'fresh.ts'), 'export const fresh = 1;\n');
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);
  await openFile(app, shell, 'a.ts', 'export const a = 2;');
  await runCommand(app, 'Open Timeline', 'damocles.git.openTimeline');
  await expect(timeline(shell).getByTestId('timeline-staged')).toBeVisible();
  await expect(timeline(shell).locator('[role="option"]').first()).toHaveAttribute('data-testid', 'timeline-staged');

  // The commit's menu, as VS Code's timeline item context menu orders it.
  const overlay = await readyOverlay(app);
  await entries(shell).first().click({ button: 'right' });
  await expect(overlayMenu(overlay)).toBeVisible();
  for (const id of ['openChanges', 'openCommit', 'compare', 'copyCommitId', 'copyCommitMessage']) await expect(menuItem(overlay, id)).toBeVisible();
  await overlay.keyboard.press('Escape');
  await expect(overlayMenu(overlay)).toHaveCount(0);

  await openFile(app, shell, 'fresh.ts', 'export const fresh = 1;');
  await runCommand(app, 'Open Timeline', 'damocles.git.openTimeline');
  await expect(timeline(shell).getByTestId('timeline-empty')).toHaveText('This file is not committed yet.');
});

test('the blame card opens under its text even where the last card lay, stays while the pointer rests on the text, and a click on that text reaches the editor', async ({ foreground: _foreground, home, launch }) => {
  // equal lines, so each blame text starts where the one above it does and a card opened from one covers the next
  const lines = Array.from({ length: 16 }, (_, index) => `export const n${String(index + 1).padStart(2, '0')} = ${index + 1};`);
  await initRepo(home, home.project, { 'a.ts': `${lines.join('\n')}\n` });
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);
  await openFile(app, shell, 'a.ts', lines[0]!);
  const line = (n: number): Locator => codeEditor(shell).locator('.view-line', { hasText: `n${String(n).padStart(2, '0')} =` });
  const card = shell.getByTestId('blame-card');
  const away = async (): Promise<void> => {
    await shell.mouse.move(1, 1);
    await expect(card).toHaveCount(0);
  };

  await blameOnLine(shell, line(4));
  await hoverBlame(shell);
  await expect(card).toBeVisible();
  await expectCardUnderText(shell);
  const covered = (await card.boundingBox())!;
  await away();

  // line 5's text lies under where that card was: the card opens under line 5 instead, and outlasts the hide delay and its exit
  await blameOnLine(shell, line(5));
  const next = (await blameText(shell).boundingBox())!;
  expect(next.y + next.height / 2).toBeGreaterThan(covered.y);
  await hoverBlame(shell);
  await expect(card).toBeVisible();
  await expectCardUnderText(shell);
  await shell.waitForTimeout(800);
  await expect(card).toBeVisible();
  await expectCardUnderText(shell);
  await away();

  // a click on line 6's text, under where the card for line 5 was, puts the caret at the line's end
  await blameOnLine(shell, line(6));
  const onText = (await blameText(shell).boundingBox())!;
  await shell.mouse.click(onText.x + onText.width / 2, onText.y + onText.height / 2);
  await shell.keyboard.type('#');
  await expect.poll(() => bufferText(shell)).toContain(`${lines[5]}#\n`);
});

test('blame shows the cursor line\'s commit after a rest, its card on hover, You, Not Committed Yet after an edit, and Toggle Inline Blame hides it across a restart', async ({ foreground: _foreground, home, launch }) => {
  // support/git.ts commits as e2e <e2e@example.com>
  await initRepo(home, home.project, { 'a.ts': 'export const one = 1;\nexport const two = 2;\n' });
  await git(home, home.project, 'commit', '-q', '--amend', '-m', 'Tighten CORS for admin');
  let { app } = await launch();
  let shell = await openScmProject(app, home.project);
  await openFile(app, shell, 'a.ts', 'export const two = 2;');
  await codeEditor(shell).locator('.view-line', { hasText: 'export const two = 2;' }).click();
  await expect(blameText(shell)).toBeVisible();
  await expect(blameText(shell)).toContainText('e2e,');
  await expect(blameText(shell)).toContainText('Tighten CORS for admin');
  await expect(blameText(shell)).toContainText(/now|ago|second|minute/);

  // The card names the author, the email, a 24-hour date and the short hash.
  const hash = (await git(home, home.project, 'rev-parse', 'HEAD')).slice(0, 7);
  await hoverBlame(shell);
  const card = shell.getByTestId('blame-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('e2e@example.com');
  await expect(card.getByTestId('blame-card-hash')).toHaveText(hash);
  await expect(card.getByTestId('blame-card-date')).toHaveText(/\d{2}:\d{2}/);
  await expect(card.getByTestId('blame-card-date')).not.toHaveText(/AM|PM/);
  await expectCardUnderText(shell);

  // Leaving the card for the code hides it, as leaving the blame text does.
  const cardBox = (await card.boundingBox())!;
  await shell.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
  const firstLine = (await codeEditor(shell).locator('.view-line', { hasText: 'export const one = 1;' }).boundingBox())!;
  await shell.mouse.move(firstLine.x + 4, firstLine.y + firstLine.height / 2);
  await expect(card).toHaveCount(0);
  await hoverBlame(shell);
  await expect(card).toBeVisible();

  // In the focus overlay too, whose pane is fixed and transformed.
  await shell.mouse.move(1, 1);
  await expect(card).toHaveCount(0);
  const focusToggle = shell.getByTestId('editor-focus-toggle');
  await focusToggle.click();
  await expect(focusToggle).toHaveAttribute('aria-pressed', 'true');
  await hoverBlame(shell);
  await expect(card).toBeVisible();
  await expectCardUnderText(shell);
  await shell.mouse.move(1, 1);
  await expect(card).toHaveCount(0);
  await focusToggle.click();
  await expect(focusToggle).toHaveAttribute('aria-pressed', 'false');
  // the pane keeps the overlay's size until its zoom-out ends
  await expect(shell.getByTestId('editor-pane')).not.toHaveAttribute('data-focus-overlay');

  // A click on the blame text reaches the editor, putting the caret at the line's end; editing the line makes it the user's.
  await codeEditor(shell).locator('.view-line', { hasText: 'export const two = 2;' }).click({ position: { x: 1, y: 2 } });
  await expect(blameText(shell)).toBeVisible();
  const onText = (await blameText(shell).boundingBox())!;
  await shell.mouse.click(onText.x + onText.width / 2, onText.y + onText.height / 2);
  await shell.keyboard.type(' // edited');
  await expect.poll(() => bufferText(shell)).toContain('export const two = 2; // edited');
  await shell.keyboard.press('ArrowLeft');
  await expect(blameText(shell)).toHaveText(/You, Not Committed Yet$/);

  // A drag from the line's start across its blame text selects the whole line.
  const line = (await codeEditor(shell).locator('.view-line', { hasText: 'export const two = 2; // edited' }).boundingBox())!;
  const across = (await blameText(shell).boundingBox())!;
  await shell.mouse.move(line.x + 1, line.y + line.height / 2);
  await shell.mouse.down();
  await shell.mouse.move(across.x + across.width / 2, across.y + across.height / 2, { steps: 5 });
  await shell.mouse.up();
  await shell.keyboard.press('Backspace');
  await expect.poll(() => bufferText(shell)).toBe('export const one = 1;\n\n');

  // Toggle Inline Blame writes the setting off; it stays off after a restart.
  await runCommand(app, 'Toggle Inline Blame', 'damocles.git.blame.toggleEditorDecoration');
  await expect(blameText(shell)).toHaveCount(0);
  await expect.poll(() => readUserSettings(home)['damocles.desktop.git.blame.editorDecoration.enabled']).toBe(false);
  await app.close();

  ({ app } = await launch());
  shell = await shellPage(app);
  // the project and its selection come back with the window
  await expect.poll(async () => (await shellState(app)).projects.some((project) => project.fsPath === home.project)).toBe(true);
  await openFile(app, shell, 'a.ts', 'export const one = 1;');
  await codeEditor(shell).locator('.view-line', { hasText: 'export const one = 1;' }).click();
  // the editor has taken the setting, off, so no blame can show on any line
  await expect(codeEditor(shell)).toHaveAttribute('data-inline-blame', 'off');
  await expect(blameText(shell)).toHaveCount(0);
});
