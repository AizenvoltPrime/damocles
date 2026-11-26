import { existsSync, promises as fs, realpathSync } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendCliRequest, type CliAnswer } from '../../cli/cli-protocol';
import { agentSocketFile } from '../../core-protocol/agent-sockets';
import { WALK_CLOSE_WAIT_MS, type WalkChild } from '../../../core/search-walk/walk-host';
import type { TerminalPost } from '../../workspace/messages';
import { CLI_HOOK_ENV } from '../../workspace/terminal/terminal-env';
import { activeLinkPath } from '../active-link';
import { daemonAnswers } from '../attach';
import type { CoreAttach } from '../control-messages';
import type { ForkedChild } from '../process-starts';
import { buildDaemon, EXIT_LOCK_LOST, EXIT_SHUTDOWN_FAILED, type Daemon, type DaemonDeps, type DaemonStarters } from '../serve';
import { createTerminalHosts } from '../terminal-hosts';
import { IDLE_EXIT_MS } from '../lifetime';
import { LOCK_UPDATE_MS } from '../lock-timing';
import { acquireDaemonLock } from '../singleton';
import { localRunPaths, makeRunDir, readHostRecords, readPidFile, runPaths, tokenPath, writePidFile, type PidRecord, type RunPaths } from '../token';
import { REPO_ROOT, startInProcessDaemon, startTestHost, TEST_FACTS, type InProcessDaemon, type TestHost } from './in-process-daemon';
import { connectClient, type TestClient } from './test-client';

const NOT_CONNECTED: CliAnswer = { ok: false, code: 'notConnected', language: 'en' };

const NO_HOSTS: DaemonStarters = {
  startFormatterHost: () => { throw new Error('no formatter host in this test'); },
};

const SPAWN: TerminalPost = { type: 'spawn', id: 'term-1', file: '/bin/sh', args: [], cwd: '/', env: {}, cols: 80, rows: 24, scrollback: 1000 };

const CORE_ATTACH: CoreAttach = {
  attach: 1,
  hostId: 'client-host',
  appInfo: { version: '0.0.0-test', host: 'desktop' },
  secretsPersistent: true,
  chatBrowserPane: true,
  mirrors: { trust: { keys: [] }, folders: { folders: [] }, editor: {}, terminal: { shown: false, shortcut: '' }, language: { language: 'en' }, clientAuth: { providers: {} }, clientUser: { settings: {}, permissionRules: [] }, clientPolicy: { voice: false, allowBypass: false } },
};

// the terminal host the daemon starts for its first terminal: the real host in this process, over ptys the test reads
function terminalHost(): { start: () => Promise<number>; started: () => TestHost | undefined; stop: () => Promise<void> } {
  let host: TestHost | undefined;
  return {
    start: async () => {
      host = await startTestHost(await localRunPaths());
      return host.pid;
    },
    started: () => host,
    stop: async () => {
      if (host && !host.hasExited()) await host.stop();
    },
  };
}

// a Damocles Core that never answers and ends only when killed
function stubbornCore(): { fork: () => ForkedChild; posted: unknown[]; started: () => boolean; killed: () => boolean } {
  const posted: unknown[] = [];
  let started = false;
  let killed = false;
  return {
    posted,
    started: () => started,
    killed: () => killed,
    fork: () => {
      started = true;
      let exit: (end: { code: number; signal: string | null; error: string | null }) => void = () => undefined;
      return {
        pid: 4242,
        postMessage: (message) => posted.push(message),
        onMessage: () => undefined,
        onExit: (listener) => { exit = listener; },
        kill: () => {
          killed = true;
          exit({ code: 1, signal: null, error: null });
        },
      };
    },
  };
}

// a Damocles Core that answers core.shutdown and ends when killed, as a real one does
function answeringCore(): { fork: () => ForkedChild } {
  return {
    fork: () => {
      let receive: (message: unknown) => void = () => undefined;
      let exit: (end: { code: number; signal: string | null; error: string | null }) => void = () => undefined;
      return {
        pid: 4243,
        postMessage: (message) => {
          const envelope = message as { kind?: string; id?: number; method?: string };
          if (envelope.kind === 'request' && envelope.method === 'core.shutdown') receive({ kind: 'response', id: envelope.id, ok: true, result: undefined });
        },
        onMessage: (listener) => { receive = listener; },
        onExit: (listener) => { exit = listener; },
        kill: () => exit({ code: 0, signal: null, error: null }),
      };
    },
  };
}

