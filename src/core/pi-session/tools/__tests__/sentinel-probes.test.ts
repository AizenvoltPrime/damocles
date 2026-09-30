import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import {
  darwinProbe,
  killGroupWithSigkill,
  linuxProbe,
  parseDarwinRow,
  readLinuxEntry,
  sweep,
  type GroupAnchors,
  type ProcessProbe,
} from '../shell-sentinel';

// The probes are the two things in the sentinel that talk to the kernel, so both reads are faked here.
vi.mock('node:fs', () => ({ readFileSync: vi.fn(), readdirSync: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

const readFileMock = vi.mocked(readFileSync);
const readdirMock = vi.mocked(readdirSync);
const execFileMock = vi.mocked(execFileSync);

/** A `/proc/<pid>/stat` line with the fields the probe reads placed at the offsets it uses. */
function statLine(pid: number, comm: string, pgid: number, startTime: string): string {
  const fields = Array.from({ length: 50 }, (_, index) => String(index));
  fields[0] = 'S';
  fields[2] = String(pgid);
  fields[19] = startTime;
  return `${pid} (${comm}) ${fields.join(' ')}\n`;
}

let stderrWrites: string[];

beforeEach(() => {
  readFileMock.mockReset();
  readdirMock.mockReset();
  execFileMock.mockReset();
  stderrWrites = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    stderrWrites.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the linux probe reads /proc', () => {
  it.each([
    ['an ordinary comm', 'bash', 700, '90210'],
    ['a comm holding the field separator', 'weird) (name', 700, '90210'],
    ['a comm that is only punctuation', ') (', 4242, '1'],
  ])('takes pgid and start time from the fields after the comm, with %s', (_label, comm, pgid, startTime) => {
    readFileMock.mockReturnValue(statLine(4242, comm, pgid, startTime));

    // The comm is the only field that can hold spaces or brackets, so everything is offset from its close.
    expect(readLinuxEntry(4242)).toEqual({ pid: 4242, pgid, startedAt: startTime });
  });

  it('reports a pid that vanished between the directory read and the stat read as absent', () => {
    readFileMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    expect(readLinuxEntry(4242)).toBeNull();
    expect(linuxProbe.startedAt(4242)).toBeNull();
  });

  it('lists only the numeric entries of /proc', () => {
    readdirMock.mockReturnValue(['1', 'self', 'cpuinfo', '4242'] as unknown as ReturnType<typeof readdirSync>);
    readFileMock.mockImplementation((file) => statLine(Number(String(file).split('/')[2]), 'bash', 700, '90210'));

    expect(linuxProbe.list()).toEqual([
      { pid: 1, pgid: 700, startedAt: '90210' },
      { pid: 4242, pgid: 700, startedAt: '90210' },
    ]);
  });

  it('survives a /proc that cannot be read at all, and says so on stderr', () => {
    // This probe backs every non-darwin POSIX platform, several of which have no /proc to read. A throw
    // here reaches the stdin end handler, and the sweep this process exists for would never run.
    readdirMock.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: no such file or directory, scandir '/proc'"), { code: 'ENOENT' });
    });

    expect(() => linuxProbe.list()).not.toThrow();
    expect(linuxProbe.list()).toEqual([]);
    expect(stderrWrites.join('')).toContain('/proc');
  });
});

describe('the darwin probe reads ps', () => {
  it.each([
    ['a single-digit day, which ps pads with a second space', 'Thu Jan  9 12:34:56 2025'],
    ['a two-digit day', 'Thu Jan 23 12:34:56 2025'],
  ])('produces one stamp for the same process whether it came from a row or a lookup, for %s', (_label, lstart) => {
    execFileMock.mockReturnValue(`${lstart}\n`);

    const fromLookup = darwinProbe.startedAt(4242);
    const fromRow = parseDarwinRow(`  4242   700 ${lstart}`);

    // The sweep compares these two strings with ===, so any formatting difference silently disables the
    // leader identity rule and the group survives panel close.
    expect(fromRow?.startedAt).toBe(fromLookup);
  });

  it('reports a pid that ps matched nothing for as absent', () => {
    execFileMock.mockImplementation(() => {
      throw new Error('Command failed: /bin/ps');
    });

    expect(darwinProbe.startedAt(4242)).toBeNull();
    expect(darwinProbe.list()).toEqual([]);
  });

  it('parses every row of a listing and skips what is not one', () => {
    execFileMock.mockReturnValue(
      ['  1     1 Thu Jan  9 12:34:56 2025', ' 700   700 Fri Jan 10 01:02:03 2025', ''].join('\n'),
    );

    expect(darwinProbe.list()).toEqual([
      { pid: 1, pgid: 1, startedAt: 'Thu Jan 9 12:34:56 2025' },
      { pid: 700, pgid: 700, startedAt: 'Fri Jan 10 01:02:03 2025' },
    ]);
  });

  it.each([
    ['a short row', '4242 700'],
    ['a header row', 'PID PGID STARTED'],
    ['an empty row', '   '],
  ])('rejects %s', (_label, row) => {
    expect(parseDarwinRow(row)).toBeNull();
  });
});

describe('signalling one group cannot abandon the others', () => {
  function errno(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`kill ${code}`), { code });
  }

  it('treats ESRCH as the group already being gone and says nothing about it', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errno('ESRCH');
    });

    expect(() => killGroupWithSigkill(700)).not.toThrow();
    expect(kill).toHaveBeenCalledWith(-700, 'SIGKILL');
    expect(stderrWrites).toEqual([]);
  });

  it('reports any other errno and carries on, so the groups after it are still signalled', () => {
    // A group whose only surviving member dropped privileges answers EPERM. Unwinding out of the sweep
    // there would leave every group after it in the map running, which is the whole failure this
    // process exists to prevent.
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid): true => {
      if (pid === -700) throw errno('EPERM');
      return true;
    });
    const table = [
      { pid: 700, pgid: 700, startedAt: 'stamp-700' },
      { pid: 800, pgid: 800, startedAt: 'stamp-800' },
    ];
    const probe: ProcessProbe = {
      startedAt: (pid) => table.find((row) => row.pid === pid)?.startedAt ?? null,
      list: () => table,
    };
    const groups = new Map<number, GroupAnchors>([
      [700, { leaderStartedAt: 'stamp-700', members: [] }],
      [800, { leaderStartedAt: 'stamp-800', members: [] }],
    ]);

    // 700 is reported rather than claimed, and 800 is still reached.
    expect(sweep(groups, probe, killGroupWithSigkill)).toEqual([800]);
    expect(kill).toHaveBeenCalledWith(-700, 'SIGKILL');
    expect(kill).toHaveBeenCalledWith(-800, 'SIGKILL');
    expect(stderrWrites.join('')).toContain('700');
  });
});
