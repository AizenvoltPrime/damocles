import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { git } from './support/git';
import type { HermeticHome } from './support/hermetic';
import { chatRequests, isSubCall } from './support/openai-stub';
import { readyOverlay } from './support/overlay';
import { openProjectChat } from './support/screenshots';
import { chatInput } from './support/ui';
import { worktreeRepo, type RegistryRecord } from './support/worktree-repo';
import { edit, liveRecords, withStub } from './support/worktree-chat';
import { chatRowFrames, largestLogo, recordChatRow } from './support/chat-row-frames';
import { shellPage } from './support/shell';
import { setContentSize } from './support/settings';

// Hand off (plan slice 12a, D61): moving an idle chat between the project folder and its worktree, the file move in each
// direction, the refusal, the reused worktree, the rewind boundary, and D62's Blocked card in the worktree.

const handOffButton = (tab: Page): Locator => tab.getByTestId('chat-header-hand-off');
// The app's default window (DEFAULT_WINDOW_WIDTH x DEFAULT_WINDOW_HEIGHT), whatever the screen: Hand off stays a header button
// only while the chat is at least 25rem wide (ChatHeader's HAND_OFF_REM), which a 1024px window leaves no room for.
const DEFAULT_WINDOW = [1280, 820] as const;
const dialog = (overlay: Page, name: string): Locator => overlay.locator(`[data-dialog="${name}"] [data-testid="worktree-dialog"]`);

async function send(tab: Page, text: string, done: string): Promise<void> {
  await chatInput(tab).fill(text);
  await chatInput(tab).press('Enter');
  await expect(tab.getByText(done)).toBeVisible({ timeout: 60_000 });
}

async function openHandOff(tab: Page): Promise<void> {
  await handOffButton(tab).click();
  await expect(tab.getByTestId('hand-off-menu')).toBeVisible();
  await expect(tab.getByTestId('hand-off-disabled-reason')).toHaveCount(0);
}

const read = (dir: string, file: string): string => fs.readFileSync(path.join(dir, file), 'utf8');

const YOLO = { 'damocles.dangerouslySkipPermissions': true };

