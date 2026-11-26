// The terminal host: the ptys, their screens and their metadata, which outlive the daemon that started them. One daemon
// connection at a time serves the contract of host-messages.ts; while none is attached the ptys run on, paced by their own
// screens. A violation closes the connection that made it and nothing else. It also owns each terminal's endpoints (its
// damocles command socket, its forwarded agent's socket, the credential relay) for the terminal's life and forwards each
// connection to the attached daemon, holding it while none is (docs/invariants.md "The damocles command"). No electron import.
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import { CREDENTIAL_NONCE_VARIABLE } from '../../core/scm/askpass/credential-relay';
import { createEndpoint, type Endpoint } from '../core-protocol/endpoint';
import { channelTransport } from '../../remote/channel-transport';
import { acceptConnection, HANDSHAKE_MAX_BYTES, NONCE_BYTES, type Accepted, type Hello, type HelloAnswer } from '../../remote/handshake';
import { CHANNEL, createMux, MAX_FRAME_BYTES, type Mux, type StreamChannel } from '../../remote/mux';
import { createPersistentProtocol, type PersistentProtocol } from '../../remote/persistent-protocol';
import { END_TIMEOUT_MS, streamSocket } from '../../remote/stream-transport';
import { pipeStream } from '../../remote/tunnel-pipe';
import { INVALID, type Parser } from '../core-protocol/schema';
import { checkSocketFolder, touch } from '../daemon/token';
import type { HostMessage, HostRequest } from '../pty-host/protocol';
import { createPtySessions, type PtySessionsDeps } from '../pty-host/sessions';
import { CLI_HOOK_ENV } from '../workspace/terminal/terminal-env';
import {
  DAEMON_TO_TERMINAL_HOST,
  DEFAULT_HOSTED_IDLE_DAYS,
  ENDPOINT_HOLD_MS,
  ENDPOINTS_FEATURE,
  MAX_HELD_ENDPOINT_CONNECTIONS,
  MAX_HOSTED_MESSAGE_CHARS,
  MAX_HOSTED_TERMINALS,
  ptySpawn,
  TERMINAL_HOST_FEATURES,
  TERMINAL_HOST_MAX_MESSAGE_BYTES,
  TERMINAL_HOST_PROTOCOL_VERSION,
  TERMINAL_HOST_TO_DAEMON,
  type DaemonToTerminalHost,
  type HostedTerminal,
  type TerminalHostSpawn,
  type TerminalHostToDaemon,
} from './host-messages';

// connections still authenticating at once; one more takes the place of the oldest, since any local user can open the
// Windows pipe and a daemon proves the token in milliseconds
export const MAX_AUTHENTICATING = 16;
// refused connections are logged once, then counted for this long
const REFUSAL_LOG_MS = 60_000;
// an empty host with no daemon exits only this long after it serves, so the daemon that started it has time to attach
export const EMPTY_CHECK_MS = 30_000;
// a pty still connecting on Windows holds the sessions' shutdown; the host exits without it after this
const SHUTDOWN_TIMEOUT_MS = 2000;
const DAY_MS: number = 24 * 60 * 60 * 1000;
// setTimeout's longest delay
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface TerminalHostDeps {
  // the host's server version, which its welcome carries
  readonly version: string;
  readonly spawn: PtySessionsDeps['spawn'];
  readonly screen: PtySessionsDeps['screen'];
  readonly throttleConpty: boolean;
  readonly readProcessName: boolean;
  // once: the host holds no terminal and no daemon is attached, or a daemon asked it to shut down
  readonly exit: (reason: string) => void;
  readonly now?: () => number;
  readonly emptyCheckMs?: number;
  // the host's own socket folder, where its terminals' endpoints are made (POSIX), or null for named pipes (Windows); read
  // once the host listens
  readonly endpointFolder: () => Promise<string | null>;
  // the terminals it holds, after each spawn, each pty's pid and each terminal it stops holding (records.ts list)
  readonly listed: (terminals: readonly HostedTerminal[]) => void;
  readonly log: (line: string) => void;
}

