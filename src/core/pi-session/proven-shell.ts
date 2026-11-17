// The one "proven read-only" verdict on a shell call, which plan mode, read-only agents, design chats and the checkpoint baseline
// wait all take (docs/invariants.md "Permissions and plan mode"): the classifier's, then on win32 where Windows places the
// drives and folders it opens, then the PowerShell command lookup.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { TOOL_BASH, TOOL_POWERSHELL } from '../../shared/tool-names';
import { envSpellings } from '../../shared/env-spellings';
import { networkReach } from '../local-links';
import { classifyReadOnlyShellCommand, type ReadOnlyVerdict } from './readonly-shell';

/** Where the PowerShell the PowerShell tool starts looks a command up. */
export interface PowerShellSearch {
  /** PATH of the environment the tool starts PowerShell with. */
  readonly path: string;
  /** PATHEXT of that environment; undefined when it has none. */
  readonly pathext: string | undefined;
  /** The folder of the pwsh the tool starts first, which pwsh puts ahead of PATH; undefined when no pwsh is found. */
  readonly pwshHome: string | undefined;
}

/** What a chat's gate reads of the machine its tools run on, per call. */
export interface ChatMachine {
  readonly platform: NodeJS.Platform;
  /** Hosts of the chat's folders, every spelling (`networkPathHost`); WSL's are local to `leavesLocalDrives` itself. */
  allowedNetworkHosts(): Promise<ReadonlySet<string>>;
  /** Read only for a PowerShell command on win32; absent, PowerShell's lookup is unknown and no command of one passes. */
  powerShellSearch?(): Promise<PowerShellSearch>;
  /** The shell tools' home folders (`shellHomeFolders`), read only on win32 for a command that opens the home; absent, none passes. */
  homeFolders?(): Promise<readonly string[]>;
  /** Every folder the shell tools' command lookups may read (`shellLookupFolders`), read only on win32; absent, no command passes there. */
  lookupFolders?(): Promise<readonly string[]>;
}

/**
 * The folders a command lookup of the shell tools may read, from the environment they start with: each PATH entry, which bash,
 * PowerShell and the pwsh search (`findPwsh`) visit, every spelling, and `%ProgramFiles%\PowerShell\7`, where `findPwsh` looks
 * when PATH holds no pwsh.
 */
