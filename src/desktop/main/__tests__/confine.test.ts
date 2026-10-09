import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { confineEntry, confineExisting, type Project } from '../documents/confine';

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
  ])('refuses a link to %j without following it', async (target) => {
    fakeLink('share', target);
    expect(await confineExisting(project, 'share/sub/a.ts')).toEqual({ ok: false, reason: 'outside' });
    expect(await confineExisting(project, 'share')).toEqual({ ok: false, reason: 'outside' });
    expect(await confineEntry(project, 'share/sub/a.ts')).toEqual({ ok: false, reason: 'outside' });
    expect(followed).toEqual([]);
    // The link itself is still an entry: a rename or trash acts on it and never follows it.
    expect(await confineEntry(project, 'share')).toMatchObject({ ok: true, path: path.join(projectDir, 'share') });
    expect(followed).toEqual([]);
  });

  it('refuses a relative or absolute local target that leads on through a UNC link', async () => {
    fakeLink('remote', '\\\\server\\share');
    fakeLink('hop', 'remote\\x');
    fakeLink('up', '..\\proj\\remote');
    fakeLink('absolute', `${projectDir}\\remote\\x`);
    for (const relativePath of ['hop/a.ts', 'up/a.ts', 'absolute/a.ts']) {
      expect(await confineExisting(project, relativePath), relativePath).toEqual({ ok: false, reason: 'outside' });
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
    expect(await confineExisting(project, 'unc/a.ts')).toEqual({ ok: false, reason: 'outside' });
    expect(followed).toEqual([]);
  });

  it('follows a junction whose target reads \\??\\C:\\ as the local path it is', async () => {
    fakeLink('local', `\\??\\${projectDir}\\real`, false);
    expect(await confineExisting(project, 'local/sub/a.ts')).toEqual({ ok: true, path: path.join(projectDir, 'real', 'sub', 'a.ts') });
  });
});

describe('links that stay local', () => {
  it('follows a junction and a relative symlink that stay inside the project', async () => {
    fs.symlinkSync(path.join(projectDir, 'real'), path.join(projectDir, 'inner'), 'junction');
    expect(await confineExisting(project, 'inner/sub/a.ts')).toEqual({ ok: true, path: path.join(projectDir, 'real', 'sub', 'a.ts') });
    fs.symlinkSync(path.join('src', 'app.ts'), path.join(projectDir, 'rel.ts'), 'file');
    expect(await confineExisting(project, 'rel.ts')).toEqual({ ok: true, path: path.join(projectDir, 'src', 'app.ts') });
  });

  it('still refuses a local link that leaves the project', async () => {
    fs.mkdirSync(path.join(root, 'outside'));
    fs.symlinkSync(path.join(root, 'outside'), path.join(projectDir, 'out'), 'junction');
    expect(await confineExisting(project, 'out')).toEqual({ ok: false, reason: 'outside' });
  });

  it('fails a link loop', async () => {
    fs.symlinkSync(path.join(projectDir, 'b'), path.join(projectDir, 'a'), 'junction');
    fs.symlinkSync(path.join(projectDir, 'a'), path.join(projectDir, 'b'), 'junction');
    expect(await confineExisting(project, 'a/x.ts')).toEqual({ ok: false, reason: 'failed' });
  });

  it('reads no link on a path without one, with one lstat per segment on win32 and none elsewhere', async () => {
    expect(await confineExisting(project, 'src/app.ts')).toEqual({ ok: true, path: path.join(projectDir, 'src', 'app.ts') });
    expect(fs.promises.lstat).toHaveBeenCalledTimes(process.platform === 'win32' ? 2 : 0);
    expect(fs.promises.readlink).not.toHaveBeenCalled();
  });
});
