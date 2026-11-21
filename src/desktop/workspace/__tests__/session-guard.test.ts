import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reachesNamedStore, reachesSessions } from '../session-guard';

const WSL = { platform: 'linux', drives: [{ mountPoint: '/mnt/c', prefix: [] }] } as const;
const WINDOWS = { platform: 'win32', drives: [] } as const;
const MAC = { platform: 'darwin', drives: [] } as const;
const holdsNoHome = async (): Promise<boolean> => false;

describe('a store any machine keeps under its home, by the guarded folders\' names', () => {
  it('refuses every action inside a WSL drive mount\'s sessions or lease folder, in any case and by an 8.3 alias', async () => {
    for (const home of ['.damocles', '.DAMOCLES', 'DAMOCL~1']) {
      for (const file of [`/mnt/c/Users/me/${home}/pi/agent/sessions/x.jsonl`, `/mnt/c/Users/me/${home}/pi/AGENT/sessions/--w--/x.jsonl`, `/mnt/c/Users/me/${home}/locks/sessions/x.lock`, `/mnt/c/Users/me/${home}/PI~1/agent/SESSIO~1`]) {
        for (const removes of [false, true]) expect(await reachesNamedStore(file, removes, WSL, holdsNoHome), `${file} ${removes}`).toBe(true);
      }
    }
  });

  it('refuses a Windows path into another distro\'s store or a drive\'s, case-blind, and an 8.3 alias only through a WSL drive alias', async () => {
    const refused = [
      '\\\\wsl.localhost\\Ubuntu\\home\\u\\.damocles\\locks\\sessions\\x.lock',
      '\\\\wsl$\\Ubuntu\\home\\u\\.Damocles\\pi\\agent\\sessions\\--w--\\x.jsonl',
      'C:\\Users\\me\\.DAMOCLES\\pi\\agent\\sessions\\x.jsonl',
      'D:\\backup\\.damocles\\locks\\sessions',
      '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\me\\DAMOCL~1\\pi\\agent\\sessions\\x.jsonl',
    ];
    for (const file of refused) expect(await reachesNamedStore(file, false, WINDOWS, holdsNoHome), file).toBe(true);
    // a native drive path is judged on its realpath, which names the folder in full
    expect(await reachesNamedStore('C:\\Users\\me\\DAMOCL~1\\pi\\agent\\sessions\\x.jsonl', false, WINDOWS, holdsNoHome)).toBe(false);
  });

  it('compares a native Linux path exactly and a macOS one case-blind', async () => {
    expect(await reachesNamedStore('/home/u/.damocles/pi/agent/sessions/x.jsonl', false, WSL, holdsNoHome)).toBe(true);
    expect(await reachesNamedStore('/home/u/.DAMOCLES/pi/agent/sessions/x.jsonl', false, WSL, holdsNoHome)).toBe(false);
    expect(await reachesNamedStore('/home/u/DAMOCL~1/pi/agent/sessions/x.jsonl', false, WSL, holdsNoHome)).toBe(false);
    expect(await reachesNamedStore('/Users/u/.DAMOCLES/locks/Sessions/x.lock', false, MAC, holdsNoHome)).toBe(true);
  });

  it('refuses deleting or moving a folder only when a guarded folder exists below it, by the rest of its chain or a whole one', async () => {
    const existing = new Set([
      '/mnt/c/Users/me/.damocles/pi/agent/sessions',
      '/mnt/c/Users/me/DAMOCL~1/locks/sessions',
      '/mnt/c/Users/u2/.damocles/locks/sessions',
      '\\\\wsl.localhost\\Ubuntu\\home\\u\\.damocles\\locks\\sessions',
    ]);
    const holds = (separator: string) => async (folder: string, below: readonly string[]): Promise<boolean> => existing.has([folder, ...below].join(separator));
    for (const folder of ['/mnt/c/Users/me/.damocles', '/mnt/c/Users/me/DAMOCL~1', '/mnt/c/Users/me/.damocles/pi', '/mnt/c/Users/me/.damocles/pi/agent', '/mnt/c/Users/me', '/mnt/c/Users/u2', '/mnt/c/Users/u2/.damocles/locks']) {
      expect(await reachesNamedStore(folder, true, WSL, holds('/')), folder).toBe(true);
      expect(await reachesNamedStore(folder, false, WSL, holds('/')), folder).toBe(false);
    }
    expect(await reachesNamedStore('\\\\wsl.localhost\\Ubuntu\\home\\u', true, WINDOWS, holds('\\'))).toBe(true);
    const notHeld = ['/mnt/c/Users/me/.damocles/locks', '/mnt/c/Users/u2/.damocles/pi', '/mnt/c/Users/other', '/mnt/c/Users/other/.damocles', '/mnt/c/Users/me/PROGRA~1', '/mnt/c/Users/me/projects/x', '/mnt/c/Users/me/.damocles/worktrees', '/mnt/c/Users/me/.damocles/settings.json', '/mnt/c/Users/me/.damocles/pi/models.json'];
    for (const folder of notHeld) expect(await reachesNamedStore(folder, true, WSL, holds('/')), folder).toBe(false);
  });

  it('fails closed when a probe below a removed folder fails other than missing', async () => {
    const denied = async (): Promise<boolean> => Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
    await expect(reachesNamedStore('/mnt/c/Users/me/projects/x', true, WSL, denied)).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('lets through folders named sessions, locks or pi/agent outside a .damocles folder', async () => {
    for (const file of ['/home/u/work/sessions/x.jsonl', '/home/u/work/pi/agent/sessions/x.jsonl', '/mnt/c/work/locks/sessions/x.lock', '/home/u/damocles/pi/agent/sessions/x.jsonl']) {
      for (const removes of [false, true]) expect(await reachesNamedStore(file, removes, WSL, holdsNoHome), file).toBe(false);
    }
    expect(await reachesNamedStore('C:\\work\\pi\\agent\\sessions\\x.jsonl', true, WINDOWS, holdsNoHome)).toBe(false);
  });
});

describe('this machine\'s session leases', () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-session-guard-')));
    // a home not named .damocles, so only its exact path guards it
    home = path.join(root, 'dhome');
    fs.mkdirSync(path.join(home, 'locks', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, 'locks', 'sessions', 's1.lock'), '');
    fs.mkdirSync(path.join(home, 'locks', 'other'), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses an action inside the lease folder and a delete or move of a folder that holds it', async () => {
    for (const removes of [false, true]) {
      expect(await reachesSessions(path.join(home, 'locks', 'sessions', 's1.lock'), home, removes)).toBe(true);
      expect(await reachesSessions(path.join(home, 'locks', 'sessions', 's2.lock'), home, removes)).toBe(true);
    }
    expect(await reachesSessions(path.join(home, 'locks'), home, true)).toBe(true);
    expect(await reachesSessions(path.join(home, 'locks'), home, false)).toBe(false);
    expect(await reachesSessions(path.join(home, 'locks', 'other'), home, true)).toBe(false);
  });

  it('refuses deleting a folder a store or lease folder of another home lies below, and lets through a .damocles that holds neither', async () => {
    const user = path.join(root, 'user');
    fs.mkdirSync(path.join(user, '.damocles', 'pi', 'agent', 'sessions'), { recursive: true });
    const leases = path.join(root, 'leases');
    fs.mkdirSync(path.join(leases, '.damocles', 'locks', 'sessions'), { recursive: true });
    for (const holder of [user, path.join(user, '.damocles'), path.join(user, '.damocles', 'pi'), path.join(user, '.damocles', 'pi', 'agent'), leases, path.join(leases, '.damocles'), path.join(leases, '.damocles', 'locks')]) {
      expect(await reachesSessions(holder, home, true), holder).toBe(true);
    }
    // a project's own settings folder, and a folder that merely holds one
    const project = path.join(root, 'project');
    fs.mkdirSync(path.join(project, '.damocles', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(project, '.damocles', 'settings.json'), '{}');
    fs.mkdirSync(path.join(root, 'plain', 'sessions'), { recursive: true });
    for (const free of [project, path.join(project, '.damocles'), path.join(leases, '.damocles', 'pi'), path.join(root, 'plain'), path.join(root, 'plain', 'sessions')]) {
      expect(await reachesSessions(free, home, true), free).toBe(false);
    }
  });

  it('refuses deleting a folder whose probe below it fails other than missing, naming the error', async () => {
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    const lstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (target, options) => {
      if (String(target).startsWith(`${project}${path.sep}`) && path.basename(String(target)) === 'sessions') throw Object.assign(new Error(`EACCES: permission denied, lstat '${String(target)}'`), { code: 'EACCES' });
      return lstat(target, options as never) as never;
    });
    await expect(reachesSessions(project, home, true)).rejects.toMatchObject({ code: 'EACCES' });
  });
});