export function shellLookupFolders(env: Readonly<Record<string, string | undefined>>): string[] {
  const values = (name: string): string[] => envSpellings(env, name, 'win32').map((key) => env[key]).filter((value): value is string => value !== undefined && value !== '');
  return [
    ...values('PATH').flatMap((value) => value.split(';')).map((entry) => entry.replace(/"/g, '')).filter((entry) => entry !== ''),
    ...values('ProgramFiles').map((folder) => path.win32.join(folder, 'PowerShell', '7')),
  ];
}

/**
 * Every folder the shell tools may read `~` as, from the environment they start with: HOME, which Git Bash takes first,
 * HOMEDRIVE and HOMESHARE, which Git Bash and Windows PowerShell may take without it, and USERPROFILE, pwsh's; each spelling.
 */
export function shellHomeFolders(env: Readonly<Record<string, string | undefined>>): string[] {
  return ['HOME', 'HOMEDRIVE', 'HOMESHARE', 'USERPROFILE']
    .flatMap((name) => envSpellings(env, name, 'win32').map((key) => env[key]))
    .filter((folder): folder is string => folder !== undefined && folder !== '');
}

// The extensions Windows runs a file with by default (PATHEXT's stock value); PowerShell adds .ps1 whatever PATHEXT holds.
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL';
// The only files PowerShell starts as a program of its own, with the argv the classifier read.
const PROGRAM_EXTENSIONS: ReadonlySet<string> = new Set(['.exe', '.com']);

/**
 * The verdict on `input.command` of shell tool `toolName` run in `cwd`: `classifyReadOnlyShellCommand`'s, and on win32 a proven
 * command stays proven only when no drive or folder it opens reaches a computer off the chat's hosts (`placedOffHosts`), and a
 * proven PowerShell command only when no PATH folder holds a command name it looks up as a file PowerShell runs other than an
 * .exe or .com.
 */
export async function provenReadOnlyShell(toolName: string, input: Record<string, unknown>, machine: ChatMachine, cwd: string): Promise<ReadOnlyVerdict> {
  const shell = toolName === TOOL_BASH ? 'bash' : toolName === TOOL_POWERSHELL ? 'powershell' : null;
  if (shell === null) return { readOnly: false, reason: `${toolName} is not a shell tool` };
  const command = typeof input['command'] === 'string' ? input['command'] : '';
  const allowed = await machine.allowedNetworkHosts();
  const verdict = classifyReadOnlyShellCommand(shell, command, { allowedNetworkHosts: allowed });
  if (!verdict.readOnly || machine.platform !== 'win32') return verdict;
  const offHosts = await placedOffHosts(verdict, cwd, machine, allowed);
  if (offHosts !== undefined) return { readOnly: false, reason: offHosts };
  if (shell !== 'powershell' || verdict.commandNames.length === 0) return verdict;
  if (machine.powerShellSearch === undefined) return { readOnly: false, reason: 'the commands PowerShell would run cannot be looked up here' };
  const refusal = await scriptOnPath(verdict.commandNames, await machine.powerShellSearch(), allowed);
  return refusal === undefined ? verdict : { readOnly: false, reason: refusal };
}

/**
 * Why a proven command may open a computer off the chat's hosts, else undefined: a drive it names, the root of its working
 * folder, when it opens the home the root of a home folder, and the root of every folder its lookup may read, each placed by
 * `networkReach` (a drive where QueryDosDeviceW maps it now) before anything reads one. A root Windows cannot place, a home
 * folder that names no root, an unknown home and unknown lookup folders refuse.
 */
async function placedOffHosts(verdict: Extract<ReadOnlyVerdict, { readOnly: true }>, cwd: string, machine: ChatMachine, allowed: ReadonlySet<string>): Promise<string | undefined> {
  const places: Array<{ label: string; folder: string; root: string | undefined }> = [
    ...verdict.drives.map((letter) => ({ label: 'the drive', folder: `${letter}:`, root: `${letter}:\\` })),
    { label: 'the working folder', folder: cwd, root: folderRoot(cwd) },
  ];
  if (verdict.home) {
    const homes = machine.homeFolders === undefined ? [] : await machine.homeFolders();
    if (homes.length === 0) return 'the shell\'s home folder cannot be told here, so where `~` leads is unknown';
    places.push(...homes.map((home) => ({ label: 'the home folder', folder: home, root: folderRoot(home) ?? msysDriveRoot(home) })));
  }
  if (machine.lookupFolders === undefined) return 'the folders the shell looks commands up in cannot be told here';
  // A folder with no drive or share of its own (`bin`, `\tools`, Git Bash's `/usr/bin`) is on the working folder's drive or Git's own.
  for (const folder of await machine.lookupFolders()) {
    const root = folderRoot(folder) ?? msysDriveRoot(folder);
    if (root !== undefined) places.push({ label: 'the PATH folder', folder, root });
  }
  for (const { label, folder, root } of places) {
    const refusal = await offHosts(label, folder, root, allowed);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

/**
 * Why opening `folder`, whose drive or share root is `root`, may reach a computer off `allowed`, by `networkReach` of the root,
 * else undefined; a root that is unknown or that Windows cannot place (a failing QueryDosDeviceW, a walk that fails) refuses.
 */
async function offHosts(label: string, folder: string, root: string | undefined, allowed: ReadonlySet<string>): Promise<string | undefined> {
  if (root === undefined) return `${label} \`${folder}\` names no drive or share, so where it leads is unknown`;
  let reach: Awaited<ReturnType<typeof networkReach>>;
  try {
    reach = await networkReach(root, allowed);
  } catch (err) {
    // a placement Windows cannot give is an answer, unlike a programming error
    if (!(err instanceof Error) || err instanceof TypeError || err instanceof ReferenceError) throw err;
    return `Windows could not tell where ${label} \`${folder}\` leads (${err.message})`;
  }
  if (reach === null) return undefined;
  const hosts = [...reach.hosts, ...(reach.unplaced ? ['an unknown computer'] : [])].join(', ');
  return `${label} \`${folder}\` is on another computer (${hosts}): opening it can send your Windows credentials there`;
}

/** The drive root (`Z:\`) or share root (`\\host\share\`) of a Windows folder; undefined for a root-relative or relative one. */
function folderRoot(folder: string): string | undefined {
  const drive = /^([a-z]):/i.exec(folder);
  if (drive) return `${drive[1]!.toUpperCase()}:\\`;
  return /^[\\/]{2}/.test(folder) ? path.win32.parse(folder).root : undefined;
}

/** The drive root of a Git Bash spelling of a drive folder (`/c/Users/me`, `/cygdrive/c/Users/me`). */
function msysDriveRoot(folder: string): string | undefined {
  const drive = /^\/(?:cygdrive\/)?([a-z])(?:\/|$)/i.exec(folder);
  return drive ? `${drive[1]!.toUpperCase()}:\\` : undefined;
}

/**
 * Why one of `commands` may start a file other than an .exe or .com under PowerShell, or undefined when none may. Each folder is
 * placed (`offHosts`) before it is read, so a folder on a computer off `allowed` refuses unread.
 */
async function scriptOnPath(commands: readonly string[], search: PowerShellSearch, allowed: ReadonlySet<string>): Promise<string | undefined> {
  const extensions = new Set(['.ps1', ...`${DEFAULT_PATHEXT};${search.pathext ?? ''}`.split(';').filter(Boolean).map((ext) => ext.toLowerCase())]);
  const folders: string[] = search.pwshHome === undefined ? [] : [search.pwshHome];
  // Probed on pwsh 7 and Windows PowerShell 5.1: an empty entry is never searched; a relative one is, from a folder a command can change.
  for (const entry of search.path.split(';')) {
    const folder = entry.replace(/"/g, '');
    if (folder === '') continue;
    if (!/^(?:[a-z]:[\\/]|[\\/]{2})/i.test(folder)) return `PATH holds the relative folder \`${entry}\`, where PowerShell may find any command`;
    folders.push(folder);
  }
  for (const command of commands) {
    if (/[\\/:]/.test(command)) return `\`${command}\` names a path, which PowerShell runs without the PATH check`;
  }
  for (const folder of folders) {
    const placed = await offHosts('the PATH folder', folder, folderRoot(folder), allowed);
    if (placed !== undefined) return placed;
    const entries = await folderEntries(folder);
    if (typeof entries === 'string') return entries;
    for (const entry of entries) {
      const file = entry.toLowerCase();
      const command = commands.find((name) => {
        const typed = name.toLowerCase();
        return file === typed || (file.startsWith(typed) && extensions.has(file.slice(typed.length)));
      });
      if (command !== undefined && !PROGRAM_EXTENSIONS.has(path.extname(file))) {
        return `\`${command}\` may run ${path.win32.join(folder, entry)}, a script or document rather than the command the read-only check judged`;
      }
    }
  }
  return undefined;
}

/** The names in `folder`; none when it does not exist, as PowerShell skips it; the refusal when it cannot be read. */
async function folderEntries(folder: string): Promise<readonly string[] | string> {
  try {
    return await fs.readdir(folder);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    return `the PATH folder ${folder} could not be read (${code ?? String(err)}), so the command PowerShell runs is unknown`;
  }
}
