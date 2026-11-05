import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { selectedProjectKey, shellPage, viewFocused } from './support/shell';
import { openProjectChat } from './support/screenshots';
import { chatInput } from './support/ui';
import { activeTab, codeEditor, DOCUMENT_END, editorShows, editorState, editorTab, filesRow, quickOpen, quickPick, saveWithKeyboard } from './support/editor';

function seedProject(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src', 'routes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'routes', 'auth.ts'), Array.from({ length: 60 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n'));
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const app = 1;\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Readme\n');
}

test('Quick Open lists the project before a query, then fuzzy results with highlighted characters and a project chip', async ({ foreground: _foreground, home, launch }) => {
  seedProject(home.project);
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const overlay = await quickOpen(app, '');
  const picker = quickPick(overlay);
  await expect(overlay.getByTestId('quick-pick-input')).toBeFocused();
  await expect(overlay.getByTestId('quick-pick-input')).toHaveAttribute('placeholder', 'Search files in all projects (append : to go to line, @ to mention in chat, > to run a command)');
  await expect(picker.getByText('alpha · current')).toBeVisible();
  await expect(picker.locator('[data-testid="quick-pick-item"]', { hasText: 'app.ts' })).toBeVisible();

  await overlay.getByTestId('quick-pick-input').fill('rauth');
  const first = picker.getByTestId('quick-pick-item').first();
  await expect(first).toContainText('auth.ts');
  await expect(first.locator('mark.quick-pick-match').first()).toBeVisible();
  await expect(first.locator('.project-avatar')).toHaveText('A');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  // The combobox names the active option, and the arrow keys move it.
  const activeId = await overlay.getByTestId('quick-pick-input').getAttribute('aria-activedescendant');
  expect(activeId).toBe(await first.getAttribute('id'));

  await overlay.getByTestId('quick-pick-input').press('Escape');
  await expect(picker).toBeHidden();
});

test('a :line suffix opens the file at that line, and opening it again from a recent pick lists it first', async ({ foreground: _foreground, home, launch }) => {
  seedProject(home.project);
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  const overlay = await quickOpen(app, 'auth.ts:42');
  await expect(overlay.getByTestId('quick-pick-hint')).toHaveText('Enter opens the file at line 42');
  await overlay.getByTestId('quick-pick-input').press('Enter');
  await expect(editorTab(shell, 'auth.ts')).toHaveAttribute('aria-selected', 'true');
  await editorShows(shell, 'line42 = 42');
  // The caret sits on line 42: Monaco draws the current-line highlight at that line's top.
  const lineTop = await codeEditor(shell).locator('.view-line', { hasText: 'line42 = 42' }).evaluate((line) => (line as HTMLElement).style.top);
  await expect.poll(() => codeEditor(shell).locator('.view-overlays .current-line').first().evaluate((highlight) => (highlight.parentElement as HTMLElement).style.top)).toBe(lineTop);

  const again = await quickOpen(app, '');
  await expect(quickPick(again).getByText('recently opened')).toBeVisible();
  await expect(quickPick(again).getByTestId('quick-pick-item').first()).toContainText('auth.ts');
  await again.getByTestId('quick-pick-input').press('Escape');
});

test('an @ prefix mentions the picked file in the chat instead of opening it', async ({ foreground: _foreground, home, launch }) => {
  seedProject(home.project);
  const { app } = await launch();
  const chat = await openProjectChat(app, home.project);
  const before = await activeTab(app);
  const overlay = await quickOpen(app, '@app.ts');
  await expect(overlay.getByTestId('quick-pick-hint')).toHaveText('Enter mentions the file in the chat');
  await overlay.getByTestId('quick-pick-input').press('Enter');
  await expect(chatInput(chat)).toHaveValue('@src/app.ts ');
  expect((await activeTab(app))?.id).toBe(before?.id);
});

const OUTSIDE_TEXT = 'first\nsecond\nabcdefgh\nfourth\n';
// Typed at :3:5, the caret sits before the fifth character of line 3.
const EDITED_TEXT = 'first\nsecond\nabcd|efgh\nfourth\n';

interface TypedForm {
  readonly name: string;
  readonly file: string;
  readonly typed: string;
}

// This platform's forms of an absolute path, each naming its own file outside the project.
function typedForms(home: { root: string; home: string }): TypedForm[] {
  const outside = path.join(home.root, 'outside');
  const spaced = path.join(home.root, 'outside folder', 'with space.txt');
  const tilde = path.join(home.home, 'notes', 'tilde.txt');
  const forms: TypedForm[] = process.platform === 'win32'
    ? [
        { name: 'backslashes.txt', file: path.join(outside, 'backslashes.txt'), typed: `${path.join(outside, 'backslashes.txt')}:3:5` },
        { name: 'forward.txt', file: path.join(outside, 'forward.txt'), typed: `${path.join(outside, 'forward.txt').replaceAll('\\', '/')}:3:5` },
        { name: 'with space.txt', file: spaced, typed: `"${spaced}":3:5` },
        { name: 'tilde.txt', file: tilde, typed: '~\\notes\\tilde.txt:3:5' },
      ]
    : [
        { name: 'absolute.txt', file: path.join(outside, 'absolute.txt'), typed: `${path.join(outside, 'absolute.txt')}:3:5` },
        { name: 'with space.txt', file: spaced, typed: `"${spaced}":3:5` },
      ];
  forms.push({ name: 'tilde-slash.txt', file: path.join(home.home, 'notes', 'tilde-slash.txt'), typed: '~/notes/tilde-slash.txt:3:5' });
  for (const form of forms) {
    fs.mkdirSync(path.dirname(form.file), { recursive: true });
    fs.writeFileSync(form.file, OUTSIDE_TEXT);
  }
  return forms;
}

test('a typed absolute path outside the project is the first row, opens editable at :3:5, saves in place and returns editable after a relaunch', async ({ foreground: _foreground, home, launch }) => {
  test.setTimeout(240_000);
  seedProject(home.project);
  const forms = typedForms(home);
  {
    const { app, close } = await launch();
    await openProjectChat(app, home.project);
    const shell = await shellPage(app);
    for (const form of forms) {
      const overlay = await quickOpen(app, form.typed);
      const rows = quickPick(overlay).getByTestId('quick-pick-item');
      await expect(rows.first()).toContainText(form.name);
      await expect(rows.first()).toContainText(path.dirname(form.file));
      // a file on this computer carries no host chip and no project chip
      await expect(rows.first().getByTestId('quick-pick-badge')).toHaveCount(0);
      await expect(rows.first().locator('.project-avatar')).toHaveCount(0);
      await expect(overlay.getByTestId('quick-pick-hint')).toHaveText('Enter opens the file at line 3, column 5');
      await overlay.getByTestId('quick-pick-input').press('Enter');

      await expect(editorTab(shell, form.name)).toHaveAttribute('aria-selected', 'true');
      await editorShows(shell, 'abcdefgh');
      await expect.poll(async () => activeTab(app)).toMatchObject({ kind: 'code', readOnly: false, displayPath: form.file });
      expect((await activeTab(app))?.projectKey).toBeUndefined();
      await expect.poll(() => viewFocused(app, shell)).toBe(true);
      await shell.keyboard.type('|');
      await expect(editorTab(shell, form.name)).toHaveAttribute('data-dirty', 'true');
      await saveWithKeyboard(app);
      await expect.poll(() => fs.readFileSync(form.file, 'utf8')).toBe(EDITED_TEXT);
      await expect(editorTab(shell, form.name)).not.toHaveAttribute('data-dirty', 'true');
    }
    await close();
  }

  const { app, close } = await launch();
  const shell = await shellPage(app);
  for (const form of forms) {
    await editorTab(shell, form.name).click();
    await editorShows(shell, 'abcd|efgh');
    await expect.poll(async () => activeTab(app)).toMatchObject({ kind: 'code', readOnly: false, displayPath: form.file });
    await codeEditor(shell).locator('.view-lines').click();
    await shell.keyboard.press(DOCUMENT_END);
    await shell.keyboard.type('fifth');
    await saveWithKeyboard(app);
    await expect.poll(() => fs.readFileSync(form.file, 'utf8')).toBe(`${EDITED_TEXT}fifth`);
  }
  await close();
});

test('a typed absolute path inside the project lists the project file and opens the tab Files opened', async ({ foreground: _foreground, home, launch }) => {
  seedProject(home.project);
  fs.writeFileSync(path.join(home.project, 'other.ts'), 'export const other = 1;\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await filesRow(shell, 'src').click();
  await filesRow(shell, 'src/app.ts').click();
  await expect(editorTab(shell, 'app.ts')).toHaveAttribute('aria-selected', 'true');
  const fromFiles = await activeTab(app);
  expect(fromFiles).toMatchObject({ projectKey: await selectedProjectKey(app), relativePath: 'src/app.ts', readOnly: false });
  // another tab in front, so the pick has to bring the Files tab back
  await filesRow(shell, 'other.ts').click();
  await expect(editorTab(shell, 'other.ts')).toHaveAttribute('aria-selected', 'true');
  const tabCount = (await editorState(app)).tabs.length;

  const overlay = await quickOpen(app, path.join(home.project, 'src', 'app.ts'));
  const rows = quickPick(overlay).getByTestId('quick-pick-item');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('app.ts');
  await expect(rows.first().locator('.project-avatar')).toHaveText('A');
  await overlay.getByTestId('quick-pick-input').press('Enter');
  await expect(editorTab(shell, 'app.ts')).toHaveAttribute('aria-selected', 'true');
  expect((await activeTab(app))?.id).toBe(fromFiles?.id);
  expect((await editorState(app)).tabs).toHaveLength(tabCount);
});

// The entries' names, in the listed order, from each option's accessible name.
async function rowNames(overlay: Page): Promise<string[]> {
  const labels = await quickPick(overlay).getByTestId('quick-pick-item').evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label') ?? ''));
  return labels.map((label) => label.split(', ')[0]!);
}

test('a typed folder lists its entries after .., folders first; Tab completes a name, Enter goes into a folder or opens a file editable at its line', async ({ foreground: _foreground, home, launch }) => {
  test.skip(process.platform !== 'win32', 'the typed forms are Windows paths');
  test.setTimeout(180_000);
  seedProject(home.project);
  const tmp = path.join(home.root, 'browse');
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.hidden'), 'hidden\n');
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(tmp, 'ab.txt'), 'first\nsecond line\nthird\n');
  fs.writeFileSync(path.join(home.home, 'home-marker.txt'), 'home\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);

  const overlay = await quickOpen(app, `${tmp}\\`);
  const input = overlay.getByTestId('quick-pick-input');
  await expect(input).toHaveAttribute('aria-autocomplete', 'list');
  await expect.poll(() => rowNames(overlay)).toEqual(['..', 'src', '.hidden', 'a.txt', 'ab.txt']);
  const src = quickPick(overlay).getByTestId('quick-pick-item').nth(1);
  await expect(src).toHaveAttribute('aria-label', 'src, folder');
  await expect(src.getByTestId('quick-pick-file-icon')).toHaveAttribute('data-directory', 'true');

  // the text after the last separator filters by prefix, and Tab completes the highlighted name in place
  await input.fill(`${tmp}\\a`);
  await expect.poll(() => rowNames(overlay)).toEqual(['a.txt', 'ab.txt']);
  await input.press('Tab');
  await expect(input).toHaveValue(`${tmp}\\a.txt`);
  await expect(input).toBeFocused();

  // a '.' after the separator lists the dotfiles
  await input.fill(`${tmp}\\.`);
  await expect.poll(() => rowNames(overlay)).toEqual(['.hidden']);

  // the first entry after .. is highlighted, so Enter goes into it and opens nothing
  await input.fill(`${tmp}\\`);
  await expect.poll(() => rowNames(overlay)).toEqual(['..', 'src', '.hidden', 'a.txt', 'ab.txt']);
  await expect(src).toHaveAttribute('aria-selected', 'true');
  await expect(input).toHaveAttribute('aria-activedescendant', (await src.getAttribute('id'))!);
  await input.press('Enter');
  await expect(input).toHaveValue(`${tmp}\\src\\`);
  await expect(quickPick(overlay)).toBeVisible();
  await expect.poll(() => rowNames(overlay)).toEqual(['..']);
  // .. is highlighted only in a folder that lists nothing else
  await expect(quickPick(overlay).getByTestId('quick-pick-item').first()).toHaveAttribute('aria-selected', 'true');
  await input.press('Enter');
  await expect(input).toHaveValue(`${tmp}\\`);

  // a file of the folder opens editable at the typed line
  await input.fill(`${tmp}\\ab.txt:2`);
  await expect(quickPick(overlay).getByTestId('quick-pick-item').first()).toContainText('ab.txt');
  await expect(overlay.getByTestId('quick-pick-hint')).toHaveText('Enter opens the file at line 2');
  await input.press('Enter');
  await expect(editorTab(shell, 'ab.txt')).toHaveAttribute('aria-selected', 'true');
  await editorShows(shell, 'second line');
  await expect.poll(async () => activeTab(app)).toMatchObject({ kind: 'code', readOnly: false, displayPath: path.join(tmp, 'ab.txt') });
  const lineTop = await codeEditor(shell).locator('.view-line', { hasText: 'second line' }).evaluate((line) => (line as HTMLElement).style.top);
  await expect.poll(() => codeEditor(shell).locator('.view-overlays .current-line').first().evaluate((highlight) => (highlight.parentElement as HTMLElement).style.top)).toBe(lineTop);

  // an existing folder with no match says so instead of falling back to the text search
  const none = await quickOpen(app, `${tmp}\\zzz`);
  await expect(none.getByTestId('quick-pick-empty')).toHaveText("No entries here start with 'zzz'.");
  // with no trailing separator the folder itself is the row to go into
  await none.getByTestId('quick-pick-input').fill(tmp);
  await expect.poll(() => rowNames(none)).toContain('browse');
  await expect(quickPick(none).getByTestId('quick-pick-item').filter({ hasText: 'browse' }).first()).toHaveAttribute('aria-label', 'browse, folder');
  // ~\ lists this computer's home, the hermetic one
  await none.getByTestId('quick-pick-input').fill('~\\');
  await expect.poll(() => rowNames(none)).toContain('home-marker.txt');
  await expect(quickPick(none).getByTestId('quick-pick-badge')).toHaveCount(0);
  await none.getByTestId('quick-pick-input').press('Escape');
  await expect(quickPick(none)).toBeHidden();
});
