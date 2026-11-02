// Listening TCP sockets on Windows through iphlpapi's GetExtendedTcpTable (TCP_TABLE_OWNER_PID_LISTENER, AF_INET and AF_INET6)
// over koffi, with gopsutil's row layouts and its grow-and-retry call (net_windows.go, BSD-3, THIRD-PARTY-NOTICES.md). The
// owner is the user of the owning process's token; parents come from a CreateToolhelp32Snapshot. No process starts per scan.
import { loopbackOf } from './linux-ports';
import type { PortCandidate } from './ports-messages';
import { describeProcess, type ProcessEntry } from './process-label';

const AF_INET = 2;
const AF_INET6 = 23;
const TCP_TABLE_OWNER_PID_LISTENER = 3;
const NO_ERROR = 0;
const ERROR_INSUFFICIENT_BUFFER = 122;
// tables grow between the size query and the read while sockets open; more than this many rounds is a fault
const MAX_TABLE_ATTEMPTS = 8;
// MIB_TCPROW_OWNER_PID: state, local address, local port, remote address, remote port, owning pid (DWORDs)
export const TCP4_ROW_BYTES = 24;
// MIB_TCP6ROW_OWNER_PID: local address[16], scope id, local port, remote address[16], scope id, remote port, state, pid
export const TCP6_ROW_BYTES = 56;
const TH32CS_SNAPPROCESS = 0x2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const TOKEN_QUERY = 0x8;
const TOKEN_USER = 1;
const MAX_PATH = 260;
// PROCESSENTRY32W on 64-bit Windows: dwSize, cntUsage, pid, (pad), heap id (8), module id, threads, parent pid, priority,
// flags, szExeFile[260] UTF-16, padded to 8
const ENTRY_PID = 8;
const ENTRY_PARENT = 32;
const ENTRY_EXE = 44;
export const PROCESS_ENTRY_BYTES = 568;

export interface TableRow {
  readonly pid: number;
  readonly port: number;
  readonly bindAddress: string;
  readonly family: 4 | 6;
}

// the port DWORD holds the port in network byte order in its low 16 bits
const portAt = (table: Uint8Array, offset: number): number => (table[offset]! << 8) | table[offset + 1]!;
const view = (table: Uint8Array): DataView => new DataView(table.buffer, table.byteOffset, table.byteLength);

/** The rows of a MIB_TCPTABLE_OWNER_PID: a DWORD count, then the rows. */
export function parseTcp4Table(table: Uint8Array): TableRow[] {
  const data = view(table);
  const count = data.getUint32(0, true);
  if (4 + count * TCP4_ROW_BYTES > table.length) throw new Error(`An IPv4 TCP table of ${table.length} bytes cannot hold ${count} rows`);
  const rows: TableRow[] = [];
  for (let at = 4, index = 0; index < count; index++, at += TCP4_ROW_BYTES) {
    rows.push({ bindAddress: [...table.subarray(at + 4, at + 8)].join('.'), port: portAt(table, at + 8), pid: data.getUint32(at + 20, true), family: 4 });
  }
  return rows;
}

function v6Text(bytes: Uint8Array): string {
  const groups: string[] = [];
  for (let at = 0; at < 16; at += 2) groups.push(((bytes[at]! << 8) | bytes[at + 1]!).toString(16));
  let best = -1;
  let bestLength = 1;
  for (let at = 0; at < 8;) {
    let end = at;
    while (end < 8 && groups[end] === '0') end++;
    if (end - at > bestLength) {
      best = at;
      bestLength = end - at;
    }
    at = end === at ? at + 1 : end;
  }
  if (best < 0) return groups.join(':');
  return `${groups.slice(0, best).join(':')}::${groups.slice(best + bestLength).join(':')}`;
}

/** The rows of a MIB_TCP6TABLE_OWNER_PID: a DWORD count, then the rows. */
export function parseTcp6Table(table: Uint8Array): TableRow[] {
  const data = view(table);
  const count = data.getUint32(0, true);
  if (4 + count * TCP6_ROW_BYTES > table.length) throw new Error(`An IPv6 TCP table of ${table.length} bytes cannot hold ${count} rows`);
  const rows: TableRow[] = [];
  for (let at = 4, index = 0; index < count; index++, at += TCP6_ROW_BYTES) {
    rows.push({ bindAddress: v6Text(table.subarray(at, at + 16)), port: portAt(table, at + 20), pid: data.getUint32(at + 52, true), family: 6 });
  }
  return rows;
}

