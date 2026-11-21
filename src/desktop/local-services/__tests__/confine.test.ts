import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mappedDrivePath } from '../../../core/mapped-drives';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { confineEntry, confineExisting, confineMissing, confineOrCreateFolder, confineResolved, type LinkRule, type Project } from '../confine';

vi.mock('../../../core/mapped-drives', () => ({ mappedDrivePath: vi.fn(() => null) }));

const RULES: readonly LinkRule[] = ['withinProject', 'throughLinks'];
const SHARE = { ok: false, reason: 'outside', refusal: 'share' };

let root: string;
let projectDir: string;
let project: Project;
// folderKey of a link -> what readlink answers for it
let fakeTargets: Map<string, string>;
// Links nothing may follow. A realpath or stat at or under one, and any call on a UNC or device path, is recorded in followed
// and throws instead of reaching the network.
let guarded: string[];
let followed: string[];

const isAtOrUnder = (file: string, link: string): boolean => folderKey(file) === folderKey(link) || folderKey(file).startsWith(`${folderKey(link)}${path.sep}`);

function follows(file: string, linksToo: boolean): boolean {
  if (!/^[\\/]{2}/.test(file) && !(linksToo && guarded.some((link) => isAtOrUnder(file, link)))) return false;
  followed.push(file);
  return true;
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-confine-')));
  projectDir = path.join(root, 'proj');
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'real', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'src', 'app.ts'), 'x');
  fs.writeFileSync(path.join(projectDir, 'real', 'sub', 'a.ts'), 'x');
  project = { key: folderKey(projectDir), fsPath: projectDir, name: 'proj' };
  fakeTargets = new Map();
  guarded = [];
  followed = [];
  const readlink = fs.promises.readlink.bind(fs.promises);
  vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) => fakeTargets.get(folderKey(String(file))) ?? readlink(file)) as typeof fs.promises.readlink);
  const realpath = fs.promises.realpath.bind(fs.promises);
  vi.spyOn(fs.promises, 'realpath').mockImplementation((async (file: fs.PathLike) => {
    if (follows(String(file), true)) throw new Error(`followed ${String(file)}`);
    return realpath(file);
  }) as typeof fs.promises.realpath);
  const stat = fs.promises.stat.bind(fs.promises);
  vi.spyOn(fs.promises, 'stat').mockImplementation((async (file: fs.PathLike, options?: fs.StatOptions) => {
    if (follows(String(file), true)) throw new Error(`followed ${String(file)}`);
    return stat(file, options);
  }) as typeof fs.promises.stat);
  const lstatOf = fs.promises.lstat.bind(fs.promises);
  vi.spyOn(fs.promises, 'lstat').mockImplementation((async (file: fs.PathLike, options?: fs.StatOptions) => {
    if (follows(String(file), false)) throw new Error(`followed ${String(file)}`);
    return lstatOf(file, options);
  }) as typeof fs.promises.lstat);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(mappedDrivePath).mockReset().mockReturnValue(null);
  fs.rmSync(root, { recursive: true, force: true });
});

// A real junction (lstat sees a link, and creating one needs no privilege) whose readlink answers target.
function fakeLink(name: string, target: string, guard = true): string {
  const link = path.join(projectDir, name);
  fs.symlinkSync(path.join(projectDir, 'real'), link, 'junction');
  fakeTargets.set(folderKey(link), target);
  if (guard) guarded.push(link);
  return link;
}

