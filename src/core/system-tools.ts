// The operating system tools Damocles spawns, as absolute paths: docs/invariants.md "Source control", the git spawn bullet.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { executablePathForm, searchPathEntries } from './executable-path';
import { log } from './logger';
import { runProcess } from './process-launcher';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The first absolute PATH folder's `fileName` as an absolute path, or undefined. A bare name would also search relative
 * entries (`.`, `bin`), which resolve against the spawn's working folder, often a repository.
 */
export function findOnAbsolutePath(fileName: string, platform: NodeJS.Platform, env: Env): string | undefined {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return searchPathEntries(platform, env)
    .map((dir) => join(dir, fileName))
    .find(isFile);
}

/**
 * findOnAbsolutePath without blocking the thread on a slow PATH folder, such as a disconnected network drive. With several
 * names, the first PATH folder holding any of them wins, as a PATHEXT lookup picks one.
 */
export function findOnAbsolutePathAsync(fileNames: string | readonly string[], platform: NodeJS.Platform, env: Env): Promise<string | undefined> {
  return findOnAbsolutePathWith(isFileAsync, fileNames, platform, env);
}

async function findOnAbsolutePathWith(
  isFileTest: (candidate: string) => Promise<boolean>,
  fileNames: string | readonly string[],
  platform: NodeJS.Platform,
  env: Env,
): Promise<string | undefined> {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  for (const dir of searchPathEntries(platform, env)) {
    for (const fileName of typeof fileNames === 'string' ? [fileNames] : fileNames) {
      const candidate = join(dir, fileName);
      if (await isFileTest(candidate)) return candidate;
    }
  }
  return undefined;
}

function isFileAsync(candidate: string): Promise<boolean> {
  return fs.promises.stat(candidate).then((stat) => stat.isFile(), () => false);
}

/**
 * The bash pi's `getShellConfig` would pick, found without its synchronous `where`/`which` start, which on Windows runs
 * outside the spawn lock and can hold the thread for its 5 s timeout: Git Bash where Git for Windows installs, then an
 * absolute PATH folder's bash. Windows' own System32\bash.exe on PATH is WSL's, which pi runs with the command on stdin.
 */
export async function findBash(env: Env = process.env): Promise<string | undefined> {
  if (process.platform !== 'win32') return (await isFileAsync('/bin/bash')) ? '/bin/bash' : findOnAbsolutePathAsync('bash', process.platform, env);
  const installed = [env['ProgramFiles'], env['ProgramFiles(x86)']]
    .filter((root): root is string => root !== undefined && executablePathForm(root, 'win32').kind === 'absolute')
    .map((root) => path.win32.join(root, 'Git', 'bin', 'bash.exe'));
  for (const candidate of installed) if (await isFileAsync(candidate)) return candidate;
  return findOnAbsolutePathAsync('bash.exe', 'win32', env);
}

/**
 * PowerShell 7 as pi's getPowerShellConfig finds it, without its synchronous `where`: an absolute PATH folder's pwsh, a
 * Microsoft Store alias included, then on Windows `%ProgramFiles%\PowerShell\7\pwsh.exe`. Only pwsh accepts an alias:
 * WindowsApps also holds WSL's bash.exe alias, which findBash must never pick. The terminal's `detectTerminalPwsh` searches
 * the install folders VS Code lists instead, since it offers a shell rather than running the one pi would.
 */
export async function findPwsh(env: Env = process.env): Promise<string | undefined> {
  if (process.platform !== 'win32') return findOnAbsolutePathAsync('pwsh', process.platform, env);
  const isRunnable = (candidate: string): Promise<boolean> => isFileOrAppAlias(candidate).catch(() => false);
  const onPath = await findOnAbsolutePathWith(isRunnable, 'pwsh.exe', 'win32', env);
  if (onPath !== undefined) return onPath;
  const programFiles = env['ProgramFiles'];
  if (programFiles === undefined || executablePathForm(programFiles, 'win32').kind !== 'absolute') return undefined;
  const installed = path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe');
  return (await isRunnable(installed)) ? installed : undefined;
}

/**
 * Whether `file` is a file or, on Windows, an app execution alias (the Store's pwsh.exe), a link whose target stat cannot
 * open but which still runs (nodejs/node#36790). Rejects when lstat, or stat of a link's target, fails for a reason other
 * than a missing path.
 */
