// One socket connection carried over a mux stream, the same on the client and the daemon: each side pauses its source while
// the other's window is full, a FIN crosses as the stream's end (half-close), and an error or a closed connection tears both
// down; a pipe's owner closes it when the connection is lost (docs/invariants.md "Ports and the remote browser").
import type { Socket } from 'node:net';
import { STREAM_WINDOW_BYTES, type Mux, type StreamChannel } from './mux';
import type { Disposable } from './persistent-protocol';

// what the peer may push on streams no owner has claimed yet, summed over the connection; past it the connection closes
export const MAX_UNCLAIMED_STREAM_BYTES: number = 64 * 1024 * 1024;

export interface TunnelPipe {
  // resets the socket and ends the stream at once (Stop forwarding)
  close(): void;
}

export interface StreamClaims {
  // a stream the peer opened, taken once by its one owner; undefined for any other id
  claim(id: number): StreamChannel | undefined;
  dispose(): void;
}

interface Unclaimed {
  readonly held: StreamChannel;
  // what arrived on it while unclaimed
  bytes: number;
  readonly counting: Disposable;
}

/**
 * Every stream the peer opens, held (holdStream) until a request names it and its owner claims it; one the peer ends unclaimed
 * is ended here too, so it stops counting against the open streams. close runs once the unclaimed streams hold more than
 * MAX_UNCLAIMED_STREAM_BYTES.
 */
export function streamClaims(mux: Pick<Mux, 'onStream'>, close: (reason: string) => void): StreamClaims {
  const opened = new Map<number, Unclaimed>();
  let unclaimedBytes = 0;
  const take = (id: number): Unclaimed | undefined => {
    const entry = opened.get(id);
    if (!entry) return undefined;
    opened.delete(id);
    entry.counting.dispose();
    unclaimedBytes -= entry.bytes;
    return entry;
  };
  const subscription = mux.onStream((stream) => {
    const entry: Unclaimed = {
      held: holdStream(stream),
      bytes: 0,
      counting: stream.onData((bytes) => {
        entry.bytes += bytes.length;
        unclaimedBytes += bytes.length;
        if (unclaimedBytes > MAX_UNCLAIMED_STREAM_BYTES) close('the peer sent more stream bytes than were asked for');
      }),
    };
    opened.set(stream.id, entry);
    stream.onEnd(() => {
      if (opened.get(stream.id) !== entry) return;
      take(stream.id);
      entry.held.end();
    });
  });
  return {
    claim: (id) => take(id)?.held,
    dispose: () => {
      subscription.dispose();
      for (const id of [...opened.keys()]) take(id);
    },
  };
}

/** A TCP tunnel's pipe (pipeStream), whose peer a reset reaches as an RST. */
export function pipeTunnel(socket: Socket, stream: StreamChannel, onClosed: () => void): TunnelPipe {
  return pipeStream(socket, stream, onClosed, (tcp) => tcp.resetAndDestroy());
}

/**
 * Pipes socket and stream until both directions ended; onClosed runs once, when the socket closed. reset ends the socket at
 * once: resetAndDestroy for TCP, destroy for a named pipe or Unix socket, which have no RST and on which resetAndDestroy throws.
 */
export function pipeStream(socket: Socket, stream: StreamChannel, onClosed: () => void, reset: (socket: Socket) => void): TunnelPipe {
  let streamEnded = false;
  let socketClosed = false;
  const endStream = (): void => {
    if (streamEnded) return;
    streamEnded = true;
    stream.end();
  };
  socket.on('data', (chunk: Buffer) => {
    if (!stream.write(chunk)) socket.pause();
  });
  const drain = stream.onDrain(() => socket.resume());
  const data = stream.onData((bytes) => {
    // once the socket closed, what the peer still sends before it reads our end is dropped, and granted back by the resume
    if (socketClosed) return;
    if (!socket.write(bytes)) stream.pause();
  });
  socket.on('drain', () => stream.resume());
  socket.on('end', endStream);
  stream.onEnd(() => {
    data.dispose();
    if (socketClosed) return;
    // the connection is gone: nothing more arrives or leaves, so the peer is reset rather than left half-open
    if (stream.closed) reset(socket);
    else socket.end();
  });
  // a reset or a failed write: the peer sees the stream end, which is the one close a stream has
  socket.on('error', () => socket.destroy());
  socket.once('close', () => {
    socketClosed = true;
    endStream();
    drain.dispose();
    // a stream paused for this socket's drain would otherwise withhold the peer's credit forever
    stream.resume();
    onClosed();
  });
  // a stream whose connection closed already never ends again
  if (stream.closed) reset(socket);
  return {
    close: () => {
      reset(socket);
      endStream();
    },
  };
}

