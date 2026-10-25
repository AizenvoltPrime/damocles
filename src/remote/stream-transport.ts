import type { Duplex } from 'node:stream';
import type { ByteSocket, Disposable } from './persistent-protocol';

/** A Duplex (a socket, a named pipe, a child's stdio joined into one) as the protocol's byte connection. */
export function streamSocket(stream: Duplex): ByteSocket {
  const on = <A extends unknown[]>(event: string, listener: (...args: A) => void): Disposable => {
    stream.on(event, listener as (...args: unknown[]) => void);
    return { dispose: () => { stream.off(event, listener as (...args: unknown[]) => void); } };
  };
  return {
    write: (bytes) => stream.write(bytes),
    // a stream paused by an earlier owner's detach stays paused when a listener attaches, so reading resumes it
    onData: (listener) => {
      const subscription = on('data', (chunk: Uint8Array) => listener(chunk));
      stream.resume();
      return subscription;
    },
    onDrain: (listener) => on('drain', listener),
    onClose: (listener) => {
      let failure: Error | undefined;
      const error = on('error', (err: Error) => {
        failure = err;
      });
      const closed = on('close', () => listener(failure));
      return { dispose: () => { error.dispose(); closed.dispose(); } };
    },
    pause: () => {
      stream.pause();
    },
    destroy: () => {
      stream.destroy();
    },
  };
}
