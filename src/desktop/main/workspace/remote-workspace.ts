import type { Disposable } from '../../../platform/disposable';
import { EDITOR_MAX_DOCUMENT_BYTES } from '../../../shared/types/messages';
import { authorityKeyOfProject, targetFolderKeyOf } from '../../../shared/project-location';
import type { Endpoint } from '../../core-protocol/endpoint';
import type { Project } from '../../local-services/confine';
import type { PtyHostExit, PtyHostProcess } from '../../workspace/host-starters';
import type { ClientToWorkspace, WireFileBytes, WireIdentity, WorkspaceToClient } from '../../workspace/messages';
import type { FileBytes } from '../../local-services/file-bytes';
import type { EntryIdentity, WatchEvent } from '../../workspace/file-system';
import type { ProjectWorkspace } from '../../workspace/project-workspace';
import type { SearchRunSink } from '../../workspace/search/search-runner';
import type { FileListingSink } from '../../workspace/quick-open-listing';
import type { ProjectFileLocation } from '../../workspace/search/types';
import type { NotConnectedError } from './workspaces';

export interface RemoteWorkspaceDeps {
  // the workspace channel's endpoint, whose results and events its tables parse before they arrive here
  readonly endpoint: Endpoint<ClientToWorkspace, WorkspaceToClient>;
  readonly authorityKey: string;
  // the native folder key of the project a terminal starts in, for control.listRuns; undefined outside every project
  readonly projectOfCwd: (cwd: string) => string | undefined;
  // the connection ended; a terminal host's exit names it
  readonly onClose: (listener: (reason: string) => void) => Disposable;
  // what a request fails with once the connection closed, its localized message naming the host
  readonly notConnected: () => NotConnectedError;
  readonly log: (line: string) => void;
}

const asBuffer = (bytes: Uint8Array): Buffer => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const toWireIdentity = (identity: EntryIdentity): WireIdentity => ({ dev: identity.dev.toString(), ino: identity.ino.toString(), birthtimeNs: identity.birthtimeNs.toString() });

// More bytes than the read asked for are refused as the local read refuses a file over the limit.
function fromWireBytes(read: WireFileBytes, limitBytes: number): FileBytes {
  if (read.kind !== 'bytes') return read;
  if (read.bytes.byteLength > limitBytes) return { kind: 'tooLarge', bytes: read.bytes.byteLength };
  return { ...read, bytes: asBuffer(read.bytes) };
}

/**
 * The ProjectWorkspace of one authority over its connection's `workspace` channel. Project keys cross as the target's own
 * folder keys (docs/invariants.md "Remote daemon and wire"): this client strips the authority prefix on the way out, maps an answer
 * back to a project it sent, and refuses a key of any other authority. Streams are events keyed by the run and watch ids it
 * allocates.
 */
