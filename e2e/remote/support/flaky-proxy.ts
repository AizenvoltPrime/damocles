import * as net from 'node:net';
import * as path from 'node:path';

// The fault-injection relay between ssh and a fixture's sshd. The test's ssh config names it as the host's ProxyCommand
// (proxy-connect.cjs, which copies ssh's stdio to this relay), so every ssh the app starts for that host, reconnects included,
// goes through it, and the spec decides what the network does:
// - cut: every live connection is reset (RST) at once; new connections pass.
// - refuse: every live connection is reset and every new one too, until restore, as a host that is unreachable.
// - blackhole: connections stay open, live and new, and no byte either way gets through, with no reset, as a silent Wi-Fi
//   loss; the bytes are held as TCP retransmits them, and restore delivers them in order on the same connections.
// - delay: every chunk either way is forwarded that many ms late, in order.

const CONNECTOR = path.join(__dirname, 'proxy-connect.cjs');
// ssh's config parser reads a backslash as an escape
const configPath = (file: string): string => file.split(path.sep).join('/');

export interface FlakyProxy {
  /** The ProxyCommand line value for the host's block in the test's ssh config. */
  readonly proxyCommand: string;
  /** Connections the relay accepted, each one ssh process. */
  accepted(): number;
  /** Connections open now. */
  open(): number;
  cut(): void;
  refuse(): void;
  blackhole(): void;
  /** Every chunk from now on is forwarded ms late, both ways; 0 forwards at once. */
  delay(ms: number): void;
  /** Normal forwarding; the bytes a blackhole held go on first, in order, on their own connections. */
  restore(): void;
  /** Resets every connection and stops listening; resolves once nothing of the relay is left. */
  close(): Promise<void>;
}

interface Relayed {
  readonly client: net.Socket;
  readonly upstream: net.Socket;
  // what a blackhole holds, in arrival order, with the socket each chunk goes to; null is the sender's end
  readonly held: Array<{ readonly to: net.Socket; readonly chunk: Buffer | null }>;
}

/** Starts a relay on 127.0.0.1 to the sshd on 127.0.0.1:`targetPort`. */
export async function startFlakyProxy(targetPort: number): Promise<FlakyProxy> {
  let mode: 'pass' | 'refuse' | 'blackhole' = 'pass';
  let delayMs = 0;
  let accepted = 0;
  const live = new Set<Relayed>();

  const reset = (relayed: Relayed): void => {
    relayed.client.resetAndDestroy();
    relayed.upstream.resetAndDestroy();
    live.delete(relayed);
  };
  const send = (to: net.Socket, chunk: Buffer): void => {
    if (delayMs === 0) to.write(chunk);
    else setTimeout(() => !to.destroyed && to.write(chunk), delayMs);
  };
  const endAfterDelay = (to: net.Socket): void => {
    if (delayMs === 0) to.end();
    else setTimeout(() => !to.destroyed && to.end(), delayMs);
  };
  // a chunk goes on unless the network is blackholed; a delayed one finds its socket gone when the relay was cut meanwhile
  const forward = (relayed: Relayed, to: net.Socket, chunk: Buffer | null): void => {
    if (mode === 'blackhole') relayed.held.push({ to, chunk });
    else if (chunk === null) endAfterDelay(to);
    else send(to, chunk);
  };

  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    accepted++;
    if (mode === 'refuse') {
      client.resetAndDestroy();
      return;
    }
    const upstream = net.connect({ host: '127.0.0.1', port: targetPort, allowHalfOpen: true });
    const relayed: Relayed = { client, upstream, held: [] };
    live.add(relayed);
    client.on('data', (chunk: Buffer) => forward(relayed, upstream, chunk));
    upstream.on('data', (chunk: Buffer) => forward(relayed, client, chunk));
    client.on('end', () => forward(relayed, upstream, null));
    upstream.on('end', () => forward(relayed, client, null));
    // one side gone takes the other with it; a reset is what the spec asked for, never an error of the test
    for (const [socket, other] of [[client, upstream], [upstream, client]] as const) {
      socket.on('error', () => other.resetAndDestroy());
      socket.on('close', () => {
        other.destroy();
        live.delete(relayed);
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;

  return {
    proxyCommand: `"${configPath(process.execPath)}" "${configPath(CONNECTOR)}" ${port}`,
    accepted: () => accepted,
    open: () => live.size,
    cut: () => {
      for (const relayed of [...live]) reset(relayed);
    },
    refuse: () => {
      mode = 'refuse';
      for (const relayed of [...live]) reset(relayed);
    },
    blackhole: () => {
      mode = 'blackhole';
    },
    delay: (ms) => {
      delayMs = ms;
    },
    restore: () => {
      mode = 'pass';
      delayMs = 0;
      for (const relayed of live) {
        for (const { to, chunk } of relayed.held.splice(0)) {
          if (to.destroyed) continue;
          if (chunk === null) to.end();
          else to.write(chunk);
        }
      }
    },
    close: async () => {
      mode = 'refuse';
      for (const relayed of [...live]) reset(relayed);
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
