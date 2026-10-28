import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, TestInfo } from '@playwright/test';
import { createLauncherPool, installProcessLauncher, type Launcher } from '../../../src/core/process-launcher';
import { localRunPaths } from '../../../src/desktop/daemon/token';
import { expect } from './fixtures';
import { REPO_ROOT, type HermeticHome } from './hermetic';
import { isAlive, run, windowsProcessTree } from './app';
import { shellState } from './shell';
import { answerDialogs, answerOpenDialog, clickMenu } from './ui';

// Specs that start the loopback daemon carry this tag, so `--grep @loopback` runs them (CI's loopback job).
export const LOOPBACK_TAG = '@loopback';
// The loopback authority needs the e2e hooks, which also enable it in a dev build.
export const LOOPBACK_ENV = { env: { DAMOCLES_E2E_HOOKS: '1' } };
export const LOCAL_DAEMON = 'Local daemon';
export const LOOPBACK_TRUST_PROMPT = `on ${LOCAL_DAEMON}?`;
// Review screenshots of the remote UI, in every theme, go to this folder only when it is set.
export const REVIEW_SHOTS: string | undefined = process.env['DAMOCLES_LOOPBACK_SHOTS'];

interface Run {
  readonly kind: 'chat' | 'terminal';
  readonly id: string;
  readonly projectKey: string;
  readonly title: string;
  readonly state: string;
  readonly providers: readonly string[];
}

interface LoopbackHooks {
  __damoclesE2e: {
    loopback: {
      state(): string;
      listRuns(): Promise<{ runs: Run[] }>;
      shutdownNow(): Promise<void>;
    };
  };
}

/** The daemon's home: HOME and USERPROFILE of the daemon and every child it starts, under the test's userData. */
export const loopbackHome = (home: HermeticHome): string => path.join(home.userData, 'loopback-home');

/** The daemon's run folder in its home: its lock, pid file and logs live under ~/.damocles/server. */
export const serverDir = (home: HermeticHome): string => path.join(loopbackHome(home), '.damocles', 'server');

// the daemon's machine key reads the machine id through the launcher on Windows and macOS
let launcher: Launcher | undefined;

/** The pid file of the daemon of a home, in the run folder the daemon and its bridge key by this machine's id. */
async function pidFileIn(daemonHome: string): Promise<string> {
  if (!launcher) {
    launcher = createLauncherPool({ workerPath: path.join(REPO_ROOT, 'dist', 'process-launcher-worker.js'), sentinelPath: path.join(REPO_ROOT, 'dist', 'sentinel.js') });
    installProcessLauncher(launcher);
  }
  return (await localRunPaths(daemonHome)).pidFile;
}

const pidFile = (home: HermeticHome): Promise<string> => pidFileIn(loopbackHome(home));

/** The pid the pid file of a home's daemon names; undefined when it has none. */
export async function pidIn(daemonHome: string): Promise<number | undefined> {
  const file = await pidFileIn(daemonHome);
  if (!fs.existsSync(file)) return undefined;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: unknown };
  if (typeof parsed.pid !== 'number') throw new Error(`no pid in ${file}`);
  return parsed.pid;
}

/** The running daemon's pid from its pid file; throws while it has written none. */
export async function daemonPid(home: HermeticHome): Promise<number> {
  const pid = await pidIn(loopbackHome(home));
  if (pid === undefined) throw new Error(`no pid file for the daemon in ${loopbackHome(home)}`);
  return pid;
}

