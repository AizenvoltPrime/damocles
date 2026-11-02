import * as net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { channelTransport } from '../../../../../remote/channel-transport';
import { CHANNEL, createMux, MAX_FRAME_BYTES, type StreamChannel } from '../../../../../remote/mux';
import { createPersistentProtocol } from '../../../../../remote/persistent-protocol';
import { listeners } from '../../../../../remote/listeners';
import { holdStream, streamClaims } from '../../../../../remote/tunnel-pipe';
import { socketPair } from '../../../../../remote/__tests__/sockets';
import { createEndpoint } from '../../../../core-protocol/endpoint';
import { createPortDetector } from '../../../../daemon/ports/port-detector';
import { createPortsHost } from '../../../../daemon/ports/ports-host';
import { CLIENT_TO_PORTS, PORTS_MAX_MESSAGE_BYTES, PORTS_TO_CLIENT, type ClientToPorts, type PortsToClient } from '../../../../daemon/ports/ports-messages';
import { ForwardLimitError, MAX_FORWARDS_PER_HOST, TunnelManager, type TunnelTarget } from '../tunnels';

const log = (): void => undefined;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// a client and a daemon over one in-memory PersistentProtocol pair, the daemon serving its ports channel; opened: the opener's
// stream, before carry gets it; connect: the daemon's net.connect
function wire(options: { readonly opened?: (stream: Promise<StreamChannel>) => Promise<StreamChannel>; readonly connect?: (host: string, port: number) => net.Socket } = {}) {
  const [a, b] = socketPair();
  const clientProtocol = createPersistentProtocol({ socket: a, maxBodyBytes: MAX_FRAME_BYTES, log });
  const daemonProtocol = createPersistentProtocol({ socket: b, maxBodyBytes: MAX_FRAME_BYTES, log });
  const fail = (reason: string): never => {
    throw new Error(reason);
  };
  const clientMux = createMux({ protocol: clientProtocol, side: 'client', acceptStreams: true, onOverflow: () => fail('overflow'), onViolation: fail, log });
  const daemonMux = createMux({ protocol: daemonProtocol, side: 'daemon', acceptStreams: true, onOverflow: () => fail('overflow'), onViolation: fail, log });
  const detector = createPortDetector({ scan: async () => [], log });
  // the connection's one owner of the streams the client opens, as connections.ts makes it
  const claims = streamClaims(daemonMux, fail);
  const lost = listeners<[]>();
  const served = createPortsHost({ detector, log, ...(options.connect ? { connect: options.connect } : {}) }).serve('connection-1', channelTransport(daemonMux.messageChannel(CHANNEL.ports, PORTS_MAX_MESSAGE_BYTES), PORTS_MAX_MESSAGE_BYTES, fail), (id) => claims.claim(id), fail, lost.add);
  const ports = createEndpoint<ClientToPorts, PortsToClient>({ transport: channelTransport(clientMux.messageChannel(CHANNEL.ports, PORTS_MAX_MESSAGE_BYTES), PORTS_MAX_MESSAGE_BYTES, fail), outgoing: CLIENT_TO_PORTS, incoming: PORTS_TO_CLIENT, log });
  const open = async (target: TunnelTarget): Promise<StreamChannel> => {
    const stream = holdStream(clientMux.openStream());
    const answer = await ports.request('connect', { stream: stream.id, host: target.host, port: target.port });
    if (!answer.ok) throw new Error(answer.error);
    return stream;
  };
  const opener = (target: TunnelTarget): Promise<StreamChannel> => (options.opened ? options.opened(open(target)) : open(target));
  const tunnels = new TunnelManager({ opener: () => opener, reserved: new Set(), clientPlatform: 'win32', log });
  cleanups.push(() => {
    tunnels.stopAll('ssh+h');
    served.dispose();
    claims.dispose();
    ports.close('done');
    clientMux.dispose();
    daemonMux.dispose();
    detector.dispose();
  });
  return { tunnels, daemonMux, clientMux, served, ports, loseConnection: () => lost.fire() };
}

// the target: a server on the "remote" side
async function target(onSocket: (socket: net.Socket) => void): Promise<number> {
  const accepted = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    accepted.add(socket);
    socket.on('error', () => undefined);
    onSocket(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  cleanups.push(() => new Promise<void>((resolve) => {
    for (const socket of accepted) socket.destroy();
    server.close(() => resolve());
  }));
  return (server.address() as net.AddressInfo).port;
}

// a reset after the connect is the outcome some tests wait for, through 'close'
const connectLocal = (port: number): Promise<net.Socket> => new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true }, () => resolve(socket));
  socket.on('error', reject);
  cleanups.push(() => void socket.destroy());
});

const collect = (socket: net.Socket): { text: () => string; ended: Promise<void>; closed: Promise<void> } => {
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  return {
    text: () => Buffer.concat(chunks).toString('utf8'),
    ended: new Promise((resolve) => socket.once('end', () => resolve())),
    closed: new Promise((resolve) => socket.once('close', () => resolve())),
  };
};

