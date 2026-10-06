import { spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _electron as electron, type ElectronApplication, type TestInfo } from '@playwright/test';
import { hermeticEnv, REPO_ROOT, type HermeticHome } from './hermetic';
import { launchPackaged, packagedAppPath, withoutMainProcess } from './packaged-app';

export const MAIN_SCRIPT = path.join(REPO_ROOT, 'dist', 'desktop', 'main.js');

// Main bounds its own quit (DISPOSE_TIMEOUT_MS, 10 s); a close past this is hung, and it must end well inside the 120 s
// fixture teardown (playwright.desktop.config.ts `timeout`), or the worker times out with no log attached.
const QUIT_TIMEOUT_MS = 30_000;
const KILLED_EXIT_TIMEOUT_MS = 10_000;
const KILLED_EXIT_POLL_MS = 100;

// `root` and every process below it, from Windows' process table.
function windowsProcessTree(root: number): number[] {
  const table = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], { windowsHide: true, encoding: 'utf8' }).stdout;
  const children = new Map<number, number[]>();
  for (const line of table.split(/\r?\n/)) {
    const [pid, parent] = line.trim().split(' ').map(Number);
    if (pid === undefined || parent === undefined || !Number.isInteger(pid) || !Number.isInteger(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const tree = new Set([root]);
  for (const pid of tree) for (const child of children.get(pid) ?? []) tree.add(child);
  return [...tree];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Playwright spawns a dev launch as a process group leader on POSIX; on Windows taskkill /T ends its Chromium children.
async function killTree(proc: ChildProcess): Promise<void> {
  const root = proc.pid;
  if (root === undefined || proc.exitCode !== null || proc.signalCode !== null) return;
  const pids = process.platform === 'win32' ? windowsProcessTree(root) : [root];
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(root), '/T', '/F'], { windowsHide: true });
  else process.kill(-root, 'SIGKILL');
  // A killed process ends after the kill returns, and Windows refuses to remove a folder a live process works in, so
  // home.dispose() would fail.
  const deadline = Date.now() + KILLED_EXIT_TIMEOUT_MS;
  while (pids.some(isAlive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, KILLED_EXIT_POLL_MS));
}

async function closeWithin(app: ElectronApplication, proc: ChildProcess): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), QUIT_TIMEOUT_MS)));
  try {
    if ((await Promise.race([app.close().then(() => 'closed' as const), timedOut])) === 'closed') return;
  } finally {
    clearTimeout(timer);
  }
  await killTree(proc);
  throw new Error(`the app did not quit within ${QUIT_TIMEOUT_MS} ms of app.close(); killed it`);
}

export interface DesktopApp {
  readonly app: ElectronApplication;
  /** Main-process stdout and stderr so far. */
  output(): string;
  startTracing(): Promise<void>;
  /** Stops tracing if it is running, saving the trace when `path` is given. */
  stopTracing(path?: string): Promise<void>;
  /** Quits the app; one that does not quit in time is killed and the call rejects. */
  close(): Promise<void>;
}

export interface LaunchOptions {
  env?: Record<string, string>;
  args?: string[];
}

/**
 * Launches the desktop app on the hermetic home (the packaged executable when PACKAGED_APP_ENV names one), with its output
 * captured for artifacts. With `mainProcess` false, a dev launch refuses main-process calls as a packaged one does.
 */
export async function launchDesktop(h: HermeticHome, options: LaunchOptions = {}, mainProcess = true): Promise<DesktopApp> {
  const args = ['--user-data-dir', h.userData, ...(options.args ?? [])];
  const env = hermeticEnv(h, options.env);
  const packaged = packagedAppPath();
  const app = packaged !== undefined
    ? await launchPackaged(packaged, args, env, h.root)
    // chromiumSandbox: without it Playwright prepends --no-sandbox on Linux.
    : await electron.launch({ args: [MAIN_SCRIPT, ...args], env, cwd: h.root, chromiumSandbox: true });
  let output = '';
  let tracing = false;
  const proc = app.process();
  proc.stdout?.on('data', (d: Buffer) => (output += d.toString()));
  proc.stderr?.on('data', (d: Buffer) => (output += d.toString()));
  return {
    app: mainProcess ? app : withoutMainProcess(app),
    output: () => output,
    startTracing: async () => {
      await app.context().tracing.start({ screenshots: true, snapshots: true });
      tracing = true;
    },
    stopTracing: async (tracePath) => {
      if (!tracing || proc.exitCode !== null) return;
      tracing = false;
      await app.context().tracing.stop(tracePath ? { path: tracePath } : {});
    },
    close: async () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      // A packaged app's close bounds its own quit and kills it (packaged-app.ts).
      await (packaged !== undefined ? app.close() : closeWithin(app, proc));
    },
  };
}

/**
 * The main process log, which holds every line from the first one on; captured stdout starts only once Playwright attaches.
 * The sink flushes on the next turn of the event loop, so poll it.
 */
export function mainLog(h: HermeticHome): string {
  const file = path.join(h.userData, 'logs', 'Damocles.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** Attaches the main-process output and every log file under userData, so a failure is debuggable offline. */
export async function attachDiagnostics(testInfo: TestInfo, name: string, desktop: DesktopApp, h: HermeticHome): Promise<void> {
  await testInfo.attach(`${name}-main-output.txt`, { body: desktop.output(), contentType: 'text/plain' });
  const logs = path.join(h.userData, 'logs');
  if (!fs.existsSync(logs)) return;
  for (const file of fs.readdirSync(logs)) {
    await testInfo.attach(`${name}-${file}`, { path: path.join(logs, file), contentType: 'text/plain' });
  }
}
