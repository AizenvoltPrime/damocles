import type { Locator, Page } from '@playwright/test';
import { activeChat, expect, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { startOpenAIStub, type OpenAIStub } from './support/openai-stub';
import { chatInput } from './support/ui';

/**
 * A streaming view stays on its newest line, stops for a reader who scrolls up by wheel or keyboard,
 * and follows again from the jump button or the reader's own next message (docs/invariants.md#streaming-views). Each reply streams a screenful, holds, then
 * streams another, so the hold is where the reader acts and the release is the growth that must or
 * must not move the view.
 */

const paragraphs = (from: number, count: number): string =>
  Array.from({ length: count }, (_, i) => `Line ${from + i} of the streamed reply.`).join('\n\n');

function heldReply(stub: OpenAIStub, from: number): () => void {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  stub.replies.push({ chunks: [paragraphs(from, 60), `\n\n${paragraphs(from + 60, 60)}`], holdAfterFirst: held });
  return release;
}

const gapBelow = (view: Locator): Promise<number> => view.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
const scrollTopOf = (view: Locator): Promise<number> => view.evaluate((el) => el.scrollTop);
const scrollHeightOf = (view: Locator): Promise<number> => view.evaluate((el) => el.scrollHeight);

async function wheelUp(tab: Page, view: Locator): Promise<number> {
  const before = await scrollTopOf(view);
  const box = await view.boundingBox();
  if (!box) throw new Error('the view has no box');
  await tab.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await tab.mouse.wheel(0, -600);
  await expect.poll(() => scrollTopOf(view)).toBeLessThan(before - 300);
  // Let a smooth scroll settle, then read where the reader stopped.
  await tab.waitForTimeout(300);
  return scrollTopOf(view);
}

async function pageUp(view: Locator): Promise<number> {
  const before = await scrollTopOf(view);
  await view.press('PageUp');
  await expect.poll(() => scrollTopOf(view)).toBeLessThan(before - 100);
  await view.page().waitForTimeout(300);
  return scrollTopOf(view);
}

/** Streams the rest of a held reply and proves the reader's view did not move while it grew. */
async function releaseAndHold(view: Locator, release: () => void, readerTop: number, lastLine: Locator): Promise<void> {
  const heightBefore = await scrollHeightOf(view);
  release();
  await expect(lastLine).toBeAttached();
  await expect.poll(() => scrollHeightOf(view)).toBeGreaterThan(heightBefore + 1000);
  expect(Math.abs((await scrollTopOf(view)) - readerTop)).toBeLessThanOrEqual(1);
}

test('the transcript and the side-question overlay follow their output until the reader scrolls up', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await activeChat(app);
    const transcript = tab.locator('.message-container');
    const transcriptJump = tab.locator('[data-testid="scroll-to-bottom"]').first();

    // A reply that outgrows the view keeps its newest line in view, before and after the hold.
    const releaseFirst = heldReply(stub, 1);
    await chatInput(tab).fill('Write a long answer');
    await chatInput(tab).press('Enter');
    await expect(tab.getByText('Line 60 of the streamed reply.')).toBeInViewport();
    releaseFirst();
    await expect(tab.getByText('Line 120 of the streamed reply.')).toBeInViewport();
    await expect.poll(() => gapBelow(transcript)).toBeLessThanOrEqual(2);
    await expect(transcriptJump).toBeHidden();

    // A reader who scrolls up inside the reply that is still streaming stays where they stopped.
    const releaseSecond = heldReply(stub, 201);
    await chatInput(tab).fill('Write another long answer');
    await chatInput(tab).press('Enter');
    await expect(tab.getByText('Line 260 of the streamed reply.')).toBeInViewport();
    const readerTop = await wheelUp(tab, transcript);
    await expect(transcriptJump).toBeVisible();
    await releaseAndHold(transcript, releaseSecond, readerTop, tab.getByText('Line 320 of the streamed reply.'));

    // The reader's own next message follows again from where they had scrolled.
    const releaseThird = heldReply(stub, 601);
    await chatInput(tab).fill('And one more');
    await chatInput(tab).press('Enter');
    await expect(tab.getByText('Line 660 of the streamed reply.')).toBeInViewport();
    await expect.poll(() => gapBelow(transcript)).toBeLessThanOrEqual(2);
    await expect(transcriptJump).toBeHidden();

    // Page Up with focus in the transcript stops following as the wheel does.
    const keyboardTop = await pageUp(transcript);
    await expect(transcriptJump).toBeVisible();
    await releaseAndHold(transcript, releaseThird, keyboardTop, tab.getByText('Line 720 of the streamed reply.'));

    // The button unmounts once the view follows, and focus lands in the view rather than on the body.
    await transcriptJump.click();
    await expect.poll(() => gapBelow(transcript)).toBeLessThanOrEqual(2);
    await expect(transcriptJump).toBeHidden();
    await expect(transcript).toBeFocused();

    // The side-question overlay follows the same rule inside its own body.
    const releaseAside = heldReply(stub, 401);
    await chatInput(tab).fill('/btw what changed?');
    await chatInput(tab).press('Enter');
    const dialog = tab.getByRole('dialog');
    const body = dialog.locator('.o-panel > .overflow-y-auto');
    const asideJump = dialog.getByTestId('scroll-to-bottom');
    await expect(dialog.getByText('Line 460 of the streamed reply.')).toBeInViewport();
    await expect.poll(() => gapBelow(body)).toBeLessThanOrEqual(2);
    await expect(asideJump).toBeHidden();

    const asideTop = await wheelUp(tab, body);
    await expect(asideJump).toBeVisible();
    await releaseAndHold(body, releaseAside, asideTop, dialog.getByText('Line 520 of the streamed reply.'));

    await asideJump.click();
    await expect.poll(() => gapBelow(body)).toBeLessThanOrEqual(2);
    await expect(asideJump).toBeHidden();
    await expect(body).toBeFocused();
  } finally {
    await stub.close();
  }
});
