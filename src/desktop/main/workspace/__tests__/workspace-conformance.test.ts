// One ProjectWorkspace suite, run against the local adapter and the remote client served by the daemon's workspace host over
// a real connection, so the two hosts cannot drift.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { rgPath } from '@vscode/ripgrep';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { createRemoteWorkspace } from '../remote-workspace';
import { NotConnectedError } from '../workspaces';

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

async function remoteAdapter(): Promise<Adapter> {
  const daemon = await startInProcessDaemon({ starters: NO_HOSTS, watchWorker });
  const connection = await connect({ stream: await daemon.connect(), appVersion: '0.0.0-test', clientId: 'conformance', deviceName: 'test', terminalIdleDays: 30, log: () => undefined });
  const workspace = createRemoteWorkspace({
    endpoint: connection.workspace,
    authorityKey: 'loopback',
    projectOfCwd: () => undefined,
    onClose: (listener) => connection.onClose(listener),
    notConnected: () => new NotConnectedError('Local daemon is not connected.'),
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

const ADAPTERS: ReadonlyArray<readonly [string, () => Promise<Adapter>]> = [['local adapter', localAdapter], ['loopback client', remoteAdapter]];

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
