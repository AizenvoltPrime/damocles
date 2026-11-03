import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { projectKeyOf } from '../../../shared/project-location';
import type { Project } from '../../local-services/confine';
import { parseTypedPath, typedPathAuthority, typedPathRow, typedPathTarget, type TypedPath, type TypedPathDeps } from '../quick-open-path';
import { testRemote, testWorkspaces, type TestRemote } from './test-workspaces';

describe('parseTypedPath', () => {
  it.each<[string, TypedPath]>([
    ['C:\\x\\y.ts', { form: 'drive', path: 'C:\\x\\y.ts' }],
    ['C:/x/y.ts', { form: 'drive', path: 'C:/x/y.ts' }],
    ['  c:\\x\\y.ts  ', { form: 'drive', path: 'c:\\x\\y.ts' }],
    ['"C:\\Program Files\\x\\a.ts"', { form: 'drive', path: 'C:\\Program Files\\x\\a.ts' }],
    ['"C:\\Program Files\\x\\a.ts":12', { form: 'drive', path: 'C:\\Program Files\\x\\a.ts', line: 12 }],
    ['"C:\\Program Files\\x\\a.ts":12:3', { form: 'drive', path: 'C:\\Program Files\\x\\a.ts', line: 12, column: 3 }],
    // a quoted path is taken verbatim: a suffix inside the quotes is part of the name, and spaces are kept
    ['"C:\\Program Files\\x\\a.ts:12:3"', { form: 'drive', path: 'C:\\Program Files\\x\\a.ts:12:3' }],
    ['"/home/u/a "', { form: 'posix', path: '/home/u/a ' }],
    ['"/home/u/a ":12', { form: 'posix', path: '/home/u/a ', line: 12 }],
    // a ':' with no line after it reads as no position, quoted or not
    ['C:\\x\\a.ts:', { form: 'drive', path: 'C:\\x\\a.ts' }],
    ['"C:\\x\\a.ts":', { form: 'drive', path: 'C:\\x\\a.ts' }],
    // the parser leaves streams and dot segments to the path rules of the OS the path resolves on
    ['C:\\x\\a.ts:stream', { form: 'drive', path: 'C:\\x\\a.ts:stream' }],
    ['C:\\proj\\..\\other\\a.ts', { form: 'drive', path: 'C:\\proj\\..\\other\\a.ts' }],
    ['C:\\x\\y.ts:12', { form: 'drive', path: 'C:\\x\\y.ts', line: 12 }],
    ['C:\\x\\y.ts:12:3', { form: 'drive', path: 'C:\\x\\y.ts', line: 12, column: 3 }],
    // VS Code reads the suffix off the filter before its absolute path check, so (12) is a line here too
    ['C:\\x\\y.ts(12)', { form: 'drive', path: 'C:\\x\\y.ts', line: 12 }],
    ['/home/u/a.txt', { form: 'posix', path: '/home/u/a.txt' }],
    ['/mnt/c/Users/x/a.txt:4', { form: 'posix', path: '/mnt/c/Users/x/a.txt', line: 4 }],
    ['/home/u/a.txt(12)', { form: 'posix', path: '/home/u/a.txt', line: 12 }],
    ['/srv/node_modules/@types/x.d.ts', { form: 'posix', path: '/srv/node_modules/@types/x.d.ts' }],
    ['~', { form: 'home', path: '' }],
    ['~/a.txt:12:3', { form: 'home', path: '/a.txt', line: 12, column: 3 }],
    ['~\\a.txt', { form: 'home', path: '\\a.txt' }],
  ])('reads %s', (raw, expected) => {
    expect(parseTypedPath(raw)).toEqual(expected);
  });

  it.each([
    ['a mention', '@C:\\x\\y.ts'],
    ['a quoted mention', '"@C:\\x\\y.ts"'],
    ['a quoted mention with a position', '"@C:\\x\\y.ts":12'],
    ['a UNC path with mixed slashes', '\\/server/share/x'],
    ['a UNC path', '\\\\server\\share\\x.ts'],
    ['a UNC path with forward slashes', '//server/share/x.ts'],
    ['a device path', '\\\\?\\C:\\x.ts'],
    ['a device namespace path', '\\\\.\\pipe\\x'],
    ['a quoted UNC path', '"\\\\server\\share\\x.ts"'],
    ['a drive-relative path', 'C:x.ts'],
    ['a drive alone', 'C:'],
    ['a root-relative path', '\\x\\y.ts'],
    ['a control character', '/home/u/a\u0007.txt'],
    ['a newline', 'C:\\x\\a\n.txt'],
    ['a C1 control character', '/home/u/a\u0085.txt'],
    ['a quote left open', '"C:\\x\\y.ts'],
    ['text after the closing quote', '"C:\\x\\y.ts" more'],
    ['a mention after the closing quote', '"C:\\x\\y.ts"@'],
    ['a quoted path that starts with a space', '" C:\\x\\a.ts "'],
    ['a quoted path that starts with a space, with a position', '" C:\\x\\a.ts ":12'],
    ['a relative path', 'src/a.ts'],
    ['another user\'s home', '~root/.bashrc'],
    ['a plain query', 'editor-pane'],
  ])('refuses %s', (_name, raw) => {
    expect(parseTypedPath(raw)).toBeUndefined();
  });
});

