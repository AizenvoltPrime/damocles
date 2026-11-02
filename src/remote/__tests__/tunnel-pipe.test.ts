import * as net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMux, MAX_FRAME_BYTES, STREAM_WINDOW_BYTES, type MessageChannel, type Mux } from '../mux';
import { createPersistentProtocol } from '../persistent-protocol';
import type { StreamChannel } from '../mux';
import { holdStream, MAX_UNCLAIMED_STREAM_BYTES, pipeTunnel, streamBytes, streamClaims, writeBytes } from '../tunnel-pipe';
import { socketPair } from './sockets';

const log = (): void => undefined;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const refuse = (reason: string): never => {
  throw new Error(reason);
};

// both ends of one loopback TCP connection, each half-open capable and with its errors swallowed
async function tcpPair(): Promise<{ readonly near: net.Socket; readonly far: net.Socket }> {
  const server = net.createServer({ allowHalfOpen: true });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const accepted = new Promise<net.Socket>((resolve) => server.once('connection', resolve));
  const near = net.connect({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port, allowHalfOpen: true });
  const far = await accepted;
  server.close();
  for (const socket of [near, far]) socket.on('error', () => undefined);
  cleanups.push(() => {
    near.destroy();
    far.destroy();
  });
  return { near, far };
}

// a client and a daemon mux over one in-memory protocol pair, and a message channel each way for round trips
function pair(): { client: Mux; daemon: Mux; roundTrip: () => Promise<void> } {
  const [a, b] = socketPair();
  const client = createMux({ protocol: createPersistentProtocol({ socket: a, maxBodyBytes: MAX_FRAME_BYTES, log }), side: 'client', acceptStreams: true, onOverflow: () => refuse('overflow'), onViolation: refuse, log });
  const daemon = createMux({ protocol: createPersistentProtocol({ socket: b, maxBodyBytes: MAX_FRAME_BYTES, log }), side: 'daemon', acceptStreams: true, onOverflow: () => refuse('overflow'), onViolation: refuse, log });
  const ping: MessageChannel = client.messageChannel(9, 16);
  const pong: MessageChannel = daemon.messageChannel(9, 16);
  pong.onMessage((message) => pong.send(message));
  cleanups.push(() => {
    client.dispose();
    daemon.dispose();
  });
  // every frame the client sent before it has reached the daemon, and every credit the daemon sent before the echo is back
  const roundTrip = (): Promise<void> => new Promise((resolve) => {
    const subscription = ping.onMessage(() => {
      subscription.dispose();
      resolve();
    });
    ping.send(new Uint8Array([1]));
  });
  return { client, daemon, roundTrip };
}

