import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeChat, expect, nextChat, selectChatPage, test } from './support/fixtures';
import { overlayPage, pressKeys, PRIMARY, shellPage } from './support/shell';
import { editorTab, quickPick } from './support/editor';
import { seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { agentRequests, startOpenAIStub, type OpenAIStub, type StubReply } from './support/openai-stub';
import { addProject, chatInput, clickMenu } from './support/ui';
import { hideEditorPane } from './support/screenshots';
import { setContentSize } from './support/settings';

// Chat review (plan slice 12, D60): the header counter, the "Changes: {chat title}" tab, line comments and Send to chat.

const review = (shell: Page): Locator => shell.getByTestId('review-tab');
const entry = (shell: Page, file: string): Locator => review(shell).locator(`[data-testid="changes-entry"][data-path="${file}"]`);
const counter = (tab: Page): Locator => tab.getByTestId('chat-header-changes');

const edit = (file: string, from: string, to: string): StubReply => ({ chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: file, old_string: from, new_string: to } }] });

async function openProject(app: ElectronApplication, h: HermeticHome): Promise<Page> {
  const home = await activeChat(app);
  await expect(chatInput(home)).toBeVisible();
  const opened = nextChat(app, [home]);
  // chat review reads the chat's own records, so it works in an untrusted project
  await addProject(app, h.project, false);
  const tab = await opened;
  await expect(chatInput(tab)).toBeVisible();
  return tab;
}

async function send(tab: Page, text: string, done: string): Promise<void> {
  await chatInput(tab).fill(text);
  await chatInput(tab).press('Enter');
  await expect(tab.getByText(done)).toBeVisible();
}

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

function seed(h: HermeticHome): Record<'one' | 'two' | 'three' | 'four', string> {
  fs.mkdirSync(h.project, { recursive: true });
  const files = { one: path.join(h.project, 'one.ts'), two: path.join(h.project, 'two.ts'), three: path.join(h.project, 'three.ts'), four: path.join(h.project, 'four.ts') };
  for (const [name, file] of Object.entries(files)) fs.writeFileSync(file, `export const ${name} = 1;\nexport const keep = true;\n`);
  return files;
}

async function withStub(h: HermeticHome, run: (stub: OpenAIStub) => Promise<void>): Promise<void> {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(h, stub.baseUrl);
    writeUserSettings(h, { 'damocles.dangerouslySkipPermissions': true });
    await run(stub);
  } finally {
    await stub.close();
  }
}

