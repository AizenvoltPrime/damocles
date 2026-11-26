import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVER_BUNDLES } from '../../../../esbuild.config';
import { startIdentity } from '../../daemon/process-identity';
import { goneFromThisHost, hostPipeName, hostRecordFile, hostTerminalsFile, hostTokenPath, localRunPaths, makeRunDir, readHostRecords, readToken, runPathsIn, TERMINAL_HOST_LOG_FILE, terminalHostLogName, type PidRecord, type RunPaths } from '../../daemon/token';
import { windowsSystemTool } from '../../../core/system-tools';
import { serveTerminalHost, terminalHostArgs } from '../records';
import { readHostTerminals } from '../terminals-file';
import { connectDaemon, named, openSocket, output, until, type Daemon } from './host-client';

// The host as a daemon starts it: its bundles, run with Node from a package root, with the real node-pty, the real start
// identity reads and a real shell.

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const WINDOWS = process.platform === 'win32';
const START_TIMEOUT_MS = 60_000;
// what main.ts loads from the package root's dist/
const PACKAGE_BUNDLES = ['dist/terminal-host.js', 'dist/process-launcher-worker.js', 'dist/sentinel.js'];

interface HostProcess {
  readonly paths: RunPaths;
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  readonly record: PidRecord;
}

let root: string;
let paths: RunPaths;
let child: ChildProcess;
let exited: Promise<number | null>;
let host: PidRecord;
const hosts: HostProcess[] = [];

const alive = (pid: number): boolean => !goneFromThisHost(os.hostname(), pid);

