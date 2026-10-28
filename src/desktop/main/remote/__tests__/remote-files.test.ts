import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import { folderKey } from '../../../../core/workspace-folders/folder-key';
import { createFileSystem, type WorkspaceFileSystem } from '../../../workspace/file-system';
import type { RemoteProject } from '../authorities';
import { projectOfCwd, remoteFileRef, type RemoteFileRoot } from '../remote-files';

const posix: RemoteProject = { key: 'ssh+h1|/srv/app', fsPath: '/srv/app', name: 'app', authorityKey: 'ssh+h1', folderKey: '/srv/app', os: 'linux' };
const windows: RemoteProject = { key: 'wsl+x|c:\\work\\app', fsPath: 'C:\\work\\app', name: 'app', authorityKey: 'wsl+x', folderKey: 'c:\\work\\app', os: 'win32' };

describe('remoteFileRef', () => {
  it('names a file inside the project by the target\'s path rules', () => {
    expect(remoteFileRef([posix], '/srv/app/src/a.ts')).toEqual({ projectKey: posix.key, relativePath: 'src/a.ts' });
    expect(remoteFileRef([windows], 'C:\\work\\app\\src\\a.ts')).toEqual({ projectKey: windows.key, relativePath: 'src/a.ts' });
  });

  it('refuses the project root, a path outside it, a relative, UNC or drive path and a dot-dot escape', () => {
    for (const target of ['/srv/app', '/srv/app/', '/srv/other/a.ts', 'src/a.ts', '/srv/app/../etc/passwd', '\\\\attacker\\share\\x', 'C:\\Users\\me\\x']) {
      expect(remoteFileRef([posix], target)).toBeUndefined();
    }
    for (const target of ['\\\\attacker\\share\\x', 'D:\\work\\app\\a.ts', 'C:\\work\\other\\a.ts', 'C:\\work\\app\\..\\x']) {
      expect(remoteFileRef([windows], target)).toBeUndefined();
    }
  });

  it('names nothing for a project of another authority', () => {
    expect(remoteFileRef([], '/srv/app/src/a.ts')).toBeUndefined();
  });

  it('names a file of a project registered through a link by the realpath its core gives, and by the folder as registered', () => {
    const linked: RemoteFileRoot = { ...posix, fsPath: '/home/dev/app', realPath: '/srv/app' };
    expect(remoteFileRef([linked], '/srv/app/src/a.ts')).toEqual({ projectKey: posix.key, relativePath: 'src/a.ts' });
    expect(remoteFileRef([linked], '/home/dev/app/src/a.ts')).toEqual({ projectKey: posix.key, relativePath: 'src/a.ts' });
    for (const target of ['/srv/app', '/srv/app/../etc/passwd', '/srv/other/a.ts']) expect(remoteFileRef([linked], target)).toBeUndefined();
  });
});

// The target's own confinement of the ref, as the daemon runs it: the ref is lexical, the file the target opens is not.
describe('remoteFileRef with the target\'s confinement', () => {
  let root: string;
  let files: WorkspaceFileSystem;
  let project: RemoteFileRoot;

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-remote-files-')));
    const real = path.join(root, 'real-app');
    fs.mkdirSync(path.join(real, 'src'), { recursive: true });
    fs.writeFileSync(path.join(real, 'src', 'a.ts'), 'inside');
    fs.mkdirSync(path.join(root, 'secrets'));
    fs.writeFileSync(path.join(root, 'secrets', 'key.txt'), 'outside');
    fs.symlinkSync(path.join(root, 'secrets'), path.join(real, 'out'), 'junction');
    const registered = path.join(root, 'app-link');
    fs.symlinkSync(real, registered, 'junction');
    project = { key: `ssh+h1|${folderKey(registered)}`, fsPath: registered, name: 'app-link', authorityKey: 'ssh+h1', folderKey: folderKey(registered), os: process.platform as RemoteFileRoot['os'], realPath: real };
    files = createFileSystem({ watchers: createFakePlatform().fileWatchers, trash: async () => undefined, damoclesHome: path.join(root, 'home', '.damocles'), log: () => undefined });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('opens a repository file of a linked project, and still refuses a link inside it that leads outside', async () => {
    const inside = remoteFileRef([project], path.join(root, 'real-app', 'src', 'a.ts'));
    expect(inside).toEqual({ projectKey: project.key, relativePath: 'src/a.ts' });
    expect(await files.confineExisting(project, inside!.relativePath)).toEqual({ ok: true, path: path.join(root, 'real-app', 'src', 'a.ts') });
    const escaping = remoteFileRef([project], path.join(root, 'real-app', 'out', 'key.txt'));
    expect(escaping).toEqual({ projectKey: project.key, relativePath: 'out/key.txt' });
    expect(await files.confineExisting(project, escaping!.relativePath)).toEqual({ ok: false, reason: 'outside' });
    expect(remoteFileRef([project], path.join(root, 'secrets', 'key.txt'))).toBeUndefined();
  });
});

describe('projectOfCwd', () => {
  const inner: RemoteProject = { ...posix, key: 'ssh+h1|/srv/app/packages/web', fsPath: '/srv/app/packages/web', name: 'web', folderKey: '/srv/app/packages/web' };
  const worktree: RemoteProject = { ...posix, key: 'ssh+h1|/home/dev/.damocles/worktrees/app-1', fsPath: '/home/dev/.damocles/worktrees/app-1' };

  // removing the inner project asks about its terminals, and ending the outer's leaves the inner's running
  it('names the deepest project holding the folder when one project is opened inside another', () => {
    expect(projectOfCwd([posix, inner], '/srv/app/packages/web/src')).toBe(inner.folderKey);
    expect(projectOfCwd([inner, posix], '/srv/app/packages/web')).toBe(inner.folderKey);
    expect(projectOfCwd([posix, inner], '/srv/app/docs')).toBe(posix.folderKey);
  });

  it('names a chat worktree\'s project for a terminal started there, and nothing outside every root', () => {
    expect(projectOfCwd([worktree, posix], '/home/dev/.damocles/worktrees/app-1/src')).toBe(posix.folderKey);
    expect(projectOfCwd([posix], '/srv/other')).toBeUndefined();
    expect(projectOfCwd([posix], 'relative/dir')).toBeUndefined();
  });
});