/** Moves the chat to its worktree through the header menu, confirming the files listed; returns the worktree's record. */
async function moveToWorktree(app: ElectronApplication, h: HermeticHome, tab: Page, listed: readonly string[]): Promise<RegistryRecord> {
  await openHandOff(tab);
  await expect(tab.getByTestId('hand-off-current')).toContainText('Project folder');
  await tab.getByTestId('hand-off-move').click();
  const overlay = await readyOverlay(app);
  const confirm = dialog(overlay, 'handOffConfirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('Move this chat to a worktree?');
  await expect(confirm.getByTestId('worktree-dialog-file')).toHaveCount(listed.length);
  for (const file of listed) await expect(confirm).toContainText(file);
  await confirm.getByTestId('worktree-dialog-move').click();
  await expect(tab.getByTestId('chat-header-worktree')).toBeVisible({ timeout: 60_000 });
  const [record] = liveRecords(h);
  return record!;
}

test('Move to a worktree moves the chat\'s two files, leaves the user\'s third, and the conversation continues there; rewinding before it restores the conversation only', async ({ home, launch }) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'), { files: { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n', 'c.ts': 'export const c = 1;\n' } });
  await withStub(home, YOLO, async (stub) => {
    const { app } = await launch();
    const tab = await openProjectChat(app, repo.project);
    await setContentSize(app, ...DEFAULT_WINDOW);
    await expect(handOffButton(tab)).toBeVisible();
    stub.replies.push(edit(path.join(repo.project, 'a.ts'), 'a = 1', 'a = 2'), edit(path.join(repo.project, 'b.ts'), 'b = 1', 'b = 2'), { chunks: ['Edited a and b'] });
    await send(tab, 'Raise a and b', 'Edited a and b');
    fs.writeFileSync(path.join(repo.project, 'c.ts'), 'export const c = 3;\n');

    // The row's time and model line swaps for the branch; its logo keeps its own size through the swap.
    const shell = await shellPage(app);
    await expect(shell.locator('[data-testid="chat-list"] [aria-selected="true"]').getByTestId('provider-logo')).toBeVisible();
    await recordChatRow(shell, 'selected');
    const record = await moveToWorktree(app, home, tab, ['a.ts', 'b.ts']);
    await expect(shell.locator('[data-testid="chat-list"] [aria-selected="true"]')).toHaveAttribute('data-worktree', 'live');
    const moving = await chatRowFrames(shell);
    expect(largestLogo(moving)).toBeGreaterThan(0);
    expect(largestLogo(moving)).toBeLessThanOrEqual(12);
    expect(read(record.workingFolder, 'a.ts')).toBe('export const a = 2;\n');
    expect(read(record.workingFolder, 'b.ts')).toBe('export const b = 2;\n');
    expect(read(repo.project, 'a.ts')).toBe('export const a = 1;\n');
    expect(read(repo.project, 'b.ts')).toBe('export const b = 1;\n');
    expect(read(repo.project, 'c.ts')).toBe('export const c = 3;\n');
    expect(await git(home, repo.project, 'status', '--porcelain')).toBe('M c.ts');
    await expect(tab.getByTestId('chat-header-worktree')).toContainText(record.branch!);

    // The conversation continues in the worktree: the model hears the new folder, and its next Edit lands there.
    const before = chatRequests(stub).length;
    stub.replies.push(edit(path.join(record.workingFolder, 'a.ts'), 'a = 2', 'a = 4'), { chunks: ['Raised a again'] });
    await send(tab, 'Raise a again', 'Raised a again');
    // the agent's request (not a background sub-call such as memory extraction) carries the working-folder note's own words,
    // which the system prompt's "Primary working directory" never says
    const note = JSON.stringify(`This chat now works in ${record.workingFolder}. Read and edit files there from now on.`).slice(1, -1);
    const turns = chatRequests(stub).slice(before).filter((request) => !isSubCall(request)).map((request) => JSON.stringify(request.body)).filter((body) => body.includes('Raise a again'));
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.every((body) => body.includes(note))).toBe(true);
    // the note rides with the next prompt and starts no turn of its own
    expect(chatRequests(stub).slice(0, before).map((request) => JSON.stringify(request.body)).some((body) => body.includes(note))).toBe(false);
    expect(read(record.workingFolder, 'a.ts')).toBe('export const a = 4;\n');
    expect(read(repo.project, 'a.ts')).toBe('export const a = 1;\n');

    // The first turn was before the hand-off: its rewind restores the conversation only and says so.
    await tab.getByTestId('chat-header-more').click();
    await tab.locator('[data-testid="chat-header-more-menu"] [data-action="rewind"]').click();
    const browser = tab.getByTestId('rewind-browser');
    await expect(browser).toBeVisible();
    await expect(browser.getByTestId('rewind-row-hand-off')).toHaveCount(1);
    await browser.getByTestId('rewind-search').fill('Raise a and b');
    await expect(browser.getByTestId('rewind-hand-off-note')).toHaveText('Files from before the hand-off are in the other folder. Rewind restores the conversation only.');
  });
});

