// Channels over one PersistentProtocol. Each regular message body is one frame (frozen): channel id (VQL), kind u8, flags
// u8, body. A message over FRAGMENT_BYTES goes out as data frames with MORE, joined per channel; a sender sends only within
// the credit its receiver granted, and the scheduler writes round-robin over the channels with a frame and credit.
import { listeners, type Listeners } from './listeners';
import type { Disposable, PersistentProtocol } from './persistent-protocol';

export const CHANNEL = { control: 1, workspace: 2, core: 3, ports: 4 } as const;
// Fixed ids are below FIRST_DYNAMIC; the client opens even ids from 16, the daemon odd ids from 17.
export const FIRST_DYNAMIC = 16;

export const FRAGMENT_BYTES: number = 64 * 1024;
export const MESSAGE_WINDOW_BYTES: number = 1024 * 1024;
export const STREAM_WINDOW_BYTES: number = 256 * 1024;
// frames sent and unacknowledged plus frames queued, live or dropped; the longest message queued on each message channel is
// not counted (docs/invariants.md "Remote daemon and wire")
export const MAX_HELD_BYTES: number = 64 * 1024 * 1024;
// the largest frame body: a fragment, its channel id and its two bytes
export const MAX_FRAME_BYTES: number = FRAGMENT_BYTES + 16;
// streams open at once on one connection, both sides' together
export const MAX_OPEN_STREAMS = 1024;

const KIND = { open: 0, data: 1, credit: 2, close: 3 } as const;
const MORE = 1;

export interface MessageChannel {
  readonly id: number;
  send(message: Uint8Array): void;
  onMessage(listener: (message: Uint8Array) => void): Disposable;
  // settles once the channel's queue is within its window, or the mux is disposed; a producer that can wait awaits it
  drained(): Promise<void>;
}

export interface StreamChannel {
  readonly id: number;
  // the connection is gone: writes are dropped and nothing more arrives; closing fires onDrain and onEnd once
  readonly closed: boolean;
  // false: the bytes queued past the window, so wait for onDrain, or the stream is closed
  write(bytes: Uint8Array): boolean;
  end(): void;
  onData(listener: (bytes: Uint8Array) => void): Disposable;
  onEnd(listener: () => void): Disposable;
  onDrain(listener: () => void): Disposable;
}

export interface MuxOptions {
  readonly protocol: Pick<PersistentProtocol, 'send' | 'onMessage' | 'writable' | 'onDrain' | 'unackedBytes'>;
  readonly side: 'client' | 'daemon';
  readonly maxHeldBytes?: number;
  // the held frames passed the bound: the connection's state is dropped and the client attaches fresh
  readonly onOverflow: () => void;
  // a frame outside the format; the connection closes
  readonly onViolation: (reason: string) => void;
  // whether the peer may open streams; an open otherwise is a violation
  readonly acceptStreams: boolean;
  readonly log: (line: string) => void;
}

export interface Mux {
  // a fixed channel, open on both sides from the start; maxMessageBytes bounds a joined message
  messageChannel(id: number, maxMessageBytes: number): MessageChannel;
  // reserved: an id reserveStream gave, so an answer can name a stream before it opens
  openStream(reserved?: number): StreamChannel;
  // the next stream id, opened later in order
  reserveStream(): number;
  // a stream the peer opened
  onStream(listener: (stream: StreamChannel) => void): Disposable;
  // bytes held for the connection as the bound counts them
  heldBytes(): number;
  // settles once every frame queued before the call was handed to the protocol, or the mux is disposed
  drained(): Promise<void>;
  dispose(): void;
}

interface Queued {
  readonly bytes: Uint8Array;
  offset: number;
  readonly end?: true;
}

interface Outgoing {
  readonly id: number;
  readonly window: number;
  credit: number;
  // message channels: whole messages, the head one partly sent; streams: byte chunks and the end marker
  readonly queue: Queued[];
  // message channels: queued messages, each longer than every one queued after it, so the first is the longest
  readonly longest: Queued[];
  queuedBytes: number;
  // queue items pushed and fully handed to the protocol, which drained() compares
  enqueued: number;
  sent: number;
  readonly stream: boolean;
  // a write returned false or a producer waits; the drain fires once the queue is back within the window
  blocked: boolean;
  readonly drained: Listeners<[]>;
}

function vqlLength(value: number): number {
  let length = 1;
  for (let rest = value; rest >= 0x80; rest = Math.floor(rest / 0x80)) length++;
  return length;
}

function writeVql(target: Uint8Array, offset: number, value: number): number {
  let at = offset;
  let rest = value;
  while (rest >= 0x80) {
    target[at++] = (rest % 0x80) | 0x80;
    rest = Math.floor(rest / 0x80);
  }
  target[at++] = rest;
  return at;
}