export function createRemoteWorkspace(deps: RemoteWorkspaceDeps): ProjectWorkspace {
  const { endpoint, authorityKey } = deps;

  const native = (projectKey: string): string => {
    const folderKey = targetFolderKeyOf(projectKey);
    if (folderKey === undefined || authorityKeyOfProject(projectKey) !== authorityKey) throw new Error(`The project key ${projectKey} is not on ${authorityKey}`);
    return folderKey;
  };
  const toWire = (project: Project): Project => ({ key: native(project.key), fsPath: project.fsPath, name: project.name });
  const locationToWire = (location: ProjectFileLocation): ProjectFileLocation => ({ ...location, projectKey: native(location.projectKey) });

  let closed = false;
  // a request on a closed connection, or one it closes under, fails as the host not being connected, never with the close reason
  const call: typeof endpoint.request = (method, params, signal) => {
    if (closed) return Promise.reject(deps.notConnected());
    return endpoint.request(method, params, signal).catch((err: unknown) => {
      throw closed ? deps.notConnected() : err;
    });
  };

  let nextId = 1;
  const watches = new Map<number, (event: WatchEvent) => void>();
  const searches = new Map<number, SearchRunSink>();
  const listings = new Map<number, FileListingSink>();
  const report = (what: string) => (err: unknown): void => deps.log(`[remote] ${what} failed: ${err instanceof Error ? err.message : String(err)}`);

  endpoint.onEvent('files.watchEvent', ({ watchId, kind, path }) => watches.get(watchId)?.({ kind, path }));
  endpoint.onEvent('search.event', ({ runId, event }) => searches.get(runId)?.event(event));
  endpoint.onEvent('search.dropped', ({ runId }) => searches.get(runId)?.dropped());
  endpoint.onEvent('search.end', ({ runId, end }) => {
    const sink = searches.get(runId);
    searches.delete(runId);
    sink?.end(end);
  });
  endpoint.onEvent('quickOpen.data', ({ runId, chunk }) => listings.get(runId)?.data(asBuffer(chunk)));
  endpoint.onEvent('quickOpen.end', ({ runId, error }) => {
    const sink = listings.get(runId);
    listings.delete(runId);
    sink?.end(error);
  });
  // a run still going when the connection ends ends with it
  deps.onClose((reason) => {
    closed = true;
    for (const sink of searches.values()) sink.end({ error: `The connection to the host ended: ${reason}` });
    for (const sink of listings.values()) sink.end(`The connection to the host ended: ${reason}`);
    searches.clear();
    listings.clear();
    watches.clear();
  });

  return {
    files: {
      confineExisting: async (project, relativePath) => call('files.confineExisting', { project: toWire(project), relativePath }),
      confineMissing: async (project, relativePath) => call('files.confineMissing', { project: toWire(project), relativePath }),
      entry: async (project, relativePath) => {
        const entry = await call('files.entry', { project: toWire(project), relativePath });
        if (!entry.ok) return entry;
        const { identity } = entry;
        return { ...entry, identity: { dev: BigInt(identity.dev), ino: BigInt(identity.ino), birthtimeNs: BigInt(identity.birthtimeNs) } };
      },
      // the answer names one of the projects sent, never one the daemon makes up
      projectOfPath: async (projects, target) => {
        const found = await call('files.projectOfPath', { projects: projects.map(toWire), target });
        const project = found && projects.find((candidate) => native(candidate.key) === found.project.key);
        return found && project && { project, relativePath: found.relativePath, path: found.path };
      },
      realpath: (target) => call('files.realpath', { target }),
      read: async (filePath, limitBytes) => fromWireBytes(await call('files.read', { path: filePath, ...(limitBytes !== undefined ? { limitBytes } : {}) }), limitBytes ?? EDITOR_MAX_DOCUMENT_BYTES),
      readText: (filePath) => call('files.readText', { path: filePath }),
      writeInPlace: async (project, location, bytes) => call('files.writeInPlace', { project: toWire(project), location: locationToWire(location), bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) }),
      readHostSettings: async () => {
        const { path, read } = await call('files.readHostSettings', {});
        return { path, read: read.kind === 'outside' ? read : fromWireBytes(read, EDITOR_MAX_DOCUMENT_BYTES) };
      },
      writeHostSettings: (bytes) => call('files.writeHostSettings', { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) }),
      createEntry: async (project, relativeDir, name, kind) => call('files.createEntry', { project: toWire(project), relativeDir, name, kind }),
      renameEntry: async (project, relativePath, newName) => call('files.renameEntry', { project: toWire(project), relativePath, newName }),
      deleteEntry: async (project, relativePath, confirmed) => call('files.deleteEntry', { project: toWire(project), relativePath, confirmed: toWireIdentity(confirmed) }),
      trash: (entryPath) => call('files.trash', { path: entryPath }),
      isDirectory: (target) => call('files.isDirectory', { target }),
      mtimes: (folder, relativePaths) => call('files.mtimes', { folder, relativePaths }),
      browse: (folder) => call('files.browse', { folder }),
      watch: (base, glob, listener) => {
        const watchId = nextId++;
        watches.set(watchId, listener);
        call('files.watch', { watchId, base, glob }).catch((err: unknown) => {
          watches.delete(watchId);
          report(`watching ${base}`)(err);
        });
        return {
          dispose: () => {
            if (!watches.delete(watchId)) return;
            call('files.unwatch', { watchId }).catch(report(`unwatching ${base}`));
          },
        };
      },
    },
    tree: {
      list: async (project, relativeDir, excludes) => call('tree.list', { project: toWire(project), relativeDir, excludes }),
    },
    search: {
      run: (cwd, args, sink) => {
        const runId = nextId++;
        searches.set(runId, sink);
        call('search.run', { runId, cwd, args }).catch((err: unknown) => {
          if (!searches.delete(runId)) return;
          sink.end({ error: err instanceof Error ? err.message : String(err) });
        });
        return {
          kill: () => {
            if (searches.delete(runId)) call('search.kill', { runId }).catch(report('stopping a search'));
          },
        };
      },
    },
    quickOpen: {
      list: (root, ignoreArgs, excludes, sink) => {
        const runId = nextId++;
        listings.set(runId, sink);
        call('quickOpen.list', { runId, root, ignoreArgs, excludes }).catch((err: unknown) => {
          if (!listings.delete(runId)) return;
          sink.end(err instanceof Error ? err.message : String(err));
        });
        return {
          kill: () => {
            if (listings.delete(runId)) call('quickOpen.kill', { runId }).catch(report('stopping a file listing'));
          },
        };
      },
    },
    format: {
      resolve: (root, file, untrusted) => call('format.resolve', { root, file, untrusted }),
      format: async (target, request) => call('format.format', { target: { key: native(target.key), root: target.root }, request }),
      retain: (projectKeys) => {
        call('format.retain', { projectKeys: projectKeys.filter((key) => authorityKeyOfProject(key) === authorityKey).map(native) }).catch(report('keeping the formatter hosts'));
      },
      release: async (projectKey) => call('format.release', { projectKey: native(projectKey) }),
      running: async (projectKey) => call('format.running', { projectKey: native(projectKey) }),
      // the daemon keeps a host only while some connection retains it
      dispose: () => {
        call('format.retain', { projectKeys: [] }).catch(report('releasing the formatter hosts'));
      },
    },
    terminals: {
      startHost: () => remotePtyHost(deps),
      detectProfiles: async () => [...(await call('terminals.detectProfiles', {}))],
      environment: async (locale) => ({ ...(await call('terminals.environment', { locale })) }),
      injection: async (request) => {
        const injected = await call('terminals.injection', { request });
        return injected && { args: [...injected.args], env: { ...injected.env } };
      },
      list: () => call('terminals.list', {}),
      windowsBuild: () => call('terminals.windowsBuild', {}),
      linkKind: async (project, relativePath) => call('terminals.linkKind', { project: toWire(project), relativePath }),
    },
  };
}