/** A live process's command line, from Windows' process table or ps; undefined once it is gone or unreadable. */
async function commandLineOf(pid: number): Promise<string | undefined> {
  const read = process.platform === 'win32'
    ? await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`])
    : await run('ps', ['-o', 'args=', '-p', String(pid)]);
  const line = read.stdout.trim();
  return line === '' ? undefined : line;
}

/** `root` and every process below it: Windows' process table, or ps elsewhere. */
export async function processTree(root: number): Promise<number[]> {
  if (process.platform === 'win32') return windowsProcessTree(root);
  const table = await run('ps', ['-A', '-o', 'pid=,ppid=']);
  if (table.code !== 0) throw new Error(`ps exited with code ${table.code}: ${table.stderr.trim()}`);
  const children = new Map<number, number[]>();
  for (const line of table.stdout.split('\n')) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || parent === undefined || !Number.isInteger(pid) || !Number.isInteger(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const tree = new Set([root]);
  for (const pid of tree) for (const child of children.get(pid) ?? []) tree.add(child);
  return [...tree];
}

/**
 * Opens `folder` through "Developer: Open Folder Through Local Daemon...", answering the native picker and the trust question
 * that names the host, and resolves the new project's key once main selected it.
 */
export async function openThroughLocalDaemon(app: ElectronApplication, folder: string, trust = true): Promise<string> {
  await answerOpenDialog(app, folder);
  await answerDialogs(app, { [LOOPBACK_TRUST_PROMPT]: trust ? 'Trust Folder' : "Don't Trust" });
  await clickMenu(app, 'damocles.developer.openFolderThroughLocalDaemon');
  let key = '';
  await expect.poll(async () => {
    const state = await shellState(app);
    const project = state.projects.find((candidate) => candidate.authority.kind === 'loopback' && candidate.fsPath === folder);
    key = project?.key ?? '';
    return project !== undefined && project.connection === 'connected' && state.selected.projectKey === project.key;
  }, { timeout: 60_000 }).toBe(true);
  return key;
}

export function listRuns(app: ElectronApplication): Promise<{ runs: Run[] }> {
  return app.evaluate(() => (globalThis as unknown as LoopbackHooks).__damoclesE2e.loopback.listRuns());
}

/**
 * Ends the daemon with control.shutdownNow and waits until neither it nor any process it started (pty host, formatter
 * hosts, the shells in its terminals) is alive. Every spec that starts a daemon ends with this.
 */
export async function shutdownDaemon(app: ElectronApplication, home: HermeticHome): Promise<void> {
  const tree = await processTree(await daemonPid(home));
  const file = await pidFile(home);
  await app.evaluate(() => (globalThis as unknown as LoopbackHooks).__damoclesE2e.loopback.shutdownNow());
  await expect.poll(() => tree.filter(isAlive), { timeout: 30_000 }).toEqual([]);
  await expect.poll(() => fs.existsSync(file)).toBe(false);
}

function running(app: ElectronApplication): boolean {
  try {
    const proc = app.process();
    return proc.exitCode === null && proc.signalCode === null;
  } catch {
    // Playwright throws once it disposed of the app, as after a close that timed out and killed it
    return false;
  }
}

/**
 * A test's `finally`: ends a daemon still running in the test's home, so a test that failed midway leaves none behind. It
 * asks through the app while the app runs, and kills the daemon's process tree when no app is left to ask.
 */
export async function endLeftoverDaemon(app: ElectronApplication | undefined, home: HermeticHome): Promise<void> {
  if (!fs.existsSync(await pidFile(home))) return;
  if (app && running(app)) {
    await shutdownDaemon(app, home);
    return;
  }
  await killDaemonIn(loopbackHome(home));
}

/** Kills the process tree of the daemon whose pid file is in `daemonHome`'s run folder; nothing when no daemon.js serve runs. */
export async function killDaemonIn(daemonHome: string): Promise<void> {
  const root = await pidIn(daemonHome);
  if (root === undefined) return;
  // a stale pid file can name a pid the system has since given to a process that is no daemon (daemon.js serve)
  if (!/daemon\.js\S*\s+serve\b/.test((await commandLineOf(root)) ?? '')) return;
  const tree = await processTree(root);
  for (const pid of tree.filter(isAlive)) process.kill(pid, 'SIGKILL');
  await expect.poll(() => tree.filter(isAlive), { timeout: 30_000 }).toEqual([]);
}

/** A test's cleanup after a failure attaches its own error instead of replacing the failure's. */
export async function cleanUp(testInfo: TestInfo, failure: unknown, step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (error) {
    if (failure === undefined) throw error;
    await testInfo.attach('cleanup-error.txt', { body: error instanceof Error ? error.stack ?? error.message : String(error), contentType: 'text/plain' });
  }
}

/** Every file below `dir`, relative and '/'-separated; empty when it does not exist. */
export function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();
}
