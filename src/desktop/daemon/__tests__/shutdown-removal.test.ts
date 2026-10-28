import { existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostStarters } from '../../workspace/host-starters';
import { connectToDaemon } from '../attach';
import { openEndpoint, type ListeningEndpoint } from '../endpoint-server';
import { buildDaemon, type Daemon } from '../serve';
import { createSocketFolder, makeRunDir, runPaths, socketFoldersFile, removeRecordedSocketFolders, writePidFile, writeSocketFolders, type RunPaths } from '../token';
import { REPO_ROOT, startInProcessDaemon, TEST_FACTS } from './in-process-daemon';
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
async function gatedDaemon(): Promise<{ daemon: Daemon; order: string[]; open: () => void; exited: Promise<void>; client: (clientId: string) => Promise<TestClient> }> {
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
  const client = async (clientId: string): Promise<TestClient> => {
    const { socket, rest } = await connectToDaemon({ paths, start: () => Promise.reject(new Error('no start in this test')), deadlineMs: 5000, log: () => undefined });
    if (rest.length > 0) socket.unshift(Buffer.from(rest));
    return connectClient(socket, { clientId });
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
    const idle = daemon.shutdown('idle');
    expect(await removal.control.request('shutdownForRemoval', {})).toEqual({ runKey: '0123456789abcdef' });
    open();
    await idle;
    await exited;
    await removal.closed;
    expect(order).toEqual(['released', 'removal closed']);
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
      const crowded = await createSocketFolder(base);
      await fs.writeFile(path.join(crowded, 'askpass.sock'), '');
      await fs.writeFile(path.join(crowded, 'notes.txt'), '');
      const foreign = path.join(base, 'other-tool');
      await fs.mkdir(foreign, { mode: 0o700 });
      await fs.writeFile(path.join(foreign, 'askpass.sock'), '');
      await writeSocketFolders(paths, [agent, relay, crowded, foreign, path.join(base, 'damocles-gone')]);
      const lines: string[] = [];
      await removeRecordedSocketFolders(paths, (line) => lines.push(line));
      expect(existsSync(agent) || existsSync(relay)).toBe(false);
      expect((await fs.readdir(crowded)).sort()).toEqual(['notes.txt']);
      expect(await fs.readdir(foreign)).toEqual(['askpass.sock']);
      expect(lines.filter((line) => line.startsWith('[daemon] leaving'))).toHaveLength(1);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});
