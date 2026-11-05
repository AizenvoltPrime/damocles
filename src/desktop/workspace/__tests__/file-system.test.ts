import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import type { Project } from '../../local-services/confine';
import { createFileSystem, WriteRefusedError, type WorkspaceFileSystem } from '../file-system';
import { namePrefixMatches } from '../outside-listing';

let root: string;
let project: Project;
let files: WorkspaceFileSystem;
const logged: string[] = [];

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-workspace-files-')));
  const projectDir = path.join(root, 'proj');
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'src', 'a.ts'), 'old text');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');
  project = { key: folderKey(projectDir), fsPath: projectDir, name: 'proj' };
  logged.length = 0;
  files = createFileSystem({ watchers: createFakePlatform().fileWatchers, trash: async () => undefined, damoclesHome: path.join(root, 'home', '.damocles'), log: (line) => logged.push(line) });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const located = (relativePath: string) => ({ path: path.join(project.fsPath, ...relativePath.split('/')), projectKey: project.key, relativePath });

describe('confinement through the workspace files', () => {
  it('refuses an absolute path, a parent escape, and on Windows a UNC path, a device name or a drive-relative path, before any file system call', async () => {
    const realpath = vi.spyOn(fs.promises, 'realpath');
    const lstat = vi.spyOn(fs.promises, 'lstat');
    const windowsOnly = process.platform === 'win32' ? ['\\\\server\\share\\a.ts', '//server/share/a.ts', 'src/CON', 'src/nul.txt', 'C:a.ts', 'src/a.ts:stream'] : [];
    for (const relativePath of [...windowsOnly, '../outside.txt', 'src/../../outside.txt', path.join(root, 'outside.txt')]) {
      expect(await files.confineExisting(project, relativePath), relativePath).toEqual({ ok: false, reason: 'outside' });
      expect(await files.entry(project, relativePath), relativePath).toEqual({ ok: false, reason: 'outside' });
    }
    expect(realpath).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
  });

  it('confines an existing file to its real path and a missing one under its deepest existing folder', async () => {
    expect(await files.confineExisting(project, 'src/a.ts')).toEqual({ ok: true, path: path.join(project.fsPath, 'src', 'a.ts') });
    expect(await files.confineExisting(project, 'src/gone.ts')).toEqual({ ok: false, reason: 'missing' });
    expect(await files.confineMissing(project, 'src/new/b.ts')).toEqual({ ok: true, path: path.join(project.fsPath, 'src', 'new', 'b.ts') });
  });
});

describe('the in-place save', () => {
  it('writes the confined file in place, so a hardlink and the mode stay', async () => {
    const file = path.join(project.fsPath, 'src', 'a.ts');
    const link = path.join(root, 'hardlink.ts');
    fs.linkSync(file, link);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o640);
    const before = fs.statSync(file, { bigint: true });
    await files.writeInPlace(project, located('src/a.ts'), Buffer.from('new'));
    const after = fs.statSync(file, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(fs.readFileSync(link, 'utf8')).toBe('new');
    if (process.platform !== 'win32') expect(after.mode & 0o777n).toBe(0o640n);
  });

  it('refuses a file another one replaced between the identity check and the open, and leaves the newcomer alone', async () => {
    const file = path.join(project.fsPath, 'src', 'a.ts');
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (target: fs.PathLike, flags?: string | number) => {
      if (flags === 'r+') {
        fs.writeFileSync(`${file}.new`, 'someone else');
        fs.renameSync(`${file}.new`, file);
      }
      return open(target, flags);
    }) as typeof fs.promises.open);
    const write = files.writeInPlace(project, located('src/a.ts'), Buffer.from('mine'));
    await expect(write).rejects.toBeInstanceOf(WriteRefusedError);
    await expect(write).rejects.toMatchObject({ refusal: 'replaced' });
    expect(fs.readFileSync(file, 'utf8')).toBe('someone else');
  });

  it('refuses a path that no longer names the file the editor opened', async () => {
    fs.writeFileSync(path.join(project.fsPath, 'src', 'b.ts'), 'b');
    await expect(files.writeInPlace(project, { ...located('src/a.ts'), path: path.join(project.fsPath, 'src', 'b.ts') }, Buffer.from('x'))).rejects.toMatchObject({ refusal: 'outsideFile' });
    expect(fs.readFileSync(path.join(project.fsPath, 'src', 'b.ts'), 'utf8')).toBe('b');
  });

  it('creates a missing file exclusively, with any folder deleted with it', async () => {
    await files.writeInPlace(project, located('gone/deeper/c.ts'), Buffer.from('back'));
    expect(fs.readFileSync(path.join(project.fsPath, 'gone', 'deeper', 'c.ts'), 'utf8')).toBe('back');
  });
});