describe.runIf(process.platform === 'win32')('links to UNC and device paths (win32)', () => {
  it.each([
    ['\\\\server\\share\\x'],
    ['//server/share/x'],
    ['\\\\?\\UNC\\server\\share\\x'],
    ['\\\\?\\C:\\x'],
    ['\\\\.\\pipe\\x'],
    ['\\??\\UNC\\server\\share\\x'],
    ['\\??\\GLOBALROOT\\Device\\Mup\\server\\share'],
    ['\\??\\Volume{00000000-0000-0000-0000-000000000000}\\'],
    ['D:x'],
  ])('refuses a link to %j without following it, under either rule', async (target) => {
    fakeLink('share', target);
    for (const rule of RULES) {
      expect(await confineExisting(project, 'share/sub/a.ts', rule)).toEqual(SHARE);
      expect(await confineExisting(project, 'share', rule)).toEqual(SHARE);
      expect(await confineMissing(project, 'share/sub/new.ts', rule)).toEqual(SHARE);
      expect(await confineOrCreateFolder(project, 'share/sub/made', rule)).toEqual(SHARE);
      expect(await confineEntry(project, 'share/sub/a.ts', rule)).toEqual(SHARE);
      expect(followed).toEqual([]);
      // The link itself is still an entry: a rename or trash acts on it and never follows it.
      expect(await confineEntry(project, 'share', rule)).toMatchObject({ ok: true, path: path.join(projectDir, 'share') });
      expect(followed).toEqual([]);
    }
  });

  it.each([['\\\\wsl.localhost\\Ubuntu\\home\\me'], ['\\\\wsl$\\Ubuntu\\home\\me'], ['\\\\server\\share\\assets'], ['\\\\.\\C:\\x']])('refuses a folder link to %j behind another link, with no lstat of the target', async (target) => {
    fs.mkdirSync(path.join(root, 'linked'));
    fs.symlinkSync(path.join(root, 'linked'), path.join(projectDir, 'outer'), 'junction');
    const inner = path.join(root, 'linked', 'wsl');
    fs.symlinkSync(path.join(projectDir, 'real'), inner, 'junction');
    fakeTargets.set(folderKey(inner), target);
    guarded.push(inner);
    expect(await confineExisting(project, 'outer/wsl/sub/a.ts', 'throughLinks')).toEqual(SHARE);
    expect(await confineEntry(project, 'outer/wsl/sub/a.ts', 'throughLinks')).toEqual(SHARE);
    expect(followed).toEqual([]);
  });

  it('refuses a relative or absolute local target that leads on through a UNC link', async () => {
    fakeLink('remote', '\\\\server\\share');
    fakeLink('hop', 'remote\\x');
    fakeLink('up', '..\\proj\\remote');
    fakeLink('absolute', `${projectDir}\\remote\\x`);
    for (const relativePath of ['hop/a.ts', 'up/a.ts', 'absolute/a.ts']) {
      for (const rule of RULES) expect(await confineExisting(project, relativePath, rule), relativePath).toEqual(SHARE);
    }
    expect(followed).toEqual([]);
  });

  it('refuses a real symlink to a UNC share, which Node reads back from \\??\\UNC\\', async (ctx) => {
    const link = path.join(projectDir, 'unc');
    try {
      fs.symlinkSync('\\\\damocles.invalid\\share', link, 'dir');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') ctx.skip();
      throw err;
    }
    guarded.push(link);
    for (const rule of RULES) expect(await confineExisting(project, 'unc/a.ts', rule)).toEqual(SHARE);
    expect(followed).toEqual([]);
  });

  it('follows a junction whose target reads \\??\\C:\\ as the local path it is', async () => {
    fakeLink('local', `\\??\\${projectDir}\\real`, false);
    for (const rule of RULES) expect(await confineExisting(project, 'local/sub/a.ts', rule)).toEqual({ ok: true, path: path.join(projectDir, 'real', 'sub', 'a.ts') });
  });
});

