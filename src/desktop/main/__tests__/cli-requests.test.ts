import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../local-services/confine';
import { CliRequests, resolveRemoteSpec, type CliRequestsDeps, type PatchTab } from '../cli-requests';
import type { HostRecord } from '../remote/host-store';
import { OutsideFilesUnsupportedError } from '../workspace/remote-workspace';
import { RootSpellings } from '../workspace/root-spellings';
import { englishText, LocalizedError } from '../../../shared/localized-text';

const english = (message: string, ...args: string[]): string => message.replace(/\{(\d+)\}/g, (_match, index: string) => args[Number(index)] ?? '');

const APP: Project = { key: 'ssh+h1|/srv/app', fsPath: '/srv/app', name: 'app' };
const LOCAL: Project = { key: 'c:\\work', fsPath: 'C:\\work', name: 'work' };

interface World {
  // existing files and folders, by authority and path
  readonly files: Map<string, string>;
  readonly folders: Set<string>;
  readonly projects: Project[];
  // links: a path, by authority, to the realpath resolveOutside answers; leaving: a project path whose link leads out, as
  // confineExisting finds
  readonly links: Map<string, string>;
  readonly leaving: Set<string>;
  // shares: a local drive path whose realpath, which resolveOutside answers, is a share's (a mapped drive)
  readonly shares: Map<string, string>;
  // failing: a project path its confinement cannot resolve (a link to a drive that does not answer)
  readonly failing: Set<string>;
  // the host's server lists no files.outside
  readonly oldServer: boolean;
}

function fake(world: Partial<World> = {}, overrides: Partial<CliRequestsDeps> = {}) {
  const files = world.files ?? new Map([['ssh+h1:/srv/app/src/app.ts', 'one\ntwo\n'], ['ssh+h1:/srv/app/b.txt', 'one\nthree\n'], ['local:C:\\work\\a.txt', 'a']]);
  const folders = world.folders ?? new Set(['ssh+h1:/srv/app', 'ssh+h1:/srv/app/src', 'ssh+h1:/srv/other', 'local:C:\\work']);
  const projects = world.projects ?? [APP, LOCAL];
  const links = world.links ?? new Map<string, string>();
  const leaving = world.leaving ?? new Set<string>();
  const shares = world.shares ?? new Map<string, string>();
  const failing = world.failing ?? new Set<string>();
  const calls: string[] = [];
  // whether each question focused its action (Add Project) rather than Cancel
  const focused: boolean[] = [];
  let tabs = 0;
  const closes = new Map<string, () => void>();
  const os = (authorityKey: string): NodeJS.Platform => (authorityKey === 'local' ? 'win32' : 'linux');
  const flavor = (authorityKey: string): typeof path.posix => (os(authorityKey) === 'win32' ? path.win32 : path.posix);
  const deps: CliRequestsDeps = {
    projects: (authorityKey) => projects.filter((project) => (authorityKey === 'local' ? !project.key.startsWith('ssh+') : project.key.startsWith(`${authorityKey}|`))),
    // no retain: each project's open path alone
    spellings: new RootSpellings({ os: 'win32', realpath: () => Promise.reject(new Error('no realpath in this test')), log: () => undefined }),
    os,
    // this computer's messages have their own wording and never name it as a host
    hostName: (authorityKey) => {
      if (authorityKey === 'local') throw new Error('this computer is named as a host');
      return 'prod-1';
    },
    isDirectory: async (authorityKey, folder) => folders.has(`${authorityKey}:${folder}`),
    confineExisting: async (authorityKey, project, relativePath) => {
      const full = flavor(authorityKey).join(project.fsPath, ...relativePath.split('/'));
      if (leaving.has(`${authorityKey}:${full}`)) return { ok: false, reason: 'outside' };
      if (failing.has(`${authorityKey}:${full}`)) return { ok: false, reason: 'failed' };
      return files.has(`${authorityKey}:${full}`) ? { ok: true, path: full } : { ok: false, reason: 'missing' };
    },
    confineMissing: async (authorityKey, project, relativePath) => {
      const full = flavor(authorityKey).join(project.fsPath, ...relativePath.split('/'));
      if (leaving.has(`${authorityKey}:${full}`)) return { ok: false, reason: 'outside' };
      if (failing.has(`${authorityKey}:${full}`)) return { ok: false, reason: 'failed' };
      return { ok: true, path: full };
    },
    read: async (authorityKey, file) => {
      const text = files.get(`${authorityKey}:${file}`);
      return text === undefined ? { kind: 'missing' } : { kind: 'bytes', bytes: Buffer.from(text), mtimeMs: 0, dev: 0, ino: 0 };
    },
    // the outside rule's lexical refusals, before anything else is looked at
    resolveOutside: async (authorityKey, target) => {
      calls.push(`resolve ${authorityKey} ${target}`);
      if (world.oldServer === true && authorityKey !== 'local') throw new OutsideFilesUnsupportedError(authorityKey);
      if (/^[\\/]{2}/.test(target)) return { kind: 'outside', reason: 'share' };
      if (os(authorityKey) === 'win32' && target.slice(2).includes(':')) return { kind: 'outside', reason: 'name' };
      const shared = authorityKey === 'local' ? shares.get(target) : undefined;
      if (shared !== undefined) return { kind: 'share', path: shared, entry: files.has(`local:${shared}`) ? 'file' : 'folder' };
      const real = links.get(`${authorityKey}:${target}`) ?? target;
      if (files.has(`${authorityKey}:${real}`)) return { kind: 'file', path: real };
      return folders.has(`${authorityKey}:${real}`) ? { kind: 'folder', path: real } : { kind: 'missing' };
    },
    readOutside: async (authorityKey, file) => {
      const text = files.get(`${authorityKey}:${file}`);
      return text === undefined ? { kind: 'missing' } : { kind: 'bytes', bytes: Buffer.from(text), mtimeMs: 0, dev: 0, ino: 0 };
    },
    folderProject: async (authorityKey, folder) => {
      const listed = projects.find((project) => project.fsPath === folder && deps.projects(authorityKey).includes(project));
      return { projectKey: listed?.key ?? `${authorityKey}|${folder}`, listed: listed !== undefined };
    },
    selectProject: async (key) => { calls.push(`select ${key}`); },
    addFolder: async (authorityKey, folder) => { calls.push(`add ${authorityKey} ${folder}`); },
    confirm: async (question, _action, focusAction) => {
      calls.push(`ask ${question}`);
      focused.push(focusAction);
      return true;
    },
    openNamed: async (authorityKey, filePath, position) => {
      calls.push(`open ${authorityKey} ${filePath}${position.line !== undefined ? ` @${position.line}` : ''}${position.column !== undefined ? `:${position.column}` : ''}`);
      return `tab-${++tabs}`;
    },
    showPatch: (tab: PatchTab) => {
      calls.push(`patch ${tab.left.name} ${tab.right.name} ${tab.content.kind}`);
      return `tab-${++tabs}`;
    },
    whenClosed: (tabId) => new Promise((resolve) => closes.set(tabId, resolve)),
    showWindow: () => { calls.push('window'); },
    openExternal: async (authorityKey, url) => { calls.push(`url ${authorityKey} ${url}`); },
    resolveRemote: (spec) => resolveRemoteSpec(spec, [], false),
    connect: async (target) => {
      calls.push(`connect ${target.kind}`);
      return target.kind === 'wsl' ? `wsl+${target.distro}` : target.authorityKey;
    },
    openConnect: async (query) => { calls.push(`connect dialog ${query}`); },
    notify: (message) => { calls.push(`notify ${message}`); },
    claimWaitMarker: async (marker) => {
      calls.push(`claim ${marker}`);
      return true;
    },
    deleteWaitMarker: async (marker) => { calls.push(`marker ${marker}`); },
    t: english,
    render: englishText,
    log: () => undefined,
    ...overrides,
  };
  // what opened and was asked, without the outside rule's lookups
  const actions = (): string[] => calls.filter((call) => !call.startsWith('resolve '));
  return { requests: new CliRequests(deps), calls, actions, focused, waiting: () => [...closes.keys()], close: (tabId: string) => closes.get(tabId)!() };
}