describe('the host\'s own settings file', () => {
  let home: string;
  let settings: string;
  const text = (read: Awaited<ReturnType<WorkspaceFileSystem['readHostSettings']>>['read']): string | undefined => (read.kind === 'bytes' ? read.bytes.toString('utf8') : undefined);

  beforeEach(() => {
    home = path.join(root, 'home', '.damocles');
    settings = path.join(home, 'settings.json');
    fs.mkdirSync(home, { recursive: true });
  });

  it('reads ~/.damocles/settings.json and writes it in place, creating it when missing', async () => {
    expect(await files.readHostSettings()).toEqual({ path: settings, read: { kind: 'missing' } });
    await files.writeHostSettings(Buffer.from('{}'));
    const created = fs.statSync(settings, { bigint: true }).ino;
    await files.writeHostSettings(Buffer.from('{ "damocles.maxBudgetUsd": 3 }'));
    expect(fs.statSync(settings, { bigint: true }).ino).toBe(created);
    const read = await files.readHostSettings();
    expect(read.path).toBe(settings);
    expect(text(read.read)).toBe('{ "damocles.maxBudgetUsd": 3 }');
  });

  it('refuses a settings.json that links to any other file, outside ~/.damocles or beside it', async () => {
    const outsideFile = path.join(root, 'outside.txt');
    fs.symlinkSync(outsideFile, settings, 'file');
    expect((await files.readHostSettings()).read).toEqual({ kind: 'outside' });
    await expect(files.writeHostSettings(Buffer.from('{}'))).rejects.toMatchObject({ refusal: 'outsideProject' });
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('outside');

    fs.rmSync(settings);
    const mcp = path.join(home, 'mcp.json');
    fs.writeFileSync(mcp, '{ "mcpServers": {} }');
    fs.symlinkSync(mcp, settings, 'file');
    expect((await files.readHostSettings()).read).toEqual({ kind: 'outside' });
    await expect(files.writeHostSettings(Buffer.from('{}'))).rejects.toMatchObject({ refusal: 'outsideFile' });
    expect(fs.readFileSync(mcp, 'utf8')).toBe('{ "mcpServers": {} }');
  });

  it('names the file in the real ~/.damocles when that folder is itself a link', async () => {
    fs.rmSync(home, { recursive: true });
    const real = path.join(root, 'dotfiles', 'damocles');
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, home, 'junction');
    await files.writeHostSettings(Buffer.from('{}'));
    expect(fs.readFileSync(path.join(real, 'settings.json'), 'utf8')).toBe('{}');
    expect((await files.readHostSettings()).path).toBe(path.join(real, 'settings.json'));
  });
});

describe('the folder browser', () => {
  it('offers a folder a link leads to, as a ~/work link would be, and neither a file nor a link that leads nowhere', async () => {
    fs.symlinkSync(project.fsPath, path.join(root, 'linked'), 'junction');
    const gone = path.join(root, 'gone');
    fs.mkdirSync(gone);
    fs.symlinkSync(gone, path.join(root, 'dangling'), 'junction');
    fs.rmSync(gone, { recursive: true });
    const listed = await files.browse(root);
    if (!listed.ok) throw new Error(listed.reason);
    expect([...listed.folders].sort()).toEqual(['linked', 'proj']);
  });

  it.runIf(process.platform === 'win32')('leaves out a link to a share without a stat', async () => {
    fs.symlinkSync(project.fsPath, path.join(root, 'share'), 'junction');
    const readlink = fs.promises.readlink.bind(fs.promises);
    vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) => (String(file) === path.join(root, 'share') ? '\\\\server\\share' : readlink(file))) as typeof fs.promises.readlink);
    const stat = vi.spyOn(fs.promises, 'stat');
    const listed = await files.browse(root);
    if (!listed.ok) throw new Error(listed.reason);
    expect(listed.folders).toEqual(['proj']);
    expect(stat.mock.calls.map(([file]) => String(file))).not.toContain(path.join(root, 'share'));
  });
});

type FakeKind = 'file' | 'dir' | 'fifo';

const fakeEntry = (kind: FakeKind) => ({ isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => false, isFIFO: () => kind === 'fifo' });

// readdir lists extra's names before folder's own entries, typed as extra names them when asked for types, and lstat types each
// the same way.
function withNames(folder: string, extra: ReadonlyArray<readonly [Buffer, FakeKind]>): void {
  const readdir = fs.promises.readdir.bind(fs.promises) as (target: fs.PathLike, options: unknown) => Promise<unknown[]>;
  vi.spyOn(fs.promises, 'readdir').mockImplementation((async (target: fs.PathLike, options: unknown) => {
    const typed = (options as { withFileTypes?: boolean } | undefined)?.withFileTypes === true;
    return [...extra.map(([name, kind]) => (typed ? { name, ...fakeEntry(kind) } : name)), ...(await readdir(target, options))];
  }) as unknown as typeof fs.promises.readdir);
  const kinds = new Map(extra.map(([name, kind]) => [path.join(folder, name.toString('utf8')), kind]));
  const lstat = fs.promises.lstat.bind(fs.promises);
  vi.spyOn(fs.promises, 'lstat').mockImplementation((async (target: fs.PathLike, options?: fs.StatOptions) => {
    const kind = kinds.get(String(target));
    if (kind === undefined) return lstat(target, options);
    return fakeEntry(kind) as fs.Stats;
  }) as typeof fs.promises.lstat);
}

