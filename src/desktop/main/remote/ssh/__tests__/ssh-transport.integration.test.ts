// The SSH transport against a real sshd in a Docker container: this computer's ssh, main's askpass server with the real
// helper (the native trampoline on Windows), stage 0 and stage 1 on the wire, up to the probe's report.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { processLauncher, runProcess, type Launcher } from '../../../../../core/process-launcher';
import type { AskpassServer } from '../../../../../core/scm/askpass/askpass-server';
import { findOnAbsolutePathAsync, resolveSshExecutable } from '../../../../../core/system-tools';
import type { ServerManifest } from '../../server-manifest-format';
import { scratchDir } from '../../bootstrap/__tests__/shells';
// @ts-expect-error -- plain .mjs script, no types
import { tarGz } from '../../../../../../scripts/server-archive.mjs';
// @ts-expect-error -- plain .mjs script, no types
import { ALPINE_TARGET_IMAGE } from '../../../../../../scripts/server-targets.mjs';
import { runSsh } from '../control-master';
import { createMainAskpassServer } from '../ssh-askpass';
import { SshConnectError, startSshTransport, type SshAttemptHooks, type SshTransportDeps, type SshTransportOptions } from '../ssh-transport';

const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');
const ASKPASS_PATHS = {
  askpass: path.join(REPO, 'dist', 'askpass', 'askpass.sh'),
  sshAskpass: path.join(REPO, 'dist', 'askpass', 'ssh-askpass.sh'),
  node: process.execPath,
  main: path.join(REPO, 'dist', 'askpass-main.js'),
};

