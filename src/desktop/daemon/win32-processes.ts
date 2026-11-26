// Windows processes through kernel32 and ntdll over koffi, required lazily behind the win32 check (docs/invariants.md "koffi is
// required lazily, behind the win32 check, and its failure is reported rather than swallowed"): a load or call failure throws
// to the caller, and a later call tries the load again.

// koffi 3 hands a pointer, and so a HANDLE, as a BigInt
type Handle = bigint;

const PROCESS_TERMINATE = 0x0001;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x0010_0000;
// OpenProcess's error for a pid no process has
const ERROR_INVALID_PARAMETER = 87;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
// what the kill makes the exit code, as Node's process.kill and taskkill /F do
const KILLED_EXIT_CODE = 1;
// NtTerminateProcess's answer for a process another kill or its own exit already ends; TerminateProcess reports it as access
// denied, while the handle is not yet signalled
const STATUS_PROCESS_IS_TERMINATING = 0xc000_010a;
const FILETIME_BYTES = 8;
const SYSTEM_PROCESS_INFORMATION = 5;
const STATUS_INFO_LENGTH_MISMATCH = 0xc000_0004;
const PROCESS_LIST_START_BYTES = 1 << 20;
// SYSTEM_PROCESS_INFORMATION's field offsets on 64-bit Windows, which every Damocles build targets (phnt ntexapi.h)
const NEXT_ENTRY_OFFSET = 0;
const CREATE_TIME_OFFSET = 32;
const UNIQUE_PROCESS_ID_OFFSET = 80;
const PARENT_PROCESS_ID_OFFSET = 88;

/** A process held open: its pid names it, and no other process, until close. */
export interface OpenedProcess {
  readonly pid: number;
  // the creation time in FILETIME ticks (100 ns since 1601, UTC)
  readonly created: bigint;
  // NtTerminateProcess through the handle; throws unless it ends the process or the process was already ending
  terminate(): void;
  close(): void;
}

/** A process as the system process list recorded it: ppid is the pid of its parent at its start, which a later process may have. */
export interface SystemProcess {
  readonly pid: number;
  readonly ppid: number;
  // the creation time in FILETIME ticks, as OpenedProcess.created reads it
  readonly created: bigint;
}

export interface Win32Processes {
  // the running process of pid, opened for reading (and for TerminateProcess with terminate); undefined when no process has
  // the pid or it has exited; throws when it cannot be opened
  open(pid: number, terminate: boolean): OpenedProcess | undefined;
  // every process, read in one NtQuerySystemInformation call, which needs no access to any of them
  list(): SystemProcess[];
}

interface KoffiModule {
  load: (library: string) => { func: (convention: string, name: string, result: string, parameters: string[]) => unknown };
}

// Win32 BOOL is a 4-byte int, so it is bound as int and compared with zero
export interface Kernel32 {
  openProcess: (access: number, inherit: boolean, pid: number) => Handle | null;
  getProcessTimes: (process: Handle, creation: Buffer, exit: Buffer, kernel: Buffer, user: Buffer) => number;
  waitForSingleObject: (handle: Handle, milliseconds: number) => number;
  // ntdll's, answering an NTSTATUS
  terminateProcess: (process: Handle, exitStatus: number) => number;
  closeHandle: (handle: Handle) => number;
  // koffi keeps the thread's last error from Node and V8 between its calls
  getLastError: () => number;
  // ntdll's, answering an NTSTATUS
  querySystemInformation: (informationClass: number, information: Buffer, length: number, returned: Buffer) => number;
}

let bound: Win32Processes | undefined;

function bind(): Kernel32 {
  if (process.platform !== 'win32') throw new Error('kernel32 exists only on Windows');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require('koffi') as KoffiModule;
  const kernel32 = koffi.load('kernel32.dll');
  const ntdll = koffi.load('ntdll.dll');
  return {
    openProcess: kernel32.func('__stdcall', 'OpenProcess', 'void*', ['uint32', 'bool', 'uint32']) as Kernel32['openProcess'],
    getProcessTimes: kernel32.func('__stdcall', 'GetProcessTimes', 'int', ['void*', 'void*', 'void*', 'void*', 'void*']) as Kernel32['getProcessTimes'],
    waitForSingleObject: kernel32.func('__stdcall', 'WaitForSingleObject', 'uint32', ['void*', 'uint32']) as Kernel32['waitForSingleObject'],
    terminateProcess: ntdll.func('__stdcall', 'NtTerminateProcess', 'uint32', ['void*', 'int32']) as Kernel32['terminateProcess'],
    closeHandle: kernel32.func('__stdcall', 'CloseHandle', 'int', ['void*']) as Kernel32['closeHandle'],
    getLastError: kernel32.func('__stdcall', 'GetLastError', 'uint32', []) as Kernel32['getLastError'],
    querySystemInformation: ntdll.func('__stdcall', 'NtQuerySystemInformation', 'uint32', ['int32', 'void*', 'uint32', 'void*']) as Kernel32['querySystemInformation'],
  };
}

