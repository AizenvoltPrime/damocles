import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { chatRequests, startOpenAIStub, type StubReply } from './support/openai-stub';
import { addProject, chatInput } from './support/ui';

const ACCEPT_ALL = 'Yes, and accept all edits this session';
const COMMAND = 'echo after-accept-all';

async function openProject(app: ElectronApplication, h: HermeticHome): Promise<Page> {
  const home = await activeChat(app);
  await expect(chatInput(home)).toBeVisible();
  const opened = nextChat(app, [home]);
  await addProject(app, h.project, true);
  const tab = await opened;
  await expect(chatInput(tab)).toBeVisible();
  return tab;
}

/** A file in the project holding `limit = 5`, with the Edit call that raises it. */
function editable(h: HermeticHome, name: string): { file: string; edit: StubReply } {
  const file = path.join(h.project, name);
  fs.writeFileSync(file, 'export const limit = 5;\n');
  return { file, edit: { chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: file, old_string: 'limit = 5', new_string: 'limit = 10' } }] } };
}

const edited = (file: string) => () => fs.readFileSync(file, 'utf8').includes('limit = 10');

test("option 2 on a subagent's edit prompt switches the chat to Accept edits: every agent's later edit runs unasked, a shell command still asks", async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await openProject(app, home);
    const prompt = tab.getByRole('region', { name: 'Permission request' });
    const first = editable(home, 'first.ts');
    const second = editable(home, 'second.ts');
    const mains = editable(home, 'main.ts');

    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'Agent', arguments: { description: 'Raise the limits', prompt: 'Raise every limit.', subagent_type: 'general-purpose' } }] },
      first.edit,
      second.edit,
      { chunks: [], toolCalls: [{ name: 'bash', arguments: { command: COMMAND } }] },
      { chunks: ['Subagent done'] },
      mains.edit,
      { chunks: ['All limits raised'] },
    );
    await chatInput(tab).fill('raise the limits');
    await chatInput(tab).press('Enter');

    await expect(prompt).toContainText('Raise the limits wants to edit');
    await expect(tab.getByTestId('composer-mode')).toHaveAccessibleName(/^Ask before edits/);
    await prompt.getByRole('option', { name: ACCEPT_ALL }).click();
    await expect(tab.getByTestId('composer-mode')).toHaveAccessibleName(/^Accept edits/);
    await expect.poll(edited(first.file)).toBe(true);

    // The subagent's next edit runs unasked; its shell command is the next prompt.
    await expect.poll(edited(second.file)).toBe(true);
    await expect(prompt).toContainText('Raise the limits wants to run this command:');
    await expect(prompt).toContainText(COMMAND);
    await expect(prompt.getByRole('option', { name: ACCEPT_ALL })).toHaveCount(0);
    await prompt.getByRole('option', { name: 'Yes', exact: true }).click();

    // The chat's own edit after the subagent finished runs unasked too.
    await expect(tab.getByText('All limits raised')).toBeVisible();
    expect(edited(mains.file)()).toBe(true);
    await expect(prompt).toBeHidden();
  } finally {
    await stub.close();
  }
});

test("option 2 on a team agent's edit prompt switches the chat to Accept edits: its later edit runs unasked, a shell command still asks", async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    writeUserSettings(home, { 'damocles.team.enabled': true });
    const { app } = await launch();
    const tab = await openProject(app, home);
    const prompt = tab.getByRole('region', { name: 'Permission request' });
    const first = editable(home, 'first.ts');
    const second = editable(home, 'second.ts');

    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'create_team', arguments: { title: 'Lockout', brief: 'Lock an account after ten failed logins.', agents: [{ name: 'Atlas', role: 'lead' }, { name: 'Mira', role: 'specialist' }] } }] },
      first.edit,
      second.edit,
      { chunks: [], toolCalls: [{ name: 'bash', arguments: { command: COMMAND } }] },
      { chunks: ['Waiting on the team'], holdAfterFirst: new Promise<void>(() => {}) },
    );
    await chatInput(tab).fill('start a team');
    await chatInput(tab).press('Enter');

    await expect(prompt).toContainText('Atlas from team Lockout wants to edit');
    await prompt.getByRole('option', { name: ACCEPT_ALL }).click();
    await expect(tab.getByTestId('composer-mode')).toHaveAccessibleName(/^Accept edits/);
    await expect.poll(edited(first.file)).toBe(true);

    await expect.poll(edited(second.file)).toBe(true);
    await expect(prompt).toContainText('Atlas from team Lockout wants to run this command:');
    await expect(prompt).toContainText(COMMAND);
    await expect(prompt.getByRole('option', { name: ACCEPT_ALL })).toHaveCount(0);
    await prompt.getByRole('option', { name: 'Yes', exact: true }).click();
    await expect(prompt).toBeHidden();
  } finally {
    await stub.close();
  }
});

