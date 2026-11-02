import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { expectNoAxeViolations } from '../desktop/support/axe';
import { activeChat, selectChatPage } from '../desktop/support/fixtures';
import { settled } from '../desktop/support/screenshots';
import { settingsModal, settingsRow } from '../desktop/support/settings';
import { overlayPage } from '../desktop/support/shell';
import { shootThemes } from './support/review-shots';
import { readUserSettings } from '../desktop/support/hermetic';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { agentRequests, type OpenAIStub } from '../desktop/support/openai-stub';
import { awaitTurnEnd } from '../desktop/support/ui';
import { daemonPids, shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { closeRemoteDialog, exited, requestQuit, targetCoreLog, targetSessions } from './support/remote-runs';
import { TARGET_HOME, TARGET_USER } from './support/sshd';
import { newRemoteChat, startTargetStub } from './support/target-agent';

const APP = '/srv/app';
const SERVER_SOURCE = fs.readFileSync(path.join(__dirname, 'support', 'mcp-notes-server.cjs'), 'utf8');
// the personal server's secret, which must never reach the target
const CLIENT_SECRET = 'client-secret-7c1f2e';
const REMOTE_AVAILABLE = 'damocles.desktop.mcp.remoteAvailable';

const post = (tab: Page, message: Record<string, unknown>): Promise<void> => tab.evaluate((m) => window.damoclesBridge!.postMessage(m), message);

/** Opens the chat page's MCP panel, as its header's MCP button does. */
async function openMcpPanel(tab: Page): Promise<ReturnType<Page['getByTestId']>> {
  await tab.evaluate(() => {
    type PiniaHost = { __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, { openMcpPanel(): void }> } } } } };
    (document.querySelector('#app') as unknown as PiniaHost).__vue_app__.config.globalProperties.$pinia._s.get('ui')!.openMcpPanel();
  });
  const panel = tab.getByTestId('mcp-panel');
  await expect(panel).toBeVisible();
  await settled(tab);
  return panel;
}

const serverRow = (panel: ReturnType<Page['getByTestId']>, name: string) => panel.getByTestId('mcp-server-row').filter({ hasText: name });

/** Every agent request so far, as the text the model received. */
const agentText = (stub: OpenAIStub): string => agentRequests(stub).map((request) => JSON.stringify(request.body)).join('\n');

/** The tools the last agent request offered the model. */
const offeredTools = (stub: OpenAIStub): string[] =>
  ((agentRequests(stub).at(-1)?.body as { tools?: Array<{ function?: { name?: string } }> } | undefined)?.tools ?? []).map((tool) => tool.function?.name ?? '');

