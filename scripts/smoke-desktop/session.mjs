// One smoke session: the app's launches on a hermetic home, and that home's removal; see README.md "Hermetic home".
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createSmokeHome, retireRun } from './hermetic.mjs';

// Above main's own bounded quit (DISPOSE_TIMEOUT_MS, 10 s), so only a hung quit (a quit dialog left open) is killed.
export const CLOSE_TIMEOUT_MS = 20_000;
const KILLED_EXIT_TIMEOUT_MS = 10_000;

/** Whether `promise` settles within `ms`; rejects when it rejects first. */
async function within(promise, ms) {
  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([promise.then(() => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Kills the launched app's process tree and waits for `exited`. Playwright spawns a dev launch as a process group leader on
 * POSIX and through cmd.exe on Windows, where taskkill /T ends the Electron tree below it.
 */
export async function killTree(proc, exited) {
  if (proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    await new Promise((resolve) => {
      const child = spawn(taskkill, ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true });
      child.once('error', resolve);
      child.once('close', resolve);
    });
  } else {
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch (err) {
      if (err?.code !== 'ESRCH') throw err;
    }
  }
  if (!(await within(exited, KILLED_EXIT_TIMEOUT_MS))) {
    throw new Error(`the app's process ${proc.pid} did not end within ${KILLED_EXIT_TIMEOUT_MS / 1000} s of being killed`);
  }
}

/**
 * `launchApp(home)` starts the app on `home` and resolves to `{ close(), exited, kill() }`: `close` asks it to quit,
 * `exited` settles (never rejects) when its main process ends, and `kill` ends its process tree.
 */
export function createSmokeSession({ dir, realHome, realLocalAppData, launchApp, closeTimeoutMs = CLOSE_TIMEOUT_MS, now = () => Date.now() }) {
  let running;
  let home;

  async function start() {
    const handle = await launchApp(home);
    running = handle;
    handle.exited.then(() => { if (running === handle) running = undefined; });
  }

  /** Quits the app, killing it when its close throws or does not finish within `closeTimeoutMs`. */
  async function stop() {
    const handle = running;
    if (!handle) return { closed: 'not running' };
    const closing = Promise.resolve().then(() => handle.close()).then(() => handle.exited);
    closing.catch(() => {});
    let reason;
    try {
      if (await within(closing, closeTimeoutMs)) {
        running = undefined;
        return { closed: 'quit' };
      }
      reason = `it did not quit within ${closeTimeoutMs / 1000} s (a quit dialog may be open)`;
    } catch (err) {
      reason = `closing it failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    await handle.kill();
    running = undefined;
    return { closed: 'killed', reason };
  }

  /** Starts the app on a new copy of the developer's home, keeping the previous run's logs. */
  async function launch() {
    if (running) return { ok: true, alreadyRunning: true, home: home?.home };
    home = undefined;
    home = await createSmokeHome({ dir, realHome, realLocalAppData, now: now() });
    await start();
    return { ok: true, home: home.home, notices: home.notices };
  }

  /** Quits the app and starts it again on the same home, as a user's quit and relaunch would. */
  async function relaunch() {
    if (!home) throw new Error('No smoke home to relaunch on; post --launch first.');
    const stopped = await stop();
    await start();
    return { ok: true, home: home.home, ...stopped };
  }

  /** Quits the app, then deletes the home with its credentials whether or not the quit succeeded. */
  async function quit() {
    let stopped;
    let retired;
    try {
      stopped = await stop();
    } finally {
      home = undefined;
      retired = await retireRun(dir);
    }
    return { ...stopped, ...retired };
  }

  return { launch, relaunch, quit, home: () => home, current: () => running };
}
