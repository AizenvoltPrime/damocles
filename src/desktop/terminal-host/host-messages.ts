// The terminal host contract: what a daemon and a terminal host send each other on the control channel of the host's own
// endpoint. FrozenTerminalHostRequests, FrozenTerminalHostDaemonEvents and FrozenTerminalHostEvents are frozen: every daemon
// of every later version adopts every older host with them, so their shapes, bounds and meanings never change, and each is
// declared here and nowhere else. A terminal the host does not hold is named by no event, and an event from the daemon that
// names one is dropped.

import type { Call, Contract, Tables } from '../core-protocol/messages';
import { arr, bool, either, int, INVALID, nonEmpty, none, obj, oneOf, opt, str, streamId, type Parser } from '../core-protocol/schema';
import { parseHostRequest, type HostRequest } from '../pty-host/protocol';

// the hello a daemon sends a host and the welcome it gets; a host refuses any other number
export const TERMINAL_HOST_PROTOCOL_VERSION = 1;

// The largest message is a list of MAX_HOSTED_TERMINALS terminals with every text at its bound, at most 3 UTF-8 bytes per
// UTF-16 unit; a screen of MAX_HOSTED_SCREEN_CHARS with its kept shell sequences is a tenth of it.
export const TERMINAL_HOST_MAX_MESSAGE_BYTES: number = 1024 * 1024 * 1024;

// Frozen bounds. A daemon sends within them and a host answers within them, whatever either side's own limits are. None is
// narrower than what a daemon accepted from a client when the contract was frozen.
export const MAX_HOSTED_TERMINALS = 256;
export const MAX_HOSTED_ID_CHARS = 50;
export const MAX_HOSTED_COLS = 2000;
export const MAX_HOSTED_ROWS = 1000;
export const MAX_HOSTED_SCROLLBACK = 100_000;
export const MAX_HOSTED_TITLE_CHARS = 1024;
export const MAX_HOSTED_PROJECT_KEY_CHARS = 32_767;
// above the longest JSON text of a TerminalView: 21 texts of 4096 units, each unit escaped as six
export const MAX_HOSTED_VIEW_CHARS: number = 1024 * 1024;
export const MAX_HOSTED_PID: number = 2 ** 32;
export const MAX_HOSTED_IDLE_DAYS = 3650;
export const DEFAULT_HOSTED_IDLE_DAYS = 30;
export const MAX_HOSTED_FEATURES = 256;
export const MAX_HOSTED_INPUT_CHARS: number = 64 * 1024;
export const MAX_HOSTED_ACK_CHARS = 1_000_000;
export const MAX_HOSTED_DATA_CHARS: number = 64 * 1024;
export const MAX_HOSTED_SCREEN_CHARS: number = 32 * 1024 * 1024;
export const MAX_HOSTED_SCREEN_MARKS = 400;
export const MAX_HOSTED_KEPT_SEQUENCES = 600;
export const MAX_HOSTED_SEQUENCE_CHARS: number = 16 * 1024;
export const MAX_HOSTED_KEPT_SEQUENCE_CHARS: number = 1024 * 1024;
export const MAX_HOSTED_PROCESS_NAME_CHARS = 256;
export const MAX_HOSTED_MESSAGE_CHARS = 2000;

export const HOSTED_ID: RegExp = /^term-[1-9][0-9]{0,14}$/;
export const HOSTED_FEATURE: RegExp = /^[A-Za-z0-9._-]{1,128}$/;

/** A terminal a host holds, as attach and list answer it. */
export interface HostedTerminal {
  readonly id: string;
  // 0 until a Windows pty connected; ready follows with the pid
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  // what the host's screen keeps
  readonly scrollback: number;
  readonly title: string;
  // the native folder key on the target; empty for a terminal no project started
  readonly projectKey: string;
  // the terminal's TerminalView as JSON text, which only a daemon parses; absent for a terminal started without one
  readonly view?: string;
  // the host's clock, in ms, when the terminal was last left with no viewer; absent while it is viewed
  readonly detachedAt?: number;
}

