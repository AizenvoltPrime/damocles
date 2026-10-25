// Each connection: the handshake, then a mux with the control channel and, for a client of this protocol version, the
// workspace and core channels. A violation on any of them closes that connection only.
import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { Disposable } from '../../platform/disposable';
import { CORE_MAX_MESSAGE_BYTES } from '../core-protocol/attached-transport';
import { createEndpoint, type CoreProtocolError, type CoreTransport, type Endpoint } from '../core-protocol/endpoint';
import type { Call, Contract, Tables } from '../core-protocol/messages';
import { channelTransport } from '../../remote/channel-transport';
import { acceptConnection, HANDSHAKE_MAX_BYTES, NONCE_BYTES, type Accepted, type Hello, type HelloAnswer, type HostFacts } from '../../remote/handshake';
import { CHANNEL, createMux, MAX_FRAME_BYTES, type Mux } from '../../remote/mux';
import { createPersistentProtocol, type PersistentProtocol } from '../../remote/persistent-protocol';
import { FEATURES, PROTOCOL_VERSION } from '../../remote/protocol-version';
import { streamSocket } from '../../remote/stream-transport';
import { WORKSPACE_MAX_MESSAGE_BYTES } from '../workspace/messages';
import {
  CLIENT_TO_CONTROL,
  CONTROL_MAX_MESSAGE_BYTES,
  CONTROL_TO_CLIENT,
  FROZEN_CLIENT_TO_CONTROL,
  type ClientToControl,
  type ControlRequests,
  type ControlToClient,
  type CoreState,
  type FrozenClientToControl,
} from './control-messages';
import type { CoreConnection } from './remote-core-host';
import type { WorkspaceHost } from './workspace-host';

// how long an ended connection waits for its peer to end too
const END_TIMEOUT_MS = 2000;
// connections still authenticating at once; another is closed at once
export const MAX_UNAUTHENTICATED = 16;

type Params<M extends keyof ControlRequests> = ControlRequests[M] extends Call<infer P, unknown> ? P : never;
type Result<M extends keyof ControlRequests> = ControlRequests[M] extends Call<unknown, infer R> ? R : never;

// What the control channel does; streams and the core channel belong to the connection the request came on (a refused
// connection has no core channel).
export type ControlService = {
  readonly [M in keyof ControlRequests]: (params: Params<M>, connection: { readonly mux: Mux; readonly core: CoreConnection | undefined }) => Result<M> | Promise<Result<M>>;
};

/** The daemon's Damocles Core as connections see it (remote-core-host.ts). */
export interface CoreHostAccess {
  epoch(): string | null;
  onState(listener: (state: CoreState) => void): Disposable;
  connect(connectionId: string, channel: CoreTransport, close: (reason: string) => void): CoreConnection;
}

export interface ConnectionsDeps {
  readonly serverVersion: string;
  readonly facts: HostFacts;
  readonly workspace: WorkspaceHost;
  readonly core: CoreHostAccess;
  readonly control: ControlService;
  // live clients past welcome; a refused connection is not one
  readonly clientsChanged: (count: number) => void;
  readonly log: (line: string) => void;
}

export interface Connections {
  // token: the one the endpoint the socket reached was opened with
  accept(socket: Duplex, token: Uint8Array): void;
  // ends every connection, letting each write what it has sent
  endAll(): Promise<void>;
  destroyAll(): void;
}

interface Live {
  readonly id: string;
  readonly protocol: PersistentProtocol;
  readonly socket: Duplex;
}

