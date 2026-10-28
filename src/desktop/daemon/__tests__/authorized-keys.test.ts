import * as nodeFs from 'node:fs';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunOutput, SpawnSpec } from '../../../core/process-launcher';
import { installAuthorizedKey, keyEntry, type AuthorizedKeysDeps } from '../authorized-keys';
import { DAMOCLES_PUBLIC_KEY } from '../control-messages';

const KEY = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'A'.repeat(43)} damocles@laptop`;
const OTHER = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBB other@host';
const ok: RunOutput = { exit: { code: 0, signal: null }, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true });
});

async function posixHome(overrides: Partial<AuthorizedKeysDeps> = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'authorized-keys-'));
  homes.push(home);
  const run = vi.fn(async (_spec: SpawnSpec, _options: { readonly timeoutMs: number }) => ok);
  const log = vi.fn();
  // the owner the file system reports for this user's files, which the daemon's uid must equal
  const uid = (await fs.stat(home)).uid;
  const deps: AuthorizedKeysDeps = { platform: 'linux', homedir: home, env: {}, uid, run, restorecon: async () => undefined, log, ...overrides };
  return { home, deps, run, log, file: path.join(home, '.ssh', 'authorized_keys') };
}

describe('the key Damocles installs', () => {
  it('is one ssh-ed25519 line with the Damocles comment and nothing an authorized_keys line could carry as options', () => {
    expect(DAMOCLES_PUBLIC_KEY.test(KEY)).toBe(true);
    expect(DAMOCLES_PUBLIC_KEY.test(`command="sh" ${KEY}`)).toBe(false);
    expect(DAMOCLES_PUBLIC_KEY.test(`${KEY}\nssh-ed25519 AAAA x`)).toBe(false);
    expect(DAMOCLES_PUBLIC_KEY.test(KEY.replace('damocles@', 'other@'))).toBe(false);
  });

  it('is found by its type and blob whatever its comment or harmless options, and never in a comment line', () => {
    expect(keyEntry(`${OTHER}\nno-pty ${KEY.replace('damocles@laptop', 'renamed')}\n`, KEY)).toBe('present');
    expect(keyEntry(`# ${KEY}\n${OTHER}\n`, KEY)).toBe('absent');
  });

  it('is restricted when the first line holding it carries an option that keeps it from logging Damocles in', () => {
    for (const options of ['command="/bin/false"', 'from="10.0.0.0/8"', 'restrict', 'no-pty,RESTRICT', 'expiry-time="20200101"', 'cert-authority', 'from="a,b",no-pty']) {
      expect(keyEntry(`${options} ${KEY}\n`, KEY), options).toBe('restricted');
    }
    expect(keyEntry(`command="x" ${KEY}\n${KEY}\n`, KEY)).toBe('restricted');
    expect(keyEntry(`${KEY}\ncommand="x" ${KEY}\n`, KEY)).toBe('present');
  });

  it('never takes the key from inside a quoted option value of another key\'s line', () => {
    expect(keyEntry(`command="echo ${KEY.split(' ').slice(0, 2).join(' ')} \\"x\\"" ssh-rsa AAAAB3Nza other\n`, KEY)).toBe('absent');
    expect(keyEntry(`ssh-rsa AAAAB3Nza ${KEY}\n`, KEY)).toBe('absent');
  });
});

