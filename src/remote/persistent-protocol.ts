// Framing, acks and keepalive over one byte connection: a port of VS Code's PersistentProtocol (src/vs/base/parts/ipc/common/
// ipc.net.ts, MIT, see THIRD-PARTY-NOTICES.md). Replay, ReplayRequest, the suspect state, Pause and Resume are not built yet.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { listeners } from './listeners';

// type u8, id u32, ack u32, length u32, big-endian (frozen)
export const HEADER_BYTES = 13;

// Frozen numbering, VS Code's ProtocolMessageType; 5 to 8 (Disconnect, ReplayRequest, Pause, Resume) are reserved.
export const MESSAGE_TYPE = { regular: 1, control: 2, ack: 3, keepAlive: 9 } as const;

export const STANDALONE_ACK_BYTES: number = 256 * 1024;
export const STANDALONE_ACK_MS = 2000;
export const KEEPALIVE_MS = 5000;
export const KEEPALIVE_TIMEOUT_MS = 20_000;
// An event loop that stalled this long since the last keepalive check explains a silence; the timeout waits for the next one.
const HIGH_LOAD_DELAY_NS = 1e9;
const MAX_ID = 0xffff_ffff;

export interface Disposable {
  dispose(): void;
}

/** A byte connection: a socket, a pipe or a child's stdio. */
export interface ByteSocket {
  // false: the socket buffers past its high water mark; wait for onDrain
  write(bytes: Uint8Array): boolean;
  onData(listener: (chunk: Uint8Array) => void): Disposable;
  onDrain(listener: () => void): Disposable;
  onClose(listener: (error: Error | undefined) => void): Disposable;
  // stops reading until the next owner reads again; nothing arrives meanwhile
  pause(): void;
  // stops both directions at once
  destroy(): void;
}

export interface ProtocolTiming {
  readonly ackBytes: number;
  readonly ackMs: number;
  readonly keepAliveMs: number;
  readonly keepAliveTimeoutMs: number;
}

export interface ProtocolOptions {
  readonly socket: ByteSocket;
  // a header announcing a longer body closes the connection before the body is buffered
  readonly maxBodyBytes: number;
  readonly timing?: Partial<ProtocolTiming>;
  // whether the event loop was too busy for a silence to mean a dead peer; perf_hooks' event loop delay by default
  readonly highLoad?: () => boolean;
  readonly log: (line: string) => void;
}

export interface PersistentProtocol {
  // unsequenced; the handshake
  sendControl(body: Uint8Array): void;
  // sequenced and held until the peer acknowledges it
  send(body: Uint8Array): void;
  onControl(listener: (body: Uint8Array) => void): Disposable;
  onMessage(listener: (body: Uint8Array) => void): Disposable;
  // once, with why it closed
  onClose(listener: (reason: string) => void): Disposable;
  onDrain(listener: () => void): Disposable;
  writable(): boolean;
  setMaxBodyBytes(bytes: number): void;
  startKeepAlive(): void;
  // the bytes of sent regular messages the peer has not acknowledged
  unackedBytes(): number;
  close(reason: string): void;
  // stops reading and writing without closing the socket, pauses it, and hands over the bytes read past the last message;
  // the next owner reads from the socket and takes its errors before the event loop turns
  detach(): Uint8Array;
}


function eventLoopLoad(): { highLoad(): boolean; dispose(): void } {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  return {
    highLoad: () => {
      const high = histogram.max >= HIGH_LOAD_DELAY_NS;
      histogram.reset();
      return high;
    },
    dispose: () => histogram.disable(),
  };
}

