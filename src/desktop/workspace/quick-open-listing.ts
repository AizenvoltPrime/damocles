import type { WalkHost } from '../../core/search-walk';
import type { WalkSwitches } from '../../platform/walk-settings';
import { isRelativeFilePath } from '../../shared/relative-path';

export interface FileListingSink {
  // files below the root, '/'-separated, each one isRelativeFilePath passes
  files(batch: readonly string[]): void;
  // once, after the last batch; never after a kill, on either host; error: the listing failed
  end(error?: string): void;
}

export interface FileListing {
  kill(): void;
}

export interface QuickOpenListing {
  // every file under root the walk lists with walk's switches and each exclude as a `!` override, `.git` folders included
  list(root: string, walk: WalkSwitches, excludes: readonly string[], sink: FileListingSink): FileListing;
}

export interface QuickOpenListingDeps {
  readonly walks: WalkHost;
  readonly log: (line: string) => void;
}

/** Quick Open's file listing through the walk host's processes; the caller scores the paths. */
export function createQuickOpenListing(deps: QuickOpenListingDeps): QuickOpenListing {
  return {
    list(root, { ignore, followLinks }, excludes, sink) {
      const controller = new AbortController();
      const { signal } = controller;
      // `.git` is left to the excludes, as rg with --hidden leaves it
      const walk = deps.walks.walk({ root, requireGit: true, ignore, gitFolders: 'list', overrides: excludes.map((glob) => `!${glob}`), ...(followLinks ? { followLinks: true } : {}) }, signal);
      void (async () => {
        try {
          for await (const batch of walk) {
            // a name Quick Open cannot name (a '\' in a POSIX name, a path past its bound) is left out
            const files = batch.filter(isRelativeFilePath);
            if (files.length > 0 && !signal.aborted) sink.files(files);
          }
        } catch (err) {
          if (!signal.aborted) sink.end(err instanceof Error ? err.message : String(err));
          return;
        }
        if (walk.errors.length > 0) deps.log(`[quick-open] listing ${root} skipped folders or links it could not read: ${walk.errors.join('; ').slice(0, 500)}`);
        if (!signal.aborted) sink.end();
      })();
      return { kill: () => controller.abort() };
    },
  };
}
