import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { runSentinel, sweep, type GroupAnchors, type ProcessEntry, type ProcessProbe } from '../shell-sentinel';
import { startShellSentinel } from '../shell-sentinel-client';
import { log } from '../../../logger';

const harness = vi.hoisted(() => ({ child: undefined as unknown as ChildProcess }));

// The client's only reach outside itself, faked so this file owns both ends of the panel's pipe.
vi.mock('child_process', () => ({ spawn: vi.fn(() => harness.child) }));
vi.mock('../../../logger', () => ({ log: vi.fn() }));

/** A `ChildProcess` with only the members `startShellSentinel` touches. */
function fakeChild(): { child: ChildProcess; stdin: PassThrough; stderr: PassThrough } {
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stderr, unref: (): void => {}, pid: 4242 }) as unknown as ChildProcess;
  return { child, stdin, stderr };
}

function entry(pid: number, pgid: number, startedAt: string): ProcessEntry {
  return { pid, pgid, startedAt };
}

function group(leaderStartedAt: string | null, members: ReadonlyArray<[number, string]>): GroupAnchors {
  return { leaderStartedAt, members: members.map(([pid, startedAt]) => ({ pid, startedAt })) };
}

/** A probe over a table this file can swap between the `x` snapshot and the sweep. */
function mutableProbe(table: ProcessEntry[]): { probe: ProcessProbe; set: (rows: ProcessEntry[]) => void } {
  let rows = table;
  return {
    probe: {
      startedAt: (pid) => rows.find((row) => row.pid === pid)?.startedAt ?? null,
      list: () => rows,
    },
    set: (next) => {
      rows = next;
    },
  };
}

function probeOver(table: readonly ProcessEntry[]): ProcessProbe {
  return {
    startedAt: (pid) => table.find((row) => row.pid === pid)?.startedAt ?? null,
    list: () => table,
  };
}

beforeEach(() => {
  vi.mocked(spawn).mockClear();
});

