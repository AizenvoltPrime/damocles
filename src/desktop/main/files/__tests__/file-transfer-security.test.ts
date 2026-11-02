import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import { folderKey } from '../../../../core/workspace-folders/folder-key';
import type { Project } from '../../../local-services/confine';
import type { FilesTransferProgress } from '../../../preload/shell-channels';
import { createFileSystem, type WorkspaceFileSystem } from '../../../workspace/file-system';
import { isPartName, type TransferEntry } from '../../../workspace/transfer-ops';
import type { CheckedQuestion } from '../../message-dialog';
import { FileTransferService, type FileTransferDeps, type TransferFiles, type TransferRequest } from '../file-transfer';

// Files that come from another machine, or leave this one: names, links, modes and sizes a target sends are untrusted, main
// writes only under the folder the user picked, and a move between hosts deletes a source item only after its copy landed.

const posix = process.platform !== 'win32';
const OUTSIDE = 'outside, never touched';
let root: string;

// a directory link that needs no privilege on Windows
const linkFolder = (target: string, link: string): void => fs.symlinkSync(target, link, posix ? 'dir' : 'junction');

function projectAt(dir: string): Project {
  fs.mkdirSync(dir, { recursive: true });
  return { key: folderKey(dir), fsPath: dir, name: path.basename(dir) };
}

const hostFiles = (platform: NodeJS.Platform = process.platform): WorkspaceFileSystem =>
  createFileSystem({ watchers: createFakePlatform().fileWatchers, trash: async () => undefined, damoclesHome: path.join(root, 'home', '.damocles'), log: () => undefined, platform });

interface Host {
  readonly project: Project;
  readonly files: TransferFiles;
  readonly os: NodeJS.Platform;
  readonly authority: string;
  readonly host?: string;
}

// answers each conflict with the action of that label
function harness(hosts: readonly Host[], options: { readonly platform?: NodeJS.Platform; readonly local?: TransferFiles; readonly answer?: string } = {}) {
  const progress: FilesTransferProgress[] = [];
  const asked: CheckedQuestion[] = [];
  const waiting = new Map<number, (state: FilesTransferProgress['state']) => void>();
  const byKey = (key: string): Host => {
    const found = hosts.find((candidate) => candidate.project.key === key);
    if (!found) throw new Error(`no project ${key}`);
    return found;
  };
  const deps: FileTransferDeps = {
    projects: () => hosts.map((candidate) => candidate.project),
    filesOf: (key) => byKey(key).files,
    target: (key) => ({ os: byKey(key).os, ...(byKey(key).host !== undefined ? { host: byKey(key).host } : {}) }),
    authorityOf: (key) => byKey(key).authority,
    transfers: () => true,
    local: options.local ?? hostFiles(options.platform),
    platform: options.platform ?? process.platform,
    askChecked: vi.fn(async (question: CheckedQuestion) => {
      asked.push(question);
      return { action: question.actions.indexOf(options.answer ?? 'Skip'), checked: false };
    }),
    notify: vi.fn(async () => undefined),
    showDetails: vi.fn(async () => undefined),
    renameInProject: vi.fn(async (_key, _from, renameOnDisk) => renameOnDisk()),
    progress: (update) => {
      progress.push(update);
      if (update.state === 'done' || update.state === 'failed' || update.state === 'cancelled') waiting.get(update.transferId)?.(update.state);
    },
    changed: vi.fn(),
    reveal: vi.fn(async () => undefined),
    t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)])),
    log: () => undefined,
  };
  const service = new FileTransferService(deps);
  // starts a transfer and resolves its end state
  const transfer = async (request: TransferRequest): Promise<FilesTransferProgress['state']> => {
    const started = await service.start(request);
    if (!started.ok) throw new Error(`refused: ${started.reason}`);
    const done = progress.find((update) => update.transferId === started.transferId && ['done', 'failed', 'cancelled'].includes(update.state));
    if (done) return done.state;
    return new Promise((resolve) => waiting.set(started.transferId, resolve));
  };
  return { service, deps, transfer, progress, asked };
}

