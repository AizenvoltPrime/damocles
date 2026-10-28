// `daemon.js attach`: the bridge, one per connection. It finds the running daemon of whatever version through this machine's
// run folder, starts its own when none answers, proves the token to it and checks the daemon's proof, and from then on only
// copies bytes between its stdio and the daemon.
import * as net from 'node:net';
import * as path from 'node:path';
import { createLauncherPool, installProcessLauncher, lockThreadSpawns } from '../../core/process-launcher';
import { authenticateBridge, HANDSHAKE_MAX_BYTES } from '../../remote/handshake';
import { createPersistentProtocol } from '../../remote/persistent-protocol';
import { streamSocket } from '../../remote/stream-transport';
import { ATTACH_DEADLINE_MS } from './lock-timing';
import { startDaemonDetached } from './process-starts';
import { checkSocketFolder, goneFromThisHost, isOwnEndpoint, localRunPaths, readPidFile, readToken, tokenPath, type PidRecord, type RunPaths } from './token';

const RETRY_MS = 200;
// the bridge could not reach or start a daemon
export const EXIT_NO_DAEMON = 2;

export interface ConnectOptions {
  readonly paths: RunPaths;
  // starts a daemon; called at most once, when none answers, since a start waits for a lock whose holder does not answer yet
  readonly start: () => Promise<void>;
  readonly deadlineMs?: number;
  // the SSH agent socket sshd forwarded into this session, sent in the last authentication message
  readonly agentSock?: string;
  readonly log: (line: string) => void;
}

export interface DaemonConnection {
  readonly socket: net.Socket;
  // bytes read past the handshake, which belong to the app
  readonly rest: Uint8Array;
}

function connectSocket(endpoint: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

// The daemon the pid file names, authenticated; rejects when it does not answer or cannot prove the token.
async function tryDaemon(paths: RunPaths, record: PidRecord, agentSock?: string): Promise<DaemonConnection> {
  if (!isOwnEndpoint(record)) throw new Error(`the pid file names ${record.endpoint}, which is not a daemon endpoint`);
  // lstat before every connect: a folder swapped for a link or another user's is never used
  if (record.socketFolder !== null) await checkSocketFolder(record.socketFolder);
  const token = await readToken(tokenPath(paths, record));
  const socket = await connectSocket(record.endpoint);
  const protocol = createPersistentProtocol({ socket: streamSocket(socket), maxBodyBytes: HANDSHAKE_MAX_BYTES, log: () => undefined });
  try {
    await authenticateBridge(protocol, token, agentSock);
  } catch (err) {
    // sends nothing more to an endpoint that is not this user's daemon
    protocol.close('not this user\'s daemon');
    throw err;
  }
  return { socket, rest: protocol.detach() };
}

// A pid file naming a process of this host that has ended is a crashed daemon's: nothing connects to its endpoint, which
// another process may hold now.
const recordGone = (record: PidRecord): boolean => goneFromThisHost(record.hostname, record.pid);

/** Whether the daemon the pid file names answers and proves the token now; the probe's connection ends before its hello. */
export async function daemonAnswers(paths: RunPaths): Promise<boolean> {
  const record = await readPidFile(paths.pidFile);
  if (!record || recordGone(record)) return false;
  const connection = await tryDaemon(paths, record).catch(() => undefined);
  connection?.socket.destroy();
  return connection !== undefined;
}

/**
 * Connects to the running daemon, starting one when none answers, within the deadline; two bridges at once end with one
 * daemon. Each pid record is tried once: a daemon writes its record once its endpoint listens, so one that failed stays failed,
 * and the bridge waits for the record of the daemon it started.
 */
export async function connectToDaemon(options: ConnectOptions): Promise<DaemonConnection> {
  const deadline = Date.now() + (options.deadlineMs ?? ATTACH_DEADLINE_MS);
  let started = false;
  let last = 'no daemon is running';
  let tried: PidRecord | undefined;
  for (;;) {
    const record = await readPidFile(options.paths.pidFile);
    if (record && recordGone(record)) {
      last = `the daemon ${record.pid} the pid file names has ended`;
    } else if (record && (record.pid !== tried?.pid || record.endpoint !== tried.endpoint)) {
      tried = record;
      try {
        return await tryDaemon(options.paths, record, options.agentSock);
      } catch (err) {
        last = `the daemon at ${record.endpoint} did not answer: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (!started) {
      started = true;
      options.log(`[attach] ${last}; starting one`);
      // the daemon lock decides between bridges that start one at once
      await options.start();
    }
    if (Date.now() >= deadline) throw new Error(`no daemon answered within ${options.deadlineMs ?? ATTACH_DEADLINE_MS} ms: ${last}`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}

/** The attach mode: stdout and stdin become the daemon connection; failures go to stderr and end with EXIT_NO_DAEMON. */
export async function attach(root: string): Promise<void> {
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  // the machine id is read through the launcher on Windows and macOS
  lockThreadSpawns();
  installProcessLauncher(createLauncherPool({ workerPath: path.join(root, 'dist', 'process-launcher-worker.js'), sentinelPath: path.join(root, 'dist', 'sentinel.js') }));
  let connection: DaemonConnection;
  // sshd sets SSH_AUTH_SOCK only for a session that forwards an agent; the daemon uses it only while the client's policy forwards
  const agentSock = process.env['SSH_AUTH_SOCK'];
  try {
    connection = await connectToDaemon({
      paths: await localRunPaths(),
      ...(agentSock !== undefined && agentSock !== '' ? { agentSock } : {}),
      // HOME, USERPROFILE and ELECTRON_RUN_AS_NODE pass through to the daemon, which drops ELECTRON_* for its children
      start: () => startDaemonDetached(process.execPath, [path.join(root, 'dist', 'daemon.js'), 'serve'], Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), root),
      log,
    });
  } catch (err) {
    log(`[attach] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_NO_DAEMON);
  }
  const { socket, rest } = connection;
  if (rest.length > 0) process.stdout.write(rest);
  socket.pipe(process.stdout);
  process.stdin.pipe(socket);
  socket.once('close', () => process.exit(0));
  socket.on('error', (err) => log(`[attach] the daemon connection failed: ${err.message}`));
}