/** The entries of a SystemProcessInformation buffer, each found at the previous one's NextEntryOffset until one answers 0. */
export function parseProcessInformation(information: Buffer): SystemProcess[] {
  const processes: SystemProcess[] = [];
  for (let at = 0; ; ) {
    processes.push({
      pid: Number(information.readBigUInt64LE(at + UNIQUE_PROCESS_ID_OFFSET)),
      ppid: Number(information.readBigUInt64LE(at + PARENT_PROCESS_ID_OFFSET)),
      created: information.readBigUInt64LE(at + CREATE_TIME_OFFSET),
    });
    const next = information.readUInt32LE(at + NEXT_ENTRY_OFFSET);
    if (next === 0) return processes;
    at += next;
  }
}

export function processesOf(api: Kernel32): Win32Processes {
  const failed = (call: string, pid: number): Error => new Error(`${call}(${pid}) failed with Win32 error ${api.getLastError()}`);
  // WaitForSingleObject with no wait: signalled once the process exited, while its object lives on for each open handle
  const exited = (handle: Handle, pid: number): boolean => {
    const wait = api.waitForSingleObject(handle, 0);
    if (wait !== WAIT_OBJECT_0 && wait !== WAIT_TIMEOUT) throw failed('WaitForSingleObject', pid);
    return wait === WAIT_OBJECT_0;
  };
  return {
    open: (pid, terminate) => {
      const handle = api.openProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE | (terminate ? PROCESS_TERMINATE : 0), false, pid);
      if (!handle) {
        const code = api.getLastError();
        if (code === ERROR_INVALID_PARAMETER) return undefined;
        throw new Error(`OpenProcess(${pid}) failed with Win32 error ${code}`);
      }
      try {
        if (exited(handle, pid)) {
          api.closeHandle(handle);
          return undefined;
        }
        const times = Array.from({ length: 4 }, () => Buffer.alloc(FILETIME_BYTES));
        if (api.getProcessTimes(handle, times[0]!, times[1]!, times[2]!, times[3]!) === 0) throw failed('GetProcessTimes', pid);
        let open = true;
        return {
          pid,
          created: times[0]!.readBigUInt64LE(0),
          terminate: () => {
            const status = api.terminateProcess(handle, KILLED_EXIT_CODE);
            if (status !== 0 && status !== STATUS_PROCESS_IS_TERMINATING) throw new Error(`NtTerminateProcess(${pid}) failed with NTSTATUS 0x${status.toString(16)}`);
          },
          close: () => {
            if (open) api.closeHandle(handle);
            open = false;
          },
        };
      } catch (err) {
        api.closeHandle(handle);
        throw err;
      }
    },
    // the list grows between the call that sizes it and the next, so each retry asks for more than the size answered
    list: () => {
      const returned = Buffer.alloc(4);
      for (let bytes = PROCESS_LIST_START_BYTES; ; ) {
        const information = Buffer.alloc(bytes);
        const status = api.querySystemInformation(SYSTEM_PROCESS_INFORMATION, information, bytes, returned);
        if (status === 0) return parseProcessInformation(information);
        if (status !== STATUS_INFO_LENGTH_MISMATCH) throw new Error(`NtQuerySystemInformation failed with NTSTATUS 0x${status.toString(16)}`);
        bytes = Math.max(bytes * 2, returned.readUInt32LE(0) + PROCESS_LIST_START_BYTES / 4);
      }
    },
  };
}

/** kernel32's process calls, bound once they bind. */
export function win32Processes(): Win32Processes {
  bound ??= processesOf(bind());
  return bound;
}
