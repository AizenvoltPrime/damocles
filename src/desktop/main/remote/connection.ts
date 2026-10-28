import type { Duplex } from 'node:stream';
import type { Disposable } from '../../../platform/disposable';
import { channelTransport } from '../../../remote/channel-transport';
import { listeners } from '../../../remote/listeners';
import { HANDSHAKE_MAX_BYTES, sayHello, type HostFacts } from '../../../remote/handshake';
import { CHANNEL, createMux, MAX_FRAME_BYTES, type StreamChannel } from '../../../remote/mux';
import { createPersistentProtocol } from '../../../remote/persistent-protocol';
import { PROTOCOL_VERSION } from '../../../remote/protocol-version';
import { streamSocket } from '../../../remote/stream-transport';
import { CORE_MAX_MESSAGE_BYTES } from '../../core-protocol/attached-transport';
import { createEndpoint, type CoreTransport, type Endpoint } from '../../core-protocol/endpoint';
import { ERROR_CODEC } from '../../core-protocol/errors';
import {
  CLIENT_TO_CONTROL,
  CONTROL_MAX_MESSAGE_BYTES,
  CONTROL_TO_CLIENT,
  FROZEN_CLIENT_TO_CONTROL,
  type AttachedClient,
  type ClientToControl,
  type ControlToClient,
  type FrozenClientToControl,
} from '../../daemon/control-messages';
import { CLIENT_TO_WORKSPACE, WORKSPACE_MAX_MESSAGE_BYTES, WORKSPACE_TO_CLIENT, type ClientToWorkspace, type WorkspaceToClient } from '../../workspace/messages';

export interface ConnectOptions {
  // the transport's byte stream, already past the bridge's authentication
  readonly stream: Duplex;
  readonly appVersion: string;
  readonly clientId: string;
  readonly deviceName: string;
  // the hello's protocol version: PROTOCOL_VERSION unless the e2e hooks name another
  readonly protocolVersion?: number;
  // damocles.desktop.remote.terminalIdleDays, sent in control.attach
  readonly terminalIdleDays: number;
  // a daemon of another protocol refused the hello: its connection stays open for the frozen control commands, handed here
  // before the connect rejects with OtherProtocolError; without it that connection closes
  readonly onOtherProtocol?: (daemon: OtherProtocolDaemon) => void;
  readonly log: (line: string) => void;
}

/** A daemon of another protocol version, reached for the frozen control commands alone (listRuns, the shutdowns, mirror.sync). */
export interface OtherProtocolDaemon {
  readonly serverVersion: string;
  readonly protocolVersion: number;
  readonly control: Endpoint<FrozenClientToControl, ControlToClient>;
  receiveStream(id: number, maxBytes: number, onChunk: (bytes: Uint8Array) => Promise<void>): Promise<number>;
  onClose(listener: (reason: string) => void): Disposable;
  close(reason: string): void;
}

/** The daemon runs another protocol version; when the connect was given onOtherProtocol, that handler holds its connection. */
export class OtherProtocolError extends Error {
  override readonly name: string = 'OtherProtocolError';
}

// The daemon resumes a dropped connection by its reconnection token, and both sides replay what they hold.
export const RESUME_FEATURE = 'protocol.resume';
// The daemon tells an attach that asks which devices are attached (control.clients).
export const CLIENTS_FEATURE = 'clients';

export type ResumeOutcome = 'resumed' | 'refused';