// pi gates every call of a step before running any, so both Edit prompts are open when the first is answered.
test('option 2 on one of two edit prompts raised in the same step also approves the other, which the new mode would not ask about', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await openProject(app, home);
    const prompt = tab.getByRole('region', { name: 'Permission request' });
    const first = editable(home, 'first.ts');
    const second = editable(home, 'second.ts');

    stub.replies.push(
      { chunks: [], toolCalls: [...(first.edit.toolCalls ?? []), ...(second.edit.toolCalls ?? [])] },
      { chunks: ['Both limits raised'] },
    );
    await chatInput(tab).fill('raise both limits');
    await chatInput(tab).press('Enter');

    await expect(prompt).toContainText('first.ts');
    await prompt.getByRole('option', { name: ACCEPT_ALL }).click();
    await expect(tab.getByTestId('composer-mode')).toHaveAccessibleName(/^Accept edits/);
    await expect(tab.getByText('Both limits raised')).toBeVisible();
    expect(edited(first.file)()).toBe(true);
    expect(edited(second.file)()).toBe(true);
    await expect(prompt).toBeHidden();
  } finally {
    await stub.close();
  }
});

// A mode or YOLO change re-checks the open prompts, which exist only during a turn, so the composer controls stay live in one.
test('switching to Accept edits from the composer while two edit prompts are open runs both edits', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await openProject(app, home);
    const prompt = tab.getByRole('region', { name: 'Permission request' });
    const first = editable(home, 'first.ts');
    const second = editable(home, 'second.ts');

    stub.replies.push(
      { chunks: [], toolCalls: [...(first.edit.toolCalls ?? []), ...(second.edit.toolCalls ?? [])] },
      { chunks: ['Both limits raised'] },
    );
    await chatInput(tab).fill('raise both limits');
    await chatInput(tab).press('Enter');

    await expect(prompt).toContainText('first.ts');
    await tab.getByTestId('composer-mode').click();
    await expect(tab.getByTestId('composer-mode')).toHaveAccessibleName(/^Accept edits/);
    await expect(tab.getByText('Both limits raised')).toBeVisible();
    expect(edited(first.file)()).toBe(true);
    expect(edited(second.file)()).toBe(true);
    await expect(prompt).toBeHidden();
  } finally {
    await stub.close();
  }
});

const ranUnderYolo = (h: HermeticHome) => () => fs.existsSync(path.join(h.project, 'yolo.txt'));
const YOLO_COMMAND = { name: 'bash', arguments: { command: 'echo ran > yolo.txt' } };

test('turning YOLO on from the composer while a shell prompt is open runs the command', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await openProject(app, home);
    const prompt = tab.getByRole('region', { name: 'Permission request' });

    stub.replies.push({ chunks: [], toolCalls: [YOLO_COMMAND] }, { chunks: ['Command done'] });
    await chatInput(tab).fill('run it');
    await chatInput(tab).press('Enter');

    await expect(prompt).toContainText('yolo.txt');
    await tab.getByTestId('composer-yolo').click();
    await expect(tab.getByText('Command done')).toBeVisible();
    expect(ranUnderYolo(home)()).toBe(true);
    await expect(prompt).toBeHidden();
  } finally {
    await stub.close();
  }
});

test('turning YOLO on while a question is open leaves the question waiting for the user', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await openProject(app, home);
    const question = tab.getByRole('region', { name: 'Question prompt' });

    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'AskUserQuestion', arguments: { questions: [{ header: 'Limit', question: 'Which limit?', options: [{ label: 'Five', description: 'Strict' }, { label: 'Ten', description: 'Lenient' }], multiSelect: false }] } }] },
      { chunks: [], toolCalls: [YOLO_COMMAND] },
      { chunks: ['Limit set'] },
    );
    await chatInput(tab).fill('set the limit');
    await chatInput(tab).press('Enter');

    await expect(question).toContainText('Which limit?');
    await tab.getByTestId('composer-yolo').click();
    await expect(tab.getByTestId('composer-yolo')).toHaveAttribute('aria-pressed', 'true');
    await question.getByRole('option', { name: 'Ten' }).click();
    // The first Submit is the tab the answer moved to, the last sends the answers.
    await question.getByRole('button', { name: 'Submit', exact: true }).last().click();

    // The command after the answer runs unasked, so YOLO was on while the question stayed open.
    await expect(tab.getByText('Limit set')).toBeVisible();
    expect(ranUnderYolo(home)()).toBe(true);
  } finally {
    await stub.close();
  }
});

test('leaving plan mode from the composer while a shell prompt is open tells the model at its next step', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await openProject(app, home);
    const prompt = tab.getByRole('region', { name: 'Permission request' });
    const mode = tab.getByTestId('composer-mode');
    await mode.click();
    await mode.click();
    await expect(mode).toHaveAccessibleName(/^Plan mode/);

    stub.replies.push({ chunks: [], toolCalls: [YOLO_COMMAND] }, { chunks: ['Implementing now'] });
    await chatInput(tab).fill('plan it');
    await chatInput(tab).press('Enter');

    await expect(prompt).toContainText('yolo.txt');
    await mode.click();
    await expect(mode).toHaveAccessibleName(/^Ask before edits/);
    await prompt.getByRole('option', { name: 'Yes', exact: true }).click();

    await expect(tab.getByText('Implementing now')).toBeVisible();
    expect(chatRequests(stub).some((r) => JSON.stringify(r.body).includes('switched this chat out of plan mode'))).toBe(true);
  } finally {
    await stub.close();
  }
});