describe('installAuthorizedKey on POSIX (ssh-copy-id semantics)', () => {
  it('creates ~/.ssh and authorized_keys and appends the key', async () => {
    const { deps, file } = await posixHome();
    expect(await installAuthorizedKey(KEY, deps)).toEqual({ result: 'installed', path: file });
    expect(await fs.readFile(file, 'utf8')).toBe(`${KEY}${os.EOL}`);
  });

  it.runIf(process.platform !== 'win32')('makes ~/.ssh 0700 and authorized_keys 0600, also when they existed wider', async () => {
    const { deps, home, file } = await posixHome();
    await fs.mkdir(path.join(home, '.ssh'), { mode: 0o755 });
    await fs.writeFile(file, `${OTHER}\n`, { mode: 0o644 });
    await installAuthorizedKey(KEY, deps);
    expect((await fs.stat(path.join(home, '.ssh'))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('adds a newline first when the file lacks a final one, and appends only when the key is absent', async () => {
    const { deps, home, file } = await posixHome();
    await fs.mkdir(path.join(home, '.ssh'));
    await fs.writeFile(file, OTHER);
    expect((await installAuthorizedKey(KEY, deps)).result).toBe('installed');
    expect(await fs.readFile(file, 'utf8')).toBe(`${OTHER}${os.EOL}${KEY}${os.EOL}`);
    expect((await installAuthorizedKey(KEY, deps)).result).toBe('present');
    expect(await fs.readFile(file, 'utf8')).toBe(`${OTHER}${os.EOL}${KEY}${os.EOL}`);
  });

  it('reports restricted and writes nothing when the key\'s line carries a forced command', async () => {
    const { deps, home, file } = await posixHome();
    await fs.mkdir(path.join(home, '.ssh'));
    await fs.writeFile(file, `command="/bin/false" ${KEY}\n`);
    expect(await installAuthorizedKey(KEY, deps)).toEqual({ result: 'failed', code: 'restricted', path: file });
    expect(await fs.readFile(file, 'utf8')).toBe(`command="/bin/false" ${KEY}\n`);
  });

  it('refuses a folder another user owns, writing nothing', async () => {
    const { deps, home, file } = await posixHome();
    const result = await installAuthorizedKey(KEY, { ...deps, uid: (deps.uid ?? 0) + 1 });
    expect(result).toEqual({ result: 'failed', code: 'ownership', path: path.join(home, '.ssh') });
    await expect(fs.access(file)).rejects.toThrow();
  });

  it('refuses an authorized_keys another user owns in the user\'s own ~/.ssh, writing nothing', async () => {
    const { deps, home, file } = await posixHome();
    await fs.mkdir(path.join(home, '.ssh'));
    await fs.writeFile(file, `${OTHER}\n`);
    const realOpen = fs.open;
    vi.spyOn(nodeFs.promises, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      const realStat = handle.stat.bind(handle);
      // the file's owner as another user's file reports it
      handle.stat = (async () => Object.assign(Object.create(Object.getPrototypeOf(await realStat())), await realStat(), { uid: (deps.uid ?? 0) + 1 })) as typeof handle.stat;
      return handle;
    }) as typeof fs.open);
    expect(await installAuthorizedKey(KEY, deps)).toEqual({ result: 'failed', code: 'ownership', path: file });
    expect(await fs.readFile(file, 'utf8')).toBe(`${OTHER}\n`);
  });

  it('refuses an authorized_keys that is not a regular file', async () => {
    const { deps, home, file } = await posixHome();
    await fs.mkdir(file, { recursive: true });
    expect(await installAuthorizedKey(KEY, deps)).toEqual({ result: 'failed', code: 'notFile', path: file });
    expect((await fs.readdir(path.join(home, '.ssh')))).toEqual(['authorized_keys']);
  });

  it('refuses a ~/.ssh that is not a folder', async () => {
    const { deps, home } = await posixHome();
    await fs.writeFile(path.join(home, '.ssh'), 'x');
    expect(await installAuthorizedKey(KEY, deps)).toEqual({ result: 'failed', code: 'notFile', path: path.join(home, '.ssh') });
    expect(await fs.readFile(path.join(home, '.ssh'), 'utf8')).toBe('x');
  });

  it('answers writeFailed and logs when ~/.ssh cannot be made or authorized_keys cannot be read', async () => {
    const { deps, home, log, file } = await posixHome();
    await fs.writeFile(path.join(home, 'plain'), '');
    const under = path.join(home, 'plain', 'home');
    expect(await installAuthorizedKey(KEY, { ...deps, homedir: under })).toEqual({ result: 'failed', code: 'writeFailed', path: path.join(under, '.ssh') });
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`[keys] preparing ${path.join(under, '.ssh')} failed`));
    await fs.mkdir(path.join(home, '.ssh'));
    const realStat = fs.stat;
    vi.spyOn(nodeFs.promises, 'stat').mockImplementation(((target: nodeFs.PathLike, ...rest: unknown[]) =>
      String(target) === file ? Promise.reject(Object.assign(new Error('EACCES: denied'), { code: 'EACCES' })) : (realStat as (...args: unknown[]) => Promise<nodeFs.Stats>)(target, ...rest)) as typeof fs.stat);
    expect(await installAuthorizedKey(KEY, deps)).toEqual({ result: 'failed', code: 'writeFailed', path: file });
    expect(log).toHaveBeenCalledWith(`[keys] reading ${file} failed: EACCES: denied`);
  });

  it('runs restorecon -F on the folder and the file when SELinux tools are present, through the launcher at its absolute path', async () => {
    const { deps, run, home, file } = await posixHome({ restorecon: async () => '/usr/sbin/restorecon' });
    await installAuthorizedKey(KEY, deps);
    expect(run).toHaveBeenCalledTimes(1);
    const [spec] = run.mock.calls[0]!;
    expect(spec.file).toBe('/usr/sbin/restorecon');
    expect(spec.args).toEqual(['-F', path.join(home, '.ssh'), file]);
    expect(spec.shell).toBeUndefined();
  });

  it('keeps the install and logs when restorecon cannot start', async () => {
    const { deps, log, file } = await posixHome({ restorecon: async () => '/usr/sbin/restorecon', run: async () => Promise.reject(new Error('spawn EACCES')) });
    expect(await installAuthorizedKey(KEY, deps)).toEqual({ result: 'installed', path: file });
    expect(log).toHaveBeenCalledWith('[keys] restorecon -F did not start: spawn EACCES');
  });

  it('starts no restorecon without SELinux tools', async () => {
    const { deps, run } = await posixHome();
    await installAuthorizedKey(KEY, deps);
    expect(run).not.toHaveBeenCalled();
  });
});