describe('a stream the peer opened, held until its owner claims it', () => {
  it('takes at most one credit window before its claim, then hands the reader every byte once, in order', async () => {
    const { client, daemon, roundTrip } = pair();
    const claims = streamClaims(daemon, refuse);
    cleanups.push(() => claims.dispose());
    // the bytes the daemon's side received, whoever reads them
    let arrived = 0;
    daemon.onStream((stream) => stream.onData((bytes) => {
      arrived += bytes.length;
    }));
    const stream = client.openStream();
    const size = 3 * STREAM_WINDOW_BYTES + 17;
    const sent = new Uint8Array(size).map((_, index) => index % 251);
    stream.write(sent);
    await vi.waitFor(() => expect(arrived).toBe(STREAM_WINDOW_BYTES));
    await roundTrip();
    await roundTrip();
    expect(arrived).toBe(STREAM_WINDOW_BYTES);
    const owner = claims.claim(stream.id)!;
    expect(claims.claim(stream.id)).toBeUndefined();
    const read: Uint8Array[] = [];
    owner.onData((bytes) => read.push(bytes));
    await vi.waitFor(() => expect(read.reduce((total, bytes) => total + bytes.length, 0)).toBe(size));
    expect(Buffer.concat(read).equals(Buffer.from(sent))).toBe(true);
  });

  it('pauses the stream until its reader subscribes, and keeps a pause the reader made before', () => {
    const calls: string[] = [];
    const data = new Set<(bytes: Uint8Array) => void>();
    const raw: StreamChannel = {
      id: 16,
      closed: false,
      write: () => true,
      end: () => undefined,
      onData: (listener) => {
        data.add(listener);
        return { dispose: () => data.delete(listener) };
      },
      onEnd: () => ({ dispose: () => undefined }),
      onDrain: () => ({ dispose: () => undefined }),
      pause: () => calls.push('pause'),
      resume: () => calls.push('resume'),
    };
    const held = holdStream(raw);
    expect(calls).toEqual(['pause']);
    data.forEach((listener) => listener(new Uint8Array([1, 2])));
    // a resume before anyone reads grants nothing
    held.resume();
    held.pause();
    expect(calls).toEqual(['pause', 'pause']);
    const read: number[] = [];
    held.onData((bytes) => read.push(...bytes));
    expect(read).toEqual([1, 2]);
    expect(calls).toEqual(['pause', 'pause']);
    held.resume();
    expect(calls).toEqual(['pause', 'pause', 'resume']);
    // a reader with no pause of its own takes the credit at once
    const plain = holdStream(raw);
    plain.onData(() => undefined);
    expect(calls.slice(-2)).toEqual(['pause', 'resume']);
  });

  it('calls an end listener added after the end arrived, also once an earlier listener subscribed', () => {
    const ends = new Set<() => void>();
    const raw: StreamChannel = {
      id: 16,
      closed: false,
      write: () => true,
      end: () => undefined,
      onData: () => ({ dispose: () => undefined }),
      onEnd: (listener) => {
        ends.add(listener);
        return { dispose: () => ends.delete(listener) };
      },
      onDrain: () => ({ dispose: () => undefined }),
      pause: () => undefined,
      resume: () => undefined,
    };
    const held = holdStream(raw);
    const calls: string[] = [];
    held.onEnd(() => calls.push('early'));
    [...ends].forEach((listener) => listener());
    held.onEnd(() => calls.push('late'));
    expect(calls).toEqual(['early', 'late']);
  });

  it('ends its own direction of a stream the peer ended unclaimed, which then claims as nothing', async () => {
    const { client, daemon } = pair();
    const claims = streamClaims(daemon, refuse);
    cleanups.push(() => claims.dispose());
    const stream = client.openStream();
    const ended = new Promise<void>((resolve) => stream.onEnd(() => resolve()));
    stream.end();
    await ended;
    expect(claims.claim(stream.id)).toBeUndefined();
  });

  it('closes the connection once the unclaimed streams hold more than MAX_UNCLAIMED_STREAM_BYTES, a claimed one no longer counting', async () => {
    const { client, daemon } = pair();
    const closed: string[] = [];
    // as a connection's close does, which ends the mux at once
    const claims = streamClaims(daemon, (reason) => {
      closed.push(reason);
      daemon.dispose();
    });
    cleanups.push(() => claims.dispose());
    let arrived = 0;
    daemon.onStream((stream) => stream.onData((bytes) => {
      arrived += bytes.length;
    }));
    // each stream takes one window into its hold; in batches, so the client's own held bytes stay under its bound
    const fill = async (count: number): Promise<number[]> => {
      const ids: number[] = [];
      for (let done = 0; done < count; done += 32) {
        const before = arrived;
        const batch = Math.min(32, count - done);
        for (let index = 0; index < batch; index++) {
          const stream = client.openStream();
          stream.write(new Uint8Array(STREAM_WINDOW_BYTES));
          ids.push(stream.id);
        }
        await vi.waitFor(() => expect(arrived - before).toBe(batch * STREAM_WINDOW_BYTES), { timeout: 10_000 });
      }
      return ids;
    };
    const [first] = await fill(MAX_UNCLAIMED_STREAM_BYTES / STREAM_WINDOW_BYTES);
    expect(closed).toEqual([]);
    claims.claim(first!)!.onData(() => undefined);
    await fill(1);
    expect(closed).toEqual([]);
    client.openStream().write(new Uint8Array(STREAM_WINDOW_BYTES));
    await vi.waitFor(() => expect(closed).toEqual(['the peer sent more stream bytes than were asked for']));
  }, 30_000);
});

