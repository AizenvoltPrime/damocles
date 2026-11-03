import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { ToolsSnapshot } from '../../src/shared/types/tools';
import { logBeforeQuit, mainLog } from '../desktop/support/app';
import { readUserSettings, type HermeticHome } from '../desktop/support/hermetic';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { closeSettingsModal, openSettingsModal, settingsModal, settingsNav, settingsRow } from '../desktop/support/settings';
import { overlayPage, shellPage } from '../desktop/support/shell';
import { listChats } from '../desktop/support/shell-ui';
import { awaitTurnEnd, hostMessages, postFromWebview, recordHostMessages } from '../desktop/support/ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { expect, test } from './support/flaky';
import { addHost, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG } from './support/remote';
import { chatShowing, targetCoreLog } from './support/remote-runs';
import { TARGET_HOME, TARGET_USER, type SshdFixture } from './support/sshd';
import { newRemoteChat, startTargetStub } from './support/target-agent';

const APP = '/srv/app';
const SETTING_MESSAGES = ['setPinnedHeaderHidden', 'toggleToolGroup', 'toggleTool'] as const;
// The reply is long enough that its prompt scrolls out of view, so the list pins it.
const LONG_REPLY = Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of the long reply.`).join('\n\n');
const LAST_LINE = 'Line 80 of the long reply.';

// main's log lines (src/desktop/main/remote/foreign-view-relay.ts)
const routedLine = (type: string, authority: string): string => `[foreign-view] ${type} from a chat on ${authority} goes to this computer's core`;
const failedLine = (type: string, authority: string): string => `[foreign-view] ${type} from a chat on ${authority} failed:`;

/** The host's own ~/.damocles/settings.json, which only its Settings tab writes; `{}` while it does not exist. */
async function hostSettings(fixture: Pick<SshdFixture, 'sh'>): Promise<Record<string, unknown>> {
  return JSON.parse(await fixture.sh(`cat ${TARGET_HOME}/.damocles/settings.json 2>/dev/null || echo '{}'`, TARGET_USER)) as Record<string, unknown>;
}

/** Opens the chat page's Tools panel and asks its core for the status, as the header's Tools button does. */
async function openToolsPanel(tab: Page): Promise<Locator> {
  await tab.evaluate(() => {
    type PiniaHost = { __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, { openToolsPanel(): boolean }> } } } } };
    (document.querySelector('#app') as unknown as PiniaHost).__vue_app__.config.globalProperties.$pinia._s.get('ui')!.openToolsPanel();
  });
  await postFromWebview(tab, { type: 'requestToolStatus' });
  const panel = tab.getByTestId('tools-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('tools-loading')).toHaveCount(0, { timeout: 60_000 });
  return panel;
}

const groupCard = (panel: Locator, group: string): Locator => panel.locator(`[data-testid="tools-group"][data-group="${group}"]`);
const groupSwitch = (panel: Locator, group: string, name: string): Locator => groupCard(panel, group).getByRole('switch', { name: `Enable ${name} tools`, exact: true });

/** The Tools status the chat's own core last posted; a foreign proxy never delivers one, so this is the remote core's. */
async function lastToolStatus(tab: Page): Promise<ToolsSnapshot | undefined> {
  return (await hostMessages(tab, 'toolStatus')).at(-1)?.['data'] as ToolsSnapshot | undefined;
}

/** Asks the chat's core for its Tools status until `check` holds of the answer. */
async function expectRemoteToolStatus(tab: Page, check: (snapshot: ToolsSnapshot) => boolean): Promise<void> {
  await expect.poll(async () => {
    await postFromWebview(tab, { type: 'requestToolStatus' });
    const snapshot = await lastToolStatus(tab);
    return snapshot !== undefined && check(snapshot);
  }, { timeout: 120_000 }).toBe(true);
}

const groupEnabled = (snapshot: ToolsSnapshot, group: string): boolean | undefined => snapshot.groups.find((entry) => entry.group === group)?.enabled;

/** Resolves once the page got a successful settingWriteResult for `key` beyond the `seen` it had. */
async function expectWriteLanded(tab: Page, key: string, seen: number): Promise<number> {
  let results: Array<Record<string, unknown>> = [];
  await expect.poll(async () => (results = (await hostMessages(tab, 'settingWriteResult')).filter((result) => result['key'] === key)).length, { timeout: 30_000 }).toBeGreaterThan(seen);
  expect(results.slice(seen).map((result) => result['ok'])).toEqual(results.slice(seen).map(() => true));
  return results.length;
}

// A chat page shows a `notification` post as its own in-page toast, so the page's messages, not main's popup, record it.
const failureNotices = async (tab: Page): Promise<string[]> => (await hostMessages(tab, 'notification'))
  .map((notice) => (notice['message'] as { readonly message?: unknown } | undefined)?.message)
  .filter((message): message is string => typeof message === 'string' && message.startsWith('Failed to save'));

