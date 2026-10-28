import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostStarters } from '../../workspace/host-starters';
import { connectToDaemon, daemonAnswers } from '../attach';
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
// a holder whose endpoint never answers
const NO_ANSWER = async (): Promise<boolean> => false;

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.shutdown()));
});

describe('the daemon singleton', () => {
  it('holds one lock per user and host', async () => {
    const paths = await localRunPaths();
    await makeRunDir(paths);
    const first = await acquireDaemonLock(paths, () => undefined, NO_ANSWER);
    const second = await acquireDaemonLock(paths, () => undefined, NO_ANSWER, 0);
    expect(first.held).toBe(true);
    expect(second.held).toBe(false);
    if (first.held) await first.release();
    const third = await acquireDaemonLock(paths, () => undefined, NO_ANSWER);
    expect(third.held).toBe(true);
    if (third.held) await third.release();
  });

  it('takes over the lock of a daemon that crashed once it turns stale, waiting rather than failing the start', async () => {
    const paths = await localRunPaths();
    await makeRunDir(paths);
    // a crashed daemon's lock, refreshed just now; it turns stale while the start waits, after the first probe
    fs.mkdirSync(paths.lockFile);
    let probes = 0;
    const lock = await acquireDaemonLock(paths, () => undefined, async () => {
      probes += 1;
      const stale = new Date(Date.now() - LOCK_STALE_MS - 1000);
      if (probes === 1) fs.utimesSync(paths.lockFile, stale, stale);
      // the real probe: a crashed daemon has no pid file that answers
      return daemonAnswers(paths);
    });
    expect(lock.held).toBe(true);
    expect(probes).toBe(1);
    if (lock.held) await lock.release();
  }, 15_000);

  it('gives up at once while the lock\'s holder answers on its endpoint, instead of waiting out the stale window', async () => {
    running.push(await startInProcessDaemon({ starters: NO_HOSTS }));
    const paths = await localRunPaths();
    const started = Date.now();
    const lock = await acquireDaemonLock(paths, () => undefined, () => daemonAnswers(paths));
    expect(lock.held).toBe(false);
    expect(Date.now() - started).toBeLessThan(LOCK_STALE_MS / 4);
  }, LOCK_STALE_MS / 2);

  it('waits for a holder that does not answer, as one still starting or shutting down, and takes the lock once it is released', async () => {
    const paths = await localRunPaths();
    await makeRunDir(paths);
    const holder = await acquireDaemonLock(paths, () => undefined, NO_ANSWER);
    if (!holder.held) throw new Error('the holder did not get the lock');
    let probes = 0;
    const lock = await acquireDaemonLock(paths, () => undefined, async () => {
      probes += 1;
      // the holder finishes its shutdown while the start waits
      if (probes === 2) await holder.release();
      return false;
    });
    expect(lock.held).toBe(true);
    expect(probes).toBe(2);
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
