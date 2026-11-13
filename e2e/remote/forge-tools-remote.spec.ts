import * as dns from 'node:dns/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import type { DesktopApp } from '../desktop/support/app';
import { agentBash } from '../desktop/support/agent-bash';
import { createTestPki } from '../desktop/support/certs';
import { CI_FIXTURES, PLANTED_LOG_TOKEN, secretsIn, startForgeStub, type ForgeStub } from '../desktop/support/forge-stub';
import { writeUserSettings } from '../desktop/support/hermetic';
import { call, chatRequests, type OpenAIStub } from '../desktop/support/openai-stub';
import { closeSettingsModal, openSettingsModal } from '../desktop/support/settings';
import type { ToolsSnapshot } from '../../src/shared/types/tools';
import { awaitTurnEnd, chatInput, hostMessages, postFromWebview, recordHostMessages } from '../desktop/support/ui';
import { trustCa } from './support/credentials';
import { daemonPids, shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, expect, hostLogs, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { closeRemoteDialog, exited, requestQuit, targetCoreLog, targetSessions } from './support/remote-runs';
import { HOST_FROM_CONTAINER, TARGET_USER } from './support/sshd';
import { newRemoteChat, startTargetStub } from './support/target-agent';

// GitHub and GitLab accounts in a remote chat on an SSH target: the daemon core's forge tools run through the
// user.forge relay on this computer's accounts, the approval card names the host in its title, the refused-git notice lists
// this computer's accounts, and no token reaches the target. The stub's gitlab.com is reached as host.docker.internal.

const APP = '/srv/app';
const GITLAB = 'gitlab.com';
const REPO = 'alexios-s/damocles';
const TOKENS = { 'alexios-s': 'glpat-stubAlexiosSApi000000008', 'work-alexios': 'glpat-stubWorkAlexiosApi000001' } as const;
const MR = CI_FIXTURES.mergeRequest;
const REMOTE_TITLE = `prod-1 Comment on merge request !${MR.number}?`;
const DETACHED = 'Your GitHub and GitLab accounts are on your computer, and Damocles is closed.';
const OFF_HERE = 'GitHub and GitLab tools are off on the computer that shows this chat.';
const CHECKED = { timeout: 60_000 };

// as forge-credential-relay.spec.ts: where this computer's core and the target both reach the stub
async function stubAddress(): Promise<string> {
  if (process.platform !== 'linux') return '0.0.0.0';
  return (await dns.lookup(HOST_FROM_CONTAINER)).address;
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

async function turn(tab: Page, openai: OpenAIStub, prompt: string, ...replies: Parameters<OpenAIStub['replies']['push']>): Promise<void> {
  openai.replies.push(...replies);
  await chatInput(tab).fill(prompt);
  await chatInput(tab).press('Enter');
  await expect(chatInput(tab)).toHaveValue('');
  await expect(tab.getByText(`Echo: ${prompt}`, { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);
}

async function tokenSignIn(desktop: DesktopApp): Promise<void> {
  const overlay = await openSettingsModal(desktop.app, 'accounts');
  await expect(overlay.getByTestId('forge-loading')).toHaveCount(0);
  for (const [login, token] of Object.entries(TOKENS)) {
    await overlay.getByRole('button', { name: `Add account: ${GITLAB}`, exact: true }).click();
    await overlay.getByRole('radio', { name: 'Token', exact: true }).click();
    await overlay.getByLabel('Personal access token', { exact: true }).fill(token);
    await overlay.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(overlay.getByText(`Signed in as ${login}`, { exact: true })).toBeVisible();
  }
  await closeSettingsModal(overlay);
}

const comments = (stub: ForgeStub): { login: string; body: string }[] => stub.gitlab.forgeWrites
  .filter((write) => write.method === 'POST' && write.path.endsWith(`/merge_requests/${MR.number}/notes`))
  .map((write) => ({ login: write.login, body: String((write.body as { body?: unknown }).body) }));

test('forge tools in a remote chat run through the relay on this computer\'s accounts, with no token on the target, and say why when the group is off here or Damocles is closed', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(900_000);
  const fixture = await sshd('prod-1');
  const openai = await startTargetStub(home, fixture);
  const closers: (() => Promise<void>)[] = [() => openai.close()];
  try {
    const pki = createTestPki([HOST_FROM_CONTAINER, 'localhost']);
    const caFile = path.join(home.root, 'forge-test-ca.pem');
    fs.writeFileSync(caFile, pki.caCertPem);
    const stub = await startForgeStub({ cert: pki.leafCertPem, key: pki.leafKeyPem, ca: pki.caCertPem, listenAddress: await stubAddress(), publicHost: HOST_FROM_CONTAINER });
    closers.push(() => stub.close());
    await trustCa(fixture, pki.caCertPem);
    writeUserSettings(home, { 'damocles.desktop.git.autofetch': false });
    const env = {
      env: {
        ...remoteEnv(ssh, mirror),
        DAMOCLES_E2E_HOOKS: '1',
        DAMOCLES_E2E_FORGE_SERVERS: stub.e2eServersEnv(),
        NODE_EXTRA_CA_CERTS: caFile,
      },
    };
    await fixture.sh([
      "git config --global user.name 'E2E Dev'",
      'git config --global user.email dev@prod-1.invalid',
      `git init -q -b main ${APP}`,
      `cd ${APP}`,
      'echo one > a.txt && git add -A && git commit -q -m init',
      `git remote add origin '${stub.gitlab.webUrl}/${REPO}.git'`,
    ].join(' && '), TARGET_USER);

    const first = await launch(env);
    // both accounts can push to alexios-s/damocles, so a tool call resolves none without the user
    await tokenSignIn(first);
    const hostId = await addHost(first.app, { alias: 'prod-1', name: 'prod-1' });
    await openRemoteFolder(first.app, hostId, APP);
    const key = await remoteProjectKey(first.app, { authorityKey: `ssh+${hostId}` }, APP);
    const tab = await newRemoteChat(first.app, key);

    // the refused-git notice in a remote chat lists this computer's accounts, and choosing one binds the remote project here
    await turn(tab, openai, 'Comment on the merge request.', call('ToolSearch', { tools: ['forge'] }), call('ForgeComment', { number: MR.number, body: 'from prod-1' }));
    expect(toolResults(openai)[0]).toMatch(/^Loaded \d+ tools: .*ForgeComment/);
    const notice = tab.getByTestId('forge-refused-notice');
    await expect(notice).toHaveAttribute('data-reason', 'noAccount', CHECKED);
    await notice.getByRole('button', { name: 'Choose account', exact: true }).click();
    const menu = tab.getByRole('menu', { name: `Account for ${GITLAB}`, exact: true });
    await expect(menu.getByRole('menuitemradio')).toHaveCount(2);
    await expect(menu.getByRole('menuitemradio', { name: 'alexios-s, Agent shells not allowed', exact: true })).toBeVisible();
    await menu.getByRole('menuitemradio', { name: 'work-alexios, Agent shells not allowed', exact: true }).click();
    await expect(tab.getByText(/ now uses work-alexios$/)).toBeVisible(CHECKED);
    expect(comments(stub)).toEqual([]);

    // the card's title carries the host badge; Enter posts once through the relay as the chosen account
    openai.replies.push(call('ForgeComment', { number: MR.number, body: 'from prod-1' }), { chunks: ['Commented from prod-1.'] });
    await chatInput(tab).fill('Try again.');
    await chatInput(tab).press('Enter');
    const options = tab.getByRole('listbox', { name: REMOTE_TITLE, exact: true });
    await expect(options).toBeVisible(CHECKED);
    await expect(tab.getByTestId('permission-title').getByTestId('host-name-badge')).toHaveText('prod-1');
    await expect(tab.getByRole('region', { name: 'Comment text', exact: true })).toHaveText('from prod-1');
    await options.press('Enter');
    await expect(tab.getByText(`Allowed once. Posting the comment to !${MR.number} as work-alexios on ${GITLAB}.`, { exact: true })).toBeVisible();
    await expect(tab.getByText('Commented from prod-1.', { exact: true })).toBeVisible(CHECKED);
    await awaitTurnEnd(tab);
    expect(comments(stub)).toEqual([{ login: 'work-alexios', body: 'from prod-1' }]);

    // reads through the relay: bounded, redacted text, and no temp file path on this computer
    await turn(tab, openai, 'Why did CI fail?', call('ForgePipelines', {}), call('ForgeJobLog', { job: CI_FIXTURES.jobs.e2e }));
    const [pipelines, log] = toolResults(openai).slice(-2);
    expect(pipelines).toContain(String(CI_FIXTURES.pipeline.id));
    expect(pipelines).toContain('work-alexios');
    expect(log).toContain('rotates once per account');
    expect(log).toContain('[redacted]');
    expect(log).not.toContain(PLANTED_LOG_TOKEN);
    expect(log).not.toContain('Full output:');

    // no token in the agent's environment on the target
    await agentBash(tab, openai, 'env', 'Show the environment.');
    const shellEnv = toolResults(openai).at(-1)!;
    expect(shellEnv).toContain('HOME=');
    expect(shellEnv).not.toMatch(/(GITLAB_TOKEN|GH_TOKEN|GITHUB_TOKEN|GITLAB_PRIVATE_TOKEN)=/);

    // the group switched off on this computer: the relay refuses with the reason once main reads the edited settings file
    writeUserSettings(home, { 'damocles.desktop.forge.agentTools': false });
    let attempt = 0;
    await expect(async () => {
      attempt += 1;
      await turn(tab, openai, `Check CI again (${attempt}).`, call('ForgePipelines', {}));
      expect(toolResults(openai).at(-1)).toContain(OFF_HERE);
    }).toPass({ timeout: 120_000 });
    writeUserSettings(home, { 'damocles.desktop.forge.agentTools': true });

    // a run that continues after quit: the tool says the accounts are on a computer where Damocles is closed
    const releases: (() => void)[] = [];
    openai.replies.push(
      { chunks: ['Checking CI.', ' Now.'], holds: [{ before: 1, until: new Promise<void>((resolve) => releases.push(resolve)) }], toolCalls: [{ name: 'ForgePipelines', arguments: {} }] },
      { chunks: ['Checked while you were away.'] },
    );
    await chatInput(tab).fill('Check CI while I am away.');
    await chatInput(tab).press('Enter');
    await expect(tab.getByText('Checking CI.', { exact: false })).toBeVisible(CHECKED);
    await requestQuit(first.app);
    const { dialog } = await closeRemoteDialog(first.app);
    await dialog.getByRole('button', { name: 'Keep running' }).click();
    await exited(first);
    expect(await daemonPids(fixture)).toHaveLength(1);
    releases[0]!();
    await expect.poll(() => targetSessions(fixture), { timeout: 120_000 }).toContain('Checked while you were away.');
    const sessions = await targetSessions(fixture);
    expect(sessions).toContain(DETACHED);

    // no token on the target: its sessions, its core's log, its daemon's log and every process environment of the account
    const secrets = [...Object.values(TOKENS), ...stub.gitlab.issuedSecrets(), PLANTED_LOG_TOKEN];
    const environments = await fixture.sh(`for p in /proc/[0-9]*; do [ -O "$p" ] && tr '\\0' '\\n' < "$p/environ" 2>/dev/null; done; true`, TARGET_USER);
    expect(environments).not.toMatch(/(GITLAB_TOKEN|GH_TOKEN|GITHUB_TOKEN|GITLAB_PRIVATE_TOKEN)=/);
    const second = await launch(env);
    await remoteProjectKey(second.app, { authorityKey: `ssh+${hostId}` }, APP);
    // the attach marks this computer's forge servers not read yet until its core read its forge files, so the turn waits for
    // the remote core's Tools status to show the group loadable for this device
    const relaunched = await newRemoteChat(second.app, key);
    await recordHostMessages(relaunched);
    await expect.poll(async () => {
      await postFromWebview(relaunched, { type: 'requestToolStatus' });
      const status = (await hostMessages(relaunched, 'toolStatus')).at(-1)?.['data'] as ToolsSnapshot | undefined;
      return status?.groups.find((group) => group.group === 'forge')?.available;
    }, CHECKED).toBe(true);
    await turn(relaunched, openai, 'Load the forge tools after the relaunch.', call('ToolSearch', { tools: ['forge'] }));
    expect(toolResults(openai).at(-1)).toMatch(/^Loaded \d+ tools: .*ForgePipelines/);
    const daemonLog = (await hostLogs(second.app, hostId)).daemon;
    for (const [where, text] of Object.entries({ sessions, core: await targetCoreLog(fixture), daemon: daemonLog, environments, shellEnv })) {
      expect(secretsIn(text, secrets), where).toEqual([]);
    }
    await shutdownHostDaemon(second.app, hostId, fixture);
  } finally {
    while (closers.length > 0) await closers.pop()!();
  }
});