describe('a forwarded connection over its tunnel stream', () => {
  it('carries bytes both ways, a server that speaks first included, and passes a half-close each way', async () => {
    const remotePort = await target((socket) => {
      socket.write('hello ');
      const got: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => got.push(chunk));
      // the client finished writing; the server still answers, then ends its side
      socket.on('end', () => socket.end(`echo:${Buffer.concat(got).toString('utf8')}`));
    });
    const { tunnels } = wire();
    const tunnel = await tunnels.forward('ssh+h', { host: '127.0.0.1', port: remotePort });
    const local = await connectLocal(tunnel.localPort);
    const read = collect(local);
    await vi.waitFor(() => expect(read.text()).toBe('hello '));
    local.end('ping');
    await read.ended;
    expect(read.text()).toBe('hello echo:ping');
    await read.closed;
    await vi.waitFor(() => expect(tunnels.get('ssh+h', tunnel.key)?.liveConnections).toBe(0));
  });

  it('carries more than the stream window in both directions', async () => {
    const size = 3 * 256 * 1024 + 17;
    const remotePort = await target((socket) => socket.pipe(socket));
    const { tunnels } = wire();
    const tunnel = await tunnels.forward('ssh+h', { host: '127.0.0.1', port: remotePort });
    const local = await connectLocal(tunnel.localPort);
    let received = 0;
    local.on('data', (chunk: Buffer) => {
      received += chunk.length;
    });
    local.write(Buffer.alloc(size, 7));
    await vi.waitFor(() => expect(received).toBe(size), { timeout: 10_000 });
  });

  it('counts live connections, and Stop forwarding closes the listener and every open connection', async () => {
    const remotePort = await target(() => undefined);
    const { tunnels } = wire();
    const tunnel = await tunnels.forward('ssh+h', { host: '127.0.0.1', port: remotePort });
    const first = await connectLocal(tunnel.localPort);
    const second = await connectLocal(tunnel.localPort);
    await vi.waitFor(() => expect(tunnels.get('ssh+h', tunnel.key)?.liveConnections).toBe(2));
    const closed = Promise.all([first, second].map((socket) => new Promise<void>((resolve) => socket.once('close', () => resolve()))));
    tunnels.stop('ssh+h', tunnel.key);
    await closed;
    expect(tunnels.list('ssh+h')).toEqual([]);
    await expect(connectLocal(tunnel.localPort)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('closes the local connection when the target refuses, and counts nothing for it', async () => {
    const { tunnels } = wire();
    const remotePort = await target(() => undefined);
    const tunnel = await tunnels.forward('ssh+h', { host: '127.0.0.1', port: remotePort });
    // nothing listens on the target's port any more
    await cleanups.pop()?.();
    const local = await connectLocal(tunnel.localPort);
    await new Promise<void>((resolve) => local.once('close', () => resolve()));
    expect(tunnels.get('ssh+h', tunnel.key)?.liveConnections).toBe(0);
  });

  it('ends the local connection when the connection to the daemon goes away', async () => {
    const remotePort = await target(() => undefined);
    const { tunnels, clientMux } = wire();
    const tunnel = await tunnels.forward('ssh+h', { host: '127.0.0.1', port: remotePort });
    const local = await connectLocal(tunnel.localPort);
    await vi.waitFor(() => expect(tunnels.get('ssh+h', tunnel.key)?.liveConnections).toBe(1));
    const closed = new Promise<void>((resolve) => local.once('close', () => resolve()));
    clientMux.dispose();
    await closed;
  });

  it('drops and grants back what the target sends on a stream it opened for a connection that ended while it waited', async () => {
    let pumping = true;
    const chunk = Buffer.alloc(64 * 1024, 2);
    const remotePort = await target((socket) => {
      const pump = (): void => {
        while (pumping) {
          if (!socket.write(chunk)) {
            socket.once('drain', pump);
            return;
          }
        }
        socket.end();
      };
      pump();
    });
    let opened!: () => void;
    const streamOpened = new Promise<void>((resolve) => { opened = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    // the daemon's socket to the target, which closes once it read the target's end behind every byte before it
    let daemonSocket: net.Socket | undefined;
    const { tunnels } = wire({
      opened: async (stream) => {
        const ready = await stream;
        opened();
        await released;
        return ready;
      },
      connect: (host, port) => {
        daemonSocket = net.connect({ host, port, allowHalfOpen: true });
        return daemonSocket;
      },
    });
    const tunnel = await tunnels.forward('ssh+h', { host: '127.0.0.1', port: remotePort });
    await connectLocal(tunnel.localPort);
    await streamOpened;
    // the stream's window is full, so the daemon stopped reading the target
    await vi.waitFor(() => expect(daemonSocket!.isPaused()).toBe(true), { timeout: 10_000 });
    const daemonClosed = new Promise<void>((resolve) => daemonSocket!.once('close', () => resolve()));
    pumping = false;
    tunnels.stop('ssh+h', tunnel.key);
    release();
    await daemonClosed;
  }, 30_000);

  it('resets every connection a forward carries when the connection is lost, and keeps listening', async () => {
    const remotePort = await target(() => undefined);
    const { tunnels } = wire();
    const tunnel = await tunnels.forward('ssh+h', { host: '127.0.0.1', port: remotePort });
    const sockets = [await connectLocal(tunnel.localPort), await connectLocal(tunnel.localPort)];
    await vi.waitFor(() => expect(tunnels.get('ssh+h', tunnel.key)?.liveConnections).toBe(2));
    const closed = Promise.all(sockets.map((socket) => new Promise<void>((resolve) => socket.once('close', () => resolve()))));
    tunnels.resetConnections('ssh+h');
    await closed;
    await vi.waitFor(() => expect(tunnels.get('ssh+h', tunnel.key)?.liveConnections).toBe(0));
    await connectLocal(tunnel.localPort);
    await vi.waitFor(() => expect(tunnels.get('ssh+h', tunnel.key)?.liveConnections).toBe(1));
  });

  it('resets the daemon\'s side of every tunnel when the connection is lost', async () => {
    let targetClosed!: Promise<void>;
    const remotePort = await target((socket) => {
      targetClosed = new Promise((resolve) => socket.once('close', () => resolve()));
    });
    const { tunnels, loseConnection } = wire();
    const tunnel = await tunnels.forward('ssh+h', { host: '127.0.0.1', port: remotePort });
    await connectLocal(tunnel.localPort);
    await vi.waitFor(() => expect(tunnels.get('ssh+h', tunnel.key)?.liveConnections).toBe(1));
    await vi.waitFor(() => expect(targetClosed).toBeDefined());
    loseConnection();
    await targetClosed;
  });

  it('fails a connect still in flight when the connection closes, so its socket never outlives it', async () => {
    let pending: net.Socket | undefined;
    const { served, ports, clientMux } = wire({
      connect: () => {
        pending = new net.Socket();
        return pending;
      },
    });
    const stream = holdStream(clientMux.openStream());
    void ports.request('connect', { stream: stream.id, host: '127.0.0.1', port: 9 }).catch(() => undefined);
    await vi.waitFor(() => expect(pending).toBeDefined());
    served.dispose();
    expect(pending!.destroyed).toBe(true);
  });

  it.each(['EADDRNOTAVAIL', 'ENETUNREACH'])('connects a dual-stack listener on 127.0.0.1 when ::1 answers %s', async (code) => {
    const remotePort = await target((socket) => socket.end('hello'));
    const tried: string[] = [];
    const { tunnels } = wire({
      connect: (host, port) => {
        tried.push(host);
        if (host !== '::1') return net.connect({ host, port, allowHalfOpen: true });
        // a target whose loopback has no ::1
        const socket = new net.Socket();
        process.nextTick(() => socket.destroy(Object.assign(new Error(`connect ${code} ::1:${port}`), { code })));
        return socket;
      },
    });
    const tunnel = await tunnels.forward('ssh+h', { host: '::1', port: remotePort });
    const read = collect(await connectLocal(tunnel.localPort));
    await read.ended;
    expect(read.text()).toBe('hello');
    expect(tried).toEqual(['::1', '127.0.0.1']);
  });

  it('answers a refusal on ::1 as refused, without trying 127.0.0.1', async () => {
    const tried: string[] = [];
    const { ports, clientMux } = wire({
      connect: (host) => {
        tried.push(host);
        const socket = new net.Socket();
        process.nextTick(() => socket.destroy(Object.assign(new Error('connect ECONNREFUSED ::1:9'), { code: 'ECONNREFUSED' })));
        return socket;
      },
    });
    const stream = holdStream(clientMux.openStream());
    expect(await ports.request('connect', { stream: stream.id, host: '::1', port: 9 })).toEqual({ ok: false, error: 'refused' });
    expect(tried).toEqual(['::1']);
  });

  it(`refuses a forward past ${MAX_FORWARDS_PER_HOST} live ones of a host, whoever asks, until one stops`, async () => {
    const { tunnels } = wire();
    const remote = (index: number): TunnelTarget => ({ host: '127.0.0.1', port: 30_000 + index });
    for (let index = 0; index < MAX_FORWARDS_PER_HOST; index++) await tunnels.forward('ssh+h', remote(index));
    await expect(tunnels.forward('ssh+h', remote(MAX_FORWARDS_PER_HOST))).rejects.toBeInstanceOf(ForwardLimitError);
    // a live one is still answered, and another host has its own
    expect((await tunnels.forward('ssh+h', remote(0))).remote).toEqual(remote(0));
    await tunnels.forward('ssh+other', remote(0));
    tunnels.stop('ssh+h', tunnels.list('ssh+h')[0]!.key);
    await tunnels.forward('ssh+h', remote(MAX_FORWARDS_PER_HOST));
    tunnels.stopAll('ssh+other');
  }, 60_000);

  it('listens on both loopbacks, so a port another program holds on either one is taken', async () => {
    const remotePort = await target(() => undefined);
    const { tunnels } = wire();
    const tunnel = await tunnels.forward('ssh+h', { host: '127.0.0.1', port: remotePort });
    expect(tunnel.localAddresses[0]).toBe('127.0.0.1');
    expect(tunnel.localAddresses.every((address) => address === '127.0.0.1' || address === '::1')).toBe(true);
  });
});