describe('the listing of a typed folder outside every project', () => {
  let folder: string;

  beforeEach(() => {
    folder = path.join(root, 'docs');
    fs.mkdirSync(path.join(folder, 'Sub'), { recursive: true });
    for (const name of ['.hidden', 'a.txt', 'Ab.txt', 'b.txt']) fs.writeFileSync(path.join(folder, name), '');
  });

  const sorted = (listing: Awaited<ReturnType<WorkspaceFileSystem['listOutside']>>) => (listing.kind === 'folder' ? { ...listing, entries: [...listing.entries].sort((a, b) => (a.name < b.name ? -1 : 1)) } : listing);

  it('lists hidden entries and links as what they lead to, a link to a file with its realpath, and skips a link that leads nowhere', async () => {
    fs.symlinkSync(path.join(folder, 'Sub'), path.join(folder, 'to-sub'), 'junction');
    fs.symlinkSync(path.join(root, 'outside.txt'), path.join(folder, 'to-file'), 'file');
    const gone = path.join(root, 'gone');
    fs.mkdirSync(gone);
    fs.symlinkSync(gone, path.join(folder, 'dangling'), 'junction');
    fs.rmSync(gone, { recursive: true });
    expect(sorted(await files.listOutside(`${folder}${path.sep}`, ''))).toEqual({
      kind: 'folder',
      path: folder,
      entries: [
        { name: '.hidden', kind: 'file', link: false },
        { name: 'Ab.txt', kind: 'file', link: false },
        { name: 'Sub', kind: 'dir', link: false },
        { name: 'a.txt', kind: 'file', link: false },
        { name: 'b.txt', kind: 'file', link: false },
        { name: 'to-file', kind: 'file', link: true, target: path.join(root, 'outside.txt') },
        { name: 'to-sub', kind: 'dir', link: true },
      ],
      truncated: false,
    });
  });

  it.runIf(process.platform === 'win32')('types each entry from the folder read on Windows, so a file that refuses an lstat (pagefile.sys) is listed', async () => {
    const real = fs.promises.lstat.bind(fs.promises);
    const lstat = vi.spyOn(fs.promises, 'lstat').mockImplementation((async (target: fs.PathLike, options?: fs.StatOptions) => {
      if (path.dirname(String(target)) !== folder) return real(target, options);
      throw Object.assign(new Error(`EPERM: operation not permitted, lstat '${String(target)}'`), { code: 'EPERM' });
    }) as typeof fs.promises.lstat);
    expect(sorted(await files.listOutside(folder, ''))).toMatchObject({ kind: 'folder', entries: [{ name: '.hidden' }, { name: 'Ab.txt' }, { name: 'Sub', kind: 'dir' }, { name: 'a.txt' }, { name: 'b.txt', kind: 'file' }] });
    expect(lstat.mock.calls.map(([target]) => String(target)).filter((target) => target.startsWith(`${folder}${path.sep}`))).toEqual([]);
  });

  it('leaves out a link that cannot be followed for any reason, and lists the rest, as the folder browser does', async () => {
    fs.symlinkSync(path.join(folder, 'Sub'), path.join(folder, 'b-mount'), 'junction');
    const stat = fs.promises.stat.bind(fs.promises);
    // a link into a dead FUSE mount
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (target: fs.PathLike, options?: fs.StatOptions) => {
      if (String(target) === path.join(folder, 'b-mount')) throw Object.assign(new Error('ENOTCONN: socket is not connected'), { code: 'ENOTCONN' });
      return stat(target, options);
    }) as typeof fs.promises.stat);
    expect(await files.listOutside(folder, 'b')).toEqual({ kind: 'folder', path: folder, entries: [{ name: 'b.txt', kind: 'file', link: false }], truncated: false });
    expect(await files.browse(folder)).toEqual({ ok: true, path: folder, folders: ['Sub'] });
  });

  it.runIf(process.platform === 'win32')('leaves out a link to a folder whose realpath is a share', async () => {
    const link = path.join(folder, 'mapped');
    fs.symlinkSync(path.join(folder, 'Sub'), link, 'junction');
    const realpath = fs.promises.realpath.bind(fs.promises);
    vi.spyOn(fs.promises, 'realpath').mockImplementation((async (target: fs.PathLike) => (String(target) === link ? '\\\\server\\share\\sub' : realpath(target))) as typeof fs.promises.realpath);
    expect(await files.listOutside(folder, 'm')).toEqual({ kind: 'folder', path: folder, entries: [], truncated: false });
  });

  it('answers missing for a folder path that loops or runs past the system\'s length', async () => {
    for (const code of ['ELOOP', 'ENAMETOOLONG']) {
      vi.spyOn(fs.promises, 'realpath').mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      expect(await files.listOutside(folder, ''), code).toEqual({ kind: 'missing' });
    }
  });

  it('folds a Greek name one character at a time, final sigma as sigma, so every shorter prefix of a match matches', async () => {
    for (const name of ['ΟΔΟΣ.txt', 'ΟΔΟΣΗΜΑΝΣΗ.txt', 'οδος.txt']) {
      for (const prefix of ['ΟΔΟΣ', 'οδοσ', 'οδος']) expect(namePrefixMatches(name, prefix), `${name} ${prefix}`).toBe(true);
    }
    for (const prefix of ['α', 'ασ', 'αστ', 'ΑΣΤ', 'αςτ']) expect(namePrefixMatches('ΑΣΤΡΟ.txt', prefix), prefix).toBe(true);
    expect(namePrefixMatches('ΑΣΤΡΟ.txt', 'αστο')).toBe(false);
    expect(namePrefixMatches('ab', 'abc')).toBe(false);
    fs.writeFileSync(path.join(folder, 'Οδός.txt'), '');
    expect(await files.listOutside(folder, 'ΟΔΌΣ')).toEqual({ kind: 'folder', path: folder, entries: [{ name: 'Οδός.txt', kind: 'file', link: false }], truncated: false });
  });

  it('keeps the names that start with the prefix, case folded', async () => {
    expect(sorted(await files.listOutside(folder, 'A'))).toEqual({ kind: 'folder', path: folder, entries: [{ name: 'Ab.txt', kind: 'file', link: false }, { name: 'a.txt', kind: 'file', link: false }], truncated: false });
    expect(await files.listOutside(folder, 'zzz')).toEqual({ kind: 'folder', path: folder, entries: [], truncated: false });
  });

  it('skips a name that is no valid UTF-8 or holds a control character, and a FIFO, socket or device', async () => {
    withNames(folder, [[Buffer.from([0x62, 0xff]), 'file'], [Buffer.from('b\u0007.txt'), 'file'], [Buffer.from('bpipe'), 'fifo']]);
    expect(await files.listOutside(folder, 'b')).toEqual({ kind: 'folder', path: folder, entries: [{ name: 'b.txt', kind: 'file', link: false }], truncated: false });
  });

  // Windows' read types every entry, which then needs no lstat
  it.skipIf(process.platform === 'win32')('skips an entry gone between the read and its lstat, and lists the rest', async () => {
    const lstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (target: fs.PathLike, options?: fs.StatOptions) => {
      if (String(target) === path.join(folder, 'a.txt')) throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      return lstat(target, options);
    }) as typeof fs.promises.lstat);
    expect(await files.listOutside(folder, 'a')).toEqual({ kind: 'folder', path: folder, entries: [{ name: 'Ab.txt', kind: 'file', link: false }], truncated: false });
  });

  // opening a FIFO parks a libuv thread until a writer appears, so the scan never opens one
  it.skipIf(process.platform === 'win32')('skips a real FIFO', async () => {
    execFileSync('mkfifo', [path.join(folder, 'bpipe')]);
    expect(await files.listOutside(folder, 'b')).toEqual({ kind: 'folder', path: folder, entries: [{ name: 'b.txt', kind: 'file', link: false }], truncated: false });
  });

  it('refuses a UNC, device or relative path, a dot segment, NUL, and on Windows a reserved name, before any file system call', async () => {
    const calls = (['realpath', 'lstat', 'stat', 'readdir', 'readlink'] as const).map((name) => vi.spyOn(fs.promises, name));
    const windowsOnly = process.platform === 'win32' ? ['\\\\server\\share\\', '//server/share/', '\\\\?\\C:\\', '\\\\.\\pipe\\', 'C:docs', '\\docs', `${folder}\\CON\\`] : [];
    for (const target of [...windowsOnly, 'docs', `${folder}${path.sep}..${path.sep}`, `${folder}\0`]) expect(await files.listOutside(target, ''), target).toEqual({ kind: 'outside' });
    for (const call of calls) expect(call).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')('asks a drive other than the system drive for its root first, and calls nothing else on it when it does not answer', async () => {
    const asked: string[] = [];
    const lstat = fs.promises.lstat.bind(fs.promises);
    // an offline mapped drive, whose calls hang for about 21 s
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (target: fs.PathLike, options?: fs.StatOptions) => {
      if (!String(target).startsWith('Q:')) return lstat(target, options);
      asked.push(String(target));
      return new Promise(() => undefined);
    }) as typeof fs.promises.lstat);
    const others = (['realpath', 'stat', 'readdir', 'readlink'] as const).map((name) => vi.spyOn(fs.promises, name));
    expect(await files.listOutside('Q:\\docs\\', '')).toEqual({ kind: 'missing' });
    await expect(files.resolveOutside('Q:\\docs\\a.txt')).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(asked).toEqual(['Q:\\']);
    for (const call of others) expect(call).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')('asks a share\'s root before a realpath under it, and takes no realpath when it does not answer', async () => {
    const asked: string[] = [];
    const lstat = fs.promises.lstat.bind(fs.promises);
    // an offline share, whose calls hang for about 21 s
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (target: fs.PathLike, options?: fs.StatOptions) => {
      if (!String(target).startsWith('\\\\offline\\')) return lstat(target, options);
      asked.push(String(target));
      return new Promise(() => undefined);
    }) as typeof fs.promises.lstat);
    const realpath = vi.spyOn(fs.promises, 'realpath');
    await expect(files.realpath('\\\\offline\\share\\proj')).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    // asked once, or not at all while other hung checks fill the probe's cap
    expect(asked.filter((target) => target !== '\\\\offline\\share\\')).toEqual([]);
    expect(realpath).not.toHaveBeenCalled();
  });

  it('answers missing, notAFolder and denied', async () => {
    expect(await files.listOutside(path.join(folder, 'gone'), '')).toEqual({ kind: 'missing' });
    expect(await files.listOutside(path.join(folder, 'a.txt', 'below'), '')).toEqual({ kind: 'missing' });
    expect(await files.listOutside(path.join(folder, 'a.txt'), '')).toEqual({ kind: 'notAFolder' });
    vi.spyOn(fs.promises, 'readdir').mockRejectedValue(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }));
    expect(await files.listOutside(folder, '')).toEqual({ kind: 'denied' });
  });

  it('stops at 1,000 kept entries and marks the listing truncated', async () => {
    withNames(folder, Array.from({ length: 1005 }, (_, index) => [Buffer.from(`f${index}`), 'file'] as const));
    const listed = await files.listOutside(folder, 'f');
    expect(listed.kind === 'folder' && [listed.entries.length, listed.truncated]).toEqual([1000, true]);
    expect(await files.listOutside(folder, 'f100')).toMatchObject({ truncated: false });
  });

  it('stops after examining 50,000 names, however few it kept', async () => {
    withNames(folder, Array.from({ length: 50_001 }, (_, index) => [Buffer.from(`n${index}`), 'file'] as const));
    expect(await files.listOutside(folder, 'a')).toEqual({ kind: 'folder', path: folder, entries: [], truncated: true });
  });

  it('stops at its 2 s deadline', async () => {
    withNames(folder, Array.from({ length: 20 }, (_, index) => [Buffer.from(`d${index}`), 'file'] as const));
    const readdir = vi.mocked(fs.promises.readdir);
    // the clock passes the deadline once the folder was read and its first batch of entries typed
    let checks = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (!readdir.mock.calls.some(([target]) => String(target) === folder) || checks++ === 0 ? 0 : 2500));
    const listed = await files.listOutside(folder, '');
    expect(listed.kind === 'folder' && [listed.entries.length, listed.truncated]).toEqual([16, true]);
  });

  it.runIf(process.platform === 'win32')('skips a link to a share without a stat', async () => {
    const link = path.join(folder, 'share');
    fs.symlinkSync(path.join(folder, 'Sub'), link, 'junction');
    const readlink = fs.promises.readlink.bind(fs.promises);
    vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) => (String(file) === link ? '\\\\server\\share' : readlink(file))) as typeof fs.promises.readlink);
    const stat = vi.spyOn(fs.promises, 'stat');
    const realpath = vi.spyOn(fs.promises, 'realpath');
    expect(await files.listOutside(folder, 's')).toEqual({ kind: 'folder', path: folder, entries: [{ name: 'Sub', kind: 'dir', link: false }], truncated: false });
    for (const call of [...stat.mock.calls, ...realpath.mock.calls]) expect(String(call[0])).not.toBe(link);
  });
});

