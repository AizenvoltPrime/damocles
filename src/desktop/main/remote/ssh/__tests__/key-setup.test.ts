import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAMOCLES_HOME_DIR } from '../../../../../core/paths';
import type { RunOutput, SpawnSpec } from '../../../../../core/process-launcher';
import type { AskpassMode } from '../../../../../core/scm/askpass/askpass-server';
import type { InstalledKey } from '../../host-store';
import { HostNotConnectedError, keyCommentName, keyFolder, keygenArgs, parseFingerprint, setUpPasswordless, type KeySetupDeps, type KeySetupTarget } from '../key-setup';
import { optionArg } from '../ssh-args';
import type { InstallKeyResult } from '../../../../daemon/control-messages';

const BLOB = `AAAAC3NzaC1lZDI1NTE5AAAAI${'A'.repeat(43)}`;
const FINGERPRINT = `SHA256:${'b'.repeat(43)}`;
const output = (code: number, stdout = ''): RunOutput => ({ exit: { code, signal: null }, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) });

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await fs.rm(folder, { recursive: true, force: true });
});

interface SetupOptions {
  readonly verifyCode?: number;
  readonly install?: InstallKeyResult;
  readonly keygenCode?: number;
  // what `ssh -G` prints for PreferredAuthentications, from the saved options and the user's config
  // null: the option is unset, so ssh -G prints no line for it
  readonly preferred?: string | null;
}

async function setup(options: SetupOptions = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'key-setup-'));
  folders.push(home);
  const folder = path.join(home, '.damocles', 'ssh');
  // ssh-keygen as it behaves: -t writes the pair, -y prints the public key, -l the fingerprint; ssh verifies with exit 0
  const run = vi.fn(async (spec: SpawnSpec): Promise<RunOutput> => {
    if (spec.file === '/usr/bin/ssh-keygen' && spec.args[0] === '-t') {
      if (options.keygenCode !== undefined) return { exit: { code: options.keygenCode, signal: null }, stdout: Buffer.alloc(0), stderr: Buffer.from('Saving key failed') };
      const file = spec.args[spec.args.indexOf('-f') + 1]!;
      await new Promise((resolve) => setImmediate(resolve));
      await fs.writeFile(file, 'private', { flag: 'wx' });
      await fs.writeFile(`${file}.pub`, `ssh-ed25519 ${BLOB} damocles@laptop\n`, { flag: 'wx' });
      return output(0);
    }
    if (spec.file === '/usr/bin/ssh-keygen' && spec.args[0] === '-y') return output(0, `ssh-ed25519 ${BLOB}\n`);
    if (spec.file === '/usr/bin/ssh-keygen') return output(0, `256 ${FINGERPRINT} damocles@laptop (ED25519)\n`);
    return output(options.verifyCode ?? 0);
  });
  const registrations: Array<{ mode: AskpassMode; disposed: boolean }> = [];
  const logs: string[] = [];
  const queries: Array<readonly string[]> = [];
  const sshQuery = vi.fn(async (_file: string, args: readonly string[]) => {
    queries.push(args);
    const preferred = options.preferred === null ? '' : `preferredauthentications ${options.preferred ?? 'gssapi-with-mic,publickey,keyboard-interactive,password'}\n`;
    return { code: 0, stdout: `user dev\nhostname prod\n${preferred}port 22\n`, stderr: '' };
  });
  const deps: KeySetupDeps = {
    folder,
    clientName: 'laptop',
    resolveKeygen: async () => '/usr/bin/ssh-keygen',
    resolveSsh: async () => '/usr/bin/ssh',
    run,
    sshQuery,
    askpass: async () => ({
      register: async (mode: AskpassMode) => {
        const registration = { mode, disposed: false };
        registrations.push(registration);
        return { env: { SSH_ASKPASS: '/askpass.sh', SSH_ASKPASS_REQUIRE: 'force', DAMOCLES_ASKPASS_NONCE: 'n', GIT_ASKPASS: '/git.sh' }, cancelled: new AbortController().signal, dispose: () => { registration.disposed = true; } };
      },
    }),
    sshVersion: async () => [8, 1],
    env: { PATH: '/bin' },
    log: (line) => logs.push(line),
  };
  const steps: string[] = [];
  const installs: string[] = [];
  const recorded: InstalledKey[] = [];
  const target: KeySetupTarget = {
    destination: { kind: 'alias', alias: 'prod-1' },
    canInstall: true,
    install: async (publicKey) => {
      installs.push(publicKey);
      return options.install ?? { result: 'installed', path: '/home/dev/.ssh/authorized_keys' };
    },
    recordInstalled: async (installed) => {
      recorded.push(installed);
    },
    progress: (step, state, failure) => steps.push(`${step}:${state}${failure ? `:${failure.code}` : ''}`),
  };
  return { home, folder, deps, target, run, steps, installs, recorded, registrations, logs, queries };
}