/** One authority's connection after its welcome: the daemon's facts and the endpoints over its control and workspace channels. */
export interface RemoteConnection {
  readonly facts: HostFacts;
  // the daemon's app version (welcome.serverVersion)
  readonly serverVersion: string;
  // what the daemon lists in welcome.features; a newer command is called only when it is listed
  readonly features: readonly string[];
  // serverTime minus the midpoint of hello and welcome on this computer's clock
  readonly skewMs: number;
  readonly control: Endpoint<ClientToControl, ControlToClient>;
  readonly workspace: Endpoint<ClientToWorkspace, WorkspaceToClient>;
  // the `core` channel, whose messages each attach generation tags (attachedTransport)
  readonly coreChannel: CoreTransport;
  // the bytes of a stream the daemon opened (a mirror.sync change), handed to onChunk in order; resolves the byte count once
  // the daemon ended it, rejects past maxBytes or when the connection closes first
  receiveStream(id: number, maxBytes: number, onChunk: (bytes: Uint8Array) => Promise<void>): Promise<number>;
  // once, with why the connection ended
  onClose(listener: (reason: string) => void): Disposable;
  // the transport dropped while the daemon can resume the connection: everything waits for resume, or a close
  onLost(listener: (reason: string) => void): Disposable;
  lost(): boolean;
  // since: the missed deadline the suspect state counts from (epoch ms); undefined once a frame arrived again
  onSuspect(listener: (since: number | undefined) => void): Disposable;
  suspectSince(): number | undefined;
  // hello with the reconnection token over a new transport: resumed, or refused, after which only a fresh connection helps
  resume(stream: Duplex): Promise<ResumeOutcome>;
  // destroys the transport alone, which leaves a resumable connection lost (closed otherwise)
  cutTransport(): void;
  // the devices attached to the daemon, this one marked self, by device name; empty from a daemon that does not list clients
  devices(): readonly AttachedClient[];
  onDevices(listener: () => void): Disposable;
  // ends this connection only; the daemon keeps its terminals for the next one
  close(reason: string): void;
}

/**
 * hello, welcome and control.attach over the stream (docs/invariants.md "Remote daemon and wire"). The mux, both channels and
 * their endpoints exist before hello, so no frame arrives for a channel not listened to; a violation on either endpoint closes
 * this connection only.
 */
