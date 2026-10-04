import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { seedStubModel, type HermeticHome } from './support/hermetic';
import { chatRequests, startOpenAIStub, type OpenAIStub } from './support/openai-stub';
import { addProject, chatInput } from './support/ui';

const permissionPrompt = (tab: Page): Locator => tab.getByRole('region', { name: 'Permission request' });

/** The card of the one file change in the transcript, by the file name it shows. */
const fileCard = (tab: Page, name: string): Locator => tab.getByTestId('tool-card').filter({ hasText: name });

/** The new-file line numbers the card's diff shows, top to bottom. */
const newLineNumbers = (card: Locator): Promise<string[]> =>
  card.locator('[data-part="new-line"]').evaluateAll((cells) => cells.map((cell) => cell.textContent?.trim() ?? '').filter(Boolean));

function numbered(count: number): string {
  return Array.from({ length: count }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n') + '\n';
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

/** Opens the pending file change's Monaco proposal from its card, approves it there and waits for the file to hold `expected`. */
async function approve(tab: Page, file: string, expected: string): Promise<void> {
  await expect(permissionPrompt(tab)).toBeVisible();
  await permissionPrompt(tab).getByRole('button', { name: 'Open diff' }).click();
  await tab.getByTestId('editor-approve').click();
  await expect(permissionPrompt(tab)).toBeHidden();
  await expect.poll(() => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)).toBe(expected);
}

async function awaitTitleRequest(stub: OpenAIStub): Promise<void> {
  await expect.poll(() => chatRequests(stub).some((r) => JSON.stringify(r.body).includes('descriptive title'))).toBe(true);
}

test('an Edit far down a file numbers its card at the real line, while it awaits approval and after the result', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const file = path.join(home.project, 'far.ts');
    const original = numbered(200);
    fs.writeFileSync(file, original);
    const { app } = await launch();
    const tab = await openProject(app, home);

    stub.replies.push({ chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: file, old_string: 'export const line150 = 150;', new_string: 'export const line150 = 1500;' } }] });
    await send(tab, 'change line 150');
    await expect(permissionPrompt(tab)).toBeVisible();
    const card = fileCard(tab, 'far.ts');
    await expect.poll(() => newLineNumbers(card)).toEqual(['146', '147', '148', '149', '150', '151', '152', '153', '154']);

    await approve(tab, file, original.replace('= 150;', '= 1500;'));
    await expect(card.getByTestId('tool-card-change')).toHaveText('+1 −1');
    await expect.poll(() => newLineNumbers(card)).toEqual(['146', '147', '148', '149', '150', '151', '152', '153', '154']);
    await expect(card.locator('[data-part="new-line"]', { hasText: /^1$/ })).toHaveCount(0);
    await awaitTitleRequest(stub);
  } finally {
    await stub.close();
  }
});

test('a Write that replaces a file shows the changed lines numbered as the file is, and a new file numbered from 1', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const file = path.join(home.project, 'rewrite.ts');
    const original = numbered(200);
    const rewritten = original.replace('export const line120 = 120;', 'export const line120 = 0;');
    fs.writeFileSync(file, original);
    const { app } = await launch();
    const tab = await openProject(app, home);

    stub.replies.push({ chunks: [], toolCalls: [{ name: 'write', arguments: { path: file, content: rewritten } }] });
    await send(tab, 'rewrite the file');
    await approve(tab, file, rewritten);

    const card = fileCard(tab, 'rewrite.ts');
    await expect.poll(() => newLineNumbers(card)).toEqual(['116', '117', '118', '119', '120', '121', '122', '123', '124']);
    await expect(card.getByTestId('tool-card-change')).toHaveText('+1 −1');
    await awaitTitleRequest(stub);

    const created = path.join(home.project, 'created.ts');
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'write', arguments: { path: created, content: 'export const a = 1;\nexport const b = 2;\n' } }] });
    await send(tab, 'create a file');
    await approve(tab, created, 'export const a = 1;\nexport const b = 2;\n');
    await expect.poll(() => newLineNumbers(fileCard(tab, 'created.ts'))).toEqual(['1', '2']);
  } finally {
    await stub.close();
  }
});
