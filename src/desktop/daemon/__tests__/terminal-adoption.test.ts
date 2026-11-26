import { spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEADER_BYTES } from '../../../remote/persistent-protocol';
import type { HostMessage } from '../../pty-host/protocol';
import type { HostedTerminal, TerminalHostSpawn } from '../../terminal-host/host-messages';
import type { DaemonStarters } from '../serve';
import { createTerminalHosts, type HostLink, type TerminalHosts } from '../terminal-hosts';
import { SHARED_HOME_WINDOW_MS, createSocketFolder, hostPipeName, hostRecordFile, hostSocketPath, hostTokenPath, localRunPaths, makeRunDir, readHostRecords, socketFolderBase, terminalHostLogName, writePidFile, writeToken, type PidRecord, type RunPaths } from '../token';
import { startInProcessDaemon, startTestHost, testStartIdentity, type InProcessDaemon, type TestHost } from './in-process-daemon';
import { connectClient, type TestClient } from './test-client';

const NO_FORMATTER: DaemonStarters = { startFormatterHost: () => { throw new Error('no formatter host in this test'); } };
const OWN = '0.0.0-test';
const OLDER = '0.0.0-older';
const VIEW = { root: '/srv/app', profile: { id: 'bash', name: 'bash', file: '/bin/bash', args: [], icon: 'bash' as const }, startCwd: '/srv/app', nonce: '0123456789abcdef0123456789abcdef' };
const noStart = (): Promise<number> => Promise.reject(new Error('this test starts no terminal host'));
const spawnOf = (id: string, extra: Partial<TerminalHostSpawn> = {}): TerminalHostSpawn => ({ id, file: '/bin/bash', args: [], cwd: '/', env: {}, cols: 80, rows: 24, scrollback: 1000, title: 'bash', projectKey: '/srv/app', endpoints: { cli: false, relay: false }, ...extra });

let paths: RunPaths;
let lines: string[];
const hosts: TestHost[] = [];
const daemons: InProcessDaemon[] = [];
const earlier: TerminalHosts[] = [];

beforeEach(async () => {
  paths = await localRunPaths();
  await makeRunDir(paths);
  lines = [];
});

afterEach(async () => {
  for (const hosts of earlier.splice(0)) hosts.release('the test ended');
  for (const daemon of daemons.splice(0)) await daemon.shutdown();
  for (const host of hosts.splice(0)) if (!host.hasExited()) await host.stop();
  await fs.rm(paths.terminalHostsDir, { recursive: true, force: true });
});

async function host(options: Parameters<typeof startTestHost>[1] = {}): Promise<TestHost> {
  const started = await startTestHost(paths, options);
  hosts.push(started);
  return started;
}

// What a daemon that ran before left in a host: terminals, started over that host's own endpoint and then let go of.
// idleDays: the limit that daemon's client named
async function leaveTerminals(version: string, spawns: readonly TerminalHostSpawn[], idleDays?: number): Promise<void> {
  const before = createTerminalHosts({ paths, identity: testStartIdentity, version, start: noStart, log: () => undefined });
  earlier.push(before);
  if (idleDays !== undefined) before.setIdleDays(idleDays);
  let adopted: HostLink | undefined;
  before.onLink((link) => { adopted = link; });
  await before.adoptAll();
  const link = adopted ?? await before.currentHost();
  const ready = new Set<string>();
  link.onMessage((message) => { if (message.type === 'ready') ready.add(message.id); });
  for (const spawn of spawns) await link.endpoint.request('spawn', spawn);
  await vi.waitFor(() => expect(ready.size).toBe(spawns.length));
  // its clients left before it did, and the host has heard so before this returns
  for (const spawn of spawns) link.endpoint.emit('viewed', { id: spawn.id, viewed: false });
  await link.endpoint.request('list', {});
  before.release('the earlier daemon went');
}

async function daemon(options: Parameters<typeof startInProcessDaemon>[0] = {}): Promise<InProcessDaemon> {
  const started = await startInProcessDaemon({ starters: NO_FORMATTER, startTerminalHost: noStart, log: (line) => lines.push(line), ...options });
  daemons.push(started);
  return started;
}

async function client(of: InProcessDaemon, clientId = 'laptop'): Promise<{ client: TestClient; messages: HostMessage[] }> {
  const connected = await connectClient(await of.connect(), { clientId });
  const messages: HostMessage[] = [];
  connected.workspace.onEvent('terminals.message', ({ message }) => messages.push(message));
  return { client: connected, messages };
}

// a pid of this machine that names no process
function endedPid(): number {
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  return pid;
}

// what a host that ended without its cleanup left: its record, its token and (POSIX) its socket folder
async function leftBy(pid: number): Promise<{ record: PidRecord; folder: string | null }> {
  await fs.mkdir(paths.terminalHostsDir, { recursive: true });
  const folder = process.platform === 'win32' ? null : await createSocketFolder(await socketFolderBase());
  const record: PidRecord = { version: OLDER, pid, hostname: os.hostname(), endpoint: folder === null ? hostPipeName() : hostSocketPath(folder), socketFolder: folder, updatedAt: Date.now() };
  await writeToken(hostTokenPath(paths, record));
  if (folder !== null) await fs.writeFile(record.endpoint, '');
  await writePidFile(hostRecordFile(paths, pid), record);
  return { record, folder };
}

