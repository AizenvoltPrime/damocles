import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { forgeEnv, inAccounts, launchReady, setAgentShells, startStubOnTestCa, tokenSignIn } from './support/forge';
import { CI_FIXTURES, PLANTED_LOG_TOKEN, type ForgeStub } from './support/forge-stub';
import { expect, test } from './support/fixtures';
import type { DesktopApp } from './support/app';
import { startDesignChat } from './support/design';
import { git, initRepo } from './support/git';
import { seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { agentRequests, call, chatRequests, startOpenAIStub, type OpenAIStub } from './support/openai-stub';
import { openProjectChat } from './support/screenshots';
import { setContentSize } from './support/settings';
import { awaitTurnEnd, chatInput, postFromWebview } from './support/ui';

// The agent's GitHub and GitLab tools, deferred behind ToolSearch and scoped to the chat's project,
// and the design's approval card for a forge write. The stub's gitlab.com stands in for the design's gitlab.indigital.gr and
// alexios-s/damocles for grp/damocles; work-alexios (agent shells allowed) for astef-admin, alexios-s for astefanopoulos.

const GITLAB = 'gitlab.com';
const REPO = 'alexios-s/damocles';
const TOKENS = { 'alexios-s': 'glpat-stubAlexiosSApi000000008', 'work-alexios': 'glpat-stubWorkAlexiosApi000001' } as const;
type Login = keyof typeof TOKENS;
const MR = CI_FIXTURES.mergeRequest;
const TITLE = `Comment on merge request !${MR.number}?`;
const ALWAYS = `Yes, and don't ask again for ForgeComment on ${REPO}`;
const COMMENT = 'Pushed the fix in 4e1a9c2: refresh now runs once per account and persists the rotated token before first use. Ready for review.\n<b>not bold</b>';
const CHECKED = { timeout: 30_000 };

interface ToolsRun {
  readonly app: ElectronApplication;
  readonly stub: ForgeStub;
  readonly openai: OpenAIStub;
}

const closers: (() => Promise<void>)[] = [];
test.afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

async function launchTools(launch: (options?: { env?: Record<string, string> }) => Promise<DesktopApp>, home: HermeticHome, settings: Record<string, unknown> = {}): Promise<ToolsRun> {
  const started = await startStubOnTestCa(home);
  const { stub } = started;
  closers.push(() => stub.close());
  const openai = await startOpenAIStub();
  closers.push(() => openai.close());
  seedStubModel(home, openai.baseUrl);
  writeUserSettings(home, settings);
  const desktop = await launchReady(launch, forgeEnv(started));
  return { app: desktop.app, stub, openai };
}

/** Signs each account in with its token and sets its "Agent shells may use this account" switch. */
async function signIn(run: ToolsRun, switches: Partial<Record<Login, boolean>>): Promise<void> {
  await inAccounts(run.app, async (overlay) => {
    for (const login of Object.keys(switches) as Login[]) await tokenSignIn(overlay, GITLAB, TOKENS[login], login);
    for (const [login, on] of Object.entries(switches)) await setAgentShells(overlay, GITLAB, login, on);
  });
}

/** A project named damocles whose origin is the stub's alexios-s/damocles, opened with its chat. */
async function damoclesProject(run: ToolsRun, home: HermeticHome): Promise<Page> {
  const dir = path.join(home.root, 'projects', 'damocles');
  await initRepo(home, dir);
  await git(home, dir, 'remote', 'add', 'origin', `${run.stub.gitlab.webUrl}/${REPO}.git`);
  return openProjectChat(run.app, dir);
}

async function send(tab: Page, text: string): Promise<void> {
  await chatInput(tab).fill(text);
  await chatInput(tab).press('Enter');
}

/** Every tool result the model received, in order, as text. */
function toolResults(stub: OpenAIStub): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const request of chatRequests(stub)) {
    for (const message of (request.body as { messages?: { role: string; tool_call_id?: string; content: unknown }[] }).messages ?? []) {
      if (message.role !== 'tool' || message.tool_call_id === undefined || seen.has(message.tool_call_id)) continue;
      seen.add(message.tool_call_id);
      results.push(typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
    }
  }
  return results;
}

