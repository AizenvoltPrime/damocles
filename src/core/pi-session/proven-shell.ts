// The one "proven read-only" verdict on a shell call, which plan mode, read-only agents, design chats and the checkpoint baseline
// wait all take (docs/invariants.md "Permissions and plan mode"): the classifier's, then on win32 the PowerShell command lookup.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { TOOL_BASH, TOOL_POWERSHELL } from '../../shared/tool-names';
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
}

// The extensions Windows runs a file with by default (PATHEXT's stock value); PowerShell adds .ps1 whatever PATHEXT holds.
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL';
// The only files PowerShell starts as a program of its own, with the argv the classifier read.
const PROGRAM_EXTENSIONS: ReadonlySet<string> = new Set(['.exe', '.com']);

/**
 * The verdict on `input.command` of shell tool `toolName`: `classifyReadOnlyShellCommand`'s, and on win32 a proven PowerShell
 * command stays proven only when no PATH folder holds a command name it looks up as a file PowerShell runs other than an .exe or .com.
 */
export async function provenReadOnlyShell(toolName: string, input: Record<string, unknown>, machine: ChatMachine): Promise<ReadOnlyVerdict> {
  const shell = toolName === TOOL_BASH ? 'bash' : toolName === TOOL_POWERSHELL ? 'powershell' : null;
  if (shell === null) return { readOnly: false, reason: `${toolName} is not a shell tool` };
  const command = typeof input['command'] === 'string' ? input['command'] : '';
  const verdict = classifyReadOnlyShellCommand(shell, command, { allowedNetworkHosts: await machine.allowedNetworkHosts() });
  if (!verdict.readOnly || shell !== 'powershell' || machine.platform !== 'win32' || verdict.commandNames.length === 0) return verdict;
  if (machine.powerShellSearch === undefined) return { readOnly: false, reason: 'the commands PowerShell would run cannot be looked up here' };
  const refusal = await scriptOnPath(verdict.commandNames, await machine.powerShellSearch());
  return refusal === undefined ? verdict : { readOnly: false, reason: refusal };
}

/** Why one of `commands` may start a file other than an .exe or .com under PowerShell, or undefined when none may. */
async function scriptOnPath(commands: readonly string[], search: PowerShellSearch): Promise<string | undefined> {
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
