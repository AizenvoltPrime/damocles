import { promises as fs } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostRecordFile, hostTerminalsFile, hostTokenPath, isHostEndpoint, readHostRecords, readToken, runPathsIn, type RunPaths } from '../../daemon/token';
import { TERMINAL_HIGH_WATERMARK_CHARS } from '../../preload/terminal-channels';
import { createPtyScreen, type PtyScreen } from '../../pty-host/screen';
import type { Pty } from '../../pty-host/sessions';
import type { StreamChannel } from '../../../remote/mux';
import { CLI_HOOK_ENV } from '../../workspace/terminal/terminal-env';
import { createTerminalHost, MAX_AUTHENTICATING, type TerminalHost } from '../host';
import { DEFAULT_HOSTED_IDLE_DAYS, ENDPOINT_HOLD_MS, MAX_HELD_ENDPOINT_CONNECTIONS, type TerminalHostSpawn } from '../host-messages';
import { connectDaemon, named, openSocket, output, until, type Daemon } from './host-client';
import { serveTerminalHost, type ServedTerminalHost } from '../records';

// the options of every server made, so a test reads how the endpoints accept
const serverOptions = vi.hoisted((): unknown[] => []);
vi.mock('node:net', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:net')>();
  const createServer = (...args: Parameters<typeof original.createServer>): ReturnType<typeof original.createServer> => {
    serverOptions.push(args[0]);
    return original.createServer(...args);
  };
  return { ...original, default: { ...original, createServer }, createServer };
});

const DAY_MS = 24 * 60 * 60 * 1000;
// the second pty's pid, whose start identity cannot be read
const UNREADABLE_PID = 4001;
const identity = (pid: number): Promise<string | undefined> => (pid === UNREADABLE_PID ? Promise.reject(new Error('ps failed')) : Promise.resolve(`start of ${pid}`));
// a pty of this pid throws once the sessions hold it
const BROKEN_PID = 6666;
// the host's timers and clock, which still follow real time, so sockets and waits run as usual
const FAKE_CLOCK: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true };
const VIEW = JSON.stringify({ root: '/srv/app', profile: { id: 'bash', name: 'bash', file: '/bin/bash', args: [], icon: 'bash' }, startCwd: '/srv/app', nonce: '0123456789abcdef0123456789abcdef' });
const VIEWLESS: TerminalHostSpawn = { id: 'term-1', file: '/bin/sh', args: [], cwd: '/', env: {}, cols: 80, rows: 24, scrollback: 1000, title: 'sh', projectKey: '/srv/app', endpoints: { cli: false, relay: false } };
const SPAWN: TerminalHostSpawn = { ...VIEWLESS, view: VIEW };

class FakePty implements Pty {
  readonly pid: number;
  readonly process = 'sh';
  readonly env: Readonly<Record<string, string>>;
  readonly written: string[] = [];
  readonly sizes: Array<[number, number]> = [];
  paused = false;
  killed = false;
  private dataListener: (data: string) => void = () => undefined;
  private exitListener: (event: { exitCode: number }) => void = () => undefined;
  constructor(pid: number, env: Readonly<Record<string, string>> = {}) {
    this.pid = pid;
    this.env = env;
  }
  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
  }
  onExit(listener: (event: { exitCode: number }) => void): void {
    if (this.pid === BROKEN_PID) throw new Error('the pty broke after it started');
    this.exitListener = listener;
  }
  print(data: string): void {
    this.dataListener(data);
  }
  exit(exitCode: number): void {
    this.exitListener({ exitCode });
  }
  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows]);
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  kill(): void {
    this.killed = true;
  }
}

interface Harness {
  readonly host: TerminalHost;
  readonly served: ServedTerminalHost;
  readonly paths: RunPaths;
  readonly ptys: FakePty[];
  readonly exits: string[];
  readonly logs: string[];
  // set: the next serialize of a screen says it was reached and holds its answer until released
  gate: { readonly entered: () => void; readonly released: Promise<void> } | undefined;
  // set: no endpoint is made until it settles
  endpointsHeld: Promise<void> | undefined;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startHost(options: { emptyCheckMs?: number; rewriteMs?: number; identity?: (pid: number) => Promise<string | undefined>; throttleConpty?: boolean; serving?: boolean } = {}): Promise<Harness> {
  const runDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'dm-host-')), 'run-0123456789abcdef');
  await fs.mkdir(path.join(runDir, 'logs'), { recursive: true });
  const paths = runPathsIn(runDir);
  const ptys: FakePty[] = [];
  const exits: string[] = [];
  const logs: string[] = [];
  const harness: Pick<Harness, 'gate' | 'endpointsHeld'> = { gate: undefined, endpointsHeld: undefined };
  const listening: { served?: ServedTerminalHost } = {};
  const host = createTerminalHost({
    version: '3.7.0+0123456789ab',
    spawn: (file, _args, spawnOptions) => {
      if (file === '/missing') throw new Error('no such shell');
      const pty = new FakePty(file === '/broken' ? BROKEN_PID : file === '/badpid' ? 2 ** 33 : 4000 + ptys.length, spawnOptions.env);
      ptys.push(pty);
      return pty;
    },
    screen: (screenOptions): PtyScreen => {
      const screen = createPtyScreen(screenOptions);
      return {
        ...screen,
        serialize: async () => {
          const gate = harness.gate;
          if (!gate) return screen.serialize();
          harness.gate = undefined;
          const snapshot = await screen.serialize();
          gate.entered();
          await gate.released;
          return snapshot;
        },
      };
    },
    throttleConpty: options.throttleConpty ?? false,
    readProcessName: false,
    exit: (reason) => exits.push(reason),
    emptyCheckMs: options.emptyCheckMs ?? 60 * 60 * 1000,
    endpointFolder: async () => {
      await harness.endpointsHeld;
      if (!listening.served) throw new Error('the host is not listening yet');
      return listening.served.record.socketFolder;
    },
    listed: (terminals) => listening.served?.list(terminals),
    log: (line) => logs.push(line),
  });
  const served = await serveTerminalHost({ paths, version: '3.7.0+0123456789ab', accept: host.accept, touchIntervalMs: DAY_MS, identity: options.identity ?? identity, ...(options.rewriteMs !== undefined ? { rewriteMs: options.rewriteMs } : {}), log: (line) => logs.push(line) });
  listening.served = served;
  if (options.serving !== false) host.serving();
  cleanups.push(async () => {
    await host.close();
    await served.close();
    await fs.rm(path.dirname(runDir), { recursive: true, force: true });
  });
  return Object.assign(harness, { host, served, paths, ptys, exits, logs });
}

