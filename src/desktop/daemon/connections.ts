// Each connection: the handshake, then a mux with the control channel and, for a client of this protocol version, the
// workspace and core channels. A violation on any of them closes that connection only.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { Disposable } from '../../platform/disposable';
import { CORE_MAX_MESSAGE_BYTES } from '../core-protocol/attached-transport';
import { createEndpoint, type CoreProtocolError, type CoreTransport, type Endpoint } from '../core-protocol/endpoint';
import type { Call, Contract, Tables } from '../core-protocol/messages';
import { channelTransport } from '../../remote/channel-transport';
import { acceptConnection, HANDSHAKE_MAX_BYTES, NONCE_BYTES, type Accepted, type Hello, type HelloAnswer, type HostFacts } from '../../remote/handshake';
import { CHANNEL, createMux, MAX_FRAME_BYTES, MAX_HELD_BYTES, type Mux } from '../../remote/mux';
import { listeners } from '../../remote/listeners';
import { createPersistentProtocol, type PersistentProtocol } from '../../remote/persistent-protocol';
import { FEATURES, PROTOCOL_VERSION } from '../../remote/protocol-version';
import { END_TIMEOUT_MS, streamSocket } from '../../remote/stream-transport';
import { WORKSPACE_MAX_MESSAGE_BYTES } from '../workspace/messages';
import {
  CLIENT_TO_CONTROL,
  CONTROL_MAX_MESSAGE_BYTES,
  CONTROL_TO_CLIENT,
  FROZEN_CLIENT_TO_CONTROL,
  type ClientToControl,
  type ControlRequests,
  type ControlToClient,
  type AttachedClient,
  type CoreState,
  type FrozenClientToControl,
} from './control-messages';
import type { ClientLink } from './core-routes';
import type { CoreConnection } from './remote-core-host';
import type { WorkspaceHost } from './workspace-host';

// connections still authenticating at once; another is closed at once
export const MAX_UNAUTHENTICATED = 16;
// how long a dropped connection's state waits for its client to resume it (VS Code's ReconnectionGraceTime)
export const RECONNECTION_GRACE_MS: number = 3 * 60 * 60 * 1000;

type Params<M extends keyof ControlRequests> = ControlRequests[M] extends Call<infer P, unknown> ? P : never;
type Result<M extends keyof ControlRequests> = ControlRequests[M] extends Call<unknown, infer R> ? R : never;

// What the control channel does; streams and the core channel belong to the connection the request came on (a refused
// connection has no core channel).
export interface ControlConnection {
  readonly id: string;
  // the hello's
  readonly clientId: string;
  readonly mux: Mux;
  readonly core: CoreConnection | undefined;
  readonly close: (reason: string) => void;
  // closes once the socket wrote what it holds, so a reply sent just before reaches the client
  readonly end: (reason: string) => void;
}

export type ControlService = {
  readonly [M in keyof ControlRequests]: (params: Params<M>, connection: ControlConnection) => Result<M> | Promise<Result<M>>;
};

/** The daemon's Damocles Core as connections see it (remote-core-host.ts). */
export interface CoreHostAccess {
  epoch(): string | null;
  onState(listener: (state: CoreState) => void): Disposable;
  // clientId: the hello's
  connect(connectionId: string, clientId: string, channel: CoreTransport, close: (reason: string) => void, link: ClientLink): CoreConnection;
}

export interface ConnectionsDeps {
  readonly serverVersion: string;
  readonly facts: HostFacts;
  readonly workspace: WorkspaceHost;
  readonly core: CoreHostAccess;
  readonly control: ControlService;
  // every welcomed connection, connected or dropped inside its grace; a refused connection is not one
  readonly connectionsChanged: (connections: readonly ConnectionPresence[]) => void;
  // the forwarded agent socket the client's bridge named on its latest authenticated connection; undefined once it dropped
  readonly agentSock: (clientId: string, agentSock: string | undefined) => void;
  // RECONNECTION_GRACE_MS and MAX_HELD_BYTES unless the e2e hooks shorten them
  readonly graceMs?: number;
  readonly maxHeldBytes?: number;
  readonly log: (line: string) => void;
}

export type ConnectionPresence = 'connected' | 'inGrace';

export interface Connections {
  // token: the one the endpoint the socket reached was opened with
  accept(socket: Duplex, token: Uint8Array): void;
  // ends every connection but those named, letting each write what it has sent
  endAll(except?: ReadonlySet<string>): Promise<void>;
  destroyAll(): void;
}

interface Live {
  readonly id: string;
  readonly clientId: string;
  readonly protocol: PersistentProtocol;
  readonly token: Uint8Array;
  readonly deviceName: string;
  // set once the client's attach asked for control.clients events
  clientsEvents?: ((clients: readonly AttachedClient[]) => void) | undefined;
  // set while the connection is dropped and inside its grace
  grace?: NodeJS.Timeout | undefined;
  // tells the core channel's link the connection resumed
  readonly resumed: () => void;
}

