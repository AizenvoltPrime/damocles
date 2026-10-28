// `daemon.js self-test`: proves a server package runs on this machine with its own Node (scripts/verify-server-package.mjs).
// Every package of node_modules is present, every external the bundles load is imported, node:sqlite opens with FTS5,
// ripgrep runs through the launcher's worker thread, the pty host's node-pty runs echo, and Damocles Core forks and answers
// its init through parentChannel().
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveRgPath } from '../../core/chat-panel/ripgrep';
import { createLauncherPool, installProcessLauncher, lockThreadSpawns, runProcess } from '../../core/process-launcher';
import { windowsSystemTool } from '../../core/system-tools';
import type { HostMessage, HostRequest } from '../pty-host/protocol';
import { daemonChildEnv } from './child-env';
import type { CoreAttach, CoreState } from './control-messages';
import type { DaemonState } from './daemon-state';
import { forkChild } from './process-starts';
import { createRemoteCoreHost } from './remote-core-host';
import { createRunRegistry } from './run-registry';
import { daemonStarters } from './serve';
import { localRunPaths } from './token';

const STEP_TIMEOUT_MS = 60_000;
const MARKER = 'damocles-self-test';

// scripts/build-server.mjs writes it at the package root
interface PackageInfo {
  readonly version: string;
  readonly target: string;
  readonly externals: readonly string[];
  // every top-level package of node_modules, so one no import reaches at load time is checked too
  readonly packages: readonly string[];
}

function within<T>(what: string, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${STEP_TIMEOUT_MS} ms`)), STEP_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function checkPackages(root: string, info: PackageInfo): Promise<void> {
  for (const name of info.packages) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(await fs.readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
    } catch (err) {
      throw new Error(`${name} is missing from node_modules: ${err instanceof Error ? err.message : String(err)}`);
    }
    if ((manifest as { name?: unknown } | null)?.name !== name) throw new Error(`node_modules/${name}/package.json does not name ${name}`);
  }
}

async function importExternals(root: string, info: PackageInfo): Promise<string> {
  await checkPackages(root, info);
  for (const name of info.externals) {
    try {
      await import(name);
    } catch (err) {
      throw new Error(`${name} does not load: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return `${info.packages.length} packages, ${info.externals.length} imported`;
}