export interface TerminalHost {
  // token: the one the endpoint the socket reached was opened with
  accept(socket: Duplex, token: Uint8Array): void;
  // the daily touch of the terminals' endpoints: a removed socket is bound again at its path, in its folder made again only
  // when this host makes it and it passes checkSocketFolder; else that endpoint stays gone
  touchEndpoints(): Promise<void>;
  // the host's record and endpoint exist: the empty check's window starts here, never while a daemon cannot find the host
  serving(): void;
  // makes, binds and touches no endpoint from now on and takes no connection; before the host's files are removed
  stop(): void;
  // stops, kills every pty and ends every connection, letting each write what it has sent
  close(): Promise<void>;
}

interface Hosted {
  pid: number;
  cols: number;
  rows: number;
  scrollback: number;
  readonly title: string;
  readonly projectKey: string;
  readonly view: string | undefined;
  detachedAt: number | undefined;
  // screens the attached daemon asked for, and screens earlier connections asked for, which are never sent
  asked: number;
  stale: number;
}

interface Link {
  readonly protocol: PersistentProtocol;
  readonly mux: Mux;
  readonly endpoint: Endpoint<TerminalHostToDaemon, DaemonToTerminalHost>;
  // its attach listed ENDPOINTS_FEATURE, so it takes the endpoints' connections
  forwards: boolean;
}

type Forwarded = Extract<HostRequest, { readonly type: 'serialize' | 'input' | 'resize' | 'ack' | 'scrollback' | 'clear' | 'kill' }>;

// what a connection on an endpoint is to the daemon; one object per endpoint, which its held connections share
type Forward = { readonly kind: 'cli'; readonly terminalId: string } | { readonly kind: 'agent'; readonly key: string } | { readonly kind: 'relay' };

interface Listening {
  // the socket path or pipe name the shells' environments name
  readonly name: string;
  readonly forward: Forward;
  server: net.Server;
}

interface Held {
  readonly socket: net.Socket;
  readonly forward: Forward;
  readonly timer: NodeJS.Timeout;
}

type HostEvents = TerminalHostToDaemon['events'];

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const errnoCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

