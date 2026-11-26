import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SERVER_BUNDLES } from '../../../../esbuild.config';
import type { HostMessage } from '../../pty-host/protocol';
import { terminalHostArgs } from '../../terminal-host/records';
import { createTerminalHosts, type HostLink } from '../terminal-hosts';
import { goneFromThisHost, makeRunDir, readHostRecords, runPathsIn, type RunPaths } from '../token';

// A process starts a terminal host the way a daemon does (startDetached: WMI on Windows, setsid elsewhere), starts a real
// shell in it and ends without a word, as a killed daemon does. The host and the shell must run on, and the next daemon must
// find the same shell process.

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const VERSION = '9.9.9';
const START_TIMEOUT_MS = 90_000;
const alive = (pid: number): boolean => !goneFromThisHost(os.hostname(), pid);

let root: string;
let paths: RunPaths;
let started: { hostPid: number; shellPid: number; starterPid: number };
const lines: string[] = [];

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-host-outlives-'));
  const bundle = SERVER_BUNDLES.find((options) => options.outfile === 'dist/terminal-host.js');
  if (!bundle) throw new Error('the server package has no terminal host bundle');
  await build({ ...bundle, absWorkingDir: REPO, outfile: path.join(root, 'dist', 'terminal-host.js'), logLevel: 'silent' });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: VERSION }));
  paths = runPathsIn(path.join(root, 'home', '.damocles', 'server', 'run-0123456789abcdef'));
  await makeRunDir(paths);
  const [entry, runDirArg] = terminalHostArgs(root, paths.runDir);
  // node-pty stays in the checkout: the test's package root has no node_modules
  const args = [entry!, runDirArg!, `--node-pty=${path.join(REPO, 'node_modules', 'node-pty')}`];
  const report = path.join(root, 'started.json');
  const [file, shellArgs] = process.platform === 'win32' ? [path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe'), ['/d']] : ['/bin/sh', []];
  const source = path.join(root, 'starter.ts');
  await fs.writeFile(source, `
    import * as fs from 'node:fs';
    import { startDetached } from ${JSON.stringify(path.join(REPO, 'src', 'desktop', 'daemon', 'process-starts.ts'))};
    import { createTerminalHosts } from ${JSON.stringify(path.join(REPO, 'src', 'desktop', 'daemon', 'terminal-hosts.ts'))};
    import { runPathsIn } from ${JSON.stringify(path.join(REPO, 'src', 'desktop', 'daemon', 'token.ts'))};
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const log = (line: string): void => fs.appendFileSync(${JSON.stringify(path.join(root, 'starter.log'))}, line + '\\n');
    const hosts = createTerminalHosts({ paths: runPathsIn(${JSON.stringify(paths.runDir)}), version: ${JSON.stringify(VERSION)}, start: () => startDetached(process.execPath, ${JSON.stringify(args)}, env, ${JSON.stringify(root)}, log), log });
    void hosts.currentHost().then(async (link) => {
      link.onMessage((message) => {
        if (message.type !== 'ready') return;
        fs.writeFileSync(${JSON.stringify(`${report}.tmp`)}, JSON.stringify({ hostPid: link.pid, shellPid: message.pid, starterPid: process.pid }));
        fs.renameSync(${JSON.stringify(`${report}.tmp`)}, ${JSON.stringify(report)});
        // no release and no shutdown: the process is gone, as a killed daemon is
        process.exit(0);
      });
      await link.endpoint.request('spawn', { id: 'term-1', file: ${JSON.stringify(file)}, args: ${JSON.stringify(shellArgs)}, cwd: ${JSON.stringify(os.homedir())}, env, cols: 80, rows: 24, scrollback: 1000, title: 'shell', projectKey: '', endpoints: { cli: false, relay: false } });
    }).catch((err: unknown) => {
      log(String(err));
      process.exit(1);
    });
  `);
  const starter = path.join(root, 'starter.cjs');
  // koffi resolves its native module from its own folder, as in every bundle (esbuild.config.ts)
  await build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', outfile: starter, external: ['koffi'], logLevel: 'silent' });
  const starting = spawn(process.execPath, [starter], { stdio: 'ignore', windowsHide: true });
  const code = await new Promise<number | null>((resolve) => starting.once('exit', resolve));
  const log = await fs.readFile(path.join(root, 'starter.log'), 'utf8').catch(() => '');
  if (code !== 0) throw new Error(`the starter exited with ${String(code)}: ${log}`);
  started = JSON.parse(await fs.readFile(report, 'utf8')) as typeof started;
}, 2 * START_TIMEOUT_MS);

