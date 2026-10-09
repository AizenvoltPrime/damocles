import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { seedStubModel, type HermeticHome } from './support/hermetic';
import { chatRequests, startOpenAIStub, type OpenAIStub } from './support/openai-stub';
import { shellPage, viewFocused } from './support/shell';
import { addProject, chatInput, postFromWebview, sendAndAwaitEcho } from './support/ui';
import { activeTab, codeEditor, diffEditor, editorShows, editorState } from './support/editor';

const TARGET_OLD = "export const target = 'old';";
const TARGET_NEW = "export const target = 'new';";
const TARGET_REJECTED = "export const target = 'rejected';";

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

// The title request goes out once the first turn has ended, so the next scripted reply goes to the next turn.
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

test('rewind: the checkpoint diff opens as a diff tab in the editor pane, and rolling back restores the file', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const file = path.join(home.project, 'notes.ts');
    const original = `${TARGET_OLD}\nexport const other = 1;\n`;
    fs.writeFileSync(file, original);
    const { app } = await launch();
    const tab = await openProject(app, home);
    const shell = await shellPage(app);

    // A checkpoint is the state after its prompt's turn, so the edit comes in the turn after the one rewound to.
    await sendAndAwaitEcho(tab, 'before the edit');
    await awaitTitleRequest(stub);
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: file, old_string: TARGET_OLD, new_string: TARGET_NEW } }] });
    await send(tab, 'change the notes');
    await expect(permissionPrompt(tab)).toBeVisible();
    await permissionPrompt(tab).getByRole('option', { name: 'Yes', exact: true }).click();
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe(original.replace(TARGET_OLD, TARGET_NEW));

    await tab.getByRole('button', { name: 'Rewind conversation to this message' }).first().click();
    const modal = tab.getByRole('alertdialog');
    await expect(modal.getByText('Restore Options')).toBeVisible();
    await modal.getByRole('button', { name: 'Show affected files' }).click();
    await modal.getByTitle(`View checkpoint diff for ${file}`).click();

    // D15: only approval diffs stay in the chat; a checkpoint diff is a pane tab.
    await expect.poll(async () => (await activeTab(app))?.kind).toBe('diff');
    await expect(overlay(tab)).toBeHidden();
    await expect(diffEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');
    await expect(diffEditor(shell).locator('.editor.original .view-line', { hasText: "target = 'old'" })).toBeVisible();
    await expect(diffEditor(shell).locator('.editor.modified .view-line', { hasText: "target = 'new'" })).toBeVisible();

    await modal.getByRole('option', { name: /Rewind code to here/ }).click();
    await modal.getByRole('button', { name: 'Roll back files' }).click();
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe(original);
  } finally {
    await stub.close();
  }
});

test("open file: a chat's openFile opens a pane tab at the requested line and focuses it, with the shell's Monaco workers", async ({ foreground: _foreground, home, launch }) => {
  const file = path.join(home.project, 'lines.ts');
  fs.writeFileSync(file, Array.from({ length: 400 }, (_, i) => `export const value_${i + 1} = ${i + 1};`).join('\n'));
  const { app } = await launch();
  const project = await openProject(app, home);
  const shell = await shellPage(app);
  const failures: string[] = [];
  shell.on('console', (message) => {
    if (message.text().includes('Content Security Policy') || message.text().includes('Could not create web worker')) failures.push(message.text());
  });

  await postFromWebview(project, { type: 'openFile', filePath: file, line: 250 });
  await expect.poll(async () => (await activeTab(app))?.title).toBe('lines.ts');
  await editorShows(shell, 'value_250 = 250');
  await expect.poll(() => viewFocused(app, shell)).toBe(true);
  // Syntax highlighting and the TypeScript service run in module workers served from the shell's assets.
  expect((await tokenClassesOnLine(codeEditor(shell), 'value_250 = 250')).length).toBeGreaterThan(1);
  await expect.poll(() => ['editor', 'ts'].every((name) => shell.workers().some((worker) => worker.url().endsWith(`/desktop-shell/assets/worker-${name}.worker.js`)))).toBe(true);
  expect(failures).toEqual([]);
  expect((await editorState(app)).tabs).toHaveLength(1);
  // The chat page loads no Monaco for a file open any more.
  expect(project.workers().some((worker) => /monaco-/.test(worker.url()))).toBe(false);
});

test("JSON diagnostics follow VS Code's languages: a comment is an error in package.json, while tsconfig.json is JSON with Comments", async ({ home, launch }) => {
  fs.writeFileSync(path.join(home.project, 'package.json'), '{\n  // not JSON\n  "name": "a"\n}\n');
  fs.writeFileSync(path.join(home.project, 'tsconfig.json'), '{\n  // allowed here\n  "compilerOptions": { "strict": true, },\n  "include": [tru]\n}\n');
  const { app } = await launch();
  const project = await openProject(app, home);
  const shell = await shellPage(app);
  // The text of each line an error squiggle sits on.
  const errorLines = (): Promise<string[]> => codeEditor(shell).evaluate((editor) => {
    const lines = [...editor.querySelectorAll<HTMLElement>('.view-line')];
    return [...new Set([...editor.querySelectorAll<HTMLElement>('.squiggly-error')].map((squiggle) => {
      const top = squiggle.getBoundingClientRect().top;
      const line = lines.find((candidate) => Math.abs(candidate.getBoundingClientRect().top - top) < 2);
      return (line?.textContent ?? '').replace(/\u00a0/g, ' ').trim();
    }))];
  });

  await postFromWebview(project, { type: 'openFile', filePath: path.join(home.project, 'package.json') });
  await editorShows(shell, '"name"');
  await expect.poll(errorLines).toEqual(['// not JSON']);

  // The broken value proves the file was validated; its comment and trailing comma pass.
  await postFromWebview(project, { type: 'openFile', filePath: path.join(home.project, 'tsconfig.json') });
  await editorShows(shell, 'compilerOptions');
  await expect.poll(errorLines).toEqual(['"include": [tru]']);
});