test('the header counts what the chat and its subagent edited, not a shell command\'s file or another chat\'s edit; the tab lists them, says shell changes are not listed, and Last turn shows the latest turn', async ({ foreground: _foreground, home, launch }) => {
  const files = seed(home);
  await withStub(home, async (stub) => {
    stub.replies.push(
      edit(files.one, 'one = 1', 'one = 2'),
      edit(files.two, 'two = 1', 'two = 2'),
      { chunks: [], toolCalls: [{ name: 'Agent', arguments: { description: 'Edit three', prompt: 'Raise three.', subagent_type: 'general-purpose' } }] },
      edit(files.three, 'three = 1', 'three = 2'),
      { chunks: ['Subagent done'] },
      { chunks: [], toolCalls: [{ name: 'bash', arguments: { command: 'node -e "require(\'fs\').writeFileSync(\'shell.txt\', \'made by a shell\\n\')"' } }] },
      { chunks: ['First turn done'] },
      // another chat edits four.ts
      edit(files.four, 'four = 1', 'four = 2'),
      { chunks: ['Other chat done'] },
      // the first chat's second turn edits two.ts again
      edit(files.two, 'two = 2', 'two = 3'),
      { chunks: ['Second turn done'] },
    );
    const { app } = await launch();
    const tab = await openProject(app, home);
    await send(tab, 'edit three files', 'First turn done');
    await expect.poll(() => fs.existsSync(path.join(home.project, 'shell.txt'))).toBe(true);
    // Below 560px the counter folds into the header's More menu.
    await expect(tab.getByTestId('chat-header')).toHaveAttribute('data-width', 'narrow');
    await tab.getByTestId('chat-header-more').click();
    await expect(tab.getByTestId('chat-header-more-menu').locator('[data-action="reviewChanges"]')).toContainText('+3 −3');
    await tab.keyboard.press('Escape');
    await hideEditorPane(app, tab);
    await expect(counter(tab)).toBeVisible();
    await expect(tab.getByTestId('chat-header-changes-added')).toHaveText('3');
    await expect(tab.getByTestId('chat-header-changes-removed')).toHaveText('3');

    // A second chat's edit of four.ts is that chat's, not this one's.
    const shell = await shellPage(app);
    const second = nextChat(app, [tab]);
    await clickMenu(app, 'damocles.newChat');
    const other = await second;
    await send(other, 'edit four', 'Other chat done');
    await selectChatPage(app, tab);
    await expect(counter(tab)).toBeVisible();

    await counter(tab).click();
    await expect(review(shell)).toBeVisible();
    await expect(editorTab(shell, 'Changes:')).toHaveAttribute('aria-selected', 'true');
    await expect(review(shell).getByTestId('changes-entry')).toHaveCount(3);
    for (const file of ['one.ts', 'two.ts', 'three.ts']) await expect(entry(shell, file)).toBeVisible();
    await expect(review(shell).getByTestId('review-shell-note')).toHaveText('Changes made by shell commands are not listed');

    // Last turn lists only what the latest turn changed.
    await send(tab, 'edit two again', 'Second turn done');
    await review(shell).getByTestId('review-scope-turn').click();
    await expect(review(shell).getByTestId('changes-entry')).toHaveCount(1);
    await expect(entry(shell, 'two.ts')).toBeVisible();
    await review(shell).getByTestId('review-scope-chat').click();
    await expect(review(shell).getByTestId('changes-entry')).toHaveCount(3);
  });
});

test('a review sent while the chat runs is queued, reaches the chat once the turn ends, and leaves the bar', async ({ foreground: _foreground, home, launch }) => {
  const files = seed(home);
  await withStub(home, async (stub) => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    stub.replies.push(
      edit(files.one, 'one = 1', 'one = 2'),
      { chunks: ['Edits done'] },
      { chunks: ['Still ', 'working on it'], holdAfterFirst: hold },
      { chunks: ['Review received'] },
    );
    const { app } = await launch();
    const tab = await openProject(app, home);
    await send(tab, 'edit one', 'Edits done');
    await hideEditorPane(app, tab);
    await counter(tab).click();
    const shell = await shellPage(app);
    await expect(review(shell)).toBeVisible();

    // the chat starts a turn that holds its reply open
    await chatInput(tab).fill('keep going');
    await chatInput(tab).press('Enter');
    await expect(tab.getByText('Still')).toBeVisible();

    await entry(shell, 'one.ts').click();
    await expect(review(shell).locator('[data-testid="changes-diff"][data-path="one.ts"]')).toBeVisible();
    await review(shell).locator('[data-testid="changes-line"][data-type="addition"]').first().getByTestId('review-line-number').click();
    await review(shell).getByTestId('review-comment-input').fill('Why two?');
    await review(shell).getByTestId('review-comment-input').press('Enter');
    const before = agentRequests(stub).length;
    await review(shell).getByTestId('review-send').click();
    await expect(review(shell).getByTestId('review-bar')).toHaveCount(0);
    expect(agentRequests(stub).length).toBe(before);

    release();
    await expect(tab.getByText('Review received')).toBeVisible();
    const sent = JSON.stringify(agentRequests(stub).slice(before).map((request) => request.body));
    expect(sent).toContain('one.ts:1');
    expect(sent).toContain('Why two?');
  });
});

