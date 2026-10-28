import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { decode } from '../../src/remote/codec';
import { HEADER_BYTES, MESSAGE_TYPE } from '../../src/remote/persistent-protocol';
import { NONCE_BYTES } from '../../src/remote/handshake';
import { isAlive, run, windowsProcessTree } from '../desktop/support/app';
import { openInEditor, editorShows, quickOpen, quickPick } from '../desktop/support/editor';
import type { HermeticHome } from '../desktop/support/hermetic';
import { killDaemonIn, pidIn } from '../desktop/support/loopback';
import { localRunPaths } from '../../src/desktop/daemon/token';
import { overlayPage, shellPage, shellState } from '../desktop/support/shell';
import { openTerminal, runInTerminal, waitForOutputLine } from '../desktop/support/terminal';
import { addHost, control, DARWIN_TARGET_TAG, dropConnection, expect, openRemoteFolder, readRemoteBytes, remoteProjectKey, test as remoteTest, WINDOWS_SSH_ENV, WINDOWS_TARGET_TAG, writeRemoteBytes } from './support/remote';

// The target suites run on a CI runner against its own sshd (remote-e2e-nightly.yml), which authorizes a key for the runner's
// account and passes it, the known host line and the account here. The target's home is the runner's, discarded with it.
const TARGET = {
  identity: process.env['DAMOCLES_E2E_TARGET_IDENTITY'],
  knownHosts: process.env['DAMOCLES_E2E_TARGET_KNOWN_HOSTS'],
  user: process.env['DAMOCLES_E2E_TARGET_USER'],
  // cmd or powershell: the DefaultShell the workflow gave Win32-OpenSSH
  shell: process.env['DAMOCLES_E2E_TARGET_SHELL'],
};

// A release URL nothing serves: the target's download fails at once and the app uploads the package it built.
const NO_RELEASE = 'http://127.0.0.1:1';

const targetEnv = (home: HermeticHome): Record<string, string> => ({ ...WINDOWS_SSH_ENV, DAMOCLES_E2E_HOOKS: '1', DAMOCLES_REMOTE: '1', DAMOCLES_E2E_SSH_CONFIG: targetConfig(home), DAMOCLES_E2E_RELEASE_URL: NO_RELEASE });

/** A temp ~/.ssh naming the runner's sshd as prod-1, with the workflow's key and known host. */
function targetConfig(home: HermeticHome): string {
  const { identity, knownHosts, user } = TARGET;
  if (!identity || !knownHosts || !user) throw new Error('DAMOCLES_E2E_TARGET_IDENTITY, _KNOWN_HOSTS and _USER are unset; the target suites run in remote-e2e-nightly.yml');
  const dir = path.join(home.home, '.ssh');
  fs.mkdirSync(dir, { recursive: true });
  const key = path.join(dir, 'id_ed25519');
  fs.copyFileSync(identity, key);
  if (process.platform !== 'win32') fs.chmodSync(key, 0o600);
  fs.copyFileSync(knownHosts, path.join(dir, 'known_hosts'));
  const posix = (file: string): string => file.split(path.sep).join('/');
  const config = path.join(dir, 'config');
  fs.writeFileSync(config, [
    'Host prod-1',
    '  HostName 127.0.0.1',
    '  Port 22',
    `  User ${user}`,
    `  IdentityFile "${posix(key)}"`,
    '  IdentitiesOnly yes',
    '  IdentityAgent none',
    `  UserKnownHostsFile "${posix(path.join(dir, 'known_hosts'))}"`,
    '',
  ].join('\n'));
  return config;
}

// The runner's account is the target's, so its daemon's pid file is in this computer's real home.
const targetDaemonPid = (): Promise<number | undefined> => pidIn(os.homedir());

async function connectTarget(app: ElectronApplication, folder: string): Promise<{ hostId: string; key: string }> {
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, folder);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, folder);
  return { hostId, key };
}

/** Ends the target's daemon and waits until its process (Windows: its whole tree) is gone. */
async function shutdownTarget(app: ElectronApplication, hostId: string): Promise<void> {
  const pid = await targetDaemonPid();
  expect(pid).toBeDefined();
  const tree = process.platform === 'win32' ? await windowsProcessTree(pid!) : [pid!];
  await control(app, hostId, 'shutdownNow');
  await expect.poll(() => tree.filter(isAlive), { timeout: 30_000 }).toEqual([]);
}

