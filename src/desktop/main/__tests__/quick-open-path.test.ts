import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { projectKeyOf } from '../../../shared/project-location';
import type { Project } from '../../local-services/confine';
import { parseTypedPath, typedInput, typedPathAuthority, typedPathRowsAt, typedPathTarget, type ListingCache, type TypedPath, type TypedPathDeps, type TypedPathRows } from '../quick-open-path';
import type { ProjectWorkspace } from '../../workspace/project-workspace';
import { quickOpenRowKey } from '../../preload/overlay-channels';
import { ListingUnsupportedError } from '../workspace/remote-workspace';
import { RootSpellings } from '../workspace/root-spellings';
import { testRemote, testWorkspaces, type TestRemote } from './test-workspaces';

describe('parseTypedPath', () => {
  it.each<[string, TypedPath]>([
    ['C:\\x\\y.ts', { form: 'drive', path: 'C:\\x\\y.ts' }],
    ['C:/x/y.ts', { form: 'drive', path: 'C:/x/y.ts' }],
    ['  c:\\x\\y.ts  ', { form: 'drive', path: 'c:\\x\\y.ts' }],
    ['"C:\\Program Files\\x\\a.ts"', { form: 'drive', path: 'C:\\Program Files\\x\\a.ts', quoted: true }],
    ['"C:\\Program Files\\x\\a.ts":12', { form: 'drive', path: 'C:\\Program Files\\x\\a.ts', line: 12, quoted: true }],
    ['"C:\\Program Files\\x\\a.ts":12:3', { form: 'drive', path: 'C:\\Program Files\\x\\a.ts', line: 12, column: 3, quoted: true }],
    // a quoted path is taken verbatim: a suffix inside the quotes is part of the name, and spaces are kept
    ['"C:\\Program Files\\x\\a.ts:12:3"', { form: 'drive', path: 'C:\\Program Files\\x\\a.ts:12:3', quoted: true }],
    ['"/home/u/a "', { form: 'posix', path: '/home/u/a ', quoted: true }],
    ['"/home/u/a ":12', { form: 'posix', path: '/home/u/a ', line: 12, quoted: true }],
    // a ':' with no line after it reads as no position, quoted or not
    ['C:\\x\\a.ts:', { form: 'drive', path: 'C:\\x\\a.ts' }],
    ['"C:\\x\\a.ts":', { form: 'drive', path: 'C:\\x\\a.ts', quoted: true }],
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
    // a UNC path names a file only where a local project's spelling holds it
    ['\\\\server\\share\\x.ts', { form: 'unc', path: '\\\\server\\share\\x.ts' }],
    ['//server/share/x.ts:4', { form: 'unc', path: '//server/share/x.ts', line: 4 }],
    ['\\/server/share/x', { form: 'unc', path: '\\/server/share/x' }],
    ['/\\server\\share\\x', { form: 'unc', path: '/\\server\\share\\x' }],
    ['"\\\\server\\share\\x.ts"', { form: 'unc', path: '\\\\server\\share\\x.ts', quoted: true }],
    ['\\\\wsl$\\Ubuntu\\home\\a.ts', { form: 'unc', path: '\\\\wsl$\\Ubuntu\\home\\a.ts' }],
    ['\\\\server\\share', { form: 'unc', path: '\\\\server\\share' }],
  ])('reads %s', (raw, expected) => {
    expect(parseTypedPath(raw)).toEqual(expected);
  });

  it.each([
    ['a mention', '@C:\\x\\y.ts'],
    ['a quoted mention', '"@C:\\x\\y.ts"'],
    ['a quoted mention with a position', '"@C:\\x\\y.ts":12'],
    ['a device path', '\\\\?\\C:\\x.ts'],
    ['a device path with forward slashes', '//?/C:/x.ts'],
    ['a device namespace path', '\\\\.\\pipe\\x'],
    ['a device namespace path alone', '\\\\.'],
    ['a quoted device path', '"\\\\?\\C:\\x.ts"'],
    ['a server with no share', '\\\\server'],
    ['a server with an empty share', '\\\\server\\'],
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
    ['a UNC path with a POSIX host selected', '\\\\server\\share\\a.ts', 'ssh+h', 'win32', { 'ssh+h': 'linux' }, 'local'],
    ['a UNC path on Linux', '//server/share/a.ts', undefined, 'linux', {}, undefined],
    ['a path for a host whose OS is not known', '/home/u/a.txt', 'ssh+gone', 'linux', {}, 'local'],
  ])('targets %s', (_name, raw, selected, local, hosts, expected) => {
    expect(typedPathAuthority(typed(raw), selected, machines(local, hosts))).toBe(expected);
  });
});

