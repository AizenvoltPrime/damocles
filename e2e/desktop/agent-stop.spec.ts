import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { chatRequests, startOpenAIStub, type StubReply } from './support/openai-stub';
import { addProject, chatInput } from './support/ui';

const MAIN_GOES_ON = 'The main agent carries on with the partial work.';

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

/** A reply that streams its first chunk and then never finishes, so the agent it answers keeps working until stopped. */
function working(): StubReply {
  return { chunks: ['Working on it'], holdAfterFirst: new Promise<void>(() => {}) };
}

test('Stop on a running subagent card ends only that subagent, and the main agent goes on with its partial work', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await openProject(app, home);

    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'Agent', arguments: { description: 'Survey the repo', prompt: 'Look around the repository.', subagent_type: 'general-purpose' } }] },
      working(),
      { chunks: [MAIN_GOES_ON] },
    );
    await send(tab, 'start a subagent');

    const card = tab.getByTestId('subagent-card');
    const stop = card.getByTestId('subagent-card-stop');
    await expect(stop).toBeVisible();
    await expect(stop).toHaveAccessibleName('Stop subagent Survey the repo');
    await stop.click();

    await expect(card.getByTestId('subagent-status')).toHaveText('Stopped');
    await expect(stop).toBeHidden();
    await expect(tab.getByText(MAIN_GOES_ON)).toBeVisible();
    // The main agent's next request carries the Agent result with the partial output and the stop note.
    expect(chatRequests(stub).some((r) => JSON.stringify(r.body).includes('STOPPED BY THE USER before completion'))).toBe(true);
  } finally {
    await stub.close();
  }
});

test('Stop team asks first, then ends only the team, and the main agent goes on with the partial results', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    writeUserSettings(home, { 'damocles.team.enabled': true });
    const { app } = await launch();
    const tab = await openProject(app, home);

    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'create_team', arguments: { title: 'Lockout', brief: 'Lock an account after ten failed logins.', agents: [{ name: 'Atlas', role: 'lead' }, { name: 'Mira', role: 'specialist' }] } }] },
      working(),
      { chunks: [MAIN_GOES_ON] },
    );
    await send(tab, 'start a team');

    const card = tab.getByTestId('team-card');
    const stop = card.getByTestId('team-card-stop');
    await expect(stop).toBeVisible();
    await stop.click();
    const confirm = tab.getByTestId('stop-team-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('Stop the team?');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    await expect(stop).toBeFocused();

    await stop.click();
    await confirm.getByRole('button', { name: 'Stop team' }).click();
    // The Stop is busy or gone by now, so focus returns to the transcript around it rather than to the page.
    await expect.poll(() => tab.evaluate(() => document.activeElement?.hasAttribute('data-overlay-return-focus') ?? false)).toBe(true);

    await expect(card.getByTestId('team-status')).toHaveText('Stopped');
    await expect(tab.getByText(MAIN_GOES_ON)).toBeVisible();
    expect(chatRequests(stub).some((r) => JSON.stringify(r.body).includes('TEAM STOPPED BY THE USER before completion'))).toBe(true);
  } finally {
    await stub.close();
  }
});
