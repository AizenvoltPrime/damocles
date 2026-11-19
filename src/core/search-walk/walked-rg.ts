import { open } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { processLauncher } from '../process-launcher';
import { BATCH_COMMAND_LINE, commandLineCost } from './command-line';

/**
 * rg matching the files the search walk listed, named on its command line in batches, up to walkedRgRuns() runs at once
 * (docs/invariants.md "Tool overrides"); the caller decides what its events mean.
 */

type RgText = { text?: string; bytes?: string };

/** One event of rg's --json output, as far as the engine reads it. */
export interface RgLineEvent {
  type?: string;
  data?: { path?: RgText; line_number?: number; absolute_offset?: number; lines?: RgText; binary_offset?: number | null };
}

/** How one rg run ended: its exit code, the start of its stderr, and whether it printed its closing summary (it searched). */
export interface RgRunEnd {
  readonly code: number | null;
  readonly stderr: string;
  readonly summary: boolean;
}

/** A file's events the engine still holds: their matches, and their lines' text in UTF-8 bytes. */
export interface HeldEvents {
  readonly matches: number;
  readonly bytes: number;
}

export interface RgRunOptions {
  readonly rgPath: string;
  readonly signal: AbortSignal | undefined;
  // match and context events, and in a walked run each file's end after its released events; a walked run's files arrive one
  // whole file at a time, never interleaved, in no fixed order across files (as rg's own parallel walk)
  readonly onEvent: (event: RgLineEvent) => void;
  // true once nothing more is wanted: every running rg is killed, and no batch starts after it
  readonly done: () => boolean;
  // each run that done() did not stop: an error ends the search with it, undefined goes on
  readonly runEnded: (end: RgRunEnd) => Error | undefined;
  // a line longer than this many bytes is dropped unread and reported to onDropped
  readonly maxEventBytes?: number;
  readonly onDropped?: () => void;
}

export interface WalkedRgOptions extends RgRunOptions {
  readonly cwd: string;
  // rg's --json and matching flags, never '--'; walkedRgArgs puts the engine's own flags, the pattern and '--' after them
  readonly flags: readonly string[];
  readonly pattern: string;
  // the walk, listed under signal: files relative to cwd, each batch's command line within BATCH_COMMAND_LINE (batchLineBudget);
  // signal aborts with the caller's, and once a run fails or done() answers true, so the listing stops at once
  readonly batches: (signal: AbortSignal) => AsyncIterable<readonly string[]>;
  // a file's held events are read past (scanFile) and released or dropped once this answers true
  readonly mustRelease: (held: HeldEvents) => boolean;
}

// rg reads no config file and no ignore file, git folder or git config for the files it is given, and reads each file as its own
// walk reads it, whatever the batch's size.
const WALKED_FLAGS = ['--no-config', '--no-ignore', '--no-mmap'];

// rg's read buffer (grep-searcher's DEFAULT_BUFFER_CAPACITY): its walk reports nothing from the buffer holding a file's first NUL on.
const BINARY_BUFFER = 64 * 1024;

/** rg prints an error for every file it cannot open, which can run to megabytes; the first ones name the cause. */
const STDERR_LIMIT = 8 * 1024;

/** Every argument of a walked rg run before its files: the caller's flags, the engine's, the pattern as --regexp's value, and '--'. */
function walkedRgArgs(flags: readonly string[], pattern: string): string[] {
  if (flags.includes('--')) throw new Error('A walked rg run puts its own -- before the files');
  return [...flags, ...WALKED_FLAGS, '--regexp', pattern, '--'];
}

/** The units a batch's files may take on a walked run's command line (walkedRgArgs): a file costs commandLineCost. */
export function batchLineBudget(rgPath: string, flags: readonly string[], pattern: string): number {
  return BATCH_COMMAND_LINE - [rgPath, ...walkedRgArgs(flags, pattern)].reduce((sum, arg) => sum + commandLineCost(arg), 0);
}

function aborted(): Error {
  return new Error('Operation aborted');
}

/** pi 1.5.2's `decodeRgText` (`dist/core/tools/grep.js:31`): rg sends non-UTF-8 text base64-encoded in `bytes`. */
export function decodeRgText(data: RgText | undefined): string {
  if (typeof data?.text === 'string') return data.text;
  if (typeof data?.bytes === 'string') return Buffer.from(data.bytes, 'base64').toString('utf-8');
  return '';
}