/** One PROCESSENTRY32W: its pid, parent pid and executable name. */
export function parseProcessEntry(entry: Uint8Array): ProcessEntry {
  const data = view(entry);
  const exe = Buffer.from(entry.buffer, entry.byteOffset + ENTRY_EXE, MAX_PATH * 2).toString('utf16le');
  const end = exe.indexOf('\0');
  return { pid: data.getUint32(ENTRY_PID, true), ppid: data.getUint32(ENTRY_PARENT, true), name: end < 0 ? exe : exe.slice(0, end) };
}

/** The Win32 calls a scan makes; koffi binds them, tests replace them. */
export interface Win32Api {
  // GetExtendedTcpTable into buffer (null: the size query); size[0] in, the needed size out
  getExtendedTcpTable(buffer: Buffer | null, size: Uint32Array, family: number): number;
  // the processes of a toolhelp snapshot
  processes(): ProcessEntry[];
  // whether the process's token user is this process's; false for a process this user cannot open
  ownedByCurrentUser(pid: number): boolean;
}

/** GetExtendedTcpTable, growing the buffer while the table outgrows it (gopsutil's getTableUintptr loop). */
export function readTcpTable(api: Pick<Win32Api, 'getExtendedTcpTable'>, family: number): Buffer {
  const size = new Uint32Array([0]);
  let result = api.getExtendedTcpTable(null, size, family);
  for (let attempt = 0; attempt < MAX_TABLE_ATTEMPTS; attempt++) {
    if (result !== ERROR_INSUFFICIENT_BUFFER && result !== NO_ERROR) throw new Error(`GetExtendedTcpTable failed with ${result}`);
    const buffer = Buffer.alloc(Math.max(size[0]!, 4));
    result = api.getExtendedTcpTable(buffer, size, family);
    if (result === NO_ERROR) return buffer;
  }
  throw new Error(`GetExtendedTcpTable kept outgrowing its buffer after ${MAX_TABLE_ATTEMPTS} attempts`);
}

export function scanWin32Listeners(api: Win32Api = loadWin32Api()): PortCandidate[] {
  const rows = [...parseTcp4Table(readTcpTable(api, AF_INET)), ...parseTcp6Table(readTcpTable(api, AF_INET6))];
  const owned = new Map<number, boolean>();
  const mine = rows.filter((row) => {
    if (!owned.has(row.pid)) owned.set(row.pid, api.ownedByCurrentUser(row.pid));
    return owned.get(row.pid);
  });
  if (mine.length === 0) return [];
  const table = new Map(api.processes().map((entry) => [entry.pid, entry]));
  return mine.map((row) => {
    const process = describeProcess(row.pid, table);
    return { port: row.port, bindAddress: row.bindAddress, family: row.family, host: loopbackOf(row.bindAddress, row.family), pid: row.pid, ...(process ? { process } : {}) };
  });
}

type Handle = bigint;

// QueryFullProcessImageNameW's buffer, in UTF-16 units: the longest path Windows names
const MAX_IMAGE_PATH = 32_768;
let imageReader: ((pid: number) => string | undefined) | undefined;

/** A reader of a process's full image path through QueryFullProcessImageNameW; undefined for a process this user cannot open. */
export function loadImageNameReader(): (pid: number) => string | undefined {
  if (imageReader) return imageReader;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require('koffi') as KoffiModule;
  const kernel32 = koffi.load('kernel32.dll');
  const openProcess = kernel32.func('__stdcall', 'OpenProcess', 'void*', ['uint32', 'bool', 'uint32']) as (access: number, inherit: boolean, pid: number) => Handle | null;
  const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'int', ['void*']) as (handle: Handle) => number;
  const queryImageName = kernel32.func('__stdcall', 'QueryFullProcessImageNameW', 'int', ['void*', 'uint32', 'void*', '_Inout_ uint32*']) as (process: Handle, flags: number, name: Buffer, size: [number]) => number;
  imageReader = (pid) => {
    const process = openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (!process) return undefined;
    try {
      const name = Buffer.alloc(MAX_IMAGE_PATH * 2);
      const size: [number] = [MAX_IMAGE_PATH];
      if (queryImageName(process, 0, name, size) === 0) return undefined;
      return name.subarray(0, size[0] * 2).toString('utf16le');
    } finally {
      closeHandle(process);
    }
  };
  return imageReader;
}

interface KoffiModule {
  load: (library: string) => { func: (convention: string, name: string, result: string, parameters: string[]) => unknown };
  decode: (value: Buffer, type: string) => unknown;
}

