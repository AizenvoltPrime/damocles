/**
 * The POSIX half of shell process cleanup, run as its own process, one per panel.
 *
 * EOF on the stdin the host holds is the only trigger, so nothing here may add a timer, an interval or
 * a poll. This bundle must depend on nothing outside the Node standard library, because it has to keep
 * working with the extension host gone.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

/** One live process, as the platform probe reports it. */
export interface ProcessEntry {
  readonly pid: number;
  readonly pgid: number;
  /** Opaque. Comparable only against another stamp from the same probe on the same boot. */
  readonly startedAt: string;
}

/** The two process-table reads the sentinel needs, injected so the sweep runs on any platform. */
export interface ProcessProbe {
  /** The start stamp of one pid, or null when no process holds that pid. */
  startedAt(pid: number): string | null;
  /** Every process this uid can see. */
  list(): readonly ProcessEntry[];
}

/** Signal one process group. The real wiring sends SIGKILL to the negated pgid. */
export type KillGroup = (pgid: number) => void;

/** One process pinned to a moment, so the same process can be told apart from a pid that was reused. */
export interface MemberAnchor {
  readonly pid: number;
  readonly startedAt: string;
}

/** Everything known about one registered group. */
export interface GroupAnchors {
  /** The leader's stamp read at registration, or null when no process held that pid by then. */
  readonly leaderStartedAt: string | null;
  /** The group's members at the moment its shell exited. Empty until that record arrives. */
  readonly members: readonly MemberAnchor[];
}

/** True when one process the sentinel identified earlier is still alive under the same pid. */
function anchorHolds(table: readonly ProcessEntry[], anchor: MemberAnchor): boolean {
  return table.some((entry) => entry.pid === anchor.pid && entry.startedAt === anchor.startedAt);
}

/**
 * Decide which registered groups are still the groups that were registered, and signal those.
 *
 * A pid can be recycled between registration and here, and signalling a recycled group id would kill an
 * unrelated process of the user's, so every group is re-identified against a process the sentinel saw
 * itself. Neither kernel hands out a pid that is currently in use as a process group id, so one surviving
 * member the sentinel can name proves the whole group, leader or no leader. A group that matches nothing
 * is left alone.
 */
export function sweep(
  groups: ReadonlyMap<number, GroupAnchors>,
  probe: ProcessProbe,
  killGroup: KillGroup,
): readonly number[] {
  const table = probe.list();
  const signalled: number[] = [];
  for (const [pgid, anchors] of groups) {
    const leader = table.find((entry) => entry.pid === pgid);
    // A null stamp never equals a live one, so a group registered after its leader died fails here.
    const identified =
      (leader !== undefined && leader.startedAt === anchors.leaderStartedAt) ||
      anchors.members.some((anchor) => anchorHolds(table, anchor));
    if (!identified) continue;
    try {
      killGroup(pgid);
    } catch (error) {
      // One group that cannot be signalled must not stop the groups after it in this loop.
      process.stderr.write(`[sentinel] could not signal process group ${pgid}: ${String(error)}\n`);
      continue;
    }
    signalled.push(pgid);
  }
  return signalled;
}

/** One record: `r<pgid>` to register a group, `x<pgid>` when its shell exited. Anything else is ignored. */
function applyRecord(line: string, groups: Map<number, GroupAnchors>, probe: ProcessProbe): void {
  if (!/^[rx][0-9]+$/.test(line)) return;
  const pgid = Number(line.slice(1));
  if (pgid <= 0) return;
  const known = groups.get(pgid);
  if (line.startsWith('r')) {
    // Read the stamp here rather than at sweep time, because the leader is alive now and may not be later.
    // Anchors held under a pgid an earlier command already used still name that command's survivors, so a
    // re-registration of the same number must keep them.
    groups.set(pgid, { leaderStartedAt: probe.startedAt(pgid), members: known?.members ?? [] });
    return;
  }
  if (known === undefined) return;
  // Every process still in the group when its shell exits is ours, so this one read names them all.
  const table = probe.list();
  // An anchor absent from the table is dead, and a dead one can never match again, so it is only bulk.
  // Both probes answer an empty list when they fail, so an empty table must never be read as all dead.
  const members = table.length === 0 ? [...known.members] : known.members.filter((anchor) => anchorHolds(table, anchor));
  for (const entry of table) {
    if (entry.pgid !== pgid) continue;
    if (members.some((anchor) => anchor.pid === entry.pid && anchor.startedAt === entry.startedAt)) continue;
    members.push({ pid: entry.pid, startedAt: entry.startedAt });
  }
  // With no anchor left, the leader stamp is the only rule that could still fire and it can only match a
  // stranger from here, so the entry is dropped rather than carried to EOF.
  if (members.length === 0) {
    groups.delete(pgid);
    return;
  }
  // This record proves the leader is dead, so its stamp must never be consulted again.
  groups.set(pgid, { leaderStartedAt: null, members });
}

