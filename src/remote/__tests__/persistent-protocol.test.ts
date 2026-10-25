import { duplexPair } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPersistentProtocol, HEADER_BYTES, MESSAGE_TYPE, STANDALONE_ACK_BYTES } from '../persistent-protocol';
import { streamSocket } from '../stream-transport';
import { fakeSocket, header, message, parseHeader, socketPair } from './sockets';

const log = (): void => undefined;

afterEach(() => {
  vi.useRealTimers();
});

describe('PersistentProtocol', () => {
  it('frames regular and control messages across chunk boundaries', async () => {
    const [a, b] = socketPair();
    const sender = createPersistentProtocol({ socket: a, maxBodyBytes: 1 << 20, log });
    const receiver = createPersistentProtocol({ socket: b, maxBodyBytes: 1 << 20, log });
    const got: string[] = [];
    receiver.onMessage((body) => got.push(`m:${Buffer.from(body).toString()}`));
    receiver.onControl((body) => got.push(`c:${Buffer.from(body).toString()}`));
    sender.sendControl(Buffer.from('hello'));
    sender.send(Buffer.from('one'));
    sender.send(new Uint8Array(200_000).fill(65));
    sender.send(Buffer.from(''));
    await vi.waitFor(() => expect(got).toHaveLength(4));
    expect(got[0]).toBe('c:hello');
    expect(got[1]).toBe('m:one');
    expect(got[2]).toHaveLength(2 + 200_000);
    expect(got[3]).toBe('m:');
    sender.close('done');
    receiver.close('done');
  });

  it('carries the ack on every outgoing message and drops acknowledged messages', () => {
    const socket = fakeSocket();
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: 1024, log });
    protocol.send(new Uint8Array(10));
    protocol.send(new Uint8Array(20));
    expect(protocol.unackedBytes()).toBe(2 * HEADER_BYTES + 30);
    socket.receive(message(MESSAGE_TYPE.regular, 1, 1, new Uint8Array(1)));
    expect(protocol.unackedBytes()).toBe(HEADER_BYTES + 20);
    protocol.sendControl(new Uint8Array(0));
    expect(parseHeader(socket.written.at(-1)!)).toMatchObject({ type: MESSAGE_TYPE.control, ack: 1 });
    socket.receive(message(MESSAGE_TYPE.ack, 0, 2, new Uint8Array(0)));
    expect(protocol.unackedBytes()).toBe(0);
    protocol.close('done');
  });

  it('sends a standalone ack once 256 KiB arrived', () => {
    const socket = fakeSocket();
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: 1 << 20, log });
    const body = new Uint8Array(64 * 1024);
    for (let id = 1; id <= 3; id++) socket.receive(message(MESSAGE_TYPE.regular, id, 0, body));
    expect(socket.written).toHaveLength(0);
    socket.receive(message(MESSAGE_TYPE.regular, 4, 0, body));
    expect((4 * (body.length + HEADER_BYTES)) >= STANDALONE_ACK_BYTES).toBe(true);
    expect(socket.written.map(parseHeader)).toEqual([{ type: MESSAGE_TYPE.ack, id: 0, ack: 4, length: 0 }]);
    protocol.close('done');
  });

  it('sends a standalone ack 2 s after the first unacknowledged message', () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: 1024, log });
    socket.receive(message(MESSAGE_TYPE.regular, 1, 0, new Uint8Array(5)));
    vi.advanceTimersByTime(1000);
    socket.receive(message(MESSAGE_TYPE.regular, 2, 0, new Uint8Array(5)));
    vi.advanceTimersByTime(999);
    expect(socket.written).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(socket.written.map(parseHeader)).toEqual([{ type: MESSAGE_TYPE.ack, id: 0, ack: 2, length: 0 }]);
    protocol.close('done');
  });

  it('closes on a header announcing a body over the bound, before buffering it', () => {
    const socket = fakeSocket();
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: 100, log });
    const reasons: string[] = [];
    protocol.onClose((reason) => reasons.push(reason));
    socket.receive(header(MESSAGE_TYPE.control, 0, 0, 101));
    expect(reasons).toEqual(['a message of 101 bytes, over the 100 byte bound']);
    expect(socket.destroyed()).toBe(true);
    expect(socket.written).toHaveLength(0);
  });

  it('closes on a gap in ids, an ack of a message never sent and an unknown type', () => {
    const cases = [
      message(MESSAGE_TYPE.regular, 2, 0, new Uint8Array(0)),
      message(MESSAGE_TYPE.control, 0, 5, new Uint8Array(0)),
      message(6, 0, 0, new Uint8Array(0)),
    ];
    for (const frame of cases) {
      const socket = fakeSocket();
      const protocol = createPersistentProtocol({ socket, maxBodyBytes: 100, log });
      const reasons: string[] = [];
      protocol.onClose((reason) => reasons.push(reason));
      socket.receive(frame);
      expect(reasons).toHaveLength(1);
      expect(socket.destroyed()).toBe(true);
    }
  });

  it('ends only the connection when a message listener throws, and isolates close listeners', () => {
    const socket = fakeSocket();
    const lines: string[] = [];
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: 100, log: (line) => lines.push(line) });
    const reasons: string[] = [];
    protocol.onMessage(() => {
      throw new Error('handler bug');
    });
    protocol.onClose(() => {
      throw new Error('close listener bug');
    });
    protocol.onClose((reason) => reasons.push(reason));
    expect(() => socket.receive(message(MESSAGE_TYPE.regular, 1, 0, new Uint8Array(1)))).not.toThrow();
    expect(reasons).toEqual(['handling a message failed: handler bug']);
    expect(lines.some((line) => line.includes('close listener bug'))).toBe(true);
  });

  it('sends keepalives and closes after 20 s of silence, except under load', () => {
    vi.useFakeTimers();
    let busy = false;
    const socket = fakeSocket();
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: 100, log, highLoad: () => busy });
    const reasons: string[] = [];
    protocol.onClose((reason) => reasons.push(reason));
    expect(socket.written).toHaveLength(0);
    protocol.startKeepAlive();
    vi.advanceTimersByTime(5000);
    expect(socket.written.map((frame) => parseHeader(frame).type)).toEqual([MESSAGE_TYPE.keepAlive]);
    busy = true;
    vi.advanceTimersByTime(30_000);
    expect(reasons).toEqual([]);
    busy = false;
    vi.advanceTimersByTime(5000);
    expect(reasons).toEqual(['nothing arrived in 20000 ms']);
  });

  it('keeps a peer that answers alive', () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: 100, log, highLoad: () => false });
    const reasons: string[] = [];
    protocol.onClose((reason) => reasons.push(reason));
    protocol.startKeepAlive();
    for (let tick = 0; tick < 20; tick++) {
      vi.advanceTimersByTime(5000);
      socket.receive(message(MESSAGE_TYPE.keepAlive, 0, 0, new Uint8Array(0)));
    }
    expect(reasons).toEqual([]);
    protocol.close('done');
  });

  it('hands over the bytes read past the last message on detach', () => {
    const socket = fakeSocket();
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: 100, log });
    const next = message(MESSAGE_TYPE.control, 0, 0, Uint8Array.from([1, 2, 3]));
    const frame = new Uint8Array(13 + 3 + 5);
    frame.set(message(MESSAGE_TYPE.control, 0, 0, Uint8Array.from([9, 9, 9])));
    frame.set(next.subarray(0, 5), 16);
    const controls: number[] = [];
    protocol.onControl((body) => controls.push(body.length));
    socket.receive(frame);
    expect(controls).toEqual([3]);
    expect([...protocol.detach()]).toEqual([...next.subarray(0, 5)]);
    expect(socket.destroyed()).toBe(false);
  });

  it('leaves a detached stream paused, so bytes that arrive before the next owner reads are kept', async () => {
    const [ours, theirs] = duplexPair();
    const protocol = createPersistentProtocol({ socket: streamSocket(ours), maxBodyBytes: 100, log });
    protocol.detach();
    theirs.write(Uint8Array.from([4, 5, 6]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const read: number[] = [];
    ours.on('data', (chunk: Buffer) => read.push(...chunk)).resume();
    await vi.waitFor(() => expect(read).toEqual([4, 5, 6]));
  });
});
