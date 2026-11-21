import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkConfigPath, checkConfigPathSync, configLinkPolicy, noticeRefusedConfigRead, userConfigBase, type ConfigPathVerdict } from '../local-config-path';
import { linkStaysLocalSync } from '../../local-links';

// The QueryDosDeviceW answer for a drive a test maps, by name (`R:`); any other asks Windows.
const dosDevices = vi.hoisted(() => new Map<string, string>());
vi.mock('../../dos-devices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../dos-devices')>();
  return { queryDosDevice: (name: string): string | undefined => dosDevices.get(name) ?? actual.queryDosDevice(name) };
});

// The sync walk's lstatSync, readlinkSync and realpathSync.native go to these twins of the promise spies below.
const syncFs = vi.hoisted(() => ({ fake: undefined as undefined | { lstat(file: string): { isSymbolicLink(): boolean }; readlink(file: string): string; realpath(file: string): string } }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const lstatSync = ((...args: Parameters<typeof actual.lstatSync>) => (syncFs.fake ? syncFs.fake.lstat(String(args[0])) : actual.lstatSync(...args))) as typeof actual.lstatSync;
  const readlinkSync = ((...args: Parameters<typeof actual.readlinkSync>) => (syncFs.fake ? syncFs.fake.readlink(String(args[0])) : actual.readlinkSync(...args))) as typeof actual.readlinkSync;
  const native = ((...args: Parameters<typeof actual.realpathSync.native>) => (syncFs.fake ? syncFs.fake.realpath(String(args[0])) : actual.realpathSync.native(...args))) as typeof actual.realpathSync.native;
  const realpathSync = Object.assign(((...args: Parameters<typeof actual.realpathSync>) => actual.realpathSync(...args)) as typeof actual.realpathSync, { native });
  const overrides = { lstatSync, readlinkSync, realpathSync };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

let root: string;
// the folder every faked link really leads to, while its readlink answers a share
let marker: string;
// a link's path, lowercased -> what readlink answers for it
let fakeTargets: Map<string, string>;
// every call that named a UNC path
let uncCalls: string[];

const isUnc = (file: string): boolean => /^[\\/]{2}/.test(file);

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-config-path-')));
  marker = path.join(root, 'marker');
  fs.mkdirSync(path.join(marker, 'x'), { recursive: true });
  fakeTargets = new Map();
  uncCalls = [];
  const readlink = fs.promises.readlink.bind(fs.promises);
  vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) => fakeTargets.get(String(file).toLowerCase()) ?? readlink(file)) as typeof fs.promises.readlink);
  for (const name of ['realpath', 'lstat', 'stat', 'open', 'readdir'] as const) {
    const original = fs.promises[name].bind(fs.promises) as (file: fs.PathLike) => Promise<unknown>;
    vi.spyOn(fs.promises, name).mockImplementation((async (file: fs.PathLike) => {
      if (isUnc(String(file))) {
        uncCalls.push(String(file));
        throw new Error(`reached ${String(file)}`);
      }
      return original(file);
    }) as never);
  }
  const reached = (file: string): never => {
    uncCalls.push(file);
    throw new Error(`reached ${file}`);
  };
  syncFs.fake = {
    lstat: (file) => (isUnc(file) ? reached(file) : actualFs.lstatSync(file)),
    readlink: (file) => fakeTargets.get(file.toLowerCase()) ?? actualFs.readlinkSync(file),
    realpath: (file) => (isUnc(file) ? reached(file) : actualFs.realpathSync.native(file)),
  };
});

