// One ProjectWorkspace suite, run against the local adapter and the remote client served by the daemon's workspace host over
// a real connection, so the two hosts cannot drift.
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { rgPath } from '@vscode/ripgrep';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAMOCLES_HOME_DIR } from '../../../../core/paths';
import { folderKey } from '../../../../core/workspace-folders/folder-key';
import { DesktopFileWatcherFactory } from '../../../local-services/file-watcher-factory';
import { createWorkerTreeHost } from '../../../local-services/watch-worker-host';
import type { Project } from '../../../local-services/confine';
import { createFileSystem, WriteRefusedError, type WatchEvent } from '../../../workspace/file-system';
import { createFormatter } from '../../../workspace/format/formatter';
import type { HostStarters } from '../../../workspace/host-starters';
import type { ProjectWorkspace } from '../../../workspace/project-workspace';
import { createQuickOpenListing } from '../../../workspace/quick-open-listing';
import { ALL_IGNORE_FILES } from '../../../../core/search-walk';
import { createWalkHost } from '../../../../core/search-walk';
import { InThreadWalkChild } from '../../../../__mocks__/in-thread-walk-child';
import { searchRequest } from '../../../workspace/search/rg-args';
import { createSearchRunner, type RgEvent, type SearchRequest, type SearchRunEnd } from '../../../workspace/search/search-runner';
import { createTerminalBackend } from '../../../workspace/terminal/terminal-backend';
import { NONCE_ENV } from '../../../workspace/terminal/shell-integration-injection';
import { createTreeListing } from '../../../workspace/tree-listing';
import { REPO_ROOT, startInProcessDaemon } from '../../../daemon/__tests__/in-process-daemon';
import { connect } from '../../remote/connection';
import { carriesOutsideFiles, carriesTransfers, carriesWalks, createRemoteWorkspace, LINKS_FEATURE, ListingUnsupportedError, OUTSIDE_FILES_FEATURE, OUTSIDE_LISTING_FEATURE, OutsideFilesUnsupportedError, RANGED_READS_FEATURE, RangedReadsUnsupportedError, READ_OUTSIDE_LIMIT_FEATURE, SESSION_FILES_FEATURE, TRANSFER_FEATURES, TransfersUnsupportedError, WALK_FEATURES, WATCH_READY_FEATURE } from '../remote-workspace';
import { NotConnectedError } from '../workspaces';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import { MAX_OPEN_STREAMS } from '../../../../remote/mux';
import { CLIENT_TO_WORKSPACE, type ClientToWorkspace, type WorkspaceToClient } from '../../../workspace/messages';
import type { Endpoint } from '../../../core-protocol/endpoint';
import { INVALID } from '../../../core-protocol/schema';
import { FileTransferService } from '../../files/file-transfer';
import { LocalizedError } from '../../../../shared/localized-text';
import { FEATURES } from '../../../../remote/protocol-version';
import { testRemote } from '../../__tests__/test-workspaces';

// No pty host or formatter host starts in this suite; the terminal and format members it runs need none.
const NO_HOSTS: HostStarters = {
  startPtyHost: () => { throw new Error('no pty host in this suite'); },
  startFormatterHost: () => { throw new Error('no formatter host in this suite'); },
};

interface Adapter {
  readonly workspace: ProjectWorkspace;
  // the key the adapter's callers name a project of this folder by
  readonly keyOf: (folder: string) => string;
  // the remote client's own channel, for a request no workspace method sends
  readonly endpoint?: Endpoint<ClientToWorkspace, WorkspaceToClient>;
  dispose(): Promise<void>;
}

// the watch worker bundled for this suite, which runs without a desktop build
let watchWorker: string;

