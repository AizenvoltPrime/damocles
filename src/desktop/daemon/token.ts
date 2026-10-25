// The daemon's run files: ~/.damocles/server/run-<machine key>/ holds the lock, the pid file, the logs and the state, so
// machines sharing a home over NFS never write the same file. On POSIX the socket and its token live in a mkdtemp folder
// outside the home; on Windows the token sits in the run folder, whose ACL admits only the user.
import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { networkFileSystem } from '../../core/network-fs';
import { runProcess } from '../../core/process-launcher';
import { windowsSystemTool } from '../../core/system-tools';
import { machineRunKey } from './machine-id';

export const TOKEN_BYTES = 32;
// the daemon touches its folder, socket, token and pid file this often; systemd-tmpfiles and macOS periodic remove older files
export const TOUCH_INTERVAL_MS: number = 24 * 60 * 60 * 1000;
// another run folder whose pid file was touched within this long shares the home
export const SHARED_HOME_WINDOW_MS: number = 25 * 60 * 60 * 1000;
const PID_FILE = 'daemon.pid';
const SOCKET_NAME = 'daemon.sock';
const TOKEN_NAME = 'token';

export interface RunPaths {
  readonly serverDir: string;
  readonly runDir: string;
  readonly lockFile: string;
  readonly pidFile: string;
  readonly logsDir: string;
  // zsh's ZDOTDIR for the daemon's integrated shells
  readonly zshDotDir: string;
}

export interface PidRecord {
  readonly version: string;
  readonly pid: number;
  // the name another machine sharing the home shows for this daemon; absent from an older daemon's file
  readonly hostname?: string;
  // the socket path or the pipe name
  readonly endpoint: string;
  // POSIX: the mkdtemp folder holding the socket and the token; null on Windows
  readonly socketFolder: string | null;
  readonly updatedAt: number;
}

export function runPaths(home: string, runKey: string): RunPaths {
  const serverDir = path.join(home, '.damocles', 'server');
  const runDir = path.join(serverDir, `run-${runKey}`);
  return {
    serverDir,
    runDir,
    lockFile: path.join(runDir, 'daemon.lock'),
    pidFile: path.join(runDir, PID_FILE),
    logsDir: path.join(runDir, 'logs'),
    zshDotDir: path.join(runDir, 'shell-integration', 'zsh'),
  };
}

/** This machine's run folder in home: the bridge, the daemon and the e2e support all find it here. */
export async function localRunPaths(home: string = os.homedir()): Promise<RunPaths> {
  return runPaths(home, await machineRunKey());
}

export function socketPath(socketFolder: string): string {
  return path.join(socketFolder, SOCKET_NAME);
}

const PIPE_NAME = /^\\\\\.\\pipe\\damocles-server-[0-9a-f]{32}$/;

/** Whether a pid file's endpoint is one this daemon would have made: its folder's socket, or a pipe of the daemon's pattern. */
export function isOwnEndpoint(record: Pick<PidRecord, 'endpoint' | 'socketFolder'>, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return record.socketFolder === null && PIPE_NAME.test(record.endpoint);
  return record.socketFolder !== null && path.basename(record.socketFolder).startsWith(SOCKET_FOLDER_PREFIX) && record.endpoint === socketPath(record.socketFolder);
}

/** Removes a socket folder by its two names, so a folder holding anything else is never emptied; one already gone is done. */
export async function removeSocketFolder(folder: string): Promise<void> {
  await fs.rm(path.join(folder, SOCKET_NAME), { force: true });
  await fs.rm(path.join(folder, TOKEN_NAME), { force: true });
  await fs.rmdir(folder).catch((err: unknown) => {
    if (errnoCode(err) !== 'ENOENT') throw err;
  });
}

// POSIX: beside the socket; Windows: in the run folder.
export function tokenPath(paths: RunPaths, record: Pick<PidRecord, 'socketFolder'>): string {
  return record.socketFolder === null ? path.join(paths.runDir, TOKEN_NAME) : path.join(record.socketFolder, TOKEN_NAME);
}

export function pipeName(): string {
  return `\\\\.\\pipe\\damocles-server-${randomBytes(16).toString('hex')}`;
}

function errnoCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

// The user's SID: a bare name resolves to a local account of the same name before the domain one.
async function userSid(): Promise<string> {
  const { exit, stdout } = await runProcess({ file: windowsSystemTool('whoami'), args: ['/user', '/fo', 'csv', '/nh'], windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }, { timeoutMs: 30_000 });
  const sid = /"(S-1-[0-9-]+)"\s*$/.exec(stdout.toString('utf8').trim())?.[1];
  if (exit?.code !== 0 || sid === undefined) throw new Error(`whoami did not name the user's SID (exit ${String(exit?.code ?? 'none')})`);
  return sid;
}

