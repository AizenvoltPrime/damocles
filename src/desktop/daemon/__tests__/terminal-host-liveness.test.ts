import { promises as fs } from 'node:fs';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_TYPE } from '../../../remote/persistent-protocol';
import { writeHostTerminals, type PersistedTerminal } from '../../terminal-host/terminals-file';
import type { ProcessKills, Reproof } from '../process-kill';
import { createTerminalHosts, HOST_SHUTDOWN_TIMEOUT_MS, type TerminalHosts, type TerminalHostsDeps } from '../terminal-hosts';
import { hostRecordFile, hostTerminalsFile, localRunPaths, makeRunDir, readHostRecords, SHARED_HOME_WINDOW_MS, writePidFile, type PidRecord, type RunPaths } from '../token';
import { startTestHost, type TestHost } from './in-process-daemon';

const OWN = '0.0.0-test';
const noStart = (): Promise<number> => Promise.reject(new Error('this test starts no terminal host'));

let paths: RunPaths;
let lines: string[];
let kills: string[];
// the reproof each group kill was given, to be read as the kill would after its grace
let reproofs: Reproof[];
const started: TestHost[] = [];
const created: TerminalHosts[] = [];

beforeEach(async () => {
  paths = await localRunPaths();
  await makeRunDir(paths);
  lines = [];
  kills = [];
  reproofs = [];
});

afterEach(async () => {
  for (const hosts of created.splice(0)) hosts.release('the test ended');
  for (const host of started.splice(0)) {
    host.answer();
    if (!host.hasExited()) await host.stop();
  }
  await fs.rm(paths.terminalHostsDir, { recursive: true, force: true });
});

// kills that never reach a process: each is recorded, and ending a host stops the in-process one
function recordedKills(onProcess: () => Promise<void> = () => Promise.resolve(), forced = true): ProcessKills {
  return {
    group: (pid, start, reproof) => {
      kills.push(`group ${pid} ${start}`);
      reproofs.push(reproof);
      return Promise.resolve();
    },
    process: async (pid) => {
      kills.push(`process ${pid}`);
      await onProcess();
      return true;
    },
    force: (pid) => {
      kills.push(`force ${pid}`);
      return Promise.resolve(forced);
    },
  };
}

// the start identity a test host records and, unless a test says otherwise, the one the daemon reads now
const sameIdentity = (pid: number): Promise<string | undefined> => Promise.resolve(`test1:start of ${pid}`);

async function liveHost(pid?: number, tap?: (socket: Duplex) => void): Promise<TestHost> {
  const host = await startTestHost(paths, { version: OWN, identity: sameIdentity, ...(pid !== undefined ? { pid } : {}), ...(tap ? { tap } : {}) });
  started.push(host);
  return host;
}

// a host that hung before this daemon's first attach, its terminals file naming these shells
async function hungHost(terminals: readonly PersistedTerminal[] = [], pid?: number): Promise<TestHost> {
  const host = await liveHost(pid);
  await writeHostTerminals(hostTerminalsFile(paths, host.pid), { hostStart: `test1:start of ${host.pid}`, terminals });
  host.hang();
  return host;
}

const shell = (id: string, pid: number, start?: string): PersistedTerminal => ({ id, pid, cols: 80, rows: 24, scrollback: 1000, title: 'bash', projectKey: '/srv/app', ...(start !== undefined ? { start } : {}) });

// each responding change as text, and each link as it attached
function watched(options: Partial<TerminalHostsDeps>): { hosts: TerminalHosts; events: string[] } {
  const hosts = createTerminalHosts({ paths, version: OWN, start: noStart, kills: recordedKills(), identity: sameIdentity, log: (line) => lines.push(line), ...options });
  created.push(hosts);
  const events: string[] = [];
  hosts.onResponding((pid, responding) => events.push(`${pid} ${responding ? 'responding' : 'not responding'}`));
  hosts.onLink((link) => events.push(`${link.pid} attached`));
  return { hosts, events };
}

