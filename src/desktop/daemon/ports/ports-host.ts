// The daemon's side of the `ports` channel on each welcomed connection: every candidate and URL the detector reports, and one
// net.connect per tunnel stream the client opens and names in `connect`, which it claims from the connection.
import * as net from 'node:net';
import type { Disposable } from '../../../platform/disposable';
import type { StreamChannel } from '../../../remote/mux';
import { pipeTunnel } from '../../../remote/tunnel-pipe';
import { createEndpoint, type CoreProtocolError, type CoreTransport } from '../../core-protocol/endpoint';
import type { PortDetector } from './port-detector';
import { CLIENT_TO_PORTS, PORTS_TO_CLIENT, type ClientToPorts, type ConnectAnswer, type PortsToClient } from './ports-messages';

export interface PortsHost {
  // claim: a stream the client opened on this connection, taken once (ControlConnection.claimStream); onLost: the connection
  // dropped and waits inside its grace
  serve(connectionId: string, transport: CoreTransport, claim: (id: number) => StreamChannel | undefined, close: (reason: string) => void, onLost: (listener: () => void) => Disposable): Disposable;
}

export interface PortsHostDeps {
  readonly detector: PortDetector;
  readonly log: (line: string) => void;
  readonly connect?: (host: string, port: number) => net.Socket;
}

// how the daemon's connect failed, as the client shows it
export function connectError(err: unknown): ConnectAnswer {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ECONNREFUSED') return { ok: false, error: 'refused' };
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ETIMEDOUT' || code === 'EADDRNOTAVAIL') return { ok: false, error: 'unreachable' };
  return { ok: false, error: 'failed' };
}

export function createPortsHost(deps: PortsHostDeps): PortsHost {
  const connectTo = deps.connect ?? ((host: string, port: number) => net.connect({ host, port, allowHalfOpen: true }));
  return {
    serve: (connectionId, transport, claim, close, onLost) => {
      const endpoint = createEndpoint<PortsToClient, ClientToPorts>({
        transport,
        outgoing: PORTS_TO_CLIENT,
        incoming: CLIENT_TO_PORTS,
        log: deps.log,
        onViolation: (error: CoreProtocolError) => close(error.message),
      });
      const pipes = new Set<{ close(): void }>();
      // connects in flight, which a close fails at once
      const connecting = new Set<net.Socket>();
      let watching = false;
      const resetPipes = (): void => {
        for (const pipe of [...pipes]) pipe.close();
      };
      // a tunnel's socket holds no resumable state, and a browser stalled for the grace is worse off than reset
      const subscriptions: Disposable[] = [onLost(resetPipes)];
      // a client that never watches is one that does not read this channel
      endpoint.serve('watch', () => {
        if (watching) return;
        watching = true;
        subscriptions.push(deps.detector.onList((candidates) => endpoint.emit('list', { candidates })), deps.detector.onUrl((seen) => endpoint.emit('urlSeen', seen)));
        const current = deps.detector.current();
        if (current) endpoint.emit('list', { candidates: current });
      });
      endpoint.serve('connect', ({ stream: id, host, port }) => {
        const stream = claim(id);
        if (!stream) throw new Error(`Stream ${id} is not open on ${connectionId}`);
        return new Promise<ConnectAnswer>((resolve) => {
          const attempt = (address: string): void => {
            const socket = connectTo(address, port);
            connecting.add(socket);
            const failed = (err: NodeJS.ErrnoException): void => {
              connecting.delete(socket);
              // a dual-stack '::' listener on a target whose loopback has no ::1 (IPv6 off) still takes IPv4 loopback
              if (address === '::1' && (err.code === 'EADDRNOTAVAIL' || err.code === 'ENETUNREACH')) {
                attempt('127.0.0.1');
                return;
              }
              deps.log(`[ports] ${connectionId}: connecting ${address}:${port} failed: ${err.message}`);
              stream.end();
              resolve(connectError(err));
            };
            socket.once('error', failed);
            socket.once('connect', () => {
              connecting.delete(socket);
              socket.off('error', failed);
              const pipe = pipeTunnel(socket, stream, () => pipes.delete(pipe));
              pipes.add(pipe);
              resolve({ ok: true });
            });
          };
          attempt(host);
        });
      });
      return {
        dispose: () => {
          for (const subscription of subscriptions) subscription.dispose();
          for (const socket of [...connecting]) socket.destroy(new Error('the connection closed'));
          resetPipes();
          endpoint.close('the connection closed');
        },
      };
    },
  };
}
