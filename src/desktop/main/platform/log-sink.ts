import * as fs from 'node:fs';
import * as path from 'node:path';
import { shell } from 'electron';
import type { LogSink, LogSinkFactory } from '../../../platform/log-sink';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
// <name>.log plus this many rotated files <name>.1.log ... <name>.N.log
const ROTATED_FILES = 3;

function rotate(filePath: string): void {
  const base = filePath.slice(0, -'.log'.length);
  for (let index = ROTATED_FILES - 1; index >= 1; index--) {
    const from = `${base}.${index}.log`;
    if (fs.existsSync(from)) fs.renameSync(from, `${base}.${index + 1}.log`);
  }
  if (fs.existsSync(filePath)) fs.renameSync(filePath, `${base}.1.log`);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Sanitized so a sink name can never leave the logs directory.
export function logFileName(name: string): string {
  return `${name.replace(/[^A-Za-z0-9._-]/g, '_')}.log`;
}

class RotatingFileSink implements LogSink {
  private readonly filePath: string;
  private readonly echo: boolean;
  private bytes: number;
  private pending: string[] = [];
  private flushScheduled = false;
  private disposed = false;
  // steps that keep failing, so a full disk reports once rather than on every flush
  private readonly failing = new Set<'rotate' | 'append'>();

  constructor(filePath: string, echo: boolean) {
    this.filePath = filePath;
    this.echo = echo;
    this.bytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  }

  appendLine(line: string): void {
    if (this.disposed) return;
    const text = `${line}\n`;
    if (this.echo) process.stdout.write(text);
    this.pending.push(text);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => this.flush());
  }

  // One write per event-loop turn keeps the main thread off the disk for every line. The log is where failures are
  // reported, so its own failures go to stderr: a rotation that fails keeps appending, an append that fails drops the batch.
  private flush(): void {
    this.flushScheduled = false;
    if (this.pending.length === 0) return;
    const text = this.pending.join('');
    const lines = this.pending.length;
    this.pending = [];
    const size = Buffer.byteLength(text);
    if (this.bytes > 0 && this.bytes + size > MAX_FILE_BYTES) {
      try {
        rotate(this.filePath);
        this.bytes = 0;
        this.failing.delete('rotate');
      } catch (err) {
        this.reportFailure('rotate', `could not rotate ${this.filePath}, appending to it instead: ${errorText(err)}`);
      }
    }
    try {
      fs.appendFileSync(this.filePath, text);
      this.bytes += size;
      this.failing.delete('append');
    } catch (err) {
      this.reportFailure('append', `dropped ${lines} log line(s), could not write ${this.filePath}: ${errorText(err)}`);
    }
  }

  private reportFailure(step: 'rotate' | 'append', message: string): void {
    if (this.failing.has(step)) return;
    this.failing.add(step);
    process.stderr.write(`[log] ${message}\n`);
  }

  show(): void {
    this.flush();
    void shell.openPath(this.filePath);
  }

  dispose(): void {
    this.flush();
    this.disposed = true;
  }
}

// One rotating file per sink name under <userData>/logs; echo mirrors lines to stdout for an unpackaged run.
export function createDesktopLogSinkFactory(logsDir: string, echo: boolean): LogSinkFactory {
  fs.mkdirSync(logsDir, { recursive: true });
  return {
    create: (name) => new RotatingFileSink(path.join(logsDir, logFileName(name)), echo),
  };
}