export function createConnections(deps: ConnectionsDeps): Connections {
  const { log } = deps;
  const sockets = new Set<Duplex>();
  // each welcomed socket's connection id, which endAll may keep open
  const socketIds = new Map<Duplex, string>();
  // before their handshake: any local user can open the Windows pipe, so these are capped
  const unauthenticated = new Set<Duplex>();
  // welcomed connections by clientId, connected or inside their grace; a new connection with a known id replaces it
  const clients = new Map<string, Live>();
  let nextId = 0;
  const graceMs = deps.graceMs ?? RECONNECTION_GRACE_MS;
  // once the daemon ends its connections, a dropped one is closed instead of held
  let ending = false;

  // every connected client's device name, never its id, to each client that asked; a connection inside its grace is not attached
  const attachedFor = (live: Live): AttachedClient[] => [...clients.values()].filter((other) => !other.grace).map((other) => ({ deviceName: other.deviceName, self: other === live }));
  const publishClients = (): void => {
    for (const live of clients.values()) if (!live.grace) live.clientsEvents?.(attachedFor(live));
  };
  const presence = (): void => {
    deps.connectionsChanged([...clients.values()].map((live) => (live.grace ? 'inGrace' : 'connected')));
    publishClients();
  };

  // the connection a hello resumes: its client's, holding the same token
  const resumable = (hello: Hello): Live | undefined => {
    const live = clients.get(hello.clientId);
    const token = hello.reconnectionToken;
    return live && token && live.token.length === token.length && timingSafeEqual(live.token, token) ? live : undefined;
  };

  // The held protocol takes the new socket, each side replays what the other has not acknowledged, and the agent socket is the
  // one the new ssh session's bridge names.
  const resume = (socket: Duplex, handshake: PersistentProtocol, live: Live, agentSock: string | undefined): void => {
    const rest = handshake.detach();
    clearTimeout(live.grace);
    live.grace = undefined;
    socketIds.set(socket, live.id);
    deps.agentSock(live.clientId, agentSock);
    live.protocol.resume(streamSocket(socket), rest);
    live.resumed();
    presence();
    log(`[daemon] ${live.id} resumed`);
  };

  const answer = (hello: Hello): HelloAnswer => {
    if (hello.protocolVersion !== PROTOCOL_VERSION) return { kind: 'refused', refused: { reason: 'protocol', serverVersion: deps.serverVersion, protocolVersion: PROTOCOL_VERSION } };
    const resumed = hello.reconnectionToken ? resumable(hello) : undefined;
    // past the grace, after an overflow or a daemon restart the token names nothing, and the client attaches fresh
    if (hello.reconnectionToken && !resumed) return { kind: 'refused', refused: { reason: 'unknown-token', serverVersion: deps.serverVersion, protocolVersion: PROTOCOL_VERSION } };
    if (resumed) {
      return {
        kind: 'welcome',
        welcome: { serverVersion: deps.serverVersion, protocolVersion: PROTOCOL_VERSION, features: FEATURES, facts: deps.facts, reconnectionToken: resumed.token, resumed: true, coreEpoch: deps.core.epoch(), serverTime: Date.now() },
      };
    }
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

  const serveControl = <C extends Contract>(id: string, clientId: string, mux: Mux, tables: Tables<C>, methods: ReadonlyArray<keyof ControlRequests & keyof C['requests']>, close: (reason: string) => void, end: (reason: string) => void, core: () => CoreConnection | undefined): Endpoint<ControlToClient, C> => {
    const channel = mux.messageChannel(CHANNEL.control, CONTROL_MAX_MESSAGE_BYTES);
    const endpoint = createEndpoint<ControlToClient, C>({
      transport: channelTransport(channel, CONTROL_MAX_MESSAGE_BYTES, close),
      outgoing: CONTROL_TO_CLIENT,
      incoming: tables,
      log,
      onViolation: (error: CoreProtocolError) => close(error.message),
    });
    for (const method of methods) {
      const handler = deps.control[method] as (params: unknown, connection: ControlConnection) => unknown;
      (endpoint.serve as (name: string, serve: (params: unknown) => unknown) => void)(method, (params) => handler(params, { id, clientId, mux, core: core(), close, end }));
    }
    return endpoint;
  };

  const connected = (socket: Duplex, protocol: PersistentProtocol, accepted: Accepted): void => {
    if (accepted.answer.kind === 'refused' && accepted.answer.refused.reason === 'unknown-token') {
      // ended, not destroyed, so the refusal reaches the client first
      socket.end();
      return;
    }
    const held = accepted.answer.kind === 'welcome' && accepted.answer.welcome.resumed ? resumable(accepted.hello) : undefined;
    if (held) {
      resume(socket, protocol, held, accepted.agentSock);
      return;
    }
    const id = `connection-${++nextId}`;
    socketIds.set(socket, id);
    const close = (reason: string): void => protocol.close(reason);
    const end = (reason: string): void => protocol.end(reason);
    protocol.setMaxBodyBytes(MAX_FRAME_BYTES);
    // an overflow drops the connection's state, so its token names nothing and the client attaches fresh
    const mux = createMux({ protocol, side: 'daemon', acceptStreams: false, maxHeldBytes: deps.maxHeldBytes ?? MAX_HELD_BYTES, onOverflow: () => close('held frames passed the per-connection bound'), onViolation: close, log });
    const disposables: Array<{ dispose(): void }> = [{ dispose: () => mux.dispose() }];
    if (accepted.answer.kind === 'refused') {
      const endpoint = serveControl<FrozenClientToControl>(id, accepted.hello.clientId, mux, FROZEN_CLIENT_TO_CONTROL, ['listRuns', 'shutdownWhenIdle', 'shutdownNow', 'mirror.sync'], close, end, () => undefined);
      disposables.push({ dispose: () => endpoint.close('the connection closed') });
      log(`[daemon] ${id} speaks protocol ${accepted.hello.protocolVersion}, not ${PROTOCOL_VERSION}: serving the frozen control commands only`);
    } else {
      const coreChannel = mux.messageChannel(CHANNEL.core, CORE_MAX_MESSAGE_BYTES);
      const lostChanged = listeners<[]>(log);
      const core = deps.core.connect(id, accepted.hello.clientId, channelTransport(coreChannel, CORE_MAX_MESSAGE_BYTES, close), close, {
        drained: () => coreChannel.drained(),
        lost: () => protocol.lost(),
        onLostChange: lostChanged.add,
      });
      // attach is served below, where it also learns whether the client watches the attached devices
      const methods = (Object.keys(CLIENT_TO_CONTROL.requests) as Array<keyof ControlRequests>).filter((method) => method !== 'attach');
      const endpoint = serveControl<ClientToControl>(id, accepted.hello.clientId, mux, CLIENT_TO_CONTROL, methods, close, end, () => core);
      disposables.push(core, { dispose: () => endpoint.close('the connection closed') }, deps.core.onState((state) => endpoint.emit('coreState', state)));
      const workspace = mux.messageChannel(CHANNEL.workspace, WORKSPACE_MAX_MESSAGE_BYTES);
      disposables.push(deps.workspace.serve(id, accepted.hello.clientId, channelTransport(workspace, WORKSPACE_MAX_MESSAGE_BYTES, close), close));
      const { clientId, deviceName } = accepted.hello;
      const previous = clients.get(clientId);
      const live: Live = { id, clientId, protocol, token: accepted.answer.welcome.reconnectionToken, deviceName, resumed: () => lostChanged.fire() };
      endpoint.serve('attach', async (params) => {
        await deps.control.attach(params, { id, clientId, mux, core, close, end });
        if (params.watchClients !== true || live.clientsEvents) return;
        live.clientsEvents = (list) => endpoint.emit('clients', { clients: list });
        live.clientsEvents(attachedFor(live));
      });
      clients.set(clientId, live);
      previous?.protocol.close(`client ${clientId} attached again on ${id}`);
      deps.agentSock(clientId, accepted.agentSock);
      disposables.push({
        dispose: () => {
          clearTimeout(live.grace);
          if (clients.get(clientId) !== live) return;
          clients.delete(clientId);
          deps.agentSock(clientId, undefined);
        },
      });
      protocol.holdOnDrop();
      protocol.onLost((reason) => {
        if (ending) {
          protocol.close(`the daemon is shutting down (${reason})`);
          return;
        }
        // the agent socket died with the ssh session
        deps.agentSock(clientId, undefined);
        live.grace = setTimeout(() => {
          log(`[daemon] ${id}: the grace ended`);
          protocol.close('the reconnection grace ended');
        }, graceMs);
        lostChanged.fire();
        presence();
        log(`[daemon] ${id} lost (${reason}); held for ${graceMs} ms`);
      });
      presence();
      log(`[daemon] ${id}: client ${clientId} (${accepted.hello.deviceName}, app ${accepted.hello.appVersion}) attached`);
    }
    protocol.onClose((reason) => {
      for (const disposable of disposables.reverse()) disposable.dispose();
      presence();
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
        socketIds.delete(socket);
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
    endAll: async (except) => {
      ending = true;
      // a connection inside its grace has no socket left to end
      for (const live of [...clients.values()]) if (live.grace && !except?.has(live.id)) live.protocol.close('the daemon is shutting down');
      await Promise.all([...sockets].filter((socket) => !except?.has(socketIds.get(socket) ?? '')).map((socket) => new Promise<void>((resolve) => {
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
      ending = true;
      for (const socket of sockets) socket.destroy();
      for (const live of [...clients.values()]) live.protocol.close('the daemon stopped');
    },
  };
}
