import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { mainLog } from '../desktop/support/app';
import type { HermeticHome } from '../desktop/support/hermetic';
import { attachDaemonLogs, newLoopbackChat, sendPrompt, startLoopbackStub, targetAgentDir } from '../desktop/support/loopback-agent';
import { cleanUp, endLeftoverDaemon, filesUnder, LOOPBACK_ENV, LOOPBACK_TAG, serverDir, shutdownDaemon } from '../desktop/support/loopback';
import { awaitTurnEnd } from '../desktop/support/ui';
import { expect, test } from './support/remote';

// The reconnection grace and the held-frame bound, shortened by the daemon's e2e hooks, which a server package refuses, so
// these run on the loopback authority, whose daemon is the checkout's dist/daemon.js started with main's environment.

const GRACE_MS = 3000;
// below the overflow test's reply (40 deltas of 64 KiB) that streams while the transport is down; a rejoin replays the
// ended turn's message, which may pass the bound alone, as the longest message a channel queues
const MAX_HELD_BYTES = 2 * 1024 * 1024;
const REPLY_DELTAS = 40;

interface TransportHooks {
  __damoclesE2e: {
    loopback: {
      cutTransport(options: { hold: boolean }): void;
      releaseTransport(): void;
      coreState(): Promise<{ epoch: string | null }>;
    };
    remote: { reconnectNow(authorityKey: string): void };
  };
}

const hooks = (app: ElectronApplication) => ({
  cut: () => app.evaluate(() => (globalThis as unknown as TransportHooks).__damoclesE2e.loopback.cutTransport({ hold: true })),
  release: () => app.evaluate(() => {
    const e2e = (globalThis as unknown as TransportHooks).__damoclesE2e;
    e2e.loopback.releaseTransport();
    e2e.remote.reconnectNow('loopback');
  }),
  epoch: async () => (await app.evaluate(() => (globalThis as unknown as TransportHooks).__damoclesE2e.loopback.coreState())).epoch,
});

/** The chat page that shows `text`: a fresh attach may have replaced the page the test held. */
async function chatShowing(app: ElectronApplication, text: string): Promise<Page> {
  let found: Page | undefined;
  await expect.poll(async () => {
    found = undefined;
    for (const page of app.windows().filter((candidate) => !candidate.isClosed() && candidate.url().includes('/panel/'))) {
      // a page the fresh attach closes while it is looked at shows nothing
      const shows = await page.getByText(text, { exact: false }).first().isVisible().catch((error: unknown) => {
        if (page.isClosed()) return false;
        throw error;
      });
      if (shows) found = page;
    }
    return found !== undefined;
  }, { timeout: 60_000 }).toBe(true);
  return found!;
}

/** Every session file of the daemon's pi agent dir, as text. */
function sessionText(home: HermeticHome): string {
  const root = path.join(targetAgentDir(home), 'sessions');
  return filesUnder(root).filter((file) => file.endsWith('.jsonl')).map((file) => fs.readFileSync(path.join(root, ...file.split('/')), 'utf8')).join('\n');
}

/** The daemon's own log lines, from every log file in its run folder. */
function daemonLog(home: HermeticHome): string {
  const root = serverDir(home);
  return filesUnder(root).filter((file) => /(^|\/)daemon[^/]*\.log$/.test(file)).map((file) => fs.readFileSync(path.join(root, ...file.split('/')), 'utf8')).join('\n');
}

