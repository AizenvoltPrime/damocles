import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mappedDrivePath } from '../../../core/mapped-drives';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import type { LinkRule } from '../../../platform/file-confinement';
import { createVsCodeFileConfinement } from '../file-confinement';

vi.mock('../../../core/mapped-drives', () => ({ mappedDrivePath: vi.fn(() => null) }));

const RULES: readonly LinkRule[] = ['withinProject', 'throughLinks'];
const OUTSIDE = { ok: false, reason: 'outside' };

let root: string;
let project: string;
let outside: string;
// folderKey of a link -> what readlink answers for it
let fakeTargets: Map<string, string>;
// every realpath, stat or open that named a UNC path, or a path at or under a link in guarded
let followed: string[];
let guarded: string[];

const isAtOrUnder = (file: string, folder: string): boolean => folderKey(file) === folderKey(folder) || folderKey(file).startsWith(`${folderKey(folder)}${path.sep}`);

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-vscode-confine-')));
  project = path.join(root, 'proj');
  outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(project, 'real'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(project, 'real', 'a.ts'), 'x');
  fs.writeFileSync(path.join(outside, 'f.txt'), 'x');
  fs.symlinkSync(outside, path.join(project, 'out'), 'junction');
  fakeTargets = new Map();
  followed = [];
  guarded = [];
  const readlink = fs.promises.readlink.bind(fs.promises);
  vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) => fakeTargets.get(folderKey(String(file))) ?? readlink(file)) as typeof fs.promises.readlink);
  for (const name of ['realpath', 'stat', 'open', 'lstat'] as const) {
    const original = (fs.promises[name] as (...args: unknown[]) => Promise<unknown>).bind(fs.promises);
    vi.spyOn(fs.promises, name).mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
      const spelled = String(file);
      if (/^[\\/]{2}/.test(spelled) || (name !== 'lstat' && guarded.some((link) => isAtOrUnder(spelled, link)))) {
        followed.push(`${name} ${spelled}`);
        throw new Error(`followed ${spelled}`);
      }
      return original(file, ...rest);
    }) as never);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(mappedDrivePath).mockReset().mockReturnValue(null);
  fs.rmSync(root, { recursive: true, force: true });
});

const confine = createVsCodeFileConfinement();

describe('VS Code\'s confinement of a file a chat names', () => {
  it('answers a file inside the folder, and follows a link out only through links', async () => {
    for (const rule of RULES) expect(await confine.confineExisting(project, 'real/a.ts', rule)).toEqual({ ok: true, path: path.join(project, 'real', 'a.ts') });
    expect(await confine.confineExisting(project, 'out/f.txt', 'withinProject')).toEqual(OUTSIDE);
    expect(await confine.confineExisting(project, 'out/f.txt', 'throughLinks')).toEqual({ ok: true, path: path.join(outside, 'f.txt'), via: { link: 'out', realRoot: outside } });
  });

  it('refuses a \'..\' segment under either rule, as the walk reads lexical prefixes', async () => {
    for (const rule of RULES) expect(await confine.confineExisting(project, 'real/../real/a.ts', rule)).toEqual(OUTSIDE);
  });
});

describe.runIf(process.platform === 'win32')('VS Code\'s confinement and network paths (win32)', () => {
  it('walks every segment before any realpath under either rule, so a link onto a share is refused untouched', async () => {
    const link = path.join(project, 'nas');
    fs.symlinkSync(path.join(project, 'real'), link, 'junction');
    fakeTargets.set(folderKey(link), '\\\\host\\share\\x');
    guarded.push(link);
    for (const rule of RULES) {
      for (const relativePath of ['nas/a.ts', 'nas']) {
        vi.mocked(fs.promises.readlink).mockClear();
        vi.mocked(fs.promises.realpath).mockClear();
        expect(await confine.confineExisting(project, relativePath, rule)).toEqual(OUTSIDE);
        // the walk read the link before any realpath, the folder's included
        const readlink = vi.mocked(fs.promises.readlink).mock;
        const linkRead = readlink.invocationCallOrder[readlink.calls.findIndex(([file]) => folderKey(String(file)) === folderKey(link))];
        expect(linkRead).toBeDefined();
        expect(vi.mocked(fs.promises.realpath).mock.invocationCallOrder.filter((order) => order < linkRead!)).toEqual([]);
      }
    }
    expect(followed).toEqual([]);
  });

  // Every realpath at or under folder answers the same path under share, as when a link there was swapped after the walk.
  function realpathsUnder(folder: string, share: string): void {
    const realpath = vi.mocked(fs.promises.realpath).getMockImplementation()!;
    vi.mocked(fs.promises.realpath).mockImplementation((async (file: fs.PathLike) => {
      const spelled = String(file);
      return isAtOrUnder(spelled, folder) ? path.join(share, path.relative(folder, spelled)) : realpath(file);
    }) as typeof fs.promises.realpath);
  }

  it('refuses a link swapped onto a share that is neither the folder\'s nor a mapped drive\'s, under either rule', async () => {
    realpathsUnder(path.join(project, 'out'), '\\\\evil\\share\\x');
    for (const rule of RULES) expect(await confine.confineExisting(project, 'out/f.txt', rule)).toEqual(OUTSIDE);
    expect(followed).toEqual([]);
  });

  it('follows a link onto the share a drive letter maps, as the user\'s own mapping', async () => {
    vi.mocked(mappedDrivePath).mockImplementation((driveRoot) => (driveRoot.toUpperCase() === 'Z:\\' ? '\\\\nas\\home' : null));
    realpathsUnder(path.join(project, 'out'), '\\\\nas\\home\\notes');
    expect(await confine.confineExisting(project, 'out/f.txt', 'throughLinks')).toEqual({ ok: true, path: '\\\\nas\\home\\notes\\f.txt', via: { link: 'out', realRoot: '\\\\nas\\home\\notes' } });
    expect(followed).toEqual([]);
  });

  it('reads a folder whose own realpath is on a share', async () => {
    realpathsUnder(project, '\\\\nas\\data\\proj');
    for (const rule of RULES) expect(await confine.confineExisting(project, 'real/a.ts', rule)).toEqual({ ok: true, path: '\\\\nas\\data\\proj\\real\\a.ts' });
    expect(followed).toEqual([]);
  });
});