/** Ends this side of a stream nothing will read: what the peer still sends until its own end is dropped and granted back. */
export function abandonStream(stream: StreamChannel): void {
  stream.onData(() => undefined);
  stream.resume();
  stream.end();
}

/**
 * The stream with what arrives before its reader subscribes kept for that reader: the daemon may send a target's first bytes
 * (a server that speaks first) ahead of the answer that hands the stream to its pipe, and the mux drops data no one listens to.
 * Until the reader subscribes the stream is paused, so the peer sends at most one credit window into the hold.
 */
export function holdStream(stream: StreamChannel): StreamChannel {
  const held: Uint8Array[] = [];
  let ended = false;
  let reading = false;
  // the reader's own pause, which its subscription keeps
  let readerPaused = false;
  stream.pause();
  const holding = stream.onData((bytes) => held.push(bytes));
  stream.onEnd(() => {
    ended = true;
  });
  return {
    id: stream.id,
    get closed() {
      return stream.closed;
    },
    write: (bytes) => stream.write(bytes),
    end: () => stream.end(),
    onDrain: (listener) => stream.onDrain(listener),
    pause: () => {
      readerPaused = true;
      stream.pause();
    },
    resume: () => {
      readerPaused = false;
      if (reading) stream.resume();
    },
    onData: (listener) => {
      holding.dispose();
      for (const bytes of held.splice(0)) listener(bytes);
      const subscription = stream.onData(listener);
      reading = true;
      if (!readerPaused) stream.resume();
      return subscription;
    },
    onEnd: (listener) => {
      if (!ended) return stream.onEnd(listener);
      listener();
      return { dispose: () => undefined };
    },
  };
}

/**
 * A file's bytes as they arrive on stream, for one reader that pulls them: the stream is paused while a window of bytes waits
 * unread. The iteration ends with the peer's end; the connection closing first fails it. Returning early ends this side,
 * which the peer reads as a cancel.
 */
export function streamBytes(stream: StreamChannel): AsyncIterable<Uint8Array> {
  const queued: Uint8Array[] = [];
  let queuedBytes = 0;
  let ended = false;
  let paused = false;
  let wake: (() => void) | undefined;
  const signal = (): void => {
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };
  const data = stream.onData((bytes) => {
    queued.push(bytes);
    queuedBytes += bytes.length;
    if (!paused && queuedBytes >= STREAM_WINDOW_BYTES) {
      paused = true;
      stream.pause();
    }
    signal();
  });
  const end = stream.onEnd(() => {
    ended = true;
    signal();
  });
  // a stream paused here would withhold the peer's credit, so its end never crosses behind its queued bytes
  const finish = (): void => {
    data.dispose();
    end.dispose();
    abandonStream(stream);
  };
  const iterator: AsyncIterator<Uint8Array> = {
    next: async () => {
      while (queued.length === 0 && !ended) await new Promise<void>((resolve) => { wake = resolve; });
      const bytes = queued.shift();
      if (bytes === undefined) {
        finish();
        if (stream.closed) throw new Error('The connection closed before the transfer finished');
        return { done: true, value: undefined };
      }
      queuedBytes -= bytes.length;
      if (paused && queuedBytes < STREAM_WINDOW_BYTES) {
        paused = false;
        stream.resume();
      }
      return { done: false, value: bytes };
    },
    return: async () => {
      queued.length = 0;
      finish();
      return { done: true, value: undefined };
    },
  };
  return { [Symbol.asyncIterator]: () => iterator };
}

/**
 * Writes source to stream within its credit and ends it. Resolves 'stopped' once the peer ended its side first (a refusal or a
 * cancel), the connection closed or signal aborted, with the source returned early; a source that throws ends the stream short
 * and rethrows.
 */
export async function writeBytes(stream: StreamChannel, source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<'ended' | 'stopped'> {
  let stopped = stream.closed || signal?.aborted === true;
  let wake: (() => void) | undefined;
  const wakeUp = (): void => {
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };
  const stop = (): void => {
    stopped = true;
    wakeUp();
  };
  const ending = stream.onEnd(stop);
  const draining = stream.onDrain(wakeUp);
  signal?.addEventListener('abort', stop, { once: true });
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (!stopped) {
      const next = await iterator.next();
      if (next.done) break;
      if (stream.write(next.value)) continue;
      if (!stopped) await new Promise<void>((resolve) => { wake = resolve; });
    }
    if (stopped) await iterator.return?.();
    return stopped ? 'stopped' : 'ended';
  } finally {
    signal?.removeEventListener('abort', stop);
    ending.dispose();
    draining.dispose();
    stream.end();
  }
}