// A port free on 127.0.0.1 now, from the OS's own ephemeral pick; closed again before it returns.
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function dockerLinux(): Promise<string | undefined> {
  const docker = await findOnAbsolutePathAsync(process.platform === 'win32' ? 'docker.exe' : 'docker', process.platform, process.env);
  if (docker === undefined) return undefined;
  const info = await runProcess({ file: docker, args: ['info', '--format', '{{.OSType}}'], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, { timeoutMs: 30_000 });
  return info.exit?.code === 0 && info.stdout.toString('utf8').trim() === 'linux' ? docker : undefined;
}

const helperBuilt = existsSync(ASKPASS_PATHS.main) && existsSync(process.platform === 'win32' ? path.join(REPO, 'dist', 'askpass', 'ssh-askpass.exe') : ASKPASS_PATHS.sshAskpass);
const ssh = helperBuilt ? await resolveSshExecutable() : undefined;
const docker = ssh !== undefined ? await dockerLinux() : undefined;
const runnable = docker !== undefined && ssh !== undefined && helperBuilt;

describe.skipIf(!runnable)('startSshTransport against a Docker sshd (needs Docker with Linux containers, ssh and npm run build:desktop)', () => {
  const name = `damocles-ssh-transport-${randomBytes(4).toString('hex')}`;
  let port = 0;
  let home = '';
  let config = '';
  let knownHosts = '';
  let askpass: AskpassServer;
  const run = async (args: string[]): Promise<string> => {
    const { exit, stdout, stderr } = await runProcess({ file: docker!, args, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, { timeoutMs: 180_000 });
    if (exit?.code !== 0) throw new Error(`docker ${args.join(' ')}: ${stderr.toString('utf8')}`);
    return stdout.toString('utf8');
  };

  beforeAll(async () => {
    home = scratchDir('ssh-client-');
    mkdirSync(path.join(home, '.ssh'));
    const identity = path.join(home, '.ssh', 'id_ed25519');
    const keygen = path.join(path.dirname(ssh!), process.platform === 'win32' ? 'ssh-keygen.exe' : 'ssh-keygen');
    await runProcess({ file: keygen, args: ['-q', '-t', 'ed25519', '-N', '', '-f', identity], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    knownHosts = path.join(home, '.ssh', 'known_hosts');
    writeFileSync(knownHosts, '');
    // a port the OS hands out, never one in a Windows excluded port range, where Docker Desktop's own pick can land
    port = await freeLoopbackPort();
    try {
      await run(['run', '-d', '--rm', '--name', name, '-p', `127.0.0.1:${port}:22`, ALPINE_TARGET_IMAGE, 'sleep', '600']);
    } catch (error) {
      // a failed `docker run` may leave the container created
      await runProcess({ file: docker!, args: ['rm', '-f', name], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, { timeoutMs: 60_000 });
      throw error;
    }
    const setup = [
      'apk add --no-cache openssh-server libstdc++ libgcc >/dev/null',
      'adduser -D -s /bin/sh dev && passwd -u dev >/dev/null 2>&1; sed -i "s/^dev:!/dev:*/" /etc/shadow',
      'mkdir -p /home/dev/.ssh && chmod 700 /home/dev/.ssh',
      'ssh-keygen -A >/dev/null',
      '/usr/sbin/sshd',
    ].join(' && ');
    await run(['exec', name, 'sh', '-c', setup]);
    await run(['exec', '-i', name, 'sh', '-c', `printf '%s\\n' '${readFileSync(`${identity}.pub`, 'utf8').trim()}' > /home/dev/.ssh/authorized_keys && chown -R dev /home/dev/.ssh && chmod 600 /home/dev/.ssh/authorized_keys`]);
    const posix = (file: string): string => file.split(path.sep).join('/');
    config = path.join(home, 'ssh_config');
    writeFileSync(config, [
      'Host fixture',
      '  HostName 127.0.0.1',
      `  Port ${port}`,
      '  User dev',
      `  IdentityFile "${posix(identity)}"`,
      '  IdentitiesOnly yes',
      '  IdentityAgent none',
      `  UserKnownHostsFile "${posix(knownHosts)}"`,
      `  GlobalKnownHostsFile "${posix(path.join(home, 'none'))}"`,
      // a user's RemoteCommand and RequestTTY must not replace stage 0
      '  RemoteCommand echo replaced',
      '  RequestTTY yes',
      '',
    ].join('\n'));
    askpass = createMainAskpassServer({ paths: ASKPASS_PATHS, log: () => undefined });
  }, 240_000);

  // a test that needs a known host starts from the key the fixture's sshd holds now
  const trustHostKey = async (): Promise<void> => {
    const key = (await run(['exec', name, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'])).trim().split(/\s+/).slice(0, 2).join(' ');
    writeFileSync(knownHosts, `[127.0.0.1]:${port} ${key}\n`);
  };

  afterAll(async () => {
    await askpass?.dispose();
    if (docker !== undefined) await run(['rm', '-f', name]).catch(() => undefined);
  });

  const options = (hooks: SshAttemptHooks, overrides: Partial<SshTransportOptions> = {}): SshTransportOptions => ({
    hostLabel: 'fixture',
    destination: { kind: 'alias', alias: 'fixture' },
    forwardAgent: false,
    signal: new AbortController().signal,
    hooks,
    savePlatform: vi.fn(async () => undefined),
    installFolderSettled: vi.fn(async () => undefined),
    askpass,
    // a build without the target's package: the attempt runs to the probe's report and stops there
    manifest: { version: '3.7.0', protocolVersion: 1, packages: {} } satisfies ServerManifest,
    releasesUrl: 'http://127.0.0.1:9/releases',
    artifacts: { packagePath: async () => { throw new Error('no upload in this test'); } },
    sshConfigFile: config,
    log: () => undefined,
    ...overrides,
  });

  it('asks the host key with its fingerprint, lets ssh record it, detects the platform, and runs stage 1 to the probe', async () => {
    writeFileSync(knownHosts, '');
    const steps: string[] = [];
    const prompts: unknown[] = [];
    const hooks: SshAttemptHooks = {
      step: (step) => steps.push(step),
      progress: () => undefined,
      prompt: async (prompt) => {
        prompts.push(prompt);
        return prompt.kind === 'hostKey' ? { answer: 'connect', remember: false } : undefined;
      },
      notice: () => undefined,
    };
    const attempt = options(hooks);
    const failure = await startSshTransport(attempt).then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(SshConnectError);
    expect((failure as SshConnectError).code, (failure as SshConnectError).stderrTail).toBe('unknown');
    expect((failure as SshConnectError).params).toEqual({ reason: 'noPackage', target: 'alpine-x64' });
    const fingerprint = (await run(['exec', name, 'ssh-keygen', '-l', '-E', 'sha256', '-f', '/etc/ssh/ssh_host_ed25519_key.pub'])).match(/SHA256:\S+/)![0];
    expect(prompts).toEqual([{ kind: 'hostKey', host: `[127.0.0.1]:${port}`, keyType: 'ED25519', fingerprint }]);
    expect(readFileSync(knownHosts, 'utf8')).toContain(`[127.0.0.1]:${port}`);
    expect(steps).toEqual(['connecting', 'authenticating', 'checking']);
    expect(attempt.savePlatform).toHaveBeenCalledWith({ os: 'linux' });
  }, 120_000);

  it('connects without asking once the key is known, and reuses the cached platform', async () => {
    await trustHostKey();
    const prompt = vi.fn(async () => undefined);
    const before = statSync(knownHosts).mtimeMs;
    const commands: string[] = [];
    const launcher = (): Launcher => {
      const real = processLauncher();
      return {
        ...real,
        launch: (spec, launchOptions) => {
          commands.push(spec.args?.at(-1) ?? '');
          return real.launch(spec, launchOptions);
        },
      };
    };
    const deps: SshTransportDeps = { resolveSsh: async () => ssh, launcher, run: runSsh, env: process.env, userInfo: () => os.userInfo() };
    const attempt = options({ step: () => undefined, progress: () => undefined, prompt, notice: () => undefined }, { cachedPlatform: { os: 'linux' } });
    const failure = await startSshTransport(attempt, deps).then(() => undefined, (err: unknown) => err as SshConnectError);
    expect(failure?.params).toEqual({ reason: 'noPackage', target: 'alpine-x64' });
    expect(prompt).not.toHaveBeenCalled();
    // stage 0's ssh alone: no detection ran
    expect(commands).toHaveLength(1);
    expect(commands[0]).not.toBe('uname -s');
    expect(statSync(knownHosts).mtimeMs).toBe(before);
  }, 120_000);

  // A stand-in package: self-test passes, and attach answers every byte after its greeting, as the bridge copies bytes.
  const stubPackage = (version: string): { manifest: ServerManifest; file: string; data: Buffer } => {
    const script = "#!/bin/sh\ncase \"$1\" in\n  self-test) echo 'self-test: passed'; exit 0 ;;\n  attach) printf 'BRIDGE:'; exec cat ;;\nesac\nexit 64\n";
    // server-package.json marks an installed version, as every built package carries it
    const data: Buffer = tarGz([{ path: 'bin/damocles-server', mode: 0o755, data: Buffer.from(script) }, { path: 'server-package.json', mode: 0o644, data: Buffer.from(`{"version":"${version}"}\n`) }]);
    const file = path.join(scratchDir('stub-package-'), `damocles-server-${version}-alpine-x64.tar.gz`);
    writeFileSync(file, data);
    const manifest: ServerManifest = { version, protocolVersion: 1, packages: { 'alpine-x64': { file: path.basename(file), sha256: createHash('sha256').update(data).digest('hex'), size: data.length } } };
    return { manifest, file, data };
  };
  const quietHooks = (progress: number[] = [], steps: string[] = []): SshAttemptHooks => ({ step: (step) => steps.push(step), progress: (fraction) => progress.push(fraction), prompt: async () => ({ answer: 'connect', remember: false }), notice: () => undefined });

  it('installs by upload when the target cannot download, and hands over the bridge\'s bytes', async () => {
    await trustHostKey();
    const stub = stubPackage('3.7.1');
    const progress: number[] = [];
    const steps: string[] = [];
    const result = await startSshTransport(options(quietHooks(progress, steps), { manifest: stub.manifest, artifacts: { packagePath: async () => stub.file }, cachedPlatform: { os: 'linux' } }));
    try {
      expect(result.probe).toEqual({ target: 'alpine-x64', installDir: '/home/dev/.damocles/server', notices: [] });
      // a key that needs no question still passes Authenticating, once the remote command runs
      expect(steps).toEqual(['connecting', 'authenticating', 'checking', 'installing', 'starting']);
      expect(progress.at(-1)).toBe(1);
      const echoed = new Promise<string>((resolve) => {
        let text = '';
        result.stream.on('data', (chunk: Buffer) => {
          text += chunk.toString('latin1');
          if (text.length >= 'BRIDGE:'.length + 4) resolve(text);
        });
      });
      result.stream.write(Buffer.from([0x00, 0xff, 0x0a, 0x0d]));
      expect(await echoed).toBe(`BRIDGE:${Buffer.from([0x00, 0xff, 0x0a, 0x0d]).toString('latin1')}`);
      expect(await run(['exec', name, 'ls', '-a', '/home/dev/.damocles/server'])).toMatch(/3\.7\.1-alpine-x64/);
      expect(await run(['exec', name, 'sh', '-c', 'ls -a /home/dev/.damocles/server | grep -c staging || true'])).toBe('0\n');
    } finally {
      result.dispose();
    }
  }, 120_000);

  it('stops a tampered package at the hash check, before unpacking, leaving no version folder', async () => {
    await trustHostKey();
    const stub = stubPackage('3.7.2');
    const tampered = path.join(scratchDir('tampered-'), path.basename(stub.file));
    const bytes = Buffer.from(stub.data);
    bytes.writeUInt8(bytes.readUInt8(bytes.length - 20) ^ 0xff, bytes.length - 20);
    writeFileSync(tampered, bytes);
    const failure = await startSshTransport(options(quietHooks(), { manifest: stub.manifest, artifacts: { packagePath: async () => tampered }, cachedPlatform: { os: 'linux' } })).then(() => undefined, (err: unknown) => err as SshConnectError);
    expect(failure?.code).toBe('hashMismatch');
    const listing = await run(['exec', name, 'ls', '-a', '/home/dev/.damocles/server']);
    expect(listing).not.toMatch(/3\.7\.2/);
    expect(listing).not.toMatch(/staging|install\.lock/);
  }, 120_000);

  it('installs into <folder>/<user> for a folder holding a space, a quote and $, and then cleans the previous default folder', async () => {
    await trustHostKey();
    const stub = stubPackage('3.7.3');
    const folder = "/tmp/my 'odd' $dir";
    await run(['exec', name, 'sh', '-c', `mkdir -p "/tmp/my 'odd' \\$dir" && chmod 777 "/tmp/my 'odd' \\$dir" && mkdir -p /home/dev/.damocles/server/run-0123456789abcdef /home/dev/.damocles/server/.staging-left && chown -R dev /home/dev/.damocles`]);
    const attempt = options(quietHooks(), { manifest: stub.manifest, artifacts: { packagePath: async () => stub.file }, cachedPlatform: { os: 'linux' }, installFolder: folder, previousInstallFolder: null });
    const result = await startSshTransport(attempt);
    result.dispose();
    expect(result.probe.installDir).toBe(`${folder}/dev`);
    expect(await run(['exec', name, 'ls', `${folder}/dev`])).toMatch(/3\.7\.3-alpine-x64/);
    expect(attempt.installFolderSettled).toHaveBeenCalledTimes(1);
    expect((await run(['exec', name, 'ls', '-a', '/home/dev/.damocles/server'])).split('\n').filter((entry) => entry !== '' && entry !== '.' && entry !== '..')).toEqual(['run-0123456789abcdef']);
  }, 120_000);

  it('stops on a changed host key with the known_hosts name for ssh-keygen -R, and asks nothing', async () => {
    await trustHostKey();
    await run(['exec', name, 'sh', '-c', "pkill sshd; rm -f /etc/ssh/ssh_host_*; ssh-keygen -A >/dev/null; /usr/sbin/sshd"]);
    const prompt = vi.fn(async () => ({ answer: 'connect', remember: false }));
    const failure = await startSshTransport(options({ step: () => undefined, progress: () => undefined, prompt, notice: () => undefined })).then(() => undefined, (err: unknown) => err as SshConnectError);
    expect(failure?.code).toBe('hostKeyChanged');
    expect(failure?.params).toEqual({ host: `[127.0.0.1]:${port}` });
    expect(prompt).not.toHaveBeenCalled();
  }, 120_000);

  it('refuses a cancelled host key question as hostKeyRefused', async () => {
    writeFileSync(knownHosts, '');
    const failure = await startSshTransport(options({ step: () => undefined, progress: () => undefined, prompt: async () => ({ answer: 'cancel', remember: false }), notice: () => undefined })).then(() => undefined, (err: unknown) => err as SshConnectError);
    expect(failure?.code).toBe('hostKeyRefused');
    expect(readFileSync(knownHosts, 'utf8')).toBe('');
  }, 120_000);
});
