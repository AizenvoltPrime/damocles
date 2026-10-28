import { describe, expect, it, vi } from 'vitest';
import { createMux, FRAGMENT_BYTES, MAX_FRAME_BYTES, MAX_OPEN_STREAMS, MESSAGE_WINDOW_BYTES, type Mux } from '../mux';
import { createPersistentProtocol, type PersistentProtocol } from '../persistent-protocol';
import { fakeSocket, socketPair } from './sockets';

const log = (): void => undefined;

interface Side {
  readonly protocol: PersistentProtocol;
  readonly mux: Mux;
  readonly violations: string[];
  overflowed: boolean;
}

function connected(maxHeldBytes?: number): { client: Side; daemon: Side } {
  const [a, b] = socketPair();
  const side = (socket: typeof a, which: 'client' | 'daemon'): Side => {
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: MAX_FRAME_BYTES, log });
    const state: Side = { protocol, mux: undefined as unknown as Mux, violations: [], overflowed: false };
    (state as { mux: Mux }).mux = createMux({
      protocol,
      side: which,
      acceptStreams: which === 'client',
      ...(maxHeldBytes !== undefined ? { maxHeldBytes } : {}),
      onOverflow: () => { state.overflowed = true; },
      onViolation: (reason) => state.violations.push(reason),
      log,
    });
    return state;
  };
  return { client: side(a, 'client'), daemon: side(b, 'daemon') };
}

// the raw frame encoding, for frames a well-behaved mux never sends
function rawFrame(channel: number, kind: number, flags: number, body: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(3 + body.length);
  out[0] = channel;
  out[1] = kind;
  out[2] = flags;
  out.set(body, 3);
  return out;
}

