import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { startOpenAIStub, type OpenAIStub, type StubReply } from './support/openai-stub';
import { addProject, chatInput } from './support/ui';

/**
 * A stopped run that a handler pi awaits keeps from settling, a pi extension the user installed for a nested agent or a
 * Stop hook for the main chat: the agent's card or the chat's status bar says what the Stop waits for, again after the
 * chat view reloads, and the line goes once the handler lets the run settle.
 */

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

function working(): StubReply {
  return { chunks: ['Working on it'], holdAfterFirst: new Promise<void>(() => {}) };
}

/**
 * Installs a user pi extension whose `agent_settled` handler, in a subagent or team member session only, waits until
 * the returned release file exists. Returns the extension's path and the release.
 */
function installHeldSettle(h: HermeticHome): { extension: string; release: () => void } {
  const releaseFile = path.join(h.root, 'release-settle');
  const extension = path.join(h.agentDir, 'extensions', 'held-settle.js');
  fs.mkdirSync(path.dirname(extension), { recursive: true });
  fs.writeFileSync(extension, [
    "import * as fs from 'node:fs';",
    'export default function (pi) {',
    "  pi.on('agent_settled', async (_event, ctx) => {",
    "    if (!/[\\\\/](subagents|teams)([\\\\/]|$)/.test(ctx.sessionManager.getSessionDir())) return;",
    `    while (!fs.existsSync(${JSON.stringify(releaseFile)})) await new Promise((resolve) => setTimeout(resolve, 100));`,
    '  });',
    '}',
    '',
  ].join('\n'));
  return { extension, release: () => fs.writeFileSync(releaseFile, '') };
}

test('a stopped subagent whose agent_settled handler holds its run says so on its card until the run settles', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const held = installHeldSettle(home);
    const { app } = await launch();
    const tab = await openProject(app, home);

    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'Agent', arguments: { description: 'Survey the repo', prompt: 'Look around the repository.', subagent_type: 'general-purpose' } }] },
      working(),
      { chunks: [MAIN_GOES_ON] },
    );
    await send(tab, 'start a subagent');

    const card = tab.getByTestId('subagent-card');
    await card.getByTestId('subagent-card-stop').click();

    const line = card.getByTestId('subagent-status-line');
    await expect(line).toHaveText(`Stopping: waiting for pi's agent_settled handlers to return. pi gives them no abort signal. pi extensions with such a handler: ${held.extension}.`);
    await expect(card.getByTestId('subagent-status')).toHaveText('Running');

    held.release();
    await expect(card.getByTestId('subagent-status')).toHaveText('Stopped');
    await expect(line).toBeHidden();
    await expect(tab.getByText(MAIN_GOES_ON)).toBeVisible();
  } finally {
    await stub.close();
  }
});

/**
 * Configures a Stop hook (`agent_end` in `hooks.json`) that runs until the returned release file exists. The main chat
 * loads no user pi extension, and Damocles awaits this hook in its own `agent_settled` handler, with no abort signal.
 */
function installHeldStopHook(h: HermeticHome): () => void {
  const releaseFile = path.join(h.root, 'release-stop-hook');
  const waitForRelease = "const fs = require('fs'); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) clearInterval(timer); }, 100);";
  fs.writeFileSync(path.join(h.damoclesDir, 'hooks.json'), JSON.stringify({ hooks: { agent_end: [{ command: [process.execPath, '-e', waitForRelease, releaseFile], timeoutMs: 120_000 }] } }));
  return () => fs.writeFileSync(releaseFile, '');
}

/** The id the stopped team's result offered `resume_team` for, as the main agent read it. */
function resumableTeamId(stub: OpenAIStub): string {
  for (const request of [...stub.requests].reverse()) {
    const id = /resume_team\(\{team_id:\\"([0-9a-f-]{36})\\"\}\)/.exec(JSON.stringify(request.body))?.[1];
    if (id) return id;
  }
  throw new Error('no team result offered resume_team');
}

test("a resumed team's lead waits for its stopped run to let go of its session file, and says what that run waits for", async ({ home, launch }) => {
  // The team's drain gives up on the held lead after 30 s.
  test.setTimeout(150_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    writeUserSettings(home, { 'damocles.team.enabled': true });
    const held = installHeldSettle(home);
    const { app } = await launch();
    const tab = await openProject(app, home);

    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'create_team', arguments: { title: 'Lockout', brief: 'Lock an account after ten failed logins.', agents: [{ name: 'Atlas', role: 'lead' }, { name: 'Mira', role: 'specialist' }] } }] },
      working(),
      { chunks: [MAIN_GOES_ON] },
    );
    await send(tab, 'start a team');

    const teamCard = tab.getByTestId('team-card');
    await teamCard.getByTestId('team-card-stop').click();
    await tab.getByTestId('stop-team-confirm').getByRole('button', { name: 'Stop team' }).click();
    await expect(teamCard.getByTestId('team-status')).toHaveText('Stopped', { timeout: 60_000 });
    await expect(tab.getByText(MAIN_GOES_ON)).toBeVisible();

    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'resume_team', arguments: { team_id: resumableTeamId(stub) } }] },
      working(),
    );
    await send(tab, 'resume the team');
    await tab.getByTestId('team-card').last().getByText('Lockout').click();

    const lead = tab.getByTestId('team-agent-card').filter({ hasText: 'Atlas' });
    const line = lead.getByTestId('team-agent-wind-down');
    await expect(line).toHaveText(`Stopping: waiting for pi's agent_settled handlers to return. pi gives them no abort signal. pi extensions with such a handler: ${held.extension}.`);
    // The resumed lead has not opened its file, so its model call is still unasked.
    expect(stub.replies).toHaveLength(1);

    held.release();
    await expect(line).toBeHidden();
    await expect.poll(() => stub.replies.length).toBe(0);
  } finally {
    await stub.close();
  }
});

