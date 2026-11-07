import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { chatById, expect, selectChatPage, test } from './support/fixtures';
import { expectNoAxeViolations } from './support/axe';
import { designChatPage } from './support/design';
import { seedStubModel } from './support/hermetic';
import { call, startOpenAIStub } from './support/openai-stub';
import { openProjectChat, setPageSize } from './support/screenshots';
import { activeTab, diffEditor } from './support/editor';
import { shellPage, shellState } from './support/shell';
import { awaitTurnEnd, chatInput } from './support/ui';

// PD-36: in a design chat, Fork from here makes a separate, unlinked design from the fork point's files,
// and Rewind continues the same design in a new chat with the later decision and screen gone, leaving the old chat read-only
// behind a banner that opens the current one.

test.describe.configure({ timeout: 300_000 });

const screenHtml = (body: string): string => [
  '<!doctype html>',
  '<html lang="en" data-ds-screen="S1" data-ds-states="default">',
  '<head><meta charset="utf-8"><title>Contacts</title></head>',
  `<body><main><h1>Contacts</h1>${body}</main></body></html>`,
  '',
].join('\n');

const SCREEN_TABLE = screenHtml('<table><tr><td>Ada Lovelace</td></tr></table>');
const SCREEN_CARDS = screenHtml('<ul><li>Ada Lovelace</li></ul>');
const ASK_TABLE = 'Lay out the contacts as a table';
const ASK_CARDS = 'Try contact cards instead';

interface LinkFile { designSessionId: string | null; superseded: string[]; parentSessionId: string | null }

const read = (file: string): string => fs.readFileSync(file, 'utf8');
const readLink = (designsDir: string, designId: string): LinkFile => JSON.parse(read(path.join(designsDir, '.state', designId, 'link.json'))) as LinkFile;

async function send(page: Page, text: string, reply: string): Promise<void> {
  await chatInput(page).fill(text);
  await chatInput(page).press('Enter');
  await expect(page.getByText(reply, { exact: true })).toBeVisible({ timeout: 30_000 });
  await awaitTurnEnd(page);
}

/** Opens the rewind dock at the user message `text`, once that turn's checkpoint shows its rewind control. */
async function openRewindDock(page: Page, text: string): Promise<Locator> {
  const rewind = page.locator('[data-type="user-message"]', { hasText: text }).getByTestId('user-message-rewind');
  await expect(rewind).toHaveCount(1, { timeout: 30_000 });
  await rewind.click();
  const dock = page.getByRole('alertdialog');
  await expect(dock).toBeVisible();
  // The checkpoint details arrive after the dock opens.
  await expect(dock.locator('[data-row="files"] [role="status"]')).toHaveCount(0);
  return dock;
}

