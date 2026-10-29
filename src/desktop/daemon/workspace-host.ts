// The daemon's workspace modules, built with its fork starters, served on each connection's `workspace` channel. Every id a
// connection names is looked up among its own, so one connection can never kill or unwatch another's.
import { createEndpoint, type CoreProtocolError, type CoreTransport } from '../core-protocol/endpoint';
import { ERROR_CODEC } from '../core-protocol/errors';
import { folderKey } from '../../core/workspace-folders/folder-key';
import type { Disposable } from '../../platform/disposable';
import type { EntryIdentity, WorkspaceFileSystem } from '../workspace/file-system';
import type { Formatter } from '../workspace/format/formatter';
import { CLIENT_TO_WORKSPACE, WORKSPACE_TO_CLIENT, type ClientToWorkspace, type WireConfinedEntry, type WireIdentity, type WorkspaceToClient } from '../workspace/messages';
import type { QuickOpenListing } from '../workspace/quick-open-listing';
import type { SearchRunner } from '../workspace/search/search-runner';
import type { TerminalBackend } from '../workspace/terminal/terminal-backend';
import type { TreeListing } from '../workspace/tree-listing';
import type { HubClient, TerminalHub } from './terminal-hub';

export interface WorkspaceModules {
  readonly files: WorkspaceFileSystem;
  readonly tree: TreeListing;
  readonly search: SearchRunner;
  readonly quickOpen: QuickOpenListing;
  readonly format: Formatter;
  // detection, environment, injection and links; its own pty host is never started, the hub's is
  readonly terminals: Omit<TerminalBackend, 'startHost' | 'list'>;
  readonly hub: TerminalHub;
  // what a new terminal of clientId adds to its environment: the git credential relay and that client's forwarded agent's
  // socket; a value of undefined removes the variable
  readonly terminalCredentials: (base: Readonly<Record<string, string>>, clientId: string) => Readonly<Record<string, string | undefined>>;
  // the watcher's roots that ran out of inotify watches, and the limit they ran into
  readonly watchLimits: {
    roots(): readonly string[];
    onReached(listener: (root: string) => void): Disposable;
    limit(): Promise<number | null>;
  };
}

export interface WorkspaceHost {
  // serves one connection of clientId (its hello's) until the returned disposable or onViolation ends it
  serve(connectionId: string, clientId: string, transport: CoreTransport, onViolation: (reason: string) => void): Disposable;
}

const wireIdentity = (identity: EntryIdentity): WireIdentity => ({ dev: identity.dev.toString(), ino: identity.ino.toString(), birthtimeNs: identity.birthtimeNs.toString() });

