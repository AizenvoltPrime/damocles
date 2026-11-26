// A daemon in the test process, as serve runs it minus the process setup: the lock, serve's own endpoint, token, pid file
// and touch in the hermetic home, and the real connections, control channel and workspace host. connect() returns what the
// attach bridge hands the app: a connection already past the bridge's authentication.
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import type { HostFacts } from '../../../remote/handshake';
import { createPtyScreen } from '../../pty-host/screen';
import type { Pty, PtySpawnOptions } from '../../pty-host/sessions';
import { createTerminalHost } from '../../terminal-host/host';
import { serveTerminalHost } from '../../terminal-host/records';
import { connectToDaemon, daemonAnswers } from '../attach';
import type { StartIdentity } from '../process-identity';
import { buildDaemon, createCredentialRelay, daemonStarters, listen, type Daemon, type DaemonDeps, type DaemonRelay, type DaemonStarters, type ListenOptions } from '../serve';
import { acquireDaemonLock } from '../singleton';
import { localRunPaths, makeRunDir, TOUCH_INTERVAL_MS, type PidRecord, type RunPaths } from '../token';

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
  // the daemon's server version, which names the terminal host its new terminals start in
  readonly version: string;
  // resolves with the reason once the daemon would have exited
  readonly exited: Promise<string>;
  readonly exitCode: Promise<number>;
  // the daemon's git credential relay, when the options asked for one
  readonly relay: DaemonRelay | undefined;
  // agentSock: the forwarded agent socket the bridge names
  connect(agentSock?: string): Promise<Duplex>;
  shutdown(): Promise<void>;
}

/** A pty a test drives: what it prints is the terminal's output, and end() is its process exiting. */
export class TestPty implements Pty {
  readonly process = 'sh';
  killed = false;
  readonly written: string[] = [];
  private dataListener: (data: string) => void = () => undefined;
  private exitListener: (event: { exitCode: number }) => void = () => undefined;
  readonly pid: number;
  readonly file: string;
  readonly env: Readonly<Record<string, string>>;
  constructor(pid: number, file: string, env: Readonly<Record<string, string>>) {
    this.pid = pid;
    this.file = file;
    this.env = env;
  }
  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
  }
  onExit(listener: (event: { exitCode: number }) => void): void {
    this.exitListener = listener;
  }
  print(data: string): void {
    this.dataListener(data);
  }
  end(exitCode: number): void {
    this.exitListener({ exitCode });
  }
  write(data: string): void {
    this.written.push(data);
  }
  resize(): void {}
  pause(): void {}
  resume(): void {}
  kill(): void {
    this.killed = true;
  }
}

/** A terminal host in the test process: the real host and its real endpoint, token and record, over ptys the test drives. */
export interface TestHost {
  readonly pid: number;
  readonly record: PidRecord;
  // every pty it started, in order
  readonly ptys: TestPty[];
  // resolves with the reason once the host would have exited
  readonly exited: Promise<string>;
  hasExited(): boolean;
  // cuts every connection under the host, as a link lost between two live processes is; the host and its ptys run on
  dropLinks(): void;
  // the host reads nothing on any connection, open or new, as a hung host holding its sockets open; answer reads on again
  hang(): void;
  answer(): void;
  // ends it as its process ending would: the endpoint closes and the record goes
  stop(): Promise<void>;
}

export interface TestHostOptions {
  readonly version?: string;
  // the live pid its record is named by; default this process's. A second host of one test names another live pid
  readonly pid?: number;
  readonly emptyCheckMs?: number;
  readonly now?: () => number;
  // the start identities it records; default testStartIdentity
  readonly identity?: StartIdentity;
  readonly log?: (line: string) => void;
  // each daemon connection's socket as the host takes it, before the host reads or writes it
  readonly tap?: (socket: Duplex) => void;
}

// a start identity read without the OS, which test hosts record and in-process daemons read unless a test names the OS's
export const testStartIdentity: StartIdentity = (pid) => Promise.resolve(`test1:start of ${pid}`);