export function createTerminalHost(deps: TerminalHostDeps): TerminalHost {
  const { log } = deps;
  const now = deps.now ?? Date.now;
  const terminals = new Map<string, Hosted>();
  // a spawn whose pty has not started or failed yet, and the requests for its id queued behind it, in order
  const starting = new Map<string, Promise<void>>();
  // terminals being ended, each until its exit is reported
  const ending = new Map<string, Promise<void>>();
  const sockets = new Map<Duplex, PersistentProtocol>();
  // oldest first
  const authenticating = new Set<Duplex>();
  let refusals = 0;
  let refusalTimer: NodeJS.Timeout | undefined;
  let endpointNotes = 0;
  let endpointNoteTimer: NodeJS.Timeout | undefined;
  let daemon: Link | undefined;
  let idleDays = DEFAULT_HOSTED_IDLE_DAYS;
  let idleTimer: NodeJS.Timeout | undefined;
  // false until EMPTY_CHECK_MS after serving
  let mayExitEmpty = false;
  let exited = false;
  let closing = false;
  // the terminals' endpoints: a CLI socket per terminal, an agent socket per key, one credential relay
  const cliEndpoints = new Map<string, Listening>();
  const agentEndpoints = new Map<string, Listening>();
  let relayEndpoint: Listening | undefined;
  // the agent key each terminal's environment names
  const agentKeys = new Map<string, string>();
  // connections waiting for a daemon that forwards, oldest first
  const waiting: Held[] = [];
  // the credential nonce this host's terminals send, which the attached daemon's core accepts for credential requests only
  const relayNonce = randomBytes(32).toString('hex');
  const windows = process.platform === 'win32';
  // endpoints are made, touched and closed one at a time
  let endpointWork: Promise<unknown> = Promise.resolve();
  const serially = <T>(run: () => Promise<T>): Promise<T> => {
    const next = endpointWork.then(run);
    endpointWork = next.catch(() => undefined);
    return next;
  };

  const exit = (reason: string): void => {
    if (exited || closing) return;
    exited = true;
    deps.exit(reason);
  };

  const checkEmpty = (): void => {
    if (mayExitEmpty && terminals.size === 0 && !daemon) exit('it holds no terminal and no daemon is attached');
  };
  let emptyTimer: NodeJS.Timeout | undefined;

  // Any peer can make the host refuse connections; its one thread also runs every pty, so it writes one line per interval.
  const refused = (reason: string): void => {
    if (refusalTimer) {
      refusals++;
      return;
    }
    log(`[terminal-host] refused a connection: ${reason}`);
    refusalTimer = setTimeout(() => {
      refusalTimer = undefined;
      if (refusals > 0) log(`[terminal-host] refused ${refusals} more connections`);
      refusals = 0;
    }, REFUSAL_LOG_MS);
    refusalTimer.unref();
  };
  // Any local user can open a Windows endpoint pipe, so what one connection costs is logged once per interval too.
  const endpointNote = (line: string): void => {
    if (endpointNoteTimer) {
      endpointNotes++;
      return;
    }
    log(`[terminal-host] ${line}`);
    endpointNoteTimer = setTimeout(() => {
      endpointNoteTimer = undefined;
      if (endpointNotes > 0) log(`[terminal-host] ${endpointNotes} more endpoint connections failed or closed unforwarded`);
      endpointNotes = 0;
    }, REFUSAL_LOG_MS);
    endpointNoteTimer.unref();
  };

  // An event outside the contract or past the channel's bound never crosses. The daemon would then be one event behind for
  // that terminal (a screen it waits for, an exit), so its link ends and the next attach starts from the host's list.
  const emit = <E extends keyof HostEvents & string>(name: E, payload: HostEvents[E]): void => {
    const link = daemon;
    if (!link) return;
    try {
      if ((TERMINAL_HOST_TO_DAEMON.events[name] as Parser<unknown>)(payload) === INVALID) throw new Error('it is outside the contract');
      link.endpoint.emit(name, payload);
    } catch (err) {
      log(`[terminal-host] a ${name} event could not be sent: ${errorText(err)}`);
      link.protocol.close(`a ${name} event could not be sent`);
    }
  };

  // A connection crosses on a stream of the daemon's link; the mux's bounds apply, and one it refuses closes this connection only.
  const pass = (link: Link, socket: net.Socket, forward: Forward): void => {
    let stream: StreamChannel;
    try {
      stream = link.mux.openStream();
    } catch (err) {
      endpointNote(`closed an endpoint connection: ${errorText(err)}`);
      socket.destroy();
      return;
    }
    emit('connection', { stream: stream.id, ...forward });
    // a Unix socket or a pipe has no RST: destroy is its reset
    pipeStream(socket, stream, () => undefined, (closed) => closed.destroy());
    // once the daemon ended its side and the last byte is written the connection goes, so a peer that never closes holds no
    // stream of the link
    stream.onEnd(() => {
      const timer = setTimeout(() => socket.destroy(), END_TIMEOUT_MS);
      socket.once('finish', () => {
        clearTimeout(timer);
        socket.destroy();
      });
      socket.once('close', () => clearTimeout(timer));
    });
    socket.resume();
  };

  const unhold = (entry: Held): void => {
    clearTimeout(entry.timer);
    const at = waiting.indexOf(entry);
    if (at !== -1) waiting.splice(at, 1);
  };

  // Paused from its connect, so nothing it sends is read before a daemon takes it.
  const endpointConnection = (socket: net.Socket, forward: Forward): void => {
    socket.on('error', (err) => endpointNote(`an endpoint connection failed: ${err.message}`));
    if (closing) {
      socket.destroy();
      return;
    }
    if (daemon?.forwards) {
      pass(daemon, socket, forward);
      return;
    }
    if (waiting.length >= MAX_HELD_ENDPOINT_CONNECTIONS) {
      refused(`${MAX_HELD_ENDPOINT_CONNECTIONS} endpoint connections already wait for a daemon`);
      socket.destroy();
      return;
    }
    const entry: Held = {
      socket,
      forward,
      timer: setTimeout(() => {
        unhold(entry);
        endpointNote(`closed an endpoint connection no daemon took within ${ENDPOINT_HOLD_MS} ms`);
        socket.destroy();
      }, ENDPOINT_HOLD_MS),
    };
    waiting.push(entry);
    socket.once('close', () => unhold(entry));
  };

  const listenAt = async (name: string, forward: Forward): Promise<net.Server> => {
    const server = net.createServer({ pauseOnConnect: true }, (socket) => endpointConnection(socket, forward));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(name, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (err) => log(`[terminal-host] the endpoint ${name} failed: ${err.message}`));
    try {
      // the folder is 0700, so the moment before this chmod exposes nothing
      if (!windows) await fs.chmod(name, 0o600);
    } catch (err) {
      server.close();
      throw err;
    }
    return server;
  };

  // The host's folder, made again by this host only when it is gone, and refused unless it is the user's own 0700 folder.
  const ownFolder = async (folder: string): Promise<void> => {
    const made = await fs.mkdir(folder, { mode: 0o700 }).then(() => true, (err: unknown) => {
      if (errnoCode(err) === 'EEXIST') return false;
      throw err;
    });
    if (made) {
      await fs.chmod(folder, 0o700);
      log(`[terminal-host] made its socket folder ${folder} again`);
    }
    await checkSocketFolder(folder);
  };

  const open = async (forward: Forward): Promise<Listening> => {
    const folder = await deps.endpointFolder();
    if (closing) throw new Error('the terminal host is closing');
    let name: string;
    if (folder === null) {
      name = `\\\\.\\pipe\\damocles-${forward.kind}-${randomBytes(16).toString('hex')}`;
    } else {
      await ownFolder(folder);
      name = path.join(folder, `${forward.kind === 'relay' ? 'askpass' : forward.kind}-${randomBytes(12).toString('hex')}.sock`);
    }
    return { name, forward, server: await listenAt(name, forward) };
  };

  // Its held connections close with it; connections already passed to a daemon end with their streams. remove: its socket
  // file is this host's to remove.
  const closeEndpoint = async (listening: Listening, remove: boolean): Promise<void> => {
    listening.server.close();
    for (const entry of [...waiting]) {
      if (entry.forward !== listening.forward) continue;
      unhold(entry);
      entry.socket.destroy();
    }
    if (remove && !windows) await fs.rm(listening.name, { force: true });
  };

  // Names a variable as the shell reads it; Windows names variables in any case.
  const setVariable = (env: Record<string, string>, name: string, value: string): void => {
    if (windows) for (const key of Object.keys(env)) if (key.toUpperCase() === name) delete env[key];
    env[name] = value;
  };

  // The spawn's environment with the terminal's own endpoints in place of any the daemon named.
  const withEndpoints = (id: string, request: TerminalHostSpawn): Promise<Record<string, string>> => serially(async () => {
    const env = { ...request.env };
    const { cli, relay, agentKey } = request.endpoints;
    if (cli) {
      const listening = await open({ kind: 'cli', terminalId: id });
      cliEndpoints.set(id, listening);
      setVariable(env, CLI_HOOK_ENV, listening.name);
    }
    if (agentKey !== undefined) {
      let listening = agentEndpoints.get(agentKey);
      if (!listening) {
        listening = await open({ kind: 'agent', key: agentKey });
        agentEndpoints.set(agentKey, listening);
      }
      agentKeys.set(id, agentKey);
      setVariable(env, 'SSH_AUTH_SOCK', listening.name);
    }
    if (relay) {
      relayEndpoint ??= await open({ kind: 'relay' });
      setVariable(env, 'DAMOCLES_ASKPASS_HANDLE', relayEndpoint.name);
      setVariable(env, CREDENTIAL_NONCE_VARIABLE, relayNonce);
    }
    return env;
  });

  // The terminal's own CLI socket goes with it, and its agent socket once no other terminal names that key.
  const dropEndpoints = (id: string): void => void serially(async () => {
    const cli = cliEndpoints.get(id);
    cliEndpoints.delete(id);
    if (cli) await closeEndpoint(cli, true);
    const key = agentKeys.get(id);
    agentKeys.delete(id);
    if (key === undefined || [...agentKeys.values()].includes(key)) return;
    const agent = agentEndpoints.get(key);
    agentEndpoints.delete(key);
    if (agent) await closeEndpoint(agent, true);
  }).catch((err: unknown) => log(`[terminal-host] closing the endpoints of ${id} failed: ${errorText(err)}`));

  // A tmp cleaner removed the socket: bound again at the same path, so every shell naming it keeps working.
  const rebind = async (folder: string, listening: Listening): Promise<void> => {
    if (closing) return;
    try {
      await ownFolder(folder);
      listening.server.close();
      listening.server = await listenAt(listening.name, listening.forward);
      log(`[terminal-host] ${listening.name} was removed; bound it again`);
    } catch (err) {
      log(`[terminal-host] ${listening.name} was removed and stays gone: ${errorText(err)}`);
      for (const [id, cli] of cliEndpoints) if (cli === listening) cliEndpoints.delete(id);
      for (const [key, agent] of agentEndpoints) if (agent === listening) agentEndpoints.delete(key);
      if (relayEndpoint === listening) relayEndpoint = undefined;
      await closeEndpoint(listening, false);
    }
  };

  const deadline = (id: string, terminal: Hosted): number | undefined => (idleDays === 0 || terminal.detachedAt === undefined || ending.has(id) ? undefined : terminal.detachedAt + idleDays * DAY_MS);

  const arm = (): void => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    if (closing) return;
    const next = Math.min(...[...terminals].flatMap(([id, terminal]) => deadline(id, terminal) ?? []));
    if (next !== Infinity) idleTimer = setTimeout(sweep, Math.min(Math.max(next - now(), 0), MAX_TIMER_MS));
  };

  // The host holds the terminal no longer; the attached daemon hears it once.
  const drop = (id: string, exitCode: number): void => {
    if (!terminals.delete(id)) return;
    dropEndpoints(id);
    deps.listed(hosted());
    emit('exit', { id, exitCode });
    arm();
    checkEmpty();
  };

  const handle = (request: Forwarded): Promise<void> => sessions.handle(request).catch((err: unknown) => log(`[terminal-host] a ${request.type} of ${request.id} failed: ${errorText(err)}`));

  const queueBehind = (id: string, handled: Promise<void>): Promise<void> => {
    const tail = handled.then(() => undefined, () => undefined);
    starting.set(id, tail);
    void tail.then(() => {
      if (starting.get(id) === tail) starting.delete(id);
    });
    return handled;
  };

  // A terminal's requests reach the sessions only once its spawn did, which waits for its endpoints first.
  const run = (request: Forwarded): Promise<void> => {
    const prior = starting.get(request.id);
    return prior ? queueBehind(request.id, prior.then(() => handle(request))) : handle(request);
  };

  // A kill of a terminal already ending answers with that end, so every kill reports the exit before its answer.
  const end = (id: string): Promise<void> => {
    const under = ending.get(id);
    if (under) return under;
    const terminal = terminals.get(id);
    if (!terminal) return Promise.resolve();
    const ended = run({ type: 'kill', id }).then(() => {
      ending.delete(id);
      if (terminals.get(id) === terminal) drop(id, 1);
    });
    ending.set(id, ended);
    return ended;
  };

  function sweep(): void {
    idleTimer = undefined;
    for (const [id, terminal] of [...terminals]) {
      if ((deadline(id, terminal) ?? Infinity) > now()) continue;
      log(`[terminal-host] ending ${id}: no client viewed it within the idle limit of ${idleDays} days`);
      void end(id);
    }
    arm();
  }

  const receive = (message: HostMessage): void => {
    const terminal = terminals.get(message.id);
    if (!terminal) return;
    switch (message.type) {
      case 'ready':
        terminal.pid = message.pid;
        deps.listed(hosted());
        emit('ready', { id: message.id, pid: message.pid });
        return;
      case 'data':
        emit('data', { id: message.id, data: message.data });
        return;
      case 'screen': {
        if (terminal.stale > 0) {
          terminal.stale--;
          return;
        }
        terminal.asked = Math.max(terminal.asked - 1, 0);
        terminal.cols = message.cols;
        terminal.rows = message.rows;
        const { type: _type, ...screen } = message;
        emit('screen', screen);
        return;
      }
      case 'process':
        emit('process', { id: message.id, name: message.name });
        return;
      case 'exit':
        drop(message.id, message.exitCode);
        return;
      case 'error':
        // a spawn that failed leaves no terminal behind, and no exit to report
        if (starting.has(message.id) && terminals.delete(message.id)) {
          dropEndpoints(message.id);
          deps.listed(hosted());
        }
        emit('error', { id: message.id, message: message.message });
        checkEmpty();
        return;
    }
  };

  const sessions = createPtySessions({ spawn: deps.spawn, post: receive, throttleConpty: deps.throttleConpty, readProcessName: deps.readProcessName, screen: deps.screen, selfAcknowledge: true, log });

  const hosted = (): HostedTerminal[] => [...terminals].map(([id, terminal]) => ({
    id,
    pid: terminal.pid,
    cols: terminal.cols,
    rows: terminal.rows,
    scrollback: terminal.scrollback,
    title: terminal.title,
    projectKey: terminal.projectKey,
    ...(terminal.view !== undefined ? { view: terminal.view } : {}),
    ...(terminal.detachedAt !== undefined ? { detachedAt: terminal.detachedAt } : {}),
  }));

  // No daemon views anything now: each idle clock runs, and the screens that connection asked for go to nobody.
  const leave = (): void => {
    for (const terminal of terminals.values()) {
      terminal.detachedAt ??= now();
      terminal.stale += terminal.asked;
      terminal.asked = 0;
    }
  };

  const endAll = async (): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), SHUTDOWN_TIMEOUT_MS);
    });
    const killed = sessions.handle({ type: 'shutdown' }).then(() => false, (err: unknown) => {
      log(`[terminal-host] killing the ptys failed: ${errorText(err)}`);
      return false;
    });
    if (await Promise.race([killed, timedOut])) log(`[terminal-host] a pty was still connecting after ${SHUTDOWN_TIMEOUT_MS} ms; its shell ends with this process`);
    clearTimeout(timer);
    for (const id of [...terminals.keys()]) drop(id, 1);
  };

  const answer = (hello: Hello): HelloAnswer => {
    const refused = (reason: 'protocol' | 'unknown-token'): HelloAnswer => ({ kind: 'refused', refused: { reason, serverVersion: deps.version, protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION } });
    if (hello.protocolVersion !== TERMINAL_HOST_PROTOCOL_VERSION) return refused('protocol');
    // a host link is never resumed
    if (hello.reconnectionToken) return refused('unknown-token');
    return {
      kind: 'welcome',
      welcome: {
        serverVersion: deps.version,
        protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
        features: [...TERMINAL_HOST_FEATURES],
        // the frozen welcome needs them and a daemon reads none, so none comes from the machine, where one could fail the parse
        facts: { os: windows ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux', arch: process.arch, libc: null, homedir: '/', shell: '', gitAvailable: false, pathFlavor: windows ? 'win32' : 'posix' },
        reconnectionToken: randomBytes(NONCE_BYTES),
        resumed: false,
        coreEpoch: null,
        serverTime: now(),
      },
    };
  };

  const connected = (socket: Duplex, protocol: PersistentProtocol, accepted: Accepted): void => {
    if (accepted.answer.kind === 'refused') {
      log(`[terminal-host] refused ${accepted.hello.clientId} (${accepted.hello.appVersion}): ${accepted.answer.refused.reason}`);
      // ended, not destroyed, so the refusal reaches the daemon first
      socket.end();
      return;
    }
    const close = (reason: string): void => protocol.close(reason);
    protocol.setMaxBodyBytes(MAX_FRAME_BYTES);
    const mux = createMux({ protocol, side: 'daemon', acceptStreams: false, onOverflow: () => close('held frames passed the per-connection bound'), onViolation: close, log });
    const endpoint = createEndpoint<TerminalHostToDaemon, DaemonToTerminalHost>({
      transport: channelTransport(mux.messageChannel(CHANNEL.control, TERMINAL_HOST_MAX_MESSAGE_BYTES), TERMINAL_HOST_MAX_MESSAGE_BYTES, close),
      outgoing: TERMINAL_HOST_TO_DAEMON,
      incoming: DAEMON_TO_TERMINAL_HOST,
      log,
      onViolation: (error) => close(error.message),
      checkOutgoing: true,
    });
    const link: Link = { protocol, mux, endpoint, forwards: false };
    const who = `${accepted.hello.clientId} (${accepted.hello.appVersion})`;
    let attached = false;

    // attach comes first: anything else from a connection that is not the host's daemon is a violation
    const whenAttached = <P, R>(what: string, handler: (params: P) => R) => (params: P): R => {
      if (daemon !== link) {
        close(`a ${what} before attach`);
        throw new Error(`${what} needs an attached connection`);
      }
      return handler(params);
    };
    const held = <P extends { readonly id: string }>(what: string, handler: (params: P, terminal: Hosted) => void) => whenAttached(what, (params: P): void => {
      const terminal = terminals.get(params.id);
      if (terminal) handler(params, terminal);
    });

    endpoint.serve('attach', ({ features, idleDays: days }) => {
      if (attached) {
        close('a second attach');
        throw new Error('this connection attached already');
      }
      attached = true;
      const earlier = daemon;
      daemon = link;
      earlier?.protocol.close('another daemon attached');
      leave();
      sessions.setSelfAcknowledge(false);
      if (days !== undefined) idleDays = days;
      arm();
      log(`[terminal-host] daemon ${who} attached${features.length > 0 ? ` with ${features.join(', ')}` : ''}; ${terminals.size} terminals, idle limit ${idleDays} days`);
      // before the answer, so the daemon knows the nonce and the waiting connections by the time it has the terminals
      if (features.includes(ENDPOINTS_FEATURE)) {
        link.forwards = true;
        emit('relayNonce', { nonce: relayNonce });
        for (const entry of [...waiting]) {
          unhold(entry);
          pass(link, entry.socket, entry.forward);
        }
      }
      return { terminals: hosted() };
    });
    endpoint.serve('list', whenAttached('list', () => ({ terminals: hosted() })));
    endpoint.serve('kill', whenAttached('kill', ({ id }) => end(id)));
    endpoint.serve('idleDays', whenAttached('idleDays', ({ days }) => {
      idleDays = days;
      arm();
    }));
    endpoint.serve('shutdown', whenAttached('shutdown', async () => {
      log(`[terminal-host] daemon ${who} asked for a shutdown`);
      await endAll();
      // after the answer is on its way
      setImmediate(() => void mux.drained().then(() => exit('a daemon asked it to shut down')));
    }));
    endpoint.serve('spawn', whenAttached('spawn', async (request) => {
      const { id } = request;
      if (terminals.has(id) || terminals.size >= MAX_HOSTED_TERMINALS) {
        emit('error', { id, message: terminals.has(id) ? `terminal ${id} is already running` : `this host already runs ${MAX_HOSTED_TERMINALS} terminals` });
        return;
      }
      const terminal: Hosted = { pid: 0, cols: request.cols, rows: request.rows, scrollback: request.scrollback, title: request.title, projectKey: request.projectKey, view: request.view, detachedAt: undefined, asked: 0, stale: 0 };
      terminals.set(id, terminal);
      deps.listed(hosted());
      const start = async (): Promise<void> => {
        try {
          // before the pty starts, so the shell never names an endpoint that is not there yet
          const env = await withEndpoints(id, request);
          // a shutdown ended it meanwhile, its endpoints with it
          if (terminals.get(id) !== terminal) return;
          await sessions.handle(ptySpawn({ ...request, env }));
        } catch (err) {
          // the sessions may hold a pty for it; the host holds no terminal it cannot serve
          if (terminals.get(id) === terminal) {
            await handle({ type: 'kill', id });
            if (terminals.delete(id)) {
              dropEndpoints(id);
              deps.listed(hosted());
              emit('error', { id, message: errorText(err).slice(0, MAX_HOSTED_MESSAGE_CHARS) });
            }
          }
          checkEmpty();
          throw err;
        }
      };
      await queueBehind(id, start());
    }));

    endpoint.onEvent('serialize', held('serialize', ({ id }, terminal) => {
      terminal.asked++;
      void run({ type: 'serialize', id });
    }));
    endpoint.onEvent('input', held('input', ({ id, data }) => void run({ type: 'input', id, data })));
    endpoint.onEvent('resize', held('resize', ({ id, cols, rows }, terminal) => {
      terminal.cols = cols;
      terminal.rows = rows;
      void run({ type: 'resize', id, cols, rows });
    }));
    endpoint.onEvent('ack', held('ack', ({ id, chars }) => void run({ type: 'ack', id, chars })));
    endpoint.onEvent('viewed', held('viewed', ({ viewed }, terminal) => {
      terminal.detachedAt = viewed ? undefined : (terminal.detachedAt ?? now());
      arm();
    }));
    endpoint.onEvent('scrollback', held('scrollback', ({ id, scrollback }, terminal) => {
      terminal.scrollback = scrollback;
      void run({ type: 'scrollback', id, scrollback });
    }));
    endpoint.onEvent('clear', held('clear', ({ id }) => void run({ type: 'clear', id })));

    protocol.onClose((reason) => {
      endpoint.close('the connection closed');
      mux.dispose();
      log(`[terminal-host] the connection of ${who} closed: ${reason}`);
      if (daemon !== link) return;
      daemon = undefined;
      leave();
      sessions.setSelfAcknowledge(true);
      arm();
      checkEmpty();
    });
    protocol.startKeepAlive();
  };

  return {
    accept: (socket, token) => {
      if (closing) {
        socket.destroy();
        return;
      }
      if (authenticating.size >= MAX_AUTHENTICATING) {
        const [oldest] = authenticating;
        if (oldest) sockets.get(oldest)?.close(`${MAX_AUTHENTICATING} newer connections are authenticating`);
      }
      authenticating.add(socket);
      socket.once('close', () => {
        authenticating.delete(socket);
        sockets.delete(socket);
      });
      const protocol = createPersistentProtocol({ socket: streamSocket(socket), maxBodyBytes: HANDSHAKE_MAX_BYTES, log });
      sockets.set(socket, protocol);
      acceptConnection({
        protocol,
        token,
        answer,
        accepted: (accepted) => {
          authenticating.delete(socket);
          connected(socket, protocol, accepted);
        },
        // runs from a timer too, so it only logs
        failed: (reason) => {
          authenticating.delete(socket);
          refused(reason);
        },
      });
    },
    touchEndpoints: () => serially(async () => {
      const folder = await deps.endpointFolder();
      // a pipe holds its name while the host lives
      if (closing || folder === null) return;
      for (const listening of [...cliEndpoints.values(), ...agentEndpoints.values(), ...(relayEndpoint ? [relayEndpoint] : [])]) {
        if (!(await touch([listening.name]))) await rebind(folder, listening);
      }
    }),
    serving: () => {
      emptyTimer ??= setTimeout(() => {
        mayExitEmpty = true;
        checkEmpty();
      }, deps.emptyCheckMs ?? EMPTY_CHECK_MS);
    },
    stop: () => {
      closing = true;
    },
    close: async () => {
      closing = true;
      clearTimeout(emptyTimer);
      clearTimeout(idleTimer);
      clearTimeout(refusalTimer);
      clearTimeout(endpointNoteTimer);
      await serially(async () => {
        for (const listening of [...cliEndpoints.values(), ...agentEndpoints.values(), ...(relayEndpoint ? [relayEndpoint] : [])]) await closeEndpoint(listening, true);
        cliEndpoints.clear();
        agentEndpoints.clear();
        relayEndpoint = undefined;
      });
      for (const entry of [...waiting]) {
        unhold(entry);
        entry.socket.destroy();
      }
      await endAll();
      await Promise.all([...sockets].map(([socket, protocol]) => new Promise<void>((resolve) => {
        // a peer that never ends its side is cut off
        const timer = setTimeout(() => socket.destroy(), END_TIMEOUT_MS);
        socket.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        protocol.end('the terminal host is closing');
      })));
    },
  };
}
