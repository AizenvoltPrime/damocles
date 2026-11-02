import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_OAUTH_CALLBACK_PORT } from '../../../../../core/pi-session/mcp/oauth-callback-port';
import { candidatePorts, refusalOf, reservedClientPorts } from '../reserved-ports';
import { accepts, PortRefusedError, TunnelManager } from '../tunnels';

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as net.AddressInfo;
    server.close(() => resolve(port));
  });
});

const listenOn = (port: number): Promise<net.Server> => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => resolve(server));
});

const managers: TunnelManager[] = [];
const manager = (reserved: ReadonlySet<number>, clientPlatform: NodeJS.Platform = 'win32'): TunnelManager => {
  const created = new TunnelManager({ opener: () => undefined, reserved, clientPlatform, log: () => undefined });
  managers.push(created);
  return created;
};

afterEach(() => {
  for (const created of managers.splice(0)) for (const tunnel of [...created.list('ssh+h')]) created.stop('ssh+h', tunnel.key);
});

describe('reserved client ports', () => {
  it('are pi-ai\'s sign-in callbacks and Damocles\' MCP OAuth callback, as the environment sets it', () => {
    expect([...reservedClientPorts({})].sort((a, b) => a - b)).toEqual([1455, 1456, DEFAULT_OAUTH_CALLBACK_PORT, 53692]);
    expect(reservedClientPorts({ MCP_OAUTH_CALLBACK_PORT: '33418' }).has(33418)).toBe(true);
    expect(reservedClientPorts({ MCP_OAUTH_CALLBACK_PORT: '33418' }).has(DEFAULT_OAUTH_CALLBACK_PORT)).toBe(false);
  });

  it('are never a forward\'s local port: the remote port maps to the next free one', () => {
    const reserved = reservedClientPorts({});
    expect(refusalOf(1455, reserved, 'linux')).toBe('reserved');
    expect(candidatePorts(1455, reserved, 'linux').next().value).toBe(1457);
    expect(candidatePorts(53692, reserved, 'win32').next().value).toBe(53693);
  });

  it('a remote listener on a reserved port maps elsewhere, and a local bind of that port still works', async () => {
    const reservedPort = await freePort();
    const tunnels = manager(new Set([reservedPort]));
    const tunnel = await tunnels.forward('ssh+h', { host: '127.0.0.1', port: reservedPort });
    expect(tunnel.localPort).not.toBe(reservedPort);
    const signIn = await listenOn(reservedPort);
    await new Promise<void>((resolve) => signIn.close(() => resolve()));
  });

  it('refuses a reserved port as the user\'s local port and requireLocalPort, leaving the forward where it was', async () => {
    const reservedPort = await freePort();
    const remotePort = await freePort();
    const tunnels = manager(new Set([reservedPort]));
    const tunnel = await tunnels.forward('ssh+h', { host: '127.0.0.1', port: remotePort });
    await expect(tunnels.changeLocalPort('ssh+h', tunnel.key, reservedPort)).rejects.toMatchObject({ code: 'reserved', port: reservedPort });
    await expect(tunnels.forward('ssh+h', { host: '127.0.0.1', port: reservedPort }, { localPort: reservedPort, requireLocalPort: true })).rejects.toBeInstanceOf(PortRefusedError);
    expect(tunnels.get('ssh+h', tunnel.key)?.localPort).toBe(tunnel.localPort);
  });

  it('takes the next free port when the remote port\'s number is in use here, and refuses a taken one the user names', async () => {
    const taken = await freePort();
    const holder = await listenOn(taken);
    try {
      const tunnels = manager(new Set());
      const tunnel = await tunnels.forward('ssh+h', { host: '127.0.0.1', port: taken });
      expect(tunnel.localPort).toBeGreaterThan(taken);
      const other = await freePort();
      const moved = await tunnels.changeLocalPort('ssh+h', tunnel.key, other);
      expect(moved.localPort).toBe(other);
      await expect(tunnels.changeLocalPort('ssh+h', tunnel.key, taken)).rejects.toMatchObject({ code: 'inUse', port: taken });
      expect(tunnels.get('ssh+h', tunnel.key)?.localPort).toBe(other);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  it('takes the remote port\'s own number when nothing here listens on it', async () => {
    const free = await freePort();
    const tunnels = manager(new Set());
    expect((await tunnels.forward('ssh+h', { host: '127.0.0.1', port: free })).localPort).toBe(free);
  });

  // beside a wildcard listener Windows and macOS let the forward bind loopback, and then route loopback connections to it
  it.each([
    { host: '::', ipv6Only: false, loopback: '127.0.0.1' },
    { host: '0.0.0.0', ipv6Only: false, loopback: '127.0.0.1' },
    { host: '::', ipv6Only: true, loopback: '::1' },
    { host: '127.0.0.1', ipv6Only: false, loopback: '127.0.0.1' },
    { host: '::1', ipv6Only: false, loopback: '::1' },
  ])('counts a port another program serves on $host (ipv6Only $ipv6Only) as taken, and leaves it serving on $loopback', async ({ host, ipv6Only, loopback }) => {
    const holder = await new Promise<net.Server>((resolve, reject) => {
      const server = net.createServer((socket) => socket.end('holder'));
      server.once('error', reject);
      server.listen({ host, port: 0, ipv6Only }, () => resolve(server));
    });
    try {
      const taken = (holder.address() as net.AddressInfo).port;
      const tunnels = manager(new Set());
      const tunnel = await tunnels.forward('ssh+h', { host: '127.0.0.1', port: taken });
      expect(tunnel.localPort).not.toBe(taken);
      await expect(tunnels.forward('ssh+h', { host: '127.0.0.1', port: taken + 1 }, { localPort: taken, requireLocalPort: true })).rejects.toMatchObject({ code: 'inUse', port: taken });
      await expect(tunnels.changeLocalPort('ssh+h', tunnel.key, taken)).rejects.toMatchObject({ code: 'inUse', port: taken });
      expect(tunnels.get('ssh+h', tunnel.key)?.localPort).toBe(tunnel.localPort);
      const reached = await new Promise<string>((resolve, reject) => {
        const socket = net.connect({ host: loopback, port: taken });
        let text = '';
        socket.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
        socket.on('end', () => resolve(text));
        socket.on('error', reject);
      });
      expect(reached).toBe('holder');
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  it('refuses a port outside 1..65535', () => {
    expect(refusalOf(0, new Set(), 'win32')).toBe('invalid');
    expect(refusalOf(65536, new Set(), 'win32')).toBe('invalid');
    expect(refusalOf(1.5, new Set(), 'win32')).toBe('invalid');
  });
});

describe('the loopback probe', () => {
  // a listener whose full accept queue drops the connect never answers it, so the deadline decides
  it('counts a port whose connect nothing answers within the deadline as taken', async () => {
    const unanswered = (): net.Socket => new net.Socket();
    await expect(accepts('127.0.0.1', 1, 20, unanswered)).resolves.toBe(true);
  });

  // a program whose sockets handle no error would crash on a reset from the probe
  it('reads what the listener sent before closing, so the listener\'s connection ends with no reset', async () => {
    let bannerWritten!: () => void;
    const written = new Promise<void>((resolve) => { bannerWritten = resolve; });
    const server = net.createServer();
    const ended = new Promise<{ readonly hadError: boolean; readonly errors: readonly string[] }>((resolve) => {
      server.once('connection', (socket) => {
        const errors: string[] = [];
        socket.on('error', (err: NodeJS.ErrnoException) => errors.push(err.code ?? err.message));
        socket.once('close', (hadError) => resolve({ hadError, errors }));
        socket.end('banner', () => bannerWritten());
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // the probe sees its connect only once the banner waits unread in the socket's receive buffer: paused, Node reads nothing
    const afterBanner = (options: net.NetConnectOpts): net.Socket => {
      const socket = net.connect(options).pause();
      const emit = socket.emit.bind(socket);
      socket.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
        if (event !== 'connect') return emit(event, ...args);
        void written.then(() => emit(event, ...args));
        return true;
      }) as typeof socket.emit;
      return socket;
    };
    try {
      await expect(accepts('127.0.0.1', (server.address() as net.AddressInfo).port, 1000, afterBanner)).resolves.toBe(true);
      expect(await ended).toEqual({ hadError: false, errors: [] });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
