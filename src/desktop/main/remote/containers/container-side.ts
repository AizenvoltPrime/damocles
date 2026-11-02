// Where a container's engine and the devcontainer CLI run: this computer, through main's launcher, or an SSH host, through its
// daemon's containers.* control requests. Both build their argv from container-commands.ts.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runProcess, type Launcher } from '../../../../core/process-launcher';
import { findOnAbsolutePathAsync } from '../../../../core/system-tools';
import type { StreamChannel } from '../../../../remote/mux';
import { copyPackageArgs, dataOwnerArgs, DEVCONTAINER_CONFIGS, devcontainerReadArgs, devcontainerUpArgs, execStageArgs, inspectArgs, PS_ARGS } from '../../../daemon/container-commands';
import type { ContainerEngine } from '../../../daemon/container-values';
import type { ContainerCliResult, ContainerEngineResult } from '../../../daemon/control-messages';
import { hostEnvironment } from '../../../local-services/host-environment';
import type { ArtifactCache } from '../artifact-cache';
import type { RemoteConnection } from '../connection';
import type { ServerManifest, ServerTarget } from '../server-manifest-format';
import { SshConnectError, type StageProcess } from '../ssh/ssh-transport';
import { releaseAssetUrl } from '../artifact-cache';

// the launcher closes the CLI's output this long after it exited, though the `docker run -a` it started still holds it
const EXIT_OUTPUT_IDLE_MS = 2000;
// a list, an inspect or a cp that takes longer is cut off
const ENGINE_TIMEOUT_MS = 120_000;

export interface CliTarget {
  readonly engine: ContainerEngine;
  readonly workspaceFolder: string;
  readonly configPath: string;
}

export type CopyResult = 'copied' | 'notCopied' | 'engineMissing';

export interface ContainerSide {
  // the SSH host the engine runs on; undefined for this computer
  readonly via: string | undefined;
  config(folder: string): Promise<string | null>;
  // stderr chunks reach onStderr as they come; the signal kills the CLI
  // dataKey: the container key whose data volume the container mounts
  up(target: CliTarget, dataKey: string, removeExisting: boolean, onStderr: (text: string) => void, signal: AbortSignal): Promise<ContainerCliResult>;
  // the data volume's folder given to the remote user
  prepareData(engine: ContainerEngine, containerId: string, user: string): Promise<ContainerEngineResult>;
  // the signal kills the CLI, as up's does
  readConfiguration(target: CliTarget, onStderr: (text: string) => void, signal: AbortSignal): Promise<ContainerCliResult>;
  list(engine: ContainerEngine): Promise<ContainerEngineResult>;
  inspect(engine: ContainerEngine, ids: readonly string[]): Promise<ContainerEngineResult>;
  exec(engine: ContainerEngine, containerId: string, user: string): Promise<StageProcess | 'engineMissing'>;
  copyPackage(engine: ContainerEngine, containerId: string, folder: string, target: ServerTarget): Promise<CopyResult>;
}

/** A fresh read-configuration id: matches no container (container-commands.ts devcontainerReadArgs). */
export const trustReadId = (): string => randomBytes(16).toString('hex');

export interface LocalSideDeps {
  readonly launcher: () => Launcher;
  // the login environment main merged at startup
  readonly env: NodeJS.ProcessEnv;
  // the app's binary, run as Node, and the CLI's entry under app.asar.unpacked
  readonly execPath: string;
  readonly cliPath: string;
  readonly artifacts: () => Promise<ArtifactCache>;
  readonly platform?: NodeJS.Platform;
}

/** The engine on an absolute PATH folder of the login environment, never a bare name. */
export function findLocalEngine(engine: ContainerEngine, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  return findOnAbsolutePathAsync(platform === 'win32' ? `${engine}.exe` : engine, platform, env);
}

