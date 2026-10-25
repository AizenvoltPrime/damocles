import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { authorityKey, authorityKeyOfProject, isInsideFolder, pathFor, projectKeyOf, targetFolderKeyOf } from '../project-location';

describe('project location', () => {
  it('names each authority by its stable key', () => {
    expect(authorityKey({ kind: 'local' })).toBe('local');
    expect(authorityKey({ kind: 'loopback' })).toBe('loopback');
    expect(authorityKey({ kind: 'ssh', hostId: '5f3c1e' })).toBe('ssh+5f3c1e');
    expect(authorityKey({ kind: 'wsl', distro: 'Ubuntu-24.04' })).toBe('wsl+Ubuntu-24.04');
    expect(authorityKey({ kind: 'container', key: 'ab12' })).toBe('container+ab12');
  });

  it('keeps a local key as its folder key and prefixes a remote one', () => {
    expect(projectKeyOf({ kind: 'local' }, 'c:\\work\\app')).toBe('c:\\work\\app');
    expect(projectKeyOf({ kind: 'loopback' }, 'c:\\work\\app')).toBe('loopback|c:\\work\\app');
    expect(projectKeyOf({ kind: 'ssh', hostId: '5f3c1e' }, '/srv/app')).toBe('ssh+5f3c1e|/srv/app');
  });

  it('reads the authority and target folder key back from a project key', () => {
    expect(authorityKeyOfProject('loopback|/srv/app')).toBe('loopback');
    expect(targetFolderKeyOf('loopback|/srv/app')).toBe('/srv/app');
    expect(authorityKeyOfProject('ssh+5f3c1e|/srv/a|b')).toBe('ssh+5f3c1e');
    expect(targetFolderKeyOf('ssh+5f3c1e|/srv/a|b')).toBe('/srv/a|b');
  });

  it('reads every local key as local, a POSIX path holding the separator included', () => {
    for (const key of ['/home/a|b', 'c:\\work\\app', '\\\\server\\share\\app', '/loopback|x']) {
      expect(authorityKeyOfProject(key)).toBe('local');
      expect(targetFolderKeyOf(key)).toBeUndefined();
    }
  });

  it('reads a known authority prefix as remote whatever follows it, and builds no key from a folder key that is not absolute', () => {
    expect(authorityKeyOfProject('loopback|')).toBe('loopback');
    expect(targetFolderKeyOf('ssh+5f3c1e|')).toBe('');
    for (const folder of ['', 'srv/app', 'C:app']) expect(() => projectKeyOf({ kind: 'loopback' }, folder)).toThrow('absolute folder key');
    expect(projectKeyOf({ kind: 'wsl', distro: 'Ubuntu' }, '\\\\server\\share')).toBe('wsl+Ubuntu|\\\\server\\share');
  });

  it('finds a path inside a folder in the target flavor, a child named like ..foo included', () => {
    const posix = { os: 'linux' } as const;
    expect(isInsideFolder(posix, '/srv/app', '/srv/app')).toBe(true);
    expect(isInsideFolder(posix, '/srv/app', '/srv/app/..foo/bar')).toBe(true);
    expect(isInsideFolder(posix, '/srv/app', '/srv/other')).toBe(false);
    expect(isInsideFolder(posix, '/srv/app', '/srv')).toBe(false);
    expect(isInsideFolder({ os: 'win32' }, 'C:\\app', 'C:\\app\\..cache')).toBe(true);
    expect(isInsideFolder({ os: 'win32' }, 'C:\\app', 'D:\\app')).toBe(false);
  });

  it('does path arithmetic in the target flavor', () => {
    expect(pathFor({ os: 'win32' })).toBe(path.win32);
    expect(pathFor({ os: 'linux' })).toBe(path.posix);
    expect(pathFor({ os: 'darwin' }).join('/srv/app', 'src', 'a.ts')).toBe('/srv/app/src/a.ts');
    expect(pathFor({ os: 'win32' }).join('C:\\app', 'src/a.ts')).toBe('C:\\app\\src\\a.ts');
  });
});
