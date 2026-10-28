import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { ShellHost } from '../../src/desktop/preload/shell-channels';
import { overlayPage, popupPage, popupToasts, recordToasts, shellPage, shellState } from '../desktop/support/shell';
import { activeTerminal, openTerminal, runInTerminal, terminalText } from '../desktop/support/terminal';
import { writeUserSettings } from '../desktop/support/hermetic';
import { changedKey, connectDialog, failureAlert } from './support/connect-ui';
import { daemonPids, shutdownHostDaemon } from './support/daemon-teardown';
import { expect, holdFor, pageNow, reconnectPhase, sightings, test, watchConnectionUi, type ProxiedHost } from './support/flaky';
import { mainLog } from '../desktop/support/app';
import type { HermeticHome } from '../desktop/support/hermetic';
import { newRemoteChat, startTargetStub } from './support/target-agent';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { awaitTurnEnd } from '../desktop/support/ui';
import { addHost, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG } from './support/remote';

const APP = '/srv/app';
// a blackhole shows its amber dot and banner within this, well before the 20 s timeout that decides a drop
const BLACKHOLE_SHOWN_MS = 8000;
// the blackhole test heals by this, leaving the heal itself 5 s before the 20 s timeout
const HEAL_BY_MS = 15_000;
// one latency measurement: 5 pings 2 s apart, run every 60 s, the first 10 s after connecting
const MEASUREMENT_MS = 60_000 + 5 * 2000;
const DROP_MS = 120_000;

const banner = (shell: Page): Locator => shell.locator('[data-testid="connection-banner"], [data-testid="connection-banner-edge"]').first();
const dot = (shell: Page): Locator => shell.getByTestId('host-status-dot').first();

/** Connects prod-1 and waits until main attached to its core, so an outage meets an attached client, not a first attach. */
async function connect(app: ElectronApplication, home: HermeticHome): Promise<{ readonly hostId: string; readonly key: string; readonly shell: Page }> {
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, APP);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  await expect.poll(() => mainLog(home), { timeout: 60_000 }).toContain(`[remote] attached to the core on ssh+${hostId} (attach 1,`);
  return { hostId, key, shell: await shellPage(app) };
}

/** Retry on the failure banner: the chat page's when a prod-1 chat covers the chat slot, else the shell's. */
async function retry(app: ElectronApplication): Promise<void> {
  let button: Locator | undefined;
  await expect.poll(async () => {
    button = undefined;
    for (const page of app.windows().filter((candidate) => !candidate.isClosed())) {
      const candidate = page.locator('[data-testid="chat-connection-banner-reconnect"], [data-testid="connection-banner-reconnect"]').first();
      if (await candidate.isVisible()) button = candidate;
    }
    return button !== undefined;
  }, { timeout: 30_000 }).toBe(true);
  await button!.click();
}

async function host(app: ElectronApplication, hostId: string): Promise<ShellHost> {
  const found = (await shellState(app)).hosts.find((candidate) => candidate.hostId === hostId);
  if (!found) throw new Error(`no host ${hostId} in ShellState`);
  return found;
}

/** The numbers of every `seq-<n>` row on the terminal's screen, top to bottom. */
async function sequence(shell: Page): Promise<number[]> {
  return (await terminalText(shell)).split('\n').flatMap((row) => {
    const found = /^seq-(\d+)$/.exec(row.trim());
    return found ? [Number(found[1])] : [];
  });
}

async function runCounter(app: ElectronApplication): Promise<Page> {
  const shell = await openTerminal(app);
  await runInTerminal(shell, "i=0; while true; do i=$((i+1)); echo \"seq-$i\"; sleep 0.2; done");
  await expect.poll(async () => (await sequence(shell)).length, { timeout: 30_000 }).toBeGreaterThan(5);
  return shell;
}

test.beforeEach(({ home }) => {
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
});

test('a drop under 1 s, cut with a reset and restored, shows no banner and no dot change, and terminal output goes on with no gap and no duplicate', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, proxied }) => {
  test.setTimeout(600_000);
  const target: ProxiedHost = await proxied('prod-1');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const { hostId } = await connect(app, home);
  const shell = await runCounter(app);
  await watchConnectionUi(shell);
  const before = target.proxy.accepted();
  const last = Math.max(...(await sequence(shell)));
  // the cut lasts no longer than the reset: the next ssh the reconnect loop starts goes straight through
  target.proxy.cut();
  await expect.poll(() => target.proxy.accepted(), { timeout: 30_000 }).toBeGreaterThan(before);
  // the counter runs on the target throughout; output written during the cut arrives, every line once
  await expect.poll(async () => Math.max(...(await sequence(shell))), { timeout: 30_000 }).toBeGreaterThan(last + 20);
  const seen = await sequence(shell);
  expect(seen).toEqual(seen.map((_n, index) => seen[0]! + index));
  expect(await sightings(shell)).toEqual([]);
  await expect(dot(shell)).toHaveAttribute('data-shape', 'connected');
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running');
  await shutdownHostDaemon(app, hostId, target.fixture);
});

