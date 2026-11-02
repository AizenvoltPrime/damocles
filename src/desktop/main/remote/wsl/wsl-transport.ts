// The WSL transport: `wsl.exe -d <distro> --exec /bin/sh -c <stage 0>` through main's launcher with streaming stdio, stage 1 on
// its stdin, and stage 1's status lines until the bridge hands stdout to the protocol. There is no askpass and no host key:
// wsl.exe runs the distro's default user. The package comes from the app's cache through its wslpath (stage1-posix.sh).
import type { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { processLauncher, type LaunchedProcess, type Launcher } from '../../../../core/process-launcher';
import { windowsSystemTool } from '../../../../core/system-tools';
import type { CachedPlatform } from '../../../preload/overlay-channels';
import type { ArtifactCache } from '../artifact-cache';
import type { ServerManifest } from '../server-manifest-format';
import { buildPosixStage1, isWslMappableFolder, validateInstallFolder } from '../bootstrap/stage1';
import { POSIX_STAGE0_SCRIPT } from '../bootstrap/stage0';
import { createTail, runStage, SshConnectError, type Failure, type ProbeReport, type SshAttemptHooks } from '../ssh/ssh-transport';
import { isWslDistroName } from './distro-name';
import { decodeWslOutput, isUtf16leMessage, wslExeEnvironment } from './wsl-list';

// what the distro list says of one distro now; listFailed: wsl.exe did not answer the list
export type DistroListing = 'listed' | 'notListed' | 'listFailed';

const MAX_STDERR_TAIL_CHARS = 16 * 1024;
const MAX_LOG_LINE_CHARS = 2000;

export interface WslTransportOptions {
  readonly distro: string;
  // whether wsl.exe lists the distro now; one it does not list, or a list that failed, starts nothing
  readonly listed: () => Promise<DistroListing>;
  // absent: the default ~/.damocles/server
  readonly installFolder?: string;
  // null: the default folder; absent: nothing to clean
  readonly previousInstallFolder?: string | null;
  // aborting before the connect resolves kills wsl.exe and rejects with cancelled
  readonly signal: AbortSignal;
  // a wsl attempt reports connecting, then stage 1's steps; it never prompts
  readonly hooks: Pick<SshAttemptHooks, 'step' | 'progress' | 'notice'>;
  installFolderSettled(): Promise<void>;
  readonly manifest: ServerManifest;
  readonly releasesUrl: string;
  readonly artifacts: ArtifactCache;
  readonly log: (line: string) => void;
}

export interface WslTransportDeps {
  readonly launcher: () => Launcher;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const defaultDeps: WslTransportDeps = { launcher: processLauncher, env: process.env };

export interface WslTransportResult {
  readonly stream: Duplex;
  readonly platform: CachedPlatform;
  readonly probe: ProbeReport;
  stderrTail(): string;
  // kills wsl.exe if it still runs; the daemon, detached under WSL's init, and its runs keep running
  dispose(): void;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** wsl.exe's arguments: the distro, the home folder as the working folder, and stage 0 run by /bin/sh with no login shell. */
export function wslStageArgs(distro: string): string[] {
  if (!isWslDistroName(distro)) throw new RangeError('Not a WSL distro name');
  return ['-d', distro, '--cd', '~', '--exec', '/bin/sh', '-c', POSIX_STAGE0_SCRIPT];
}

function failureFor(code: number | null, aborted: boolean, failure: Failure): SshConnectError {
  if (aborted) return failure('cancelled');
  // a Windows exit code is a DWORD; wsl.exe's own failure, -1, arrives as 4294967295
  return failure('unknown', { reason: 'wslExited', exitCode: (code ?? -1) | 0 });
}

/** wsl.exe's stderr as text: the distro's UTF-8, streamed, and wsl.exe's own messages, UTF-16LE from an inbox wsl.exe. */
export function wslStderrDecoder(): { write(chunk: Buffer): string; end(): string } {
  const utf8 = new StringDecoder('utf8');
  return {
    write: (chunk) => (isUtf16leMessage(chunk) ? decodeWslOutput(chunk) : utf8.write(chunk).replaceAll('\0', '')),
    end: () => utf8.end(),
  };
}

/** Starts stage 0 in the distro, runs the probe and the install, and resolves once the bridge authenticated to the daemon. */
export async function startWslTransport(options: WslTransportOptions, deps: WslTransportDeps = defaultDeps): Promise<WslTransportResult> {
  const { hooks, log, signal } = options;
  const args = wslStageArgs(options.distro);
  const stderr = createTail(MAX_STDERR_TAIL_CHARS);
  const failure: Failure = (code, params = {}) => new SshConnectError(code, params, stderr.text());
  if (signal.aborted) throw failure('cancelled');
  for (const folder of [options.installFolder, options.previousInstallFolder]) {
    if (typeof folder !== 'string') continue;
    const check = validateInstallFolder(folder);
    if (!check.ok) throw failure('installFolderInvalid', { reason: check.reason });
  }
  const listing = await options.listed();
  if (listing === 'listFailed') throw failure('unknown', { reason: 'wslList' });
  if (listing === 'notListed') throw failure('distroNotListed', { distro: options.distro });
  if (signal.aborted) throw failure('cancelled');
  hooks.step('connecting');
  const cacheFolder = options.artifacts.packageFolder();
  // without a cache to copy from the stage downloads, then asks for the upload, as on SSH
  if (!isWslMappableFolder(cacheFolder)) log(`the package cache ${cacheFolder} is no drive path wslpath maps; the stage downloads or uploads the package`);
  const stage1 = buildPosixStage1({
    manifest: options.manifest,
    releasesUrl: options.releasesUrl,
    ...(options.installFolder !== undefined ? { installFolder: options.installFolder } : {}),
    ...(options.previousInstallFolder !== undefined ? { previousInstallFolder: options.previousInstallFolder } : {}),
    ...(isWslMappableFolder(cacheFolder) ? { wslCacheFolder: cacheFolder } : {}),
  });
  let child: LaunchedProcess;
  try {
    // WSL_UTF8 makes wsl.exe's own messages UTF-8; the distro's bytes pass through as they are
    child = deps.launcher().launch({ file: windowsSystemTool('wsl', deps.env), args, env: { ...wslExeEnvironment(deps.env), WSL_UTF8: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (err) {
    log(`wsl.exe did not start: ${messageOf(err)}`);
    throw failure('unknown', { reason: 'spawn' });
  }
  const decoder = wslStderrDecoder();
  let partial = '';
  const logLine = (line: string): void => {
    if (line.trim() !== '') log(line.slice(0, MAX_LOG_LINE_CHARS));
  };
  const take = (text: string): void => {
    stderr.append(text);
    const lines = (partial + text).split(/\r?\n/);
    partial = lines.pop()!.slice(0, MAX_LOG_LINE_CHARS);
    lines.forEach(logLine);
  };
  child.onData('stderr', (chunk) => take(decoder.write(chunk)));
  child.closed.then(() => {
    take(decoder.end());
    logLine(partial);
  }, () => undefined);
  const abort = (): void => child.kill();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const result = await runStage(child, stage1, { ...options, cache: 'artifactFolder' }, failure, (code) => failureFor(code, signal.aborted, failure), () => undefined, log);
    if (signal.aborted) {
      result.stream.destroy();
      throw failure('cancelled');
    }
    return { stream: result.stream, platform: { os: 'linux' }, probe: result.probe, stderrTail: () => stderr.text(), dispose: () => child.kill() };
  } catch (err) {
    if (signal.aborted && !(err instanceof SshConnectError && err.code === 'cancelled')) throw failure('cancelled');
    throw err;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
