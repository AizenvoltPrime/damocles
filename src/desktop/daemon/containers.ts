// Dev Containers on this host for a client whose containers run here: the devcontainer CLI under the package's own Node, the
// engine (docker or podman, found on an absolute PATH folder of the login environment) on the daemon's launcher, stage 0 under
// `exec` over a client-opened stream, and the package copied in from this host's package cache. Every argv comes from
// container-commands.ts; nothing runs through a shell.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { processLauncher, runProcess, type LaunchedProcess } from '../../core/process-launcher';
import { findOnAbsolutePathAsync } from '../../core/system-tools';
import type { StreamChannel } from '../../remote/mux';
import { daemonChildEnv } from './child-env';
import { copyPackageArgs, dataOwnerArgs, DEVCONTAINER_CONFIGS, devcontainersCliEntry, devcontainerReadArgs, devcontainerUpArgs, execStageArgs, inspectArgs, PS_ARGS } from './container-commands';
import type { ContainerEngine } from './container-values';
import { MAX_CONTAINER_OUTPUT_CHARS, type ContainerCliResult, type ContainerEngineResult } from './control-messages';
import type { ControlConnection, ControlService } from './connections';

// the launcher closes a command's output this long after it exited, though a child it started (the CLI's `docker run -a`)
// still holds it
const EXIT_OUTPUT_IDLE_MS = 2000;
// a list, an inspect or a cp that takes longer is cut off
const ENGINE_TIMEOUT_MS = 120_000;
// a package download that takes longer leaves the copy to the upload
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
// a cached package file: readable by a container user of another uid after docker cp, which keeps the mode
const CACHED_PACKAGE_MODE = 0o644;
// stdin bytes in flight to exec before the stream pauses
const MAX_PENDING_STDIN_BYTES = 1024 * 1024;

export type ContainersService = Pick<ControlService, 'containers.config' | 'containers.up' | 'containers.prepareData' | 'containers.readConfiguration' | 'containers.list' | 'containers.inspect' | 'containers.exec' | 'containers.copyPackage'>;

export interface ContainersDeps {
  // the package root: the CLI is node_modules/@devcontainers/cli/devcontainer.js under it
  readonly root: string;
  // this host's package cache; the install folder's package-cache
  readonly cacheFolder: string;
  readonly fetch?: typeof fetch;
  readonly log: (line: string) => void;
}

const bounded = (text: string): string => (text.length > MAX_CONTAINER_OUTPUT_CHARS ? text.slice(-MAX_CONTAINER_OUTPUT_CHARS) : text);

/** The engine's absolute path on an absolute PATH folder of the daemon's login environment; undefined when there is none. */
export function findEngine(engine: ContainerEngine, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = daemonChildEnv('user')): Promise<string | undefined> {
  return findOnAbsolutePathAsync(platform === 'win32' ? `${engine}.exe` : engine, platform, env);
}

function claimed(connection: ControlConnection, id: number): StreamChannel {
  const stream = connection.claimStream(id);
  if (!stream) throw new Error(`Stream ${id} is not open on ${connection.id}`);
  return stream;
}

