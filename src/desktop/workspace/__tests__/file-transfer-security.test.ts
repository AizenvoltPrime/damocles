import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import type { Project } from '../../local-services/confine';
import { createTransferOps, isPartName, type TransferEntry, type TransferOps } from '../transfer-ops';

// The host side of copies in and out of Files against a hostile caller or a racing local process: every operation stays
// inside its project, never writes through a link, and never carries setuid, setgid or sticky bits.

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

const posix = process.platform !== 'win32';
const MTIME = Date.UTC(2021, 5, 6, 7, 8, 9);
const OUTSIDE = 'outside, never touched';
let root: string;
let project: Project;
let ops: TransferOps;
const at = (relative: string): string => path.join(project.fsPath, ...relative.split('/'));
const outside = (): string => path.join(root, 'outside.txt');

// a directory link that needs no privilege on Windows
const linkFolder = (target: string, link: string): void => fs.symlinkSync(target, link, posix ? 'dir' : 'junction');

async function* bytes(text: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(text);
}

const receive = (relativeDir: string, name: string, text: string, replace: boolean) =>
  ops.receiveFile(project, relativeDir, name, bytes(text), { mode: 0o644, mtimeMs: MTIME, replace, size: Buffer.byteLength(text) });

async function walked(relativePath: string): Promise<TransferEntry[]> {
  const entries: TransferEntry[] = [];
  for await (const page of ops.walk(project, relativePath)) entries.push(...page);
  return entries;
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-transfer-security-')));
  const projectDir = path.join(root, 'proj');
  fs.mkdirSync(path.join(projectDir, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'lib'));
  fs.writeFileSync(path.join(projectDir, 'src', 'a.ts'), 'inside');
  fs.mkdirSync(path.join(root, 'elsewhere'));
  fs.writeFileSync(outside(), OUTSIDE);
  fs.writeFileSync(path.join(root, 'elsewhere', 'secret.txt'), OUTSIDE);
  project = { key: folderKey(projectDir), fsPath: projectDir, name: 'proj' };
  ops = createTransferOps({ platform: process.platform, log: () => undefined });
  // a folder link inside the project that leads outside it
  linkFolder(path.join(root, 'elsewhere'), at('escape'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

// what lies outside the project after an operation: only the fixture's own entries, unchanged
function expectOutsideUntouched(): void {
  expect(fs.readdirSync(root).sort()).toEqual(['elsewhere', 'outside.txt', 'proj']);
  expect(fs.readdirSync(path.join(root, 'elsewhere'))).toEqual(['secret.txt']);
  expect(fs.readFileSync(outside(), 'utf8')).toBe(OUTSIDE);
  expect(fs.readFileSync(path.join(root, 'elsewhere', 'secret.txt'), 'utf8')).toBe(OUTSIDE);
}

describe('every new operation confines its paths on the host', () => {
  const escapes = (): string[] => ['..', '../outside.txt', 'src/../../outside.txt', outside(), 'escape/secret.txt'];

  it('copy refuses a source and a destination folder outside the project', async () => {
    for (const source of escapes()) {
      expect(await ops.copy(project, source, project, 'lib', 'got.txt', false), source).toMatchObject({ ok: false, reason: 'outside' });
    }
    for (const toDir of ['..', path.join(root, 'elsewhere'), 'escape', 'src/../..']) {
      expect(await ops.copy(project, 'src/a.ts', project, toDir, 'a.ts', false), toDir).toMatchObject({ ok: false, reason: 'outside' });
    }
    expect(fs.readdirSync(at('lib'))).toEqual([]);
    expectOutsideUntouched();
  });

  it('move refuses a source and a destination folder outside the project, and leaves both where they were', async () => {
    for (const source of escapes()) {
      expect(await ops.move(project, source, project, 'lib', 'got.txt', false), source).toMatchObject({ ok: false, reason: 'outside' });
    }
    for (const toDir of ['..', path.join(root, 'elsewhere'), 'escape', 'src/../..']) {
      expect(await ops.move(project, 'src/a.ts', project, toDir, 'a.ts', false), toDir).toMatchObject({ ok: false, reason: 'outside' });
    }
    expect(fs.readFileSync(at('src/a.ts'), 'utf8')).toBe('inside');
    expect(fs.readdirSync(at('lib'))).toEqual([]);
    expectOutsideUntouched();
  });

  it('receiveFile, makeFolder and clashes refuse a folder outside the project', async () => {
    for (const relativeDir of ['..', path.join(root, 'elsewhere'), 'escape', 'src/../..']) {
      expect(await receive(relativeDir, 'dropped.txt', 'x', false), relativeDir).toMatchObject({ ok: false, reason: 'outside' });
      expect(await ops.makeFolder(project, relativeDir, 'made'), relativeDir).toMatchObject({ ok: false, reason: 'outside' });
      expect(await ops.clashes(project, relativeDir, ['secret.txt']), relativeDir).toMatchObject({ ok: false, reason: 'outside' });
    }
    expectOutsideUntouched();
  });

  it.runIf(posix)('makeLink refuses a folder outside the project', async () => {
    for (const relativeDir of ['..', path.join(root, 'elsewhere'), 'escape', 'src/../..']) {
      expect(await ops.makeLink(project, relativeDir, 'made', 'secret.txt', false), relativeDir).toMatchObject({ ok: false, reason: 'outside' });
    }
    expectOutsideUntouched();
  });

  it('readFile refuses a file outside the project, and a file under a folder link leading out', async () => {
    for (const source of escapes()) {
      expect(await ops.readFile(project, source), source).toMatchObject({ ok: false, reason: 'outside' });
    }
  });

  it('walk refuses a path outside the project, and walking a folder link lists the link and nothing behind it', async () => {
    for (const source of escapes()) {
      const walk = ops.walk(project, source)[Symbol.asyncIterator]();
      await expect(walk.next(), source).rejects.toThrow(/outside/);
    }
    const entries = await walked('escape');
    expect(entries.map((entry) => [entry.relativePath, entry.kind])).toEqual([['', 'link']]);
    expect(entries[0]!.size).toBe(0);
  });

  it('walk lists a link to an outside file as a link of size 0 and never reads it', async () => {
    fs.symlinkSync(outside(), at('src/deep/passwd'), 'file');
    const entries = await walked('src');
    expect(entries.find((entry) => entry.relativePath === 'deep/passwd')).toMatchObject({ kind: 'link', size: 0, linkTarget: outside() });
    expect(entries.filter((entry) => entry.relativePath.startsWith('escape'))).toEqual([]);
  });

  it('removeFolder never removes a folder link or what it leads to', async () => {
    const entries = await walked('escape');
    expect(await ops.removeFolder(project, 'escape', entries[0]!.identity)).toMatchObject({ ok: false, reason: 'notFolder' });
    fs.rmSync(path.join(root, 'elsewhere', 'secret.txt'));
    const [inner] = await walked('escape');
    expect(await ops.removeFolder(project, 'escape', inner!.identity)).toMatchObject({ ok: false });
    expect(fs.existsSync(path.join(root, 'elsewhere'))).toBe(true);
    expect(fs.lstatSync(at('escape')).isSymbolicLink()).toBe(true);
  });
});

describe('names are checked on the host for the host\'s platform', () => {
  const everywhere = ['..', '.', '', '../../escaped.txt', 'a/b', 'a\\b', 'x\0y', ' lead', 'trail '];
  const windowsOnly = ['CON', 'nul.txt', 'COM1', 'lpt1.log', 'a:b', 'trail.', 'pipe|name'];

  it.each([['linux' as const, everywhere], ['darwin' as const, everywhere], ['win32' as const, [...everywhere, ...windowsOnly]]])('a %s host refuses each name for every operation that names an entry', async (platform, names) => {
    const host = createTransferOps({ platform, log: () => undefined });
    for (const name of names) {
      expect(await host.receiveFile(project, 'src/deep', name, bytes('x'), { mode: 0o644, mtimeMs: MTIME, replace: true, size: 1 }), name).toEqual({ ok: false, reason: 'invalidName' });
      expect(await host.copy(project, 'src/a.ts', project, 'src/deep', name, true), name).toEqual({ ok: false, reason: 'invalidName' });
      expect(await host.move(project, 'src/a.ts', project, 'src/deep', name, true), name).toEqual({ ok: false, reason: 'invalidName' });
      expect(await host.makeFolder(project, 'src/deep', name), name).toEqual({ ok: false, reason: 'invalidName' });
      if (platform !== 'win32') expect(await host.makeLink(project, 'src/deep', name, 'a.ts', true), name).toEqual({ ok: false, reason: 'invalidName' });
    }
    expect(fs.readFileSync(at('src/a.ts'), 'utf8')).toBe('inside');
    expect(fs.readdirSync(at('src/deep'))).toEqual([]);
    expect(fs.readdirSync(project.fsPath).sort()).toEqual(['escape', 'lib', 'src']);
    expectOutsideUntouched();
  });

  it('a POSIX host accepts the names only Windows refuses', async () => {
    const linux = createTransferOps({ platform: 'linux', log: () => undefined });
    for (const name of posix ? ['CON', 'a:b', 'trail.'] : ['legit name.txt']) {
      expect(await linux.makeFolder(project, 'src/deep', name), name).toEqual({ ok: true });
    }
  });
});

describe('a destination that is a link is replaced as a link, never written through', () => {
  beforeEach(() => {
    fs.symlinkSync(outside(), at('src/linked.txt'), 'file');
    fs.symlinkSync(path.join(root, 'planted.txt'), at('src/dangling.txt'), 'file');
  });

  it('receiveFile with replace swaps the link for the file and leaves its target alone', async () => {
    expect(await receive('src', 'linked.txt', 'new', true)).toEqual({ ok: true });
    expect(fs.lstatSync(at('src/linked.txt')).isFile()).toBe(true);
    expect(fs.readFileSync(at('src/linked.txt'), 'utf8')).toBe('new');
    expectOutsideUntouched();
  });

  it('receiveFile without replace finds a link, dangling or not, taken, and creates nothing where it points', async () => {
    expect(await receive('src', 'linked.txt', 'new', false)).toEqual({ ok: false, reason: 'exists' });
    expect(await receive('src', 'dangling.txt', 'new', false)).toEqual({ ok: false, reason: 'exists' });
    expect(fs.lstatSync(at('src/dangling.txt')).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(at('src')).filter(isPartName)).toEqual([]);
    expectOutsideUntouched();
  });

  it('copy and move with replace swap the link and leave its target alone', async () => {
    expect(await ops.copy(project, 'src/a.ts', project, 'src', 'linked.txt', true)).toEqual({ ok: true });
    expect(fs.lstatSync(at('src/linked.txt')).isFile()).toBe(true);
    expect(await ops.copy(project, 'src/a.ts', project, 'src', 'dangling.txt', false)).toEqual({ ok: false, reason: 'exists' });
    fs.writeFileSync(at('lib/b.ts'), 'moved');
    expect(await ops.move(project, 'lib/b.ts', project, 'src', 'dangling.txt', true)).toEqual({ ok: true, left: [] });
    expect(fs.lstatSync(at('src/dangling.txt')).isFile()).toBe(true);
    expect(fs.readFileSync(at('src/dangling.txt'), 'utf8')).toBe('moved');
    expectOutsideUntouched();
  });

  it('move of a link moves the link itself, never the file it leads to', async () => {
    expect(await ops.move(project, 'src/linked.txt', project, 'lib', 'linked.txt', false)).toEqual({ ok: true, left: [] });
    expect(fs.lstatSync(at('lib/linked.txt')).isSymbolicLink()).toBe(true);
    expectOutsideUntouched();
  });

  it.each([['an outside file', 'outside.txt'], ['a missing outside path', 'planted.txt']])('a part name planted as a link to %s is never written through', async (_what, leadsTo) => {
    const fixed = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    vi.mocked(crypto.randomBytes).mockImplementationOnce((() => fixed) as unknown as typeof crypto.randomBytes);
    fs.symlinkSync(path.join(root, leadsTo), at('src/.got.txt.damocles-deadbeef.part'), 'file');
    const result = await receive('src', 'got.txt', 'attacker bytes', false);
    expect(result).toMatchObject({ ok: false });
    expect(fs.existsSync(at('src/got.txt'))).toBe(false);
    expectOutsideUntouched();
  });
});

describe('a racing local process cannot redirect a read or a copy outside the project', () => {
  it('readFile refuses a file swapped for a link after its check', async () => {
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (target: fs.PathLike, flags?: string | number) => {
      if (String(target) === at('src/a.ts') && flags === 'r') {
        fs.rmSync(at('src/a.ts'));
        fs.symlinkSync(outside(), at('src/a.ts'), 'file');
      }
      return open(target, flags);
    }) as typeof fs.promises.open);
    expect(await ops.readFile(project, 'src/a.ts')).toMatchObject({ ok: false, reason: 'failed', code: 'ECHANGED' });
  });

  it('copy refuses a source swapped for a link after its check, and leaves no copy of what it led to', async () => {
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
      if (String(file) === at('src/a.ts') && fs.lstatSync(at('src/a.ts')).isFile()) {
        fs.rmSync(at('src/a.ts'));
        fs.symlinkSync(outside(), at('src/a.ts'), 'file');
      }
      return open(file, flags, mode);
    });
    expect(await ops.copy(project, 'src/a.ts', project, 'lib', 'a.ts', false)).toMatchObject({ ok: false });
    expect(fs.readdirSync(at('lib'))).toEqual([]);
  });
});