describe('the liveness of the terminal hosts a daemon is attached to', { timeout: 20_000 }, () => {
  it('closes the link to a host that does not answer a list in time, and attaches again once it answers', async () => {
    const host = await liveHost();
    const { hosts, events } = watched({ retryMs: 100, attachTimeoutMs: 300, reattachWaitMs: 60_000 });
    await hosts.adoptAll();
    host.hang();
    await vi.waitFor(() => expect(lines).toContain(`[terminal] the link to the terminal host ${host.pid} (${OWN}) closed: it did not answer a list within 300 ms`), { timeout: 5000 });
    host.answer();
    await vi.waitFor(() => expect(events).toEqual([`${host.pid} attached`, `${host.pid} attached`]), { timeout: 5000 });
    expect(kills).toEqual([]);
  });

  it('keeps the link to a host whose answer arrived while the daemon\'s loop stalled past the bound', async () => {
    let asked = false;
    // the host's answer to a probe's list is written, then the whole process stalls past the bound before the daemon reads it
    const host = await liveHost(undefined, (socket) => {
      const write = socket.write.bind(socket) as (chunk: Uint8Array) => boolean;
      socket.write = ((chunk: Uint8Array) => {
        const written = write(chunk);
        if (asked && chunk[0] === MESSAGE_TYPE.regular) {
          asked = false;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
        }
        return written;
      }) as typeof socket.write;
    });
    const { hosts, events } = watched({ retryMs: 200, attachTimeoutMs: 300, reattachWaitMs: 60_000 });
    hosts.onLink((link) => {
      const request = link.endpoint.request.bind(link.endpoint);
      link.endpoint.request = ((method: 'list', params: Record<string, never>) => {
        if (method === 'list') asked = true;
        return request(method, params);
      }) as typeof link.endpoint.request;
    });
    await hosts.adoptAll();
    await sleep(1000);
    expect(lines.filter((line) => line.startsWith(`[terminal] the link to the terminal host ${host.pid}`))).toEqual([]);
    expect(events).toEqual([`${host.pid} attached`]);
  });

  it('never closes the link to a host that answers, nor says it is not responding', async () => {
    const host = await liveHost();
    const { hosts, events } = watched({ retryMs: 50, attachTimeoutMs: 300, reattachWaitMs: 100 });
    await hosts.adoptAll();
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(lines.filter((line) => line.startsWith(`[terminal] the link to the terminal host ${host.pid}`))).toEqual([]);
    expect(events).toEqual([`${host.pid} attached`]);
    expect(await hosts.endHost(host.pid)).toBe(false);
    expect(kills).toEqual([]);
  });

  it('says once that a lost host whose pid lives is not responding after the reattach wait, and that it answers again once it attached', async () => {
    const host = await liveHost();
    const { hosts, events } = watched({ retryMs: 100, attachTimeoutMs: 200, reattachWaitMs: 700 });
    await hosts.adoptAll();
    host.hang();
    await vi.waitFor(() => expect(events).toEqual([`${host.pid} attached`, `${host.pid} not responding`]), { timeout: 5000 });
    // the retries go on failing meanwhile, and it is said once
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(lines.filter((line) => line.startsWith(`[terminal] the terminal host ${host.pid} is not responding`))).toHaveLength(1);
    host.answer();
    await vi.waitFor(() => expect(events).toEqual([`${host.pid} attached`, `${host.pid} not responding`, `${host.pid} responding`, `${host.pid} attached`]), { timeout: 5000 });
    expect(lines).toContain(`[terminal] the terminal host ${host.pid} answers again`);
    expect(kills).toEqual([]);
  });

  it('ends a host that is not responding when asked: its process, then its terminals as an ended host\'s, and its record', async () => {
    const host = await liveHost();
    const hosts = createTerminalHosts({ paths, version: OWN, start: noStart, kills: recordedKills(() => host.stop()), identity: sameIdentity, retryMs: 100, attachTimeoutMs: 200, reattachWaitMs: 500, log: (line) => lines.push(line) });
    created.push(hosts);
    const endedPids: number[] = [];
    hosts.onEnded((pid) => endedPids.push(pid));
    let marked = false;
    hosts.onResponding((_pid, responding) => { marked = !responding; });
    await hosts.adoptAll();
    host.hang();
    await vi.waitFor(() => expect(marked).toBe(true), { timeout: 5000 });
    expect(await hosts.endHost(host.pid + 1)).toBe(false);
    expect(kills).toEqual([]);
    expect(await hosts.endHost(host.pid)).toBe(true);
    expect(kills).toEqual([`process ${host.pid}`]);
    expect(endedPids).toEqual([host.pid]);
    expect(await readHostRecords(paths)).toEqual([]);
  });

  // the next daemon adopts the host and decides for itself
  it('kills nothing on its own, and says nothing more once it released its hosts', async () => {
    const host = await liveHost();
    const { hosts, events } = watched({ retryMs: 100, attachTimeoutMs: 200, reattachWaitMs: 400 });
    await hosts.adoptAll();
    host.hang();
    await vi.waitFor(() => expect(events).toContain(`${host.pid} not responding`), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    hosts.release('the daemon is handing over');
    // the next lock owner may adopt it
    expect(await hosts.endHost(host.pid)).toBe(false);
    host.answer();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(events).toEqual([`${host.pid} attached`, `${host.pid} not responding`]);
    expect(kills).toEqual([]);
  });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('a live host of this machine that hung before this daemon\'s first attach', { timeout: 20_000 }, () => {
  it('is listed from its terminals file by the first pass, is not responding the reattach wait after its first try, and converges once it attaches', async () => {
    const host = await hungHost([shell('term-1', 4001, 'test1:start of 4001')]);
    const { hosts, events } = watched({ retryMs: 100, attachTimeoutMs: 200, reattachWaitMs: 700 });
    const listed: string[] = [];
    hosts.onUnattached((pid, terminals) => listed.push(`${pid} ${terminals.map((terminal) => `${terminal.id} ${terminal.pid}`).join(',')}`));
    await hosts.adoptAll();
    expect(listed).toEqual([`${host.pid} term-1 4001`]);
    expect(events).toEqual([]);
    await vi.waitFor(() => expect(events).toEqual([`${host.pid} not responding`]), { timeout: 5000 });
    expect(lines).toContain(`[terminal] the terminal host ${host.pid} is not responding: it has not attached for 700 ms since its first attach, and its terminals' requests wait for it`);
    await sleep(400);
    expect(listed).toHaveLength(1);
    host.answer();
    await vi.waitFor(() => expect(events).toEqual([`${host.pid} not responding`, `${host.pid} responding`, `${host.pid} attached`]), { timeout: 5000 });
    expect(kills).toEqual([]);
  });

  it('has ended once its pid names another process, so nothing waits for it and nothing kills it', async () => {
    const host = await hungHost([shell('term-1', 4001, 'test1:start of 4001')]);
    const { hosts, events } = watched({ retryMs: 100, attachTimeoutMs: 200, reattachWaitMs: 300, identity: (pid) => Promise.resolve(`test1:a later process of ${pid}`) });
    const listed: number[] = [];
    const endedPids: number[] = [];
    hosts.onUnattached((pid) => listed.push(pid));
    hosts.onEnded((pid) => endedPids.push(pid));
    await hosts.adoptAll();
    expect(listed).toEqual([]);
    expect(endedPids).toEqual([host.pid]);
    expect(await readHostRecords(paths)).toEqual([]);
    await expect(fs.stat(hostTerminalsFile(paths, host.pid))).rejects.toMatchObject({ code: 'ENOENT' });
    await sleep(500);
    expect(events).toEqual([]);
    expect(kills).toEqual([]);
  });

  it('is never judged when its record names another machine, which only that machine can', async () => {
    const host = await hungHost([shell('term-1', 4001, 'test1:start of 4001')]);
    const record: PidRecord = { ...host.record, hostname: 'lab-2' };
    await writePidFile(hostRecordFile(paths, host.pid), record);
    const { hosts, events } = watched({ retryMs: 100, attachTimeoutMs: 200, reattachWaitMs: 300 });
    const listed: number[] = [];
    hosts.onUnattached((pid) => listed.push(pid));
    await hosts.adoptAll();
    await sleep(800);
    expect(listed).toEqual([]);
    expect(events).toEqual([]);
    expect(await hosts.endHost(host.pid)).toBe(false);
    expect(kills).toEqual([]);
  });

  it('kills a shell its terminals file names only while that shell\'s start identity is the one recorded', async () => {
    const host = await hungHost([shell('term-1', 4001, 'test1:start of 4001'), shell('term-2', 4002, 'test1:start of an earlier 4002'), shell('term-3', 4003), shell('term-4', 4004, 'test1:start of 4004'), shell('term-5', 0), shell('term-6', 4006, 'test2:start of 4006')]);
    const identity = (pid: number): Promise<string | undefined> => (pid === 4004 ? Promise.reject(new Error('ps failed')) : sameIdentity(pid));
    const { hosts } = watched({ retryMs: 5000, attachTimeoutMs: 200, reattachWaitMs: 300, identity });
    await hosts.adoptAll();
    const outcomes: string[] = [];
    for (const id of ['term-1', 'term-2', 'term-3', 'term-4', 'term-5', 'term-6', 'term-9']) outcomes.push(`${id} ${await hosts.killGroup(host.pid, id)}`);
    expect(outcomes).toEqual(['term-1 killed', 'term-2 ended', 'term-3 unproved', 'term-4 unproved', 'term-5 unproved', 'term-6 unproved', 'term-9 unproved']);
    expect(kills).toEqual(['group 4001 test1:start of 4001']);
    expect(lines).toEqual(expect.arrayContaining([
      '[terminal] the shell 4002 of term-2 is not killed: its pid names another process now',
      '[terminal] the shell 4003 of term-3 is not killed: no start identity of it was recorded',
      '[terminal] the shell 4004 of term-4 is not killed: its start identity cannot be read: ps failed',
      '[terminal] the shell 4006 of term-6 is not killed: its recorded start identity is of a scheme this daemon does not read',
      `[terminal] term-5 is not killed directly: the terminals file of its terminal host ${host.pid} names no shell of it`,
      `[terminal] term-9 is not killed directly: the terminals file of its terminal host ${host.pid} names no shell of it`,
    ]));
  });

  // the group's SIGKILL follows its grace, by when the shell may have ended and its pid be another process's
  it('gives a group kill the shell\'s proof to read again before its last signal', async () => {
    const host = await hungHost([shell('term-1', 4001, 'test1:start of 4001')]);
    let reading: (pid: number) => Promise<string | undefined> = sameIdentity;
    const { hosts } = watched({ retryMs: 5000, attachTimeoutMs: 200, reattachWaitMs: 300, identity: (pid) => reading(pid) });
    await hosts.adoptAll();
    expect(await hosts.killGroup(host.pid, 'term-1')).toBe('killed');
    expect(await reproofs[0]!()).toBe('same');
    reading = (pid) => Promise.resolve(`test1:a later process of ${pid}`);
    expect(await reproofs[0]!()).toBe('ended');
    reading = () => Promise.reject(new Error('ps failed'));
    expect(await reproofs[0]!()).toBe('unproved');
  });

  it('kills no shell directly when its host attaches while the shell is proved, and none once the daemon let go of its hosts', async () => {
    const host = await hungHost([shell('term-1', 4001, 'test1:start of 4001')]);
    const reads: { gate?: Promise<void> } = {};
    let open!: () => void;
    const identity = async (pid: number): Promise<string | undefined> => {
      if (reads.gate) await reads.gate;
      return sameIdentity(pid);
    };
    const { hosts, events } = watched({ retryMs: 60_000, attachTimeoutMs: 200, reattachWaitMs: 300, identity });
    await hosts.adoptAll();
    await vi.waitFor(() => expect(events).toEqual([`${host.pid} not responding`]), { timeout: 5000 });
    reads.gate = new Promise<void>((resolve) => { open = resolve; });
    const killing = hosts.killGroup(host.pid, 'term-1');
    host.answer();
    await hosts.adoptAll();
    expect(events).toContain(`${host.pid} attached`);
    open();
    expect(await killing).toBe('unproved');
    expect(lines).toContain(`[terminal] the shell 4001 of term-1 is not killed directly: its terminal host ${host.pid} answers again`);

    reads.gate = new Promise<void>((resolve) => { open = resolve; });
    const held = hosts.killGroup(host.pid, 'term-1');
    hosts.release('the daemon is handing over');
    open();
    expect(await held).toBe('unproved');
    expect(kills).toEqual([]);
    expect(lines).toContain('[terminal] the shell 4001 of term-1 is not killed directly: the daemon let go of its terminal hosts');
  });

  // a ps per try on macOS: a hung host's file and proof are read again only once its file changed
  it('reads and proves a hung host again only when its terminals file changed, and proves it anew before a kill', async () => {
    const host = await hungHost([shell('term-1', 4001, 'test1:start of 4001')]);
    let hostReads = 0;
    const identity = (pid: number): Promise<string | undefined> => {
      if (pid === host.pid) hostReads++;
      return sameIdentity(pid);
    };
    const { hosts, events } = watched({ retryMs: 50, attachTimeoutMs: 100, reattachWaitMs: 300, identity });
    await hosts.adoptAll();
    await vi.waitFor(() => expect(events).toEqual([`${host.pid} not responding`]), { timeout: 5000 });
    await sleep(500);
    expect(hostReads).toBe(1);
    await writeHostTerminals(hostTerminalsFile(paths, host.pid), { hostStart: `test1:start of ${host.pid}`, terminals: [shell('term-1', 4001, 'test1:start of 4001'), shell('term-2', 4002, 'test1:start of 4002')] });
    await vi.waitFor(() => expect(hostReads).toBe(2), { timeout: 5000 });
    await sleep(500);
    expect(hostReads).toBe(2);
    const hostsEnding = createTerminalHosts({ paths, version: OWN, start: noStart, kills: recordedKills(() => host.stop()), identity, retryMs: 50, attachTimeoutMs: 100, reattachWaitMs: 300, log: (line) => lines.push(line) });
    created.push(hostsEnding);
    hosts.release('the test hands over');
    let marked = false;
    hostsEnding.onResponding((_pid, responding) => { marked = !responding; });
    await hostsEnding.adoptAll();
    await vi.waitFor(() => expect(marked).toBe(true), { timeout: 5000 });
    const before = hostReads;
    expect(await hostsEnding.endHost(host.pid)).toBe(true);
    expect(hostReads).toBe(before + 1);
  });

  it('is ended on End terminal host once not responding, only when its start identity is the one recorded', async () => {
    const host = await hungHost();
    let reading: (pid: number) => Promise<string | undefined> = sameIdentity;
    const hosts = createTerminalHosts({ paths, version: OWN, start: noStart, kills: recordedKills(() => host.stop()), identity: (pid) => reading(pid), retryMs: 5000, attachTimeoutMs: 200, reattachWaitMs: 300, log: (line) => lines.push(line) });
    created.push(hosts);
    const endedPids: number[] = [];
    hosts.onEnded((pid) => endedPids.push(pid));
    let marked = false;
    hosts.onResponding((_pid, responding) => { marked = !responding; });
    await hosts.adoptAll();
    // still waited for
    expect(await hosts.endHost(host.pid)).toBe(false);
    await vi.waitFor(() => expect(marked).toBe(true), { timeout: 5000 });
    reading = () => Promise.reject(new Error('PowerShell exited with 1'));
    expect(await hosts.endHost(host.pid)).toBe(false);
    expect(kills).toEqual([]);
    expect(lines).toContain(`[terminal] the terminal host ${host.pid} is not ended: its start identity cannot be read: PowerShell exited with 1`);
    reading = sameIdentity;
    expect(await hosts.endHost(host.pid)).toBe(true);
    expect(kills).toEqual([`process ${host.pid}`]);
    expect(endedPids).toEqual([host.pid]);
    expect(await readHostRecords(paths)).toEqual([]);
  });

  // a SIGKILLed host leaves its record, and an attach already waiting on its endpoint is reset, not refused
  it('ends a host\'s terminals and files once End terminal host\'s kill proved its process gone, whatever its endpoint answers', async () => {
    const host = await hungHost();
    const { hosts, events } = watched({ retryMs: 60_000, attachTimeoutMs: 200, reattachWaitMs: 300 });
    const endedPids: number[] = [];
    hosts.onEnded((pid) => endedPids.push(pid));
    await hosts.adoptAll();
    await vi.waitFor(() => expect(events).toEqual([`${host.pid} not responding`]), { timeout: 5000 });
    expect(await hosts.endHost(host.pid)).toBe(true);
    expect(kills).toEqual([`process ${host.pid}`]);
    expect(endedPids).toEqual([host.pid]);
    expect(await readHostRecords(paths)).toEqual([]);
  });

  it('kills nothing on End terminal host when the host attaches while its identity is read', async () => {
    const host = await hungHost();
    // set: every identity read waits for it
    const reads: { gate?: Promise<void> } = {};
    let open!: () => void;
    const identity = async (pid: number): Promise<string | undefined> => {
      if (reads.gate) await reads.gate;
      return sameIdentity(pid);
    };
    const { hosts, events } = watched({ retryMs: 60_000, attachTimeoutMs: 200, reattachWaitMs: 300, identity });
    await hosts.adoptAll();
    await vi.waitFor(() => expect(events).toEqual([`${host.pid} not responding`]), { timeout: 5000 });
    reads.gate = new Promise<void>((resolve) => { open = resolve; });
    const ending = hosts.endHost(host.pid);
    host.answer();
    await hosts.adoptAll();
    expect(events).toEqual([`${host.pid} not responding`, `${host.pid} responding`, `${host.pid} attached`]);
    open();
    expect(await ending).toBe(false);
    expect(kills).toEqual([]);
    expect(lines).toContain(`[terminal] the terminal host ${host.pid} is not ended: it answers again`);
  });

  // a suspend or a long stop leaves the record untouched; the age rule judges only what the identity cannot
  it('keeps a host it proves running, however old its record and however long it has not attached, and says so once while its failure stays the same', async () => {
    const host = await hungHost();
    const old = new Date(Date.now() - SHARED_HOME_WINDOW_MS - 60_000);
    await fs.utimes(hostRecordFile(paths, host.pid), old, old);
    const { hosts } = watched({ retryMs: 20, attachTimeoutMs: 100, giveUpMs: 100, reattachWaitMs: 60_000 });
    const endedPids: number[] = [];
    hosts.onEnded((pid) => endedPids.push(pid));
    await hosts.adoptAll();
    await sleep(1000);
    expect(endedPids).toEqual([]);
    expect((await readHostRecords(paths)).map((entry) => entry.pid)).toEqual([host.pid]);
    expect(lines.filter((line) => line.startsWith(`[terminal] the terminal host ${host.pid} did not attach, trying again`))).toEqual([`[terminal] the terminal host ${host.pid} did not attach, trying again in 20 ms: no attach within 100 ms`]);
  });

  it('starts a new terminal\'s host at once when the host of its version it waits for is already not responding', async () => {
    await hungHost();
    let starts = 0;
    const { hosts, events } = watched({ retryMs: 60_000, attachTimeoutMs: 100, reattachWaitMs: 1500, start: () => { starts++; return noStart(); } });
    await hosts.adoptAll();
    await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 5000 });
    const before = Date.now();
    await expect(hosts.currentHost()).rejects.toThrow('this test starts no terminal host');
    expect(Date.now() - before).toBeLessThan(1000);
    expect(starts).toBe(1);
  });

  it('removes, at its first adoption, a terminals file or a record\'s temporary file no record names whose pid no process has, and keeps one of a live pid', async () => {
    await fs.mkdir(paths.terminalHostsDir, { recursive: true });
    const dead = 4_194_305;
    await writeHostTerminals(hostTerminalsFile(paths, dead), { terminals: [] });
    await fs.writeFile(`${hostTerminalsFile(paths, dead)}.tmp`, '{');
    // a host killed inside its record's write
    await fs.writeFile(`${hostRecordFile(paths, dead)}.${dead}.tmp`, '{');
    // a host that is starting writes its terminals file just before its record
    await writeHostTerminals(hostTerminalsFile(paths, process.ppid), { terminals: [] });
    await fs.writeFile(`${hostRecordFile(paths, process.ppid)}.${process.ppid}.tmp`, '{');
    const { hosts } = watched({});
    await hosts.adoptAll();
    expect((await fs.readdir(paths.terminalHostsDir)).sort()).toEqual([`${process.ppid}.json.${process.ppid}.tmp`, `${process.ppid}.terminals`]);
  });

  it('has ended without a kill when End terminal host finds its pid another process\'s', async () => {
    const host = await hungHost();
    let reading: (pid: number) => Promise<string | undefined> = sameIdentity;
    const { hosts } = watched({ retryMs: 5000, attachTimeoutMs: 200, reattachWaitMs: 300, identity: (pid) => reading(pid) });
    const endedPids: number[] = [];
    hosts.onEnded((pid) => endedPids.push(pid));
    let marked = false;
    hosts.onResponding((_pid, responding) => { marked = !responding; });
    await hosts.adoptAll();
    await vi.waitFor(() => expect(marked).toBe(true), { timeout: 5000 });
    reading = (pid) => Promise.resolve(`test1:a later process of ${pid}`);
    expect(await hosts.endHost(host.pid)).toBe(true);
    expect(kills).toEqual([]);
    expect(endedPids).toEqual([host.pid]);
    expect(await readHostRecords(paths)).toEqual([]);
  });
});

describe('the end of every terminal host', { timeout: 30_000 }, () => {
  it('for a removal ends each host of this machine it cannot reach and each attached one that did not close in time, only once each is proved', async () => {
    const attached = await liveHost();
    const { hosts } = watched({ retryMs: 60_000, attachTimeoutMs: 200, reattachWaitMs: 60_000 });
    await hosts.adoptAll();
    const unreached = await hungHost([], process.ppid);
    await hosts.adoptAll();
    // hangs after it attached, so it never answers its shutdown
    attached.hang();
    const before = Date.now();
    await hosts.endForRemoval();
    // forced at once: the attached one had the frozen shutdown as its graceful step, and an unreachable or stopped one handles neither that nor SIGTERM
    expect(kills).toEqual([`force ${unreached.pid}`, `force ${attached.pid}`]);
    expect(Date.now() - before).toBeGreaterThanOrEqual(HOST_SHUTDOWN_TIMEOUT_MS);
    expect(await readHostRecords(paths)).toEqual([]);
  });

  // REMOVAL_SHUTDOWN_MAX_MS counts the two as running beside each other
  it('for a removal forces an attached host that ignored its shutdown without waiting for the unreachable hosts\' ends', async () => {
    const attached = await liveHost();
    const steps: string[] = [];
    const slow: ProcessKills = {
      group: () => Promise.resolve(),
      process: () => Promise.resolve(true),
      force: async (pid) => {
        steps.push(`force ${pid}`);
        if (pid === process.ppid) await sleep(HOST_SHUTDOWN_TIMEOUT_MS + 1500);
        steps.push(`gone ${pid}`);
        return true;
      },
    };
    const { hosts } = watched({ retryMs: 60_000, attachTimeoutMs: 200, reattachWaitMs: 60_000, kills: slow });
    await hosts.adoptAll();
    await hungHost([], process.ppid);
    await hosts.adoptAll();
    attached.hang();
    await hosts.endForRemoval();
    expect(steps).toEqual([`force ${process.ppid}`, `force ${attached.pid}`, `gone ${attached.pid}`, `gone ${process.ppid}`]);
  });

  it('for a removal leaves a host whose identity it cannot prove and another machine\'s, and says so', async () => {
    const unproved = await hungHost();
    const other = await hungHost([], process.ppid);
    await writePidFile(hostRecordFile(paths, other.pid), { ...other.record, hostname: 'lab-2' });
    const { hosts } = watched({ attachTimeoutMs: 200, identity: (pid) => (pid === unproved.pid ? Promise.reject(new Error('ps failed')) : sameIdentity(pid)) });
    await hosts.adoptAll();
    await hosts.endForRemoval();
    expect(kills).toEqual([]);
    expect((await readHostRecords(paths)).map((entry) => entry.pid).sort()).toEqual([unproved.pid, other.pid].sort());
    expect(lines).toContain(`[terminal] left the terminal host ${unproved.pid} running: its start identity cannot be read: ps failed`);
    expect(lines).toContain(`[terminal] left the terminal host ${other.pid} running: its record names the machine lab-2`);
  });

  it('for a removal removes the files of a host whose pid names another process now, and kills nothing', async () => {
    const reused = await hungHost();
    const { hosts } = watched({ attachTimeoutMs: 200, identity: (pid) => Promise.resolve(`test1:a later process of ${pid}`) });
    await hosts.endForRemoval();
    expect(kills).toEqual([]);
    expect(await readHostRecords(paths)).toEqual([]);
    await expect(fs.stat(hostTerminalsFile(paths, reused.pid))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(lines).toContain(`[terminal] removed the record of the terminal host ${reused.pid}: its pid names another process now, so it has ended`);
  });

  it('for a removal keeps the files of a host it forced that did not end', async () => {
    const stubborn = await hungHost();
    const { hosts } = watched({ attachTimeoutMs: 200, kills: recordedKills(undefined, false) });
    await hosts.endForRemoval();
    expect(kills).toEqual([`force ${stubborn.pid}`]);
    expect((await readHostRecords(paths)).map((entry) => entry.pid)).toEqual([stubborn.pid]);
    expect((await fs.stat(hostTerminalsFile(paths, stubborn.pid))).isFile()).toBe(true);
    expect(lines).toContain(`[terminal] the terminal host ${stubborn.pid} did not end`);
  });

  it('for a removal kills no host that has no terminals file to prove it by', async () => {
    const unproved = await hungHost();
    await fs.rm(hostTerminalsFile(paths, unproved.pid));
    const { hosts } = watched({ attachTimeoutMs: 200 });
    await hosts.endForRemoval();
    expect(kills).toEqual([]);
    expect(lines).toContain(`[terminal] left the terminal host ${unproved.pid} running: it has no terminals file to prove it by`);
  });

  it('on any other shutdown ends only the attached hosts, and leaves one it cannot reach for the next daemon', async () => {
    const unreached = await hungHost();
    const { hosts } = watched({ attachTimeoutMs: 200, reattachWaitMs: 300 });
    await hosts.adoptAll();
    await hosts.endAll();
    await sleep(500);
    expect(kills).toEqual([]);
    expect((await readHostRecords(paths)).map((entry) => entry.pid)).toEqual([unreached.pid]);
  });
});