test('a blackholed connection, bytes held with no reset, shows the amber dot and the banner within 8 s; healed before the 20 s timeout, the same connection resumes with no gap and no duplicate', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, proxied }) => {
  test.setTimeout(600_000);
  const target = await proxied('prod-1');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const { hostId } = await connect(app, home);
  const shell = await runCounter(app);
  await watchConnectionUi(shell);
  const accepted = target.proxy.accepted();
  const holedAt = await pageNow(shell);
  target.proxy.blackhole();
  await expect(banner(shell)).toBeVisible({ timeout: BLACKHOLE_SHOWN_MS });
  // the dot renders from the same host state as the banner
  await expect(dot(shell)).toHaveAttribute('data-shape', 'connecting', { timeout: 2000 });
  const first = (await sightings(shell))[0]!;
  expect(first.at - holedAt).toBeLessThan(BLACKHOLE_SHOWN_MS);
  expect(await reconnectPhase(app, `ssh+${hostId}`)).toBe('suspect');
  const last = Math.max(...(await sequence(shell)));
  // the network heals before the 20 s timeout: TCP delivers what it held on the same connection
  expect((await pageNow(shell)) - holedAt).toBeLessThan(HEAL_BY_MS);
  target.proxy.restore();
  await expect(banner(shell)).toHaveCount(0, { timeout: 30_000 });
  expect((await sightings(shell)).map((sighting) => sighting.what)).toContain('banner:reconnected');
  await expect(dot(shell)).toHaveAttribute('data-shape', 'connected');
  expect(await reconnectPhase(app, `ssh+${hostId}`)).toBeUndefined();
  expect(target.proxy.accepted()).toBe(accepted);
  expect(mainLog(home)).not.toMatch(/\[remote\] ssh\+\S+: attempt \d+/);
  await expect.poll(async () => Math.max(...(await sequence(shell))), { timeout: 30_000 }).toBeGreaterThan(last + 20);
  const seen = await sequence(shell);
  expect(seen).toEqual(seen.map((_n, index) => seen[0]! + index));
  expect((await host(app, hostId)).reconnect).toBeUndefined();
  await shutdownHostDaemon(app, hostId, target.fixture);
});

test('700 ms added each way shows the slow state within one measurement with no banner, and removing it returns to normal at the next', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, proxied }) => {
  // three measurements set the baseline, then one slow and one normal: about five minutes of the 60 s schedule
  test.setTimeout(900_000);
  const target = await proxied('prod-1');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const { hostId, shell } = await connect(app, home);
  await expect.poll(async () => (await host(app, hostId)).latency?.history.length ?? 0, { timeout: 3 * MEASUREMENT_MS }).toBeGreaterThanOrEqual(3);
  expect((await host(app, hostId)).latency?.slow).toBe(false);
  await watchConnectionUi(shell);
  const measured = (await host(app, hostId)).latency!.history.length;
  target.proxy.delay(700);
  await expect.poll(async () => (await host(app, hostId)).latency?.history.length, { timeout: MEASUREMENT_MS + 30_000 }).toBeGreaterThan(measured);
  const slow = (await host(app, hostId)).latency!;
  expect(slow).toMatchObject({ slow: true });
  expect(slow.latencyMs).toBeGreaterThanOrEqual(700);
  await expect(dot(shell)).toHaveAttribute('data-shape', 'slow');
  await expect(dot(shell)).toHaveAttribute('aria-label', new RegExp(`Slow connection to prod-1 \\(${slow.latencyMs} ms\\)`));
  target.proxy.delay(0);
  await expect.poll(async () => (await host(app, hostId)).latency?.history.length, { timeout: MEASUREMENT_MS + 30_000 }).toBeGreaterThan(measured + 1);
  expect((await host(app, hostId)).latency?.slow).toBe(false);
  await expect(dot(shell)).toHaveAttribute('data-shape', 'connected');
  // slow is never an outage: no banner and no amber dot at any point
  expect(await sightings(shell)).toEqual([]);
  await shutdownHostDaemon(app, hostId, target.fixture);
});