/** The tool names the model was offered with its last request. */
function offeredTools(stub: OpenAIStub): string[] {
  const last = chatRequests(stub).filter((request) => ((request.body as { tools?: unknown[] }).tools?.length ?? 0) > 1).at(-1);
  return ((last?.body as { tools?: { function?: { name?: string } }[] } | undefined)?.tools ?? []).map((tool) => tool.function?.name ?? '');
}

const comments = (run: ToolsRun): { login: string; body: string }[] => run.stub.gitlab.forgeWrites
  .filter((write) => write.method === 'POST' && write.path.endsWith(`/merge_requests/${MR.number}/notes`))
  .map((write) => ({ login: write.login, body: String((write.body as { body?: unknown }).body) }));

const card = (tab: Page): Locator => tab.getByTestId('permission-card');
const options = (tab: Page, title = TITLE): Locator => tab.getByRole('listbox', { name: title, exact: true });
const allowedOnce = (login: Login): string => `Allowed once. Posting the comment to !${MR.number} as ${login} on ${GITLAB}.`;

test('ToolSearch loads the forge group on a stub GitLab project; ForgePipelines lists its pipelines and ForgeJobLog redacts the planted token', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const run = await launchTools(launch, home);
  await signIn(run, { 'alexios-s': false });
  const tab = await damoclesProject(run, home);

  run.openai.replies.push(
    call('ToolSearch', { tools: ['forge'] }),
    call('ForgePipelines', {}),
    call('ForgeJobLog', { job: CI_FIXTURES.jobs.e2e }),
    { chunks: ['Read the CI.'] },
  );
  await send(tab, 'Why did CI fail?');
  await expect(tab.getByText('Read the CI.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);

  const [loaded, pipelines, log] = toolResults(run.openai);
  expect(loaded).toMatch(/^Loaded \d+ tools: .*ForgePipelines/);
  for (const name of ['ForgePipelines', 'ForgeJobs', 'ForgeJobLog', 'ForgeMergeRequest', 'ForgeComment', 'ForgeJobAction', 'ForgeOpenMergeRequest']) expect(offeredTools(run.openai)).toContain(name);
  expect(pipelines).toContain(GITLAB);
  expect(pipelines).toContain(REPO);
  expect(pipelines).toContain('alexios-s');
  expect(pipelines).toContain(String(CI_FIXTURES.pipeline.id));
  expect(pipelines).toContain(String(CI_FIXTURES.pipeline.previous));
  expect(log).toContain('rotates once per account');
  expect(log).toContain('export GITLAB_TOKEN=');
  expect(log).not.toContain(PLANTED_LOG_TOKEN);
  expect(log).not.toContain('\u001b[');
  // reads ask nothing
  await expect(card(tab)).toHaveCount(0);
});

test('ForgeComment asks in default and acceptEdits, is blocked in plan mode, and runs in YOLO', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchTools(launch, home);
  await signIn(run, { 'alexios-s': false });
  const tab = await damoclesProject(run, home);
  run.openai.replies.push(call('ToolSearch', { tools: ['forge'] }), { chunks: ['Loaded.'] });
  await send(tab, 'load the forge tools');
  await expect(tab.getByText('Loaded.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);

  for (const mode of ['default', 'acceptEdits'] as const) {
    await postFromWebview(tab, { type: 'setPermissionMode', mode });
    run.openai.replies.push(call('ForgeComment', { number: MR.number, body: `asked in ${mode}` }), { chunks: [`Posted in ${mode}.`] });
    await send(tab, `comment in ${mode}`);
    await expect(options(tab)).toBeVisible(CHECKED);
    await options(tab).press('Enter');
    await expect(tab.getByText(allowedOnce('alexios-s'), { exact: true })).toBeVisible();
    await expect(tab.getByText(`Posted in ${mode}.`, { exact: true })).toBeVisible(CHECKED);
    await awaitTurnEnd(tab);
    expect(comments(run).at(-1)).toEqual({ login: 'alexios-s', body: `asked in ${mode}` });
  }

  await postFromWebview(tab, { type: 'setPermissionMode', mode: 'plan' });
  const before = comments(run).length;
  const asked = agentRequests(run.openai).length;
  // a plan-mode turn ends only at ExitPlanMode or AskUserQuestion: a reply that ended would get the stub's echo for every
  // nudge, and those rows push this one out of the virtualized list, so it stays open until the user stops it
  run.openai.replies.push(call('ForgeComment', { number: MR.number, body: 'in plan mode' }), { chunks: ['Blocked in plan mode.'], holdAfterFirst: new Promise<void>(() => {}) });
  await send(tab, 'comment in plan mode');
  await expect(tab.getByText('Blocked in plan mode.', { exact: true })).toBeVisible(CHECKED);
  await tab.getByTestId('composer-send').click();
  await awaitTurnEnd(tab);
  await expect(card(tab)).toHaveCount(0);
  expect(toolResults(run.openai).at(-1)).toMatch(/plan mode/i);
  expect(comments(run)).toHaveLength(before);
  expect(agentRequests(run.openai)).toHaveLength(asked + 2);

  await postFromWebview(tab, { type: 'setPermissionMode', mode: 'default' });
  await postFromWebview(tab, { type: 'setDangerouslySkipPermissions', enabled: true });
  run.openai.replies.push(call('ForgeComment', { number: MR.number, body: 'in YOLO' }), { chunks: ['Posted in YOLO.'] });
  await send(tab, 'comment in YOLO');
  await expect(tab.getByText('Posted in YOLO.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);
  await expect(card(tab)).toHaveCount(0);
  expect(comments(run).at(-1)).toEqual({ login: 'alexios-s', body: 'in YOLO' });
});

for (const width of [768, 1280]) {
  test(`forge write approval journey at ${width} px: the tool's notice binds an account, then the card names it and Enter posts once`, async ({ home, launch }) => {
    test.setTimeout(300_000);
    const run = await launchTools(launch, home);
    await setContentSize(run.app, width, 900);
    // both accounts can push to alexios-s/damocles, so nothing resolves without the user
    await signIn(run, { 'alexios-s': false, 'work-alexios': true });
    const tab = await damoclesProject(run, home);

    run.openai.replies.push(call('ToolSearch', { tools: ['forge'] }), call('ForgeComment', { number: MR.number, body: COMMENT }), { chunks: ['No account yet.'] });
    await send(tab, `Comment on !${MR.number} that it is ready for review.`);
    await expect(tab.getByText('No account yet.', { exact: true })).toBeVisible(CHECKED);
    await awaitTurnEnd(tab);
    const notice = tab.getByTestId('forge-refused-notice');
    await expect(notice).toHaveAttribute('data-reason', 'noAccount');
    await expect(notice.getByRole('region', { name: "The agent's ForgeComment was refused", exact: true })).toBeVisible();
    expect(comments(run)).toEqual([]);

    // the journey (S9-agent.journey.json), its first half on the tool's notice
    await tab.getByRole('button', { name: 'Choose account', exact: true }).click();
    await expect(tab.getByRole('menu', { name: `Account for ${GITLAB}`, exact: true })).toBeVisible();
    await tab.getByRole('menuitemradio', { name: 'work-alexios, Agent shells allowed', exact: true }).click();
    await expect(tab.getByText('damocles now uses work-alexios', { exact: true })).toBeVisible(CHECKED);

    run.openai.replies.push(call('ForgeComment', { number: MR.number, body: COMMENT }), { chunks: ['Commented.'] });
    await send(tab, 'Try again.');
    await expect(options(tab)).toBeVisible(CHECKED);
    // the card names the server, project and account, and shows the exact text it will post
    await expect(card(tab).getByTestId('permission-title')).toHaveText(TITLE);
    await expect(card(tab).getByTestId('permission-subtitle')).toContainText('ForgeComment');
    await expect(card(tab).getByTestId('permission-subtitle')).toContainText('writes to the server as you');
    const facts = card(tab).getByRole('definition');
    await expect(card(tab).getByRole('term')).toHaveText(['Server', 'Project', 'Account']);
    await expect(facts.nth(0)).toHaveText(GITLAB);
    await expect(facts.nth(1)).toContainText(REPO);
    await expect(facts.nth(1)).toContainText(`!${MR.number} ${MR.title}`);
    await expect(facts.nth(2)).toContainText('work-alexios');
    await expect(facts.nth(2)).toContainText('chosen by you');
    const content = card(tab).getByRole('region', { name: 'Comment text', exact: true });
    expect(await content.evaluate((node) => node.textContent)).toBe(COMMENT);
    await expect(content.locator('b')).toHaveCount(0);

    await options(tab).press('Enter');
    await expect(tab.getByText(allowedOnce('work-alexios'), { exact: true })).toBeVisible();
    await expect(tab.getByRole('status').filter({ hasText: allowedOnce('work-alexios') })).toBeVisible();
    await expect(tab.getByText('Commented.', { exact: true })).toBeVisible(CHECKED);
    expect(comments(run)).toEqual([{ login: 'work-alexios', body: COMMENT }]);
  });
}

test('forge write approval card: the feedback field refuses with its text, and option 2 saves a rule for this tool on this project', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchTools(launch, home);
  await signIn(run, { 'alexios-s': false });
  const tab = await damoclesProject(run, home);

  run.openai.replies.push(call('ToolSearch', { tools: ['forge'] }), call('ForgeComment', { number: MR.number, body: 'too early' }), { chunks: ['Waiting.'] });
  await send(tab, 'comment now');
  await expect(options(tab)).toBeVisible(CHECKED);
  const feedback = card(tab).getByRole('textbox', { name: 'Tell Damocles what to do instead', exact: true });
  await feedback.fill('Wait until the pipeline passes');
  await feedback.press('Enter');
  await expect(tab.getByText('Waiting.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);
  expect(toolResults(run.openai).at(-1)).toContain('Wait until the pipeline passes');
  expect(comments(run)).toEqual([]);

  run.openai.replies.push(call('ForgeComment', { number: MR.number, body: 'first' }), { chunks: ['First posted.'] });
  await send(tab, 'comment once');
  await expect(options(tab)).toBeVisible(CHECKED);
  await expect(options(tab).getByRole('option')).toHaveCount(3);
  for (const [index, name] of ['Yes', ALWAYS, 'No'].entries()) await expect(options(tab).getByRole('option').nth(index)).toHaveAccessibleName(name);
  await options(tab).getByRole('option', { name: ALWAYS, exact: true }).click();
  await tab.getByTestId('permission-destination-picker').getByRole('button', { name: /^Local/ }).click();
  await expect(tab.getByText('First posted.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);
  expect(comments(run).map((comment) => comment.body)).toEqual(['first']);
  const local = path.join(home.root, 'projects', 'damocles', '.damocles', 'settings.local.json');
  expect(JSON.parse(fs.readFileSync(local, 'utf8'))).toMatchObject({ permissions: { allow: expect.arrayContaining([`ForgeComment(${GITLAB}/${REPO})`]) } });

  run.openai.replies.push(call('ForgeComment', { number: MR.number, body: 'second' }), { chunks: ['Second posted.'] });
  await send(tab, 'comment again');
  await expect(tab.getByText('Second posted.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);
  await expect(card(tab)).toHaveCount(0);
  expect(comments(run).map((comment) => comment.body)).toEqual(['first', 'second']);
});

async function forgeNotLoadable(run: ToolsRun, tab: Page): Promise<void> {
  run.openai.replies.push(call('ToolSearch', { tools: ['forge'] }), { chunks: ['Tried.'] });
  await send(tab, 'load the forge tools');
  await expect(tab.getByText('Tried.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);
  expect(toolResults(run.openai).at(-1)).toContain('No new tools were loaded.');
  expect(offeredTools(run.openai).filter((name) => /^Forge[A-Z]/.test(name))).toEqual([]);
}

test('the forge group cannot be loaded with no account', async ({ home, launch }) => {
  test.setTimeout(180_000);
  const run = await launchTools(launch, home);
  await forgeNotLoadable(run, await damoclesProject(run, home));
});

test('the forge group cannot be loaded while it is switched off', async ({ home, launch }) => {
  test.setTimeout(180_000);
  const run = await launchTools(launch, home, { 'damocles.desktop.forge.agentTools': false });
  await signIn(run, { 'alexios-s': false });
  await forgeNotLoadable(run, await damoclesProject(run, home));
});

test('the forge group cannot be loaded in a design chat', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const run = await launchTools(launch, home);
  await signIn(run, { 'alexios-s': false });
  const parent = await damoclesProject(run, home);
  const { design } = await startDesignChat(run.app, parent, run.openai, home, {
    fidelity: 'Static mockup',
    script: () => [call('ToolSearch', { tools: ['forge'] }), { chunks: ['Tried in design.'] }],
  });
  await expect(design.getByText('Tried in design.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(design);
  expect(toolResults(run.openai).at(-1)).not.toMatch(/^Loaded/);
  expect(offeredTools(run.openai).filter((name) => /^Forge[A-Z]/.test(name))).toEqual([]);
});
