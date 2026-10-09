import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { TerminalIcon } from '../../preload/terminal-channels';
import { searchPathEntries } from './executable-path';

/** A detected shell; id is stable across runs, and damocles.desktop.terminal.defaultProfile names one. */
export interface TerminalProfile {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly args: readonly string[];
  readonly icon: TerminalIcon;
}

export interface ProfileProbe {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
  // Windows' build number, 0 elsewhere
  readonly windowsBuild: number;
  isFile(file: string): Promise<boolean>;
  // a missing directory lists nothing
  readDir(dir: string): Promise<string[]>;
  // undefined for a missing file
  readText(file: string): Promise<string | undefined>;
  // stdout of a run that exited 0; rejects otherwise, with the run's stdout and stderr Buffers on the error
  run(file: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<Buffer>;
  log(line: string): void;
}

// wsl.exe -d, which a WSL profile runs, came with the May 2020 Update.
const MIN_WSL_BUILD = 19041;
// Docker Desktop's own distros are not shells for a user (VS Code skips them too).
const HIDDEN_WSL_DISTROS = new Set(['docker-desktop', 'docker-desktop-data']);
const WSL_TIMEOUT_MS = 10_000;
const POSIX_SHELLS = ['zsh', 'bash', 'fish'] as const;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function firstFile(probe: ProfileProbe, candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) if (await probe.isFile(candidate)) return candidate;
  return undefined;
}

// PowerShell 7 where VS Code looks: Program Files\PowerShell\<highest major>, the other bitness's, the Store's alias, the .NET
// global tool and Scoop.
async function findPwsh(probe: ProfileProbe): Promise<string | undefined> {
  const win = path.win32;
  const installed = async (programFiles: string | undefined): Promise<string | undefined> => {
    if (!programFiles) return undefined;
    const base = win.join(programFiles, 'PowerShell');
    const majors = (await probe.readDir(base)).filter((name) => /^\d+$/.test(name)).sort((a, b) => Number(b) - Number(a));
    return firstFile(probe, majors.map((major) => win.join(base, major, 'pwsh.exe')));
  };
  const store = async (): Promise<string | undefined> => {
    const localAppData = probe.env['LOCALAPPDATA'];
    if (!localAppData) return undefined;
    const apps = win.join(localAppData, 'Microsoft', 'WindowsApps');
    const dir = (await probe.readDir(apps)).find((name) => /^Microsoft\.PowerShell_/.test(name));
    return dir === undefined ? undefined : firstFile(probe, [win.join(apps, dir, 'pwsh.exe')]);
  };
  return (await installed(probe.env['ProgramFiles']))
    ?? (await installed(probe.env['ProgramFiles(x86)']))
    ?? (await store())
    ?? (await firstFile(probe, [win.join(probe.homedir, '.dotnet', 'tools', 'pwsh.exe'), win.join(probe.homedir, 'scoop', 'apps', 'pwsh', 'current', 'pwsh.exe')]));
}

// Git Bash beside the git.exe on PATH, the one probeGit ran: <root>\cmd\git.exe, <root>\bin\git.exe or <root>\mingw64\bin\git.exe.
async function findGitBash(probe: ProfileProbe): Promise<string | undefined> {
  const win = path.win32;
  const git = await firstFile(probe, searchPathEntries(probe.platform, probe.env).map((entry) => win.join(entry, 'git.exe')));
  if (git === undefined) return undefined;
  const dir = win.dirname(git);
  return firstFile(probe, [win.join(dir, '..', 'bin', 'bash.exe'), win.join(dir, '..', '..', 'bin', 'bash.exe')].map((candidate) => win.normalize(candidate)));
}

/** The distro names `wsl.exe -l -q` prints, in UTF-16LE, one per line. */
export function parseWslList(stdout: Buffer): string[] {
  return stdout
    .toString('utf16le')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, '').trim())
    .filter((name) => name.length > 0 && !HIDDEN_WSL_DISTROS.has(name.toLowerCase()));
}

async function findWslDistros(probe: ProfileProbe, wsl: string): Promise<string[]> {
  if (probe.windowsBuild < MIN_WSL_BUILD || !(await probe.isFile(wsl))) return [];
  try {
    // WSL_UTF8=1 in the user's environment would switch the list to UTF-8.
    return parseWslList(await probe.run(wsl, ['-l', '-q'], { ...probe.env, WSL_UTF8: '0' }));
  } catch (err) {
    // No distro installed makes wsl.exe exit non-zero with a message instead of a list.
    probe.log(`[terminal] no WSL distros: ${wslFailureText(err)}`);
    return [];
  }
}

// wsl.exe writes its message in UTF-16LE, as it writes the list, and execFile's error message decodes it as UTF-8, NULs
// and all, which would make the app log unreadable as text.
function wslFailureText(err: unknown): string {
  const failure = err as { code?: unknown; stdout?: unknown; stderr?: unknown };
  const message = [failure.stderr, failure.stdout]
    .filter((output): output is Buffer => Buffer.isBuffer(output))
    .map((output) => output.toString('utf16le').replace(/^\uFEFF/, '').replace(/\0/g, '').replace(/\s+/g, ' ').trim())
    .filter((text) => text.length > 0)
    .join(' ');
  if (message === '') return errorText(err);
  return typeof failure.code === 'number' ? `exit code ${failure.code}: ${message}` : message;
}

