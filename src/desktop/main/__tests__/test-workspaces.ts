import { rgPath } from '@vscode/ripgrep';
import { DAMOCLES_HOME_DIR } from '../../../core/paths';
import type { FileWatcherFactory } from '../../../platform/file-watcher';
import type { CoreTransport } from '../../core-protocol/endpoint';
import { createEndpoint, type Endpoint } from '../../core-protocol/endpoint';
import { ERROR_CODEC } from '../../core-protocol/errors';
import type { TerminalHub } from '../../daemon/terminal-hub';
import { createWorkspaceHost, type WorkspaceModules } from '../../daemon/workspace-host';
import { createFileSystem, type FileSystemDeps } from '../../workspace/file-system';
import type { Formatter } from '../../workspace/format/formatter';
import { CLIENT_TO_WORKSPACE, WORKSPACE_TO_CLIENT, type ClientToWorkspace, type WorkspaceToClient } from '../../workspace/messages';
import type { ProjectWorkspace } from '../../workspace/project-workspace';
import { createQuickOpenListing, type QuickOpenListingDeps } from '../../workspace/quick-open-listing';
import { createSearchRunner, type SearchRunnerDeps } from '../../workspace/search/search-runner';
import type { TerminalBackend } from '../../workspace/terminal/terminal-backend';
import { createTreeListing } from '../../workspace/tree-listing';
import { createRemoteWorkspace } from '../workspace/remote-workspace';
import { createWorkspaces, NotConnectedError, type Workspaces } from '../workspace/workspaces';

export interface TestWorkspaceOptions {
  readonly watchers: FileWatcherFactory;
  readonly trash?: FileSystemDeps['trash'];
  readonly remove?: FileSystemDeps['remove'];
  // the folder readHostSettings and writeHostSettings name; default: the hermetic home's
  readonly damoclesHome?: string;
  // the workspace of an authority other than local; default: none connected
  readonly remote?: (authorityKey: string) => ProjectWorkspace;
  readonly rgPath?: () => Promise<string>;
  readonly spawnSearchRg?: SearchRunnerDeps['spawnRg'];
  readonly spawnListingRg?: QuickOpenListingDeps['spawnRg'];
  readonly format?: Formatter;
  readonly terminals?: TerminalBackend;
  // the daemon watcher's inotify limit reports; default: none
  readonly watchLimits?: WorkspaceModules['watchLimits'];
  readonly log?: (line: string) => void;
}

function unused<T extends object>(name: string): T {
  return new Proxy({} as T, { get: (_target, key) => { throw new Error(`the test workspace has no ${name} (${String(key)})`); } });
}

function localModules(options: TestWorkspaceOptions): ProjectWorkspace {
  const log = options.log ?? (() => undefined);
  const resolveRg = options.rgPath ?? (async () => rgPath);
  return {
    files: createFileSystem({ watchers: options.watchers, trash: options.trash ?? (async () => { throw new Error('no trash in this test'); }), ...(options.remove ? { remove: options.remove } : {}), damoclesHome: options.damoclesHome ?? DAMOCLES_HOME_DIR, log }),
    tree: createTreeListing(log),
    search: createSearchRunner({ rgPath: resolveRg, log, ...(options.spawnSearchRg ? { spawnRg: options.spawnSearchRg } : {}) }),
    quickOpen: createQuickOpenListing({ rgPath: resolveRg, log, ...(options.spawnListingRg ? { spawnRg: options.spawnListingRg } : {}) }),
    format: options.format ?? unused<Formatter>('formatter'),
    terminals: options.terminals ?? unused<TerminalBackend>('terminal backend'),
  };
}

/** The local workspace's real modules over the test's watchers and ripgrep, with the parts a test does not use refusing calls. */
export function testWorkspaces(options: TestWorkspaceOptions): Workspaces {
  return createWorkspaces(localModules(options), options.remote ?? ((authorityKey) => { throw new NotConnectedError(`no ${authorityKey} workspace in this test`); }));
}

export interface TestRemote {
  // the connected workspace; throws NotConnectedError, as main's does, once disconnected
  workspace(): ProjectWorkspace;
  // the client end of the workspace channel, as a connection's workspace endpoint
  readonly endpoint: Endpoint<ClientToWorkspace, WorkspaceToClient>;
  // ends the connection: its streams end and every later call fails
  disconnect(reason: string): void;
}

// Two ends of an in-memory channel; each message arrives on a later task, structured-cloned as the wire copies it.
function channel(): readonly [CoreTransport, CoreTransport] {
  const listeners = [new Set<(raw: unknown) => void>(), new Set<(raw: unknown) => void>()] as const;
  const end = (own: 0 | 1): CoreTransport => ({
    post: (message) => {
      const copy = structuredClone(message);
      setImmediate(() => listeners[own === 0 ? 1 : 0].forEach((listener) => listener(copy)));
    },
    onMessage: (listener) => {
      listeners[own].add(listener);
      return { dispose: () => listeners[own].delete(listener) };
    },
  });
  return [end(0), end(1)];
}

/**
 * A remote authority in tests: this computer's real modules behind the daemon's workspace host, reached through the remote
 * client over an in-memory channel, so a service sees remote keys, rebuilt errors and connection ends as main does.
 */
export function testRemote(options: TestWorkspaceOptions & { readonly authorityKey?: string }): TestRemote {
  const log = options.log ?? (() => undefined);
  const authorityKey = options.authorityKey ?? 'loopback';
  const modules = localModules(options);
  const hub = { list: async () => [], post: () => { throw new Error('no terminal hub in this test'); }, detach: () => undefined } as unknown as TerminalHub;
  const watchLimits = options.watchLimits ?? { roots: () => [], onReached: () => ({ dispose: () => undefined }), limit: async () => null };
  const host = createWorkspaceHost({ ...modules, hub, terminalCredentials: () => ({}), watchLimits }, log);
  const [clientEnd, hostEnd] = channel();
  const served = host.serve('test-connection', 'test-client', hostEnd, (reason) => { throw new Error(reason); });
  const endpoint = createEndpoint<ClientToWorkspace, WorkspaceToClient>({ transport: clientEnd, outgoing: CLIENT_TO_WORKSPACE, incoming: WORKSPACE_TO_CLIENT, log, errors: ERROR_CODEC });
  const closeListeners = new Set<(reason: string) => void>();
  let closedWith: string | undefined;
  const workspace = createRemoteWorkspace({
    endpoint,
    authorityKey,
    projectOfCwd: () => undefined,
    onClose: (listener) => {
      if (closedWith !== undefined) listener(closedWith);
      else closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
    notConnected: () => new NotConnectedError(`${authorityKey} is not connected.`),
    watchReady: true,
    log,
  });
  return {
    endpoint,
    workspace: () => {
      if (closedWith !== undefined) throw new NotConnectedError(`${authorityKey} is not connected.`);
      return workspace;
    },
    disconnect: (reason) => {
      if (closedWith !== undefined) return;
      closedWith = reason;
      endpoint.close(reason);
      served.dispose();
      for (const listener of [...closeListeners]) listener(reason);
    },
  };
}
