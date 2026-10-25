import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostStarters } from '../../workspace/host-starters';
import { connectToDaemon } from '../attach';
import { removeStaleSocket } from '../endpoint-server';
import { acquireDaemonLock, LOCK_STALE_MS } from '../singleton';
import { createSocketFolder, localRunPaths, makeRunDir, socketFolderBase, socketPath, writePidFile } from '../token';
import { startInProcessDaemon, type InProcessDaemon } from './in-process-daemon';
import { connectClient } from './test-client';

const NO_HOSTS: HostStarters = {
  startPtyHost: () => { throw new Error('no pty host in this test'); },
  startFormatterHost: () => { throw new Error('no formatter host in this test'); },
};

const running: InProcessDaemon[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.shutdown()));
});

describe('the daemon singleton', () => {
  it('holds one lock per user and host', async () => {
    const paths = await localRunPaths();
    await makeRunDir(paths);
    const first = await acquireDaemonLock(paths, () => undefined);
    const second = await acquireDaemonLock(paths, () => undefined, 0);
    expect(first.held).toBe(true);
    expect(second.held).toBe(false);
    if (first.held) await first.release();
    const third = await acquireDaemonLock(paths, () => undefined);
    expect(third.held).toBe(true);
    if (third.held) await third.release();
  });

  it('takes over the lock of a daemon that crashed once it turns stale, waiting rather than failing the start', async () => {
    const paths = await localRunPaths();
    await makeRunDir(paths);
    // a crashed daemon's lock, last refreshed almost LOCK_STALE_MS ago
    fs.mkdirSync(paths.lockFile);
    const refreshed = new Date(Date.now() - LOCK_STALE_MS + 1500);
    fs.utimesSync(paths.lockFile, refreshed, refreshed);
    const started = Date.now();
    const lock = await acquireDaemonLock(paths, () => undefined);
    expect(lock.held).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    if (lock.held) await lock.release();
  }, 15_000);

  it('ends two bridges that start at once with one daemon', async () => {
    const refused: string[] = [];
    const start = (): Promise<void> => startInProcessDaemon({ starters: NO_HOSTS, lockWaitMs: 0 }).then((daemon) => {
      running.push(daemon);
    }, (err: unknown) => {
      refused.push(err instanceof Error ? err.message : String(err));
    });
    const paths = await localRunPaths();
    const [a, b] = await Promise.all([connectToDaemon({ paths, start, log: () => undefined }), connectToDaemon({ paths, start, log: () => undefined })]);
    expect(running).toHaveLength(1);
    expect(refused).toEqual(['another daemon holds the lock in this test home']);
    const clients = await Promise.all([connectClient(a.socket, { clientId: 'a' }), connectClient(b.socket, { clientId: 'b' })]);
    expect(clients.map((client) => client.outcome.kind)).toEqual(['welcome', 'welcome']);
    for (const client of clients) client.protocol.close('done');
  });

  it.skipIf(process.platform === 'win32')('removes a stale socket folder of its own, and nothing else', async () => {
    const paths = await localRunPaths();
    await makeRunDir(paths);
    const stale = await createSocketFolder(await socketFolderBase());
    fs.writeFileSync(socketPath(stale), '');
    fs.writeFileSync(path.join(stale, 'token'), 'x');
    await writePidFile(paths.pidFile, { version: '1', pid: 1, endpoint: socketPath(stale), socketFolder: stale, updatedAt: 0 });
    await removeStaleSocket(paths, () => undefined);
    expect(fs.existsSync(stale)).toBe(false);

    // a pid file naming a folder that is not a socket folder of the daemon leaves it alone
    const precious = fs.mkdtempSync(path.join(await socketFolderBase(), 'precious-'));
    fs.writeFileSync(path.join(precious, 'keep'), 'x');
    await writePidFile(paths.pidFile, { version: '1', pid: 1, endpoint: socketPath(precious), socketFolder: precious, updatedAt: 0 });
    await removeStaleSocket(paths, () => undefined);
    expect(fs.existsSync(path.join(precious, 'keep'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('starts past a stale socket folder it cannot empty, leaving it as it is', async () => {
    const paths = await localRunPaths();
    await makeRunDir(paths);
    const stale = await createSocketFolder(await socketFolderBase());
    fs.writeFileSync(path.join(stale, 'stranger'), 'x');
    await writePidFile(paths.pidFile, { version: '1', pid: 1, endpoint: socketPath(stale), socketFolder: stale, updatedAt: 0 });
    const lines: string[] = [];
    await removeStaleSocket(paths, (line) => lines.push(line));
    expect(fs.existsSync(path.join(stale, 'stranger'))).toBe(true);
    expect(lines.some((line) => line.startsWith(`[daemon] could not remove the earlier socket folder ${stale}`))).toBe(true);
    const daemon = await startInProcessDaemon({ starters: NO_HOSTS });
    running.push(daemon);
    expect((await connectClient(await daemon.connect(), { clientId: 'a' })).outcome.kind).toBe('welcome');
  });
});