async function windowsProfiles(probe: ProfileProbe): Promise<TerminalProfile[]> {
  const win = path.win32;
  const windir = probe.env['SystemRoot'] ?? probe.env['windir'];
  if (windir === undefined) throw new Error('Neither SystemRoot nor windir is set');
  // A 32-bit process on 64-bit Windows reaches the 64-bit System32 only through Sysnative.
  const system32 = win.join(windir, probe.env['PROCESSOR_ARCHITEW6432'] !== undefined ? 'Sysnative' : 'System32');
  const windowsPowerShell = win.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const cmd = win.join(system32, 'cmd.exe');
  const [pwsh, gitBash, hasWindowsPowerShell, hasCmd, distros] = await Promise.all([
    findPwsh(probe),
    findGitBash(probe),
    probe.isFile(windowsPowerShell),
    probe.isFile(cmd),
    findWslDistros(probe, win.join(system32, 'wsl.exe')),
  ]);
  const profiles: TerminalProfile[] = [];
  if (pwsh) profiles.push({ id: 'pwsh', name: 'PowerShell', file: pwsh, args: [], icon: 'powershell' });
  if (hasWindowsPowerShell) profiles.push({ id: 'windows-powershell', name: 'Windows PowerShell', file: windowsPowerShell, args: [], icon: 'powershell' });
  if (hasCmd) profiles.push({ id: 'cmd', name: 'Command Prompt', file: cmd, args: [], icon: 'cmd' });
  if (gitBash) profiles.push({ id: 'git-bash', name: 'Git Bash', file: gitBash, args: ['--login', '-i'], icon: 'git-bash' });
  for (const distro of distros) profiles.push({ id: `wsl:${distro}`, name: distro, file: win.join(system32, 'wsl.exe'), args: ['-d', distro], icon: 'wsl' });
  return profiles;
}

function posixIcon(name: string): TerminalIcon {
  return name === 'zsh' || name === 'bash' || name === 'fish' ? name : 'shell';
}

// $SHELL first, then zsh, bash and fish from /etc/shells or PATH; one profile per shell name. macOS terminals start login shells.
async function posixProfiles(probe: ProfileProbe): Promise<TerminalProfile[]> {
  const posix = path.posix;
  const listed = ((await probe.readText('/etc/shells')) ?? '').split('\n').map((line) => line.trim()).filter((line) => line.startsWith('/'));
  const onPath = searchPathEntries(probe.platform, probe.env);
  const args = probe.platform === 'darwin' ? ['-l'] : [];
  const profiles: TerminalProfile[] = [];
  const add = (file: string): void => {
    const name = posix.basename(file);
    if (!profiles.some((profile) => profile.id === name)) profiles.push({ id: name, name, file, args, icon: posixIcon(name) });
  };
  const loginShell = probe.env['SHELL'];
  if (loginShell && posix.isAbsolute(loginShell) && (await probe.isFile(loginShell))) add(loginShell);
  for (const name of POSIX_SHELLS) {
    const file = await firstFile(probe, [...listed.filter((entry) => posix.basename(entry) === name), ...onPath.map((entry) => posix.join(entry, name))]);
    if (file) add(file);
  }
  return profiles;
}

/** The shells this machine has, in the order the quick pick lists them; the first is the default when no setting names one. */
export function detectProfiles(probe: ProfileProbe): Promise<TerminalProfile[]> {
  return probe.platform === 'win32' ? windowsProfiles(probe) : posixProfiles(probe);
}

// An app execution alias (the Store's pwsh.exe) is a reparse point whose target a stat cannot always open; it still runs.
async function isFile(file: string): Promise<boolean> {
  let link: import('node:fs').Stats;
  try {
    link = await fs.lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
    throw err;
  }
  if (!link.isSymbolicLink()) return link.isFile();
  try {
    return (await fs.stat(file)).isFile();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

async function readDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
    throw err;
  }
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

// The promisified execFile, unlike the callback form, puts stdout and stderr on the error of a failed run.
const execFileAsync = promisify(execFile);

async function run(file: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<Buffer> {
  const { stdout } = await execFileAsync(file, [...args], { encoding: 'buffer', env, timeout: WSL_TIMEOUT_MS, windowsHide: true });
  return stdout;
}

/** The Windows build in os.release() ("10.0.19045"), as VS Code's getWindowsBuildNumberFromOsRelease reads it; 0 elsewhere. */
export function windowsBuildNumber(release: string = os.release(), platform: NodeJS.Platform = process.platform): number {
  const build = platform === 'win32' ? /^\d+\.\d+\.(\d+)/.exec(release)?.[1] : undefined;
  return build === undefined ? 0 : Number(build);
}

/** The probe over this machine's file system and environment. */
export function systemProfileProbe(env: Readonly<Record<string, string | undefined>>, log: (line: string) => void): ProfileProbe {
  return { platform: process.platform, env, homedir: os.homedir(), windowsBuild: windowsBuildNumber(), isFile, readDir, readText, run, log };
}