const open = (...paths: Array<string | { path: string; line?: number; column?: number }>) => ({
  request: { kind: 'open' as const, cwd: '/srv/app', items: paths.map((item) => (typeof item === 'string' ? { path: item } : item)), wait: false },
});

describe('the damocles command\'s requests in main', () => {
  it('opens a file inside a project of the terminal\'s host at its line and column, bringing the window forward', async () => {
    const { requests, calls } = fake();
    await expect(requests.fromSocket('ssh+h1', open({ path: '/srv/app/src/app.ts', line: 42, column: 3 }))).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['window', 'open ssh+h1 /srv/app/src/app.ts @42:3']);
  });

  it('reads path:line:column so only when the path as typed does not exist', async () => {
    const files = new Map([['ssh+h1:/srv/app/notes:12', 'a file named with a colon'], ['ssh+h1:/srv/app/notes', 'n']]);
    const { requests, actions } = fake({ files });
    await requests.fromSocket('ssh+h1', open({ path: '/srv/app/notes', line: 12 }));
    expect(actions()).toEqual(['window', 'open ssh+h1 /srv/app/notes:12']);
    // the unsplit name is missing: the position applies, inside a project and outside one
    const missing = fake({ files: new Map([['ssh+h1:/srv/app/notes', 'n'], ['ssh+h1:/home/me/notes', 'n']]) });
    await missing.requests.fromSocket('ssh+h1', open({ path: '/srv/app/notes', line: 12 }, { path: '/home/me/notes', line: 3 }));
    expect(missing.actions()).toEqual(['window', 'open ssh+h1 /srv/app/notes @12', 'open ssh+h1 /home/me/notes @3']);
  });

  it('opens a file outside every project of its host on that host, and a file of another host\'s project path as that host\'s own file', async () => {
    const { requests, actions } = fake({ files: new Map([['ssh+h1:/srv/app/src/app.ts', 'a'], ['ssh+h1:/etc/hosts', '127.0.0.1 localhost\n'], ['ssh+h2:/srv/app/src/app.ts', 'b']]), folders: new Set(['ssh+h1:/etc', 'ssh+h2:/srv/app/src']) });
    await expect(requests.fromSocket('ssh+h1', open('/srv/app/src/app.ts', '/etc/hosts'))).resolves.toEqual({ ok: true });
    await expect(requests.fromSocket('ssh+h2', open('/srv/app/src/app.ts'))).resolves.toEqual({ ok: true });
    expect(actions()).toEqual(['window', 'open ssh+h1 /srv/app/src/app.ts', 'open ssh+h1 /etc/hosts', 'window', 'open ssh+h2 /srv/app/src/app.ts']);
  });

  it('opens a missing file empty, inside a project or outside one, and refuses one whose folder is missing, opening nothing', async () => {
    const { requests, actions } = fake({ folders: new Set(['ssh+h1:/srv/app', 'ssh+h1:/home/me']) });
    await expect(requests.fromSocket('ssh+h1', open('/srv/app/new.txt', '/home/me/new.txt'))).resolves.toEqual({ ok: true });
    expect(actions()).toEqual(['window', 'open ssh+h1 /srv/app/new.txt', 'open ssh+h1 /home/me/new.txt']);
    const refused = fake({ folders: new Set(['ssh+h1:/srv/app']) });
    await expect(refused.requests.fromSocket('ssh+h1', open('/srv/app/b.txt', '/srv/app/nofolder/new.txt'))).resolves.toEqual({ ok: false, message: 'damocles: /srv/app/nofolder/new.txt cannot be created, because its folder does not exist.' });
    await expect(refused.requests.fromSocket('ssh+h1', open('/home/me/nofolder/new.txt'))).resolves.toEqual({ ok: false, message: 'damocles: /home/me/nofolder/new.txt cannot be created, because its folder does not exist.' });
    expect(refused.actions()).toEqual([]);
  });

  it('opens a project path a link leads out of at the path named, which the editor follows to its target', async () => {
    const { requests, actions } = fake({ files: new Map([['ssh+h1:/home/me/target.txt', 't']]), leaving: new Set(['ssh+h1:/srv/app/link.txt']), links: new Map([['ssh+h1:/srv/app/link.txt', '/home/me/target.txt']]) });
    await expect(requests.fromSocket('ssh+h1', open('/srv/app/link.txt'))).resolves.toEqual({ ok: true });
    expect(actions()).toEqual(['window', 'open ssh+h1 /srv/app/link.txt']);
  });

  it('answers a share or device path and a stream name with the refusal\'s own text, opening nothing and touching nothing past the folder check', async () => {
    const folderChecks: string[] = [];
    const { requests, calls } = fake({}, {
      isDirectory: async (_authorityKey, folder) => {
        folderChecks.push(folder);
        return false;
      },
    });
    await requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: '\\\\server\\share\\x.txt' }], wait: false } });
    await requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: 'C:\\x\\a.txt:s' }], wait: false } });
    // the folder check of each path and no check of its parent; the outside rule refuses it lexically
    expect(folderChecks).toEqual(['\\\\server\\share\\x.txt', 'C:\\x\\a.txt:s']);
    expect(calls).toEqual([
      'resolve local \\\\server\\share\\x.txt',
      'notify damocles: Damocles does not open \\\\server\\share\\x.txt: it is on a network share or a device outside your projects.',
      'resolve local C:\\x\\a.txt:s',
      'notify damocles: Damocles does not open C:\\x\\a.txt:s: part of this path would be read differently than it is written, such as a trailing dot or space, a stream or a reserved device name.',
    ]);
  });

  it('refuses a file outside the projects of a host whose server is too old, naming the host, and still opens a project file there', async () => {
    const { requests, actions } = fake({ oldServer: true, folders: new Set(['ssh+h1:/srv/app', 'ssh+h1:/srv/app/src', 'ssh+h1:/home/me']) });
    await expect(requests.fromSocket('ssh+h1', open('/home/me/.bashrc'))).resolves.toEqual({ ok: false, message: 'damocles: the Damocles server on prod-1 cannot open files outside its projects.' });
    await expect(requests.fromSocket('ssh+h1', open('/srv/app/src/app.ts'))).resolves.toEqual({ ok: true });
    expect(actions()).toEqual(['window', 'open ssh+h1 /srv/app/src/app.ts']);
  });

  it('names paths as the host does, with `.` and `..` resolved and no trailing separator, as a WSL shell\'s `$PWD/.` arrives', async () => {
    const { requests, calls } = fake();
    await requests.fromSocket('ssh+h1', open('/srv/other/.', '/srv/app/src/../src/app.ts', '/srv/app/'));
    expect(calls).toEqual(['window', 'ask Add /srv/other on prod-1 as a project?', 'add ssh+h1 /srv/other', 'open ssh+h1 /srv/app/src/app.ts', 'select ssh+h1|/srv/app']);
    const local = fake();
    await local.requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: 'C:\\work\\.\\a.txt' }, { path: 'C:\\work\\' }], wait: false } });
    expect(local.actions()).toEqual(['window', 'open local C:\\work\\a.txt', 'select c:\\work']);
  });

  it('selects a folder that is a project, and asks before adding a folder outside every project', async () => {
    const { requests, calls } = fake();
    await requests.fromSocket('ssh+h1', open('/srv/app'));
    expect(calls).toEqual(['window', 'select ssh+h1|/srv/app']);
    calls.length = 0;
    await expect(requests.fromSocket('ssh+h1', open('/srv/other'))).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['window', 'ask Add /srv/other on prod-1 as a project?', 'add ssh+h1 /srv/other']);
    const declined = fake({}, { confirm: async () => false });
    await expect(declined.requests.fromSocket('ssh+h1', open('/srv/other'))).resolves.toEqual({ ok: false, message: 'damocles: /srv/other was not added as a project.' });
    expect(declined.calls).not.toContain('add ssh+h1 /srv/other');
  });

  it('answers --wait once every tab the request opened has closed', async () => {
    const { requests, close, waiting } = fake();
    let answered = false;
    const answer = requests.fromSocket('ssh+h1', { request: { kind: 'open', cwd: '/srv/app', items: [{ path: '/srv/app/src/app.ts' }, { path: '/srv/app/b.txt' }], wait: true } }).then((value) => {
      answered = true;
      return value;
    });
    await vi.waitFor(() => expect(waiting()).toEqual(['tab-1', 'tab-2']));
    close('tab-1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(answered).toBe(false);
    close('tab-2');
    await expect(answer).resolves.toEqual({ ok: true });
  });

  it('answers --wait on a file outside every project once its tab closed', async () => {
    const { requests, close, waiting } = fake({ files: new Map([['ssh+h1:/home/me/.bashrc', 'x']]) });
    let answered = false;
    const answer = requests.fromSocket('ssh+h1', { request: { kind: 'open', cwd: '/home/me', items: [{ path: '/home/me/.bashrc', line: 3 }], wait: true } }).then((value) => {
      answered = true;
      return value;
    });
    await vi.waitFor(() => expect(waiting()).toEqual(['tab-1']));
    expect(answered).toBe(false);
    close('tab-1');
    await expect(answer).resolves.toEqual({ ok: true });
  });

  it('opens --diff as a patch tab named with both files, and as too large once the diff passes its time bound', async () => {
    const { requests, calls } = fake();
    await requests.fromSocket('ssh+h1', { request: { kind: 'diff', cwd: '/srv/app', left: '/srv/app/src/app.ts', right: '/srv/app/b.txt', wait: false } });
    expect(calls).toEqual(['window', 'patch app.ts b.txt patch']);
    const patches: PatchTab[] = [];
    const big = (seed: string): string => Array.from({ length: 20_000 }, (_, index) => `${seed}${index}`).join('\n');
    const slow = fake({ files: new Map([['ssh+h1:/srv/app/a', big('a')], ['ssh+h1:/srv/app/b', big('b')]]) }, {
      diffTimeoutMs: 1,
      showPatch: (tab) => {
        patches.push(tab);
        return 'tab-1';
      },
    });
    await slow.requests.fromSocket('ssh+h1', { request: { kind: 'diff', cwd: '/srv/app', left: '/srv/app/a', right: '/srv/app/b', wait: false } });
    expect(patches.map((tab) => tab.content)).toEqual([{ kind: 'tooLarge' }]);
  });

  it('builds the patch with both paths and the binary mark', async () => {
    const patches: PatchTab[] = [];
    const files = new Map([['ssh+h1:/srv/app/a.txt', 'one\n'], ['ssh+h1:/srv/app/b.txt', 'two\n'], ['ssh+h1:/srv/app/c.bin', '\0\0\0binary']]);
    const { requests } = fake({ files }, { showPatch: (tab) => { patches.push(tab); return 'tab'; } });
    await requests.fromSocket('ssh+h1', { request: { kind: 'diff', cwd: '/', left: '/srv/app/a.txt', right: '/srv/app/b.txt', wait: false } });
    await requests.fromSocket('ssh+h1', { request: { kind: 'diff', cwd: '/', left: '/srv/app/a.txt', right: '/srv/app/c.bin', wait: false } });
    expect(patches[0]).toMatchObject({ left: { name: 'a.txt', folder: '/srv/app', path: '/srv/app/a.txt' }, right: { name: 'b.txt', folder: '/srv/app', path: '/srv/app/b.txt' } });
    expect(patches[0]!.content.kind === 'patch' && patches[0]!.content.patch).toContain('--- /srv/app/a.txt\n+++ /srv/app/b.txt\n');
    expect(patches[1]!.content).toEqual({ kind: 'binary' });
  });

  it('diffs a side outside every project through the outside rule, and refuses a missing or refused side', async () => {
    const patches: PatchTab[] = [];
    const files = new Map([['ssh+h1:/srv/app/a.txt', 'one\n'], ['ssh+h1:/home/me/b.txt', 'two\n']]);
    const { requests } = fake({ files }, { showPatch: (tab) => { patches.push(tab); return 'tab'; } });
    await expect(requests.fromSocket('ssh+h1', { request: { kind: 'diff', cwd: '/', left: '/srv/app/a.txt', right: '/home/me/b.txt', wait: false } })).resolves.toEqual({ ok: true });
    expect(patches[0]!.content.kind === 'patch' && patches[0]!.content.patch).toContain('--- /srv/app/a.txt\n+++ /home/me/b.txt\n');
    await expect(requests.fromSocket('ssh+h1', { request: { kind: 'diff', cwd: '/', left: '/srv/app/a.txt', right: '/home/me/gone.txt', wait: false } })).resolves.toEqual({ ok: false, message: 'damocles: /home/me/gone.txt does not exist.' });
    const local = fake();
    await local.requests.fromCommandLine({ request: { kind: 'diff', cwd: 'C:\\', left: 'C:\\work\\a.txt', right: '\\\\server\\share\\b.txt', wait: false } });
    expect(local.calls.at(-1)).toBe('notify damocles: Damocles does not open \\\\server\\share\\b.txt: it is on a network share or a device outside your projects.');
  });

  it('opens and diffs a file named by a mapped drive of a project opened at its share path as that project\'s file, and refuses one no project holds', async () => {
    const SHARED: Project = { key: '\\\\server\\share\\proj', fsPath: '\\\\server\\share\\proj', name: 'proj' };
    const files = new Map([['local:\\\\server\\share\\proj\\a.txt', 'one\n'], ['local:\\\\server\\share\\proj\\b.txt', 'two\n'], ['local:\\\\server\\other\\c.txt', 'c']]);
    const shares = new Map([['Z:\\proj\\a.txt', '\\\\server\\share\\proj\\a.txt'], ['Z:\\proj\\b.txt', '\\\\server\\share\\proj\\b.txt'], ['Y:\\c.txt', '\\\\server\\other\\c.txt']]);
    const patches: PatchTab[] = [];
    const local = fake({ files, shares, projects: [APP, LOCAL, SHARED] }, { showPatch: (tab) => { patches.push(tab); return 'tab'; } });
    await local.requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: 'Z:\\proj\\a.txt' }], wait: false } });
    expect(local.actions().at(-1)).toBe('open local Z:\\proj\\a.txt');
    await local.requests.fromCommandLine({ request: { kind: 'diff', cwd: 'C:\\', left: 'Z:\\proj\\a.txt', right: 'Z:\\proj\\b.txt', wait: false } });
    expect(patches[0]!.content.kind === 'patch' && patches[0]!.content.patch).toContain('-one\n+two\n');
    const refusal = 'notify damocles: Damocles does not open Y:\\c.txt: it is on a network share or a device outside your projects.';
    await local.requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: 'Y:\\c.txt' }], wait: false } });
    expect(local.calls.at(-1)).toBe(refusal);
    await local.requests.fromCommandLine({ request: { kind: 'diff', cwd: 'C:\\', left: 'Z:\\proj\\a.txt', right: 'Y:\\c.txt', wait: false } });
    expect(local.calls.at(-1)).toBe(refusal);
    // a project's file its confinement no longer finds is refused as the share's, never read by the outside rule
    const leaving = fake({ files, shares, projects: [APP, LOCAL, SHARED], leaving: new Set(['local:\\\\server\\share\\proj\\b.txt']) });
    await leaving.requests.fromCommandLine({ request: { kind: 'diff', cwd: 'C:\\', left: 'Z:\\proj\\a.txt', right: 'Z:\\proj\\b.txt', wait: false } });
    expect(leaving.calls.at(-1)).toBe('notify damocles: Damocles does not open Z:\\proj\\b.txt: it is on a network share or a device outside your projects.');
  });

  it('diffs a side named by the share spelling of a project on a mapped drive as that project\'s file, and refuses it once the drive is remapped', async () => {
    // C:\work stands for a mapped drive: its realpath, and every realpath confinement takes under it, is the share's
    let share = '\\\\server\\share\\work';
    const spellings = new RootSpellings({ os: 'win32', realpath: async (folder) => (folder === LOCAL.fsPath ? share : folder), log: () => undefined });
    await spellings.retain([LOCAL, APP]);
    const patches: PatchTab[] = [];
    const files = new Map([['local:C:\\work\\a.txt', 'one\n'], ['local:C:\\work\\b.txt', 'two\n']]);
    const local = fake({ files }, {
      spellings,
      confineExisting: async (_authorityKey, project, relativePath) => {
        const lexical = path.win32.join(project.fsPath, ...relativePath.split('/'));
        return files.has(`local:${lexical}`) ? { ok: true, path: `${share}${lexical.slice(project.fsPath.length)}` } : { ok: false, reason: 'missing' };
      },
      read: async (_authorityKey, file) => {
        const text = files.get(`local:${LOCAL.fsPath}${file.slice(share.length)}`);
        return text === undefined ? { kind: 'missing' } : { kind: 'bytes', bytes: Buffer.from(text), mtimeMs: 0, dev: 0, ino: 0 };
      },
      showPatch: (tab) => {
        patches.push(tab);
        return 'tab';
      },
    });
    const named = '\\\\server\\share\\work\\b.txt';
    await local.requests.fromCommandLine({ request: { kind: 'diff', cwd: 'C:\\', left: 'C:\\work\\a.txt', right: named, wait: false } });
    expect(patches[0]).toMatchObject({ left: { path: 'C:\\work\\a.txt' }, right: { name: 'b.txt', path: named } });
    expect(patches[0]!.content.kind === 'patch' && patches[0]!.content.patch).toContain('-one\n+two\n');
    // the share side never reaches the outside rule
    expect(local.calls.filter((call) => call.startsWith('resolve '))).toEqual([]);
    share = '\\\\other\\share\\work';
    await local.requests.fromCommandLine({ request: { kind: 'diff', cwd: 'C:\\', left: 'C:\\work\\a.txt', right: named, wait: false } });
    expect(local.calls.at(-1)).toBe(`notify damocles: Damocles does not open ${named}: it is on a network share or a device outside your projects.`);
    expect(patches).toHaveLength(1);
  });

  it('opens a file named by the share spelling of a project on a mapped drive, never asking the outside rule, and refuses it once the drive is remapped', async () => {
    // C:\work stands for a mapped drive: its realpath, and every realpath confinement takes under it, is the share's
    let share = '\\\\server\\share\\work';
    const spellings = new RootSpellings({ os: 'win32', realpath: async (folder) => (folder === LOCAL.fsPath ? share : folder), log: () => undefined });
    await spellings.retain([LOCAL, APP]);
    const files = new Map([['local:C:\\work\\b.txt', 'two\n']]);
    const local = fake({ files }, {
      spellings,
      confineExisting: async (_authorityKey, project, relativePath) => {
        const lexical = path.win32.join(project.fsPath, ...relativePath.split('/'));
        return files.has(`local:${lexical}`) ? { ok: true, path: `${share}${lexical.slice(project.fsPath.length)}` } : { ok: false, reason: 'missing' };
      },
    });
    const named = '\\\\server\\share\\work\\b.txt';
    await local.requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: named }], wait: false } });
    expect(local.calls.filter((call) => !call.startsWith('claim ') && !call.startsWith('marker '))).toEqual(['window', `open local ${named}`]);
    share = '\\\\other\\share\\work';
    await local.requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: named }], wait: false } });
    expect(local.calls.at(-1)).toBe(`notify damocles: Damocles does not open ${named}: it is on a network share or a device outside your projects.`);
    expect(local.calls.filter((call) => call.startsWith('open '))).toHaveLength(1);
  });

  it('sends a target terminal\'s BROWSER address through the link checks', async () => {
    const { requests, calls } = fake();
    await expect(requests.fromSocket('ssh+h1', { request: { kind: 'openExternal', url: 'https://example.test/login' } })).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['url ssh+h1 https://example.test/login']);
  });

  it('cuts a refusal to the bound the relay carries', async () => {
    const long = `/srv/${'a'.repeat(4000)}/${'b'.repeat(4000)}`;
    const { requests } = fake();
    const answer = await requests.fromSocket('ssh+h1', open(long));
    expect(answer.ok === false && answer.message.length).toBe(4096);
  });

  it('handles the command line on this computer, telling a refusal as a notice and always deleting the wait marker', async () => {
    const { requests, calls, actions } = fake();
    await requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\work', items: [{ path: 'C:\\work\\a.txt' }], wait: false } });
    expect(actions()).toEqual(['window', 'open local C:\\work\\a.txt']);
    calls.length = 0;
    await requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: 'C:\\nofolder\\win.ini' }], wait: true }, waitMarker: 'C:\\Temp\\damocles-wait-1' });
    expect(actions()).toEqual(['claim C:\\Temp\\damocles-wait-1', 'notify damocles: C:\\nofolder\\win.ini cannot be created, because its folder does not exist.', 'marker C:\\Temp\\damocles-wait-1']);
  });

  it('deletes the wait marker of the command line once the tab closed', async () => {
    const { requests, calls, close } = fake();
    const done = requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\work', items: [{ path: 'C:\\work\\a.txt' }], wait: true }, waitMarker: 'm' });
    await vi.waitFor(() => expect(calls).toContain('open local C:\\work\\a.txt'));
    expect(calls).not.toContain('marker m');
    close('tab-1');
    await done;
    expect(calls.at(-1)).toBe('marker m');
  });

  it('ends every --wait at the quit, which keeps the tabs: a socket gets its answer and each wait marker is deleted once', async () => {
    const { requests, calls, close, waiting } = fake();
    const socket = requests.fromSocket('ssh+h1', { request: { kind: 'open', cwd: '/srv/app', items: [{ path: '/srv/app/src/app.ts' }], wait: true } });
    const commandLine = requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\work', items: [{ path: 'C:\\work\\a.txt' }], wait: true }, waitMarker: 'm' });
    await vi.waitFor(() => expect(waiting()).toEqual(['tab-1', 'tab-2']));
    await requests.dispose();
    expect(calls.filter((call) => call === 'marker m')).toEqual(['marker m']);
    await expect(socket).resolves.toEqual({ ok: true });
    await commandLine;
    // a tab closing afterwards deletes nothing more
    close('tab-2');
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls.filter((call) => call === 'marker m')).toEqual(['marker m']);
  });

  it('deletes the wait marker of a command line still asking at the quit', async () => {
    let answer = (_yes: boolean): void => undefined;
    let asked = false;
    const { requests, calls } = fake({ folders: new Set(['local:C:\\other']) }, {
      confirm: () => new Promise((resolve) => {
        asked = true;
        answer = resolve;
      }),
    });
    const done = requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: 'C:\\other' }], wait: true }, waitMarker: 'm' });
    await vi.waitFor(() => expect(asked).toBe(true));
    await requests.dispose();
    expect(calls).toContain('marker m');
    answer(false);
    await done;
    expect(calls.filter((call) => call === 'marker m')).toEqual(['marker m']);
  });

  it('asks every folder question before anything opens, so a no opens nothing, and a --wait refused returns at once', async () => {
    const both = fake({ folders: new Set(['ssh+h1:/srv/app', 'ssh+h1:/srv/other', 'ssh+h1:/srv/third']) });
    await both.requests.fromSocket('ssh+h1', open('/srv/other', '/srv/app/b.txt', '/srv/third'));
    expect(both.actions()).toEqual(['window', 'ask Add /srv/other on prod-1 as a project?', 'ask Add /srv/third on prod-1 as a project?', 'add ssh+h1 /srv/other', 'open ssh+h1 /srv/app/b.txt', 'add ssh+h1 /srv/third']);
    const declined = fake({}, { confirm: async (question) => question.includes('/srv/app') });
    await expect(declined.requests.fromSocket('ssh+h1', { request: { kind: 'open', cwd: '/srv/app', items: [{ path: '/srv/app/src/app.ts' }, { path: '/srv/other' }], wait: true } })).resolves.toEqual({ ok: false, message: 'damocles: /srv/other was not added as a project.' });
    expect(declined.actions()).toEqual(['window']);
    expect(declined.waiting()).toEqual([]);
  });

  it('focuses Cancel in a socket\'s add question, since any process on the target reaches its sockets, and Add Project in the command line\'s', async () => {
    const { requests, focused } = fake({ folders: new Set(['ssh+h1:/srv/other', 'local:C:\\other']) });
    await requests.fromSocket('ssh+h1', open('/srv/other'));
    await requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: 'C:\\other' }], wait: false } });
    expect(focused).toEqual([false, true]);
  });

  it('words this computer\'s question and refusals for it, never naming it as a host', async () => {
    const { requests, calls } = fake({ folders: new Set(['local:C:\\other']) });
    await requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: 'C:\\other' }], wait: false } });
    expect(calls).toContain('ask Add C:\\other on this computer as a project?');
  });

  it('names the path as typed in a refusal, position included, when neither its whole nor its split form opens', async () => {
    const { requests } = fake();
    await expect(requests.fromSocket('ssh+h1', open({ path: '/srv/app/nofolder/nope.ts', line: 3, column: 4 }))).resolves.toEqual({ ok: false, message: 'damocles: /srv/app/nofolder/nope.ts:3:4 cannot be created, because its folder does not exist.' });
    await expect(requests.fromSocket('ssh+h1', open({ path: 'src/a.ts', line: 3 }))).resolves.toEqual({ ok: false, message: 'damocles: src/a.ts:3 is not an absolute path on prod-1.' });
  });

  it('tells an editor failure in words, a LocalizedError rendered in the user\'s language', async () => {
    const plain = fake({}, { openNamed: async () => { throw new Error('the connection ended'); } });
    await expect(plain.requests.fromSocket('ssh+h1', open('/srv/app/b.txt'))).resolves.toEqual({ ok: false, message: 'damocles: the connection ended' });
    const timedOut = Object.assign(new LocalizedError({ message: 'The drive {0} did not answer within a second.', args: ['Q:\\'] }), { message: 'English message' });
    const localized = fake({}, { openNamed: async () => { throw timedOut; } });
    await expect(localized.requests.fromSocket('ssh+h1', open('/srv/app/b.txt'))).resolves.toEqual({ ok: false, message: 'damocles: The drive Q:\\ did not answer within a second.' });
  });

  it('refuses a project path its project cannot resolve before anything opens', async () => {
    const { requests, actions } = fake({ failing: new Set(['ssh+h1:/srv/app/b.txt']) });
    await expect(requests.fromSocket('ssh+h1', open('/srv/app/src/app.ts', { path: '/srv/app/b.txt', line: 2 }))).resolves.toEqual({ ok: false, message: 'damocles: /srv/app/b.txt:2 could not be opened.' });
    expect(actions()).toEqual([]);
  });

  it('refuses a new file in a folder whose realpath is a share no project holds before anything opens, and opens one a project holds', async () => {
    const SHARED: Project = { key: '\\\\server\\share\\proj', fsPath: '\\\\server\\share\\proj', name: 'proj' };
    const shares = new Map([['Y:\\notes', '\\\\server\\other\\notes'], ['Z:\\proj', '\\\\server\\share\\proj']]);
    const folders = new Set(['local:C:\\work', 'local:Y:\\notes', 'local:Z:\\proj']);
    const { requests, calls, actions } = fake({ shares, folders, projects: [APP, LOCAL, SHARED] });
    await requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: 'C:\\work\\a.txt' }, { path: 'Y:\\notes\\new.txt' }], wait: false } });
    expect(calls.at(-1)).toBe('notify damocles: Damocles does not open Y:\\notes\\new.txt: it is on a network share or a device outside your projects.');
    expect(actions().filter((call) => call.startsWith('open '))).toEqual([]);
    await requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: 'Z:\\proj\\new.txt' }], wait: false } });
    expect(actions().at(-1)).toBe('open local Z:\\proj\\new.txt');
  });

  it('reads path:line as one name on a host whose server opens no file outside its projects, so a project file still opens at its line', async () => {
    // a Windows host's project confinement refuses the stream-like name app.ts:12, which the outside rule would judge
    const { requests, actions } = fake({ oldServer: true, leaving: new Set(['ssh+h1:/srv/app/src/app.ts:12']) });
    await expect(requests.fromSocket('ssh+h1', open({ path: '/srv/app/src/app.ts', line: 12 }))).resolves.toEqual({ ok: true });
    expect(actions()).toEqual(['window', 'open ssh+h1 /srv/app/src/app.ts @12']);
  });

  it('refuses a --diff side that is a folder on a mapped drive as no file', async () => {
    const SHARED: Project = { key: '\\\\server\\share\\proj', fsPath: '\\\\server\\share\\proj', name: 'proj' };
    const shares = new Map([['Z:\\proj\\src', '\\\\server\\share\\proj\\src']]);
    const { requests, calls } = fake({ shares, projects: [APP, LOCAL, SHARED] });
    await requests.fromCommandLine({ request: { kind: 'diff', cwd: 'C:\\', left: 'C:\\work\\a.txt', right: 'Z:\\proj\\src', wait: false } });
    expect(calls.at(-1)).toBe('notify damocles: Z:\\proj\\src is not a file.');
  });

  it('names a refused path as typed, its position included', async () => {
    const { requests, calls } = fake();
    await requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: '\\\\server\\share\\x.txt', line: 3 }], wait: false } });
    expect(calls.at(-1)).toBe('notify damocles: Damocles does not open \\\\server\\share\\x.txt:3: it is on a network share or a device outside your projects.');
  });

  it('claims a command line\'s wait marker before the window is ready, and once the quit began opens nothing and deletes the marker', async () => {
    const { requests, calls } = fake();
    let ready = (): void => undefined;
    const waiting = requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\work', items: [{ path: 'C:\\work\\a.txt' }], wait: true }, waitMarker: 'm1' }, new Promise((resolve) => { ready = resolve; }));
    await vi.waitFor(() => expect(calls).toEqual(['claim m1']));
    await requests.dispose();
    ready();
    await waiting;
    expect(calls).toEqual(['claim m1', 'marker m1']);
    await requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\work', items: [{ path: 'C:\\work\\a.txt' }], wait: true }, waitMarker: 'm2' });
    expect(calls).toEqual(['claim m1', 'marker m1', 'marker m2']);
    await expect(requests.fromSocket('ssh+h1', open('/srv/app/b.txt'))).resolves.toEqual({ ok: false, message: 'damocles: Damocles is quitting, so nothing was opened.' });
    expect(calls.some((call) => call.startsWith('open') || call === 'window')).toBe(false);
  });

  it('deletes the wait marker of a switch it refuses to parse, and of a request that arrives once the quit began, opening nothing', async () => {
    const { requests, calls } = fake();
    const marker = path.resolve('cli-wait', `damocles-wait-${'c'.repeat(32)}`);
    const switchOf = (value: unknown): string => `--damocles-cli=${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
    const items = Array.from({ length: 65 }, () => ({ path: 'C:\\work\\a.txt' }));
    await requests.fromArgv(['Damocles.exe', switchOf({ request: { kind: 'open', cwd: 'C:\\', items, wait: true }, waitMarker: marker })], Promise.resolve(), false);
    expect(calls).toEqual([`marker ${marker}`]);
    await requests.fromArgv(['Damocles.exe', switchOf({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: 'C:\\work\\a.txt' }], wait: true }, waitMarker: marker })], Promise.resolve(), true);
    expect(calls).toEqual([`marker ${marker}`, `marker ${marker}`]);
    await requests.fromArgv(['Damocles.exe', '--disable-gpu'], Promise.resolve(), false);
    await requests.fromArgv(['Damocles.exe', switchOf({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: 'C:\\work\\a.txt' }], wait: false } })], Promise.resolve(), false);
    expect(calls).toEqual([`marker ${marker}`, `marker ${marker}`, 'window', 'open local C:\\work\\a.txt']);
  });

  it('does not wait on a marker the command already removed', async () => {
    const { requests, calls, waiting } = fake({}, { claimWaitMarker: async () => false });
    await requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\work', items: [{ path: 'C:\\work\\a.txt' }], wait: true }, waitMarker: 'm' });
    expect(waiting()).toEqual([]);
    expect(calls).toEqual(['window', 'open local C:\\work\\a.txt', 'marker m']);
  });

  it('refuses a path that is not absolute on its host, which would resolve against a working folder of Damocles', async () => {
    const { requests, calls } = fake({ folders: new Set(['local:C:\\work', 'local:\\work']) });
    await expect(requests.fromSocket('ssh+h1', open('src/app.ts'))).resolves.toEqual({ ok: false, message: 'damocles: src/app.ts is not an absolute path on prod-1.' });
    await expect(requests.fromSocket('ssh+h1', { request: { kind: 'diff', cwd: '/srv/app', left: '/srv/app/b.txt', right: 'b.txt', wait: false } })).resolves.toEqual({ ok: false, message: 'damocles: b.txt is not an absolute path on prod-1.' });
    // a Windows path without its drive resolves against the working folder's drive
    for (const typed of ['work\\a.txt', '\\work', 'C:work\\a.txt']) {
      await requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: typed }], wait: false } });
      expect(calls.at(-1)).toBe(`notify damocles: ${typed} is not an absolute path on this computer.`);
    }
    expect(calls.filter((call) => !call.startsWith('notify'))).toEqual([]);
  });

  it('refuses a --remote value of no known form, opening nothing', async () => {
    const { requests, calls } = fake();
    for (const spec of ['container+x', 'ssh+', 'wsl']) {
      await requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: '/srv/app' }], wait: false }, remote: spec });
      expect(calls.at(-1)).toBe(`notify damocles: ${spec} names no host. Use wsl+<distro>, ssh+<host> or loopback.`);
    }
    expect(calls.filter((call) => !call.startsWith('notify'))).toEqual([]);
  });

  it('opens an unsaved --remote host in the Connect dialog filled in, connecting nothing', async () => {
    const { requests, calls } = fake();
    await requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: '/srv/app' }], wait: false }, remote: 'ssh+deploy@10.0.7.12' });
    expect(calls).toEqual(['connect dialog deploy@10.0.7.12', 'notify damocles: no saved host is called deploy@10.0.7.12. Connect to it, then run the command again.']);
  });

  it('connects a saved --remote host first, then opens on it; a WSL distro connects as Reopen in WSL connects it, and its folder adds like any host\'s', async () => {
    const { requests, calls } = fake({}, { resolveRemote: (spec) => resolveRemoteSpec(spec, [{ id: 'h1', kind: 'ssh', destination: { kind: 'alias', alias: 'prod' }, name: 'prod-1', recentFolders: [], settings: {} }], false) });
    await requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: '/srv/app' }], wait: false }, remote: 'ssh+PROD-1' });
    expect(calls).toEqual(['connect authority', 'window', 'select ssh+h1|/srv/app']);
    const wsl = fake({ folders: new Set(['wsl+Ubuntu:/home/ada/notes']), projects: [] });
    await wsl.requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: '/home/ada/notes' }], wait: false }, remote: 'wsl+Ubuntu' });
    expect(wsl.calls).toEqual(['connect wsl', 'window', 'ask Add /home/ada/notes on prod-1 as a project?', 'add wsl+Ubuntu /home/ada/notes']);
  });

  it('refuses loopback where the loopback daemon does not run', async () => {
    const { requests, calls } = fake();
    await requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: 'C:\\work' }], wait: false }, remote: 'loopback' });
    expect(calls).toEqual(['notify damocles: loopback names the local daemon, which runs only in a development build.']);
  });

  it('takes requests only from the CLI sockets and the app\'s command line, never from a renderer', () => {
    const root = path.join(__dirname, '..', '..');
    const index = fs.readFileSync(path.join(root, 'main', 'index.ts'), 'utf8');
    expect(index.match(/\.fromSocket\(/g)).toHaveLength(1);
    expect(index).toMatch(/connection\.workspace\.serve\('cli\.request', \(relay\) => this\.requireCliRequests\(\)\.fromSocket\(authorityKey, relay\)\)/);
    expect(index.match(/\.fromCommandLine\(/g)).toBeNull();
    expect(index.match(/\.fromArgv\(/g)).toHaveLength(1);
    expect(index.match(/this\.takeCommandLine\(([^)]*)\)/g)).toEqual(['this.takeCommandLine(argv)', 'this.takeCommandLine(process.argv)']);
    expect(index).toMatch(/app\.on\('second-instance', \(_event, argv\) => \{/);
    // no preload or renderer names the module or a channel for it
    for (const dir of ['preload', 'shell']) {
      const sources = fs.readdirSync(path.join(root, dir), { recursive: true, encoding: 'utf8' }).filter((file) => /\.(ts|vue)$/.test(file) && !file.includes('__tests__'));
      for (const file of sources) expect(fs.readFileSync(path.join(root, dir, file), 'utf8'), file).not.toMatch(/cli-requests|cli-protocol|cliRequest/);
    }
  });
});

describe('--remote resolution', () => {
  const hosts: HostRecord[] = [
    { id: 'h1', kind: 'ssh', destination: { kind: 'alias', alias: 'prod-alias' }, name: 'billing-prod', recentFolders: [], settings: {} },
    { id: 'h2', kind: 'ssh', destination: { kind: 'address', host: '10.0.7.12', user: 'deploy', port: 2222, options: [] }, name: 'deploy box', recentFolders: [], settings: {} },
    { id: 'h3', kind: 'wsl', distro: 'Ubuntu-24.04', name: 'Ubuntu', recentFolders: [], settings: {} },
  ];

  it('names a saved SSH host by its name, then its ssh alias, then user@host[:port], ignoring case', () => {
    expect(resolveRemoteSpec('ssh+billing-prod', hosts, false)).toEqual({ kind: 'authority', authorityKey: 'ssh+h1', hostId: 'h1' });
    expect(resolveRemoteSpec('ssh+BILLING-Prod', hosts, false)).toEqual({ kind: 'authority', authorityKey: 'ssh+h1', hostId: 'h1' });
    expect(resolveRemoteSpec('ssh+prod-alias', hosts, false)).toEqual({ kind: 'authority', authorityKey: 'ssh+h1', hostId: 'h1' });
    expect(resolveRemoteSpec('ssh+deploy@10.0.7.12:2222', hosts, false)).toEqual({ kind: 'authority', authorityKey: 'ssh+h2', hostId: 'h2' });
    expect(resolveRemoteSpec('ssh+DEPLOY BOX', hosts, false)).toMatchObject({ hostId: 'h2' });
    // the address without its saved port names no saved host
    expect(resolveRemoteSpec('ssh+deploy@10.0.7.12', hosts, false)).toEqual({ kind: 'unsaved', query: 'deploy@10.0.7.12' });
  });

  it('prefers a host\'s name over another host\'s alias', () => {
    const clash: HostRecord[] = [
      { id: 'a', kind: 'ssh', destination: { kind: 'alias', alias: 'staging' }, name: 'old', recentFolders: [], settings: {} },
      { id: 'b', kind: 'ssh', destination: { kind: 'alias', alias: 'b-alias' }, name: 'staging', recentFolders: [], settings: {} },
    ];
    expect(resolveRemoteSpec('ssh+staging', clash, false)).toMatchObject({ hostId: 'b' });
  });

  it('follows a rename at once: the new name resolves and the old one names no saved host', () => {
    const renamed = hosts.map((host) => (host.id === 'h1' ? { ...host, name: 'billing' } : host));
    expect(resolveRemoteSpec('ssh+billing', renamed, false)).toMatchObject({ hostId: 'h1' });
    expect(resolveRemoteSpec('ssh+billing-prod', renamed, false)).toEqual({ kind: 'unsaved', query: 'billing-prod' });
  });

  it('names a distro by its saved spelling, and loopback only where it runs', () => {
    expect(resolveRemoteSpec('wsl+ubuntu-24.04', hosts, false)).toEqual({ kind: 'wsl', distro: 'Ubuntu-24.04' });
    expect(resolveRemoteSpec('wsl+Debian', hosts, false)).toEqual({ kind: 'wsl', distro: 'Debian' });
    expect(resolveRemoteSpec('loopback', hosts, true)).toEqual({ kind: 'authority', authorityKey: 'loopback' });
    expect(resolveRemoteSpec('loopback', hosts, false)).toEqual({ kind: 'loopbackOff' });
  });
});
