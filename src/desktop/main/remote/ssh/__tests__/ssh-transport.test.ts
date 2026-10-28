import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LaunchedProcess, Launcher, ProcessExit, SpawnSpec } from '../../../../../core/process-launcher';
import { createFakeSecretsStore } from '../../../../../__mocks__/fake-platform';
import type { AskpassRegistration, AskpassServer, PromptCredential } from '../../../../../core/scm/askpass/askpass-server';
import type { SshPrompt } from '../../../../preload/overlay-channels';
import { createRememberedSecrets } from '../remembered-secrets';
import type { ServerManifest } from '../../server-manifest-format';
import type { SshRun } from '../control-master';
import { parseSshVersion, runSshStage, SshConnectError, sshCallEnv, startSshTransport, type SshStageOptions, type SshTransportDeps, type SshTransportOptions } from '../ssh-transport';

// every call of the attempts' authenticated(), counted through the real rememberedAttempt
const authenticatedCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('../ssh-askpass', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ssh-askpass')>();
  return {
    ...actual,
    rememberedAttempt: (deps: Parameters<typeof actual.rememberedAttempt>[0]) => {
      const attempt = actual.rememberedAttempt(deps);
      return { ...attempt, authenticated: () => { authenticatedCalls.count++; attempt.authenticated(); } };
    },
  };
});

const PROBE = '@@DAMOCLES {"kind":"probe","target":"linux-x64","install":"/home/dev/.damocles/server"}\n';
const BRIDGE = '@@DAMOCLES {"kind":"bridge"}\n';

// One ssh process as the launcher hands it over, driven by the test: output, exit, a start that fails.
class FakeSsh {
  readonly spec: SpawnSpec;
  readonly written: Buffer[] = [];
  killed = 0;
  ended = false;
  writeError: Error | undefined;
  private readonly listeners = { stdout: [] as Array<(chunk: Buffer) => void>, stderr: [] as Array<(chunk: Buffer) => void> };
  private settle!: { exit: (exit: ProcessExit) => void; close: () => void; fail: (err: Error) => void };
  private done = false;
  readonly handle: LaunchedProcess;

  constructor(spec: SpawnSpec) {
    this.spec = spec;
    let exit!: (value: ProcessExit) => void;
    let close!: () => void;
    let failExit!: (err: Error) => void;
    let failClose!: (err: Error) => void;
    const exited = new Promise<ProcessExit>((resolve, reject) => { exit = resolve; failExit = reject; });
    const closed = new Promise<void>((resolve, reject) => { close = resolve; failClose = reject; });
    exited.catch(() => undefined);
    closed.catch(() => undefined);
    this.settle = { exit, close, fail: (err) => { failExit(err); failClose(err); } };
    this.handle = {
      pid: Promise.resolve(42),
      onData: (stream, listener) => { this.listeners[stream].push(listener); },
      write: async (chunk) => {
        if (this.writeError) throw this.writeError;
        this.written.push(Buffer.from(chunk));
      },
      end: () => { this.ended = true; },
      exited,
      closed,
      kill: () => {
        if (this.done) return;
        this.killed++;
        queueMicrotask(() => this.exit(null));
      },
    };
  }

  get command(): string {
    return this.spec.args!.at(-1)!;
  }

  stdout(data: string | Buffer): void {
    const chunk = Buffer.from(data);
    for (const listener of this.listeners.stdout) listener(chunk);
  }

  stderr(data: string | Buffer): void {
    const chunk = Buffer.from(data);
    for (const listener of this.listeners.stderr) listener(chunk);
  }

  exit(code: number | null): void {
    if (this.done) return;
    this.done = true;
    this.settle.exit({ code, signal: code === null ? 'SIGTERM' : null });
    this.settle.close();
  }

  failStart(err: Error): void {
    if (this.done) return;
    this.done = true;
    this.settle.fail(err);
  }
}

let sshPaths = 0;

