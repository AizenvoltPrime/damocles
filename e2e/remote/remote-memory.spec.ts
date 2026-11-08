import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeChat } from '../desktop/support/fixtures';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { agentRequests, call, lastToolResult, type OpenAIStub } from '../desktop/support/openai-stub';
import { shellPage } from '../desktop/support/shell';
import { awaitTurnEnd, hostMessages, recordHostMessages } from '../desktop/support/ui';
import { daemonPids, shutdownHostDaemon } from './support/daemon-teardown';
import { test as flakyTest } from './support/flaky';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { closeRemoteDialog, exited, requestQuit, targetSessions } from './support/remote-runs';
import { openRemoteHostSettings } from './support/host-settings-ui';
import { TARGET_HOME, TARGET_USER, type SshdFixture } from './support/sshd';
import { newRemoteChat, startTargetStub } from './support/target-agent';

const APP = '/srv/app';
const LOCAL_GLOBAL = 'The user wants zorblax deploys to run at night.';
const TARGET_PROJECT = 'Zorblax deploys go through the staging pipeline first.';
const CLOSED_GLOBAL = 'The user signs zorblax releases with a hardware key.';
const HELD_GLOBAL = 'The user keeps zorblax release notes in the wiki.';
const LOCAL_NOTE = 'Zorblax staging credentials rotate every Monday.';
const LOCAL_FACT = 'The user runs zorblax builds on a Threadripper.';
const HOST_PROJECT = 'Zorblax serves its API from /srv/app/api.';
const POPUP_GLOBAL = 'The user reviews zorblax pull requests before lunch.';
const AWAY_NOTE = 'Zorblax rollbacks need two approvals.';

/** A webview message a chat page posts, as its own components do. */
const post = (tab: Page, message: Record<string, unknown>): Promise<void> => tab.evaluate((m) => window.damoclesBridge!.postMessage(m), message);

/** Global rows of this computer's memory store whose content is `content`. */
function localGlobals(damoclesDir: string, content: string): number {
  const db = new DatabaseSync(path.join(damoclesDir, 'memory.v3.db'), { readOnly: true });
  try {
    return (db.prepare("SELECT count(*) AS n FROM memories WHERE scope = 'global' AND content = ?").get(content) as { n: number }).n;
  } finally {
    db.close();
  }
}

/** This computer's global rows whose content is `content`: how many, and whether any is pinned or forgotten. */
function localGlobal(damoclesDir: string, content: string): { n: number; pinned: boolean; forgotten: boolean } {
  const db = new DatabaseSync(path.join(damoclesDir, 'memory.v3.db'), { readOnly: true });
  try {
    const row = db.prepare("SELECT count(*) AS n, coalesce(max(pinned), 0) AS pinned, coalesce(max(forgotten), 0) AS forgotten FROM memories WHERE scope = 'global' AND content = ?").get(content) as { n: number; pinned: number; forgotten: number };
    return { n: row.n, pinned: row.pinned === 1, forgotten: row.forgotten === 1 };
  } finally {
    db.close();
  }
}

const outbox = (fixture: Pick<SshdFixture, 'sh'>): Promise<string> =>
  fixture.sh(`d=${TARGET_HOME}/.damocles/outbox; [ -d "$d" ] || exit 0; for f in "$d"/*.jsonl; do [ -e "$f" ] && { echo "== $f $(stat -c %a "$f")"; cat "$f"; }; done; true`, TARGET_USER);

/**
 * Every memory row of the target account's store, read with the installed server's node. Opened read-write: a read-only open of
 * a WAL database fails while no connection holds its -shm file, as after the daemon's core closed it.
 */
async function targetMemories(fixture: Pick<SshdFixture, 'sh'>): Promise<string> {
  const node = (await fixture.sh(`ls -d ${TARGET_HOME}/.damocles/server/*/node/node | head -n 1`, TARGET_USER)).trim();
  const script = "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.env.HOME + '/.damocles/memory.v3.db'); console.log(JSON.stringify(db.prepare('SELECT scope, content FROM memories').all()));";
  return fixture.sh(`${node} -e "${script.replaceAll('"', '\\"')}"`, TARGET_USER);
}

/** The last agent request's body, which carries the prompt's memory injection. */
const lastAgentBody = (stub: OpenAIStub): string => JSON.stringify(agentRequests(stub).at(-1)?.body ?? null);

async function connect(app: ElectronApplication): Promise<{ hostId: string; key: string }> {
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  await openRemoteFolder(app, hostId, APP);
  return { hostId, key: await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP) };
}

