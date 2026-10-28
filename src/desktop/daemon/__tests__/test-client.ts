// The app's side of a daemon connection, as handshake.ts defines it, for the daemon's own tests.
import type { Duplex } from 'node:stream';
import { channelTransport } from '../../../remote/channel-transport';
import { HANDSHAKE_MAX_BYTES, sayHello, type HelloOutcome } from '../../../remote/handshake';
import { CHANNEL, createMux, MAX_FRAME_BYTES, type Mux } from '../../../remote/mux';
import { createPersistentProtocol, type PersistentProtocol } from '../../../remote/persistent-protocol';
import { PROTOCOL_VERSION } from '../../../remote/protocol-version';
import { streamSocket } from '../../../remote/stream-transport';
import { createEndpoint, type Endpoint } from '../../core-protocol/endpoint';
import { ERROR_CODEC } from '../../core-protocol/errors';
import { CLIENT_TO_WORKSPACE, WORKSPACE_MAX_MESSAGE_BYTES, WORKSPACE_TO_CLIENT, type ClientToWorkspace, type WorkspaceToClient } from '../../workspace/messages';
import { CLIENT_TO_CONTROL, CONTROL_MAX_MESSAGE_BYTES, CONTROL_TO_CLIENT, FROZEN_CLIENT_TO_CONTROL, type ClientToControl, type ControlToClient, type FrozenClientToControl } from '../control-messages';

export interface TestClient {
  readonly protocol: PersistentProtocol;
  readonly mux: Mux;
  readonly outcome: HelloOutcome;
  // one control endpoint per channel: the full one after welcome, the frozen one after refused { reason: 'protocol' }
  readonly control: Endpoint<ClientToControl, ControlToClient>;
  readonly frozen: Endpoint<FrozenClientToControl, ControlToClient>;
  readonly workspace: Endpoint<ClientToWorkspace, WorkspaceToClient>;
  readonly closed: Promise<string>;
}

export async function connectClient(socket: Duplex, hello: { clientId?: string; deviceName?: string; protocolVersion?: number; reconnectionToken?: Uint8Array } = {}): Promise<TestClient> {
  const log = (): void => undefined;
  const protocol = createPersistentProtocol({ socket: streamSocket(socket), maxBodyBytes: MAX_FRAME_BYTES, log });
  const closed = new Promise<string>((resolve) => protocol.onClose(resolve));
  const close = (reason: string): void => protocol.close(reason);
  const mux = createMux({ protocol, side: 'client', acceptStreams: true, onOverflow: () => close('overflow'), onViolation: close, log });
  const controlChannel = mux.messageChannel(CHANNEL.control, CONTROL_MAX_MESSAGE_BYTES);
  const workspaceChannel = mux.messageChannel(CHANNEL.workspace, WORKSPACE_MAX_MESSAGE_BYTES);
  const outcome = await sayHello(protocol, {
    appVersion: '0.0.0-test',
    protocolVersion: hello.protocolVersion ?? PROTOCOL_VERSION,
    clientId: hello.clientId ?? 'test-client',
    deviceName: hello.deviceName ?? 'test device',
    ...(hello.reconnectionToken ? { reconnectionToken: hello.reconnectionToken } : {}),
  });
  const controlTransport = channelTransport(controlChannel, CONTROL_MAX_MESSAGE_BYTES, close);
  const client: TestClient = {
    protocol,
    mux,
    outcome,
    closed,
    ...(outcome.kind === 'welcome'
      ? { control: createEndpoint({ transport: controlTransport, outgoing: CLIENT_TO_CONTROL, incoming: CONTROL_TO_CLIENT, log, onViolation: (error) => close(error.message) }), frozen: undefined as never }
      : { frozen: createEndpoint({ transport: controlTransport, outgoing: FROZEN_CLIENT_TO_CONTROL, incoming: CONTROL_TO_CLIENT, log, onViolation: (error) => close(error.message) }), control: undefined as never }),
    workspace: createEndpoint({
      transport: channelTransport(workspaceChannel, WORKSPACE_MAX_MESSAGE_BYTES, close),
      outgoing: CLIENT_TO_WORKSPACE,
      incoming: WORKSPACE_TO_CLIENT,
      log,
      errors: ERROR_CODEC,
      onViolation: (error) => close(error.message),
    }),
  };
  protocol.onClose((reason) => {
    client.control?.close(reason);
    client.frozen?.close(reason);
    client.workspace.close(reason);
  });
  return client;
}

/** A new socket for a client whose connection dropped: hello with its token, and on a resumed welcome its held protocol takes the socket. */
export async function resumeClient(client: TestClient, socket: Duplex, clientId: string): Promise<HelloOutcome> {
  if (client.outcome.kind !== 'welcome') throw new Error('only a welcomed client resumes');
  const handshake = createPersistentProtocol({ socket: streamSocket(socket), maxBodyBytes: HANDSHAKE_MAX_BYTES, log: () => undefined });
  const outcome = await sayHello(handshake, { appVersion: '0.0.0-test', protocolVersion: PROTOCOL_VERSION, clientId, deviceName: 'test device', reconnectionToken: client.outcome.welcome.reconnectionToken });
  if (outcome.kind === 'welcome' && outcome.resumedRest) client.protocol.resume(streamSocket(socket), outcome.resumedRest);
  return outcome;
}