/** How much of a file is known: `clean` bytes from its start hold no NUL, `nul` is the first one's offset, `end` that it was read whole. */
interface FileScan {
  clean: number;
  nul?: number;
  end: boolean;
}

/**
 * Reads file, a regular file the walk listed, from scan.clean on until `until`, its end or a NUL. rg decodes a file opening with a
 * UTF-16 byte order mark before it looks for a NUL, so such a file is read to its end or its first U+0000, which counts at offset 0.
 */
async function scanFile(file: string, scan: FileScan, until: number): Promise<void> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(BINARY_BUFFER);
    if (scan.clean === 0) {
      const { bytesRead } = await handle.read(buffer, 0, 2, 0);
      const utf16 = bytesRead === 2 && buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf-16le' : bytesRead === 2 && buffer[0] === 0xfe && buffer[1] === 0xff ? 'utf-16be' : undefined;
      if (utf16 !== undefined) {
        const decoder = new TextDecoder(utf16);
        for (let position = 2; ; ) {
          const { bytesRead: read } = await handle.read(buffer, 0, BINARY_BUFFER, position);
          if (decoder.decode(buffer.subarray(0, read), { stream: read > 0 }).includes('\0')) {
            scan.nul = 0;
            return;
          }
          if (read === 0) break;
          position += read;
        }
        scan.end = true;
        return;
      }
    }
    while (scan.clean < until) {
      const { bytesRead } = await handle.read(buffer, 0, BINARY_BUFFER, scan.clean);
      const nul = buffer.subarray(0, bytesRead).indexOf(0);
      if (nul >= 0) {
        scan.nul = scan.clean + nul;
        return;
      }
      scan.clean += bytesRead;
      if (bytesRead < BINARY_BUFFER) {
        scan.end = true;
        return;
      }
    }
  } finally {
    await handle.close();
  }
}

// The byte after an event's line, from where its line starts.
const lineEnd = (event: RgLineEvent): number => (event.data?.absolute_offset ?? 0) + (typeof event.data?.lines?.bytes === 'string' ? Buffer.from(event.data.lines.bytes, 'base64').length : Buffer.byteLength(event.data?.lines?.text ?? ''));

/** Calls onLine with each line of the chunks it is pushed, and onDropped instead for a line longer than maxBytes, never held whole. */
function lineReader(maxBytes: number, onLine: (line: string) => void, onDropped: () => void): { push(chunk: Buffer): void; end(): void } {
  let chunks: Buffer[] = [];
  let size = 0;
  let dropping = false;
  const take = (piece: Buffer): void => {
    if (dropping || piece.length === 0) return;
    if (size + piece.length > maxBytes) {
      dropping = true;
      chunks = [];
      size = 0;
      return;
    }
    chunks.push(piece);
    size += piece.length;
  };
  const endLine = (): void => {
    if (dropping) onDropped();
    else if (size > 0) onLine(Buffer.concat(chunks, size).toString('utf8'));
    chunks = [];
    size = 0;
    dropping = false;
  };
  return {
    push: (chunk) => {
      let start = 0;
      for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, start)) {
        take(chunk.subarray(start, index));
        endLine();
        start = index + 1;
      }
      take(chunk.subarray(start));
    },
    end: endLine,
  };
}

/** Whose file is part-way through the sink: while one run's file is, every other run's lines wait for that file's end. */
interface SinkTurn {
  owner: object | undefined;
  readonly waiting: Set<() => void>;
}

/** What a walked run shares with the other runs of its search. */
interface WalkedRun {
  readonly mustRelease: (held: HeldEvents) => boolean;
  readonly sink: SinkTurn;
  // the search stopped (done(), a failed run, the caller's abort): the run is killed and its lines dropped
  readonly kill: AbortSignal;
}

function handOver(sink: SinkTurn): void {
  sink.owner = undefined;
  const waiting = [...sink.waiting];
  sink.waiting.clear();
  queueMicrotask(() => {
    for (const wake of waiting) wake();
  });
}

/**
 * One rg run. walked set: rg searches the files the walk listed, each named on its command line, and so past a NUL, where
 * its own walk reports nothing from the read buffer holding the NUL on (64 KiB, BINARY_BUFFER); a file's events are held until
 * its end, or, once mustRelease answers true, until a read of the file shows no NUL up to their buffers. From a file's first
 * event shown to its end the run holds walked.sink, so another run's file never interleaves with it.
 */
