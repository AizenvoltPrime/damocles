import { describe, expect, it } from 'vitest';
import { parseProcessInformation, win32Processes } from '../win32-processes';

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