export async function startTestHost(paths: RunPaths, options: TestHostOptions = {}): Promise<TestHost> {
  const ptys: TestPty[] = [];
  let exitWith!: (reason: string) => void;
  let exited = false;
  const exit = new Promise<string>((resolve) => { exitWith = resolve; });
  const version = options.version ?? '0.0.0-test';
  const log = options.log ?? (() => undefined);
  const stop = async (): Promise<void> => {
    await served.close();
    await host.close();
  };
  const host = createTerminalHost({
    version,
    spawn: (file: string, _args: readonly string[], spawnOptions: PtySpawnOptions) => {
      const pty = new TestPty(4000 + ptys.length, file, spawnOptions.env);
      ptys.push(pty);
      return pty;
    },
    screen: createPtyScreen,
    throttleConpty: false,
    readProcessName: false,
    // as main.ts does: the record goes, then the connections
    exit: (reason) => {
      exited = true;
      void stop().then(() => exitWith(reason));
    },
    ...(options.emptyCheckMs !== undefined ? { emptyCheckMs: options.emptyCheckMs } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    // a spawn reaches the host only once it listens
    endpointFolder: async () => served.record.socketFolder,
    listed: (terminals) => served.list(terminals),
    log,
  });
  const sockets = new Set<Duplex>();
  let hung = false;
  const held: Array<() => void> = [];
  const accept = (socket: Duplex, token: Uint8Array): void => {
    if (hung) {
      held.push(() => {
        if (!socket.destroyed) accept(socket, token);
      });
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    options.tap?.(socket);
    host.accept(socket, token);
  };
  const served = await serveTerminalHost({ paths, version, accept, touchIntervalMs: TOUCH_INTERVAL_MS, identity: options.identity ?? testStartIdentity, log, ...(options.pid !== undefined ? { pid: options.pid } : {}) });
  host.serving();
  return { pid: served.record.pid, record: served.record, ptys, exited: exit, hasExited: () => exited, dropLinks: () => { for (const socket of [...sockets]) socket.destroy(); },
    hang: () => {
      hung = true;
      for (const socket of sockets) socket.pause();
    },
    answer: () => {
      hung = false;
      for (const socket of sockets) socket.resume();
      for (const accepted of held.splice(0)) accepted();
    },
    stop,
  };
}

export interface InProcessOptions {
  // default: the built dist/formatter-host.js, forked (run npm run build:desktop first)
  readonly starters?: DaemonStarters;
  // default: the built dist/terminal-host.js, detached, which the daemon's shutdown here ends
  readonly startTerminalHost?: () => Promise<number>;
  readonly version?: string;
  readonly log?: (line: string) => void;
  // default: serve's wait for a lock another daemon holds
  readonly lockWaitMs?: number;
  readonly touchIntervalMs?: number;
  readonly forkCore?: DaemonDeps['forkCore'];
  // default: the built dist/watch-worker.js
  readonly watchWorker?: string;
  // default: the built dist/walk-child.js
  readonly walkChild?: DaemonDeps['walkChild'];
  readonly graceMs?: number;
  readonly maxHeldBytes?: number;
  readonly now?: () => number;
  // makes the daemon's git credential relay, as serve does
  readonly credentialRelay?: boolean;
  // default testStartIdentity, which startTestHost's hosts record
  readonly startIdentity?: StartIdentity;
  readonly floor?: ListenOptions['floor'];
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
    root: REPO_ROOT,
    version,
    touchIntervalMs: options.touchIntervalMs ?? TOUCH_INTERVAL_MS,
    log,
    ...(options.floor ? { floor: options.floor } : {}),
    build: (endpoint) => buildDaemon({
      git: { available: false, reason: 'not probed in tests' },
      e2eHooks: false,
      root: REPO_ROOT,
      version,
      facts: TEST_FACTS,
      paths,
      starters: options.starters ?? daemonStarters(REPO_ROOT),
      ...(options.startTerminalHost ? { startTerminalHost: options.startTerminalHost } : {}),
      startIdentity: options.startIdentity ?? testStartIdentity,
      ...(options.forkCore ? { forkCore: options.forkCore } : {}),
      ...(options.watchWorker !== undefined ? { watchWorker: options.watchWorker } : {}),
      ...(options.walkChild !== undefined ? { walkChild: options.walkChild } : {}),
      ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
      ...(options.maxHeldBytes !== undefined ? { maxHeldBytes: options.maxHeldBytes } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
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
    version,
    exited: exit.then(({ reason }) => reason),
    exitCode: exit.then(({ code }) => code),
    relay,
    connect: async (agentSock) => {
      const { socket, rest } = await connectToDaemon({ paths, start: () => Promise.reject(new Error('the in-process daemon is not running')), deadlineMs: 5000, ...(agentSock !== undefined ? { agentSock } : {}), log });
      if (rest.length > 0) socket.unshift(Buffer.from(rest));
      return socket;
    },
    // ends every terminal host the daemon is attached to, so a test leaves none behind
    shutdown: () => daemon.shutdown('the test ended', 'end'),
  };
}
