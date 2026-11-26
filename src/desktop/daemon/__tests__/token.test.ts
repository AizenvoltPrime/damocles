import { existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSocketFolder,
  hostPipeName,
  hostRecordFile,
  hostSocketPath,
  hostTerminalsFile,
  hostTokenPath,
  isHostEndpoint,
  isOwnEndpoint,
  pipeName,
  readHostRecords,
  removeHostFiles,
  removeRecordedSocketFolders,
  runPaths,
  runPathsIn,
  socketPath,
  TERMINAL_HOST_LOG_FILE,
  terminalHostLogName,
  writePidFile,
  writeSocketFolders,
  writeToken,
  type PidRecord,
  type RunPaths,
} from '../token';

const POSIX = process.platform !== 'win32';
let home: string;
let paths: RunPaths;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-token-'));
  paths = runPaths(home, '0123456789abcdef');
  await fs.mkdir(paths.terminalHostsDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const pipeRecord = (pid: number, endpoint: string = hostPipeName()): PidRecord => ({ version: '3.7.0+0123456789ab', pid, hostname: os.hostname(), endpoint, socketFolder: null, updatedAt: 1 });

describe('a terminal host\'s paths', () => {
  it('sit in the run folder\'s terminal-hosts, which a run folder path gives back whole', () => {
    expect(paths.terminalHostsDir).toBe(path.join(paths.runDir, 'terminal-hosts'));
    expect(runPathsIn(paths.runDir)).toEqual(paths);
    expect(hostRecordFile(paths, 4242)).toBe(path.join(paths.terminalHostsDir, '4242.json'));
    expect(hostTerminalsFile(paths, 4242)).toBe(path.join(paths.terminalHostsDir, '4242.terminals'));
    expect(hostTokenPath(paths, { pid: 4242, socketFolder: null })).toBe(path.join(paths.terminalHostsDir, '4242.token'));
    expect(hostTokenPath(paths, { pid: 4242, socketFolder: '/tmp/damocles-Ab12Cd' })).toBe(path.join('/tmp/damocles-Ab12Cd', 'token'));
  });

  it('name its log and that log\'s rotated files by its pid', () => {
    expect(terminalHostLogName(4242)).toBe('terminal-host-4242');
    expect(TERMINAL_HOST_LOG_FILE.exec('terminal-host-4242.log')?.[1]).toBe('4242');
    expect(TERMINAL_HOST_LOG_FILE.exec('terminal-host-4242.2.log')?.[1]).toBe('4242');
    for (const name of ['daemon.log', 'terminal-host-.log', 'terminal-host-0.log', 'terminal-host-4242.log.tmp', 'xterminal-host-4242.log']) expect(TERMINAL_HOST_LOG_FILE.test(name)).toBe(false);
  });
});

// A later daemon finds a host built today only at these names, so each is spelled out here and never follows an edit.
describe('the frozen layout a daemon finds a terminal host by', () => {
  it('is terminal-hosts/<pid>.json, with the token at terminal-hosts/<pid>.token or beside the socket, 64 hex digits', async () => {
    const sep = path.sep;
    expect(hostRecordFile(paths, 4242)).toBe(`${paths.runDir}${sep}terminal-hosts${sep}4242.json`);
    expect(hostTokenPath(paths, { pid: 4242, socketFolder: null })).toBe(`${paths.runDir}${sep}terminal-hosts${sep}4242.token`);
    expect(hostTokenPath(paths, { pid: 4242, socketFolder: `${sep}tmp${sep}damocles-Ab12Cd` })).toBe(`${sep}tmp${sep}damocles-Ab12Cd${sep}token`);
    expect(hostSocketPath(`${sep}tmp${sep}damocles-Ab12Cd`)).toBe(`${sep}tmp${sep}damocles-Ab12Cd${sep}host.sock`);
    const file = hostTokenPath(paths, { pid: 4242, socketFolder: null });
    await writeToken(file);
    expect(await fs.readFile(file, 'utf8')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the pipe \\\\.\\pipe\\damocles-terminals-<32 hex> on Windows and host.sock in a damocles- folder elsewhere', () => {
    expect(isHostEndpoint({ endpoint: '\\\\.\\pipe\\damocles-terminals-0123456789abcdef0123456789abcdef', socketFolder: null }, 'win32')).toBe(true);
    expect(hostPipeName().slice(0, '\\\\.\\pipe\\damocles-terminals-'.length)).toBe('\\\\.\\pipe\\damocles-terminals-');
    const folder = `${path.sep}tmp${path.sep}damocles-Ab12Cd`;
    expect(isHostEndpoint({ endpoint: `${folder}${path.sep}host.sock`, socketFolder: folder }, 'linux')).toBe(true);
  });

  it('reads a record by the fields version, pid, hostname, endpoint, socketFolder and updatedAt', async () => {
    const endpoint = '\\\\.\\pipe\\damocles-terminals-0123456789abcdef0123456789abcdef';
    await fs.writeFile(hostRecordFile(paths, 4242), `{"version":"3.7.0+0123456789ab","pid":4242,"hostname":"box","endpoint":${JSON.stringify(endpoint)},"socketFolder":null,"updatedAt":1}\n`);
    const [entry] = await readHostRecords(paths);
    expect(entry).toEqual({ pid: 4242, record: POSIX ? undefined : { version: '3.7.0+0123456789ab', pid: 4242, hostname: 'box', endpoint, socketFolder: null, updatedAt: 1 } });
  });
});

describe('a terminal host\'s endpoint', () => {
  it('is a pipe named damocles-terminals- and 128 random bits on Windows, which is never a daemon\'s', () => {
    const name = hostPipeName();
    expect(name).toMatch(/^\\\\\.\\pipe\\damocles-terminals-[0-9a-f]{32}$/);
    expect(hostPipeName()).not.toBe(name);
    expect(isHostEndpoint({ endpoint: name, socketFolder: null }, 'win32')).toBe(true);
    expect(isOwnEndpoint({ endpoint: name, socketFolder: null }, 'win32')).toBe(false);
    expect(isHostEndpoint({ endpoint: pipeName(), socketFolder: null }, 'win32')).toBe(false);
    for (const endpoint of [`${name}0`, name.toUpperCase(), `${name}\\x`, name.replace('pipe', 'PIPE\\..'), '\\\\other\\pipe\\damocles-terminals-00000000000000000000000000000000']) {
      expect(isHostEndpoint({ endpoint, socketFolder: null }, 'win32')).toBe(false);
    }
    expect(isHostEndpoint({ endpoint: name, socketFolder: 'C:\\Temp\\damocles-Ab12Cd' }, 'win32')).toBe(false);
  });

  it.runIf(POSIX)('is host.sock in a damocles- folder on POSIX, which is never a daemon\'s', () => {
    const folder = '/tmp/damocles-Ab12Cd';
    expect(hostSocketPath(folder)).toBe('/tmp/damocles-Ab12Cd/host.sock');
    expect(isHostEndpoint({ endpoint: hostSocketPath(folder), socketFolder: folder }, 'linux')).toBe(true);
    expect(isOwnEndpoint({ endpoint: hostSocketPath(folder), socketFolder: folder }, 'linux')).toBe(false);
    expect(isHostEndpoint({ endpoint: socketPath(folder), socketFolder: folder }, 'linux')).toBe(false);
    expect(isHostEndpoint({ endpoint: '/tmp/other/host.sock', socketFolder: folder }, 'linux')).toBe(false);
    expect(isHostEndpoint({ endpoint: '/tmp/private/host.sock', socketFolder: '/tmp/private' }, 'linux')).toBe(false);
    expect(isHostEndpoint({ endpoint: hostSocketPath(folder), socketFolder: null }, 'linux')).toBe(false);
  });
});

describe('the terminal host records of a run folder', () => {
  it('are none while the folder does not exist', async () => {
    expect(await readHostRecords(runPaths(home, 'fedcba9876543210'))).toEqual([]);
  });

  it.runIf(!POSIX)('carry a record only when the file parses, names its own pid and names a host endpoint', async () => {
    await writePidFile(hostRecordFile(paths, 11), pipeRecord(11));
    await writePidFile(hostRecordFile(paths, 12), pipeRecord(13));
    await writePidFile(hostRecordFile(paths, 14), pipeRecord(14, pipeName()));
    await fs.writeFile(hostRecordFile(paths, 15), '{ not json');
    await fs.writeFile(path.join(paths.terminalHostsDir, '16.token'), 'x');
    await fs.writeFile(path.join(paths.terminalHostsDir, 'notes.json'), '{}');
    await fs.writeFile(path.join(paths.terminalHostsDir, '017.json'), '{}');
    const entries = (await readHostRecords(paths)).sort((a, b) => a.pid - b.pid);
    expect(entries.map((entry) => [entry.pid, entry.record?.pid])).toEqual([[11, 11], [12, undefined], [14, undefined], [15, undefined]]);
  });

  it('carry no record for an entry that cannot be read, which is logged and stops no other', async () => {
    // a folder where a record should be: reading it fails with EISDIR
    await fs.mkdir(hostRecordFile(paths, 18));
    await fs.writeFile(hostRecordFile(paths, 19), '{ not json');
    const lines: string[] = [];
    const entries = (await readHostRecords(paths, (line) => lines.push(line))).sort((a, b) => a.pid - b.pid);
    expect(entries).toEqual([{ pid: 18, record: undefined }, { pid: 19, record: undefined }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('the terminal host record 18.json cannot be read');
  });

  it('remove a host\'s record, its terminals and its Windows token by name, and nothing else', async () => {
    const record = POSIX ? undefined : pipeRecord(21);
    await fs.writeFile(hostRecordFile(paths, 21), '{ not json');
    await fs.writeFile(hostTerminalsFile(paths, 21), '{}');
    // what a host killed inside its writes leaves
    await fs.writeFile(`${hostTerminalsFile(paths, 21)}.tmp`, '{');
    await fs.writeFile(`${hostRecordFile(paths, 21)}.21.tmp`, '{');
    await fs.writeFile(hostTokenPath(paths, { pid: 21, socketFolder: null }), 'x');
    await fs.writeFile(hostRecordFile(paths, 22), '{}');
    await fs.writeFile(hostTerminalsFile(paths, 22), '{}');
    await removeHostFiles(paths, { pid: 21, record });
    expect((await fs.readdir(paths.terminalHostsDir)).sort()).toEqual(['22.json', '22.terminals']);
    // one already gone is done
    await removeHostFiles(paths, { pid: 21, record });
  });

  it.runIf(POSIX)('remove a host\'s socket folder by host.sock and token, and leave one that holds anything else or is not this user\'s own', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-token-base-'));
    try {
      const record = async (pid: number, extra?: string): Promise<PidRecord> => {
        const socketFolder = await createSocketFolder(base);
        await fs.writeFile(hostSocketPath(socketFolder), '');
        await writeToken(hostTokenPath(paths, { pid, socketFolder }));
        if (extra) await fs.writeFile(path.join(socketFolder, extra), 'mine');
        const made: PidRecord = { version: '3.7.0+0123456789ab', pid, hostname: os.hostname(), endpoint: hostSocketPath(socketFolder), socketFolder, updatedAt: 1 };
        await writePidFile(hostRecordFile(paths, pid), made);
        return made;
      };
      const gone = await record(31);
      const crowded = await record(32, 'notes.txt');
      const open = await record(33);
      await fs.chmod(open.socketFolder!, 0o755);
      expect((await readHostRecords(paths)).map((entry) => entry.record?.pid).sort()).toEqual([31, 32, 33]);

      await removeHostFiles(paths, { pid: 31, record: gone });
      expect(existsSync(gone.socketFolder!)).toBe(false);
      await expect(removeHostFiles(paths, { pid: 32, record: crowded })).rejects.toMatchObject({ code: 'ENOTEMPTY' });
      expect(await fs.readdir(crowded.socketFolder!)).toEqual(['notes.txt']);
      await expect(removeHostFiles(paths, { pid: 33, record: open })).rejects.toThrow('has mode 755, not 700');
      expect((await fs.readdir(open.socketFolder!)).sort()).toEqual(['host.sock', 'token']);
      // the records are gone either way, so no daemon tries those hosts again
      expect(await readHostRecords(paths)).toEqual([]);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it.runIf(POSIX)('a recorded socket folder that holds a host\'s socket is removed by the socket-folders rule', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-token-base-'));
    try {
      const folder = await createSocketFolder(base);
      await fs.writeFile(hostSocketPath(folder), '');
      await fs.writeFile(path.join(folder, 'token'), '');
      await writeSocketFolders(paths, [folder]);
      await removeRecordedSocketFolders(paths, () => undefined);
      expect(existsSync(folder)).toBe(false);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});

describe('a pid file', () => {
  // a reader of the record, or an indexer, holding it open makes Windows refuse the rename for a moment
  it.runIf(!POSIX)('replaces one that is held open for a moment', async () => {
    const file = hostRecordFile(paths, 11);
    await writePidFile(file, pipeRecord(11));
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }));
    try {
      await writePidFile(file, { ...pipeRecord(11), updatedAt: 2 });
    } finally {
      rename.mockRestore();
    }
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ pid: 11, updatedAt: 2 });
  });
});
