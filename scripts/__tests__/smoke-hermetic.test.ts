import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSmokeHome, OWNER_MARKER, PI_REFRESH_WINDOW_MS, removeTree, RUN_MARGIN_MS, seedAuth, smokeEnv } from '../smoke-desktop/hermetic.mjs';
import { createSmokeSession } from '../smoke-desktop/session.mjs';

const NOW = Date.UTC(2026, 9, 29, 12, 0);
const HOUR = 60 * 60 * 1000;

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'damocles-smoke-hermetic-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTree(dir);
});

const write = (file: string, text: string): void => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
};

/** A developer home with a sign-in, preferences, the subscription plugin's clone and state the smoke app must not see. */
function realHome(auth: Record<string, unknown>): string {
  const home = tempDir();
  const agent = join(home, '.damocles', 'pi', 'agent');
  write(join(home, '.damocles', 'settings.json'), '{"damocles.desktop.projects.view":"flat"}');
  write(join(home, '.damocles', 'provider-key-sweep.json'), '{"sweptAt":1}');
  write(join(home, '.damocles', 'worktrees', 'registry.json'), '{"records":[]}');
  write(join(home, '.damocles', 'hooks.json'), '{}');
  write(join(agent, 'settings.json'), '{"packages":["https://github.com/gotgenes/pi-anthropic-auth@abc"]}');
  write(join(agent, 'models-store.json'), '{"anthropic":{}}');
  write(join(agent, 'git', 'github.com', 'gotgenes', 'pi-anthropic-auth', 'src', 'index.ts'), 'export default () => {};');
  write(join(agent, 'sessions', 'C--work', 'a.jsonl'), '{}');
  write(join(agent, 'auth.json'), JSON.stringify(auth));
  write(join(home, '.gitconfig'), '[user]\n\tname = Dev\n');
  return home;
}

describe('the credentials a smoke run copies', () => {
  it('copies an api_key entry as it is', () => {
    const entry = { type: 'api_key', key: 'sk-test', env: { REGION: 'eu' } };
    expect(seedAuth({ deepseek: entry }, NOW)).toEqual({ auth: { deepseek: entry }, notices: [] });
  });

  it('copies an oauth entry without its refresh token, keeping the access token and the rest', () => {
    const entry = { type: 'oauth', access: 'at', refresh: 'rt', expires: NOW + 8 * HOUR, accountId: 'acct' };
    const { auth, notices } = seedAuth({ anthropic: entry }, NOW);
    expect(auth).toEqual({ anthropic: { type: 'oauth', access: 'at', expires: NOW + 8 * HOUR, accountId: 'acct' } });
    expect(JSON.stringify(auth)).not.toContain('rt');
    expect(notices).toEqual([]);
  });

  it('accepts a token that lasts exactly the margin past pi\'s refresh window', () => {
    const expires = NOW + PI_REFRESH_WINDOW_MS + RUN_MARGIN_MS;
    expect(seedAuth({ anthropic: { type: 'oauth', access: 'at', refresh: 'rt', expires } }, NOW).notices).toEqual([]);
  });

  it('names a provider whose token expires before a run could finish, and still copies it', () => {
    const expires = NOW + PI_REFRESH_WINDOW_MS + RUN_MARGIN_MS - 1;
    const { auth, notices } = seedAuth({ anthropic: { type: 'oauth', access: 'at', refresh: 'rt', expires } }, NOW);
    expect(auth['anthropic']).toEqual({ type: 'oauth', access: 'at', expires });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('"anthropic" sign-in expires at');
    expect(notices[0]).toContain('Send one message with that provider in your own Damocles app after');
  });

  it('tells the developer to refresh now when the token is inside pi\'s refresh window or expired', () => {
    const { notices } = seedAuth({
      'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: NOW - HOUR },
      anthropic: { type: 'oauth', access: 'a', refresh: 'r', expires: NOW + PI_REFRESH_WINDOW_MS - 1 },
    }, NOW);
    expect(notices[0]).toContain('"openai-codex" sign-in has expired');
    expect(notices[1]).toContain('"anthropic" sign-in expires at');
    expect(notices.every((notice) => notice.includes('Damocles app now'))).toBe(true);
  });

  it('leaves out an entry of an unknown type, naming it', () => {
    const { auth, notices } = seedAuth({ odd: { type: 'session', token: 't' } }, NOW);
    expect(auth).toEqual({});
    expect(notices[0]).toContain('"odd"');
  });
});

