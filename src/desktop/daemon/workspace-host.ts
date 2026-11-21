// The daemon's workspace modules, built with its fork starters, served on each connection's `workspace` channel. Every id a
// connection names is looked up among its own, so one connection can never kill or unwatch another's.
import { createEndpoint, type CoreProtocolError, type CoreTransport } from '../core-protocol/endpoint';
import { ERROR_CODEC } from '../core-protocol/errors';
import { l } from '../../core/l10n';
import { folderKey } from '../../core/workspace-folders/folder-key';
import type { Disposable } from '../../platform/disposable';
import type { StreamChannel } from '../../remote/mux';
import { streamBytes, writeBytes } from '../../remote/tunnel-pipe';
import { englishText } from '../../shared/localized-text';
import type { HostLinkRefusal, LinkRule } from '../local-services/confine';
import type { DeleteResult, EntryIdentity, EntryResult, LocalFileSystem, WorkspaceFileSystem } from '../workspace/file-system';
import type { MoveResult, ReadRangeResult, ReadResult, TransferEntry, TransferResult } from '../workspace/transfer-ops';
import type { Formatter } from '../workspace/format/formatter';
import { CLIENT_TO_WORKSPACE, WORKSPACE_TO_CLIENT, type ClientToWorkspace, type WalkPage, type WireConfinedEntry, type WireReadRangeResult, type WireReadResult, type WireIdentity, type WireTransferEntry, type WorkspaceToClient } from '../workspace/messages';
import type { QuickOpenListing } from '../workspace/quick-open-listing';
import type { SearchRunner } from '../workspace/search/search-runner';
import type { HostTerminalBackend } from '../workspace/terminal/terminal-backend';
import type { HostTreeListing } from '../workspace/tree-listing';
import type { CliServer } from './cli-server';
import type { HubClient, TerminalHub } from './terminal-hub';

// under: the module's project-path methods under the rule a request names
export interface WorkspaceModules {
  readonly files: WorkspaceFileSystem<HostLinkRefusal> & Pick<LocalFileSystem, 'under'>;
  readonly tree: HostTreeListing;
  readonly search: SearchRunner;
  readonly quickOpen: QuickOpenListing;
  readonly format: Formatter;
  // detection, environment, injection and links; its own pty host is never started, the hub's is
  readonly terminals: Omit<HostTerminalBackend, 'startHost' | 'list'>;
  readonly hub: TerminalHub;
  // the terminals' damocles command sockets, which relay to the connection that most recently attached a terminal's view
  readonly cli: Pick<CliServer, 'connected'>;
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
  // serves one connection of clientId (its hello's) until the returned disposable or onViolation ends it; claimStream takes a
  // stream the client opened on this connection, once; lost: the connection dropped and waits inside its grace;
  // clientFeatures: the FEATURES of the connection's latest control.attachCore, none before it
  serve(connectionId: string, clientId: string, transport: CoreTransport, onViolation: (reason: string) => void, claimStream: (id: number) => StreamChannel | undefined, lost: () => boolean, clientFeatures: () => ReadonlySet<string>): Disposable;
}

// walks one connection holds open: each is a client's transfer, which ends or returns its walk
export const MAX_WALKS = 64;

// a client that lists it parses sessionFile as an entry's or a transfer's reason, and notOwned as sessionFiles.write's answer
// (core-routes.ts)
export const SESSION_FILE_REFUSAL_FEATURE = 'files.sessionFileRefusal';

// sessionFile as a client without SESSION_FILE_REFUSAL_FEATURE reads it: an existing reason with the refusal's words
const SESSION_FILE_FAILED = { ok: false, reason: 'failed', message: englishText(l('Chat session files are kept there, and only Damocles changes them.')) } as const;

type SessionFileRefusable = EntryResult<HostLinkRefusal> | DeleteResult<HostLinkRefusal> | TransferResult<HostLinkRefusal> | MoveResult<HostLinkRefusal>;

const wireIdentity = (identity: EntryIdentity): WireIdentity => ({ dev: identity.dev.toString(), ino: identity.ino.toString(), birthtimeNs: identity.birthtimeNs.toString() });
const fromWireIdentity = (identity: WireIdentity): EntryIdentity => ({ dev: BigInt(identity.dev), ino: BigInt(identity.ino), birthtimeNs: BigInt(identity.birthtimeNs) });
const wireEntry = (entry: TransferEntry): WireTransferEntry => ({ ...entry, identity: wireIdentity(entry.identity) });
// A request that does not ask to follow links out of the project never does.
const ruleOf = (links: 'follow' | undefined): LinkRule => (links === 'follow' ? 'throughLinks' : 'withinProject');