const markFile = (at: RunPaths): string => path.join(at.runDir, 'handed-over.json');

// the hand-over mark as it lies in the run folder, or undefined when there is none
async function readMark(at: RunPaths): Promise<unknown> {
  const text = await fs.readFile(markFile(at), 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  });
  return text === undefined ? undefined : JSON.parse(text);
}

let home: string;
let paths: RunPaths;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-shutdown-'));
  paths = runPaths(home, '0123456789abcdef');
  await makeRunDir(paths);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

// The daemon of `closeEndpoint` and `releaseLock`, and the exit it reaches: its reason and code.
function daemonWith(closeEndpoint: DaemonDeps['closeEndpoint'], lines: string[] = [], releaseLock: DaemonDeps['releaseLock'] = async () => undefined): { daemon: Daemon; exited: Promise<{ reason: string; code: number }> } {
  let exited!: (exit: { reason: string; code: number }) => void;
  const exit = new Promise<{ reason: string; code: number }>((resolve) => { exited = resolve; });
  const daemon = buildDaemon({
    git: { available: false, reason: 'not probed in tests' },
    e2eHooks: false,
    root: REPO_ROOT,
    terminalRoot: REPO_ROOT,
    version: '0.0.0-test',
    facts: TEST_FACTS,
    paths,
    starters: NO_HOSTS,
    closeEndpoint,
    abandonEndpoint: async () => undefined,
    releaseLock,
    exit: (reason, code) => exited({ reason, code }),
    log: (line) => lines.push(line),
  });
  return { daemon, exited: exit };
}