function runOnce(options: RgRunOptions, cwd: string | undefined, args: readonly string[], walked: WalkedRun | undefined): Promise<void> {
  const { signal, onEvent, done } = options;
  return new Promise<void>((resolve, reject) => {
    // an aborted signal fires no abort event, so a run started after the abort would go to its end
    if (signal?.aborted) return reject(aborted());
    const child = processLauncher().launch({ file: options.rgPath, args, ...(cwd !== undefined ? { cwd } : {}), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const stderrDecoder = new StringDecoder('utf8');
    child.onData('stderr', (chunk) => {
      if (stderr.length < STDERR_LIMIT) stderr += stderrDecoder.write(chunk).slice(0, STDERR_LIMIT - stderr.length);
    });
    const self = {};
    let stopped = false;
    let summary = false;
    let file: { path: string; held: RgLineEvent[]; matches: number; bytes: number; scan: FileScan; mode: 'hold' | 'stream' | 'cut' } | undefined;
    // rg's lines not yet handled, in order: they wait while the run reads a file, or while another run's file holds the sink
    let queue: string[] = [];
    let head = 0;
    let draining = false;
    let scanning = false;
    // a finished read's release, which goes before the lines that waited for it
    let release: (() => void) | undefined;
    let outputEnded = false;
    let failure: { error: unknown } | undefined;
    let settleDrained: () => void = () => undefined;
    const drained = new Promise<void>((settled) => {
      settleDrained = settled;
    });
    const stopIfDone = (): void => {
      if (done() && !stopped) {
        stopped = true;
        child.kill();
      }
    };
    const show = (event: RgLineEvent): void => {
      if (walked) walked.sink.owner = self;
      onEvent(event);
    };
    const onFileEvent = (event: RgLineEvent, mustRelease: (held: HeldEvents) => boolean): void => {
      if (event.type === 'begin') {
        file = { path: decodeRgText(event.data?.path), held: [], matches: 0, bytes: 0, scan: { clean: 0, end: false }, mode: 'hold' };
        return;
      }
      if (file === undefined) return;
      if (event.type === 'end') {
        const binaryOffset = event.data?.binary_offset;
        if (file.mode === 'hold') {
          const before = binaryOffset == null ? Infinity : binaryOffset - BINARY_BUFFER;
          for (const kept of file.held) if (lineEnd(kept) <= before) show(kept);
        }
        file = undefined;
        show(event);
        if (walked?.sink.owner === self) handOver(walked.sink);
        return;
      }
      if (event.type !== 'match' && event.type !== 'context') return;
      if (file.mode === 'stream') return show(event);
      // the NUL is known: a later line still shows when it ends a read buffer before the NUL
      if (file.mode === 'cut') {
        if (lineEnd(event) <= (file.scan.nul ?? 0) - BINARY_BUFFER) show(event);
        return;
      }
      file.held.push(event);
      if (event.type === 'match') file.matches++;
      file.bytes += Buffer.byteLength(decodeRgText(event.data?.lines));
      // the file is read far enough to release its hold
      if (mustRelease(file)) {
        const checked = file;
        scanning = true;
        const until = checked.held.reduce((last, kept) => Math.max(last, kept.data?.absolute_offset ?? 0), 0) + BINARY_BUFFER;
        scanFile(path.resolve(cwd ?? '', checked.path), checked.scan, until).then(() => {
          scanning = false;
          release = () => {
            const { nul, end, clean } = checked.scan;
            // a line shows when no buffer up to its own holds a NUL: rg's walk stops at the buffer holding the first one
            const shows = (kept: RgLineEvent): boolean => (nul !== undefined ? lineEnd(kept) <= nul - BINARY_BUFFER : end || (kept.data?.absolute_offset ?? 0) + BINARY_BUFFER <= clean);
            const released = checked.held.filter(shows);
            checked.held = nul !== undefined || end ? [] : checked.held.filter((kept) => !shows(kept));
            checked.matches = checked.held.filter((kept) => kept.type === 'match').length;
            checked.bytes = checked.held.reduce((sum, kept) => sum + Buffer.byteLength(decodeRgText(kept.data?.lines)), 0);
            if (nul !== undefined) checked.mode = 'cut';
            else if (end) checked.mode = 'stream';
            for (const kept of released) show(kept);
            stopIfDone();
          };
          drain();
        }, (error: unknown) => {
          scanning = false;
          failure = { error };
          child.kill();
          drain();
        });
      }
    };
    const handle = (line: string): void => {
      if (done() || !line.trim()) return;
      let event: RgLineEvent;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === 'summary') summary = true;
      if (walked) onFileEvent(event, walked.mustRelease);
      else onEvent(event);
      stopIfDone();
    };
    function drain(): void {
      if (draining) return;
      draining = true;
      try {
        while (!stopped && failure === undefined && !scanning && (release !== undefined || head < queue.length)) {
          if (walked && walked.sink.owner !== undefined && walked.sink.owner !== self) {
            walked.sink.waiting.add(drain);
            break;
          }
          if (release !== undefined) {
            const next = release;
            release = undefined;
            next();
          } else {
            const line = queue[head]!;
            head++;
            handle(line);
          }
        }
      } finally {
        draining = false;
      }
      if (stopped || failure !== undefined || head === queue.length) {
        queue = [];
        head = 0;
      }
      // lines that wait (another run's file holds the sink, or a read decides a hold) keep rg's output paused, bounding the queue
      if (head < queue.length) child.pauseOutput();
      else child.resumeOutput();
      if (outputEnded && (stopped || failure !== undefined || (head === queue.length && !scanning && release === undefined))) settleDrained();
    }
    const stop = (): void => {
      if (!stopped) {
        stopped = true;
        child.kill();
      }
      drain();
    };
    signal?.addEventListener('abort', stop, { once: true });
    walked?.kill.addEventListener('abort', stop, { once: true });
    // the search stopped during the launch
    if (signal?.aborted || walked?.kill.aborted) stop();
    const lines = lineReader(options.maxEventBytes ?? Infinity, (line) => {
      queue.push(line);
      drain();
    }, () => options.onDropped?.());
    child.onData('stdout', (chunk) => lines.push(chunk));
    const settle = (): void => {
      signal?.removeEventListener('abort', stop);
      walked?.kill.removeEventListener('abort', stop);
      if (walked?.sink.owner === self) handOver(walked.sink);
    };
    Promise.all([child.exited, child.closed]).then(async ([{ code }]) => {
      lines.end();
      outputEnded = true;
      drain();
      await drained;
      settle();
      if (failure) return reject(failure.error);
      if (signal?.aborted) return reject(aborted());
      const error = stopped ? undefined : options.runEnded({ code, stderr: stderr.trim(), summary });
      if (error) return reject(error);
      resolve();
    }, (error: Error) => {
      settle();
      reject(new Error(`Failed to run ripgrep: ${error.message}`));
    });
  });
}

/** One rg run with args, its events passed on as they come, for files no walk listed. */
export function runRg(options: RgRunOptions & { readonly cwd?: string; readonly args: readonly string[] }): Promise<void> {
  return runOnce(options, options.cwd, options.args, undefined);
}

/**
 * rg runs a walked search keeps live at once: half the logical CPUs, at least 1 and at most 4. Each named file costs rg a stat on
 * one thread before it searches, which several runs share out (docs/perf.md "Search: walked batches against ripgrep's walk").
 */
export function walkedRgRuns(): number {
  return Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2)));
}

