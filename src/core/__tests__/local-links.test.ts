import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from 'vitest';
import { followsLocalLinksOnly, linkStaysLocalSync, networkHostsOf, networkReach, realpathOnOwnShare } from '../local-links';

// linkStaysLocalSync's lstatSync, readlinkSync and realpathSync.native go to these sync twins of the promise spies below.
const syncFs = vi.hoisted(() => ({ fake: undefined as undefined | { lstat(file: string): { isSymbolicLink(): boolean }; readlink(file: string): string; realpath(file: string): string } }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const lstatSync = ((...args: Parameters<typeof actual.lstatSync>) => (syncFs.fake ? syncFs.fake.lstat(String(args[0])) : actual.lstatSync(...args))) as typeof actual.lstatSync;
  const readlinkSync = ((...args: Parameters<typeof actual.readlinkSync>) => (syncFs.fake ? syncFs.fake.readlink(String(args[0])) : actual.readlinkSync(...args))) as typeof actual.readlinkSync;
  const native = ((...args: Parameters<typeof actual.realpathSync.native>) => (syncFs.fake ? syncFs.fake.realpath(String(args[0])) : actual.realpathSync.native(...args))) as typeof actual.realpathSync.native;
  const realpathSync = Object.assign(((...args: Parameters<typeof actual.realpathSync>) => actual.realpathSync(...args)) as typeof actual.realpathSync, { native });
  const overrides = { lstatSync, readlinkSync, realpathSync };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

// The QueryDosDeviceW answer for a drive a test maps, by name (`Q:`); a thrown Error for a failing call; any other asks Windows.
const dosDevices = vi.hoisted(() => new Map<string, string | Error>());
vi.mock('../dos-devices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dos-devices')>();
  return {
    queryDosDevice: (name: string): string | undefined => {
      const answer = dosDevices.get(name);
      if (answer instanceof Error) throw answer;
      return answer ?? actual.queryDosDevice(name);
    },
  };
});

let root: string;
// the folder every "evil" link really leads to, while its readlink answers a share
let marker: string;
// a link's identity (its folder's realpath joined with its name, lowercased) -> what readlink answers for it
let fakeTargets: Map<string, string>;
// every realpath or lstat call that named a UNC path
let uncCalls: string[];
let lstatCalls: number;

const isUnc = (file: string): boolean => /^[\\/]{2}/.test(file);

// The same link under every spelling that reaches it, so a walk naming it through another link still reads the fake.
function identity(file: string): string {
  if (isUnc(file)) return file.toLowerCase();
  try {
    return path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file)).toLowerCase();
  } catch {
    return file.toLowerCase();
  }
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-links-')));
  marker = path.join(root, 'marker');
  fs.mkdirSync(path.join(marker, 'x'), { recursive: true });
  fakeTargets = new Map();
  uncCalls = [];
  lstatCalls = 0;
  const readlink = fs.promises.readlink.bind(fs.promises);
  vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) => fakeTargets.get(identity(String(file))) ?? readlink(file)) as typeof fs.promises.readlink);
  for (const name of ['realpath', 'lstat'] as const) {
    const original = fs.promises[name].bind(fs.promises) as (file: fs.PathLike) => Promise<unknown>;
    vi.spyOn(fs.promises, name).mockImplementation((async (file: fs.PathLike) => {
      if (name === 'lstat') lstatCalls++;
      if (isUnc(String(file))) {
        uncCalls.push(String(file));
        throw new Error(`reached ${String(file)}`);
      }
      return original(file);
    }) as never);
  }
  const reached = (file: string): never => {
    uncCalls.push(file);
    throw new Error(`reached ${file}`);
  };
  syncFs.fake = {
    lstat: (file) => (isUnc(file) ? reached(file) : actualFs.lstatSync(file)),
    readlink: (file) => fakeTargets.get(identity(file)) ?? actualFs.readlinkSync(file),
    realpath: (file) => (isUnc(file) ? reached(file) : actualFs.realpathSync.native(file)),
  };
});

