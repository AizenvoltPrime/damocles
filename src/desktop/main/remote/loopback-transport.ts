import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Duplex } from 'node:stream';
import { renameWithRetry } from '../../../core/config/json-config-write';
import { processLauncher, runProcess, type LaunchedProcess, type SpawnSpec } from '../../../core/process-launcher';
import { posixTool, windowsSystemTool } from '../../../core/system-tools';

// Characters of the bridge's stderr a log line keeps.
const MAX_STDERR_LINE_CHARS = 2000;
// Characters of the archive's sha256 that name its unpacked folder.
const UNPACKED_NAME_CHARS = 16;

export interface LoopbackTransportOptions {
  // this Electron executable, which runs the daemon's bundle as Node
  readonly execPath: string;
  // dist/daemon.js
  readonly daemonScript: string;
  // the daemon's HOME and USERPROFILE: <userData>/loopback-home, so nothing it writes reaches the user's ~/.damocles
  readonly home: string;
  // DAMOCLES_LOOPBACK_PACKAGE: a server package unpacked under unpackRoot, whose own Node runs the bridge and the daemon
  readonly serverPackage?: { readonly archive: string; readonly unpackRoot: string };
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Unpacks `archive` once into `<unpackRoot>/<sha256 prefix>` with the system tar (tar.exe on Windows), staged then renamed. */
export async function unpackServerPackage(archive: string, unpackRoot: string): Promise<string> {
  const dir = path.join(unpackRoot, (await sha256File(archive)).slice(0, UNPACKED_NAME_CHARS));
  const unpacked = (): Promise<boolean> => fs.stat(dir).then(() => true, () => false);
  if (await unpacked()) return dir;
  const tar = process.platform === 'win32' ? windowsSystemTool('tar') : posixTool('tar');
  if (!tar) throw new Error('No tar was found to unpack the server package');
  await fs.mkdir(unpackRoot, { recursive: true });
  // a staging folder of its own, since another app may unpack the same package into the same root at once
  const staging = await fs.mkdtemp(`${dir}.unpacking-`);
  try {
    const output = await runProcess({ file: tar, args: [archive.endsWith('.zip') ? '-xf' : '-xzf', archive, '-C', staging], stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    if (output.exit?.code !== 0) throw new Error(`${tar} could not unpack ${archive}: ${output.stderr.toString('utf8').trim()}`);
    if (!(await unpacked())) {
      try {
        await renameWithRetry(staging, dir);
      } catch (err) {
        // the other app's rename landed first
        if (!(await unpacked())) throw err;
      }
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  return dir;
}

/** The bridge's start: the checkout's daemon under this Electron as Node, or the unpacked package's launcher and Node. */
export function bridgeSpec(options: LoopbackTransportOptions, packageRoot?: string): SpawnSpec {
  const attach = ['attach', '--home', options.home];
  const io = { stdio: ['pipe', 'pipe', 'pipe'] as const, windowsHide: true };
  if (packageRoot === undefined) return { file: options.execPath, args: [options.daemonScript, ...attach], env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' }, ...io };
  const env = Object.fromEntries(Object.entries(options.env).filter(([key]) => !/^ELECTRON_/i.test(key)));
  // a .cmd launcher would need cmd.exe and its quoting, so Windows runs the package's node.exe on the daemon as the launcher does
  if (process.platform === 'win32') return { file: path.join(packageRoot, 'node', 'node.exe'), args: [path.join(packageRoot, 'dist', 'daemon.js'), ...attach], env, ...io };
  return { file: path.join(packageRoot, 'bin', 'damocles-server'), args: attach, env, ...io };
}

/**
 * A started bridge's stdout and stdin as one Duplex. Ending it detaches this app and leaves the daemon and its terminals
 * running; frames written while a write is in flight go to the bridge as one write.
 */
export function bridgeStream(bridge: LaunchedProcess, log: (line: string) => void): Duplex {
  let ended = false;
  const stream = new Duplex({
    read: () => undefined,
    write: (chunk: Buffer, _encoding, callback) => {
      bridge.write(chunk).then(() => callback(), callback);
    },
    writev: (chunks, callback) => {
      bridge.write(Buffer.concat(chunks.map(({ chunk }) => chunk as Buffer))).then(() => callback(), callback);
    },
    final: (callback) => {
      bridge.end();
      callback();
    },
    destroy: (err, callback) => {
      if (!ended) bridge.kill();
      callback(err);
    },
  });
  bridge.onData('stdout', (chunk) => stream.push(chunk));
  bridge.onData('stderr', (chunk) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line !== '') log(`[loopback] bridge: ${line.slice(0, MAX_STDERR_LINE_CHARS)}`);
  });
  bridge.exited.then((exit) => {
    ended = true;
    log(`[loopback] the bridge exited with code ${String(exit.code)}${exit.signal ? ` (${exit.signal})` : ''}`);
  }, () => {
    ended = true;
  });
  // its output closes after the exit, so the last bytes it wrote are read first
  bridge.closed.then(() => {
    stream.push(null);
    stream.destroy();
  }, (err: unknown) => {
    stream.destroy(err instanceof Error ? err : new Error(String(err)));
  });
  return stream;
}

/**
 * The loopback authority's transport: `daemon.js attach --home <home>` started through the launcher with stdio pipes. The
 * bridge authenticates to the daemon (starting it detached when none runs) and then only copies bytes. With a server package
 * it resolves once the package is unpacked and the bridge started, so the handshake's time limit never counts the unpack.
 */
export async function startLoopbackTransport(options: LoopbackTransportOptions): Promise<Duplex> {
  const pkg = options.serverPackage;
  const root = pkg ? await unpackServerPackage(pkg.archive, pkg.unpackRoot) : undefined;
  if (root !== undefined) options.log(`[loopback] the daemon runs from the server package unpacked at ${root}`);
  return bridgeStream(processLauncher().launch(bridgeSpec(options, root)), options.log);
}