export async function isFileOrAppAlias(file: string): Promise<boolean> {
  let link: fs.Stats;
  try {
    link = await fs.promises.lstat(file);
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
  if (!link.isSymbolicLink()) return link.isFile();
  try {
    return (await fs.promises.stat(file)).isFile();
  } catch (err) {
    // libuv's stat of an app execution alias fails with EACCES.
    if (process.platform === 'win32' && (err as NodeJS.ErrnoException).code === 'EACCES') return true;
    if (isMissing(err)) return false;
    throw err;
  }
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

// Where OpenSSH installs its client tools when no absolute PATH folder holds them.
const POSIX_OPENSSH_FOLDERS: readonly string[] = ['/usr/bin', '/bin'];
// `ssh -V` of the Win32-OpenSSH build, the only Windows client that reaches the Windows ssh-agent's named pipe.
const WIN32_OPENSSH_VERSION = /\bOpenSSH_for_Windows_/;
const SSH_VERSION_TIMEOUT_MS = 15_000;

type OpenSshTool = 'ssh-keygen' | 'ssh-add';

/** What `ssh -V` printed, stderr first; undefined when it gave no answer. */
export type SshVersionReader = (ssh: string) => Promise<string | undefined>;

/** How the OpenSSH client is chosen beyond the environment's PATH. */
export interface SshClientChoice {
  /** The SSH client path setting: an absolute path to a file, which wins on every OS. */
  readonly configured?: string | undefined;
  readonly readVersion?: SshVersionReader;
  readonly log?: (line: string) => void;
}

/** `ssh -V` on the launcher. */
export const readSshVersion: SshVersionReader = async (ssh) => {
  const { exit, stdout, stderr } = await runProcess({ file: ssh, args: ['-V'], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, { timeoutMs: SSH_VERSION_TIMEOUT_MS });
  return exit === null ? undefined : `${stderr.toString('utf8')}${stdout.toString('utf8')}`;
};

interface VersionEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly text: Promise<string | undefined>;
}

const versionTexts = new WeakMap<SshVersionReader, Map<string, VersionEntry>>();
// each fallback client is logged once per process
const loggedFallbacks = new Set<string>();

// One `ssh -V` per binary while its modification time and size stay; a run that gave no answer is read again next time.
async function sshVersionText(file: string, read: SshVersionReader): Promise<string | undefined> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return undefined;
  }
  let cache = versionTexts.get(read);
  if (cache === undefined) versionTexts.set(read, (cache = new Map()));
  const known = cache.get(file);
  if (known !== undefined && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return known.text;
  const entry: VersionEntry = { mtimeMs: stat.mtimeMs, size: stat.size, text: read(file).catch(() => undefined) };
  cache.set(file, entry);
  const text = await entry.text;
  if (text === undefined && cache.get(file) === entry) cache.delete(file);
  return text;
}

/**
 * The first OpenSSH for Windows build among the absolute PATH folders' ssh.exe and `%SystemRoot%\System32\OpenSSH\ssh.exe`;
 * an MSYS or Cygwin build (Git for Windows' usr\bin, MSYS2) only when there is none, with a log line.
 */
async function windowsSshClient(env: Env, choice: SshClientChoice): Promise<string | undefined> {
  const onPath = await findAllOnAbsolutePath('ssh.exe', 'win32', env);
  const builtIn = path.win32.join(windowsSystemDirectory(env), 'OpenSSH', 'ssh.exe');
  const candidates = [...onPath, ...((await isFileAsync(builtIn)) ? [builtIn] : [])].filter((file, index, all) => all.findIndex((other) => other.toLowerCase() === file.toLowerCase()) === index);
  const read = choice.readVersion ?? readSshVersion;
  for (const candidate of candidates) if (WIN32_OPENSSH_VERSION.test((await sshVersionText(candidate, read)) ?? '')) return candidate;
  const fallback = candidates[0];
  if (fallback !== undefined && !loggedFallbacks.has(fallback)) {
    loggedFallbacks.add(fallback);
    (choice.log ?? log)(`[ssh] no OpenSSH for Windows client was found, so ${fallback} runs; an MSYS or Cygwin ssh cannot reach the Windows ssh-agent`);
  }
  return fallback;
}

async function findAllOnAbsolutePath(fileName: string, platform: NodeJS.Platform, env: Env): Promise<string[]> {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const found: string[] = [];
  for (const dir of searchPathEntries(platform, env)) {
    const candidate = join(dir, fileName);
    if (await isFileAsync(candidate)) found.push(candidate);
  }
  return found;
}

async function posixOpenSshTool(name: 'ssh' | OpenSshTool, env: Env, platform: NodeJS.Platform): Promise<string | undefined> {
  return (await findOnAbsolutePathAsync(name, platform, env)) ?? firstFile(POSIX_OPENSSH_FOLDERS.map((dir) => path.posix.join(dir, name)));
}

async function firstFile(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) if (await isFileAsync(candidate)) return candidate;
  return undefined;
}

/**
 * The OpenSSH client as an absolute path, undefined when none exists: the SSH client path setting when it names a file, else
 * on Windows windowsSshClient, elsewhere an absolute PATH folder's ssh, then `/usr/bin`'s or `/bin`'s. A setting that is not
 * an absolute path to a file is logged and the default runs.
 */
export async function resolveSshExecutable(env: Env = process.env, platform: NodeJS.Platform = process.platform, choice: SshClientChoice = {}): Promise<string | undefined> {
  const { configured } = choice;
  if (configured !== undefined) {
    const form = executablePathForm(configured, platform);
    if (form.kind === 'absolute' && (await isFileAsync(form.file))) return form.file;
    (choice.log ?? log)(`[ssh] the SSH client path setting names ${configured}, which is not ${form.kind === 'absolute' ? 'a file' : 'an absolute path'}; the default client runs`);
  }
  return platform === 'win32' ? windowsSshClient(env, choice) : posixOpenSshTool('ssh', env, platform);
}

