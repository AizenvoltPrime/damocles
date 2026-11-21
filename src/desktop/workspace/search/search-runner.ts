import { batchLineBudget, GlobSyntaxError, overrideRules, runWalkedRg, type WalkHost, type WalkIgnore, type WalkStream } from '../../../core/search-walk';

// Characters of ripgrep's stderr, and of the walk's errors, kept for the error and the log.
const MAX_STDERR_CHARS = 4096;
// Bytes of one ripgrep JSON event read; a longer one is dropped unread. --json prints each matching line whole, and a
// multi-line match's lines can be a whole file, which the reader would hold several times over while it decodes them.
const MAX_RG_EVENT_BYTES: number = 32 * 1024 * 1024;
// A file's events held for the NUL rule (runWalkedRg) are read past and released once their lines pass this many UTF-8 bytes.
const SEARCH_HOLD_BYTES: number = 1024 * 1024;

// One event of ripgrep's --json output.
export interface RgEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

// error: the search could not run; else ripgrep's exit code over the whole search and the start of its stderr
export type SearchRunEnd = { readonly code: number | null; readonly stderr: string } | { readonly error: string };

/** A content search (searchRequest): rg's matching flags, its pattern, and the walk that lists the files. */
export interface SearchRequest {
  readonly match: readonly string[];
  readonly pattern: string;
  readonly walk: { readonly ignore: WalkIgnore; readonly overrides: readonly string[]; readonly followLinks?: true };
}

export interface SearchRunSink {
  // a file's begin before its first event, its match and context events, then its end
  event(event: RgEvent): void;
  // an event over the runner's event bound (MAX_RG_EVENT_BYTES), dropped unread
  dropped(): void;
  // once, after the last event; never after a kill
  end(end: SearchRunEnd): void;
}

export interface SearchRun {
  kill(): void;
}

export interface SearchRunner {
  run(cwd: string, request: SearchRequest, sink: SearchRunSink): SearchRun;
}

export interface SearchRunnerDeps {
  readonly rgPath: () => Promise<string>;
  readonly walks: WalkHost;
  readonly log: (line: string) => void;
  // MAX_RG_EVENT_BYTES and SEARCH_HOLD_BYTES unless given
  readonly maxEventBytes?: number;
  readonly holdBytes?: number;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Search's runs: the walk lists the files below cwd, through links only under walk.followLinks, and rg only matches them, in
 * batches (runWalkedRg).
 * The end's code is rg's own over the whole search: 2 once any rg run or the walk failed, else 0 when anything matched, else 1.
 */
export function createSearchRunner(deps: SearchRunnerDeps): SearchRunner {
  const maxEventBytes = deps.maxEventBytes ?? MAX_RG_EVENT_BYTES;
  const holdBytes = deps.holdBytes ?? SEARCH_HOLD_BYTES;
  return {
    run(cwd, request, sink) {
      const controller = new AbortController();
      const { signal } = controller;
      let stderr = '';
      const keepStderr = (text: string): void => {
        if (text !== '' && stderr.length < MAX_STDERR_CHARS) stderr = `${stderr}${stderr === '' ? '' : '\n'}${text}`.slice(0, MAX_STDERR_CHARS);
      };
      let failed = false;
      let matched = false;
      let begun = false;
      let dropped = 0;
      // an rg run that searched nothing (no closing summary): every later run would fail the same way
      const refused = new Error('ripgrep refused the search');
      const execute = async (): Promise<SearchRunEnd> => {
        try {
          overrideRules(request.walk.overrides);
        } catch (err) {
          // rg's own wording, which Search shows
          if (err instanceof GlobSyntaxError) return { code: 2, stderr: err.message };
          throw err;
        }
        const rgPath = await deps.rgPath();
        if (signal.aborted) throw new Error('Operation aborted');
        const flags = ['--json', ...request.match];
        const { pattern } = request;
        let walk: WalkStream | undefined;
        try {
          await runWalkedRg({
            rgPath,
            cwd,
            flags,
            pattern,
            // .git is walked as any folder; only the excludes keep it out
            batches: (listing) => (walk = deps.walks.walk({ root: cwd, requireGit: true, ignore: request.walk.ignore, gitFolders: 'list', overrides: request.walk.overrides, lineBudget: Math.max(1, batchLineBudget(rgPath, flags, pattern)), ...(request.walk.followLinks ? { followLinks: true } : {}) }, listing)),
            signal,
            mustRelease: (held) => held.bytes > holdBytes,
            onEvent: (event) => {
              if (signal.aborted) return;
              if (event.type === 'end') {
                if (begun) sink.event(event as RgEvent);
                begun = false;
                return;
              }
              if (event.type !== 'match' && event.type !== 'context') return;
              if (!begun) sink.event({ type: 'begin', data: { path: event.data?.path } });
              begun = true;
              if (event.type === 'match') matched = true;
              sink.event(event as RgEvent);
            },
            done: () => false,
            runEnded: ({ code, stderr: text, summary }) => {
              keepStderr(text);
              if (code === 0 || code === 1) return undefined;
              failed = true;
              return summary ? undefined : refused;
            },
            maxEventBytes,
            onDropped: () => {
              dropped++;
              if (!signal.aborted) sink.dropped();
            },
          });
        } catch (err) {
          if (err !== refused) throw err;
        }
        if (walk !== undefined && walk.errors.length > 0) {
          failed = true;
          keepStderr(walk.errors.join('\n'));
        }
        return { code: failed ? 2 : matched ? 0 : 1, stderr };
      };
      execute().then((end) => {
        if (dropped > 0) deps.log(`[search] dropped ${dropped} ripgrep events over ${maxEventBytes} bytes`);
        if ('stderr' in end && end.stderr !== '') deps.log(`[search] ripgrep: ${end.stderr.slice(0, 500)}`);
        if (!signal.aborted) sink.end(end);
      }, (err: unknown) => {
        if (!signal.aborted) sink.end({ error: messageOf(err) });
      });
      return { kill: () => controller.abort() };
    },
  };
}
