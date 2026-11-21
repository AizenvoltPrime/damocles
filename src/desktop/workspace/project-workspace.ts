import type { LocalFileSystem, WorkspaceFileSystem } from './file-system';
import type { Formatter } from './format/formatter';
import type { QuickOpenListing } from './quick-open-listing';
import type { SearchRunner } from './search/search-runner';
import type { HostTerminalBackend, TerminalBackend } from './terminal/terminal-backend';
import type { HostTreeListing, TreeListing } from './tree-listing';

// The services of the host holding a project's files. Arguments and results stay structured-clone values and every stream a
// listener or handle whose events carry their run, watch or terminal id, so a remote client can serve it over a channel.
export interface ProjectWorkspace {
  readonly files: WorkspaceFileSystem;
  readonly tree: TreeListing;
  readonly search: SearchRunner;
  readonly quickOpen: QuickOpenListing;
  readonly format: Formatter;
  readonly terminals: TerminalBackend;
}

// This computer's workspace. A daemon serves one, picking each request's LinkRule through under.
export interface LocalWorkspace extends ProjectWorkspace {
  readonly files: LocalFileSystem;
  readonly tree: HostTreeListing;
  readonly terminals: HostTerminalBackend;
}
