// Framing, acks, keepalive, replay and the suspect state over one byte connection: a port of VS Code's PersistentProtocol
// (src/vs/base/parts/ipc/common/ipc.net.ts, MIT, see THIRD-PARTY-NOTICES.md).
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { listeners } from './listeners';

// type u8, id u32, ack u32, length u32, big-endian (frozen)
export const HEADER_BYTES = 13;

// Frozen numbering, VS Code's ProtocolMessageType; 5, 7 and 8 (Disconnect, Pause, Resume) are reserved, Pause and Resume
// being the local lost and resumed states here (docs/invariants.md "Remote daemon and wire").
export const MESSAGE_TYPE = { regular: 1, control: 2, ack: 3, replayRequest: 6, keepAlive: 9 } as const;

export const STANDALONE_ACK_BYTES: number = 256 * 1024;
export const STANDALONE_ACK_MS = 2000;
export const KEEPALIVE_MS = 5000;
export const KEEPALIVE_TIMEOUT_MS = 20_000;
// past a missed keepalive or ack deadline with nothing received, the connection is suspect
export const SUSPECT_AFTER_MS = 2000;
// VS Code's: a gap asks the peer to replay at most this often
const REPLAY_REQUEST_INTERVAL_MS = 10_000;
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
  // writes what it holds, then ends; a peer that never ends its side is cut off
  end(): void;
}

export interface ProtocolTiming {
  readonly ackBytes: number;
  readonly ackMs: number;
  readonly keepAliveMs: number;
  readonly keepAliveTimeoutMs: number;
  readonly suspectAfterMs: number;
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
  // sequenced and held until the peer acknowledges it; while the socket is lost it is only held, and replayed on resume
  send(body: Uint8Array): void;
  onControl(listener: (body: Uint8Array) => void): Disposable;
  onMessage(listener: (body: Uint8Array) => void): Disposable;
  // once, with why it closed
  onClose(listener: (reason: string) => void): Disposable;
  onDrain(listener: () => void): Disposable;
  // after holdOnDrop: the socket ended or went silent past the timeout; the protocol waits for resume or close
  onLost(listener: (reason: string) => void): Disposable;
  // since: the missed deadline (epoch ms) the suspect state counts from; undefined once a frame arrived again
  onSuspect(listener: (since: number | undefined) => void): Disposable;
  writable(): boolean;
  // the socket is gone and the protocol waits for resume
  lost(): boolean;
  setMaxBodyBytes(bytes: number): void;
  startKeepAlive(): void;
  // from now on a dropped socket or a silent peer leaves the protocol lost instead of closed
  holdOnDrop(): void;
  // takes a new socket (dropping one still held), reads rest first, and replays every unacknowledged message
  resume(socket: ByteSocket, rest: Uint8Array): void;
  // the bytes of sent regular messages the peer has not acknowledged
  unackedBytes(): number;
  close(reason: string): void;
  // close, but the socket first writes what it holds; held for no resume
  end(reason: string): void;
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

interface Unacked {
  readonly id: number;
  readonly body: Uint8Array;
  // when it was last written, which its ack deadline counts from
  sentAt: number;
}

export function createPersistentProtocol(options: ProtocolOptions): PersistentProtocol {
  const timing: ProtocolTiming = {
    ackBytes: STANDALONE_ACK_BYTES,
    ackMs: STANDALONE_ACK_MS,
    keepAliveMs: KEEPALIVE_MS,
    keepAliveTimeoutMs: KEEPALIVE_TIMEOUT_MS,
    suspectAfterMs: SUSPECT_AFTER_MS,
    ...options.timing,
  };
  let socket: ByteSocket | undefined = options.socket;
  let maxBodyBytes = options.maxBodyBytes;
  const control = listeners<[Uint8Array]>();
  const regular = listeners<[Uint8Array]>();
  const closed = listeners<[string]>(options.log);
  const drained = listeners<[]>(options.log);
  const lostListeners = listeners<[string]>(options.log);
  const suspectListeners = listeners<[number | undefined]>(options.log);
  let ended: string | undefined;
  let detached = false;
  let isWritable = true;
  let holding = false;
  let lostWith: string | undefined;
  let keepAliveWanted = false;

  let lastSentId = 0;
  let lastReceivedId = 0;
  const unacked: Unacked[] = [];
  let unackedTotal = 0;
  let receivedSinceAck = 0;
  let ackTimer: NodeJS.Timeout | undefined;
  let keepAlive: NodeJS.Timeout | undefined;
  let suspectCheck: { readonly at: number; cancel(): void } | undefined;
  let suspectSince: number | undefined;
  let load: { highLoad(): boolean; dispose(): void } | undefined;
  let lastReceivedAt = Date.now();
  let lastReplayRequestAt = -Infinity;
  let lastReplayAnsweredAt = -Infinity;

  let chunks: Uint8Array[] = [];
  let buffered = 0;
  let header: { readonly raw: Uint8Array; readonly type: number; readonly id: number; readonly ack: number; readonly length: number } | undefined;
  let subscriptions: Disposable[] = [];

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
    suspectCheck?.cancel();
    suspectCheck = undefined;
    load?.dispose();
    load = undefined;
  };