beforeAll(async () => {
  watchWorker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-conf-worker-')), 'watch-worker.js');
  // koffi stays external, as in the app's worker bundle (esbuild.config.ts watchWorkerOptions): it loads its own native module
  await build({ entryPoints: [path.join(REPO_ROOT, 'src', 'desktop', 'watch-worker', 'index.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: watchWorker, external: ['koffi'], logLevel: 'silent' });
});

afterAll(() => {
  fs.rmSync(path.dirname(watchWorker), { recursive: true, force: true });
});

/** Lets a read open that waits on the FIFO at `fifo` go on, so a failing run leaves no thread blocked. */
function releaseFifo(fifo: string): void {
  try {
    fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
  } catch (err) {
    // ENXIO: nothing waits on it
    if ((err as NodeJS.ErrnoException).code !== 'ENXIO') throw err;
  }
}

function watchers(): DesktopFileWatcherFactory {
  return new DesktopFileWatcherFactory({ folders: () => [], onDidChange: () => ({ dispose: () => undefined }) }, () => undefined, createWorkerTreeHost(() => new Worker(watchWorker), () => undefined));
}

async function localAdapter(): Promise<Adapter> {
  const factory = watchers();
  const log = (): void => undefined;
  const rg = async (): Promise<string> => rgPath;
  const walks = createWalkHost(() => new InThreadWalkChild(), log);
  const workspace: ProjectWorkspace = {
    files: createFileSystem({ watchers: factory, trash: () => Promise.reject(new Error('no trash in this suite')), damoclesHome: DAMOCLES_HOME_DIR, log }),
    tree: createTreeListing(log),
    search: createSearchRunner({ rgPath: rg, walks, log }),
    quickOpen: createQuickOpenListing({ walks, log }),
    format: createFormatter({ starters: NO_HOSTS, watchers: factory, log }),
    terminals: createTerminalBackend({ starters: NO_HOSTS, platform: process.platform, scriptsDir: path.join(REPO_ROOT, 'resources', 'shell-integration'), zshDotDir: path.join(os.tmpdir(), 'zdot'), homedir: os.homedir(), env: process.env, log }),
  };
  return { workspace, keyOf: folderKey, dispose: () => factory.close() };
}

// features: what the client takes from the daemon's welcome, every name by default; requested: each request method it sends
async function remoteAdapter(features: (listed: readonly string[]) => readonly string[] = (listed) => listed, requested: string[] = []): Promise<Adapter> {
  const daemon = await startInProcessDaemon({ starters: NO_HOSTS, watchWorker, walkChild: () => new InThreadWalkChild() });
  const connection = await connect({ stream: await daemon.connect(), appVersion: '0.0.0-test', clientId: 'conformance', deviceName: 'test', terminalIdleDays: 30, log: () => undefined });
  const endpoint = connection.workspace;
  const workspace = createRemoteWorkspace({
    endpoint: {
      ...endpoint,
      request: (method, params, signal) => {
        requested.push(method);
        return endpoint.request(method, params, signal);
      },
    },
    authorityKey: 'loopback',
    projectOfCwd: () => undefined,
    onClose: (listener) => connection.onClose(listener),
    notConnected: () => new NotConnectedError('Local daemon is not connected.'),
    watchReady: connection.features.includes(WATCH_READY_FEATURE),
    transfers: carriesTransfers(features(connection.features)),
    rangedReads: features(connection.features).includes(RANGED_READS_FEATURE),
    outside: carriesOutsideFiles(features(connection.features)),
    listing: features(connection.features).includes(OUTSIDE_LISTING_FEATURE),
    links: features(connection.features).includes(LINKS_FEATURE),
    walks: carriesWalks(features(connection.features)),
    searchUnsupported: () => 'Update the Damocles server on this host to search it.',
    openStream: () => connection.openStream(),
    log: () => undefined,
  });
  return {
    workspace,
    endpoint,
    keyOf: (folder) => `loopback|${folderKey(folder)}`,
    dispose: async () => {
      connection.close('the suite ended');
      await daemon.shutdown();
    },
  };
}

const ADAPTERS: ReadonlyArray<readonly [string, () => Promise<Adapter>]> = [['local adapter', localAdapter], ['loopback client', () => remoteAdapter()]];

const NEEDLE: SearchRequest = { match: ['--fixed-strings'], pattern: 'needle', walk: { ignore: ALL_IGNORE_FILES, overrides: [] } };

function search(workspace: ProjectWorkspace, cwd: string, request: SearchRequest = NEEDLE): Promise<{ events: RgEvent[]; end: SearchRunEnd }> {
  return new Promise((resolve) => {
    const events: RgEvent[] = [];
    workspace.search.run(cwd, request, { event: (event) => events.push(event), dropped: () => undefined, end: (end) => resolve({ events, end }) });
  });
}

// Each file's match and context events in rg's order, by its '/'-separated path below the search root.
function lineEvents(events: readonly RgEvent[]): Record<string, string[]> {
  const files: Record<string, string[]> = {};
  for (const { type, data } of events) {
    if (type !== 'match' && type !== 'context') continue;
    const { path: printed, line_number: line, lines, submatches } = data as { path: { text: string }; line_number: number; lines: unknown; submatches?: Array<{ start: number; end: number }> };
    const file = printed.text.replace(/^\.[\\/]/, '').replaceAll('\\', '/');
    (files[file] ??= []).push(JSON.stringify([type, line, lines, submatches?.map(({ start, end }) => [start, end])]));
  }
  return files;
}

// What Search's rg run over its own walk gave for request: --hidden, the overrides as globs, --no-ignore for every switch off.
function rgOwnWalk(cwd: string, request: SearchRequest): { files: Record<string, string[]>; code: number | null } {
  const { ignore, overrides } = request.walk;
  const ignoreArgs = [...(ignore.files ? [] : ['--no-ignore']), ...(ignore.global ? [] : ['--no-ignore-global']), ...(ignore.parents ? [] : ['--no-ignore-parent'])];
  const args = ['--json', '--no-config', '--hidden', ...ignoreArgs, ...overrides.flatMap((glob) => ['-g', glob]), ...request.match, '--', request.pattern, '.'];
  const run = spawnSync(rgPath, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const events = run.stdout.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as RgEvent);
  return { files: lineEvents(events), code: run.status };
}

function listing(workspace: ProjectWorkspace, root: string, excludes: readonly string[] = [], followLinks = false): Promise<{ files: string[]; error: string | undefined }> {
  return new Promise((resolve) => {
    const files: string[] = [];
    workspace.quickOpen.list(root, { ignore: ALL_IGNORE_FILES, followLinks }, excludes, { files: (batch) => files.push(...batch), end: (error) => resolve({ files: files.sort(), error }) });
  });
}

describe.each(ADAPTERS)('ProjectWorkspace conformance: %s', (_name, start) => {
  let adapter: Adapter;
  let root: string;
  let project: Project;
  let workspace: ProjectWorkspace;
  const file = (relative: string): string => path.join(project.fsPath, ...relative.split('/'));

  beforeEach(async () => {
    adapter = await start();
    workspace = adapter.workspace;
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-conf-')));
    const folder = path.join(root, 'proj');
    fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'src', 'a.ts'), 'export const needle = 1;\n');
    fs.writeFileSync(path.join(folder, 'README.md'), '# Readme\n');
    fs.writeFileSync(path.join(root, 'outside.txt'), 'outside\n');
    project = { key: adapter.keyOf(folder), fsPath: folder, name: 'proj' };
  });

  afterEach(async () => {
    await adapter.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('confines paths to the project and names an entry by its bigint identity', async () => {
    for (const rule of ['withinProject', 'throughLinks'] as const) {
      expect(await workspace.files.confineExisting(project, 'src/a.ts', rule)).toEqual({ ok: true, path: file('src/a.ts') });
      expect(await workspace.files.confineExisting(project, 'nope.ts', rule)).toEqual({ ok: false, reason: 'missing' });
      expect(await workspace.files.confineMissing(project, 'src/new.ts', rule)).toEqual({ ok: true, path: file('src/new.ts') });
    }
    const entry = await workspace.files.entry(project, 'src');
    if (!entry.ok) throw new Error('no entry');
    expect(entry).toMatchObject({ path: file('src'), folder: true });
    expect(typeof entry.identity.dev).toBe('bigint');
    expect(typeof entry.identity.ino).toBe('bigint');
    expect(typeof entry.identity.birthtimeNs).toBe('bigint');
    expect(await workspace.files.realpath(file('src/a.ts'))).toBe(file('src/a.ts'));
    expect(await workspace.files.realpath(file('gone'))).toBeUndefined();
    expect(await workspace.files.isDirectory(file('src'))).toBe(true);
    expect(await workspace.files.isDirectory(file('README.md'))).toBe(false);
    expect(await workspace.files.mtimes(project.fsPath, ['README.md', 'gone.md'])).toEqual([fs.lstatSync(file('README.md')).mtimeMs, undefined]);
    expect(await workspace.files.isDirectory(file('gone'))).toBe(false);
    await expect(workspace.files.realpath(`${file('src')}\0`)).rejects.toThrow();
    await expect(workspace.files.isDirectory(`${file('src')}\0`)).rejects.toThrow();
  });

  it('rejects a failed call with the system error code, which crosses the wire as that code', async () => {
    const realpath = fs.promises.realpath.bind(fs.promises);
    const denied = vi.spyOn(fs.promises, 'realpath').mockImplementation((async (target: fs.PathLike, options?: fs.ObjectEncodingOptions) => {
      if (String(target) === file('src')) throw Object.assign(new Error(`EACCES: permission denied, realpath '${String(target)}'`), { code: 'EACCES' });
      return realpath(target, options);
    }) as typeof fs.promises.realpath);
    try {
      const failed = await workspace.files.realpath(file('src')).catch((err: unknown) => err);
      expect((failed as NodeJS.ErrnoException).code).toBe('EACCES');
    } finally {
      denied.mockRestore();
    }
  });

  it('answers a confinement the file system failed with the failure\'s own words, which cross the wire as its text', async () => {
    const drive = { message: 'The drive {0} did not answer within a second.', args: ['Q:\\'] };
    const realpath = fs.promises.realpath.bind(fs.promises);
    const offline = vi.spyOn(fs.promises, 'realpath').mockImplementation((async (target: fs.PathLike, options?: fs.ObjectEncodingOptions) => {
      if (String(target) === file('src')) throw Object.assign(new LocalizedError(drive), { code: 'ETIMEDOUT' });
      return realpath(target, options);
    }) as typeof fs.promises.realpath);
    try {
      const failed = { ok: false, reason: 'failed', error: drive };
      expect(await workspace.files.confineExisting(project, 'src', 'throughLinks')).toEqual(failed);
      expect(await workspace.tree.list(project, 'src', [])).toEqual(failed);
      expect(await workspace.files.createEntry(project, 'src', 'b.ts', 'file')).toEqual(failed);
    } finally {
      offline.mockRestore();
    }
  });

  it('refuses a path a link carries out of the project within the project, and follows it through links to the link root', async () => {
    fs.symlinkSync(root, file('escape'), 'junction');
    expect(await workspace.files.confineExisting(project, 'escape/outside.txt', 'withinProject')).toEqual({ ok: false, reason: 'outside' });
    expect(await workspace.files.confineMissing(project, 'escape/new.txt', 'withinProject')).toEqual({ ok: false, reason: 'outside' });
    const via = { link: 'escape', realRoot: root };
    expect(await workspace.files.confineExisting(project, 'escape/outside.txt', 'throughLinks')).toEqual({ ok: true, path: path.join(root, 'outside.txt'), via });
    expect(await workspace.files.confineMissing(project, 'escape/new.txt', 'throughLinks')).toEqual({ ok: true, path: path.join(root, 'new.txt'), via });
  });

  it.runIf(process.platform === 'win32' || process.platform === 'darwin')('spells a path typed in another case as its folders list it when asked, a link by its own name', async () => {
    fs.symlinkSync(root, file('Out'), 'junction');
    const spell = { spell: true } as const;
    expect(await workspace.files.confineExisting(project, 'SRC/A.TS', 'throughLinks', spell)).toEqual({ ok: true, path: file('src/a.ts'), spelling: 'src/a.ts' });
    expect(await workspace.files.confineExisting(project, 'OUT/OUTSIDE.TXT', 'throughLinks', spell)).toEqual({ ok: true, path: path.join(root, 'outside.txt'), via: { link: 'OUT', realRoot: root }, spelling: 'Out/outside.txt' });
    expect(await workspace.files.confineExisting(project, 'Out/outside.txt', 'throughLinks', spell)).toEqual({ ok: true, path: path.join(root, 'outside.txt'), via: { link: 'Out', realRoot: root } });
    // a caller that does not ask reads nothing more
    expect(await workspace.files.confineExisting(project, 'OUT/OUTSIDE.TXT', 'throughLinks')).toEqual({ ok: true, path: path.join(root, 'outside.txt'), via: { link: 'OUT', realRoot: root } });
  });

  it('lists, reads, saves and changes a linked folder outside the project, and acts on the link row itself', async () => {
    fs.symlinkSync(root, file('escape'), 'junction');
    const target = path.join(root, 'outside.txt');
    const listed = await workspace.tree.list(project, 'escape', []);
    expect(listed.ok && listed.entries.find((entry) => entry.name === 'outside.txt')).toEqual({ name: 'outside.txt', kind: 'file' });
    // the listing names the link root it went through, and the link's row carries its own target text
    expect(listed.ok && listed.via).toEqual({ link: 'escape', realRoot: fs.realpathSync.native(root) });
    const top = await workspace.tree.list(project, '', []);
    expect(top.ok && top.entries.find((entry) => entry.name === 'escape')).toEqual({ name: 'escape', kind: 'dir', link: { target: fs.readlinkSync(file('escape')) } });
    expect(await workspace.terminals.linkKind(project, 'escape/outside.txt')).toBe('file');
    const read = await workspace.files.readFile(project, 'escape/outside.txt');
    if (!read.ok) throw new Error(read.reason);
    const chunks: Buffer[] = [];
    for await (const chunk of read.chunks) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString('utf8')).toBe('outside\n');
    await workspace.files.writeInPlace(project, { path: target, projectKey: project.key, relativePath: 'escape/outside.txt' }, Buffer.from('saved'));
    expect(fs.readFileSync(target, 'utf8')).toBe('saved');
    expect(await workspace.files.createEntry(project, 'escape', 'made.txt', 'file')).toEqual({ ok: true });
    expect(await workspace.files.renameEntry(project, 'escape/made.txt', 'renamed.txt')).toEqual({ ok: true });
    const made = await workspace.files.entry(project, 'escape/renamed.txt');
    if (!made.ok) throw new Error(made.reason);
    expect(made.path).toBe(path.join(root, 'renamed.txt'));
    expect(await workspace.files.deleteEntry(project, 'escape/renamed.txt', made.identity)).toEqual({ ok: true });
    expect(fs.existsSync(path.join(root, 'renamed.txt'))).toBe(false);
    // the link row is the link: renamed, never its target
    expect(await workspace.files.entry(project, 'escape')).toMatchObject({ ok: true, path: file('escape'), folder: false });
    expect(await workspace.files.renameEntry(project, 'escape', 'gate')).toEqual({ ok: true });
    expect(fs.lstatSync(file('gate')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('saved');
  });

  it.runIf(process.platform === 'win32')('answers a listing and an entry operation whose path crosses a link to a UNC share with the share refusal', async () => {
    fs.mkdirSync(path.join(root, 'real'));
    fs.writeFileSync(path.join(root, 'real', 'x.txt'), 'x');
    const link = file('share');
    fs.symlinkSync(path.join(root, 'real'), link, 'junction');
    const readlink = fs.promises.readlink.bind(fs.promises);
    vi.spyOn(fs.promises, 'readlink').mockImplementation((async (target: fs.PathLike) => (folderKey(String(target)) === folderKey(link) ? '\\\\server\\share' : readlink(target))) as typeof fs.promises.readlink);
    const share = { ok: false, reason: 'outside', refusal: 'share' };
    try {
      expect(await workspace.tree.list(project, 'share', [])).toEqual(share);
      expect(await workspace.tree.list(project, 'share/deeper', [])).toEqual(share);
      expect(await workspace.files.entry(project, 'share/x.txt')).toEqual(share);
      expect(await workspace.files.createEntry(project, 'share', 'made.txt', 'file')).toEqual(share);
      expect(await workspace.files.renameEntry(project, 'share/x.txt', 'y.txt')).toEqual(share);
      expect(await workspace.files.deleteEntry(project, 'share/x.txt', { dev: 1n, ino: 2n, birthtimeNs: 3n })).toEqual(share);
      expect(fs.readdirSync(path.join(root, 'real'))).toEqual(['x.txt']);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('reads an HTML preview\'s file by its project\'s trust, and a read without preview never follows its last segment', async () => {
    const outside = path.join(root, 'assets');
    fs.mkdirSync(path.join(outside, 'css'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'css', 'site.css'), 'body{}');
    fs.writeFileSync(path.join(outside, '.env'), 'SECRET=1');
    fs.mkdirSync(path.join(root, '.ssh'));
    fs.writeFileSync(path.join(root, '.ssh', 'notes.txt'), 'private');
    fs.mkdirSync(path.join(root, '.config', 'x'), { recursive: true });
    fs.writeFileSync(path.join(root, '.config', 'x', 'page.html'), '<p>');
    fs.symlinkSync(outside, file('site'), 'junction');
    fs.symlinkSync(path.join(root, '.ssh'), file('ssh'), 'junction');
    fs.symlinkSync(path.join(root, '.config', 'x'), file('cfg'), 'junction');
    fs.symlinkSync(file('src'), file('inner'), 'junction');
    const trusted = { trusted: true };
    const untrusted = { trusted: false };
    const served = async (relativePath: string, preview?: { readonly trusted: boolean }) => {
      const read = await workspace.files.readFileRange(project, relativePath, 0, 1024, preview);
      if (!read.ok) return read;
      for await (const chunk of read.chunks) void chunk;
      return { ok: true, resolvedPath: read.resolvedPath };
    };
    expect(await served('site/css/site.css', trusted)).toEqual({ ok: true, resolvedPath: 'css/site.css' });
    for (const denied of ['site/.env', 'ssh/notes.txt', 'cfg/page.html']) expect(await served(denied, trusted), denied).toEqual({ ok: false, reason: 'outside' });
    expect(await served('site/css/site.css', untrusted)).toEqual({ ok: false, reason: 'outside' });
    for (const preview of [trusted, untrusted]) expect(await served('inner/a.ts', preview)).toEqual({ ok: true, resolvedPath: 'src/a.ts' });
    expect(await served('inner/a.ts')).toEqual({ ok: true, resolvedPath: 'src/a.ts' });
    expect(await served('inner')).toEqual({ ok: false, reason: 'notAFile', folder: false });
    expect(await served('site/css/site.css')).toEqual({ ok: false, reason: 'outside' });
    expect(await served('site', trusted)).toEqual({ ok: false, reason: 'notAFile', folder: true });
  });

  it('refuses a trusted preview read through a link into a data store of the reading machine, and serves an ordinary folder', async () => {
    // a store this machine's own env and home name: Windows' LOCALAPPDATA, macOS's ~/Library, Linux's /proc
    const store = process.platform === 'win32'
      ? fs.mkdtempSync(path.join(process.env['LOCALAPPDATA']!, 'dm-conf-store-'))
      : process.platform === 'darwin' ? fs.mkdtempSync(path.join(os.homedir(), 'Library', 'Caches', 'dm-conf-store-')) : undefined;
    try {
      if (store !== undefined) fs.writeFileSync(path.join(store, 'page.html'), '<p>');
      fs.symlinkSync(store ?? '/proc/self', file('data'), 'junction');
      const name = store !== undefined ? 'data/page.html' : 'data/environ';
      expect(await workspace.files.readFileRange(project, name, 0, 16, { trusted: true })).toEqual({ ok: false, reason: 'outside' });
      // the temp folder this suite's files live in is inside LOCALAPPDATA on Windows, and still ordinary
      fs.mkdirSync(path.join(root, 'assets'));
      fs.writeFileSync(path.join(root, 'assets', 'page.html'), '<p>');
      fs.symlinkSync(path.join(root, 'assets'), file('site'), 'junction');
      const read = await workspace.files.readFileRange(project, 'site/page.html', 0, 16, { trusted: true });
      if (read.ok) for await (const chunk of read.chunks) void chunk;
      expect(read).toMatchObject({ ok: true, resolvedPath: 'page.html' });
    } finally {
      if (store !== undefined) fs.rmSync(store, { recursive: true, force: true });
    }
  });

  it('refuses a preview read whose file is swapped for a link after its realpath, under either trust', async () => {
    const outside = path.join(root, 'assets');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'page.html'), '<p>');
    fs.mkdirSync(path.join(root, 'secret'));
    fs.symlinkSync(outside, file('site'), 'junction');
    // the link root's own check refuses a swap under it first; the lstat refuses one inside the project
    const cases = [
      ['site/page.html', path.join(outside, 'page.html'), { trusted: true }, { ok: false, reason: 'outside' }],
      ['src/a.ts', file('src/a.ts'), { trusted: true }, { ok: false, reason: 'notAFile', folder: false }],
      ['src/a.ts', file('src/a.ts'), { trusted: false }, { ok: false, reason: 'notAFile', folder: false }],
    ] as const;
    for (const [relativePath, real, preview, refused] of cases) {
      fs.rmSync(real, { force: true });
      fs.writeFileSync(real, 'x');
      const realpath = fs.promises.realpath.bind(fs.promises);
      const swapped = vi.spyOn(fs.promises, 'realpath').mockImplementation((async (target: fs.PathLike, options?: fs.ObjectEncodingOptions) => {
        const answer = await realpath(target, options);
        if (String(target) === file(relativePath)) {
          fs.rmSync(real);
          fs.symlinkSync(path.join(root, 'secret'), real, 'junction');
        }
        return answer;
      }) as typeof fs.promises.realpath);
      try {
        expect(await workspace.files.readFileRange(project, relativePath, 0, 16, preview), relativePath).toEqual(refused);
      } finally {
        swapped.mockRestore();
        fs.unlinkSync(real);
      }
    }
  });

  it.runIf(process.platform !== 'win32')('refuses a FIFO to every preview read without opening it', async () => {
    execFileSync('mkfifo', [file('pipe.html')]);
    try {
      for (const preview of [{ trusted: true }, { trusted: false }, undefined]) {
        expect(await workspace.files.readFileRange(project, 'pipe.html', 0, 16, preview)).toEqual({ ok: false, reason: 'notAFile', folder: false });
      }
    } finally {
      releaseFifo(file('pipe.html'));
    }
  });

  it('reads bytes as a Buffer within the limit', async () => {
    const read = await workspace.files.read(file('README.md'));
    if (read.kind !== 'bytes') throw new Error(read.kind);
    expect(Buffer.isBuffer(read.bytes)).toBe(true);
    expect(read.bytes.toString('utf8')).toBe('# Readme\n');
    expect(await workspace.files.read(file('README.md'), 4)).toEqual({ kind: 'tooLarge', bytes: 9 });
    expect(await workspace.files.read(file('gone.md'))).toEqual({ kind: 'missing' });
  });

  it('writes in place, and refuses a write outside the project as WriteRefusedError with its refusal', async () => {
    const mtime = await workspace.files.writeInPlace(project, { path: file('README.md'), projectKey: project.key, relativePath: 'README.md' }, Buffer.from('# Changed\n'));
    expect(typeof mtime).toBe('number');
    expect(fs.readFileSync(file('README.md'), 'utf8')).toBe('# Changed\n');
    const refused = await workspace.files.writeInPlace(project, { path: path.join(root, 'outside.txt'), projectKey: project.key, relativePath: '../outside.txt' }, Buffer.from('x')).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(WriteRefusedError);
    expect((refused as WriteRefusedError).refusal).toBe('outsideProject');
    expect(fs.readFileSync(path.join(root, 'outside.txt'), 'utf8')).toBe('outside\n');
  });

  it('reads and writes the host\'s own settings file, and refuses one that links elsewhere as WriteRefusedError', async () => {
    const settings = path.join(DAMOCLES_HOME_DIR, 'settings.json');
    fs.mkdirSync(DAMOCLES_HOME_DIR, { recursive: true });
    const kept = fs.existsSync(settings) ? fs.readFileSync(settings) : undefined;
    try {
      fs.rmSync(settings, { force: true });
      await workspace.files.writeHostSettings(Buffer.from('{ "damocles.maxBudgetUsd": 3 }'));
      const read = await workspace.files.readHostSettings();
      expect(read.path).toBe(path.join(fs.realpathSync.native(DAMOCLES_HOME_DIR), 'settings.json'));
      expect(read.read.kind === 'bytes' ? read.read.bytes.toString('utf8') : read.read).toBe('{ "damocles.maxBudgetUsd": 3 }');
      fs.rmSync(settings);
      fs.symlinkSync(path.join(root, 'outside.txt'), settings, 'file');
      expect((await workspace.files.readHostSettings()).read).toEqual({ kind: 'outside' });
      const refused = await workspace.files.writeHostSettings(Buffer.from('{}')).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(WriteRefusedError);
      expect((refused as WriteRefusedError).refusal).toBe('outsideProject');
      expect(fs.readFileSync(path.join(root, 'outside.txt'), 'utf8')).toBe('outside\n');
    } finally {
      fs.rmSync(settings, { force: true });
      if (kept) fs.writeFileSync(settings, kept);
    }
  });

  it('resolves, reads and writes a file outside every project by the host\'s own rule, and refuses one swapped for a link', async () => {
    const folder = fs.realpathSync.native(root);
    const notes = path.join(folder, `conformance-${path.basename(root)}.md`);
    fs.writeFileSync(notes, '# Notes\n');
    try {
      expect(await workspace.files.resolveOutside(notes)).toEqual({ kind: 'file', path: notes });
      expect(await workspace.files.resolveOutside(path.join(root, 'outside.txt'))).toEqual({ kind: 'file', path: path.join(root, 'outside.txt') });
      expect(await workspace.files.resolveOutside(root)).toEqual({ kind: 'folder', path: root });
      expect(await workspace.files.resolveOutside(path.join(root, 'gone.md'))).toEqual({ kind: 'missing' });
      expect(await workspace.files.resolveOutside('relative.md')).toEqual({ kind: 'outside', reason: 'name' });
      if (process.platform === 'win32') expect(await workspace.files.resolveOutside('\\\\server\\share\\a.md')).toEqual({ kind: 'outside', reason: 'share' });
      const read = await workspace.files.readOutside(notes);
      expect(read.kind === 'bytes' && read.bytes.toString('utf8')).toBe('# Notes\n');
      expect(await workspace.files.readOutside(notes, 4)).toEqual({ kind: 'tooLarge', bytes: 8 });
      expect(typeof (await workspace.files.writeOutside(notes, Buffer.from('# Edited\n')))).toBe('number');
      expect(fs.readFileSync(notes, 'utf8')).toBe('# Edited\n');
      fs.rmSync(notes);
      fs.symlinkSync(path.join(root, 'outside.txt'), notes, 'file');
      expect(await workspace.files.readOutside(notes)).toEqual({ kind: 'outside' });
      const refused = await workspace.files.writeOutside(notes, Buffer.from('x')).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(WriteRefusedError);
      expect((refused as WriteRefusedError).refusal).toBe('outsideFile');
      expect(fs.readFileSync(path.join(root, 'outside.txt'), 'utf8')).toBe('outside\n');
    } finally {
      fs.rmSync(notes, { force: true });
    }
  });

  it('lists a typed folder outside every project by the host\'s own rule: entries by prefix, links as what they lead to', async () => {
    const folder = path.join(fs.realpathSync.native(root), 'listed');
    fs.mkdirSync(path.join(folder, 'Sub'), { recursive: true });
    for (const name of ['.hidden', 'a.txt', 'B.txt']) fs.writeFileSync(path.join(folder, name), '');
    fs.symlinkSync(path.join(folder, 'Sub'), path.join(folder, 'to-sub'), 'junction');
    const byName = (entries: readonly { readonly name: string }[]) => [...entries].sort((a, b) => a.name.localeCompare(b.name));
    const listed = await workspace.files.listOutside(`${folder}${path.sep}`, '');
    expect(listed.kind === 'folder' && { ...listed, entries: byName(listed.entries) }).toEqual({
      kind: 'folder',
      path: folder,
      entries: [
        { name: '.hidden', kind: 'file', link: false },
        { name: 'a.txt', kind: 'file', link: false },
        { name: 'B.txt', kind: 'file', link: false },
        { name: 'Sub', kind: 'dir', link: false },
        { name: 'to-sub', kind: 'dir', link: true },
      ],
      truncated: false,
    });
    expect(await workspace.files.listOutside(folder, 'b')).toEqual({ kind: 'folder', path: folder, entries: [{ name: 'B.txt', kind: 'file', link: false }], truncated: false });
    expect(await workspace.files.listOutside(path.join(folder, 'gone'), '')).toEqual({ kind: 'missing' });
    expect(await workspace.files.listOutside(path.join(folder, 'a.txt'), '')).toEqual({ kind: 'notAFolder' });
    expect(await workspace.files.listOutside('relative', '')).toEqual({ kind: 'outside' });
    if (process.platform === 'win32') expect(await workspace.files.listOutside('\\\\server\\share\\', '')).toEqual({ kind: 'outside' });
  });

  it.skipIf(process.platform === 'win32')('resolves an entry that is neither a file nor a folder as other, and reads it as no file', async () => {
    const fifo = path.join(fs.realpathSync.native(root), 'pipe');
    execFileSync('mkfifo', [fifo]);
    expect(await workspace.files.resolveOutside(fifo)).toEqual({ kind: 'other', path: fifo });
    expect(await workspace.files.readOutside(fifo)).toEqual({ kind: 'notAFile', folder: false });
  });

  it.skipIf(process.platform === 'win32')('reads a file outside every project that a FIFO replaced after its checks as outside, never waiting for a writer', async () => {
    const file = path.join(fs.realpathSync.native(root), 'swapped.txt');
    fs.writeFileSync(file, 'regular\n');
    const open = fs.promises.open.bind(fs.promises);
    let swapped = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (target, flags, mode) => {
      if (!swapped && String(target) === file) {
        swapped = true;
        fs.rmSync(file);
        execFileSync('mkfifo', [file]);
      }
      return open(target, flags, mode);
    });

    try {
      const read = await Promise.race([workspace.files.readOutside(file), new Promise((resolve) => setTimeout(() => resolve('still waiting after 2 s'), 2000))]);
      expect(swapped).toBe(true);
      // outside when the FIFO took a new inode number, notAFile when it reused the removed file's
      expect([{ kind: 'outside' }, { kind: 'notAFile', folder: false }]).toContainEqual(read);
    } finally {
      vi.mocked(fs.promises.open).mockRestore();
      releaseFifo(file);
    }
  });

  it('creates, renames and deletes only the entry it confirmed', async () => {
    expect(await workspace.files.createEntry(project, 'src', 'b.ts', 'file')).toEqual({ ok: true });
    expect(await workspace.files.createEntry(project, 'src', 'b.ts', 'file')).toMatchObject({ ok: false, reason: 'exists' });
    expect(await workspace.files.createEntry(project, '', 'lib', 'dir')).toEqual({ ok: true });
    expect(fs.statSync(file('lib')).isDirectory()).toBe(true);
    expect(await workspace.files.renameEntry(project, 'src/b.ts', 'a.ts')).toMatchObject({ ok: false, reason: 'exists' });
    expect(fs.readFileSync(file('src/a.ts'), 'utf8')).toBe('export const needle = 1;\n');
    await expect(workspace.files.trash(file('lib'))).rejects.toThrow();
    expect(fs.existsSync(file('lib'))).toBe(true);
    expect(await workspace.files.renameEntry(project, 'src/b.ts', 'c.ts')).toEqual({ ok: true });
    expect(fs.existsSync(file('src/c.ts'))).toBe(true);
    const entry = await workspace.files.entry(project, 'src/c.ts');
    if (!entry.ok) throw new Error('no entry');
    fs.rmSync(file('src/c.ts'));
    fs.writeFileSync(file('src/c.ts'), 'a different file\n');
    expect(await workspace.files.deleteEntry(project, 'src/c.ts', entry.identity)).toMatchObject({ ok: false, reason: 'changed' });
    const again = await workspace.files.entry(project, 'src/c.ts');
    if (!again.ok) throw new Error('no entry');
    expect(await workspace.files.deleteEntry(project, 'src/c.ts', again.identity)).toEqual({ ok: true });
    expect(fs.existsSync(file('src/c.ts'))).toBe(false);
  });

  it('receives a file through a part and streams it back, and a source that throws leaves no part and no claim', async () => {
    async function* bytes(...parts: string[]): AsyncGenerator<Uint8Array> {
      for (const part of parts) yield Buffer.from(part);
    }
    const mtimeMs = Date.UTC(2021, 5, 6);
    expect(await workspace.files.receiveFile(project, 'src', 'b.ts', bytes('one ', 'two'), { mode: 0o644, mtimeMs, replace: false, size: 7 })).toEqual({ ok: true });
    expect(fs.readFileSync(file('src/b.ts'), 'utf8')).toBe('one two');
    expect(fs.statSync(file('src/b.ts')).mtimeMs).toBe(mtimeMs);
    expect(await workspace.files.receiveFile(project, 'src', 'b.ts', bytes('x'), { mode: 0o644, mtimeMs, replace: false, size: 1 })).toEqual({ ok: false, reason: 'exists' });
    expect(await workspace.files.receiveFile(project, 'src', 'c.ts', bytes('xy'), { mode: 0o644, mtimeMs, replace: false, size: 3 })).toMatchObject({ ok: false, reason: 'incomplete' });
    const cancelled = new Error('cancelled');
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield Buffer.alloc(300 * 1024, 1);
      throw cancelled;
    }
    await expect(workspace.files.receiveFile(project, 'src', 'd.ts', failing(), { mode: 0o644, mtimeMs, replace: false, size: 600 * 1024 })).rejects.toBe(cancelled);
    // the host answers after it removed its part, and the listing is read after the answer
    await vi.waitFor(() => expect(fs.readdirSync(file('src')).sort()).toEqual(['a.ts', 'b.ts']));
    const big = Buffer.alloc(700 * 1024, 7);
    fs.writeFileSync(file('src/big.bin'), big);
    const read = await workspace.files.readFile(project, 'src/big.bin');
    if (!read.ok) throw new Error(read.reason);
    expect(read.size).toBe(big.length);
    const parts: Buffer[] = [];
    for await (const chunk of read.chunks) parts.push(Buffer.from(chunk));
    expect(Buffer.concat(parts).equals(big)).toBe(true);
    expect(await workspace.files.readFile(project, 'src')).toEqual({ ok: false, reason: 'notAFile' });
    const early = await workspace.files.readFile(project, 'src/big.bin');
    if (!early.ok) throw new Error(early.reason);
    for await (const chunk of early.chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      break;
    }
  });

  it('reads a byte range of a file on the host, clamped to its size, and refuses what readFile refuses', async () => {
    const big = Buffer.from(Array.from({ length: 700 * 1024 }, (_, i) => i % 251));
    fs.writeFileSync(file('src/big.bin'), big);
    const bytesOf = async (offset: number, length: number): Promise<{ offset: number; length: number; bytes: Buffer }> => {
      const read = await workspace.files.readFileRange(project, 'src/big.bin', offset, length);
      if (!read.ok) throw new Error(read.reason);
      expect(read.size).toBe(big.length);
      const parts: Buffer[] = [];
      for await (const chunk of read.chunks) parts.push(Buffer.from(chunk));
      return { offset: read.offset, length: read.length, bytes: Buffer.concat(parts) };
    };
    const middle = await bytesOf(300 * 1024 + 7, 200 * 1024);
    expect(middle.offset).toBe(300 * 1024 + 7);
    expect(middle.bytes.equals(big.subarray(300 * 1024 + 7, 500 * 1024 + 7))).toBe(true);
    const suffix = await bytesOf(-10, 10);
    expect(suffix.offset).toBe(big.length - 10);
    expect(suffix.bytes.equals(big.subarray(-10))).toBe(true);
    expect(await bytesOf(big.length, 10)).toEqual({ offset: big.length, length: 0, bytes: Buffer.alloc(0) });
    // the spans a preview asks for the whole file and for a suffix longer than it
    for (const [offset, length] of [[0, Number.MAX_SAFE_INTEGER], [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]] as const) {
      const whole = await bytesOf(offset, length);
      expect(whole.offset).toBe(0);
      expect(whole.length).toBe(big.length);
      expect(whole.bytes.equals(big)).toBe(true);
    }
    expect(await workspace.files.readFileRange(project, 'src', 0, 1)).toEqual({ ok: false, reason: 'notAFile', folder: true });
    expect(await workspace.files.readFileRange(project, 'src/gone.bin', 0, 1)).toEqual({ ok: false, reason: 'missing' });
  });

  it("answers a ranged read with the file's path relative to the project's real root, through folder links", async () => {
    fs.mkdirSync(file('.git'));
    fs.writeFileSync(file('.git/config'), 'secret');
    fs.mkdirSync(file('node_modules/.pnpm/lib@1.0.0/node_modules/lib'), { recursive: true });
    fs.writeFileSync(file('node_modules/.pnpm/lib@1.0.0/node_modules/lib/index.js'), 'lib');
    fs.symlinkSync(file('.git'), file('src/x'), 'junction');
    fs.symlinkSync(file('node_modules/.pnpm/lib@1.0.0/node_modules/lib'), file('node_modules/lib'), 'junction');
    const resolved = async (relativePath: string): Promise<string> => {
      const read = await workspace.files.readFileRange(project, relativePath, 0, 1);
      if (!read.ok) throw new Error(read.reason);
      await read.chunks[Symbol.asyncIterator]().return?.();
      return read.resolvedPath;
    };
    expect(await resolved('src/x/config')).toBe('.git/config');
    expect(await resolved('node_modules/lib/index.js')).toBe('node_modules/.pnpm/lib@1.0.0/node_modules/lib/index.js');
  });

  it('closes the host\'s handle of a ranged read returned unread', async () => {
    // past the stream's credit window, so the host still holds its handle while no byte is read
    fs.writeFileSync(file('src/huge.bin'), Buffer.alloc(4 * 1024 * 1024));
    // FileHandle is not exported, so its prototype comes from a handle; the host's handle is the one it stats as it opens, and
    // a closed handle's fd is -1
    const probe = await fs.promises.open(file('src/huge.bin'), 'r');
    const stat = vi.spyOn(Object.getPrototypeOf(probe) as fs.promises.FileHandle, 'stat');
    await probe.close();
    try {
      const unread = await workspace.files.readFileRange(project, 'src/huge.bin', 0, 4 * 1024 * 1024);
      if (!unread.ok) throw new Error(unread.reason);
      const opened = stat.mock.contexts as fs.promises.FileHandle[];
      expect(opened).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(opened[0]!.fd).toBeGreaterThanOrEqual(0);
      await unread.chunks[Symbol.asyncIterator]().return?.();
      await expect.poll(() => opened[0]!.fd).toBe(-1);
    } finally {
      stat.mockRestore();
    }
  });

  it('walks in pages, finds clashes, and copies, moves, makes and removes folders on the host', async () => {
    fs.mkdirSync(file('src/deep'));
    fs.writeFileSync(file('src/deep/c.txt'), 'see');
    const walked: Array<[string, string]> = [];
    for await (const page of workspace.files.walk(project, 'src')) walked.push(...page.map((entry): [string, string] => [entry.relativePath, entry.kind]));
    expect(walked).toEqual([['', 'dir'], ['a.ts', 'file'], ['deep', 'dir'], ['deep/c.txt', 'file']]);
    for await (const page of workspace.files.walk(project, 'src')) {
      expect(page.length).toBeGreaterThan(0);
      break;
    }
    const foldsCase = process.platform === 'win32' || process.platform === 'darwin';
    expect(await workspace.files.clashes(project, 'src', ['A.ts', 'z.ts'])).toEqual({ ok: true, clashes: [foldsCase ? { name: 'a.ts', kind: 'file' } : null, null] });
    expect(await workspace.files.makeFolder(project, '', 'lib')).toEqual({ ok: true });
    expect(await workspace.files.makeFolder(project, '', 'lib')).toEqual({ ok: true });
    expect(await workspace.files.copy(project, 'src/a.ts', project, 'lib', 'a copy.ts', false)).toEqual({ ok: true });
    expect(fs.readFileSync(file('lib/a copy.ts'), 'utf8')).toBe('export const needle = 1;\n');
    expect(await workspace.files.move(project, 'src/deep', project, 'lib', 'deep', false)).toEqual({ ok: true, left: [] });
    expect(fs.readFileSync(file('lib/deep/c.txt'), 'utf8')).toBe('see');
    expect(await workspace.files.move(project, 'lib', project, 'lib/deep', 'lib', false)).toEqual({ ok: false, reason: 'intoItself' });
    expect(await workspace.files.makeLink(project, 'lib', 'to-a', 'a copy.ts', false)).toEqual(process.platform === 'win32' ? { ok: false, reason: 'unsupported' } : { ok: true });
    fs.mkdirSync(file('empty'));
    const empty = await workspace.files.entry(project, 'empty');
    if (!empty.ok) throw new Error(empty.reason);
    expect(await workspace.files.removeFolder(project, 'empty', empty.identity)).toEqual({ ok: true });
    expect(fs.existsSync(file('empty'))).toBe(false);
  });

  it('answers projectOfPath with the project it was given', async () => {
    const found = await workspace.files.projectOfPath([project], file('src/a.ts'));
    expect(found).toEqual({ project, relativePath: 'src/a.ts', path: file('src/a.ts') });
    expect(await workspace.files.projectOfPath([project], path.join(root, 'outside.txt'))).toBeUndefined();
  });

  it('lists a folder, and stops reporting a watch once it is disposed', async () => {
    expect(await workspace.tree.list(project, '', [])).toEqual({ ok: true, entries: expect.arrayContaining([{ name: 'src', kind: 'dir' }, { name: 'README.md', kind: 'file' }]) });
    expect(await workspace.tree.list(project, '../', [])).toMatchObject({ ok: false });
    const events: WatchEvent[] = [];
    const watch = workspace.files.watch(project.fsPath, '**', (event) => events.push(event));
    // a watch is live once it reports a file made after it started
    await expect.poll(() => {
      fs.writeFileSync(file('probe.txt'), String(Date.now()));
      return events.some((event) => event.path === file('probe.txt'));
    }, { timeout: 15_000, interval: 300 }).toBe(true);
    watch.dispose();
    // a second watch that sees a later file proves the disposed one was told of it too, had it still been watching
    const later: WatchEvent[] = [];
    const witness = workspace.files.watch(project.fsPath, '**', (event) => later.push(event));
    const seen = events.length;
    await expect.poll(() => {
      fs.writeFileSync(file('after.txt'), String(Date.now()));
      return later.some((event) => event.path === file('after.txt'));
    }, { timeout: 15_000, interval: 300 }).toBe(true);
    witness.dispose();
    expect(events.slice(seen)).toEqual([]);
  });

  it('reports a file created and deleted right after the watch is ready', async () => {
    const events: WatchEvent[] = [];
    const watch = workspace.files.watch(project.fsPath, '**', (event) => events.push(event));
    try {
      await watch.ready;
      fs.writeFileSync(file('fresh.txt'), 'x');
      await expect.poll(() => events.some((event) => event.kind === 'create' && event.path === file('fresh.txt')), { timeout: 15_000 }).toBe(true);
      fs.rmSync(file('fresh.txt'));
      await expect.poll(() => events.some((event) => event.kind === 'delete' && event.path === file('fresh.txt')), { timeout: 15_000 }).toBe(true);
    } finally {
      watch.dispose();
    }
  });

  it('runs ripgrep for search and walks for the Quick Open listing in the project', async () => {
    const found = await search(workspace, project.fsPath);
    expect(found.end).toMatchObject({ code: 0 });
    expect(found.events.filter((event) => event.type === 'match')).toHaveLength(1);
    expect(await listing(workspace, project.fsPath)).toEqual({ files: ['README.md', 'src/a.ts'], error: undefined });
  });

  it('lists hidden files and .git as the excludes allow, in batches, and nothing through or under a junction', async () => {
    fs.mkdirSync(path.join(root, 'linked'));
    fs.writeFileSync(path.join(root, 'linked', 'secret.ts'), '');
    fs.symlinkSync(path.join(root, 'linked'), file('link'), 'junction');
    fs.mkdirSync(file('.git'));
    fs.writeFileSync(file('.git/HEAD'), '');
    fs.writeFileSync(file('.env'), '');
    fs.mkdirSync(file('many'));
    const many = Array.from({ length: 1200 }, (_, index) => `many/f${String(index).padStart(4, '0')}.ts`);
    for (const name of many) fs.writeFileSync(file(name), '');
    expect(await listing(workspace, project.fsPath, ['**/.git'])).toEqual({ files: ['.env', 'README.md', ...many, 'src/a.ts'], error: undefined });
    expect((await listing(workspace, project.fsPath, ['**/many'])).files).toEqual(['.env', '.git/HEAD', 'README.md', 'src/a.ts']);
  });

  it('searches what rg matched over its own walk: .git as the toggle and excludes allow, binary files, CRLF, multiline and context', async () => {
    fs.mkdirSync(file('.git'));
    fs.writeFileSync(file('.git/HEAD'), 'needle head\n');
    fs.writeFileSync(file('.gitignore'), 'ignored.txt\n');
    fs.writeFileSync(file('ignored.txt'), 'needle ignored\n');
    fs.mkdirSync(file('node_modules/pkg'), { recursive: true });
    fs.writeFileSync(file('node_modules/pkg/x.js'), 'needle vendored\n');
    fs.writeFileSync(file('crlf.txt'), 'one\r\nneedle two\r\nthree\r\n');
    fs.writeFileSync(file('multi.txt'), 'foo\nbar needle\nbaz\n');
    // rg's walk shows nothing of a file from the read buffer holding its first NUL (64 KiB) on, and all of a file without one
    fs.writeFileSync(file('early.bin'), Buffer.from('head\0\nneedle 1\n'));
    fs.writeFileSync(file('late.bin'), `${Array.from({ length: 2000 }, (_, index) => `needle ${index}`).join('\n')}\n${'filler line\n'.repeat(8000)}x\0y\nneedle tail\n`);
    fs.writeFileSync(file('wide.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('before\nneedle wide\nafter\n', 'utf16le')]));
    const query = { pattern: 'needle', isRegex: false, matchCase: false, wholeWord: false, include: '', exclude: '', useExcludeSettingsAndIgnoreFiles: true, onlyOpenEditors: false };
    const request = (overrides: Partial<typeof query>, contextLines = 0): SearchRequest =>
      searchRequest({ query: { ...query, ...overrides }, include: [], exclude: [], excludeSettings: ['**/.git', '**/node_modules'], ignore: ALL_IGNORE_FILES, followLinks: false, contextLines });
    const cases: Array<[string, SearchRequest]> = [
      ['the toggle on', request({})],
      ['the toggle off', request({ useExcludeSettingsAndIgnoreFiles: false })],
      ['context lines', request({}, 1)],
      ['a multiline regex', request({ pattern: 'bar needle\\nbaz', isRegex: true })],
      ['a regex end of line at CRLF', request({ pattern: 'two$', isRegex: true })],
      ['no match', request({ pattern: 'absent' })],
    ];
    for (const [label, searched] of cases) {
      const expected = rgOwnWalk(project.fsPath, searched);
      const found = await search(workspace, project.fsPath, searched);
      expect(lineEvents(found.events), label).toEqual(expected.files);
      expect(found.end, label).toEqual({ code: expected.code, stderr: '' });
    }
    expect(Object.keys(rgOwnWalk(project.fsPath, request({ useExcludeSettingsAndIgnoreFiles: false })).files).sort()).toEqual(['.git/HEAD', 'crlf.txt', 'ignored.txt', 'late.bin', 'multi.txt', 'node_modules/pkg/x.js', 'src/a.ts', 'wide.txt']);
  });

  it('searches nothing through or under a junction, and a dangling junction fails nothing', async () => {
    fs.mkdirSync(path.join(root, 'linked'));
    fs.writeFileSync(path.join(root, 'linked', 'secret.ts'), 'needle\n');
    fs.symlinkSync(path.join(root, 'linked'), file('link'), 'junction');
    fs.mkdirSync(path.join(root, 'gone'));
    fs.symlinkSync(path.join(root, 'gone'), file('dangling'), 'junction');
    fs.rmdirSync(path.join(root, 'gone'));
    const found = await search(workspace, project.fsPath);
    expect(Object.keys(lineEvents(found.events))).toEqual(['src/a.ts']);
    expect(found.events.map((event) => event.type)).toEqual(['begin', 'match', 'end']);
    expect(found.end).toEqual({ code: 0, stderr: '' });
    // rg's own walk opens the junction's target, and fails on the one that is gone
    if (process.platform === 'win32') expect(rgOwnWalk(project.fsPath, NEEDLE).code).toBe(2);
  });

  it('under followLinks lists and searches a junction\'s files by the path through it, and leaves a dangling one out', async () => {
    fs.mkdirSync(path.join(root, 'linked'));
    fs.writeFileSync(path.join(root, 'linked', 'secret.ts'), 'needle\n');
    fs.symlinkSync(path.join(root, 'linked'), file('link'), 'junction');
    fs.mkdirSync(path.join(root, 'gone'));
    fs.symlinkSync(path.join(root, 'gone'), file('dangling'), 'junction');
    fs.rmdirSync(path.join(root, 'gone'));
    const found = await search(workspace, project.fsPath, { ...NEEDLE, walk: { ...NEEDLE.walk, followLinks: true } });
    expect(Object.keys(lineEvents(found.events)).sort()).toEqual(['link/secret.ts', 'src/a.ts']);
    expect(found.end).toEqual({ code: 0, stderr: '' });
    expect(await listing(workspace, project.fsPath, [], true)).toEqual({ files: ['README.md', 'link/secret.ts', 'src/a.ts'], error: undefined });
  });

  it('shows rg\'s own wording for a glob the walk refuses, and rg\'s stderr for a regex it refuses', async () => {
    const glob = await search(workspace, project.fsPath, { ...NEEDLE, walk: { ...NEEDLE.walk, overrides: ['a}'] } });
    expect(glob).toEqual({ events: [], end: { code: 2, stderr: expect.stringMatching(/^error parsing glob 'a}'/) } });
    const regex = await search(workspace, project.fsPath, { ...NEEDLE, match: [], pattern: '(' });
    expect(regex.events).toEqual([]);
    expect(regex.end).toEqual({ code: 2, stderr: expect.stringContaining('regex parse error') });
  });

  it('answers the terminal backend\'s environment, its kept terminals and a link\'s kind', async () => {
    const env = await workspace.terminals.environment('en-US');
    expect(Object.keys(env).some((key) => key.toUpperCase() === 'PATH')).toBe(true);
    expect(Object.keys(env).filter((key) => key.startsWith('ELECTRON_'))).toEqual([]);
    expect(await workspace.terminals.list()).toEqual([]);
    expect(await workspace.terminals.linkKind(project, 'src/a.ts')).toBe('file');
    expect(await workspace.terminals.linkKind(project, 'src')).toBe('folder');
    expect(await workspace.terminals.linkKind(project, 'gone')).toBeNull();
  });

  it('sends no end for a search or a listing it killed', async () => {
    for (let index = 0; index < 200; index++) fs.writeFileSync(file(`src/f${index}.ts`), 'needle\n');
    const ends: string[] = [];
    workspace.search.run(project.fsPath, NEEDLE, { event: () => undefined, dropped: () => undefined, end: () => ends.push('search') }).kill();
    workspace.quickOpen.list(project.fsPath, { ignore: ALL_IGNORE_FILES, followLinks: false }, [], { files: () => undefined, end: () => ends.push('listing') }).kill();
    // a run started after the kills ends after anything the killed ones could still send
    expect((await search(workspace, project.fsPath)).end).toMatchObject({ code: 0 });
    expect((await listing(workspace, project.fsPath)).error).toBeUndefined();
    expect(ends).toEqual([]);
  });

  it('finds no Prettier in a project that has none, and keeps no formatter host for a project it released', async () => {
    expect(await workspace.format.resolve(project.fsPath, file('src/a.ts'), [])).toEqual({ kind: 'none' });
    workspace.format.retain([project.key]);
    expect(await workspace.format.running(project.key)).toBe(false);
    await workspace.format.release(project.key);
    expect(await workspace.format.running(project.key)).toBe(false);
  });

  it('detects the shells of this host and injects shell integration into one it supports', async () => {
    const profiles = await workspace.terminals.detectProfiles();
    expect(profiles.length).toBeGreaterThan(0);
    for (const profile of profiles) expect(path.isAbsolute(profile.file)).toBe(true);
    const injected = await Promise.all(profiles.map((profile) => workspace.terminals.injection({ file: profile.file, args: profile.args, nonce: 'n0nce', env: {} })));
    expect(injected.some((injection) => injection?.env[NONCE_ENV] === 'n0nce')).toBe(true);
  });
});

describe('transfers over a loopback connection', () => {
  let adapter: Adapter;
  let root: string;
  let project: Project;

  const start = async (features?: (listed: readonly string[]) => readonly string[], requested?: string[]): Promise<void> => {
    adapter = await remoteAdapter(features, requested);
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-conf-transfer-')));
    const folder = path.join(root, 'proj');
    fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'src', 'a.ts'), 'a');
    project = { key: adapter.keyOf(folder), fsPath: folder, name: 'proj' };
  };

  afterEach(async () => {
    await adapter.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('confines a request without links within the project, so a client that does not ask never follows a link out', async () => {
    await start();
    fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');
    fs.symlinkSync(root, path.join(project.fsPath, 'escape'), 'junction');
    const endpoint = adapter.endpoint!;
    const wire = { key: folderKey(project.fsPath), fsPath: project.fsPath, name: project.name };
    expect(await endpoint.request('files.confineExisting', { project: wire, relativePath: 'escape/outside.txt' }, undefined)).toEqual({ ok: false, reason: 'outside' });
    expect(await endpoint.request('files.confineMissing', { project: wire, relativePath: 'escape/new.txt' }, undefined)).toEqual({ ok: false, reason: 'outside' });
    expect(await endpoint.request('files.entry', { project: wire, relativePath: 'escape/outside.txt' }, undefined)).toEqual({ ok: false, reason: 'outside' });
    expect(await endpoint.request('tree.list', { project: wire, relativeDir: 'escape', excludes: [] }, undefined)).toEqual({ ok: false, reason: 'outside' });
    expect(await endpoint.request('terminals.linkKind', { project: wire, relativePath: 'escape/outside.txt' }, undefined)).toBeNull();
    expect(await endpoint.request('files.createEntry', { project: wire, relativeDir: 'escape', name: 'made.txt', kind: 'file' }, undefined)).toEqual({ ok: false, reason: 'outside' });
    expect(await endpoint.request('files.clashes', { project: wire, relativeDir: 'escape', names: ['outside.txt'] }, undefined)).toEqual({ ok: false, reason: 'outside' });
    expect(fs.existsSync(path.join(root, 'made.txt'))).toBe(false);
    expect(await endpoint.request('files.confineExisting', { project: wire, relativePath: 'escape/outside.txt', links: 'follow' }, undefined)).toEqual({ ok: true, path: path.join(root, 'outside.txt'), via: { link: 'escape', realRoot: root } });
  });

  it('sends nothing to a daemon that does not list the transfer features, and the connection stays up', async () => {
    await start((listed) => listed.filter((feature) => !TRANSFER_FEATURES.includes(feature)));
    const { files } = adapter.workspace;
    const identity = { dev: 1n, ino: 2n, birthtimeNs: 3n };
    async function* none(): AsyncGenerator<Uint8Array> {}
    const calls: Array<() => Promise<unknown>> = [
      async () => {
        for await (const page of files.walk(project, 'src')) return page;
        return undefined;
      },
      () => files.clashes(project, 'src', ['a.ts']),
      () => files.copy(project, 'src/a.ts', project, 'src', 'b.ts', false),
      () => files.move(project, 'src/a.ts', project, 'src', 'b.ts', false),
      () => files.makeFolder(project, '', 'lib', 0o755),
      () => files.makeLink(project, '', 'to-a', 'src/a.ts', false, ''),
      () => files.verifyLink(project, 'to-a', ''),
      () => files.removeFolder(project, 'src', identity),
      () => files.receiveFile(project, 'src', 'b.ts', none(), { mode: 0o644, mtimeMs: 0, replace: false, size: 0 }),
      () => files.readFile(project, 'src/a.ts'),
    ];
    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(TransfersUnsupportedError);
    expect(fs.readdirSync(project.fsPath)).toEqual(['src']);
    expect(await files.confineExisting(project, 'src/a.ts', 'throughLinks')).toEqual({ ok: true, path: path.join(project.fsPath, 'src', 'a.ts') });
  });

  it.each([OUTSIDE_FILES_FEATURE, SESSION_FILES_FEATURE, READ_OUTSIDE_LIMIT_FEATURE])('sends nothing for a file outside every project to a daemon that does not list %s, and the connection stays up', async (missing) => {
    await start((listed) => listed.filter((feature) => feature !== missing));
    const { files } = adapter.workspace;
    const target = path.join(root, 'proj', 'src', 'a.ts');
    await expect(files.resolveOutside(target)).rejects.toBeInstanceOf(OutsideFilesUnsupportedError);
    await expect(files.readOutside(target)).rejects.toBeInstanceOf(OutsideFilesUnsupportedError);
    await expect(files.writeOutside(target, Buffer.from('x'))).rejects.toBeInstanceOf(OutsideFilesUnsupportedError);
    expect(fs.readFileSync(target, 'utf8')).toBe('a');
    expect(await files.confineExisting(project, 'src/a.ts', 'throughLinks')).toEqual({ ok: true, path: target });
  });

  it('sends no ranged read to a daemon that does not list files.readFileRange.resolvedPath, and its whole-file read still works', async () => {
    const requested: string[] = [];
    await start((listed) => listed.filter((feature) => feature !== RANGED_READS_FEATURE), requested);
    const { files } = adapter.workspace;
    await expect(files.readFileRange(project, 'src/a.ts', 0, 1)).rejects.toBeInstanceOf(RangedReadsUnsupportedError);
    expect(requested).toEqual([]);
    const read = await files.readFile(project, 'src/a.ts');
    expect(requested).toEqual(['files.readFile']);
    if (!read.ok) throw new Error(read.reason);
    for await (const chunk of read.chunks) expect(Buffer.from(chunk).toString('utf8')).toBe('a');
  });

  it('sends no Quick Open listing or search to a daemon that does not list the walk features, and the connection stays up', async () => {
    const requested: string[] = [];
    await start((listed) => listed.filter((feature) => !WALK_FEATURES.includes(feature)), requested);
    const { workspace } = adapter;
    expect(await listing(workspace, project.fsPath)).toEqual({ files: [], error: undefined });
    expect(await search(workspace, project.fsPath)).toEqual({ events: [], end: { error: 'Update the Damocles server on this host to search it.' } });
    expect(requested).toEqual([]);
    expect(await workspace.files.confineExisting(project, 'src/a.ts', 'throughLinks')).toEqual({ ok: true, path: path.join(project.fsPath, 'src', 'a.ts') });
  });

  it('lists and searches without links on a daemon that does not list files.links', async () => {
    await start((listed) => listed.filter((feature) => feature !== LINKS_FEATURE));
    const { workspace } = adapter;
    fs.mkdirSync(path.join(root, 'linked'));
    fs.writeFileSync(path.join(root, 'linked', 'secret.ts'), 'needle\n');
    fs.symlinkSync(path.join(root, 'linked'), path.join(project.fsPath, 'link'), 'junction');
    expect(await listing(workspace, project.fsPath, [], true)).toEqual({ files: ['src/a.ts'], error: undefined });
    expect(await search(workspace, project.fsPath, { ...NEEDLE, walk: { ...NEEDLE.walk, followLinks: true } })).toEqual({ events: [], end: { code: 1, stderr: '' } });
  });

  it('sends no listing to a daemon that does not list files.listOutside, and the connection stays up', async () => {
    await start((listed) => listed.filter((feature) => feature !== OUTSIDE_LISTING_FEATURE));
    const { files } = adapter.workspace;
    await expect(files.listOutside(root, '')).rejects.toBeInstanceOf(ListingUnsupportedError);
    expect(await files.resolveOutside(root)).toEqual({ kind: 'folder', path: root });
  });

  it('ends a file\'s stream short once its signal aborts, also while the writer waits for credit, and the host keeps no part', async () => {
    await start();
    const controller = new AbortController();
    let pulled = 0;
    // a source far faster than the host writes, which never ends on its own
    const endless: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          pulled += 1;
          if (pulled === 4) controller.abort();
          return { done: false, value: new Uint8Array(64 * 1024).fill(1) };
        },
        return: async () => ({ done: true, value: undefined }),
      }),
    };
    const size = 256 * 1024 * 1024;
    expect(await adapter.workspace.files.receiveFile(project, 'src', 'big.bin', endless, { mode: 0o644, mtimeMs: 0, replace: false, size }, controller.signal)).toMatchObject({ ok: false, reason: 'incomplete' });
    expect(pulled * 64 * 1024).toBeLessThan(size / 16);
    expect(fs.readdirSync(path.join(project.fsPath, 'src'))).toEqual(['a.ts']);
  });

  it('frees each source stream a receiver refused unread, so a download never uses up the connection\'s streams', async () => {
    await start();
    const count = MAX_OPEN_STREAMS + 8;
    for (let index = 0; index < count; index++) fs.writeFileSync(path.join(project.fsPath, 'src', `f${index}.txt`), 'x');
    const local = createFileSystem({ watchers: createFakePlatform().fileWatchers, trash: async () => undefined, damoclesHome: DAMOCLES_HOME_DIR, log: () => undefined });
    // a name another process took meanwhile: the receiver refuses before it reads a byte
    vi.spyOn(local, 'receiveFile').mockImplementation(async () => ({ ok: false, reason: 'exists' }));
    const ended: string[] = [];
    const service = new FileTransferService({
      projects: () => [project],
      filesOf: () => adapter.workspace.files,
      target: () => ({ os: process.platform, host: 'loopback' }),
      authorityOf: (key) => (key === project.key ? 'loopback' : 'local'),
      transfers: () => true,
      local,
      platform: process.platform,
      askChecked: async () => ({ action: undefined, checked: false }),
      notify: async () => undefined,
      showDetails: async () => undefined,
      renameInProject: async (_key, _from, renameOnDisk) => renameOnDisk(),
      progress: (update) => {
        if (['done', 'failed', 'cancelled'].includes(update.state)) ended.push(update.state);
      },
      changed: () => undefined,
      revealDownload: async () => undefined,
      t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)])),
      log: () => undefined,
    });
    const picked = path.join(root, 'downloads');
    fs.mkdirSync(picked);
    expect(await service.start({ op: 'download', sources: [{ kind: 'project', projectKey: project.key, relativePath: 'src' }], destination: { kind: 'download', folder: picked } })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(ended).toEqual(['done']), { timeout: 30_000 });
  }, 60_000);
});

