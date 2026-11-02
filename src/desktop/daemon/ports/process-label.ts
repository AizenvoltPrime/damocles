// A listening socket's row label: the listener's name and the command the user's shell started, such as "node (npm run dev)".
import type { PortProcess } from './ports-messages';
import { MAX_PROCESS_COMMAND_CHARS, MAX_PROCESS_NAME_CHARS } from './ports-messages';

export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly command?: string;
}

// a parent chain longer than this is a pid loop
const MAX_ANCESTORS = 64;
const SHELLS: ReadonlySet<string> = new Set(['bash', 'zsh', 'sh', 'dash', 'ash', 'fish', 'ksh', 'mksh', 'tcsh', 'csh', 'nu', 'pwsh', 'powershell', 'cmd']);

/** The executable's base name without a login dash or a Windows extension, lower case. */
function baseName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? name;
  return last.replace(/^-/, '').replace(/\.exe$/i, '').toLowerCase();
}

export function isShell(entry: ProcessEntry): boolean {
  return SHELLS.has(baseName(entry.name));
}

// control and format characters would let a command forge text around it where a row shows it
const clean = (text: string, max: number): string => text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').trim().slice(0, max);

/**
 * The listener's name, and the command of the outermost process whose parent is a shell: through `npm run dev`, vite's node
 * runs under `sh -c` under npm's node under the user's shell, and the row names npm's command.
 */
export function describeProcess(pid: number, table: ReadonlyMap<number, ProcessEntry>): PortProcess | undefined {
  const entry = table.get(pid);
  if (!entry) return undefined;
  const name = clean(entry.name.split(/[\\/]/).pop() ?? entry.name, MAX_PROCESS_NAME_CHARS);
  if (name.length === 0) return undefined;
  let started: ProcessEntry | undefined;
  let current = entry;
  for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
    const parent = table.get(current.ppid);
    if (!parent || parent.pid === current.pid) break;
    if (isShell(parent) && !isShell(current)) started = current;
    current = parent;
  }
  const command = started ? clean(started.command ?? started.name, MAX_PROCESS_COMMAND_CHARS) : '';
  return command.length > 0 && command !== name ? { name, command } : { name };
}
