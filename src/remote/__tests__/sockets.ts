import { duplexPair } from 'node:stream';
import type { ByteSocket, Disposable } from '../persistent-protocol';
import { streamSocket } from '../stream-transport';

/** Two connected in-memory sockets with Node's stream buffering and backpressure. */
export function socketPair(): [ByteSocket, ByteSocket] {
  const [a, b] = duplexPair();
  return [streamSocket(a), streamSocket(b)];
}

export interface FakeSocket extends ByteSocket {
  readonly written: Uint8Array[];
  receive(bytes: Uint8Array): void;
  close(): void;
  destroyed(): boolean;
}

/** A socket that records every write and is fed by hand. */
export function fakeSocket(): FakeSocket {
  const data = new Set<(chunk: Uint8Array) => void>();
  const closes = new Set<(error: Error | undefined) => void>();
  const add = <T>(set: Set<T>, listener: T): Disposable => {
    set.add(listener);
    return { dispose: () => { set.delete(listener); } };
  };
  let destroyed = false;
  const written: Uint8Array[] = [];
  return {
    written,
    write: (bytes) => {
      written.push(bytes.slice());
      return true;
    },
    onData: (listener) => add(data, listener),
    onDrain: () => ({ dispose: () => undefined }),
    onClose: (listener) => add(closes, listener),
    pause: () => undefined,
    destroy: () => {
      destroyed = true;
    },
    receive: (bytes) => {
      for (const listener of [...data]) listener(bytes);
    },
    close: () => {
      for (const listener of [...closes]) listener(undefined);
    },
    destroyed: () => destroyed,
  };
}

export function header(type: number, id: number, ack: number, length: number): Uint8Array {
  const out = new Uint8Array(13);
  const view = new DataView(out.buffer);
  view.setUint8(0, type);
  view.setUint32(1, id);
  view.setUint32(5, ack);
  view.setUint32(9, length);
  return out;
}

export function message(type: number, id: number, ack: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(13 + body.length);
  out.set(header(type, id, ack, body.length));
  out.set(body, 13);
  return out;
}

export function parseHeader(frame: Uint8Array): { type: number; id: number; ack: number; length: number } {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return { type: view.getUint8(0), id: view.getUint32(1), ack: view.getUint32(5), length: view.getUint32(9) };
}