/** The first devcontainer configuration of folder in the CLI's own order, or null. */
export async function configOf(folder: string): Promise<string | null> {
  for (const parts of DEVCONTAINER_CONFIGS) {
    const candidate = path.join(folder, ...parts);
    if ((await fs.stat(candidate).catch(() => undefined))?.isFile()) return candidate;
  }
  return null;
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * The package file in this host's cache: a cached file that passes its size and hash, else one downloaded and checked again;
 * undefined when none could be had. The folder stays private and the file CACHED_PACKAGE_MODE.
 */
export async function cachedPackage(deps: Pick<ContainersDeps, 'cacheFolder' | 'fetch' | 'log'>, pkg: { readonly file: string; readonly sha256: string; readonly size: number; readonly url: string }): Promise<string | undefined> {
  const { file, sha256, size, url } = pkg;
  const target = path.join(deps.cacheFolder, file);
  const stat = await fs.stat(target).catch(() => undefined);
  if (stat?.isFile() && stat.size === size && (await sha256Of(target)) === sha256) {
    await fs.chmod(target, CACHED_PACKAGE_MODE);
    return target;
  }
  await fs.mkdir(deps.cacheFolder, { recursive: true, mode: 0o700 });
  const partial = path.join(deps.cacheFolder, `.${file}.${randomBytes(6).toString('hex')}.partial`);
  try {
    const response = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { mode: CACHED_PACKAGE_MODE }));
    const { size: got } = await fs.stat(partial);
    if (got !== size || (await sha256Of(partial)) !== sha256) throw new Error(`the download of ${file} is not the package the manifest names`);
    // the umask may have narrowed the mode the write asked for
    await fs.chmod(partial, CACHED_PACKAGE_MODE);
    await fs.rename(partial, target);
    return target;
  } catch (err) {
    deps.log(`[containers] downloading ${file} into the package cache failed: ${err instanceof Error ? err.message : String(err)}`);
    await fs.rm(partial, { force: true });
    return undefined;
  }
}

