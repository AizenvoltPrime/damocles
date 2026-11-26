import { createHmac, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { processLauncher, type LaunchedProcess } from '../../../../../core/process-launcher';
import { decode, encode } from '../../../../../remote/codec';
import { HANDSHAKE_MAX_BYTES } from '../../../../../remote/handshake';
import { createPersistentProtocol } from '../../../../../remote/persistent-protocol';
import { streamSocket } from '../../../../../remote/stream-transport';
import { markHandedOver } from '../../../../daemon/hand-over-mark';
import { localRunPaths, makeRunDir, pipeName, tokenPath, writePidFile, writeToken, type RunPaths } from '../../../../daemon/token';
import type { ServerManifest } from '../../server-manifest-format';
import { parseStageLine, STAGE_MARKER, type StageMessage } from '../probe-parse';
import { stage1Frame, windowsStage0 } from '../stage0';
import { buildWindowsStage1 } from '../stage1';
import { powerShell, runPowerShell, scratchDir, withWindowsDefinitions } from './shells';

// Stage 0 and stage 1 as a Win32-OpenSSH session runs them: overlapped stdin and stdout, under cmd or a PowerShell default
// shell, ending in the package's own `node.exe dist\daemon.js attach`, which reaches a daemon this test plays.

const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');
const SERVER_VERSION = '3.7.0+0123456789ab';
const TARGET = process.arch === 'arm64' ? 'win32-arm64' : 'win32-x64';
const BRIDGE_LINE = Buffer.from(`${STAGE_MARKER}{"kind":"bridge"}\n`);
const CODEC_LIMITS = { maxBytes: HANDSHAKE_MAX_BYTES, maxItems: 512, maxDepth: 4 };

const pkg = { file: `damocles-server-3.7.0-${TARGET}.zip`, sha256: 'a'.repeat(64), size: 10, serverVersion: SERVER_VERSION };
const manifest: ServerManifest = { version: '3.7.0', protocolVersion: 1, published: false, packages: { 'win32-x64': pkg, 'win32-arm64': pkg } };

// every byte value, then random bytes
const payloadOf = (length: number): Buffer => Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, index) => index)), randomBytes(length - 256)]);

const proofOf = (token: Uint8Array, label: string, first: Uint8Array, second: Uint8Array): Buffer => createHmac('sha256', token).update(label).update(first).update(second).digest();

interface FakeDaemon {
  readonly connections: () => number;
  close(): Promise<void>;
}