describe('typedPathAuthority', () => {
  const machines = (local: NodeJS.Platform, hosts: Readonly<Record<string, NodeJS.Platform>>) => (authority: string): NodeJS.Platform | undefined => (authority === 'local' ? local : hosts[authority]);
  const typed = (raw: string): TypedPath => parseTypedPath(raw)!;

  it.each<[string, string, string | undefined, NodeJS.Platform, Record<string, NodeJS.Platform>, string | undefined]>([
    ['a drive path with a POSIX host selected', 'C:\\x\\a.ts', 'ssh+h', 'win32', { 'ssh+h': 'linux' }, 'local'],
    ['a POSIX path with a POSIX host selected', '/home/u/a.txt', 'ssh+h', 'win32', { 'ssh+h': 'linux' }, 'ssh+h'],
    ['/mnt/c with a WSL project selected', '/mnt/c/Users/x/a.txt', 'wsl+Ubuntu', 'win32', { 'wsl+Ubuntu': 'linux' }, 'wsl+Ubuntu'],
    ['/mnt/c with a local Windows project selected', '/mnt/c/Users/x/a.txt', 'local', 'win32', { 'wsl+Ubuntu': 'linux' }, undefined],
    ['a drive path with a local Windows project selected', 'C:\\x\\a.ts', 'local', 'win32', {}, 'local'],
    ['a POSIX path with a Windows host selected from Linux', '/etc/hosts', 'ssh+w', 'linux', { 'ssh+w': 'win32' }, 'local'],
    ['a drive path with a Windows host selected from Linux', 'C:\\x\\a.ts', 'ssh+w', 'linux', { 'ssh+w': 'win32' }, 'ssh+w'],
    ['a drive path on Linux with a POSIX host selected', 'C:\\x\\a.ts', 'ssh+h', 'linux', { 'ssh+h': 'linux' }, undefined],
    ['~/ with a POSIX host selected', '~/a.txt', 'ssh+h', 'win32', { 'ssh+h': 'linux' }, 'ssh+h'],
    ['~\\ with a POSIX host selected', '~\\a.txt', 'ssh+h', 'win32', { 'ssh+h': 'linux' }, 'local'],
    ['~\\ on Linux with a POSIX host selected', '~\\a.txt', 'ssh+h', 'linux', { 'ssh+h': 'linux' }, undefined],
    ['~/ with nothing selected', '~/a.txt', undefined, 'darwin', {}, 'local'],
    ['a path for a host whose OS is not known', '/home/u/a.txt', 'ssh+gone', 'linux', {}, 'local'],
    // win32 would read it as a UNC path; only POSIX rules take it, as a POSIX path
    ['/\\server\\share on Windows with nothing selected', '/\\server\\share\\x', undefined, 'win32', {}, undefined],
    ['/\\server\\share on Windows with a local project selected', '/\\server\\share\\x', 'local', 'win32', {}, undefined],
  ])('targets %s', (_name, raw, selected, local, hosts, expected) => {
    expect(typedPathAuthority(typed(raw), selected, machines(local, hosts))).toBe(expected);
  });
});