describe('daemon shutdown', () => {
  it('still runs every later step and exits, with a failure code, when closing the endpoint fails', async () => {
    const lines: string[] = [];
    const { daemon, exited } = daemonWith(() => Promise.reject(new Error('the run folder is gone')), lines);
    await daemon.shutdown('control.shutdownNow', 'end');
    expect(await exited).toEqual({ reason: 'control.shutdownNow', code: EXIT_SHUTDOWN_FAILED });
    expect(lines).toContain('[daemon] shutdown: closing the endpoint failed: the run folder is gone');
  });

  it('exits with 0 when every step succeeds', async () => {
    const { daemon, exited } = daemonWith(async () => undefined);
    await daemon.shutdown('idle', 'release');
    expect(await exited).toEqual({ reason: 'idle', code: 0 });
  });

  // a daemon with one terminal in the terminal host it started
  async function daemonWithTerminal(): Promise<{ daemon: InProcessDaemon; client: TestClient; host: TestHost; stop: () => Promise<void> }> {
    const pty = terminalHost();
    const daemon = await startInProcessDaemon({ starters: NO_HOSTS, startTerminalHost: pty.start });
    const client = await connectClient(await daemon.connect());
    client.workspace.emit('terminals.post', { request: SPAWN });
    await vi.waitFor(async () => expect(await client.workspace.request('terminals.list', {})).toHaveLength(1));
    return { daemon, client, host: pty.started()!, stop: pty.stop };
  }

  it.each([
    ['a stop signal', (daemon: InProcessDaemon) => daemon.daemon.shutdown('it received SIGTERM', 'release'), false],
    ['control.handOver now', (_daemon: InProcessDaemon, client: TestClient) => client.control.request('handOver', { when: 'now' }), true],
    ['control.handOver idle with no chat run', (_daemon: InProcessDaemon, client: TestClient) => client.control.request('handOver', { when: 'idle' }), true],
    ['control.handOverIfIdle with no chat run', (_daemon: InProcessDaemon, client: TestClient) => client.control.request('handOverIfIdle', {}), true],
  ] as const)('leaves every terminal with its host on %s, and the next daemon adopts it', async (_name, stop, marks) => {
    const { daemon, client, host, stop: stopHost } = await daemonWithTerminal();
    try {
      await fs.rm(markFile(daemon.paths), { force: true });
      await stop(daemon, client);
      expect(await daemon.exitCode).toBe(0);
      expect(await readMark(daemon.paths)).toEqual(marks ? { version: daemon.version, at: expect.any(Number) } : undefined);
      expect(host.ptys.map((pty) => pty.killed)).toEqual([false]);
      expect(host.hasExited()).toBe(false);
      const next = await startInProcessDaemon({ starters: NO_HOSTS, startTerminalHost: () => Promise.reject(new Error('no start in this test')) });
      const again = await connectClient(await next.connect());
      expect((await again.workspace.request('terminals.list', {})).map((terminal) => `${terminal.id} ${terminal.pid}`)).toEqual([`term-1 ${host.ptys[0]!.pid}`]);
      // the frozen shutdownNow still ends every terminal, and with them the host
      await again.control.request('shutdownNow', {});
      expect(await next.exitCode).toBe(0);
      expect(await host.exited).toBe('a daemon asked it to shut down');
      expect(host.ptys.map((pty) => pty.killed)).toEqual([true]);
    } finally {
      await stopHost();
    }
  }, 20_000);

  it('leaves no hand-over mark when it exits on shutdownWhenIdle or once idle', async () => {
    const daemon = await startInProcessDaemon({ starters: NO_HOSTS });
    await fs.rm(markFile(daemon.paths), { force: true });
    const client = await connectClient(await daemon.connect());
    await client.control.request('shutdownWhenIdle', {});
    expect(await daemon.exitCode).toBe(0);
    expect(await readMark(daemon.paths)).toBeUndefined();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { exited } = daemonWith(async () => undefined);
      await vi.advanceTimersByTimeAsync(IDLE_EXIT_MS);
      expect(await exited).toEqual({ reason: `no client, run or terminal for ${IDLE_EXIT_MS} ms`, code: 0 });
    } finally {
      vi.useRealTimers();
    }
    expect(await readMark(paths)).toBeUndefined();
  });

  it('ends every terminal and its host on a removal\'s shutdown', async () => {
    const { daemon, client, host, stop: stopHost } = await daemonWithTerminal();
    try {
      await client.control.request('shutdownForRemoval', {});
      expect(await daemon.exitCode).toBe(0);
      expect(await host.exited).toBe('a daemon asked it to shut down');
      expect(await readHostRecords(daemon.paths)).toEqual([]);
    } finally {
      await stopHost();
    }
  }, 20_000);

  it('stops at once when another daemon took its lock, killing its children, leaving the new owner\'s pid file and lock alone, and ending no terminal host', async () => {
    const pty = terminalHost();
    const core = stubbornCore();
    const lines: string[] = [];
    const daemon = await startInProcessDaemon({ starters: NO_HOSTS, startTerminalHost: pty.start, forkCore: core.fork, credentialRelay: true, log: (line) => lines.push(line) });
    // the folders under the socket base are this daemon's alone, so they go even when the run folder is left to the new owner
    const ownFolders = [daemon.daemon.agentProxy.folder(), process.platform === 'win32' ? undefined : path.dirname(daemon.relay!.identity().handle)].filter((folder) => folder !== undefined);
    expect(ownFolders).toHaveLength(process.platform === 'win32' ? 0 : 2);
    const client = await connectClient(await daemon.connect());
    await client.control.request('attachCore', CORE_ATTACH);
    // a damocles --wait whose client never answers holds no step
    const { answer } = await waitingCliRequest(client, pty.started);
    expect(core.started()).toBe(true);
    // the new owner's lock has its own mtime, and its pid file names it
    const newer: PidRecord = { ...(await readPidFile(daemon.paths.pidFile))!, pid: process.pid + 1, updatedAt: Date.now() };
    await writePidFile(daemon.paths.pidFile, newer);
    const taken = new Date(Date.now() - 60_000);
    await fs.utimes(daemon.paths.lockFile, taken, taken);
    // proper-lockfile finds the mtime changed at its next refresh
    expect(await daemon.exitCode).toBe(EXIT_LOCK_LOST);
    expect(await daemon.exited).toBe('the daemon lock was compromised');
    await expect(answer).resolves.toEqual(NOT_CONNECTED);
    expect(await client.closed).toBeTruthy();
    expect(core.killed()).toBe(true);
    // the lock's new owner adopts the host: its terminal runs on, and its record still names it
    const host = pty.started()!;
    expect(host.ptys.map((terminal) => terminal.killed)).toEqual([false]);
    expect(host.hasExited()).toBe(false);
    const owner = createTerminalHosts({ paths: daemon.paths, version: daemon.version, start: () => Promise.reject(new Error('no start in this test')), log: () => undefined });
    const adopted: string[][] = [];
    owner.onLink((link) => adopted.push(link.terminals.map((terminal) => terminal.id)));
    await owner.adoptAll();
    expect(adopted).toEqual([['term-1']]);
    owner.release('the test ended');
    await pty.stop();
    expect(JSON.stringify(core.posted)).not.toContain('core.shutdown');
    expect(lines.some((line) => line.startsWith('[daemon] shutting down'))).toBe(false);
    expect(await readPidFile(daemon.paths.pidFile)).toEqual(newer);
    expect((await fs.stat(daemon.paths.lockFile)).mtimeMs).toBe(taken.getTime());
    for (const folder of ownFolders) expect(existsSync(folder)).toBe(false);
    await fs.rm(daemon.paths.lockFile, { recursive: true });
    await fs.rm(daemon.paths.pidFile);
  }, LOCK_UPDATE_MS * 3);

  it('kills a walk process stuck in a read when it lost its lock, and waits WALK_CLOSE_WAIT_MS for it at most', async () => {
    const lines: string[] = [];
    let kills = 0;
    let asked!: () => void;
    const walking = new Promise<void>((resolve) => (asked = resolve));
    // a process whose read never returns, which no kill ends
    const stuck: WalkChild = {
      onReply: () => undefined,
      onStderr: () => undefined,
      send: async (request) => {
        if (request.kind === 'walk') asked();
      },
      exited: new Promise(() => undefined),
      kill: () => void kills++,
    };
    const daemon = await startInProcessDaemon({ starters: NO_HOSTS, walkChild: () => stuck, log: (line) => lines.push(line) });
    const client = await connectClient(await daemon.connect());
    await client.workspace.request('quickOpen.list', { runId: 1, root: home, ignore: { files: true, global: true, parents: true }, excludes: [] });
    await walking;
    const started = Date.now();
    void daemon.daemon.lockLost('the daemon lock was compromised');
    expect(await daemon.exitCode).toBe(EXIT_LOCK_LOST);
    expect(Date.now() - started).toBeLessThan(WALK_CLOSE_WAIT_MS + 2_000);
    expect(kills).toBeGreaterThan(0);
    expect(lines).toContain(`[walk] a walk process did not exit within ${WALK_CLOSE_WAIT_MS} ms of its kill`);
    await fs.rm(daemon.paths.lockFile, { recursive: true });
    await fs.rm(daemon.paths.pidFile);
  });

  it('leaves a pid file another daemon wrote when it shuts down', async () => {
    const daemon = await startInProcessDaemon({ starters: NO_HOSTS });
    const other: PidRecord = { ...(await readPidFile(daemon.paths.pidFile))!, pid: process.pid + 1 };
    await writePidFile(daemon.paths.pidFile, other);
    await daemon.shutdown();
    expect(await daemon.exitCode).toBe(0);
    expect(await readPidFile(daemon.paths.pidFile)).toEqual(other);
    await fs.rm(daemon.paths.pidFile);
  });

  it('holds the daemon lock until its last step, so a start waiting for it never runs beside the shutdown', async () => {
    // ending a terminal host's terminals holds the shutdown after the endpoint closed
    const pty = terminalHost();
    const daemon = await startInProcessDaemon({ starters: NO_HOSTS, startTerminalHost: pty.start });
    const client = await connectClient(await daemon.connect());
    client.workspace.emit('terminals.post', { request: SPAWN });
    await vi.waitFor(() => expect(pty.started()?.ptys).toHaveLength(1));
    let exited = false;
    void daemon.exited.then(() => {
      exited = true;
    });
    const shutdown = daemon.shutdown();
    // the real probe: a daemon shutting down closed its endpoint first, so the start waits for the lock instead of giving up
    const lock = await acquireDaemonLock(daemon.paths, () => undefined, () => daemonAnswers(daemon.paths));
    expect(lock.held).toBe(true);
    expect(exited).toBe(true);
    if (lock.held) await lock.release();
    await shutdown;
  }, 20_000);

  it('ends while a terminal\'s damocles --wait waits for its client, answering it not connected', async () => {
    const pty = terminalHost();
    const daemon = await startInProcessDaemon({ starters: NO_HOSTS, startTerminalHost: pty.start });
    const client = await connectClient(await daemon.connect());
    const { answer } = await waitingCliRequest(client, pty.started);
    await daemon.shutdown();
    expect(await daemon.exitCode).toBe(0);
    await expect(answer).resolves.toEqual(NOT_CONNECTED);
  }, 20_000);

  it('gives a checkout daemon\'s terminals the damocles and BROWSER the desktop build writes, through the active link', async () => {
    const pty = terminalHost();
    const daemon = await startInProcessDaemon({ starters: NO_HOSTS, startTerminalHost: pty.start });
    const client = await connectClient(await daemon.connect());
    client.workspace.emit('terminals.post', { request: SPAWN });
    const env = await vi.waitFor(() => {
      expect(spawnEnv(pty.started)).toBeDefined();
      return spawnEnv(pty.started)!;
    });
    try {
      expect(realpathSync(activeLinkPath(daemon.paths.runDir))).toBe(realpathSync(REPO_ROOT));
      const bin = path.join(activeLinkPath(daemon.paths.runDir), 'dist', 'server-bin');
      expect(env['BROWSER']).toBe(path.join(bin, 'helpers', process.platform === 'win32' ? 'browser.exe' : 'browser.sh'));
      const searchPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1];
      expect(searchPath?.split(path.delimiter)[0]).toBe(path.join(bin, 'remote-cli'));
    } finally {
      await daemon.shutdown();
    }
  }, 20_000);
});