/**
 * rg over the batches while they are still being listed: up to walkedRgRuns() runs live and one listed batch waiting beyond them.
 * None starts after done(), a failure or an abort, which kill every live run and stop the listing.
 */
export async function runWalkedRg(options: WalkedRgOptions): Promise<void> {
  const args = walkedRgArgs(options.flags, options.pattern);
  const most = walkedRgRuns();
  const stop = new AbortController();
  const listing = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
  const done = (): boolean => {
    if (!options.done()) return false;
    stop.abort();
    return true;
  };
  const walked: WalkedRun = { mustRelease: options.mustRelease, sink: { owner: undefined, waiting: new Set() }, kill: stop.signal };
  const live = new Set<Promise<void>>();
  let failure: { error: unknown } | undefined;
  try {
    for await (const batch of options.batches(listing)) {
      while (live.size >= most && !listing.aborted) await Promise.race(live);
      if (listing.aborted || done()) break;
      const run: Promise<void> = runOnce({ ...options, done }, options.cwd, [...args, ...batch], walked).then(() => {
        done();
      }, (error: unknown) => {
        failure ??= { error };
        stop.abort();
      }).then(() => {
        live.delete(run);
      });
      live.add(run);
    }
  } catch (err) {
    // the listing this engine stopped ends with an abort, which is not the search's
    if (!stop.signal.aborted || options.signal?.aborted) throw err;
  } finally {
    // a listing that fails leaves its runs to finish (an abort kills them) before the error reaches the caller
    await Promise.all(live);
  }
  if (failure) throw failure.error;
  if (options.signal?.aborted) throw aborted();
}