describe('the sweep signals only a group it has positively identified', () => {
  it('signals when the leader is alive and is still the same process', () => {
    const killed: number[] = [];
    const table = [entry(500, 500, 'stamp-500'), entry(501, 500, 'stamp-501')];

    const signalled = sweep(new Map([[500, group('stamp-500', [])]]), probeOver(table), (pgid) => killed.push(pgid));

    expect(killed).toEqual([500]);
    expect(signalled).toEqual([500]);
  });

  it('signals when the leader is gone but a member anchor still matches', () => {
    // `sleep 600 &` with bash already exited. The member anchor taken when the shell exited is the whole
    // reason this can be signalled at all: one identified survivor proves the pgid was never recycled.
    const killed: number[] = [];
    const table = [entry(801, 800, 'stamp-801'), entry(802, 800, 'stamp-802')];

    const signalled = sweep(new Map([[800, group('stamp-800', [[801, 'stamp-801']])]]), probeOver(table), (pgid) =>
      killed.push(pgid),
    );

    expect(killed).toEqual([800]);
    expect(signalled).toEqual([800]);
  });

  it('does NOT signal when the leader is gone and no member anchor matches, while a sibling that matches is signalled', () => {
    // The case the member anchor exists to close. Group 900's pid space wrapped: processes carry pgid 900
    // but none of them is one we anchored, so they are a stranger's. Signalling would be data loss.
    const killed: number[] = [];
    const table = [
      entry(901, 900, 'stamp-STRANGER-A'),
      entry(902, 900, 'stamp-STRANGER-B'),
      entry(701, 700, 'stamp-701'),
    ];
    const groups = new Map([
      [900, group('stamp-900', [[901, 'stamp-OURS']])],
      [700, group('stamp-700', [[701, 'stamp-701']])],
    ]);

    const signalled = sweep(groups, probeOver(table), (pgid) => killed.push(pgid));

    expect(killed).toEqual([700]);
    expect(signalled).toEqual([700]);
    expect(killed).not.toContain(900);
  });

  it('does NOT signal a group whose identity check fails on every anchor it has', () => {
    // Leader pid recycled AND the one member anchor is stale. Nothing here is ours.
    const killed: number[] = [];
    const table = [entry(600, 600, 'stamp-RECYCLED'), entry(601, 600, 'stamp-ALSO-NOT-OURS')];

    const signalled = sweep(new Map([[600, group('stamp-ORIGINAL', [[601, 'stamp-OURS']])]]), probeOver(table), (pgid) =>
      killed.push(pgid),
    );

    expect(killed).toEqual([]);
    expect(signalled).toEqual([]);
  });

  it('falls through to the member anchors when the leader pid is alive but mismatched', () => {
    // A pid reused as a leader says nothing about whether our group emptied, so this must not stop the
    // sweep. Rule 1 failing has to fall to rule 2 rather than refuse outright.
    const killed: number[] = [];
    const table = [entry(1000, 1000, 'stamp-SOMEONE-ELSE'), entry(1001, 1000, 'stamp-1001')];

    const signalled = sweep(new Map([[1000, group('stamp-ORIGINAL', [[1001, 'stamp-1001']])]]), probeOver(table), (pgid) =>
      killed.push(pgid),
    );

    expect(killed).toEqual([1000]);
    expect(signalled).toEqual([1000]);
  });

  it('signals nothing for a group whose members had already gone when the shell exited', () => {
    const killed: number[] = [];

    const signalled = sweep(new Map([[1100, group('stamp-1100', [])]]), probeOver([entry(1, 1, 'stamp-init')]), (pgid) =>
      killed.push(pgid),
    );

    expect(killed).toEqual([]);
    expect(signalled).toEqual([]);
  });

  it('goes on to the next group when signalling one of them throws', () => {
    // Every group in the map is signalled from one loop, so an unkillable group must not take the
    // groups after it down with it. That is the same abandoned cleanup the pipe handlers guard against.
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const attempted: number[] = [];
    const table = [entry(700, 700, 'stamp-700'), entry(800, 800, 'stamp-800'), entry(900, 900, 'stamp-900')];
    const groups = new Map([
      [700, group('stamp-700', [])],
      [800, group('stamp-800', [])],
      [900, group('stamp-900', [])],
    ]);

    const signalled = sweep(groups, probeOver(table), (pgid) => {
      attempted.push(pgid);
      if (pgid === 800) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    });

    expect(attempted).toEqual([700, 800, 900]);
    // The one that threw is not claimed as signalled, and the failure is reported rather than hidden.
    expect(signalled).toEqual([700, 900]);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('800');
    stderr.mockRestore();
  });

  it('signals nothing when an anchored member pid is alive but started later', () => {
    // The pid came back as a different process. Matching on the pid alone would kill a stranger.
    const killed: number[] = [];
    const table = [entry(1201, 1200, 'stamp-LATER')];

    const signalled = sweep(new Map([[1200, group(null, [[1201, 'stamp-EARLIER']])]]), probeOver(table), (pgid) =>
      killed.push(pgid),
    );

    expect(killed).toEqual([]);
    expect(signalled).toEqual([]);
  });
});

