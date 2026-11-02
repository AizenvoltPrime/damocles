// The loopback probe of a daemon in WSL (docs/invariants.md "Ports and the remote browser"): a listener on a random loopback
// port that writes a random nonce to every connection. The client connects to its own 127.0.0.1 on the same port, and the
// nonce coming back means WSL forwards loopback ports to Windows.
import { randomBytes } from 'node:crypto';
import * as net from 'node:net';
import type { PortCandidate } from './ports/ports-messages';

export const PROBE_NONCE_BYTES = 16;

export interface PortProbe {
  // the listener's port and nonce once it listens
  readonly answer: Promise<{ readonly port: number; readonly nonce: string }>;
  // the listener's port, undefined until it listens
  port(): number | undefined;
  close(): Promise<void>;
}

/** The user's listening sockets without the probe's own listener, which is this process's on the probe's port. */
export function withoutProbe(candidates: readonly PortCandidate[], probePort: number | undefined, pid: number): PortCandidate[] {
  return probePort === undefined ? [...candidates] : candidates.filter((candidate) => !(candidate.port === probePort && candidate.pid === pid));
}

/** Opens the probe listener on 127.0.0.1 at a port the OS picks, with a nonce drawn for this daemon's life. */
export function openPortProbe(log: (line: string) => void): PortProbe {
  const nonce = randomBytes(PROBE_NONCE_BYTES).toString('hex');
  let port: number | undefined;
  const server = net.createServer((socket) => {
    socket.on('error', (err) => log(`[port-probe] a probe connection failed: ${err.message}`));
    socket.end(`${nonce}\n`);
  });
  const answer = new Promise<{ readonly port: number; readonly nonce: string }>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      server.off('error', reject);
      server.on('error', (err) => log(`[port-probe] the listener failed: ${err.message}`));
      port = (server.address() as net.AddressInfo).port;
      resolve({ port, nonce });
    });
  });
  answer.catch((err: unknown) => log(`[port-probe] could not listen: ${err instanceof Error ? err.message : String(err)}`));
  // the probe never keeps the daemon alive on its own
  server.unref();
  return {
    answer,
    port: () => port,
    close: () => new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    }),
  };
}