describe('files outside every project', () => {
  let folder: string;
  let file: string;

  beforeEach(() => {
    folder = path.join(root, 'docs');
    fs.mkdirSync(folder);
    file = path.join(folder, 'notes.md');
    fs.writeFileSync(file, '# Notes\n');
  });

  it('resolves a file or a folder to its realpath and answers missing for neither', async () => {
    expect(await files.resolveOutside(path.join(root, 'outside.txt'))).toEqual({ kind: 'file', path: path.join(root, 'outside.txt') });
    expect(await files.resolveOutside(path.join(root, 'proj'))).toEqual({ kind: 'folder', path: path.join(root, 'proj') });
    expect(await files.resolveOutside(path.join(root, 'gone.txt'))).toEqual({ kind: 'missing' });
    expect(await files.resolveOutside(path.join(root, 'outside.txt', 'below'))).toEqual({ kind: 'missing' });
    fs.symlinkSync(path.join(root, 'proj'), path.join(root, 'linked'), 'junction');
    expect(await files.resolveOutside(path.join(root, 'linked', 'src', 'a.ts'))).toEqual({ kind: 'file', path: path.join(project.fsPath, 'src', 'a.ts') });
  });

  it('refuses before any file system call, as a share for a UNC or device path, and as a name for NUL, a relative or dot segment path and on Windows a drive-relative or root-relative path, a stream or a reserved name', async () => {
    const calls = (['realpath', 'lstat', 'stat', 'open', 'readlink'] as const).map((name) => vi.spyOn(fs.promises, name));
    const share = process.platform === 'win32' ? ['\\\\server\\share\\a.md', '//server/share/a.md', '\\\\?\\C:\\a.md', '\\\\.\\pipe\\a.md'] : [];
    const name = [
      ...(process.platform === 'win32' ? ['C:a.md', '\\a.md', '/a.md', `${folder}\\CON.md`, `${file}:stream`, `${folder}\\x.md.`] : []),
      `${folder}${path.sep}.${path.sep}a.md`,
      `${folder}${path.sep}..${path.sep}docs${path.sep}notes.md`,
      'a.md',
      'docs/a.md',
      `${file}\0`,
    ];
    const cases = [...share.map((target) => [target, 'share'] as const), ...name.map((target) => [target, 'name'] as const)];
    for (const [target, reason] of cases) {
      expect(await files.resolveOutside(target), target).toEqual({ kind: 'outside', reason });
      expect(await files.readOutside(target), target).toEqual({ kind: 'outside' });
      await expect(files.writeOutside(target, Buffer.from('x')), target).rejects.toMatchObject({ refusal: 'outsideFile' });
    }
    for (const call of calls) expect(call).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe('# Notes\n');
  });

  it('resolves, reads and writes a hard-linked file in place, keeping its inode, its other name and its mode', async () => {
    const hard = path.join(root, 'hard.md');
    fs.linkSync(file, hard);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o640);
    const before = fs.statSync(file, { bigint: true });
    expect(await files.resolveOutside(file)).toEqual({ kind: 'file', path: file });
    expect(typeof (await files.writeOutside(file, Buffer.from('mine')))).toBe('number');
    const after = fs.statSync(file, { bigint: true });
    expect(after.ino).toBe(before.ino);
    if (process.platform !== 'win32') expect(after.mode & 0o777n).toBe(0o640n);
    expect(fs.readFileSync(hard, 'utf8')).toBe('mine');
    const read = await files.readOutside(hard);
    expect(read.kind === 'bytes' && read.bytes.toString('utf8')).toBe('mine');
  });

  it('reads and writes a file only while its path is still its realpath', async () => {
    const read = await files.readOutside(file);
    expect(read.kind === 'bytes' && read.bytes.toString('utf8')).toBe('# Notes\n');
    const other = path.join(folder, 'other.md');
    fs.writeFileSync(other, 'other');
    fs.rmSync(file);
    fs.symlinkSync(other, file, 'file');
    expect(await files.readOutside(file)).toEqual({ kind: 'outside' });
    await expect(files.writeOutside(file, Buffer.from('mine'))).rejects.toMatchObject({ refusal: 'outsideFile' });
    expect(fs.readFileSync(other, 'utf8')).toBe('other');
  });

  it.each([['a junction', 'junction' as const], ['a directory link', 'dir' as const]])('refuses a file once a folder on its path became %s, writing nothing where it leads', async (_name, type) => {
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'notes.md'), 'elsewhere');
    fs.renameSync(folder, path.join(root, 'docs-moved'));
    fs.symlinkSync(elsewhere, folder, type);
    expect(await files.readOutside(file)).toEqual({ kind: 'outside' });
    await expect(files.writeOutside(file, Buffer.from('mine'))).rejects.toMatchObject({ refusal: 'outsideFile' });
    expect(fs.readFileSync(path.join(elsewhere, 'notes.md'), 'utf8')).toBe('elsewhere');
    // a file gone from behind the link is never created there either
    fs.rmSync(path.join(elsewhere, 'notes.md'));
    await expect(files.writeOutside(file, Buffer.from('mine'))).rejects.toMatchObject({ refusal: 'outsideFile' });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'docs-moved', 'notes.md'), 'utf8')).toBe('# Notes\n');
  });

  it('refuses a file another one replaced between the identity check and the open, and leaves the newcomer alone', async () => {
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (target: fs.PathLike, flags?: string | number) => {
      if (flags === 'r+') {
        fs.writeFileSync(`${file}.new`, 'someone else');
        fs.renameSync(`${file}.new`, file);
      }
      return open(target, flags);
    }) as typeof fs.promises.open);
    await expect(files.writeOutside(file, Buffer.from('mine'))).rejects.toMatchObject({ refusal: 'replaced' });
    expect(fs.readFileSync(file, 'utf8')).toBe('someone else');
  });

  it('refuses a file replaced by a link that leads nowhere, creating nothing where it leads', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.rmSync(file);
    fs.symlinkSync(path.join(elsewhere, 'missing.md'), file, 'file');
    const open = vi.spyOn(fs.promises, 'open');
    await expect(files.writeOutside(file, Buffer.from('mine'))).rejects.toMatchObject({ refusal: 'outsideFile' });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses a write whose path was swapped to a link, back, and to the link again around its checks', async () => {
    const elsewhere = path.join(root, 'elsewhere.md');
    fs.writeFileSync(elsewhere, 'elsewhere');
    const toLink = (): void => {
      fs.rmSync(file);
      fs.symlinkSync(elsewhere, file, 'file');
    };
    const stat = fs.promises.stat.bind(fs.promises);
    let swapped = false;
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (target: fs.PathLike, options?: fs.StatOptions) => {
      if (swapped || String(target) !== file || options?.bigint !== true) return stat(target, options);
      swapped = true;
      // the identity is the link's target, and the path is a plain file again for the realpath
      toLink();
      const linked = await stat(target, options);
      fs.rmSync(file);
      fs.writeFileSync(file, '# Notes\n');
      return linked;
    }) as typeof fs.promises.stat);
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (target: fs.PathLike, flags?: string | number) => {
      if (flags === 'r+') toLink();
      return open(target, flags);
    }) as typeof fs.promises.open);
    await expect(files.writeOutside(file, Buffer.from('mine'))).rejects.toMatchObject({ refusal: 'outsideFile' });
    expect(swapped).toBe(true);
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe('elsewhere');
  });

  it('answers missing for a file deleted before its identity stat', async () => {
    const stat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (target: fs.PathLike, options?: fs.StatOptions) => {
      if (String(target) === file && options?.bigint === true) fs.rmSync(file, { force: true });
      return stat(target, options);
    }) as typeof fs.promises.stat);
    expect(await files.readOutside(file)).toEqual({ kind: 'missing' });
  });

  describe('a read from the one handle its checks lead to', () => {
    // every handle an open returned, and whether it was closed
    let handles: Array<{ closed: boolean }>;
    // runs once, right before the read's open of file
    let beforeOpen: (() => void) | undefined;

    beforeEach(() => {
      handles = [];
      beforeOpen = undefined;
      const open = fs.promises.open.bind(fs.promises);
      vi.spyOn(fs.promises, 'open').mockImplementation((async (target: fs.PathLike, flags?: string | number) => {
        if (String(target) === file && flags === 'r' && beforeOpen) {
          const swap = beforeOpen;
          beforeOpen = undefined;
          swap();
        }
        const handle = await open(target, flags);
        const record = { closed: false };
        handles.push(record);
        const close = handle.close.bind(handle);
        handle.close = async () => {
          record.closed = true;
          await close();
        };
        return handle;
      }) as typeof fs.promises.open);
    });

    const allClosed = (): boolean => handles.every((handle) => handle.closed);

    it('reads the file through the handle it checked, closing it', async () => {
      const read = await files.readOutside(file);
      expect(read.kind === 'bytes' && read.bytes.toString('utf8')).toBe('# Notes\n');
      expect(handles).toHaveLength(1);
      expect(allClosed()).toBe(true);
    });

    it('refuses a file another one replaced between its checks and the open, returning none of the newcomer\'s text', async () => {
      beforeOpen = () => {
        fs.writeFileSync(`${file}.new`, 'someone else');
        fs.renameSync(`${file}.new`, file);
      };
      expect(await files.readOutside(file)).toEqual({ kind: 'outside' });
      expect(handles).toHaveLength(1);
      expect(allClosed()).toBe(true);
    });

    it('refuses a path swapped to a link around its identity stat, back for the realpath, and to the link again for the open', async () => {
      const elsewhere = path.join(root, 'elsewhere.md');
      fs.writeFileSync(elsewhere, 'elsewhere');
      const toLink = (): void => {
        fs.rmSync(file);
        fs.symlinkSync(elsewhere, file, 'file');
      };
      const stat = fs.promises.stat.bind(fs.promises);
      let swapped = false;
      vi.spyOn(fs.promises, 'stat').mockImplementation((async (target: fs.PathLike, options?: fs.StatOptions) => {
        if (swapped || String(target) !== file || options?.bigint !== true) return stat(target, options);
        swapped = true;
        toLink();
        const linked = await stat(target, options);
        fs.rmSync(file);
        fs.writeFileSync(file, '# Notes\n');
        return linked;
      }) as typeof fs.promises.stat);
      beforeOpen = toLink;
      expect(await files.readOutside(file)).toEqual({ kind: 'outside' });
      expect(swapped).toBe(true);
      expect(allClosed()).toBe(true);
    });

    it('opens no folder: a path that is no regular file answers before any open', async () => {
      expect(await files.readOutside(folder)).toEqual({ kind: 'notAFile', folder: true });
      expect(handles).toEqual([]);
    });

    // opening a FIFO parks a libuv thread until a writer appears
    it.skipIf(process.platform === 'win32')('resolves a FIFO as other, and reads it as no file without opening it', async () => {
      const fifo = path.join(folder, 'pipe');
      execFileSync('mkfifo', [fifo]);
      expect(await files.resolveOutside(fifo)).toEqual({ kind: 'other', path: fifo });
      expect(await files.readOutside(fifo)).toEqual({ kind: 'notAFile', folder: false });
      expect(handles).toEqual([]);
    });
  });

  it('creates a missing file exclusively, only in a folder that resolves to itself, and never a folder', async () => {
    fs.rmSync(file);
    await files.writeOutside(file, Buffer.from('# Back\n'));
    expect(fs.readFileSync(file, 'utf8')).toBe('# Back\n');
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(folder, 'sub'), 'junction');
    await expect(files.writeOutside(path.join(folder, 'sub', 'new.md'), Buffer.from('x'))).rejects.toMatchObject({ refusal: 'outsideFile' });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    await expect(files.writeOutside(path.join(folder, 'gone', 'new.md'), Buffer.from('x'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fs.existsSync(path.join(folder, 'gone'))).toBe(false);
  });
});