describe.runIf(process.platform !== 'win32')('a daemon whose active link cannot be pointed', () => {
  it('gives its terminals the package\'s own paths, as a shell that outlives it then does', async () => {
    // a folder in the link's place, which rename(2) does not replace; an earlier test's daemon left a link there, which goes
    // as a link, never through it
    const runDir = (await localRunPaths()).runDir;
    await fs.unlink(activeLinkPath(runDir)).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    });
    await fs.mkdir(path.join(activeLinkPath(runDir), 'kept'), { recursive: true });
    const pty = terminalHost();
    const lines: string[] = [];
    const daemon = await startInProcessDaemon({ starters: NO_HOSTS, startTerminalHost: pty.start, log: (line) => lines.push(line) });
    try {
      const client = await connectClient(await daemon.connect());
      client.workspace.emit('terminals.post', { request: SPAWN });
      const env = await vi.waitFor(() => {
        expect(spawnEnv(pty.started)).toBeDefined();
        return spawnEnv(pty.started)!;
      });
      expect(env['BROWSER']).toBe(path.join(REPO_ROOT, 'dist', 'server-bin', 'helpers', 'browser.sh'));
      expect(lines.some((line) => line.startsWith(`[daemon] pointing ${activeLinkPath(runDir)} at ${REPO_ROOT} failed, so terminals name ${REPO_ROOT}`))).toBe(true);
    } finally {
      await daemon.shutdown();
      await fs.rm(activeLinkPath(runDir), { recursive: true, force: true });
    }
  }, 20_000);
});

