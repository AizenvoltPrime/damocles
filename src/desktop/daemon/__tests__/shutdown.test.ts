import { existsSync, promises as fs } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSocketFile } from '../../core-protocol/agent-sockets';
import type { HostStarters, PtyHostProcess } from '../../workspace/host-starters';
import type { TerminalPost } from '../../workspace/messages';
import { daemonAnswers } from '../attach';
import type { CoreAttach } from '../control-messages';
import type { ForkedChild } from '../process-starts';
import { buildDaemon, EXIT_LOCK_LOST, EXIT_SHUTDOWN_FAILED, type Daemon, type DaemonDeps } from '../serve';
import { LOCK_UPDATE_MS } from '../lock-timing';
import { acquireDaemonLock } from '../singleton';
import { makeRunDir, readPidFile, runPaths, tokenPath, writePidFile, type PidRecord, type RunPaths } from '../token';
import { REPO_ROOT, startInProcessDaemon, TEST_FACTS, type InProcessDaemon } from './in-process-daemon';
import { connectClient } from './test-client';

const NO_HOSTS: HostStarters = {
  startPtyHost: () => { throw new Error('no pty host in this test'); },
  startFormatterHost: () => { throw new Error('no formatter host in this test'); },
};

const SPAWN: TerminalPost = { type: 'spawn', id: 'term-1', file: '/bin/sh', args: [], cwd: '/', env: {}, cols: 80, rows: 24, scrollback: 1000 };

const CORE_ATTACH: CoreAttach = {
  attach: 1,
  hostId: 'client-host',
  appInfo: { version: '0.0.0-test', host: 'desktop' },
  secretsPersistent: true,
  chatBrowserPane: true,
  mirrors: { state: { global: {}, workspace: {} }, trust: { keys: [] }, folders: { folders: [] }, editor: {}, terminal: { shown: false, shortcut: '' }, language: { language: 'en' }, clientAuth: { providers: {} }, clientUser: { settings: {}, permissionRules: [] }, clientPolicy: { voice: false, allowBypass: false } },
};

// a pty host that ignores its shutdown and ends only when killed
function stubbornPtyHost(): { start: () => PtyHostProcess; posted: unknown[]; started: () => boolean; killed: () => boolean } {
  const posted: unknown[] = [];
  let started = false;
  let killed = false;
  return {
    posted,
    started: () => started,
    killed: () => killed,
    start: () => {
      started = true;
      let exit: (end: { code: number; reason: null; error: null }) => void = () => undefined;
      return {
        postMessage: (message) => posted.push(message),
        onMessage: () => undefined,
        onExit: (listener) => { exit = listener; },
        kill: () => {
          killed = true;
          exit({ code: 1, reason: null, error: null });
        },
      };
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
    await daemon.shutdown('control.shutdownNow');
    expect(await exited).toEqual({ reason: 'control.shutdownNow', code: EXIT_SHUTDOWN_FAILED });
    expect(lines).toContain('[daemon] shutdown: closing the endpoint failed: the run folder is gone');
  });

  it('exits with 0 when every step succeeds', async () => {
    const { daemon, exited } = daemonWith(async () => undefined);
    await daemon.shutdown('idle');
    expect(await exited).toEqual({ reason: 'idle', code: 0 });
  });

  it('stops at once when another daemon took its lock, killing its children and leaving the new owner\'s pid file and lock alone', async () => {
    const pty = stubbornPtyHost();
    const core = stubbornCore();
    const lines: string[] = [];
    const daemon = await startInProcessDaemon({ starters: { ...NO_HOSTS, startPtyHost: pty.start }, forkCore: core.fork, credentialRelay: true, log: (line) => lines.push(line) });
    // the folders under the socket base are this daemon's alone, so they go even when the run folder is left to the new owner
    const ownFolders = [daemon.daemon.agentProxy.folder(), process.platform === 'win32' ? undefined : path.dirname(daemon.relay!.identity().handle)].filter((folder) => folder !== undefined);
    expect(ownFolders).toHaveLength(process.platform === 'win32' ? 0 : 2);
    const client = await connectClient(await daemon.connect());
    await client.control.request('attachCore', CORE_ATTACH);
    client.workspace.emit('terminals.post', { request: SPAWN });
    await vi.waitFor(() => expect(pty.started()).toBe(true));
    expect(core.started()).toBe(true);
    // the new owner's lock has its own mtime, and its pid file names it
    const newer: PidRecord = { ...(await readPidFile(daemon.paths.pidFile))!, pid: process.pid + 1, updatedAt: Date.now() };
    await writePidFile(daemon.paths.pidFile, newer);
    const taken = new Date(Date.now() - 60_000);
    await fs.utimes(daemon.paths.lockFile, taken, taken);
    // proper-lockfile finds the mtime changed at its next refresh
    expect(await daemon.exitCode).toBe(EXIT_LOCK_LOST);
    expect(await daemon.exited).toBe('the daemon lock was compromised');
    expect(await client.closed).toBeTruthy();
    expect(pty.killed() && core.killed()).toBe(true);
    expect(pty.posted).not.toContainEqual({ type: 'shutdown' });
    expect(JSON.stringify(core.posted)).not.toContain('core.shutdown');
    expect(lines.some((line) => line.startsWith('[daemon] shutting down'))).toBe(false);
    expect(await readPidFile(daemon.paths.pidFile)).toEqual(newer);
    expect((await fs.stat(daemon.paths.lockFile)).mtimeMs).toBe(taken.getTime());
    for (const folder of ownFolders) expect(existsSync(folder)).toBe(false);
    await fs.rm(daemon.paths.lockFile, { recursive: true });
    await fs.rm(daemon.paths.pidFile);
  }, LOCK_UPDATE_MS * 3);

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
    // a pty host that ends only when killed holds the shutdown for the terminals' limit, after the endpoint closed
    const pty = stubbornPtyHost();
    const daemon = await startInProcessDaemon({ starters: { ...NO_HOSTS, startPtyHost: pty.start } });
    const client = await connectClient(await daemon.connect());
    client.workspace.emit('terminals.post', { request: SPAWN });
    await vi.waitFor(() => expect(pty.started()).toBe(true));
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
});

describe.runIf(process.platform !== 'win32')('a shutdown on POSIX', () => {
  it('removes every socket folder the daemon made, a client\'s agent socket included, and exits 0', async () => {
    const agents = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-agent-'));
    const agentSock = path.join(agents, 'agent.1');
    const agent = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => agent.listen(agentSock, resolve));
    try {
      const daemon = await startInProcessDaemon({ starters: NO_HOSTS, credentialRelay: true });
      const client = await connectClient(await daemon.connect(agentSock), { clientId: 'laptop' });
      expect(client.outcome.kind).toBe('welcome');
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
