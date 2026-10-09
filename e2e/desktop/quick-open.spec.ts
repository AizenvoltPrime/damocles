import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from './support/fixtures';
import { shellPage } from './support/shell';
import { openProjectChat } from './support/screenshots';
import { chatInput } from './support/ui';
import { activeTab, codeEditor, editorShows, editorTab, quickOpen, quickPick } from './support/editor';

function seedProject(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src', 'routes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'routes', 'auth.ts'), Array.from({ length: 60 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n'));
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const app = 1;\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Readme\n');
}

test('Quick Open lists the project before a query, then fuzzy results with highlighted characters and a project chip', async ({ home, launch }) => {
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

test('a :line suffix opens the file at that line, and opening it again from a recent pick lists it first', async ({ home, launch }) => {
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

test('an @ prefix mentions the picked file in the chat instead of opening it', async ({ home, launch }) => {
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