describe('the workspace channel\'s file reads', () => {
  it('carries no whole-file text read, so a host reads a file only through its bounded, confined reads', () => {
    expect(Object.keys(CLIENT_TO_WORKSPACE.requests)).not.toContain('files.readText');
    expect(Object.keys(CLIENT_TO_WORKSPACE.requests)).toEqual(expect.arrayContaining(['files.read', 'files.readOutside', 'files.readFileRange']));
  });
});

describe('the outside answer on the wire', () => {
  it('carries other with its path and a refusal only with its reason, on every platform', () => {
    const { params, result } = CLIENT_TO_WORKSPACE.requests['files.resolveOutside'];
    expect(result({ kind: 'other', path: '/srv/pipe' })).toEqual({ kind: 'other', path: '/srv/pipe' });
    expect(result({ kind: 'outside', reason: 'share' })).toEqual({ kind: 'outside', reason: 'share' });
    expect(result({ kind: 'outside', reason: 'name' })).toEqual({ kind: 'outside', reason: 'name' });
    for (const malformed of [{ kind: 'outside' }, { kind: 'outside', reason: 'elsewhere' }, { kind: 'other' }, { kind: 'file' }]) {
      expect(result(malformed), JSON.stringify(malformed)).toBe(INVALID);
    }
    // the parser keeps only the fields it knows
    expect(params({ target: '/srv/x', extra: 'x' })).toEqual({ target: '/srv/x' });
  });

  it('carries a listing prefix only as the start of one name, and at most the host\'s 1,000 entries', () => {
    const { params, result } = CLIENT_TO_WORKSPACE.requests['files.listOutside'];
    expect(params({ folder: '/srv/', prefix: '.ba' })).toEqual({ folder: '/srv/', prefix: '.ba' });
    for (const prefix of ['a/b', 'a\\b', 'a\0', 'a\u0007', 'a\u0085', 'x'.repeat(256)]) expect(params({ folder: '/srv/', prefix }), JSON.stringify(prefix)).toBe(INVALID);
    const entries = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `f${index}`, kind: 'file', link: false }));
    expect(result({ kind: 'folder', path: '/srv', entries: entries(1000), truncated: true })).not.toBe(INVALID);
    expect(result({ kind: 'folder', path: '/srv', entries: entries(1001), truncated: true })).toBe(INVALID);
    expect(result({ kind: 'denied' })).toEqual({ kind: 'denied' });
    // main joins each name to the folder, so none may name another place
    for (const name of ['a/b', '.', '..', 'a\0', 'a\u0007', '']) expect(result({ kind: 'folder', path: '/srv', entries: [{ name, kind: 'file', link: false }], truncated: false }), JSON.stringify(name)).toBe(INVALID);
    // a POSIX host may list a name holding a backslash
    expect(result({ kind: 'folder', path: '/srv', entries: [{ name: 'a\\b', kind: 'file', link: false }], truncated: false })).not.toBe(INVALID);
    expect(result({ kind: 'folder', path: '/srv', entries: [{ name: 'l', kind: 'file', link: true, target: '/etc/x' }], truncated: false })).toEqual({ kind: 'folder', path: '/srv', entries: [{ name: 'l', kind: 'file', link: true, target: '/etc/x' }], truncated: false });
  });
});