describe('mux', () => {
  it('splits a message over 64 KiB into continued frames and joins them', async () => {
    const { client, daemon } = connected();
    const sent: number[] = [];
    const original = daemon.protocol.send.bind(daemon.protocol);
    daemon.protocol.send = (body) => {
      sent.push(body.length);
      original(body);
    };
    const out = daemon.mux.messageChannel(2, 8 << 20);
    const into = client.mux.messageChannel(2, 8 << 20);
    const got: Uint8Array[] = [];
    into.onMessage((message) => got.push(message));
    const big = new Uint8Array(3 * FRAGMENT_BYTES + 5).map((_, index) => index % 251);
    out.send(big);
    out.send(Uint8Array.from([7]));
    await vi.waitFor(() => expect(got).toHaveLength(2));
    expect(Buffer.compare(got[0]!, big)).toBe(0);
    expect([...got[1]!]).toEqual([7]);
    expect(sent.filter((length) => length > FRAGMENT_BYTES)).toHaveLength(3);
  });

  it('sends within the credit and refuses a joined message over the bound', async () => {
    const { client, daemon } = connected();
    daemon.mux.messageChannel(2, 1024);
    const out = client.mux.messageChannel(2, 1024);
    out.send(new Uint8Array(2048));
    await vi.waitFor(() => expect(daemon.violations).toEqual(['a message over 1024 bytes on channel 2']));
  });

  it('writes round-robin over the channels with frames and credit', async () => {
    const { client, daemon } = connected();
    const order: number[] = [];
    const a = daemon.mux.messageChannel(2, 64 << 20);
    const b = daemon.mux.messageChannel(1, 64 << 20);
    client.mux.messageChannel(2, 64 << 20).onMessage(() => order.push(2));
    client.mux.messageChannel(1, 64 << 20).onMessage(() => order.push(1));
    a.send(new Uint8Array(8 * FRAGMENT_BYTES));
    for (let index = 0; index < 4; index++) b.send(new Uint8Array(10));
    await vi.waitFor(() => expect(order).toHaveLength(5));
    // the four small messages are not queued behind the large one
    expect(order.indexOf(2)).toBe(4);
  });

  it('stops a sender at its window until the receiver grants credit', async () => {
    const { client, daemon } = connected();
    const out = daemon.mux.messageChannel(2, 64 << 20);
    const into = client.mux.messageChannel(2, 64 << 20);
    let received = 0;
    into.onMessage((message) => {
      received += message.length;
    });
    for (let index = 0; index < 8; index++) out.send(new Uint8Array(MESSAGE_WINDOW_BYTES / 2));
    await vi.waitFor(() => expect(received).toBe(4 * MESSAGE_WINDOW_BYTES), { timeout: 5000 });
  });

  it('refuses data past the granted credit', async () => {
    const [a, b] = socketPair();
    const peer = createPersistentProtocol({ socket: a, maxBodyBytes: MAX_FRAME_BYTES, log });
    // a receiver whose protocol bound admits one frame larger than the whole window
    const receiver = createPersistentProtocol({ socket: b, maxBodyBytes: 2 * MESSAGE_WINDOW_BYTES, log });
    const violations: string[] = [];
    createMux({ protocol: receiver, side: 'daemon', acceptStreams: false, onOverflow: () => undefined, onViolation: (reason) => violations.push(reason), log }).messageChannel(2, 64 << 20);
    peer.send(rawFrame(2, 1, 1, new Uint8Array(MESSAGE_WINDOW_BYTES + 1)));
    await vi.waitFor(() => expect(violations).toEqual(['data past the credit of channel 2']));
  });

  it('refuses an empty continued frame', async () => {
    const { client, daemon } = connected();
    daemon.mux.messageChannel(2, 64 << 20);
    client.protocol.send(rawFrame(2, 1, 1));
    await vi.waitFor(() => expect(daemon.violations).toEqual(['an empty continued frame on channel 2']));
  });

  it('carries streams with an end, and bounds the streams a peer opens', async () => {
    const { client, daemon } = connected();
    const streams: number[] = [];
    const data: number[] = [];
    let ended = false;
    client.mux.onStream((stream) => {
      streams.push(stream.id);
      stream.onData((bytes) => data.push(bytes.length));
      stream.onEnd(() => { ended = true; });
    });
    const stream = daemon.mux.openStream();
    expect(stream.id).toBe(17);
    stream.write(new Uint8Array(100_000));
    stream.end();
    await vi.waitFor(() => expect(ended).toBe(true));
    expect(streams).toEqual([17]);
    expect(data.reduce((sum, length) => sum + length, 0)).toBe(100_000);
    // the daemon accepts no stream from a client
    client.mux.openStream();
    await vi.waitFor(() => expect(daemon.violations).toEqual(['an open of channel 16']));
  });

  it('refuses a reopened stream id and more than MAX_OPEN_STREAMS open streams', async () => {
    const { client, daemon } = connected();
    client.mux.onStream(() => undefined);
    daemon.protocol.send(rawFrame(17, 0, 0));
    daemon.protocol.send(rawFrame(17, 3, 0));
    daemon.protocol.send(rawFrame(17, 0, 0));
    await vi.waitFor(() => expect(client.violations).toEqual(['an open of channel 17']));
    const second = connected();
    second.client.mux.onStream(() => undefined);
    for (let index = 0; index < MAX_OPEN_STREAMS; index++) second.daemon.mux.openStream();
    expect(() => second.daemon.mux.openStream()).toThrow(/streams are open/);
  });

  it('keeps terminal output flowing during a sustained 100 MiB read, with no gap over 100 ms', async () => {
    const { client, daemon } = connected();
    const terminal = daemon.mux.messageChannel(2, 1 << 20);
    const arrivals: number[] = [];
    client.mux.messageChannel(2, 1 << 20).onMessage(() => arrivals.push(performance.now()));
    let received = 0;
    const total = 100 * 1024 * 1024;
    client.mux.onStream((stream) => stream.onData((bytes) => {
      received += bytes.length;
    }));
    const file = daemon.mux.openStream();
    const chunk = new Uint8Array(1024 * 1024);
    let written = 0;
    const pump = (): void => {
      while (written < total) {
        written += chunk.length;
        if (!file.write(chunk)) return;
      }
      file.end();
    };
    file.onDrain(pump);
    pump();
    const ticker = setInterval(() => terminal.send(Uint8Array.from([1, 2, 3])), 10);
    await vi.waitFor(() => expect(received).toBe(total), { timeout: 60_000, interval: 50 });
    clearInterval(ticker);
    const gaps = arrivals.slice(1).map((at, index) => at - arrivals[index]!);
    expect(arrivals.length).toBeGreaterThan(10);
    expect(Math.max(...gaps)).toBeLessThan(100);
  }, 90_000);

  it.each([
    ['a credit past the window', rawFrame(2, 2, 0, Uint8Array.from([1])), 'a credit on channel 2'],
    ['a credit that does not end', rawFrame(2, 2, 0, Uint8Array.from([0x80])), 'a credit on channel 2'],
    ['an unknown kind', rawFrame(2, 9, 0), 'a frame of unknown kind 9'],
    ['unknown flags', rawFrame(2, 1, 2, Uint8Array.from([1])), 'unknown frame flags 2'],
    ['MORE on a frame that is not data', rawFrame(2, 2, 1, Uint8Array.from([1])), 'unknown frame flags 1'],
    ['data on a channel that is not open', rawFrame(5, 1, 0, Uint8Array.from([1])), 'data on channel 5, which is not open'],
    ['a close of a message channel', rawFrame(2, 3, 0), 'a close of channel 2'],
    ['a channel id not in its shortest form', Uint8Array.from([0x82, 0x00, 1, 0, 1]), 'a malformed frame'],
  ])('refuses %s', async (_name, frame, reason) => {
    const { client, daemon } = connected();
    daemon.mux.messageChannel(2, 64 << 20);
    client.protocol.send(frame);
    await vi.waitFor(() => expect(daemon.violations).toEqual([reason]));
  });

  it('ignores a credit that crossed the close of its stream', async () => {
    const { client, daemon } = connected();
    const ended: number[] = [];
    client.mux.onStream((stream) => stream.onEnd(() => ended.push(stream.id)));
    const stream = daemon.mux.openStream();
    stream.end();
    await vi.waitFor(() => expect(ended).toEqual([17]));
    const into = client.mux.messageChannel(2, 1024);
    const got: number[] = [];
    into.onMessage((message) => got.push(message.length));
    client.protocol.send(rawFrame(17, 2, 0, Uint8Array.from([5])));
    daemon.mux.messageChannel(2, 1024).send(new Uint8Array(3));
    await vi.waitFor(() => expect(got).toEqual([3]));
    expect(daemon.violations).toEqual([]);
  });

  it('wakes a blocked writer and ends the readers when it is disposed', async () => {
    const { client, daemon } = connected();
    const ended: number[] = [];
    const opened = new Promise<void>((resolve) => client.mux.onStream((stream) => {
      stream.onEnd(() => ended.push(stream.id));
      resolve();
    }));
    const stream = daemon.mux.openStream();
    await opened;
    expect(stream.write(new Uint8Array(1024 * 1024))).toBe(false);
    const woke = new Promise<void>((resolve) => stream.onDrain(resolve));
    daemon.mux.dispose();
    await woke;
    expect(stream.closed).toBe(true);
    expect(stream.write(new Uint8Array(1))).toBe(false);
    client.mux.dispose();
    expect(ended).toEqual([17]);
  });

  it('spends a reservation even when too many streams are open to open it', () => {
    const { client, daemon } = connected();
    client.mux.onStream(() => undefined);
    const reserved = daemon.mux.reserveStream();
    for (let index = 0; index < MAX_OPEN_STREAMS; index++) daemon.mux.openStream();
    expect(() => daemon.mux.openStream(reserved)).toThrow(/streams are open/);
    expect(() => daemon.mux.openStream(reserved)).toThrow(/was not reserved/);
  });

  it('settles drained once the frames queued before the call went out, whatever is queued after', async () => {
    const sent: Uint8Array[] = [];
    const protocol = { send: (body: Uint8Array) => sent.push(body), onMessage: () => ({ dispose: () => undefined }), writable: () => true, onDrain: () => ({ dispose: () => undefined }), unackedBytes: () => 0 };
    const mux = createMux({ protocol, side: 'daemon', acceptStreams: false, onOverflow: () => undefined, onViolation: () => undefined, log });
    const channel = mux.messageChannel(2, 64 << 20);
    channel.send(new Uint8Array(MESSAGE_WINDOW_BYTES));
    const first = mux.drained();
    // no credit comes back, so this one never goes out
    channel.send(new Uint8Array(10));
    let later = false;
    void mux.drained().then(() => { later = true; });
    await first;
    expect(sent.reduce((total, body) => total + body.length, 0)).toBeGreaterThanOrEqual(MESSAGE_WINDOW_BYTES);
    await new Promise((resolve) => setImmediate(resolve));
    expect(later).toBe(false);
    mux.dispose();
    await vi.waitFor(() => expect(later).toBe(true));
  });

  it('drops a live connection once its backlog passes the bound, the longest queued message not counted', () => {
    const { daemon } = connected(4 * 1024 * 1024);
    const out = daemon.mux.messageChannel(2, 64 << 20);
    // one of them, the longest, is not counted; the other three are
    for (let index = 0; index < 3; index++) out.send(new Uint8Array(2 * 1024 * 1024));
    expect(daemon.mux.heldBytes()).toBe(4 * 1024 * 1024);
    expect(daemon.overflowed).toBe(false);
    out.send(new Uint8Array(2 * 1024 * 1024));
    expect(daemon.overflowed).toBe(true);
  });

  it('does not count a message larger than the bound queued behind small ones that have the credit to go out', async () => {
    const { client, daemon } = connected(2 * 1024 * 1024);
    const out = daemon.mux.messageChannel(3, 64 << 20);
    const received: number[] = [];
    client.mux.messageChannel(3, 64 << 20).onMessage((message) => received.push(message.length));
    // a rejoin's replay as measured: sessionCleared, the user message and one 5.4 MB assistant message in one turn
    out.send(new Uint8Array(24));
    out.send(new Uint8Array(34));
    out.send(new Uint8Array(5_400_081));
    expect(daemon.overflowed).toBe(false);
    await vi.waitFor(() => expect(received).toEqual([24, 34, 5_400_081]));
    expect(daemon.overflowed).toBe(false);
  });

  it('settles a message channel\'s drained once its queue is back within the window, and on dispose', async () => {
    const { client, daemon } = connected();
    const out = daemon.mux.messageChannel(2, 64 << 20);
    const into = client.mux.messageChannel(2, 64 << 20);
    await expect(out.drained()).resolves.toBeUndefined();
    let consumed = 0;
    into.onMessage(() => consumed++);
    for (let index = 0; index < 4; index++) out.send(new Uint8Array(MESSAGE_WINDOW_BYTES));
    let drained = false;
    void out.drained().then(() => { drained = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    await vi.waitFor(() => expect(drained).toBe(true));
    expect(consumed).toBeGreaterThanOrEqual(2);
    for (let index = 0; index < 4; index++) out.send(new Uint8Array(MESSAGE_WINDOW_BYTES));
    const stuck = out.drained();
    daemon.mux.dispose();
    await expect(stuck).resolves.toBeUndefined();
  });

  it('counts what a dropped connection holds, and an overflow drops its state so the client attaches fresh', async () => {
    const socket = fakeSocket();
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: MAX_FRAME_BYTES, log });
    protocol.holdOnDrop();
    let overflowed = 0;
    const mux = createMux({ protocol, side: 'daemon', acceptStreams: false, maxHeldBytes: 1024 * 1024, onOverflow: () => { overflowed++; }, onViolation: () => undefined, log });
    const out = mux.messageChannel(2, 64 << 20);
    // sent and never acknowledged
    out.send(new Uint8Array(200 * 1024));
    await vi.waitFor(() => expect(protocol.unackedBytes()).toBeGreaterThan(200 * 1024));
    socket.close();
    expect(protocol.lost()).toBe(true);
    // the longest of the three is not counted; the other two and the unacknowledged bytes stay within the bound
    for (let index = 0; index < 3; index++) out.send(new Uint8Array(300 * 1024));
    expect(mux.heldBytes()).toBeGreaterThan(800 * 1024);
    expect(overflowed).toBe(0);
    out.send(new Uint8Array(300 * 1024));
    expect(overflowed).toBe(1);
    // nothing is held for a resume any more
    expect(mux.heldBytes()).toBe(protocol.unackedBytes());
    protocol.close('done');
  });

  it('counts a message once it went out unacknowledged, so the flush that sends past the bound drops the connection', async () => {
    const socket = fakeSocket();
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: MAX_FRAME_BYTES, log });
    let overflowed = 0;
    const mux = createMux({ protocol, side: 'daemon', acceptStreams: false, maxHeldBytes: 300 * 1024, onOverflow: () => { overflowed++; }, onViolation: () => undefined, log });
    // queued, it is the longest message and not counted; sent within the credit and never acknowledged, it is
    mux.messageChannel(2, 64 << 20).send(new Uint8Array(1024 * 1024));
    expect(overflowed).toBe(0);
    await vi.waitFor(() => expect(overflowed).toBe(1));
    expect(protocol.unackedBytes()).toBeGreaterThan(300 * 1024);
    protocol.close('done');
  });
});