afterEach(() => {
  syncFs.fake = undefined;
  dosDevices.clear();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function junction(at: string, target: string): void {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, 'junction');
}

// A link the walk reads as one to target, which really leads to marker.
function linkTo(at: string, target: string): void {
  junction(at, marker);
  fakeTargets.set(at.toLowerCase(), target);
}

// A fake file system on shares that do not exist, for both walks: each path is a link to its target, an entry when its target
// is undefined, and missing when absent; any path on another root answers from the disk.
function fakeShare(fake: Map<string, string | undefined>): void {
  const roots = new Set([...fake.keys()].map((known) => path.parse(known).root.toLowerCase()));
  const onFake = (file: string): boolean => roots.has(path.parse(path.resolve(file)).root.toLowerCase());
  const entry = (file: string): { isSymbolicLink(): boolean } => {
    const found = [...fake.entries()].find(([known]) => known.toLowerCase() === file.toLowerCase());
    if (found === undefined) throw Object.assign(new Error(`ENOENT ${file}`), { code: 'ENOENT' });
    return { isSymbolicLink: () => found[1] !== undefined };
  };
  for (const [link, target] of fake) if (target !== undefined) fakeTargets.set(link.toLowerCase(), target);
  const lstat = vi.mocked(fs.promises.lstat);
  const lstatOf = lstat.getMockImplementation()!;
  lstat.mockImplementation((async (file: fs.PathLike) => (onFake(String(file)) ? entry(String(file)) : lstatOf(file))) as never);
  // a folder on a faked root is its own realpath
  const realpath = vi.mocked(fs.promises.realpath);
  const realpathOf = realpath.getMockImplementation()!;
  realpath.mockImplementation((async (file: fs.PathLike) => (onFake(String(file)) ? String(file) : realpathOf(file))) as never);
  const local = syncFs.fake!;
  syncFs.fake = { ...local, lstat: (file) => (onFake(file) ? entry(file) : local.lstat(file)), realpath: (file) => (onFake(file) ? file : local.realpath(file)) };
}

// Both forms answer the same for the same file.
async function verdicts(base: string, file: string): Promise<ConfigPathVerdict> {
  const answer = await checkConfigPath(base, file);
  expect(checkConfigPathSync(base, file)).toEqual(answer);
  return answer;
}

describe.runIf(process.platform === 'win32')('checkConfigPath and checkConfigPathSync (win32)', () => {
  it('refuse a config file linked onto another share or WSL without reaching it', async () => {
    const project = path.join(root, 'p');
    linkTo(path.join(project, '.damocles'), '\\\\host\\share\\dm');
    linkTo(path.join(project, '.claude'), '\\\\wsl.localhost\\Ubuntu\\home\\u\\.claude');
    expect(await verdicts(project, path.join(project, '.damocles', 'settings.json'))).toEqual({ refused: 'share' });
    expect(await verdicts(project, path.join(project, '.claude', 'settings.json'))).toEqual({ refused: 'share' });
    expect(uncCalls).toEqual([]);
  });

  it('refuse NT-spelled UNC, device and chained targets alike', async () => {
    const project = path.join(root, 'p');
    linkTo(path.join(project, 'nt'), '\\??\\UNC\\host\\share\\dm');
    linkTo(path.join(project, 'pipe'), '\\\\.\\pipe\\dm');
    fs.mkdirSync(path.join(root, 'middle'), { recursive: true });
    junction(path.join(project, 'chain'), path.join(root, 'middle'));
    linkTo(path.join(root, 'middle', 'dm'), '\\\\host\\share\\dm');
    // the same link as named through the junction, which readlink is asked under
    fakeTargets.set(path.join(project, 'chain', 'dm').toLowerCase(), '\\\\host\\share\\dm');
    expect(await verdicts(project, path.join(project, 'nt', 'settings.json'))).toEqual({ refused: 'share' });
    expect(await verdicts(project, path.join(project, 'pipe', 'settings.json'))).toEqual({ refused: 'share' });
    expect(await verdicts(project, path.join(project, 'chain', 'dm', 'settings.json'))).toEqual({ refused: 'share' });
    expect(uncCalls).toEqual([]);
  });

  it('follow a local link, and answer ok for a missing file, which the reader then meets itself', async () => {
    const project = path.join(root, 'p');
    fs.mkdirSync(path.join(root, 'dotfiles'), { recursive: true });
    junction(path.join(project, '.damocles'), path.join(root, 'dotfiles'));
    expect(await verdicts(project, path.join(project, '.damocles', 'settings.json'))).toBe('ok');
    expect(await verdicts(project, path.join(project, 'missing', 'settings.json'))).toBe('ok');
  });

  it('follow a link that stays on the base folder\'s own share', async () => {
    fakeShare(new Map([['\\\\corp\\home\\u', undefined], ['\\\\corp\\home\\u\\.damocles', '\\\\corp\\home\\dotfiles'], ['\\\\corp\\home\\dotfiles', undefined], ['\\\\corp\\home\\dotfiles\\settings.json', undefined]]));
    expect(await verdicts('\\\\corp\\home\\u', '\\\\corp\\home\\u\\.damocles\\settings.json')).toBe('ok');
    // share names compare case-blind, as Windows does
    expect(await verdicts('\\\\CORP\\Home\\u', '\\\\CORP\\Home\\u\\.damocles\\settings.json')).toBe('ok');
    fakeTargets.set('\\\\corp\\home\\u\\.damocles', '\\\\other\\share');
    expect(await verdicts('\\\\corp\\home\\u', '\\\\corp\\home\\u\\.damocles\\settings.json')).toEqual({ refused: 'share' });
    expect(uncCalls).toEqual([]);
  });

  it('judge a path outside its base folder from its own root, so a plain file on a share is ok and a link off it is not', async () => {
    fakeShare(new Map([['\\\\corp\\data\\app', undefined], ['\\\\corp\\data\\app\\projects.json', undefined], ['\\\\corp\\data\\app\\out', '\\\\evil\\s']]));
    expect(await verdicts(root, '\\\\corp\\data\\app\\projects.json')).toBe('ok');
    expect(await verdicts(root, '\\\\corp\\data\\app\\out\\x.json')).toEqual({ refused: 'share' });
    expect(uncCalls).toEqual([]);
  });

  it('follow a link onto a mapped drive as the user\'s own mapping', async () => {
    const project = path.join(root, 'p');
    linkTo(path.join(project, '.damocles'), 'Q:\\dm');
    fakeShare(new Map([['Q:\\', undefined], ['Q:\\dm', undefined], ['Q:\\dm\\settings.json', undefined]]));
    expect(await verdicts(project, path.join(project, '.damocles', 'settings.json'))).toBe('ok');
  });

  it('reject a loop as ELOOP in both forms', async () => {
    const project = path.join(root, 'p');
    junction(path.join(project, 'a'), path.join(project, 'b'));
    junction(path.join(project, 'b'), path.join(project, 'a'));
    await expect(checkConfigPath(project, path.join(project, 'a', 'x.json'))).rejects.toMatchObject({ code: 'ELOOP' });
    expect(() => checkConfigPathSync(project, path.join(project, 'a', 'x.json'))).toThrow(expect.objectContaining({ code: 'ELOOP' }));
  });

  it('reject with ETIMEDOUT when a network drive a link leads onto does not answer, which the reader takes as unreadable', async () => {
    vi.resetModules();
    const { checkConfigPath: check } = await import('../local-config-path');
    const project = path.join(root, 'p');
    linkTo(path.join(project, '.damocles'), 'R:\\dm');
    dosDevices.set('R:', String.raw`\Device\LanmanRedirector\;R:000000000004111a\nas\dm`);
    const lstat = vi.mocked(fs.promises.lstat);
    const original = lstat.getMockImplementation()!;
    lstat.mockImplementation((async (file: fs.PathLike) => (String(file) === 'R:\\' ? new Promise(() => undefined) : original(file))) as never);
    await expect(check(project, path.join(project, '.damocles', 'settings.json'))).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  });
});

describe.runIf(process.platform === 'win32')('configLinkPolicy (win32)', () => {
  // syncFs.fake's lstat, counting every call, so a test sees how often the walks touched the disk.
  function countLstats(): { readonly count: () => number } {
    let calls = 0;
    const local = syncFs.fake!;
    syncFs.fake = { ...local, lstat: (file) => (calls++, local.lstat(file)) };
    return { count: () => calls };
  }

  it('judges a file inside a base from that base, so a base whose realpath is on a share follows a link onto that share', () => {
    const work = path.join(root, 'work');
    fs.mkdirSync(path.join(marker, 'proj'), { recursive: true });
    junction(work, marker);
    const base = path.join(work, 'proj');
    linkTo(path.join(base, '.pi'), '\\\\corp\\projects\\shared');
    // the same link as named through the junction, which a walk from the drive root asks readlink under
    fakeTargets.set(path.join(marker, 'proj', '.pi').toLowerCase(), '\\\\corp\\projects\\shared');
    fakeShare(new Map([['\\\\corp\\projects\\shared', undefined], ['\\\\corp\\projects\\shared\\settings.json', undefined]]));
    // the base is reached through a local link onto the share it is on
    const local = syncFs.fake!;
    syncFs.fake = { ...local, realpath: (file) => (file.toLowerCase() === base.toLowerCase() ? '\\\\corp\\projects\\proj' : local.realpath(file)) };
    const file = path.join(base, '.pi', 'settings.json');
    expect(configLinkPolicy([base])(file)).toBe(true);
    // judged from its drive root, the same file is refused
    expect(linkStaysLocalSync(file)).toBe(false);
    fakeTargets.set(path.join(base, '.pi').toLowerCase(), '\\\\other\\projects\\shared');
    expect(configLinkPolicy([base])(file)).toBe(false);
    expect(uncCalls).toEqual([]);
  });

  it('follows a link above every base onto a base\'s own share, as for a context file between that link and the project', () => {
    const work = path.join(root, 'work');
    fs.mkdirSync(path.join(marker, 'proj'), { recursive: true });
    linkTo(work, '\\\\corp\\projects');
    const base = path.join(work, 'proj');
    fakeShare(new Map([['\\\\corp\\projects\\AGENTS.md', undefined]]));
    const local = syncFs.fake!;
    syncFs.fake = { ...local, realpath: (file) => (file.toLowerCase() === base.toLowerCase() ? '\\\\corp\\projects\\proj' : local.realpath(file)) };
    const ancestor = path.join(work, 'AGENTS.md');
    expect(configLinkPolicy([base])(ancestor)).toBe(true);
    // judged from its drive root alone, the same file is refused
    expect(linkStaysLocalSync(ancestor)).toBe(false);
    fakeTargets.set(work.toLowerCase(), '\\\\other\\projects');
    expect(configLinkPolicy([base])(ancestor)).toBe(false);
    expect(uncCalls).toEqual([]);
  });

  it('judges a file from the deepest base holding it, whose own link is never judged', () => {
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    linkTo(path.join(home, '.damocles'), '\\\\corp\\dm');
    const file = path.join(home, '.damocles', 'settings.json');
    expect(configLinkPolicy([home, path.join(home, '.damocles')])(file)).toBe(true);
    expect(configLinkPolicy([path.join(home, '.damocles'), home])(file)).toBe(true);
    expect(configLinkPolicy([home])(file)).toBe(false);
    expect(uncCalls).toEqual([]);
  });

  it('refuses a file outside every base spelled on a share none of them is on without touching it, and walks one on a base\'s share', () => {
    const base = '\\\\corp\\home\\u';
    fakeShare(new Map([['\\\\corp\\home\\u', undefined], ['\\\\corp\\home\\other', undefined], ['\\\\corp\\home\\other\\x.json', undefined]]));
    const lstats = countLstats();
    const policy = configLinkPolicy([base, root]);
    for (const foreign of ['\\\\evil\\s\\x.json', '\\\\?\\UNC\\evil\\s\\x.json', '\\\\?\\GLOBALROOT\\Device\\Mup\\corp\\home\\x.json', '\\\\.\\pipe\\x']) {
      expect(policy(foreign)).toBe(false);
    }
    expect(lstats.count()).toBe(0);
    expect(uncCalls).toEqual([]);
    expect(policy('\\\\corp\\home\\other\\x.json')).toBe(true);
  });

  it('refuses a file a loop holds, inside a base or outside every base', () => {
    const project = path.join(root, 'p');
    junction(path.join(project, 'a'), path.join(project, 'b'));
    junction(path.join(project, 'b'), path.join(project, 'a'));
    expect(configLinkPolicy([project])(path.join(project, 'a', 'x.json'))).toBe(false);
    expect(configLinkPolicy([path.join(root, 'elsewhere')])(path.join(project, 'a', 'x.json'))).toBe(false);
  });

  it('reads each path once in one run of probes, and again in a later run', async () => {
    const project = path.join(root, 'p');
    fs.mkdirSync(path.join(project, 'deep', 'er'), { recursive: true });
    const lstats = countLstats();
    const policy = configLinkPolicy([root]);
    const first = path.join(project, 'deep', 'er', 'AGENTS.md');
    expect(policy(first)).toBe(true);
    const once = lstats.count();
    expect(policy(first)).toBe(true);
    expect(lstats.count()).toBe(once);
    // a sibling shares every folder above it with the first walk
    expect(policy(path.join(project, 'deep', 'er', 'CLAUDE.md'))).toBe(true);
    expect(lstats.count()).toBe(once + 1);
    await Promise.resolve();
    // the next run, as a later reload, walks again and sees a link made since
    linkTo(path.join(project, 'deep', 'er', 'AGENTS.md'), '\\\\evil\\s\\AGENTS.md');
    expect(policy(first)).toBe(false);
    expect(lstats.count()).toBeGreaterThan(once + 1);
    expect(uncCalls).toEqual([]);
  });
});

describe('checkConfigPath off Windows', () => {
  it('answers ok without touching the file system', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const lstat = vi.mocked(fs.promises.lstat);
      lstat.mockClear();
      const syncCalls: string[] = [];
      const local = syncFs.fake!;
      syncFs.fake = { lstat: (file) => (syncCalls.push(file), local.lstat(file)), readlink: (file) => (syncCalls.push(file), local.readlink(file)), realpath: (file) => (syncCalls.push(file), local.realpath(file)) };
      expect(await checkConfigPath(root, '\\\\host\\share\\settings.json')).toBe('ok');
      expect(checkConfigPathSync(root, path.join(root, 'settings.json'))).toBe('ok');
      expect(configLinkPolicy([root])('\\\\host\\share\\settings.json')).toBe(true);
      expect(configLinkPolicy([root])(path.join(root, 'settings.json'))).toBe(true);
      expect(lstat).not.toHaveBeenCalled();
      expect(syncCalls).toEqual([]);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('noticeRefusedConfigRead', () => {
  it('tells the user once per file for the process, whichever reader refused it, and only through a channel', () => {
    const file = path.join(root, 'once', 'settings.json');
    const first = { warn: vi.fn(async () => undefined) };
    const second = { warn: vi.fn(async () => undefined) };
    noticeRefusedConfigRead(file, undefined);
    noticeRefusedConfigRead(file, first);
    noticeRefusedConfigRead(file, second);
    expect(first.warn).toHaveBeenCalledWith({ message: '{0} links to a network share or WSL path, so Damocles does not read it.', args: [file] });
    expect(second.warn).not.toHaveBeenCalled();
  });
});

describe('userConfigBase', () => {
  it('is the Damocles data folder for a file in it and the home folder otherwise', () => {
    const home = path.join(root, 'home');
    expect(userConfigBase(path.join(home, '.damocles', 'mcp.json'), home)).toBe(path.join(home, '.damocles'));
    expect(userConfigBase(path.join(home, '.claude', 'settings.json'), home)).toBe(home);
  });
});