// The daemon's pty host as one client sees it: posts become terminals.post, killAll, shutdown and kill detach this client,
// and its terminals outlive the connection.
function remotePtyHost(deps: RemoteWorkspaceDeps): PtyHostProcess {
  const { endpoint } = deps;
  const messageListeners = new Set<(message: unknown) => void>();
  const exitListeners = new Set<(exit: PtyHostExit) => void>();
  const subscriptions: Disposable[] = [];
  let ended: PtyHostExit | undefined;
  const end = (exit: PtyHostExit): void => {
    if (ended) return;
    ended = exit;
    for (const subscription of subscriptions.splice(0)) subscription.dispose();
    for (const listener of [...exitListeners]) listener(exit);
  };
  subscriptions.push(
    endpoint.onEvent('terminals.message', ({ message }) => {
      for (const listener of [...messageListeners]) listener(message);
    }),
    endpoint.onEvent('terminals.hostExit', (exit) => end(exit)),
  );
  // last: a connection that already closed calls this at once, which ends the host before it is returned
  subscriptions.push(deps.onClose((reason) => end({ code: 1, reason: `disconnected: ${reason}`, error: null })));
  const detach = (): void => {
    if (!ended) endpoint.emit('terminals.detach', {});
  };
  return {
    postMessage: (request) => {
      if (ended) return;
      if (request.type === 'killAll' || request.type === 'shutdown') {
        detach();
        return;
      }
      const projectKey = request.type === 'spawn' ? deps.projectOfCwd(request.cwd) : undefined;
      endpoint.emit('terminals.post', { request, ...(projectKey !== undefined ? { projectKey } : {}) });
    },
    onMessage: (listener) => { messageListeners.add(listener); },
    // a listener that comes after the end hears it at once
    onExit: (listener) => {
      if (ended) listener(ended);
      else exitListeners.add(listener);
    },
    kill: () => {
      detach();
      end({ code: 0, reason: 'detached', error: null });
    },
  };
}