/** Run the sweep on a path that must not throw, reporting a probe failure on stderr instead. */
function sweepOrReport(
  groups: ReadonlyMap<number, GroupAnchors>,
  probe: ProcessProbe,
  killGroup: KillGroup,
): readonly number[] {
  try {
    return sweep(groups, probe, killGroup);
  } catch (error) {
    process.stderr.write(`[sentinel] the sweep failed: ${String(error)}\n`);
    return [];
  }
}

/**
 * Read records off `input` until EOF, then sweep once.
 *
 * A shell exiting is not an unregistration. A process the user backgrounded with `&` outlives the shell
 * call that started it, and panel close still has to reach it. A caller that passes `groups` keeps a
 * reference it can sweep from itself if this process dies before EOF arrives.
 */
export function runSentinel(
  input: NodeJS.ReadableStream,
  probe: ProcessProbe,
  killGroup: KillGroup,
  groups: Map<number, GroupAnchors> = new Map(),
): Promise<readonly number[]> {
  let pending = '';
  return new Promise((resolve) => {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      pending += chunk;
      for (let cut = pending.indexOf('\n'); cut >= 0; cut = pending.indexOf('\n')) {
        applyRecord(pending.slice(0, cut), groups, probe);
        pending = pending.slice(cut + 1);
      }
    });
    // A read error means the host end of the pipe is gone, which is the same news as EOF.
    input.on('error', () => resolve(sweepOrReport(groups, probe, killGroup)));
    input.on('end', () => resolve(sweepOrReport(groups, probe, killGroup)));
  });
}

/** Fields of `/proc/<pid>/stat` after the command name, which is the only field that can hold spaces. */
const LINUX_PGID_FIELD = 2;
const LINUX_STARTTIME_FIELD = 19;

export function readLinuxEntry(pid: number): ProcessEntry | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    // A pid that vanished between the directory read and here is the answer, not a failure.
    return null;
  }
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const pgid = Number(fields[LINUX_PGID_FIELD]);
  const startedAt = fields[LINUX_STARTTIME_FIELD];
  if (startedAt === undefined || !Number.isInteger(pgid)) return null;
  return { pid, pgid, startedAt };
}

export const linuxProbe: ProcessProbe = {
  startedAt: (pid: number): string | null => readLinuxEntry(pid)?.startedAt ?? null,
  list: (): readonly ProcessEntry[] => {
    let names: readonly string[];
    try {
      names = readdirSync('/proc');
    } catch (error) {
      // Every non-darwin POSIX platform lands here, and several have no /proc at all to read.
      process.stderr.write(`[sentinel] /proc could not be read, so no group can be identified: ${String(error)}\n`);
      return [];
    }
    const entries: ProcessEntry[] = [];
    for (const name of names) {
      if (!/^[0-9]+$/.test(name)) continue;
      const entry = readLinuxEntry(Number(name));
      if (entry) entries.push(entry);
    }
    return entries;
  },
};

/** `ps` exits non-zero when it matched no process, which is how a dead pid reports itself. */
function runPs(args: readonly string[]): string | null {
  try {
    return execFileSync('/bin/ps', [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** `lstart` is `%c`, so it holds spaces and is the last column. */
export function parseDarwinRow(row: string): ProcessEntry | null {
  const parts = row.trim().split(/\s+/);
  if (parts.length < 3) return null;
  const pid = Number(parts[0]);
  const pgid = Number(parts[1]);
  if (!Number.isInteger(pid) || !Number.isInteger(pgid)) return null;
  return { pid, pgid, startedAt: parts.slice(2).join(' ') };
}

export const darwinProbe: ProcessProbe = {
  startedAt: (pid: number): string | null => {
    const out = runPs(['-o', 'lstart=', '-p', String(pid)]);
    // `lstart` pads a single-digit day, so both stamps have to collapse runs of spaces or they never match.
    const stamp = out?.trim().split(/\s+/).join(' ');
    return stamp ? stamp : null;
  },
  list: (): readonly ProcessEntry[] => {
    const out = runPs(['-A', '-o', 'pid=,pgid=,lstart=']);
    if (out === null) return [];
    const entries: ProcessEntry[] = [];
    for (const row of out.split('\n')) {
      const entry = parseDarwinRow(row);
      if (entry) entries.push(entry);
    }
    return entries;
  },
};

export function killGroupWithSigkill(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch (error) {
    // ESRCH means the last member exited between the check and here, so there is nothing left to kill.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function main(): Promise<void> {
  const probe = process.platform === 'darwin' ? darwinProbe : linuxProbe;
  const groups = new Map<number, GroupAnchors>();
  // Dying without sweeping is the one outcome this process must never have, so the last handler still tries.
  process.on('uncaughtException', (error) => {
    process.stderr.write(`[sentinel] sweeping after an unhandled failure: ${String(error)}\n`);
    sweepOrReport(groups, probe, killGroupWithSigkill);
    process.exit(1);
  });
  await runSentinel(process.stdin, probe, killGroupWithSigkill, groups);
  process.exit(0);
}

// Importing this module must attach nothing to stdin, so the real run starts only when it is the entry.
if (typeof require !== 'undefined' && require.main === module) void main();