function openSqlite(): string {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE VIRTUAL TABLE words USING fts5(text); INSERT INTO words VALUES ('${MARKER}');`);
    const row = db.prepare('SELECT count(*) AS hits FROM words WHERE words MATCH ?').get('"damocles"') as { hits: number };
    if (row.hits !== 1) throw new Error(`FTS5 found ${row.hits} rows`);
    return 'FTS5';
  } finally {
    db.close();
  }
}

async function runRipgrep(root: string): Promise<string> {
  const rg = await resolveRgPath({ resourceRoot: root, unpackedRoot: root });
  const output = await runProcess({ file: rg, args: ['--version'], stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }, { timeoutMs: STEP_TIMEOUT_MS });
  const text = output.stdout.toString('utf8');
  if (output.exit?.code !== 0 || !text.startsWith('ripgrep ')) throw new Error(`${rg} --version failed: ${output.stderr.toString('utf8').trim()}`);
  return text.split('\n')[0]!.trim();
}

function echoThroughPty(root: string): Promise<string> {
  const host = daemonStarters(root).startPtyHost();
  const [file, args] = process.platform === 'win32' ? [windowsSystemTool('cmd'), ['/d', '/c', `echo ${MARKER}`]] : ['/bin/sh', ['-c', `echo ${MARKER}`]];
  const spawn: HostRequest = { type: 'spawn', id: 'term-1', file, args, cwd: os.homedir(), env: daemonChildEnv('user'), cols: 80, rows: 24, scrollback: 1000 };
  return new Promise<string>((resolve, reject) => {
    let output = '';
    host.onExit(({ code, error }) => reject(new Error(`the pty host exited (${code}${error ? `: ${error}` : ''})`)));
    host.onMessage((raw) => {
      const message = raw as HostMessage;
      if (message.type === 'data') output += message.data;
      if (message.type === 'error') reject(new Error(`the pty did not start: ${message.message}`));
      if (message.type !== 'exit') return;
      host.postMessage({ type: 'shutdown' } satisfies HostRequest);
      if (output.includes(MARKER)) resolve(`echo exited ${message.exitCode}`);
      else reject(new Error(`echo printed no ${MARKER}: ${JSON.stringify(output.slice(-500))}`));
    });
    host.postMessage(spawn);
  });
}

async function startCore(root: string, version: string, log: (line: string) => void): Promise<string> {
  const state: DaemonState = { snapshot: () => ({}), update: async () => undefined, applyClient: () => false, flush: async () => undefined };
  const core = createRemoteCoreHost({
    root,
    paths: await localRunPaths(),
    git: { available: false, reason: 'not probed by the self-test' },
    e2eHooks: false,
    state,
    registry: createRunRegistry(),
    fork: (entry, args) => forkChild(entry, args, daemonChildEnv('node')),
    agentFolder: () => undefined,
    log,
  });
  const attach: CoreAttach = {
    attach: 1,
    hostId: 'self-test',
    appInfo: { version, host: 'desktop' },
    secretsPersistent: false,
    chatBrowserPane: false,
    mirrors: {
      state: { global: {}, workspace: {} },
      trust: { keys: [] },
      folders: { folders: [] },
      editor: {},
      terminal: { shown: false, shortcut: '' },
      language: { language: 'en' },
      clientAuth: { providers: {} },
      clientUser: { settings: {}, permissionRules: [] },
      clientPolicy: { voice: false, allowBypass: false },
    },
  };
  const answered = new Promise<CoreState>((resolve, reject) => {
    core.onState((next) => {
      if (next.phase === 'running') resolve(next);
      if (next.phase === 'restarting' || next.phase === 'halted') reject(new Error('Damocles Core ended before it answered its init'));
    });
  });
  const connection = core.connect('self-test', 'self-test', { post: () => undefined, onMessage: () => ({ dispose: () => undefined }) }, () => undefined, { drained: () => Promise.resolve(), lost: () => false, onLostChange: () => ({ dispose: () => undefined }) });
  connection.attach(attach);
  try {
    const running = await within('Damocles Core', answered);
    return `pid ${running.pid ?? 'unknown'} answered its init`;
  } finally {
    connection.dispose();
    await core.shutdown();
  }
}

/** Runs every check in order, reporting each on stdout; resolves false at the first failure. */
export async function selfTest(root: string): Promise<boolean> {
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const info = JSON.parse(await fs.readFile(path.join(root, 'server-package.json'), 'utf8')) as PackageInfo;
  lockThreadSpawns();
  installProcessLauncher(createLauncherPool({ workerPath: path.join(root, 'dist', 'process-launcher-worker.js'), sentinelPath: path.join(root, 'dist', 'sentinel.js') }));
  const steps: ReadonlyArray<readonly [string, () => Promise<string> | string]> = [
    ['modules', () => importExternals(root, info)],
    ['node:sqlite', () => openSqlite()],
    ['launcher worker and ripgrep', () => runRipgrep(root)],
    ['node-pty', () => echoThroughPty(root)],
    ['Damocles Core', () => startCore(root, info.version, log)],
  ];
  process.stdout.write(`self-test: Damocles server ${info.version} (${info.target}) on Node ${process.versions.node}\n`);
  for (const [name, run] of steps) {
    try {
      process.stdout.write(`self-test: ${name} ok (${await within(name, Promise.resolve().then(run))})\n`);
    } catch (err) {
      process.stdout.write(`self-test: ${name} FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
      return false;
    }
  }
  return true;
}