test('a remote chat injects a global memory saved on this computer beside the target\'s project memories; a global memory its turn saves while the app is closed waits in that device\'s outbox on the target and arrives on this computer once after reconnecting', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture);
  try {
    const env = { env: remoteEnv(ssh, mirror) };
    const first = await launch(env);
    // a global memory saved on this computer, through a local chat's memory panel request
    const localTab = await activeChat(first.app);
    await post(localTab, { type: 'createMemory', tier: 'global', kind: 'preference', content: LOCAL_GLOBAL, requestId: 'local-global' });
    await expect.poll(() => localGlobals(home.damoclesDir, LOCAL_GLOBAL)).toBe(1);

    const { hostId, key } = await connect(first.app);
    const tab = await newRemoteChat(first.app, key);
    // a project memory of the target, saved through the remote chat into the target's own store
    await post(tab, { type: 'createMemory', tier: 'project', kind: 'fact', content: TARGET_PROJECT, requestId: 'target-project' });
    // other project memories, so the prompt's words are distinctive in the target's store (a word every memory holds is common)
    for (const [index, content] of ['The database runs Postgres 16.', 'Tests use vitest with a hermetic home.', 'The API listens on port 8080.'].entries()) {
      await post(tab, { type: 'createMemory', tier: 'project', kind: 'fact', content, requestId: `target-other-${index}` });
    }

    // the target's store holds them before the prompt, whose injection reads it
    await expect.poll(() => targetMemories(fixture), { timeout: 30_000 }).toContain(TARGET_PROJECT);
    expect(await targetMemories(fixture)).not.toContain(LOCAL_GLOBAL);
    stub.replies.push({ chunks: ['Noted.'] });
    await sendPrompt(tab, 'how do zorblax deploys work');
    await awaitTurnEnd(tab);
    // the prompt's injection carries both, the client's global ranked with the target's project memory
    const injected = lastAgentBody(stub);
    expect(injected).toContain(LOCAL_GLOBAL);
    expect(injected).toContain(TARGET_PROJECT);

    // a turn that saves a global memory after the app closed with Keep running
    const releases: Array<() => void> = [];
    stub.replies.push(
      { chunks: ['Saving it.', ' Now.'], holds: [{ before: 1, until: new Promise<void>((resolve) => releases.push(resolve)) }], toolCalls: [{ name: 'SaveMemory', arguments: { content: CLOSED_GLOBAL, kind: 'preference', scope: 'global' } }] },
      { chunks: ['Saved for later.'] },
    );
    await sendPrompt(tab, 'remember how I sign releases');
    await expect(tab.getByText('Saving it.', { exact: false })).toBeVisible({ timeout: 60_000 });
    await requestQuit(first.app);
    const { dialog } = await closeRemoteDialog(first.app);
    await dialog.getByRole('button', { name: 'Keep running' }).click();
    await exited(first);
    expect(await daemonPids(fixture)).toHaveLength(1);
    releases[0]!();
    await expect.poll(() => targetSessions(fixture), { timeout: 60_000 }).toContain('Saved for later.');
    const held = await outbox(fixture);
    expect(held).toContain(CLOSED_GLOBAL);
    // one file per device, private to the target account
    expect(held).toMatch(/== \S+\.jsonl 600/);
    expect(localGlobals(home.damoclesDir, CLOSED_GLOBAL)).toBe(0);

    // relaunched: the device attaches, its outbox drains to it, and the memory lands once
    const second = await launch(env);
    await remoteProjectKey(second.app, { authorityKey: `ssh+${hostId}` }, APP);
    await expect.poll(() => localGlobals(home.damoclesDir, CLOSED_GLOBAL), { timeout: 60_000 }).toBe(1);
    await expect.poll(() => outbox(fixture), { timeout: 30_000 }).not.toContain(CLOSED_GLOBAL);
    expect(localGlobals(home.damoclesDir, CLOSED_GLOBAL)).toBe(1);
    await shutdownHostDaemon(second.app, hostId, fixture);
  } finally {
    await stub.close();
  }
});

