// The `ports` channel: the daemon reports every listening socket of its user and every loopback URL its terminals and agent
// shells print; the client decides what to forward and opens one `tunnel` stream per accepted connection.
import type { Call, Contract, Tables } from '../../core-protocol/messages';
import { arr, either, int, INVALID, none, nonEmpty, obj, oneOf, opt, str, streamId, type Parser } from '../../core-protocol/schema';

export const PORTS_MAX_MESSAGE_BYTES: number = 4 * 1024 * 1024;
export const MAX_PROCESS_NAME_CHARS = 256;
export const MAX_PROCESS_COMMAND_CHARS = 1024;
// a host name or address as the url finder or a bound socket names it
export const MAX_PORT_HOST_CHARS = 253;
// a candidate's largest encoding: 3 UTF-8 bytes per UTF-16 unit of its process strings, its two ASCII hosts, and 256 bytes
// for the tags, keys and numbers
const MAX_CANDIDATE_BYTES = 3 * (MAX_PROCESS_NAME_CHARS + MAX_PROCESS_COMMAND_CHARS) + 2 * MAX_PORT_HOST_CHARS + 256;
// sockets one list carries, as many as fit the channel's bound at their largest with 1 KiB for the envelope; a host listening
// on more is reported up to this many
export const MAX_PORT_CANDIDATES: number = Math.floor((PORTS_MAX_MESSAGE_BYTES - 1024) / MAX_CANDIDATE_BYTES);

/** The listening process: its executable name, and the command line of the process the user's shell started. */
export interface PortProcess {
  readonly name: string;
  readonly command?: string;
}

/** A listening TCP socket of the daemon's user. host: the loopback form of bindAddress, which the daemon connects to. */
export interface PortCandidate {
  readonly port: number;
  readonly bindAddress: string;
  readonly family: 4 | 6;
  readonly host: string;
  readonly pid?: number;
  readonly process?: PortProcess;
}

export type UrlSource = 'terminal' | 'agentShell';

export type ConnectAnswer = { readonly ok: true } | { readonly ok: false; readonly error: 'refused' | 'unreachable' | 'failed' };

export interface PortsRequests {
  // the client listens on this channel: the daemon sends its list and URLs from then on
  watch: Call<object, void>;
  // the client opened `stream` just before; the daemon connects host:port and pipes the two
  connect: Call<{ readonly stream: number; readonly host: string; readonly port: number }, ConnectAnswer>;
}

export interface PortsEvents {
  // the whole set on every change, and once to each new connection
  list: { readonly candidates: readonly PortCandidate[] };
  urlSeen: { readonly host: string; readonly port: number; readonly source: UrlSource };
}

export interface ClientToPorts extends Contract {
  readonly requests: PortsRequests;
  readonly events: Record<string, never>;
  readonly mirrors: Record<string, never>;
  readonly panelOps: Record<string, never>;
}

export interface PortsToClient extends Contract {
  readonly requests: Record<string, never>;
  readonly events: PortsEvents;
  readonly mirrors: Record<string, never>;
  readonly panelOps: Record<string, never>;
}

const port = int(1, 65535);
const literal = <const T extends boolean>(value: T): Parser<T> => (raw) => (raw === value ? value : INVALID);
// a host name of letters, digits, '.', '-', '_' or an IP literal without brackets; never option-like
const host: Parser<string> = (raw) => (typeof raw === 'string' && raw.length <= MAX_PORT_HOST_CHARS && /^[A-Za-z0-9_.:%-]+$/.test(raw) && !raw.startsWith('-') ? raw : INVALID);
const candidate: Parser<PortCandidate> = obj({
  port,
  bindAddress: host,
  family: (raw) => (raw === 4 || raw === 6 ? raw : INVALID),
  host,
  pid: opt(int(1, 2 ** 32)),
  process: opt(obj({ name: nonEmpty(MAX_PROCESS_NAME_CHARS), command: opt(str(MAX_PROCESS_COMMAND_CHARS)) })),
});

export const CLIENT_TO_PORTS: Tables<ClientToPorts> = {
  requests: {
    watch: { params: obj({}), result: none },
    connect: {
      params: obj({ stream: streamId, host, port }),
      result: either(obj({ ok: literal(true) }), obj({ ok: literal(false), error: oneOf(['refused', 'unreachable', 'failed'] as const) })),
    },
  },
  events: {},
  mirrors: {},
  panelOps: {},
};

export const PORTS_TO_CLIENT: Tables<PortsToClient> = {
  requests: {},
  events: {
    list: obj({ candidates: arr(candidate, MAX_PORT_CANDIDATES) }),
    urlSeen: obj({ host, port, source: oneOf(['terminal', 'agentShell'] as const) }),
  },
  mirrors: {},
  panelOps: {},
};
