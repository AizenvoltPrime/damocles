import { spawn, type ChildProcess } from 'node:child_process';
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
// killTree runs two of these (the table read, taskkill) after QUIT_TIMEOUT_MS; with the exit poll that stays inside the 120 s teardown.
const RUN_TIMEOUT_MS = 15_000;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Never a synchronous child process here: a lock holder refreshes its lock on this event loop (fair-lock.ts).
export function run(command: string, args: string[], timeoutMs = RUN_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.once('error', reject);
    // `killed` is set only by spawn's timeout here.
    child.once('close', (code) => (child.killed ? reject(new Error(`${command} did not finish within ${timeoutMs} ms`)) : resolve({ code, stdout, stderr })));
  });
}

/** `root` and every process below it, from Windows' process table. */
export async function windowsProcessTree(root: number): Promise<number[]> {
  const table = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }']);
  if (table.code !== 0) throw new Error(`Get-CimInstance Win32_Process exited with code ${table.code}: ${table.stderr.trim()}`);
  const children = new Map<number, number[]>();
  for (const line of table.stdout.split(/\r?\n/)) {
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

/** Kills `proc`'s tree and waits until it is gone; an unreadable Windows process table still kills the root's tree, then rejects. */
// Playwright spawns a dev launch as a process group leader on POSIX; on Windows taskkill /T ends its Chromium children.
export async function killTree(proc: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>): Promise<void> {
  const root = proc.pid;
  if (root === undefined || proc.exitCode !== null || proc.signalCode !== null) return;
  const tree: { pids: number[]; error?: unknown } = process.platform === 'win32'
    ? await windowsProcessTree(root).then((pids) => ({ pids }), (error: unknown) => ({ pids: [root], error }))
    : { pids: [root] };
  // Every pid read, since a root that exited meanwhile leaves /T nothing to walk from. taskkill's exit code is not trusted:
  // the liveness poll below decides.
  if (process.platform === 'win32') await run('taskkill', ['/F', '/T', ...tree.pids.flatMap((pid) => ['/PID', String(pid)])]);
  else process.kill(-root, 'SIGKILL');
  // A killed process ends after the kill returns, and Windows refuses to remove a folder a live process works in, so
  // home.dispose() would fail.
  const deadline = Date.now() + KILLED_EXIT_TIMEOUT_MS;
  while (tree.pids.some(isAlive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, KILLED_EXIT_POLL_MS));
  if ('error' in tree) throw tree.error;
}

async function closeWithin(app: ElectronApplication, proc: ChildProcess, exit: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), QUIT_TIMEOUT_MS)));
  try {
    // app.close() returns at once when the app's browser connection already closed, before the process exits.
    if ((await Promise.race([app.close().then(() => exit).then(() => 'closed' as const), timedOut])) === 'closed') return;
  } finally {
    clearTimeout(timer);
  }
  const killFailure = await killTree(proc).then(() => '', (error: unknown) => `; reading its process tree failed: ${error instanceof Error ? error.message : String(error)}`);
  throw new Error(`the app did not quit within ${QUIT_TIMEOUT_MS} ms of app.close(); killed it${killFailure}`);
}

export interface DesktopApp {
  readonly app: ElectronApplication;
  /** Main-process stdout and stderr so far. */
  output(): string;
  startTracing(): Promise<void>;
  /** Stops tracing if it is running, saving the trace when `path` is given. */
  stopTracing(path?: string): Promise<void>;
  /**
   * Quits the app unless it already exited. Rejects when it does not quit in time (it is killed) and, once, when its main
   * process ended other than with exit code 0, which is a crash on the way out whose report is in output().
   */
  close(): Promise<void>;
}

export interface LaunchOptions {
  env?: Record<string, string>;
  args?: string[];
  /** A module the main process requires before the app's main script; a dev launch only. */
  require?: string;
}

/**
 * Launches the desktop app on the hermetic home (the packaged executable when PACKAGED_APP_ENV names one), with its output
 * captured for artifacts. With `mainProcess` false, a dev launch refuses main-process calls as a packaged one does.
 */
export async function launchDesktop(h: HermeticHome, options: LaunchOptions = {}, mainProcess = true): Promise<DesktopApp> {
  const args = ['--user-data-dir', h.userData, ...(options.args ?? [])];
  const env = hermeticEnv(h, options.env);
  const packaged = packagedAppPath();
  if (packaged !== undefined && options.require !== undefined) throw new Error('a packaged app runs no module ahead of its main script');
  const app = packaged !== undefined
    ? await launchPackaged(packaged, args, env, h.root)
    // chromiumSandbox: without it Playwright prepends --no-sandbox on Linux.
    : await electron.launch({ args: [...(options.require !== undefined ? ['-r', options.require] : []), MAIN_SCRIPT, ...args], env, cwd: h.root, chromiumSandbox: true });
  let output = '';
  let tracing = false;
  let exitReported = false;
  const proc = app.process();
  // A main process killed by a signal (a native abort) keeps exitCode null.
  const exited = (): boolean => proc.exitCode !== null || proc.signalCode !== null;
  const exit = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
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
      // Playwright discards the trace of an app that exited.
      if (!tracing || exited()) return;
      tracing = false;
      await app.context().tracing.stop(tracePath ? { path: tracePath } : {});
    },
    close: async () => {
      // A packaged app's close bounds its own quit and kills it (packaged-app.ts).
      if (!exited()) await (packaged !== undefined ? app.close() : closeWithin(app, proc, exit));
      if (exitReported) return;
      exitReported = true;
      if (proc.exitCode !== 0) throw new Error(`the main process ${proc.signalCode !== null ? `died of ${proc.signalCode}` : `exited with code ${proc.exitCode}`} instead of 0; see its main output`);
    },
  };
}

/**
 * The main process log, which holds every line from the first one on; captured stdout starts only once Playwright attaches.
 * While the app runs, the sink writes a line on a later turn of main's event loop, so wait for a line with
 * `expect.poll(() => mainLog(h))`, and read the absence of one only from `quitLog` or `logBeforeQuit`.
 */
export function mainLog(h: HermeticHome): string {
  const file = path.join(h.userData, 'logs', 'Damocles.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

const WILL_QUIT = '[shutdown] will-quit';

/** The main log once the last launch on `h` has quit: the sink writes every pending line as it closes at will-quit. */
export function quitLog(h: HermeticHome): string {
  const log = mainLog(h);
  if (!log.trimEnd().endsWith(WILL_QUIT)) throw new Error(`the main log does not end with ${WILL_QUIT}, so the app has not quit and may still write lines`);
  return log;
}

/** quitLog up to the last quit, for a check about what the app logged before its teardown. */
export function logBeforeQuit(h: HermeticHome): string {
  const log = quitLog(h);
  return log.slice(0, log.lastIndexOf('[shutdown] quitting'));
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
