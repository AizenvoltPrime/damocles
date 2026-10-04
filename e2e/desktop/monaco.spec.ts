import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { chatRequests, startOpenAIStub, type OpenAIStub } from './support/openai-stub';
import { shellState } from './support/shell';
import { addProject, chatInput, clickMenu, postFromWebview, sendAndAwaitEcho } from './support/ui';
import { editSettingsFile } from './support/settings';

const TARGET_OLD = "export const target = 'old';";
const TARGET_NEW = "export const target = 'new';";
const TARGET_REJECTED = "export const target = 'rejected';";
const SELECT_ALL = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';

// Over 1 MB, which the acceptance requires to render; the edited line sits near the top so it is in view.
function bigSource(): string {
  const lines = ['// generated for the Monaco e2e', '', TARGET_OLD];
  let length = lines.join('\n').length;
  for (let i = 0; length < 1_200_000; i++) {
    const line = `export const line${i} = ${i};`;
    lines.push(line);
    length += line.length + 1;
  }
  return `${lines.join('\n')}\n`;
}

const overlay = (tab: Page): Locator => tab.getByTestId('editor-overlay');
const diffView = (tab: Page): Locator => tab.getByTestId('editor-diff-view');
const permissionPrompt = (tab: Page): Locator => tab.getByRole('region', { name: 'Permission request' });

/** Records console lines that mean a Monaco worker could not start (CSP refusal or Monaco's main-thread fallback). */
function watchWorkerFailures(tab: Page): string[] {
  const failures: string[] = [];
  tab.on('console', (message) => {
    const text = message.text();
    if (text.includes('Content Security Policy') || text.includes('Could not create web worker')) failures.push(text);
  });
  return failures;
}

/** The distinct Monaco token classes on the rendered line containing `text`; more than one means syntax highlighting. */
async function tokenClassesOnLine(editor: Locator, text: string): Promise<string[]> {
  const line = editor.locator('.view-line', { hasText: text }).first();
  await expect(line).toBeVisible();
  return line.evaluate((el) => [...new Set([...el.querySelectorAll('span[class*="mtk"]')].flatMap((s) => [...s.classList].filter((c) => /^mtk\d+$/.test(c))))]);
}

