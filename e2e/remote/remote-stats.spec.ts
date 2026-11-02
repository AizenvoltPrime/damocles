import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expectNoAxeViolations } from '../desktop/support/axe';
import { activeChat } from '../desktop/support/fixtures';
import { openProjectChat } from '../desktop/support/screenshots';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { selectedProjectKey, shellPage, shellState } from '../desktop/support/shell';
import { awaitTurnEnd } from '../desktop/support/ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteHosts, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { shootThemes } from './support/review-shots';
import { TARGET_USER } from './support/sshd';
import { newRemoteChat, startTargetStub } from './support/target-agent';

const APP = '/srv/app';
// a key only the target's login environment holds, so the run is billed to the host
const HOST_KEY = 'sk-host-env-stats-3b9d';

/** The breakdowns and the top sessions, each captured on its own, where the host labels show. */
async function shootSections(app: ElectronApplication, tab: Page, overlay: Locator, name: string): Promise<void> {
  for (const [part, selector] of [['project', '[data-breakdown="project"]'], ['credential', '[data-breakdown="credential"]'], ['sessions', '[data-top-sessions]']] as const) {
    const section = overlay.locator(selector);
    await section.scrollIntoViewIfNeeded();
    await shootThemes(app, tab, `${name}-${part}`, section);
  }
}

async function openStats(tab: Page): Promise<ReturnType<Page['getByTestId']>> {
  await tab.getByTestId('chat-header-more').click();
  await tab.getByRole('menuitem', { name: /Usage statistics/ }).click();
  const overlay = tab.getByTestId('usage-stats-overlay');
  await expect(overlay).toBeVisible();
  return overlay;
}

test('this computer\'s /stats counts a remote chat\'s turns from the session mirror, labelled with the host\'s name from this computer, its environment\'s spend under "<host>\'s environment", its sub-calls from the mirrored ledger, and a rename relabels them', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  await fixture.sh(`test ! -e ~/.bash_profile && printf 'export OPENAI_API_KEY=%s\\n' '${HOST_KEY}' >> ~/.profile`, TARGET_USER);
  const stub = await startTargetStub(home, fixture, TARGET_USER, false);
  try {
    const { app } = await launch({ env: remoteEnv(ssh, mirror) });
    // a local project, whose chat shows this computer's /stats later
    await openProjectChat(app, home.project);
    const localProject = await selectedProjectKey(app);
    const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
    const key = await openRemoteFolder(app, hostId, APP);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    const tab = await newRemoteChat(app, key);
    // the stub model, which runs on prod-1's environment since this computer holds no OpenAI credential
    await tab.getByTestId('composer-model').click();
    const menu = tab.getByTestId('composer-model-menu');
    await menu.getByTestId('composer-model-option').filter({ hasText: 'GPT-6 Luna' }).click();
    await expect(menu).toBeHidden();
    await sendPrompt(tab, 'Count this turn');
    await expect(tab.getByText('Echo: Count this turn', { exact: true })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);

    // this computer's /stats, on a local chat: the turn arrives through the mirror the settled turn synced
    await (await shellPage(app)).evaluate((target) => window.damoclesShell!.selectProject(target), localProject);
    await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(localProject);
    const localTab = await activeChat(app);
    const projectRow = (overlay: ReturnType<Page['getByTestId']>) => overlay.locator('[data-breakdown="project"] tr[data-row^="project:remote:"]');
    const overlay = await openStats(localTab);
    await expect.poll(async () => {
      if ((await projectRow(overlay).count()) > 0) return true;
      await overlay.getByTestId('stats-refresh').click();
      return false;
    }, { timeout: 120_000, intervals: [2000] }).toBe(true);
    await expect(projectRow(overlay).locator('[data-stats-host]')).toHaveText('prod-1');
    const hostCredential = overlay.locator(`[data-breakdown="credential"] tr[data-row="credential:host:${hostId}"]`);
    await expect(hostCredential).toContainText("prod-1's environment");
    await expectNoAxeViolations(localTab, '[data-testid="usage-stats-overlay"]');
    await shootThemes(app, localTab, 'stats-remote-host', overlay);
    await shootSections(app, localTab, overlay, 'stats-remote-host');

    // a rename on this computer relabels the open page at once; core never named the host
    const shell = await shellPage(app);
    await shell.evaluate(([id, name]) => window.damoclesShell!.renameHost(id!, name!), [hostId, 'billing-prod']);
    await expect.poll(async () => (await remoteHosts(app)).find((host) => host.hostId === hostId)?.name).toBe('billing-prod');
    await expect(projectRow(overlay).locator('[data-stats-host]')).toHaveText('billing-prod');
    await expect(hostCredential).toContainText("billing-prod's environment");
    await shootThemes(app, localTab, 'stats-remote-host-renamed', overlay);
    await shootSections(app, localTab, overlay, 'stats-remote-host-renamed');

    // the turn's AI title is a sub-call billed to prod-1's environment, which only the target's ledger records
    await expect.poll(async () => (await fixture.sh(`cat /home/${TARGET_USER}/.damocles/usage/subcalls.jsonl 2>/dev/null || true`, TARGET_USER)).includes('"purpose":"session-title"'), { timeout: 60_000 }).toBe(true);
    // only a ledger records sub-call rows, so under prod-1's project they come from its mirrored ledger
    await projectRow(overlay).click();
    await expect(overlay.locator('[data-project-chip]')).toHaveText('app on billing-prod');
    const subcalls = overlay.locator('[data-breakdown="source"] tr[data-row="source:background"]');
    await expect.poll(async () => {
      if ((await subcalls.count()) > 0) return true;
      await overlay.getByTestId('stats-refresh').click();
      return false;
    }, { timeout: 120_000, intervals: [2000] }).toBe(true);
    await subcalls.locator('[data-expand]').click();
    await expect(overlay.locator('[data-breakdown="source"] tr[data-row="source:background:session-title"]')).toBeVisible();
    await expect(hostCredential).toContainText("billing-prod's environment");

    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await stub.close();
  }
});
