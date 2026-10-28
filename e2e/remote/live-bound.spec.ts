import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { mainLog } from '../desktop/support/app';
import type { HermeticHome } from '../desktop/support/hermetic';
import { attachDaemonLogs, newLoopbackChat, sendPrompt, startLoopbackStub } from '../desktop/support/loopback-agent';
import { cleanUp, endLeftoverDaemon, filesUnder, LOOPBACK_ENV, LOOPBACK_TAG, serverDir, shutdownDaemon } from '../desktop/support/loopback';
import { awaitTurnEnd } from '../desktop/support/ui';
import { expect, test } from './support/remote';

// The held-frame bound counts a live connection too, shortened by the daemon's e2e hooks, which a server package refuses,
// so this runs on the loopback authority, whose daemon is the checkout's dist/daemon.js started with main's environment.

const GRACE_MS = 3000;
// above the core channel's 1 MiB window, which a paced replay may still fill
const MAX_HELD_BYTES = 4 * 1024 * 1024;
// six replies of 500,000 characters: a rejoin replays each as one message carrying its text twice, about 6 MB in all
const TURNS = 6;
const REPLY_CHARS = 500_000;

interface TransportHooks {
  __damoclesE2e: {
    loopback: { cutTransport(options: { hold: boolean }): void; releaseTransport(): void; coreState(): Promise<{ epoch: string | null }> };
    remote: { reconnectNow(authorityKey: string): void };
  };
}

const marker = (turn: number): string => `Reply-${String(turn).padStart(2, '0')}:`;

/** The daemon's own log lines, from every log file in its run folder. */
function daemonLog(home: HermeticHome): string {
  const root = serverDir(home);
  return filesUnder(root).filter((file) => /(^|\/)daemon[^/]*\.log$/.test(file)).map((file) => fs.readFileSync(path.join(root, ...file.split('/')), 'utf8')).join('\n');
}

/** The chat page that shows `text`: the fresh attach replaced the page the test held. */
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

test('a rejoin replaying a transcript larger than the held-frame bound to a live client completes with no overflow and one fresh attach', { tag: LOOPBACK_TAG }, async ({ home, launch }, testInfo) => {
  test.setTimeout(300_000);
  const stub = await startLoopbackStub(home);
  const folder = path.join(home.root, 'long-transcript');
  fs.mkdirSync(folder, { recursive: true });
  let app: ElectronApplication | undefined;
  let failure: unknown;
  try {
    ({ app } = await launch({ env: { ...LOOPBACK_ENV.env, DAMOCLES_E2E_RECONNECTION_GRACE_MS: String(GRACE_MS), DAMOCLES_E2E_MAX_HELD_BYTES: String(MAX_HELD_BYTES) } }));
    const { tab } = await newLoopbackChat(app, folder);
    for (let turn = 0; turn < TURNS; turn++) {
      // one chunk, so the live stream posts one partial per reply
      stub.replies.push({ chunks: [`${marker(turn)}${'y'.repeat(REPLY_CHARS)}`] });
      await sendPrompt(tab, `Turn ${turn}`);
      await expect(tab.getByText(marker(turn), { exact: false })).toBeVisible({ timeout: 60_000 });
      await awaitTurnEnd(tab);
    }
    const shown = (page: Page): Promise<string[] | null> => page.evaluate(() => document.body.textContent?.match(/Reply-\d\d:/g) ?? null);
    // the page shows the transcript before the drop as it shows it after the rejoin
    const before = await shown(tab);
    expect(before).toContain(marker(TURNS - 1));
    const { epoch } = await app.evaluate(() => (globalThis as unknown as TransportHooks).__damoclesE2e.loopback.coreState());
    await app.evaluate(() => (globalThis as unknown as TransportHooks).__damoclesE2e.loopback.cutTransport({ hold: true }));
    await expect.poll(() => daemonLog(home), { timeout: 60_000 }).toMatch(/connection-\d+: the grace ended/);
    await app.evaluate(() => {
      const hooks = (globalThis as unknown as TransportHooks).__damoclesE2e;
      hooks.loopback.releaseTransport();
      hooks.remote.reconnectNow('loopback');
    });
    const rejoining = `[remote] loopback: rejoining 1 chats through views.join (epoch ${epoch})`;
    await expect.poll(() => mainLog(home), { timeout: 60_000 }).toContain(rejoining);
    const rejoined = await chatShowing(app, marker(TURNS - 1));
    expect(await shown(rejoined)).toEqual(before);
    await sendPrompt(rejoined, 'After the rejoin');
    await expect(rejoined.getByText('Echo: After the rejoin', { exact: true })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(rejoined);
    expect(daemonLog(home)).not.toContain('held frames passed the per-connection bound');
    expect(mainLog(home).split(rejoining).length - 1).toBe(1);
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