test('a killed daemon is followed by a reconnect that shows "prod-1\'s Damocles server restarted"', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, proxied }) => {
  test.setTimeout(600_000);
  const target = await proxied('prod-1');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  await recordToasts(app);
  const { hostId, shell } = await connect(app, home);
  const [pid] = await daemonPids(target.fixture);
  await target.fixture.sh(`kill -KILL ${pid}`);
  // the restart's toast opens the popup window, so both wait as long
  const popup = await popupPage(app, 120_000);
  await expect(popupToasts(popup).filter({ hasText: 'prod-1\'s Damocles server restarted' })).toBeVisible({ timeout: 120_000 });
  await expect(dot(shell)).toHaveAttribute('data-shape', 'connected');
  expect(await daemonPids(target.fixture)).not.toContain(pid);
  await shutdownHostDaemon(app, hostId, target.fixture);
});

test('a changed host key during a reconnect raises the security modal and connects nowhere', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, proxied }) => {
  test.setTimeout(600_000);
  const target = await proxied('prod-1');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const { hostId, shell } = await connect(app, home);
  // the host is reinstalled under the session: sshd's restart ends it, and every later attempt meets the new key
  const [pid] = await daemonPids(target.fixture);
  await target.fixture.rotateHostKey();
  target.proxy.cut();
  const overlay = await overlayPage(app);
  await expect(changedKey(overlay, 'prod-1')).toBeVisible({ timeout: 120_000 });
  await expect(dot(shell)).toHaveAttribute('data-shape', 'failed');
  expect((await host(app, hostId)).reconnect).toMatchObject({ phase: 'failed', code: 'hostKeyChanged' });
  // no retry follows a changed key: the proxy sees no new connection
  const accepted = target.proxy.accepted();
  await changedKey(overlay, 'prod-1').getByRole('button', { name: 'Close' }).click();
  // closed once, the modal stays closed and the Connect dialog shows the failed step; nothing starts until the user retries
  await expect(changedKey(overlay, 'prod-1')).toHaveCount(0);
  await expect(failureAlert(overlay)).toHaveAttribute('data-code', 'hostKeyChanged');
  await expect(failureAlert(overlay)).toContainText("prod-1's host key has changed");
  expect(target.proxy.accepted()).toBe(accepted);
  await overlay.keyboard.press('Escape');
  await expect(connectDialog(overlay)).toHaveCount(0);
  expect(target.proxy.accepted()).toBe(accepted);
  // the user checks the new key and records it; Retry then reaches the daemon that kept running all along
  await ssh.trust(target.fixture);
  await retry(app);
  await expect(dot(shell)).toHaveAttribute('data-shape', 'connected', { timeout: 120_000 });
  expect(await daemonPids(target.fixture)).toEqual([pid]);
  await shutdownHostDaemon(app, hostId, target.fixture);
});

test('an agent turn running when the connection drops finishes during a 2-minute drop, and the chat shows the whole transcript after reconnect', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, proxied }) => {
  test.setTimeout(900_000);
  const target = await proxied('prod-1');
  const stub = await startTargetStub(home, target.fixture);
  try {
    const { app } = await launch({ env: remoteEnv(ssh, mirror) });
    const { hostId, key, shell } = await connect(app, home);
    const tab = await newRemoteChat(app, key);
    let release!: () => void;
    stub.replies.push({ chunks: ['Part one.', ' Part two.', ' Part three.'], holdAfterFirst: new Promise<void>((resolve) => (release = resolve)) });
    await sendPrompt(tab, 'Write three parts');
    await expect(tab.getByText('Part one.', { exact: false })).toBeVisible({ timeout: 60_000 });
    target.proxy.refuse();
    await expect(banner(shell)).toBeVisible({ timeout: 30_000 });
    // the run goes on on the target with nobody connected, and ends there: its session file holds the whole reply
    release();
    await expect.poll(async () => (await target.fixture.sh("grep -rl 'Part three' /home/dev/.damocles/pi/agent/sessions || true", 'dev')).trim(), { timeout: 60_000 }).not.toBe('');
    await holdFor(DROP_MS);
    target.proxy.restore();
    await expect(tab.getByText('Part one. Part two. Part three.', { exact: true })).toBeVisible({ timeout: 120_000 });
    await awaitTurnEnd(tab);
    // the transcript once: one prompt, one reply
    await expect(tab.getByTestId('user-message-time')).toHaveCount(1);
    await expect(tab.getByText('Part one. Part two. Part three.', { exact: true })).toHaveCount(1);
    await shutdownHostDaemon(app, hostId, target.fixture);
  } finally {
    await stub.close();
  }
});