// undefined: malformed, past the safe range or not in its shortest form, as the codec reads one
function readVql(source: Uint8Array, offset: number): { value: number; next: number } | undefined {
  let value = 0;
  let scale = 1;
  for (let at = offset; at < source.length && at < offset + 8; at++) {
    const byte = source[at]!;
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return Number.isSafeInteger(value) && (at === offset || byte !== 0) ? { value, next: at + 1 } : undefined;
    scale *= 0x80;
  }
  return undefined;
}

function frame(channel: number, kind: number, flags: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(vqlLength(channel) + 2 + body.length);
  let at = writeVql(out, 0, channel);
  out[at++] = kind;
  out[at++] = flags;
  out.set(body, at);
  return out;
}

function vqlBody(value: number): Uint8Array {
  const out = new Uint8Array(vqlLength(value));
  writeVql(out, 0, value);
  return out;
}

export function createMux(options: MuxOptions): Mux {
  const { protocol } = options;
  const maxHeld = options.maxHeldBytes ?? MAX_HELD_BYTES;
  // frames that need no credit: opens, credits and a stream's close after its data
  const controlQueue: Uint8Array[] = [];
  let controlEnqueued = 0;
  let controlSent = 0;
  const outgoing = new Map<number, Outgoing>();
  let order: number[] = [];
  let cursor = 0;
  let flushScheduled: NodeJS.Immediate | undefined;
  let disposed = false;
  let overflowed = false;
  const streamOpened = listeners<[StreamChannel]>();
  let nextStream = options.side === 'client' ? FIRST_DYNAMIC : FIRST_DYNAMIC + 1;
  // ids reserveStream gave that have not opened yet
  const reservations = new Set<number>();

  interface Incoming {
    readonly window: number;
    // credit the peer still holds; a data frame past it is a violation
    available: number;
    consumed: number;
    // message channels only: the bound and the message being joined, in a buffer that doubles up to it
    readonly maxMessageBytes?: number;
    joined: Uint8Array;
    joinedBytes: number;
    readonly data: Listeners<[Uint8Array]>;
    readonly ended?: Listeners<[]>;
  }
  const incoming = new Map<number, Incoming>();

  // a stream counts until both directions closed
  const openStreams = (): number => {
    let open = 0;
    for (const id of new Set([...outgoing.keys(), ...incoming.keys()])) if (id >= FIRST_DYNAMIC) open++;
    return open;
  };

  const violation = (reason: string): void => {
    if (disposed) return;
    dispose();
    options.onViolation(reason);
  };

  const heldBytes = (): number => {
    let held = protocol.unackedBytes();
    for (const channel of outgoing.values()) {
      held += channel.queuedBytes;
      const longest = channel.longest[0];
      if (longest) held -= longest.bytes.length - longest.offset;
    }
    return held;
  };

  const checkBound = (): void => {
    if (overflowed || disposed || heldBytes() <= maxHeld) return;
    overflowed = true;
    dispose();
    options.onOverflow();
  };

  const scheduleFlush = (): void => {
    if (disposed || flushScheduled) return;
    flushScheduled = setImmediate(flush);
  };

  // one frame of the channel, or undefined when it has nothing it may send
  const nextFrame = (channel: Outgoing): Uint8Array | undefined => {
    const head = channel.queue[0];
    if (!head) return undefined;
    if (head.end) {
      channel.queue.shift();
      channel.sent++;
      outgoing.delete(channel.id);
      order = order.filter((id) => id !== channel.id);
      return frame(channel.id, KIND.close, 0, new Uint8Array(0));
    }
    if (channel.credit <= 0) return undefined;
    const size = Math.min(FRAGMENT_BYTES, channel.credit, head.bytes.length - head.offset);
    const body = head.bytes.subarray(head.offset, head.offset + size);
    head.offset += size;
    channel.credit -= size;
    channel.queuedBytes -= size;
    const done = head.offset === head.bytes.length;
    if (done) {
      channel.queue.shift();
      if (channel.longest[0] === head) channel.longest.shift();
      channel.sent++;
    }
    if (channel.blocked && channel.queuedBytes <= channel.window) {
      channel.blocked = false;
      channel.drained.fire();
    }
    return frame(channel.id, KIND.data, !channel.stream && !done ? MORE : 0, body);
  };

  // each waiter holds the counts queued at its call; a channel that closed since sent all it had
  interface DrainWaiter {
    readonly control: number;
    readonly channels: ReadonlyArray<readonly [Outgoing, number]>;
    readonly resolve: () => void;
  }
  const drainWaiters = new Set<DrainWaiter>();
  const handedOver = (waiter: DrainWaiter): boolean =>
    controlSent >= waiter.control && waiter.channels.every(([channel, queued]) => channel.sent >= queued || outgoing.get(channel.id) !== channel);
  const settleDrained = (): void => {
    for (const waiter of [...drainWaiters]) {
      if (!disposed && !handedOver(waiter)) continue;
      drainWaiters.delete(waiter);
      waiter.resolve();
    }
  };
  const queueControl = (bytes: Uint8Array): void => {
    controlQueue.push(bytes);
    controlEnqueued++;
    scheduleFlush();
  };

  function flush(): void {
    flushScheduled = undefined;
    try {
      send();
    } finally {
      settleDrained();
    }
    // sending moves bytes from the queue to the unacknowledged ones, and the longest message's sent part counts from then
    checkBound();
  }

  function send(): void {
    while (!disposed && protocol.writable()) {
      const control = controlQueue.shift();
      if (control) {
        protocol.send(control);
        controlSent++;
        continue;
      }
      let sent = false;
      for (let tried = 0; tried < order.length && !sent; tried++) {
        cursor = (cursor + 1) % order.length;
        const channel = outgoing.get(order[cursor]!);
        const next = channel && nextFrame(channel);
        if (next) {
          protocol.send(next);
          sent = true;
        }
      }
      if (!sent) return;
    }
  }

  const register = (id: number, window: number, stream: boolean): Outgoing => {
    const channel: Outgoing = { id, window, credit: window, queue: [], longest: [], queuedBytes: 0, enqueued: 0, sent: 0, stream, blocked: false, drained: listeners<[]>(options.log) };
    outgoing.set(id, channel);
    order.push(id);
    return channel;
  };

  const grant = (id: number, entry: Incoming, bytes: number): void => {
    entry.consumed += bytes;
    if (entry.consumed < entry.window / 4) return;
    queueControl(frame(id, KIND.credit, 0, vqlBody(entry.consumed)));
    entry.available += entry.consumed;
    entry.consumed = 0;
  };

  const streamChannel = (id: number, out: Outgoing, entry: Incoming): StreamChannel => ({
    id,
    get closed() {
      return disposed;
    },
    write: (bytes) => {
      if (disposed || !outgoing.has(id) || out.queue.some((item) => item.end)) return false;
      out.queue.push({ bytes, offset: 0 });
      out.enqueued++;
      out.queuedBytes += bytes.length;
      scheduleFlush();
      checkBound();
      if (out.queuedBytes > out.window) out.blocked = true;
      return !out.blocked;
    },
    end: () => {
      if (disposed || !outgoing.has(id) || out.queue.some((item) => item.end)) return;
      out.queue.push({ bytes: new Uint8Array(0), offset: 0, end: true });
      out.enqueued++;
      scheduleFlush();
    },
    onData: entry.data.add,
    onEnd: entry.ended!.add,
    onDrain: out.drained.add,
  });

  const addStream = (id: number): StreamChannel => {
    const out = register(id, STREAM_WINDOW_BYTES, true);
    const entry: Incoming = { window: STREAM_WINDOW_BYTES, available: STREAM_WINDOW_BYTES, consumed: 0, joined: new Uint8Array(0), joinedBytes: 0, data: listeners(), ended: listeners(options.log) };
    incoming.set(id, entry);
    return streamChannel(id, out, entry);
  };

  const receiveData = (id: number, entry: Incoming, flags: number, body: Uint8Array): void => {
    if (body.length > entry.available) {
      violation(`data past the credit of channel ${id}`);
      return;
    }
    entry.available -= body.length;
    if (entry.maxMessageBytes === undefined) {
      if ((flags & MORE) !== 0) {
        violation(`a continued frame on stream ${id}`);
        return;
      }
      entry.data.fire(body);
      grant(id, entry, body.length);
      return;
    }
    const more = (flags & MORE) !== 0;
    if (more && body.length === 0) {
      violation(`an empty continued frame on channel ${id}`);
      return;
    }
    const total = entry.joinedBytes + body.length;
    if (total > entry.maxMessageBytes) {
      violation(`a message over ${entry.maxMessageBytes} bytes on channel ${id}`);
      return;
    }
    grant(id, entry, body.length);
    if (!more && entry.joinedBytes === 0) {
      entry.data.fire(body);
      return;
    }
    if (total > entry.joined.length) {
      const grown = new Uint8Array(Math.min(entry.maxMessageBytes, Math.max(total, entry.joined.length * 2)));
      grown.set(entry.joined.subarray(0, entry.joinedBytes));
      entry.joined = grown;
    }
    entry.joined.set(body, entry.joinedBytes);
    entry.joinedBytes = total;
    if (more) return;
    const message = entry.joined.slice(0, total);
    entry.joined = new Uint8Array(0);
    entry.joinedBytes = 0;
    entry.data.fire(message);
  };

  const receive = (body: Uint8Array): void => {
    if (disposed) return;
    const header = readVql(body, 0);
    if (!header || header.next + 2 > body.length) {
      violation('a malformed frame');
      return;
    }
    const id = header.value;
    const kind = body[header.next]!;
    const flags = body[header.next + 1]!;
    const payload = body.subarray(header.next + 2);
    if (flags & ~MORE || (flags !== 0 && kind !== KIND.data)) {
      violation(`unknown frame flags ${flags}`);
      return;
    }
    switch (kind) {
      case KIND.open: {
        const peerParity = options.side === 'client' ? 1 : 0;
        // an id opens again only once both directions of its last stream closed
        if (!options.acceptStreams || id < FIRST_DYNAMIC || id % 2 !== peerParity || incoming.has(id) || outgoing.has(id) || payload.length !== 0 || openStreams() >= MAX_OPEN_STREAMS) {
          violation(`an open of channel ${id}`);
          return;
        }
        streamOpened.fire(addStream(id));
        return;
      }
      case KIND.data: {
        const entry = incoming.get(id);
        if (!entry) {
          violation(`data on channel ${id}, which is not open`);
          return;
        }
        receiveData(id, entry, flags, payload);
        return;
      }
      case KIND.credit: {
        const channel = outgoing.get(id);
        const amount = readVql(payload, 0);
        // a credit can cross the close of its stream
        if (!channel && id >= FIRST_DYNAMIC && amount) return;
        if (!channel || !amount || amount.next !== payload.length || channel.credit + amount.value > channel.window) {
          violation(`a credit on channel ${id}`);
          return;
        }
        channel.credit += amount.value;
        scheduleFlush();
        return;
      }
      case KIND.close: {
        const entry = incoming.get(id);
        if (!entry?.ended || payload.length !== 0) {
          violation(`a close of channel ${id}`);
          return;
        }
        incoming.delete(id);
        entry.ended.fire();
        return;
      }
      default:
        violation(`a frame of unknown kind ${kind}`);
    }
  };

  const subscriptions = [protocol.onMessage(receive), protocol.onDrain(scheduleFlush)];

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (flushScheduled) clearImmediate(flushScheduled);
    subscriptions.forEach((subscription) => subscription.dispose());
    const writers = [...outgoing.values()];
    const readers = [...incoming.values()];
    outgoing.clear();
    incoming.clear();
    settleDrained();
    for (const channel of writers) channel.drained.fire();
    for (const entry of readers) entry.ended?.fire();
  }

  return {
    messageChannel: (id, maxMessageBytes) => {
      if (id < 1 || id >= FIRST_DYNAMIC || incoming.has(id)) throw new Error(`channel ${id} is not a free fixed channel`);
      const out = register(id, MESSAGE_WINDOW_BYTES, false);
      const entry: Incoming = { window: MESSAGE_WINDOW_BYTES, available: MESSAGE_WINDOW_BYTES, consumed: 0, maxMessageBytes, joined: new Uint8Array(0), joinedBytes: 0, data: listeners() };
      incoming.set(id, entry);
      return {
        id,
        send: (message) => {
          if (disposed) return;
          const item: Queued = { bytes: message, offset: 0 };
          out.queue.push(item);
          while (out.longest.length > 0 && out.longest.at(-1)!.bytes.length <= message.length) out.longest.pop();
          out.longest.push(item);
          out.enqueued++;
          out.queuedBytes += message.length;
          scheduleFlush();
          checkBound();
        },
        onMessage: entry.data.add,
        drained: () => {
          if (disposed || out.queuedBytes <= out.window) return Promise.resolve();
          out.blocked = true;
          return new Promise((resolve) => {
            const subscription = out.drained.add(() => {
              subscription.dispose();
              resolve();
            });
          });
        },
      };
    },
    openStream: (reserved) => {
      if (reserved !== undefined && !reservations.delete(reserved)) throw new Error(`stream ${reserved} was not reserved`);
      if (openStreams() >= MAX_OPEN_STREAMS) throw new Error(`more than ${MAX_OPEN_STREAMS} streams are open`);
      const id = reserved ?? nextStream;
      if (reserved === undefined) nextStream += 2;
      queueControl(frame(id, KIND.open, 0, new Uint8Array(0)));
      return addStream(id);
    },
    reserveStream: () => {
      const id = nextStream;
      nextStream += 2;
      reservations.add(id);
      return id;
    },
    onStream: streamOpened.add,
    heldBytes,
    drained: () => new Promise((resolve) => {
      drainWaiters.add({ control: controlEnqueued, channels: [...outgoing.values()].map((channel) => [channel, channel.enqueued] as const), resolve });
      settleDrained();
    }),
    dispose,
  };
}
