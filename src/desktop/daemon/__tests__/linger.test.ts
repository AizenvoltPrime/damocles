import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { RunOutput, SpawnSpec } from '../../../core/process-launcher';
import { posixToolAsync } from '../../../core/system-tools';
import { LINGER_USER } from '../control-messages';
import { enableLinger, type LingerDeps } from '../linger';

vi.mock('../../../core/system-tools', () => ({ posixToolAsync: vi.fn() }));

const output = (code: number | null, stderr = '', signal: NodeJS.Signals | null = null): RunOutput => ({ exit: code === null && signal === null ? null : { code, signal }, stdout: Buffer.alloc(0), stderr: Buffer.from(stderr) });

const scratch = mkdtempSync(path.join(os.tmpdir(), 'linger-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
// logind's linger folder with no user recorded
const emptyLingerFolder = path.join(scratch, 'empty');
mkdirSync(emptyLingerFolder);

function linger(result: RunOutput, overrides: Omit<Partial<LingerDeps>, 'loginctl'> & { readonly loginctl?: string | undefined } = {}) {
  const run = vi.fn(async (_spec: SpawnSpec, _options: { readonly timeoutMs: number }) => result);
  const log = vi.fn();
  const loginctl = 'loginctl' in overrides ? overrides.loginctl : '/usr/bin/loginctl';
  const deps: LingerDeps = { log, run, platform: 'linux', lingerFolder: emptyLingerFolder, user: () => 'dev', ...overrides, loginctl: async () => loginctl };
  return { run, log, done: enableLinger(deps) };
}

describe('enableLinger', () => {
  it('runs loginctl at its absolute path for the own user only, without sudo or a password prompt, in the C locale', async () => {
    const { run, done } = linger(output(0));
    expect(await done).toEqual({ result: 'enabled' });
    const [spec] = run.mock.calls[0]!;
    expect(spec.file).toBe('/usr/bin/loginctl');
    expect(spec.args).toEqual(['--no-ask-password', 'enable-linger', 'dev']);
    expect(spec.env?.['LC_ALL']).toBe('C');
    expect(spec.shell).toBeUndefined();
  });

  it('names the daemon\'s own user when no user is injected', async () => {
    const run = vi.fn(async (_spec: SpawnSpec, _options: { readonly timeoutMs: number }) => output(0));
    await enableLinger({ log: vi.fn(), run, platform: 'linux', lingerFolder: emptyLingerFolder, loginctl: async () => '/usr/bin/loginctl' });
    expect(run.mock.calls[0]![0].args).toEqual(['--no-ask-password', 'enable-linger', os.userInfo().username]);
  });

  it('answers alreadyEnabled and starts nothing when logind records linger for the user', async () => {
    const folder = path.join(scratch, 'recorded');
    mkdirSync(folder);
    writeFileSync(path.join(folder, 'dev'), '');
    const { run, done } = linger(output(0), { lingerFolder: folder });
    expect(await done).toEqual({ result: 'alreadyEnabled' });
    expect(run).not.toHaveBeenCalled();
  });

  it('names the user an admin enables when polkit refuses', async () => {
    const { done } = linger(output(1, 'Could not enable linger: Access denied'));
    expect(await done).toEqual({ result: 'refused', user: 'dev' });
    expect(await linger(output(1, 'Could not enable linger: Interactive authentication required.')).done).toEqual({ result: 'refused', user: 'dev' });
  });

  it('reports any other failure by code, never as a refusal', async () => {
    expect(await linger(output(1, 'Failed to connect to bus: No such file or directory')).done).toEqual({ result: 'failed', code: 'exit1' });
    expect(await linger(output(null, '', 'SIGKILL')).done).toEqual({ result: 'failed', code: 'signal-SIGKILL' });
    expect(await linger(output(null)).done).toEqual({ result: 'failed', code: 'timeout' });
  });

  it('answers failed and logs when loginctl cannot start or the user name cannot be read', async () => {
    const run = vi.fn(async () => Promise.reject(new Error('spawn EACCES')));
    const log = vi.fn();
    expect(await enableLinger({ log, run, platform: 'linux', lingerFolder: emptyLingerFolder, user: () => 'dev', loginctl: async () => '/usr/bin/loginctl' })).toEqual({ result: 'failed', code: 'spawn' });
    expect(log).toHaveBeenCalledWith('[linger] loginctl did not start: spawn EACCES');
    const unnamed = linger(output(0), { user: () => { throw new Error('ENOENT: no passwd entry'); } });
    expect(await unnamed.done).toEqual({ result: 'failed', code: 'userInfo' });
    expect(unnamed.run).not.toHaveBeenCalled();
  });

  it('starts nothing off Linux, for a host without loginctl or for a user name loginctl would not take', async () => {
    const windows = linger(output(0), { platform: 'win32' });
    expect(await windows.done).toEqual({ result: 'failed', code: 'noLoginctl' });
    const missing = linger(output(0), { loginctl: undefined });
    expect(await missing.done).toEqual({ result: 'failed', code: 'noLoginctl' });
    const odd = linger(output(0), { user: () => '-root' });
    expect(await odd.done).toEqual({ result: 'failed', code: 'user' });
    expect([...windows.run.mock.calls, ...missing.run.mock.calls, ...odd.run.mock.calls]).toEqual([]);
  });

  it('takes loginctl\'s path from posixToolAsync, never a bare program name', async () => {
    vi.mocked(posixToolAsync).mockResolvedValueOnce('/bin/loginctl');
    const run = vi.fn(async (_spec: SpawnSpec, _options: { readonly timeoutMs: number }) => output(0));
    await enableLinger({ log: vi.fn(), run, platform: 'linux', lingerFolder: emptyLingerFolder, user: () => 'dev' });
    expect(posixToolAsync).toHaveBeenCalledWith('loginctl');
    expect(run.mock.calls[0]![0]).toMatchObject({ file: '/bin/loginctl' });
  });
});

describe('the user names linger takes', () => {
  it('takes SSSD and Active Directory names and the POSIX ones', () => {
    for (const user of ['dev', 'svc-deploy', 'ada@corp.example.com', 'CORP\\ada', 'host$', 'Ada Lovelace', '_apt', 'ünïcode']) expect(LINGER_USER.test(user), user).toBe(true);
  });

  it('refuses an option-like, numeric, path-like, padded or control-bearing name', () => {
    for (const user of ['', '-root', '--help', '1000', '.', '..', 'a/b', 'a:b', ' dev', 'dev ', 'a\nb', 'a\u0000b', 'a\u202eb', 'a\u2028b', 'x'.repeat(256)]) {
      expect(LINGER_USER.test(user), JSON.stringify(user)).toBe(false);
    }
  });
});
