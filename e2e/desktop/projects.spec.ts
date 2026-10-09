import * as fs from 'node:fs';
import * as path from 'node:path';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { selectedProjectKey, shellState } from './support/shell';
import { addProject, answerDialogs, answerOpenDialog, chatInput, askedDialogs, clickMenu, TRUST_PROMPT } from './support/ui';
import { chatRow, listChats, projectKeyOf, projectRow, readyShell } from './support/shell-ui';
import { chooseMenuItem, confirmDialog, readyOverlay } from './support/overlay';

test('projects: the sidebar adds, trusts, selects and removes projects, shows their activity, and refuses removal while a chat runs', async ({ home, launch }) => {
  test.setTimeout(180_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const beta = path.join(path.dirname(home.project), 'beta');
    fs.mkdirSync(beta, { recursive: true });

    const desktop = await launch();
    const { app } = desktop;
    await expect(chatInput(await activeChat(app))).toBeVisible();
    const shell = await readyShell(app);

    // Adding asks once; declining leaves the project listed, selected and untrusted.
    await addProject(app, home.project, false);
    await expect.poll(async () => (await shellState(app)).projects.map((p) => p.name)).toEqual(['alpha']);
    expect((await askedDialogs(app)).filter((b) => b.message.startsWith(TRUST_PROMPT))).toHaveLength(1);
    const alphaKey = await projectKeyOf(app, 'alpha');
    const alphaRow = projectRow(shell, alphaKey);
    await expect(alphaRow).toHaveAttribute('aria-selected', 'true');
    await expect(shell.getByTestId('breadcrumb-project')).toHaveText('alpha');
    await expect(alphaRow.getByTestId('untrusted-badge')).toHaveText('Untrusted');

    // The Untrusted badge asks the same trust question.
    await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder' });
    await alphaRow.getByTestId('untrusted-badge').click();
    await expect.poll(async () => (await shellState(app)).projects[0]?.trusted).toBe(true);
    await expect(alphaRow.getByTestId('untrusted-badge')).toHaveCount(0);

    // Add project (folder-plus) opens the folder picker; the new project becomes the selected one.
    await answerOpenDialog(app, beta);
    await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder' });
    await shell.getByTestId('add-project').click();
    await expect.poll(async () => (await shellState(app)).projects.map((p) => p.name)).toEqual(['alpha', 'beta']);
    const betaKey = await projectKeyOf(app, 'beta');
    await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(betaKey);
    await expect(shell.getByTestId('breadcrumb-project')).toHaveText('beta');

    // Selecting alpha in the sidebar brings back its chat.
    await alphaRow.click();
    await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(alphaKey);
    const alpha = await activeChat(app);
    await expect(chatInput(alpha)).toBeVisible();

    // A running turn shows on alpha's row and blocks its removal with a reason.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    stub.replies.push({ chunks: ['Echo: ', 'long turn'], holdAfterFirst: held });
    await chatInput(alpha).fill('long turn');
    await chatInput(alpha).press('Enter');
    await expect(alphaRow.getByTestId('activity-badge')).toHaveText('1 running');
    expect((await shellState(app)).projects.find((p) => p.key === alphaKey)).toMatchObject({ running: 1, waiting: 0 });
    await alphaRow.click({ button: 'right' });
    await chooseMenuItem(app, 'remove');
    await expect(shell.getByTestId('sidebar-projects').getByRole('alert')).toContainText('alpha');
    expect((await shellState(app)).projects.map((p) => p.name)).toEqual(['alpha', 'beta']);
    release();
    await expect(alpha.getByText('Echo: long turn', { exact: true })).toBeVisible();
    await expect(alphaRow.getByTestId('activity-badge')).toHaveCount(0);

    // Idle: removal from the context menu releases alpha's folder runtime.
    await alphaRow.click({ button: 'right' });
    await chooseMenuItem(app, 'remove');
    await expect.poll(() => desktop.output()).toContain(`[FolderRuntime] disposed (cwd=${home.project})`);
    await expect.poll(async () => (await shellState(app)).projects.map((p) => p.name)).toEqual(['beta']);
    await expect(projectRow(shell, alphaKey)).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(path.join(home.userData, 'projects.json'), 'utf8'))).toMatchObject({ projects: [beta] });
  } finally {
    await stub.close();
  }
});

type LaunchHold = typeof globalThis & { __damoclesE2e?: { launchRestore?: { readonly reached: boolean; release(): void } } };

test('a project added while core still sets the home chat up takes that chat at once, as core will, and its chat list loads', async ({ home, launch }) => {
  // The launch's chat restore waits on the hold, so core has not registered the home chat when the project is added.
  const { app } = await launch({ env: { DAMOCLES_E2E_HOOKS: '1', DAMOCLES_E2E_HOLD_CHAT_RESTORE: '1' } });
  await expect.poll(() => app.evaluate(() => (globalThis as LaunchHold).__damoclesE2e?.launchRestore?.reached ?? false)).toBe(true);
  const overlay = await readyOverlay(app);
  const shell = await readyShell(app);
  const homeKey = await selectedProjectKey(app);

  // The shell asks for the home folder's chats by the state it holds, and main adds the project before the request arrives:
  // the shell's page is paused in the debugger between reading its state and asking.
  const debug = await app.context().newCDPSession(shell);
  await debug.send('Debugger.enable');
  const paused = new Promise<void>((resolve) => debug.once('Debugger.paused', () => resolve()));
  const crossed = shell.evaluate(async (key) => {
    const { revision } = await window.damoclesShell!.getState();
    // eslint-disable-next-line no-debugger
    debugger;
    return window.damoclesShell!.listChats(key, revision);
  }, homeKey);
  await paused;
  await answerOpenDialog(app, home.project);
  await clickMenu(app, 'damocles.addProject');
  const question = confirmDialog(overlay);
  await expect(question).toBeVisible();
  await debug.send('Debugger.resume');
  expect(await crossed).toBeNull();
  await debug.detach();

  // While the trust question is open, the selected project's chat list loads and holds the selected chat.
  const alphaKey = await projectKeyOf(app, 'alpha');
  const homeChatId = (await shellState(app)).selected.chatId;
  expect(homeChatId).toBeDefined();
  const listed = await listChats(app);
  expect(listed.projectKey).toBe(alphaKey);
  expect(listed.chats.map((chat) => chat.id)).toContain(homeChatId);
  await expect(chatRow(shell, homeChatId!)).toBeVisible();
  await expect(shell.getByTestId('chats-load-failed')).toHaveCount(0);

  await app.evaluate(() => (globalThis as LaunchHold).__damoclesE2e!.launchRestore!.release());
  const homeChat = await activeChat(app);
  await expect.poll(() => homeChat.evaluate(() => (window.damoclesBridge?.getState() as { workspaceFolderKey?: string } | null | undefined)?.workspaceFolderKey)).toBe(alphaKey);

  await question.getByRole('button', { name: 'Trust Folder' }).click();
  await expect(question).toHaveCount(0);
  await expect(chatInput(await nextChat(app, [homeChat]))).toBeVisible();
  expect((await shellState(app)).selected.projectKey).toBe(alphaKey);
});