// the environment the daemon's terminal host started its first pty with
function spawnEnv(host: () => TestHost | undefined): Readonly<Record<string, string>> | undefined {
  return host()?.ptys[0]?.env;
}

// Spawns a terminal through client and sends `damocles --wait` on its socket; client takes the relay and never answers.
async function waitingCliRequest(client: TestClient, host: () => TestHost | undefined): Promise<{ readonly answer: Promise<CliAnswer> }> {
  const relayed: unknown[] = [];
  client.workspace.serve('cli.request', (relay) => {
    relayed.push(relay);
    return new Promise(() => undefined);
  });
  client.workspace.emit('terminals.post', { request: SPAWN });
  const hook = await vi.waitFor(() => {
    expect(spawnEnv(host)?.[CLI_HOOK_ENV]).toBeDefined();
    return spawnEnv(host)![CLI_HOOK_ENV]!;
  });
  const answer = sendCliRequest(() => net.connect(hook), { kind: 'open', cwd: '/srv', items: [{ path: '/srv/COMMIT_EDITMSG' }], wait: true });
  await vi.waitFor(() => expect(relayed).toHaveLength(1));
  return { answer };
}

describe.runIf(process.platform !== 'win32')('a shutdown on POSIX', () => {
  it('removes every socket folder the daemon made, a client\'s agent socket included, and exits 0', async () => {
    const agents = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-agent-'));
    const agentSock = path.join(agents, 'agent.1');
    const agent = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => agent.listen(agentSock, resolve));
    try {
      const daemon = await startInProcessDaemon({ starters: NO_HOSTS, credentialRelay: true, forkCore: answeringCore().fork });
      const client = await connectClient(await daemon.connect(agentSock), { clientId: 'laptop' });
      expect(client.outcome.kind).toBe('welcome');
      // the agent proxy opens a client's socket only while its policy forwards the agent
      await client.control.request('attachCore', { ...CORE_ATTACH, mirrors: { ...CORE_ATTACH.mirrors, clientPolicy: { ...CORE_ATTACH.mirrors.clientPolicy, agentForwarding: true } } });
      await daemon.daemon.agentProxy.settled();
      const agentFolder = daemon.daemon.agentProxy.folder()!;
      expect(existsSync(agentSocketFile(agentFolder, 'laptop'))).toBe(true);
      const folders = [(await readPidFile(daemon.paths.pidFile))!.socketFolder!, agentFolder, path.dirname(daemon.relay!.identity().handle)];
      expect(new Set(folders).size).toBe(3);
      await daemon.shutdown();
      expect(await daemon.exitCode).toBe(0);
      for (const folder of folders) expect(existsSync(folder)).toBe(false);
      expect(await readPidFile(daemon.paths.pidFile)).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => agent.close(() => resolve()));
      await fs.rm(agents, { recursive: true, force: true });
    }
  });
});