export async function connect(options: ConnectOptions): Promise<RemoteConnection> {
  const { log } = options;
  const protocol = createPersistentProtocol({ socket: streamSocket(options.stream), maxBodyBytes: MAX_FRAME_BYTES, log });
  const close = (reason: string): void => protocol.close(reason);
  const mux = createMux({ protocol, side: 'client', acceptStreams: true, onOverflow: () => close('held frames over the bound'), onViolation: close, log });
  const controlChannel = mux.messageChannel(CHANNEL.control, CONTROL_MAX_MESSAGE_BYTES);
  const workspaceChannel = mux.messageChannel(CHANNEL.workspace, WORKSPACE_MAX_MESSAGE_BYTES);
  const coreChannel = channelTransport(mux.messageChannel(CHANNEL.core, CORE_MAX_MESSAGE_BYTES), CORE_MAX_MESSAGE_BYTES, close);
  let closedWith: string | undefined;
  const closeListeners = listeners<[string]>(log);
  let transport = options.stream;
  const lostListeners = listeners<[string]>(log);
  const suspectListeners = listeners<[number | undefined]>(log);
  const deviceListeners = listeners<[]>(log);
  // once, with why it ended; a listener added after the close runs at once
  const onClose = (listener: (reason: string) => void): Disposable => {
    if (closedWith === undefined) return closeListeners.add(listener);
    listener(closedWith);
    return { dispose: () => undefined };
  };
  let devices: readonly AttachedClient[] = [];
  let suspectSince: number | undefined;
  protocol.onLost((reason) => {
    suspectSince = undefined;
    lostListeners.fire(reason);
  });
  protocol.onSuspect((since) => {
    suspectSince = since;
    suspectListeners.fire(since);
  });
  protocol.onClose((reason) => {
    closedWith = reason;
    mux.dispose();
    closeListeners.fire(reason);
  });
  const controlTransport = channelTransport(controlChannel, CONTROL_MAX_MESSAGE_BYTES, close);
  const control = createEndpoint<ClientToControl, ControlToClient>({
    transport: controlTransport,
    outgoing: CLIENT_TO_CONTROL,
    incoming: CONTROL_TO_CLIENT,
    log,
    onViolation: (err) => close(err.message),
  });
  const workspace = createEndpoint<ClientToWorkspace, WorkspaceToClient>({
    transport: channelTransport(workspaceChannel, WORKSPACE_MAX_MESSAGE_BYTES, close),
    outgoing: CLIENT_TO_WORKSPACE,
    incoming: WORKSPACE_TO_CLIENT,
    log,
    errors: ERROR_CODEC,
    onViolation: (err) => close(err.message),
  });
  closeListeners.add((reason) => {
    control.close(reason);
    workspace.close(reason);
  });
  control.onEvent('clients', ({ clients }) => {
    devices = clients;
    deviceListeners.fire();
  });
  const protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
  const inbox = streamInbox(close);
  mux.onStream((stream) => inbox.opened(stream));
  closeListeners.add((reason) => inbox.closed(reason));
  const outcome = await (async () => {
    const answer = await sayHello(protocol, { appVersion: options.appVersion, protocolVersion, clientId: options.clientId, deviceName: options.deviceName });
    if (answer.kind === 'refused') {
      const why = `The daemon (version ${answer.refused.serverVersion}, protocol ${answer.refused.protocolVersion}) refused this app's protocol ${protocolVersion}`;
      if (answer.refused.reason !== 'protocol' || !options.onOtherProtocol) throw new Error(why);
      // the control channel now serves the frozen commands alone
      control.close('the daemon speaks another protocol');
      protocol.startKeepAlive();
      const frozen = createEndpoint<FrozenClientToControl, ControlToClient>({ transport: controlTransport, outgoing: FROZEN_CLIENT_TO_CONTROL, incoming: CONTROL_TO_CLIENT, log, onViolation: (err) => close(err.message) });
      closeListeners.add((reason) => frozen.close(reason));
      options.onOtherProtocol({
        serverVersion: answer.refused.serverVersion,
        protocolVersion: answer.refused.protocolVersion,
        control: frozen,
        receiveStream: (id, maxBytes, onChunk) => inbox.receive(id, maxBytes, onChunk),
        onClose,
        close,
      });
      throw new OtherProtocolError(why);
    }
    protocol.startKeepAlive();
    if (closedWith !== undefined) throw new Error(`The connection closed: ${closedWith}`);
    log(`[remote] welcome from daemon ${answer.welcome.serverVersion} on ${answer.welcome.facts.os}, clock skew ${Math.round(answer.skewMs)} ms`);
    await control.request('attach', { terminalIdleDays: options.terminalIdleDays, ...(answer.welcome.features.includes(CLIENTS_FEATURE) ? { watchClients: true } : {}) });
    // a drop before the attach landed fails the connect; after it, the daemon holds the connection for a resume
    if (answer.welcome.features.includes(RESUME_FEATURE)) protocol.holdOnDrop();
    return answer;
  })().catch((err: unknown) => {
    // a connection that never attached is ended, so its bridge exits and the daemon stops counting it as a client; one handed
    // to onOtherProtocol is its holder's
    if (!(err instanceof OtherProtocolError)) close(err instanceof Error ? err.message : String(err));
    throw err;
  });
  const { reconnectionToken } = outcome.welcome;
  const resume = async (stream: Duplex): Promise<ResumeOutcome> => {
    if (closedWith !== undefined) throw new Error(`The connection closed: ${closedWith}`);
    if (!protocol.lost()) throw new Error('Only a dropped connection resumes');
    const handshake = createPersistentProtocol({ socket: streamSocket(stream), maxBodyBytes: HANDSHAKE_MAX_BYTES, log });
    const answer = await sayHello(handshake, { appVersion: options.appVersion, protocolVersion, clientId: options.clientId, deviceName: options.deviceName, reconnectionToken }).catch((err: unknown) => {
      handshake.close(err instanceof Error ? err.message : String(err));
      throw err;
    });
    if (answer.kind === 'refused') {
      handshake.close(`the daemon refused the resume: ${answer.refused.reason}`);
      return 'refused';
    }
    if (!answer.resumedRest) {
      handshake.close('a welcome that did not resume');
      throw new Error('The daemon welcomed the reconnection token without resuming the connection');
    }
    // a close while hello was on its way leaves nothing to resume
    if (closedWith !== undefined) {
      stream.destroy();
      throw new Error(`The connection closed: ${closedWith}`);
    }
    transport = stream;
    protocol.resume(streamSocket(stream), answer.resumedRest);
    suspectSince = undefined;
    log(`[remote] the connection resumed, clock skew ${Math.round(answer.skewMs)} ms`);
    return 'resumed';
  };
  return {
    facts: outcome.welcome.facts,
    serverVersion: outcome.welcome.serverVersion,
    features: outcome.welcome.features,
    skewMs: outcome.skewMs,
    control,
    workspace,
    coreChannel,
    receiveStream: (id, maxBytes, onChunk) => inbox.receive(id, maxBytes, onChunk),
    onClose,
    onLost: lostListeners.add,
    lost: () => protocol.lost(),
    onSuspect: suspectListeners.add,
    suspectSince: () => suspectSince,
    resume,
    cutTransport: () => {
      if (!protocol.lost()) transport.destroy();
    },
    devices: () => devices,
    onDevices: deviceListeners.add,
    close,
  };
}