test('a personal MCP server marked available runs on this computer for a remote chat, tools and resources, and the target never sees its env; an unmarked one is invisible there; a run that continues after quit uses the target\'s own machine server', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  // two personal servers on this computer: one the user marks for remote hosts, one they do not
  const server = path.join(home.root, 'mcp-notes-server.cjs');
  fs.writeFileSync(server, SERVER_SOURCE);
  fs.writeFileSync(path.join(home.damoclesDir, 'mcp.json'), JSON.stringify({
    mcpServers: {
      personal: { command: process.execPath, args: [server], env: { NOTES_TOKEN: CLIENT_SECRET } },
      private: { command: process.execPath, args: [server], env: { NOTES_TOKEN: CLIENT_SECRET } },
    },
  }));
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture);
  try {
    const env = { env: remoteEnv(ssh, mirror) };
    const first = await launch(env);
    const localTab = await activeChat(first.app);
    await post(localTab, { type: 'mcpSetRemoteAvailable', serverName: 'personal', available: true });
    await expect.poll(() => readUserSettings(home)[REMOTE_AVAILABLE]).toEqual(['personal']);
    // this computer's MCP panel: each personal server has its switch, the marked one on
    const localPanel = await openMcpPanel(localTab);
    await expect(serverRow(localPanel, 'personal').getByTestId('mcp-remote-available-toggle')).toHaveAttribute('aria-checked', 'true');
    await expect(serverRow(localPanel, 'private').getByTestId('mcp-remote-available-toggle')).toHaveAttribute('aria-checked', 'false');
    await shootThemes(first.app, localTab, 'mcp-local-remote-available', localPanel);
    await localTab.keyboard.press('Escape');

    const hostId = await addHost(first.app, { alias: 'prod-1', name: 'prod-1' });
    await openRemoteFolder(first.app, hostId, APP);
    const key = await remoteProjectKey(first.app, { authorityKey: `ssh+${hostId}` }, APP);
    // the target's own machine server, which needs no secret of this computer
    const node = (await fixture.sh(`ls -d ${TARGET_HOME}/.damocles/server/*/node/node | head -n 1`, TARGET_USER)).trim();
    await fixture.sh(`cat > ${TARGET_HOME}/notes-server.cjs`, TARGET_USER, SERVER_SOURCE);
    await fixture.sh(`cat > ${TARGET_HOME}/.damocles/mcp.json`, TARGET_USER, JSON.stringify({ mcpServers: { machine: { command: node, args: [`${TARGET_HOME}/notes-server.cjs`] } } }));
    const tab = await newRemoteChat(first.app, key);
    const targetName = (await fixture.sh('hostname', TARGET_USER)).trim();

    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'ToolSearch', arguments: { tools: ['personal', 'machine', 'mcp_resources'] } }] },
      { chunks: [], toolCalls: [{ name: 'mcp__personal__whoami', arguments: {} }] },
      { chunks: [], toolCalls: [{ name: 'list_mcp_resources', arguments: {} }] },
      { chunks: [], toolCalls: [{ name: 'read_mcp_resource', arguments: { server: 'personal', uri: 'notes://today' } }] },
      { chunks: [], toolCalls: [{ name: 'mcp__machine__whoami', arguments: {} }] },
      { chunks: ['All checked.'] },
    );
    await sendPrompt(tab, 'check my notes servers');
    await expect(tab.getByText('All checked.')).toBeVisible({ timeout: 120_000 });
    await awaitTurnEnd(tab);
    const seen = agentText(stub);
    // the marked server ran on this computer with its env; the machine server ran on the target with none
    expect(seen).toContain(`whoami ran on ${os.hostname()} with the token set`);
    expect(seen).toContain(`today's notes, read on ${os.hostname()} with the token set`);
    expect(seen).toContain(`whoami ran on ${targetName} with the token unset`);
    // the unmarked server is nowhere on the target: no tool, no resource server
    expect(offeredTools(stub).filter((name) => name.startsWith('mcp__private'))).toEqual([]);
    expect(seen).not.toContain('"server":"private"');
    expect(seen).not.toContain('mcp__private__');


    // the remote chat's MCP panel: where each server runs, the relayed one read-only, and the way to the host's tab
    await selectChatPage(first.app, tab);
    const remotePanel = await openMcpPanel(tab);
    await expect(serverRow(remotePanel, 'personal').getByTestId('mcp-server-placement')).toHaveAttribute('data-placement', 'client');
    await expect(serverRow(remotePanel, 'machine').getByTestId('mcp-server-placement')).toHaveAttribute('data-placement', 'host');
    await expect(serverRow(remotePanel, 'machine').getByTestId('mcp-server-placement')).toHaveText('prod-1');
    await expect(serverRow(remotePanel, 'personal').getByTestId('mcp-relayed-note')).toBeVisible();
    await expect(serverRow(remotePanel, 'private')).toHaveCount(0);
    await expect(remotePanel.getByTestId('mcp-host-settings-note')).toBeVisible();
    await expectNoAxeViolations(tab, '[data-testid="mcp-panel"]');
    await shootThemes(first.app, tab, 'mcp-remote-chat', remotePanel);

    // the host's tab of the settings: the target's machine servers, edited there
    await remotePanel.getByTestId('mcp-open-host-settings').click();
    const overlay = await overlayPage(first.app);
    await expect(settingsModal(overlay)).toBeVisible();
    const hostRow = settingsRow(overlay, 'mcpHostServers');
    await expect(hostRow).toBeVisible({ timeout: 30_000 });
    await hostRow.getByTestId('mcp-host-servers-open').click();
    const hostPanel = overlay.getByTestId('mcp-panel');
    await expect(serverRow(hostPanel, 'machine')).toBeVisible();
    // exposure there is saved to the host's own settings, named after the host, and takes effect at once
    await expect(hostPanel.getByTestId('mcp-tool-exposure-scope')).toHaveText('prod-1 settings');
    await serverRow(hostPanel, 'machine').getByRole('button', { name: 'Show tools and resources' }).click();
    await serverRow(hostPanel, 'machine').getByTestId('mcp-tool-exposure').locator('[data-exposure="direct"]').click();
    await expect.poll(async () => JSON.parse(await fixture.sh(`cat ${TARGET_HOME}/.damocles/settings.json 2>/dev/null || echo '{}'`, TARGET_USER))['damocles.mcp.toolExposure']).toEqual({ machine: { whoami: 'direct' } });
    await expect(serverRow(hostPanel, 'machine').getByTestId('mcp-tool-exposure-source')).toHaveText('prod-1 settings');
    expect(readUserSettings(home)['damocles.mcp.toolExposure']).toBeUndefined();
    await expectNoAxeViolations(overlay, '[data-testid="mcp-panel"]');
    await settled(overlay);
    await shootThemes(first.app, overlay, 'mcp-host-tab', settingsModal(overlay));
    await hostPanel.getByTestId('mcp-add-server').click();
    await settled(overlay);
    await shootThemes(first.app, overlay, 'mcp-host-tab-add-server', settingsModal(overlay));
    await overlay.keyboard.press('Escape');
    // Escape closes the host panel, then the settings
    await overlay.keyboard.press('Escape');
    await expect(hostPanel).toBeHidden();
    await overlay.keyboard.press('Escape');
    await expect(settingsModal(overlay)).toBeHidden();
    await tab.keyboard.press('Escape');

    // a run that continues after quit: the machine server answers, the personal one says its computer is away
    const releases: Array<() => void> = [];
    stub.replies.push(
      { chunks: ['Checking again.', ' Now.'], holds: [{ before: 1, until: new Promise<void>((resolve) => releases.push(resolve)) }], toolCalls: [{ name: 'mcp__machine__whoami', arguments: {} }] },
      { chunks: [], toolCalls: [{ name: 'mcp__personal__whoami', arguments: {} }] },
      { chunks: ['Checked while you were away.'] },
    );
    await sendPrompt(tab, 'check them again');
    await expect(tab.getByText('Checking again.', { exact: false })).toBeVisible({ timeout: 60_000 });
    await requestQuit(first.app);
    const { dialog } = await closeRemoteDialog(first.app);
    await dialog.getByRole('button', { name: 'Keep running' }).click();
    await exited(first);
    expect(await daemonPids(fixture)).toHaveLength(1);
    releases[0]!();
    await expect.poll(() => targetSessions(fixture), { timeout: 120_000 }).toContain('Checked while you were away.');
    const sessions = await targetSessions(fixture);
    expect(sessions.split(`whoami ran on ${targetName} with the token unset`).length - 1).toBe(2);
    expect(sessions).toContain('The MCP server personal runs on your computer and Damocles is closed.');

    // nothing of the personal server's config reached the target
    for (const text of [sessions, await targetCoreLog(fixture), await fixture.sh(`cat ${TARGET_HOME}/.damocles/mcp.json`, TARGET_USER)]) {
      expect(text).not.toContain(CLIENT_SECRET);
      expect(text).not.toContain(server.replaceAll('\\', '\\\\'));
    }

    const second = await launch(env);
    await remoteProjectKey(second.app, { authorityKey: `ssh+${hostId}` }, APP);
    await shutdownHostDaemon(second.app, hostId, fixture);
  } finally {
    await stub.close();
  }
});
