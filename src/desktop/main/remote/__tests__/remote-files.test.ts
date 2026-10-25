import { describe, expect, it } from 'vitest';
import type { RemoteProject } from '../authorities';
import { remoteFileRef } from '../remote-files';

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
});