test('Hand off waits for an idle chat; Move to project folder copies back, refuses a file with local edits, and a later move reuses the worktree', async ({ home, launch }) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'), { files: { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' } });
  await withStub(home, YOLO, async (stub) => {
    const { app } = await launch();
    const tab = await openProjectChat(app, repo.project);
    await setContentSize(app, ...DEFAULT_WINDOW);
    stub.replies.push(edit(path.join(repo.project, 'a.ts'), 'a = 1', 'a = 2'), { chunks: ['Edited a'] });
    await send(tab, 'Raise a', 'Edited a');
    const record = await moveToWorktree(app, home, tab, ['a.ts']);

    // Running: Hand off still opens, and its move is disabled with its reason until the turn ends.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    stub.replies.push(edit(path.join(record.workingFolder, 'b.ts'), 'b = 1', 'b = 2'), { chunks: ['Working', ' and done'], holdAfterFirst: held });
    await chatInput(tab).fill('Raise b in the worktree');
    await chatInput(tab).press('Enter');
    await expect(tab.getByTestId('chat-header-hand-off-wrap')).toHaveAttribute('title', 'Hand off is available while the chat is idle', { timeout: 30_000 });
    await handOffButton(tab).click();
    await expect(tab.getByTestId('hand-off-move')).toHaveAttribute('aria-disabled', 'true');
    await expect(tab.getByTestId('hand-off-disabled-reason')).toHaveText('Hand off is available while the chat is idle');
    await tab.getByTestId('hand-off-menu').press('Escape');
    await expect(tab.getByTestId('hand-off-menu')).toHaveCount(0);
    release();
    await expect(tab.getByText('Working and done')).toBeVisible({ timeout: 60_000 });
    await expect(tab.getByTestId('chat-header-hand-off-wrap')).toHaveAttribute('title', 'Hand off: move where this chat works');

    // A local edit to b.ts in the project folder refuses the move back, naming the file.
    fs.writeFileSync(path.join(repo.project, 'b.ts'), 'export const b = 9;\n');
    await openHandOff(tab);
    await expect(tab.getByTestId('hand-off-current')).toContainText(`Worktree ${record.branch}`);
    await tab.getByTestId('hand-off-move').click();
    const overlay = await readyOverlay(app);
    const refusal = dialog(overlay, 'refusal');
    await expect(refusal).toBeVisible({ timeout: 30_000 });
    await expect(refusal).toContainText("Can't move this chat to the project folder");
    await expect(refusal.getByTestId('worktree-dialog-files')).toContainText('b.ts');
    await refusal.getByTestId('worktree-dialog-ok').click();
    await expect(tab.getByTestId('chat-header-worktree')).toContainText(record.branch!);

    // Without the clash it copies the changes back and the chat works in the project folder again.
    await git(home, repo.project, 'checkout', '--', 'b.ts');
    await openHandOff(tab);
    await tab.getByTestId('hand-off-move').click();
    const back = dialog(overlay, 'handOffConfirm');
    await expect(back).toContainText('Move this chat to the project folder?');
    await back.getByTestId('worktree-dialog-move').click();
    await expect(tab.getByTestId('chat-header-worktree')).toHaveCount(0, { timeout: 60_000 });
    expect(read(repo.project, 'a.ts')).toBe('export const a = 2;\n');
    expect(read(repo.project, 'b.ts')).toBe('export const b = 2;\n');

    // A second move to a worktree reuses the same one.
    await moveToWorktree(app, home, tab, ['a.ts', 'b.ts']);
    expect(liveRecords(home).map((each) => each.id)).toEqual([record.id]);
  });
});

test('in a worktree chat, an Edit aimed at the project folder is Blocked with the policy reason, even in YOLO mode', async ({ home, launch }) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'));
  await withStub(home, YOLO, async (stub) => {
    const { app } = await launch();
    const tab = await openProjectChat(app, repo.project);
    await setContentSize(app, ...DEFAULT_WINDOW);
    stub.replies.push(edit(path.join(repo.project, 'a.ts'), 'a = 1', 'a = 2'), { chunks: ['Edited a'] });
    await send(tab, 'Raise a', 'Edited a');
    await moveToWorktree(app, home, tab, ['a.ts']);
    stub.replies.push(edit(path.join(repo.project, 'a.ts'), 'a = 1', 'a = 5'), { chunks: ['Tried the project folder'] });
    await send(tab, 'Edit the project folder copy', 'Tried the project folder');
    await expect(tab.getByTestId('tool-card-blocked')).toHaveText('Blocked');
    await expect(tab.getByTestId('tool-card-blocked-reason')).toContainText('worktree');
    expect(read(repo.project, 'a.ts')).toBe('export const a = 1;\n');
  });
});