export function createWorkspaceHost(modules: WorkspaceModules, log: (line: string) => void): WorkspaceHost {
  // each connection's format.retain; the formatter keeps the union
  const retained = new Map<string, readonly string[]>();
  const retain = (): void => modules.format.retain([...new Set([...retained.values()].flat())]);

  return {
    serve(connectionId, clientId, transport, onViolation) {
      const endpoint = createEndpoint<WorkspaceToClient, ClientToWorkspace>({
        transport,
        outgoing: WORKSPACE_TO_CLIENT,
        incoming: CLIENT_TO_WORKSPACE,
        log,
        errors: ERROR_CODEC,
        onViolation: (error: CoreProtocolError) => onViolation(error.message),
      });
      const watches = new Map<number, Disposable>();
      const searches = new Map<number, { kill(): void }>();
      const listings = new Map<number, { kill(): void }>();
      const fresh = <T>(map: Map<number, T>, id: number, what: string): void => {
        if (map.has(id)) throw new Error(`${what} ${id} is already running on this connection`);
      };
      const { files, tree, search, quickOpen, format, terminals, hub } = modules;
      const client: HubClient = {
        id: connectionId,
        message: (message) => endpoint.emit('terminals.message', { message }),
        hostExit: (end) => endpoint.emit('terminals.hostExit', end),
      };

      endpoint.serve('files.confineExisting', ({ project, relativePath }) => files.confineExisting(project, relativePath));
      endpoint.serve('files.confineMissing', ({ project, relativePath }) => files.confineMissing(project, relativePath));
      endpoint.serve('files.entry', async ({ project, relativePath }): Promise<WireConfinedEntry> => {
        const entry = await files.entry(project, relativePath);
        return entry.ok ? { ok: true, path: entry.path, folder: entry.folder, identity: wireIdentity(entry.identity) } : entry;
      });
      endpoint.serve('files.projectOfPath', ({ projects, target }) => files.projectOfPath(projects, target));
      endpoint.serve('files.realpath', ({ target }) => files.realpath(target));
      endpoint.serve('files.folderKey', ({ path }) => folderKey(path));
      endpoint.serve('files.read', ({ path, limitBytes }) => files.read(path, limitBytes));
      endpoint.serve('files.readText', ({ path }) => files.readText(path));
      endpoint.serve('files.writeInPlace', ({ project, location, bytes }) => files.writeInPlace(project, location, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
      endpoint.serve('files.readHostSettings', () => files.readHostSettings());
      endpoint.serve('files.writeHostSettings', ({ bytes }) => files.writeHostSettings(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
      endpoint.serve('files.createEntry', ({ project, relativeDir, name, kind }) => files.createEntry(project, relativeDir, name, kind));
      endpoint.serve('files.renameEntry', ({ project, relativePath, newName }) => files.renameEntry(project, relativePath, newName));
      endpoint.serve('files.deleteEntry', ({ project, relativePath, confirmed }) =>
        files.deleteEntry(project, relativePath, { dev: BigInt(confirmed.dev), ino: BigInt(confirmed.ino), birthtimeNs: BigInt(confirmed.birthtimeNs) }));
      endpoint.serve('files.trash', ({ path }) => files.trash(path));
      endpoint.serve('files.isDirectory', ({ target }) => files.isDirectory(target));
      endpoint.serve('files.mtimes', ({ folder, relativePaths }) => files.mtimes(folder, relativePaths));
      endpoint.serve('files.browse', ({ folder }) => files.browse(folder));
      // answered once the watch reports every later change (files.watchReady)
      endpoint.serve('files.watch', async ({ watchId, base, glob }) => {
        fresh(watches, watchId, 'watch');
        const watch = files.watch(base, glob, (event) => endpoint.emit('files.watchEvent', { watchId, ...event }));
        watches.set(watchId, watch);
        await watch.ready;
      });
      endpoint.serve('files.unwatch', ({ watchId }) => {
        watches.get(watchId)?.dispose();
        watches.delete(watchId);
      });
      endpoint.serve('files.watchLimits', async () => ({ roots: modules.watchLimits.roots(), limit: await modules.watchLimits.limit() }));
      endpoint.serve('tree.list', ({ project, relativeDir, excludes }) => tree.list(project, relativeDir, excludes));
      endpoint.serve('search.run', ({ runId, cwd, args }) => {
        fresh(searches, runId, 'search');
        searches.set(runId, search.run(cwd, args, {
          event: (event) => endpoint.emit('search.event', { runId, event }),
          dropped: () => endpoint.emit('search.dropped', { runId }),
          end: (end) => {
            searches.delete(runId);
            endpoint.emit('search.end', { runId, end });
          },
        }));
      });
      endpoint.serve('search.kill', ({ runId }) => {
        searches.get(runId)?.kill();
        searches.delete(runId);
      });
      endpoint.serve('quickOpen.list', ({ runId, root, ignoreArgs, excludes }) => {
        fresh(listings, runId, 'listing');
        listings.set(runId, quickOpen.list(root, ignoreArgs, excludes, {
          data: (chunk) => endpoint.emit('quickOpen.data', { runId, chunk }),
          end: (error) => {
            listings.delete(runId);
            endpoint.emit('quickOpen.end', { runId, ...(error !== undefined ? { error } : {}) });
          },
        }));
      });
      endpoint.serve('quickOpen.kill', ({ runId }) => {
        listings.get(runId)?.kill();
        listings.delete(runId);
      });
      endpoint.serve('format.resolve', ({ root, file, untrusted }) => format.resolve(root, file, untrusted));
      endpoint.serve('format.format', ({ target, request }) => format.format(target, request));
      endpoint.serve('format.retain', ({ projectKeys }) => {
        retained.set(connectionId, projectKeys);
        retain();
      });
      endpoint.serve('format.release', ({ projectKey }) => format.release(projectKey));
      endpoint.serve('format.running', ({ projectKey }) => format.running(projectKey));
      endpoint.serve('terminals.detectProfiles', () => terminals.detectProfiles());
      endpoint.serve('terminals.environment', async ({ locale }) => {
        const env: Record<string, string> = { ...(await terminals.environment(locale)) };
        for (const [key, value] of Object.entries(modules.terminalCredentials(env, clientId))) {
          if (value === undefined) delete env[key];
          else env[key] = value;
        }
        return env;
      });
      endpoint.serve('terminals.injection', ({ request }) => terminals.injection(request));
      endpoint.serve('terminals.linkKind', ({ project, relativePath }) => terminals.linkKind(project, relativePath));
      endpoint.serve('terminals.list', () => hub.list());
      endpoint.serve('terminals.windowsBuild', () => terminals.windowsBuild());
      const subscriptions = [
        endpoint.onEvent('terminals.post', ({ request, projectKey }) => hub.post(client, request, projectKey)),
        endpoint.onEvent('terminals.detach', () => hub.detach(client)),
        // every client hears it: the watch is shared, and each one names its own project from the folder
        modules.watchLimits.onReached((root) => {
          void modules.watchLimits.limit().then((limit) => endpoint.emit('files.watchLimit', { root, limit }));
        }),
      ];

      return {
        dispose: () => {
          subscriptions.forEach((subscription) => subscription.dispose());
          endpoint.close('the connection closed');
          for (const watch of watches.values()) watch.dispose();
          for (const run of [...searches.values(), ...listings.values()]) run.kill();
          watches.clear();
          searches.clear();
          listings.clear();
          hub.detach(client);
          if (retained.delete(connectionId)) retain();
        },
      };
    },
  };
}
