import * as fs from 'node:fs';
import * as path from 'node:path';
import { activeChat, expect, test } from '../support/fixtures';
import { REPO_ROOT, seedStubModel } from '../support/hermetic';
import { setWindowContentSize } from '../support/browser';
import { captureThemes, openProjectChat } from '../support/screenshots';
import { overlayPage, pressKeys, PRIMARY, selectedProjectKey, shellPage } from '../support/shell';
import { chatRequests, startOpenAIStub } from '../support/openai-stub';
import { chatInput, sendAndAwaitEcho } from '../support/ui';
import { conflictBar, editorShows, editorTab, openInEditor, quickPick } from '../support/editor';

// Review captures for the markdown preview following the buffer, a conflicted tab and the rewind confirmation over a
// proposal diff, saved to DAMOCLES_SCREENSHOT_DIR, dark and light.
const OUT = process.env.DAMOCLES_SCREENSHOT_DIR ?? path.join(process.env.USERPROFILE ?? REPO_ROOT, '.damocles', 'screenshots', 'u5');
const WIDTH = 1440;
const HEIGHT = 900;

test.setTimeout(300_000);

test('the markdown preview of unsaved text, and a tab changed on disk', async ({ foreground: _foreground, home, launch }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(home.project, 'NOTES.md'), '# Notes\n\nSaved text.\n');
  const appFile = path.join(home.project, 'app.ts');
  fs.writeFileSync(appFile, "export const v = 'one';\n");
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  await setWindowContentSize(app, WIDTH, HEIGHT);
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  const projectKey = await selectedProjectKey(app);

  expect(await openInEditor(app, { projectKey, relativePath: 'NOTES.md', as: 'source' })).toMatchObject({ ok: true });
  await editorShows(shell, '# Notes');
  await shell.keyboard.press('Control+End');
  await shell.keyboard.type('## Typed, not saved\n\n- [x] the preview follows the buffer\n');
  expect(await openInEditor(app, { projectKey, relativePath: 'NOTES.md', as: 'preview' })).toMatchObject({ ok: true });
  await expect(shell.getByTestId('markdown-preview').locator('h2')).toHaveText('Typed, not saved');
  await captureThemes(app, OUT, 'preview-unsaved-text');

  expect(await openInEditor(app, { projectKey, relativePath: 'app.ts' })).toMatchObject({ ok: true });
  await editorShows(shell, "'one'");
  await shell.keyboard.press('Control+End');
  await shell.keyboard.type('// mine');
  await expect(editorTab(shell, 'app.ts')).toHaveAttribute('data-dirty', 'true');
  fs.writeFileSync(appFile, "export const v = 'two';\n");
  await expect(conflictBar(shell)).toBeVisible();
  // The conflicted tab, inactive, beside the active preview: its colour and its name say Changed on disk.
  await shell.locator('[data-testid="editor-tab"][data-kind="markdownPreview"]').click();
  await expect(editorTab(shell, 'app.ts')).toHaveAttribute('title', /Changed on disk/);
  await captureThemes(app, OUT, 'conflicted-tab-inactive');
});

test('the rewind confirmation over a proposal diff', async ({ home, launch }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const file = path.join(home.project, 'notes.ts');
    fs.writeFileSync(file, "export const target = 'old';\n");
    const { app } = await launch();
    await expect(chatInput(await activeChat(app))).toBeVisible();
    await setWindowContentSize(app, WIDTH, HEIGHT);
    const chat = await openProjectChat(app, home.project);

    await sendAndAwaitEcho(chat, 'before the edit');
    await expect.poll(() => chatRequests(stub).some((r) => JSON.stringify(r.body).includes('descriptive title'))).toBe(true);
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: file, old_string: "'old'", new_string: "'new'" } }] });
    await chatInput(chat).fill('change the notes');
    await chatInput(chat).press('Enter');
    const prompt = chat.getByRole('region', { name: 'Permission request' });
    await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: 'Open diff' }).click();
    await expect(chat.getByTestId('editor-overlay')).toBeVisible();

    // Rewind from the command palette while the diff is open.
    const overlay = await overlayPage(app);
    await pressKeys(app, '/shell/', 'P', [PRIMARY, 'shift']);
    await expect(quickPick(overlay)).toBeVisible();
    await overlay.getByTestId('quick-pick-input').fill('>rewind');
    await expect(overlay.locator('[data-testid="quick-pick-item"][data-item-id="damocles.chat.rewind"]')).toBeVisible();
    await overlay.getByTestId('quick-pick-input').press('Enter');
    const picker = chat.getByTestId('rewind-browser');
    await expect(picker.getByRole('option').first()).toBeVisible();
    await picker.getByRole('option', { name: /before the edit/ }).click();
    const modal = chat.getByRole('alertdialog');
    await expect(modal).toBeVisible();
    await expect.poll(() => modal.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await captureThemes(app, OUT, 'rewind-confirmation-over-proposal-diff');
  } finally {
    await stub.close();
  }
});
