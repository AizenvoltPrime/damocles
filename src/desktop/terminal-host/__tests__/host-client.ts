// A daemon's side of the terminal host link, for tests: the token proof, hello, then the contract's endpoint.
import * as net from 'node:net';
import { createEndpoint, type Endpoint } from '../../core-protocol/endpoint';
import { channelTransport } from '../../../remote/channel-transport';
import { authenticateBridge, HANDSHAKE_MAX_BYTES, sayHello, type HelloOutcome } from '../../../remote/handshake';
import { CHANNEL, createMux, MAX_FRAME_BYTES, type StreamChannel } from '../../../remote/mux';
import { createPersistentProtocol, type PersistentProtocol } from '../../../remote/persistent-protocol';
import { streamSocket } from '../../../remote/stream-transport';
import { streamClaims } from '../../../remote/tunnel-pipe';
import { DAEMON_TO_TERMINAL_HOST, TERMINAL_HOST_MAX_MESSAGE_BYTES, TERMINAL_HOST_PROTOCOL_VERSION, TERMINAL_HOST_TO_DAEMON, type DaemonToTerminalHost, type TerminalHostToDaemon } from '../host-messages';

type HostEvents = TerminalHostToDaemon['events'];
export type Event = { [E in keyof HostEvents]: { readonly name: E } & HostEvents[E] }[keyof HostEvents];

export interface Daemon {
  readonly welcome: HelloOutcome;
  readonly protocol: PersistentProtocol;
  readonly endpoint: Endpoint<DaemonToTerminalHost, TerminalHostToDaemon>;
  // every event the host sent, in order
  readonly events: Event[];
  // the stream each connection event named, claimed as the daemon claims it
  readonly streams: Map<number, StreamChannel>;
  readonly closed: Promise<string>;
  isClosed(): boolean;
}

export function openSocket(endpoint: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** Rejects when the endpoint does not prove the token; a refused hello resolves with its refusal. */
export async function connectDaemon(socket: net.Socket, token: Uint8Array, protocolVersion: number = TERMINAL_HOST_PROTOCOL_VERSION, reconnectionToken?: Uint8Array): Promise<Daemon> {
  const protocol = createPersistentProtocol({ socket: streamSocket(socket), maxBodyBytes: HANDSHAKE_MAX_BYTES, log: () => undefined });
  let wasClosed = false;
  // pending requests reject once the connection closed
  const closers: Array<(reason: string) => void> = [];
  const closed = new Promise<string>((resolve) => {
    protocol.onClose((reason) => {
      wasClosed = true;
      for (const closer of closers) closer(reason);
      resolve(reason);
    });
  });
  await authenticateBridge(protocol, token);
  const welcome = await sayHello(protocol, { appVersion: '3.8.0+ba9876543210', protocolVersion, clientId: 'daemon-1', deviceName: 'box', ...(reconnectionToken ? { reconnectionToken } : {}) });
  const close = (reason: string): void => protocol.close(reason);
  protocol.setMaxBodyBytes(MAX_FRAME_BYTES);
  const mux = createMux({ protocol, side: 'client', acceptStreams: true, onOverflow: () => close('overflow'), onViolation: close, log: () => undefined });
  const claims = streamClaims(mux, close);
  const made = createEndpoint<DaemonToTerminalHost, TerminalHostToDaemon>({
    transport: channelTransport(mux.messageChannel(CHANNEL.control, TERMINAL_HOST_MAX_MESSAGE_BYTES), TERMINAL_HOST_MAX_MESSAGE_BYTES, close),
    outgoing: DAEMON_TO_TERMINAL_HOST,
    incoming: TERMINAL_HOST_TO_DAEMON,
    log: () => undefined,
    onViolation: (error) => close(error.message),
  });
  closers.push((reason) => {
    made.close(reason);
    claims.dispose();
  });
  const events: Event[] = [];
  const streams = new Map<number, StreamChannel>();
  for (const name of ['ready', 'data', 'screen', 'process', 'exit', 'error', 'relayNonce'] as const) made.onEvent(name, (payload) => events.push({ name, ...payload } as Event));
  made.onEvent('connection', (connection) => {
    const stream = claims.claim(connection.stream);
    if (stream) streams.set(connection.stream, stream);
    events.push({ name: 'connection', ...connection });
  });
  return { welcome, protocol, endpoint: made, events, streams, closed, isClosed: () => wasClosed };
}

export const named = <E extends Event['name']>(daemon: Daemon, name: E): Array<Extract<Event, { name: E }>> => daemon.events.filter((event): event is Extract<Event, { name: E }> => event.name === name);
export const output = (daemon: Daemon): string => named(daemon, 'data').map((event) => event.data).join('');
export async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`the condition did not hold within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
