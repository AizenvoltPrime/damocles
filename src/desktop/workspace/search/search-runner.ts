import { StringDecoder } from 'node:string_decoder';
import { processLauncher, type LaunchedProcess } from '../../../core/process-launcher';

// Characters of ripgrep's stderr kept for the error and the log.
const MAX_STDERR_CHARS = 4096;
// Bytes of one ripgrep JSON event read; a longer one is dropped unread. --json prints each matching line whole, and a
// multi-line match's lines can be a whole file, which the reader would hold several times over while it decodes them.
export const MAX_RG_EVENT_BYTES: number = 32 * 1024 * 1024;

export type RgProcess = Pick<LaunchedProcess, 'onData' | 'exited' | 'closed' | 'kill'>;

export function spawnRipgrep(rgPath: string, args: readonly string[], cwd?: string): RgProcess {
  return processLauncher().launch({ file: rgPath, args, ...(cwd !== undefined ? { cwd } : {}), stdio: ['ignore', 'pipe', 'pipe'] });
}

// One event of ripgrep's --json output.
export interface RgEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

// error: ripgrep could not run; else its exit code and the start of its stderr
export type SearchRunEnd = { readonly code: number | null; readonly stderr: string } | { readonly error: string };

export interface SearchRunSink {
  event(event: RgEvent): void;
  // an event over MAX_RG_EVENT_BYTES, dropped unread
  dropped(): void;
  // once, after the last event; never after a kill
  end(end: SearchRunEnd): void;
}

export interface SearchRun {
  kill(): void;
}

export interface SearchRunner {
  run(cwd: string, args: readonly string[], sink: SearchRunSink): SearchRun;
}

export interface SearchRunnerDeps {
  readonly rgPath: () => Promise<string>;
  readonly log: (line: string) => void;
  readonly spawnRg?: (rgPath: string, args: readonly string[], cwd: string) => RgProcess;
}

/**
 * Calls onLine with each line of the chunks it is pushed, and onDropped instead for a line longer than maxBytes, which is never
 * held whole; end() ends the last line.
 */
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

/** Search's ripgrep runs: the process, its --json lines read as events, and its exit; the caller builds the results. */
export function createSearchRunner(deps: SearchRunnerDeps): SearchRunner {
  return {
    run(cwd, args, sink) {
      let killed = false;
      let rg: RgProcess | undefined;
      const execute = async (): Promise<void> => {
        const rgPath = await deps.rgPath();
        if (killed) return;
        const started = (deps.spawnRg ?? spawnRipgrep)(rgPath, args, cwd);
        rg = started;
        let dropped = 0;
        const lines = lineReader(MAX_RG_EVENT_BYTES, (line) => {
          if (killed) return;
          let event: RgEvent;
          try {
            event = JSON.parse(line) as RgEvent;
          } catch {
            deps.log('[search] dropping a ripgrep line that is not JSON');
            return;
          }
          sink.event(event);
        }, () => {
          dropped++;
          if (!killed) sink.dropped();
        });
        started.onData('stdout', (chunk) => lines.push(chunk));
        let stderr = '';
        const decoder = new StringDecoder('utf8');
        started.onData('stderr', (chunk) => {
          if (stderr.length < MAX_STDERR_CHARS) stderr += decoder.write(chunk).slice(0, MAX_STDERR_CHARS - stderr.length);
        });
        // The close follows every chunk of output.
        Promise.all([started.exited, started.closed]).then(([{ code }]) => {
          lines.end();
          if (dropped > 0) deps.log(`[search] dropped ${dropped} ripgrep events over ${MAX_RG_EVENT_BYTES} bytes`);
          const trimmed = stderr.trim();
          if (trimmed !== '') deps.log(`[search] ripgrep: ${trimmed.slice(0, 500)}`);
          if (!killed) sink.end({ code, stderr: trimmed });
        }, (err: Error) => {
          if (!killed) sink.end({ error: err.message });
        });
      };
      execute().catch((err: unknown) => {
        if (!killed) sink.end({ error: err instanceof Error ? err.message : String(err) });
      });
      return {
        kill: () => {
          killed = true;
          rg?.kill();
        },
      };
    },
  };
}