test('an outbox the target holds for a device away 30 days shows on the host card, and Deliver here brings its memories to this computer once', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture);
  try {
    // a device that has not attached for 40 days left one memory in its outbox on the target
    const write = { uuid: 'held-uuid-1', kind: 'preference', content: HELD_GLOBAL };
    const lastSeen = Date.now() - 40 * 24 * 60 * 60 * 1000;
    await fixture.sh([
      `d=${TARGET_HOME}/.damocles/outbox`,
      `mkdir -p "$d" && chmod 700 ${TARGET_HOME}/.damocles "$d"`,
      `printf '%s\\n' '${JSON.stringify(write)}' > "$d/device-old.jsonl" && chmod 600 "$d/device-old.jsonl"`,
      `printf '%s' '${JSON.stringify({ 'device-old': lastSeen })}' > "$d/last-seen.json" && chmod 600 "$d/last-seen.json"`,
    ].join(' && '), TARGET_USER);
    const env = { env: remoteEnv(ssh, mirror) };
    const first = await launch(env);
    const { hostId } = await connect(first.app);
    const { block } = await openRemoteHostSettings(first.app, hostId);
    const row = block.getByTestId('held-memory-queue');
    await expect(row).toHaveCount(1, { timeout: 60_000 });
    await expect(row.getByTestId('held-memory-text')).toContainText('1 memory waiting for a device last seen');
    expect(localGlobals(home.damoclesDir, HELD_GLOBAL)).toBe(0);

    await row.getByTestId('held-memory-deliver').click();
    await expect(block.getByTestId('held-memory-outcome')).toHaveText('1 memory is being delivered to this computer.');
    await expect.poll(() => localGlobals(home.damoclesDir, HELD_GLOBAL), { timeout: 60_000 }).toBe(1);
    await expect.poll(() => outbox(fixture), { timeout: 30_000 }).not.toContain(HELD_GLOBAL);
    await expect(block.getByTestId('held-memory-queue')).toHaveCount(0);
    expect(localGlobals(home.damoclesDir, HELD_GLOBAL)).toBe(1);
    await shutdownHostDaemon(first.app, hostId, fixture);
  } finally {
    await stub.close();
  }
});
/** Opens the remote chat's memory popup from its header's More menu, where a chat as narrow as the test window folds it. */
async function openMemoryPopup(tab: Page): Promise<Locator> {
  await tab.getByTestId('chat-header-more').click();
  await tab.getByTestId('chat-header-more-menu').locator('[data-action="memory"]').click();
  const panel = tab.getByTestId('memory-panel');
  await expect(panel).toBeVisible();
  return panel;
}

async function closeMemoryPopup(tab: Page, panel: Locator): Promise<void> {
  await tab.keyboard.press('Escape');
  await expect(panel).toBeHidden();
}

const memoryRow = (panel: Locator, content: string): Locator => panel.locator('article[data-memory-id]').filter({ hasText: content });

/** Adds a memory from the popup's footer, in the tier named as the footer's toggle labels it. */
async function addFromPopup(panel: Locator, tier: 'Global' | 'Note', content: string): Promise<void> {
  await panel.getByLabel('Where the new memory goes').getByText(tier, { exact: true }).click();
  await panel.getByTestId('memory-new').fill(content);
  await panel.getByTestId('memory-new').press('Enter');
  await expect(panel.getByTestId('memory-new')).toHaveValue('', { timeout: 30_000 });
}

