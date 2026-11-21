import { processLauncher, type ProcessExit } from '../process-launcher';
import { lineReader, MAX_WALK_LINE_BYTES, maxBatchFiles, parseWalkReply, WALK_CREDIT, walkLine, type WalkReply, type WalkRequest, type WalkSpec } from './walk-protocol';

/**
 * What the host needs of a walk process, whatever carries its messages: startWalkChild starts one on the launcher, desktop main
 * forks one as a utility process (main/walk-process.ts).
 */
export interface WalkChild {
  // each reply as it arrived, unchecked; onFault when the channel itself broke the contract, with the reason
  onReply(listener: (reply: unknown) => void, onFault: (reason: string) => void): void;
  onStderr(listener: (text: string) => void): void;
  // rejects when the process closed first
  send(request: WalkRequest): Promise<void>;
  // once it exited and its output closed; rejects when it could not start
  readonly exited: Promise<ProcessExit>;
  // kills it at once
  kill(): void;
}

/** One walk's files in batches of '/'-separated paths below its root; its iteration throws the walk's failure. */
export interface WalkStream extends AsyncIterable<readonly string[]> {
  // folders below the root the walk could not read, as rg reports them (the walk went on); complete once the iteration ended
  readonly errors: readonly string[];
  // under WalkSpec.timed, each timed file's modified time in ms by its path, set as its batch is taken
  readonly modified: ReadonlyMap<string, number>;
}

export interface WalkHost {
  // an abort of signal, or leaving the iteration early, cancels the walk in its process
  walk(spec: WalkSpec, signal?: AbortSignal): WalkStream;
  // ends every running walk with an error and kills the processes, waiting at most WALK_CLOSE_WAIT_MS for them; a later walk starts a fresh one
  close(): Promise<void>;
}

// Walk processes a host runs at once: a walk starts a second only while every running one holds a walk (docs/perf.md "Quick Open listing").
export const MAX_WALK_PROCESSES = 2;

// A walk process that failed this many times within WALK_FAILURE_WINDOW_MS is not started again until the oldest failure leaves it.
export const MAX_WALK_FAILURES = 5;
export const WALK_FAILURE_WINDOW_MS: number = 5 * 60 * 1000;
// How long close waits for the killed process to exit, which a read stuck on a share that stopped answering can hold.
export const WALK_CLOSE_WAIT_MS = 2000;
// A process with no walk and no held read is killed this long after its last one settled: VS Code's ipc.cp.ts Client disposes
// an idle stateless child after its default 60 s timeout. Each idle process holds 70 MB or more (docs/perf.md "Quick Open listing").
export const WALK_IDLE_MS = 60_000;
// The end of the process's stderr its failure's log line carries.
const MAX_STDERR_CHARS = 2000;

interface Pending {
  readonly batchFiles: number;
  readonly batches: Array<Extract<WalkReply, { kind: 'files' }>>;
  ended: { readonly errors: readonly string[]; readonly error?: Error } | undefined;
  // settles the iteration waiting for a batch or the end
  wake: (() => void) | undefined;
}