test("a stopped team's lead whose agent_settled handler holds its run says so on its card until the run settles", async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    writeUserSettings(home, { 'damocles.team.enabled': true });
    const held = installHeldSettle(home);
    const { app } = await launch();
    const tab = await openProject(app, home);

    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'create_team', arguments: { title: 'Lockout', brief: 'Lock an account after ten failed logins.', agents: [{ name: 'Atlas', role: 'lead' }, { name: 'Mira', role: 'specialist' }] } }] },
      working(),
      { chunks: [MAIN_GOES_ON] },
    );
    await send(tab, 'start a team');

    const teamCard = tab.getByTestId('team-card');
    await teamCard.getByTestId('team-card-stop').click();
    await tab.getByTestId('stop-team-confirm').getByRole('button', { name: 'Stop team' }).click();
    await teamCard.getByText('Lockout').click();

    const lead = tab.getByTestId('team-agent-card').filter({ hasText: 'Atlas' });
    const line = lead.getByTestId('team-agent-wind-down');
    await expect(line).toHaveText(`Stopping: waiting for pi's agent_settled handlers to return. pi gives them no abort signal. pi extensions with such a handler: ${held.extension}.`);

    held.release();
    await expect(line).toBeHidden();
    await expect(teamCard.getByTestId('team-status')).toHaveText('Stopped');
    await expect(tab.getByText(MAIN_GOES_ON)).toBeVisible();
  } finally {
    await stub.close();
  }
});

test("a stopped chat whose Stop hook holds its run says so in its status bar, after a reload too, and the next message waits for it", async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const release = installHeldStopHook(home);
    const { app } = await launch();
    const tab = await openProject(app, home);

    stub.replies.push(working());
    await send(tab, 'start working');
    await expect(tab.getByText('Working on it')).toBeVisible();
    await tab.keyboard.press('Escape');

    const line = tab.getByTestId('status-wind-down');
    const text = "Stopping: waiting for pi's agent_settled handlers to return. pi gives them no abort signal.";
    await expect(line).toHaveText(text);
    stub.replies.push({ chunks: ['The next message ran.'] });
    await send(tab, 'the next message');
    await expect(line).toHaveText(text);
    // The message waits for the stopped run, so its model call is still unasked.
    expect(stub.replies).toHaveLength(1);

    await tab.reload();
    await expect(chatInput(tab)).toBeVisible();
    await expect(line).toHaveText(text);

    release();
    await expect(line).toBeHidden();
    await expect(tab.getByText('The next message ran.')).toBeVisible();
    expect(stub.replies).toHaveLength(0);
  } finally {
    await stub.close();
  }
});

test('a stopped subagent still winding down when the chat view reloads keeps its running card and its line until the run settles', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const held = installHeldSettle(home);
    const { app } = await launch();
    const tab = await openProject(app, home);

    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'Agent', arguments: { description: 'Survey the repo', prompt: 'Look around the repository.', subagent_type: 'general-purpose' } }] },
      working(),
      { chunks: [MAIN_GOES_ON] },
    );
    await send(tab, 'start a subagent');

    const card = tab.getByTestId('subagent-card');
    await card.getByTestId('subagent-card-stop').click();
    const line = card.getByTestId('subagent-status-line');
    const text = `Stopping: waiting for pi's agent_settled handlers to return. pi gives them no abort signal. pi extensions with such a handler: ${held.extension}.`;
    await expect(line).toHaveText(text);

    await tab.reload();
    // The main turn still waits on the subagent, so the reloaded composer queues.
    await expect(tab.getByRole('textbox', { name: 'Message Damocles' })).toHaveAttribute('placeholder', 'Type to queue your next message…');
    await expect(card.getByTestId('subagent-status')).toHaveText('Running');
    await expect(line).toHaveText(text);

    held.release();
    await expect(card.getByTestId('subagent-status')).toHaveText('Stopped');
    await expect(line).toBeHidden();
    await expect(tab.getByText(MAIN_GOES_ON)).toBeVisible();
  } finally {
    await stub.close();
  }
});