export function createWorkspaceHost(modules: WorkspaceModules, log: (line: string) => void): WorkspaceHost {
  // each connection's format.retain; the formatter keeps the union
  const retained = new Map<string, readonly string[]>();
  const retain = (): void => modules.format.retain([...new Set([...retained.values()].flat())]);

  return {
    serve(connectionId, clientId, transport, onViolation, claimStream, lost, clientFeatures) {
      const endpoint = createEndpoint<WorkspaceToClient, ClientToWorkspace>({
        transport,
        outgoing: WORKSPACE_TO_CLIENT,
        incoming: CLIENT_TO_WORKSPACE,
        log,
        errors: ERROR_CODEC,
        // an answer outside the contract fails that one request instead of ending the client's connection
        checkOutgoing: true,
        onViolation: (error: CoreProtocolError) => onViolation(error.message),
      });
      const watches = new Map<number, Disposable>();
      const searches = new Map<number, { kill(): void }>();
      const listings = new Map<number, { kill(): void }>();
      const walks = new Map<number, AsyncIterator<readonly TransferEntry[]>>();
      const claim = (id: number): StreamChannel => {
        const stream = claimStream(id);
        if (!stream) throw new Error(`Stream ${id} is not open on ${connectionId}`);
        return stream;
      };
      const page = async (walkId: number, walk: AsyncIterator<readonly TransferEntry[]>): Promise<WalkPage> => {
        let next: IteratorResult<readonly TransferEntry[]>;
        try {
          next = await walk.next();
        } catch (err) {
          walks.delete(walkId);
          throw err;
        }
        if (next.done) walks.delete(walkId);
        return { entries: next.done ? [] : next.value.map(wireEntry), done: next.done === true };
      };
      // read at the answer, so an attach that lands while the action runs counts
      const told = async <R extends SessionFileRefusable>(answer: Promise<R>): Promise<R | typeof SESSION_FILE_FAILED> => {
        const result = await answer;
        return !result.ok && result.reason === 'sessionFile' && !clientFeatures().has(SESSION_FILE_REFUSAL_FEATURE) ? SESSION_FILE_FAILED : result;
      };
      const fresh = <T>(map: Map<number, T>, id: number, what: string): void => {
        if (map.has(id)) throw new Error(`${what} ${id} is already running on this connection`);
      };
      const { files, tree, search, quickOpen, format, terminals, hub } = modules;
      const client: HubClient = {
        id: connectionId,
        message: (message) => endpoint.emit('terminals.message', { message }),
        hostExit: (end) => endpoint.emit('terminals.hostExit', end),
      };

      endpoint.serve('files.confineExisting', ({ project, relativePath, links, spell }) => files.confineExisting(project, relativePath, ruleOf(links), spell ? { spell } : {}));
      endpoint.serve('files.confineMissing', ({ project, relativePath, links }) => files.confineMissing(project, relativePath, ruleOf(links)));
      endpoint.serve('files.entry', async ({ project, relativePath, links }): Promise<WireConfinedEntry> => {
        const entry = await files.under(ruleOf(links)).entry(project, relativePath);
        return entry.ok ? { ok: true, path: entry.path, folder: entry.folder, identity: wireIdentity(entry.identity), ...(entry.sessionStore ? { sessionStore: true } : {}) } : entry;
      });
      endpoint.serve('files.projectOfPath', ({ projects, target }) => files.projectOfPath(projects, target));
      endpoint.serve('files.realpath', ({ target }) => files.realpath(target));
      endpoint.serve('files.folderKey', ({ path }) => folderKey(path));
      endpoint.serve('files.read', ({ path, limitBytes }) => files.read(path, limitBytes));
      endpoint.serve('files.writeInPlace', ({ project, location, bytes, links }) => files.under(ruleOf(links)).writeInPlace(project, location, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
      endpoint.serve('files.readHostSettings', () => files.readHostSettings());
      endpoint.serve('files.writeHostSettings', ({ bytes }) => files.writeHostSettings(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
      endpoint.serve('files.resolveOutside', ({ target }) => files.resolveOutside(target));
      endpoint.serve('files.readOutside', ({ path, limitBytes }) => files.readOutside(path, limitBytes));
      endpoint.serve('files.writeOutside', ({ path, bytes }) => files.writeOutside(path, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
      endpoint.serve('files.listOutside', ({ folder, prefix }) => files.listOutside(folder, prefix));
      endpoint.serve('files.createEntry', ({ project, relativeDir, name, kind, links }) => told(files.under(ruleOf(links)).createEntry(project, relativeDir, name, kind)));
      endpoint.serve('files.renameEntry', ({ project, relativePath, newName, links }) => told(files.under(ruleOf(links)).renameEntry(project, relativePath, newName)));
      endpoint.serve('files.deleteEntry', ({ project, relativePath, confirmed, links }) =>
        told(files.under(ruleOf(links)).deleteEntry(project, relativePath, { dev: BigInt(confirmed.dev), ino: BigInt(confirmed.ino), birthtimeNs: BigInt(confirmed.birthtimeNs) })));
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
      endpoint.serve('files.walk', ({ walkId, project, relativePath, links }) => {
        fresh(walks, walkId, 'walk');
        if (walks.size >= MAX_WALKS) throw new Error(`${MAX_WALKS} walks are already running on this connection`);
        const walk = files.under(ruleOf(links)).walk(project, relativePath)[Symbol.asyncIterator]();
        walks.set(walkId, walk);
        return page(walkId, walk);
      });
      endpoint.serve('files.walkNext', ({ walkId }) => {
        const walk = walks.get(walkId);
        if (!walk) throw new Error(`walk ${walkId} is not running on this connection`);
        return page(walkId, walk);
      });
      endpoint.serve('files.walkEnd', async ({ walkId }) => {
        const walk = walks.get(walkId);
        walks.delete(walkId);
        await walk?.return?.();
      });
      endpoint.serve('files.clashes', ({ project, relativeDir, names, links }) => files.under(ruleOf(links)).clashes(project, relativeDir, names));
      endpoint.serve('files.receiveFile', async ({ project, relativeDir, name, stream, mode, mtimeMs, replace, size, links }) => {
        const bytes = claim(stream);
        try {
          return await told(files.under(ruleOf(links)).receiveFile(project, relativeDir, name, streamBytes(bytes), { mode, mtimeMs, replace, size }));
        } finally {
          // a refusal before the first byte, or a failure, still closes this side
          bytes.end();
        }
      });
      // a read whose bytes follow on the client's stream once it is answered; a refusal or a throw ends the stream at once
      const streamRead = async <R extends ReadResult | ReadRangeResult>(stream: number, relativePath: string, reading: () => Promise<R>): Promise<R> => {
        const bytes = claim(stream);
        const read = await reading().catch((err: unknown) => {
          bytes.end();
          throw err;
        });
        if (!read.ok) {
          bytes.end();
          return read;
        }
        // after the answer: the client holds the stream until it reads, and a read failure ends it short
        setImmediate(() => {
          writeBytes(bytes, read.chunks).catch((err: unknown) => log(`[workspace] reading ${relativePath} for ${connectionId} failed: ${err instanceof Error ? err.message : String(err)}`));
        });
        return read;
      };
      endpoint.serve('files.readFile', async ({ project, relativePath, stream, links }): Promise<WireReadResult> => {
        const read = await streamRead(stream, relativePath, () => files.under(ruleOf(links)).readFile(project, relativePath));
        return read.ok ? { ok: true, size: read.size } : read;
      });
      endpoint.serve('files.readFileRange', async ({ project, relativePath, stream, offset, length, preview }): Promise<WireReadRangeResult> => {
        const read = await streamRead(stream, relativePath, () => files.readFileRange(project, relativePath, offset, length, preview));
        return read.ok ? { ok: true, size: read.size, offset: read.offset, length: read.length, resolvedPath: read.resolvedPath } : read;
      });
      // the client's cancel of either stops it between files and removes the part being written
      endpoint.serve('files.copy', ({ from, relativePath, to, toDir, name, replace, links }, signal) => told(files.under(ruleOf(links)).copy(from, relativePath, to, toDir, name, replace, signal)));
      endpoint.serve('files.move', ({ from, relativePath, to, toDir, name, replace, links }, signal) => told(files.under(ruleOf(links)).move(from, relativePath, to, toDir, name, replace, signal)));
      endpoint.serve('files.makeFolder', ({ project, relativeDir, name, mode, links }) => told(files.under(ruleOf(links)).makeFolder(project, relativeDir, name, mode)));
      endpoint.serve('files.makeLink', ({ project, relativeDir, name, target, replace, within, links }) => told(files.under(ruleOf(links)).makeLink(project, relativeDir, name, target, replace, within)));
      endpoint.serve('files.verifyLink', ({ project, relativePath, within, links }) => told(files.under(ruleOf(links)).verifyLink(project, relativePath, within)));
      endpoint.serve('files.removeFolder', ({ project, relativePath, confirmed, links }) => told(files.under(ruleOf(links)).removeFolder(project, relativePath, fromWireIdentity(confirmed))));
      endpoint.serve('tree.list', ({ project, relativeDir, excludes, links }) => tree.under(ruleOf(links)).list(project, relativeDir, excludes));
      endpoint.serve('search.run', ({ runId, cwd, match, pattern, walk }) => {
        fresh(searches, runId, 'search');
        searches.set(runId, search.run(cwd, { match, pattern, walk }, {
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
      endpoint.serve('quickOpen.list', ({ runId, root, ignore, followLinks, excludes }) => {
        fresh(listings, runId, 'listing');
        listings.set(runId, quickOpen.list(root, { ignore, followLinks: followLinks === true }, excludes, {
          files: (files) => endpoint.emit('quickOpen.files', { runId, files }),
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
      endpoint.serve('terminals.linkKind', ({ project, relativePath, links }) => terminals.under(ruleOf(links)).linkKind(project, relativePath));
      endpoint.serve('terminals.list', () => hub.list());
      endpoint.serve('terminals.windowsBuild', () => terminals.windowsBuild());
      const subscriptions = [
        modules.cli.connected(connectionId, { clientId, lost, relay: (relay) => endpoint.request('cli.request', relay) }),
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
          for (const walk of walks.values()) void walk.return?.();
          walks.clear();
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
