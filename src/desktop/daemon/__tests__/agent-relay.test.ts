import * as net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamChannel } from '../../../remote/mux';
import { createAgentRelay, MAX_AGENT_CONNECTIONS } from '../agent-relay';

// A stream as the relay sees it: what it wrote, whether it ended, and the peer's bytes and end.
function fakeStream(id: number) {
  const data = new Set<(bytes: Uint8Array) => void>();
  const ends = new Set<() => void>();
  const written: string[] = [];
  let ended = false;
  const stream: StreamChannel = {
    id,
    closed: false,
    write: (bytes) => {
      written.push(Buffer.from(bytes).toString('utf8'));
      return true;
    },
    end: () => {
      ended = true;
    },
    onData: (listener) => {
      data.add(listener);
      return { dispose: () => data.delete(listener) };
    },
    onEnd: (listener) => {
      ends.add(listener);
      return { dispose: () => ends.delete(listener) };
    },
    onDrain: () => ({ dispose: () => undefined }),
    pause: () => undefined,
    resume: () => undefined,
  };
  return {
    stream,
    written: () => written.join(''),
    ended: () => ended,
    send: (text: string) => data.forEach((listener) => listener(Buffer.from(text))),
    finish: () => ends.forEach((listener) => listener()),
  };
}

describe('a connection\'s SSH agent relay on the daemon', () => {
  const sockets: net.Socket[] = [];
  // one listener per test, standing in for the proxy socket; an accepted socket is matched to its process by port
  let proxy: Promise<{ readonly server: net.Server; readonly port: number; readonly accepted: (localPort: number) => Promise<net.Socket> }> | undefined;
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    const listening = proxy;
    proxy = undefined;
    if (listening) {
      const { server } = await listening;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  function proxySocket() {
    proxy ??= new Promise((resolve) => {
      const arrived = new Map<number, net.Socket>();
      const waiting = new Map<number, (socket: net.Socket) => void>();
      const server = net.createServer((socket) => {
        const take = waiting.get(socket.remotePort!);
        waiting.delete(socket.remotePort!);
        if (take) take(socket);
        else arrived.set(socket.remotePort!, socket);
      });
      const accepted = (localPort: number): Promise<net.Socket> => new Promise((take) => {
        const socket = arrived.get(localPort);
        arrived.delete(localPort);
        if (socket) take(socket);
        else waiting.set(localPort, take);
      });
      server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as net.AddressInfo).port, accepted }));
    });
    return proxy;
  }

  // a process connecting to the proxy socket: its own end, and the end the proxy hands the relay
  async function connected(): Promise<{ process: net.Socket; incoming: net.Socket; received: () => string; closed: Promise<void> }> {
    const { port, accepted } = await proxySocket();
    const process = net.connect(port, '127.0.0.1');
    process.on('error', () => undefined);
    let text = '';
    process.on('data', (chunk) => { text += chunk.toString('utf8'); });
    const closed = new Promise<void>((resolve) => process.on('close', () => resolve()));
    await new Promise<void>((resolve) => process.once('connect', () => resolve()));
    const incoming = await accepted(process.localPort!);
    incoming.on('error', () => undefined);
    sockets.push(process, incoming);
    return { process, incoming, received: () => text, closed };
  }

  it('asks once per process with a fresh request, and pipes it only once the client connects it', async () => {
    const asked: number[] = [];
    const relay = createAgentRelay({ ask: (request) => asked.push(request), log: () => undefined });
    const one = await connected();
    const two = await connected();
    relay.request(one.incoming);
    relay.request(two.incoming);
    expect(asked).toEqual([1, 2]);
    expect(one.incoming.isPaused()).toBe(true);
    one.process.write('sign this');
    const stream = fakeStream(16);
    expect(relay.connect(1, stream.stream)).toBe(true);
    await vi.waitFor(() => expect(stream.written()).toBe('sign this'));
    stream.send('signed');
    await vi.waitFor(() => expect(one.received()).toBe('signed'));
    // the peer's end ends the process's connection
    stream.finish();
    await one.closed;
    relay.close();
  });

  it('answers false and ends the named stream for a request refused, taken already, never drawn, or whose process hung up', async () => {
    const relay = createAgentRelay({ ask: () => undefined, log: () => undefined });
    const refused = await connected();
    relay.request(refused.incoming);
    relay.refuse(1);
    await refused.closed;
    const gone = await connected();
    relay.request(gone.incoming);
    gone.process.destroy();
    await new Promise<void>((resolve) => gone.incoming.once('close', () => resolve()));
    const taken = await connected();
    relay.request(taken.incoming);
    expect(relay.connect(3, fakeStream(16).stream)).toBe(true);
    for (const request of [1, 2, 3, 99]) {
      const stream = fakeStream(18);
      expect(relay.connect(request, stream.stream)).toBe(false);
      expect(stream.ended()).toBe(true);
    }
    relay.close();
  });

  it(`closes a process at once past ${MAX_AGENT_CONNECTIONS} waiting or relayed, and every one when the relay closes`, async () => {
    const asked: number[] = [];
    const lines: string[] = [];
    const relay = createAgentRelay({ ask: (request) => asked.push(request), log: (line) => lines.push(line) });
    const open = await Promise.all(Array.from({ length: MAX_AGENT_CONNECTIONS }, () => connected()));
    for (const each of open) relay.request(each.incoming);
    expect(relay.connect(1, fakeStream(16).stream)).toBe(true);
    const extra = await connected();
    relay.request(extra.incoming);
    await extra.closed;
    expect(asked).toHaveLength(MAX_AGENT_CONNECTIONS);
    expect(lines).toEqual([`[agent] closed a connection: ${MAX_AGENT_CONNECTIONS} are already relayed or waiting`]);
    relay.close();
    await Promise.all(open.map((each) => each.closed));
    const late = await connected();
    relay.request(late.incoming);
    await late.closed;
    expect(asked).toHaveLength(MAX_AGENT_CONNECTIONS);
  });
});
