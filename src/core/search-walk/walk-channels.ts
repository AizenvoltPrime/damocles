// The walk process's channels to its host: stdin and stdout for a process the launcher started, the parent port for an Electron
// utility process. serveWalks runs the same over either.
import { createInterface } from 'node:readline';
import type { WalkChannel } from './walk-serve';
import { walkLine, type WalkRequest } from './walk-protocol';

/** What a utility process's process.parentPort offers; each message event carries a request as data. */
export interface WalkParentPort {
  on(event: 'message', listener: (event: { readonly data: unknown }) => void): unknown;
  postMessage(message: unknown): void;
}

/** One JSON message a line on input and output; onEnd runs once input ends or either stream fails, as when the host died. */
export function stdioWalkChannel(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, onEnd: () => void): WalkChannel {
  input.on('error', onEnd);
  output.on('error', onEnd);
  return {
    send: (reply) => void output.write(walkLine(reply)),
    onRequest: (listener) => {
      const lines = createInterface({ input, crlfDelay: Infinity });
      lines.on('line', (line) => listener(JSON.parse(line) as WalkRequest));
      lines.on('close', onEnd);
    },
  };
}

/** Structured-clone messages over a utility process's parent port. */
export function portWalkChannel(port: WalkParentPort): WalkChannel {
  return {
    send: (reply) => port.postMessage(reply),
    onRequest: (listener) => void port.on('message', ({ data }) => listener(data as WalkRequest)),
  };
}
