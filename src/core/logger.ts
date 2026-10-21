import { format } from 'node:util';
import type { LogSink } from '../platform/log-sink';

// Lines logged before the host installs a sink are dropped; the host installs it first in activate.
let sink: LogSink | undefined;
// False in a worker thread, whose host stamps each relayed line as it logs it.
let stamped = true;

export function installLogSink(s: LogSink): void {
  sink = s;
  stamped = true;
}

/** A worker thread's sink: each line goes to `post` unstamped, for the host to log() once. */
export function installWorkerLogRelay(post: (message: string) => void): void {
  sink = { appendLine: post, show: () => undefined, dispose: () => undefined };
  stamped = false;
}

export function log(...args: unknown[]): void {
  const text = format(...args);
  sink?.appendLine(stamped ? `[${new Date().toISOString()}] ${text}` : text);
}

export function showLog(preserveFocus?: boolean): void {
  sink?.show(preserveFocus);
}