test('two comments sent with Ctrl+Enter reach the chat as one message with both path:line entries; an outside edit is marked and a file put back by hand drops out; Chat: Review Changes opens the tab', async ({ foreground: _foreground, home, launch }) => {
  const files = seed(home);
  await withStub(home, async (stub) => {
    stub.replies.push(
      edit(files.one, 'one = 1', 'one = 2'),
      edit(files.two, 'two = 1', 'two = 2'),
      edit(files.three, 'three = 1', 'three = 2'),
      { chunks: ['Edits done'] },
      { chunks: ['Thanks for the review'] },
    );
    const { app } = await launch();
    const tab = await openProject(app, home);
    await send(tab, 'edit three files', 'Edits done');
    await hideEditorPane(app, tab);
    await expect(counter(tab)).toBeVisible();

    const shell = await shellPage(app);
    await runCommand(app, 'Review Changes', 'damocles.chat.reviewChanges');
    await expect(review(shell)).toBeVisible();

    // A file the user changed after the chat is marked; one put back to its baseline drops out.
    fs.writeFileSync(files.one, 'export const one = 2;\nexport const keep = false;\n');
    fs.writeFileSync(files.three, 'export const three = 1;\nexport const keep = true;\n');
    await expect(entry(shell, 'three.ts')).toHaveCount(0);
    await expect(entry(shell, 'one.ts').getByTestId('changes-entry-note')).toBeVisible();

    // A comment from a line number click, then one from the keyboard on a focused line.
    await entry(shell, 'two.ts').click();
    await expect(review(shell).locator('[data-testid="changes-diff"][data-path="two.ts"]')).toBeVisible();
    await review(shell).locator('[data-testid="changes-line"][data-type="addition"]').first().getByTestId('review-line-number').click();
    await review(shell).getByTestId('review-comment-input').fill('Why two?');
    await review(shell).getByTestId('review-comment-input').press('Enter');
    await expect(review(shell).getByTestId('review-comment')).toHaveCount(1);
    await expect(review(shell).getByTestId('review-bar')).toContainText('1 comment ready');

    await entry(shell, 'one.ts').click();
    await expect(review(shell).locator('[data-testid="changes-diff"][data-path="one.ts"]')).toBeVisible();
    await review(shell).locator('[data-testid="changes-line"][data-type="deletion"]').first().click({ position: { x: 150, y: 4 } });
    await shell.keyboard.press('Enter');
    await review(shell).getByTestId('review-comment-input').fill('Keep the old one');
    await shell.keyboard.press('Enter');
    await expect(review(shell).getByTestId('review-bar')).toContainText('2 comments ready');
    await expect(entry(shell, 'one.ts').getByTestId('changes-entry-comments')).toContainText('1');

    // Escape cancels an open box without a comment.
    await review(shell).locator('[data-testid="changes-line"][data-type="addition"]').first().click({ position: { x: 150, y: 4 } });
    await shell.keyboard.press('Enter');
    await expect(review(shell).getByTestId('review-comment-input')).toBeVisible();
    await shell.keyboard.press('Escape');
    await expect(review(shell).getByTestId('review-comment-input')).toHaveCount(0);

    const before = agentRequests(stub).length;
    await shell.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Enter`);
    await expect(review(shell).getByTestId('review-bar')).toHaveCount(0);
    await expect(tab.getByText('Thanks for the review')).toBeVisible();
    const sent = JSON.stringify(agentRequests(stub).slice(before).map((request) => request.body));
    expect(sent).toContain('two.ts:1');
    expect(sent).toMatch(/one\.ts:1 \(removed\)/);
    expect(sent).toContain('Why two?');
    expect(sent).toContain('Keep the old one');
  });
});

test('at the largest font in the narrowest window the files list stacks above the diff, keeps the keyboard, and the review bar stacks its buttons at one width', async ({ foreground: _foreground, home, launch }) => {
  const files = seed(home);
  await withStub(home, async (stub) => {
    stub.replies.push(edit(files.one, 'one = 1', 'one = 2'), edit(files.two, 'two = 1', 'two = 2'), { chunks: ['Done both'] });
    const { app } = await launch();
    const tab = await openProject(app, home);
    await send(tab, 'edit two files', 'Done both');
    await hideEditorPane(app, tab);
    await counter(tab).click();
    const shell = await shellPage(app);
    await expect(review(shell)).toBeVisible();
    await entry(shell, 'one.ts').click();
    await review(shell).locator('[data-testid="changes-line"][data-type="addition"]').first().getByTestId('review-line-number').click();
    await review(shell).getByTestId('review-comment-input').fill('Why two?');
    await review(shell).getByTestId('review-comment-input').press('Enter');
    await expect(review(shell).getByTestId('review-comment')).toHaveCount(1);
    await setContentSize(app, 900, 660);
    await shell.evaluate(() => document.documentElement.style.setProperty('--d-font-size', '20px'));

    const layout = () => shell.evaluate(() => {
      const box = (testId: string): DOMRect => document.querySelector(`[data-testid="review-tab"] [data-testid="${testId}"]`)!.getBoundingClientRect();
      const list = box('changes-list');
      const diff = box('changes-diff');
      const where = document.querySelector('[data-testid="review-comment"] .truncate')!;
      const discard = box('review-discard');
      const sendButton = box('review-send');
      return {
        listAbove: list.bottom <= diff.top,
        listFullWidth: Math.abs(list.width - box('changes-tab').width) <= 1,
        commentHeaderWhole: where.scrollWidth <= where.clientWidth,
        sendBelowDiscard: sendButton.top >= discard.bottom,
        sameWidth: Math.abs(sendButton.width - discard.width) <= 1 && Math.abs(sendButton.left - discard.left) <= 1,
      };
    });
    await expect.poll(layout).toEqual({ listAbove: true, listFullWidth: true, commentHeaderWhole: true, sendBelowDiscard: true, sameWidth: true });

    // The stacked list is the same listbox: arrows move the selection and the diff follows.
    await entry(shell, 'one.ts').focus();
    await shell.keyboard.press('ArrowDown');
    await expect(entry(shell, 'two.ts')).toHaveAttribute('aria-selected', 'true');
    await expect(entry(shell, 'two.ts')).toBeFocused();
    await expect(review(shell).locator('[data-testid="changes-diff"][data-path="two.ts"]')).toBeVisible();
  });
});

test('at a larger font in the narrowest window the Changes tab moves its scope toggle under the lead, so both read whole inside the pane', async ({ foreground: _foreground, home, launch }) => {
  const files = seed(home);
  await withStub(home, async (stub) => {
    stub.replies.push(edit(files.one, 'one = 1', 'one = 2'), { chunks: ['Done one'] });
    const { app } = await launch();
    const tab = await openProject(app, home);
    await send(tab, 'edit one', 'Done one');
    await hideEditorPane(app, tab);
    await counter(tab).click();
    const shell = await shellPage(app);
    await expect(review(shell)).toBeVisible();
    const row = () => shell.evaluate(() => {
      const box = (testId: string): DOMRect => document.querySelector(`[data-testid="${testId}"]`)!.getBoundingClientRect();
      const lead = document.querySelector('[data-testid="changes-lead"] > span')!;
      const toggle = document.querySelector('[data-testid="review-scope-chat"]')!.parentElement!.getBoundingClientRect();
      return {
        leadWhole: lead.scrollWidth <= lead.clientWidth,
        toggleBelow: toggle.top >= box('changes-heading').bottom - 1,
        toggleInside: toggle.right <= box('editor-pane').right,
      };
    });
    await expect.poll(row).toEqual({ leadWhole: true, toggleBelow: false, toggleInside: true });
    // The minimum window at a 16px font: the editor column is about 15.8rem, below the row's 28rem wrap.
    await setContentSize(app, 900, 660);
    await shell.evaluate(() => document.documentElement.style.setProperty('--d-font-size', '16px'));
    await expect.poll(row).toEqual({ leadWhole: true, toggleBelow: true, toggleInside: true });
  });
});
