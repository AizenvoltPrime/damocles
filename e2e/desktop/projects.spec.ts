import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { chatTab, expect, nextTab, panelIdOf, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { shellPage, shellState } from './support/shell';
import { addProject, answerMessageBoxes, chatInput, messageBoxes, TRUST_PROMPT } from './support/ui';
import type { RemoveProjectResult } from '../../src/desktop/preload/shell-channels';

async function projectKey(app: ElectronApplication, name: string): Promise<string> {
  const project = (await shellState(app)).projects.find((p) => p.name === name);
  if (!project) throw new Error(`no project ${name}`);
  return project.key;
}

test('projects: adding asks for trust once, trust can be granted later, the default project opens new tabs, removal is refused while a session runs and otherwise releases the runtime', async ({ home, launch }) => {
  test.setTimeout(180_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const beta = path.join(path.dirname(home.project), 'beta');
    fs.mkdirSync(beta, { recursive: true });

    const desktop = await launch();
    const { app } = desktop;
    const homeTab = await chatTab(app);
    await expect(chatInput(homeTab)).toBeVisible();
    const shell = await shellPage(app);

    // Adding asks once; declining leaves the project listed and untrusted.
    const alphaOpened = nextTab(app, [homeTab]);
    await addProject(app, home.project, false);
    const alpha = await alphaOpened;
    await expect(chatInput(alpha)).toBeVisible();
    expect((await messageBoxes(app)).filter((b) => b.message.startsWith(TRUST_PROMPT))).toHaveLength(1);
    const alphaKey = await projectKey(app, 'alpha');
    expect((await shellState(app)).projects).toEqual([expect.objectContaining({ name: 'alpha', fsPath: home.project, trusted: false })]);

    // Granting later from the shell goes through the same native prompt.
    await answerMessageBoxes(app, { [TRUST_PROMPT]: 'Trust Folder' });
    await shell.evaluate((key) => window.damoclesShell!.grantTrust(key), alphaKey);
    await expect.poll(async () => (await shellState(app)).projects[0]?.trusted).toBe(true);

    const betaOpened = nextTab(app, app.windows());
    await addProject(app, beta, true);
    await expect(chatInput(await betaOpened)).toBeVisible();
    const betaKey = await projectKey(app, 'beta');

    // Selecting a project makes it the default for new tabs; open tabs keep their project.
    await shell.evaluate((key) => window.damoclesShell!.selectProject(key), betaKey);
    await expect.poll(async () => (await shellState(app)).projects.find((p) => p.isDefault)?.key).toBe(betaKey);
    const defaultOpened = nextTab(app, app.windows());
    await shell.evaluate(() => window.damoclesShell!.newTab());
    const defaultTab = await defaultOpened;
    await expect(chatInput(defaultTab)).toBeVisible();
    await expect.poll(async () => (await shellState(app)).tabs.find((t) => t.id === panelIdOf(defaultTab))?.projectKey).toBe(betaKey);
    expect((await shellState(app)).tabs.find((t) => t.id === panelIdOf(alpha))?.projectKey).toBe(alphaKey);

    // A running turn in alpha blocks its removal with a reason. The title request may take one held reply first.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    stub.replies.push({ chunks: ['Echo: ', 'long turn'], holdAfterFirst: held }, { chunks: ['Echo: ', 'long turn'], holdAfterFirst: held });
    await chatInput(alpha).fill('long turn');
    await chatInput(alpha).press('Enter');
    await expect.poll(async () => (await shellState(app)).tabs.find((t) => t.id === panelIdOf(alpha))?.busy).toBe(true);
    const refused = await shell.evaluate((key) => window.damoclesShell!.removeProject(key), alphaKey) as RemoveProjectResult;
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.reason).toContain('alpha');
    expect((await shellState(app)).projects.map((p) => p.name)).toEqual(['alpha', 'beta']);
    release();
    await expect(alpha.getByText('Echo: long turn', { exact: true })).toBeVisible();
    await expect.poll(async () => (await shellState(app)).tabs.find((t) => t.id === panelIdOf(alpha))?.busy).toBe(false);

    // Idle: removal releases alpha's folder runtime and moves its tab to the remaining project.
    const removed = await shell.evaluate((key) => window.damoclesShell!.removeProject(key), alphaKey) as RemoveProjectResult;
    expect(removed).toEqual({ ok: true });
    await expect.poll(() => desktop.output()).toContain(`[FolderRuntime] disposed (cwd=${home.project})`);
    await expect.poll(async () => (await shellState(app)).projects.map((p) => p.name)).toEqual(['beta']);
    await expect.poll(async () => (await shellState(app)).tabs.find((t) => t.id === panelIdOf(alpha))?.projectKey).toBe(betaKey);
    expect(JSON.parse(fs.readFileSync(path.join(home.userData, 'projects.json'), 'utf8'))).toMatchObject({ projects: [beta] });
  } finally {
    await stub.close();
  }
});