/** Drops inherited entries and grants only the user, by SID, inherited by every file made inside it (Windows). */
export async function restrictToUser(folder: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const sid = await userSid();
  const { exit } = await runProcess({ file: windowsSystemTool('icacls'), args: [folder, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }, { timeoutMs: 30_000 });
  if (exit?.code !== 0) throw new Error(`icacls could not restrict ${folder} to ${sid} (exit ${String(exit?.code ?? 'none')})`);
}

export async function makeRunDir(paths: RunPaths): Promise<void> {
  await fs.mkdir(paths.runDir, { recursive: true, mode: 0o700 });
  await restrictToUser(paths.runDir);
  await fs.mkdir(paths.logsDir, { recursive: true, mode: 0o700 });
}

// The folder Linux keeps for the user's sockets only while the user has linger: logind removes it at the last logout.
async function lingers(): Promise<boolean> {
  try {
    await fs.access(path.join('/var/lib/systemd/linger', os.userInfo().username));
    return true;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return false;
    throw err;
  }
}

export async function socketFolderBase(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string> {
  if (platform === 'darwin') return env['TMPDIR'] || os.tmpdir();
  const runtime = env['XDG_RUNTIME_DIR'];
  if (runtime && path.isAbsolute(runtime) && (await lingers())) return runtime;
  return '/tmp';
}

/** Throws unless the folder is a real folder, not a link, owned by this user, mode 0700, and not on a network file system. */
export async function checkSocketFolder(folder: string): Promise<void> {
  const stat = await fs.lstat(folder);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${folder} is not a folder`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${folder} belongs to uid ${stat.uid}, not ${uid}`);
  if ((stat.mode & 0o777) !== 0o700) throw new Error(`${folder} has mode ${(stat.mode & 0o777).toString(8)}, not 700`);
  if (process.platform !== 'linux') return;
  const { type } = await fs.statfs(folder);
  const network = networkFileSystem(folder, () => type);
  if (network) throw new Error(`${folder} is on ${network}`);
}

export const SOCKET_FOLDER_PREFIX = 'damocles-';

/** A new unpredictable socket folder under base (POSIX), checked before use. */
export async function createSocketFolder(base: string): Promise<string> {
  const folder = await fs.mkdtemp(path.join(base, SOCKET_FOLDER_PREFIX));
  await fs.chmod(folder, 0o700);
  await checkSocketFolder(folder);
  return folder;
}

/** A fresh token, created exclusively with mode 0600 (and the run folder's user-only ACL on Windows) before its bytes are written. */
export async function writeToken(file: string): Promise<Uint8Array> {
  const token = randomBytes(TOKEN_BYTES);
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(token.toString('hex'));
  } finally {
    await handle.close();
  }
  return token;
}

export async function readToken(file: string): Promise<Uint8Array> {
  const text = (await fs.readFile(file, 'utf8')).trim();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${file} does not hold a daemon token`);
  return Buffer.from(text, 'hex');
}

export function parsePidRecord(raw: unknown): PidRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const { version, pid, hostname, endpoint, socketFolder, updatedAt } = value;
  if (typeof version !== 'string' || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || typeof endpoint !== 'string' || endpoint === '') return undefined;
  if (!(socketFolder === null || (typeof socketFolder === 'string' && path.isAbsolute(socketFolder))) || typeof updatedAt !== 'number') return undefined;
  return { version, pid, ...(typeof hostname === 'string' && hostname !== '' ? { hostname } : {}), endpoint, socketFolder, updatedAt };
}

// undefined: no pid file, or one that does not parse
export async function readPidFile(file: string): Promise<PidRecord | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return parsePidRecord(JSON.parse(text));
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}

export async function writePidFile(file: string, record: PidRecord): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
}

// Touches each path; false when one was removed.
export async function touch(files: readonly string[], now: Date = new Date()): Promise<boolean> {
  for (const file of files) {
    try {
      await fs.utimes(file, now, now);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return false;
      throw err;
    }
  }
  return true;
}

/** The hostnames other run folders' pid files in this home name, of those touched within SHARED_HOME_WINDOW_MS. */
export async function otherHostsInHome(paths: RunPaths, now: number = Date.now()): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(paths.serverDir);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return [];
    throw err;
  }
  const own = path.basename(paths.runDir);
  const hosts: string[] = [];
  for (const name of names) {
    if (!name.startsWith('run-') || name === own) continue;
    const file = path.join(paths.serverDir, name, PID_FILE);
    try {
      const stat = await fs.stat(file);
      if (now - stat.mtimeMs > SHARED_HOME_WINDOW_MS) continue;
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') continue;
      throw err;
    }
    const hostname = (await readPidFile(file))?.hostname;
    if (hostname !== undefined) hosts.push(hostname);
  }
  return hosts;
}