describe('a refusal of an action that reaches chat session files, as a client reads it', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-conf-sessions-')));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // A client whose attach lists files.sessionFileRefusal reads the reason; any other, the attach's absence included, reads an
  // existing one with the refusal's words, which its parser takes.
  it('reaches a client that lists files.sessionFileRefusal as sessionFile, and any other as failed with its words', async () => {
    const home = path.join(root, 'home', '.damocles');
    const sessions = path.join(home, 'pi', 'agent', 'sessions', '--work--');
    const chat = path.join(sessions, '2026-11-04T10-00-00-000Z_s1.jsonl');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(chat, 'chat\n');
    const folder = path.join(root, 'proj');
    fs.mkdirSync(folder);
    fs.mkdirSync(path.join(sessions, 'empty'));
    fs.writeFileSync(path.join(folder, 'b.jsonl'), 'evil\n');
    fs.symlinkSync(path.dirname(sessions), path.join(folder, 'store'), 'junction');
    const inStore = `store/--work--/${path.basename(chat)}`;
    const failed = { ok: false, reason: 'failed', message: 'Chat session files are kept there, and only Damocles changes them.' };
    for (const [clientFeatures, refused] of [[FEATURES, { ok: false, reason: 'sessionFile' }], [FEATURES.filter((name) => name !== 'files.sessionFileRefusal'), failed], [[], failed]] as const) {
      const remote = testRemote({ watchers: createFakePlatform().fileWatchers, damoclesHome: home, clientFeatures });
      try {
        const project: Project = { key: `loopback|${folderKey(folder)}`, fsPath: folder, name: 'proj' };
        const { files } = remote.workspace();
        const entry = await files.entry(project, inStore);
        if (!entry.ok) throw new Error(`the session file did not confine: ${entry.reason}`);
        // an entry answer flags it, so Files refuses before its question
        expect(entry.sessionStore).toBe(true);
        expect(await files.deleteEntry(project, inStore, entry.identity)).toEqual(refused);
        expect(await files.renameEntry(project, inStore, 'renamed.jsonl')).toEqual(refused);
        expect(await files.createEntry(project, 'store/--work--', 'new.txt', 'file')).toEqual(refused);
        const wire = { key: folderKey(folder), fsPath: folder, name: 'proj' };
        expect(await remote.endpoint.request('files.makeFolder', { project: wire, relativeDir: 'store/--work--', name: 'made', links: 'follow' }, undefined)).toEqual(refused);
        expect(await remote.endpoint.request('files.copy', { from: wire, relativePath: 'b.jsonl', to: wire, toDir: 'store/--work--', name: path.basename(chat), replace: true, links: 'follow' }, undefined)).toEqual(refused);
        expect(await remote.endpoint.request('files.move', { from: wire, relativePath: inStore, to: wire, toDir: '', name: 'moved.jsonl', replace: false, links: 'follow' }, undefined)).toEqual(refused);
        const empty = await files.entry(project, 'store/--work--/empty');
        if (!empty.ok) throw new Error(`the empty folder did not confine: ${empty.reason}`);
        const { dev, ino, birthtimeNs } = empty.identity;
        expect(await remote.endpoint.request('files.removeFolder', { project: wire, relativePath: 'store/--work--/empty', confirmed: { dev: String(dev), ino: String(ino), birthtimeNs: String(birthtimeNs) }, links: 'follow' }, undefined)).toEqual(refused);
      } finally {
        remote.disconnect('the test ended');
      }
    }
    expect([fs.readdirSync(sessions).sort(), fs.readFileSync(chat, 'utf8')]).toEqual([[path.basename(chat), 'empty'], 'chat\n']);
  });
});
