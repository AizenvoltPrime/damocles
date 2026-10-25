import type { Duplex } from 'node:stream';
import type { Disposable } from '../../../platform/disposable';
import { channelTransport } from '../../../remote/channel-transport';
import { sayHello, type HostFacts } from '../../../remote/handshake';
import { CHANNEL, createMux, MAX_FRAME_BYTES } from '../../../remote/mux';
import { createPersistentProtocol } from '../../../remote/persistent-protocol';
import { PROTOCOL_VERSION } from '../../../remote/protocol-version';
import { streamSocket } from '../../../remote/stream-transport';
import { CORE_MAX_MESSAGE_BYTES } from '../../core-protocol/attached-transport';
import { createEndpoint, type CoreTransport, type Endpoint } from '../../core-protocol/endpoint';
import { ERROR_CODEC } from '../../core-protocol/errors';
import { CLIENT_TO_CONTROL, CONTROL_MAX_MESSAGE_BYTES, CONTROL_TO_CLIENT, type ClientToControl, type ControlToClient } from '../../daemon/control-messages';
import { CLIENT_TO_WORKSPACE, WORKSPACE_MAX_MESSAGE_BYTES, WORKSPACE_TO_CLIENT, type ClientToWorkspace, type WorkspaceToClient } from '../../workspace/messages';

export interface ConnectOptions {
  // the transport's byte stream, already past the bridge's authentication
  readonly stream: Duplex;
  readonly appVersion: string;
  readonly clientId: string;
  readonly deviceName: string;
  // damocles.desktop.remote.terminalIdleDays, sent in control.attach
  readonly terminalIdleDays: number;
  readonly log: (line: string) => void;
}

/** One authority's connection after its welcome: the daemon's facts and the endpoints over its control and workspace channels. */
export interface RemoteConnection {
  readonly facts: HostFacts;
  // serverTime minus the midpoint of hello and welcome on this computer's clock
  readonly skewMs: number;
  readonly control: Endpoint<ClientToControl, ControlToClient>;
  readonly workspace: Endpoint<ClientToWorkspace, WorkspaceToClient>;
  // the `core` channel, whose messages each attach generation tags (attachedTransport)
  readonly coreChannel: CoreTransport;
  // once, with why the connection ended
  onClose(listener: (reason: string) => void): Disposable;
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
  const closeListeners = new Set<(reason: string) => void>();
  protocol.onClose((reason) => {
    closedWith = reason;
    mux.dispose();
    for (const listener of [...closeListeners]) listener(reason);
  });
  const control = createEndpoint<ClientToControl, ControlToClient>({
    transport: channelTransport(controlChannel, CONTROL_MAX_MESSAGE_BYTES, close),
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
  const outcome = await (async () => {
    const answer = await sayHello(protocol, { appVersion: options.appVersion, protocolVersion: PROTOCOL_VERSION, clientId: options.clientId, deviceName: options.deviceName });
    if (answer.kind === 'refused') {
      throw new Error(`The daemon (version ${answer.refused.serverVersion}, protocol ${answer.refused.protocolVersion}) refused this app's protocol ${PROTOCOL_VERSION}`);
    }
    protocol.startKeepAlive();
    if (closedWith !== undefined) throw new Error(`The connection closed: ${closedWith}`);
    log(`[remote] welcome from daemon ${answer.welcome.serverVersion} on ${answer.welcome.facts.os}, clock skew ${Math.round(answer.skewMs)} ms`);
    await control.request('attach', { terminalIdleDays: options.terminalIdleDays });
    return answer;
  })().catch((err: unknown) => {
    // a connection that never attached is ended, so its bridge exits and the daemon stops counting it as a client
    close(err instanceof Error ? err.message : String(err));
    throw err;
  });
  return {
    facts: outcome.welcome.facts,
    skewMs: outcome.skewMs,
    control,
    workspace,
    coreChannel,
    onClose: (listener) => {
      if (closedWith !== undefined) {
        listener(closedWith);
        return { dispose: () => undefined };
      }
      closeListeners.add(listener);
      return { dispose: () => { closeListeners.delete(listener); } };
    },
    close,
  };
}