// Every test shares the runner account's one daemon (playwright.remote.config.ts runs them one at a time), so the next test,
// and the job's next DefaultShell run, must never meet the daemon a failed test left. An auto fixture is set up first and
// torn down last, after the test's app closed and can no longer start a daemon again.
const test = remoteTest.extend<{ leftoverDaemon: void }>({
  leftoverDaemon: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use();
      await killDaemonIn(os.homedir());
    },
    { auto: true },
  ],
});

for (const [tag, platform] of [[WINDOWS_TARGET_TAG, 'win32'], [DARWIN_TARGET_TAG, 'darwin']] as const) {
  test.describe(`${platform} target`, { tag }, () => {
    test(`connects to the runner's sshd and runs Files, the editor, a terminal and Quick Open on ${platform}`, async ({ foreground: _foreground, home, launch }) => {
      const folder = path.join(home.root, 'target-project');
      fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
      fs.writeFileSync(path.join(folder, 'src', 'target.ts'), 'export const target = 1;\n');
      fs.writeFileSync(path.join(folder, 'notes.md'), '# Target\n');
      const { app } = await launch({ env: targetEnv(home) });
      const { hostId, key } = await connectTarget(app, folder);
      const project = (await shellState(app)).projects.find((candidate) => candidate.key === key)!;
      expect(project.platform).toBe(platform);
      const shell = await shellPage(app);
      expect(await shell.evaluate((projectKey) => window.damoclesShell!.createFile({ projectKey, relativeDir: '', name: 'made.txt', kind: 'file' }), key)).toEqual({ ok: true, relativePath: 'made.txt' });
      await expect.poll(() => fs.existsSync(path.join(folder, 'made.txt'))).toBe(true);
      expect(await openInEditor(app, { projectKey: key, relativePath: 'notes.md' })).toMatchObject({ ok: true });
      await editorShows(shell, '# Target');
      const picker = quickPick(await quickOpen(app, 'target'));
      await expect(picker.locator('[data-testid="quick-pick-item"]', { hasText: 'target.ts' })).toBeVisible();
      await (await overlayPage(app)).keyboard.press('Escape');
      const terminal = await openTerminal(app);
      await runInTerminal(terminal, 'echo target-ok-3d');
      await waitForOutputLine(terminal, 'target-ok-3d');
      await shutdownTarget(app, hostId);
    });

    test(`the daemon on ${platform} survives the end of its SSH session, and the next connection attaches to it`, async ({ home, launch }) => {
      const folder = path.join(home.root, 'target-project');
      fs.mkdirSync(folder, { recursive: true });
      const { app } = await launch({ env: targetEnv(home) });
      const { hostId, key } = await connectTarget(app, folder);
      const pid = (await targetDaemonPid())!;
      await dropConnection(app, hostId);
      await expect.poll(async () => (await shellState(app)).projects.find((project) => project.key === key)?.connection).not.toBe('connected');
      expect(isAlive(pid)).toBe(true);
      await openRemoteFolder(app, hostId, folder);
      await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, folder);
      expect(await targetDaemonPid()).toBe(pid);
      await shutdownTarget(app, hostId);
    });
  });
}