describe('a socket piped over a stream', () => {
  it('keeps granting the peer credit after its socket closed while paused, so the peer\'s writer drains and its pipe closes', async () => {
    const { client, daemon } = pair();
    // the browser, which stops reading, and the client's accepted socket
    const browser = await tcpPair();
    // the daemon's socket and the target server, which writes until the test stops it
    const target = await tcpPair();
    let daemonClosed = false;
    daemon.onStream((stream) => pipeTunnel(target.near, stream, () => { daemonClosed = true; }));
    const raw = client.openStream();
    let paused = false;
    const watched: StreamChannel = {
      id: raw.id,
      get closed() {
        return raw.closed;
      },
      write: (bytes) => raw.write(bytes),
      end: () => raw.end(),
      onData: (listener) => raw.onData(listener),
      onEnd: (listener) => raw.onEnd(listener),
      onDrain: (listener) => raw.onDrain(listener),
      pause: () => {
        paused = true;
        raw.pause();
      },
      resume: () => raw.resume(),
    };
    pipeTunnel(browser.far, watched, () => undefined);
    browser.near.pause();
    let pumping = true;
    const serverClosed = new Promise<void>((resolve) => target.far.once('close', () => resolve()));
    const chunk = Buffer.alloc(64 * 1024, 1);
    const pump = (): void => {
      while (pumping) {
        if (!target.far.write(chunk)) {
          target.far.once('drain', pump);
          return;
        }
      }
      target.far.end();
    };
    pump();
    await vi.waitFor(() => expect(paused).toBe(true), { timeout: 10_000 });
    pumping = false;
    browser.near.resetAndDestroy();
    await serverClosed;
    await vi.waitFor(() => expect(daemonClosed).toBe(true));
  }, 30_000);

  it('resets a socket piped onto a stream whose connection already closed', async () => {
    const { client } = pair();
    const stream = client.openStream();
    client.dispose();
    const { near, far } = await tcpPair();
    const closed = new Promise<void>((resolve) => far.once('close', () => resolve()));
    let pipeClosed = false;
    pipeTunnel(near, stream, () => { pipeClosed = true; });
    await closed;
    await vi.waitFor(() => expect(pipeClosed).toBe(true));
  });
});

