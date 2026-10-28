import type { Page } from '@playwright/test';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { overlayPage } from '../desktop/support/shell';
import { awaitTurnEnd } from '../desktop/support/ui';
import { browserEntry, pickBrowser } from './support/connect-ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, expect, openRemoteFolder, pickOnHost, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { newRemoteChat, startTargetStub } from './support/target-agent';

const APP = '/srv/app';
const PLAN = 'plan-from-prod-1-5c1e';

/** Binds a plan through the chat's Bind a plan file… overlay and its Browse, which asks the core's pickFile. */
async function browseForPlan(tab: Page): Promise<void> {
  await tab.getByTestId('chat-header-more').click();
  await tab.getByTestId('chat-header-more-menu').getByRole('menuitem', { name: 'Bind a plan file…' }).click();
  await tab.getByTestId('bind-plan-overlay').getByTestId('bind-plan-browse').click();
}

test('a remote core\'s pickFolder and pickFile open the host\'s folder browser inside its projects and answer the chosen target path, cancel answers undefined, and a plan bound through Browse is read on the target', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  await fixture.sh(`mkdir -p ${APP}/src/deep && printf '# ${PLAN}\\n' > ${APP}/plan.md && printf 'x\\n' > ${APP}/src/a.ts`, 'dev');
  const stub = await startTargetStub(home, fixture);
  try {
    const { app } = await launch({ env: remoteEnv(ssh, mirror) });
    const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
    const authority = `ssh+${hostId}`;
    const key = await openRemoteFolder(app, hostId, APP);
    await remoteProjectKey(app, { authorityKey: authority }, APP);
    const overlay = await overlayPage(app);

    // pickFolder: the browser in folder mode, named with the host and the core's title, lists folders only, offers only the
    // project's root, and answers the folder entered.
    let answer = pickOnHost(app, authority, 'folder', { title: 'Pick a folder', defaultPath: APP, buttonLabel: 'Use Folder' });
    const folders = pickBrowser(overlay, 'folder');
    await expect(folders).toBeVisible();
    await expect(folders).toHaveAccessibleName('prod-1: Pick a folder');
    await expect(folders.getByTestId('recent-folder')).toHaveText([APP]);
    await expect(browserEntry(folders, 'src')).toHaveAttribute('data-kind', 'folder');
    await expect(browserEntry(folders, 'plan.md')).toHaveCount(0);
    await browserEntry(folders, 'src').dblclick();
    await expect(browserEntry(folders, 'deep')).toBeVisible();
    await folders.getByTestId('folder-browser-confirm').click();
    expect(await answer).toBe(`${APP}/src`);
    await expect(folders).toHaveCount(0);

    // Escape and Cancel answer undefined.
    answer = pickOnHost(app, authority, 'folder', {});
    await expect(pickBrowser(overlay, 'folder')).toHaveAccessibleName('Choose a folder on prod-1');
    await overlay.keyboard.press('Escape');
    expect(await answer).toBeUndefined();
    answer = pickOnHost(app, authority, 'file', { defaultPath: APP });
    const files = pickBrowser(overlay, 'file');
    await expect(files).toHaveAccessibleName('Choose a file on prod-1');
    await files.getByTestId('folder-browser-cancel').click();
    expect(await answer).toBeUndefined();
    await expect(files).toHaveCount(0);

    // A default path outside the host's projects opens at the project instead, never above it.
    answer = pickOnHost(app, authority, 'file', { defaultPath: '/etc' });
    await expect(browserEntry(files, 'plan.md')).toHaveAttribute('data-kind', 'file');
    await expect(browserEntry(files, 'passwd')).toHaveCount(0);
    await browserEntry(files, 'plan.md').click();
    await files.getByTestId('folder-browser-confirm').click();
    expect(await answer).toBe(`${APP}/plan.md`);

    // The real caller: Bind a plan file…'s Browse asks the core's pickFile, and the core reads the chosen file on the target.
    const tab = await newRemoteChat(app, key);
    await sendPrompt(tab, 'Start a session');
    await expect(tab.getByText('Echo: Start a session', { exact: true })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    await browseForPlan(tab);
    await expect(files).toBeVisible();
    await expect(files).toHaveAccessibleName('prod-1: Select Plan File to Inject');
    await browserEntry(files, 'plan.md').dblclick();
    await expect(files).toHaveCount(0);
    // the plan file the core wrote in the target's ~/.damocles from the chosen file's text
    const planFiles = async (): Promise<string[]> => (await fixture.sh(`grep -rl --include='*.md' '${PLAN}' /home/dev/.damocles || true`, 'dev')).trim().split('\n').filter(Boolean);
    await expect.poll(planFiles, { timeout: 30_000 }).toHaveLength(1);

    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await stub.close();
  }
});