// A daemon as a bridge finds it: its pid record naming its pipe, the token, its side of the token proof, then an echo of every
// byte the bridge copies to it.
async function fakeDaemon(paths: RunPaths): Promise<FakeDaemon> {
  await makeRunDir(paths);
  const token = await writeToken(tokenPath(paths, { socketFolder: null }));
  const endpoint = pipeName();
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    const protocol = createPersistentProtocol({ socket: streamSocket(socket), maxBodyBytes: HANDSHAKE_MAX_BYTES, log: () => undefined });
    const daemonNonce = randomBytes(32);
    let bridgeNonce: Uint8Array | undefined;
    protocol.onControl((body) => {
      const fields = decode(body, CODEC_LIMITS) as Record<string, unknown>;
      if (bridgeNonce === undefined) {
        bridgeNonce = fields['nonce'] as Uint8Array;
        protocol.sendControl(encode({ nonce: daemonNonce, proof: proofOf(token, 'damocles-daemon', bridgeNonce, daemonNonce) }));
        return;
      }
      if (!proofOf(token, 'damocles-bridge', daemonNonce, bridgeNonce).equals(fields['proof'] as Uint8Array)) {
        socket.destroy();
        return;
      }
      // detached inside the listener, so the bytes after the proof are never read as frames
      socket.write(protocol.detach());
      socket.on('data', (chunk: Buffer) => socket.write(chunk));
      socket.resume();
    });
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  await writePidFile(paths.pidFile, { version: SERVER_VERSION, pid: process.pid, hostname: os.hostname(), endpoint, socketFolder: null, updatedAt: Date.now() });
  return {
    connections: () => sockets.length,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Stage {
  readonly child: LaunchedProcess;
  readonly stdout: () => Buffer;
  readonly stderr: () => string;
}

// the stage's status messages up to and including the bridge line, and the bytes after it
const split = (stdout: Buffer): { readonly messages: StageMessage[]; readonly rest: Buffer | undefined } => {
  const at = stdout.indexOf(BRIDGE_LINE);
  const lines = at < 0 ? stdout : stdout.subarray(0, at + BRIDGE_LINE.length);
  const messages = lines.toString('utf8').split(/\r?\n/).flatMap((line) => {
    const message = parseStageLine(line);
    return message ? [message] : [];
  });
  return { messages, rest: at < 0 ? undefined : stdout.subarray(at + BRIDGE_LINE.length) };
};

describe.skipIf(process.platform !== 'win32')('Windows stage 1 runs the package\'s attach bridge under a real Windows PowerShell', { timeout: 150_000 }, async () => {
  const shell = (await powerShell())!;
  const install = path.join(os.homedir(), '.damocles', 'server');
  const floorFile = path.join(install, 'security-floor');
  const report = path.join(scratchDir('bridge-report-'), 'serve.json');
  // a PSModulePath from the other edition, which the stage drops for itself and hands the daemon
  const foreign = scratchDir('ps7-modules-');
  let paths: RunPaths;

  // The installed version folder: Node, the attach bundle, and a daemon.js whose serve only reports its environment.
  beforeAll(async () => {
    paths = await localRunPaths();
    const versionDir = path.join(install, `${SERVER_VERSION}-${TARGET}`);
    mkdirSync(path.join(versionDir, 'node'), { recursive: true });
    copyFileSync(process.execPath, path.join(versionDir, 'node', 'node.exe'));
    const options = { bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent', write: true, packages: 'external' } as const;
    await Promise.all([
      build({ ...options, entryPoints: [path.join(REPO, 'src', 'desktop', 'daemon', 'main.ts')], outfile: path.join(versionDir, 'dist', 'attach.js') }),
      build({ ...options, entryPoints: [path.join(REPO, 'src', 'core', 'process-launcher', 'worker.ts')], outfile: path.join(versionDir, 'dist', 'process-launcher-worker.js') }),
      build({ ...options, entryPoints: [path.join(REPO, 'src', 'core', 'pi-session', 'tools', 'shell-sentinel.ts')], outfile: path.join(versionDir, 'dist', 'sentinel.js') }),
    ]);
    writeFileSync(path.join(versionDir, 'dist', 'daemon.js'), `if (process.argv[2] === 'serve') require('node:fs').writeFileSync(${JSON.stringify(report)}, JSON.stringify({ psModulePath: process.env.PSModulePath ?? null, executionPolicy: process.env.PSExecutionPolicyPreference ?? null }));\nelse require('./attach.js');\n`);
    writeFileSync(path.join(versionDir, 'server-package.json'), JSON.stringify({ name: 'damocles-server', version: '3.7.0', serverVersion: SERVER_VERSION }));
  }, 150_000);

  const running: Stage[] = [];
  afterEach(() => {
    for (const stage of running.splice(0)) stage.child.kill({ tree: true });
    rmSync(paths.runDir, { recursive: true, force: true });
    rmSync(report, { force: true });
    rmSync(floorFile, { force: true });
  });

  // Stage 0 as sshd starts it under each default shell, given stage 1 at once, with the session's execution policy, if any; the
  // packages resolve from the checkout.
  const start = async (form: 'cmd' | 'powershell', executionPolicy?: string): Promise<Stage> => {
    const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([name]) => !['PSMODULEPATH', 'PSEXECUTIONPOLICYPREFERENCE'].includes(name.toUpperCase())));
    env['PSModulePath'] = `${foreign};${path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')}`;
    if (executionPolicy !== undefined) env['PSExecutionPolicyPreference'] = executionPolicy;
    env['NODE_PATH'] = path.join(REPO, 'node_modules');
    const spec = form === 'cmd'
      ? { file: path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/d', '/c', ...windowsStage0('cmd').split(' ')] }
      : { file: shell, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsStage0('powershell')] };
    const child = processLauncher().launch({ ...spec, env, windowsHide: true, stdio: ['overlapped', 'overlapped', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.onData('stdout', (chunk) => stdout.push(chunk));
    child.onData('stderr', (chunk) => stderr.push(chunk));
    const stage = { child, stdout: () => Buffer.concat(stdout), stderr: () => Buffer.concat(stderr).toString('utf8') };
    running.push(stage);
    await child.write(stage1Frame(buildWindowsStage1({ manifest })));
    return stage;
  };

  // the protocol's bytes, sent right behind stage 1 in network-sized chunks, before any of the stage has run
  const send = async (stage: Stage, payload: Buffer): Promise<void> => {
    for (let at = 0; at < payload.length; at += 64 * 1024) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      await stage.child.write(payload.subarray(at, at + 64 * 1024));
    }
  };

  const echoed = async (stage: Stage, payload: Buffer): Promise<void> => {
    await vi.waitFor(() => expect(split(stage.stdout()).rest?.length ?? -1).toBeGreaterThanOrEqual(payload.length), { timeout: 120_000, interval: 100 });
  };

  // Clear-DamoclesPrevious tells this machine's records by the run folder the bridge uses
  it('keys this machine\'s run folder as the bridge does', async () => {
    const output = await runPowerShell(shell, withWindowsDefinitions('[Console]::Out.Write("run-$(Get-DamoclesRunKey)")'));
    expect(output.stdout.toString('utf8')).toBe(path.basename(paths.runDir));
  });

  it.each(['cmd', 'powershell'] as const)('hands attach stage 0\'s own handles under %s: PowerShell reads none of the 4 MiB behind stage 1, which pass through unchanged', async (form) => {
    const daemon = await fakeDaemon(paths);
    const payload = payloadOf(4 * 1024 * 1024);
    const stage = await start(form);
    const sending = send(stage, payload);
    await echoed(stage, payload);
    await sending;
    await daemon.close();
    expect((await stage.child.exited).code, stage.stderr()).toBe(0);
    const { messages, rest } = split(stage.stdout());
    expect(messages.slice(-2)).toEqual([{ kind: 'step', step: 'starting' }, { kind: 'bridge' }]);
    expect(rest!.equals(payload)).toBe(true);
    expect([daemon.connections(), existsSync(report)]).toEqual([1, false]);
  });

  it('writes the belowFloor line after the bridge line and exits with the bridge\'s code, starting no daemon, when the app is below the host\'s floor', async () => {
    writeFileSync(floorFile, '3.9.0\n');
    const stage = await start('powershell');
    expect((await stage.child.exited).code).toBe(1);
    const { messages, rest } = split(stage.stdout());
    expect(messages.slice(-2)).toEqual([{ kind: 'step', step: 'starting' }, { kind: 'bridge' }]);
    expect(parseStageLine(rest!.toString('utf8').trimEnd())).toEqual({ kind: 'fail', code: 'belowFloor', params: { floor: '3.9.0' } });
    expect(stage.stderr()).not.toContain('starting one');
    expect(existsSync(report)).toBe(false);
  });

  it('yields after a hand-over to the daemon another bridge starts, starting none of its own', async () => {
    const payload = payloadOf(64 * 1024);
    const stage = await start('cmd');
    const sending = send(stage, payload);
    await vi.waitFor(() => expect(split(stage.stdout()).messages.some((message) => message.kind === 'probe')).toBe(true), { timeout: 120_000, interval: 50 });
    await makeRunDir(paths);
    await markHandedOver(paths, SERVER_VERSION);
    await vi.waitFor(() => expect(split(stage.stdout()).rest).toBeDefined(), { timeout: 120_000, interval: 50 });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const daemon = await fakeDaemon(paths);
    await echoed(stage, payload);
    await sending;
    await daemon.close();
    expect((await stage.child.exited).code, stage.stderr()).toBe(0);
    expect(split(stage.stdout()).rest!.equals(payload)).toBe(true);
    expect(stage.stderr()).not.toContain('starting one');
    expect(existsSync(report)).toBe(false);
  });

  it('starts the daemon through WMI with the PSModulePath the stage inherited, then joins it', async () => {
    const payload = payloadOf(64 * 1024);
    const stage = await start('powershell');
    const sending = send(stage, payload);
    await vi.waitFor(() => expect(existsSync(report)).toBe(true), { timeout: 120_000, interval: 100 });
    const daemon = await fakeDaemon(paths);
    await echoed(stage, payload);
    await sending;
    await daemon.close();
    expect((await stage.child.exited).code, stage.stderr()).toBe(0);
    expect(stage.stderr()).toContain('starting one');
    expect(stage.stderr()).not.toContain('detached instead');
    // Windows PowerShell adds its own folders to the value it inherited, after it
    const { psModulePath, executionPolicy } = JSON.parse(readFileSync(report, 'utf8')) as { psModulePath: string | null; executionPolicy: string | null };
    expect(psModulePath?.startsWith(`${foreign};`), psModulePath ?? 'none').toBe(true);
    // the session had none, and the stage's own Bypass stays the stage's
    expect(executionPolicy).toBeNull();
  });

  // the Bypass the stage runs under would otherwise reach every PowerShell the user opens in a terminal on the host
  it.each([undefined, 'RemoteSigned'] as const)('hands the daemon the execution policy the session had (%s) under cmd, never the stage\'s own', async (policy) => {
    const payload = payloadOf(64 * 1024);
    const stage = await start('cmd', policy);
    const sending = send(stage, payload);
    await vi.waitFor(() => expect(existsSync(report), stage.stderr()).toBe(true), { timeout: 120_000, interval: 100 });
    const daemon = await fakeDaemon(paths);
    await echoed(stage, payload);
    await sending;
    await daemon.close();
    expect((await stage.child.exited).code, stage.stderr()).toBe(0);
    const { executionPolicy } = JSON.parse(readFileSync(report, 'utf8')) as { executionPolicy: string | null };
    expect(executionPolicy).toBe(policy ?? null);
  });
});
