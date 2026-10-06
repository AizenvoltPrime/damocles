import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { seedStubModel, type HermeticHome } from './support/hermetic';
import { chatRequests, startOpenAIStub } from './support/openai-stub';
import { addProject, chatInput } from './support/ui';

const STOPPED_REPLY = 'Left the build stopped.';

async function openProject(app: ElectronApplication, h: HermeticHome): Promise<Page> {
  const home = await activeChat(app);
  await expect(chatInput(home)).toBeVisible();
  const opened = nextChat(app, [home]);
  await addProject(app, h.project, true);
  const tab = await opened;
  await expect(chatInput(tab)).toBeVisible();
  return tab;
}

test('a shell command the user approves offers Stop and its live output while it runs, and Stop ends it', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await openProject(app, home);
    const prompt = tab.getByRole('region', { name: 'Permission request' });

    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'bash', arguments: { command: 'echo build-started; sleep 120' } }] },
      { chunks: [STOPPED_REPLY] },
    );
    await chatInput(tab).fill('run the build');
    await chatInput(tab).press('Enter');

    const card = tab.getByTestId('tool-card').filter({ hasText: 'sleep 120' });
    const stop = card.getByRole('button', { name: 'Stop, then add an optional note' });
    await expect(prompt).toBeVisible();
    await expect(stop).toHaveCount(0);
    await prompt.getByRole('option', { name: 'Yes', exact: true }).click();
    await expect(prompt).toBeHidden();

    await expect(stop).toBeVisible();
    await expect(card.getByRole('log', { name: 'Live command output' })).toContainText('build-started');
    await stop.click();
    await card.getByRole('button', { name: 'Stop', exact: true }).click();

    await expect(card).toContainText('Stopped');
    await expect(tab.getByText(STOPPED_REPLY)).toBeVisible();
    expect(chatRequests(stub).some((r) => JSON.stringify(r.body).includes('Command cancelled by the user'))).toBe(true);
  } finally {
    await stub.close();
  }
});

test("a subagent's shell command needs approval with no Stop while its prompt is open, and offers Stop once approved", async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await openProject(app, home);
    const prompt = tab.getByRole('region', { name: 'Permission request' });

    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'Agent', arguments: { description: 'Run the build', prompt: 'Run the build.', subagent_type: 'general-purpose' } }] },
      { chunks: [], toolCalls: [{ name: 'bash', arguments: { command: 'echo sub-build-started; sleep 120' } }] },
      { chunks: ['The build was stopped.'] },
      { chunks: [STOPPED_REPLY] },
    );
    await chatInput(tab).fill('have a subagent run the build');
    await chatInput(tab).press('Enter');

    await expect(prompt).toContainText('Run the build wants to run this command:');
    const subagentCard = tab.getByTestId('subagent-card');
    const overlay = tab.getByRole('dialog');
    const card = overlay.getByTestId('tool-card').filter({ hasText: 'sleep 120' });
    const stop = card.getByRole('button', { name: 'Stop, then add an optional note' });
    await subagentCard.click();
    await expect(card).toContainText('Needs approval');
    await expect(stop).toHaveCount(0);

    // The overlay covers the dock, so the prompt is answered with it closed.
    await overlay.getByTestId('overlay-close').click();
    await prompt.getByRole('option', { name: 'Yes', exact: true }).click();
    await expect(prompt).toBeHidden();
    await subagentCard.click();

    await expect(stop).toBeVisible();
    await expect(card).not.toContainText('Needs approval');
    await expect(card.getByRole('log', { name: 'Live command output' })).toContainText('sub-build-started');
    await stop.click();
    await card.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(card).toContainText('Stopped');

    await overlay.getByTestId('overlay-close').click();
    await expect(tab.getByText(STOPPED_REPLY)).toBeVisible();
  } finally {
    await stub.close();
  }
});
