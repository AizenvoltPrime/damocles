import { describe, expect, it } from 'vitest';
import { parseProcessEntry, parseTcp4Table, parseTcp6Table, PROCESS_ENTRY_BYTES, readTcpTable, scanWin32Listeners, TCP4_ROW_BYTES, TCP6_ROW_BYTES, type Win32Api } from '../win32-ports';
import type { ProcessEntry } from '../process-label';

// GetExtendedTcpTable(TCP_TABLE_OWNER_PID_LISTENER) answers captured on Windows 11 build 26300 (x64): the count, then rows
const CAPTURED_V4 = Buffer.from('030000000100000000000000008700000000000000000000e808000006000000000000000883000000000000000000002c11000002000000000000000d3d00000000000000000000c82a0000', 'hex');
const CAPTURED_V6 = Buffer.from('0200000000000000000000000000000000000000000000000087000000000000000000000000000000000000000000000000000002000000e8080000000000000000000000000000000000000000000001bd00000000000000000000000000000000000000000000000000000100000004000000', 'hex');

// one MIB_TCPROW_OWNER_PID: the address in network order, the port in network order in the DWORD's low 16 bits
function row4(address: readonly number[], port: number, pid: number): Buffer {
  const row = Buffer.alloc(TCP4_ROW_BYTES);
  row.writeUInt32LE(2, 0);
  Buffer.from(address).copy(row, 4);
  row.writeUInt16BE(port, 8);
  row.writeUInt32LE(pid, 20);
  return row;
}

function row6(address: Buffer, port: number, pid: number): Buffer {
  const row = Buffer.alloc(TCP6_ROW_BYTES);
  address.copy(row, 0);
  row.writeUInt16BE(port, 20);
  row.writeUInt32LE(2, 48);
  row.writeUInt32LE(pid, 52);
  return row;
}

const table = (rows: readonly Buffer[]): Buffer => {
  const count = Buffer.alloc(4);
  count.writeUInt32LE(rows.length);
  return Buffer.concat([count, ...rows]);
};

function entry(pid: number, ppid: number, exe: string): Buffer {
  const buffer = Buffer.alloc(PROCESS_ENTRY_BYTES);
  buffer.writeUInt32LE(PROCESS_ENTRY_BYTES, 0);
  buffer.writeUInt32LE(pid, 8);
  buffer.writeUInt32LE(ppid, 32);
  buffer.write(`${exe}\0`, 44, 'utf16le');
  return buffer;
}

describe('the Windows TCP tables', () => {
  it('reads the captured IPv4 listener rows: wildcard address, port byte order and owning pid', () => {
    expect(parseTcp4Table(CAPTURED_V4)).toEqual([
      { bindAddress: '0.0.0.0', port: 135, pid: 2280, family: 4 },
      { bindAddress: '0.0.0.0', port: 2179, pid: 4396, family: 4 },
      { bindAddress: '0.0.0.0', port: 3389, pid: 10952, family: 4 },
    ]);
  });

  it('reads the captured IPv6 listener rows', () => {
    expect(parseTcp6Table(CAPTURED_V6)).toEqual([
      { bindAddress: '::', port: 135, pid: 2280, family: 6 },
      { bindAddress: '::', port: 445, pid: 4, family: 6 },
    ]);
  });

  it('reads a loopback address and a port whose two bytes differ in their own order', () => {
    expect(parseTcp4Table(table([row4([127, 0, 0, 1], 5173, 4321)]))).toEqual([{ bindAddress: '127.0.0.1', port: 5173, pid: 4321, family: 4 }]);
    const loopback = Buffer.alloc(16);
    loopback[15] = 1;
    expect(parseTcp6Table(table([row6(loopback, 0x1f90, 7)]))).toEqual([{ bindAddress: '::1', port: 8080, pid: 7, family: 6 }]);
    const mapped = Buffer.from('00000000000000000000ffff7f000001', 'hex');
    expect(parseTcp6Table(table([row6(mapped, 3000, 9)]))[0]?.bindAddress).toBe('::ffff:7f00:1');
  });

  it('refuses a count the buffer cannot hold', () => {
    const short = table([row4([127, 0, 0, 1], 1, 1)]);
    short.writeUInt32LE(2, 0);
    expect(() => parseTcp4Table(short)).toThrow('cannot hold 2 rows');
  });

  it('grows the buffer and calls again while the table outgrows it', () => {
    const answer = table([row4([127, 0, 0, 1], 8000, 1)]);
    const sizes: number[] = [];
    let growing = 2;
    const api = {
      getExtendedTcpTable: (buffer: Buffer | null, size: Uint32Array) => {
        sizes.push(buffer?.length ?? 0);
        // another socket opened between the size query and the read, twice
        if (buffer === null || buffer.length < answer.length || growing-- > 0) {
          size[0] = (buffer?.length ?? answer.length - 8) + 4;
          return 122;
        }
        answer.copy(buffer);
        return 0;
      },
    };
    expect(parseTcp4Table(readTcpTable(api, 2))).toEqual([{ bindAddress: '127.0.0.1', port: 8000, pid: 1, family: 4 }]);
    expect(sizes.length).toBeGreaterThan(2);
  });

  it('reads a PROCESSENTRY32W', () => {
    expect(parseProcessEntry(entry(4321, 77, 'node.exe'))).toEqual({ pid: 4321, ppid: 77, name: 'node.exe' });
  });

  it('lists only sockets the user\'s processes own, labelled by what the user\'s shell started', () => {
    const processes: ProcessEntry[] = [
      { pid: 10, ppid: 1, name: 'WindowsTerminal.exe' },
      { pid: 20, ppid: 10, name: 'pwsh.exe' },
      { pid: 30, ppid: 20, name: 'npm.cmd' },
      { pid: 40, ppid: 30, name: 'node.exe' },
    ];
    const api: Win32Api = {
      getExtendedTcpTable: (buffer, size, family) => {
        const answer = family === 2 ? table([row4([0, 0, 0, 0], 135, 2280), row4([127, 0, 0, 1], 5173, 40)]) : table([]);
        if (buffer === null || buffer.length < answer.length) {
          size[0] = answer.length;
          return 122;
        }
        answer.copy(buffer);
        return 0;
      },
      processes: () => processes,
      ownedByCurrentUser: (pid) => pid === 40,
    };
    expect(scanWin32Listeners(api)).toEqual([{ port: 5173, bindAddress: '127.0.0.1', family: 4, host: '127.0.0.1', pid: 40, process: { name: 'node.exe', command: 'npm.cmd' } }]);
  });
});
