import * as fs from 'node:fs';
import * as path from 'node:path';
import { activeChat, expect, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { shellState } from './support/shell';
import { addProject, answerMessageBoxes, answerOpenDialog, chatInput, messageBoxes, TRUST_PROMPT } from './support/ui';
import { projectKeyOf, projectRow, readyShell } from './support/shell-ui';
import { chooseMenuItem } from './support/overlay';

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
    expect((await messageBoxes(app)).filter((b) => b.message.startsWith(TRUST_PROMPT))).toHaveLength(1);
    const alphaKey = await projectKeyOf(app, 'alpha');
    const alphaRow = projectRow(shell, alphaKey);
    await expect(alphaRow).toHaveAttribute('aria-selected', 'true');
    await expect(shell.getByTestId('breadcrumb-project')).toHaveText('alpha');
    await expect(alphaRow.getByTestId('untrusted-badge')).toHaveText('Untrusted');

    // The Untrusted badge opens the same native trust prompt.
    await answerMessageBoxes(app, { [TRUST_PROMPT]: 'Trust Folder' });
    await alphaRow.getByTestId('untrusted-badge').click();
    await expect.poll(async () => (await shellState(app)).projects[0]?.trusted).toBe(true);
    await expect(alphaRow.getByTestId('untrusted-badge')).toHaveCount(0);

    // Add project (folder-plus) opens the folder picker; the new project becomes the selected one.
    await answerOpenDialog(app, beta);
    await answerMessageBoxes(app, { [TRUST_PROMPT]: 'Trust Folder' });
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

    // A running turn shows on alpha's row and blocks its removal with a reason. The title request may take one held reply first.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    stub.replies.push({ chunks: ['Echo: ', 'long turn'], holdAfterFirst: held }, { chunks: ['Echo: ', 'long turn'], holdAfterFirst: held });
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
