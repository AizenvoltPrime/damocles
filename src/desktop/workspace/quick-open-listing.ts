import { StringDecoder } from 'node:string_decoder';
import { ripgrepFileArgs } from '../quick-open-worker/protocol';
import { spawnRipgrep, type RgProcess } from './search/search-runner';

// Characters of a listing's ripgrep stderr kept for the log and the failure.
const MAX_LISTING_STDERR_CHARS = 4096;

export interface FileListingSink {
  // ripgrep's stdout: one path per line
  data(chunk: Buffer): void;
  // once, after the last data; never after a kill, on either host; error: the listing failed
  end(error?: string): void;
}

export interface FileListing {
  // ripgrep starts no process (its Windows console host ends with it), so this kill through the handle is the whole tree
  kill(): void;
}

export interface QuickOpenListing {
  // every file under root, as `rg --files` prints them relative to it
  list(root: string, ignoreArgs: readonly string[], excludes: readonly string[], sink: FileListingSink): FileListing;
}

export interface QuickOpenListingDeps {
  readonly rgPath: () => Promise<string>;
  readonly log: (line: string) => void;
  readonly spawnRg?: (rgPath: string, args: readonly string[]) => RgProcess;
}

/** Quick Open's ripgrep file listing; the caller scores the paths. */
export function createQuickOpenListing(deps: QuickOpenListingDeps): QuickOpenListing {
  return {
    list(root, ignoreArgs, excludes, sink) {
      let killed = false;
      let rg: RgProcess | undefined;
      void (async () => {
        let rgPath: string;
        try {
          rgPath = await deps.rgPath();
        } catch (err) {
          if (!killed) sink.end(err instanceof Error ? err.message : String(err));
          return;
        }
        // killed meanwhile: nobody is left to kill a ripgrep started now
        if (killed) return;
        const started = (deps.spawnRg ?? ((file, args) => spawnRipgrep(file, args)))(rgPath, ripgrepFileArgs(root, ignoreArgs, excludes));
        rg = started;
        let stderr = '';
        let ended = false;
        const end = (error: string | undefined): void => {
          if (ended || killed) return;
          ended = true;
          sink.end(error);
        };
        started.onData('stdout', (chunk) => {
          if (!killed) sink.data(chunk);
        });
        const decoder = new StringDecoder('utf8');
        started.onData('stderr', (chunk) => {
          if (stderr.length < MAX_LISTING_STDERR_CHARS) stderr += decoder.write(chunk).slice(0, MAX_LISTING_STDERR_CHARS - stderr.length);
        });
        Promise.all([started.exited, started.closed]).then(([{ code }]) => {
          // 1 is ripgrep's "nothing found".
          if (code !== 0 && code !== 1) {
            end(`ripgrep exited with ${String(code)}: ${stderr.trim()}`);
            return;
          }
          if (stderr.trim() !== '') deps.log(`[quick-open] ripgrep: ${stderr.trim().slice(0, 500)}`);
          end(undefined);
        }, (err: Error) => end(err.message));
      })();
      return {
        kill: () => {
          killed = true;
          rg?.kill();
        },
      };
    },
  };
}