flakyTest('a remote chat\'s memory popup lists this computer\'s notes and globals beside the host\'s rows and manages them on this computer, also while the host is away; the remote agent\'s ListNotes returns the notes', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, proxied }) => {
  flakyTest.setTimeout(600_000);
  const target = await proxied('prod-1');
  const { fixture } = target;
  const stub = await startTargetStub(home, fixture);
  try {
    const { app } = await launch({ env: remoteEnv(ssh, mirror) });
    // a note and a global fact saved on this computer, through a local chat's memory panel requests
    const localTab = await activeChat(app);
    await post(localTab, { type: 'createMemory', tier: 'note', content: LOCAL_NOTE, requestId: 'local-note' });
    await post(localTab, { type: 'createMemory', tier: 'global', kind: 'fact', content: LOCAL_FACT, requestId: 'local-fact' });
    await expect.poll(() => [localGlobal(home.damoclesDir, LOCAL_NOTE).n, localGlobal(home.damoclesDir, LOCAL_FACT).n]).toEqual([1, 1]);

    const { hostId, key } = await connect(app);
    const tab = await newRemoteChat(app, key);
    await recordHostMessages(tab);
    await post(tab, { type: 'createMemory', tier: 'project', kind: 'fact', content: HOST_PROJECT, requestId: 'host-project' });
    await expect.poll(() => targetMemories(fixture), { timeout: 30_000 }).toContain(HOST_PROJECT);

    // this computer's rows, marked as its own, beside the host's project row
    let panel = await openMemoryPopup(tab);
    await expect(memoryRow(panel, LOCAL_FACT)).toBeVisible({ timeout: 60_000 });
    await expect(memoryRow(panel, LOCAL_FACT).getByTestId('memory-on-this-computer')).toBeVisible();
    await expect(memoryRow(panel, HOST_PROJECT)).toBeVisible({ timeout: 60_000 });
    await expect(memoryRow(panel, HOST_PROJECT).getByTestId('memory-on-this-computer')).toHaveCount(0);
    await panel.locator('[data-tab="note"]').click();
    await expect(memoryRow(panel, LOCAL_NOTE)).toBeVisible();
    await panel.locator('[data-tab="all"]').click();

    // managed from the popup: a pin and a create land in this computer's database
    await memoryRow(panel, LOCAL_FACT).locator('[data-memory-action="pin"]').click();
    await expect.poll(() => localGlobal(home.damoclesDir, LOCAL_FACT).pinned, { timeout: 30_000 }).toBe(true);
    await expect(memoryRow(panel, LOCAL_FACT).locator('[data-memory-action="unpin"]')).toBeVisible();
    await addFromPopup(panel, 'Global', POPUP_GLOBAL);
    await expect.poll(() => localGlobal(home.damoclesDir, POPUP_GLOBAL).n, { timeout: 30_000 }).toBe(1);
    await expect(memoryRow(panel, POPUP_GLOBAL)).toBeVisible({ timeout: 30_000 });
    await closeMemoryPopup(tab, panel);

    // the remote agent lists this computer's notes by relayed ids
    stub.replies.push(call('ListNotes', {}), { chunks: ['Listed.'] });
    await sendPrompt(tab, 'list my notes');
    await expect(tab.getByText('Listed.', { exact: true })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    const listed = lastToolResult(stub);
    expect(listed).toContain(LOCAL_NOTE);
    expect(listed).toMatch(/global:[^:"]+:/);

    // the host away: this computer's list is asked again and answered, and every change still lands here
    target.proxy.refuse();
    await expect(tab.getByTestId('chat-connection-banner')).toBeVisible({ timeout: 30_000 });
    const answered = (await hostMessages(tab, 'userMemoriesUpdate')).length;
    panel = await openMemoryPopup(tab);
    await expect.poll(async () => (await hostMessages(tab, 'userMemoriesUpdate')).length, { timeout: 30_000 }).toBeGreaterThan(answered);
    await expect(memoryRow(panel, LOCAL_FACT)).toBeVisible();
    await expect(memoryRow(panel, HOST_PROJECT)).toBeVisible();
    await memoryRow(panel, LOCAL_FACT).locator('[data-memory-action="forget"]').click();
    await expect.poll(() => localGlobal(home.damoclesDir, LOCAL_FACT).forgotten, { timeout: 30_000 }).toBe(true);
    await memoryRow(panel, POPUP_GLOBAL).locator('[data-memory-action="pin"]').click();
    await expect.poll(() => localGlobal(home.damoclesDir, POPUP_GLOBAL).pinned, { timeout: 30_000 }).toBe(true);
    await panel.locator('[data-tab="note"]').click();
    await memoryRow(panel, LOCAL_NOTE).locator('[data-memory-action="delete"]').click();
    await expect.poll(() => localGlobal(home.damoclesDir, LOCAL_NOTE).n, { timeout: 30_000 }).toBe(0);
    await expect(memoryRow(panel, LOCAL_NOTE)).toHaveCount(0);
    await panel.locator('[data-tab="all"]').click();
    await addFromPopup(panel, 'Note', AWAY_NOTE);
    await expect.poll(() => localGlobal(home.damoclesDir, AWAY_NOTE).n, { timeout: 30_000 }).toBe(1);
    await panel.locator('[data-tab="note"]').click();
    await expect(memoryRow(panel, AWAY_NOTE)).toBeVisible({ timeout: 30_000 });
    await closeMemoryPopup(tab, panel);
    target.proxy.restore();
    const shell = await shellPage(app);
    await expect.poll(async () => (await shell.evaluate(() => window.damoclesShell!.getState())).projects.find((project) => project.key === key)?.connection, { timeout: 120_000 }).toBe('connected');

    // each change landed once, here only: the target's store and outbox never saw these rows
    expect([LOCAL_FACT, POPUP_GLOBAL, AWAY_NOTE].map((content) => localGlobal(home.damoclesDir, content).n)).toEqual([1, 1, 1]);
    const targetRows = await targetMemories(fixture);
    const held = await outbox(fixture);
    for (const content of [LOCAL_NOTE, LOCAL_FACT, POPUP_GLOBAL, AWAY_NOTE]) {
      expect(targetRows).not.toContain(content);
      expect(held).not.toContain(content);
    }
    expect(targetRows).toContain(HOST_PROJECT);
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await stub.close();
  }
});
