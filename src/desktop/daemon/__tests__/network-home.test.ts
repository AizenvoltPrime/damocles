import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const statfs = vi.hoisted(() => ({ type: undefined as number | undefined, realpath: undefined as string | undefined }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const statfsSync = ((folder: fs.PathLike) => (statfs.type === undefined ? actual.statfsSync(folder) : { ...actual.statfsSync(folder), type: statfs.type })) as typeof actual.statfsSync;
  const realpathSync = Object.assign((file: fs.PathLike) => actual.realpathSync(file), {
    native: ((file: fs.PathLike) => statfs.realpath ?? actual.realpathSync.native(file)) as typeof actual.realpathSync.native,
  }) as typeof actual.realpathSync;
  return { ...actual, default: { ...actual, statfsSync, realpathSync }, statfsSync, realpathSync };
});

const { networkFileSystem, sqliteJournalMode } = await import('../../../core/network-fs');
const { openAndMigrate } = await import('../../../core/memory/database');
const { createDaemonState } = await import('../daemon-state');
const { localRunPaths, otherHostsInHome, runPaths, SHARED_HOME_WINDOW_MS, writePidFile } = await import('../token');
const { machineRunKey } = await import('../machine-id');

afterEach(() => {
  statfs.type = undefined;
  statfs.realpath = undefined;
});

describe('homes shared over a network file system', () => {
  it('keeps the logs, state, lock and pid file in the run folder of this machine\'s key', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-home-'));
    const paths = await localRunPaths(home);
    const runDir = path.join(home, '.damocles', 'server', `run-${await machineRunKey()}`);
    expect(paths.runDir).toBe(runDir);
    for (const inside of [paths.logsDir, paths.lockFile, paths.pidFile, paths.zshDotDir]) expect(inside.startsWith(`${runDir}${path.sep}`)).toBe(true);
    const state = createDaemonState(paths.runDir, () => undefined);
    await state.update('global', 'damocles.probe', 1);
    await state.flush();
    expect(fs.readdirSync(path.join(runDir, 'state')).length).toBeGreaterThan(0);
  });

  it('opens SQLite with journal_mode DELETE on a network or cluster file system, and WAL elsewhere', () => {
    const typeOf = (magic: number) => () => magic;
    expect(networkFileSystem('/home/u', typeOf(0x6969), 'linux')).toBe('NFS');
    expect(networkFileSystem('/home/u', typeOf(0x517b), 'linux')).toBe('SMB');
    expect(networkFileSystem('/home/u', typeOf(0xff534d42), 'linux')).toBe('CIFS');
    expect(networkFileSystem('/home/u', typeOf(0x01021997), 'linux')).toBe('9P');
    for (const [magic, name] of [[0x65735546, 'FUSE'], [0x00c36400, 'CephFS'], [0x0bd00bd0, 'Lustre'], [0x47504653, 'GPFS'], [0x5346414f, 'AFS'], [0x6b414653, 'AFS']] as const) {
      expect(networkFileSystem('/home/u', typeOf(magic), 'linux')).toBe(name);
    }
    expect(networkFileSystem('/home/u', typeOf(0xef53), 'linux')).toBeUndefined();
    expect(networkFileSystem('\\\\server\\share\\db', typeOf(0), 'win32')).toBe('SMB');
    expect(networkFileSystem('\\\\?\\UNC\\server\\share\\db', typeOf(0), 'win32')).toBe('SMB');
    expect(networkFileSystem('\\\\?\\C:\\Users\\u\\db', typeOf(0), 'win32')).toBeUndefined();
    expect(networkFileSystem('C:\\Users\\u\\db', typeOf(0), 'win32')).toBeUndefined();
    statfs.type = 0x6969;
    expect(sqliteJournalMode(path.join(os.tmpdir(), 'x.db'), 'linux')).toBe('DELETE');
    statfs.type = 0xef53;
    expect(sqliteJournalMode(path.join(os.tmpdir(), 'x.db'), 'linux')).toBe('WAL');
    // a mapped network drive: Z:\db resolves to the share it maps
    statfs.realpath = '\\\\server\\share\\db';
    expect(sqliteJournalMode(path.join(os.tmpdir(), 'x.db'), 'win32')).toBe('DELETE');
    statfs.realpath = 'C:\\Users\\u\\db';
    expect(sqliteJournalMode(path.join(os.tmpdir(), 'x.db'), 'win32')).toBe('WAL');
  });

  it.runIf(process.platform === 'linux')('applies the journal mode when core opens a database', () => {
    for (const [magic, mode] of [[0x6969, 'delete'], [0xef53, 'wal']] as const) {
      statfs.type = magic;
      const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-journal-')), 'memory.db');
      const { db } = openAndMigrate(dbPath);
      expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe(mode);
      db.close();
    }
  });

  it('names another machine whose daemon touched its pid file within 25 hours, by the hostname the file holds', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-home-'));
    const paths = runPaths(home, '1111111111111111');
    const now = Date.now();
    for (const [key, hostname, age] of [['1111111111111111', 'this-host', 0], ['2222222222222222', 'lab-02', 60_000], ['3333333333333333', 'lab-03', SHARED_HOME_WINDOW_MS + 60_000]] as const) {
      const pidFile = runPaths(home, key).pidFile;
      fs.mkdirSync(path.dirname(pidFile), { recursive: true });
      await writePidFile(pidFile, { version: '1', pid: 7, hostname, endpoint: '/tmp/damocles-x/daemon.sock', socketFolder: '/tmp/damocles-x', updatedAt: now - age });
      fs.utimesSync(pidFile, new Date(now - age), new Date(now - age));
    }
    expect(await otherHostsInHome(paths, now)).toEqual(['lab-02']);
  });
});