/** Selects all and pastes `text`, as a user does; pasted text skips Monaco's auto-closing and auto-indent, which would alter typed JSON. */
async function replaceText(editor: Locator, text: string): Promise<void> {
  await editor.locator('.view-lines').click();
  await editor.page().keyboard.press(SELECT_ALL);
  await editor.locator('.native-edit-context, textarea.inputarea').first().evaluate((input, pasted) => {
    const data = new DataTransfer();
    data.setData('text/plain', pasted);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

async function openProject(app: ElectronApplication, h: HermeticHome): Promise<Page> {
  const home = await activeChat(app);
  await expect(chatInput(home)).toBeVisible();
  const opened = nextChat(app, [home]);
  await addProject(app, h.project, true);
  const tab = await opened;
  await expect(chatInput(tab)).toBeVisible();
  return tab;
}

async function send(tab: Page, text: string): Promise<void> {
  await chatInput(tab).fill(text);
  await chatInput(tab).press('Enter');
}

// The session title request follows the first turn; queuing the next tool call before it lands would hand it the title call.
async function awaitTitleRequest(stub: OpenAIStub): Promise<void> {
  await expect.poll(() => chatRequests(stub).some((r) => JSON.stringify(r.body).includes('descriptive title'))).toBe(true);
}

test('permission diff: Monaco shows original and proposed for a file over 1 MB; closing decides nothing, approve applies, reject leaves the file', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const file = path.join(home.project, 'big.ts');
    const original = bigSource();
    expect(Buffer.byteLength(original)).toBeGreaterThan(1024 * 1024);
    fs.writeFileSync(file, original);
    const { app } = await launch();
    const tab = await openProject(app, home);
    const workerFailures = watchWorkerFailures(tab);

    stub.replies.push({ chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: file, old_string: TARGET_OLD, new_string: TARGET_NEW } }] });
    await send(tab, 'edit the big file');
    await expect(permissionPrompt(tab)).toBeVisible();
    // The agent raised the proposal, so it waits for the card's Open diff and the composer keeps focus.
    await expect(overlay(tab)).toBeHidden();
    // The placeholder changes while a prompt waits, so the composer is found by its name.
    await expect(tab.getByRole('textbox', { name: 'Message Damocles' })).toBeFocused();
    await permissionPrompt(tab).getByRole('button', { name: 'Open diff' }).click();
    await expect(overlay(tab)).toBeVisible();
    await expect(overlay(tab)).toHaveAttribute('data-view-kind', 'diff');
    await expect(overlay(tab)).toHaveAttribute('data-purpose', 'proposal');
    await expect(diffView(tab)).toHaveAttribute('data-monaco-ready', 'true');
    const originalEditor = diffView(tab).locator('.editor.original');
    const modifiedEditor = diffView(tab).locator('.editor.modified');
    await expect(originalEditor.locator('.view-line', { hasText: "target = 'old'" })).toBeVisible();
    await expect(modifiedEditor.locator('.view-line', { hasText: "target = 'new'" })).toBeVisible();
    await expect(modifiedEditor.locator('.line-insert, .char-insert').first()).toBeAttached();
    await expect(originalEditor.locator('.line-delete, .char-delete').first()).toBeAttached();
    expect((await tokenClassesOnLine(modifiedEditor, "target = 'new'")).length).toBeGreaterThan(1);
    // The diff is computed in Monaco's editor worker, served from app:// under the chat panel's worker-src.
    expect(tab.workers().some((w) => /\/webview\/assets\/monaco-[^/]+\.js$/.test(w.url()))).toBe(true);

    // Closing the overlay is not a decision: the prompt stays and the file is untouched.
    await tab.getByTestId('editor-overlay-close').click();
    await expect(overlay(tab)).toBeHidden();
    await expect(permissionPrompt(tab)).toBeVisible();
    expect(fs.readFileSync(file, 'utf8')).toBe(original);

    // The card's Open diff shows the same Monaco proposal again.
    await permissionPrompt(tab).getByRole('button', { name: 'Open diff' }).click();
    await expect(overlay(tab)).toHaveAttribute('data-purpose', 'proposal');
    await expect(diffView(tab)).toHaveAttribute('data-monaco-ready', 'true');
    await tab.getByTestId('editor-overlay-close').click();
    await expect(overlay(tab)).toBeHidden();

    // The option's name is its label; its digit is announced through aria-keyshortcuts.
    const yes = permissionPrompt(tab).getByRole('option', { name: 'Yes', exact: true });
    await expect(yes).toHaveAttribute('aria-keyshortcuts', '1 Enter');
    await yes.click();
    await expect(permissionPrompt(tab)).toBeHidden();
    const approved = original.replace(TARGET_OLD, TARGET_NEW);
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe(approved);
    await awaitTitleRequest(stub);

    // A second proposal, rejected from the overlay: the prompt resolves, the overlay closes, the file keeps the approved text.
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: file, old_string: TARGET_NEW, new_string: TARGET_REJECTED } }] });
    await send(tab, 'edit it again');
    await expect(permissionPrompt(tab)).toBeVisible();
    await permissionPrompt(tab).getByRole('button', { name: 'Open diff' }).click();
    await expect(diffView(tab)).toHaveAttribute('data-monaco-ready', 'true');
    await expect(modifiedEditor.locator('.view-line', { hasText: "target = 'rejected'" })).toBeVisible();
    await tab.getByTestId('editor-reject').click();
    await expect(permissionPrompt(tab)).toBeHidden();
    await expect(overlay(tab)).toBeHidden();
    await expect.poll(() => chatRequests(stub).length).toBeGreaterThan(3);
    expect(fs.readFileSync(file, 'utf8')).toBe(approved);
    expect(workerFailures).toEqual([]);
  } finally {
    await stub.close();
  }
});