// every entry under dir, '/' separated, a link as `name -> target`
function tree(dir: string, prefix = ''): string[] {
  return fs.readdirSync(dir).sort().flatMap((name) => {
    const at = path.join(dir, name);
    const rel = `${prefix}${name}`;
    const stat = fs.lstatSync(at);
    if (stat.isSymbolicLink()) return [`${rel} -> ${fs.readlinkSync(at)}`];
    return stat.isDirectory() ? [`${rel}/`, ...tree(at, `${rel}/`)] : [rel];
  });
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-transfer-service-security-')));
  fs.mkdirSync(path.join(root, 'elsewhere'));
  fs.writeFileSync(path.join(root, 'elsewhere', 'secret.txt'), OUTSIDE);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function expectOutsideUntouched(allowed: readonly string[]): void {
  expect(fs.readdirSync(root).sort()).toEqual([...allowed, 'elsewhere'].sort());
  expect(tree(path.join(root, 'elsewhere'))).toEqual(['secret.txt']);
  expect(fs.readFileSync(path.join(root, 'elsewhere', 'secret.txt'), 'utf8')).toBe(OUTSIDE);
}

// A target that lists and streams whatever it likes.
interface Listed {
  readonly relativePath: string;
  readonly kind: TransferEntry['kind'];
  readonly mode?: number;
  readonly linkTarget?: string;
  readonly text?: string;
  // the bytes streamed when they differ from text, whose length is the advertised size
  readonly sends?: string;
  readonly mtimeMs?: number;
}

function hostileTarget(listed: readonly Listed[]): TransferFiles {
  const entries: TransferEntry[] = listed.map((item, index) => ({
    relativePath: item.relativePath,
    kind: item.kind,
    size: item.text !== undefined ? Buffer.byteLength(item.text) : 0,
    mode: item.mode ?? (item.kind === 'dir' ? 0o755 : 0o644),
    mtimeMs: item.mtimeMs ?? Date.UTC(2022, 1, 2),
    identity: { dev: 1n, ino: BigInt(index + 1), birthtimeNs: 0n },
    ...(item.linkTarget !== undefined ? { linkTarget: item.linkTarget } : {}),
  }));
  const refuse = async (): Promise<never> => {
    throw new Error('a download never asks the target for this');
  };
  return {
    async *walk() {
      yield entries;
    },
    async readFile(_project, relativePath) {
      const item = listed.find((candidate) => `logs/${candidate.relativePath}` === relativePath && candidate.kind === 'file');
      if (!item || item.text === undefined) return { ok: false, reason: 'missing' };
      const sent = item.sends ?? item.text;
      return { ok: true, size: Buffer.byteLength(item.text), chunks: (async function* chunks() { yield Buffer.from(sent); })() };
    },
    clashes: refuse,
    receiveFile: refuse,
    copy: refuse,
    move: refuse,
    makeFolder: refuse,
    makeLink: refuse,
    verifyLink: refuse,
    removeFolder: refuse,
    deleteEntry: refuse,
  };
}

const HOSTILE: readonly Listed[] = [
  { relativePath: '', kind: 'dir' },
  { relativePath: 'ok.txt', kind: 'file', text: 'ok', mode: 0o4755 },
  { relativePath: 'ok.txt', kind: 'file', text: 'the second ok.txt' },
  { relativePath: '..', kind: 'file', text: 'dot dot' },
  { relativePath: '.', kind: 'file', text: 'dot' },
  { relativePath: 'a\\..\\..\\b.txt', kind: 'file', text: 'backslashes' },
  { relativePath: '../../evil.txt', kind: 'file', text: 'evil' },
  { relativePath: '/etc/passwd', kind: 'file', text: 'evil' },
  { relativePath: 'CON', kind: 'file', text: 'device' },
  { relativePath: 'trail.', kind: 'file', text: 'trailing dot' },
  { relativePath: 'x:y', kind: 'file', text: 'stream' },
  { relativePath: 'fifo', kind: 'other' },
  { relativePath: 'big.txt', kind: 'file', text: 'abc', sends: 'abcdefgh' },
  { relativePath: 'short.txt', kind: 'file', text: 'abcdefgh', sends: 'abc' },
  { relativePath: 'd1', kind: 'dir' },
  { relativePath: 'd1/b', kind: 'link', linkTarget: '..' },
  { relativePath: 'chain', kind: 'link', linkTarget: 'd1/b/..' },
  { relativePath: 'chain2', kind: 'link', linkTarget: 'd1/b/../../elsewhere/secret.txt' },
  { relativePath: 'passwd', kind: 'link', linkTarget: '/etc/passwd' },
  { relativePath: 'drive', kind: 'link', linkTarget: 'C:\\Windows\\win.ini' },
  { relativePath: 'unc', kind: 'link', linkTarget: '\\\\server\\share\\x' },
  { relativePath: 'up', kind: 'link', linkTarget: '../../elsewhere/secret.txt' },
  { relativePath: 'sub', kind: 'link', linkTarget: 'd1' },
  { relativePath: 'sub/x.txt', kind: 'file', text: 'through the link' },
  { relativePath: 'inner', kind: 'link', linkTarget: 'ok.txt' },
  { relativePath: 'deep', kind: 'dir' },
  { relativePath: 'deep/rel', kind: 'link', linkTarget: '../ok.txt' },
];

describe('Download from a hostile target', () => {
  function download(client: NodeJS.Platform) {
    const picked = path.join(root, 'picked');
    fs.mkdirSync(picked);
    const remote: Host = { project: { key: 'remote-key', fsPath: '/srv/app', name: 'app' }, files: hostileTarget(HOSTILE), os: 'linux', authority: 'ssh+prod-1', host: 'prod-1' };
    const { transfer, asked } = harness([remote], { platform: client, local: hostFiles(client) });
    return { picked, asked, run: () => transfer({ op: 'download', sources: [{ kind: 'project', projectKey: 'remote-key', relativePath: 'logs' }], destination: { kind: 'download', folder: picked } }) };
  }

  it.each(posix ? ['linux' as const, 'win32' as const] : ['win32' as const])('lands only safe names and safe links under the picked folder, on a %s client', async (client) => {
    const { picked, run } = download(client);
    expect(await run()).toBe('done');
    const names = client === 'win32' ? [] : ['CON', 'trail.', 'x:y'];
    // a link on a Windows client is skipped; on POSIX only relative links resolving inside the download, through no link
    // on POSIX a backslash is part of a name, so `\\server\share\x` names an entry beside the link
    const links = client === 'win32' ? [] : ['d1/b -> ..', 'deep/rel -> ../ok.txt', 'inner -> ok.txt', 'sub -> d1', 'unc -> \\\\server\\share\\x'];
    const expected = ['d1/', 'deep/', 'ok.txt', ...names, ...links].sort();
    expect(tree(path.join(picked, 'logs')).sort()).toEqual(expected);
    expect(fs.readFileSync(path.join(picked, 'logs', 'ok.txt'), 'utf8')).toBe('ok');
    expect(fs.readdirSync(picked)).toEqual(['logs']);
    expect(fs.readdirSync(path.join(picked, 'logs')).filter(isPartName)).toEqual([]);
    expectOutsideUntouched(['home', 'picked'].filter((name) => fs.existsSync(path.join(root, name))));
  });

  it.runIf(posix)('drops setuid, setgid and sticky from a downloaded file', async () => {
    const { picked, run } = download('linux');
    expect(await run()).toBe('done');
    expect(fs.statSync(path.join(picked, 'logs', 'ok.txt')).mode & 0o7777).toBe(0o755);
  });

  it('never merges into a picked-folder entry that is a link: Keep both lands in a new real folder', async () => {
    const picked = path.join(root, 'picked');
    fs.mkdirSync(picked);
    linkFolder(path.join(root, 'elsewhere'), path.join(picked, 'logs'));
    const remote: Host = { project: { key: 'remote-key', fsPath: '/srv/app', name: 'app' }, files: hostileTarget([{ relativePath: '', kind: 'dir' }, { relativePath: 'secret.txt', kind: 'file', text: 'from the target' }]), os: 'linux', authority: 'ssh+prod-1', host: 'prod-1' };
    const { transfer, asked } = harness([remote], { answer: 'Keep both' });
    expect(await transfer({ op: 'download', sources: [{ kind: 'project', projectKey: 'remote-key', relativePath: 'logs' }], destination: { kind: 'download', folder: picked } })).toBe('done');
    expect(asked.map((question) => question.actions)).toEqual([['Keep both', 'Skip']]);
    expect(fs.lstatSync(path.join(picked, 'logs')).isSymbolicLink()).toBe(true);
    expect(tree(path.join(picked, 'logs copy'))).toEqual(['secret.txt']);
    expectOutsideUntouched(['home', 'picked'].filter((name) => fs.existsSync(path.join(root, name))));
  });

  // the client's file system resolves `D1` to `d1`, so the lexical walk of the target must fold names as that file system does
  it('refuses a link that climbs out through a link of the download named in another case, on a darwin client', async () => {
    const picked = path.join(root, 'picked');
    fs.mkdirSync(picked);
    const remote: Host = {
      project: { key: 'remote-key', fsPath: '/srv/app', name: 'app' },
      files: hostileTarget([{ relativePath: '', kind: 'dir' }, { relativePath: 'd1', kind: 'dir' }, { relativePath: 'd1/b', kind: 'link', linkTarget: '..' }, { relativePath: 'a', kind: 'link', linkTarget: 'D1/b/../..' }]),
      os: 'linux',
      authority: 'ssh+prod-1',
      host: 'prod-1',
    };
    const { transfer } = harness([remote], { platform: 'darwin', local: hostFiles('darwin') });
    expect(await transfer({ op: 'download', sources: [{ kind: 'project', projectKey: 'remote-key', relativePath: 'logs' }], destination: { kind: 'download', folder: picked } })).toBe('done');
    expect(tree(path.join(picked, 'logs'))).toEqual(['d1/', 'd1/b -> ..']);
  });

  it('refuses a link that climbs out through a link already in the folder a download merges into', async () => {
    const picked = path.join(root, 'picked');
    fs.mkdirSync(path.join(picked, 'logs'), { recursive: true });
    linkFolder(path.join(root, 'elsewhere'), path.join(picked, 'logs', 'cur'));
    const remote: Host = {
      project: { key: 'remote-key', fsPath: '/srv/app', name: 'app' },
      files: hostileTarget([{ relativePath: '', kind: 'dir' }, { relativePath: 'x', kind: 'link', linkTarget: 'cur/..' }, { relativePath: 'y', kind: 'link', linkTarget: 'cur/secret.txt' }]),
      os: 'linux',
      authority: 'ssh+prod-1',
      host: 'prod-1',
    };
    const { transfer } = harness([remote], { platform: 'linux', local: hostFiles('linux') });
    expect(await transfer({ op: 'download', sources: [{ kind: 'project', projectKey: 'remote-key', relativePath: 'logs' }], destination: { kind: 'download', folder: picked } })).toBe('done');
    expect(tree(path.join(picked, 'logs')).filter((entry) => !entry.startsWith('cur'))).toEqual([]);
  });

  it.each([['win32' as const], ['darwin' as const]])('a case clash from a Linux target asks on a %s client and never overwrites silently', async (client) => {
    const picked = path.join(root, 'picked');
    fs.mkdirSync(picked);
    const remote: Host = {
      project: { key: 'remote-key', fsPath: '/srv/app', name: 'app' },
      files: hostileTarget([{ relativePath: '', kind: 'dir' }, { relativePath: 'A.txt', kind: 'file', text: 'upper' }, { relativePath: 'a.txt', kind: 'file', text: 'lower' }]),
      os: 'linux',
      authority: 'ssh+prod-1',
      host: 'prod-1',
    };
    const { transfer, asked } = harness([remote], { platform: client, local: hostFiles(client), answer: 'Skip' });
    expect(await transfer({ op: 'download', sources: [{ kind: 'project', projectKey: 'remote-key', relativePath: 'logs' }], destination: { kind: 'download', folder: picked } })).toBe('done');
    expect(asked).toHaveLength(1);
    expect(tree(path.join(picked, 'logs'))).toEqual(['A.txt']);
    expect(fs.readFileSync(path.join(picked, 'logs', 'A.txt'), 'utf8')).toBe('upper');
  });
});

describe('every name main sends a host is one that host allows', () => {
  it('a Keep both name too long for the host is skipped, never sent', async () => {
    const long = `${'n'.repeat(250)}.txt`;
    const dropped = path.join(root, 'drop', long);
    fs.mkdirSync(path.dirname(dropped), { recursive: true });
    fs.writeFileSync(dropped, 'new');
    const files = hostFiles('linux');
    const sent: string[] = [];
    const record = (name: string): void => {
      sent.push(name);
    };
    const dest: Host = {
      project: projectAt(path.join(root, 'remote')),
      files: {
        ...files,
        clashes: async (project, dir, names) => { names.forEach(record); return files.clashes(project, dir, names); },
        receiveFile: async (project, dir, name, source, options) => { record(name); return files.receiveFile(project, dir, name, source, options); },
        makeFolder: async (project, dir, name) => { record(name); return files.makeFolder(project, dir, name); },
      },
      os: 'linux',
      authority: 'ssh+prod-1',
      host: 'prod-1',
    };
    fs.writeFileSync(path.join(dest.project.fsPath, long), 'old');
    const { transfer } = harness([dest], { answer: 'Keep both' });
    expect(await transfer({ op: 'copy', sources: [{ kind: 'local', path: dropped }], destination: { kind: 'project', projectKey: dest.project.key, relativeDir: '' } })).toBe('done');
    expect(sent.filter((name) => name.length > 255)).toEqual([]);
    expect(fs.readFileSync(path.join(dest.project.fsPath, long), 'utf8')).toBe('old');
  });
});

describe('copies in from this computer never follow a link', () => {
  function droppedFolder(): string {
    const dropped = path.join(root, 'drop', 'pkg');
    fs.mkdirSync(dropped, { recursive: true });
    fs.writeFileSync(path.join(dropped, 'a.txt'), 'a');
    linkFolder(path.join(root, 'elsewhere'), path.join(dropped, 'escape'));
    return dropped;
  }

  it('to another host: a link out of the dropped folder is skipped and what it leads to never crosses', async () => {
    const dropped = droppedFolder();
    const dest: Host = { project: projectAt(path.join(root, 'remote')), files: hostFiles('linux'), os: 'linux', authority: 'ssh+prod-1', host: 'prod-1' };
    const { transfer } = harness([dest]);
    expect(await transfer({ op: 'copy', sources: [{ kind: 'local', path: dropped }], destination: { kind: 'project', projectKey: dest.project.key, relativeDir: '' } })).toBe('done');
    expect(tree(dest.project.fsPath)).toEqual(['pkg/', 'pkg/a.txt']);
    expectOutsideUntouched(['drop', 'home', 'remote'].filter((name) => fs.existsSync(path.join(root, name))));
  });

  it('on this computer: the link is made as a link on POSIX and skipped on Windows, never filled with what it leads to', async () => {
    const dropped = droppedFolder();
    const dest: Host = { project: projectAt(path.join(root, 'local')), files: hostFiles(), os: process.platform, authority: 'local' };
    const { transfer } = harness([dest]);
    expect(await transfer({ op: 'copy', sources: [{ kind: 'local', path: dropped }], destination: { kind: 'project', projectKey: dest.project.key, relativeDir: '' } })).toBe('done');
    const listed = tree(dest.project.fsPath);
    expect(listed.filter((entry) => entry.startsWith('pkg/escape') && !entry.startsWith('pkg/escape ->'))).toEqual([]);
    expect(listed.some((entry) => entry.includes('secret.txt'))).toBe(false);
    expect(listed.filter((entry) => !entry.startsWith('pkg/escape'))).toEqual(['pkg/', 'pkg/a.txt']);
    expectOutsideUntouched(['drop', 'home', 'local'].filter((name) => fs.existsSync(path.join(root, name))));
  });
});

describe('a move between hosts deletes a source item only after its copy landed whole', () => {
  let from: Host;
  let to: Host;

  beforeEach(() => {
    from = { project: projectAt(path.join(root, 'from')), files: hostFiles(), os: process.platform, authority: 'ssh+one', host: 'one' };
    to = { project: projectAt(path.join(root, 'to')), files: hostFiles(), os: process.platform, authority: 'ssh+two', host: 'two' };
    fs.mkdirSync(path.join(from.project.fsPath, 'pkg'));
    fs.writeFileSync(path.join(from.project.fsPath, 'pkg', 'a.txt'), 'abcdefgh');
  });

  const move = (): TransferRequest => ({ op: 'move', sources: [{ kind: 'project', projectKey: from.project.key, relativePath: 'pkg' }], destination: { kind: 'project', projectKey: to.project.key, relativeDir: '' } });
  const sourceFile = (): string => path.join(from.project.fsPath, 'pkg', 'a.txt');

  it('deletes the source once the copy landed, and keeps a source folder whose skipped child stays in it', async () => {
    linkFolder(path.join(root, 'elsewhere'), path.join(from.project.fsPath, 'pkg', 'escape'));
    const { transfer } = harness([from, to]);
    expect(await transfer(move())).toBe('done');
    expect(fs.readFileSync(path.join(to.project.fsPath, 'pkg', 'a.txt'), 'utf8')).toBe('abcdefgh');
    expect(fs.existsSync(sourceFile())).toBe(false);
    expect(fs.lstatSync(path.join(from.project.fsPath, 'pkg', 'escape')).isSymbolicLink()).toBe(true);
    expectOutsideUntouched(['from', 'home', 'to'].filter((name) => fs.existsSync(path.join(root, name))));
  });

  it('keeps the source when the stream ends short', async () => {
    const files = from.files;
    from = { ...from, files: { ...files, readFile: async (project, relativePath) => {
      const read = await files.readFile(project, relativePath);
      if (!read.ok) return read;
      for await (const chunk of read.chunks) void chunk;
      return { ok: true, size: read.size, chunks: (async function* short() { yield Buffer.from('abc'); })() };
    } } };
    const { transfer } = harness([from, to]);
    expect(await transfer(move())).toBe('done');
    expect(fs.readFileSync(sourceFile(), 'utf8')).toBe('abcdefgh');
    expect(fs.existsSync(path.join(to.project.fsPath, 'pkg', 'a.txt'))).toBe(false);
    expect(fs.readdirSync(path.join(to.project.fsPath, 'pkg')).filter(isPartName)).toEqual([]);
  });

  it('keeps the source when the destination refuses the file', async () => {
    to = { ...to, files: { ...to.files, receiveFile: async () => ({ ok: false, reason: 'failed', message: 'disk full' }) } };
    const { transfer } = harness([from, to]);
    expect(await transfer(move())).toBe('done');
    expect(fs.readFileSync(sourceFile(), 'utf8')).toBe('abcdefgh');
  });

  it('keeps the source when the file grew after the walk saw its size', async () => {
    const files = from.files;
    from = { ...from, files: { ...files, readFile: async (project, relativePath) => {
      fs.appendFileSync(sourceFile(), 'ijk');
      return files.readFile(project, relativePath);
    } } };
    const { transfer } = harness([from, to]);
    expect(await transfer(move())).toBe('done');
    expect(fs.readFileSync(sourceFile(), 'utf8')).toBe('abcdefghijk');
  });

  it('keeps the source, and leaves no part, when the move is cancelled mid-file', async () => {
    const files = from.files;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      from = { ...from, files: { ...files, readFile: async (project, relativePath) => {
        const read = await files.readFile(project, relativePath);
        if (!read.ok) return read;
        await read.chunks[Symbol.asyncIterator]().return?.();
        const gate = new Promise<void>((open) => { release = open; });
        return { ok: true, size: read.size, chunks: (async function* gated() {
          yield Buffer.from('abcd');
          resolve();
          await gate;
          yield Buffer.from('efgh');
        })() };
      } } };
    });
    const { service, transfer, progress } = harness([from, to]);
    const ended = transfer(move());
    await reached;
    service.cancel(progress[0]!.transferId);
    release();
    expect(await ended).toBe('cancelled');
    // the row ends at once; the step it stopped waiting for removes its part and claim, which cancelAll waits for
    await service.cancelAll();
    expect(fs.readFileSync(sourceFile(), 'utf8')).toBe('abcdefgh');
    expect(fs.existsSync(path.join(to.project.fsPath, 'pkg', 'a.txt'))).toBe(false);
    expect(fs.readdirSync(path.join(to.project.fsPath, 'pkg')).filter(isPartName)).toEqual([]);
  });
});
