// One ProjectWorkspace suite, run against the local adapter and the remote client served by the daemon's workspace host over
// a real connection, so the two hosts cannot drift.
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
import { createSearchRunner, type RgEvent, type SearchRunEnd } from '../../../workspace/search/search-runner';
import { createTerminalBackend } from '../../../workspace/terminal/terminal-backend';
import { NONCE_ENV } from '../../../workspace/terminal/shell-integration-injection';
import { createTreeListing } from '../../../workspace/tree-listing';
import { REPO_ROOT, startInProcessDaemon } from '../../../daemon/__tests__/in-process-daemon';
import { connect } from '../../remote/connection';
import { carriesTransfers, createRemoteWorkspace, TRANSFER_FEATURES, TransfersUnsupportedError, WATCH_READY_FEATURE } from '../remote-workspace';
import { NotConnectedError } from '../workspaces';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import { MAX_OPEN_STREAMS } from '../../../../remote/mux';
import { FileTransferService } from '../../files/file-transfer';

// No pty host or formatter host starts in this suite; the terminal and format members it runs need none.
const NO_HOSTS: HostStarters = {
  startPtyHost: () => { throw new Error('no pty host in this suite'); },
  startFormatterHost: () => { throw new Error('no formatter host in this suite'); },
};

interface Adapter {
  readonly workspace: ProjectWorkspace;
  // the key the adapter's callers name a project of this folder by
  readonly keyOf: (folder: string) => string;
  dispose(): Promise<void>;
}

// the watch worker bundled for this suite, which runs without a desktop build
let watchWorker: string;