afterEach(() => {
  syncFs.fake = undefined;
  dosDevices.clear();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function folder(...parts: string[]): string {
  const made = path.join(root, ...parts);
  fs.mkdirSync(made, { recursive: true });
  return made;
}

function junction(at: string, target: string): void {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, 'junction');
}

// A real symlink, which needs Developer Mode or an elevated process on Windows; the test skips without either.
function symlink(ctx: TestContext, at: string, target: string): void {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  try {
    fs.symlinkSync(target, at, 'dir');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') ctx.skip();
    throw err;
  }
}

// A link the walk reads as one to \\attacker\share, which really leads to marker so Windows can be asked where it goes.
function evil(at: string): void {
  junction(at, marker);
  fakeTargets.set(identity(at), '\\\\attacker\\share');
}

// Where Windows itself opens file, following every link with its own rules.
const windowsOpens = (file: string): string => fs.realpathSync.native(file);

describe.runIf(process.platform === 'win32')('the names Windows resolves a relative link against (win32)', () => {
  it('reads a relative symlink below a junction against the junction\'s own name, as an npm workspace link gives', async (ctx) => {
    const project = folder('p');
    folder('p', 'packages', 'group', 'lib');
    fs.mkdirSync(path.join(project, 'packages', 'a'));
    fs.writeFileSync(path.join(project, 'packages', 'a', 'evil'), 'decoy');
    junction(path.join(project, 'node_modules', 'lib'), path.join(project, 'packages', 'group', 'lib'));
    symlink(ctx, path.join(project, 'packages', 'group', 'lib', 'cfg'), '..\\..\\a\\evil');
    evil(path.join(project, 'a', 'evil'));
    expect(windowsOpens(path.join(project, 'node_modules', 'lib', 'cfg'))).toBe(marker);
    expect(await followsLocalLinksOnly(project, ['node_modules', 'lib', 'cfg'])).toBe(false);
    expect(uncCalls).toEqual([]);
  });

  it('reads a relative symlink below a junction whose target runs through a symlink against that symlink\'s target', async (ctx) => {
    const project = folder('p');
    folder('p', 'r6', 'x');
    folder('p', 'w');
    symlink(ctx, path.join(project, 's6'), path.join(project, 'r6'));
    junction(path.join(project, 'j6'), path.join(project, 's6', 'x'));
    symlink(ctx, path.join(project, 'r6', 'x', 'l'), '..\\w');
    evil(path.join(project, 'r6', 'w'));
    expect(windowsOpens(path.join(project, 'j6', 'l'))).toBe(marker);
    expect(await followsLocalLinksOnly(project, ['j6', 'l'])).toBe(false);
  });

  it('reads a target climbing above a base that is a junction against the base\'s own name', async (ctx) => {
    const app = path.join(root, 'work', 'app');
    junction(app, folder('src', 'repo', 'app'));
    folder('src', 'repo', 'evil');
    symlink(ctx, path.join(root, 'src', 'repo', 'app', 'x'), '..\\evil');
    evil(path.join(root, 'work', 'evil'));
    expect(windowsOpens(path.join(app, 'x'))).toBe(marker);
    expect(await followsLocalLinksOnly(app, ['x'])).toBe(false);
  });

  it('reads a target climbing above a base that is a symlink against the base\'s target', async (ctx) => {
    const app = path.join(root, 'work', 'app');
    symlink(ctx, app, folder('src', 'repo', 'app'));
    folder('work', 'evil');
    symlink(ctx, path.join(root, 'src', 'repo', 'app', 'x'), '..\\evil');
    evil(path.join(root, 'src', 'repo', 'evil'));
    expect(windowsOpens(path.join(app, 'x'))).toBe(marker);
    expect(await followsLocalLinksOnly(app, ['x'])).toBe(false);
  });

  it('reads a target climbing above a base reached through a symlink and then a junction as Windows names it', async (ctx) => {
    const base = path.join(root, 'p', 'a', 'b');
    folder('p', 'X1', 'X2', 'x');
    folder('p', 'Y', 'y');
    folder('p', 'evil');
    symlink(ctx, path.join(root, 'p', 'a'), path.join(root, 'p', 'X1', 'X2', 'x'));
    junction(path.join(root, 'p', 'X1', 'X2', 'x', 'b'), path.join(root, 'p', 'Y', 'y'));
    symlink(ctx, path.join(root, 'p', 'Y', 'y', 'l'), '..\\..\\evil');
    evil(path.join(root, 'p', 'X1', 'X2', 'evil'));
    expect(windowsOpens(path.join(base, 'l'))).toBe(marker);
    expect(await followsLocalLinksOnly(base, ['l'])).toBe(false);
  });

  it('counts a target that climbs out and back in as climbing', async (ctx) => {
    const base = path.join(root, 'a', 'sbase');
    symlink(ctx, base, folder('r', 'inner'));
    symlink(ctx, path.join(root, 'r', 'inner', 'l3'), '..\\sbase\\x');
    evil(path.join(root, 'r', 'sbase'));
    expect(windowsOpens(path.join(base, 'l3'))).toBe(path.join(marker, 'x'));
    expect(await followsLocalLinksOnly(base, ['l3'])).toBe(false);
  });

  it('follows a climbing target that stays local under every reading, such as a monorepo link to ../shared', async (ctx) => {
    const app = path.join(root, 'work', 'app');
    junction(app, folder('src', 'repo', 'app'));
    folder('src', 'repo', 'shared');
    folder('work', 'shared');
    symlink(ctx, path.join(root, 'src', 'repo', 'app', 'lib'), '..\\shared');
    expect(await followsLocalLinksOnly(app, ['lib'])).toBe(true);
  });

  it('follows a root-relative target that stays local', async (ctx) => {
    const project = folder('p');
    const shared = folder('shared');
    symlink(ctx, path.join(project, 'top'), shared.slice(2));
    expect(await followsLocalLinksOnly(project, ['top'])).toBe(true);
  });

  it('reads a target that stays inside its link\'s folder lexically, with no realpath', async () => {
    const project = folder('p');
    folder('p', 'sub');
    junction(path.join(project, 'down'), path.join(project, 'sub'));
    expect(await followsLocalLinksOnly(project, ['down'])).toBe(true);
    expect(vi.mocked(fs.promises.realpath)).not.toHaveBeenCalled();
  });

  it('takes no realpath of a base that is its own when a target climbs above it', async (ctx) => {
    const listed = folder('p', 'listed');
    folder('p', 'shared');
    symlink(ctx, path.join(listed, 'up'), '..\\shared');
    expect(await followsLocalLinksOnly(listed, ['up'], { baseIsReal: true })).toBe(true);
    expect(vi.mocked(fs.promises.realpath)).not.toHaveBeenCalled();
  });

  it('asks the file system about each path once, however many readings pass it', async (ctx) => {
    const deep = folder('p', ...Array.from({ length: 20 }, (_, i) => `d${i}`));
    const climb = Array.from({ length: 20 }, () => '..').join('\\');
    const back = Array.from({ length: 20 }, (_, i) => `d${i}`).join('\\');
    for (let i = 0; i < 20; i++) symlink(ctx, path.join(deep, `n${i}`), `${climb}\\${back}\\n${i + 1}`);
    fs.writeFileSync(path.join(deep, 'n20'), 'end');
    expect(await followsLocalLinksOnly(path.join(root, 'p'), [...Array.from({ length: 20 }, (_, i) => `d${i}`), 'n0'])).toBe(true);
    expect(lstatCalls).toBeLessThan(100);
  });

  it('compares paths as spelled, so a link in a case-sensitive folder never hides behind a sibling differing only in case', async (ctx) => {
    const project = folder('cs');
    try {
      execFileSync(path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'fsutil.exe'), ['file', 'setCaseSensitiveInfo', project, 'enable'], { stdio: 'ignore' });
    } catch {
      ctx.skip();
    }
    folder('cs', 'a', 'x');
    evil(path.join(project, 'A'));
    symlink(ctx, path.join(project, 'a', 'l'), '..\\A\\x');
    expect(windowsOpens(path.join(project, 'a', 'l'))).toBe(path.join(marker, 'x'));
    expect(await followsLocalLinksOnly(project, ['a', 'l'])).toBe(false);
    expect(await followsLocalLinksOnly(path.join(project, 'a'), ['l'], { baseIsReal: true })).toBe(false);
  });

  it('keeps no answer a reading gave while a reading it reached was still open, which a later reading may resolve otherwise', async (ctx) => {
    const base = folder('b');
    for (const plain of [['m', 'c', 'evil'], ['d', 'r'], ['d', 'k'], ['d', 'm']]) folder('b', ...plain);
    symlink(ctx, path.join(base, 'a'), path.join(base, 'd', 'r'));
    symlink(ctx, path.join(base, 'd', 'r', 't'), '..\\k');
    symlink(ctx, path.join(base, 'k'), path.join(base, 'y'));
    symlink(ctx, path.join(base, 'y'), path.join(base, 'a', 't'));
    symlink(ctx, path.join(base, 'p1'), path.join(base, 'a', 't'));
    symlink(ctx, path.join(base, 'd', 'k', 'n'), '..\\m\\c');
    symlink(ctx, path.join(base, 'd', 'm', 'c'), path.join(base, 'y'));
    evil(path.join(base, 'd', 'k', 'evil'));
    expect(windowsOpens(path.join(base, 'p1', 'n', 'evil'))).toBe(marker);
    expect(await followsLocalLinksOnly(base, ['p1', 'n', 'evil'])).toBe(false);
  });

  it('refuses an absolute share target without reaching it', async () => {
    const project = folder('p');
    evil(path.join(project, 'unc'));
    expect(await followsLocalLinksOnly(project, ['unc', 'a.ts'])).toBe(false);
    expect(uncCalls).toEqual([]);
  });

  it('rejects as missing when every reading leads nowhere', async () => {
    const project = folder('p');
    junction(path.join(project, 'gone'), path.join(root, 'nowhere'));
    await expect(followsLocalLinksOnly(project, ['gone', 'a.ts'])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a loop as ELOOP, in the user\'s language', async () => {
    const project = folder('p');
    junction(path.join(project, 'a'), path.join(project, 'b'));
    junction(path.join(project, 'b'), path.join(project, 'a'));
    await expect(followsLocalLinksOnly(project, ['a', 'x.ts'])).rejects.toMatchObject({ code: 'ELOOP', text: { message: 'The path under {0} goes through too many links.' } });
  });
});

describe.runIf(process.platform === 'win32')('shares and drives (win32)', () => {
  // A fake file system for the paths fake names, on drives and shares that do not exist: each path is a link to its target, an
  // entry when its target is undefined, and missing when absent.
  function fakeDisk(fake: Map<string, string | undefined>, realpaths: Map<string, string> = new Map()): void {
    const lstat = vi.mocked(fs.promises.lstat);
    const realpath = vi.mocked(fs.promises.realpath);
    const lstatOf = lstat.getMockImplementation()!;
    const realpathOf = realpath.getMockImplementation()!;
    lstat.mockImplementation((async (file: fs.PathLike) => {
      const key = String(file).toLowerCase();
      if (key.startsWith(root.toLowerCase())) return lstatOf(file);
      const entry = [...fake.entries()].find(([known]) => known.toLowerCase() === key);
      if (entry === undefined) throw Object.assign(new Error(`ENOENT ${String(file)}`), { code: 'ENOENT' });
      return { isSymbolicLink: () => entry[1] !== undefined };
    }) as never);
    for (const [link, target] of fake) if (target !== undefined) fakeTargets.set(link.toLowerCase(), target);
    realpath.mockImplementation((async (file: fs.PathLike) => realpaths.get(String(file).toUpperCase()) ?? realpathOf(file)) as never);
  }

  it('follows a link to its own share when the base names the share root without a trailing separator', async () => {
    fakeDisk(new Map([['\\\\server\\share\\link', '\\\\server\\share\\real'], ['\\\\server\\share\\real', undefined], ['\\\\server\\share\\real\\a.ts', undefined]]));
    expect(await followsLocalLinksOnly('\\\\server\\share', ['link', 'a.ts'])).toBe(true);
  });

  it('reads a target climbing above a mapped drive\'s root on its share, which is the user\'s own mapping', async () => {
    const project = folder('p');
    junction(path.join(project, 'm'), marker);
    fakeTargets.set(identity(path.join(project, 'm')), 'M:\\proj\\a');
    fakeDisk(new Map([['M:\\', undefined], ['M:\\proj', undefined], ['M:\\proj\\a', '..\\..\\..\\up'], ['M:\\up', undefined], ['\\\\nas\\data\\', undefined], ['\\\\nas\\data\\up', undefined]]), new Map([['M:\\', '\\\\nas\\data\\']]));
    expect(await followsLocalLinksOnly(project, ['m'])).toBe(true);
  });

  it('rejects with ETIMEDOUT when a network drive a link leads onto does not answer, asking it once at a time', async () => {
    vi.resetModules();
    const { followsLocalLinksOnly: walk } = await import('../local-links');
    const project = folder('p');
    junction(path.join(project, 'mapped'), marker);
    fakeTargets.set(identity(path.join(project, 'mapped')), 'Q:\\data');
    dosDevices.set('Q:', String.raw`\Device\LanmanRedirector\;Q:000000000004111a\nas\data`);
    const lstat = vi.mocked(fs.promises.lstat);
    const original = lstat.getMockImplementation()!;
    const asked: string[] = [];
    lstat.mockImplementation((async (file: fs.PathLike) => {
      if (String(file) !== 'Q:\\') return original(file);
      asked.push(String(file));
      return new Promise(() => undefined);
    }) as never);
    await expect(walk(project, ['mapped', 'a.ts'])).rejects.toMatchObject({ code: 'ETIMEDOUT', text: { message: 'The drive {0} did not answer within a second.', args: ['Q:\\'] } });
    await expect(walk(project, ['mapped', 'b.ts'])).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(asked).toEqual(['Q:\\']);
  });

  it('probes a drive a link leads onto only when Windows maps it off this computer\'s volumes, or cannot say where', async () => {
    vi.resetModules();
    const { followsLocalLinksOnly: walk } = await import('../local-links');
    const project = folder('p');
    const drives: [string, string | Error][] = [
      ['K', String.raw`\Device\HarddiskVolume9`],
      ['L', `\\??\\${marker}`],
      ['N', String.raw`\Device\LanmanRedirector\;N:000000000004111a\nas\data`],
      ['O', String.raw`\??\N:\deeper`],
      ['U', new Error('QueryDosDeviceW(U:) failed with Win32 error 5')],
    ];
    for (const [letter, mapping] of drives) {
      junction(path.join(project, letter), marker);
      fakeTargets.set(identity(path.join(project, letter)), `${letter}:\\data`);
      dosDevices.set(`${letter}:`, mapping);
    }
    fakeDisk(new Map(drives.flatMap(([letter]) => [[`${letter}:\\data`, undefined], [`${letter}:\\data\\a.ts`, undefined]] as const)));
    const probed: string[] = [];
    const lstat = vi.mocked(fs.promises.lstat);
    const original = lstat.getMockImplementation()!;
    // a drive root that never answers: a probe of it costs the walk its second and rejects ETIMEDOUT
    lstat.mockImplementation((async (file: fs.PathLike) => {
      if (!/^[A-Z]:\\$/.test(String(file))) return original(file);
      probed.push(String(file));
      return new Promise(() => undefined);
    }) as never);
    // a local volume, and a subst onto a local path, are followed as the user's own mapping
    expect(await walk(project, ['K', 'a.ts'])).toBe(true);
    expect(await walk(project, ['L', 'a.ts'])).toBe(true);
    expect(probed).toEqual([]);
    // a network drive, a subst onto one, and a drive Windows cannot place must answer
    await expect(walk(project, ['N', 'a.ts'])).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await expect(walk(project, ['O', 'a.ts'])).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await expect(walk(project, ['U', 'a.ts'])).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(probed.filter((root) => !['N:\\', 'O:\\', 'U:\\'].includes(root))).toEqual([]);
  });

  it('owns only its own host and share for a base spelled as a device path, and no other device root', async () => {
    const owner = '\\\\?\\UNC\\hostA\\s\\p';
    const mupOwner = '\\\\?\\GLOBALROOT\\Device\\Mup\\hostA\\s';
    fakeDisk(new Map([
      [`${owner}\\other`, '\\\\?\\UNC\\hostB\\s\\x'],
      [`${owner}\\same`, '\\\\?\\UNC\\hostA\\s\\shared'],
      ['\\\\?\\UNC\\hostA', undefined],
      ['\\\\?\\UNC\\hostA\\s', undefined],
      ['\\\\?\\UNC\\hostA\\s\\shared', undefined],
      ['\\\\?\\UNC\\hostA\\s\\shared\\a.ts', undefined],
      [`${mupOwner}\\mup`, '\\\\?\\GLOBALROOT\\Device\\Mup\\hostB\\s'],
    ]), new Map([[owner.toUpperCase(), owner]]));
    expect(await followsLocalLinksOnly(owner, ['other', 'a.ts'])).toBe(false);
    expect(await followsLocalLinksOnly(owner, ['same', 'a.ts'])).toBe(true);
    expect(await followsLocalLinksOnly(mupOwner, ['mup', 'a.ts'])).toBe(false);
    expect(vi.mocked(fs.promises.lstat).mock.calls.map(([file]) => String(file)).filter((file) => /hostb/i.test(file))).toEqual([]);
  });

  it('counts the share Windows maps a base\'s drive to as the base\'s own, though its realpath names another server', async () => {
    dosDevices.set('M:', String.raw`\Device\LanmanRedirector\;M:000000000004111a\corp\users`);
    fakeDisk(new Map([
      ['M:\\u', undefined],
      ['M:\\u\\link', '\\\\corp\\users\\shared'],
      ['M:\\u\\fqdn', '\\\\corp.example.com\\users\\shared'],
      ['\\\\corp\\users\\shared', undefined],
      ['\\\\corp\\users\\shared\\a.ts', undefined],
    ]), new Map([['M:\\U', '\\\\fs01\\users$\\u']]));
    expect(await followsLocalLinksOnly('M:\\u', ['link', 'a.ts'])).toBe(true);
    // one server under its NetBIOS and its FQDN name is two shares to the walk
    expect(await followsLocalLinksOnly('M:\\u', ['fqdn', 'a.ts'])).toBe(false);
  });

  it('follows a link onto a share of an allowed host, or WSL\'s, only when the walk is given its hosts', async () => {
    const project = folder('p');
    junction(path.join(project, 'nas'), marker);
    fakeTargets.set(identity(path.join(project, 'nas')), '\\\\NAS\\data\\x');
    junction(path.join(project, 'wsl'), marker);
    fakeTargets.set(identity(path.join(project, 'wsl')), '\\\\wsl.localhost\\Ubuntu\\home');
    fakeDisk(new Map([['\\\\nas\\data\\', undefined], ['\\\\nas\\data\\x', undefined], ['\\\\nas\\data\\x\\a.ts', undefined],
      ['\\\\wsl.localhost\\Ubuntu\\', undefined], ['\\\\wsl.localhost\\Ubuntu\\home', undefined], ['\\\\wsl.localhost\\Ubuntu\\home\\a.ts', undefined]]));
    expect(await followsLocalLinksOnly(project, ['nas', 'a.ts'])).toBe(false);
    expect(await followsLocalLinksOnly(project, ['nas', 'a.ts'], { allowedHosts: new Set(['other']) })).toBe(false);
    expect(await followsLocalLinksOnly(project, ['nas', 'a.ts'], { allowedHosts: new Set(['nas']) })).toBe(true);
    expect(await followsLocalLinksOnly(project, ['wsl', 'a.ts'])).toBe(false);
    expect(await followsLocalLinksOnly(project, ['wsl', 'a.ts'], { allowedHosts: new Set() })).toBe(true);
  });

  // fakeDisk for linkStaysLocalSync, which walks from the drive root: paths on the drives and shares fake names answer as
  // there, any other path from the disk.
  function fakeSyncDisk(fake: Map<string, string | undefined>, realpaths: Map<string, string> = new Map()): void {
    const fakeRoots = new Set([...fake.keys()].map((known) => path.parse(path.resolve(known)).root.toLowerCase()));
    const local = syncFs.fake!;
    syncFs.fake = {
      ...local,
      lstat: (file) => {
        if (!fakeRoots.has(path.parse(path.resolve(file)).root.toLowerCase())) return local.lstat(file);
        const entry = [...fake.entries()].find(([known]) => known.toLowerCase() === file.toLowerCase());
        if (entry === undefined) throw Object.assign(new Error(`ENOENT ${file}`), { code: 'ENOENT' });
        return { isSymbolicLink: () => entry[1] !== undefined };
      },
      realpath: (file) => realpaths.get(file.toUpperCase()) ?? local.realpath(file),
    };
  }

  // The sync twin answers as the walk does for the path the walk's base and segments name.
  async function expectParity(base: string, segments: string[], expected: boolean): Promise<void> {
    expect(await followsLocalLinksOnly(base, segments)).toBe(expected);
    expect(linkStaysLocalSync(path.join(base, ...segments))).toBe(expected);
  }

  describe('linkStaysLocalSync', () => {
    it('follows a link to its own share as the walk does', async () => {
      const fake = new Map([['\\\\server\\share\\link', '\\\\server\\share\\real'], ['\\\\server\\share\\real', undefined], ['\\\\server\\share\\real\\a.ts', undefined]]);
      fakeDisk(fake);
      fakeSyncDisk(fake);
      await expectParity('\\\\server\\share', ['link', 'a.ts'], true);
    });

    it('reads a target climbing above a mapped drive\'s root on its share as the walk does', async () => {
      const project = folder('p');
      junction(path.join(project, 'm'), marker);
      fakeTargets.set(identity(path.join(project, 'm')), 'M:\\proj\\a');
      const fake = new Map([['M:\\', undefined], ['M:\\proj', undefined], ['M:\\proj\\a', '..\\..\\..\\up'], ['M:\\up', undefined], ['\\\\nas\\data\\', undefined], ['\\\\nas\\data\\up', undefined]]);
      const realpaths = new Map([['M:\\', '\\\\nas\\data\\']]);
      fakeDisk(fake, realpaths);
      fakeSyncDisk(fake, realpaths);
      const asked: string[] = [];
      const { lstat } = syncFs.fake!;
      syncFs.fake = { ...syncFs.fake!, lstat: (file) => (asked.push(file), lstat(file)) };
      await expectParity(project, ['m'], true);
      expect(asked).toEqual(expect.arrayContaining(['M:\\up', '\\\\nas\\data\\up']));
    });

    it('refuses a link onto a share of another host, and onto WSL, as the walk without allowedHosts does, never reaching either', async () => {
      const project = folder('p');
      junction(path.join(project, 'nas'), marker);
      fakeTargets.set(identity(path.join(project, 'nas')), '\\\\NAS\\data\\x');
      junction(path.join(project, 'wsl'), marker);
      fakeTargets.set(identity(path.join(project, 'wsl')), '\\\\wsl.localhost\\Ubuntu\\home');
      evil(path.join(project, 'unc'));
      await expectParity(project, ['nas', 'a.ts'], false);
      await expectParity(project, ['wsl', 'a.ts'], false);
      await expectParity(project, ['unc', 'a.ts'], false);
      expect(uncCalls).toEqual([]);
    });

    it('follows a link onto another drive without asking whether the drive answers', () => {
      const project = folder('p');
      junction(path.join(project, 'mapped'), marker);
      fakeTargets.set(identity(path.join(project, 'mapped')), 'Q:\\data');
      const asked: string[] = [];
      fakeSyncDisk(new Map([['Q:\\data', undefined], ['Q:\\data\\a.ts', undefined]]));
      const { lstat } = syncFs.fake!;
      syncFs.fake = { ...syncFs.fake!, lstat: (file) => (asked.push(file), lstat(file)) };
      expect(linkStaysLocalSync(path.join(project, 'mapped', 'a.ts'))).toBe(true);
      expect(asked.filter((file) => file.toUpperCase().startsWith('Q:'))).toEqual(['Q:\\data', 'Q:\\data\\a.ts']);
    });

    it('reads a relative symlink below a junction against the junction\'s own name, as the walk does', async (ctx) => {
      const project = folder('p');
      folder('p', 'packages', 'group', 'lib');
      fs.mkdirSync(path.join(project, 'packages', 'a'));
      junction(path.join(project, 'node_modules', 'lib'), path.join(project, 'packages', 'group', 'lib'));
      symlink(ctx, path.join(project, 'packages', 'group', 'lib', 'cfg'), '..\\..\\a\\evil');
      evil(path.join(project, 'a', 'evil'));
      await expectParity(project, ['node_modules', 'lib', 'cfg'], false);
      expect(uncCalls).toEqual([]);
    });

    it('answers true for a broken link, which the caller\'s stat reports, and false for a loop', () => {
      const project = folder('p');
      junction(path.join(project, 'gone'), path.join(root, 'nowhere'));
      junction(path.join(project, 'a'), path.join(project, 'b'));
      junction(path.join(project, 'b'), path.join(project, 'a'));
      expect(linkStaysLocalSync(path.join(project, 'gone', 'a.ts'))).toBe(true);
      expect(linkStaysLocalSync(path.join(project, 'a', 'x.ts'))).toBe(false);
    });
  });

  it('places a path off this computer\'s drives by its spelling without reaching it, or by a link on its walk', async () => {
    const project = folder('p');
    evil(path.join(project, 'unc'));
    fs.writeFileSync(path.join(project, 'a.ts'), '');
    // walked from the drive root, which fakeDisk would hide
    expect(await networkReach(path.join(project, 'unc', 'a.ts'), new Set(['nas']))).not.toBeNull();
    expect(await networkReach(path.join(project, 'a.ts'), new Set())).toBeNull();
    expect(await networkReach(path.join(project, 'missing', 'a.ts'), new Set())).toBeNull();
    for (const spelled of ['\\\\evil\\s\\x', '//evil/s/x', '\\\\?\\UNC\\evil\\s\\x', '\\\\evil@SSL\\s\\x', '\\\\?\\C:\\x', '\\\\.\\pipe\\x']) {
      expect(await networkReach(spelled, new Set(['nas']))).not.toBeNull();
    }
    expect(uncCalls).toEqual([]);
    fakeDisk(new Map([['\\\\nas\\proj\\', undefined], ['\\\\nas\\proj\\a.ts', undefined], ['\\\\wsl$\\Ubuntu\\', undefined], ['\\\\wsl$\\Ubuntu\\a.ts', undefined]]));
    expect(await networkReach('\\\\nas\\proj\\a.ts', new Set(['nas']))).toBeNull();
    expect(await networkReach('\\\\wsl$\\Ubuntu\\a.ts', new Set())).toBeNull();
  });

  it('names the host a path reaches by its spelling, or by the target of the link on its walk, and marks a reach it cannot place', async () => {
    const project = folder('p');
    evil(path.join(project, 'unc'));
    junction(path.join(project, 'nt'), marker);
    fakeTargets.set(identity(path.join(project, 'nt')), '\\??\\UNC\\NAS\\data');
    junction(path.join(project, 'volume'), marker);
    fakeTargets.set(identity(path.join(project, 'volume')), '\\\\?\\Volume{0b1c}\\x');
    junction(path.join(project, 'mup'), marker);
    fakeTargets.set(identity(path.join(project, 'mup')), '\\\\?\\GLOBALROOT\\Device\\Mup\\evil\\s');
    // CreateSymbolicLinkW stores a \\?\ target as \??\, which readlink returns unchanged
    junction(path.join(project, 'nt-mup'), marker);
    fakeTargets.set(identity(path.join(project, 'nt-mup')), '\\??\\GLOBALROOT\\Device\\Mup\\evil\\s');
    fs.writeFileSync(path.join(project, 'a.ts'), '');
    expect(await networkReach('\\\\FileServer\\share\\a.txt', new Set(['nas']))).toEqual({ hosts: ['fileserver'], unplaced: false });
    expect(await networkReach('\\\\?\\UNC\\evil\\s\\x', new Set())).toEqual({ hosts: ['evil'], unplaced: false });
    expect(await networkReach('\\\\evil@SSL\\s\\x', new Set())).toEqual({ hosts: ['evil'], unplaced: false });
    expect(await networkReach('\\\\?\\C:\\x', new Set())).toEqual({ hosts: [], unplaced: true });
    expect(await networkReach('\\\\.\\pipe\\x', new Set())).toEqual({ hosts: [], unplaced: true });
    expect(await networkReach('\\\\?\\GLOBALROOT\\Device\\Mup\\evil\\s\\y', new Set())).toEqual({ hosts: [], unplaced: true });
    expect(await networkReach(path.join(project, 'unc', 'a.ts'), new Set(['nas']))).toEqual({ hosts: ['attacker'], unplaced: false });
    expect(await networkReach(path.join(project, 'nt', 'a.ts'), new Set())).toEqual({ hosts: ['nas'], unplaced: false });
    expect(await networkReach(path.join(project, 'volume', 'a.ts'), new Set())).toEqual({ hosts: [], unplaced: true });
    expect(await networkReach(path.join(project, 'mup', 'a.ts'), new Set())).toEqual({ hosts: [], unplaced: true });
    expect(await networkReach(path.join(project, 'nt-mup', 'a.ts'), new Set())).toEqual({ hosts: [], unplaced: true });
    expect(await networkReach(path.join(project, 'a.ts'), new Set())).toBeNull();
    expect(await networkReach(path.join(project, 'missing', 'a.ts'), new Set())).toBeNull();
    expect(uncCalls).toEqual([]);
  });

  // Windows opens one reading of an ambiguous link, which the walk cannot tell, so the card names the hosts of all of them.
  it('names the host of every reading of an ambiguous link that leads off, not only the first', async (ctx) => {
    const app = path.join(root, 'work', 'app');
    junction(app, folder('src', 'repo', 'app'));
    symlink(ctx, path.join(root, 'src', 'repo', 'app', 'x'), '..\\evil');
    junction(path.join(root, 'work', 'evil'), marker);
    fakeTargets.set(identity(path.join(root, 'work', 'evil')), '\\\\attacker\\share');
    junction(path.join(root, 'src', 'repo', 'evil'), marker);
    fakeTargets.set(identity(path.join(root, 'src', 'repo', 'evil')), '\\\\other\\share');
    expect((await networkReach(path.join(app, 'x', 'a.ts'), new Set()))?.hosts).toEqual(['attacker', 'other']);
    fakeTargets.set(identity(path.join(root, 'src', 'repo', 'evil')), '\\\\?\\GLOBALROOT\\Device\\Mup\\other\\share');
    expect(await networkReach(path.join(app, 'x', 'b.ts'), new Set())).toEqual({ hosts: ['attacker'], unplaced: true });
    // a reading that leads off decides the walk even when every other reading is missing
    fs.rmdirSync(path.join(root, 'src', 'repo', 'evil'));
    expect(await networkReach(path.join(app, 'x', 'c.ts'), new Set())).toEqual({ hosts: ['attacker'], unplaced: false });
    expect(uncCalls).toEqual([]);
  });

  // Every read of a path on a drive a test maps: none may happen before the drive is placed.
  const driveReads = (letter: string): string[] =>
    [...vi.mocked(fs.promises.lstat).mock.calls, ...vi.mocked(fs.promises.realpath).mock.calls].map(([file]) => String(file)).filter((file) => file.toUpperCase().startsWith(`${letter}:`));

  it('places a mapped network drive where Windows maps it, before touching any path on it', async () => {
    dosDevices.set('Q:', String.raw`\Device\LanmanRedirector\;Q:000000000004111a\Evil\data\sub`);
    expect(await networkReach('Q:\\x\\a.ts', new Set(['nas']))).toEqual({ hosts: ['evil'], unplaced: false });
    expect(await networkReach('q:\\a.ts', new Set())).toEqual({ hosts: ['evil'], unplaced: false });
    dosDevices.set('Q:', String.raw`\Device\WebDavRedirector\;Q:0\evil@SSL@8443\DavWWWRoot`);
    expect(await networkReach('Q:\\a.ts', new Set())).toEqual({ hosts: ['evil'], unplaced: false });
    dosDevices.set('Q:', String.raw`\Device\LanmanRedirector\;Q:000000000004111a`);
    expect(await networkReach('Q:\\a.ts', new Set(['nas']))).toEqual({ hosts: [], unplaced: true });
    dosDevices.set('Q:', String.raw`\Device\Mup\evil\s`);
    expect(await networkReach('Q:\\a.ts', new Set())).toEqual({ hosts: ['evil'], unplaced: false });
    expect(driveReads('Q')).toEqual([]);
  });

  it('walks a mapped drive on an allowed host, or on WSL, as any local path, and a local volume as before', async () => {
    fakeDisk(new Map([['Q:\\', undefined], ['Q:\\x', undefined], ['Q:\\x\\a.ts', undefined]]));
    dosDevices.set('Q:', String.raw`\Device\LanmanRedirector\;Q:000000000004111a\NAS\data`);
    expect(await networkReach('Q:\\x\\a.ts', new Set(['nas']))).toBeNull();
    dosDevices.set('Q:', String.raw`\Device\P9Rdr\;Q:0\wsl.localhost\Ubuntu`);
    expect(await networkReach('Q:\\x\\a.ts', new Set())).toBeNull();
    dosDevices.set('Q:', String.raw`\Device\HarddiskVolume9`);
    expect(await networkReach('Q:\\x\\a.ts', new Set())).toBeNull();
    expect(driveReads('Q')).toContain('Q:\\x');
  });

  it('places a subst drive by its target\'s own rules, links on the target\'s path included', async () => {
    const project = folder('p');
    evil(path.join(project, 'unc'));
    folder('p', 'local');
    dosDevices.set('Q:', `\\??\\${path.join(project, 'unc', 'dir')}`);
    expect(await networkReach('Q:\\a.ts', new Set())).toEqual({ hosts: ['attacker'], unplaced: false });
    dosDevices.set('Q:', String.raw`\??\UNC\Evil\s\dir`);
    expect(await networkReach('Q:\\a.ts', new Set())).toEqual({ hosts: ['evil'], unplaced: false });
    dosDevices.set('R:', String.raw`\Device\LanmanRedirector\;R:0\other\s`);
    dosDevices.set('Q:', String.raw`\??\R:\dir`);
    expect(await networkReach('Q:\\a.ts', new Set())).toEqual({ hosts: ['other'], unplaced: false });
    expect(driveReads('Q')).toEqual([]);
    expect(driveReads('R')).toEqual([]);
    dosDevices.set('Q:', `\\??\\${path.join(project, 'local')}`);
    expect(await networkReach('Q:\\a.ts', new Set())).toBeNull();
    expect(uncCalls).toEqual([]);
  });

  it('rejects a subst drive that names itself through other drives, as Windows cannot open it', async () => {
    dosDevices.set('Q:', String.raw`\??\R:\x`);
    dosDevices.set('R:', String.raw`\??\Q:\y`);
    await expect(networkReach('Q:\\a.ts', new Set())).rejects.toMatchObject({ code: 'ELOOP' });
  });

  it('places a drive a link on the walk leads onto before touching it, and only in a walk given the chat\'s hosts', async () => {
    const project = folder('p');
    junction(path.join(project, 'mapped'), marker);
    fakeTargets.set(identity(path.join(project, 'mapped')), 'Q:\\data');
    dosDevices.set('Q:', String.raw`\Device\LanmanRedirector\;Q:000000000004111a\evil\s`);
    expect(await networkReach(path.join(project, 'mapped', 'a.ts'), new Set(['nas']))).toEqual({ hosts: ['evil'], unplaced: false });
    expect(await followsLocalLinksOnly(project, ['mapped', 'a.ts'], { allowedHosts: new Set() })).toBe(false);
    expect(driveReads('Q')).toEqual([]);
    fakeDisk(new Map([['Q:\\', undefined], ['Q:\\data', undefined], ['Q:\\data\\a.ts', undefined]]));
    expect(await followsLocalLinksOnly(project, ['mapped', 'a.ts'], { allowedHosts: new Set(['evil']) })).toBe(true);
    // the desktop's own walks take the user's mapping as theirs
    expect(await followsLocalLinksOnly(project, ['mapped', 'a.ts'])).toBe(true);
  });

  it('blocks rather than places a path when Windows cannot say where a drive points', async () => {
    dosDevices.set('Q:', new Error('QueryDosDeviceW(Q:) failed with Win32 error 5'));
    await expect(networkReach('Q:\\a.ts', new Set())).rejects.toThrow('Win32 error 5');
    const project = folder('p');
    junction(path.join(project, 'mapped'), marker);
    fakeTargets.set(identity(path.join(project, 'mapped')), 'Q:\\data');
    await expect(networkReach(path.join(project, 'mapped', 'a.ts'), new Set())).rejects.toThrow('Win32 error 5');
    expect(driveReads('Q')).toEqual([]);
  });

  it('takes a folder\'s hosts from its spelling and its realpath, as a mapped drive names its share', async () => {
    fakeDisk(new Map([['M:\\proj', undefined]]), new Map([['M:\\PROJ', '\\\\nas\\data\\proj']]));
    expect([...await networkHostsOf(['\\\\Files.Corp\\proj', 'M:\\proj', root, path.join(root, 'missing')])].sort()).toEqual(['files.corp', 'nas']);
    expect([...await networkHostsOf([root], ['//Other/share', 'N:\\x'])]).toEqual(['other']);
  });
});

describe.runIf(process.platform === 'win32')('a confinement\'s realpath on a share (win32)', () => {
  // every letter a local volume, so only the mappings a test sets name a share
  beforeEach(() => {
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') dosDevices.set(`${letter}:`, String.raw`\Device\HarddiskVolume9`);
  });

  it('accepts a drive realpath, and a share realpath on the base\'s own share by its spelling, its realpath or its drive\'s mapping', () => {
    expect(realpathOnOwnShare('C:\\proj', 'C:\\proj', 'D:\\x\\a.ts')).toBe(true);
    expect(realpathOnOwnShare('\\\\nas\\data\\proj', '\\\\nas\\data\\proj', '\\\\NAS\\Data\\other\\a.ts')).toBe(true);
    expect(realpathOnOwnShare('C:\\link', '\\\\nas\\data\\proj', '\\\\nas\\data\\other\\a.ts')).toBe(true);
    dosDevices.set('P:', String.raw`\Device\LanmanRedirector\;P:000000000004111a\nas\data`);
    expect(realpathOnOwnShare('P:\\proj', 'P:\\proj', '\\\\nas\\data\\proj\\a.ts')).toBe(true);
    expect(uncCalls).toEqual([]);
  });

  it('accepts a share any drive letter maps now, since a link to that letter is followed as the user\'s own mapping', () => {
    dosDevices.set('Z:', String.raw`\Device\LanmanRedirector\;Z:000000000004111a\nas\home`);
    expect(realpathOnOwnShare('C:\\proj', 'C:\\proj', '\\\\nas\\home\\notes\\a.md')).toBe(true);
    dosDevices.set('Y:', String.raw`\??\UNC\files\team`);
    expect(realpathOnOwnShare('C:\\proj', 'C:\\proj', '\\\\files\\team\\a.md')).toBe(true);
    expect(uncCalls).toEqual([]);
  });

  it('refuses a realpath on any other share, and a device path that names no share, touching neither', () => {
    dosDevices.set('Z:', String.raw`\Device\LanmanRedirector\;Z:000000000004111a\nas\home`);
    expect(realpathOnOwnShare('C:\\proj', 'C:\\proj', '\\\\evil\\share\\a.ts')).toBe(false);
    expect(realpathOnOwnShare('C:\\proj', 'C:\\proj', '\\\\nas\\other\\a.ts')).toBe(false);
    expect(realpathOnOwnShare('\\\\nas\\data\\proj', '\\\\nas\\data\\proj', '\\\\nas\\other\\a.ts')).toBe(false);
    expect(realpathOnOwnShare('C:\\proj', 'C:\\proj', '\\\\?\\GLOBALROOT\\Device\\Mup\\evil\\s\\a.ts')).toBe(false);
    expect(realpathOnOwnShare('C:\\proj', 'C:\\proj', '\\\\.\\pipe\\x')).toBe(false);
    // another name of one server is another path, which Damocles cannot match without contacting the server
    expect(realpathOnOwnShare('\\\\nas\\data\\proj', '\\\\nas\\data\\proj', '\\\\nas.corp.example\\data\\a.ts')).toBe(false);
    expect(realpathOnOwnShare('C:\\proj', 'C:\\proj', '\\\\nas.corp.example\\home\\a.md')).toBe(false);
    expect(uncCalls).toEqual([]);
  });

  it('adds no share for a letter Windows cannot place, which refuses more, never less', () => {
    dosDevices.set('Z:', new Error('QueryDosDeviceW(Z:) failed with Win32 error 5'));
    expect(realpathOnOwnShare('C:\\proj', 'C:\\proj', '\\\\nas\\home\\a.md')).toBe(false);
  });
});
