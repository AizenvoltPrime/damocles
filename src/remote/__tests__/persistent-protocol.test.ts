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

  it('closes on an ack of a message never sent and an unknown type', () => {
    const cases = [
      message(MESSAGE_TYPE.control, 0, 5, new Uint8Array(0)),
      message(5, 0, 0, new Uint8Array(0)),
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

  it('asks for a replay on a gap in ids, drops the out-of-order message and ignores duplicates', () => {
    const socket = fakeSocket();
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: 100, log });
    const got: number[] = [];
    protocol.onMessage((body) => got.push(body[0]!));
    socket.receive(message(MESSAGE_TYPE.regular, 1, 0, Uint8Array.of(1)));
    socket.receive(message(MESSAGE_TYPE.regular, 3, 0, Uint8Array.of(3)));
    expect(socket.written.map(parseHeader)).toEqual([{ type: MESSAGE_TYPE.replayRequest, id: 0, ack: 1, length: 0 }]);
    // at most one request per interval
    socket.receive(message(MESSAGE_TYPE.regular, 4, 0, Uint8Array.of(4)));
    expect(socket.written).toHaveLength(1);
    socket.receive(message(MESSAGE_TYPE.regular, 1, 0, Uint8Array.of(1)));
    socket.receive(message(MESSAGE_TYPE.regular, 2, 0, Uint8Array.of(2)));
    socket.receive(message(MESSAGE_TYPE.regular, 3, 0, Uint8Array.of(3)));
    expect(got).toEqual([1, 2, 3]);
    protocol.close('done');
  });

  it('resends every unacknowledged message when the peer asks for a replay', () => {
    const socket = fakeSocket();
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: 100, log });
    protocol.send(Uint8Array.of(1));
    protocol.send(Uint8Array.of(2));
    protocol.send(Uint8Array.of(3));
    socket.written.length = 0;
    socket.receive(message(MESSAGE_TYPE.replayRequest, 0, 1, new Uint8Array(0)));
    expect(socket.written.map(parseHeader)).toEqual([
      { type: MESSAGE_TYPE.regular, id: 2, ack: 0, length: 1 },
      { type: MESSAGE_TYPE.regular, id: 3, ack: 0, length: 1 },
    ]);
    protocol.close('done');
  });

  it('answers at most one replay request per interval, however often the peer asks', () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: 100, log });
    protocol.send(Uint8Array.of(1));
    socket.written.length = 0;
    const replayed = (): number => socket.written.filter((frame) => parseHeader(frame).type === MESSAGE_TYPE.regular).length;
    socket.receive(message(MESSAGE_TYPE.replayRequest, 0, 0, new Uint8Array(0)));
    socket.receive(message(MESSAGE_TYPE.replayRequest, 0, 0, new Uint8Array(0)));
    vi.advanceTimersByTime(9999);
    socket.receive(message(MESSAGE_TYPE.replayRequest, 0, 0, new Uint8Array(0)));
    expect(replayed()).toBe(1);
    vi.advanceTimersByTime(1);
    socket.receive(message(MESSAGE_TYPE.replayRequest, 0, 0, new Uint8Array(0)));
    expect(replayed()).toBe(2);
    protocol.close('done');
  });

  it('acknowledges a replayed message it already has, so a resumed peer with nothing else to hear never turns suspect', () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: 100, log });
    socket.receive(message(MESSAGE_TYPE.regular, 1, 0, Uint8Array.of(1)));
    vi.advanceTimersByTime(2000);
    socket.written.length = 0;
    // the peer never saw that ack and replays the message after a resume
    socket.receive(message(MESSAGE_TYPE.regular, 1, 0, Uint8Array.of(1)));
    vi.advanceTimersByTime(2000);
    expect(socket.written.map(parseHeader)).toEqual([{ type: MESSAGE_TYPE.ack, id: 0, ack: 1, length: 0 }]);
    protocol.close('done');
  });

  it('ends gracefully: the socket writes what it holds, the protocol closes with the reason and holds nothing for a resume', () => {
    const socket = fakeSocket();
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: 100, log });
    protocol.holdOnDrop();
    const lost: string[] = [];
    const closes: string[] = [];
    protocol.onLost((reason) => lost.push(reason));
    protocol.onClose((reason) => closes.push(reason));
    protocol.end('the client disconnected');
    expect(socket.ended()).toBe(true);
    expect(socket.destroyed()).toBe(false);
    socket.close();
    expect(closes).toEqual(['the client disconnected']);
    expect(lost).toEqual([]);
  });

  it('delivers what a stream socket holds before its end reaches the peer', async () => {
    const [ours, theirs] = duplexPair();
    const socket = streamSocket(ours);
    const read: number[] = [];
    theirs.on('data', (chunk: Buffer) => read.push(...chunk));
    const ended = new Promise((resolve) => theirs.once('end', resolve));
    socket.write(Uint8Array.from([7, 8, 9]));
    socket.end();
    await ended;
    expect(read).toEqual([7, 8, 9]);
    theirs.destroy();
  });

  it('holds a dropped socket\'s state and replays the unacknowledged messages on resume, the rest bytes read first', () => {
    const first = fakeSocket();
    const protocol = createPersistentProtocol({ socket: first, maxBodyBytes: 100, log });
    protocol.holdOnDrop();
    const got: number[] = [];
    const lost: string[] = [];
    const closes: string[] = [];
    protocol.onMessage((body) => got.push(body[0]!));
    protocol.onLost((reason) => lost.push(reason));
    protocol.onClose((reason) => closes.push(reason));
    protocol.send(Uint8Array.of(1));
    protocol.send(Uint8Array.of(2));
    first.receive(message(MESSAGE_TYPE.regular, 1, 1, Uint8Array.of(10)));
    first.close();
    expect(lost).toEqual(['the connection closed']);
    expect(closes).toEqual([]);
    expect(protocol.lost()).toBe(true);
    expect(protocol.writable()).toBe(false);
    // held while lost, written by the replay
    protocol.send(Uint8Array.of(3));
    const second = fakeSocket();
    protocol.resume(second, message(MESSAGE_TYPE.regular, 2, 3, Uint8Array.of(20)));
    expect(second.written.map(parseHeader)).toEqual([
      { type: MESSAGE_TYPE.regular, id: 2, ack: 1, length: 1 },
      { type: MESSAGE_TYPE.regular, id: 3, ack: 1, length: 1 },
    ]);
    expect(got).toEqual([10, 20]);
    expect(protocol.unackedBytes()).toBe(0);
    expect(protocol.lost()).toBe(false);
    // the peer's replay of what already arrived is dropped, and asks for nothing
    second.receive(message(MESSAGE_TYPE.regular, 1, 3, Uint8Array.of(10)));
    expect(got).toEqual([10, 20]);
    expect(second.written.map(parseHeader).some((frame) => frame.type === MESSAGE_TYPE.replayRequest)).toBe(false);
    protocol.close('done');
  });

  it('replaces a socket the peer already left, dropping the old one without a lost event', () => {
    const first = fakeSocket();
    const protocol = createPersistentProtocol({ socket: first, maxBodyBytes: 100, log });
    protocol.holdOnDrop();
    const lost: string[] = [];
    protocol.onLost((reason) => lost.push(reason));
    protocol.send(Uint8Array.of(1));
    const second = fakeSocket();
    protocol.resume(second, new Uint8Array(0));
    expect(first.destroyed()).toBe(true);
    first.close();
    expect(lost).toEqual([]);
    expect(second.written.map(parseHeader)).toEqual([{ type: MESSAGE_TYPE.regular, id: 1, ack: 0, length: 1 }]);
    protocol.close('done');
  });

  it('turns suspect 2 s past the missed keepalive deadline, and any frame clears it', () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: 100, log, highLoad: () => false });
    const suspects: Array<number | undefined> = [];
    protocol.onSuspect((since) => suspects.push(since));
    const start = Date.now();
    protocol.startKeepAlive();
    vi.advanceTimersByTime(6999);
    expect(suspects).toEqual([]);
    // the fake clock runs an immediate set inside a timer 1 ms later, so a suspect decision lands 1 ms past its timer
    vi.advanceTimersByTime(2);
    expect(suspects).toEqual([start + 5000]);
    socket.receive(message(MESSAGE_TYPE.keepAlive, 0, 0, new Uint8Array(0)));
    expect(suspects).toEqual([start + 5000, undefined]);
    protocol.close('done');
  });

  it('decides suspect only after the loop read what arrived while it stalled past the deadline', () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: 100, log, highLoad: () => false });
    const suspects: Array<number | undefined> = [];
    protocol.onSuspect((since) => suspects.push(since));
    const start = Date.now();
    protocol.startKeepAlive();
    // the loop stalls from 4 s to past 7 s: the late timers run first (the keepalive, then the suspect timer), and only
    // the poll phase after them reads the peer's keepalive that arrived at 5 s
    vi.advanceTimersByTime(4000);
    vi.advanceTimersToNextTimer();
    vi.advanceTimersToNextTimer();
    expect(Date.now()).toBe(start + 7000);
    socket.receive(message(MESSAGE_TYPE.keepAlive, 0, 0, new Uint8Array(0)));
    vi.advanceTimersByTime(1);
    expect(suspects).toEqual([]);
    // re-armed from that frame
    vi.advanceTimersByTime(6999);
    expect(suspects).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(suspects).toEqual([start + 12_000]);
    protocol.close('done');
  });

  it('turns suspect 2 s past the missed ack deadline of the oldest unacknowledged message', () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: 100, log, highLoad: () => false });
    const suspects: Array<number | undefined> = [];
    protocol.onSuspect((since) => suspects.push(since));
    const start = Date.now();
    protocol.startKeepAlive();
    vi.advanceTimersByTime(500);
    socket.receive(message(MESSAGE_TYPE.keepAlive, 0, 0, new Uint8Array(0)));
    vi.advanceTimersByTime(500);
    protocol.send(Uint8Array.of(1));
    // the ack deadline (send + 2 s) comes before the keepalive one (last frame + 5 s)
    vi.advanceTimersByTime(3999);
    expect(suspects).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(suspects).toEqual([start + 3000]);
    protocol.close('done');
  });

  it('counts a missed ack deadline only while nothing arrived after it', () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: 100, log, highLoad: () => false });
    const suspects: Array<number | undefined> = [];
    protocol.onSuspect((since) => suspects.push(since));
    protocol.startKeepAlive();
    protocol.send(Uint8Array.of(1));
    vi.advanceTimersByTime(3000);
    const keepAliveAt = Date.now();
    socket.receive(message(MESSAGE_TYPE.keepAlive, 0, 0, new Uint8Array(0)));
    vi.advanceTimersByTime(6999);
    expect(suspects).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(suspects).toEqual([keepAliveAt + 5000]);
    protocol.close('done');
  });

  it('after holdOnDrop, 20 s of silence loses the socket instead of closing the protocol', () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: 100, log, highLoad: () => false });
    protocol.holdOnDrop();
    const lost: string[] = [];
    const closes: string[] = [];
    protocol.onLost((reason) => lost.push(reason));
    protocol.onClose((reason) => closes.push(reason));
    protocol.startKeepAlive();
    vi.advanceTimersByTime(25_000);
    expect(lost).toEqual(['nothing arrived in 20000 ms']);
    expect(closes).toEqual([]);
    expect(socket.destroyed()).toBe(true);
    protocol.close('the grace ended');
    expect(closes).toEqual(['the grace ended']);
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