describe.runIf(process.platform === 'win32')('a drive path whose realpath is a share (win32)', () => {
  it('resolves as share with that realpath and the entry\'s kind, naming the share to no other call, and reads as outside', async () => {
    const file = path.join(root, 'outside.txt');
    const share = '\\\\server\\share\\outside.txt';
    // root stands for a mapped drive: the file's realpath is the share's
    const realpath = fs.promises.realpath.bind(fs.promises);
    vi.spyOn(fs.promises, 'realpath').mockImplementation((async (named: fs.PathLike) => (folderKey(String(named)) === folderKey(file) ? share : realpath(named))) as typeof fs.promises.realpath);
    const named: string[] = [];
    for (const name of ['stat', 'lstat', 'open', 'readlink'] as const) {
      const original = (fs.promises[name] as (...args: unknown[]) => Promise<unknown>).bind(fs.promises);
      vi.spyOn(fs.promises, name).mockImplementation((async (target: fs.PathLike, ...rest: unknown[]) => {
        named.push(String(target));
        return original(target, ...rest);
      }) as never);
    }
    expect(await files.resolveOutside(file)).toEqual({ kind: 'share', path: share, entry: 'file' });
    expect(await files.readOutside(file)).toEqual({ kind: 'outside' });
    expect(named.filter((target) => /^[\\/]{2}/.test(target))).toEqual([]);
  });
});

