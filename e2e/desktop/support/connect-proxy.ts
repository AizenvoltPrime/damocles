import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';

export interface ConnectProxy {
  readonly url: string;
  /** Every CONNECT authority requested, allowed or not, in arrival order. */
  readonly connects: string[];
  close(): Promise<void>;
}

/**
 * An HTTP CONNECT proxy that tunnels only to the host names it maps to loopback ports and refuses
 * everything else, so a test can prove traffic went through it and nothing leaves the machine.
 */
export async function startConnectProxy(routes: Record<string, number>): Promise<ConnectProxy> {
  const connects: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end('CONNECT only');
  });
  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    const authority = req.url ?? '';
    connects.push(authority);
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    const port = routes[authority];
    if (port === undefined) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect(port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    connects,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