test.describe('win32 target', { tag: WINDOWS_TARGET_TAG }, () => {
  test(`every byte value and 16 MiB of random data cross the connection unchanged both ways (DefaultShell ${TARGET.shell ?? 'unknown'})`, async ({ home, launch }) => {
    test.setTimeout(600_000);
    const folder = path.join(home.root, 'target-project');
    fs.mkdirSync(folder, { recursive: true });
    const { app } = await launch({ env: targetEnv(home) });
    const { hostId, key } = await connectTarget(app, folder);
    const everyByte = Buffer.from(Array.from({ length: 256 }, (_, n) => n));
    // 16 MiB in 4 MiB files, each inside one workspace message's bound
    const random = Array.from({ length: 4 }, () => randomBytes(4 * 1024 * 1024));
    for (const [i, bytes] of [everyByte, ...random].entries()) {
      const name = `bytes-${i}.bin`;
      // to the target: written through the wire, compared on the target's disk
      await writeRemoteBytes(app, key, name, bytes);
      expect(fs.readFileSync(path.join(folder, name)).equals(bytes)).toBe(true);
      // from the target: written on its disk, read through the wire
      const back = `back-${i}.bin`;
      fs.writeFileSync(path.join(folder, back), bytes);
      expect((await readRemoteBytes(app, key, back)).equals(bytes)).toBe(true);
    }
    await shutdownTarget(app, hostId);
  });

  // The daemon draws a random pipe name each start, so the bind it makes is checked with the package's own Node.
  test('a pipe another process created first under a name makes the package Node\'s bind of that name fail, as the daemon\'s start binds its pipe', async ({ home, launch }) => {
    const folder = path.join(home.root, 'target-project');
    fs.mkdirSync(folder, { recursive: true });
    const { app } = await launch({ env: targetEnv(home) });
    const { hostId } = await connectTarget(app, folder);
    const server = path.join(os.homedir(), '.damocles', 'server');
    const version = fs.readdirSync(server).find((name) => /-win32-(?:x64|arm64)$/.test(name));
    expect(version).toBeDefined();
    const node = path.join(server, version!, 'node', 'node.exe');
    const bind = "const net = require('net'); net.createServer().once('error', (e) => { console.log(e.code); process.exit(0); }).listen(process.argv[1], () => { console.log('bound'); process.exit(0); });";
    const name = `\\\\.\\pipe\\damocles-server-${randomBytes(16).toString('hex')}`;
    const squatter = net.createServer();
    await new Promise<void>((resolve) => squatter.listen(name, resolve));
    try {
      expect((await run(node, ['-e', bind, name])).stdout.trim()).toBe('EADDRINUSE');
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
    // the same name binds once nobody holds it, so the refusal was the other process's pipe
    expect((await run(node, ['-e', bind, name])).stdout.trim()).toBe('bound');
    await shutdownTarget(app, hostId);
  });

  test('a stand-in pipe under a stopped daemon\'s name receives only the bridge\'s nonce, and the bridge starts a new daemon', async ({ home, launch }) => {
    const folder = path.join(home.root, 'target-project');
    fs.mkdirSync(folder, { recursive: true });
    const { app } = await launch({ env: targetEnv(home) });
    const { hostId, key } = await connectTarget(app, folder);
    const old = (await targetDaemonPid())!;
    const record = JSON.parse(fs.readFileSync(await pidFileOf(), 'utf8')) as { endpoint: string };
    // a daemon that died without its cleanup leaves its pid file, naming a pipe nobody serves
    const tree = await windowsProcessTree(old);
    await run('taskkill', ['/F', '/T', '/PID', String(old)]);
    await expect.poll(() => tree.filter(isAlive), { timeout: 30_000 }).toEqual([]);
    await expect.poll(async () => (await shellState(app)).projects.find((project) => project.key === key)?.connection).not.toBe('connected');
    const received: Buffer[] = [];
    const standIn = net.createServer((socket) => {
      socket.on('data', (chunk) => received.push(chunk));
    });
    await new Promise<void>((resolve) => standIn.listen(record.endpoint, resolve));
    try {
      await openRemoteFolder(app, hostId, folder);
      await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, folder);
      const fresh = await targetDaemonPid();
      expect(fresh).toBeDefined();
      expect(fresh).not.toBe(old);
    } finally {
      await new Promise<void>((resolve) => standIn.close(() => resolve()));
    }
    // exactly one control frame, whose body is the bridge's first handshake message and nothing else
    const bytes = Buffer.concat(received);
    expect(bytes.length).toBeGreaterThan(HEADER_BYTES);
    expect(bytes.readUInt8(0)).toBe(MESSAGE_TYPE.control);
    expect(bytes.readUInt32BE(1)).toBe(0);
    expect(bytes.readUInt32BE(5)).toBe(0);
    expect(bytes.length).toBe(HEADER_BYTES + bytes.readUInt32BE(9));
    const body = decode(bytes.subarray(HEADER_BYTES), { maxBytes: 1024 }) as { v?: unknown; nonce?: unknown };
    expect(Object.keys(body).sort()).toEqual(['nonce', 'v']);
    expect(body.v).toBe(1);
    expect(body.nonce instanceof Uint8Array && body.nonce.length).toBe(NONCE_BYTES);
    await shutdownTarget(app, hostId);
  });
});

/** The runner's daemon pid file, in the run folder its machine key names; pidIn installed the launcher the key needs. */
async function pidFileOf(): Promise<string> {
  return (await localRunPaths(os.homedir())).pidFile;
}
