import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat } from '../desktop/support/fixtures';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { agentRequests, type OpenAIStub } from '../desktop/support/openai-stub';
import { awaitTurnEnd } from '../desktop/support/ui';
import { daemonPids, shutdownHostDaemon } from './support/daemon-teardown';
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

const outbox = (fixture: Pick<SshdFixture, 'sh'>): Promise<string> =>
  fixture.sh(`d=${TARGET_HOME}/.damocles/outbox; [ -d "$d" ] || exit 0; for f in "$d"/*.jsonl; do [ -e "$f" ] && { echo "== $f $(stat -c %a "$f")"; cat "$f"; }; done; true`, TARGET_USER);

/** Every memory row of the target account's store, read with the installed server's node. */
async function targetMemories(fixture: Pick<SshdFixture, 'sh'>): Promise<string> {
  const node = (await fixture.sh(`ls -d ${TARGET_HOME}/.damocles/server/*/node/node | head -n 1`, TARGET_USER)).trim();
  const script = "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.env.HOME + '/.damocles/memory.v3.db', { readOnly: true }); console.log(JSON.stringify(db.prepare('SELECT scope, content FROM memories').all()));";
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