describe.runIf(process.platform === 'win32')('files outside every project behind links to UNC and device paths (win32)', () => {
  // folderKey of a link -> what readlink answers for it; a realpath or stat at or under such a link, or of a UNC or device
  // path, is recorded and throws instead of reaching the network
  let fakeTargets: Map<string, string>;
  let followed: string[];

  beforeEach(() => {
    fakeTargets = new Map();
    followed = [];
    const follows = (file: string): boolean => /^[\\/]{2}/.test(file) || [...fakeTargets.keys()].some((link) => folderKey(file).startsWith(link));
    const readlink = fs.promises.readlink.bind(fs.promises);
    vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) => fakeTargets.get(folderKey(String(file))) ?? readlink(file)) as typeof fs.promises.readlink);
    const realpath = fs.promises.realpath.bind(fs.promises);
    vi.spyOn(fs.promises, 'realpath').mockImplementation((async (file: fs.PathLike) => {
      if (follows(String(file))) {
        followed.push(String(file));
        throw new Error(`followed ${String(file)}`);
      }
      return realpath(file);
    }) as typeof fs.promises.realpath);
    const stat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (file: fs.PathLike, options?: fs.StatOptions) => {
      if (follows(String(file))) {
        followed.push(String(file));
        throw new Error(`followed ${String(file)}`);
      }
      return stat(file, options);
    }) as typeof fs.promises.stat);
  });

  it.each([['\\\\server\\share'], ['\\\\?\\UNC\\server\\share'], ['\\\\.\\pipe\\x'], ['\\??\\UNC\\server\\share'], ['D:x']])('refuses a path through a link to %j as a share, without following it', async (target) => {
    const folder = path.join(root, 'docs');
    fs.mkdirSync(path.join(root, 'real'), { recursive: true });
    fs.mkdirSync(folder, { recursive: true });
    // a real junction, which lstat sees as a link and which needs no privilege, whose readlink answers target
    const link = path.join(folder, 'share');
    fs.symlinkSync(path.join(root, 'real'), link, 'junction');
    fakeTargets.set(folderKey(link), target);
    const named = path.join(link, 'a.md');
    expect(await files.resolveOutside(named)).toEqual({ kind: 'outside', reason: 'share' });
    expect(await files.readOutside(named)).toEqual({ kind: 'outside' });
    await expect(files.writeOutside(named, Buffer.from('x'))).rejects.toMatchObject({ refusal: 'outsideFile' });
    expect(followed).toEqual([]);
  });
});

