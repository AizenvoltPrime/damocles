import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { parseProcessInformation, processesOf, win32Processes, type Kernel32 } from '../win32-processes';

// a 64-bit SYSTEM_PROCESS_INFORMATION entry with the fields the list reads; next is the offset of the entry after it, 0 for the last
function entry(next: number, pid: number, ppid: number, created: bigint): Buffer {
  const bytes = Buffer.alloc(next || 256);
  bytes.writeUInt32LE(next, 0);
  bytes.writeBigUInt64LE(created, 32);
  bytes.writeBigUInt64LE(BigInt(pid), 80);
  bytes.writeBigUInt64LE(BigInt(ppid), 88);
  return bytes;
}

describe('the Windows system process list', () => {
  it('reads each entry\'s pid, parent pid and creation time, following NextEntryOffset to the entry whose offset is 0', () => {
    const list = Buffer.concat([entry(0x140, 0, 0, 0n), entry(0x120, 4, 0, 5n), entry(0, 9876, 4, 133_000_000_000_000_000n)]);
    expect(parseProcessInformation(list)).toEqual([
      { pid: 0, ppid: 0, created: 0n },
      { pid: 4, ppid: 0, created: 5n },
      { pid: 9876, ppid: 4, created: 133_000_000_000_000_000n },
    ]);
  });

  it.runIf(process.platform === 'win32')('lists this process with its parent and the creation time its handle reads', () => {
    const processes = win32Processes();
    const self = processes.list().find((candidate) => candidate.pid === process.pid);
    const opened = processes.open(process.pid, false)!;
    try {
      expect(self).toEqual({ pid: process.pid, ppid: process.ppid, created: opened.created });
    } finally {
      opened.close();
    }
  });
});

// a running process whose NtTerminateProcess answers status
function terminating(status: number): Kernel32 {
  return {
    openProcess: () => 1n,
    getProcessTimes: (_process, creation) => {
      creation.writeBigUInt64LE(1000n);
      return 1;
    },
    waitForSingleObject: () => 258,
    terminateProcess: () => status,
    closeHandle: () => 1,
    getLastError: () => 0,
    querySystemInformation: () => 0,
  };
}

describe('ending a Windows process', () => {
  // A second kill lands there while the first one's threads are still being torn down, before the handle is signalled.
  it('counts a process whose termination is already under way as ended', () => {
    expect(() => processesOf(terminating(0)).open(42, true)!.terminate()).not.toThrow();
    expect(() => processesOf(terminating(0xc000_010a)).open(42, true)!.terminate()).not.toThrow();
  });

  it.runIf(process.platform === 'win32')('ends a running process, and again through the same handle while it is ending or ended', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    await once(child, 'spawn');
    const exit = once(child, 'exit');
    const opened = win32Processes().open(child.pid!, true)!;
    try {
      opened.terminate();
      opened.terminate();
      await exit;
      opened.terminate();
    } finally {
      opened.close();
    }
    expect(child.exitCode).toBe(1);
  });

  it('throws any other status, naming it', () => {
    expect(() => processesOf(terminating(0xc000_0022)).open(42, true)!.terminate()).toThrow('NtTerminateProcess(42) failed with NTSTATUS 0xc0000022');
  });
});
