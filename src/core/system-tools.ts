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
export async function findOnAbsolutePathAsync(fileNames: string | readonly string[], platform: NodeJS.Platform, env: Env): Promise<string | undefined> {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  for (const dir of searchPathEntries(platform, env)) {
    for (const fileName of typeof fileNames === 'string' ? [fileNames] : fileNames) {
      const candidate = join(dir, fileName);
      if (await fs.promises.stat(candidate).then((stat) => stat.isFile(), () => false)) return candidate;
    }
  }
  return undefined;
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