/**
 * daemon → host. attach is a connection's first message and is sent once: it makes this connection the host's daemon, closes
 * the connection of any earlier one, and starts pacing every pty by this daemon's acks from zero. Every terminal is unviewed
 * until this daemon says otherwise, its idle clock running from when it was last left, and a screen an earlier connection
 * asked for is never sent. features: the terminal host feature names the daemon knows. idleDays, here and in the request of
 * that name: a terminal left unviewed for that many days is ended; 0 keeps it forever; absent, the host keeps the limit it has,
 * DEFAULT_HOSTED_IDLE_DAYS until a daemon gave one. kill ends that terminal, which
 * reports its exit before the answer; one the host does not hold answers the same. shutdown ends every terminal, each
 * reporting its exit, answers, ends the connection and the host exits.
 */
export interface FrozenTerminalHostRequests {
  attach: Call<{ readonly features: readonly string[]; readonly idleDays?: number }, { readonly terminals: readonly HostedTerminal[] }>;
  list: Call<object, { readonly terminals: readonly HostedTerminal[] }>;
  kill: Call<{ readonly id: string }, void>;
  shutdown: Call<object, void>;
  idleDays: Call<{ readonly days: number }, void>;
}

/**
 * daemon → host, after attach. serialize: the host answers one screen per serialize, in order, after every data before it.
 * ack: the daemon took that many UTF-16 units of the terminal's data; a pty with more than the host's high watermark
 * unacknowledged is paused until the acks bring it under the low one. viewed: whether any client views the terminal; false
 * starts its idle clock, true stops it, and a daemon connection that ends leaves every terminal unviewed. scrollback: what
 * the host's screen keeps from then on. clear: clears the host's screen after the output so far.
 */
export interface FrozenTerminalHostDaemonEvents {
  serialize: { readonly id: string };
  input: { readonly id: string; readonly data: string };
  resize: { readonly id: string; readonly cols: number; readonly rows: number };
  ack: { readonly id: string; readonly chars: number };
  viewed: { readonly id: string; readonly viewed: boolean };
  scrollback: { readonly id: string; readonly scrollback: number };
  clear: { readonly id: string };
}

/**
 * host → daemon, to the attached daemon only. ready: the pty has its pid. screen: the answer to serialize; marks are the
 * kept OSC 633 sequences' lines by index, sequences the index the next OSC 633 sequence gets, shellSequences the latest kept
 * payloads in index order, processName the last name sent as process, now the host's clock at the serialize, which each kept
 * time is read against. process: the foreground process's name changed (macOS and Linux). exit: the host no longer holds
 * the terminal; exitCode is the process's, or 1 for one the host ended. error: a spawn of that id started nothing; a terminal
 * the host already held under that id runs on.
 */
export interface FrozenTerminalHostEvents {
  ready: { readonly id: string; readonly pid: number };
  data: { readonly id: string; readonly data: string };
  screen: {
    readonly id: string;
    readonly data: string;
    readonly cols: number;
    readonly rows: number;
    readonly marks: readonly { readonly index: number; readonly line: number }[];
    readonly sequences: number;
    readonly shellSequences?: readonly { readonly index: number; readonly body: string; readonly time: number }[];
    readonly processName?: string;
    readonly now?: number;
  };
  process: { readonly id: string; readonly name: string };
  exit: { readonly id: string; readonly exitCode: number };
  error: { readonly id: string; readonly message: string };
}

// The host's own feature names, which its welcome lists; a daemon's attach lists the ones it knows. Each addition to
// TerminalHostEvents is named here, and protocol-compat.ts checks the table against this list.
export const TERMINAL_HOST_FEATURES: readonly string[] = ['terminalHost.endpoints'];
// the endpoints feature, as both sides check it
export const ENDPOINTS_FEATURE = 'terminalHost.endpoints';
// a host's endpoint connections waiting for a daemon that lists ENDPOINTS_FEATURE, and how long each waits
export const MAX_HELD_ENDPOINT_CONNECTIONS = 64;
export const ENDPOINT_HOLD_MS = 30_000;