/** The CLI's environment: the login environment with the app's binary as Node, reading no file inside an asar archive as one. */
export function cliEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  // Everything the CLI starts (the consented initializeCommand, the engine) inherits both, so an Electron program
  // initializeCommand launches runs as Node; the CLI passes its own environment to its children and has no option to drop them.
  return { ...hostEnvironment(env), ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' };
}

export function localContainerSide(deps: LocalSideDeps): ContainerSide {
  const platform = deps.platform ?? process.platform;
  const engineEnv = hostEnvironment(deps.env);
  const engine = (name: ContainerEngine): Promise<string | undefined> => findLocalEngine(name, deps.env, platform);

  const runCli = async (args: readonly string[], onStderr: (text: string) => void, signal?: AbortSignal): Promise<ContainerCliResult> => {
    const child = deps.launcher().launch({ file: deps.execPath, args: [deps.cliPath, ...args], cwd: os.homedir(), env: cliEnvironment(deps.env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, exitOutputIdleMs: EXIT_OUTPUT_IDLE_MS, detached: process.platform !== 'win32' }, signal ? { signal } : {});
    const stdout: Buffer[] = [];
    child.onData('stdout', (chunk) => stdout.push(chunk));
    child.onData('stderr', (chunk) => onStderr(chunk.toString('utf8')));
    const [exit] = await Promise.all([child.exited, child.closed]);
    return { result: 'ran', code: exit.code, stdout: Buffer.concat(stdout).toString('utf8') };
  };

  const runEngine = async (name: ContainerEngine, args: readonly string[]): Promise<ContainerEngineResult> => {
    const enginePath = await engine(name);
    if (enginePath === undefined) return { result: 'engineMissing' };
    const { exit, stdout, stderr } = await runProcess({ file: enginePath, args: [...args], env: engineEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }, { timeoutMs: ENGINE_TIMEOUT_MS });
    return { result: 'ran', code: exit?.code ?? null, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
  };

  return {
    via: undefined,
    config: async (folder) => {
      for (const parts of DEVCONTAINER_CONFIGS) {
        const candidate = path.join(folder, ...parts);
        if ((await fs.promises.stat(candidate).catch(() => undefined))?.isFile()) return candidate;
      }
      return null;
    },
    up: async (target, dataKey, removeExisting, onStderr, signal) => {
      const enginePath = await engine(target.engine);
      if (enginePath === undefined) return { result: 'engineMissing' };
      return runCli(devcontainerUpArgs({ ...target, enginePath }, dataKey, removeExisting), onStderr, signal);
    },
    prepareData: (name, containerId, user) => runEngine(name, dataOwnerArgs(containerId, user)),
    readConfiguration: async (target, onStderr, signal) => {
      const enginePath = await engine(target.engine);
      if (enginePath === undefined) return { result: 'engineMissing' };
      return runCli(devcontainerReadArgs({ ...target, enginePath }, trustReadId()), onStderr, signal);
    },
    list: (name) => runEngine(name, PS_ARGS),
    inspect: (name, ids) => runEngine(name, inspectArgs(ids)),
    exec: async (name, containerId, user) => {
      const enginePath = await engine(name);
      if (enginePath === undefined) return 'engineMissing';
      return deps.launcher().launch({ file: enginePath, args: execStageArgs(containerId, user), env: engineEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    },
    copyPackage: async (name, containerId, folder, target) => {
      const enginePath = await engine(name);
      if (enginePath === undefined) return 'engineMissing';
      const source = await (await deps.artifacts()).packagePath(target);
      const { exit } = await runProcess({ file: enginePath, args: copyPackageArgs(source, containerId, folder, path.basename(source)), env: engineEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }, { timeoutMs: ENGINE_TIMEOUT_MS });
      return exit?.code === 0 ? 'copied' : 'notCopied';
    },
  };
}

export interface ViaSideDeps {
  readonly hostId: string;
  // this computer's name for the host, which a failure names
  readonly hostName: () => string;
  // the SSH host's connection while it is connected
  readonly connection: () => RemoteConnection | undefined;
  readonly manifest: () => Promise<{ readonly manifest: ServerManifest; readonly releasesUrl: string }>;
}

/** A client-opened stream as a stage 0 process: its data is stdout, writing waits for the window, and its end is the exit. */
export function streamProcess(stream: StreamChannel): StageProcess {
  const ended = new Promise<void>((resolve) => stream.onEnd(resolve));
  return {
    onData: (kind, listener) => {
      if (kind === 'stdout') stream.onData((bytes) => listener(Buffer.from(bytes)));
    },
    write: async (chunk) => {
      if (stream.closed) throw new Error('The exec stream is closed');
      if (stream.write(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)) return;
      await new Promise<void>((resolve) => {
        const drained = stream.onDrain(() => {
          drained.dispose();
          resolve();
        });
      });
    },
    end: (chunk) => {
      if (chunk !== undefined) stream.write(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
      stream.end();
    },
    kill: () => stream.end(),
    exited: ended.then(() => ({ code: null, signal: null })),
    closed: ended,
  };
}


export function viaContainerSide(deps: ViaSideDeps): ContainerSide {
  const connected = (): RemoteConnection => {
    const connection = deps.connection();
    if (!connection) throw new SshConnectError('viaNotConnected', { host: deps.hostName() }, '');
    if (!connection.features.includes(CONTAINERS_FEATURE)) throw new SshConnectError('containerFeatureMissing', { host: deps.hostName() }, '');
    return connection;
  };
  // the CLI's stderr arrives on a stream this side opened and named in the request; ending it early ends the CLI on the host
  const withStderr = async (connection: RemoteConnection, onStderr: (text: string) => void, request: (stream: number) => Promise<ContainerCliResult>, signal?: AbortSignal): Promise<ContainerCliResult> => {
    const stream = connection.openStream();
    const decoder = new TextDecoder();
    stream.onData((bytes) => onStderr(decoder.decode(bytes, { stream: true })));
    const abort = (): void => stream.end();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) stream.end();
    try {
      return await request(stream.id);
    } finally {
      signal?.removeEventListener('abort', abort);
      stream.end();
    }
  };
  return {
    via: deps.hostId,
    config: async (folder) => (await connected().control.request('containers.config', { folder })).configPath,
    up: async (target, dataKey, removeExisting, onStderr, signal) => {
      const connection = connected();
      return withStderr(connection, onStderr, (stream) => connection.control.request('containers.up', { ...target, dataKey, removeExisting, stream }), signal);
    },
    prepareData: async (engine, containerId, user) => connected().control.request('containers.prepareData', { engine, containerId, user }),
    readConfiguration: async (target, onStderr, signal) => {
      const connection = connected();
      return withStderr(connection, onStderr, (stream) => connection.control.request('containers.readConfiguration', { ...target, trustReadId: trustReadId(), stream }), signal);
    },
    list: async (engine) => connected().control.request('containers.list', { engine }),
    inspect: async (engine, ids) => connected().control.request('containers.inspect', { engine, ids: [...ids] }),
    exec: async (engine, containerId, user) => {
      const connection = connected();
      const stream = connection.openStream();
      const answer = await connection.control.request('containers.exec', { engine, containerId, user, stream: stream.id }).catch((err: unknown) => {
        stream.end();
        throw err;
      });
      if (answer.result === 'engineMissing') {
        stream.end();
        return 'engineMissing';
      }
      return streamProcess(stream);
    },
    copyPackage: async (engine, containerId, folder, target) => {
      const connection = connected();
      const { manifest, releasesUrl } = await deps.manifest();
      const pkg = manifest.packages[target];
      if (!pkg) return 'notCopied';
      const { result } = await connection.control.request('containers.copyPackage', { engine, containerId, folder, file: pkg.file, sha256: pkg.sha256, size: pkg.size, url: releaseAssetUrl(releasesUrl, manifest.version, pkg.file) });
      return result;
    },
  };
}

// The daemon carries Dev Containers (control containers.*).
export const CONTAINERS_FEATURE = 'containers';
