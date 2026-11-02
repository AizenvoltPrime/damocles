import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../local-services/confine';
import { CliRequests, resolveRemoteSpec, type CliRequestsDeps, type PatchTab } from '../cli-requests';
import type { HostRecord } from '../remote/host-store';

const english = (message: string, ...args: string[]): string => message.replace(/\{(\d+)\}/g, (_match, index: string) => args[Number(index)] ?? '');

const APP: Project = { key: 'ssh+h1|/srv/app', fsPath: '/srv/app', name: 'app' };
const LOCAL: Project = { key: 'c:\\work', fsPath: 'C:\\work', name: 'work' };

interface World {
  // existing files and folders, by authority and path
  readonly files: Map<string, string>;
  readonly folders: Set<string>;
  readonly projects: Project[];
  // links inside a project: escapes' canonical path is outside every project; leaving lead out on the way, as confineExisting finds
  readonly escapes: Set<string>;
  readonly leaving: Set<string>;
}

function fake(world: Partial<World> = {}, overrides: Partial<CliRequestsDeps> = {}) {
  const files = world.files ?? new Map([['ssh+h1:/srv/app/src/app.ts', 'one\ntwo\n'], ['ssh+h1:/srv/app/b.txt', 'one\nthree\n'], ['local:C:\\work\\a.txt', 'a']]);
  const folders = world.folders ?? new Set(['ssh+h1:/srv/app', 'ssh+h1:/srv/app/src', 'ssh+h1:/srv/other', 'local:C:\\work']);
  const projects = world.projects ?? [APP, LOCAL];
  const escapes = world.escapes ?? new Set<string>();
  const leaving = world.leaving ?? new Set<string>();
  const calls: string[] = [];
  // whether each question focused its action (Add Project) rather than Cancel
  const focused: boolean[] = [];
  let tabs = 0;
  const closes = new Map<string, () => void>();
  const os = (authorityKey: string): NodeJS.Platform => (authorityKey === 'local' ? 'win32' : 'linux');
  const flavor = (authorityKey: string): typeof path.posix => (os(authorityKey) === 'win32' ? path.win32 : path.posix);
  const deps: CliRequestsDeps = {
    projects: (authorityKey) => projects.filter((project) => (authorityKey === 'local' ? !project.key.startsWith('ssh+') : project.key.startsWith(`${authorityKey}|`))),
    os,
    // this computer's messages have their own wording and never name it as a host
    hostName: (authorityKey) => {
      if (authorityKey === 'local') throw new Error('this computer is named as a host');
      return 'prod-1';
    },
    isDirectory: async (authorityKey, folder) => folders.has(`${authorityKey}:${folder}`),
    projectOfPath: async (authorityKey, candidates, target) => {
      const p = flavor(authorityKey);
      if (escapes.has(`${authorityKey}:${target}`)) return undefined;
      const project = candidates.find((candidate) => target.startsWith(candidate.fsPath + p.sep));
      return project && { project, relativePath: p.relative(project.fsPath, target).split(p.sep).join('/') };
    },
    confineExisting: async (authorityKey, project, relativePath) => {
      const full = flavor(authorityKey).join(project.fsPath, ...relativePath.split('/'));
      if (leaving.has(`${authorityKey}:${full}`)) return { ok: false, reason: 'outside' };
      return files.has(`${authorityKey}:${full}`) ? { ok: true, path: full } : { ok: false, reason: 'missing' };
    },
    read: async (authorityKey, file) => {
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
    openFile: async (projectKey, relativePath, position) => {
      calls.push(`open ${projectKey} ${relativePath}${position.line !== undefined ? ` @${position.line}` : ''}${position.column !== undefined ? `:${position.column}` : ''}`);
      return { ok: true, tabId: `tab-${++tabs}` };
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
    log: () => undefined,
    ...overrides,
  };
  return { requests: new CliRequests(deps), calls, focused, waiting: () => [...closes.keys()], close: (tabId: string) => closes.get(tabId)!() };
}

const open = (...paths: Array<string | { path: string; line?: number; column?: number }>) => ({
  request: { kind: 'open' as const, cwd: '/srv/app', items: paths.map((item) => (typeof item === 'string' ? { path: item } : item)), wait: false },
});

describe('the damocles command\'s requests in main', () => {
  it('opens a file inside a project of the terminal\'s host at its line and column, bringing the window forward', async () => {
    const { requests, calls } = fake();
    await expect(requests.fromSocket('ssh+h1', open({ path: '/srv/app/src/app.ts', line: 42, column: 3 }))).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['window', 'open ssh+h1|/srv/app src/app.ts @42:3']);
  });

  it('reads path:line:column so only when the path as typed does not exist', async () => {
    const files = new Map([['ssh+h1:/srv/app/notes:12', 'a file named with a colon'], ['ssh+h1:/srv/app/notes', 'n']]);
    const { requests, calls } = fake({ files });
    await requests.fromSocket('ssh+h1', open({ path: '/srv/app/notes', line: 12 }));
    expect(calls).toEqual(['window', 'open ssh+h1|/srv/app notes:12']);
    // the unsplit name is missing: the position applies
    const missing = fake({ files: new Map([['ssh+h1:/srv/app/notes', 'n']]) });
    await missing.requests.fromSocket('ssh+h1', open({ path: '/srv/app/notes', line: 12 }));
    expect(missing.calls).toEqual(['window', 'open ssh+h1|/srv/app notes @12']);
  });

  it('refuses a file outside every project of its host with the exact message, opening nothing', async () => {
    const { requests, calls } = fake();
    await expect(requests.fromSocket('ssh+h1', open('/srv/app/src/app.ts', '/etc/hosts'))).resolves.toEqual({
      ok: false,
      message: 'damocles: /etc/hosts is outside the projects open on prod-1. Open its folder with: damocles /etc',
    });
    expect(calls).toEqual([]);
    // a file of another host's project is outside this host's projects
    await expect(requests.fromSocket('ssh+h2', open('/srv/app/src/app.ts'))).resolves.toMatchObject({ ok: false });
  });

  it('names paths as the host does, with `.` and `..` resolved and no trailing separator, as a WSL shell\'s `$PWD/.` arrives', async () => {
    const { requests, calls } = fake();
    await requests.fromSocket('ssh+h1', open('/srv/other/.', '/srv/app/src/../src/app.ts', '/srv/app/'));
    expect(calls).toEqual(['window', 'ask Add /srv/other on prod-1 as a project?', 'add ssh+h1 /srv/other', 'open ssh+h1|/srv/app src/app.ts', 'select ssh+h1|/srv/app']);
    const local = fake();
    await local.requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: 'C:\\work\\.\\a.txt' }, { path: 'C:\\work\\' }], wait: false } });
    expect(local.calls).toEqual(['window', 'open c:\\work a.txt', 'select c:\\work']);
  });

  it('refuses a missing file inside a project', async () => {
    const { requests } = fake();
    await expect(requests.fromSocket('ssh+h1', open('/srv/app/missing.ts'))).resolves.toEqual({ ok: false, message: 'damocles: /srv/app/missing.ts does not exist.' });
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
    const { requests, calls } = fake();
    await requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\work', items: [{ path: 'C:\\work\\a.txt' }], wait: false } });
    expect(calls).toEqual(['window', 'open c:\\work a.txt']);
    calls.length = 0;
    await requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: 'C:\\Windows\\win.ini' }], wait: true }, waitMarker: 'C:\\Temp\\damocles-wait-1' });
    expect(calls).toEqual(['claim C:\\Temp\\damocles-wait-1', 'notify damocles: C:\\Windows\\win.ini is outside the projects open on this computer. Open its folder with: damocles C:\\Windows', 'marker C:\\Temp\\damocles-wait-1']);
  });

  it('deletes the wait marker of the command line once the tab closed', async () => {
    const { requests, calls, close } = fake();
    const done = requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\work', items: [{ path: 'C:\\work\\a.txt' }], wait: true }, waitMarker: 'm' });
    await vi.waitFor(() => expect(calls).toContain('open c:\\work a.txt'));
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
    expect(both.calls).toEqual(['window', 'ask Add /srv/other on prod-1 as a project?', 'ask Add /srv/third on prod-1 as a project?', 'add ssh+h1 /srv/other', 'open ssh+h1|/srv/app b.txt', 'add ssh+h1 /srv/third']);
    const declined = fake({}, { confirm: async (question) => question.includes('/srv/app') });
    await expect(declined.requests.fromSocket('ssh+h1', { request: { kind: 'open', cwd: '/srv/app', items: [{ path: '/srv/app/src/app.ts' }, { path: '/srv/other' }], wait: true } })).resolves.toEqual({ ok: false, message: 'damocles: /srv/other was not added as a project.' });
    expect(declined.calls).toEqual(['window']);
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

  it('says a path that leads out of its project through a link does so, never that it does not exist, and offers no folder that is already a project', async () => {
    const { requests } = fake({ files: new Map([['ssh+h1:/srv/app/link.txt', 'x'], ['ssh+h1:/srv/app/escape.txt', 'x']]), leaving: new Set(['ssh+h1:/srv/app/link.txt']), escapes: new Set(['ssh+h1:/srv/app/escape.txt', 'ssh+h1:/srv/app/src/deep.txt']) });
    await expect(requests.fromSocket('ssh+h1', open('/srv/app/link.txt'))).resolves.toEqual({ ok: false, message: 'damocles: /srv/app/link.txt leads outside its project.' });
    await expect(requests.fromSocket('ssh+h1', open('/srv/app/escape.txt'))).resolves.toEqual({ ok: false, message: 'damocles: /srv/app/escape.txt leads outside the projects open on prod-1.' });
    await expect(requests.fromSocket('ssh+h1', open('/srv/app/src/deep.txt'))).resolves.toEqual({ ok: false, message: 'damocles: /srv/app/src/deep.txt leads outside the projects open on prod-1.' });
    await expect(requests.fromSocket('ssh+h1', { request: { kind: 'diff', cwd: '/', left: '/srv/app/link.txt', right: '/srv/app/b.txt', wait: false } })).resolves.toEqual({ ok: false, message: 'damocles: /srv/app/link.txt leads outside its project.' });
    const local = fake();
    await local.requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\', items: [{ path: 'C:\\work\\gone.txt' }], wait: false } });
    expect(local.calls).toEqual(['notify damocles: C:\\work\\gone.txt does not exist.']);
  });

  it('names the path as typed in a refusal, position included, when neither its whole nor its split form opens', async () => {
    const { requests } = fake();
    await expect(requests.fromSocket('ssh+h1', open({ path: '/etc/hosts', line: 12 }))).resolves.toEqual({ ok: false, message: 'damocles: /etc/hosts:12 is outside the projects open on prod-1. Open its folder with: damocles /etc' });
    await expect(requests.fromSocket('ssh+h1', open({ path: '/srv/app/nope.ts', line: 3, column: 4 }))).resolves.toEqual({ ok: false, message: 'damocles: /srv/app/nope.ts:3:4 does not exist.' });
    await expect(requests.fromSocket('ssh+h1', open({ path: 'src/a.ts', line: 3 }))).resolves.toEqual({ ok: false, message: 'damocles: src/a.ts:3 is not an absolute path on prod-1.' });
  });

  it('tells why the editor could not open a file in words, never as a code', async () => {
    for (const [reason, message] of [['missing', 'damocles: /srv/app/b.txt does not exist.'], ['outside', 'damocles: /srv/app/b.txt leads outside its project.'], ['failed', 'damocles: /srv/app/b.txt could not be opened.']] as const) {
      const { requests } = fake({}, { openFile: async () => ({ ok: false, reason }) });
      await expect(requests.fromSocket('ssh+h1', open('/srv/app/b.txt'))).resolves.toEqual({ ok: false, message });
    }
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
    expect(calls).toEqual([`marker ${marker}`, `marker ${marker}`, 'window', 'open c:\\work a.txt']);
  });

  it('does not wait on a marker the command already removed', async () => {
    const { requests, calls, waiting } = fake({}, { claimWaitMarker: async () => false });
    await requests.fromCommandLine({ request: { kind: 'open', cwd: 'C:\\work', items: [{ path: 'C:\\work\\a.txt' }], wait: true }, waitMarker: 'm' });
    expect(waiting()).toEqual([]);
    expect(calls).toEqual(['window', 'open c:\\work a.txt', 'marker m']);
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