describe('typedPathTarget', () => {
  const on = (os: NodeJS.Platform) => ({ authorityOs: () => os, homedir: () => (os === 'win32' ? 'C:\\Users\\u' : '/home/u') });

  it('resolves the dot segments of a win32 path by text, as Windows does', () => {
    expect(typedPathTarget('C:\\proj\\..\\other\\.\\a.ts:4', undefined, on('win32'))).toEqual({ authority: 'local', os: 'win32', path: 'C:\\other\\a.ts', line: 4 });
    expect(typedPathTarget('~\\..\\v\\a.ts', undefined, on('win32'))).toEqual({ authority: 'local', os: 'win32', path: 'C:\\Users\\v\\a.ts' });
  });

  it('keeps the dot segments of a POSIX path, which the kernel resolves after following links', () => {
    expect(typedPathTarget('/home/u/proj/../a.ts', undefined, on('linux'))).toEqual({ authority: 'local', os: 'linux', path: '/home/u/proj/../a.ts' });
    expect(typedPathTarget('~/./a.ts', undefined, on('linux'))).toEqual({ authority: 'local', os: 'linux', path: '/home/u/./a.ts' });
  });
});

describe('typedPathRow', () => {
  let root: string;
  let home: string;
  let hostHome: string;
  let file: string;
  let project: Project;
  let hostProject: Project;
  let remote: TestRemote | undefined;
  let deps: TypedPathDeps;

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-typed-')));
    home = path.join(root, 'home');
    hostHome = path.join(root, 'host-home');
    const projectDir = path.join(root, 'proj');
    for (const folder of [home, hostHome, path.join(projectDir, 'src'), path.join(root, 'elsewhere')]) fs.mkdirSync(folder, { recursive: true });
    file = path.join(root, 'elsewhere', 'notes.txt');
    fs.writeFileSync(file, 'notes\n');
    fs.writeFileSync(path.join(projectDir, 'src', 'app.ts'), '');
    fs.writeFileSync(path.join(home, 'mine.txt'), '');
    fs.writeFileSync(path.join(hostHome, 'theirs.txt'), '');
    project = { key: folderKey(projectDir), fsPath: projectDir, name: 'proj' };
    // the loopback host serves this computer's disk, under its own project key
    hostProject = { key: projectKeyOf({ kind: 'loopback' }, folderKey(projectDir)), fsPath: projectDir, name: 'proj' };
    remote = testRemote({ watchers: createFakePlatform().fileWatchers });
    deps = {
      projects: () => [project, hostProject],
      workspaces: testWorkspaces({ watchers: createFakePlatform().fileWatchers, remote: () => remote!.workspace() }),
      authorityOs: () => process.platform,
      homedir: (authority) => (authority === 'local' ? home : remote && authority === 'loopback' ? hostHome : undefined),
      hostName: (authority) => (authority === 'loopback' ? 'Local daemon' : authority),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    remote?.disconnect('the test ended');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('answers a file outside every project with the path row on the selected project\'s authority, named with its host', async () => {
    expect(await typedPathRow(`${file}:12:4`, project.key, deps)).toEqual({
      result: { kind: 'path', authority: 'local', path: file, label: 'notes.txt', description: path.dirname(file), labelMatches: [[0, 9]], descriptionMatches: [[0, path.dirname(file).length]], recent: false },
      line: 12,
      column: 4,
    });
    expect(await typedPathRow(file, hostProject.key, deps)).toMatchObject({ result: { kind: 'path', authority: 'loopback', path: file, host: 'Local daemon' } });
  });

  it('answers a file inside a root with that root\'s project row', async () => {
    const answer = await typedPathRow(path.join(project.fsPath, 'src', 'app.ts'), project.key, deps);
    expect(answer).toEqual({ result: { kind: 'project', projectKey: project.key, projectName: 'proj', relativePath: 'src/app.ts', label: 'app.ts', description: 'src', labelMatches: [[0, 6]], descriptionMatches: [[0, 3]], recent: false } });
    expect(await typedPathRow(path.join(project.fsPath, 'src', 'app.ts'), hostProject.key, deps)).toMatchObject({ result: { kind: 'project', projectKey: hostProject.key } });
  });

  it('expands ~ with the home folder of the authority it targets', async () => {
    expect(await typedPathRow('~/mine.txt', project.key, deps)).toMatchObject({ result: { authority: 'local', path: path.join(home, 'mine.txt') } });
    expect(await typedPathRow('~/theirs.txt', hostProject.key, deps)).toMatchObject({ result: { authority: 'loopback', path: path.join(hostHome, 'theirs.txt') } });
    expect(await typedPathRow('~/theirs.txt', project.key, deps)).toBeUndefined();
  });

  it('gives no row for a folder, a missing file, or the selected host while it is not connected, and never falls back to this computer then', async () => {
    expect(await typedPathRow(path.dirname(file), project.key, deps)).toBeUndefined();
    expect(await typedPathRow(path.join(root, 'elsewhere', 'gone.txt'), project.key, deps)).toBeUndefined();
    remote!.disconnect('network');
    expect(await typedPathRow(file, hostProject.key, deps)).toBeUndefined();
    expect(await typedPathRow('~/mine.txt', hostProject.key, deps)).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')('answers a file of a project on a mapped drive, whose realpath is a share\'s, with its project row, and nothing outside every project there', async () => {
    // root as a mapped drive of \\server\share: a realpath under it answers the share's spelling, which a stat maps back
    const share = '\\\\server\\share';
    const realpath = fs.promises.realpath.bind(fs.promises);
    vi.spyOn(fs.promises, 'realpath').mockImplementation((async (file: fs.PathLike) => {
      const real = await realpath(String(file).startsWith(share) ? `${root}${String(file).slice(share.length)}` : file);
      return real.toLowerCase().startsWith(`${root.toLowerCase()}\\`) ? `${share}${real.slice(root.length)}` : real;
    }) as typeof fs.promises.realpath);
    const stat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (file: fs.PathLike, options?: fs.StatOptions) => stat(String(file).startsWith(share) ? `${root}${String(file).slice(share.length)}` : file, options)) as typeof fs.promises.stat);
    expect(await typedPathRow(path.join(project.fsPath, 'src', 'app.ts'), project.key, deps)).toMatchObject({ result: { kind: 'project', projectKey: project.key, relativePath: 'src/app.ts' } });
    expect(await typedPathRow(path.join(project.fsPath, 'src'), project.key, deps)).toBeUndefined();
    expect(await typedPathRow(file, project.key, deps)).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')('gives no row for a UNC or device path, asking the file system nothing', async () => {
    const files = { ...deps.workspaces.local.files, resolveOutside: () => Promise.reject(new Error('no file system call is expected')) };
    const local = { ...deps.workspaces.local, files };
    const quiet: TypedPathDeps = { ...deps, workspaces: { ...deps.workspaces, local, forAuthority: () => local } };
    for (const raw of ['\\\\server\\share\\x.txt', '\\\\?\\C:\\x.txt', '\\\\.\\C:\\x.txt', 'C:x.txt']) expect(await typedPathRow(raw, project.key, quiet), raw).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')('gives no row for an NTFS stream, inside a project or outside every one, with no file system call', async () => {
    const calls = (['lstat', 'realpath', 'stat'] as const).map((name) => vi.spyOn(fs.promises, name));
    expect(await typedPathRow(`${file}:stream`, project.key, deps)).toBeUndefined();
    expect(await typedPathRow(`${path.join(project.fsPath, 'src', 'app.ts')}:stream`, project.key, deps)).toBeUndefined();
    for (const call of calls) expect(call).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')('resolves the dot segments of a win32 path by text, to a project row or a path row', async () => {
    expect(await typedPathRow(`${project.fsPath}\\src\\.\\app.ts`, project.key, deps)).toMatchObject({ result: { kind: 'project', projectKey: project.key, relativePath: 'src/app.ts' } });
    expect(await typedPathRow(`${project.fsPath}\\..\\elsewhere\\notes.txt`, project.key, deps)).toMatchObject({ result: { kind: 'path', authority: 'local', path: file } });
  });

  it.runIf(process.platform !== 'win32')('gives no row for a POSIX path with a dot segment', async () => {
    expect(await typedPathRow(`${project.fsPath}/src/./app.ts`, project.key, deps)).toBeUndefined();
    expect(await typedPathRow(`${project.fsPath}/../elsewhere/notes.txt`, project.key, deps)).toBeUndefined();
  });
});