  const unsubscribe = (): void => {
    subscriptions.forEach((subscription) => subscription.dispose());
    subscriptions = [];
  };

  const finish = (reason: string, release: (current: ByteSocket) => void): void => {
    if (ended !== undefined || detached) return;
    ended = reason;
    stopTimers();
    unsubscribe();
    if (socket) release(socket);
    closed.fire(reason);
  };
  const close = (reason: string): void => finish(reason, (current) => current.destroy());

  // The socket is gone: what was sent stays unacknowledged for the replay, and a frame read in part is the peer's to replay.
  const lose = (reason: string): void => {
    if (ended !== undefined || detached || lostWith !== undefined) return;
    if (!holding) {
      close(reason);
      return;
    }
    lostWith = reason;
    stopTimers();
    unsubscribe();
    socket?.destroy();
    socket = undefined;
    chunks = [];
    buffered = 0;
    header = undefined;
    suspectSince = undefined;
    lostListeners.fire(reason);
  };

  const writeFrame = (type: number, id: number, body: Uint8Array): void => {
    if (ended !== undefined || detached || !socket) return;
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

  // The earliest missed deadline with nothing received since: the next keepalive, and the oldest unacknowledged message's ack.
  const missedDeadline = (): number => {
    const keepAliveDeadline = lastReceivedAt + timing.keepAliveMs;
    const oldest = unacked[0];
    const ackDeadline = oldest && oldest.sentAt + timing.ackMs > lastReceivedAt ? oldest.sentAt + timing.ackMs : Infinity;
    return Math.min(keepAliveDeadline, ackDeadline);
  };

  const armSuspect = (): void => {
    if (!keepAlive || suspectSince !== undefined) return;
    const at = missedDeadline() + timing.suspectAfterMs;
    if (suspectCheck && at >= suspectCheck.at) return;
    suspectCheck?.cancel();
    const timer = setTimeout(() => {
      // a timer late from a stalled loop runs before the poll phase reads what arrived meanwhile, so decide after it
      const immediate = setImmediate(() => {
        suspectCheck = undefined;
        const deadline = missedDeadline();
        if (Date.now() >= deadline + timing.suspectAfterMs) {
          suspectSince = deadline;
          suspectListeners.fire(deadline);
          return;
        }
        armSuspect();
      });
      check.cancel = () => clearImmediate(immediate);
    }, Math.max(0, at - Date.now()));
    const check = { at, cancel: () => clearTimeout(timer) };
    suspectCheck = check;
  };

  const acknowledged = (ack: number): boolean => {
    if (ack > lastSentId) return false;
    while (unacked.length > 0 && unacked[0]!.id <= ack) unackedTotal -= HEADER_BYTES + unacked.shift()!.body.length;
    return true;
  };

  const scheduleAck = (bytes: number): void => {
    receivedSinceAck += bytes;
    if (receivedSinceAck >= timing.ackBytes) {
      writeFrame(MESSAGE_TYPE.ack, 0, new Uint8Array(0));
      return;
    }
    ackTimer ??= setTimeout(() => {
      ackTimer = undefined;
      writeFrame(MESSAGE_TYPE.ack, 0, new Uint8Array(0));
    }, timing.ackMs);
  };

  const replay = (): void => {
    const now = Date.now();
    for (const message of unacked) {
      message.sentAt = now;
      writeFrame(MESSAGE_TYPE.regular, message.id, message.body);
    }
  };

  const dispatch = (type: number, id: number, ack: number, body: Uint8Array): void => {
    if (!acknowledged(ack)) {
      close(`the peer acknowledged message ${ack}, which was never sent`);
      return;
    }
    switch (type) {
      case MESSAGE_TYPE.regular:
        // a replay resends what already arrived; the ack stops the peer counting it unacknowledged, which would turn it suspect
        if (id <= lastReceivedId) {
          scheduleAck(0);
          return;
        }
        if (id !== lastReceivedId + 1) {
          const now = Date.now();
          if (now - lastReplayRequestAt >= REPLAY_REQUEST_INTERVAL_MS) {
            lastReplayRequestAt = now;
            writeFrame(MESSAGE_TYPE.replayRequest, 0, new Uint8Array(0));
          }
          return;
        }
        lastReceivedId = id;
        scheduleAck(HEADER_BYTES + body.length);
        regular.fire(body);
        return;
      case MESSAGE_TYPE.control:
        control.fire(body);
        return;
      case MESSAGE_TYPE.replayRequest: {
        // an honest peer asks at most once per interval, so asking more often gets no more than that
        const now = Date.now();
        if (now - lastReplayAnsweredAt < REPLAY_REQUEST_INTERVAL_MS) return;
        lastReplayAnsweredAt = now;
        replay();
        return;
      }
      case MESSAGE_TYPE.ack:
      case MESSAGE_TYPE.keepAlive:
        return;
      default:
        close(`a message of unknown type ${type}`);
    }
  };

  const receive = (chunk: Uint8Array): void => {
    if (ended !== undefined || detached || lostWith !== undefined) return;
    lastReceivedAt = Date.now();
    if (suspectSince !== undefined) {
      suspectSince = undefined;
      suspectListeners.fire(undefined);
    }
    chunks.push(chunk);
    buffered += chunk.length;
    try {
      while (ended === undefined && !detached && lostWith === undefined) {
        if (!header) {
          if (buffered < HEADER_BYTES) break;
          const raw = take(HEADER_BYTES);
          const view = new DataView(raw.buffer);
          header = { raw, type: view.getUint8(0), id: view.getUint32(1), ack: view.getUint32(5), length: view.getUint32(9) };
          if (header.length > maxBodyBytes) {
            close(`a message of ${header.length} bytes, over the ${maxBodyBytes} byte bound`);
            return;
          }
        }
        if (buffered < header.length) break;
        const { type, id, ack, length } = header;
        header = undefined;
        dispatch(type, id, ack, take(length));
      }
    } catch (err) {
      // a listener's bug ends this connection, never the process
      close(`handling a message failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    armSuspect();
  };

  const startTimers = (): void => {
    const monitor = options.highLoad ? undefined : eventLoopLoad();
    load = monitor;
    const highLoad = options.highLoad ?? (() => monitor!.highLoad());
    lastReceivedAt = Date.now();
    keepAlive = setInterval(() => {
      // read every tick, so a stall counts only for the interval it happened in
      const busy = highLoad();
      if (Date.now() - lastReceivedAt > timing.keepAliveTimeoutMs && !busy) {
        lose(`nothing arrived in ${timing.keepAliveTimeoutMs} ms`);
        return;
      }
      writeFrame(MESSAGE_TYPE.keepAlive, 0, new Uint8Array(0));
    }, timing.keepAliveMs);
    armSuspect();
  };

  const attach = (next: ByteSocket): void => {
    socket = next;
    isWritable = true;
    subscriptions = [
      next.onData(receive),
      next.onDrain(() => {
        isWritable = true;
        drained.fire();
      }),
      next.onClose((error) => lose(error ? `the connection failed: ${error.message}` : 'the connection closed')),
    ];
  };

  attach(options.socket);

  return {
    sendControl: (body) => writeFrame(MESSAGE_TYPE.control, 0, body),
    send: (body) => {
      if (ended !== undefined || detached) return;
      if (lastSentId === MAX_ID) {
        close('the message ids ran out');
        return;
      }
      const id = ++lastSentId;
      unacked.push({ id, body, sentAt: Date.now() });
      unackedTotal += HEADER_BYTES + body.length;
      writeFrame(MESSAGE_TYPE.regular, id, body);
      if (unacked.length === 1) armSuspect();
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
    onLost: lostListeners.add,
    onSuspect: suspectListeners.add,
    writable: () => isWritable && ended === undefined && lostWith === undefined && socket !== undefined,
    lost: () => lostWith !== undefined,
    setMaxBodyBytes: (bytes) => {
      maxBodyBytes = bytes;
    },
    startKeepAlive: () => {
      if (keepAliveWanted || ended !== undefined) return;
      keepAliveWanted = true;
      if (socket) startTimers();
    },
    holdOnDrop: () => {
      holding = true;
    },
    resume: (next, rest) => {
      if (ended !== undefined || detached) {
        next.destroy();
        return;
      }
      // a socket the peer already replaced (the daemon has not seen its drop yet) goes without a lost event
      stopTimers();
      unsubscribe();
      socket?.destroy();
      chunks = [];
      buffered = 0;
      header = undefined;
      lostWith = undefined;
      suspectSince = undefined;
      attach(next);
      replay();
      if (keepAliveWanted) startTimers();
      if (rest.length > 0) receive(rest);
      drained.fire();
    },
    unackedBytes: () => unackedTotal,
    close,
    end: (reason) => finish(reason, (current) => current.end()),
    detach: () => {
      detached = true;
      stopTimers();
      unsubscribe();
      socket?.pause();
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