describe('links that stay local', () => {
  it('follows a junction and a relative symlink that stay inside the project', async () => {
    fs.symlinkSync(path.join(projectDir, 'real'), path.join(projectDir, 'inner'), 'junction');
    fs.symlinkSync(path.join('src', 'app.ts'), path.join(projectDir, 'rel.ts'), 'file');
    // a link that stays inside answers as it always did under either rule: no via, resolvedPath from the project
    for (const rule of RULES) {
      expect(await confineExisting(project, 'inner/sub/a.ts', rule)).toEqual({ ok: true, path: path.join(projectDir, 'real', 'sub', 'a.ts') });
      expect(await confineExisting(project, 'rel.ts', rule)).toEqual({ ok: true, path: path.join(projectDir, 'src', 'app.ts') });
      expect(await confineEntry(project, 'inner/sub/a.ts', rule)).toMatchObject({ ok: true, path: path.join(projectDir, 'real', 'sub', 'a.ts'), resolvedPath: 'real/sub/a.ts' });
      expect(await confineEntry(project, 'inner/sub/a.ts', rule)).not.toHaveProperty('via');
    }
  });

  it('fails a link loop with the failure\'s own words', async () => {
    fs.symlinkSync(path.join(projectDir, 'b'), path.join(projectDir, 'a'), 'junction');
    fs.symlinkSync(path.join(projectDir, 'a'), path.join(projectDir, 'b'), 'junction');
    // win32's walk words the loop itself; elsewhere the realpath's ELOOP crosses as written
    const words = process.platform === 'win32' ? { message: 'The path under {0} goes through too many links.', args: [expect.any(String)] } : { message: '{0}', args: [expect.stringContaining('ELOOP')] };
    for (const rule of RULES) {
      expect(await confineExisting(project, 'a/x.ts', rule)).toEqual({ ok: false, reason: 'failed', error: words });
      expect(await confineEntry(project, 'a/x.ts', rule)).toEqual({ ok: false, reason: 'failed', error: words });
    }
  });

  it('fails a folder it cannot make with the file system\'s words', async () => {
    vi.spyOn(fs.promises, 'mkdir').mockRejectedValue(Object.assign(new Error('EACCES: permission denied, mkdir'), { code: 'EACCES' }));
    expect(await confineOrCreateFolder(project, 'src/made', 'throughLinks')).toEqual({ ok: false, reason: 'failed', error: { message: '{0}', args: ['EACCES: permission denied, mkdir'] } });
  });

  it('reads no link on a path without one, with one lstat per segment on win32 and none elsewhere', async () => {
    for (const rule of RULES) expect(await confineExisting(project, 'src/app.ts', rule)).toEqual({ ok: true, path: path.join(projectDir, 'src', 'app.ts') });
    expect(fs.promises.lstat).toHaveBeenCalledTimes(process.platform === 'win32' ? 4 : 0);
    expect(fs.promises.readlink).not.toHaveBeenCalled();
  });
});