function fixture(script: (ssh: FakeSsh) => void, run?: SshRun) {
  const launched: FakeSsh[] = [];
  const launcher: Launcher = {
    launch: (spec) => {
      const ssh = new FakeSsh(spec);
      launched.push(ssh);
      queueMicrotask(() => script(ssh));
      return ssh.handle;
    },
    createSessionJob: () => ({ id: 0, dispose: () => undefined }),
    dispose: async () => undefined,
  };
  const versionRuns: string[][] = [];
  // a path of its own per fixture: ssh -V's answer is cached per path
  const sshPath = `/usr/bin/ssh-${++sshPaths}`;
  const deps: SshTransportDeps = {
    resolveSsh: async () => sshPath,
    launcher: () => launcher,
    run: run ?? (async (_file, args) => {
      versionRuns.push([...args]);
      return { code: 0, stdout: '', stderr: 'OpenSSH_9.6p1, OpenSSL 3.0.13\n' };
    }),
    env: {},
    userInfo: () => os.userInfo(),
  };
  const registrations: Array<{ disposed: boolean }> = [];
  const askpass = {
    register: async (): Promise<AskpassRegistration> => {
      const registration = { disposed: false };
      registrations.push(registration);
      return { env: { SSH_ASKPASS: '/askpass.sh', SSH_ASKPASS_REQUIRE: 'force' }, cancelled: new AbortController().signal, dispose: () => { registration.disposed = true; } };
    },
  } as unknown as AskpassServer;
  return { launched, deps, askpass, registrations, versionRuns };
}

// detect: no cached platform, so the attempt runs the platform detection first
function transportOptions(askpass: AskpassServer, extra: Partial<SshTransportOptions> = {}, detect = false) {
  const steps: string[] = [];
  const logs: string[] = [];
  const controller = new AbortController();
  const options: SshTransportOptions = {
    hostLabel: 'prod-1',
    destination: { kind: 'alias', alias: 'prod-1' },
    forwardAgent: false,
    ...(detect ? {} : { cachedPlatform: { os: 'linux' as const } }),
    signal: controller.signal,
    hooks: { step: (step) => steps.push(step), progress: () => undefined, prompt: async () => undefined, notice: () => undefined },
    savePlatform: vi.fn(async () => undefined),
    installFolderSettled: vi.fn(async () => undefined),
    askpass,
    manifest: { version: '3.7.0', protocolVersion: 1, packages: {} } satisfies ServerManifest,
    releasesUrl: 'https://example.com/releases',
    artifacts: { packagePath: async () => { throw new Error('no upload'); } },
    log: (line) => { logs.push(line); },
    ...extra,
  };
  return { options, steps, logs, controller };
}