test('rewind: the confirm modal opens the checkpoint diff in Monaco, and rolling back restores the file', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const file = path.join(home.project, 'notes.ts');
    const original = `${TARGET_OLD}\nexport const other = 1;\n`;
    fs.writeFileSync(file, original);
    const { app } = await launch();
    const tab = await openProject(app, home);

    // A checkpoint is the state after its prompt's turn, so the edit comes in the turn after the one rewound to.
    await sendAndAwaitEcho(tab, 'before the edit');
    await awaitTitleRequest(stub);
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: file, old_string: TARGET_OLD, new_string: TARGET_NEW } }] });
    await send(tab, 'change the notes');
    await expect(permissionPrompt(tab)).toBeVisible();
    await permissionPrompt(tab).getByRole('option', { name: 'Yes', exact: true }).click();
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe(original.replace(TARGET_OLD, TARGET_NEW));
    await expect(overlay(tab)).toBeHidden();

    await tab.getByRole('button', { name: 'Rewind conversation to this message' }).first().click();
    const modal = tab.getByRole('alertdialog');
    await expect(modal.getByText('Restore Options')).toBeVisible();
    await modal.getByRole('button', { name: 'Show affected files' }).click();
    await modal.getByTitle(`View checkpoint diff for ${file}`).click();

    // The rewind modal steps aside while the diff is open and comes back unchanged when it closes.
    await expect(overlay(tab)).toHaveAttribute('data-purpose', 'checkpoint');
    await expect(modal).toBeHidden();
    await expect(diffView(tab)).toHaveAttribute('data-monaco-ready', 'true');
    await expect(diffView(tab).locator('.editor.original .view-line', { hasText: "target = 'old'" })).toBeVisible();
    await expect(diffView(tab).locator('.editor.modified .view-line', { hasText: "target = 'new'" })).toBeVisible();
    await tab.keyboard.press('Escape');
    await expect(overlay(tab)).toBeHidden();
    await expect(modal.getByText('Restore Options')).toBeVisible();
    await expect(modal.getByTitle(`View checkpoint diff for ${file}`)).toBeVisible();

    await modal.getByRole('option', { name: /Rewind code to here/ }).click();
    await modal.getByRole('button', { name: 'Roll back files' }).click();
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe(original);
  } finally {
    await stub.close();
  }
});

test('open file: a read-only view at the requested line in the requesting chat; untitled element context opens read-only too', async ({ home, launch }) => {
  const file = path.join(home.project, 'lines.py');
  fs.writeFileSync(file, Array.from({ length: 400 }, (_, i) => `value_${i + 1} = ${i + 1}`).join('\n'));
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const project = await openProject(app, home);
    // A chat with a conversation stays loaded when another chat is selected.
    await sendAndAwaitEcho(project, 'keep this chat');
    const projectChatId = (await shellState(app)).selected.chatId;
    const opened = nextChat(app, [project]);
    await clickMenu(app, 'damocles.newChat');
    const homeTab = await opened;
    await expect(chatInput(homeTab)).toBeVisible();

    // The request comes from the project chat while another chat is selected: the view opens there and that chat is revealed.
    await postFromWebview(project, { type: 'openFile', filePath: file, line: 250 });
    await expect.poll(async () => (await shellState(app)).selected.chatId).toBe(projectChatId);
    const view = project.getByTestId('editor-file-view');
    await expect(view).toHaveAttribute('data-monaco-ready', 'true');
    await expect(view).toHaveAttribute('data-revealed-line', '250');
    await expect(view.locator('.view-line', { hasText: 'value_250 = 250' })).toBeVisible();
    await expect(view.locator('.damocles-editor-highlight-line')).toBeVisible();
    // The other chat was a new, empty one, so leaving it dropped it rather than showing it the view.
    await expect.poll(() => homeTab.isClosed()).toBe(true);

    await view.locator('.view-lines').click();
    await project.keyboard.type('typed');
    await expect(view.locator('.view-line', { hasText: 'typed' })).toHaveCount(0);
    await project.getByTestId('editor-overlay-close').click();
    await expect(overlay(project)).toBeHidden();

    await postFromWebview(project, { type: 'openElementContext', content: '<div class="picked">element</div>' });
    const untitled = project.getByTestId('editor-file-view');
    await expect(untitled).toHaveAttribute('data-untitled', 'true');
    await expect(untitled.locator('.view-line', { hasText: 'picked' })).toBeVisible();
    expect(fs.readFileSync(file, 'utf8')).not.toContain('typed');
  } finally {
    await stub.close();
  }
});