/**
 * Makes this computer's user settings file unwritable until the returned restore. Main writes it by rename, which a read-only
 * file alone stops only on Windows, so on POSIX its folder is made read-only too.
 */
function lockUserSettings(home: Pick<HermeticHome, 'damoclesDir'>): () => void {
  const file = path.join(home.damoclesDir, 'settings.json');
  const fileMode = fs.statSync(file).mode & 0o777;
  const dirMode = fs.statSync(home.damoclesDir).mode & 0o777;
  fs.chmodSync(file, 0o444);
  if (process.platform !== 'win32') fs.chmodSync(home.damoclesDir, 0o555);
  return () => {
    if (process.platform !== 'win32') fs.chmodSync(home.damoclesDir, dirMode);
    fs.chmodSync(file, fileMode);
  };
}

test('a remote chat\'s pin and Tools switches save this computer\'s user settings, never through the remote core; a switch the host sets is disabled and links to its tab', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, proxied }) => {
  test.setTimeout(600_000);
  const target = await proxied('prod-1');
  const { fixture } = target;
  const stub = await startTargetStub(home, fixture);
  try {
    const env = { env: remoteEnv(ssh, mirror) };
    const first = await launch(env);
    const { app } = first;
    const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
    const authority = `ssh+${hostId}`;
    await openRemoteFolder(app, hostId, APP);
    const key = await remoteProjectKey(app, { authorityKey: authority }, APP);
    const tab = await newRemoteChat(app, key);
    await recordHostMessages(tab);

    // the pin: its header hides with no toast, saved in this computer's file and not the host's
    stub.replies.push({ chunks: [LONG_REPLY] });
    await sendPrompt(tab, 'Write a long answer');
    await expect(tab.getByText(LAST_LINE, { exact: true })).toBeVisible({ timeout: 120_000 });
    await awaitTurnEnd(tab);
    const pinned = tab.getByTestId('pinned-prompt');
    await expect(pinned).toBeVisible({ timeout: 30_000 });
    await pinned.getByTestId('pinned-hide').click();
    await expect(pinned).toHaveCount(0);
    await expect(tab.getByTestId('chat-header-pinned')).toBeVisible();
    await expectWriteLanded(tab, 'damocles.pinnedHeaderHidden', 0);
    expect(readUserSettings(home)['damocles.pinnedHeaderHidden']).toBe(true);
    expect(await hostSettings(fixture)).not.toHaveProperty(['damocles.pinnedHeaderHidden']);

    // Compass on: written here, and the remote session's own Tools status turns its tools on
    let panel = await openToolsPanel(tab);
    const compass = groupSwitch(panel, 'compass', 'Compass');
    await expect(compass).toHaveAttribute('aria-checked', 'false');
    await compass.click();
    await expect(compass).toHaveAttribute('aria-checked', 'true');
    const compassWrites = await expectWriteLanded(tab, 'damocles.compass.enabled', 0);
    expect(readUserSettings(home)['damocles.compass.enabled']).toBe(true);
    expect(await hostSettings(fixture)).not.toHaveProperty(['damocles.compass.enabled']);
    await expectRemoteToolStatus(tab, (snapshot) => groupEnabled(snapshot, 'compass') === true
      && snapshot.tools.some((tool) => tool.group === 'compass' && tool.enabled));

    // one tool off: the per-tool list is written here too
    await groupCard(panel, 'compass').getByRole('button', { expanded: false }).click();
    const toolSwitch = groupCard(panel, 'compass').getByTestId('tools-row').first().getByRole('switch');
    await expect(toolSwitch).toHaveAttribute('aria-checked', 'true');
    await toolSwitch.click();
    await expect(toolSwitch).toHaveAttribute('aria-checked', 'false');
    await expectWriteLanded(tab, 'damocles.tools.disabled', 0);
    expect(readUserSettings(home)['damocles.tools.disabled']).toHaveLength(1);
    expect(await hostSettings(fixture)).not.toHaveProperty(['damocles.tools.disabled']);
    await tab.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    // Browser set on the host tab: the chat's Browser switch is disabled, and its link opens Settings on that tab
    let overlay = await openSettingsModal(app, 'integrations');
    await expect(overlay.getByTestId('settings-scope-host')).toHaveAttribute('aria-selected', 'true');
    await expect(overlay.getByTestId('settings-scope-loading')).toHaveCount(0, { timeout: 60_000 });
    const browserRow = settingsRow(overlay, 'damocles.browser.enabled').getByRole('switch');
    await expect(browserRow).toHaveAttribute('aria-checked', 'false');
    await browserRow.click();
    await expect.poll(async () => (await hostSettings(fixture))['damocles.browser.enabled'], { timeout: 30_000 }).toBe(true);
    expect(readUserSettings(home)).not.toHaveProperty(['damocles.browser.enabled']);
    await closeSettingsModal(overlay);

    panel = await openToolsPanel(tab);
    await expectRemoteToolStatus(tab, (snapshot) => snapshot.groups.some((entry) => entry.group === 'browser' && entry.setOnHost === true));
    const browser = groupSwitch(panel, 'browser', 'Browser');
    await expect(browser).toBeDisabled();
    await expect(browser).toHaveAttribute('aria-checked', 'true');
    const note = groupCard(panel, 'browser').getByTestId('tools-group-host-note');
    await expect(note).toBeVisible();
    await note.getByTestId('tools-open-host-settings').click();
    overlay = await overlayPage(app);
    await expect(settingsModal(overlay)).toBeVisible();
    await expect(overlay.getByTestId('settings-scope-host')).toHaveAttribute('aria-selected', 'true');
    await expect(settingsNav(overlay, 'integrations')).toHaveAttribute('aria-selected', 'true');
    await expect(settingsRow(overlay, 'damocles.browser.enabled')).toBeVisible({ timeout: 30_000 });
    await closeSettingsModal(overlay);

    // an unwritable user file: the switch goes back and the toast names the failure
    const web = groupSwitch(panel, 'web', 'Web');
    await expect(web).toHaveAttribute('aria-checked', 'false');
    const restore = lockUserSettings(home);
    try {
      await web.click();
      await expect.poll(() => failureNotices(tab), { timeout: 60_000 }).toEqual(['Failed to save tool group setting: {0}']);
      await expect(tab.locator('[data-sonner-toast]').filter({ hasText: 'Failed to save tool group setting:' })).toHaveCount(1);
      await expect(web).toHaveAttribute('aria-checked', 'false');
    } finally {
      restore();
    }
    expect(readUserSettings(home)).not.toHaveProperty(['damocles.pi.webSearch.enabled']);

    // the host away: Compass off still saves here, and the remote chat applies it once main republishes clientUser
    target.proxy.refuse();
    await expect(tab.getByTestId('chat-connection-banner')).toBeVisible({ timeout: 30_000 });
    await compass.click();
    await expect(compass).toHaveAttribute('aria-checked', 'false');
    await expectWriteLanded(tab, 'damocles.compass.enabled', compassWrites);
    expect(readUserSettings(home)['damocles.compass.enabled']).toBe(false);
    expect(groupEnabled((await lastToolStatus(tab))!, 'compass')).toBe(true);
    target.proxy.restore();
    await expect(tab.getByTestId('chat-connection-banner')).toBeHidden({ timeout: 120_000 });
    await expectRemoteToolStatus(tab, (snapshot) => groupEnabled(snapshot, 'compass') === false);
    await expect(compass).toHaveAttribute('aria-checked', 'false');
    await tab.keyboard.press('Escape');
    // only the read-only file's failure toasted
    expect(await failureNotices(tab)).toHaveLength(1);

    // every one of the three went to this computer's core, the one sent while the host was away included
    await expect.poll(() => SETTING_MESSAGES.filter((type) => mainLog(home).includes(routedLine(type, authority))), { timeout: 30_000 }).toEqual([...SETTING_MESSAGES]);
    // a daemon's core refuses these writes with an error line, so a message that reached it would show there
    expect(await targetCoreLog(fixture)).not.toMatch(/Error saving damocles\.(pinnedHeaderHidden|compass\.enabled|pi\.webSearch\.enabled|tools\.disabled)/);
    await first.close();
    const log = logBeforeQuit(home);
    for (const type of SETTING_MESSAGES) expect(log).not.toContain(failedLine(type, authority));

    // reopened in a new launch, the chat keeps its pin hidden
    const second = await launch(env);
    await remoteProjectKey(second.app, { authorityKey: authority }, APP);
    let chatId = '';
    await expect.poll(async () => (chatId = (await listChats(second.app, key)).chats[0]?.id ?? ''), { timeout: 60_000 }).not.toBe('');
    expect(await (await shellPage(second.app)).evaluate((id) => window.damoclesShell!.selectChat(id), chatId)).toEqual({ ok: true });
    const reopened = await chatShowing(second.app, LAST_LINE);
    await expect(reopened.getByTestId('chat-header-pinned')).toBeVisible({ timeout: 60_000 });
    await expect(reopened.getByTestId('pinned-prompt')).toHaveCount(0);
    expect(readUserSettings(home)['damocles.pinnedHeaderHidden']).toBe(true);
    expect(await hostSettings(fixture)).not.toHaveProperty(['damocles.pinnedHeaderHidden']);
    await shutdownHostDaemon(second.app, hostId, fixture);
  } finally {
    await stub.close();
  }
});