describe('a shutdown during a rebind', () => {
  // a daemon whose token is removed, so its next touch binds again; the shutdown starts at the first log line trigger names
  async function rebindingDaemon(trigger: string): Promise<{ daemon: InProcessDaemon; first: PidRecord; lines: string[] }> {
    const lines: string[] = [];
    const holder: { daemon?: InProcessDaemon } = {};
    const daemon = await startInProcessDaemon({
      starters: NO_HOSTS,
      touchIntervalMs: 20,
      log: (line) => {
        lines.push(line);
        if (line.startsWith(trigger)) void holder.daemon?.shutdown();
      },
    });
    holder.daemon = daemon;
    const first = (await readPidFile(daemon.paths.pidFile))!;
    await fs.rm(tokenPath(daemon.paths, first));
    expect(await daemon.exitCode).toBe(0);
    return { daemon, first, lines };
  }

  it('binds no new endpoint once the shutdown began', async () => {
    const { daemon, first, lines } = await rebindingDaemon('[daemon] the socket folder, socket or token was removed');
    // a bind the shutdown did not stop would land within this
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(lines.filter((line) => line.startsWith('[daemon] listening on'))).toEqual([`[daemon] listening on ${first.endpoint}`]);
    expect(await readPidFile(daemon.paths.pidFile)).toBeUndefined();
  });

  it('closes the endpoint a rebind in flight bound and removes its pid file', async () => {
    const { daemon, first, lines } = await rebindingDaemon('[daemon] listening on');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const bound = lines.filter((line) => line.startsWith('[daemon] listening on')).map((line) => line.slice('[daemon] listening on '.length));
    expect(bound).toHaveLength(2);
    expect(bound[0]).toBe(first.endpoint);
    expect(await reachable(bound[1]!)).toBe(false);
    expect(await readPidFile(daemon.paths.pidFile)).toBeUndefined();
  });
});

function reachable(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(endpoint);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}