describe('the hermetic home', () => {
  it('seeds preferences, models and the plugin, and leaves out sessions, registries and hooks', async () => {
    const real = realHome({ anthropic: { type: 'oauth', access: 'at', refresh: 'rt', expires: NOW + 8 * HOUR } });
    const h = await createSmokeHome({ dir: tempDir(), realHome: real, realLocalAppData: undefined, now: NOW });
    const agent = join(h.home, '.damocles', 'pi', 'agent');
    expect(readFileSync(join(h.home, '.damocles', 'settings.json'), 'utf8')).toBe('{"damocles.desktop.projects.view":"flat"}');
    expect(existsSync(join(h.home, '.damocles', 'provider-key-sweep.json'))).toBe(true);
    expect(existsSync(join(agent, 'git', 'github.com', 'gotgenes', 'pi-anthropic-auth', 'src', 'index.ts'))).toBe(true);
    expect(existsSync(join(agent, 'settings.json'))).toBe(true);
    expect(existsSync(join(agent, 'models-store.json'))).toBe(true);
    expect(existsSync(join(h.home, '.gitconfig'))).toBe(true);
    expect(existsSync(join(agent, 'sessions'))).toBe(false);
    expect(existsSync(join(h.home, '.damocles', 'worktrees'))).toBe(false);
    expect(existsSync(join(h.home, '.damocles', 'hooks.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(agent, 'auth.json'), 'utf8'))).toEqual({ anthropic: { type: 'oauth', access: 'at', expires: NOW + 8 * HOUR } });
    expect(h.notices).toEqual([]);
  });

  it('is recreated on each launch', async () => {
    const real = realHome({});
    const dir = tempDir();
    const first = await createSmokeHome({ dir, realHome: real, realLocalAppData: undefined, now: NOW });
    write(join(first.home, '.damocles', 'worktrees', 'registry.json'), '{}');
    const second = await createSmokeHome({ dir, realHome: real, realLocalAppData: undefined, now: NOW });
    expect(second.home).toBe(first.home);
    expect(existsSync(join(second.home, '.damocles', 'worktrees'))).toBe(false);
  });

  it('copies no link from the real home', async () => {
    const real = realHome({});
    const target = tempDir();
    symlinkSync(target, join(real, '.damocles', 'pi', 'agent', 'git', 'linked'), 'junction');
    const h = await createSmokeHome({ dir: tempDir(), realHome: real, realLocalAppData: undefined, now: NOW });
    expect(existsSync(join(h.home, '.damocles', 'pi', 'agent', 'git', 'linked'))).toBe(false);
    expect(h.notices.some((notice) => notice.includes('linked'))).toBe(true);
  });

  it('deletes a link inside it without deleting what the link points to', async () => {
    const outside = tempDir();
    write(join(outside, 'keep.txt'), 'keep');
    const root = tempDir();
    write(join(root, 'h', 'file.txt'), 'x');
    symlinkSync(outside, join(root, 'h', 'junction'), 'junction');
    await removeTree(root);
    expect(existsSync(root)).toBe(false);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('refuses to delete a run folder that is itself a link', async () => {
    const outside = tempDir();
    write(join(outside, 'keep.txt'), 'keep');
    const root = join(tempDir(), 'run');
    symlinkSync(outside, root, 'junction');
    await expect(removeTree(root)).rejects.toThrow('is a link');
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('gives the app only allowlisted variables, with every home variable inside the hermetic home', () => {
    const h = { home: join('C:', 'run', 'h'), tmp: join('C:', 'run', 'tmp') };
    const env = smokeEnv(h, { PATH: '/bin', HTTPS_PROXY: 'http://proxy', ANTHROPIC_API_KEY: 'sk', ELECTRON_RUN_AS_NODE: '1', GIT_CONFIG_GLOBAL: '/real/.gitconfig', USERPROFILE: '/real' });
    expect(env).toMatchObject({ PATH: '/bin', HTTPS_PROXY: 'http://proxy', HOME: h.home, USERPROFILE: h.home, TEMP: h.tmp, TMP: h.tmp, TMPDIR: h.tmp });
    for (const key of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) expect(env[key]?.startsWith(h.home)).toBe(true);
    for (const key of ['ANTHROPIC_API_KEY', 'ELECTRON_RUN_AS_NODE', 'GIT_CONFIG_GLOBAL', 'PI_OFFLINE']) expect(env).not.toHaveProperty(key);
  });

  it('refuses to replace a run folder it did not create, deleting nothing', async () => {
    const dir = tempDir();
    write(join(dir, 'run', 'notes.txt'), 'mine');
    await expect(createSmokeHome({ dir, realHome: realHome({}), realLocalAppData: undefined, now: NOW })).rejects.toThrow(`has no ${OWNER_MARKER} file`);
    expect(readFileSync(join(dir, 'run', 'notes.txt'), 'utf8')).toBe('mine');
  });

  it('marks the run folder it creates as its own', async () => {
    const dir = tempDir();
    const h = await createSmokeHome({ dir, realHome: realHome({}), realLocalAppData: undefined, now: NOW });
    expect(lstatSync(join(h.root, OWNER_MARKER)).isFile()).toBe(true);
  });

  it('copies the content of a top-level linked file, as a plain file', async () => {
    const real = realHome({});
    const dotfiles = tempDir();
    write(join(dotfiles, 'gitconfig'), '[user]\n\tname = Stowed\n');
    rmSync(join(real, '.gitconfig'));
    symlinkSync(join(dotfiles, 'gitconfig'), join(real, '.gitconfig'), 'file');
    const h = await createSmokeHome({ dir: tempDir(), realHome: real, realLocalAppData: undefined, now: NOW });
    expect(lstatSync(join(h.home, '.gitconfig')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(h.home, '.gitconfig'), 'utf8')).toBe('[user]\n\tname = Stowed\n');
    expect(h.notices).toEqual([]);
  });

  it('never follows a top-level linked folder', async () => {
    const real = realHome({});
    const outside = tempDir();
    write(join(outside, 'index.js'), 'outside');
    symlinkSync(outside, join(real, '.damocles', 'pi', 'agent', 'extensions'), 'junction');
    const h = await createSmokeHome({ dir: tempDir(), realHome: real, realLocalAppData: undefined, now: NOW });
    expect(existsSync(join(h.home, '.damocles', 'pi', 'agent', 'extensions'))).toBe(false);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain('extensions');
  });

  it('names the links it skips inside a copied folder in one line', async () => {
    const real = realHome({});
    const git = join(real, '.damocles', 'pi', 'agent', 'git');
    symlinkSync(tempDir(), join(git, 'first'), 'junction');
    symlinkSync(tempDir(), join(git, 'second'), 'junction');
    const h = await createSmokeHome({ dir: tempDir(), realHome: real, realLocalAppData: undefined, now: NOW });
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain('2 links');
    expect(h.notices[0]).toContain('first');
  });
});

/** An app the session launches in place of Electron; `close` quits it, throws, or never settles. */
function fakeApps() {
  const apps: Array<{ home: string; closes: number; kills: number; exit: () => void }> = [];
  const state = { close: 'quits' as 'quits' | 'throws' | 'hangs', killFails: false };
  const launchApp = async (h: { home: string }) => {
    let exit = (): void => {};
    const exited = new Promise<void>((resolve) => (exit = resolve));
    const app = { home: h.home, closes: 0, kills: 0, exit };
    apps.push(app);
    return {
      exited,
      close: async (): Promise<void> => {
        app.closes++;
        if (state.close === 'throws') throw new Error('Target page, context or browser has been closed');
        if (state.close === 'hangs') return new Promise<void>(() => {});
        exit();
      },
      kill: async (): Promise<void> => {
        app.kills++;
        if (state.killFails) throw new Error('taskkill was denied');
        exit();
      },
    };
  };
  return { apps, state, launchApp };
}

describe('a smoke session', () => {
  const signedIn = { anthropic: { type: 'oauth', access: 'at', refresh: 'rt', expires: NOW + 8 * HOUR } };
  const session = (dir: string, launchApp: ReturnType<typeof fakeApps>['launchApp']) =>
    createSmokeSession({ dir, realHome: realHome(signedIn), realLocalAppData: undefined, launchApp, closeTimeoutMs: 100, now: () => NOW });
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('relaunches the app on the same home, keeping its sessions and profile', async () => {
    const fake = fakeApps();
    const s = session(tempDir(), fake.launchApp);
    const first = await s.launch();
    write(join(first.home, '.damocles', 'pi', 'agent', 'sessions', 'C--work', 'a.jsonl'), '{}');
    write(join(s.home()!.userData, 'panels.json'), '{"version":2}');
    const again = await s.relaunch();
    expect(again).toMatchObject({ ok: true, home: first.home, closed: 'quit' });
    expect(fake.apps).toHaveLength(2);
    expect(fake.apps[0]).toMatchObject({ closes: 1, kills: 0 });
    expect(existsSync(join(first.home, '.damocles', 'pi', 'agent', 'sessions', 'C--work', 'a.jsonl'))).toBe(true);
    expect(readFileSync(join(s.home()!.userData, 'panels.json'), 'utf8')).toBe('{"version":2}');
  });

  it('refuses a relaunch before a launch', async () => {
    await expect(session(tempDir(), fakeApps().launchApp).relaunch()).rejects.toThrow('post --launch first');
  });

  it('deletes the home and its credentials on quit when closing the app throws', async () => {
    const fake = fakeApps();
    const s = session(tempDir(), fake.launchApp);
    await s.launch();
    const root = s.home()!.root;
    expect(existsSync(join(s.home()!.home, '.damocles', 'pi', 'agent', 'auth.json'))).toBe(true);
    fake.state.close = 'throws';
    const result = await s.quit();
    expect(result.closed).toBe('killed');
    expect(fake.apps[0]!.kills).toBe(1);
    expect(existsSync(root)).toBe(false);
  });

  it('kills an app that does not quit in time, then deletes the home', async () => {
    const fake = fakeApps();
    const s = session(tempDir(), fake.launchApp);
    await s.launch();
    const root = s.home()!.root;
    fake.state.close = 'hangs';
    const result = await s.quit();
    expect(result.closed).toBe('killed');
    expect(fake.apps[0]!.kills).toBe(1);
    expect(existsSync(root)).toBe(false);
  });

  it('deletes the home on quit even when killing a hung app fails, then reports the failure', async () => {
    const fake = fakeApps();
    const s = session(tempDir(), fake.launchApp);
    await s.launch();
    const root = s.home()!.root;
    fake.state.close = 'hangs';
    fake.state.killFails = true;
    await expect(s.quit()).rejects.toThrow('taskkill was denied');
    expect(existsSync(root)).toBe(false);
  });

  it('deletes the home on quit even when it cannot keep the logs', async () => {
    const dir = tempDir();
    const s = session(dir, fakeApps().launchApp);
    await s.launch();
    const root = s.home()!.root;
    write(join(s.home()!.userData, 'logs', 'Damocles.log'), 'run');
    write(join(dir, 'logs', 'mine.txt'), 'mine');
    const result = await s.quit();
    expect(existsSync(root)).toBe(false);
    expect(readFileSync(join(dir, 'logs', 'mine.txt'), 'utf8')).toBe('mine');
    expect(result.notices.join('\n')).toContain(`has no ${OWNER_MARKER} file`);
  });

  it('keeps the logs of an app that exited on its own when the next launch replaces its home', async () => {
    const dir = tempDir();
    const fake = fakeApps();
    const s = session(dir, fake.launchApp);
    await s.launch();
    write(join(s.home()!.userData, 'logs', 'Damocles.log'), 'the crash');
    fake.apps[0]!.exit();
    await tick();
    await s.launch();
    expect(fake.apps).toHaveLength(2);
    expect(readFileSync(join(dir, 'logs', 'Damocles.log'), 'utf8')).toBe('the crash');
    expect(lstatSync(join(dir, 'logs', OWNER_MARKER)).isFile()).toBe(true);
    expect(existsSync(join(s.home()!.userData, 'logs', 'Damocles.log'))).toBe(false);
  });

  it('keeps the logs and deletes the home on quit', async () => {
    const dir = tempDir();
    const s = session(dir, fakeApps().launchApp);
    await s.launch();
    const root = s.home()!.root;
    write(join(s.home()!.userData, 'logs', 'Damocles.log'), 'run');
    const result = await s.quit();
    expect(result).toMatchObject({ closed: 'quit', removed: join(dir, 'run'), logs: join(dir, 'logs') });
    expect(existsSync(root)).toBe(false);
    expect(readFileSync(join(dir, 'logs', 'Damocles.log'), 'utf8')).toBe('run');
  });
});