describe('a daemon and the terminal hosts of its run folder', { timeout: 30_000 }, () => {
  it('adopts a live older host\'s terminals before it listens: they are listed as terminals and as runs, keep their pid, show their screen and take input', async () => {
    const older = await host({ version: OLDER });
    await leaveTerminals(OLDER, [spawnOf('term-3', { view: JSON.stringify(VIEW) }), spawnOf('term-4', { projectKey: '', title: 'zsh' })]);
    older.ptys[0]!.print('before the switch\r\n');
    const running = await daemon();
    const { client: laptop, messages } = await client(running);
    // the first answer already holds them: main's reattach never finds a surviving terminal missing
    expect(await laptop.workspace.request('terminals.list', {})).toEqual([{ id: 'term-3', pid: older.ptys[0]!.pid, cols: 80, rows: 24, view: VIEW }, { id: 'term-4', pid: older.ptys[1]!.pid, cols: 80, rows: 24 }]);
    expect((await laptop.control.request('listRuns', {})).runs).toEqual([
      { kind: 'terminal', id: 'term-3', projectKey: '/srv/app', title: 'bash', state: 'running', providers: [] },
      { kind: 'terminal', id: 'term-4', projectKey: '', title: 'zsh', state: 'running', providers: [] },
    ]);
    laptop.workspace.emit('terminals.post', { request: { type: 'serialize', id: 'term-3' } });
    await vi.waitFor(() => expect(messages.find((message) => message.type === 'screen')).toMatchObject({ id: 'term-3', data: expect.stringContaining('before the switch') }));
    laptop.workspace.emit('terminals.post', { request: { type: 'input', id: 'term-3', data: 'ls\r' } });
    await vi.waitFor(() => expect(older.ptys[0]!.written).toEqual(['ls\r']));
    older.ptys[0]!.print('after\r\n');
    await vi.waitFor(() => expect(messages.filter((message) => message.type === 'data').map((message) => message.data).join('')).toContain('after'));
    expect(older.ptys.every((pty) => !pty.killed)).toBe(true);
    expect(lines).toContain(`[terminal] attached to the terminal host ${older.pid} (${OLDER}) with 2 terminals`);
  });

  it('removes what an ended host left, by the names a host makes, and leaves a folder that holds anything else', async () => {
    const gone = await leftBy(endedPid());
    const kept = await leftBy(endedPid());
    if (kept.folder !== null) await fs.writeFile(path.join(kept.folder, 'notes.txt'), 'not a host\'s file');
    // a record that does not parse, named by an ended pid
    const unreadable = endedPid();
    await fs.writeFile(hostRecordFile(paths, unreadable), '{ not json');
    const running = await daemon();
    expect((await readHostRecords(paths)).map((entry) => entry.pid)).toEqual([]);
    expect(existsSync(hostTokenPath(paths, gone.record))).toBe(false);
    expect(lines).toContain(`[terminal] removed the record of the terminal host ${gone.record.pid}, which has ended`);
    expect(lines).toContain(`[terminal] removed the record of the terminal host ${unreadable}, which has ended`);
    if (gone.folder !== null && kept.folder !== null) {
      expect(existsSync(gone.folder)).toBe(false);
      expect(await fs.readdir(kept.folder)).toEqual(['notes.txt']);
      expect(lines.some((line) => line.startsWith(`[terminal] removing what the ended terminal host ${kept.record.pid} left failed`))).toBe(true);
      await fs.rm(kept.folder, { recursive: true });
    }
    const { client: laptop } = await client(running);
    expect(await laptop.workspace.request('terminals.list', {})).toEqual([]);
  });

  it('keeps the newest 5 ended hosts\' logs and every live host\'s', async () => {
    const live = await host({ version: OLDER });
    await leaveTerminals(OLDER, [spawnOf('term-3')]);
    const log = (pid: number, suffix = ''): string => path.join(paths.logsDir, `${terminalHostLogName(pid)}${suffix}.log`);
    const ended = [11, 12, 13, 14, 15, 16, 17];
    for (const [index, pid] of ended.entries()) {
      await fs.writeFile(log(pid), 'ended');
      await fs.utimes(log(pid), new Date(1_700_000_000_000 + index * 1000), new Date(1_700_000_000_000 + index * 1000));
    }
    // the oldest host's rotated file goes with its log
    await fs.writeFile(log(11, '.1'), 'rotated');
    await fs.utimes(log(11, '.1'), new Date(1_600_000_000_000), new Date(1_600_000_000_000));
    await fs.writeFile(log(live.pid), 'live');
    await fs.utimes(log(live.pid), new Date(1_500_000_000_000), new Date(1_500_000_000_000));
    await daemon();
    const left = (await fs.readdir(paths.logsDir)).filter((name) => name.startsWith('terminal-host-')).sort();
    expect(left).toEqual([...[13, 14, 15, 16, 17].map((pid) => `terminal-host-${pid}.log`), `terminal-host-${live.pid}.log`].sort());
    for (const name of left) await fs.rm(path.join(paths.logsDir, name));
  });

  it('starts while a live host cannot be reached, says so, keeps its record, and adopts it at a later try', async () => {
    const older = await host({ version: OLDER });
    await leaveTerminals(OLDER, [spawnOf('term-3')]);
    // the token is out of reach for now, which proves nothing about the host
    const tokenFile = hostTokenPath(paths, older.record);
    await fs.rename(tokenFile, `${tokenFile}.away`);
    const adopted: HostLink[] = [];
    const retrying = createTerminalHosts({ paths, identity: testStartIdentity, version: OWN, start: noStart, retryMs: 50, log: (line) => lines.push(line) });
    earlier.push(retrying);
    retrying.onLink((link) => adopted.push(link));
    await retrying.adoptAll();
    expect(adopted).toEqual([]);
    expect(lines.some((line) => line.startsWith(`[terminal] the terminal host ${older.pid} did not attach, trying again in 50 ms: `))).toBe(true);
    expect((await readHostRecords(paths)).map((entry) => entry.pid)).toEqual([older.pid]);
    await fs.rename(`${tokenFile}.away`, tokenFile);
    await vi.waitFor(() => expect(adopted.map((link) => `${link.pid} ${link.version} ${link.terminals.map((terminal: HostedTerminal) => terminal.id).join()}`)).toEqual([`${older.pid} ${OLDER} term-3`]), { timeout: 5000 });
  });

  it('answers its clients while a live host does not attach, listing that host\'s terminals from its terminals file from its first answer', async () => {
    const older = await host({ version: OLDER });
    await leaveTerminals(OLDER, [spawnOf('term-3', { view: JSON.stringify(VIEW) })]);
    const tokenFile = hostTokenPath(paths, older.record);
    await fs.rename(tokenFile, `${tokenFile}.away`);
    const running = await daemon();
    const { client: laptop } = await client(running);
    // still waited for, so not yet not responding
    expect(await laptop.workspace.request('terminals.list', {})).toEqual([{ id: 'term-3', pid: older.ptys[0]!.pid, cols: 80, rows: 24, view: VIEW }]);
    expect(lines.some((line) => line.startsWith(`[terminal] the terminal host ${older.pid} did not attach`))).toBe(true);
    expect((await readHostRecords(paths)).map((entry) => entry.pid)).toEqual([older.pid]);
    await fs.rename(`${tokenFile}.away`, tokenFile);
  });

  // a pid another process took after its host ended: the pid lives, and nothing listens where the record says
  it('removes the record of a pid that lives when nothing listens at its endpoint, since no live host is without its endpoint', async () => {
    const { record, folder } = await leftBy(process.ppid);
    const running = await daemon();
    expect(await readHostRecords(paths)).toEqual([]);
    expect(existsSync(hostTokenPath(paths, record))).toBe(false);
    if (folder !== null) expect(existsSync(folder)).toBe(false);
    expect(lines).toContain(`[terminal] removed the record of the terminal host ${process.ppid}: nothing listens at its endpoint, so it has ended`);
    expect(lines.some((line) => line.includes('trying again'))).toBe(false);
    const { client: laptop } = await client(running);
    expect(await laptop.workspace.request('terminals.list', {})).toEqual([]);
  });

  it('attaches to no host whose welcome names another version than its record, and does not try it again', async () => {
    const older = await host({ version: OLDER });
    await leaveTerminals(OLDER, [spawnOf('term-3')]);
    await writePidFile(hostRecordFile(paths, older.pid), { ...older.record, version: OWN });
    const adopted: HostLink[] = [];
    const hosts = createTerminalHosts({ paths, identity: testStartIdentity, version: OWN, start: noStart, retryMs: 20, log: (line) => lines.push(line) });
    earlier.push(hosts);
    hosts.onLink((link) => adopted.push(link));
    await hosts.adoptAll();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(adopted).toEqual([]);
    expect(lines.filter((line) => line.startsWith(`[terminal] the terminal host ${older.pid} `))).toEqual([`[terminal] the terminal host ${older.pid} is not attached and not tried again: its record names ${OWN} and it answers as ${OLDER}`]);
    expect(older.ptys[0]!.killed).toBe(false);
  });

  it('listens though the terminal hosts folder cannot be read, and says so', async () => {
    await fs.rm(paths.terminalHostsDir, { recursive: true, force: true });
    await fs.writeFile(paths.terminalHostsDir, 'not a folder');
    const running = await daemon();
    const { client: laptop } = await client(running);
    expect(await laptop.workspace.request('terminals.list', {})).toEqual([]);
    expect(lines.some((line) => line.startsWith('[daemon] adopting the terminal hosts failed, so their terminals are not listed: '))).toBe(true);
  });

  it('adopts its hosts at once and gives each the one attach bound, so hosts that accept and say nothing cost the start that bound once', async () => {
    const silent: net.Server[] = [];
    try {
      for (const pid of [process.pid, process.ppid]) {
        const { record } = await leftBy(pid);
        if (record.socketFolder !== null) await fs.rm(record.endpoint);
        // reads what arrives and never answers
        const server = net.createServer((socket) => socket.resume());
        await new Promise<void>((resolve) => server.listen(record.endpoint, resolve));
        silent.push(server);
      }
      const hosts = createTerminalHosts({ paths, identity: testStartIdentity, version: OWN, start: noStart, attachTimeoutMs: 1000, log: (line) => lines.push(line) });
      earlier.push(hosts);
      const started = Date.now();
      await hosts.adoptAll();
      // one after the other would take two bounds
      expect(Date.now() - started).toBeLessThan(1800);
      expect(lines.filter((line) => line.includes('did not attach, trying again')).map((line) => line.replace(/^.*: /, ''))).toEqual(['no attach within 1000 ms', 'no attach within 1000 ms']);
    } finally {
      for (const server of silent) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('attaches again to a live host whose link was cut: its viewers hear no exit, the same terminals are listed, each view gets a fresh screen, input reaches it, and a shutdown still ends that host', async () => {
    const same = await host({ version: OWN });
    await leaveTerminals(OWN, [spawnOf('term-3'), spawnOf('term-4')]);
    const running = await daemon();
    const { client: laptop, messages } = await client(running);
    laptop.workspace.emit('terminals.post', { request: { type: 'serialize', id: 'term-3' } });
    await vi.waitFor(() => expect(messages.filter((message) => message.type === 'screen')).toHaveLength(1));
    same.ptys[0]!.print('while the link is down\r\n');
    same.dropLinks();
    await vi.waitFor(() => expect(lines.some((line) => line.startsWith(`[terminal] the link to the terminal host ${same.pid} (${OWN}) closed`))).toBe(true));
    // typed once the daemon knows the link is away, or already has the next one
    laptop.workspace.emit('terminals.post', { request: { type: 'input', id: 'term-3', data: 'ls\r' } });
    await vi.waitFor(() => expect(lines.filter((line) => line === `[terminal] attached to the terminal host ${same.pid} (${OWN}) with 2 terminals`)).toHaveLength(2));
    await vi.waitFor(() => expect(messages.filter((message) => message.type === 'screen')).toHaveLength(2));
    expect(messages.some((message) => message.type === 'exit')).toBe(false);
    expect((await laptop.workspace.request('terminals.list', {})).map((terminal) => `${terminal.id} ${terminal.pid}`)).toEqual([`term-3 ${same.ptys[0]!.pid}`, `term-4 ${same.ptys[1]!.pid}`]);
    await vi.waitFor(() => expect(same.ptys[0]!.written).toEqual(['ls\r']));
    same.ptys[0]!.print('after\r\n');
    await vi.waitFor(() => expect(messages.filter((message) => message.type === 'data').map((message) => message.data).join('')).toContain('after'));
    // a new terminal starts in the same host, not in a second one of that version
    laptop.workspace.emit('terminals.post', { request: { type: 'spawn', id: 'term-5', file: '/bin/zsh', args: [], cwd: '/', env: {}, cols: 80, rows: 24, scrollback: 1000 } });
    await vi.waitFor(() => expect(same.ptys).toHaveLength(3));
    await running.shutdown();
    expect(await same.exited).toBe('a daemon asked it to shut down');
  });

  it('waits for the host of its version whose link was lost before it starts a terminal, and starts no second host while that one comes back', async () => {
    const same = await host({ version: OWN });
    let starts = 0;
    const hosts = createTerminalHosts({ paths, identity: testStartIdentity, version: OWN, start: () => { starts++; return noStart(); }, retryMs: 50, reattachWaitMs: 5000, log: (line) => lines.push(line) });
    earlier.push(hosts);
    await hosts.adoptAll();
    expect((await hosts.currentHost()).pid).toBe(same.pid);
    const tokenFile = hostTokenPath(paths, same.record);
    await fs.rename(tokenFile, `${tokenFile}.away`);
    same.dropLinks();
    await vi.waitFor(() => expect(lines.some((line) => line.includes('did not attach, trying again'))).toBe(true));
    const asked = hosts.currentHost();
    await fs.rename(`${tokenFile}.away`, tokenFile);
    expect((await asked).pid).toBe(same.pid);
    expect(starts).toBe(0);
  });

  it('starts another host of its version once the lost one stayed out of reach for the stated wait, and says so', async () => {
    const same = await host({ version: OWN });
    const hosts = createTerminalHosts({ paths, identity: testStartIdentity, version: OWN, start: async () => (await host({ version: OWN, pid: process.ppid })).pid, retryMs: 5000, reattachWaitMs: 100, log: (line) => lines.push(line) });
    earlier.push(hosts);
    await hosts.adoptAll();
    const tokenFile = hostTokenPath(paths, same.record);
    await fs.rename(tokenFile, `${tokenFile}.away`);
    same.dropLinks();
    await vi.waitFor(() => expect(lines.some((line) => line.includes('did not attach, trying again'))).toBe(true));
    expect((await hosts.currentHost()).pid).toBe(process.ppid);
    expect(lines).toContain(`[terminal] the terminal host of ${OWN} whose link was lost is not back; starting another`);
    await fs.rename(`${tokenFile}.away`, tokenFile);
  });

  it('starts new terminals in the host of its version that came back while it started another, and lets the new empty one go', async () => {
    const same = await host({ version: OWN });
    await leaveTerminals(OWN, [spawnOf('term-3')]);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let starting = false;
    let started: TestHost | undefined;
    const hosts = createTerminalHosts({
      paths,
      identity: testStartIdentity,
      version: OWN,
      start: async () => {
        starting = true;
        await gate;
        started = await host({ version: OWN, pid: process.ppid });
        return started.pid;
      },
      retryMs: 50,
      reattachWaitMs: 100,
      log: (line) => lines.push(line),
    });
    earlier.push(hosts);
    await hosts.adoptAll();
    const tokenFile = hostTokenPath(paths, same.record);
    await fs.rename(tokenFile, `${tokenFile}.away`);
    same.dropLinks();
    await vi.waitFor(() => expect(lines.some((line) => line.includes('did not attach, trying again'))).toBe(true));
    const asked = hosts.currentHost();
    await vi.waitFor(() => expect(starting).toBe(true));
    await fs.rename(`${tokenFile}.away`, tokenFile);
    await vi.waitFor(() => expect(lines.filter((line) => line === `[terminal] attached to the terminal host ${same.pid} (${OWN}) with 1 terminals`)).toHaveLength(2), { timeout: 5000 });
    open();
    const link = await asked;
    expect(link.pid).toBe(same.pid);
    expect(hosts.links()).toContain(link);
    expect(await hosts.currentHost()).toBe(link);
    expect(lines).toContain(`[terminal] the link to the terminal host ${started!.pid} (${OWN}) closed: it holds no terminal`);
  });

  it('starts new terminals in another attached host of its version once the one they started in is lost, and starts no third', async () => {
    const same = await host({ version: OWN });
    await leaveTerminals(OWN, [spawnOf('term-3')]);
    let second: TestHost | undefined;
    let starts = 0;
    const hosts = createTerminalHosts({
      paths,
      identity: testStartIdentity,
      version: OWN,
      start: async () => {
        starts++;
        if (starts > 1) return noStart();
        second = await host({ version: OWN, pid: process.ppid });
        return second.pid;
      },
      retryMs: 50,
      reattachWaitMs: 100,
      log: (line) => lines.push(line),
    });
    earlier.push(hosts);
    await hosts.adoptAll();
    const tokenFile = hostTokenPath(paths, same.record);
    await fs.rename(tokenFile, `${tokenFile}.away`);
    same.dropLinks();
    await vi.waitFor(() => expect(lines.some((line) => line.includes('did not attach, trying again'))).toBe(true));
    expect((await hosts.currentHost()).pid).toBe(second!.pid);
    await fs.rename(`${tokenFile}.away`, tokenFile);
    await vi.waitFor(() => expect(lines.filter((line) => line === `[terminal] attached to the terminal host ${same.pid} (${OWN}) with 1 terminals`)).toHaveLength(2), { timeout: 5000 });
    // the host new terminals started in is lost and stays away
    const secondToken = hostTokenPath(paths, second!.record);
    await fs.rename(secondToken, `${secondToken}.away`);
    second!.dropLinks();
    await vi.waitFor(() => expect(lines.some((line) => line.startsWith(`[terminal] the link to the terminal host ${second!.pid} (${OWN}) closed`))).toBe(true));
    expect((await hosts.currentHost()).pid).toBe(same.pid);
    expect(starts).toBe(1);
    await fs.rename(`${secondToken}.away`, secondToken);
  });

  it('takes no link that closed in the read that carried its attach answer, and attaches again', async () => {
    let attached = false;
    let broke = false;
    // the first link breaks the contract right after the host's attach answer, in the same write burst
    const same = await host({
      version: OWN,
      log: (line) => { if (!broke && line.includes(' attached')) attached = true; },
      tap: (socket) => {
        const write = socket.write.bind(socket) as (chunk: Uint8Array) => boolean;
        socket.write = ((chunk: Uint8Array) => {
          const written = write(chunk);
          if (attached && !broke) {
            broke = true;
            const unknown = new Uint8Array(HEADER_BYTES);
            unknown[0] = 0xee;
            process.nextTick(() => write(unknown));
          }
          return written;
        }) as typeof socket.write;
      },
    });
    const hosts = createTerminalHosts({ paths, identity: testStartIdentity, version: OWN, start: noStart, retryMs: 50, reattachWaitMs: 5000, log: (line) => lines.push(line) });
    earlier.push(hosts);
    await hosts.adoptAll();
    const link = await hosts.currentHost();
    expect(link.pid).toBe(same.pid);
    expect(hosts.links()).toContain(link);
    expect(lines.some((line) => line.includes('a message of unknown type 238'))).toBe(true);
  });

  it('keeps trying a lost host while its run folder cannot be read, and attaches once it can', async () => {
    const same = await host({ version: OWN });
    await leaveTerminals(OWN, [spawnOf('term-3')]);
    const hosts = createTerminalHosts({ paths, identity: testStartIdentity, version: OWN, start: noStart, retryMs: 50, log: (line) => lines.push(line) });
    earlier.push(hosts);
    await hosts.adoptAll();
    const attaches = (): number => lines.filter((line) => line === `[terminal] attached to the terminal host ${same.pid} (${OWN}) with 1 terminals`).length;
    await fs.rename(paths.terminalHostsDir, `${paths.terminalHostsDir}.away`);
    await fs.writeFile(paths.terminalHostsDir, 'not a folder');
    same.dropLinks();
    await vi.waitFor(() => expect(lines.some((line) => line.startsWith(`[terminal] attaching to the terminal host ${same.pid} again failed: `))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fs.rm(paths.terminalHostsDir);
    await fs.rename(`${paths.terminalHostsDir}.away`, paths.terminalHostsDir);
    await vi.waitFor(() => expect(attaches()).toBe(2), { timeout: 5000 });
  });

  // a machine whose hostname changed since its host started (macOS changes it with the network) still has that host
  it('adopts a live host whose record names another hostname', async () => {
    const older = await host({ version: OLDER });
    await leaveTerminals(OLDER, [spawnOf('term-3')]);
    await writePidFile(hostRecordFile(paths, older.pid), { ...older.record, hostname: 'the-name-before' });
    const adopted: HostLink[] = [];
    const hosts = createTerminalHosts({ paths, identity: testStartIdentity, version: OWN, start: noStart, log: (line) => lines.push(line) });
    earlier.push(hosts);
    hosts.onLink((link) => adopted.push(link));
    await hosts.adoptAll();
    expect(adopted.map((link) => `${link.pid} ${link.version} ${link.terminals.map((terminal: HostedTerminal) => terminal.id).join()}`)).toEqual([`${older.pid} ${OLDER} term-3`]);
  });

  // two machines with one machine id that share a home share the run folder: the other's pids and endpoints mean nothing here
  it('removes nothing of a record that names another hostname and does not attach while it is recent, and only the record once it is old and stayed out of reach for the stated time', async () => {
    const recent = await leftBy(endedPid());
    const old = await leftBy(endedPid());
    await writePidFile(hostRecordFile(paths, recent.record.pid), { ...recent.record, hostname: 'another-machine' });
    await writePidFile(hostRecordFile(paths, old.record.pid), { ...old.record, hostname: 'another-machine' });
    await fs.utimes(hostRecordFile(paths, old.record.pid), new Date(Date.now() - 2 * SHARED_HOME_WINDOW_MS), new Date(Date.now() - 2 * SHARED_HOME_WINDOW_MS));
    const hosts = createTerminalHosts({ paths, identity: testStartIdentity, version: OWN, start: noStart, retryMs: 20, giveUpMs: 100, log: (line) => lines.push(line) });
    earlier.push(hosts);
    await hosts.adoptAll();
    // neither an ended pid nor a dead endpoint of another machine's record proves anything
    expect((await readHostRecords(paths)).map((entry) => entry.pid).sort()).toEqual([recent.record.pid, old.record.pid].sort());
    await vi.waitFor(async () => expect((await readHostRecords(paths)).map((entry) => entry.pid)).toEqual([recent.record.pid]), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await readHostRecords(paths)).map((entry) => entry.pid)).toEqual([recent.record.pid]);
    // what the other machine's host left is that machine's to remove
    expect(existsSync(hostTokenPath(paths, old.record))).toBe(true);
    expect(existsSync(hostTokenPath(paths, recent.record))).toBe(true);
    expect(lines.filter((line) => line.startsWith('[terminal] removed'))).toEqual([`[terminal] removed the record of the terminal host ${old.record.pid} of another-machine: it did not attach for over 100 ms and no host touched it for over ${SHARED_HOME_WINDOW_MS} ms`]);
    // said once per record, however often it is tried
    expect(lines.filter((line) => line.startsWith(`[terminal] the terminal host ${recent.record.pid} of another-machine did not attach`))).toHaveLength(1);
    hosts.release('the test ended');
    for (const left of [recent, old]) {
      await fs.rm(hostTokenPath(paths, left.record), { force: true });
      if (left.folder !== null) await fs.rm(left.folder, { recursive: true, force: true });
    }
  });

  // A host's daily touch is late after a suspend, so its record may look old while it lives: one failed attach proves nothing.
  it('adopts a host whose record is old and whose first attach failed once it answers, and keeps its files', async () => {
    const older = await host({ version: OLDER });
    await leaveTerminals(OLDER, [spawnOf('term-3')]);
    const tokenFile = hostTokenPath(paths, older.record);
    await fs.rename(tokenFile, `${tokenFile}.away`);
    await fs.utimes(hostRecordFile(paths, older.pid), new Date(Date.now() - 2 * SHARED_HOME_WINDOW_MS), new Date(Date.now() - 2 * SHARED_HOME_WINDOW_MS));
    const adopted: HostLink[] = [];
    const hosts = createTerminalHosts({ paths, identity: testStartIdentity, version: OWN, start: noStart, retryMs: 50, log: (line) => lines.push(line) });
    earlier.push(hosts);
    hosts.onLink((link) => adopted.push(link));
    await hosts.adoptAll();
    expect(adopted).toEqual([]);
    expect((await readHostRecords(paths)).map((entry) => entry.pid)).toEqual([older.pid]);
    await fs.rename(`${tokenFile}.away`, tokenFile);
    await vi.waitFor(() => expect(adopted.map((link) => `${link.pid} ${link.terminals.map((terminal: HostedTerminal) => terminal.id).join()}`)).toEqual([`${older.pid} term-3`]), { timeout: 5000 });
    expect((await readHostRecords(paths)).map((entry) => entry.pid)).toEqual([older.pid]);
    expect(existsSync(tokenFile)).toBe(true);
    expect(lines.some((line) => line.startsWith('[terminal] removed'))).toBe(false);
  });

  // a live host touches its record every day, so an old record whose endpoint stays out of reach for the stated time is a dead host's
  it('removes an old record whose endpoint accepts and never answers once it stayed out of reach for the stated time, and keeps trying a recent one', async () => {
    const silent: net.Server[] = [];
    try {
      const records: PidRecord[] = [];
      for (const pid of [process.pid, process.ppid]) {
        const { record } = await leftBy(pid);
        if (record.socketFolder !== null) await fs.rm(record.endpoint);
        const server = net.createServer((socket) => socket.resume());
        await new Promise<void>((resolve) => server.listen(record.endpoint, resolve));
        silent.push(server);
        records.push(record);
      }
      await fs.utimes(hostRecordFile(paths, process.ppid), new Date(Date.now() - 2 * SHARED_HOME_WINDOW_MS), new Date(Date.now() - 2 * SHARED_HOME_WINDOW_MS));
      const hosts = createTerminalHosts({ paths, identity: testStartIdentity, version: OWN, start: noStart, attachTimeoutMs: 100, retryMs: 20, giveUpMs: 300, log: (line) => lines.push(line) });
      earlier.push(hosts);
      await hosts.adoptAll();
      // the first failed attach removes nothing
      expect((await readHostRecords(paths)).map((entry) => entry.pid).sort()).toEqual([process.pid, process.ppid].sort());
      await vi.waitFor(async () => expect((await readHostRecords(paths)).map((entry) => entry.pid)).toEqual([process.pid]), { timeout: 5000 });
      expect(lines).toContain(`[terminal] removed the record of the terminal host ${process.ppid}: it did not attach for over 300 ms (no attach within 100 ms) and nothing touched its record for over ${SHARED_HOME_WINDOW_MS} ms, so it has ended`);
      expect(lines.some((line) => line.startsWith(`[terminal] the terminal host ${process.pid} did not attach, trying again in 20 ms: `))).toBe(true);
      expect(existsSync(hostTokenPath(paths, records[1]!))).toBe(false);
      expect(existsSync(hostTokenPath(paths, records[0]!))).toBe(true);
      hosts.release('the test ended');
    } finally {
      for (const server of silent) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('removes an old record whose token is gone once it stayed out of reach for the stated time, though another process has its pid', async () => {
    const { record, folder } = await leftBy(process.ppid);
    await fs.rm(hostTokenPath(paths, record));
    await fs.utimes(hostRecordFile(paths, process.ppid), new Date(Date.now() - 2 * SHARED_HOME_WINDOW_MS), new Date(Date.now() - 2 * SHARED_HOME_WINDOW_MS));
    const hosts = createTerminalHosts({ paths, identity: testStartIdentity, version: OWN, start: noStart, retryMs: 20, giveUpMs: 100, log: (line) => lines.push(line) });
    earlier.push(hosts);
    await hosts.adoptAll();
    expect((await readHostRecords(paths)).map((entry) => entry.pid)).toEqual([process.ppid]);
    await vi.waitFor(async () => expect(await readHostRecords(paths)).toEqual([]), { timeout: 5000 });
    if (folder !== null) expect(existsSync(folder)).toBe(false);
  });

  // a reboot empties /tmp: the record stays in the home, its folder is gone, and another process has the pid
  it.runIf(process.platform !== 'win32')('removes an old record whose socket folder is gone once it stayed out of reach for the stated time', async () => {
    const { folder } = await leftBy(process.ppid);
    await fs.rm(folder!, { recursive: true });
    await fs.utimes(hostRecordFile(paths, process.ppid), new Date(Date.now() - 2 * SHARED_HOME_WINDOW_MS), new Date(Date.now() - 2 * SHARED_HOME_WINDOW_MS));
    const hosts = createTerminalHosts({ paths, identity: testStartIdentity, version: OWN, start: noStart, retryMs: 20, giveUpMs: 100, log: (line) => lines.push(line) });
    earlier.push(hosts);
    await hosts.adoptAll();
    expect((await readHostRecords(paths)).map((entry) => entry.pid)).toEqual([process.ppid]);
    await vi.waitFor(async () => expect(await readHostRecords(paths)).toEqual([]), { timeout: 5000 });
  });

  it('attaches at once after a link\'s first close, and waits for the retry when the next link closes again within seconds', async () => {
    const same = await host({ version: OWN });
    await leaveTerminals(OWN, [spawnOf('term-3')]);
    const hosts = createTerminalHosts({ paths, identity: testStartIdentity, version: OWN, start: noStart, retryMs: 3000, log: (line) => lines.push(line) });
    earlier.push(hosts);
    await hosts.adoptAll();
    const attaches = (): number => lines.filter((line) => line === `[terminal] attached to the terminal host ${same.pid} (${OWN}) with 1 terminals`).length;
    same.dropLinks();
    // well within the retry
    await vi.waitFor(() => expect(attaches()).toBe(2), { timeout: 2000 });
    same.dropLinks();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(attaches()).toBe(2);
    await vi.waitFor(() => expect(attaches()).toBe(3), { timeout: 6000 });
  });

  it('starts no host once it released its hosts, though a terminal still waited for a lost one', async () => {
    const same = await host({ version: OWN });
    let starts = 0;
    const hosts = createTerminalHosts({ paths, identity: testStartIdentity, version: OWN, start: () => { starts++; return noStart(); }, retryMs: 5000, reattachWaitMs: 100, log: (line) => lines.push(line) });
    earlier.push(hosts);
    await hosts.adoptAll();
    const tokenFile = hostTokenPath(paths, same.record);
    await fs.rename(tokenFile, `${tokenFile}.away`);
    same.dropLinks();
    await vi.waitFor(() => expect(lines.some((line) => line.includes('did not attach, trying again'))).toBe(true));
    const asked = hosts.currentHost();
    hosts.release('the daemon is shutting down');
    await expect(asked).rejects.toThrow('the daemon let go of its terminal hosts');
    expect(starts).toBe(0);
    await fs.rename(`${tokenFile}.away`, tokenFile);
  });

  it('attaches again to a host it started under a pid it had let go of before', async () => {
    const older = await host({ version: OLDER, pid: process.ppid });
    let started: TestHost | undefined;
    const adopting = createTerminalHosts({
      paths,
      identity: testStartIdentity,
      version: OWN,
      start: async () => {
        started = await host({ version: OWN, pid: process.ppid });
        return started.pid;
      },
      log: (line) => lines.push(line),
    });
    earlier.push(adopting);
    // the empty older host is let go of, and ends
    await adopting.adoptAll();
    await older.stop();
    const own = await adopting.currentHost();
    expect(`${own.pid} ${own.version}`).toBe(`${process.ppid} ${OWN}`);
    started!.dropLinks();
    await vi.waitFor(() => expect(lines.filter((line) => line === `[terminal] attached to the terminal host ${process.ppid} (${OWN}) with 0 terminals`)).toHaveLength(2));
  });

  it('tells every viewer each terminal ended once its host has really ended', async () => {
    const older = await host({ version: OLDER });
    await leaveTerminals(OLDER, [spawnOf('term-3'), spawnOf('term-4')]);
    const running = await daemon();
    const { client: laptop, messages } = await client(running);
    laptop.workspace.emit('terminals.post', { request: { type: 'serialize', id: 'term-3' } });
    laptop.workspace.emit('terminals.post', { request: { type: 'serialize', id: 'term-4' } });
    await vi.waitFor(() => expect(messages.filter((message) => message.type === 'screen')).toHaveLength(2));
    await older.stop();
    await vi.waitFor(() => expect(messages.filter((message) => message.type === 'exit')).toEqual([{ type: 'exit', id: 'term-3', exitCode: 1 }, { type: 'exit', id: 'term-4', exitCode: 1 }]));
    expect(await laptop.workspace.request('terminals.list', {})).toEqual([]);
    expect((await laptop.control.request('listRuns', {})).runs).toEqual([]);
  });

  // a pid another process took: whatever answers at the record's endpoint cannot prove the host's token
  it('attaches to no endpoint that cannot prove the token its record\'s place holds, and tells it nothing', async () => {
    const other = await host({ version: OLDER });
    await leaveTerminals(OLDER, [spawnOf('term-3')]);
    const tokenFile = hostTokenPath(paths, other.record);
    await fs.rm(tokenFile);
    await writeToken(tokenFile);
    const running = await daemon();
    const { client: laptop } = await client(running);
    expect(await laptop.workspace.request('terminals.list', {})).toEqual([]);
    expect(lines).toContain(`[terminal] the terminal host ${other.pid} is not attached and not tried again: the endpoint is not this user's daemon`);
    // its record stays: only a host that provably ended loses it
    expect((await readHostRecords(paths)).map((entry) => entry.pid)).toEqual([other.pid]);
    // the terminal runs on in its host, which no daemon ended
    expect(other.ptys[0]!.killed).toBe(false);
    expect(other.hasExited()).toBe(false);
  });

  it('starts new terminals only in the host of its own version, started when none is attached, and keeps the older host\'s terminals where they are', async () => {
    const older = await host({ version: OLDER, pid: process.ppid });
    await leaveTerminals(OLDER, [spawnOf('term-3')]);
    let own: TestHost | undefined;
    let starts = 0;
    const running = await daemon({
      startTerminalHost: async () => {
        starts++;
        own = await host({ version: OWN });
        return own.pid;
      },
    });
    const { client: laptop, messages } = await client(running);
    // adopting starts nothing: a host starts with the first terminal
    expect(starts).toBe(0);
    laptop.workspace.emit('terminals.post', { request: { type: 'spawn', id: 'term-5', file: '/bin/zsh', args: [], cwd: '/', env: {}, cols: 80, rows: 24, scrollback: 1000 }, projectKey: '/srv/app' });
    laptop.workspace.emit('terminals.post', { request: { type: 'spawn', id: 'term-6', file: '/bin/zsh', args: [], cwd: '/', env: {}, cols: 80, rows: 24, scrollback: 1000 }, projectKey: '/srv/app' });
    await vi.waitFor(() => expect(messages.filter((message) => message.type === 'ready').map((message) => message.id)).toEqual(['term-5', 'term-6']));
    expect(starts).toBe(1);
    expect(own!.ptys.map((pty) => pty.file)).toEqual(['/bin/zsh', '/bin/zsh']);
    expect(older.ptys.map((pty) => pty.file)).toEqual(['/bin/bash']);
    expect((await laptop.workspace.request('terminals.list', {})).map((terminal) => terminal.id)).toEqual(['term-3', 'term-5', 'term-6']);
    // an id the older host holds is taken on this host
    laptop.workspace.emit('terminals.post', { request: { type: 'spawn', id: 'term-3', file: '/bin/zsh', args: [], cwd: '/', env: {}, cols: 80, rows: 24, scrollback: 1000 } });
    await vi.waitFor(() => expect(messages.at(-1)).toEqual({ type: 'error', id: 'term-3', message: 'terminal term-3 already exists on this host' }));
    expect(own!.ptys).toHaveLength(2);
  });

  it('uses an attached host of its own version for new terminals instead of starting one', async () => {
    const same = await host({ version: OWN });
    await leaveTerminals(OWN, [spawnOf('term-3')]);
    const running = await daemon();
    const { client: laptop, messages } = await client(running);
    laptop.workspace.emit('terminals.post', { request: { type: 'spawn', id: 'term-5', file: '/bin/zsh', args: [], cwd: '/', env: {}, cols: 80, rows: 24, scrollback: 1000 } });
    await vi.waitFor(() => expect(messages.some((message) => message.type === 'ready' && message.id === 'term-5')).toBe(true));
    expect(same.ptys.map((pty) => pty.file)).toEqual(['/bin/bash', '/bin/zsh']);
  });

  it('releases an older host once its last terminal ended, which then exits, and tells the viewers each terminal\'s own exit', async () => {
    const older = await host({ version: OLDER, emptyCheckMs: 20 });
    await leaveTerminals(OLDER, [spawnOf('term-3'), spawnOf('term-4')]);
    const running = await daemon();
    const { client: laptop, messages } = await client(running);
    laptop.workspace.emit('terminals.post', { request: { type: 'serialize', id: 'term-3' } });
    await vi.waitFor(() => expect(messages.some((message) => message.type === 'screen')).toBe(true));
    older.ptys[0]!.end(0);
    await vi.waitFor(() => expect(messages.at(-1)).toEqual({ type: 'exit', id: 'term-3', exitCode: 0 }));
    // one terminal is left, so the host is kept
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(older.hasExited()).toBe(false);
    older.ptys[1]!.end(3);
    expect(await older.exited).toBe('it holds no terminal and no daemon is attached');
    expect(await laptop.workspace.request('terminals.list', {})).toEqual([]);
    expect((await readHostRecords(paths)).map((entry) => entry.pid)).toEqual([]);
  });

  it('releases an older host that holds no terminal as it adopts, and keeps an empty host of its own version', async () => {
    // an empty host exits by itself once no daemon is attached (the test before); neither is old enough to here
    const older = await host({ version: OLDER, pid: process.ppid });
    const same = await host({ version: OWN });
    await daemon();
    expect(lines).toContain(`[terminal] attached to the terminal host ${older.pid} (${OLDER}) with 0 terminals`);
    expect(lines).toContain(`[terminal] the link to the terminal host ${older.pid} (${OLDER}) closed: it holds no terminal`);
    expect(lines).toContain(`[terminal] attached to the terminal host ${same.pid} (${OWN}) with 0 terminals`);
    expect(lines.some((line) => line.startsWith(`[terminal] the link to the terminal host ${same.pid} `))).toBe(false);
  });

  it('names no idle limit as it adopts, so a host keeps the one the daemon before gave it, and gives every attached host the limit a client\'s attach names', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    let away = 0;
    const older = await host({ version: OLDER, now: () => Date.now() + away });
    // the daemon before named 60 days, past a host's default of 30
    await leaveTerminals(OLDER, [spawnOf('term-3')], 60);
    // nobody viewed the terminal for 40 days: under the limit the host was given, over the one a fresh host starts with
    away = 40 * DAY;
    const running = await daemon();
    const { client: laptop } = await client(running);
    expect((await laptop.workspace.request('terminals.list', {})).map((terminal) => terminal.id)).toEqual(['term-3']);
    // this app's setting is 7 days, which that terminal is past
    await laptop.control.request('attach', { terminalIdleDays: 7 });
    await vi.waitFor(async () => expect(await laptop.workspace.request('terminals.list', {})).toEqual([]));
    expect(older.ptys[0]!.killed).toBe(true);
  });
});
