// `daemon.js attach`: the bridge, one per connection. It finds the running daemon of whatever version through this machine's
// run folder, starts its own when none answers, proves the token to it and checks the daemon's proof, and from then on only
// copies bytes between its stdio and the daemon.
import * as net from 'node:net';
import * as path from 'node:path';
import { createLauncherPool, installProcessLauncher, lockThreadSpawns } from '../../core/process-launcher';
import { authenticateBridge, HANDSHAKE_MAX_BYTES } from '../../remote/handshake';
import { createPersistentProtocol, type PersistentProtocol } from '../../remote/persistent-protocol';
import { streamSocket } from '../../remote/stream-transport';
import { ATTACH_DEADLINE_MS } from './lock-timing';
import { appVersionOf } from '../../shared/app-version';
import { FLOOR_UNREADABLE_REASON } from '../../shared/host-connection';
import { yieldsUntil } from './hand-over-mark';
import { startDetached } from './process-starts';
import { belowFloor, installDirOf, readFloor } from './security-floor';
import { readServerVersion } from './server-version';
import { checkSocketFolder, goneFromThisHost, isOwnEndpoint, localRunPaths, readPidFile, readToken, tokenPath, type PidRecord, type RunPaths } from './token';

const RETRY_MS = 200;
// the bridge could not reach or start a daemon
export const EXIT_NO_DAEMON = 2;
// stage 1's own exit code after a fail line
export const EXIT_FAIL_LINE = 1;

export interface ConnectOptions {
  readonly paths: RunPaths;
  // starts a daemon; called at most once, when none answers, since a start waits for a lock whose holder does not answer yet
  readonly start: () => Promise<void>;
  // the host's security floor when this bridge's app version is below it, asked only when no daemon answers; then nothing starts
  readonly floorAbove?: () => Promise<string | undefined>;
  // until when (epoch ms) this bridge waits for another bridge's daemon before starting its own (hand-over-mark.ts), asked
  // once, when no daemon answers
  readonly yieldsUntil?: () => Promise<number | undefined>;
  readonly deadlineMs?: number;
  // the SSH agent socket sshd forwarded into this session, sent in the last authentication message
  readonly agentSock?: string;
  readonly log: (line: string) => void;
}

/** No daemon runs and this bridge's app version is below the host's security floor, so it started none. */
export class BelowFloorError extends Error {
  override readonly name = 'BelowFloorError';
  readonly floor: string;

  constructor(floor: string) {
    super(`this server is older than ${floor}, the minimum a required update set on this host; no server was started`);
    this.floor = floor;
  }
}

// a fail line of stage 1's status protocol (probe-parse.ts), which main reads where the handshake would start
export const belowFloorLine = (floor: string): string => `@@DAMOCLES ${JSON.stringify({ kind: 'fail', code: 'belowFloor', params: { floor } })}\n`;

/** The server's version or the host's security floor could not be read, so the bridge cannot tell whether it may start a daemon. */
export class FloorUnreadableError extends Error {
  override readonly name = 'FloorUnreadableError';
  readonly reason: string;