/**
 * Not frozen, additive: host → daemon, only to a daemon whose attach listed ENDPOINTS_FEATURE. relayNonce: the host's
 * credential nonce, which its terminals' git credential helper sends, sent once in answer to attach before its result.
 * connection: a process connected to one of the host's endpoints, whose bytes cross on the stream the host opened just before:
 * a terminal's damocles command socket, the agent socket of a forwarded agent's key (agentSocketName's 24 hex digits), or the
 * credential relay.
 */
export interface TerminalHostEvents {
  relayNonce: { readonly nonce: string };
  connection:
    | { readonly stream: number; readonly kind: 'cli'; readonly terminalId: string }
    | { readonly stream: number; readonly kind: 'agent'; readonly key: string }
    | { readonly stream: number; readonly kind: 'relay' };
}

/**
 * Not frozen: only a daemon and a host of the same server version use it. It answers once the pty started or failed to;
 * ready or error then reports which. A new terminal is viewed. An id the host holds, or a host at MAX_HOSTED_TERMINALS,
 * reports error and starts nothing.
 */
export interface TerminalHostSpawnRequests {
  spawn: Call<TerminalHostSpawn, void>;
}

/**
 * The endpoints the host makes for a terminal and names in its environment, in place of any the daemon put there: cli its
 * own damocles command socket (DAMOCLES_CLI_HOOK), relay the host's credential relay (DAMOCLES_ASKPASS_HANDLE and
 * DAMOCLES_CREDENTIAL_NONCE), agentKey the agent socket of that key (SSH_AUTH_SOCK), shared by every terminal of the key.
 */
export interface TerminalHostEndpoints {
  readonly cli: boolean;
  readonly relay: boolean;
  readonly agentKey?: string;
}

export interface TerminalHostSpawn {
  readonly id: string;
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
  readonly scrollback: number;
  readonly title: string;
  readonly projectKey: string;
  // HostedTerminal.view
  readonly view?: string;
  readonly endpoints: TerminalHostEndpoints;
}

export interface DaemonToTerminalHost extends Contract {
  readonly requests: FrozenTerminalHostRequests & TerminalHostSpawnRequests;
  readonly events: FrozenTerminalHostDaemonEvents;
  readonly mirrors: Record<string, never>;
  readonly panelOps: Record<string, never>;
}

export interface TerminalHostToDaemon extends Contract {
  readonly requests: Record<string, never>;
  readonly events: FrozenTerminalHostEvents & TerminalHostEvents;
  readonly mirrors: Record<string, never>;
  readonly panelOps: Record<string, never>;
}

const method = <P, R>(params: Parser<P>, result: Parser<R>): { readonly params: Parser<P>; readonly result: Parser<R> } => ({ params, result });

const id: Parser<string> = (raw) => (typeof raw === 'string' && raw.length <= MAX_HOSTED_ID_CHARS && HOSTED_ID.test(raw) ? raw : INVALID);
const feature: Parser<string> = (raw) => (typeof raw === 'string' && HOSTED_FEATURE.test(raw) ? raw : INVALID);
const count = int(0, Number.MAX_SAFE_INTEGER);
const cols = int(1, MAX_HOSTED_COLS);
const rows = int(1, MAX_HOSTED_ROWS);
const scrollback = int(0, MAX_HOSTED_SCROLLBACK);
const idleDays = int(0, MAX_HOSTED_IDLE_DAYS);
const title = str(MAX_HOSTED_TITLE_CHARS);
const projectKey = str(MAX_HOSTED_PROJECT_KEY_CHARS);
const view = nonEmpty(MAX_HOSTED_VIEW_CHARS);
const nothing = obj({});
const pid = int(0, MAX_HOSTED_PID);
const hostedTerminal: Parser<HostedTerminal> = obj({ id, pid, cols, rows, scrollback, title, projectKey, view: opt(view), detachedAt: opt(count) });
const terminalList = obj({ terminals: arr(hostedTerminal, MAX_HOSTED_TERMINALS) });
const agentKey: Parser<string> = (raw) => (typeof raw === 'string' && /^[0-9a-f]{24}$/.test(raw) ? raw : INVALID);
const nonce: Parser<string> = (raw) => (typeof raw === 'string' && /^[0-9a-f]{64}$/.test(raw) ? raw : INVALID);
const connection = either(
  obj({ stream: streamId, kind: oneOf(['cli'] as const), terminalId: id }),
  either(obj({ stream: streamId, kind: oneOf(['agent'] as const), key: agentKey }), obj({ stream: streamId, kind: oneOf(['relay'] as const) })),
);