beforeAll(async () => {
  watchWorker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-conf-worker-')), 'watch-worker.js');
  await build({ entryPoints: [path.join(REPO_ROOT, 'src', 'desktop', 'watch-worker', 'index.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: watchWorker, logLevel: 'silent' });
});

afterAll(() => {
  fs.rmSync(path.dirname(watchWorker), { recursive: true, force: true });
});

function watchers(): DesktopFileWatcherFactory {
  return new DesktopFileWatcherFactory({ folders: () => [], onDidChange: () => ({ dispose: () => undefined }) }, () => undefined, createWorkerTreeHost(() => new Worker(watchWorker), () => undefined));
}

async function localAdapter(): Promise<Adapter> {
  const factory = watchers();
  const log = (): void => undefined;
  const rg = async (): Promise<string> => rgPath;
  const workspace: ProjectWorkspace = {
    files: createFileSystem({ watchers: factory, trash: () => Promise.reject(new Error('no trash in this suite')), damoclesHome: DAMOCLES_HOME_DIR, log }),
    tree: createTreeListing(log),
    search: createSearchRunner({ rgPath: rg, log }),
    quickOpen: createQuickOpenListing({ rgPath: rg, log }),
    format: createFormatter({ starters: NO_HOSTS, watchers: factory, log }),
    terminals: createTerminalBackend({ starters: NO_HOSTS, platform: process.platform, scriptsDir: path.join(REPO_ROOT, 'resources', 'shell-integration'), zshDotDir: path.join(os.tmpdir(), 'zdot'), homedir: os.homedir(), env: process.env, log }),
  };
  return { workspace, keyOf: folderKey, dispose: () => factory.close() };
}

// features: what the client takes from the daemon's welcome, every name by default
async function remoteAdapter(features: (listed: readonly string[]) => readonly string[] = (listed) => listed): Promise<Adapter> {
  const daemon = await startInProcessDaemon({ starters: NO_HOSTS, watchWorker });
  const connection = await connect({ stream: await daemon.connect(), appVersion: '0.0.0-test', clientId: 'conformance', deviceName: 'test', terminalIdleDays: 30, log: () => undefined });
  const workspace = createRemoteWorkspace({
    endpoint: connection.workspace,
    authorityKey: 'loopback',
    projectOfCwd: () => undefined,
    onClose: (listener) => connection.onClose(listener),
    notConnected: () => new NotConnectedError('Local daemon is not connected.'),
    watchReady: connection.features.includes(WATCH_READY_FEATURE),
    transfers: carriesTransfers(features(connection.features)),
    openStream: () => connection.openStream(),
    log: () => undefined,
  });
  return {
    workspace,
    keyOf: (folder) => `loopback|${folderKey(folder)}`,
    dispose: async () => {
      connection.close('the suite ended');
      await daemon.shutdown();
    },
  };
}

const ADAPTERS: ReadonlyArray<readonly [string, () => Promise<Adapter>]> = [['local adapter', localAdapter], ['loopback client', () => remoteAdapter()]];

function search(workspace: ProjectWorkspace, cwd: string, args: readonly string[]): Promise<{ events: RgEvent[]; end: SearchRunEnd }> {
  return new Promise((resolve) => {
    const events: RgEvent[] = [];
    workspace.search.run(cwd, args, { event: (event) => events.push(event), dropped: () => undefined, end: (end) => resolve({ events, end }) });
  });
}

function listing(workspace: ProjectWorkspace, root: string): Promise<{ text: string; error: string | undefined }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    workspace.quickOpen.list(root, [], [], { data: (chunk) => chunks.push(chunk), end: (error) => resolve({ text: Buffer.concat(chunks).toString('utf8'), error }) });
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
    expect(await workspace.files.confineExisting(project, 'src/a.ts')).toEqual({ ok: true, path: file('src/a.ts') });
    expect(await workspace.files.confineExisting(project, 'nope.ts')).toEqual({ ok: false, reason: 'missing' });
    expect(await workspace.files.confineMissing(project, 'src/new.ts')).toEqual({ ok: true, path: file('src/new.ts') });
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

  it('rejects a failed read with the system error code, which crosses the wire as that code', async () => {
    const failed = await workspace.files.readText(file('src')).catch((err: unknown) => err);
    expect((failed as NodeJS.ErrnoException).code).toBe('EISDIR');
  });

  it('refuses a path a link carries out of the project', async () => {
    fs.symlinkSync(root, file('escape'), 'junction');
    expect(await workspace.files.confineExisting(project, 'escape/outside.txt')).toEqual({ ok: false, reason: 'outside' });
    expect(await workspace.files.confineMissing(project, 'escape/new.txt')).toEqual({ ok: false, reason: 'outside' });
    expect(await workspace.tree.list(project, 'escape', [])).toMatchObject({ ok: false });
  });

  it('reads bytes as a Buffer within the limit, and reads text', async () => {
    const read = await workspace.files.read(file('README.md'));
    if (read.kind !== 'bytes') throw new Error(read.kind);
    expect(Buffer.isBuffer(read.bytes)).toBe(true);
    expect(read.bytes.toString('utf8')).toBe('# Readme\n');
    expect(await workspace.files.read(file('README.md'), 4)).toEqual({ kind: 'tooLarge', bytes: 9 });
    expect(await workspace.files.read(file('gone.md'))).toEqual({ kind: 'missing' });
    expect(await workspace.files.readText(file('src/a.ts'))).toBe('export const needle = 1;\n');
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

  it('runs ripgrep for search and the Quick Open listing in the project', async () => {
    const found = await search(workspace, project.fsPath, ['--json', '--fixed-strings', '--', 'needle', '.']);
    expect(found.end).toMatchObject({ code: 0 });
    expect(found.events.filter((event) => event.type === 'match')).toHaveLength(1);
    const listed = await listing(workspace, project.fsPath);
    expect(listed.error).toBeUndefined();
    expect(listed.text.split(/\r?\n/).filter(Boolean).map((line) => path.relative(project.fsPath, line).split(path.sep).join('/')).sort()).toEqual(['README.md', 'src/a.ts']);
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
    workspace.search.run(project.fsPath, ['--json', '--fixed-strings', '--', 'needle', '.'], { event: () => undefined, dropped: () => undefined, end: () => ends.push('search') }).kill();
    workspace.quickOpen.list(project.fsPath, [], [], { data: () => undefined, end: () => ends.push('listing') }).kill();
    // a run started after the kills ends after anything the killed ones could still send
    expect((await search(workspace, project.fsPath, ['--json', '--fixed-strings', '--', 'needle', '.'])).end).toMatchObject({ code: 0 });
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

  const start = async (features?: (listed: readonly string[]) => readonly string[]): Promise<void> => {
    adapter = await remoteAdapter(features);
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
    expect(await files.confineExisting(project, 'src/a.ts')).toEqual({ ok: true, path: path.join(project.fsPath, 'src', 'a.ts') });
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
      reveal: async () => undefined,
      t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)])),
      log: () => undefined,
    });
    const picked = path.join(root, 'downloads');
    fs.mkdirSync(picked);
    expect(await service.start({ op: 'download', sources: [{ kind: 'project', projectKey: project.key, relativePath: 'src' }], destination: { kind: 'download', folder: picked } })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(ended).toEqual(['done']), { timeout: 30_000 });
  }, 60_000);
});