const verifyCall = (run: ReturnType<typeof vi.fn>): SpawnSpec => run.mock.calls.map(([spec]) => spec as SpawnSpec).find((spec) => spec.file === '/usr/bin/ssh')!;

describe('Set up passwordless login', () => {
  it('generates an ed25519 key with no passphrase and the Damocles comment', () => {
    expect(keygenArgs('/h/.damocles/ssh/id_ed25519', 'DESKTOP 1')).toEqual(['-t', 'ed25519', '-N', '', '-C', 'damocles@DESKTOP-1', '-f', '/h/.damocles/ssh/id_ed25519', '-q']);
    expect(keyCommentName('')).toBe('client');
    expect(parseFingerprint(`256 ${FINGERPRINT} damocles@laptop (ED25519)`)).toBe(FINGERPRINT);
    expect(parseFingerprint('garbage')).toBeUndefined();
  });

  it('keeps the key folder main uses under Damocles\' home, never ~/.ssh', () => {
    const folder = keyFolder(DAMOCLES_HOME_DIR);
    expect(folder).toBe(path.join(DAMOCLES_HOME_DIR, 'ssh'));
    expect(path.relative(path.join(os.homedir(), '.ssh'), folder).startsWith('..')).toBe(true);
  });

  it('generates, installs the public key line through the daemon, verifies with the key offered first and reports each step', async () => {
    const { folder, deps, target, run, steps, installs, recorded } = await setup();
    const outcome = await setUpPasswordless(deps, target);
    const file = path.join(folder, 'id_ed25519');
    expect(outcome).toEqual({ result: { ok: true }, identityFile: file });
    expect(recorded).toEqual([{ fingerprint: FINGERPRINT, entry: `ssh-ed25519 ${BLOB}`, file: '/home/dev/.ssh/authorized_keys' }]);
    expect(installs).toEqual([`ssh-ed25519 ${BLOB} damocles@laptop`]);
    expect(steps).toEqual(['generate:running', 'generate:done', 'install:running', 'install:done', 'verify:running', 'verify:done']);
    const verify = verifyCall(run);
    expect(verify.args).toEqual(expect.arrayContaining(['BatchMode=yes', 'IdentitiesOnly=yes', optionArg('IdentityFile', file), 'ControlPath=none']));
    expect(verify.args.slice(-3)).toEqual(['--', 'prod-1', 'exit 0']);
  });

  it('checks under a background askpass registration, so a jump host\'s question is answered cancel and never reaches a tty', async () => {
    const { deps, target, run, registrations } = await setup();
    await setUpPasswordless(deps, target);
    expect(registrations).toEqual([{ mode: 'background', disposed: true }]);
    // the askpass variables only, and DISPLAY for the OpenSSH before 8.4 this client runs
    expect(verifyCall(run).env).toEqual({ PATH: '/bin', SSH_ASKPASS: '/askpass.sh', SSH_ASKPASS_REQUIRE: 'force', DAMOCLES_ASKPASS_NONCE: 'n', DISPLAY: 'damocles:0' });
  });

  it('doubles a % of the key\'s path for ssh, which expands IdentityFile, and records the path as it is', async () => {
    const { home, deps, target, run } = await setup();
    const folder = path.join(home, '100%x', 'ssh');
    const outcome = await setUpPasswordless({ ...deps, folder }, target);
    const file = path.join(folder, 'id_ed25519');
    expect(outcome.identityFile).toBe(file);
    expect(verifyCall(run).args).toContain(optionArg('IdentityFile', file.replaceAll('%', '%%')));
  });

  it('refuses before generating when the PreferredAuthentications ssh -G resolves asks for a password before publickey', async () => {
    for (const value of ['password', 'keyboard-interactive,publickey', 'password,publickey']) {
      const { deps, target, run, steps } = await setup({ preferred: value });
      expect(await setUpPasswordless(deps, target), value).toEqual({ result: { ok: false, step: 'generate', code: 'publickeyNotPreferred', params: {} } });
      expect(steps).toEqual(['generate:running', 'generate:failed:publickeyNotPreferred']);
      expect(run).not.toHaveBeenCalled();
    }
    const { deps, target } = await setup({ preferred: 'gssapi-with-mic,publickey,password' });
    expect((await setUpPasswordless(deps, target)).result).toEqual({ ok: true });
  });

  it('asks ssh -G with the saved options and the e2e config file, so an alias host\'s ssh config is read too', async () => {
    const { deps, target, queries } = await setup({ preferred: 'keyboard-interactive,password,publickey' });
    const destination = { kind: 'address' as const, host: 'prod', user: 'dev', options: [{ name: 'PreferredAuthentications' as const, value: 'publickey' }] };
    // ssh keeps the first value, so the saved option on the command line wins over the config; this ssh printed the config's
    expect((await setUpPasswordless(deps, { ...target, destination, configFile: '/e2e/config' })).result).toMatchObject({ code: 'publickeyNotPreferred' });
    expect(queries).toEqual([['-F', '/e2e/config', '-l', 'dev', '-o', 'PreferredAuthentications="publickey"', '-G', '--', 'prod']]);
  });

  it('goes on with ssh\'s default order when PreferredAuthentications is unset, which ssh -G leaves out of its output', async () => {
    const { deps, target, run } = await setup({ preferred: null });
    expect((await setUpPasswordless(deps, target)).result).toEqual({ ok: true });
    expect(run).toHaveBeenCalled();
  });

  it('fails generate with configUnreadable, with a log line, when ssh -G fails or does not run', async () => {
    const failing = await setup();
    const exited = { ...failing.deps, sshQuery: async () => ({ code: 255, stdout: '', stderr: 'Bad configuration option: foo' }) };
    expect(await setUpPasswordless(exited, failing.target)).toEqual({ result: { ok: false, step: 'generate', code: 'configUnreadable', params: {} } });
    expect(failing.logs).toContain('[ssh] ssh -G exited 255: Bad configuration option: foo');
    expect(failing.run).not.toHaveBeenCalled();
    const thrown = await setup();
    expect((await setUpPasswordless({ ...thrown.deps, sshQuery: () => Promise.reject(new Error('spawn EPERM')) }, thrown.target)).result).toMatchObject({ step: 'generate', code: 'configUnreadable' });
    expect(thrown.logs).toContain('[ssh] ssh -G did not run: spawn EPERM');
  });

  it('reuses an existing key pair, and records no installed key when the host already had it', async () => {
    const { deps, target, run, recorded } = await setup({ install: { result: 'present', path: '/home/dev/.ssh/authorized_keys' } });
    await setUpPasswordless(deps, target);
    const outcome = await setUpPasswordless(deps, target);
    expect(run.mock.calls.filter(([spec]) => spec.args[0] === '-t')).toHaveLength(1);
    expect(recorded).toEqual([]);
    expect(outcome.identityFile).toBeDefined();
  });

  it('records the key line it appended even when the check then fails, and no key file for ssh', async () => {
    const { deps, target, recorded, steps } = await setup({ verifyCode: 255 });
    expect(await setUpPasswordless(deps, target)).toEqual({ result: { ok: false, step: 'verify', code: 'verifyFailed', params: {} } });
    expect(recorded).toEqual([{ fingerprint: FINGERPRINT, entry: `ssh-ed25519 ${BLOB}`, file: '/home/dev/.ssh/authorized_keys' }]);
    expect(steps.at(-1)).toBe('verify:failed:verifyFailed');
  });

  it('stops at a failing install with its code and records nothing', async () => {
    const refused = await setup({ install: { result: 'failed', code: 'ownership', path: '/home/dev/.ssh' } });
    expect(await setUpPasswordless(refused.deps, refused.target)).toEqual({ result: { ok: false, step: 'install', code: 'ownership', params: { path: '/home/dev/.ssh' } } });
    expect(refused.steps.at(-1)).toBe('install:failed:ownership');
    expect(refused.recorded).toEqual([]);
    const old = await setup();
    expect(await setUpPasswordless(old.deps, { ...old.target, canInstall: false })).toEqual({ result: { ok: false, step: 'install', code: 'unsupported', params: {} } });
    expect(old.logs).toContain('[ssh] the host\'s Damocles server does not serve ssh.installAuthorizedKey');
  });

  it('maps a closed connection during the install to notConnected, with a log line', async () => {
    const { deps, target, steps, logs, recorded } = await setup();
    const outcome = await setUpPasswordless(deps, { ...target, install: () => Promise.reject(new HostNotConnectedError('the connection closed')) });
    expect(outcome).toEqual({ result: { ok: false, step: 'install', code: 'notConnected', params: {} } });
    expect(steps.at(-1)).toBe('install:failed:notConnected');
    expect(logs).toContain('[ssh] installing the key failed: the connection closed');
    expect(recorded).toEqual([]);
  });

  it('maps an error the daemon answered the install with to installFailed, never notConnected, with a log line', async () => {
    const { deps, target, steps, logs, recorded } = await setup();
    const outcome = await setUpPasswordless(deps, { ...target, install: () => Promise.reject(new Error('EROFS: read-only file system')) });
    expect(outcome).toEqual({ result: { ok: false, step: 'install', code: 'installFailed', params: {} } });
    expect(steps.at(-1)).toBe('install:failed:installFailed');
    expect(logs).toContain('[ssh] installing the key failed: EROFS: read-only file system');
    expect(recorded).toEqual([]);
  });

  it('fails generate before anything is written, with a log line, when ssh cannot be found', async () => {
    const missing = await setup();
    expect((await setUpPasswordless({ ...missing.deps, resolveSsh: async () => undefined }, missing.target)).result).toMatchObject({ step: 'generate', code: 'configUnreadable' });
    expect(missing.logs).toContain('[ssh] no ssh on this computer for passwordless login');
    expect(missing.run).not.toHaveBeenCalled();
    const lookup = await setup();
    expect((await setUpPasswordless({ ...lookup.deps, resolveSsh: () => Promise.reject(new Error('EACCES')) }, lookup.target)).result).toMatchObject({ step: 'generate', code: 'configUnreadable' });
    expect(lookup.logs).toContain('[ssh] finding ssh for passwordless login failed: EACCES');
  });

  it('fails the check, with a log line, when ssh cannot be started or askpass cannot register', async () => {
    const start = await setup();
    const run = vi.fn(async (spec: SpawnSpec) => (spec.file === '/usr/bin/ssh' ? Promise.reject(new Error('spawn EPERM')) : start.run(spec)));
    expect((await setUpPasswordless({ ...start.deps, run }, start.target)).result).toMatchObject({ step: 'verify', code: 'verifyFailed' });
    expect(start.logs).toContain('[ssh] the passwordless check did not run: spawn EPERM');
    const askpass = await setup();
    expect((await setUpPasswordless({ ...askpass.deps, askpass: async () => ({ register: () => Promise.reject(new Error('disposed')) }) }, askpass.target)).result).toMatchObject({ step: 'verify', code: 'verifyFailed' });
    expect(askpass.logs).toContain('[ssh] the passwordless check did not run: disposed');
  });

  it('fails generate with keygenFailed when ssh-keygen is missing, cannot be looked up or exits non-zero', async () => {
    const missing = await setup();
    expect((await setUpPasswordless({ ...missing.deps, resolveKeygen: async () => undefined }, missing.target)).result).toMatchObject({ step: 'generate', code: 'keygenFailed' });
    expect(missing.logs).toContain('[ssh] no ssh-keygen on this computer');
    const lookup = await setup();
    expect((await setUpPasswordless({ ...lookup.deps, resolveKeygen: () => Promise.reject(new Error('EACCES')) }, lookup.target)).result).toMatchObject({ step: 'generate', code: 'keygenFailed' });
    const failing = await setup({ keygenCode: 1 });
    expect((await setUpPasswordless(failing.deps, failing.target)).result).toMatchObject({ step: 'generate', code: 'keygenFailed' });
    expect(failing.logs.some((line) => line.includes('ssh-keygen exited 1: Saving key failed'))).toBe(true);
  });

  it('rebuilds a missing .pub from the private key with ssh-keygen -y and Damocles\' comment', async () => {
    const { folder, deps, target, run, installs } = await setup();
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'id_ed25519'), 'private');
    expect((await setUpPasswordless(deps, target)).result).toEqual({ ok: true });
    expect(run.mock.calls.map(([spec]) => spec.args)).toContainEqual(['-y', '-f', path.join(folder, 'id_ed25519')]);
    expect(run.mock.calls.filter(([spec]) => spec.args[0] === '-t')).toHaveLength(0);
    expect(await fs.readFile(path.join(folder, 'id_ed25519.pub'), 'utf8')).toBe(`ssh-ed25519 ${BLOB} damocles@laptop\n`);
    expect(installs).toEqual([`ssh-ed25519 ${BLOB} damocles@laptop`]);
  });

  it('names the .pub left without its private key, for the user to delete', async () => {
    const { folder, deps, target, steps } = await setup();
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'id_ed25519.pub'), `ssh-ed25519 ${BLOB} damocles@laptop\n`);
    expect((await setUpPasswordless(deps, target)).result).toEqual({ ok: false, step: 'generate', code: 'keyPairIncomplete', params: { path: path.join(folder, 'id_ed25519.pub') } });
    expect(steps.at(-1)).toBe('generate:failed:keyPairIncomplete');
  });

  it('shares one key generation between two setups at once', async () => {
    const first = await setup();
    const [a, b] = await Promise.all([setUpPasswordless(first.deps, first.target), setUpPasswordless(first.deps, first.target)]);
    expect([a.result, b.result]).toEqual([{ ok: true }, { ok: true }]);
    expect(first.run.mock.calls.filter(([spec]) => spec.args[0] === '-t')).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('creates the key folder for this user alone', async () => {
    const { folder, deps, target } = await setup();
    await setUpPasswordless(deps, target);
    expect((await fs.stat(folder)).mode & 0o777).toBe(0o700);
  });
});
