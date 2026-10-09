import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeChat, expect, test } from './support/fixtures';
import { overlayPage, pressKeys, PRIMARY, shellState } from './support/shell';
import { quickOpen, quickPick } from './support/editor';
import { readyShell } from './support/shell-ui';
import { chatInput } from './support/ui';

const item = (overlay: Page, id: string): Locator => overlay.locator(`[data-testid="quick-pick-item"][data-item-id="${id}"]`);

/** Show All Commands with its accelerator from the shell; resolves with the overlay once the palette has its ">" typed. */
async function openPalette(app: ElectronApplication): Promise<Page> {
  const overlay = await overlayPage(app);
  await expect(quickPick(overlay)).toHaveCount(0);
  await pressKeys(app, '/shell/', 'P', [PRIMARY, 'shift']);
  await expect(quickPick(overlay)).toBeVisible();
  await expect(overlay.getByTestId('quick-pick-input')).toHaveValue('>');
  return overlay;
}

test('Ctrl+Shift+P lists commands with their categories and shortcuts, and "context" + Enter opens Context usage in the chat', async ({ launch }) => {
  const { app } = await launch();
  await readyShell(app);
  const chat = await activeChat(app);
  await expect(chatInput(chat)).toBeVisible();
  const overlay = await openPalette(app);
  const input = overlay.getByTestId('quick-pick-input');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('role', 'combobox');
  await expect(overlay.getByRole('listbox')).toBeVisible();

  const find = item(overlay, 'damocles.search.findInFiles');
  await input.fill('>find in files');
  await expect(find).toContainText('Find in Files');
  await expect(find.getByTestId('quick-pick-shortcut').locator('kbd')).toHaveText(process.platform === 'darwin' ? ['⇧', '⌘', 'F'] : ['Ctrl', 'Shift', 'F']);
  await expect(find).toHaveAttribute('aria-keyshortcuts', process.platform === 'darwin' ? 'Shift+Meta+F' : 'Control+Shift+F');
  await expect(input).toHaveAttribute('aria-activedescendant', (await find.getAttribute('id'))!);

  await input.fill('>context');
  await expect(quickPick(overlay).getByTestId('quick-pick-item').first()).toHaveAttribute('data-item-id', 'damocles.chat.contextUsage');
  await expect(item(overlay, 'damocles.chat.contextUsage')).toContainText('Chat: Context usage');
  await input.press('Enter');
  await expect(quickPick(overlay)).toHaveCount(0);
  await expect(chat.getByRole('dialog', { name: 'Context Usage' })).toBeVisible();

  // A command run this session comes back first, under "recently used".
  const again = await openPalette(app);
  await expect(quickPick(again).getByText('recently used')).toBeVisible();
  await expect(quickPick(again).getByTestId('quick-pick-item').first()).toHaveAttribute('data-item-id', 'damocles.chat.contextUsage');
  await again.getByTestId('quick-pick-input').press('Escape');
});

test('">" in Quick Open switches to the palette and deleting it switches back', async ({ launch }) => {
  const { app } = await launch();
  await readyShell(app);
  await activeChat(app);
  const overlay = await quickOpen(app, '');
  const input = overlay.getByTestId('quick-pick-input');
  await expect(input).toHaveAttribute('aria-label', 'Quick Open');
  await expect(input).toHaveAttribute('placeholder', 'Search files in all projects (append : to go to line, @ to mention in chat, > to run a command)');
  await input.fill('>');
  await expect(input).toHaveAttribute('aria-label', 'Command Palette');
  await expect(item(overlay, 'damocles.chat.contextUsage')).toBeVisible();
  await input.fill('');
  await expect(input).toHaveAttribute('aria-label', 'Quick Open');
  await expect(item(overlay, 'damocles.chat.contextUsage')).toHaveCount(0);
  await input.press('Escape');
});

test('a command whose precondition fails is dimmed and does not run', async ({ launch }) => {
  const { app } = await launch();
  await readyShell(app);
  await activeChat(app);
  const before = await shellState(app);
  // Save needs an open editor tab; the shell has none.
  const overlay = await openPalette(app);
  const input = overlay.getByTestId('quick-pick-input');
  await input.fill('>file: save');
  const save = item(overlay, 'damocles.editor.save');
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await expect(save).toHaveClass(/opacity-50/);
  await input.press('Enter');
  // Playwright refuses to click an aria-disabled option; force sends the click a user's pointer would.
  await save.click({ force: true });
  // Neither Enter nor the click answered: the palette stays and nothing changed.
  await expect(quickPick(overlay)).toBeVisible();
  expect((await shellState(app)).selected).toEqual(before.selected);
  await input.press('Escape');
  await expect(quickPick(overlay)).toHaveCount(0);
});

test('in Greek, typing a command\'s English title finds it', async ({ launch }) => {
  const { app } = await launch({ args: ['--lang=el-GR'] });
  await readyShell(app);
  await activeChat(app);
  const overlay = await openPalette(app);
  const input = overlay.getByTestId('quick-pick-input');
  await expect(input).toHaveAttribute('placeholder', 'Πληκτρολογήστε το όνομα μιας εντολής για εκτέλεση');
  await input.fill('>context usage');
  const context = item(overlay, 'damocles.chat.contextUsage');
  await expect(context).toBeVisible();
  // The row shows its Greek label, with the English one it matched beside it.
  await expect(context).toContainText('Chat: Context usage');
  await expect(context).not.toHaveText(/^Chat: Context usage$/);
  await input.press('Escape');
});
