import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LogSink, LogSinkFactory } from '../../platform/log-sink';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
// Lines waiting behind a write past this many bytes are dropped and counted, so a stalled disk cannot grow memory without end.
const MAX_PENDING_BYTES = MAX_FILE_BYTES;
// <name>.log plus this many rotated files <name>.1.log ... <name>.N.log
const ROTATED_FILES = 3;

type Step = 'rotate' | 'append';

async function renameIfPresent(from: string, to: string): Promise<void> {
  try {
    await fs.promises.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

async function rotate(filePath: string): Promise<void> {
  const base = filePath.slice(0, -'.log'.length);
  for (let index = ROTATED_FILES - 1; index >= 1; index--) await renameIfPresent(`${base}.${index}.log`, `${base}.${index + 1}.log`);
  await renameIfPresent(filePath, `${base}.1.log`);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Sanitized so a sink name can never leave the logs directory.
export function logFileName(name: string): string {
  return `${name.replace(/[^A-Za-z0-9._-]/g, '_')}.log`;
}

// Shows a sink's file in the app (D36: a read-only log tab), focused unless preserveFocus.
export type OpenLogFile = (filePath: string, preserveFocus: boolean) => void;

export interface DesktopLogSinkFactory extends LogSinkFactory {
  /** Settles once every line logged so far, in every sink, has been written or dropped. */
  flushed(): Promise<void>;
}

const liveSinks = new Set<RotatingFileSink>();
let exitHooked = false;

/** Writes, synchronously, every line no write was started for yet; the process 'exit' hook. */
export function writeUnstartedLogLines(): void {
  for (const sink of liveSinks) sink.writeUnstarted();
}

// Lines are written in order through one promise chain per sink, which holds at most one write step: lines logged while it
// writes wait in pending and go out together when it is done. A native crash loses at most one event-loop turn of lines,
// and the 'exit' hook writes the lines no write was started for.
class RotatingFileSink implements LogSink {
  private readonly filePath: string;
  private readonly echo: boolean;
  private readonly open: OpenLogFile;
  private handle: fs.promises.FileHandle | undefined;
  private bytes = 0;
  private pending: string[] = [];
  private pendingBytes = 0;
  // lines dropped past MAX_PENDING_BYTES since the last write took pending
  private dropped = 0;
  private flushScheduled = false;
  private disposed = false;
  private chain: Promise<void> = Promise.resolve();
  // steps queued on the chain and not yet finished
  private queued = 0;
  // steps that keep failing, so a full disk reports once rather than on every flush
  private readonly failing = new Set<Step>();

  constructor(filePath: string, echo: boolean, open: OpenLogFile) {
    this.filePath = filePath;
    this.echo = echo;
    this.open = open;
    liveSinks.add(this);
  }

  appendLine(line: string): void {
    if (this.disposed) return;
    const text = `${line}\n`;
    if (this.echo) process.stdout.write(text);
    const size = Buffer.byteLength(text);
    if (this.pendingBytes + size > MAX_PENDING_BYTES) {
      this.dropped++;
      return;
    }
    this.pending.push(text);
    this.pendingBytes += size;
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => this.flush());
  }

  flushed(): Promise<void> {
    this.flush();
    return this.chain;
  }

  show(preserveFocus?: boolean): void {
    void this.flushed().then(() => this.open(this.filePath, preserveFocus === true));
  }

  // A quit disposes the sink as it exits, before an async write could land: lines with no write in flight ahead of them
  // are written at once, and lines behind one stay pending for the 'exit' hook until the chain reaches them.
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.queued === 0) this.writeUnstarted();
    this.enqueue(async () => {
      await this.writePending();
      await this.handle?.close().catch(() => undefined);
      this.handle = undefined;
      liveSinks.delete(this);
    });
  }

  writeUnstarted(): void {
    const batch = this.takePending();
    if (!batch) return;
    try {
      // The first async write creates the folder, and a process can exit before any ran.
      // eslint-disable-next-line damocles/no-sync -- only at exit or dispose, when an async write would never land
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // eslint-disable-next-line damocles/no-sync -- only at exit or dispose, when an async write would never land
      fs.appendFileSync(this.filePath, batch.text);
    } catch (err) {
      this.reportFailure('append', `dropped log lines at exit, could not write ${this.filePath}: ${errorText(err)}`);
    }
  }

  // After dispose, the closing step writes what is pending; while a write runs, it takes what is pending when it is done.
  private flush(): void {
    this.flushScheduled = false;
    if (this.disposed || this.queued > 0 || (this.pending.length === 0 && this.dropped === 0)) return;
    this.enqueue(() => this.writePending());
  }

  private async writePending(): Promise<void> {
    for (let batch = this.takePending(); batch; batch = this.takePending()) await this.write(batch.text, batch.lines);
  }

  // The pending lines, and after them a line counting those dropped past MAX_PENDING_BYTES.
  private takePending(): { readonly text: string; readonly lines: number } | undefined {
    if (this.pending.length === 0 && this.dropped === 0) return undefined;
    const gap = this.dropped > 0 ? [`[log] dropped ${this.dropped} log line(s) while earlier lines waited to be written\n`] : [];
    const lines = [...this.pending, ...gap];
    this.pending = [];
    this.pendingBytes = 0;
    this.dropped = 0;
    return { text: lines.join(''), lines: lines.length };
  }

  private enqueue(step: () => Promise<void>): void {
    this.queued++;
    this.chain = this.chain.then(step).finally(() => {
      this.queued--;
    });
  }

  // The log is where failures are reported, so its own failures go to stderr: a rotation that fails keeps appending,
  // a write that fails drops the batch. Never rejects.
  private async write(text: string, lines: number): Promise<void> {
    const size = Buffer.byteLength(text);
    try {
      if (!this.handle) await this.openHandle();
      if (this.bytes > 0 && this.bytes + size > MAX_FILE_BYTES) await this.rotate();
      await this.handle!.write(text);
      this.bytes += size;
      this.failing.delete('append');
    } catch (err) {
      await this.handle?.close().catch(() => undefined);
      this.handle = undefined;
      this.reportFailure('append', `dropped ${lines} log line(s), could not write ${this.filePath}: ${errorText(err)}`);
    }
  }

  private async openHandle(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    this.handle = await fs.promises.open(this.filePath, 'a');
    this.bytes = (await this.handle.stat()).size;
  }

  // Windows cannot rename an open file, so the handle closes first.
  private async rotate(): Promise<void> {
    await this.handle!.close();
    this.handle = undefined;
    try {
      await rotate(this.filePath);
      this.failing.delete('rotate');
    } catch (err) {
      this.reportFailure('rotate', `could not rotate ${this.filePath}, appending to it instead: ${errorText(err)}`);
    }
    await this.openHandle();
  }

  private reportFailure(step: Step, message: string): void {
    if (this.failing.has(step)) return;
    this.failing.add(step);
    process.stderr.write(`[log] ${message}\n`);
  }
}

// One rotating file per sink name under <userData>/logs; echo mirrors lines to stdout for an unpackaged run.
export function createDesktopLogSinkFactory(logsDir: string, echo: boolean, open: OpenLogFile): DesktopLogSinkFactory {
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', writeUnstartedLogLines);
  }
  const sinks: RotatingFileSink[] = [];
  return {
    create: (name) => {
      const sink = new RotatingFileSink(path.join(logsDir, logFileName(name)), echo, open);
      sinks.push(sink);
      return sink;
    },
    flushed: async () => {
      await Promise.all(sinks.map((sink) => sink.flushed()));
    },
  };
}