// the next serialize of a screen holds its answer until release()
function holdNextScreen(harness: Harness): { entered: Promise<void>; release: () => void } {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  harness.gate = { entered, released: new Promise<void>((resolve) => { release = resolve; }) };
  return { entered: reached, release };
}

async function rawSocket(harness: Harness): Promise<net.Socket> {
  const socket = await openSocket(harness.served.record.endpoint);
  cleanups.push(async () => {
    socket.destroy();
  });
  return socket;
}

// the token is read first: the protocol takes the socket in the turn it connects, so it never misses the host's close
async function connect(harness: Harness, protocolVersion?: number, reconnectionToken?: Uint8Array): Promise<Daemon> {
  const token = await readToken(hostTokenPath(harness.paths, harness.served.record));
  return connectDaemon(await rawSocket(harness), token, protocolVersion, reconnectionToken);
}

const BURST = 'x'.repeat(TERMINAL_HIGH_WATERMARK_CHARS + 1);

// The daemon's connection ends and the host has seen it: the pty it left paused, unacknowledged, runs again.
async function leaves(harness: Harness, daemon: Daemon): Promise<void> {
  const pty = harness.ptys[0]!;
  pty.print(BURST);
  await until(() => pty.paused);
  daemon.protocol.close('the daemon exited');
  await until(() => !pty.paused);
}

