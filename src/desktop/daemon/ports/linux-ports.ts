// Listening TCP sockets on Linux from /proc, read without a shell: /proc/net/tcp and tcp6 for the sockets in LISTEN state
// owned by the user, /proc/<pid>/fd links for the socket inodes' processes, /proc/<pid>/stat for their parents. Row layout and
// the inode map follow gopsutil's net_linux.go (BSD-3, THIRD-PARTY-NOTICES.md).
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import type { PortCandidate } from './ports-messages';
import { describeProcess, type ProcessEntry } from './process-label';

export interface ProcFs {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<readonly string[]>;
  readlink(path: string): Promise<string>;
}

export const NODE_PROC_FS: ProcFs = {
  readFile: (path) => fs.readFile(path, 'utf8'),
  readdir: (path) => fs.readdir(path),
  readlink: (path) => fs.readlink(path),
};

const TCP_LISTEN = '0A';

export interface ProcListener {
  readonly port: number;
  readonly bindAddress: string;
  readonly family: 4 | 6;
  readonly inode: string;
}

// /proc/net writes each 32-bit word of the address in the host's byte order
function wordBytes(hex: string, littleEndian: boolean): number[] {
  const bytes = [0, 2, 4, 6].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return littleEndian ? bytes.reverse() : bytes;
}

export function decodeAddress(hex: string, littleEndian: boolean): string | undefined {
  if (hex.length === 8) return /^[0-9A-Fa-f]{8}$/.test(hex) ? wordBytes(hex, littleEndian).join('.') : undefined;
  if (hex.length !== 32 || !/^[0-9A-Fa-f]{32}$/.test(hex)) return undefined;
  const bytes = [0, 8, 16, 24].flatMap((at) => wordBytes(hex.slice(at, at + 8), littleEndian));
  const groups: string[] = [];
  for (let at = 0; at < 16; at += 2) groups.push(((bytes[at]! << 8) | bytes[at + 1]!).toString(16));
  const mapped = groups.slice(0, 5).every((group) => group === '0') && groups[5] === 'ffff';
  if (mapped) return `::ffff:${bytes.slice(12).join('.')}`;
  return compressV6(groups);
}

// RFC 5952: the longest run of two or more zero groups becomes '::'
function compressV6(groups: readonly string[]): string {
  let best = -1;
  let bestLength = 1;
  for (let at = 0; at < groups.length;) {
    if (groups[at] !== '0') {
      at++;
      continue;
    }
    let end = at;
    while (end < groups.length && groups[end] === '0') end++;
    if (end - at > bestLength) {
      best = at;
      bestLength = end - at;
    }
    at = end;
  }
  if (best < 0) return groups.join(':');
  return `${groups.slice(0, best).join(':')}::${groups.slice(best + bestLength).join(':')}`;
}

/** The LISTEN rows of one /proc/net/tcp or tcp6 table that uid owns. */
export function parseProcNetTcp(text: string, family: 4 | 6, uid: number, littleEndian: boolean): ProcListener[] {
  const rows: ProcListener[] = [];
  for (const line of text.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    // sl local rem st tx:rx tr:when retrnsmt uid timeout inode
    if (fields.length < 10 || fields[3] !== TCP_LISTEN || Number(fields[7]) !== uid) continue;
    const [addressHex, portHex] = fields[1]!.split(':');
    const bindAddress = addressHex === undefined ? undefined : decodeAddress(addressHex, littleEndian);
    const port = portHex !== undefined && /^[0-9A-Fa-f]{4}$/.test(portHex) ? parseInt(portHex, 16) : 0;
    if (bindAddress === undefined || port === 0 || !/^\d+$/.test(fields[9]!)) continue;
    rows.push({ port, bindAddress, family, inode: fields[9]! });
  }
  return rows;
}

/** pid, parent pid and name from /proc/<pid>/stat, whose name may hold spaces and parentheses. */
export function parseStat(text: string): { readonly ppid: number; readonly name: string } | undefined {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return undefined;
  const ppid = Number(text.slice(close + 2).split(' ')[1]);
  return Number.isSafeInteger(ppid) ? { ppid, name: text.slice(open + 1, close) } : undefined;
}

