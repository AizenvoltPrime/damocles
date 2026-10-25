import * as path from 'node:path';
import type { FileWatcherFactory } from '../../../platform/file-watcher';
import { resolveRgPath } from '../../../core/chat-panel/ripgrep';
import { DAMOCLES_HOME_DIR } from '../../../core/paths';
import type { AppPaths } from '../../../platform/app-paths';
import { createFileSystem } from '../../workspace/file-system';
import { createFormatter } from '../../workspace/format/formatter';
import type { HostStarters } from '../../workspace/host-starters';
import type { ProjectWorkspace } from '../../workspace/project-workspace';
import { createQuickOpenListing } from '../../workspace/quick-open-listing';
import { createSearchRunner } from '../../workspace/search/search-runner';
import { createTerminalBackend } from '../../workspace/terminal/terminal-backend';
import { createTreeListing } from '../../workspace/tree-listing';
import { spawnFormatterHost } from '../formatting/formatter-process';
import { ptyHostPaths } from '../platform/app-paths';
import { spawnPtyHost } from '../terminal/pty-host-process';

export interface LocalWorkspaceDeps {
  readonly paths: AppPaths;
  readonly watchers: FileWatcherFactory;
  // Electron's shell.trashItem, and the permanent delete Files offers when it fails
  readonly trash: (absolutePath: string) => Promise<void>;
  readonly remove: (absolutePath: string) => Promise<void>;
  // zsh's ZDOTDIR for integrated shells, in the user's app data
  readonly zshDotDir: string;
  readonly homedir: string;
  readonly log: (line: string) => void;
}

/** This computer's workspace, run in main with utility process hosts. */
export function createLocalWorkspace(deps: LocalWorkspaceDeps): ProjectWorkspace {
  const pty = ptyHostPaths(deps.paths);
  const starters: HostStarters = {
    startPtyHost: () => spawnPtyHost(pty.script, pty.nodePty),
    startFormatterHost: (root) => spawnFormatterHost(path.join(deps.paths.unpackedRoot, 'dist', 'formatter-host.js'), root),
  };
  const rgPath = (): Promise<string> => resolveRgPath(deps.paths);
  return {
    files: createFileSystem({ watchers: deps.watchers, trash: deps.trash, remove: deps.remove, damoclesHome: DAMOCLES_HOME_DIR, log: deps.log }),
    tree: createTreeListing(deps.log),
    search: createSearchRunner({ rgPath, log: deps.log }),
    quickOpen: createQuickOpenListing({ rgPath, log: deps.log }),
    format: createFormatter({ starters, watchers: deps.watchers, log: deps.log }),
    terminals: createTerminalBackend({
      starters,
      platform: process.platform,
      scriptsDir: pty.shellIntegration,
      zshDotDir: deps.zshDotDir,
      homedir: deps.homedir,
      env: process.env,
      log: deps.log,
    }),
  };
}