describe('the terminal host', () => {
  it('serves the frozen set over its authenticated endpoint', async () => {
    const harness = await startHost();
    expect(isHostEndpoint(harness.served.record)).toBe(true);
    expect(await readHostRecords(harness.paths)).toEqual([{ pid: process.pid, record: harness.served.record }]);
    const daemon = await connect(harness);
    expect(daemon.welcome).toMatchObject({ kind: 'welcome', welcome: { serverVersion: '3.7.0+0123456789ab', protocolVersion: 1, features: ['terminalHost.endpoints'], resumed: false, coreEpoch: null, facts: { homedir: '/', shell: '', gitAvailable: false, libc: null } } });
    expect(await daemon.endpoint.request('attach', { features: [], idleDays: 7 })).toEqual({ terminals: [] });

    await daemon.endpoint.request('spawn', SPAWN);
    await until(() => named(daemon, 'ready').length === 1);
    expect(named(daemon, 'ready')).toEqual([{ name: 'ready', id: 'term-1', pid: 4000 }]);
    expect(await daemon.endpoint.request('list', {})).toEqual({ terminals: [{ id: 'term-1', pid: 4000, cols: 80, rows: 24, scrollback: 1000, title: 'sh', projectKey: '/srv/app', view: VIEW }] });

    const pty = harness.ptys[0]!;
    pty.print('hello\r\n');
    await until(() => output(daemon) === 'hello\r\n');
    daemon.endpoint.emit('ack', { id: 'term-1', chars: 7 });
    daemon.endpoint.emit('input', { id: 'term-1', data: 'ls\r' });
    daemon.endpoint.emit('resize', { id: 'term-1', cols: 100, rows: 30 });
    daemon.endpoint.emit('scrollback', { id: 'term-1', scrollback: 5000 });
    daemon.endpoint.emit('serialize', { id: 'term-1' });
    await until(() => named(daemon, 'screen').length === 1);
    expect(pty.written).toEqual(['ls\r']);
    expect(pty.sizes).toEqual([[100, 30]]);
    expect(named(daemon, 'screen')[0]).toMatchObject({ id: 'term-1', cols: 100, rows: 30, marks: [], sequences: 0, shellSequences: [] });
    expect(named(daemon, 'screen')[0]!.data).toContain('hello');

    daemon.endpoint.emit('clear', { id: 'term-1' });
    daemon.endpoint.emit('viewed', { id: 'term-1', viewed: false });
    daemon.endpoint.emit('serialize', { id: 'term-1' });
    await until(() => named(daemon, 'screen').length === 2);
    expect(named(daemon, 'screen')[1]!.data).not.toContain('hello');
    const [listed] = (await daemon.endpoint.request('list', {})).terminals;
    expect(listed).toMatchObject({ id: 'term-1', cols: 100, rows: 30, scrollback: 5000 });
    expect(listed!.detachedAt).toBeGreaterThan(0);
    daemon.endpoint.emit('viewed', { id: 'term-1', viewed: true });
    await daemon.endpoint.request('idleDays', { days: 0 });
    expect((await daemon.endpoint.request('list', {})).terminals[0]!.detachedAt).toBeUndefined();

    // an event for a terminal the host does not hold is dropped
    daemon.endpoint.emit('input', { id: 'term-9', data: 'x' });
    await daemon.endpoint.request('kill', { id: 'term-9' });
    await daemon.endpoint.request('kill', { id: 'term-1' });
    expect(named(daemon, 'exit')).toEqual([{ name: 'exit', id: 'term-1', exitCode: 1 }]);
    expect(pty.killed).toBe(true);
    expect(await daemon.endpoint.request('list', {})).toEqual({ terminals: [] });

    // a process that ends by itself reports its own code
    await daemon.endpoint.request('spawn', { ...VIEWLESS, id: 'term-2' });
    harness.ptys[1]!.exit(3);
    await until(() => named(daemon, 'exit').length === 2);
    expect(named(daemon, 'exit')[1]).toEqual({ name: 'exit', id: 'term-2', exitCode: 3 });
    expect(daemon.isClosed()).toBe(false);
  });

  it('keeps its terminals file current, with its own and each shell\'s start identity, from its start until its close', async () => {
    const harness = await startHost();
    const file = hostTerminalsFile(harness.paths, process.pid);
    const written = async (): Promise<unknown> => JSON.parse(await fs.readFile(file, 'utf8'));
    const SHELL = { id: 'term-1', cols: 80, rows: 24, scrollback: 1000, title: 'sh', projectKey: '/srv/app', view: VIEW };
    // before its record, so a daemon that finds the record finds the list
    expect(await written()).toEqual({ hostStart: `start of ${process.pid}`, terminals: [] });
    const daemon = await connect(harness);
    await daemon.endpoint.request('attach', { features: [] });
    await daemon.endpoint.request('spawn', SPAWN);
    await daemon.endpoint.request('spawn', { ...VIEWLESS, id: 'term-2' });
    const { view: _view, ...viewless } = SHELL;
    await vi.waitFor(async () => expect(await written()).toEqual({ hostStart: `start of ${process.pid}`, terminals: [{ ...SHELL, pid: 4000, start: 'start of 4000' }, { ...viewless, id: 'term-2', pid: UNREADABLE_PID }] }));
    expect(harness.logs).toContain(`[terminal-host] the start identity of the shell ${UNREADABLE_PID} of term-2 cannot be read, so no daemon can kill it directly until a later read succeeds: ps failed`);
    harness.ptys[0]!.exit(0);
    await vi.waitFor(async () => expect((await written() as { terminals: Array<{ id: string }> }).terminals.map((entry) => entry.id)).toEqual(['term-2']));
    await harness.host.close();
    await harness.served.close();
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // its own identity is in it, so a list that no longer holds still proves more than none
  it('keeps the terminals file it had when a write fails, and writes the current list again later', async () => {
    const harness = await startHost({ rewriteMs: 100 });
    const file = hostTerminalsFile(harness.paths, process.pid);
    const ids = async (): Promise<string[]> => (JSON.parse(await fs.readFile(file, 'utf8')) as { terminals: Array<{ id: string }> }).terminals.map((entry) => entry.id);
    const daemon = await connect(harness);
    await daemon.endpoint.request('attach', { features: [] });
    await daemon.endpoint.request('spawn', SPAWN);
    await vi.waitFor(async () => expect(await ids()).toEqual(['term-1']));
    // its temporary file's name taken: every write fails until it is free again
    await fs.mkdir(`${file}.tmp`);
    await daemon.endpoint.request('spawn', { ...VIEWLESS, id: 'term-2' });
    await vi.waitFor(() => expect(harness.logs.some((line) => line.startsWith('[terminal-host] writing its terminals file failed, so the one it had stays until a later write:'))).toBe(true));
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ hostStart: `start of ${process.pid}`, terminals: [{ id: 'term-1' }] });
    await fs.rmdir(`${file}.tmp`);
    await vi.waitFor(async () => expect(await ids()).toEqual(['term-1', 'term-2']));
  });

  // a read that failed once (a ps that timed out) must not leave the host or a shell unprovable for good
  it('reads again a start identity that could not be read, and writes the terminals file once one is read', async () => {
    const failed = new Set<number>();
    const failingOnce = (pid: number): Promise<string | undefined> => {
      if (failed.has(pid)) return identity(pid);
      failed.add(pid);
      return Promise.reject(new Error('ps did not finish within 5000 ms'));
    };
    const harness = await startHost({ rewriteMs: 100, identity: failingOnce });
    const file = hostTerminalsFile(harness.paths, process.pid);
    const written = async (): Promise<unknown> => JSON.parse(await fs.readFile(file, 'utf8'));
    expect(await written()).toEqual({ terminals: [] });
    await vi.waitFor(async () => expect(await written()).toEqual({ hostStart: `start of ${process.pid}`, terminals: [] }));
    const daemon = await connect(harness);
    await daemon.endpoint.request('attach', { features: [] });
    await daemon.endpoint.request('spawn', SPAWN);
    await vi.waitFor(async () => expect(await written()).toMatchObject({ hostStart: `start of ${process.pid}`, terminals: [{ id: 'term-1', pid: 4000 }] }));
    await vi.waitFor(async () => expect(await written()).toMatchObject({ terminals: [{ id: 'term-1', pid: 4000, start: 'start of 4000' }] }));
    expect(harness.logs.filter((line) => line.includes('cannot be read'))).toHaveLength(2);
  });

  it('rewrites its terminals file only when a value in it changed', async () => {
    let reads = 0;
    const ownUnreadable = (pid: number): Promise<string | undefined> => {
      if (pid !== process.pid) return identity(pid);
      reads++;
      return Promise.reject(new Error('PowerShell exited with 1'));
    };
    const harness = await startHost({ rewriteMs: 50, identity: ownUnreadable });
    const file = hostTerminalsFile(harness.paths, process.pid);
    const { mtimeMs, ino } = await fs.stat(file);
    await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(4));
    expect(await fs.stat(file)).toMatchObject({ mtimeMs, ino });
    expect(harness.logs.filter((line) => line.includes('its own start identity cannot be read'))).toHaveLength(1);
  });

  it('refuses another protocol version and a resume', async () => {
    const harness = await startHost();
    const refused = await connect(harness, 2);
    expect(refused.welcome).toMatchObject({ kind: 'refused', refused: { reason: 'protocol', protocolVersion: 1, serverVersion: '3.7.0+0123456789ab' } });
    await refused.closed;
    // the token of a welcome this host gave: a host link is never resumed
    const first = await connect(harness);
    if (first.welcome.kind !== 'welcome') throw new Error('the host refused a first hello');
    const resume = await connect(harness, undefined, first.welcome.welcome.reconnectionToken);
    expect(resume.welcome).toMatchObject({ kind: 'refused', refused: { reason: 'unknown-token', protocolVersion: 1, serverVersion: '3.7.0+0123456789ab' } });
    await resume.closed;
    expect(first.isClosed()).toBe(false);
  });

  it('ends every terminal on shutdown, answers, and exits', async () => {
    const harness = await startHost();
    const daemon = await connect(harness);
    await daemon.endpoint.request('attach', { features: [] });
    await daemon.endpoint.request('spawn', SPAWN);
    await daemon.endpoint.request('spawn', { ...SPAWN, id: 'term-2' });
    await daemon.endpoint.request('shutdown', {});
    expect(named(daemon, 'exit').map((event) => event.id).sort()).toEqual(['term-1', 'term-2']);
    expect(harness.ptys.every((pty) => pty.killed)).toBe(true);
    await until(() => harness.exits.length === 1);
    expect(harness.exits).toEqual(['a daemon asked it to shut down']);
    // what main does on exit: the record goes, then the connection ends
    await harness.served.close();
    await harness.host.close();
    await daemon.closed;
    expect(await readHostRecords(harness.paths)).toEqual([]);
    await expect(fs.stat(hostTokenPath(harness.paths, harness.served.record))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(hostRecordFile(harness.paths, process.pid))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('closes only the connection that broke the contract', async () => {
    const harness = await startHost();
    const daemon = await connect(harness);
    await daemon.endpoint.request('attach', { features: [] });
    await daemon.endpoint.request('spawn', SPAWN);

    // a request before attach
    const early = await connect(harness);
    await expect(early.endpoint.request('list', {})).rejects.toThrow();
    await early.closed;
    // an event before attach
    const eventFirst = await connect(harness);
    eventFirst.endpoint.emit('input', { id: 'term-1', data: 'rm -rf ~\r' });
    await eventFirst.closed;
    // bytes that are no handshake
    const garbage = await rawSocket(harness);
    garbage.write(Buffer.alloc(64, 0xff));
    await new Promise((resolve) => garbage.once('close', resolve));
    // a request outside the tables, from the attached daemon's own table of another version
    const stranger = await connect(harness);
    await expect((stranger.endpoint.request as (method: string, params: unknown) => Promise<unknown>)('attach', { features: ['not a name'] })).rejects.toThrow();
    await stranger.closed;

    expect(harness.exits).toEqual([]);
    expect(harness.ptys[0]!.killed).toBe(false);
    expect(harness.ptys[0]!.written).toEqual([]);
    expect(daemon.isClosed()).toBe(false);
    harness.ptys[0]!.print('still running');
    await until(() => output(daemon) === 'still running');

    // a second attach on the attached connection costs that connection, and the terminal runs on
    await expect(daemon.endpoint.request('attach', { features: [] })).rejects.toThrow();
    await daemon.closed;
    const next = await connect(harness);
    expect((await next.endpoint.request('attach', { features: [] })).terminals.map((terminal) => terminal.id)).toEqual(['term-1']);
    expect(harness.ptys[0]!.killed).toBe(false);
  });

  it(`lets at most ${MAX_AUTHENTICATING} connections authenticate at once, the newest taking the oldest one's place`, async () => {
    const harness = await startHost();
    const silent: net.Socket[] = [];
    for (let index = 0; index < MAX_AUTHENTICATING; index++) silent.push(await rawSocket(harness));
    // a daemon is never kept out by peers that hold every slot and say nothing
    const daemon = await connect(harness);
    expect(await daemon.endpoint.request('attach', { features: [] })).toEqual({ terminals: [] });
    await until(() => silent[0]!.destroyed);
    expect(silent.slice(1).every((socket) => !socket.destroyed)).toBe(true);
  });

  it('logs refused connections at most once per interval, however many there are', async () => {
    const harness = await startHost();
    for (let index = 0; index < 3 * MAX_AUTHENTICATING; index++) await rawSocket(harness);
    const daemon = await connect(harness);
    await daemon.endpoint.request('attach', { features: [] });
    expect(harness.logs.filter((line) => line.includes('refused')).length).toBeLessThanOrEqual(1);
  });

  it('holds no terminal whose pty broke as it started: the spawn answers error and the pty is killed', async () => {
    const harness = await startHost();
    const daemon = await connect(harness);
    await daemon.endpoint.request('attach', { features: [] });
    await expect(daemon.endpoint.request('spawn', { ...SPAWN, file: '/broken' })).rejects.toThrow('the pty broke after it started');
    await until(() => named(daemon, 'error').length === 1);
    expect(named(daemon, 'error')[0]).toMatchObject({ id: 'term-1', message: 'the pty broke after it started' });
    expect(await daemon.endpoint.request('list', {})).toEqual({ terminals: [] });
    expect(harness.ptys[0]!.killed).toBe(true);
    // the id is free again
    await daemon.endpoint.request('spawn', SPAWN);
    expect((await daemon.endpoint.request('list', {})).terminals).toMatchObject([{ id: 'term-1', pid: 4001 }]);
    expect(daemon.isClosed()).toBe(false);
  });

  it('closes the link rather than send an event outside the contract, and keeps the terminal', async () => {
    const harness = await startHost();
    const daemon = await connect(harness);
    await daemon.endpoint.request('attach', { features: [] });
    // its ready would carry a pid past the contract's range
    void daemon.endpoint.request('spawn', { ...SPAWN, file: '/badpid' }).catch(() => undefined);
    await daemon.closed;
    expect(named(daemon, 'ready')).toEqual([]);
    expect(harness.exits).toEqual([]);
    expect(harness.ptys[0]!.killed).toBe(false);
  });

  it('answers error to a duplicate spawn and to one whose pty does not start, and keeps the running terminal', async () => {
    const harness = await startHost();
    const daemon = await connect(harness);
    await daemon.endpoint.request('attach', { features: [] });
    await daemon.endpoint.request('spawn', SPAWN);
    await daemon.endpoint.request('spawn', { ...SPAWN, title: 'again' });
    await until(() => named(daemon, 'error').length === 1);
    expect(named(daemon, 'error')).toEqual([{ name: 'error', id: 'term-1', message: 'terminal term-1 is already running' }]);
    expect(harness.ptys).toHaveLength(1);
    await daemon.endpoint.request('spawn', { ...SPAWN, id: 'term-2', file: '/missing' });
    await until(() => named(daemon, 'error').length === 2);
    expect(named(daemon, 'error')[1]).toEqual({ name: 'error', id: 'term-2', message: 'no such shell' });
    expect((await daemon.endpoint.request('list', {})).terminals).toMatchObject([{ id: 'term-1', title: 'sh' }]);
    expect(named(daemon, 'exit')).toEqual([]);
    expect(daemon.isClosed()).toBe(false);
  });

  it('answers every kill of a terminal only after its exit, a kill that finds it already ending included', async () => {
    // the first kill waits for the conpty throttle after the spawn, so the second finds it ending
    const harness = await startHost({ throttleConpty: true });
    const daemon = await connect(harness);
    await daemon.endpoint.request('attach', { features: [] });
    await daemon.endpoint.request('spawn', SPAWN);
    const exitsAtAnswer = (): Promise<number> => daemon.endpoint.request('kill', { id: 'term-1' }).then(() => named(daemon, 'exit').length);
    expect(await Promise.all([exitsAtAnswer(), exitsAtAnswer()])).toEqual([1, 1]);
    expect(harness.ptys[0]!.killed).toBe(true);
  });

  it('exits once it holds no terminal and no daemon is attached, but not before the check starts', async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    // under the links' 20 s keepalive timeout, which the faked clock also moves
    const checkMs = 10_000;
    const empty = await startHost({ emptyCheckMs: checkMs });
    await vi.advanceTimersByTimeAsync(checkMs / 2);
    expect(empty.exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(checkMs);
    expect(empty.exits).toEqual(['it holds no terminal and no daemon is attached']);

    const harness = await startHost({ emptyCheckMs: checkMs });
    const daemon = await connect(harness);
    await daemon.endpoint.request('attach', { features: [] });
    await vi.advanceTimersByTimeAsync(checkMs + 1000);
    // an attached daemon keeps an empty host
    expect(harness.exits).toEqual([]);
    await daemon.endpoint.request('spawn', SPAWN);
    daemon.protocol.close('the daemon exited');
    await until(() => harness.logs.some((line) => line.startsWith('[terminal-host] the connection of')));
    await vi.advanceTimersByTimeAsync(1000);
    // a terminal keeps a host no daemon is attached to
    expect(harness.exits).toEqual([]);
    expect(harness.ptys[0]!.killed).toBe(false);
    harness.ptys[0]!.exit(0);
    await until(() => harness.exits.length === 1);
  });

  it('starts the empty check only once it serves, so a slow start never exits before a daemon could find it', async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    const checkMs = 10_000;
    const harness = await startHost({ emptyCheckMs: checkMs, serving: false });
    await vi.advanceTimersByTimeAsync(checkMs * 3);
    expect(harness.exits).toEqual([]);
    harness.host.serving();
    await vi.advanceTimersByTimeAsync(checkMs / 2);
    expect(harness.exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(checkMs);
    expect(harness.exits).toEqual(['it holds no terminal and no daemon is attached']);
  });

  it('ends a terminal nobody viewed for the idle limit while no daemon is attached', async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    const harness = await startHost();
    const daemon = await connect(harness);
    await daemon.endpoint.request('attach', { features: [], idleDays: 2 });
    await daemon.endpoint.request('spawn', SPAWN);
    await daemon.endpoint.request('spawn', { ...SPAWN, id: 'term-2' });
    daemon.endpoint.emit('viewed', { id: 'term-2', viewed: false });
    // a later daemon that names no limit keeps the host's
    await leaves(harness, daemon);
    const adopter = await connect(harness);
    const { terminals } = await adopter.endpoint.request('attach', { features: [] });
    expect(terminals.map((terminal) => terminal.detachedAt !== undefined)).toEqual([true, true]);
    adopter.endpoint.emit('viewed', { id: 'term-1', viewed: true });
    await adopter.endpoint.request('list', {});
    await leaves(harness, adopter);

    await vi.advanceTimersByTimeAsync(2 * DAY_MS - 60_000);
    expect(harness.ptys.map((pty) => pty.killed)).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.ptys.map((pty) => pty.killed)).toEqual([true, true]);
    expect(harness.exits).toEqual(['it holds no terminal and no daemon is attached']);
  });

  it(`keeps the default of ${DEFAULT_HOSTED_IDLE_DAYS} days until a daemon names a limit, and 0 keeps a terminal forever`, async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    const harness = await startHost();
    const daemon = await connect(harness);
    await daemon.endpoint.request('attach', { features: [] });
    await daemon.endpoint.request('spawn', SPAWN);
    await leaves(harness, daemon);
    const forever = await startHost();
    const other = await connect(forever);
    await other.endpoint.request('attach', { features: [], idleDays: 0 });
    await other.endpoint.request('spawn', SPAWN);
    await leaves(forever, other);

    // setTimeout's longest delay is under 25 days, so the limit is reached over more than one timer
    await vi.advanceTimersByTimeAsync((DEFAULT_HOSTED_IDLE_DAYS - 1) * DAY_MS);
    expect(harness.ptys[0]!.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * DAY_MS);
    expect(harness.ptys[0]!.killed).toBe(true);
    await vi.advanceTimersByTimeAsync(400 * DAY_MS);
    expect(forever.ptys[0]!.killed).toBe(false);
  });

  it('hands its terminals to a second daemon, closes the first, and sends the second no screen the first asked for', async () => {
    const harness = await startHost();
    const first = await connect(harness);
    await first.endpoint.request('attach', { features: [] });
    await first.endpoint.request('spawn', SPAWN);
    harness.ptys[0]!.print('before');
    await until(() => output(first) === 'before');
    const gate = holdNextScreen(harness);
    first.endpoint.emit('serialize', { id: 'term-1' });
    await gate.entered;

    const second = await connect(harness);
    const { terminals } = await second.endpoint.request('attach', { features: [] });
    await first.closed;
    expect(terminals).toMatchObject([{ id: 'term-1', pid: 4000, title: 'sh', projectKey: '/srv/app', view: VIEW }]);
    // unviewed until the new daemon says otherwise
    expect(terminals[0]!.detachedAt).toBeGreaterThan(0);
    gate.release();
    second.endpoint.emit('serialize', { id: 'term-1' });
    await until(() => named(second, 'screen').length === 1);
    harness.ptys[0]!.print('after');
    await until(() => output(second) === 'after');
    second.endpoint.emit('input', { id: 'term-1', data: 'pwd\r' });
    await second.endpoint.request('list', {});
    expect(harness.ptys[0]!.written).toEqual(['pwd\r']);
    expect(named(second, 'screen')).toHaveLength(1);
    expect(named(second, 'screen')[0]!.data).toContain('before');
    expect(harness.ptys[0]!.killed).toBe(false);
    expect(harness.exits).toEqual([]);
  });

  it('paces a pty by the attached daemon\'s acks, by its own screen with no daemon, and starts from zero on each attach', async () => {
    const harness = await startHost();
    const daemon = await connect(harness);
    await daemon.endpoint.request('attach', { features: [] });
    await daemon.endpoint.request('spawn', SPAWN);
    const pty = harness.ptys[0]!;
    pty.print(BURST);
    await until(() => output(daemon).length === BURST.length);
    // the screen parsed it, and still only the daemon's acks count
    daemon.endpoint.emit('serialize', { id: 'term-1' });
    await until(() => named(daemon, 'screen').length === 1);
    expect(pty.paused).toBe(true);
    for (const event of named(daemon, 'data')) daemon.endpoint.emit('ack', { id: 'term-1', chars: event.data.length });
    await until(() => !pty.paused);

    pty.print(BURST);
    await until(() => pty.paused);
    // the daemon goes without acknowledging: the pty runs on, paced by the screen
    daemon.protocol.close('the daemon exited');
    await until(() => !pty.paused);
    for (let index = 0; index < 5; index++) pty.print(BURST);
    const adopter = await connect(harness);
    await adopter.endpoint.request('attach', { features: [] });
    adopter.endpoint.emit('serialize', { id: 'term-1' });
    await until(() => named(adopter, 'screen').length === 1);
    expect(pty.paused).toBe(false);
    // from zero for the new daemon, which has not acknowledged anything
    pty.print(BURST);
    await until(() => pty.paused);
  });
});

