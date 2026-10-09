import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { alive, lockInTurn } from './fair-lock';

// The OS gives keyboard focus and the pointer's hover to one window at a time, and each app's window takes them as it opens
// or closes, so every Playwright worker serializes on this lock in the OS temp folder.
const LOCK_TARGET = path.join(os.tmpdir(), 'damocles-e2e-foreground');
// One file per app a worker has open, named <worker pid>-<n>, so a holder can wait until no other worker has one.
const OPEN_APPS = path.join(os.tmpdir(), 'damocles-e2e-open-apps');
const OPEN_APPS_POLL_MS = 250;
// Longer than the slowest test's own timeout (300 s) plus its teardown, so a waiter outlasts every other worker's test.
export const FOREGROUND_WAIT_MS = 330_000;

let holding = false;
let opened = 0;

// Apps other workers have open; a worker that died leaves its files behind, and they no longer count.
function othersOpen(): number {
  fs.mkdirSync(OPEN_APPS, { recursive: true });
  return fs.readdirSync(OPEN_APPS).filter((name) => {
    const pid = Number(name.split('-')[0]);
    return pid !== process.pid && alive(pid);
  }).length;
}

function ownOpen(): boolean {
  fs.mkdirSync(OPEN_APPS, { recursive: true });
  return fs.readdirSync(OPEN_APPS).some((name) => name.startsWith(`${process.pid}-`));
}

// Waiters take the lock in arrival order, so a worker running foreground tests back to back never starves another's launch.
const lock = (onCompromised: (err: Error) => void): Promise<() => Promise<void>> => lockInTurn(LOCK_TARGET, 'foreground', FOREGROUND_WAIT_MS, onCompromised);

/**
 * Records an app this worker is about to open and returns what removes the record once the app has closed. No worker opens
 * an app while another holds the foreground; a worker that already has one open, or holds the foreground, goes on at once.
 */
export async function openingApp(): Promise<() => void> {
  const file = path.join(OPEN_APPS, `${process.pid}-${++opened}`);
  const record = (): void => fs.writeFileSync(file, '');
  if (holding || ownOpen()) {
    record();
  } else {
    // Recorded while the lock is held, so a holder that takes it next already sees this app.
    // A brief hold: losing it to a takeover only lets that holder see this app a moment later.
    const release = await lock(() => undefined);
    try {
      record();
    } finally {
      await release();
    }
  }
  return () => fs.rmSync(file, { force: true });
}

/**
 * Holds the foreground while `use` runs: no other worker has an app open, and none opens one until it returns. A lock lost
 * meanwhile (not refreshed within LOCK_STALE_MS, so another worker may have taken it) fails the test.
 */
export async function withForeground(use: () => Promise<void>): Promise<void> {
  let compromised: Error | undefined;
  const release = await lock((err) => {
    compromised = err;
  });
  holding = true;
  try {
    const deadline = Date.now() + FOREGROUND_WAIT_MS;
    while (othersOpen() > 0) {
      if (Date.now() > deadline) throw new Error(`Other workers kept an app open for ${FOREGROUND_WAIT_MS / 1000} s`);
      await new Promise((resolve) => setTimeout(resolve, OPEN_APPS_POLL_MS));
    }
    await use();
  } finally {
    holding = false;
    if (compromised === undefined) await release();
  }
  if (compromised !== undefined) throw new Error(`The foreground lock was lost during the test: ${compromised.message}`);
}
