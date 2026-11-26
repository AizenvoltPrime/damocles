import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostStarters } from '../../workspace/host-starters';
import { connectToDaemon } from '../attach';
import { openEndpoint, type ListeningEndpoint } from '../endpoint-server';
import { startIdentity } from '../process-identity';
import { buildDaemon, type Daemon } from '../serve';
import { createSocketFolder, goneFromThisHost, localRunPaths, makeRunDir, readHostRecords, runPaths, socketFoldersFile, removeRecordedSocketFolders, writePidFile, writeSocketFolders, type RunPaths } from '../token';
import { REPO_ROOT, startInProcessDaemon, startTestHost, TEST_FACTS } from './in-process-daemon';
import { connectClient, type TestClient } from './test-client';

const NO_HOSTS: HostStarters = {
  startPtyHost: () => { throw new Error('no pty host in this test'); },
  startFormatterHost: () => { throw new Error('no formatter host in this test'); },
};

let home: string;
let paths: RunPaths;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-removal-'));
  paths = runPaths(home, '0123456789abcdef');
  await makeRunDir(paths);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

// A daemon whose endpoint close waits for `opened`, so a test decides when the shutdown passes its first step; order records
// the lock's release and each client's close.
async function gatedDaemon(): Promise<{ daemon: Daemon; order: string[]; open: () => void; exited: Promise<void>; client: (clientId: string, deviceName?: string) => Promise<TestClient> }> {
  const order: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  // bound after the daemon is built, which its endpoint calls back
  const bound: { endpoint?: ListeningEndpoint } = {};
  let exited!: () => void;
  const exit = new Promise<void>((resolve) => { exited = resolve; });
  const daemon = buildDaemon({
    git: { available: false, reason: 'not probed in tests' },
    e2eHooks: false,
    root: REPO_ROOT,
    terminalRoot: REPO_ROOT,
    version: '0.0.0-test',
    facts: TEST_FACTS,
    paths,
    starters: NO_HOSTS,
    closeEndpoint: async () => {
      await gate;
      await bound.endpoint?.close();
    },
    abandonEndpoint: async () => undefined,
    releaseLock: async () => {
      order.push('released');
    },
    exit: () => exited(),
    log: () => undefined,
  });
  const endpoint = await openEndpoint(paths, (socket, token) => daemon.connections.accept(socket, token), () => undefined);
  bound.endpoint = endpoint;
  await writePidFile(paths.pidFile, { version: '0.0.0-test', pid: process.pid, endpoint: endpoint.endpoint, socketFolder: endpoint.socketFolder, updatedAt: Date.now() });
  const client = async (clientId: string, deviceName?: string): Promise<TestClient> => {
    const { socket, rest } = await connectToDaemon({ paths, start: () => Promise.reject(new Error('no start in this test')), deadlineMs: 5000, log: () => undefined });
    if (rest.length > 0) socket.unshift(Buffer.from(rest));
    return connectClient(socket, { clientId, ...(deviceName !== undefined ? { deviceName } : {}) });
  };
  return { daemon, order, open, exited: exit, client };
}

describe('a removal\'s connection', { timeout: 120_000 }, () => {
  it('closes only after the daemon released its lock, other connections before', async () => {
    const { order, open, exited, client } = await gatedDaemon();
    const removal = await client('laptop');
    const other = await client('desktop');
    void removal.closed.then(() => order.push('removal closed'));
    void other.closed.then(() => order.push('other closed'));
    expect(await removal.control.request('shutdownForRemoval', {})).toEqual({ runKey: '0123456789abcdef' });
    open();
    await exited;
    await removal.closed;
    expect(order).toEqual(['other closed', 'released', 'removal closed']);
  });

  it('closes only after the lock is released when it asks during a shutdown already under way', async () => {
    const { daemon, order, open, exited, client } = await gatedDaemon();
    const removal = await client('laptop');
    void removal.closed.then(() => order.push('removal closed'));
    // an idle exit stalls at its first step
    const idle = daemon.shutdown('idle', 'release');
    expect(await removal.control.request('shutdownForRemoval', {})).toEqual({ runKey: '0123456789abcdef' });
    open();
    await idle;
    await exited;
    await removal.closed;
    expect(order).toEqual(['released', 'removal closed']);
  });

  it('tells every other device that asked for removing, by the remover\'s device name, before its connection ends', async () => {
    const { open, exited, client } = await gatedDaemon();
    const removal = await client('remover', 'DESKTOP-A');
    const watching = await client('watching', 'Laptop B');
    const unasked = await client('unasked', 'Old app');
    const seen: string[] = [];
    for (const [name, connection] of [['remover', removal], ['watching', watching], ['unasked', unasked]] as const) {
      connection.control.onEvent('removing', ({ deviceName }) => seen.push(`${name} told: ${deviceName}`));
      void connection.closed.then(() => seen.push(`${name} closed`));
    }
    expect(removal.outcome.kind === 'welcome' && removal.outcome.welcome.features).toContain('control.removing');
    await removal.control.request('attach', { terminalIdleDays: 7, watchRemoval: true });
    await watching.control.request('attach', { terminalIdleDays: 7, watchRemoval: true });
    await unasked.control.request('attach', { terminalIdleDays: 7 });
    await removal.control.request('shutdownForRemoval', {});
    open();
    await exited;
    await Promise.all([removal.closed, watching.closed, unasked.closed]);
    expect(seen.filter((line) => line.includes('told'))).toEqual(['watching told: DESKTOP-A']);
    expect(seen.indexOf('watching told: DESKTOP-A')).toBeLessThan(seen.indexOf('watching closed'));
  });
});