  constructor(cause: unknown) {
    super(`the host's security floor cannot be read, so no server was started: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    const code = (cause as { code?: unknown } | undefined)?.code;
    this.reason = typeof code === 'string' && FLOOR_UNREADABLE_REASON.test(code) ? code : 'unreadable';
  }
}

export const floorUnreadableLine = (err: FloorUnreadableError): string => `@@DAMOCLES ${JSON.stringify({ kind: 'fail', code: 'floorUnreadable', params: { reason: err.reason } })}\n`;

export interface DaemonConnection {
  readonly socket: net.Socket;
  // bytes read past the handshake, which belong to the app
  readonly rest: Uint8Array;
}

export function connectSocket(endpoint: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

export interface AuthenticatedConnection {
  readonly socket: net.Socket;
  // past the mutual token proof, still bounded by HANDSHAKE_MAX_BYTES
  readonly protocol: PersistentProtocol;
}

/**
 * The process a record names (a daemon, a terminal host), authenticated with the token in tokenFile; rejects when its endpoint
 * is not one `owns` accepts, it does not answer or it cannot prove the token, having sent it nothing but the first nonce.
 * signal: aborting it closes the connection, during the proof and for as long as the connection lives.
 */
export async function connectAuthenticated(record: PidRecord, tokenFile: string, owns: (record: PidRecord) => boolean, agentSock?: string, signal?: AbortSignal): Promise<AuthenticatedConnection> {
  if (!owns(record)) throw new Error(`the record of ${record.pid} names ${record.endpoint}, which is not an endpoint of its kind`);
  // lstat before every connect: a folder swapped for a link or another user's is never used
  if (record.socketFolder !== null) await checkSocketFolder(record.socketFolder);
  const token = await readToken(tokenFile);
  const socket = await connectSocket(record.endpoint);
  const protocol = createPersistentProtocol({ socket: streamSocket(socket), maxBodyBytes: HANDSHAKE_MAX_BYTES, log: () => undefined });
  // the caller's own bound: an abort closes the connection whichever step it is at, now or later
  if (signal?.aborted) protocol.close('the caller gave up');
  else signal?.addEventListener('abort', () => protocol.close('the caller gave up'), { once: true });
  try {
    await authenticateBridge(protocol, token, agentSock);
  } catch (err) {
    // sends nothing more to an endpoint that does not hold the token
    protocol.close('the token proof did not complete');
    throw err;
  }
  return { socket, protocol };
}

// The daemon the pid file names, authenticated; rejects when it does not answer or cannot prove the token.
async function tryDaemon(paths: RunPaths, record: PidRecord, agentSock?: string): Promise<DaemonConnection> {
  const { socket, protocol } = await connectAuthenticated(record, tokenPath(paths, record), isOwnEndpoint, agentSock);
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
  let yieldUntil: number | undefined;
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
      yieldUntil ??= (await options.yieldsUntil?.()) ?? 0;
      if (Date.now() < yieldUntil) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        continue;
      }
      started = true;
      // a running daemon is joined whatever the floor; only a start is refused
      const floor = await options.floorAbove?.();
      if (floor !== undefined) throw new BelowFloorError(floor);
      options.log(`[attach] ${last}; starting one`);
      // the daemon lock decides between bridges that start one at once
      await options.start();
    }
    if (Date.now() >= deadline) throw new Error(`no daemon answered within ${options.deadlineMs ?? ATTACH_DEADLINE_MS} ms: ${last}`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}

/**
 * The host's security floor when the server under `root` is installed in a version folder and its app version is below it;
 * undefined for a checkout's or the desktop app's own bridge. Throws when this server's version or the floor file cannot be
 * read, since the bridge then cannot tell whether it may start a daemon.
 */
export async function floorAbove(root: string, log: (line: string) => void): Promise<string | undefined> {
  try {
    const version = await readServerVersion(root);
    const installDir = installDirOf(root, version);
    const floor = installDir === undefined ? undefined : await readFloor(installDir, log);
    return floor !== undefined && belowFloor(appVersionOf(version), floor) ? floor : undefined;
  } catch (err) {
    throw new FloorUnreadableError(err);
  }
}

/** Until when this bridge yields after a hand-over (hand-over-mark.ts); undefined when it does not or its version cannot be read. */
export function handOverYield(root: string, paths: RunPaths, log: (line: string) => void): Promise<number | undefined> {
  return readServerVersion(root).then((own) => yieldsUntil(paths, own, log)).catch(() => undefined);
}

/**
 * The attach mode: stdout and stdin become the daemon connection; failures go to stderr and end with EXIT_NO_DAEMON, but a
 * start the security floor refuses or cannot decide, which writes its fail line to stdout and ends with EXIT_FAIL_LINE.
 */
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
    const paths = await localRunPaths();
    connection = await connectToDaemon({
      paths,
      yieldsUntil: () => handOverYield(root, paths, log),
      ...(agentSock !== undefined && agentSock !== '' ? { agentSock } : {}),
      // HOME, USERPROFILE and ELECTRON_RUN_AS_NODE pass through to the daemon, which drops ELECTRON_* for its children
      start: async () => {
        await startDetached(process.execPath, [path.join(root, 'dist', 'daemon.js'), 'serve'], Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), root, log);
      },
      floorAbove: () => floorAbove(root, log),
      log,
    });
  } catch (err) {
    log(`[attach] ${err instanceof Error ? err.message : String(err)}`);
    // the app reads the line where the handshake would start, before any of its bytes
    const line = err instanceof BelowFloorError ? belowFloorLine(err.floor) : err instanceof FloorUnreadableError ? floorUnreadableLine(err) : undefined;
    if (line !== undefined) await new Promise<void>((resolve) => process.stdout.write(line, () => resolve()));
    process.exit(line !== undefined ? EXIT_FAIL_LINE : EXIT_NO_DAEMON);
  }
  const { socket, rest } = connection;
  if (rest.length > 0) process.stdout.write(rest);
  socket.pipe(process.stdout);
  process.stdin.pipe(socket);
  socket.once('close', () => process.exit(0));
  socket.on('error', (err) => log(`[attach] the daemon connection failed: ${err.message}`));
}
