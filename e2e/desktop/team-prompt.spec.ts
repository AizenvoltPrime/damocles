import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { chatRequests, startOpenAIStub } from './support/openai-stub';
import { addProject, chatInput } from './support/ui';

const COMMAND = 'echo team-lead-check';

async function openProject(app: ElectronApplication, h: HermeticHome): Promise<Page> {
  const home = await activeChat(app);
  await expect(chatInput(home)).toBeVisible();
  const opened = nextChat(app, [home]);
  await addProject(app, h.project, true);
  const tab = await opened;
  await expect(chatInput(tab)).toBeVisible();
  return tab;
}

/**
 * The inputs of every tool call the chat's transcript holds, read from the page's store: a message that draws its
 * content blocks keeps a call it has no block for without drawing it, so the page alone cannot show that call.
 */
async function transcriptToolInputs(tab: Page): Promise<string[]> {
  return tab.evaluate(() => {
    type Messages = { messages: { toolCalls?: { input: unknown }[] }[] };
    type Host = Element & { __vue_app__?: { config: { globalProperties: { $pinia: { state: { value: { streaming: Messages } } } } } } };
    const app = (document.querySelector('#app') as Host | null)?.__vue_app__;
    if (!app) throw new Error('no Vue app on the chat page');
    return app.config.globalProperties.$pinia.state.value.streaming.messages.flatMap((m) => (m.toolCalls ?? []).map((t) => JSON.stringify(t.input)));
  });
}

test("a team agent's approval prompt names the agent and its team, marks that agent as waiting on the user, and adds no card to the chat's transcript", async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    writeUserSettings(home, { 'damocles.team.enabled': true });
    const { app } = await launch();
    const tab = await openProject(app, home);
    const prompt = tab.getByRole('region', { name: 'Permission request' });
    const strayCard = tab.getByTestId('tool-card').filter({ hasText: COMMAND });
    const transcriptHoldsCommand = async () => (await transcriptToolInputs(tab)).some((input) => input.includes(COMMAND));

    // The main agent creates the team, then the lead's first reply runs a shell command, which default mode asks about.
    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'create_team', arguments: { title: 'Lockout', brief: 'Lock an account after ten failed logins.', agents: [{ name: 'Atlas', role: 'lead' }, { name: 'Mira', role: 'specialist' }] } }] },
      { chunks: [], toolCalls: [{ name: 'bash', arguments: { command: COMMAND } }] },
      { chunks: ['Waiting on the team'], holdAfterFirst: new Promise<void>(() => {}) },
    );
    await chatInput(tab).fill('start a team');
    await chatInput(tab).press('Enter');

    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText('Atlas from team Lockout wants to run this command:');
    await expect(prompt).toContainText(COMMAND);
    await expect(strayCard).toHaveCount(0);
    expect(await transcriptHoldsCommand()).toBe(false);

    // A shell command is not an edit, so the prompt offers no "accept all edits" and 2 is the next option.
    await expect(prompt.getByRole('option', { name: /accept all edits/ })).toHaveCount(0);
    await expect(prompt.getByRole('option').nth(1)).not.toHaveText(/Yes, and/);

    // The team card names the waiting agent, as the session state core published names it.
    const teamCard = tab.getByTestId('team-card');
    await expect(teamCard.getByTestId('team-status')).toHaveText('Needs you');
    await expect(teamCard.getByRole('button', { name: 'Open agent Atlas, Needs you' })).toBeVisible();
    await expect(teamCard.getByRole('button', { name: /^Open agent Mira, / })).not.toHaveAccessibleName(/Needs you/);

    await prompt.getByRole('option', { name: 'Yes', exact: true }).click();
    await expect(prompt).toBeHidden();
    await expect(teamCard.getByTestId('team-status')).toHaveText('Running');
    await expect(teamCard.getByRole('button', { name: /^Open agent Atlas, / })).not.toHaveAccessibleName(/Needs you/);
    // The lead's next request carries the command's output, so the approved call ran.
    const toolResults = () => chatRequests(stub).flatMap((r) => (r.body as { messages?: { role: string }[] }).messages ?? []).filter((m) => m.role === 'tool');
    await expect.poll(() => toolResults().some((m) => JSON.stringify(m).includes('team-lead-check'))).toBe(true);
    await expect(strayCard).toHaveCount(0);
    expect(await transcriptHoldsCommand()).toBe(false);
  } finally {
    await stub.close();
  }
});