interface Running {
  readonly child: WalkChild;
  readonly walks: Map<number, Pending>;
  // walks cancelled, or ended while reading ahead, whose released has not come: their reads still hold the process's pool
  readonly held: Set<number>;
  stderr: string;
  // armed while the process has no walk and no held read
  idle: NodeJS.Timeout | undefined;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function settle(pending: Pending, ended: NonNullable<Pending['ended']>): void {
  pending.ended ??= ended;
  pending.wake?.();
  pending.wake = undefined;
}

/** The walk process, entry (dist/walk-child.js, an absolute path) run by this process's executable as Node, on the process launcher. */
export function startWalkChild(entry: string): WalkChild {
  const launcher = processLauncher();
  // Windows: the job's kill on close ends the process with this one, whatever else holds its stdin open.
  const job = process.platform === 'win32' ? launcher.createSessionJob() : undefined;
  const child = launcher.launch({
    file: process.execPath,
    args: [entry],
    // Electron's executable in main, Core and VS Code's extension host, which runs as Node only with this variable set
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    ...(job ? { job: job.id } : {}),
  });
  const exited = Promise.all([child.exited, child.closed]).then(([exit]) => exit);
  const release = (): void => job?.dispose();
  exited.then(release, release);
  return lineWalkChild({
    onData: (stream, listener) => child.onData(stream, listener),
    write: (text) => child.write(text),
    exited,
    kill: () => child.kill({ tree: true, signal: 'SIGKILL' }),
  });
}

/** A walk process as byte streams: one JSON message a line on its stdin and stdout. */
export interface LineWalkProcess {
  onData(stream: 'stdout' | 'stderr', listener: (chunk: Buffer) => void): void;
  // rejects when the process closed first
  write(text: string): Promise<void>;
  readonly exited: Promise<ProcessExit>;
  kill(): void;
}

/** The line protocol's side of WalkChild: a reply line longer than MAX_WALK_LINE_BYTES or not JSON is a fault. */
export function lineWalkChild(child: LineWalkProcess): WalkChild {
  return {
    onReply: (listener, onFault) => child.onData('stdout', lineReader(MAX_WALK_LINE_BYTES, (line) => {
      let reply: unknown;
      try {
        reply = JSON.parse(line);
      } catch {
        onFault('sent a malformed reply');
        return;
      }
      listener(reply);
    }, () => onFault(`sent a reply longer than ${MAX_WALK_LINE_BYTES} bytes`))),
    onStderr: (listener) => child.onData('stderr', (chunk) => listener(chunk.toString('utf8'))),
    send: (request) => child.write(walkLine(request)),
    exited: child.exited,
    kill: () => child.kill(),
  };
}

/**
 * Runs walks on walk processes, started by the walks that find every running one busy, up to MAX_WALK_PROCESSES, and kept for
 * the walks after them until one has had no walk and no held read for WALK_IDLE_MS, each walk by its own id. A walk goes to a process with no walk, else to the one with the fewest; a walk
 * cancelled or ended while reading ahead counts until the process says its reads settled (released). A walk takes
 * a batch at a time: the process sends WALK_CREDIT batches ahead, and each batch the iteration takes acks one more. A process that
 * exits, cannot start or sends a reply outside the contract is killed and every walk it ran ends with an error; no process starts
 * once MAX_WALK_FAILURES failed within WALK_FAILURE_WINDOW_MS, and each cause is logged the first time.
 */
export function createWalkHost(start: () => WalkChild, log: (line: string) => void): WalkHost {
  let running: Running[] = [];
  // killed for idleness and not yet exited
  let retiring: Running[] = [];
  let nextId = 0;
  let failures: number[] = [];
  const loggedCauses = new Set<string>();

  const recentFailures = (now: number): number[] => failures.filter((at) => now - at < WALK_FAILURE_WINDOW_MS);

  const live = (run: Running): boolean => running.includes(run);

  const fail = (run: Running, reason: string): void => {
    if (!live(run)) return;
    running = running.filter((other) => other !== run);
    clearTimeout(run.idle);
    failures = [...recentFailures(Date.now()), Date.now()];
    if (!loggedCauses.has(reason)) {
      loggedCauses.add(reason);
      const stderr = run.stderr.trim();
      log(`[walk] the walk process ${reason}${stderr === '' ? '' : `; its stderr ends: ${stderr}`}`);
    }
    if (failures.length === MAX_WALK_FAILURES) log(`[walk] the walk process failed ${MAX_WALK_FAILURES} times within ${WALK_FAILURE_WINDOW_MS / 60_000} minutes; no walk starts it until a failure is that old`);
    run.child.kill();
    for (const pending of run.walks.values()) settle(pending, { errors: [], error: new Error(`The walk process ${reason}`) });
    run.walks.clear();
  };

  // a failed write means the process is going; the kill makes sure its exit ends the walks waiting on it
  const send = (run: Running, request: WalkRequest): void => {
    run.child.send(request).catch(() => run.child.kill());
  };

  const load = (run: Running): number => run.walks.size + run.held.size;

  // Out of running before the kill, so fail's live guard counts its exit as no failure; close waits for it as for a live one.
  const retire = (run: Running): void => {
    running = running.filter((other) => other !== run);
    retiring.push(run);
    const gone = (): void => {
      retiring = retiring.filter((other) => other !== run);
    };
    run.child.exited.then(gone, gone);
    run.child.kill();
  };

  const settleIdle = (run: Running): void => {
    if (!live(run) || load(run) > 0 || run.idle !== undefined) return;
    run.idle = setTimeout(() => retire(run), WALK_IDLE_MS);
    run.idle.unref();
  };

  const receive = (run: Running, message: unknown): void => {
    if (!live(run)) return;
    const reply = parseWalkReply(message);
    if (!reply) {
      fail(run, 'sent a malformed reply');
      return;
    }
    if (reply.kind === 'released') {
      run.held.delete(reply.id);
      settleIdle(run);
      return;
    }
    const pending = run.walks.get(reply.id);
    if (!pending) {
      // a walk cancelled meanwhile; an end that crossed its cancel says whether a released follows
      if (reply.kind === 'end' && reply.reading !== true) run.held.delete(reply.id);
      settleIdle(run);
      return;
    }
    if (reply.kind === 'files') {
      if (reply.files.length > pending.batchFiles) {
        fail(run, 'sent a malformed reply');
        return;
      }
      // every batch queued here is one the host has not acked
      if (pending.batches.length >= WALK_CREDIT) {
        fail(run, 'sent more batches than its credit');
        return;
      }
      pending.batches.push(reply);
      pending.wake?.();
      pending.wake = undefined;
      return;
    }
    run.walks.delete(reply.id);
    if (reply.reading) run.held.add(reply.id);
    settle(pending, { errors: reply.errors, ...(reply.error !== undefined ? { error: new Error(reply.error) } : {}) });
    settleIdle(run);
  };

  const spawn = (): Running => {
    const run: Running = { child: start(), walks: new Map(), held: new Set(), stderr: '', idle: undefined };
    run.child.onReply((reply) => receive(run, reply), (reason) => fail(run, reason));
    run.child.onStderr((text) => {
      run.stderr = `${run.stderr}${text}`.slice(-MAX_STDERR_CHARS);
    });
    run.child.exited.then(
      ({ code, signal }) => fail(run, signal !== null ? `was ended by ${signal}` : `exited with code ${code}`),
      (err: unknown) => fail(run, `could not start: ${errorText(err)}`),
    );
    running.push(run);
    return run;
  };

  // undefined once no process runs and MAX_WALK_FAILURES failed within the window
  const pick = (): Running | undefined => {
    const idle = running.find((run) => load(run) === 0);
    if (idle) return idle;
    if (running.length < MAX_WALK_PROCESSES && recentFailures(Date.now()).length < MAX_WALK_FAILURES) return spawn();
    return running.reduce<Running | undefined>((least, run) => (least === undefined || load(run) < load(least) ? run : least), undefined);
  };

  return {
    walk: (spec, signal) => {
      const id = nextId++;
      const pending: Pending = { batchFiles: maxBatchFiles(spec), batches: [], ended: undefined, wake: undefined };
      const errors: string[] = [];
      const modified = new Map<string, number>();
      const run = signal?.aborted ? undefined : pick();
      if (signal?.aborted) {
        settle(pending, { errors: [], error: new Error('Operation aborted') });
      } else if (run === undefined) {
        settle(pending, { errors: [], error: new Error(`The walk process failed ${MAX_WALK_FAILURES} times within ${WALK_FAILURE_WINDOW_MS / 60_000} minutes`) });
      } else {
        clearTimeout(run.idle);
        run.idle = undefined;
        run.walks.set(id, pending);
        send(run, { kind: 'walk', id, ...spec });
      }
      // the process forgets the walk; whatever it sent before the cancel reached it is dropped here
      const cancel = (): void => {
        if (run !== undefined && run.walks.delete(id) && live(run)) {
          run.held.add(id);
          send(run, { kind: 'cancel', id });
        }
        pending.batches.length = 0;
        settle(pending, { errors: [], error: new Error('Operation aborted') });
      };
      signal?.addEventListener('abort', cancel, { once: true });
      async function* batches(): AsyncGenerator<readonly string[], void, undefined> {
        try {
          for (;;) {
            const batch = pending.batches.shift();
            if (batch !== undefined) {
              if (run !== undefined && live(run) && run.walks.has(id)) send(run, { kind: 'ack', id });
              for (const [index, time] of batch.times ?? []) modified.set(batch.files[index]!, time);
              yield batch.files;
            } else if (pending.ended) {
              errors.push(...pending.ended.errors);
              if (pending.ended.error) throw pending.ended.error;
              return;
            } else {
              await new Promise<void>((resolve) => (pending.wake = resolve));
            }
          }
        } finally {
          signal?.removeEventListener('abort', cancel);
          if (!pending.ended) cancel();
        }
      }
      const iterator = batches();
      return { [Symbol.asyncIterator]: () => iterator, errors, modified };
    },
    close: async () => {
      const killed = running;
      const closing = [...killed, ...retiring];
      if (closing.length === 0) return;
      running = [];
      for (const run of killed) {
        clearTimeout(run.idle);
        for (const pending of run.walks.values()) settle(pending, { errors: [], error: new Error('The walk process was closed') });
        run.walks.clear();
        run.child.kill();
      }
      let timer: NodeJS.Timeout | undefined;
      const exited = Promise.all(closing.map((run) => run.child.exited.then(() => undefined, () => undefined))).then(() => true);
      const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), WALK_CLOSE_WAIT_MS);
      });
      const done = await Promise.race([exited, timedOut]);
      clearTimeout(timer);
      if (!done) log(`[walk] a walk process did not exit within ${WALK_CLOSE_WAIT_MS} ms of its kill`);
    },
  };
}

let installed: WalkHost | undefined;

/** Installs the process's walk host, the one walkHost() answers, and returns the one it replaces. */
export function installWalkHost(host: WalkHost): WalkHost | undefined {
  const previous = installed;
  installed = host;
  return previous;
}

export function walkHost(): WalkHost {
  if (!installed) throw new Error('No walk host installed: the host must call installWalkHost() before Core walks a folder');
  return installed;
}