describe('the session store\'s files', () => {
  // the host's ~/.damocles/pi/agent/sessions/<dir>, as the engine of files' damoclesHome lays it out
  let sessions: string;
  let chat: string;
  let subagent: string;
  let member: string;
  let teamLog: string;

  const put = (target: string, text: string): string => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    return target;
  };
  const flagOf = (read: Awaited<ReturnType<WorkspaceFileSystem['read']>> | { readonly kind: 'outside' }): unknown => ('sessionFile' in read ? read.sessionFile : undefined);

  beforeEach(() => {
    sessions = path.join(root, 'home', '.damocles', 'pi', 'agent', 'sessions', '--work--');
    chat = put(path.join(sessions, '2026-11-04T10-00-00-000Z_s1.jsonl'), 'chat\n');
    subagent = put(path.join(sessions, 's1', 'subagents', '2026-11-04T10-00-00-000Z_agent-1.jsonl'), 'agent\n');
    member = put(path.join(sessions, 's1', 'teams', 't1', 'members', '2026-11-04T10-00-00-000Z_dev.a1.jsonl'), 'member\n');
    teamLog = put(path.join(sessions, 's1', 'teams', 't1.jsonl'), 'team\n');
  });

  it('reads a chat, subagent or team member file outside every project as a session file, a missing one too, and refuses to write any of them', async () => {
    for (const file of [chat, subagent, member]) {
      expect(flagOf(await files.readOutside(file)), file).toBe(true);
      await expect(files.writeOutside(file, Buffer.from('mine')), file).rejects.toMatchObject({ refusal: 'sessionFile' });
    }
    const missing = path.join(sessions, '2026-11-04T11-00-00-000Z_s2.jsonl');
    expect(await files.readOutside(missing)).toEqual({ kind: 'missing', sessionFile: true });
    await expect(files.writeOutside(missing, Buffer.from('mine'))).rejects.toMatchObject({ refusal: 'sessionFile' });
    expect([fs.readFileSync(chat, 'utf8'), fs.readFileSync(subagent, 'utf8'), fs.readFileSync(member, 'utf8'), fs.existsSync(missing)]).toEqual(['chat\n', 'agent\n', 'member\n', false]);
  });

  it('reads and writes any other file as an ordinary one: a team log, a file pi does not name, a session file of another home', async () => {
    const notes = put(path.join(sessions, 'notes.jsonl'), 'notes\n');
    const elsewhere = put(path.join(root, 'other', 'pi', 'agent', 'sessions', '--work--', '2026-11-04T10-00-00-000Z_s1.jsonl'), 'other\n');
    for (const file of [teamLog, notes, elsewhere]) {
      expect(flagOf(await files.readOutside(file)), file).toBeUndefined();
      expect(typeof (await files.writeOutside(file, Buffer.from('mine'))), file).toBe('number');
      expect(fs.readFileSync(file, 'utf8')).toBe('mine');
    }
  });

  it('flags a project file and refuses its in-place write by its canonical path, in a project of ~/.damocles or one a link leads into the session folder', async () => {
    const home: Project = { key: folderKey(path.join(root, 'home', '.damocles')), fsPath: path.join(root, 'home', '.damocles'), name: '.damocles' };
    const relative = 'pi/agent/sessions/--work--/2026-11-04T10-00-00-000Z_s1.jsonl';
    const confined = await files.confineExisting(home, relative);
    expect(confined).toEqual({ ok: true, path: chat });
    expect(flagOf(await files.read(chat))).toBe(true);
    await expect(files.writeInPlace(home, { path: chat, projectKey: home.key, relativePath: relative }, Buffer.from('mine'))).rejects.toMatchObject({ refusal: 'sessionFile' });
    await expect(files.writeInPlace(home, { path: path.join(sessions, '2026-11-04T11-00-00-000Z_s2.jsonl'), projectKey: home.key, relativePath: 'pi/agent/sessions/--work--/2026-11-04T11-00-00-000Z_s2.jsonl' }, Buffer.from('mine'))).rejects.toMatchObject({ refusal: 'sessionFile' });

    const linked = path.join(root, 'linked-sessions');
    fs.symlinkSync(sessions, linked, 'junction');
    const viaLink: Project = { key: folderKey(linked), fsPath: linked, name: 'linked-sessions' };
    const reached = await files.confineExisting(viaLink, path.basename(chat));
    expect(reached).toEqual({ ok: true, path: chat });
    expect(flagOf(await files.read(path.join(linked, path.basename(chat))))).toBe(true);
    await expect(files.writeInPlace(viaLink, { path: chat, projectKey: viaLink.key, relativePath: path.basename(chat) }, Buffer.from('mine'))).rejects.toMatchObject({ refusal: 'sessionFile' });

    expect(flagOf(await files.read(teamLog))).toBeUndefined();
    await files.writeInPlace(home, { path: teamLog, projectKey: home.key, relativePath: 'pi/agent/sessions/--work--/s1/teams/t1.jsonl' }, Buffer.from('mine'));
    expect([fs.readFileSync(chat, 'utf8'), fs.readFileSync(teamLog, 'utf8')]).toEqual(['chat\n', 'mine']);
  });

  it('flags a session file through a link to the home that holds it, the session root being canonical too', async () => {
    const realHome = path.join(root, 'dotfiles', 'damocles');
    fs.mkdirSync(path.dirname(realHome), { recursive: true });
    fs.renameSync(path.join(root, 'home', '.damocles'), realHome);
    fs.symlinkSync(realHome, path.join(root, 'home', '.damocles'), 'junction');
    const real = path.join(realHome, 'pi', 'agent', 'sessions', '--work--', path.basename(chat));
    expect(flagOf(await files.readOutside(real))).toBe(true);
    await expect(files.writeOutside(real, Buffer.from('mine'))).rejects.toMatchObject({ refusal: 'sessionFile' });
    expect(fs.readFileSync(real, 'utf8')).toBe('chat\n');
  });

  it.runIf(process.platform === 'win32')('flags and refuses a session file named in another case', async () => {
    const upper = chat.toUpperCase();
    expect(flagOf(await files.readOutside(upper))).toBe(true);
    await expect(files.writeOutside(upper, Buffer.from('mine'))).rejects.toMatchObject({ refusal: 'sessionFile' });
    expect(fs.readFileSync(chat, 'utf8')).toBe('chat\n');
  });
});