describe('typedPathTarget', () => {
  const on = (os: NodeJS.Platform) => ({ authorityOs: () => os, homedir: () => (os === 'win32' ? 'C:\\Users\\u' : '/home/u') });

  it('resolves the dot segments of a win32 path by text, as Windows does', () => {
    expect(typedPathTarget('C:\\proj\\..\\other\\.\\a.ts:4', undefined, on('win32'))).toEqual({
      authority: 'local',
      os: 'win32',
      path: 'C:\\other\\a.ts',
      line: 4,
      split: { folderText: 'C:\\proj\\..\\other\\.\\', folder: 'C:\\other\\', segment: 'a.ts' },
    });
    expect(typedPathTarget('~\\..\\v\\a.ts', undefined, on('win32'))).toEqual({
      authority: 'local',
      os: 'win32',
      path: 'C:\\Users\\v\\a.ts',
      split: { folderText: '~\\..\\v\\', folder: 'C:\\Users\\v\\', segment: 'a.ts' },
    });
  });

  it('keeps the dot segments of a POSIX path, which the kernel resolves after following links, and lists no folder of it', () => {
    expect(typedPathTarget('/home/u/proj/../a.ts', undefined, on('linux'))).toEqual({ authority: 'local', os: 'linux', path: '/home/u/proj/../a.ts' });
    expect(typedPathTarget('~/./a.ts', undefined, on('linux'))).toEqual({ authority: 'local', os: 'linux', path: '/home/u/./a.ts' });
    expect(typedPathTarget('/home/u/..', undefined, on('linux'))?.split).toBeUndefined();
    expect(typedPathTarget('/home/u/../', undefined, on('linux'))?.split).toBeUndefined();
  });

  it.each<[string, NodeJS.Platform, { folderText: string; folder: string; segment: string } | undefined]>([
    ['C:\\a\\', 'win32', { folderText: 'C:\\a\\', folder: 'C:\\a\\', segment: '' }],
    ['C:/a/b', 'win32', { folderText: 'C:/a/', folder: 'C:\\a\\', segment: 'b' }],
    ['~/p/ab', 'linux', { folderText: '~/p/', folder: '/home/u/p/', segment: 'ab' }],
    ['~/', 'linux', { folderText: '~/', folder: '/home/u/', segment: '' }],
    ['/', 'linux', { folderText: '/', folder: '/', segment: '' }],
    ['"C:\\Program Files\\x\\a b":3', 'win32', { folderText: '"C:\\Program Files\\x\\', folder: 'C:\\Program Files\\x\\', segment: 'a b' }],
    // a bare ~ names the home folder itself, whose own folder is not listed
    ['~', 'linux', undefined],
    ['C:\\a\\..', 'win32', undefined],
    // a last segment of '.' starts every dotfile's name
    ['~/.', 'linux', { folderText: '~/', folder: '/home/u/', segment: '.' }],
    ['C:\\x\\.', 'win32', { folderText: 'C:\\x\\', folder: 'C:\\x\\', segment: '.' }],
    ['/home/u/./.', 'linux', undefined],
    // no Windows name holds a ':', which names a stream
    ['C:\\x\\a.txt:stream', 'win32', undefined],
    // no UNC folder is listed
    ['\\\\server\\share\\proj\\', 'win32', undefined],
  ])('splits %s at its last separator', (raw, os, split) => {
    expect(typedPathTarget(raw, undefined, on(os))?.split).toEqual(split);
  });
});

describe('typedInput', () => {
  it.each<[string, string, { input: string; caret?: number } | undefined]>([
    ['C:\\a\\', 'b.txt', { input: 'C:\\a\\b.txt' }],
    ['C:/a/', 'src/', { input: 'C:/a/src/' }],
    ['~/', '.bashrc', { input: '~/.bashrc' }],
    // only the ends are trimmed
    ['/home/u/', ' lead', { input: '/home/u/ lead' }],
    ['/home/u/', 'trail ', { input: '"/home/u/trail "', caret: 15 }],
    ['/home/u/', 'a:12', { input: '"/home/u/a:12"', caret: 13 }],
    ['C:\\x\\', 'a(12)', { input: '"C:\\x\\a(12)"', caret: 11 }],
    ['"C:\\Program Files\\', 'x', { input: '"C:\\Program Files\\x"', caret: 19 }],
    ['"C:\\Program Files\\', 'd\\', { input: '"C:\\Program Files\\d\\"', caret: 20 }],
    // a quote inside unquoted text is part of the path, but a quoted path ends at its first quote, so no query names that
    ['/home/u/', 'say"hi', { input: '/home/u/say"hi' }],
    ['"/home/u/', 'say"hi', undefined],
    // main refuses a query past 512 characters, so no row offers one
    ['/home/u/', 'x'.repeat(504), { input: `/home/u/${'x'.repeat(504)}` }],
    ['/home/u/', 'x'.repeat(505), undefined],
    ['"/home/u/', 'x'.repeat(503), undefined],
  ])('names %s + %s', (folderText, tail, expected) => {
    expect(typedInput(folderText, tail)).toEqual(expected);
  });
});