describe('a file\'s bytes on a stream', () => {
  const CHUNK = 64 * 1024;
  // a client stream the daemon side reads through streamBytes, and the source's bytes pulled so far
  async function transfer(count: number, fail?: Error, signal?: AbortSignal): Promise<{
    readonly writing: Promise<'ended' | 'stopped'>;
    readonly reader: AsyncIterator<Uint8Array>;
    readonly pulled: () => number;
    readonly client: Mux;
    readonly daemon: Mux;
    // the reader paused the stream; each side's mux saw the other side's end
    readonly paused: () => boolean;
    readonly closedOnBothSides: Promise<void>;
  }> {
    const { client, daemon } = pair();
    const claims = streamClaims(daemon, refuse);
    cleanups.push(() => claims.dispose());
    const daemonEnded = new Promise<void>((resolve) => daemon.onStream((opened) => opened.onEnd(resolve)));
    const raw = client.openStream();
    const clientEnded = new Promise<void>((resolve) => raw.onEnd(resolve));
    const stream = holdStream(raw);
    let pulled = 0;
    let claimedNow!: () => void;
    // the source starts once the daemon side holds its owner, as a request naming the stream comes first
    const ready = new Promise<void>((resolve) => { claimedNow = resolve; });
    async function* source(): AsyncGenerator<Uint8Array> {
      await ready;
      for (let index = 0; index < count; index++) {
        pulled += CHUNK;
        yield new Uint8Array(CHUNK).fill(index);
      }
      if (fail) throw fail;
    }
    const writing = writeBytes(stream, source(), signal);
    const claimed = await vi.waitFor(() => {
      const owner = claims.claim(stream.id);
      if (!owner) throw new Error('not opened yet');
      return owner;
    });
    const pause = vi.spyOn(claimed, 'pause');
    claimedNow();
    return {
      writing,
      reader: streamBytes(claimed)[Symbol.asyncIterator](),
      pulled: () => pulled,
      client,
      daemon,
      paused: () => pause.mock.calls.length > 0,
      closedOnBothSides: Promise.all([daemonEnded, clientEnded]).then(() => undefined),
    };
  }

  async function drain(reader: AsyncIterator<Uint8Array>): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for (let next = await reader.next(); !next.done; next = await reader.next()) parts.push(next.value);
    return Buffer.concat(parts);
  }

  it('carries every byte in order, and holds the writer while the reader does not pull', async () => {
    const { writing, reader, pulled } = await transfer(32);
    await vi.waitFor(() => expect(pulled()).toBeGreaterThan(STREAM_WINDOW_BYTES));
    const held = pulled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // the window in flight, the window the reader holds unread, and the writer's own queue
    expect(pulled()).toBe(held);
    expect(held).toBeLessThanOrEqual(4 * STREAM_WINDOW_BYTES);
    const bytes = await drain(reader);
    expect(bytes.length).toBe(32 * CHUNK);
    for (let index = 0; index < 32; index++) expect(bytes[index * CHUNK]).toBe(index);
    expect(await writing).toBe('ended');
  });

  it('stops the writer once the reader returns early', async () => {
    const { writing, reader, pulled } = await transfer(64);
    expect((await reader.next()).done).toBe(false);
    await reader.return!();
    expect(await writing).toBe('stopped');
    expect(pulled()).toBeLessThan(64 * CHUNK);
  });

  // a reader that stops while its window is full must still let the writer's queued bytes and end cross, or the stream and
  // what it queued stay held for the connection's life
  it('closes the stream on both muxes and frees what the writer held once a paused reader returns early', async () => {
    const { writing, reader, client, daemon, paused, closedOnBothSides } = await transfer(64);
    await vi.waitFor(() => expect(paused()).toBe(true));
    expect((await reader.next()).done).toBe(false);
    await reader.return!();
    expect(await writing).toBe('stopped');
    await closedOnBothSides;
    await vi.waitFor(() => {
      expect(client.heldBytes()).toBe(0);
      expect(daemon.heldBytes()).toBe(0);
    }, { timeout: 5000 });
  });

  it('closes the stream on both muxes once a consumer throws inside for await while paused', async () => {
    const { writing, reader, client, daemon, paused, closedOnBothSides } = await transfer(64);
    await vi.waitFor(() => expect(paused()).toBe(true));
    const full = new Error('ENOSPC');
    const consume = async (): Promise<void> => {
      for await (const _bytes of { [Symbol.asyncIterator]: () => reader }) throw full;
    };
    await expect(consume()).rejects.toBe(full);
    expect(await writing).toBe('stopped');
    await closedOnBothSides;
    await vi.waitFor(() => {
      expect(client.heldBytes()).toBe(0);
      expect(daemon.heldBytes()).toBe(0);
    }, { timeout: 5000 });
  });

  it('ends the stream short and rethrows when the source throws, which the reader sees as fewer bytes', async () => {
    const cancelled = new Error('cancelled');
    const { writing, reader } = await transfer(3, cancelled);
    await expect(writing).rejects.toBe(cancelled);
    expect((await drain(reader)).length).toBe(3 * CHUNK);
  });

  it('stops a writer waiting for credit once its signal aborts, ending the stream short', async () => {
    const controller = new AbortController();
    const { writing, reader, pulled } = await transfer(64, undefined, controller.signal);
    await vi.waitFor(() => expect(pulled()).toBeGreaterThan(STREAM_WINDOW_BYTES));
    const held = pulled();
    controller.abort();
    expect(await writing).toBe('stopped');
    expect(pulled()).toBe(held);
    expect((await drain(reader)).length).toBeLessThan(64 * CHUNK);
  });

  it('fails the reader when the connection closes before the end', async () => {
    const { reader, daemon } = await transfer(64);
    expect((await reader.next()).done).toBe(false);
    daemon.dispose();
    await expect(drain(reader)).rejects.toThrow(/connection closed/);
  });
});