describe('the stale part sweep', () => {
  const twoDaysAgo = (): Date => new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  it('never removes a link named as a part, nor what it leads to, nor a part in another folder', async () => {
    const link = at('src/.a.ts.damocles-0123abcd.part');
    fs.symlinkSync(outside(), link, 'file');
    fs.lutimesSync(link, twoDaysAgo(), twoDaysAgo());
    const nested = at('src/deep/.b.ts.damocles-0123abcd.part');
    fs.writeFileSync(nested, 'nested');
    fs.utimesSync(nested, twoDaysAgo(), twoDaysAgo());
    expect(await receive('src', 'b.ts', 'x', false)).toEqual({ ok: true });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(nested)).toBe(true);
    expectOutsideUntouched();
  });
});

describe.runIf(posix)('modes: setuid, setgid and sticky never cross', () => {
  // the umask in force, as an exclusive create applies it
  const umask = (): number => {
    fs.writeFileSync(at('probe'), '', { mode: 0o777 });
    const mode = fs.statSync(at('probe')).mode & 0o777;
    fs.rmSync(at('probe'));
    return 0o777 & ~mode;
  };

  it.each([0o4755, 0o2755, 0o1755, 0o7777])('copy on the host of a file with mode %o keeps only its permission bits, under the umask', async (mode) => {
    fs.chmodSync(at('src/a.ts'), mode);
    const before = fs.statSync(at('src/a.ts')).mode & 0o7777;
    // the bits the OS let this user set; at least one of setuid, setgid or sticky must be among them for the case to mean anything
    expect(before & 0o7000).not.toBe(0);
    expect(await ops.copy(project, 'src/a.ts', project, 'lib', 'a.ts', false)).toEqual({ ok: true });
    expect(fs.statSync(at('lib/a.ts')).mode & 0o7777).toBe(mode & 0o777 & ~umask());
  });

  it('a move across file systems keeps only the permission bits, under the umask', async () => {
    fs.chmodSync(at('src/a.ts'), 0o4750);
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === at('src/a.ts')) throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
      return rename(from, to);
    });
    expect(await ops.move(project, 'src/a.ts', project, 'lib', 'a.ts', false)).toEqual({ ok: true, left: [] });
    expect(fs.statSync(at('lib/a.ts')).mode & 0o7777).toBe(0o750 & ~umask());
    expect(fs.existsSync(at('src/a.ts'))).toBe(false);
  });
});
