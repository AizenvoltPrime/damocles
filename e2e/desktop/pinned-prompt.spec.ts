import { activeChat, expect, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { setContentSize } from './support/settings';
import { chatInput } from './support/ui';

const LONG_REPLY = Array.from({ length: 30 }, (_, i) => `Step ${i + 1}: the limiter keys on the client address and the route.\n\n`);

test('the pinned prompt yields while it would cover more than half the message list, and pads the list below it while it shows', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await activeChat(app);
    await expect(chatInput(tab)).toBeVisible();
    // Shrinking works on every OS, where growing past the screen does not, so the sizes hold on any runner.
    await setContentSize(app, 1024, 640);

    // The long reply scrolls the prompt off the top, so the pin is active throughout; the docked prompt shortens the list.
    stub.replies.push(
      { chunks: LONG_REPLY, toolCalls: [{ name: 'bash', arguments: { command: 'echo pinned' } }] },
      { chunks: ['Left it.'] },
    );
    await chatInput(tab).fill('Explain the limiter step by step');
    await chatInput(tab).press('Enter');

    const prompt = tab.getByRole('region', { name: 'Permission request' });
    const pin = tab.getByTestId('pinned-prompt');
    const scrollPadding = (): Promise<string> => tab.locator('.message-container').evaluate((el) => (el as HTMLElement).style.scrollPaddingTop);
    await expect(prompt).toBeVisible();
    await expect(pin).toHaveCount(0);
    await expect(tab.getByTestId('pinned-restore-chip')).toHaveCount(0);
    expect(await scrollPadding()).toBe('');

    await prompt.getByRole('option', { name: 'No', exact: true }).click();
    await expect(prompt).toBeHidden();
    await expect(pin).toBeVisible();
    const { pinHeight, listHeight } = await tab.locator('.message-container').evaluate((list) => ({
      pinHeight: (list.querySelector('[data-testid="pinned-prompt"]') as HTMLElement).offsetHeight,
      listHeight: list.clientHeight,
    }));
    expect(pinHeight * 2).toBeLessThanOrEqual(listHeight);
    await expect.poll(scrollPadding).toBe(`${pinHeight}px`);
  } finally {
    await stub.close();
  }
});
