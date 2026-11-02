// The container transport: `<engine> exec -i -u <user> <id> /bin/sh -c <stage 0>` on this computer through main's launcher, or
// through an SSH host's containers.exec stream, then runStage as for SSH and WSL. The package comes from the client's artifact
// cache or the SSH host's package cache by the engine's cp into a private folder the stage makes; stage 1 checks its hash, and
// its probe names the target, so an Alpine image gets the musl package.
import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { CONTAINER_DATA_FOLDER } from '../../../daemon/container-commands';
import type { ContainerEngine } from '../../../daemon/container-values';
import type { ArtifactCache } from '../artifact-cache';
import { buildPosixStage1, validateInstallFolder } from '../bootstrap/stage1';
import type { ServerManifest, ServerTarget } from '../server-manifest-format';
import { createTail, runStage, SshConnectError, type Failure, type ProbeReport, type SshAttemptHooks } from '../ssh/ssh-transport';
import type { ContainerSide } from './container-side';

const MAX_STDERR_TAIL_CHARS = 16 * 1024;
const MAX_LOG_LINE_CHARS = 2000;

export interface ContainerTransportOptions {
  readonly side: ContainerSide;
  readonly engine: ContainerEngine;
  readonly containerId: string;
  readonly user: string;
  // a devcontainer: the remote user's ~/.damocles is its data volume's folder
  readonly dataFolder: boolean;
  readonly installFolder?: string;
  readonly previousInstallFolder?: string | null;
  // aborting before the connect resolves ends the exec and rejects with cancelled
  readonly signal: AbortSignal;
  readonly hooks: Pick<SshAttemptHooks, 'step' | 'progress' | 'notice'>;
  installFolderSettled(): Promise<void>;
  readonly manifest: ServerManifest;
  readonly releasesUrl: string;
  readonly artifacts: ArtifactCache;
  readonly log: (line: string) => void;
}

export interface ContainerTransportResult {
  readonly stream: Duplex;
  readonly probe: ProbeReport;
  stderrTail(): string;
  // ends the exec if it still runs; the daemon, detached inside the container, and its runs keep running
  dispose(): void;
}

/** A fresh private folder name in the container's /tmp, which the stage creates mode 0700 and deletes after the copy. */
export const containerCacheFolder = (): string => `/tmp/damocles-cache-${randomBytes(12).toString('hex')}`;

/** Starts stage 0 in the container, runs the probe and the install, and resolves once the bridge authenticated to the daemon. */
export async function startContainerTransport(options: ContainerTransportOptions): Promise<ContainerTransportResult> {
  const { hooks, log, signal, side } = options;
  const stderr = createTail(MAX_STDERR_TAIL_CHARS);
  const failure: Failure = (code, params = {}) => new SshConnectError(code, params, stderr.text());
  if (signal.aborted) throw failure('cancelled');
  for (const folder of [options.installFolder, options.previousInstallFolder]) {
    if (typeof folder !== 'string') continue;
    const check = validateInstallFolder(folder);
    if (!check.ok) throw failure('installFolderInvalid', { reason: check.reason });
  }
  hooks.step('connecting');
  const cacheFolder = containerCacheFolder();
  const stage1 = buildPosixStage1({
    manifest: options.manifest,
    releasesUrl: options.releasesUrl,
    ...(options.installFolder !== undefined ? { installFolder: options.installFolder } : {}),
    ...(options.previousInstallFolder !== undefined ? { previousInstallFolder: options.previousInstallFolder } : {}),
    containerCacheFolder: cacheFolder,
    ...(options.dataFolder ? { containerDataFolder: CONTAINER_DATA_FOLDER } : {}),
  });
  const child = await side.exec(options.engine, options.containerId, options.user);
  if (child === 'engineMissing') throw failure('containerEngineMissing', { engine: options.engine });
  // a listener added to a signal that already aborted never runs
  if (signal.aborted) {
    child.kill();
    throw failure('cancelled');
  }
  const decoder = new StringDecoder('utf8');
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
  const fillCache = async (target: ServerTarget): Promise<boolean> => {
    const copied = await side.copyPackage(options.engine, options.containerId, cacheFolder, target);
    log(copied === 'copied' ? `copied the ${target} package into the container` : `copying the ${target} package into the container: ${copied}; the stage asks for the upload`);
    return copied === 'copied';
  };
  try {
    const exited = (code: number | null): SshConnectError => (signal.aborted ? failure('cancelled') : failure('unknown', { reason: 'execExited', exitCode: code ?? -1 }));
    const result = await runStage(child, stage1, { ...options, cache: fillCache }, failure, exited, () => undefined, log);
    if (signal.aborted) {
      result.stream.destroy();
      throw failure('cancelled');
    }
    return { stream: result.stream, probe: result.probe, stderrTail: () => stderr.text(), dispose: () => child.kill() };
  } catch (err) {
    if (signal.aborted && !(err instanceof SshConnectError && err.code === 'cancelled')) throw failure('cancelled');
    throw err;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
