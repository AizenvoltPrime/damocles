import { activeChat, expect, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { chatRequests, startOpenAIStub } from './support/openai-stub';
import { chatInput } from './support/ui';

test('a message streams a reply from pi in main against the stub', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    stub.replies.push({ chunks: ['First streamed words', ' and the rest arrives later.'], holdAfterFirst: held });

    const { app } = await launch();
    const tab = await activeChat(app);
    await chatInput(tab).fill('Say something in two parts');
    await chatInput(tab).press('Enter');

    // The first chunk renders while the stub is still holding the stream open.
    await expect(tab.getByText('First streamed words', { exact: false })).toBeVisible();
    await expect(tab.getByText('the rest arrives later', { exact: false })).toHaveCount(0);
    release();
    await expect(tab.getByText('First streamed words and the rest arrives later.')).toBeVisible();

    const [request] = chatRequests(stub);
    const body = request!.body as { model: string; stream: boolean; messages: { role: string; content: unknown }[] };
    expect(body.model).toBe('gpt-6-luna');
    expect(body.stream).toBe(true);
    expect(JSON.stringify(body.messages)).toContain('Say something in two parts');
  } finally {
    await stub.close();
  }
});