const rejection = (promise: Promise<unknown>): Promise<SshConnectError> => promise.then(() => { throw new Error('resolved'); }, (err: unknown) => err as SshConnectError);
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('startSshTransport', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves the hops with the attempt\'s signal and expands a key\'s ~ with the passwd entry\'s home, not HOME', async () => {
    const elsewhere = path.join(os.tmpdir(), 'not-the-passwd-home');
    vi.stubEnv('HOME', elsewhere);
    vi.stubEnv('USERPROFILE', elsewhere);
    const queries: Array<{ readonly args: readonly string[]; readonly signal: AbortSignal | undefined }> = [];
    const { deps, askpass } = fixture(() => undefined, async (_file, args, _timeoutMs, signal) => {
      if (args.includes('-V')) return { code: 0, stdout: '', stderr: 'OpenSSH_9.6p1\n' };
      queries.push({ args, signal });
      return { code: 0, stdout: 'hostname prod.lan\nuser deploy\nport 22\nidentityfile ~/.ssh/id_prod\n', stderr: '' };
    });
    let credential: PromptCredential | undefined;
    const register = askpass.register.bind(askpass);
    askpass.register = async (mode, label, prompt) => {
      credential = prompt;
      return register(mode, label, prompt);
    };
    const secrets = createRememberedSecrets(createFakeSecretsStore()).forHost('h1');
    await secrets.store({ hop: { hostname: 'prod.lan', port: 22, user: 'deploy' }, kind: 'passphrase', identityFile: '~/.ssh/id_prod' }, 'stored');
    const { options, controller } = transportOptions(askpass, { remembered: { offer: true, secrets } });
    const done = rejection(startSshTransport(options, deps));
    await vi.waitFor(() => expect(credential).toBeDefined());
    const text = `Enter passphrase for key '${os.userInfo().homedir}/.ssh/id_prod':`;
    await expect(credential!({ kind: 'passphrase', text }, new AbortController().signal)).resolves.toBe('stored');
    expect(queries.map((query) => query.signal)).toEqual([options.signal]);
    controller.abort();
    expect((await done).code).toBe('cancelled');
  });

  it('still connects for an account without a passwd entry, binding a key\'s ~ only as written, with a log line', async () => {
    const { deps, askpass } = fixture(() => undefined, async (_file, args) => {
      if (args.includes('-V')) return { code: 0, stdout: '', stderr: 'OpenSSH_9.6p1\n' };
      return { code: 0, stdout: 'hostname prod.lan\nuser deploy\nport 22\nidentityfile ~/.ssh/id_prod\n', stderr: '' };
    });
    let credential: PromptCredential | undefined;
    const register = askpass.register.bind(askpass);
    askpass.register = async (mode, label, prompt) => {
      credential = prompt;
      return register(mode, label, prompt);
    };
    const secrets = createRememberedSecrets(createFakeSecretsStore()).forHost('h1');
    await secrets.store({ hop: { hostname: 'prod.lan', port: 22, user: 'deploy' }, kind: 'passphrase', identityFile: '~/.ssh/id_prod' }, 'stored');
    const asked: SshPrompt[] = [];
    const { options, controller, logs } = transportOptions(askpass, {
      remembered: { offer: true, secrets },
      hooks: { step: () => undefined, progress: () => undefined, notice: () => undefined, prompt: async (prompt) => { asked.push(prompt); return { answer: 'typed', remember: false }; } },
    });
    const noPasswd = (): never => { throw Object.assign(new Error('ENOENT: no such file or directory, uv_os_get_passwd'), { code: 'ENOENT' }); };
    const done = rejection(startSshTransport(options, { ...deps, userInfo: noPasswd }));
    await vi.waitFor(() => expect(credential).toBeDefined());
    await expect(credential!({ kind: 'passphrase', text: "Enter passphrase for key '~/.ssh/id_prod':" }, new AbortController().signal)).resolves.toBe('stored');
    const expanded = "Enter passphrase for key '/home/deploy/.ssh/id_prod':";
    await expect(credential!({ kind: 'passphrase', text: expanded }, new AbortController().signal)).resolves.toBe('typed');
    expect(asked).toEqual([{ kind: 'secret', secretKind: 'passphrase', text: expanded }]);
    expect(logs).toContain('this account has no passwd entry, so ssh reads no ~/.ssh: ENOENT: no such file or directory, uv_os_get_passwd');
    controller.abort();
    expect((await done).code).toBe('cancelled');
  });

  it('binds no passphrase on a client whose ssh -V names an OpenSSH older than 8.4, so the stored one is never given', async () => {
    const { deps, askpass } = fixture(() => undefined, async (_file, args) => {
      if (args.includes('-V')) return { code: 0, stdout: '', stderr: 'OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2\n' };
      return { code: 0, stdout: 'hostname prod.lan\nuser deploy\nport 22\nidentityfile ~/.ssh/id_prod\n', stderr: '' };
    });
    let credential: PromptCredential | undefined;
    const register = askpass.register.bind(askpass);
    askpass.register = async (mode, label, prompt) => {
      credential = prompt;
      return register(mode, label, prompt);
    };
    const secrets = createRememberedSecrets(createFakeSecretsStore()).forHost('h1');
    await secrets.store({ hop: { hostname: 'prod.lan', port: 22, user: 'deploy' }, kind: 'passphrase', identityFile: '~/.ssh/id_prod' }, 'stored');
    const asked: SshPrompt[] = [];
    const { options, controller, logs } = transportOptions(askpass, {
      remembered: { offer: true, secrets },
      hooks: { step: () => undefined, progress: () => undefined, notice: () => undefined, prompt: async (prompt) => { asked.push(prompt); return { answer: 'typed', remember: false }; } },
    });
    const done = rejection(startSshTransport(options, deps));
    await vi.waitFor(() => expect(credential).toBeDefined());
    const text = `Enter passphrase for key '${os.userInfo().homedir}/.ssh/id_prod':`;
    await expect(credential!({ kind: 'passphrase', text }, new AbortController().signal)).resolves.toBe('typed');
    expect(asked).toEqual([{ kind: 'secret', secretKind: 'passphrase', text }]);
    // the attempt's own lines carry no prefix of their own; the caller adds the host's
    expect(logs.filter((line) => line.startsWith('[ssh'))).toEqual([]);
    controller.abort();
    expect((await done).code).toBe('cancelled');
  });

  it('fails as unknown with reason askpass, with a log line, when the askpass server cannot register the attempt', async () => {
    const { launched, deps, askpass } = fixture(() => undefined);
    askpass.register = () => Promise.reject(new Error('The askpass server was disposed'));
    const { options, logs } = transportOptions(askpass);
    const failure = await rejection(startSshTransport(options, deps));
    expect([failure.code, failure.params]).toEqual(['unknown', { reason: 'askpass' }]);
    expect(logs).toContain('the askpass server could not register the attempt: The askpass server was disposed');
    expect(launched).toHaveLength(0);
  });

  it('stops at an abort that came during an await before ssh started, and starts no ssh', async () => {
    const { launched, deps, askpass } = fixture(() => undefined);
    const { options, controller } = transportOptions(askpass);
    const register = askpass.register.bind(askpass);
    askpass.register = async (...args) => {
      const registration = await register(...args);
      controller.abort();
      return registration;
    };
    const failure = await rejection(startSshTransport(options, deps));
    expect(failure.code).toBe('cancelled');
    expect(launched).toHaveLength(0);
  });

  it('kills ssh and fails with cancelled on an abort after it started', async () => {
    const { launched, deps, askpass, registrations } = fixture((ssh) => ssh.stdout('@@DAMOCLES {"kind":"step","step":"checking"}\n'));
    const { options, controller } = transportOptions(askpass);
    const done = rejection(startSshTransport(options, deps));
    await tick();
    controller.abort();
    expect((await done).code).toBe('cancelled');
    expect(launched[0]!.killed).toBe(1);
    expect(registrations[0]!.disposed).toBe(true);
  });

  it('fails as unknown with reason spawn when ssh cannot start, in the stage and in the detection', async () => {
    const stage = fixture((ssh) => ssh.failStart(Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })));
    expect((await rejection(startSshTransport(transportOptions(stage.askpass).options, stage.deps))).params).toEqual({ reason: 'spawn' });
    const detection = fixture((ssh) => ssh.failStart(new Error('spawn EACCES')));
    const { options } = transportOptions(detection.askpass, {}, true);
    const failure = await rejection(startSshTransport(options, detection.deps));
    expect(failure).toBeInstanceOf(SshConnectError);
    expect([failure.code, failure.params]).toEqual(['unknown', { reason: 'spawn' }]);
    expect(detection.launched[0]!.command).toBe('uname -s');
  });

  it('fails a detection ssh killed by a signal without proving authentication', async () => {
    const { deps, askpass } = fixture((ssh) => {
      ssh.stdout('Lin');
      ssh.exit(null);
    });
    const { options, steps } = transportOptions(askpass, {}, true);
    const failure = await rejection(startSshTransport(options, deps));
    expect([failure.code, failure.params]).toEqual(['unknown', { reason: 'sshExited', exitCode: -1 }]);
    expect(steps).toEqual(['connecting']);
    expect(options.savePlatform).not.toHaveBeenCalled();
  });

  it('goes on to stage 0 when saving the detected platform fails, and names an unsupported OS alone', async () => {
    const saved = fixture((ssh) => {
      if (ssh.command === 'uname -s') ssh.stdout('Linux\n');
      ssh.exit(ssh.command === 'uname -s' ? 0 : 255);
    });
    const { options, logs } = transportOptions(saved.askpass, { savePlatform: async () => { throw new Error('the host store is read-only'); } }, true);
    const failure = await rejection(startSshTransport(options, saved.deps));
    expect([failure.code, failure.params]).toEqual(['unknown', { reason: 'sshExited', exitCode: 255 }]);
    expect(saved.launched).toHaveLength(2);
    expect(logs.some((line) => line.includes('the host store is read-only'))).toBe(true);
    const bsd = fixture((ssh) => {
      ssh.stdout('FreeBSD\n');
      ssh.exit(0);
    });
    const refused = await rejection(startSshTransport(transportOptions(bsd.askpass, {}, true).options, bsd.deps));
    expect([refused.code, refused.params]).toEqual(['unsupportedOs', { os: 'FreeBSD' }]);
  });

  it('fails as unknown when ssh -V cannot start, and runs it again on the next attempt', async () => {
    let starts = 0;
    const { deps, askpass } = fixture(() => undefined, async () => {
      starts++;
      if (starts === 1) throw new Error('the launcher worker stopped');
      return { code: 0, stdout: '', stderr: 'OpenSSH_9.6p1\n' };
    });
    const first = await rejection(startSshTransport(transportOptions(askpass).options, deps));
    expect([first.code, first.params]).toEqual(['unknown', { reason: 'spawn' }]);
    const { options, controller } = transportOptions(askpass);
    const second = rejection(startSshTransport(options, deps));
    await tick();
    controller.abort();
    expect((await second).code).toBe('cancelled');
    expect(starts).toBe(2);
  });

  it('reads a marked line outside the protocol as bridgeFailed, after the lines before it in the same chunk', async () => {
    const broken = fixture((ssh) => ssh.stdout('@@DAMOCLES {"kind":"nonsense"}\n'));
    expect((await rejection(startSshTransport(transportOptions(broken.askpass).options, broken.deps))).params).toEqual({ reason: 'stageProtocol' });
    const failFirst = fixture((ssh) => ssh.stdout('@@DAMOCLES {"kind":"fail","code":"hashMismatch","params":{}}\n@@DAMOCLES {"kind":"nonsense"}\n'));
    expect((await rejection(startSshTransport(transportOptions(failFirst.askpass).options, failFirst.deps))).code).toBe('hashMismatch');
  });

  it('fails as unknown, without throwing into the launcher, when handling stage output throws', async () => {
    const { launched, deps, askpass } = fixture((ssh) => ssh.stdout('@@DAMOCLES {"kind":"step","step":"checking"}\n'));
    const { options, logs } = transportOptions(askpass, {
      hooks: { step: (step) => { if (step === 'checking') throw new Error('a listener broke'); }, progress: () => undefined, prompt: async () => undefined, notice: () => undefined },
    });
    const failure = await rejection(startSshTransport(options, deps));
    expect([failure.code, failure.params]).toEqual(['unknown', { reason: 'stageOutput' }]);
    expect(launched[0]!.killed).toBe(1);
    expect(logs.some((line) => line.includes('a listener broke'))).toBe(true);
  });

  it('classifies ssh\'s stderr only on exit 255 and only what ssh printed before the remote command\'s output', async () => {
    const refusedLine = 'ssh: connect to host 10.0.0.9 port 22: Connection refused\n';
    const own = fixture((ssh) => {
      ssh.stderr(refusedLine);
      ssh.exit(255);
    });
    expect((await rejection(startSshTransport(transportOptions(own.askpass).options, own.deps))).code).toBe('refused');
    const remoteExit = fixture((ssh) => {
      ssh.stderr(refusedLine);
      ssh.exit(1);
    });
    expect((await rejection(startSshTransport(transportOptions(remoteExit.askpass).options, remoteExit.deps))).params).toEqual({ reason: 'sshExited', exitCode: 1 });
    const afterOutput = fixture((ssh) => {
      ssh.stdout('@@DAMOCLES {"kind":"step","step":"checking"}\n');
      ssh.stderr(refusedLine);
      ssh.exit(255);
    });
    const failure = await rejection(startSshTransport(transportOptions(afterOutput.askpass).options, afterOutput.deps));
    expect([failure.code, failure.params]).toEqual(['unknown', { reason: 'sshExited', exitCode: 255 }]);
    expect(failure.stderrTail).toBe(refusedLine);
  });

  it('decodes stderr across chunks, for the tail and for whole log lines without a second prefix', async () => {
    const bytes = Buffer.from('Welcome to πρόδ\nkex_exchange_identification: Connection closed by remote host\n');
    const { deps, askpass } = fixture((ssh) => {
      const split = bytes.indexOf(Buffer.from('ρ')) + 1;
      ssh.stderr(bytes.subarray(0, split));
      ssh.stderr(bytes.subarray(split));
      ssh.exit(255);
    });
    const { options, logs } = transportOptions(askpass);
    const failure = await rejection(startSshTransport(options, deps));
    expect(failure.code).toBe('refused');
    expect(failure.stderrTail).toBe(bytes.toString('utf8'));
    expect(logs).toEqual(expect.arrayContaining(['Welcome to πρόδ', 'kex_exchange_identification: Connection closed by remote host']));
  });

  it('hands over the bridge, ends the stream after the last bytes when ssh exits, even while it is paused, then closes it', async () => {
    let bridgeSsh!: FakeSsh;
    const { deps, askpass } = fixture((ssh) => {
      bridgeSsh = ssh;
      ssh.stdout(`${PROBE}${BRIDGE}first`);
    });
    const result = await startSshTransport(transportOptions(askpass).options, deps);
    expect(result.probe).toEqual({ target: 'linux-x64', installDir: '/home/dev/.damocles/server', notices: [] });
    const stream: Duplex = result.stream;
    stream.pause();
    bridgeSsh.stdout('-second');
    bridgeSsh.exit(0);
    await tick();
    expect(stream.destroyed).toBe(false);
    const closed = new Promise<void>((resolve) => stream.once('close', () => resolve()));
    let read = '';
    stream.on('data', (chunk: Buffer) => { read += chunk.toString('utf8'); });
    stream.resume();
    await closed;
    expect(read).toBe('first-second');
    // ssh had exited: ending the stream never kills it
    expect(bridgeSsh.killed).toBe(0);
  });

  it('takes the stage\'s first output, not every chunk of it, as the proof that ssh signed in', async () => {
    const { deps, askpass } = fixture((ssh) => {
      ssh.stdout('@@DAMOCLES {"kind":"step","step":"checking"}\n');
      ssh.stdout(PROBE);
      ssh.stdout('motd line\n');
      ssh.stdout(BRIDGE);
    });
    authenticatedCalls.count = 0;
    const result = await startSshTransport(transportOptions(askpass).options, deps);
    expect(authenticatedCalls.count).toBe(1);
    result.dispose();
  });

  it('passes the plan\'s ControlMaster options and doubles a % in the key path', async () => {
    const { launched, deps, askpass } = fixture((ssh) => ssh.exit(255));
    const { options } = transportOptions(askpass, { controlMaster: { kind: 'off' }, identityFile: '/home/100%u/.damocles/ssh/id_ed25519' });
    await rejection(startSshTransport(options, deps));
    const args = launched[0]!.spec.args!;
    expect(args).toEqual(expect.arrayContaining(['ControlMaster=no', 'ControlPath=none', 'IdentityFile="/home/100%%u/.damocles/ssh/id_ed25519"']));
  });

  it('fails as unknown with reason sshArguments, starting no ssh, when ssh-args.ts refuses an argument', async () => {
    const { launched, deps, askpass } = fixture(() => undefined);
    const { options } = transportOptions(askpass, { identityFile: 'relative/id_ed25519' });
    const failure = await rejection(startSshTransport(options, deps));
    expect([failure.code, failure.params]).toEqual(['unknown', { reason: 'sshArguments' }]);
    expect(launched).toHaveLength(0);
  });

  it('refuses an install folder holding a newline before any ssh starts', async () => {
    const { launched, deps, askpass } = fixture(() => undefined);
    const failure = await rejection(startSshTransport(transportOptions(askpass, { installFolder: '/tmp/a\nb' }).options, deps));
    expect([failure.code, failure.params]).toEqual(['installFolderInvalid', { reason: 'newline' }]);
    expect(launched).toHaveLength(0);
  });

  it('uploads exactly the manifest\'s bytes, and refuses a package whose size differs before sending anything', async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'upload-'));
    const file = path.join(folder, 'damocles-server-3.7.0-linux-x64.tar.gz');
    writeFileSync(file, 'PACKAGE');
    const packaged = (size: number): ServerManifest => ({ version: '3.7.0', protocolVersion: 1, packages: { 'linux-x64': { file: path.basename(file), sha256: '0'.repeat(64), size } } });
    const upload = (size: number) => {
      const made = fixture((ssh) => ssh.stdout(`${PROBE}@@DAMOCLES {"kind":"upload"}\n`));
      const { options, logs } = transportOptions(made.askpass, { manifest: packaged(size), artifacts: { packagePath: async () => file } });
      return { made, done: rejection(startSshTransport(options, made.deps)), logs };
    };
    const exact = upload(7);
    await vi.waitFor(() => expect(Buffer.concat(exact.made.launched[0]!.written).toString('utf8')).toMatch(/7\nPACKAGE$/));
    exact.made.launched[0]!.exit(1);
    await exact.done;
    const wrong = upload(5);
    expect((await wrong.done).code).toBe('downloadAndUploadFailed');
    // stage 1's frame alone: no length line and no package bytes
    expect(wrong.made.launched[0]!.written).toHaveLength(1);
    expect(wrong.logs.some((line) => line.includes('5'))).toBe(true);
  });

  it('fails an upload request before the probe as a stage protocol error, not as a failed upload', async () => {
    const { deps, askpass } = fixture((ssh) => ssh.stdout('@@DAMOCLES {"kind":"upload"}\n'));
    const failure = await rejection(startSshTransport(transportOptions(askpass).options, deps));
    expect([failure.code, failure.params]).toEqual(['bridgeFailed', { reason: 'stageProtocol' }]);
  });

  it('logs no failed upload when the attempt was cancelled during it', async () => {
    let release!: () => void;
    const { deps, askpass } = fixture((ssh) => ssh.stdout(`${PROBE}@@DAMOCLES {"kind":"upload"}\n`));
    const { options, logs, controller } = transportOptions(askpass, {
      manifest: { version: '3.7.0', protocolVersion: 1, packages: { 'linux-x64': { file: 'damocles-server-3.7.0-linux-x64.tar.gz', sha256: '0'.repeat(64), size: 7 } } },
      artifacts: { packagePath: () => new Promise((_resolve, reject) => { release = () => reject(new Error('the download was stopped')); }) },
    });
    const done = rejection(startSshTransport(options, deps));
    await vi.waitFor(() => expect(release).toBeDefined());
    controller.abort();
    expect((await done).code).toBe('cancelled');
    release();
    await tick();
    expect(logs.some((line) => line.includes('upload failed'))).toBe(false);
  });
});