afterAll(async () => {
  // whatever a failed test left: the host ends on its stop signal, and its shell with it
  for (const entry of await readHostRecords(paths)) if (alive(entry.pid)) process.kill(entry.pid);
  if (started && alive(started.shellPid)) process.kill(started.shellPid);
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

describe('a shell in a terminal host', { timeout: START_TIMEOUT_MS }, () => {
  let link: HostLink;
  const messages: HostMessage[] = [];
  // the next daemon's side, made once the run folder exists
  let next: ReturnType<typeof createTerminalHosts>;

  it('outlives the process that asked for it, with its host', async () => {
    await vi.waitFor(() => expect(alive(started.starterPid)).toBe(false), { timeout: 10_000 });
    expect(alive(started.hostPid)).toBe(true);
    expect(alive(started.shellPid)).toBe(true);
    expect((await readHostRecords(paths)).map((entry) => `${entry.pid} ${entry.record?.version}`)).toEqual([`${started.hostPid} ${VERSION}`]);
  });

  it('is adopted by the next daemon with the same pid, shows its screen and takes input', async () => {
    const adopted: HostLink[] = [];
    next = createTerminalHosts({ paths, version: VERSION, start: () => Promise.reject(new Error('this test starts no terminal host')), log: (line) => lines.push(line) });
    next.onLink((attached) => adopted.push(attached));
    await next.adoptAll();
    expect(adopted.map((attached) => attached.pid)).toEqual([started.hostPid]);
    link = adopted[0]!;
    expect(link.terminals.map((terminal) => `${terminal.id} ${terminal.pid}`)).toEqual([`term-1 ${started.shellPid}`]);
    link.onMessage((message) => {
      messages.push(message);
      if (message.type === 'data') link.endpoint.emit('ack', { id: message.id, chars: message.data.length });
    });
    link.endpoint.emit('viewed', { id: 'term-1', viewed: true });
    link.endpoint.emit('serialize', { id: 'term-1' });
    await vi.waitFor(() => expect(messages.some((message) => message.type === 'screen')).toBe(true), { timeout: 20_000 });
    // typed in two parts, so the marker appears only where the shell itself printed it
    link.endpoint.emit('input', { id: 'term-1', data: `echo adopted-${'$'}{HOME:+shell}%OS:~0,0%-ok${process.platform === 'win32' ? '\r' : '\n'}` });
    await vi.waitFor(() => expect(messages.flatMap((message) => (message.type === 'data' ? [message.data] : [])).join('')).toMatch(process.platform === 'win32' ? /adopted-\$\{HOME:\+shell\}-ok/ : /adopted-shell%OS:~0,0%-ok/), { timeout: 20_000 });
    expect(alive(started.shellPid)).toBe(true);
  });

  it('ends with its host on the frozen shutdown, which removes the host\'s record', async () => {
    await next.endAll();
    await vi.waitFor(() => expect(alive(started.hostPid)).toBe(false), { timeout: 20_000 });
    await vi.waitFor(() => expect(alive(started.shellPid)).toBe(false), { timeout: 20_000 });
    expect(await readHostRecords(paths)).toEqual([]);
    expect(messages.at(-1)).toEqual({ type: 'exit', id: 'term-1', exitCode: 1 });
  });
});