describe('EOF on the pipe is the trigger, and the wire is r and x', () => {
  it('kills nothing until EOF, then kills every group it can still identify', async () => {
    const killed: number[] = [];
    const input = new PassThrough();
    const table = [entry(500, 500, 'stamp-500'), entry(600, 600, 'stamp-600')];

    const done = runSentinel(input, probeOver(table), (pgid) => killed.push(pgid));
    input.write('r500\n');
    input.write('r600\n');
    await new Promise((resolve) => setImmediate(resolve));

    // Registration alone must never kill: a command that is still running owns its group.
    expect(killed).toEqual([]);

    input.end();

    expect(await done).toEqual([500, 600]);
    expect(killed).toEqual([500, 600]);
  });

  it('anchors the members present at the x record, not the members present at EOF', async () => {
    // The snapshot is the identity. Replacing the group's contents after `x` with processes carrying the
    // same pgid and the same pids, but different start times, must not be enough to be signalled.
    const killed: number[] = [];
    const input = new PassThrough();
    const { probe, set } = mutableProbe([entry(700, 700, 'stamp-700'), entry(701, 700, 'stamp-701')]);

    const done = runSentinel(input, probe, (pgid) => killed.push(pgid));
    input.write('r700\n');
    await new Promise((resolve) => setImmediate(resolve));

    // The shell exits: 701 is ours and gets anchored.
    set([entry(701, 700, 'stamp-701')]);
    input.write('x700\n');
    await new Promise((resolve) => setImmediate(resolve));

    // Later the pid space wraps and a stranger occupies the same pid in the same group.
    set([entry(701, 700, 'stamp-STRANGER')]);
    input.end();

    expect(await done).toEqual([]);
    expect(killed).toEqual([]);
  });

  it('signals a group whose shell exited and whose anchored member is still alive', async () => {
    const killed: number[] = [];
    const input = new PassThrough();
    const { probe, set } = mutableProbe([entry(800, 800, 'stamp-800'), entry(801, 800, 'stamp-801')]);

    const done = runSentinel(input, probe, (pgid) => killed.push(pgid));
    input.write('r800\n');
    await new Promise((resolve) => setImmediate(resolve));
    set([entry(801, 800, 'stamp-801')]);
    input.write('x800\n');
    await new Promise((resolve) => setImmediate(resolve));
    input.end();

    expect(await done).toEqual([800]);
    expect(killed).toEqual([800]);
  });

  it('ignores a line that is not r or x followed by digits', async () => {
    const killed: number[] = [];
    const input = new PassThrough();
    const table = [entry(500, 500, 'stamp-500')];

    const done = runSentinel(input, probeOver(table), (pgid) => killed.push(pgid));
    input.write('not-a-record\n500\nr-7\nr0\nq500\nr 500\nr500\n');
    input.end();

    expect(await done).toEqual([500]);
    expect(killed).toEqual([500]);
  });

  it('keeps the anchors of an earlier command when the same pgid is registered again', async () => {
    // Pid reuse across commands is ordinary. Command A backgrounds a daemon and exits, command B later
    // gets the same pid, and B's registration must not throw away the only handle A's daemon has left.
    const killed: number[] = [];
    const input = new PassThrough();
    const { probe, set } = mutableProbe([entry(700, 700, 'stamp-A'), entry(701, 700, 'stamp-daemon')]);

    const done = runSentinel(input, probe, (pgid) => killed.push(pgid));
    input.write('r700\n');
    await new Promise((resolve) => setImmediate(resolve));

    // A's shell exits, leaving the daemon behind and anchored.
    set([entry(701, 700, 'stamp-daemon')]);
    input.write('x700\n');
    await new Promise((resolve) => setImmediate(resolve));

    // B takes the recycled pid 700 and registers it.
    set([entry(700, 700, 'stamp-B'), entry(701, 700, 'stamp-daemon')]);
    input.write('r700\n');
    await new Promise((resolve) => setImmediate(resolve));

    // B's shell has gone by EOF, but A's daemon is still identifiable.
    set([entry(701, 700, 'stamp-daemon')]);
    input.end();

    expect(await done).toEqual([700]);
    expect(killed).toEqual([700]);
  });

  it('lets go of a retained anchor once that process is gone', async () => {
    // Retention is bounded by liveness, or a pgid reused across a long session grows one entry without
    // limit. An anchor missing from the table is dead and could never be matched again anyway.
    const killed: number[] = [];
    const input = new PassThrough();
    const groups = new Map<number, GroupAnchors>();
    const { probe, set } = mutableProbe([entry(600, 600, 'stamp-A'), entry(601, 600, 'stamp-daemon')]);

    const done = runSentinel(input, probe, (pgid) => killed.push(pgid), groups);
    input.write('r600\n');
    await new Promise((resolve) => setImmediate(resolve));
    set([entry(601, 600, 'stamp-daemon')]);
    input.write('x600\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(groups.get(600)?.members).toEqual([{ pid: 601, startedAt: 'stamp-daemon' }]);

    // The daemon dies, a second command takes the recycled pgid, and its own survivor is anchored.
    set([entry(600, 600, 'stamp-B'), entry(602, 600, 'stamp-later')]);
    input.write('r600\n');
    await new Promise((resolve) => setImmediate(resolve));
    set([entry(602, 600, 'stamp-later')]);
    input.write('x600\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(groups.get(600)?.members).toEqual([{ pid: 602, startedAt: 'stamp-later' }]);

    input.end();
    expect(await done).toEqual([600]);
  });

  it('keeps its anchors when the probe fails during an exit record', async () => {
    // A failed probe answers an empty table rather than an error, so an empty table cannot be read as
    // proof that every anchored process died. Reading it that way would drop the group for good.
    const killed: number[] = [];
    const input = new PassThrough();
    const groups = new Map<number, GroupAnchors>();
    const { probe, set } = mutableProbe([entry(500, 500, 'stamp-A'), entry(501, 500, 'stamp-daemon')]);

    const done = runSentinel(input, probe, (pgid) => killed.push(pgid), groups);
    input.write('r500\n');
    await new Promise((resolve) => setImmediate(resolve));
    set([entry(501, 500, 'stamp-daemon')]);
    input.write('x500\n');
    await new Promise((resolve) => setImmediate(resolve));

    // The pgid is recycled, and the probe fails while the second command's exit record is processed.
    set([entry(500, 500, 'stamp-B'), entry(501, 500, 'stamp-daemon')]);
    input.write('r500\n');
    await new Promise((resolve) => setImmediate(resolve));
    set([]);
    input.write('x500\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(groups.get(500)?.members).toEqual([{ pid: 501, startedAt: 'stamp-daemon' }]);

    // The probe recovers before EOF and the daemon is still reachable.
    set([entry(501, 500, 'stamp-daemon')]);
    input.end();

    expect(await done).toEqual([500]);
    expect(killed).toEqual([500]);
  });

  it('never consults the leader stamp again once the shell exit record has arrived', async () => {
    // The stamp is read when the r record is processed, not at spawn, so it can already name a stranger.
    // After x the leader is provably dead, which makes that rule able to produce false positives only.
    const killed: number[] = [];
    const input = new PassThrough();
    const { probe, set } = mutableProbe([entry(800, 800, 'stamp-800'), entry(801, 800, 'stamp-801')]);

    const done = runSentinel(input, probe, (pgid) => killed.push(pgid));
    input.write('r800\n');
    await new Promise((resolve) => setImmediate(resolve));

    set([entry(801, 800, 'stamp-801')]);
    input.write('x800\n');
    await new Promise((resolve) => setImmediate(resolve));

    // Our member has gone and an unrelated process now leads a group under the same number and stamp.
    set([entry(800, 800, 'stamp-800'), entry(802, 800, 'stamp-stranger')]);
    input.end();

    expect(await done).toEqual([]);
    expect(killed).toEqual([]);
  });

  it('drops a group whose shell exited with nothing left to identify it by', async () => {
    // This process outlives every panel it serves, so a session of thousands of commands must not
    // accumulate one entry per command that could never be signalled anyway.
    const killed: number[] = [];
    const input = new PassThrough();
    const groups = new Map<number, GroupAnchors>();
    const { probe, set } = mutableProbe([entry(900, 900, 'stamp-900')]);

    const done = runSentinel(input, probe, (pgid) => killed.push(pgid), groups);
    input.write('r900\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(groups.has(900)).toBe(true);

    set([]);
    input.write('x900\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(groups.has(900)).toBe(false);

    input.end();
    expect(await done).toEqual([]);
  });

  it('sweeps when the pipe errors, because a broken pipe is the same news as EOF', async () => {
    const killed: number[] = [];
    const input = new PassThrough();
    const table = [entry(500, 500, 'stamp-500')];

    const done = runSentinel(input, probeOver(table), (pgid) => killed.push(pgid));
    input.write('r500\n');
    await new Promise((resolve) => setImmediate(resolve));
    input.emit('error', new Error('EPIPE'));

    expect(await done).toEqual([500]);
    expect(killed).toEqual([500]);
  });

  it('resolves rather than dying when the probe throws during the sweep', async () => {
    // A probe throw reaches this handler, and an exception here abandons cleanup for every group at once.
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const input = new PassThrough();
    const probe: ProcessProbe = {
      startedAt: () => 'stamp-500',
      list: () => {
        throw new Error("ENOENT: no such file or directory, scandir '/proc'");
      },
    };

    const done = runSentinel(input, probe, () => {});
    input.end();

    expect(await done).toEqual([]);
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });

  it('ignores an x for a group that was never registered', async () => {
    const killed: number[] = [];
    const input = new PassThrough();
    const table = [entry(901, 900, 'stamp-901')];

    const done = runSentinel(input, probeOver(table), (pgid) => killed.push(pgid));
    input.write('x900\n');
    input.end();

    // Anchoring a group we never registered would invent an identity that was never observed.
    expect(await done).toEqual([]);
    expect(killed).toEqual([]);
  });
});

describe('the host end and the sentinel end, wired together', () => {
  it('launches the sentinel detached with the write end of its stdin held by the host', () => {
    const { child } = fakeChild();
    harness.child = child;

    startShellSentinel();

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(command).toBe(process.execPath);
    expect(String(args![0])).toMatch(/sentinel\.js$/);
    // These three are the whole mechanism: a pipe the host holds, a child that outlives it, and a node
    // interpreter in an Electron host. Losing any one of them loses the guarantee silently.
    expect(options).toMatchObject({
      stdio: ['pipe', 'ignore', 'pipe'],
      detached: true,
      env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
    });
  });

  it('puts what the sentinel writes on stderr into the extension log', async () => {
    // The sentinel is detached with no console, so a discarded stderr leaves a failed probe with no
    // observable at all beyond a bare exit code.
    const { child, stderr } = fakeChild();
    harness.child = child;
    vi.mocked(log).mockClear();

    startShellSentinel();
    stderr.write("[sentinel] /proc could not be read, so no group can be identified: Error: ENOENT\n");
    await new Promise((resolve) => setImmediate(resolve));

    expect(vi.mocked(log).mock.calls.some((call) => String(call[1]).includes('/proc could not be read'))).toBe(true);
  });

  it('writes exactly one r record and one x record, in that order, and nothing else', async () => {
    const { child, stdin } = fakeChild();
    harness.child = child;
    let wire = '';
    stdin.on('data', (chunk: Buffer) => {
      wire += chunk.toString();
    });

    const sentinel = startShellSentinel();
    sentinel.register(4321);
    sentinel.shellExited(4321);
    sentinel.dispose();
    await new Promise((resolve) => setImmediate(resolve));

    // The sentinel's only input validation is a regex on this shape, so the host is the thing that has to
    // be exact. There is no unregistration record and there never is a second writer.
    expect(wire).toBe('r4321\nx4321\n');
  });

  it('FAKED PIPE, not a real kernel: a backgrounded group survives its own call and dies at panel close', async () => {
    // The real form of this needs a live POSIX kernel and runs under WSL. What this pins is that the two
    // modules agree on the wire, and that the member anchor carries a group whose leader has gone.
    const killed: number[] = [];
    const { child, stdin } = fakeChild();
    harness.child = child;
    const { probe, set } = mutableProbe([entry(4321, 4321, 'stamp-leader'), entry(4322, 4321, 'stamp-bg')]);

    const sentinel = startShellSentinel();
    const done = runSentinel(stdin, probe, (pgid) => killed.push(pgid));

    // A shell call starts and registers its group.
    sentinel.register(4321);
    await new Promise((resolve) => setImmediate(resolve));
    expect(killed).toEqual([]);

    // The shell exits, leaving the backgrounded process behind. Ending a call must not kill it.
    set([entry(4322, 4321, 'stamp-bg')]);
    sentinel.shellExited(4321);
    await new Promise((resolve) => setImmediate(resolve));
    expect(killed).toEqual([]);

    // The panel closes. dispose() ends the write end, and that EOF is what does the killing.
    sentinel.dispose();

    expect(await done).toEqual([4321]);
    expect(killed).toEqual([4321]);
  });
});
