import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from 'vitest';
import { followsLocalLinksOnly } from '../local-links';

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
});

afterEach(() => {
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

  it('rejects with ETIMEDOUT when a drive a link leads onto does not answer, asking it once at a time', async () => {
    vi.resetModules();
    const { followsLocalLinksOnly: walk } = await import('../local-links');
    const project = folder('p');
    junction(path.join(project, 'mapped'), marker);
    fakeTargets.set(identity(path.join(project, 'mapped')), 'Q:\\data');
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
});
