import * as http from 'node:http';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeChat, selectChatPage } from '../desktop/support/fixtures';
import { browserTabs, chromeEnv, openPage, PAGE_TIMEOUT, startSite } from '../desktop/support/browser';
import { writeUserSettings } from '../desktop/support/hermetic';
import { lastToolResult } from '../desktop/support/openai-stub';
import { selectedProjectKey, shellPage, shellState } from '../desktop/support/shell';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { newRemoteChat, startTargetStub } from './support/target-agent';

// A remote chat's BrowserOpen of a project file loads it from this computer's served root of the host's project
// (docs/invariants.md "Ports and the remote browser"): its module script and fetch work, the agent reads only file:// addresses,
// and no other authority's browser context holds the served origin's cookie.

const APP = '/srv/app';
const INDEX = '<!doctype html><html><head><meta charset="utf-8"><title>served loading</title><script type="module" src="app.js"></script></head><body><h1>Served</h1></body></html>';
const APP_JS = 'const data = await fetch("data.json").then((response) => response.json());\ndocument.title = "served:" + data.value + location.search + location.hash;\n';
const SERVED_TITLE = 'served:host data?tab=2#intro';

// the shown permission card: one that answered leaves through a transition while the next one enters
const permissionCard = (tab: Page): Locator => tab.locator('section[role="region"][aria-label="Permission request"]:not([class*="-leave-"])');

// Answers Yes to every permission card the turn raises until `text` shows in the chat.
async function approveUntil(tab: Page, text: string): Promise<void> {
  await expect.poll(async () => {
    if (await tab.getByText(text).isVisible()) return true;
    const card = permissionCard(tab);
    if (await card.isVisible()) await card.getByRole('option', { name: 'Yes', exact: true }).click();
    return false;
  }, { timeout: PAGE_TIMEOUT, intervals: [500] }).toBe(true);
}

async function selectProject(app: ElectronApplication, projectKey: string): Promise<void> {
  await (await shellPage(app)).evaluate((target) => window.damoclesShell!.selectProject(target), projectKey);
  await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(projectKey);
}

function get(url: string): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, { agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

test('a remote chat\'s BrowserOpen of a project file runs its module script and fetch from the served root, answers in file:// form, and no other context reaches it', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  writeUserSettings(home, { 'damocles.browser.enabled': true });
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture);
  const site = await startSite(() => 'local page');
  try {
    await fixture.sh(`mkdir -p ${APP} && cat > ${APP}/index.html`, 'dev', INDEX);
    await fixture.sh(`cat > ${APP}/app.js`, 'dev', APP_JS);
    await fixture.sh(`printf '{ "value": "host data" }\\n' > ${APP}/data.json`, 'dev');
    const { app } = await launch({ env: { ...remoteEnv(ssh, mirror), ...chromeEnv() } });
    const localTab = await activeChat(app);
    const localProject = await selectedProjectKey(app);
    // a page keeps the local chat loaded while the remote project is selected
    await openPage(app, localTab, `${site.url}/`);
    const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
    await openRemoteFolder(app, hostId, APP);
    const key = await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    const tab = await newRemoteChat(app, key);

    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'ToolSearch', arguments: { tools: ['browser'] } }] },
      { chunks: [], toolCalls: [{ name: 'BrowserOpen', arguments: { url: `file://${APP}/index.html?tab=2#intro` } }] },
      { chunks: ['The page is open.'] },
    );
    await sendPrompt(tab, 'open the project page');
    await approveUntil(tab, 'The page is open.');

    // the module script ran and fetched the project's data, with the address's query and fragment
    await expect.poll(async () => (await browserTabs(app)).map((page) => page.title), { timeout: PAGE_TIMEOUT }).toContain(SERVED_TITLE);
    const served = (await browserTabs(app)).find((page) => page.title === SERVED_TITLE)!;
    const origin = new URL(served.browser.url).origin;
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // the agent reads the file:// address only: no loopback port, open path or token
    const answer = lastToolResult(stub);
    expect(answer).toContain(`file://${APP}/index.html?tab=2#intro`);
    expect(answer).not.toMatch(/127\.0\.0\.1|localhost:\d|__damocles_preview|[?&]t=/);

    // without the cookie the served origin answers nothing of the project, and another authority's context (a local chat's)
    // holds no cookie for it
    const bare = await get(`${origin}/index.html`);
    expect(bare.status).toBe(403);
    expect(bare.body).not.toContain('Served');
    await selectProject(app, localProject);
    await selectChatPage(app, localTab);
    await openPage(app, localTab, `${origin}/index.html`);
    const local = (await browserTabs(app)).find((page) => page.browser.url.startsWith(origin));
    expect(local?.title).not.toMatch(/^served/);

    await selectProject(app, key);
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await stub.close();
    await site.close();
  }
});