export function createPersistentProtocol(options: ProtocolOptions): PersistentProtocol {
  const { socket } = options;
  const timing: ProtocolTiming = { ackBytes: STANDALONE_ACK_BYTES, ackMs: STANDALONE_ACK_MS, keepAliveMs: KEEPALIVE_MS, keepAliveTimeoutMs: KEEPALIVE_TIMEOUT_MS, ...options.timing };
  let maxBodyBytes = options.maxBodyBytes;
  const control = listeners<[Uint8Array]>();
  const regular = listeners<[Uint8Array]>();
  const closed = listeners<[string]>(options.log);
  const drained = listeners<[]>(options.log);
  let ended: string | undefined;
  let detached = false;
  let isWritable = true;

  let lastSentId = 0;
  let lastReceivedId = 0;
  const unacked: Array<{ readonly id: number; readonly bytes: number }> = [];
  let unackedTotal = 0;
  let receivedSinceAck = 0;
  let ackTimer: NodeJS.Timeout | undefined;
  let keepAlive: NodeJS.Timeout | undefined;
  let load: { highLoad(): boolean; dispose(): void } | undefined;
  let lastReceivedAt = Date.now();

  let chunks: Uint8Array[] = [];
  let buffered = 0;
  let header: { readonly raw: Uint8Array; readonly type: number; readonly id: number; readonly ack: number; readonly length: number } | undefined;

  const take = (count: number): Uint8Array => {
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const chunk = chunks[0]!;
      const used = Math.min(chunk.length, count - filled);
      out.set(chunk.subarray(0, used), filled);
      filled += used;
      if (used === chunk.length) chunks.shift();
      else chunks[0] = chunk.subarray(used);
    }
    buffered -= count;
    return out;
  };

  const stopTimers = (): void => {
    clearTimeout(ackTimer);
    ackTimer = undefined;
    clearInterval(keepAlive);
    keepAlive = undefined;
    load?.dispose();
    load = undefined;
  };

  const close = (reason: string): void => {
    if (ended !== undefined || detached) return;
    ended = reason;
    stopTimers();
    subscriptions.forEach((subscription) => subscription.dispose());
    socket.destroy();
    closed.fire(reason);
  };

  const write = (type: number, id: number, body: Uint8Array): void => {
    if (ended !== undefined || detached) return;
    const frame = new Uint8Array(HEADER_BYTES + body.length);
    const view = new DataView(frame.buffer);
    view.setUint8(0, type);
    view.setUint32(1, id);
    view.setUint32(5, lastReceivedId);
    view.setUint32(9, body.length);
    frame.set(body, HEADER_BYTES);
    // every message carries the ack
    receivedSinceAck = 0;
    clearTimeout(ackTimer);
    ackTimer = undefined;
    isWritable = socket.write(frame);
  };

  const acknowledged = (ack: number): boolean => {
    if (ack > lastSentId) return false;
    while (unacked.length > 0 && unacked[0]!.id <= ack) unackedTotal -= unacked.shift()!.bytes;
    return true;
  };

  const scheduleAck = (bytes: number): void => {
    receivedSinceAck += bytes;
    if (receivedSinceAck >= timing.ackBytes) {
      write(MESSAGE_TYPE.ack, 0, new Uint8Array(0));
      return;
    }
    ackTimer ??= setTimeout(() => {
      ackTimer = undefined;
      write(MESSAGE_TYPE.ack, 0, new Uint8Array(0));
    }, timing.ackMs);
  };

  const dispatch = (type: number, id: number, ack: number, body: Uint8Array): void => {
    if (!acknowledged(ack)) {
      close(`the peer acknowledged message ${ack}, which was never sent`);
      return;
    }
    switch (type) {
      case MESSAGE_TYPE.regular:
        if (id !== lastReceivedId + 1) {
          close(`message ${id} arrived after ${lastReceivedId}`);
          return;
        }
        lastReceivedId = id;
        scheduleAck(HEADER_BYTES + body.length);
        regular.fire(body);
        return;
      case MESSAGE_TYPE.control:
        control.fire(body);
        return;
      case MESSAGE_TYPE.ack:
      case MESSAGE_TYPE.keepAlive:
        return;
      default:
        close(`a message of unknown type ${type}`);
    }
  };

  const receive = (chunk: Uint8Array): void => {
    if (ended !== undefined || detached) return;
    lastReceivedAt = Date.now();
    chunks.push(chunk);
    buffered += chunk.length;
    try {
      while (ended === undefined && !detached) {
        if (!header) {
          if (buffered < HEADER_BYTES) return;
          const raw = take(HEADER_BYTES);
          const view = new DataView(raw.buffer);
          header = { raw, type: view.getUint8(0), id: view.getUint32(1), ack: view.getUint32(5), length: view.getUint32(9) };
          if (header.length > maxBodyBytes) {
            close(`a message of ${header.length} bytes, over the ${maxBodyBytes} byte bound`);
            return;
          }
        }
        if (buffered < header.length) return;
        const { type, id, ack, length } = header;
        header = undefined;
        dispatch(type, id, ack, take(length));
      }
    } catch (err) {
      // a listener's bug ends this connection, never the process
      close(`handling a message failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const subscriptions = [
    socket.onData(receive),
    socket.onDrain(() => {
      isWritable = true;
      drained.fire();
    }),
    socket.onClose((error) => close(error ? `the connection failed: ${error.message}` : 'the connection closed')),
  ];

  return {
    sendControl: (body) => write(MESSAGE_TYPE.control, 0, body),
    send: (body) => {
      if (ended !== undefined || detached) return;
      if (lastSentId === MAX_ID) {
        close('the message ids ran out');
        return;
      }
      const id = ++lastSentId;
      unacked.push({ id, bytes: HEADER_BYTES + body.length });
      unackedTotal += HEADER_BYTES + body.length;
      write(MESSAGE_TYPE.regular, id, body);
    },
    onControl: control.add,
    onMessage: regular.add,
    onClose: (listener) => {
      if (ended !== undefined) {
        listener(ended);
        return { dispose: () => undefined };
      }
      return closed.add(listener);
    },
    onDrain: drained.add,
    writable: () => isWritable && ended === undefined,
    setMaxBodyBytes: (bytes) => {
      maxBodyBytes = bytes;
    },
    startKeepAlive: () => {
      if (keepAlive || ended !== undefined) return;
      const monitor = options.highLoad ? undefined : eventLoopLoad();
      load = monitor;
      const highLoad = options.highLoad ?? (() => monitor!.highLoad());
      lastReceivedAt = Date.now();
      keepAlive = setInterval(() => {
        // read every tick, so a stall counts only for the interval it happened in
        const busy = highLoad();
        if (Date.now() - lastReceivedAt > timing.keepAliveTimeoutMs && !busy) {
          close(`nothing arrived in ${timing.keepAliveTimeoutMs} ms`);
          return;
        }
        write(MESSAGE_TYPE.keepAlive, 0, new Uint8Array(0));
      }, timing.keepAliveMs);
    },
    unackedBytes: () => unackedTotal,
    close,
    detach: () => {
      detached = true;
      stopTimers();
      subscriptions.forEach((subscription) => subscription.dispose());
      socket.pause();
      const pending = header?.raw ?? new Uint8Array(0);
      const body = take(buffered);
      const rest = new Uint8Array(pending.length + body.length);
      rest.set(pending);
      rest.set(body, pending.length);
      header = undefined;
      chunks = [];
      return rest;
    },
  };
}