describe('the terminal host\'s endpoints', () => {
  const KEY = 'a'.repeat(24);
  const DAEMON_NONCE = 'd'.repeat(64);
  // a spawn whose environment names the daemon's own agent socket and relay, which the host's endpoints replace
  const ENDPOINTS: TerminalHostSpawn = {
    ...VIEWLESS,
    env: { PATH: '/bin', [CLI_HOOK_ENV]: 'inherited', SSH_AUTH_SOCK: '/tmp/damocles-daemon/agent.sock', DAMOCLES_ASKPASS_HANDLE: '/tmp/damocles-daemon/askpass.sock', DAMOCLES_CREDENTIAL_NONCE: DAEMON_NONCE },
    endpoints: { cli: true, relay: true, agentKey: KEY },
  };
  const windows = process.platform === 'win32';

  async function forwarding(harness: Harness): Promise<Daemon> {
    const daemon = await connect(harness);
    await daemon.endpoint.request('attach', { features: ['terminalHost.endpoints'] });
    return daemon;
  }

  // The daemon's link ends and the host has seen it, so connections from now on wait.
  async function detach(harness: Harness, daemon: Daemon): Promise<void> {
    const before = harness.logs.filter((line) => line.includes('[terminal-host] the connection of')).length;
    daemon.protocol.close('the daemon switched');
    await until(() => harness.logs.filter((line) => line.includes('[terminal-host] the connection of')).length > before);
  }

  // a shell process connecting to an endpoint its environment names
  async function dial(endpoint: string): Promise<net.Socket> {
    const socket = await openSocket(endpoint);
    socket.on('error', () => undefined);
    cleanups.push(async () => {
      socket.destroy();
    });
    return socket;
  }

  const closed = (socket: net.Socket): Promise<void> => (socket.destroyed ? Promise.resolve() : new Promise((resolve) => socket.once('close', () => resolve())));

  // the bytes a forwarded stream carries until it holds text
  const readStream = (stream: StreamChannel, text: string): Promise<void> => new Promise((resolve) => {
    let got = '';
    stream.onData((bytes) => {
      got += Buffer.from(bytes).toString('utf8');
      if (got === text) resolve();
    });
  });

  it('makes each terminal\'s endpoints before its shell starts and names them in place of the daemon\'s: a socket per terminal, one per agent key, one relay with the host\'s own nonce', async () => {
    const harness = await startHost();
    const daemon = await forwarding(harness);
    const made = serverOptions.length;
    await daemon.endpoint.request('spawn', ENDPOINTS);
    await daemon.endpoint.request('spawn', { ...ENDPOINTS, id: 'term-2' });
    // a CLI socket each, one agent socket and one relay, each accepting paused, so no byte is read before a daemon takes it
    expect(serverOptions.slice(made)).toEqual(Array.from({ length: 4 }, () => ({ pauseOnConnect: true })));
    const [first, second] = harness.ptys.map((pty) => pty.env);
    expect(first!['PATH']).toBe('/bin');
    expect(first![CLI_HOOK_ENV]).not.toBe(second![CLI_HOOK_ENV]);
    expect(first!['SSH_AUTH_SOCK']).toBe(second!['SSH_AUTH_SOCK']);
    expect(first!['DAMOCLES_ASKPASS_HANDLE']).toBe(second!['DAMOCLES_ASKPASS_HANDLE']);
    const [nonce] = named(daemon, 'relayNonce');
    expect(first!['DAMOCLES_CREDENTIAL_NONCE']).toBe(nonce!.nonce);
    expect(nonce!.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(nonce!.nonce).not.toBe(DAEMON_NONCE);
    const names = [first![CLI_HOOK_ENV]!, first!['SSH_AUTH_SOCK']!, first!['DAMOCLES_ASKPASS_HANDLE']!];
    if (windows) {
      expect(names[0]).toMatch(/^\\\\\.\\pipe\\damocles-cli-[0-9a-f]{32}$/);
      expect(names[1]).toMatch(/^\\\\\.\\pipe\\damocles-agent-[0-9a-f]{32}$/);
      expect(names[2]).toMatch(/^\\\\\.\\pipe\\damocles-relay-[0-9a-f]{32}$/);
    } else {
      const folder = harness.served.record.socketFolder!;
      for (const name of names) expect(path.dirname(name)).toBe(folder);
      expect(path.basename(names[0]!)).toMatch(/^cli-[0-9a-f]{24}\.sock$/);
      // a random name, never the key's
      expect(path.basename(names[1]!)).toMatch(/^agent-[0-9a-f]{24}\.sock$/);
      expect(path.basename(names[1]!)).not.toBe(`agent-${KEY}.sock`);
      expect(path.basename(names[2]!)).toMatch(/^askpass-[0-9a-f]{24}\.sock$/);
      expect((await fs.lstat(folder)).mode & 0o777).toBe(0o700);
      for (const name of [...names, second![CLI_HOOK_ENV]!]) {
        const stat = await fs.lstat(name);
        expect(stat.isSocket()).toBe(true);
        expect(stat.mode & 0o777).toBe(0o600);
      }
    }
  });

  // a daemon sends what is asked of a new terminal right behind its spawn, while the host still makes its endpoints
  it('runs the input and the kill that follow a spawn at once in order once its pty started, and answers the kill after its exit', async () => {
    const harness = await startHost();
    const daemon = await forwarding(harness);
    let release!: () => void;
    harness.endpointsHeld = new Promise((resolve) => { release = resolve; });
    const spawned = daemon.endpoint.request('spawn', { ...VIEWLESS, endpoints: { cli: true, relay: false } });
    daemon.endpoint.emit('input', { id: 'term-1', data: 'ls\r' });
    daemon.endpoint.emit('serialize', { id: 'term-1' });
    const exitsAtAnswer = daemon.endpoint.request('kill', { id: 'term-1' }).then(() => named(daemon, 'exit').length);
    // answered once the host took every message before it
    await daemon.endpoint.request('list', {});
    release();
    await spawned;
    expect(await exitsAtAnswer).toBe(1);
    expect(harness.ptys).toHaveLength(1);
    expect(harness.ptys[0]!.written).toEqual(['ls\r']);
    expect(harness.ptys[0]!.killed).toBe(true);
    expect(daemon.events.map((event) => event.name)).toEqual(['relayNonce', 'ready', 'screen', 'exit']);
    expect(named(daemon, 'exit')).toEqual([{ name: 'exit', id: 'term-1', exitCode: 1 }]);
    expect(await daemon.endpoint.request('list', {})).toEqual({ terminals: [] });
  });

  it.runIf(windows)('names each endpoint once in a shell\'s environment whatever the case of the daemon\'s variable', async () => {
    const harness = await startHost();
    const daemon = await forwarding(harness);
    await daemon.endpoint.request('spawn', { ...ENDPOINTS, env: { Path: 'C:\\Windows', Damocles_Cli_Hook: 'inherited', ssh_auth_sock: '\\\\.\\pipe\\openssh-ssh-agent' } });
    const keys = Object.keys(harness.ptys[0]!.env);
    for (const name of [CLI_HOOK_ENV, 'SSH_AUTH_SOCK']) expect(keys.filter((key) => key.toUpperCase() === name)).toEqual([name]);
    expect(keys).toContain('Path');
  });

  it('forwards a connection only to a daemon whose attach lists terminalHost.endpoints, reading none of its bytes before, and carries them both ways', async () => {
    const harness = await startHost();
    const plain = await connect(harness);
    await plain.endpoint.request('attach', { features: [] });
    await plain.endpoint.request('spawn', ENDPOINTS);
    const shell = await dial(harness.ptys[0]!.env[CLI_HOOK_ENV]!);
    shell.write('{"kind":"status"}\n');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(named(plain, 'connection')).toEqual([]);
    expect(named(plain, 'relayNonce')).toEqual([]);

    const daemon = await forwarding(harness);
    await until(() => named(daemon, 'connection').length === 1);
    // the nonce comes first
    expect(daemon.events.map((event) => event.name)).toEqual(['relayNonce', 'connection']);
    const [connection] = named(daemon, 'connection');
    expect(connection).toMatchObject({ kind: 'cli', terminalId: 'term-1' });
    const stream = daemon.streams.get(connection!.stream)!;
    await readStream(stream, '{"kind":"status"}\n');
    const answer = new Promise<string>((resolve) => shell.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8'))));
    stream.write(Buffer.from('{"ok":true}\n'));
    expect(await answer).toBe('{"ok":true}\n');
  });

  it('closes a forwarded connection whose peer never closes once the daemon ended its side, so it holds no stream of the link', async () => {
    const harness = await startHost();
    const daemon = await forwarding(harness);
    await daemon.endpoint.request('spawn', ENDPOINTS);
    // a peer that writes nothing and never ends its side, whatever the host ends
    const idle = net.connect({ path: harness.ptys[0]!.env['DAMOCLES_ASKPASS_HANDLE']!, allowHalfOpen: true });
    idle.on('error', () => undefined);
    cleanups.push(async () => {
      idle.destroy();
    });
    await new Promise((resolve) => idle.once('connect', resolve));
    await until(() => named(daemon, 'connection').length === 1);
    const stream = daemon.streams.get(named(daemon, 'connection')[0]!.stream)!;
    // the host's direction of the stream ends only once it let go of the connection, which frees the stream on both sides
    const released = new Promise<void>((resolve) => stream.onEnd(() => resolve()));
    stream.end();
    await released;
    expect(stream.closed).toBe(false);
  });

  it('holds the connections that arrive with no daemon attached and forwards them in arrival order once one attaches', async () => {
    const harness = await startHost();
    const first = await forwarding(harness);
    await first.endpoint.request('spawn', ENDPOINTS);
    await first.endpoint.request('spawn', { ...ENDPOINTS, id: 'term-2' });
    const [one, two] = harness.ptys.map((pty) => pty.env);
    await detach(harness, first);
    await dial(two![CLI_HOOK_ENV]!);
    await dial(one!['DAMOCLES_ASKPASS_HANDLE']!);
    await dial(one!['SSH_AUTH_SOCK']!);
    await dial(one![CLI_HOOK_ENV]!);
    const next = await forwarding(harness);
    await until(() => named(next, 'connection').length === 4);
    expect(named(next, 'connection').map(({ name: _name, stream: _stream, ...forward }) => forward)).toEqual([
      { kind: 'cli', terminalId: 'term-2' },
      { kind: 'relay' },
      { kind: 'agent', key: KEY },
      { kind: 'cli', terminalId: 'term-1' },
    ]);
  });

  it(`closes a held connection no daemon took within ${ENDPOINT_HOLD_MS} ms`, async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    const harness = await startHost();
    const daemon = await forwarding(harness);
    await daemon.endpoint.request('spawn', ENDPOINTS);
    await detach(harness, daemon);
    const shell = await dial(harness.ptys[0]!.env[CLI_HOOK_ENV]!);
    await vi.advanceTimersByTimeAsync(ENDPOINT_HOLD_MS - 1000);
    expect(shell.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    await closed(shell);
    expect(harness.logs).toContain(`[terminal-host] closed an endpoint connection no daemon took within ${ENDPOINT_HOLD_MS} ms`);
  });

  it(`holds at most ${MAX_HELD_ENDPOINT_CONNECTIONS} connections and closes the next one at once`, async () => {
    const harness = await startHost();
    const daemon = await forwarding(harness);
    await daemon.endpoint.request('spawn', ENDPOINTS);
    await detach(harness, daemon);
    const hook = harness.ptys[0]!.env[CLI_HOOK_ENV]!;
    const held: net.Socket[] = [];
    for (let index = 0; index < MAX_HELD_ENDPOINT_CONNECTIONS; index++) held.push(await dial(hook));
    const extra = await dial(hook);
    await closed(extra);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(held.every((socket) => !socket.destroyed)).toBe(true);
    const next = await forwarding(harness);
    await until(() => named(next, 'connection').length === MAX_HELD_ENDPOINT_CONNECTIONS);
  });

  it('closes a held connection when its terminal ends, with the terminal\'s own socket, and keeps the shared ones', async () => {
    const harness = await startHost();
    const daemon = await forwarding(harness);
    await daemon.endpoint.request('spawn', ENDPOINTS);
    await daemon.endpoint.request('spawn', { ...ENDPOINTS, id: 'term-2' });
    const env = harness.ptys[0]!.env;
    await detach(harness, daemon);
    const cli = await dial(env[CLI_HOOK_ENV]!);
    const relay = await dial(env['DAMOCLES_ASKPASS_HANDLE']!);
    harness.ptys[0]!.exit(0);
    await closed(cli);
    await expect(openSocket(env[CLI_HOOK_ENV]!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(relay.destroyed).toBe(false);
    // term-2 still names the agent socket of the key
    await dial(env['SSH_AUTH_SOCK']!);
  });

  it.runIf(process.platform !== 'win32')('binds a socket a cleaner removed again at the same path on the daily touch', async () => {
    const harness = await startHost();
    const daemon = await forwarding(harness);
    await daemon.endpoint.request('spawn', ENDPOINTS);
    const hook = harness.ptys[0]!.env[CLI_HOOK_ENV]!;
    await fs.rm(hook);
    await expect(openSocket(hook)).rejects.toMatchObject({ code: 'ENOENT' });
    await harness.host.touchEndpoints();
    expect((await fs.lstat(hook)).mode & 0o777).toBe(0o600);
    await dial(hook);
    await until(() => named(daemon, 'connection').length === 1);
    expect(harness.logs).toContain(`[terminal-host] ${hook} was removed; bound it again`);
  });

  it.runIf(process.platform !== 'win32')('makes its removed folder again only by its own exclusive mkdir, and leaves the endpoints gone when the folder at that path is not its own', async () => {
    const harness = await startHost();
    const daemon = await forwarding(harness);
    await daemon.endpoint.request('spawn', ENDPOINTS);
    const env = harness.ptys[0]!.env;
    const folder = harness.served.record.socketFolder!;
    await fs.rm(folder, { recursive: true });
    await harness.host.touchEndpoints();
    expect((await fs.lstat(folder)).mode & 0o777).toBe(0o700);
    expect(harness.logs).toContain(`[terminal-host] made its socket folder ${folder} again`);
    await dial(env[CLI_HOOK_ENV]!);
    await until(() => named(daemon, 'connection').length === 1);

    // another made a folder at that path first: no endpoint binds in it
    await fs.rm(folder, { recursive: true });
    await fs.mkdir(folder, { mode: 0o755 });
    await fs.chmod(folder, 0o755);
    await harness.host.touchEndpoints();
    for (const name of [env[CLI_HOOK_ENV]!, env['SSH_AUTH_SOCK']!, env['DAMOCLES_ASKPASS_HANDLE']!]) {
      expect(harness.logs.some((line) => line.startsWith(`[terminal-host] ${name} was removed and stays gone: ${folder} has mode 755`))).toBe(true);
      await expect(fs.lstat(name)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    // a new terminal's endpoints are refused there too, so its spawn starts nothing
    await expect(daemon.endpoint.request('spawn', { ...ENDPOINTS, id: 'term-2' })).rejects.toThrow();
    expect(harness.ptys).toHaveLength(1);
    // the host's own removal leaves a folder that is not its own, so the test takes it
    await fs.rm(folder, { recursive: true });
  });

  // its files go once it stops, so an endpoint made after that would outlive the host
  it('makes no endpoint once it stops, and a spawn that needs one starts nothing', async () => {
    const harness = await startHost();
    const daemon = await forwarding(harness);
    harness.host.stop();
    await expect(daemon.endpoint.request('spawn', ENDPOINTS)).rejects.toThrow('the terminal host is closing');
    expect(harness.ptys).toEqual([]);
    expect(named(daemon, 'error')).toMatchObject([{ id: 'term-1', message: 'the terminal host is closing' }]);
  });

  it.runIf(process.platform !== 'win32')('makes no removed folder again on a touch once it stops', async () => {
    const harness = await startHost();
    const daemon = await forwarding(harness);
    await daemon.endpoint.request('spawn', ENDPOINTS);
    const folder = harness.served.record.socketFolder!;
    await fs.rm(folder, { recursive: true });
    const touched = harness.host.touchEndpoints();
    harness.host.stop();
    await touched;
    await expect(fs.lstat(folder)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(harness.logs).not.toContain(`[terminal-host] made its socket folder ${folder} again`);
  });
});
