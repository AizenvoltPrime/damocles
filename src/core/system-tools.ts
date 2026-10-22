// The operating system tools Damocles spawns, as absolute paths: docs/invariants.md "Source control", the git spawn bullet.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { executablePathForm, searchPathEntries } from './executable-path';

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

/** `%SystemRoot%\System32`; a root that is not a local absolute path falls back to C:\Windows. */
export function windowsSystemDirectory(env: Env = process.env): string {
  const root = [env['SystemRoot'], env['windir'], env['WINDIR']].find((value) => value !== undefined && executablePathForm(value, 'win32').kind === 'absolute');
  return path.win32.join(root ?? 'C:\\Windows', 'System32');
}

/** `%SystemRoot%\System32\<name>.exe`, as VS Code's killTree names taskkill. */
export function windowsSystemTool(name: 'taskkill' | 'tasklist' | 'icacls', env: Env = process.env): string {
  return path.win32.join(windowsSystemDirectory(env), `${name}.exe`);
}

/** Windows PowerShell 5.1, where every supported Windows installs it. */
export function windowsPowerShell(env: Env = process.env): string {
  return path.win32.join(windowsSystemDirectory(env), 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// Where the tool is installed when no absolute PATH folder holds it: a regular user's PATH often lacks /sbin.
const POSIX_TOOL_FOLDERS: Readonly<Record<PosixToolName, readonly string[]>> = { ldconfig: ['/sbin', '/usr/sbin'], bash: ['/bin', '/usr/bin'] };

type PosixToolName = 'ldconfig' | 'bash';

/** A POSIX tool from an absolute PATH folder, else from the folders it is installed in, or undefined when none holds it. */
export function posixTool(name: PosixToolName, env: Env = process.env, folders: readonly string[] = POSIX_TOOL_FOLDERS[name]): string | undefined {
  return findOnAbsolutePath(name, process.platform, env) ?? folders.map((dir) => path.posix.join(dir, name)).find(isFile);
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