describe('links that leave the project', () => {
  let outside: string;

  beforeEach(() => {
    outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(outside, 'deep'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'f.txt'), 'x');
    fs.writeFileSync(path.join(outside, 'deep', 'g.txt'), 'x');
    fs.symlinkSync(outside, path.join(projectDir, 'out'), 'junction');
  });

  it('refuses them within the project, and follows them through links to the deepest link\'s realpath', async () => {
    const via = { link: 'out', realRoot: outside };
    expect(await confineExisting(project, 'out', 'withinProject')).toEqual({ ok: false, reason: 'outside' });
    expect(await confineExisting(project, 'out/f.txt', 'withinProject')).toEqual({ ok: false, reason: 'outside' });
    expect(await confineEntry(project, 'out/f.txt', 'withinProject')).toEqual({ ok: false, reason: 'outside' });
    expect(await confineMissing(project, 'out/new/x.ts', 'withinProject')).toEqual({ ok: false, reason: 'outside' });
    expect(await confineExisting(project, 'out', 'throughLinks')).toEqual({ ok: true, path: outside, via });
    expect(await confineExisting(project, 'out/deep/g.txt', 'throughLinks')).toEqual({ ok: true, path: path.join(outside, 'deep', 'g.txt'), via });
    expect(await confineResolved(project, 'out/deep/g.txt', 'throughLinks')).toEqual({ ok: true, path: path.join(outside, 'deep', 'g.txt'), resolvedPath: 'deep/g.txt', via });
    expect(await confineMissing(project, 'out/new/x.ts', 'throughLinks')).toEqual({ ok: true, path: path.join(outside, 'new', 'x.ts'), via });
    expect(await confineEntry(project, 'out/deep/g.txt', 'throughLinks')).toMatchObject({ ok: true, path: path.join(outside, 'deep', 'g.txt'), resolvedPath: 'deep/g.txt', via });
  });

  it('makes a missing folder under the link root, one at a time', async () => {
    expect(await confineOrCreateFolder(project, 'out/made/sub', 'withinProject')).toEqual({ ok: false, reason: 'outside' });
    expect(fs.existsSync(path.join(outside, 'made'))).toBe(false);
    expect(await confineOrCreateFolder(project, 'out/made/sub', 'throughLinks')).toEqual({ ok: true, path: path.join(outside, 'made', 'sub'), via: { link: 'out', realRoot: outside } });
    expect(fs.statSync(path.join(outside, 'made', 'sub')).isDirectory()).toBe(true);
  });

  it('never follows the last segment of an entry, so the link row is the link itself', async () => {
    for (const rule of RULES) {
      const entry = await confineEntry(project, 'out', rule);
      expect(entry).toMatchObject({ ok: true, path: path.join(projectDir, 'out'), resolvedPath: 'out' });
      expect(entry.ok && entry.stat.isSymbolicLink()).toBe(true);
      expect(entry).not.toHaveProperty('via');
    }
  });

  it('follows a real directory symlink as it follows a junction', async (ctx) => {
    try {
      fs.symlinkSync(outside, path.join(projectDir, 'sym'), 'dir');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') ctx.skip();
      throw err;
    }
    expect(await confineExisting(project, 'sym/f.txt', 'withinProject')).toEqual({ ok: false, reason: 'outside' });
    expect(await confineExisting(project, 'sym/f.txt', 'throughLinks')).toEqual({ ok: true, path: path.join(outside, 'f.txt'), via: { link: 'sym', realRoot: outside } });
  });

  it('follows a file link out of the project with the file itself as its link root', async (ctx) => {
    const file = path.join(outside, 'f.txt');
    try {
      fs.symlinkSync(file, path.join(projectDir, 'f'), 'file');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') ctx.skip();
      throw err;
    }
    expect(await confineResolved(project, 'f', 'withinProject')).toEqual({ ok: false, reason: 'outside' });
    expect(await confineResolved(project, 'f', 'throughLinks')).toEqual({ ok: true, path: file, resolvedPath: '', via: { link: 'f', realRoot: file } });
  });

  it('takes the link root from the deepest link of a chain, and the final realpath of a link to a link', async () => {
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'h.txt'), 'x');
    fs.symlinkSync(other, path.join(outside, 'next'), 'junction');
    expect(await confineResolved(project, 'out/next/h.txt', 'throughLinks')).toEqual({ ok: true, path: path.join(other, 'h.txt'), resolvedPath: 'h.txt', via: { link: 'out/next', realRoot: other } });
    // a link to a link: the root is where the chain ends
    fs.symlinkSync(path.join(outside, 'next'), path.join(projectDir, 'chain'), 'junction');
    expect(await confineResolved(project, 'chain/h.txt', 'throughLinks')).toEqual({ ok: true, path: path.join(other, 'h.txt'), resolvedPath: 'h.txt', via: { link: 'chain', realRoot: other } });
    // a chain that comes back into the project answers as inside
    fs.symlinkSync(path.join(projectDir, 'src'), path.join(outside, 'back'), 'junction');
    expect(await confineResolved(project, 'out/back/app.ts', 'throughLinks')).toEqual({ ok: true, path: path.join(projectDir, 'src', 'app.ts'), resolvedPath: 'src/app.ts' });
    expect(await confineExisting(project, 'out/back/app.ts', 'withinProject')).toEqual({ ok: true, path: path.join(projectDir, 'src', 'app.ts') });
  });

  it.each([
    ['another folder', (link: string) => fs.symlinkSync(path.join(root, 'swapped'), link, 'junction')],
    ['a plain folder', (link: string) => {
      fs.mkdirSync(link);
      fs.writeFileSync(path.join(link, 'f.txt'), 'x');
    }],
  ])('refuses a path whose link is swapped for %s between the realpath and the link root', async (_name, swapIn) => {
    fs.mkdirSync(path.join(root, 'swapped'));
    fs.writeFileSync(path.join(root, 'swapped', 'f.txt'), 'x');
    const link = path.join(projectDir, 'out');
    const target = path.join(link, 'f.txt');
    const realpath = vi.mocked(fs.promises.realpath).getMockImplementation()!;
    vi.mocked(fs.promises.realpath).mockImplementation((async (file: fs.PathLike) => {
      const answer = await realpath(file);
      if (String(file) === target) {
        fs.unlinkSync(link);
        swapIn(link);
      }
      return answer;
    }) as typeof fs.promises.realpath);
    expect(await confineExisting(project, 'out/f.txt', 'throughLinks')).toEqual({ ok: false, reason: 'outside' });
  });
});

