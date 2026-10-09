import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { MAX_TERMINAL_LINK_PATH_LENGTH } from '../../preload/terminal-channels';
import type { Project } from '../documents/confine';
import {
  folderLinkAction,
  LINK_CACHE_TTL_MS,
  linkPathStyle,
  linkRelativePath,
  resolveTerminalLink,
  TerminalLinkCache,
  TerminalLinks,
  type LinkBase,
} from '../terminal/terminal-links';

const WIN: LinkBase = { project: { key: 'c:\\work\\proj', fsPath: 'C:\\work\\proj', name: 'proj' }, baseDir: 'C:\\work\\proj', style: 'win32' };
const WSL: LinkBase = { ...WIN, style: 'wsl' };
const POSIX: LinkBase = { project: { key: '/home/u/proj', fsPath: '/home/u/proj', name: 'proj' }, baseDir: '/home/u/proj', style: 'posix' };

describe('lexical link paths', () => {
  it('picks the path style from the platform and the shell executable, whatever the profile is called', () => {
    expect(linkPathStyle('win32', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('win32');
    expect(linkPathStyle('win32', 'C:\\Git\\bin\\bash.exe')).toBe('win32');
    expect(linkPathStyle('win32', 'C:\\Windows\\System32\\wsl.exe')).toBe('wsl');
    expect(linkPathStyle('win32', 'C:\\Windows\\System32\\WSL.EXE')).toBe('wsl');
    expect(linkPathStyle('linux', '/usr/bin/bash')).toBe('posix');
    expect(linkPathStyle('darwin', '/bin/zsh')).toBe('posix');
  });

  it.each([
    ['src/app.ts', 'src/app.ts'],
    ['src\\app.ts', 'src/app.ts'],
    ['./src/app.ts', 'src/app.ts'],
    ['src/../lib/a.ts', 'lib/a.ts'],
    ['C:\\work\\proj\\src\\a.ts', 'src/a.ts'],
    ['c:/WORK/proj/src/a.ts', 'src/a.ts'],
    ['.', ''],
  ])('Windows: %j is %j inside the project', (candidate, relative) => {
    expect(linkRelativePath(candidate, WIN)).toBe(relative);
  });

  it.each([
    '../x.ts',
    'src/../../x.ts',
    '..',
    'C:\\work\\other\\a.ts',
    'C:\\work\\proj2\\a.ts',
    'D:\\work\\proj\\a.ts',
    '\\\\server\\share\\a.ts',
    '//server/share/a.ts',
    '\\\\?\\C:\\work\\proj\\a.ts',
    '//?/C:/work/proj/a.ts',
    '\\\\.\\C:\\work\\proj\\a.ts',
    '\\\\wsl$\\Ubuntu\\home\\a',
    'C:foo.ts',
    'C:',
    '\\work\\proj\\a.ts',
    '/work/proj/a.ts',
    '/c/work/proj/a.ts',
    '~/a.ts',
    'a\0b',
    '',
    'a'.repeat(MAX_TERMINAL_LINK_PATH_LENGTH + 1),
  ])('Windows: %j is never a link', (candidate) => {
    expect(linkRelativePath(candidate, WIN)).toBeUndefined();
  });

  it('WSL: /mnt/<drive>/ maps to the drive, relative paths resolve in the project, and nothing else is a link', () => {
    expect(linkRelativePath('/mnt/c/work/proj/src/a.ts', WSL)).toBe('src/a.ts');
    expect(linkRelativePath('/mnt/C/work/proj', WSL)).toBe('');
    expect(linkRelativePath('src/a.ts', WSL)).toBe('src/a.ts');
    for (const candidate of [
      '/mnt/c',
      '/mnt/c/work/other/a.ts',
      '/mnt/d/work/proj/a.ts',
      '/mnt/cc/work/proj/a.ts',
      '/mnt/c:/work/proj/a.ts',
      '/home/u/a.ts',
      '/etc/passwd',
      '/mnt/c/work/proj/../other/a.ts',
      '//wsl$/Ubuntu/home/a',
      'src\\a.ts',
      'C:\\work\\proj\\a.ts',
      '../a.ts',
      '~/a.ts',
    ]) expect(linkRelativePath(candidate, WSL), candidate).toBeUndefined();
  });

  it('macOS and Linux: absolute paths inside the project are links, any other absolute path is not', () => {
    expect(linkRelativePath('/home/u/proj/src/a.ts', POSIX)).toBe('src/a.ts');
    expect(linkRelativePath('src/a.ts', POSIX)).toBe('src/a.ts');
    for (const candidate of ['/etc/passwd', '/home/u/proj2/a.ts', '/home/u/a.ts', '../a.ts', 'src/../../a.ts', '~/proj/a.ts']) {
      expect(linkRelativePath(candidate, POSIX), candidate).toBeUndefined();
    }
  });

  it('resolves relative paths against the base directory, still confined to the project', () => {
    const inSrc: LinkBase = { ...WIN, baseDir: 'C:\\work\\proj\\src' };
    expect(linkRelativePath('app.ts', inSrc)).toBe('src/app.ts');
    expect(linkRelativePath('../lib/a.ts', inSrc)).toBe('lib/a.ts');
    expect(linkRelativePath('../../x.ts', inSrc)).toBeUndefined();
  });
});

describe('confirmed links', () => {
  let root: string;
  let projectDir: string;
  let outside: string;
  let base: LinkBase;
  const lines: string[] = [];
  const log = (line: string): void => {
    lines.push(line);
  };

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-links-')));
    projectDir = path.join(root, 'proj');
    outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(projectDir, 'src', 'app.ts'), 'x');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    fs.symlinkSync(outside, path.join(projectDir, 'out'), 'junction');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(projectDir, 'link.txt'), 'file');
    fs.symlinkSync(path.join(projectDir, 'src', 'app.ts'), path.join(projectDir, 'inner.ts'), 'file');
    const project: Project = { key: folderKey(projectDir), fsPath: projectDir, name: 'proj' };
    base = { project, baseDir: projectDir, style: process.platform === 'win32' ? 'win32' : 'posix' };
    lines.length = 0;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('answers only files and folders that exist inside the project after every link is followed', async () => {
    const links = new TerminalLinks(log);
    const candidates = [
      'src/app.ts',
      'src',
      path.join(projectDir, 'src', 'app.ts'),
      'inner.ts',
      'missing.ts',
      '../outside/secret.txt',
      path.join(outside, 'secret.txt'),
      'out/secret.txt',
      'out',
      'link.txt',
    ];
    expect(await links.resolveAll(candidates, base)).toEqual(['file', 'folder', 'file', 'file', null, null, null, null, null, null]);
    expect(lines).toEqual([]);
  });

  it('touches no file system for a path it refuses lexically, so a UNC path never opens a network session', async () => {
    const realpath = vi.spyOn(fs.promises, 'realpath');
    const stat = vi.spyOn(fs.promises, 'stat');
    const lstat = vi.spyOn(fs.promises, 'lstat');
    try {
      const windowsOnly = process.platform === 'win32' ? ['\\\\server\\share\\a.ts', '//host/x', 'C:foo', '\\\\?\\UNC\\host\\x'] : [];
      for (const candidate of [...windowsOnly, path.join(outside, 'secret.txt'), '../outside/secret.txt']) {
        expect(await resolveTerminalLink(candidate, base, log), candidate).toBeNull();
      }
      expect(await resolveTerminalLink('/mnt/c/x', { ...base, baseDir: projectDir, style: 'wsl' }, log)).toBeNull();
      expect(realpath).not.toHaveBeenCalled();
      expect(stat).not.toHaveBeenCalled();
      expect(lstat).not.toHaveBeenCalled();
      expect(await resolveTerminalLink('src/app.ts', base, log)).toEqual({ kind: 'file', relativePath: 'src/app.ts' });
      expect(realpath).toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.runIf(process.platform === 'win32')('never follows a project link to a UNC share, so hovering it opens no network session', async () => {
    const link = path.join(projectDir, 'share');
    fs.symlinkSync(path.join(projectDir, 'src'), link, 'junction');
    const readlink = fs.promises.readlink.bind(fs.promises);
    vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) => (folderKey(String(file)) === folderKey(link) ? '\\\\server\\share' : readlink(file))) as typeof fs.promises.readlink);
    const lstatOf = fs.promises.lstat.bind(fs.promises);
    const remote: string[] = [];
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (file: fs.PathLike, options?: fs.StatOptions) => {
      if (String(file).startsWith('\\\\')) {
        remote.push(String(file));
        throw new Error('network');
      }
      return lstatOf(file, options);
    }) as typeof fs.promises.lstat);
    const realpath = vi.spyOn(fs.promises, 'realpath');
    const stat = vi.spyOn(fs.promises, 'stat');
    try {
      expect(await resolveTerminalLink('share/app.ts', base, log)).toBeNull();
      expect(await resolveTerminalLink('share', base, log)).toBeNull();
      expect(remote).toEqual([]);
      expect(realpath).not.toHaveBeenCalled();
      expect(stat).not.toHaveBeenCalled();
      expect(lines).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('gives the project-relative path a click opens', async () => {
    expect(await resolveTerminalLink('src/app.ts', base, log)).toEqual({ kind: 'file', relativePath: 'src/app.ts' });
    expect(await resolveTerminalLink('.', base, log)).toEqual({ kind: 'folder', relativePath: '' });
    const inSrc: LinkBase = { ...base, baseDir: path.join(projectDir, 'src') };
    expect(await resolveTerminalLink('app.ts', inSrc, log)).toEqual({ kind: 'file', relativePath: 'src/app.ts' });
    expect(await resolveTerminalLink('../../outside/secret.txt', inSrc, log)).toBeNull();
  });

  it.runIf(process.platform === 'win32')('maps a WSL terminal\'s /mnt/<drive>/ path to the Windows file', async () => {
    const drive = projectDir[0]!.toLowerCase();
    const mounted = `/mnt/${drive}${projectDir.slice(2).split('\\').join('/')}/src/app.ts`;
    const wsl: LinkBase = { ...base, style: 'wsl' };
    expect(await resolveTerminalLink(mounted, wsl, log)).toEqual({ kind: 'file', relativePath: 'src/app.ts' });
    expect(await resolveTerminalLink(`/mnt/${drive}${outside.slice(2).split('\\').join('/')}/secret.txt`, wsl, log)).toBeNull();
  });

  it('keeps a hover answer for the TTL, while an open resolves again', async () => {
    let now = 0;
    const links = new TerminalLinks(log, new TerminalLinkCache(() => now));
    expect(await links.resolveAll(['src/app.ts'], base)).toEqual(['file']);
    fs.rmSync(path.join(projectDir, 'src', 'app.ts'));
    expect(await links.resolveAll(['src/app.ts'], base)).toEqual(['file']);
    expect(await links.resolveFresh('src/app.ts', base)).toBeNull();
    expect(await links.resolveAll(['src/app.ts'], base)).toEqual([null]);
    fs.writeFileSync(path.join(projectDir, 'src', 'app.ts'), 'x');
    now += LINK_CACHE_TTL_MS;
    expect(await links.resolveAll(['src/app.ts'], base)).toEqual(['file']);
  });

  it('never answers one base directory or path style with another\'s entry', async () => {
    const links = new TerminalLinks(log);
    const inSrc: LinkBase = { ...base, baseDir: path.join(projectDir, 'src') };
    expect(await links.resolveAll(['app.ts'], inSrc)).toEqual(['file']);
    expect(await links.resolveAll(['app.ts'], base)).toEqual([null]);
  });
});

describe('link cache', () => {
  it('expires entries after the TTL and evicts the least recently used past its size', () => {
    let now = 1000;
    const cache = new TerminalLinkCache(() => now, 3);
    const file = { kind: 'file', relativePath: 'a' } as const;
    cache.set('a', file);
    cache.set('b', null);
    cache.set('c', file);
    expect(cache.get('a')).toEqual(file);
    cache.set('d', file);
    expect(cache.size).toBe(3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toEqual(file);
    now += LINK_CACHE_TTL_MS - 1;
    expect(cache.get('c')).toEqual(file);
    now += 1;
    expect(cache.get('c')).toBeUndefined();
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe('folder links', () => {
  const api: Project = { key: 'c:\\work\\api', fsPath: 'C:\\work\\api', name: 'api' };

  it('reveal in Files while Files shows the link\'s project', () => {
    expect(folderLinkAction(api, 'src/routes', api.key)).toEqual({ kind: 'reveal', file: { projectKey: api.key, relativePath: 'src/routes' } });
  });

  it('open Quick Open on that folder of that project when Files shows another one, or none', () => {
    expect(folderLinkAction(api, 'src/routes', 'c:\\work\\web')).toEqual({ kind: 'quickOpen', scope: { projectKey: api.key, projectName: 'api', folder: 'src/routes/' } });
    expect(folderLinkAction(api, '', undefined)).toEqual({ kind: 'quickOpen', scope: { projectKey: api.key, projectName: 'api', folder: '' } });
  });
});