describe('a removal\'s end of the terminal hosts', { timeout: 120_000 }, () => {
  const alive = (pid: number): boolean => !goneFromThisHost(os.hostname(), pid);

  it('ends a terminal host of this machine the daemon could not reach once its start identity is proved, which shutdownNow leaves running', async () => {
    // a real process stands in for the hung host's, so the identity read and the kill are the OS's
    const stand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    const standExit = new Promise((resolve) => stand.once('exit', resolve));
    await new Promise((resolve, reject) => stand.once('spawn', resolve).once('error', reject));
    const pid = stand.pid!;
    const hostPaths = await localRunPaths();
    await makeRunDir(hostPaths);
    const host = await startTestHost(hostPaths, { pid, identity: startIdentity });
    host.hang();
    try {
      const first = await startInProcessDaemon({ starters: NO_HOSTS, startIdentity });
      await (await connectClient(await first.connect())).control.request('shutdownNow', {});
      expect(await first.exitCode).toBe(0);
      expect(alive(pid)).toBe(true);
      expect((await readHostRecords(hostPaths)).map((entry) => entry.pid)).toEqual([pid]);

      const second = await startInProcessDaemon({ starters: NO_HOSTS, startIdentity });
      expect(await (await connectClient(await second.connect())).control.request('shutdownForRemoval', {})).toMatchObject({ runKey: expect.stringMatching(/^[0-9a-f]{16}$/) });
      expect(await second.exitCode).toBe(0);
      expect(alive(pid)).toBe(false);
      expect(await readHostRecords(hostPaths)).toEqual([]);
    } finally {
      stand.kill();
      await standExit;
      host.answer();
      await host.stop();
    }
  });
});

describe.runIf(process.platform !== 'win32')('the socket folder record', { timeout: 120_000 }, () => {
  it('names the endpoint, agent and relay folders a running daemon has', async () => {
    const daemon = await startInProcessDaemon({ starters: NO_HOSTS, credentialRelay: true });
    try {
      const recorded = (await fs.readFile(socketFoldersFile(daemon.paths), 'utf8')).split('\n').filter((line) => line !== '');
      const pid = JSON.parse(await fs.readFile(daemon.paths.pidFile, 'utf8')) as { socketFolder: string };
      expect(recorded.sort()).toEqual([pid.socketFolder, daemon.daemon.agentProxy.folder()!, path.dirname(daemon.relay!.identity().handle)].sort());
    } finally {
      await daemon.shutdown();
    }
  });

  it('is read by the next start, which removes the folders a crashed daemon left', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-base-'));
    try {
      const first = await startInProcessDaemon({ starters: NO_HOSTS });
      const runPaths = first.paths;
      await first.shutdown();
      // a crashed daemon's agent folder, which its pid file never named
      const agent = await createSocketFolder(base);
      await fs.writeFile(path.join(agent, `agent-${'b'.repeat(24)}.sock`), '');
      await writeSocketFolders(runPaths, [agent]);
      const next = await startInProcessDaemon({ starters: NO_HOSTS });
      try {
        expect(existsSync(agent)).toBe(false);
      } finally {
        await next.shutdown();
      }
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('lets the next start remove an earlier daemon\'s folders, only the names a daemon makes in one and only Damocles\' own', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-base-'));
    try {
      const agent = await createSocketFolder(base);
      await fs.writeFile(path.join(agent, `agent-${'a'.repeat(24)}.sock`), '');
      const relay = await createSocketFolder(base);
      await fs.writeFile(path.join(relay, 'askpass.sock'), '');
      const cli = await createSocketFolder(base);
      await fs.writeFile(path.join(cli, `cli-${'c'.repeat(24)}.sock`), '');
      const crowded = await createSocketFolder(base);
      await fs.writeFile(path.join(crowded, 'askpass.sock'), '');
      await fs.writeFile(path.join(crowded, 'notes.txt'), '');
      const foreign = path.join(base, 'other-tool');
      await fs.mkdir(foreign, { mode: 0o700 });
      await fs.writeFile(path.join(foreign, 'askpass.sock'), '');
      await writeSocketFolders(paths, [agent, relay, cli, crowded, foreign, path.join(base, 'damocles-gone')]);
      const lines: string[] = [];
      await removeRecordedSocketFolders(paths, (line) => lines.push(line));
      expect(existsSync(agent) || existsSync(relay) || existsSync(cli)).toBe(false);
      expect((await fs.readdir(crowded)).sort()).toEqual(['notes.txt']);
      expect(await fs.readdir(foreign)).toEqual(['askpass.sock']);
      expect(lines.filter((line) => line.startsWith('[daemon] leaving'))).toHaveLength(1);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});