/**
 * The OpenSSH tool in `ssh`'s own folder, as every OpenSSH build installs them, so a Win32-OpenSSH ssh never pairs with an MSYS
 * ssh-keygen or ssh-add. Only on macOS and Linux, whose builds share key files and the agent socket, does a folder without it
 * fall back to an absolute PATH folder's, then `/usr/bin`'s or `/bin`'s.
 */
export async function openSshToolBeside(ssh: string, name: OpenSshTool, env: Env = process.env, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const beside = paths.join(paths.dirname(ssh), platform === 'win32' ? `${name}.exe` : name);
  if (await isFileAsync(beside)) return beside;
  return platform === 'win32' ? undefined : posixOpenSshTool(name, env, platform);
}

/**
 * The shell git runs GIT_SSH_COMMAND and core.sshCommand through (its SHELL_PATH): /bin/sh, or on Windows Git for Windows'
 * own sh.exe under the install root above git.exe (`cmd\`, `bin\` or `mingw64\bin\`).
 */
export async function resolveGitShell(git: string | undefined, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  if (platform !== 'win32') return (await isFileAsync('/bin/sh')) ? '/bin/sh' : undefined;
  if (git === undefined) return undefined;
  let dir = path.win32.dirname(git);
  for (let up = 0; up < 3; up++) {
    const found = await firstFile([path.win32.join(dir, 'usr', 'bin', 'sh.exe'), path.win32.join(dir, 'bin', 'sh.exe')]);
    if (found !== undefined) return found;
    dir = path.win32.dirname(dir);
  }
  return undefined;
}

/** The chosen client's ssh-keygen as an absolute path (resolveSshExecutable, openSshToolBeside). */
export async function resolveSshKeygenExecutable(env: Env = process.env, platform: NodeJS.Platform = process.platform, choice: SshClientChoice = {}): Promise<string | undefined> {
  const ssh = await resolveSshExecutable(env, platform, choice);
  return ssh === undefined ? undefined : openSshToolBeside(ssh, 'ssh-keygen', env, platform);
}

/** `%SystemRoot%\System32`; a root that is not a local absolute path falls back to C:\Windows. */
export function windowsSystemDirectory(env: Env = process.env): string {
  const root = [env['SystemRoot'], env['windir'], env['WINDIR']].find((value) => value !== undefined && executablePathForm(value, 'win32').kind === 'absolute');
  return path.win32.join(root ?? 'C:\\Windows', 'System32');
}

/** `%SystemRoot%\System32\<name>.exe`, as VS Code's killTree names taskkill. */
export function windowsSystemTool(name: 'taskkill' | 'tasklist' | 'icacls' | 'whoami' | 'cmd' | 'tar' | 'reg' | 'wsl', env: Env = process.env): string {
  return path.win32.join(windowsSystemDirectory(env), `${name}.exe`);
}

/** `%SystemRoot%\explorer.exe`, File Explorer, which Windows keeps beside System32. */
export function windowsExplorer(env: Env = process.env): string {
  return path.win32.join(path.win32.dirname(windowsSystemDirectory(env)), 'explorer.exe');
}

/** Windows PowerShell 5.1, where every supported Windows installs it. */
export function windowsPowerShell(env: Env = process.env): string {
  return path.win32.join(windowsSystemDirectory(env), 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// Where the tool is installed when no absolute PATH folder holds it: a regular user's PATH often lacks /sbin.
const POSIX_TOOL_FOLDERS: Readonly<Record<PosixToolName, readonly string[]>> = { ldconfig: ['/sbin', '/usr/sbin'], bash: ['/bin', '/usr/bin'], ps: ['/bin', '/usr/bin'], tar: ['/bin', '/usr/bin'], loginctl: ['/bin', '/usr/bin'], restorecon: ['/sbin', '/usr/sbin'] };

type PosixToolName = 'ldconfig' | 'bash' | 'ps' | 'tar' | 'loginctl' | 'restorecon';

/** A POSIX tool from an absolute PATH folder, else from the folders it is installed in, or undefined when none holds it. */
export function posixTool(name: PosixToolName, env: Env = process.env, folders: readonly string[] = POSIX_TOOL_FOLDERS[name]): string | undefined {
  return findOnAbsolutePath(name, process.platform, env) ?? folders.map((dir) => path.posix.join(dir, name)).find(isFile);
}

/** posixTool without blocking the thread, for a process whose main thread serves others (the daemon). */
export async function posixToolAsync(name: PosixToolName, env: Env = process.env, folders: readonly string[] = POSIX_TOOL_FOLDERS[name]): Promise<string | undefined> {
  return (await findOnAbsolutePathAsync(name, process.platform, env)) ?? firstFile(folders.map((dir) => path.posix.join(dir, name)));
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
