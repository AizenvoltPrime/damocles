// A daemon in the test process, as serve runs it minus the process setup: the lock, serve's own endpoint, token, pid file
// and touch in the hermetic home, and the real connections, control channel and workspace host. connect() returns what the
// attach bridge hands the app: a connection already past the bridge's authentication.
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import type { HostFacts } from '../../../remote/handshake';
import type { HostStarters } from '../../workspace/host-starters';
import { connectToDaemon, daemonAnswers } from '../attach';
import { buildDaemon, createCredentialRelay, daemonStarters, listen, type Daemon, type DaemonDeps, type DaemonRelay } from '../serve';
import { acquireDaemonLock } from '../singleton';
import { localRunPaths, makeRunDir, TOUCH_INTERVAL_MS, type RunPaths } from '../token';

export const REPO_ROOT: string = path.resolve(__dirname, '..', '..', '..', '..');

export const TEST_FACTS: HostFacts = {
  os: process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux',
  arch: process.arch,
  libc: process.platform === 'linux' ? 'glibc' : null,
  homedir: '/home/test',
  shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
  gitAvailable: true,
  pathFlavor: process.platform === 'win32' ? 'win32' : 'posix',
};

export interface InProcessDaemon {
  readonly paths: RunPaths;
  readonly daemon: Daemon;
  // resolves with the reason once the daemon would have exited
  readonly exited: Promise<string>;
  readonly exitCode: Promise<number>;
  // the daemon's git credential relay, when the options asked for one
  readonly relay: DaemonRelay | undefined;
  // agentSock: the forwarded agent socket the bridge names
  connect(agentSock?: string): Promise<Duplex>;
  shutdown(): Promise<void>;
}

export interface InProcessOptions {
  // default: the built dist/pty-host.js and dist/formatter-host.js, forked (run npm run build:desktop first)
  readonly starters?: HostStarters;
  readonly version?: string;
  readonly log?: (line: string) => void;
  // default: serve's wait for a lock another daemon holds
  readonly lockWaitMs?: number;
  readonly touchIntervalMs?: number;
  readonly forkCore?: DaemonDeps['forkCore'];
  // default: the built dist/watch-worker.js
  readonly watchWorker?: string;
  readonly graceMs?: number;
  readonly maxHeldBytes?: number;
  // makes the daemon's git credential relay, as serve does
  readonly credentialRelay?: boolean;
}

export async function startInProcessDaemon(options: InProcessOptions = {}): Promise<InProcessDaemon> {
  const log = options.log ?? (() => undefined);
  const paths = await localRunPaths();
  await makeRunDir(paths);
  // serve wires the lock to the daemon built after it the same way
  let compromised = (): void => undefined;
  const lock = await acquireDaemonLock(paths, (error) => {
    log(`[daemon] the daemon lock was compromised: ${error.message}`);
    compromised();
  }, () => daemonAnswers(paths), options.lockWaitMs);
  if (!lock.held) throw new Error('another daemon holds the lock in this test home');
  let exitWith!: (exit: { reason: string; code: number }) => void;
  const exit = new Promise<{ reason: string; code: number }>((resolve) => { exitWith = resolve; });
  const version = options.version ?? '0.0.0-test';
  const relay = options.credentialRelay ? await createCredentialRelay(REPO_ROOT) : undefined;
  const daemon = await listen({
    paths,
    version,
    touchIntervalMs: options.touchIntervalMs ?? TOUCH_INTERVAL_MS,
    log,
    build: (endpoint) => buildDaemon({
      git: { available: false, reason: 'not probed in tests' },
      e2eHooks: false,
      root: REPO_ROOT,
      version,
      facts: TEST_FACTS,
      paths,
      starters: options.starters ?? daemonStarters(REPO_ROOT),
      ...(options.forkCore ? { forkCore: options.forkCore } : {}),
      ...(options.watchWorker !== undefined ? { watchWorker: options.watchWorker } : {}),
      ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
      ...(options.maxHeldBytes !== undefined ? { maxHeldBytes: options.maxHeldBytes } : {}),
      ...(relay ? { credentialRelay: relay } : {}),
      ...endpoint,
      releaseLock: lock.release,
      exit: (reason, code) => exitWith({ reason, code }),
      log,
    }),
  });
  compromised = () => void daemon.lockLost('the daemon lock was compromised');
  return {
    paths,
    daemon,
    exited: exit.then(({ reason }) => reason),
    exitCode: exit.then(({ code }) => code),
    relay,
    connect: async (agentSock) => {
      const { socket, rest } = await connectToDaemon({ paths, start: () => Promise.reject(new Error('the in-process daemon is not running')), deadlineMs: 5000, ...(agentSock !== undefined ? { agentSock } : {}), log });
      if (rest.length > 0) socket.unshift(Buffer.from(rest));
      return socket;
    },
    shutdown: () => daemon.shutdown('the test ended'),
  };
}