const SOCKET_LINK = /^socket:\[(\d+)\]$/;

const missing = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException).code;
  // a process ended while it was read, or belongs to another user
  return code === 'ENOENT' || code === 'ESRCH' || code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR';
};

async function orUndefined<T>(read: Promise<T>): Promise<T | undefined> {
  try {
    return await read;
  } catch (err) {
    if (missing(err)) return undefined;
    throw err;
  }
}

/** The loopback address the daemon connects to for a socket bound to bindAddress. */
export function loopbackOf(bindAddress: string, family: 4 | 6): string {
  if (bindAddress === '0.0.0.0') return '127.0.0.1';
  if (bindAddress === '::') return '::1';
  if (family === 6 && bindAddress === '::ffff:0.0.0.0') return '127.0.0.1';
  return bindAddress.startsWith('::ffff:') ? bindAddress.slice('::ffff:'.length) : bindAddress;
}

/** Every listening TCP socket uid owns, with the process holding it when /proc shows it. */
export async function scanLinuxListeners(proc: ProcFs = NODE_PROC_FS, uid: number = process.getuid?.() ?? -1, littleEndian: boolean = os.endianness() === 'LE'): Promise<PortCandidate[]> {
  const tables = await Promise.all([
    orUndefined(proc.readFile('/proc/net/tcp')).then((text) => (text === undefined ? [] : parseProcNetTcp(text, 4, uid, littleEndian))),
    orUndefined(proc.readFile('/proc/net/tcp6')).then((text) => (text === undefined ? [] : parseProcNetTcp(text, 6, uid, littleEndian))),
  ]);
  const listeners = tables.flat();
  if (listeners.length === 0) return [];
  const wanted = new Set(listeners.map((listener) => listener.inode));
  const owners = new Map<string, number>();
  const processes = new Map<number, ProcessEntry>();
  const pids = (await proc.readdir('/proc')).filter((name) => /^\d+$/.test(name)).map(Number);
  for (const pid of pids) {
    const stat = await orUndefined(proc.readFile(`/proc/${pid}/stat`));
    const parsed = stat === undefined ? undefined : parseStat(stat);
    if (!parsed) continue;
    processes.set(pid, { pid, ppid: parsed.ppid, name: parsed.name });
    if (owners.size === wanted.size) continue;
    const fds = await orUndefined(proc.readdir(`/proc/${pid}/fd`));
    for (const fd of fds ?? []) {
      const link = await orUndefined(proc.readlink(`/proc/${pid}/fd/${fd}`));
      const inode = link === undefined ? undefined : SOCKET_LINK.exec(link)?.[1];
      if (inode !== undefined && wanted.has(inode) && !owners.has(inode)) owners.set(inode, pid);
    }
  }
  // command lines only for the ancestors a label reads
  const withCommand = async (pid: number): Promise<void> => {
    const entry = processes.get(pid);
    if (!entry || entry.command !== undefined) return;
    const cmdline = await orUndefined(proc.readFile(`/proc/${pid}/cmdline`));
    const argv = cmdline?.split('\0').filter((part) => part.length > 0) ?? [];
    // stat's name is the main thread's, which a program may rename (Node calls it MainThread); argv[0] names the program
    const program = argv[0]?.split('/').pop();
    processes.set(pid, argv.length > 0 ? { ...entry, ...(program ? { name: program } : {}), command: argv.join(' ') } : entry);
  };
  for (const pid of new Set(owners.values())) {
    for (let current = processes.get(pid), depth = 0; current && depth < 64; current = processes.get(current.ppid), depth++) await withCommand(current.pid);
  }
  return listeners.map((listener) => {
    const pid = owners.get(listener.inode);
    const process = pid === undefined ? undefined : describeProcess(pid, processes);
    return {
      port: listener.port,
      bindAddress: listener.bindAddress,
      family: listener.family,
      host: loopbackOf(listener.bindAddress, listener.family),
      ...(pid !== undefined ? { pid } : {}),
      ...(process ? { process } : {}),
    };
  });
}
