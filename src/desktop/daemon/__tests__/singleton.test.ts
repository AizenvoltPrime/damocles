import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHELL_ENV_TIMEOUT_MS } from '../../local-services/shell-env';
import type { HostStarters } from '../../workspace/host-starters';
import { connectToDaemon, daemonAnswers } from '../attach';
import { removeStaleSocket } from '../endpoint-server';
import { DAEMON_START_MS, LOCK_STALE_MS, TAKEOVER_STALE_MS } from '../lock-timing';
import { acquireDaemonLock } from '../singleton';
import { createSocketFolder, localRunPaths, makeRunDir, pipeName, socketFolderBase, socketPath, tokenPath, writePidFile, writeToken } from '../token';
import { startInProcessDaemon, type InProcessDaemon } from './in-process-daemon';
import { connectClient } from './test-client';

const NO_HOSTS: HostStarters = {
  startPtyHost: () => { throw new Error('no pty host in this test'); },
  startFormatterHost: () => { throw new Error('no formatter host in this test'); },
};

const running: InProcessDaemon[] = [];
// a holder whose endpoint never answers
const NO_ANSWER = async (): Promise<boolean> => false;
// above Linux's pid_max and no Windows process id: kill(pid, 0) answers ESRCH
const GONE_PID = 2_000_000_000;

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.shutdown()));
});

describe('the daemon singleton', () => {
  it('gives a start past the lock longer than the login shell\'s environment may take', () => {
    expect(DAEMON_START_MS).toBeGreaterThan(SHELL_ENV_TIMEOUT_MS);
  });

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

  it('takes the lock of a holder gone from this host at once, without waiting or probing, and names itself its owner', async () => {
    const paths = await localRunPaths();
    await makeRunDir(paths);
    // a crashed daemon's lock, refreshed just now
    fs.mkdirSync(paths.lockFile);
    fs.writeFileSync(paths.lockOwnerFile, `${os.hostname()} ${GONE_PID}\n`);
    const probes = vi.fn(NO_ANSWER);
    const lock = await acquireDaemonLock(paths, () => undefined, probes, 0);
    expect(lock.held).toBe(true);
    expect(probes).not.toHaveBeenCalled();
    expect(fs.readFileSync(paths.lockOwnerFile, 'utf8')).toBe(`${os.hostname()} ${process.pid}\n`);
    if (lock.held) await lock.release();
    expect([fs.existsSync(paths.lockFile), fs.existsSync(paths.lockOwnerFile)]).toEqual([false, false]);
  });

  it('leaves a fresh lock whose owner it cannot judge gone: a live process, or another host\'s', async () => {
    const paths = await localRunPaths();
    await makeRunDir(paths);
    fs.mkdirSync(paths.lockFile);
    try {
      for (const owner of [`${os.hostname()} ${process.pid}\n`, `another-host ${GONE_PID}\n`, 'unreadable']) {
        fs.writeFileSync(paths.lockOwnerFile, owner);
        expect((await acquireDaemonLock(paths, () => undefined, NO_ANSWER, 0)).held).toBe(false);
      }
    } finally {
      fs.rmSync(paths.lockFile, { recursive: true, force: true });
      fs.rmSync(paths.lockOwnerFile, { force: true });
    }
  });

  it('takes the lock past a takeover lock that a start which died inside it left', async () => {
    const paths = await localRunPaths();
    await makeRunDir(paths);
    fs.mkdirSync(paths.lockTakeover);
    const old = new Date(Date.now() - TAKEOVER_STALE_MS - 1000);
    fs.utimesSync(paths.lockTakeover, old, old);
    const lock = await acquireDaemonLock(paths, () => undefined, NO_ANSWER, 0);
    expect(lock.held).toBe(true);
    if (lock.held) await lock.release();
  });

  it('connects to no endpoint a gone daemon\'s pid file names, and tries each other record once', async () => {
    const paths = await localRunPaths();
    await makeRunDir(paths);
    const folder = process.platform === 'win32' ? null : await createSocketFolder(await socketFolderBase());
    const endpoint = folder === null ? pipeName() : socketPath(folder);
    let connections = 0;
    // an endpoint that ends every connection at once, as a stand-in squatting on a dead daemon's name might
    const standIn = net.createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => standIn.listen(endpoint, resolve));
    try {
      const record = { version: '1', hostname: os.hostname(), endpoint, socketFolder: folder, updatedAt: Date.now() };
      await writeToken(tokenPath(paths, record));
      const start = vi.fn(async () => undefined);
      await writePidFile(paths.pidFile, { ...record, pid: GONE_PID });
      await expect(connectToDaemon({ paths, start, deadlineMs: 1000, log: () => undefined })).rejects.toThrow(/has ended/);
      expect([connections, start.mock.calls.length]).toEqual([0, 1]);
      expect(await daemonAnswers(paths)).toBe(false);
      expect(connections).toBe(0);

      await writePidFile(paths.pidFile, { ...record, pid: process.pid });
      await expect(connectToDaemon({ paths, start, deadlineMs: 1000, log: () => undefined })).rejects.toThrow(/did not answer/);
      expect(connections).toBe(1);
    } finally {
      await new Promise<void>((resolve) => standIn.close(() => resolve()));
    }
  });

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