export function createConnections(deps: ConnectionsDeps): Connections {
  const { log } = deps;
  const sockets = new Set<Duplex>();
  // before their handshake: any local user can open the Windows pipe, so these are capped
  const unauthenticated = new Set<Duplex>();
  // welcomed connections by clientId; a new connection with a live one's id replaces it
  const clients = new Map<string, Live>();
  let nextId = 0;

  const answer = (hello: Hello): HelloAnswer => {
    if (hello.protocolVersion !== PROTOCOL_VERSION) return { kind: 'refused', refused: { reason: 'protocol', serverVersion: deps.serverVersion, protocolVersion: PROTOCOL_VERSION } };
    // the daemon resumes no connection, so every reconnection token is unknown
    if (hello.reconnectionToken) return { kind: 'refused', refused: { reason: 'unknown-token', serverVersion: deps.serverVersion, protocolVersion: PROTOCOL_VERSION } };
    return {
      kind: 'welcome',
      welcome: {
        serverVersion: deps.serverVersion,
        protocolVersion: PROTOCOL_VERSION,
        features: FEATURES,
        facts: deps.facts,
        reconnectionToken: randomBytes(NONCE_BYTES),
        resumed: false,
        coreEpoch: deps.core.epoch(),
        serverTime: Date.now(),
      },
    };
  };

  const serveControl = <C extends Contract>(mux: Mux, tables: Tables<C>, methods: ReadonlyArray<keyof ControlRequests & keyof C['requests']>, close: (reason: string) => void, core: () => CoreConnection | undefined): Endpoint<ControlToClient, C> => {
    const channel = mux.messageChannel(CHANNEL.control, CONTROL_MAX_MESSAGE_BYTES);
    const endpoint = createEndpoint<ControlToClient, C>({
      transport: channelTransport(channel, CONTROL_MAX_MESSAGE_BYTES, close),
      outgoing: CONTROL_TO_CLIENT,
      incoming: tables,
      log,
      onViolation: (error: CoreProtocolError) => close(error.message),
    });
    for (const method of methods) {
      const handler = deps.control[method] as (params: unknown, connection: { readonly mux: Mux; readonly core: CoreConnection | undefined }) => unknown;
      (endpoint.serve as (name: string, serve: (params: unknown) => unknown) => void)(method, (params) => handler(params, { mux, core: core() }));
    }
    return endpoint;
  };

  const connected = (socket: Duplex, protocol: PersistentProtocol, accepted: Accepted): void => {
    const id = `connection-${++nextId}`;
    const close = (reason: string): void => protocol.close(reason);
    if (accepted.answer.kind === 'refused' && accepted.answer.refused.reason === 'unknown-token') {
      // ended, not destroyed, so the refusal reaches the client first
      socket.end();
      return;
    }
    protocol.setMaxBodyBytes(MAX_FRAME_BYTES);
    const mux = createMux({ protocol, side: 'daemon', acceptStreams: false, onOverflow: () => close('held frames passed the per-connection bound'), onViolation: close, log });
    const disposables: Array<{ dispose(): void }> = [{ dispose: () => mux.dispose() }];
    if (accepted.answer.kind === 'refused') {
      const endpoint = serveControl<FrozenClientToControl>(mux, FROZEN_CLIENT_TO_CONTROL, ['listRuns', 'shutdownWhenIdle', 'shutdownNow', 'mirror.sync'], close, () => undefined);
      disposables.push({ dispose: () => endpoint.close('the connection closed') });
      log(`[daemon] ${id} speaks protocol ${accepted.hello.protocolVersion}, not ${PROTOCOL_VERSION}: serving the frozen control commands only`);
    } else {
      const coreChannel = mux.messageChannel(CHANNEL.core, CORE_MAX_MESSAGE_BYTES);
      const core = deps.core.connect(id, channelTransport(coreChannel, CORE_MAX_MESSAGE_BYTES, close), close);
      const endpoint = serveControl<ClientToControl>(mux, CLIENT_TO_CONTROL, Object.keys(CLIENT_TO_CONTROL.requests) as Array<keyof ControlRequests>, close, () => core);
      disposables.push(core, { dispose: () => endpoint.close('the connection closed') }, deps.core.onState((state) => endpoint.emit('coreState', state)));
      const workspace = mux.messageChannel(CHANNEL.workspace, WORKSPACE_MAX_MESSAGE_BYTES);
      disposables.push(deps.workspace.serve(id, channelTransport(workspace, WORKSPACE_MAX_MESSAGE_BYTES, close), close));
      const { clientId } = accepted.hello;
      const previous = clients.get(clientId);
      clients.set(clientId, { id, protocol, socket });
      previous?.protocol.close(`client ${clientId} attached again on ${id}`);
      disposables.push({
        dispose: () => {
          if (clients.get(clientId)?.id !== id) return;
          clients.delete(clientId);
        },
      });
      deps.clientsChanged(clients.size);
      log(`[daemon] ${id}: client ${clientId} (${accepted.hello.deviceName}, app ${accepted.hello.appVersion}) attached`);
    }
    protocol.onClose((reason) => {
      for (const disposable of disposables.reverse()) disposable.dispose();
      deps.clientsChanged(clients.size);
      log(`[daemon] ${id} closed: ${reason}`);
    });
    protocol.startKeepAlive();
  };

  return {
    accept: (socket, token) => {
      if (unauthenticated.size >= MAX_UNAUTHENTICATED) {
        log(`[daemon] refused a connection: ${MAX_UNAUTHENTICATED} connections are already authenticating`);
        socket.destroy();
        return;
      }
      sockets.add(socket);
      unauthenticated.add(socket);
      socket.once('close', () => {
        sockets.delete(socket);
        unauthenticated.delete(socket);
      });
      const protocol = createPersistentProtocol({ socket: streamSocket(socket), maxBodyBytes: HANDSHAKE_MAX_BYTES, log });
      acceptConnection({
        protocol,
        token,
        answer,
        accepted: (accepted) => {
          unauthenticated.delete(socket);
          connected(socket, protocol, accepted);
        },
        // runs from a timer too, so it only logs
        failed: (reason) => log(`[daemon] refused a connection: ${reason}`),
      });
    },
    endAll: async () => {
      await Promise.all([...sockets].map((socket) => new Promise<void>((resolve) => {
        // a peer that never ends its side is cut off
        const timer = setTimeout(() => socket.destroy(), END_TIMEOUT_MS);
        socket.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.end();
      })));
    },
    destroyAll: () => {
      for (const socket of sockets) socket.destroy();
    },
  };
}