let bound: Win32Api | undefined;

/** koffi's bindings, made once; koffi is required lazily so no POSIX daemon loads it. */
export function loadWin32Api(): Win32Api {
  if (bound) return bound;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require('koffi') as KoffiModule;
  const iphlpapi = koffi.load('iphlpapi.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const advapi32 = koffi.load('advapi32.dll');
  const getExtendedTcpTable = iphlpapi.func('__stdcall', 'GetExtendedTcpTable', 'uint32', ['void*', 'uint32*', 'int', 'uint32', 'int', 'uint32']) as (table: Buffer | null, size: Uint32Array, order: number, family: number, kind: number, reserved: number) => number;
  const createSnapshot = kernel32.func('__stdcall', 'CreateToolhelp32Snapshot', 'void*', ['uint32', 'uint32']) as (flags: number, pid: number) => Handle;
  const process32First = kernel32.func('__stdcall', 'Process32FirstW', 'int', ['void*', 'void*']) as (snapshot: Handle, entry: Buffer) => number;
  const process32Next = kernel32.func('__stdcall', 'Process32NextW', 'int', ['void*', 'void*']) as (snapshot: Handle, entry: Buffer) => number;
  const openProcess = kernel32.func('__stdcall', 'OpenProcess', 'void*', ['uint32', 'bool', 'uint32']) as (access: number, inherit: boolean, pid: number) => Handle | null;
  const getCurrentProcess = kernel32.func('__stdcall', 'GetCurrentProcess', 'void*', []) as () => Handle;
  const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'int', ['void*']) as (handle: Handle) => number;
  const openProcessToken = advapi32.func('__stdcall', 'OpenProcessToken', 'int', ['void*', 'uint32', '_Out_ void**']) as (process: Handle, access: number, token: [Handle | null]) => number;
  const getTokenInformation = advapi32.func('__stdcall', 'GetTokenInformation', 'int', ['void*', 'int', 'void*', 'uint32', '_Out_ uint32*']) as (token: Handle, kind: number, info: Buffer | null, length: number, needed: [number]) => number;
  const equalSid = advapi32.func('__stdcall', 'EqualSid', 'int', ['void*', 'void*']) as (first: unknown, second: unknown) => number;

  // TOKEN_USER is a SID_AND_ATTRIBUTES whose Sid pointer points into the same buffer: the SID is read through that pointer,
  // and the buffer is kept alive as long as the pointer is used
  const tokenUser = (process: Handle): { readonly buffer: Buffer; readonly sid: unknown } | undefined => {
    const token: [Handle | null] = [null];
    if (openProcessToken(process, TOKEN_QUERY, token) === 0 || token[0] === null) return undefined;
    try {
      const needed: [number] = [0];
      getTokenInformation(token[0], TOKEN_USER, null, 0, needed);
      const info = Buffer.alloc(needed[0]);
      if (getTokenInformation(token[0], TOKEN_USER, info, info.length, needed) === 0) return undefined;
      return { buffer: info, sid: koffi.decode(info, 'void*') };
    } finally {
      closeHandle(token[0]);
    }
  };
  const own = tokenUser(getCurrentProcess());
  if (!own) throw new Error("Reading this process's token user failed");
  bound = {
    getExtendedTcpTable: (buffer, size, family) => getExtendedTcpTable(buffer, size, 0, family, TCP_TABLE_OWNER_PID_LISTENER, 0),
    processes: () => {
      const snapshot = createSnapshot(TH32CS_SNAPPROCESS, 0);
      // INVALID_HANDLE_VALUE, which koffi returns as an unsigned pointer
      if (snapshot === 0xffffffffffffffffn) throw new Error('CreateToolhelp32Snapshot failed');
      try {
        const entries: ProcessEntry[] = [];
        const entry = Buffer.alloc(PROCESS_ENTRY_BYTES);
        entry.writeUInt32LE(PROCESS_ENTRY_BYTES, 0);
        for (let more = process32First(snapshot, entry); more !== 0; more = process32Next(snapshot, entry)) entries.push(parseProcessEntry(entry));
        return entries;
      } finally {
        closeHandle(snapshot);
      }
    },
    ownedByCurrentUser: (pid) => {
      const process = openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (!process) return false;
      try {
        const user = tokenUser(process);
        return user !== undefined && equalSid(user.sid, own.sid) !== 0;
      } finally {
        closeHandle(process);
      }
    },
  };
  return bound;
}