// a host started as a daemon starts it, in its own run folder, once it wrote its record
async function startHost(runFolder: string): Promise<HostProcess> {
  const runPaths = runPathsIn(path.join(root, runFolder, '.damocles', 'server', 'run-0123456789abcdef'));
  await fs.mkdir(runPaths.logsDir, { recursive: true });
  const [bundle, runDirArg] = terminalHostArgs(root, runPaths.runDir);
  // node-pty stays in the checkout: the test's package root holds only koffi
  const started = spawn(process.execPath, [bundle!, runDirArg!, `--node-pty=${path.join(REPO, 'node_modules', 'node-pty')}`], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  started.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const done = new Promise<number | null>((resolve) => started.once('exit', resolve));
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    const [entry] = await readHostRecords(runPaths);
    if (entry?.record) {
      const launched: HostProcess = { paths: runPaths, child: started, exited: done, record: entry.record };
      hosts.push(launched);
      return launched;
    }
    if (started.exitCode !== null || Date.now() > deadline) throw new Error(`the host wrote no record (exit ${String(started.exitCode)}); stderr: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function connectTo(target: HostProcess): Promise<Daemon> {
  const token = await readToken(hostTokenPath(target.paths, target.record));
  return connectDaemon(await openSocket(target.record.endpoint), token);
}

const connect = (): Promise<Daemon> => connectTo(hosts[0]!);

const shellSpawn = (id: string, file: string) => {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== '' && !entry[0].includes('=')));
  return { id, file, args: [], cwd: root, env, cols: 80, rows: 24, scrollback: 1000, title: path.basename(file), projectKey: '', endpoints: { cli: false, relay: false } };
};

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-host-process-'));
  for (const outfile of PACKAGE_BUNDLES) {
    const options = SERVER_BUNDLES.find((bundle) => bundle.outfile === outfile);
    if (!options) throw new Error(`the server package has no ${outfile}`);
    await build({ ...options, absWorkingDir: REPO, outfile: path.join(root, outfile), logLevel: 'silent' });
  }
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  // a server package carries koffi on Windows (build-server.ts serverRoots), which resolves its native module from the checkout
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.symlink(path.join(REPO, 'node_modules', 'koffi'), path.join(root, 'node_modules', 'koffi'), 'junction');
  ({ paths, child, exited, record: host } = await startHost('home'));
}, 2 * START_TIMEOUT_MS);

afterAll(async () => {
  for (const started of hosts) {
    if (started.child.exitCode === null) started.child.kill();
    await started.exited;
  }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
});

describe.runIf(WINDOWS)('the terminal host\'s endpoint on Windows', () => {
  const serve = (runPaths: RunPaths, logged: string[] = [], pipeNames?: () => string) => serveTerminalHost({ paths: runPaths, version: '9.9.9', accept: (socket) => socket.destroy(), touchIntervalMs: 24 * 60 * 60 * 1000, log: (line) => logged.push(line), ...(pipeNames ? { pipeNames } : {}) });

  it('picks another pipe name when the one it drew is taken', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-host-pipe-'));
    const runPaths = await localRunPaths(home);
    await makeRunDir(runPaths);
    const taken = hostPipeName();
    const squatter = net.createServer();
    await new Promise<void>((resolve) => squatter.listen(taken, resolve));
    const names = [taken, hostPipeName()];
    const logged: string[] = [];
    const served = await serve(runPaths, logged, () => names.shift()!);
    try {
      expect(served.record.endpoint).not.toBe(taken);
      expect(served.record.endpoint).toMatch(/^\\\\\.\\pipe\\damocles-terminals-[0-9a-f]{32}$/);
      expect(logged).toContain(`[terminal-host] the pipe name ${taken} is taken; picking another`);
    } finally {
      await served.close();
      squatter.close();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('keeps its token and its record to the user alone, by the run folder\'s ACL', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-host-acl-'));
    const runPaths = await localRunPaths(home);
    await makeRunDir(runPaths);
    const served = await serve(runPaths);
    try {
      const user = `${process.env['USERDOMAIN']}\\${os.userInfo().username}`.toLowerCase();
      for (const target of [runPaths.terminalHostsDir, hostTokenPath(runPaths, served.record), hostRecordFile(runPaths, served.record.pid)]) {
        // icacls prints the path before the first entry and a summary line last
        const entries = execFileSync(windowsSystemTool('icacls'), [target], { encoding: 'utf8' }).replace(target, '').split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[^ ]+\\?[^:]*:\(/.test(line));
        expect(entries).toHaveLength(1);
        expect(entries[0]!.toLowerCase().startsWith(`${user}:`)).toBe(true);
      }
    } finally {
      await served.close();
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe('the terminal host process', () => {
  it('writes its record, endpoint and token where a daemon looks for them', async () => {
    expect(host).toMatchObject({ version: '9.9.9', pid: child.pid, hostname: os.hostname() });
    expect(hostRecordFile(paths, host.pid)).toBe(path.join(paths.runDir, 'terminal-hosts', `${host.pid}.json`));
    const tokenFile = hostTokenPath(paths, host);
    expect(await fs.readFile(tokenFile, 'utf8')).toMatch(/^[0-9a-f]{64}$/);
    if (WINDOWS) {
      expect(host.socketFolder).toBeNull();
      expect(host.endpoint).toMatch(/^\\\\\.\\pipe\\damocles-terminals-[0-9a-f]{32}$/);
      expect(tokenFile).toBe(path.join(paths.runDir, 'terminal-hosts', `${host.pid}.token`));
    } else {
      expect(path.basename(host.socketFolder!)).toMatch(/^damocles-/);
      expect(host.endpoint).toBe(path.join(host.socketFolder!, 'host.sock'));
      expect((await fs.stat(host.socketFolder!)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(tokenFile)).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses a peer that does not hold its token', async () => {
    await expect(connectDaemon(await openSocket(host.endpoint), new Uint8Array(32))).rejects.toThrow('the endpoint is not this user\'s daemon');
  });

  it('keeps a real shell running across daemon connections, and leaves nothing behind on shutdown', async () => {
    const first = await connect();
    expect(first.welcome).toMatchObject({ kind: 'welcome', welcome: { serverVersion: '9.9.9', protocolVersion: 1 } });
    expect(await first.endpoint.request('attach', { features: [] })).toEqual({ terminals: [] });
    const file = WINDOWS ? (process.env['ComSpec'] ?? 'cmd.exe') : '/bin/sh';
    await first.endpoint.request('spawn', shellSpawn('term-1', file));
    // a ConPTY reports its pid at its first output
    await until(() => named(first, 'ready').length === 1, START_TIMEOUT_MS);
    const { pid } = named(first, 'ready')[0]!;
    expect(pid).toBeGreaterThan(0);

    // what a daemon proves the host and the shell by before a kill, read as a daemon reads it
    const expected = { hostStart: await startIdentity(host.pid), start: await startIdentity(pid) };
    expect(expected.hostStart).toMatch(/^(linux1|win1|darwin1):/);
    expect(expected.start).toMatch(/^(linux1|win1|darwin1):/);
    const deadline = Date.now() + START_TIMEOUT_MS;
    let recorded = await readHostTerminals(paths, host.pid, () => undefined);
    while (recorded?.terminals[0]?.start === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      recorded = await readHostTerminals(paths, host.pid, () => undefined);
    }
    expect(recorded).toMatchObject({ hostStart: expected.hostStart, terminals: [{ id: 'term-1', pid, start: expected.start }] });
    // the typed text holds no 42; the shell's answer does
    first.endpoint.emit('input', { id: 'term-1', data: WINDOWS ? 'set /a 40+2\r' : 'echo $((40+2))\r' });
    await until(() => output(first).includes('42'), START_TIMEOUT_MS);
    for (const event of named(first, 'data')) first.endpoint.emit('ack', { id: 'term-1', chars: event.data.length });

    // the daemon goes; the shell and the host stay
    first.protocol.close('the daemon exited');
    await first.closed;
    const second = await connect();
    const { terminals } = await second.endpoint.request('attach', { features: [] });
    expect(terminals).toMatchObject([{ id: 'term-1', pid, title: path.basename(file), projectKey: '' }]);
    expect(alive(pid)).toBe(true);
    second.endpoint.emit('serialize', { id: 'term-1' });
    await until(() => named(second, 'screen').length === 1, START_TIMEOUT_MS);
    expect(named(second, 'screen')[0]!.data).toContain('42');
    second.endpoint.emit('input', { id: 'term-1', data: WINDOWS ? 'set /a 50+5\r' : 'echo $((50+5))\r' });
    await until(() => output(second).includes('55'), START_TIMEOUT_MS);

    await second.endpoint.request('shutdown', {});
    expect(named(second, 'exit')).toEqual([{ name: 'exit', id: 'term-1', exitCode: 1 }]);
    await second.closed;
    expect(await exited).toBe(0);
    expect(await readHostRecords(paths)).toEqual([]);
    await expect(fs.stat(hostTokenPath(paths, host))).rejects.toMatchObject({ code: 'ENOENT' });
    if (host.socketFolder !== null) await expect(fs.stat(host.socketFolder)).rejects.toMatchObject({ code: 'ENOENT' });
    await until(() => !alive(pid), START_TIMEOUT_MS);
    const logs = (await fs.readdir(paths.logsDir)).filter((name) => TERMINAL_HOST_LOG_FILE.test(name));
    expect(logs).toEqual([`${terminalHostLogName(host.pid)}.log`]);
    expect(await fs.readFile(path.join(paths.logsDir, logs[0]!), 'utf8')).toContain('Damocles terminal host 9.9.9 starting');
  }, 4 * START_TIMEOUT_MS);
});

// Windows has no SIGTERM: Node's kill there is TerminateProcess, which runs no handler
describe.runIf(!WINDOWS)('the terminal host process on SIGTERM', () => {
  it('ends its shells, removes its record and its terminals file, and exits', async () => {
    const target = await startHost('sigterm');
    const daemon = await connectTo(target);
    await daemon.endpoint.request('attach', { features: [] });
    await daemon.endpoint.request('spawn', shellSpawn('term-1', '/bin/sh'));
    await until(() => named(daemon, 'ready').length === 1, START_TIMEOUT_MS);
    const { pid } = named(daemon, 'ready')[0]!;
    expect(alive(pid)).toBe(true);
    target.child.kill('SIGTERM');
    expect(await target.exited).toBe(0);
    expect(await readHostRecords(target.paths)).toEqual([]);
    await expect(fs.stat(hostTerminalsFile(target.paths, target.record.pid))).rejects.toMatchObject({ code: 'ENOENT' });
    await until(() => !alive(pid), START_TIMEOUT_MS);
  }, 4 * START_TIMEOUT_MS);
});