const spawn: Parser<TerminalHostSpawn> = (raw) => {
  const own = obj({ title, projectKey, view: opt(view), endpoints: obj({ cli: bool, relay: bool, agentKey: opt(agentKey) }) })(raw);
  if (own === INVALID) return INVALID;
  const request = parseHostRequest({ ...(raw as object), type: 'spawn', view: undefined });
  if (request?.type !== 'spawn') return INVALID;
  const { type: _type, view: _view, ...pty } = request;
  return { ...pty, ...own };
};

/** A spawn as the host's sessions take it. */
export function ptySpawn(request: TerminalHostSpawn): Extract<HostRequest, { readonly type: 'spawn' }> {
  const { title: _title, projectKey: _projectKey, view: _view, endpoints: _endpoints, ...pty } = request;
  return { type: 'spawn', ...pty };
}

export const DAEMON_TO_TERMINAL_HOST: Tables<DaemonToTerminalHost> = {
  requests: {
    attach: method(obj({ features: arr(feature, MAX_HOSTED_FEATURES), idleDays: opt(idleDays) }), terminalList),
    list: method(nothing, terminalList),
    kill: method(obj({ id }), none),
    shutdown: method(nothing, none),
    idleDays: method(obj({ days: idleDays }), none),
    spawn: method(spawn, none),
  },
  events: {
    serialize: obj({ id }),
    input: obj({ id, data: str(MAX_HOSTED_INPUT_CHARS) }),
    resize: obj({ id, cols, rows }),
    ack: obj({ id, chars: int(1, MAX_HOSTED_ACK_CHARS) }),
    viewed: obj({ id, viewed: bool }),
    scrollback: obj({ id, scrollback }),
    clear: obj({ id }),
  },
  mirrors: {},
  panelOps: {},
};

export const TERMINAL_HOST_TO_DAEMON: Tables<TerminalHostToDaemon> = {
  requests: {},
  events: {
    ready: obj({ id, pid }),
    data: obj({ id, data: nonEmpty(MAX_HOSTED_DATA_CHARS) }),
    screen: obj({
      id,
      data: str(MAX_HOSTED_SCREEN_CHARS),
      cols,
      rows,
      marks: arr(obj({ index: count, line: count }), MAX_HOSTED_SCREEN_MARKS),
      sequences: count,
      shellSequences: opt(arr(obj({ index: count, body: str(MAX_HOSTED_SEQUENCE_CHARS), time: count }), MAX_HOSTED_KEPT_SEQUENCES)),
      processName: opt(str(MAX_HOSTED_PROCESS_NAME_CHARS)),
      now: opt(count),
    }),
    process: obj({ id, name: str(MAX_HOSTED_PROCESS_NAME_CHARS) }),
    exit: obj({ id, exitCode: int(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) }),
    error: obj({ id, message: str(MAX_HOSTED_MESSAGE_CHARS) }),
    relayNonce: obj({ nonce }),
    connection,
  },
  mirrors: {},
  panelOps: {},
};