describe('typedPathRowsAt', () => {
  let root: string;
  let home: string;
  let hostHome: string;
  let elsewhere: string;
  let file: string;
  let project: Project;
  let hostProject: Project;
  let remote: TestRemote | undefined;
  let deps: TypedPathDeps;
  let spellings: RootSpellings;
  // every lookup typedPathRowsAt reported failed
  let reported: unknown[];

  const rowsOf = async (raw: string, selected: string | undefined, over: TypedPathDeps = deps, cache: ListingCache = {}): Promise<TypedPathRows | undefined> => {
    const target = typedPathTarget(raw, selected, over);
    return target && typedPathRowsAt(target, over, cache, (err) => reported.push(err));
  };
  const labels = (rows: TypedPathRows | undefined): string[] => (rows?.results ?? []).map((row) => row.label);
  // the local workspace with some of its files' methods replaced
  const withFiles = (files: Partial<ProjectWorkspace['files']>): TypedPathDeps => {
    const local = { ...deps.workspaces.local, files: { ...deps.workspaces.local.files, ...files } };
    return { ...deps, workspaces: { ...deps.workspaces, local, forAuthority: () => local } };
  };

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-typed-')));
    home = path.join(root, 'home');
    hostHome = path.join(root, 'host-home');
    elsewhere = path.join(root, 'elsewhere');
    const projectDir = path.join(root, 'proj');
    for (const folder of [home, hostHome, path.join(projectDir, 'src'), elsewhere]) fs.mkdirSync(folder, { recursive: true });
    file = path.join(elsewhere, 'notes.txt');
    fs.writeFileSync(file, 'notes\n');
    fs.writeFileSync(path.join(projectDir, 'src', 'app.ts'), '');
    fs.writeFileSync(path.join(home, 'mine.txt'), '');
    fs.writeFileSync(path.join(hostHome, 'theirs.txt'), '');
    project = { key: folderKey(projectDir), fsPath: projectDir, name: 'proj' };
    // the loopback host serves this computer's disk, under its own project key
    hostProject = { key: projectKeyOf({ kind: 'loopback' }, folderKey(projectDir)), fsPath: projectDir, name: 'proj' };
    remote = testRemote({ watchers: createFakePlatform().fileWatchers });
    reported = [];
    const workspaces = testWorkspaces({ watchers: createFakePlatform().fileWatchers, remote: () => remote!.workspace() });
    spellings = new RootSpellings({ os: process.platform, realpath: (folder) => workspaces.local.files.realpath(folder), log: () => undefined });
    deps = {
      projects: () => [project, hostProject],
      workspaces,
      spellings,
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

  it('answers a file outside every project as the first row with its position, once though its folder lists it too', async () => {
    expect(await rowsOf(`${file}:12:4`, project.key)).toEqual({
      results: [
        { kind: 'path', authority: 'local', path: file, label: 'notes.txt', description: elsewhere, labelMatches: [[0, 9]], descriptionMatches: [[0, elsewhere.length]], recent: false, complete: { input: file }, exact: true },
      ],
      line: 12,
      column: 4,
    });
    const onHost = await rowsOf(file, hostProject.key);
    expect(onHost?.results).toHaveLength(1);
    expect(onHost).toMatchObject({ results: [{ kind: 'path', authority: 'loopback', path: file, host: 'Local daemon', complete: { input: file } }] });
  });

  it('answers a file inside a root with that root\'s project row', async () => {
    const app = path.join(project.fsPath, 'src', 'app.ts');
    expect(await rowsOf(app, project.key)).toEqual({
      results: [{ kind: 'project', projectKey: project.key, projectName: 'proj', relativePath: 'src/app.ts', label: 'app.ts', description: 'src', labelMatches: [[0, 6]], descriptionMatches: [[0, 3]], recent: false, complete: { input: app }, exact: true }],
    });
    expect(await rowsOf(app, hostProject.key)).toMatchObject({ results: [{ kind: 'project', projectKey: hostProject.key }] });
  });

  it('lists a typed folder: .. first, then its folders, then its files, hidden ones included, each with the query it leads to', async () => {
    fs.mkdirSync(path.join(elsewhere, 'Sub'));
    for (const name of ['.hidden', 'a.txt', 'Ab.txt']) fs.writeFileSync(path.join(elsewhere, name), '');
    const listed = await rowsOf(`${elsewhere}${path.sep}`, project.key);
    expect(labels(listed)).toEqual(['..', 'Sub', '.hidden', 'a.txt', 'Ab.txt', 'notes.txt']);
    expect(listed?.results.slice(0, 2)).toEqual([
      { kind: 'folder', authority: 'local', label: '..', labelMatches: [], input: `${root}${path.sep}` },
      { kind: 'folder', authority: 'local', label: 'Sub', labelMatches: [], input: `${elsewhere}${path.sep}Sub${path.sep}` },
    ]);
    expect(listed?.results[3]).toEqual({ kind: 'path', authority: 'local', path: path.join(elsewhere, 'a.txt'), label: 'a.txt', description: elsewhere, labelMatches: [], descriptionMatches: [], recent: false, complete: { input: path.join(elsewhere, 'a.txt') } });
    expect(listed).not.toHaveProperty('truncated');
    // the prefix matches case-insensitively and is highlighted; no .. once a name is typed
    const filtered = await rowsOf(path.join(elsewhere, 'A'), project.key);
    expect(labels(filtered)).toEqual(['a.txt', 'Ab.txt']);
    expect(filtered?.results.map((row) => row.labelMatches)).toEqual([[[0, 1]], [[0, 1]]]);
    // a folder typed without a separator is its parent's folder row
    expect(await rowsOf(elsewhere, project.key)).toEqual({ results: [{ kind: 'folder', authority: 'local', label: 'elsewhere', labelMatches: [[0, 9]], input: `${elsewhere}${path.sep}` }] });
  });

  it('keeps a typed position only on the file row it names', async () => {
    const listed = await rowsOf(`${path.join(elsewhere, 'no')}:3`, project.key);
    expect(labels(listed)).toEqual(['notes.txt']);
    expect(listed).not.toHaveProperty('line');
  });

  it('says a folder has no match, and leaves a missing folder or one on a host that is gone to the text search', async () => {
    expect(await rowsOf(path.join(elsewhere, 'zzz'), project.key)).toEqual({ results: [], emptyText: 'folderNoMatch', emptyName: 'zzz' });
    expect(await rowsOf(path.join(root, 'gone', 'x'), project.key)).toBeUndefined();
    remote!.disconnect('network');
    expect(await rowsOf(file, hostProject.key)).toBeUndefined();
    expect(await rowsOf('~/mine.txt', hostProject.key)).toBeUndefined();
  });

  it('lists a file a project holds as that project\'s row', async () => {
    const listed = await rowsOf(`${path.join(project.fsPath, 'src')}${path.sep}`, project.key);
    expect(listed?.results).toEqual([
      { kind: 'folder', authority: 'local', label: '..', labelMatches: [], input: `${project.fsPath}${path.sep}` },
      { kind: 'project', projectKey: project.key, projectName: 'proj', relativePath: 'src/app.ts', label: 'app.ts', description: 'src', labelMatches: [], descriptionMatches: [], recent: false, complete: { input: path.join(project.fsPath, 'src', 'app.ts') } },
    ]);
  });

  it('expands ~ with the home folder of the authority it targets, its .. the absolute folder above it', async () => {
    expect(await rowsOf('~/mine.txt', project.key)).toMatchObject({ results: [{ authority: 'local', path: path.join(home, 'mine.txt'), complete: { input: '~/mine.txt' } }] });
    expect(await rowsOf('~/theirs.txt', hostProject.key)).toMatchObject({ results: [{ authority: 'loopback', path: path.join(hostHome, 'theirs.txt'), host: 'Local daemon' }] });
    expect(await rowsOf('~/theirs.txt', project.key)).toEqual({ results: [], emptyText: 'folderNoMatch', emptyName: 'theirs.txt' });
    fs.mkdirSync(path.join(home, 'p'));
    expect((await rowsOf('~/', project.key))?.results.slice(0, 2)).toEqual([
      { kind: 'folder', authority: 'local', label: '..', labelMatches: [], input: `${root}${path.sep}` },
      { kind: 'folder', authority: 'local', label: 'p', labelMatches: [], input: '~/p/' },
    ]);
    expect((await rowsOf('~/p/', project.key))?.results).toEqual([{ kind: 'folder', authority: 'local', label: '..', labelMatches: [], input: '~/' }]);
  });

  it('quotes a query that would not read back as its path, with the caret before the closing quote, and keeps a quoted one quoted', async () => {
    fs.writeFileSync(path.join(elsewhere, 'x(12)'), '');
    fs.mkdirSync(path.join(elsewhere, 'd(3)'));
    const quotedFile = `"${path.join(elsewhere, 'x(12)')}"`;
    // a folder's query ends with its separator, so a name ending like a position reads back as typed
    const folder = `${path.join(elsewhere, 'd(3)')}${path.sep}`;
    expect((await rowsOf(path.join(elsewhere, 'x'), project.key))?.results).toMatchObject([{ complete: { input: quotedFile, caret: quotedFile.length - 1 } }]);
    expect((await rowsOf(path.join(elsewhere, 'd'), project.key))?.results).toMatchObject([{ kind: 'folder', input: folder }]);
    const notes = `"${file}"`;
    expect((await rowsOf(`"${elsewhere}${path.sep}n"`, project.key))?.results).toMatchObject([{ complete: { input: notes, caret: notes.length - 1 } }]);
  });

  it('gives the file row alone from a daemon that cannot list, and folderDenied for a folder that cannot be read', async () => {
    const unlisted = withFiles({ listOutside: () => Promise.reject(new ListingUnsupportedError('local')) });
    expect(await rowsOf(file, project.key, unlisted)).toEqual({ results: [expect.objectContaining({ kind: 'path', path: file })] });
    expect((await rowsOf(file, project.key, unlisted))?.results[0]).not.toHaveProperty('complete');
    expect(await rowsOf(`${elsewhere}${path.sep}`, project.key, unlisted)).toBeUndefined();
    const denied = withFiles({ listOutside: async () => ({ kind: 'denied' }) });
    expect(await rowsOf(`${elsewhere}${path.sep}`, project.key, denied)).toEqual({ results: [], emptyText: 'folderDenied' });
  });

  it('answers with whichever lookup succeeded and reports the one that failed', async () => {
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const unreadable = withFiles({ resolveOutside: () => Promise.reject(denied), listOutside: async () => ({ kind: 'denied' }) });
    expect(await rowsOf(path.join(elsewhere, 'x'), project.key, unreadable)).toEqual({ results: [], emptyText: 'folderDenied' });
    expect(reported).toEqual([denied]);
    reported.length = 0;
    const broken = new Error('the listing broke');
    const unlisted = withFiles({ listOutside: () => Promise.reject(broken) });
    expect(await rowsOf(file, project.key, unlisted)).toEqual({ results: [expect.objectContaining({ kind: 'path', path: file, exact: true })] });
    expect(reported).toEqual([broken]);
  });

  it('shows a file once when a link leads to it, and the typed file once when the listing spells it another way', async () => {
    fs.symlinkSync(file, path.join(elsewhere, 'to-notes'), 'file');
    const listed = await rowsOf(`${elsewhere}${path.sep}`, project.key);
    expect(labels(listed)).toEqual(['..', 'notes.txt']);
    if (process.platform === 'win32') {
      // the typed spelling maps to the project by its letters, the listing by the realpath
      const typed = await rowsOf(path.join(project.fsPath, 'SRC', 'app.ts'), project.key);
      expect(typed?.results).toEqual([expect.objectContaining({ kind: 'project', relativePath: 'SRC/app.ts', exact: true, complete: { input: path.join(project.fsPath, 'SRC', 'app.ts') } })]);
    }
    expect(reported).toEqual([]);
  });

  it('caps a listing answer at the listing bound and says it is truncated', async () => {
    const entries = Array.from({ length: 1000 }, (_, index) => ({ name: `f${index}`, kind: 'file' as const, link: false }));
    const many = withFiles({ listOutside: async (folder) => ({ kind: 'folder', path: folder, entries, truncated: false }) });
    const listed = await rowsOf(`${elsewhere}${path.sep}`, project.key, many);
    expect(listed?.results).toHaveLength(1000);
    expect(listed?.results[0]?.label).toBe('..');
    expect(listed?.truncated).toEqual({ listed: 999 });
  });

  it('counts a typed file row among the listed entries of a cut listing only when it took a listed entry\'s place', async () => {
    const cut = (entries: Array<{ name: string; kind: 'file'; link: false }>) => withFiles({ listOutside: async (folder) => ({ kind: 'folder', path: folder, entries, truncated: true }) });
    expect((await rowsOf(file, project.key, cut([])))?.truncated).toEqual({ listed: 0 });
    expect((await rowsOf(file, project.key, cut([{ name: 'notes.txt', kind: 'file', link: false }])))?.truncated).toEqual({ listed: 1 });
  });

  it.runIf(process.platform === 'win32')('answers a file of a project on a mapped drive, whose realpath is a share\'s, with its project row, and lists nothing there', async () => {
    // root as a mapped drive of \\server\share: a realpath under it answers the share's spelling, which a stat maps back
    const share = '\\\\server\\share';
    const realpath = fs.promises.realpath.bind(fs.promises);
    vi.spyOn(fs.promises, 'realpath').mockImplementation((async (target: fs.PathLike) => {
      const real = await realpath(String(target).startsWith(share) ? `${root}${String(target).slice(share.length)}` : target);
      return real.toLowerCase().startsWith(`${root.toLowerCase()}\\`) ? `${share}${real.slice(root.length)}` : real;
    }) as typeof fs.promises.realpath);
    const stat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (target: fs.PathLike, options?: fs.StatOptions) => stat(String(target).startsWith(share) ? `${root}${String(target).slice(share.length)}` : target, options)) as typeof fs.promises.stat);
    expect(await rowsOf(path.join(project.fsPath, 'src', 'app.ts'), project.key)).toEqual({ results: [expect.objectContaining({ kind: 'project', projectKey: project.key, relativePath: 'src/app.ts' })] });
    expect(await rowsOf(path.join(project.fsPath, 'src'), project.key)).toBeUndefined();
    expect(await rowsOf(file, project.key)).toBeUndefined();
    // the share's spelling of the project's file is the same project row, and no folder of the share is listed
    await spellings.retain([project, hostProject]);
    const byDrive = await rowsOf(path.join(project.fsPath, 'src', 'app.ts'), project.key);
    const byShare = await rowsOf(`${share}${project.fsPath.slice(root.length)}\\src\\app.ts`, project.key);
    expect(byShare).toEqual({ results: [{ kind: 'project', projectKey: project.key, projectName: 'proj', relativePath: 'src/app.ts', label: 'app.ts', description: 'src', labelMatches: [[0, 6]], descriptionMatches: [[0, 3]], recent: false, exact: true }] });
    expect(byShare?.results[0] && quickOpenRowKey(byShare.results[0])).toEqual(byDrive?.results[0] && quickOpenRowKey(byDrive.results[0]));
    expect(await rowsOf(`${share}${project.fsPath.slice(root.length)}\\src\\`, project.key)).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')('answers a \\\\wsl$ path of a \\\\wsl.localhost project with its project row', async () => {
    const wsl: Project = { key: folderKey('\\\\wsl.localhost\\Ubuntu\\home\\me'), fsPath: '\\\\wsl.localhost\\Ubuntu\\home\\me', name: 'me' };
    const calls: string[] = [];
    const onWsl = withFiles({
      confineExisting: async (owner, relativePath) => {
        calls.push(`confine ${owner.fsPath} ${relativePath}`);
        return { ok: true, path: `${owner.fsPath}\\${relativePath.split('/').join('\\')}` };
      },
      isDirectory: async () => false,
    });
    expect(await rowsOf('\\\\wsl$\\Ubuntu\\home\\me\\src\\a.ts:3', wsl.key, { ...onWsl, projects: () => [project, wsl] })).toEqual({
      results: [{ kind: 'project', projectKey: wsl.key, projectName: 'me', relativePath: 'src/a.ts', label: 'a.ts', description: 'src', labelMatches: [[0, 4]], descriptionMatches: [[0, 3]], recent: false, exact: true }],
      line: 3,
    });
    expect(calls).toEqual(['confine \\\\wsl.localhost\\Ubuntu\\home\\me src/a.ts']);
  });

  it.runIf(process.platform === 'win32')('gives no row for a UNC path no project holds or a device path, asking the file system nothing', async () => {
    const calls: string[] = [];
    const refuse = (name: string) => (): Promise<never> => {
      calls.push(name);
      return Promise.reject(new Error('no file system call is expected'));
    };
    const quiet = withFiles({
      confineExisting: refuse('confineExisting'),
      confineMissing: refuse('confineMissing'),
      isDirectory: refuse('isDirectory'),
      realpath: refuse('realpath'),
      projectOfPath: refuse('projectOfPath'),
      resolveOutside: refuse('resolveOutside'),
      listOutside: refuse('listOutside'),
    });
    for (const raw of ['\\\\server\\share\\x.txt', '\\\\server\\share\\', '\\\\server\\share\\proj\\src\\app.ts', '//server/share/x.txt:3', '\\\\wsl$\\Ubuntu\\x.txt', '\\\\?\\C:\\x.txt', '\\\\.\\C:\\x.txt', 'C:x.txt']) {
      expect(await rowsOf(raw, project.key, quiet), raw).toBeUndefined();
    }
    expect(calls).toEqual([]);
    expect(reported).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('gives a mapped drive path whose realpath a project holds that project\'s row, and none for one no project holds', async () => {
    const shareProject: Project = { key: '\\\\server\\share\\proj', fsPath: '\\\\server\\share\\proj', name: 'proj' };
    const confined: string[] = [];
    const mapped = withFiles({
      resolveOutside: async (target) => (target.startsWith('Z:\\') ? { kind: 'share', path: `\\\\server\\share${target.slice(2)}`, entry: 'file' } : { kind: 'missing' }),
      // the project's confinement, which alone names its share path
      confineExisting: async (root, relativePath) => {
        confined.push(`${root.fsPath} ${relativePath}`);
        return { ok: true, path: `${root.fsPath}\\${relativePath.split('/').join('\\')}` };
      },
      projectOfPath: () => Promise.reject(new Error('a share realpath is matched by spelling, never by a realpath of it')),
      listOutside: async () => ({ kind: 'missing' }),
    });
    const onShare = { ...mapped, projects: () => [shareProject] };
    expect(await rowsOf('Z:\\proj\\src\\a.ts', shareProject.key, onShare)).toMatchObject({ results: [{ kind: 'project', projectKey: shareProject.key, relativePath: 'src/a.ts', exact: true }] });
    expect((await rowsOf('Z:\\other\\b.ts', shareProject.key, onShare))?.results ?? []).toEqual([]);
    expect(confined).toEqual([`${shareProject.fsPath} src/a.ts`]);
  });

  it.runIf(process.platform === 'win32')('gives no row for an NTFS stream, inside a project or outside every one, with no file system call', async () => {
    const calls = (['lstat', 'realpath', 'stat', 'readdir'] as const).map((name) => vi.spyOn(fs.promises, name));
    expect(await rowsOf(`${file}:stream`, project.key)).toBeUndefined();
    expect(await rowsOf(`${path.join(project.fsPath, 'src', 'app.ts')}:stream`, project.key)).toBeUndefined();
    for (const call of calls) expect(call).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')('resolves the dot segments of a win32 path by text, to a project row or a path row', async () => {
    expect(await rowsOf(`${project.fsPath}\\src\\.\\app.ts`, project.key)).toMatchObject({ results: [{ kind: 'project', projectKey: project.key, relativePath: 'src/app.ts' }] });
    expect(await rowsOf(`${project.fsPath}\\..\\elsewhere\\notes.txt`, project.key)).toMatchObject({ results: [{ kind: 'path', authority: 'local', path: file, complete: { input: `${project.fsPath}\\..\\elsewhere\\notes.txt` } }] });
  });

  it.runIf(process.platform !== 'win32')('gives no row for a POSIX path with a dot segment', async () => {
    expect(await rowsOf(`${project.fsPath}/src/./app.ts`, project.key)).toBeUndefined();
    expect(await rowsOf(`${project.fsPath}/../elsewhere/notes.txt`, project.key)).toBeUndefined();
  });

  it('lists the dotfiles of the folder before a last segment of \'.\', with no row for the folder itself', async () => {
    fs.writeFileSync(path.join(elsewhere, '.hidden'), '');
    fs.mkdirSync(path.join(elsewhere, '.config'));
    const listed = await rowsOf(`${elsewhere}${path.sep}.`, project.key);
    expect(labels(listed)).toEqual(['.config', '.hidden']);
    expect(listed?.results.map((row) => row.labelMatches)).toEqual([[[0, 1]], [[0, 1]]]);
    expect(reported).toEqual([]);
  });

  it('says a folder with no parent that lists nothing has no entries, naming no typed name', async () => {
    const top = path.parse(root).root;
    const bare = withFiles({ listOutside: async (folder) => ({ kind: 'folder', path: folder, entries: [], truncated: false }) });
    expect(await rowsOf(top, project.key, bare)).toEqual({ results: [], emptyText: 'folderEmpty' });
  });

  it('labels a listed link to a project\'s file by the link\'s own name', async () => {
    fs.symlinkSync(path.join(project.fsPath, 'src', 'app.ts'), path.join(elsewhere, 'to-app'), 'file');
    const listed = await rowsOf(path.join(elsewhere, 'to'), project.key);
    expect(listed?.results).toEqual([
      { kind: 'project', projectKey: project.key, projectName: 'proj', relativePath: 'src/app.ts', label: 'to-app', description: 'src', labelMatches: [[0, 2]], descriptionMatches: [], recent: false, complete: { input: path.join(elsewhere, 'to-app') } },
    ]);
  });

  it('serves a longer name from a listing only when the bounds did not cut it', async () => {
    const asked: string[] = [];
    const listing = (truncated: boolean): TypedPathDeps => withFiles({
      listOutside: async (folder, prefix) => {
        asked.push(prefix);
        return { kind: 'folder', path: folder, entries: [{ name: 'ab.txt', kind: 'file', link: false }], truncated };
      },
    });
    const cut: ListingCache = {};
    await rowsOf(`${elsewhere}${path.sep}`, project.key, listing(true), cut);
    await rowsOf(path.join(elsewhere, 'a'), project.key, listing(true), cut);
    expect(asked).toEqual(['', 'a']);
    asked.length = 0;
    const whole: ListingCache = {};
    await rowsOf(`${elsewhere}${path.sep}`, project.key, listing(false), whole);
    expect(labels(await rowsOf(path.join(elsewhere, 'a'), project.key, listing(false), whole))).toEqual(['ab.txt']);
    expect(asked).toEqual(['']);
  });

  it('skips a listed name that holds a separator on a win32 host, which would name another folder', async () => {
    const onWindows: TypedPathDeps = {
      ...withFiles({
        resolveOutside: async () => ({ kind: 'folder', path: 'C:\\tmp' }),
        listOutside: async () => ({
          kind: 'folder',
          path: 'C:\\tmp',
          entries: [{ name: 'a\\..\\x', kind: 'file', link: false }, { name: 'up/../d', kind: 'dir', link: false }, { name: 'b.txt', kind: 'file', link: false }],
          truncated: false,
        }),
      }),
      authorityOs: () => 'win32',
    };
    expect((await rowsOf('C:\\tmp\\', project.key, onWindows))?.results).toEqual([
      { kind: 'folder', authority: 'local', label: '..', labelMatches: [], input: 'C:\\' },
      { kind: 'path', authority: 'local', path: 'C:\\tmp\\b.txt', label: 'b.txt', description: 'C:\\tmp', labelMatches: [], descriptionMatches: [], recent: false, complete: { input: 'C:\\tmp\\b.txt' } },
    ]);
  });

  it('matches a Greek name typed in lowercase, either sigma, alike from the host and from a cached listing', async () => {
    for (const name of ['ΑΣΤΡΟ.txt', 'ΟΔΟΣΗΜΑΝΣΗ.txt', 'Β.txt']) fs.writeFileSync(path.join(elsewhere, name), '');
    const asked: string[] = [];
    const counted = withFiles({
      listOutside: (folder, prefix) => {
        asked.push(prefix);
        return deps.workspaces.local.files.listOutside(folder, prefix);
      },
    });
    // each listing that serves the longer names is one the host answered for the shorter
    const sequences: ReadonlyArray<readonly [string, readonly string[], string]> = [
      ['α', ['ασ', 'αστ'], 'ΑΣΤΡΟ.txt'],
      ['ασ', ['αστ'], 'ΑΣΤΡΟ.txt'],
      ['ο', ['οδοσ', 'οδος'], 'ΟΔΟΣΗΜΑΝΣΗ.txt'],
      ['οδοσ', ['οδος'], 'ΟΔΟΣΗΜΑΝΣΗ.txt'],
      ['οδος', ['οδοσ'], 'ΟΔΟΣΗΜΑΝΣΗ.txt'],
    ];
    for (const [shorter, typed, name] of sequences) {
      const cache: ListingCache = {};
      await rowsOf(path.join(elsewhere, shorter), project.key, counted, cache);
      for (const segment of typed) {
        const raw = path.join(elsewhere, segment);
        expect(labels(await rowsOf(raw, project.key, counted, {})), `${segment} uncached`).toEqual([name]);
        asked.length = 0;
        expect(labels(await rowsOf(raw, project.key, counted, cache)), `${segment} cached`).toEqual([name]);
        expect(asked, `${segment} served from the listing of ${shorter}`).toEqual([]);
      }
    }
  });
});