describe('runSshStage', () => {
  function stageOptions(askpass: AskpassServer, extra: Partial<SshStageOptions> = {}) {
    const logs: string[] = [];
    const controller = new AbortController();
    const options: SshStageOptions = {
      hostLabel: 'prod-1',
      destination: { kind: 'alias', alias: 'prod-1' },
      platform: { os: 'linux' },
      askpass,
      prompt: async () => undefined,
      signal: controller.signal,
      log: (line) => { logs.push(line); },
      ...extra,
    };
    return { options, logs, controller };
  }

  it('resolves the remote exit code and the marked lines, decoded across chunks', async () => {
    const out = Buffer.from('motd\n@@DAMOCLES removed /home/dév/.damocles/server\n');
    const { deps, askpass, launched, registrations } = fixture((ssh) => {
      const split = out.indexOf(Buffer.from('é')) + 1;
      ssh.stdout(out.subarray(0, split));
      ssh.stdout(out.subarray(split));
      ssh.exit(3);
    });
    const { options, logs } = stageOptions(askpass);
    expect(await runSshStage(options, 'echo removal', deps)).toEqual({ code: 3, lines: ['removed /home/dév/.damocles/server'] });
    expect(logs).toContain('stage output: motd');
    expect(launched[0]!.command).toContain('/bin/sh');
    expect(registrations[0]!.disposed).toBe(true);
  });

  it('answers the removal\'s password from the host\'s remembered answers, and stores one typed with Remember once ssh signed in', async () => {
    let credential: PromptCredential | undefined;
    const { deps, askpass } = fixture((ssh) => {
      void (async () => {
        const answer = await credential!({ kind: 'password', text: "deploy@prod.lan's password:" }, new AbortController().signal);
        ssh.stdout(`@@DAMOCLES answered ${String(answer)}\n`);
        ssh.stdout('@@DAMOCLES done\n');
        ssh.exit(0);
      })();
    }, async (_file, args) => (args.includes('-V') ? { code: 0, stdout: '', stderr: 'OpenSSH_9.6p1\n' } : { code: 0, stdout: 'hostname prod.lan\nuser deploy\nport 22\n', stderr: '' }));
    const register = askpass.register.bind(askpass);
    askpass.register = async (mode, label, prompt) => {
      credential = prompt;
      return register(mode, label, prompt);
    };
    const store = createFakeSecretsStore();
    const secrets = createRememberedSecrets(store).forHost('h1');
    const hop = { hostname: 'prod.lan', port: 22, user: 'deploy' };
    await secrets.store({ hop, kind: 'password' }, 'remembered');
    const asked: SshPrompt[] = [];
    const remembered = stageOptions(askpass, { remembered: { offer: true, secrets }, prompt: async (prompt) => { asked.push(prompt); return undefined; } });
    expect((await runSshStage(remembered.options, 'true', deps)).lines).toEqual(['answered remembered', 'done']);
    expect(asked).toEqual([]);

    await secrets.delete({ hop, kind: 'password' });
    const typed = stageOptions(askpass, { remembered: { offer: true, secrets }, prompt: async (prompt) => { asked.push(prompt); return { answer: 'typed', remember: true }; } });
    expect((await runSshStage(typed.options, 'true', deps)).lines).toEqual(['answered typed', 'done']);
    expect(asked).toEqual([{ kind: 'secret', secretKind: 'password', text: "deploy@prod.lan's password:", offerRemember: true }]);
    await vi.waitFor(() => expect([...store.entries.values()]).toEqual(['typed']));
  });

  it('fails the removal as unknown with reason askpass when the askpass server cannot register it', async () => {
    const { launched, deps, askpass } = fixture(() => undefined);
    askpass.register = () => Promise.reject(new Error('The askpass server was disposed'));
    const { options, logs } = stageOptions(askpass);
    const failure = await rejection(runSshStage(options, 'true', deps));
    expect([failure.code, failure.params]).toEqual(['unknown', { reason: 'askpass' }]);
    expect(logs).toContain('the askpass server could not register the attempt: The askpass server was disposed');
    expect(launched).toHaveLength(0);
  });

  it('classifies ssh\'s own failure on exit 255', async () => {
    const { deps, askpass } = fixture((ssh) => {
      ssh.stderr('dev@prod-1: Permission denied (publickey).\n');
      ssh.exit(255);
    });
    expect((await rejection(runSshStage(stageOptions(askpass).options, 'true', deps))).code).toBe('permissionDenied');
  });

  it('starts no ssh after an abort during an await, and kills one that runs', async () => {
    const before = fixture(() => undefined);
    const early = stageOptions(before.askpass);
    const register = before.askpass.register.bind(before.askpass);
    before.askpass.register = async (...args) => {
      const registration = await register(...args);
      early.controller.abort();
      return registration;
    };
    expect((await rejection(runSshStage(early.options, 'true', before.deps))).code).toBe('cancelled');
    expect(before.launched).toHaveLength(0);
    const running = fixture(() => undefined);
    const late = stageOptions(running.askpass);
    const done = rejection(runSshStage(late.options, 'true', running.deps));
    await vi.waitFor(() => expect(running.launched).toHaveLength(1));
    late.controller.abort();
    expect((await done).code).toBe('cancelled');
    expect(running.launched[0]!.killed).toBe(1);
  });

  it('keeps the marker of a marked line past the bound, so the line reaches the outcome as a truncated status line', async () => {
    const head = `@@DAMOCLES {"kind":"removed","pad":"${'x'.repeat(3000)}`;
    const { deps, askpass } = fixture((ssh) => {
      ssh.stdout(head);
      ssh.stdout(`${'y'.repeat(3000)}"}\n@@DAMOCLES done\n`);
      ssh.exit(0);
    });
    const { lines } = await runSshStage(stageOptions(askpass).options, 'true', deps);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(head.slice('@@DAMOCLES '.length, 2000));
    expect(lines[1]).toBe('done');
  });

  it('reads an ssh that ended before taking the script by its exit, the write\'s failure only logged', async () => {
    const { deps, askpass } = fixture((ssh) => {
      ssh.stderr('ssh: connect to host 10.0.0.9 port 22: Connection refused\n');
      ssh.exit(255);
    });
    const { options, logs } = stageOptions(askpass);
    const origLaunch = deps.launcher().launch.bind(deps.launcher());
    deps.launcher().launch = (spec) => {
      const handle = origLaunch(spec);
      return { ...handle, write: async () => { throw new Error('The process has closed'); } };
    };
    expect((await rejection(runSshStage(options, 'true', deps))).code).toBe('refused');
    expect(logs.some((line) => line.includes('The process has closed'))).toBe(true);
  });
});