describe.runIf(process.platform === 'win32')('a realpath that answers a share after the walk passed (win32)', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(root, 'outside'));
    fs.writeFileSync(path.join(root, 'outside', 'f.txt'), 'x');
    fs.symlinkSync(path.join(root, 'outside'), path.join(projectDir, 'out'), 'junction');
  });

  // Every realpath at or under folder answers the same path under share, as when a link there was swapped after the walk.
  function realpathsUnder(folder: string, share: string): void {
    const realpath = vi.mocked(fs.promises.realpath).getMockImplementation()!;
    vi.mocked(fs.promises.realpath).mockImplementation((async (file: fs.PathLike) => {
      const spelled = String(file);
      return isAtOrUnder(spelled, folder) ? path.join(share, path.relative(folder, spelled)) : realpath(file);
    }) as typeof fs.promises.realpath);
  }

  it('refuses a link swapped onto a share that is neither the project\'s nor a mapped drive\'s, under either rule', async () => {
    realpathsUnder(path.join(projectDir, 'out'), '\\\\evil\\share\\x');
    for (const rule of RULES) {
      expect(await confineExisting(project, 'out/f.txt', rule)).toEqual(SHARE);
      expect(await confineResolved(project, 'out', rule)).toEqual(SHARE);
      expect(await confineEntry(project, 'out/f.txt', rule)).toEqual(SHARE);
      expect(await confineMissing(project, 'out/new.txt', rule)).toEqual(SHARE);
    }
    expect(followed).toEqual([]);
  });

  it('follows a link onto the share a drive letter maps, as the user\'s own mapping', async () => {
    vi.mocked(mappedDrivePath).mockImplementation((driveRoot) => (driveRoot.toUpperCase() === 'Z:\\' ? '\\\\nas\\home' : null));
    realpathsUnder(path.join(projectDir, 'out'), '\\\\nas\\home\\notes');
    expect(await confineResolved(project, 'out/f.txt', 'throughLinks')).toEqual({ ok: true, path: '\\\\nas\\home\\notes\\f.txt', resolvedPath: 'f.txt', via: { link: 'out', realRoot: '\\\\nas\\home\\notes' } });
    expect(await confineExisting(project, 'out/f.txt', 'withinProject')).toEqual({ ok: false, reason: 'outside' });
    expect(followed).toEqual([]);
  });

  it('reads a project whose own realpath is on a share', async () => {
    realpathsUnder(projectDir, '\\\\nas\\data\\proj');
    for (const rule of RULES) expect(await confineResolved(project, 'src/app.ts', rule)).toEqual({ ok: true, path: '\\\\nas\\data\\proj\\src\\app.ts', resolvedPath: 'src/app.ts' });
    expect(followed).toEqual([]);
  });
});