test('in a design chat, Fork from here makes its own design from the fork point, and Rewind continues the design in a new chat behind a superseded banner', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const parent = await openProjectChat(app, home.project);

    stub.replies.push(
      call('StartDesign', { title: 'Contacts list', brief: 'Design the contacts list page.' }),
      { chunks: ['Ready to design the contacts list.'] },
    );
    await chatInput(parent).fill('Design the contacts page before we build it');
    await chatInput(parent).press('Enter');
    await awaitTurnEnd(parent);

    const design = await designChatPage(app, [parent]);
    await selectChatPage(app, design);
    // Tall enough that the virtualized transcript keeps every row of the run mounted.
    await setPageSize(design, 900, 6000);
    await expect(design.getByText('Ready to design the contacts list.')).toBeVisible({ timeout: 30_000 });
    await awaitTurnEnd(design);
    const designId = (await design.getByTestId('design-header').getAttribute('data-design-id'))!;
    const designsDir = path.join(home.damoclesDir, 'designs');
    const screen = (id: string): string => path.join(designsDir, id, 'screens', 'S1-contacts.html');
    const firstChatId = readLink(designsDir, designId).designSessionId!;
    expect(firstChatId).toBeTruthy();

    // Two turns: the table with D1, then cards with D2.
    stub.replies.push(
      call('write', { path: screen(designId), content: SCREEN_TABLE }),
      call('RecordDecision', { title: 'Layout', chosen: 'Table', rejected: ['Cards'], source: { kind: 'chat', ref: ASK_TABLE } }),
      { chunks: ['S1 is a table.'] },
    );
    await send(design, ASK_TABLE, 'S1 is a table.');
    stub.replies.push(
      call('write', { path: screen(designId), content: SCREEN_CARDS }),
      call('RecordDecision', { title: 'Contact style', chosen: 'Cards', source: { kind: 'chat', ref: ASK_CARDS } }),
      { chunks: ['S1 shows cards.'] },
    );
    await send(design, ASK_CARDS, 'S1 shows cards.');
    const strip = design.getByTestId('design-decisions');
    await expect(strip.locator('[data-decision-id="D2"]')).toContainText('Cards');
    expect(read(screen(designId))).toBe(SCREEN_CARDS);

    // The dock names what goes back: the conversation, D2 leaving, the design file, and the main chat.
    let dock = await openRewindDock(design, ASK_CARDS);
    await expect(dock.locator('[data-testid="rewind-design-rows"] [data-row]')).toHaveCount(4);
    await expect(dock.locator('[data-row="conversation"] dt')).toHaveText('Conversation');
    await expect(dock.locator('[data-row="conversation"] dd')).toContainText(ASK_CARDS);
    await expect(dock.locator('[data-row="decisions"] dt')).toHaveText('Decisions');
    const leaving = dock.getByTestId('rewind-design-decisions').getByTestId('design-decision-chip');
    await expect(leaving).toHaveCount(1);
    await expect(leaving).toHaveAttribute('data-decision-id', 'D2');
    await expect(leaving).toHaveAttribute('data-leaving', 'true');
    await expect(dock.locator('[data-row="files"] dt')).toHaveText('Design files');
    // RecordDecision rebuilds decisions.md in the same folder, so the count covers more than the screen.
    await expect(dock.locator('[data-row="files"] dd')).toContainText(/\d+ files? affected/u);
    await dock.getByTestId('rewind-files-toggle').click();
    await expect(dock.getByTestId('rewind-file-list')).toContainText('S1-contacts.html');
    // A design file's checkpoint diff opens as a pane tab, read from the design folder rather than the project.
    await dock.getByTitle(/^View checkpoint diff for .*S1-contacts\.html$/u).click();
    const shell = await shellPage(app);
    await expect.poll(async () => (await activeTab(app))?.kind).toBe('diff');
    await expect(diffEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');
    await expect(diffEditor(shell).locator('.editor.original .view-line', { hasText: '<table>' })).toBeVisible();
    await expect(diffEditor(shell).locator('.editor.modified .view-line', { hasText: '<ul>' })).toBeVisible();
    await expect(dock.locator('[data-row="main-chat"] dt')).toHaveText('Main chat');
    await expect(dock.locator('[data-row="main-chat"] dd')).toHaveText('Has no finished version yet');
    await expect(dock.getByTestId('rewind-design-hint')).toHaveText('Design chat checkpoints capture its design folder, not your project.');
    await expect(dock.getByRole('option')).toHaveText([/^1\s*Cancel/, /^2\s*Fork from here/, /^3\s*Rewind/, /^4\s*Files only/]);
    await expectNoAxeViolations(design, '[role="alertdialog"]');

    // Fork from here: a new design named <designId>-f<8 hex>, with the files from before the forked turn and no main chat.
    await dock.getByRole('option', { name: /Fork from here/ }).click();
    const fork = await designChatPage(app, [parent, design]);
    const forkHeader = fork.getByTestId('design-header');
    await expect(forkHeader).toHaveAttribute('data-design-id', new RegExp(`^${designId}-f[0-9a-f]{8}$`), { timeout: 30_000 });
    const forkId = (await forkHeader.getAttribute('data-design-id'))!;
    expect(fs.statSync(path.join(designsDir, forkId)).isDirectory()).toBe(true);
    expect(read(screen(forkId))).toBe(SCREEN_TABLE);
    expect(readLink(designsDir, forkId).parentSessionId).toBeNull();
    await expect(fork.getByTestId('design-header-parent')).toHaveText('No main chat');
    await expect(fork.getByTestId('design-decisions').locator('[data-decision-id="D1"]')).toContainText('Table');
    await expect(fork.getByTestId('design-decisions').locator('[data-decision-id="D2"]')).toHaveCount(0);
    // The original keeps its files and its link.
    expect(read(screen(designId))).toBe(SCREEN_CARDS);
    expect(readLink(designsDir, designId).designSessionId).toBe(firstChatId);

    // Rewind: the same design continues in a new chat, at the earlier screen and without D2.
    await selectChatPage(app, design);
    dock = await openRewindDock(design, ASK_CARDS);
    // The options hold focus once the details arrive, so the keys the footer names work at once.
    await expect(dock.getByRole('option').first()).toBeFocused();
    await design.keyboard.press('3');
    await expect(dock).toContainText('Restore the design files?');
    await dock.getByTestId('confirm-action').click();
    await expect.poll(() => readLink(designsDir, designId).designSessionId, { timeout: 30_000 }).not.toBe(firstChatId);
    const link = readLink(designsDir, designId);
    expect(link.superseded).toContain(firstChatId);
    const current = await chatById(app, link.designSessionId!);
    await expect(current.getByTestId('design-header')).toHaveAttribute('data-design-id', designId);
    await expect(current.getByTestId('design-decisions').locator('[data-decision-id="D1"]')).toContainText('Table');
    await expect(current.getByTestId('design-decisions').locator('[data-decision-id="D2"]')).toHaveCount(0);
    await expect.poll(() => read(screen(designId))).toBe(SCREEN_TABLE);
    await expect.poll(() => read(path.join(designsDir, designId, 'decisions.md'))).not.toContain('Contact style');

    // The old chat is read-only behind the banner, which opens the current chat.
    await selectChatPage(app, design);
    const banner = design.getByTestId('design-superseded');
    await expect(banner).toContainText('This design continues in another chat.');
    await expect(design.getByTestId('composer')).toHaveCount(0);
    await expect(design.getByTestId('user-message-rewind')).toHaveCount(0);
    await expectNoAxeViolations(design, '[data-testid="design-superseded"]');
    await banner.getByRole('button', { name: 'Open the current design chat' }).click();
    await expect.poll(async () => (await shellState(app)).selected.chatId).toBe(link.designSessionId);

    // Undo rewind lives in the new chat, which carries the pre-rewind restore point, and brings the later screen back.
    await setPageSize(current, 900, 6000);
    await current.getByTestId('chat-header-more').click();
    await current.locator('[data-testid="chat-header-more-menu"] [data-action="rewind"]').click();
    const browser = current.getByTestId('rewind-browser');
    await expect(browser.getByTestId('rewind-restore-point')).toHaveCount(1, { timeout: 30_000 });
    await browser.getByTestId('rewind-undo').click();
    await expect.poll(() => read(screen(designId)), { timeout: 30_000 }).toBe(SCREEN_CARDS);

    // The parent's next StartDesign reopens the design in the new chat, never in the superseded one.
    const reopenBrief = 'Add a search field to the contacts list.';
    stub.replies.push(call('StartDesign', { title: 'Contacts list', brief: reopenBrief }), { chunks: ['Adding the search field.'] });
    await selectChatPage(app, parent);
    await chatInput(parent).fill('Add search to the contacts design');
    await chatInput(parent).press('Enter');
    await awaitTurnEnd(parent);
    await expect(current.getByTestId('design-brief-note').filter({ hasText: reopenBrief })).toHaveCount(1, { timeout: 30_000 });
    await expect(current.getByText('Adding the search field.', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(design.getByTestId('design-brief-note').filter({ hasText: reopenBrief })).toHaveCount(0);
    expect(readLink(designsDir, designId).designSessionId).toBe(link.designSessionId);

    // Every scripted reply was used and nothing ran past the script, which would answer with an echo.
    expect(stub.replies).toHaveLength(0);
    await expect(parent.getByText(/^Echo: /)).toHaveCount(0);
    await expect(current.getByText(/^Echo: /)).toHaveCount(0);
  } finally {
    await stub.close();
  }
});