export function createContainersService(deps: ContainersDeps): ContainersService {
  const { log } = deps;
  const cli = devcontainersCliEntry(deps.root);

  // The CLI with stderr on the stream as it comes; the stream ends with the CLI, and a client that ends it first (Cancel, a
  // lost connection) ends the CLI, so nothing it would still run runs after the user cancelled.
  const runCli = (args: readonly string[], stream: StreamChannel): Promise<ContainerCliResult> => runCliOn(processLauncher().launch({ file: process.execPath, args: [cli, ...args], cwd: os.homedir(), env: daemonChildEnv('node'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, exitOutputIdleMs: EXIT_OUTPUT_IDLE_MS, detached: process.platform !== 'win32' }), stream, log);

  const runEngine = async (engine: ContainerEngine, args: readonly string[]): Promise<ContainerEngineResult> => {
    const enginePath = await findEngine(engine);
    if (enginePath === undefined) return { result: 'engineMissing' };
    const { exit, stdout, stderr } = await runProcess({ file: enginePath, args: [...args], env: daemonChildEnv('user'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }, { timeoutMs: ENGINE_TIMEOUT_MS });
    return { result: 'ran', code: exit?.code ?? null, stdout: bounded(stdout.toString('utf8')), stderr: bounded(stderr.toString('utf8')) };
  };

  const cached = (file: string, sha256: string, size: number, url: string): Promise<string | undefined> => cachedPackage(deps, { file, sha256, size, url });

  return {
    'containers.config': async ({ folder }) => ({ configPath: await configOf(folder) }),
    'containers.up': async ({ engine, workspaceFolder, configPath, dataKey, removeExisting, stream: id }, connection) => {
      const stream = claimed(connection, id);
      const enginePath = await findEngine(engine);
      if (enginePath === undefined) {
        stream.end();
        return { result: 'engineMissing' };
      }
      log(`[containers] devcontainer up for ${workspaceFolder}${removeExisting ? ', removing the existing container' : ''}`);
      return runCli(devcontainerUpArgs({ workspaceFolder, configPath, enginePath }, dataKey, removeExisting), stream);
    },
    'containers.prepareData': ({ engine, containerId, user }) => runEngine(engine, dataOwnerArgs(containerId, user)),
    'containers.readConfiguration': async ({ engine, workspaceFolder, configPath, trustReadId, stream: id }, connection) => {
      const stream = claimed(connection, id);
      const enginePath = await findEngine(engine);
      if (enginePath === undefined) {
        stream.end();
        return { result: 'engineMissing' };
      }
      return runCli(devcontainerReadArgs({ workspaceFolder, configPath, enginePath }, trustReadId), stream);
    },
    'containers.list': ({ engine }) => runEngine(engine, PS_ARGS),
    'containers.inspect': ({ engine, ids }) => runEngine(engine, inspectArgs(ids)),
    'containers.exec': async ({ engine, containerId, user, stream: id }, connection) => {
      const stream = claimed(connection, id);
      const enginePath = await findEngine(engine);
      if (enginePath === undefined) {
        stream.end();
        return { result: 'engineMissing' };
      }
      const child = processLauncher().launch({ file: enginePath, args: execStageArgs(containerId, user), env: daemonChildEnv('user'), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      pipeExec(child, stream, (line) => log(`[containers] exec ${containerId.slice(0, 12)}: ${line}`));
      return { result: 'started' };
    },
    'containers.copyPackage': async ({ engine, containerId, folder, file, sha256, size, url }) => {
      const enginePath = await findEngine(engine);
      if (enginePath === undefined) return { result: 'engineMissing' };
      const source = await cached(file, sha256, size, url);
      if (source === undefined) return { result: 'notCopied' };
      const { exit, stderr } = await runProcess({ file: enginePath, args: copyPackageArgs(source, containerId, folder, file), env: daemonChildEnv('user'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }, { timeoutMs: ENGINE_TIMEOUT_MS });
      if (exit?.code === 0) return { result: 'copied' };
      log(`[containers] ${engine} cp of ${file} failed (${String(exit?.code)}): ${stderr.toString('utf8').trim().slice(0, 500)}`);
      return { result: 'notCopied' };
    },
  };
}

/**
 * A started CLI's stdout collected and its stderr on the stream until it closes; the stream ending first kills its tree. The
 * launcher cannot pause the CLI, so stderr that arrives while the stream is over its window is dropped, never queued past
 * it: the client keeps only the build log's last lines.
 */
export async function runCliOn(child: LaunchedProcess, stream: StreamChannel, log: (line: string) => void): Promise<ContainerCliResult> {
  let done = false;
  let blocked = false;
  let dropped = 0;
  const stdout: Buffer[] = [];
  child.onData('stdout', (chunk) => stdout.push(chunk));
  child.onData('stderr', (chunk) => {
    if (blocked) {
      dropped += chunk.length;
      return;
    }
    blocked = !stream.write(chunk);
  });
  const drained = stream.onDrain(() => {
    blocked = false;
  });
  const ended = stream.onEnd(() => {
    if (!done) child.kill({ tree: true });
  });
  try {
    const [exit] = await Promise.all([child.exited, child.closed]);
    return { result: 'ran', code: exit.code, stdout: bounded(Buffer.concat(stdout).toString('utf8')) };
  } finally {
    done = true;
    ended.dispose();
    drained.dispose();
    stream.end();
    if (dropped > 0) log(`[containers] dropped ${dropped} bytes of the devcontainer CLI's log while the client read slower than it wrote`);
  }
}

/**
 * The exec's stdout onto the stream and the stream onto its stdin until either ends: the stream's end closes stdin, the exec's
 * end ends the stream, and the stream pauses while its bytes wait for stdin. The launcher cannot pause stdout, so its bytes
 * queue past the stream's window; docs/invariants.md "Remote connections and credentials" (the container transport) bounds it.
 */
export function pipeExec(child: LaunchedProcess, stream: StreamChannel, log: (line: string) => void): void {
  let pending = 0;
  child.onData('stdout', (chunk) => {
    stream.write(chunk);
  });
  child.onData('stderr', (chunk) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim() !== '') log(line.slice(0, 500));
  });
  stream.onData((bytes) => {
    pending += bytes.length;
    if (pending > MAX_PENDING_STDIN_BYTES) stream.pause();
    child.write(bytes).then(() => {
      pending -= bytes.length;
      if (pending <= MAX_PENDING_STDIN_BYTES) stream.resume();
    }, (err: unknown) => log(`writing to the exec failed: ${err instanceof Error ? err.message : String(err)}`));
  });
  // a lost connection closes the stream: the exec goes with it, and the daemon it started keeps running
  stream.onEnd(() => {
    if (stream.closed) child.kill();
    else child.end();
  });
  child.closed.then(() => stream.end(), () => stream.end());
}