describe('the ssh call environment', () => {
  it('reads OpenSSH\'s version from ssh -V', () => {
    expect(parseSshVersion('OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2')).toEqual([9, 5]);
    expect(parseSshVersion('OpenSSH_8.2p1 Ubuntu-4ubuntu0.11, OpenSSL 1.1.1f')).toEqual([8, 2]);
    expect(parseSshVersion('Dropbear v2022.83')).toBeUndefined();
  });

  it('adds the askpass variables only, and DISPLAY for an OpenSSH before 8.4 or one it cannot name, unless one is set', () => {
    const askpass = { SSH_ASKPASS: '/a.sh', SSH_ASKPASS_REQUIRE: 'force', DAMOCLES_ASKPASS_HANDLE: 'h', GIT_ASKPASS: '/git.sh' };
    expect(sshCallEnv({ PATH: '/bin' }, askpass, [9, 6])).toEqual({ PATH: '/bin', SSH_ASKPASS: '/a.sh', SSH_ASKPASS_REQUIRE: 'force', DAMOCLES_ASKPASS_HANDLE: 'h' });
    expect(sshCallEnv({}, askpass, [8, 2])['DISPLAY']).toBe('damocles:0');
    expect(sshCallEnv({}, askpass, undefined)['DISPLAY']).toBe('damocles:0');
    expect(sshCallEnv({ DISPLAY: ':1' }, askpass, [7, 4])['DISPLAY']).toBe(':1');
  });
});