// Bytes the daemon may push on streams no receive has claimed yet; past it the connection closes.
const MAX_UNCLAIMED_STREAM_BYTES = 64 * 1024 * 1024;

type StreamEvent = { readonly chunk: Uint8Array } | { readonly end: true };

interface StreamSlot {
  stream?: StreamChannel;
  readonly chunks: Uint8Array[];
  bytes: number;
  ended: boolean;
  sink?: (event: StreamEvent) => void;
}

interface StreamInbox {
  opened(stream: StreamChannel): void;
  receive(id: number, maxBytes: number, onChunk: (bytes: Uint8Array) => Promise<void>): Promise<number>;
  closed(reason: string): void;
}

// A stream's open can arrive before the answer naming it is read, and the mux drops data no listener takes, so every stream
// the daemon opens is buffered from its open until a receive claims it by id.
function streamInbox(close: (reason: string) => void): StreamInbox {
  const slots = new Map<number, StreamSlot>();
  const failures = new Set<(reason: string) => void>();
  let closedWith: string | undefined;
  const slotOf = (id: number): StreamSlot => {
    const existing = slots.get(id);
    if (existing) return existing;
    const created: StreamSlot = { chunks: [], bytes: 0, ended: false };
    slots.set(id, created);
    return created;
  };
  const unclaimedBytes = (): number => [...slots.values()].reduce((sum, slot) => sum + (slot.sink ? 0 : slot.bytes), 0);
  const deliver = (slot: StreamSlot, event: StreamEvent): void => {
    if (slot.sink) {
      slot.sink(event);
      return;
    }
    if ('end' in event) {
      slot.ended = true;
      return;
    }
    slot.chunks.push(event.chunk);
    slot.bytes += event.chunk.length;
    if (unclaimedBytes() > MAX_UNCLAIMED_STREAM_BYTES) close('the daemon sent more stream bytes than were asked for');
  };
  return {
    opened: (stream) => {
      const slot = slotOf(stream.id);
      slot.stream = stream;
      stream.onData((chunk) => deliver(slot, { chunk }));
      stream.onEnd(() => deliver(slot, { end: true }));
    },
    receive: (id, maxBytes, onChunk) => {
      if (closedWith !== undefined) return Promise.reject(new Error(`The connection closed: ${closedWith}`));
      const slot = slotOf(id);
      if (slot.sink) return Promise.reject(new Error(`stream ${id} is already being received`));
      return new Promise<number>((resolve, reject) => {
        let total = 0;
        let writing = Promise.resolve();
        let settled = false;
        const settle = (outcome: () => void): void => {
          if (settled) return;
          settled = true;
          failures.delete(onClosed);
          slots.delete(id);
          // our direction closes too, so the stream stops counting against the open limit
          slot.stream?.end();
          outcome();
        };
        const fail = (err: unknown): void => settle(() => reject(err instanceof Error ? err : new Error(String(err))));
        const onClosed = (reason: string): void => fail(new Error(`The connection closed: ${reason}`));
        failures.add(onClosed);
        slot.sink = (event) => {
          if ('end' in event) {
            writing.then(() => settle(() => resolve(total)), fail);
            return;
          }
          total += event.chunk.length;
          if (total > maxBytes) {
            fail(new Error(`stream ${id} carried more than the ${maxBytes} bytes it was named for`));
            return;
          }
          const chunk = event.chunk;
          writing = writing.then(() => (settled ? undefined : onChunk(chunk)));
        };
        const buffered = slot.chunks.splice(0);
        slot.bytes = 0;
        for (const chunk of buffered) slot.sink({ chunk });
        if (slot.ended) slot.sink({ end: true });
      });
    },
    closed: (reason) => {
      closedWith = reason;
      for (const fail of [...failures]) fail(reason);
      slots.clear();
    },
  };
}
