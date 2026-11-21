import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveMention } from '../../../core/chat-panel/mention-resolver';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import type { FolderTarget } from '../../../core/workspace-folders/folder-registry';
import { createDesktopFileConfinement } from '../file-confinement';

let root: string;
let project: string;
let folders: { resolve(key: string): FolderTarget | undefined };
// folderKey of a link -> what readlink answers for it
let fakeTargets: Map<string, string>;
// Links nothing may follow: a stat, realpath or open at or under one, and any call on a UNC path, is recorded and throws
// instead of reaching the network (as in confine.test.ts).
let guarded: string[];
let followed: string[];

function follows(file: string, linksToo: boolean): boolean {
  const key = folderKey(file);
  if (!/^[\\/]{2}/.test(file) && !(linksToo && guarded.some((link) => key === folderKey(link) || key.startsWith(`${folderKey(link)}${path.sep}`)))) return false;
  followed.push(file);
  return true;
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-mention-confine-')));
  project = path.join(root, 'proj');
  fs.mkdirSync(path.join(project, 'real'), { recursive: true });
  fs.writeFileSync(path.join(project, 'real', 'a.ts'), '');
  const known: FolderTarget[] = [{ key: folderKey(project), fsPath: project, name: 'proj', label: 'proj', projectScope: true }];
  folders = { resolve: (key) => known.find((candidate) => candidate.key === key) };
  fakeTargets = new Map();
  guarded = [];
  followed = [];
  for (const name of ['stat', 'realpath', 'open', 'lstat'] as const) {
    const original = (fs.promises[name] as (...args: unknown[]) => Promise<unknown>).bind(fs.promises);
    vi.spyOn(fs.promises, name).mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
      if (follows(String(file), name !== 'lstat')) throw new Error(`followed ${String(file)}`);
      return original(file, ...rest);
    }) as never);
  }
  const readlink = fs.promises.readlink.bind(fs.promises);
  vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) => fakeTargets.get(folderKey(String(file))) ?? readlink(file)) as typeof fs.promises.readlink);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const depsOf = (trusted: boolean) => ({ folders, confinement: createDesktopFileConfinement(), trust: { isTrusted: () => trusted } });

describe('a mention through the desktop confinement', () => {
  it('resolves a file inside the chat\'s project', async () => {
    const deps = depsOf(false);
    expect(await resolveMention(deps, { projectKey: folderKey(project), relativePath: 'real/a.ts' }, project)).toEqual({ ok: true, path: path.join(project, 'real', 'a.ts'), display: 'real/a.ts' });
    expect(await resolveMention(deps, { path: path.join(project, 'real', 'a.ts') }, project)).toMatchObject({ ok: true, display: 'real/a.ts' });
  });

  it('follows a link out of the project only in a trusted one, showing the path through the link', async () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'b.ts'), '');
    fs.symlinkSync(outside, path.join(project, 'out'), 'junction');
    const target = { projectKey: folderKey(project), relativePath: 'out/b.ts' };
    expect(await resolveMention(depsOf(true), target, project)).toEqual({ ok: true, path: path.join(outside, 'b.ts'), display: 'out/b.ts' });
    expect(await resolveMention(depsOf(false), target, project)).toEqual({ ok: false, reason: 'outsideProject' });
  });

  it.runIf(process.platform === 'win32').each([[true], [false]])('refuses a repository link to a share by project key or by path, and never touches the share (trusted: %s)', async (trusted) => {
    // A real junction (no privilege needed) whose readlink answers a UNC path.
    const link = path.join(project, 'share');
    fs.symlinkSync(path.join(project, 'real'), link, 'junction');
    fakeTargets.set(folderKey(link), '\\\\server\\share\\x');
    guarded.push(link);
    const deps = depsOf(trusted);
    expect(await resolveMention(deps, { projectKey: folderKey(project), relativePath: 'share/a.ts' }, project)).toEqual({ ok: false, reason: 'outsideProject' });
    expect(await resolveMention(deps, { projectKey: folderKey(project), relativePath: 'share' }, project)).toEqual({ ok: false, reason: 'outsideProject' });
    expect(await resolveMention(deps, { path: path.join(link, 'a.ts') }, project)).toEqual({ ok: false, reason: 'outsideChat' });
    expect(followed).toEqual([]);
  });
});
