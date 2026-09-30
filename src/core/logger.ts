import { format } from 'node:util';
import type { LogSink } from '../platform/log-sink';

// Lines logged before the host installs a sink are dropped; the host installs it first in activate.
let sink: LogSink | undefined;

export function installLogSink(s: LogSink): void {
  sink = s;
}

export function log(...args: unknown[]): void {
  sink?.appendLine(`[${new Date().toISOString()}] ${format(...args)}`);
}

export function showLog(preserveFocus?: boolean): void {
  sink?.show(preserveFocus);
}
