// The SSH transport: ssh started through main's launcher with streaming stdio and a per-call environment, stage 0 as its
// remote command, stage 1 on its stdin, and stage 1's status lines until the bridge hands stdout to the protocol. The result
// is the same Duplex the loopback transport gives Authorities, past the bridge's authentication with the daemon.
import { createReadStream, promises as fs } from 'node:fs';
import * as os from 'node:os';
import { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { processLauncher, type LaunchedProcess, type Launcher, type ProcessExit } from '../../../../core/process-launcher';
import type { AskpassRegistration, AskpassServer } from '../../../../core/scm/askpass/askpass-server';
import { resolveSshExecutable } from '../../../../core/system-tools';
import type { CachedPlatform, ConnectStep, HostNotice, SshFailureCode, SshPrompt, SshPromptAnswer } from '../../../preload/overlay-channels';
import type { ShellPlatform } from '../../../preload/shell-channels';
import type { ArtifactCache } from '../artifact-cache';
import type { ServerManifest, ServerTarget } from '../server-manifest-format';
import { resolvePlatform } from '../bootstrap/platform-detect';
import { createStageOutput, StageProtocolError, type StageMessage } from '../bootstrap/probe-parse';
import { buildPosixStage1, buildWindowsStage1, validateInstallFolder } from '../bootstrap/stage1';
import { POSIX_STAGE0, stage1Frame, windowsStage0 } from '../bootstrap/stage0';
import { runSsh, type ControlMasterPlan, type SshRun } from './control-master';
import { buildSshArgs, buildSshVersionArgs, SshArgumentError, type SshArgsInput } from './ssh-args';
import { attemptPrompt, rememberedAttempt, type AttemptPromptState, type RememberedAttempt } from './ssh-askpass';
import { passwdAccount, resolveSshHops, type SshAccount } from './ssh-config';
import type { HostSecrets } from './remembered-secrets';
import type { SshDestination } from './ssh-command-parse';
import { sshPercentLiteral } from './ssh-percent';
import { classifySshStderr } from './ssh-stderr';

// characters of ssh's and the bridge's stderr kept for the failure and Show log
const MAX_STDERR_TAIL_CHARS = 16 * 1024;
const MAX_LOG_LINE_CHARS = 2000;
// a detection command's stdout past this is not an answer to `uname -s` or the shell echo
const MAX_DETECTION_STDOUT_BYTES = 4096;
// ssh exits with 255 when it, not the remote command, failed
const SSH_ERROR_EXIT = 255;
// OpenSSH before 8.4 uses SSH_ASKPASS only with DISPLAY set
const ASKPASS_REQUIRE_VERSION = [8, 4] as const;
const VERSION_TIMEOUT_MS = 15_000;
const HOPS_TIMEOUT_MS = 15_000;
// a fixed stage's status lines: the marker stage 1 uses, and at most this many kept
const STAGE_LINE_MARKER = '@@DAMOCLES ';
const MAX_STAGE_LINES = 1000;

export class SshConnectError extends Error {
  override readonly name = 'SshConnectError';
  readonly code: SshFailureCode;
  readonly params: Readonly<Record<string, string | number>>;
  // ssh's and the bridge's stderr at the failure
  readonly stderrTail: string;
  constructor(code: SshFailureCode, params: Readonly<Record<string, string | number>>, stderrTail: string) {
    super(`the SSH connection failed: ${code}`);
    this.code = code;
    this.params = params;
    this.stderrTail = stderrTail;
  }
}

export interface SshAttemptHooks {
  step(step: ConnectStep): void;
  // download or upload progress, 0 to 1, while installing
  progress(fraction: number): void;
  // hostKey answers 'connect' or 'cancel'; a secret its text, or undefined to cancel; signal aborts when ssh withdraws it
  prompt(prompt: SshPrompt, signal: AbortSignal): Promise<SshPromptAnswer | undefined>;
  notice(notice: HostNotice): void;
}

export interface ProbeReport {
  readonly target: ServerTarget;
  // <install> on the target as stage 1 resolved it
  readonly installDir: string;
  readonly notices: readonly HostNotice[];
}

export interface SshTransportResult {
  readonly stream: Duplex;
  readonly platform: CachedPlatform;
  readonly probe: ProbeReport;
  // live: the bridge keeps writing to it after the connect
  stderrTail(): string;
  // kills ssh if it still runs; the daemon and its runs keep running
  dispose(): void;
}

// the host's store, bound when the attempt began, and the prompt offering "Remember on this computer"
export interface RememberedOption {
  readonly offer: true;
  readonly secrets: HostSecrets;
}

export interface SshTransportOptions {
  // the host's name on this computer, for the askpass label
  readonly hostLabel: string;
  readonly destination: SshDestination;
  readonly osOverride?: ShellPlatform;
  readonly cachedPlatform?: CachedPlatform;
  // absent: the default ~/.damocles/server
  readonly installFolder?: string;
  // null: the default folder; absent: nothing to clean
  readonly previousInstallFolder?: string | null;
  // ssh's ForwardAgent; true only for a host known to be POSIX
  readonly forwardAgent: boolean;
  // Damocles' passwordless key once it was set up and verified
  readonly identityFile?: string;
  // the host's remembered answers, only while its Remember password setting is on
  readonly remembered?: RememberedOption;
  // aborting before the connect resolves kills ssh and rejects with cancelled
  readonly signal: AbortSignal;
  readonly hooks: SshAttemptHooks;
  // a detection ran on the host and found this platform
  savePlatform(platform: CachedPlatform): Promise<void>;
  // the first install in the new folder removed Damocles' entries from the previous one
  installFolderSettled(): Promise<void>;
  readonly askpass: AskpassServer;
  readonly manifest: ServerManifest;
  readonly releasesUrl: string;
  readonly artifacts: ArtifactCache;
  // the e2e hook's -F file
  readonly sshConfigFile?: string;
  readonly controlMaster?: ControlMasterPlan;
  readonly log: (line: string) => void;
}

export interface SshTransportDeps {
  readonly resolveSsh: () => Promise<string | undefined>;
  // ssh's connections, with streaming stdio
  readonly launcher: () => Launcher;
  // `ssh -V` and the hops' `ssh -G`
  readonly run: SshRun;
  readonly env: Readonly<Record<string, string | undefined>>;
  // the passwd entry ssh expands `~` with
  readonly userInfo: () => SshAccount;
}

const defaultDeps: SshTransportDeps = { resolveSsh: () => resolveSshExecutable(), launcher: processLauncher, run: runSsh, env: process.env, userInfo: () => os.userInfo() };

type Failure = (code: SshFailureCode, params?: Readonly<Record<string, string | number>>) => SshConnectError;

interface Tail {
  append(text: string): void;
  text(): string;
}

function createTail(max: number): Tail {
  let tail = '';
  return {
    append: (text) => {
      tail = (tail + text).slice(-max);
    },
    text: () => tail,
  };
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The major and minor version `ssh -V` names, as OpenSSH or OpenSSH_for_Windows. */
export function parseSshVersion(output: string): readonly [number, number] | undefined {
  const match = /OpenSSH(?:_for_Windows)?_(\d+)\.(\d+)/.exec(output);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

const versions = new Map<string, Promise<readonly [number, number] | undefined>>();

/** The version `ssh -V` names for this client, read once per path; a start that failed is tried again by the next call. */
export function sshVersion(ssh: string, run: SshRun = runSsh): Promise<readonly [number, number] | undefined> {
  let version = versions.get(ssh);
  if (!version) {
    const started = run(ssh, buildSshVersionArgs(), VERSION_TIMEOUT_MS).then(({ stdout, stderr }) => parseSshVersion(`${stderr}${stdout}`));
    started.catch(() => {
      if (versions.get(ssh) === started) versions.delete(ssh);
    });
    versions.set(ssh, started);
    version = started;
  }
  return version;
}

async function sshVersionOrFail(ssh: string, run: SshRun, log: (line: string) => void, failure: Failure): Promise<readonly [number, number] | undefined> {
  try {
    return await sshVersion(ssh, run);
  } catch (err) {
    log(`ssh -V did not run: ${messageOf(err)}`);
    throw failure('unknown', { reason: 'spawn' });
  }
}

/**
 * The askpass variables of one call, on top of this process's environment; never set in process.env itself. DISPLAY is added
 * for an OpenSSH older than 8.4, and for a version `ssh -V` did not name, unless the environment has one.
 */
export function sshCallEnv(base: Readonly<Record<string, string | undefined>>, askpass: Readonly<Record<string, string>>, version: readonly [number, number] | undefined): Record<string, string | undefined> {
  const picked = Object.fromEntries(Object.entries(askpass).filter(([key]) => key === 'SSH_ASKPASS' || key === 'SSH_ASKPASS_REQUIRE' || key.startsWith('DAMOCLES_ASKPASS_')));
  const old = version === undefined || version[0] < ASKPASS_REQUIRE_VERSION[0] || (version[0] === ASKPASS_REQUIRE_VERSION[0] && version[1] < ASKPASS_REQUIRE_VERSION[1]);
  return { ...base, ...picked, ...(old && !base['DISPLAY'] ? { DISPLAY: 'damocles:0' } : {}) };
}

function folderFailure(options: SshTransportOptions): { readonly reason: string } | undefined {
  for (const folder of [options.installFolder, options.previousInstallFolder]) {
    if (typeof folder !== 'string') continue;
    const check = validateInstallFolder(folder);
    if (!check.ok) return { reason: check.reason };
  }
  return undefined;
}

const samePlatform = (a: CachedPlatform | undefined, b: CachedPlatform): boolean => a !== undefined && a.os === b.os && a.windowsShell === b.windowsShell;

interface LaunchedSsh {
  readonly child: LaunchedProcess;
  // ssh's stderr from before the remote command's first output, the only part ssh's own failures are read from
  sshStderr(): string;
}

// The arguments, or the attempt's failure when ssh-args.ts refuses one; the reason is logged.
function sshArgsOrFail(input: SshArgsInput, log: (line: string) => void, failure: Failure): string[] {
  try {
    return buildSshArgs(input);
  } catch (err) {
    if (!(err instanceof SshArgumentError)) throw err;
    log(`ssh's arguments were refused: ${err.message}`);
    throw failure('unknown', { reason: 'sshArguments' });
  }
}

/** ssh on the launcher; its stderr goes to the attempt's tail and to the log line by line, decoded across chunks. */
function launchSsh(deps: SshTransportDeps, file: string, env: Record<string, string | undefined>, args: SshArgsInput, tail: Tail, log: (line: string) => void, failure: Failure): LaunchedSsh {
  const child = deps.launcher().launch({ file, args: sshArgsOrFail(args, log, failure), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const beforeOutput = createTail(MAX_STDERR_TAIL_CHARS);
  let output = false;
  child.onData('stdout', () => {
    output = true;
  });
  const decoder = new StringDecoder('utf8');
  let partial = '';
  const logLine = (line: string): void => {
    if (line.trim() !== '') log(line.slice(0, MAX_LOG_LINE_CHARS));
  };
  const take = (text: string): void => {
    tail.append(text);
    if (!output) beforeOutput.append(text);
    const lines = (partial + text).split(/\r?\n/);
    // past the log's length only what the log shows of the line is kept
    partial = lines.pop()!.slice(0, MAX_LOG_LINE_CHARS);
    lines.forEach(logLine);
  };
  child.onData('stderr', (chunk) => take(decoder.write(chunk)));
  child.closed.then(() => {
    take(decoder.end());
    logLine(partial);
    partial = '';
  }, () => undefined);
  return { child, sshStderr: () => beforeOutput.text() };
}

/** The exit once every output stream closed; a process that could not start, or whose worker died, fails as unknown. */
function exitOf(child: LaunchedProcess, log: (line: string) => void, failure: Failure): Promise<ProcessExit> {
  return Promise.all([child.exited, child.closed]).then(([exit]) => exit, (err: unknown) => {
    log(`ssh did not run: ${messageOf(err)}`);
    throw failure('unknown', { reason: 'spawn' });
  });
}

/** The failure an ssh that ended reports; ssh's own messages count only when ssh, not the remote command, failed. */
function endedFailure(code: number | null, sshStderr: string, aborted: boolean, state: AttemptPromptState, failure: Failure): SshConnectError {
  if (aborted || state.cancelled) return failure('cancelled');
  if (state.hostKeyRefused) return failure('hostKeyRefused');
  const classified = code === SSH_ERROR_EXIT ? classifySshStderr(sshStderr) : undefined;
  return classified ? failure(classified.code, classified.params) : failure('unknown', { reason: 'sshExited', exitCode: code ?? -1 });
}

// The attempt's registration with main's askpass server; a server that cannot register fails the attempt as unknown.
async function registerOrFail(askpass: AskpassServer, label: string, prompt: Parameters<AskpassServer['register']>[2], log: (line: string) => void, failure: Failure): Promise<AskpassRegistration> {
  try {
    return await askpass.register('interactive', label, prompt);
  } catch (err) {
    log(`the askpass server could not register the attempt: ${messageOf(err)}`);
    throw failure('unknown', { reason: 'askpass' });
  }
}

interface AttemptMemoryInput {
  readonly ssh: string;
  readonly version: readonly [number, number] | undefined;
  readonly destination: SshDestination;
  readonly sshConfigFile?: string;
  readonly remembered?: RememberedOption;
  readonly signal: AbortSignal;
  readonly run: SshRun;
  readonly userInfo: () => SshAccount;
  readonly log: (line: string) => void;
}

// What an attempt answers for the user: docs/invariants.md "Remote daemon and wire", remembered ssh passwords.
function attemptMemory(input: AttemptMemoryInput): RememberedAttempt {
  return rememberedAttempt({
    offer: input.remembered?.offer ?? false,
    ...(input.remembered ? { secrets: input.remembered.secrets } : {}),
    // ssh expands `~` in an IdentityFile with the passwd entry's home, never HOME
    home: passwdAccount(input.log, input.userInfo)?.homedir,
    sshVersion: input.version,
    hops: () => resolveSshHops({
      ssh: input.ssh,
      destination: input.destination,
      ...(input.sshConfigFile !== undefined ? { configFile: input.sshConfigFile } : {}),
      signal: input.signal,
      run: (file, args, runSignal) => input.run(file, args, HOPS_TIMEOUT_MS, runSignal),
    }),
    log: input.log,
  });
}

/** Connects, detects the platform when needed, runs the probe and the install, and resolves once the bridge authenticated. */
export async function startSshTransport(options: SshTransportOptions, deps: SshTransportDeps = defaultDeps): Promise<SshTransportResult> {
  const { hooks, log, signal } = options;
  const stderr = createTail(MAX_STDERR_TAIL_CHARS);
  const failure: Failure = (code, params = {}) => new SshConnectError(code, params, stderr.text());
  if (signal.aborted) throw failure('cancelled');
  const folder = folderFailure(options);
  if (folder) throw failure('installFolderInvalid', folder);
  const ssh = await deps.resolveSsh();
  if (ssh === undefined) throw failure('unknown', { reason: 'sshMissing' });
  hooks.step('connecting');
  const state: AttemptPromptState = { hostKeyRefused: false, cancelled: false };
  // reached at ssh's first question, or once the remote command ran, which a key that needed no question proves
  let authenticating = false;
  const reachAuthenticating = (): void => {
    if (authenticating) return;
    authenticating = true;
    hooks.step('authenticating');
  };
  const ask = (prompt: SshPrompt, promptSignal: AbortSignal): Promise<SshPromptAnswer | undefined> => {
    reachAuthenticating();
    return hooks.prompt(prompt, promptSignal);
  };
  let remembered: RememberedAttempt | undefined;
  // authentication is proven by the remote command's output or a detection's exit, never by ssh's first question
  const proven = (): void => {
    reachAuthenticating();
    remembered?.authenticated();
  };
  let registration: AskpassRegistration | undefined;
  let bridged = false;
  try {
    const version = await sshVersionOrFail(ssh, deps.run, log, failure);
    // a password typed for the detection answers stage 0's ssh too: Windows' OpenSSH has no master connection to share
    remembered = attemptMemory({ ssh, version, destination: options.destination, ...(options.sshConfigFile !== undefined ? { sshConfigFile: options.sshConfigFile } : {}), ...(options.remembered ? { remembered: options.remembered } : {}), signal, run: deps.run, userInfo: deps.userInfo, log });
    registration = await registerOrFail(options.askpass, `ssh ${options.hostLabel}`, attemptPrompt(ask, state, log, remembered), log, failure);
    const env = sshCallEnv(deps.env, registration.env, version);
    const spawn = (command: string): LaunchedSsh => {
      // an abort during an await before this reached no listener, so it stops the attempt here
      if (signal.aborted) throw failure('cancelled');
      return launchSsh(deps, ssh, env, {
        destination: options.destination,
        forwardAgent: options.forwardAgent,
        ...(options.identityFile !== undefined ? { identityFile: sshPercentLiteral(options.identityFile) } : {}),
        command,
        ...(options.sshConfigFile !== undefined ? { configFile: options.sshConfigFile } : {}),
        ...(options.controlMaster !== undefined ? { controlMaster: options.controlMaster } : {}),
      }, stderr, log, failure);
    };
    const whileAttempting = <T>(child: LaunchedProcess, run: Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const abort = (): void => {
          child.kill();
          reject(failure('cancelled'));
        };
        signal.addEventListener('abort', abort, { once: true });
        run.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });

    let detected = false;
    const runDetection = async (command: string): Promise<string> => {
      detected = true;
      const { child, sshStderr } = spawn(command);
      let stdout = Buffer.alloc(0);
      child.onData('stdout', (chunk) => {
        if (stdout.length < MAX_DETECTION_STDOUT_BYTES) stdout = Buffer.concat([stdout, chunk]).subarray(0, MAX_DETECTION_STDOUT_BYTES);
      });
      child.end();
      const exit = await whileAttempting(child, exitOf(child, log, failure));
      // killed by a signal, ssh proved nothing, as when it failed itself
      if (exit.code === SSH_ERROR_EXIT || exit.code === null) throw endedFailure(exit.code, sshStderr(), signal.aborted, state, failure);
      proven();
      return stdout.toString('utf8');
    };
    const resolved = await resolvePlatform(options.osOverride, options.cachedPlatform, { run: runDetection });
    if (!resolved.ok) throw failure('unsupportedOs', { os: resolved.os });
    const platform = resolved.platform;
    // the cache only spares the next connect a detection
    if (detected && !samePlatform(options.cachedPlatform, platform)) await options.savePlatform(platform).catch((err: unknown) => log(`saving the detected platform failed: ${messageOf(err)}`));

    const stageParams = {
      manifest: options.manifest,
      releasesUrl: options.releasesUrl,
      ...(options.installFolder !== undefined ? { installFolder: options.installFolder } : {}),
      ...(options.previousInstallFolder !== undefined ? { previousInstallFolder: options.previousInstallFolder } : {}),
    };
    const stage1 = platform.os === 'win32' ? buildWindowsStage1(stageParams) : buildPosixStage1(stageParams);
    const { child, sshStderr } = spawn(platform.os === 'win32' ? windowsStage0(platform.windowsShell ?? 'cmd') : POSIX_STAGE0);
    const ended = (code: number | null): SshConnectError => endedFailure(code, sshStderr(), signal.aborted, state, failure);
    const result = await whileAttempting(child, runStage(child, stage1, options, failure, ended, proven, log));
    bridged = true;
    registration.dispose();
    return {
      stream: result.stream,
      platform,
      probe: result.probe,
      stderrTail: () => stderr.text(),
      dispose: () => child.kill(),
    };
  } finally {
    remembered?.end();
    if (!bridged) registration?.dispose();
  }
}

interface StageResult {
  readonly stream: Duplex;
  readonly probe: ProbeReport;
}

/** A started bridge's stdout and stdin as one Duplex; ending it ends the bridge and leaves the daemon running. */
function bridgeDuplex(child: LaunchedProcess): { readonly stream: Duplex; readonly ended: () => void } {
  let ended = false;
  const stream = new Duplex({
    read: () => undefined,
    write: (chunk: Buffer, _encoding, callback) => {
      child.write(chunk).then(() => callback(), callback);
    },
    writev: (chunks, callback) => {
      child.write(Buffer.concat(chunks.map(({ chunk }) => chunk as Buffer))).then(() => callback(), callback);
    },
    final: (callback) => {
      child.end();
      callback();
    },
    destroy: (err, callback) => {
      if (!ended) child.kill();
      callback(err);
    },
  });
  return { stream, ended: () => { ended = true; } };
}

function runStage(
  child: LaunchedProcess,
  stage1: string,
  options: SshTransportOptions,
  failure: Failure,
  ended: (code: number | null) => SshConnectError,
  authenticated: () => void,
  log: (line: string) => void,
): Promise<StageResult> {
  const { hooks } = options;
  return new Promise<StageResult>((resolve, reject) => {
    let settled = false;
    const notices: HostNotice[] = [];
    let target: ServerTarget | undefined;
    let installDir: string | undefined;
    let bridge: ReturnType<typeof bridgeDuplex> | undefined;
    let proven = false;
    const output = createStageOutput();
    const fail = (error: SshConnectError): void => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(error);
    };

    const upload = async (): Promise<void> => {
      const pkg = target && options.manifest.packages[target];
      if (!target || !pkg) throw new StageProtocolError('an upload request before the probe named a packaged target');
      const file = await options.artifacts.packagePath(target);
      const { size } = await fs.stat(file);
      // the stage reads exactly the announced length, and every byte after it is the protocol's
      if (size !== pkg.size) throw new Error(`${file} holds ${size} bytes where the manifest names ${pkg.size}`);
      await child.write(`${pkg.size}\n`);
      let sent = 0;
      for await (const chunk of createReadStream(file, { end: pkg.size - 1 })) {
        await child.write(chunk as Buffer);
        sent += (chunk as Buffer).length;
        hooks.progress(Math.min(1, sent / pkg.size));
      }
    };

    const handle = (message: StageMessage): void => {
      switch (message.kind) {
        case 'step':
          hooks.step(message.step);
          return;
        case 'progress':
          hooks.progress(message.fraction);
          return;
        case 'notice':
          notices.push(message.notice);
          hooks.notice(message.notice);
          return;
        case 'probe':
          target = message.target;
          installDir = message.install;
          return;
        case 'fail':
          fail(failure(message.code, message.params));
          return;
        case 'upload':
          upload().catch((err: unknown) => {
            if (settled) return;
            log(`the upload failed: ${messageOf(err)}`);
            fail(err instanceof StageProtocolError ? failure('bridgeFailed', { reason: 'stageProtocol' }) : failure('downloadAndUploadFailed'));
          });
          return;
        case 'downloadFailed':
          log(`download try ${message.attempt} failed: ${message.reason}`);
          return;
        case 'settled':
          options.installFolderSettled().catch((err: unknown) => log(`recording the settled install folder failed: ${messageOf(err)}`));
          return;
        case 'bridge':
          return;
      }
    };

    child.onData('stdout', (chunk) => {
      if (bridge) {
        bridge.stream.push(chunk);
        return;
      }
      if (settled) return;
      try {
        if (!proven) {
          proven = true;
          authenticated();
        }
        const { lines, rest, error } = output.push(chunk);
        for (const { text, message } of lines) {
          if (message) handle(message);
          else if (text.trim() !== '') log(`target output: ${text.slice(0, MAX_LOG_LINE_CHARS)}`);
          if (settled) return;
        }
        if (error) throw error;
        if (rest === undefined) return;
        if (!target || installDir === undefined) throw new StageProtocolError('the bridge started before the probe reported');
        bridge = bridgeDuplex(child);
        if (rest.length > 0) bridge.stream.push(rest);
        settled = true;
        resolve({ stream: bridge.stream, probe: { target, installDir, notices } });
      } catch (err) {
        if (err instanceof StageProtocolError) {
          log(err.message);
          fail(failure('bridgeFailed', { reason: 'stageProtocol' }));
          return;
        }
        log(`reading stage 1's output failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        fail(failure('unknown', { reason: 'stageOutput' }));
      }
    });
    child.exited.then((exit) => {
      if (bridge) {
        bridge.ended();
        log(`ssh exited with code ${String(exit.code)}`);
      }
    }, () => bridge?.ended());
    child.closed.then(() => {
      if (bridge) {
        const { stream } = bridge;
        // destroy() drops what the reader has not taken yet, so the stream goes once its end was read
        stream.once('end', () => stream.destroy());
        stream.push(null);
        return;
      }
      // closed resolves only after exited did
      void child.exited.then((exit) => fail(ended(exit.code)));
    }, (err: unknown) => {
      if (bridge) bridge.stream.destroy(err instanceof Error ? err : new Error(String(err)));
      else fail(failure('unknown', { reason: 'spawn' }));
    });
    child.write(stage1Frame(stage1)).catch((err: unknown) => log(`writing stage 1 failed: ${messageOf(err)}`));
  });
}

export interface SshStageOptions {
  readonly hostLabel: string;
  readonly destination: SshDestination;
  // the host's platform, known from its connection
  readonly platform: CachedPlatform;
  readonly identityFile?: string;
  readonly sshConfigFile?: string;
  readonly controlMaster?: ControlMasterPlan;
  // the host's remembered answers, only while its Remember password setting is on: the hops a connect signs in to
  readonly remembered?: RememberedOption;
  readonly askpass: AskpassServer;
  readonly prompt: SshAttemptHooks['prompt'];
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
}

/**
 * A fixed script run over ssh as stage 0 runs stage 1 (the removal stage): stage 0 as the remote command and the script on
 * its stdin. Resolves the remote exit code and every `@@DAMOCLES` line the script printed; rejects with SshConnectError when
 * ssh itself failed.
 */
export async function runSshStage(options: SshStageOptions, script: string, deps: SshTransportDeps = defaultDeps): Promise<{ readonly code: number | null; readonly lines: readonly string[] }> {
  const { log, signal } = options;
  const stderr = createTail(MAX_STDERR_TAIL_CHARS);
  const state: AttemptPromptState = { hostKeyRefused: false, cancelled: false };
  const failure: Failure = (code, params = {}) => new SshConnectError(code, params, stderr.text());
  if (signal.aborted) throw failure('cancelled');
  const ssh = await deps.resolveSsh();
  if (ssh === undefined) throw failure('unknown', { reason: 'sshMissing' });
  let registration: AskpassRegistration | undefined;
  let remembered: RememberedAttempt | undefined;
  try {
    const version = await sshVersionOrFail(ssh, deps.run, log, failure);
    remembered = attemptMemory({ ssh, version, destination: options.destination, ...(options.sshConfigFile !== undefined ? { sshConfigFile: options.sshConfigFile } : {}), ...(options.remembered ? { remembered: options.remembered } : {}), signal, run: deps.run, userInfo: deps.userInfo, log });
    registration = await registerOrFail(options.askpass, `ssh ${options.hostLabel}`, attemptPrompt(options.prompt, state, log, remembered), log, failure);
    const env = sshCallEnv(deps.env, registration.env, version);
    // an abort during an await before this reached no listener, so it stops the stage here
    if (signal.aborted) throw failure('cancelled');
    const { child, sshStderr } = launchSsh(deps, ssh, env, {
      destination: options.destination,
      forwardAgent: false,
      ...(options.identityFile !== undefined ? { identityFile: sshPercentLiteral(options.identityFile) } : {}),
      command: options.platform.os === 'win32' ? windowsStage0(options.platform.windowsShell ?? 'cmd') : POSIX_STAGE0,
      ...(options.sshConfigFile !== undefined ? { configFile: options.sshConfigFile } : {}),
      ...(options.controlMaster !== undefined ? { controlMaster: options.controlMaster } : {}),
    }, stderr, log, failure);
    const abort = (): void => child.kill();
    signal.addEventListener('abort', abort, { once: true });
    const decoder = new StringDecoder('utf8');
    let pending = '';
    // past MAX_LOG_LINE_CHARS a line keeps its head, where a marker is, and the rest up to its end is dropped
    let overlong = false;
    const lines: string[] = [];
    let proven = false;
    child.onData('stdout', (chunk) => {
      // the remote command's first output proves ssh signed in
      if (!proven) {
        proven = true;
        remembered?.authenticated();
      }
      let text = decoder.write(chunk);
      if (overlong) {
        const end = text.indexOf('\n');
        if (end < 0) return;
        overlong = false;
        text = text.slice(end);
      }
      pending += text;
      const complete = pending.split('\n');
      pending = complete.pop() ?? '';
      // a login script may print before the stage; only marked lines are the stage's
      for (const line of complete) {
        const at = line.indexOf(STAGE_LINE_MARKER);
        if (at >= 0 && lines.length < MAX_STAGE_LINES) lines.push(line.slice(at + STAGE_LINE_MARKER.length).replace(/\r$/, '').slice(0, MAX_LOG_LINE_CHARS));
        else if (line.trim() !== '') log(`stage output: ${line.slice(0, MAX_LOG_LINE_CHARS)}`);
      }
      if (pending.length > MAX_LOG_LINE_CHARS) {
        pending = pending.slice(0, MAX_LOG_LINE_CHARS);
        overlong = true;
      }
    });
    // an ssh that ended before reading the script reports through its exit
    child.write(stage1Frame(script)).catch((err: unknown) => log(`writing the stage failed: ${messageOf(err)}`));
    const exit = await exitOf(child, log, failure).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted || state.cancelled || state.hostKeyRefused || exit.code === SSH_ERROR_EXIT) throw endedFailure(exit.code, sshStderr(), signal.aborted, state, failure);
    return { code: exit.code, lines };
  } finally {
    remembered?.end();
    registration?.dispose();
  }
}
