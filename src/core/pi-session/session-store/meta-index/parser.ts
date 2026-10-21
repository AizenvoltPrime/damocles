// pi's full parse of one session file, the index's only heavy work. In the worker it runs on a thread of its own, so the
// thread that answers requests from the index is never held by a parse (docs/invariants.md "Session store").
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker, type MessagePort } from 'node:worker_threads';
import { log } from '../../../logger';
import { sessionFileMeta } from '../metadata';
import type { SessionMetaEntry } from './protocol';

type PiModule = typeof import('@earendil-works/pi-coding-agent');

export type ParsedMeta = Pick<SessionMetaEntry, 'stored' | 'prompts'>;

export interface SessionFileParser {
  /** What the file yields; undefined when it could not be parsed at all (pi did not load, or the parse thread stopped). */
  parse(file: string, mtimeMs: number): Promise<ParsedMeta | undefined>;
  close(): Promise<void>;
}

export const SESSION_META_PARSE_MARKER = 'damocles-session-meta-parse';

interface ParseWorkerData {
  readonly marker: typeof SESSION_META_PARSE_MARKER;
  readonly piPackageDir: string;
}

type ParseRequest = { readonly id: number; readonly file: string; readonly mtimeMs: number };
type ParseAnswer = { readonly type: 'parsed'; readonly id: number; readonly meta: ParsedMeta | undefined } | { readonly type: 'log'; readonly message: string };

function loadPi(piPackageDir: string): Promise<PiModule | null> {
  return import(pathToFileURL(path.join(piPackageDir, 'dist', 'index.js')).href).then(
    (mod) => mod as PiModule,
    (err: unknown) => {
      log('[session-meta-index] loading pi from %s failed: %O', piPackageDir, err);
      return null;
    },
  );
}

// A file pi cannot read yields no session, which the index caches like any other row.
function parseWithPi(pi: PiModule, file: string, mtimeMs: number): ParsedMeta {
  try {
    // The session dir is the file's own parent, never recomputed from a workspace cwd.
    return sessionFileMeta(pi.SessionManager.open(file, path.dirname(file)), mtimeMs);
  } catch (err) {
    log('[session-meta-index] reading %s failed: %O', file, err);
    return { stored: null, prompts: [] };
  }
}

/** Parses on the calling thread, loading pi on the first parse; a test's spy on pi sees its parses. */
export function createInlineParser(piPackageDir: string): SessionFileParser {
  let pi: Promise<PiModule | null> | undefined;
  return {
    async parse(file, mtimeMs) {
      const loaded = await (pi ??= loadPi(piPackageDir));
      if (!loaded) return undefined;
      // Each parse is synchronous, so yield before it and let other requests in.
      await new Promise((resolve) => setImmediate(resolve));
      return parseWithPi(loaded, file, mtimeMs);
    },
    close: async () => undefined,
  };
}

/** pi reads a whole file into memory; a file that needs more than this stops the parse thread instead of growing the process. */
export const PARSE_THREAD_HEAP_MB = 2048;
/** A parse thread that answers nothing this long while parses wait is stopped, so a file pi never finishes cannot hold a list open. */
export const PARSE_STALL_MS = 60_000;

/** Parses on a worker started from `entry` (this bundle) on the first parse, one file at a time, in request order. */
export function createThreadParser(entry: string, piPackageDir: string, stallMs: number = PARSE_STALL_MS): SessionFileParser {
  let worker: Worker | undefined;
  let nextId = 1;
  const waiting = new Map<number, (meta: ParsedMeta | undefined) => void>();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;

  const watchStall = (): void => {
    clearTimeout(stallTimer);
    stallTimer = undefined;
    const watched = worker;
    if (!watched || waiting.size === 0) return;
    stallTimer = setTimeout(() => {
      if (worker !== watched) return;
      stopped(`no answer for ${stallMs}ms`);
      void watched.terminate();
    }, stallMs);
    stallTimer.unref();
  };

  const stopped = (reason: string): void => {
    if (waiting.size > 0) log('[session-meta-index] the parse thread stopped (%s); %d parse(s) dropped', reason, waiting.size);
    for (const done of waiting.values()) done(undefined);
    waiting.clear();
    worker = undefined;
    watchStall();
  };

  const start = (): Worker => {
    const started = new Worker(entry, {
      workerData: { marker: SESSION_META_PARSE_MARKER, piPackageDir } satisfies ParseWorkerData,
      resourceLimits: { maxOldGenerationSizeMb: PARSE_THREAD_HEAP_MB },
    });
    started.on('message', (answer: ParseAnswer) => {
      if (answer.type === 'log') {
        log('%s', answer.message);
        return;
      }
      const done = waiting.get(answer.id);
      waiting.delete(answer.id);
      done?.(answer.meta);
      if (worker === started) watchStall();
    });
    started.on('error', (err) => log('[session-meta-index] the parse thread failed: %O', err));
    started.on('exit', (code) => {
      if (worker === started) stopped(`exit code ${code}`);
    });
    // The index worker ends when its host closes it, never held open by an idle parse thread.
    started.unref();
    return started;
  };

  return {
    parse(file, mtimeMs) {
      const id = nextId++;
      worker ??= start();
      const answered = new Promise<ParsedMeta | undefined>((resolve) => waiting.set(id, resolve));
      worker.postMessage({ id, file, mtimeMs } satisfies ParseRequest);
      if (stallTimer === undefined) watchStall();
      return answered;
    },
    async close() {
      const running = worker;
      worker = undefined;
      stopped('closed');
      await running?.terminate();
    },
  };
}

/** The parse thread's side: one parse per message, answered in order. */
export function serveParser(port: MessagePort, piPackageDir: string): void {
  const inline = createInlineParser(piPackageDir);
  let queue: Promise<void> = Promise.resolve();
  port.on('message', (request: ParseRequest) => {
    queue = queue.then(async () => {
      port.postMessage({ type: 'parsed', id: request.id, meta: await inline.parse(request.file, request.mtimeMs) } satisfies ParseAnswer);
    });
  });
}

export function isParseWorkerData(data: unknown): data is ParseWorkerData {
  return typeof data === 'object' && data !== null && (data as Partial<ParseWorkerData>).marker === SESSION_META_PARSE_MARKER;
}