test('settings editor: schema validation flags unknown and user-only keys, save writes the file, invalid JSON is refused', async ({ home, launch }) => {
  const userFile = path.join(home.damoclesDir, 'settings.json');
  const projectFile = path.join(home.project, '.damocles', 'settings.json');
  writeUserSettings(home, { 'damocles.maxTurns': 40, 'damocles.notARealSetting': true });
  fs.mkdirSync(path.dirname(projectFile), { recursive: true });
  // damocles.permissionMode is restricted, so user-only: a project file may not set it.
  fs.writeFileSync(projectFile, JSON.stringify({ 'damocles.maxTurns': 7, 'damocles.permissionMode': 'plan' }, null, 2));
  const { app } = await launch();
  const tab = await openProject(app, home);
  const workerFailures = watchWorkerFailures(tab);

  await editSettingsFile(app, 'user');
  const editor = tab.getByTestId('settings-json-editor');
  const monaco = tab.getByTestId('settings-json-editor-monaco');
  await expect(editor).toHaveAttribute('data-scope', 'user');
  await expect(monaco).toHaveAttribute('data-monaco-ready', 'true');
  await expect(monaco.locator('.view-line', { hasText: 'damocles.maxTurns' })).toBeVisible();
  await expect(monaco).toHaveAttribute('data-marker-count', '1');
  await expect(tab.getByTestId('settings-json-diagnostics')).toContainText('damocles.notARealSetting');

  // A valid edit saves verbatim through the host.
  const saved = '{\n  "damocles.maxTurns": 12\n}\n';
  await replaceText(monaco, saved);
  await expect(monaco).toHaveAttribute('data-marker-count', '0');
  await tab.getByTestId('settings-json-save').click();
  await expect.poll(() => fs.readFileSync(userFile, 'utf8')).toBe(saved);
  await expect(editor).toHaveAttribute('data-dirty', 'false');

  // Text that does not parse is refused with a message, and the file keeps the last save.
  await replaceText(monaco, '{\n  "damocles.maxTurns": \n');
  await tab.getByTestId('settings-json-save').click();
  await expect(tab.getByTestId('settings-json-error')).toBeVisible();
  await expect(tab.getByTestId('settings-json-error')).not.toBeEmpty();
  expect(fs.readFileSync(userFile, 'utf8')).toBe(saved);

  // The project file uses the project schema, which flags the user-only key.
  await tab.getByTestId('settings-json-close').click();
  await editor.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(editor).toBeHidden();
  await editSettingsFile(app, 'project');
  await expect(editor).toHaveAttribute('data-scope', 'project');
  await expect(monaco).toHaveAttribute('data-monaco-ready', 'true');
  await expect(monaco).toHaveAttribute('data-marker-count', '1');
  await expect(tab.getByTestId('settings-json-diagnostics')).toContainText('damocles.permissionMode');
  expect(tab.workers().some((w) => /\/webview\/assets\/monaco-[^/]+\.js$/.test(w.url()))).toBe(true);
  expect(workerFailures).toEqual([]);
});