test('a connection past its grace gets unknown-token and attaches fresh, and the same core epoch rejoins its chat through views.join', { tag: LOOPBACK_TAG }, async ({ home, launch }, testInfo) => {
  test.setTimeout(300_000);
  const stub = await startLoopbackStub(home);
  const folder = path.join(home.root, 'graced');
  fs.mkdirSync(folder, { recursive: true });
  let app: ElectronApplication | undefined;
  let failure: unknown;
  try {
    ({ app } = await launch({ env: { ...LOOPBACK_ENV.env, DAMOCLES_E2E_RECONNECTION_GRACE_MS: String(GRACE_MS) } }));
    const { tab } = await newLoopbackChat(app, folder);
    await sendPrompt(tab, 'Before the drop');
    await expect(tab.getByText('Echo: Before the drop', { exact: true })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    const epoch = await hooks(app).epoch();
    await hooks(app).cut();
    await expect.poll(() => daemonLog(home), { timeout: 60_000 }).toMatch(/connection-\d+: the grace ended/);
    await hooks(app).release();
    await expect.poll(() => mainLog(home), { timeout: 60_000 }).toContain(`[remote] loopback: rejoining 1 chats through views.join (epoch ${epoch})`);
    expect(mainLog(home)).not.toContain('[remote] loopback: resumed inside the grace');
    expect(await hooks(app).epoch()).toBe(epoch);
    // the rejoined chat is the live chat: its transcript whole and once, and it takes a new turn
    const rejoined = await chatShowing(app, 'Echo: Before the drop');
    await expect(rejoined.getByText('Echo: Before the drop', { exact: true })).toHaveCount(1);
    await expect(rejoined.getByTestId('user-message-time')).toHaveCount(1);
    await sendPrompt(rejoined, 'After the rejoin');
    await expect(rejoined.getByText('Echo: After the rejoin', { exact: true })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(rejoined);
    await shutdownDaemon(app, home);
  } catch (error) {
    failure = error;
    await attachDaemonLogs(testInfo, home);
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => endLeftoverDaemon(app, home));
    await stub.close();
  }
});

test('a drop during which the daemon\'s held frames overflow forces a fresh attach, and the chat rejoins with its complete transcript', { tag: LOOPBACK_TAG }, async ({ home, launch }, testInfo) => {
  test.setTimeout(300_000);
  const stub = await startLoopbackStub(home);
  const folder = path.join(home.root, 'overflowed');
  fs.mkdirSync(folder, { recursive: true });
  let app: ElectronApplication | undefined;
  let failure: unknown;
  try {
    ({ app } = await launch({ env: { ...LOOPBACK_ENV.env, DAMOCLES_E2E_MAX_HELD_BYTES: String(MAX_HELD_BYTES) } }));
    const { tab } = await newLoopbackChat(app, folder);
    const epoch = await hooks(app).epoch();
    // a reply of 2.5 MiB in 64 KiB deltas, streamed while the transport is held down
    const piece = (index: number): string => ` chunk-${String(index).padStart(2, '0')}:${'z'.repeat(64 * 1024)}`;
    const chunks = ['Start of the long reply.', ...Array.from({ length: REPLY_DELTAS }, (_value, index) => piece(index)), ' End of the long reply.'];
    let release!: () => void;
    stub.replies.push({ chunks, holdAfterFirst: new Promise<void>((resolve) => (release = resolve)) });
    await sendPrompt(tab, 'Stream a lot');
    await expect(tab.getByText('Start of the long reply.', { exact: false })).toBeVisible({ timeout: 60_000 });
    await hooks(app).cut();
    release();
    await expect.poll(() => daemonLog(home), { timeout: 60_000 }).toMatch(/held frames passed the per-connection bound/);
    // the turn ends on the daemon's core while nobody is attached: its session file holds the whole reply
    await expect.poll(() => sessionText(home).includes('End of the long reply.'), { timeout: 120_000 }).toBe(true);
    await hooks(app).release();
    // not a resume: a fresh attach to the same core, whose chat rejoins
    await expect.poll(() => mainLog(home), { timeout: 60_000 }).toContain(`[remote] loopback: rejoining 1 chats through views.join (epoch ${epoch})`);
    expect(mainLog(home)).not.toContain('[remote] loopback: resumed inside the grace');
    const rejoined = await chatShowing(app, 'End of the long reply.');
    await awaitTurnEnd(rejoined);
    // the whole reply, once: every chunk arrived and none twice
    const reply = await rejoined.evaluate(() => document.body.innerText);
    expect(reply.match(/Start of the long reply\./g)).toHaveLength(1);
    expect(reply.match(/chunk-\d\d:/g)).toEqual(Array.from({ length: REPLY_DELTAS }, (_value, index) => `chunk-${String(index).padStart(2, '0')}:`));
    await shutdownDaemon(app, home);
  } catch (error) {
    failure = error;
    await attachDaemonLogs(testInfo, home);
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => endLeftoverDaemon(app, home));
    await stub.close();
  }
});
