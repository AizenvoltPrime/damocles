import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { isAlive, run, running, windowsProcessTree } from '../desktop/support/app';
import { openInEditor, editorShows, quickOpen, quickPick } from '../desktop/support/editor';
import { writeUserSettings } from '../desktop/support/hermetic';
import { killDaemonIn, pidIn, processTree, terminalHostPids } from '../desktop/support/loopback';
import { hostTerminalsFile, localRunPaths } from '../../src/desktop/daemon/token';
import { confirmDialog, readyOverlay } from '../desktop/support/overlay';
import { overlayPage, shellPage, shellState } from '../desktop/support/shell';
import { activeTerminal, openTerminal, runInTerminal, terminalText, waitForOutputLine } from '../desktop/support/terminal';
import { openConnect } from './support/connect-ui';
import { NOT_RESPONDING_MS, suspendProcess, terminalStatus } from './support/not-responding';
import { addHost, control, cutTransport, DARWIN_TARGET_TAG, dropConnection, expect, openRemoteFolder, readRemoteBytes, releaseTransport, remoteProjectKey, test as remoteTest, WINDOWS_TARGET_TAG, writeRemoteBytes } from './support/remote';
import { runnerTargetEnv } from './support/runner-target';

// cmd or powershell: the DefaultShell remote-e2e-nightly.yml gave Win32-OpenSSH
const TARGET_SHELL = process.env['DAMOCLES_E2E_TARGET_SHELL'];

// The runner's account is the target's, so its daemon's pid file is in this computer's real home.
const targetDaemonPid = (): Promise<number | undefined> => pidIn(os.homedir());

async function connectTarget(app: ElectronApplication, folder: string): Promise<{ hostId: string; key: string }> {
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, folder);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, folder);
  return { hostId, key };
}

/** Ends the target's daemon and waits until the whole trees of its process and its terminal hosts are gone. */
async function shutdownTarget(app: ElectronApplication, hostId: string): Promise<void> {
  const pid = await targetDaemonPid();
  expect(pid).toBeDefined();
  // a terminal host is detached, so the daemon's tree does not hold it
  const roots = [pid!, ...(await terminalHostPids(os.homedir()))];
  const tree = (await Promise.all(roots.map(processTree))).flat();
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
      const { app } = await launch({ env: await runnerTargetEnv(home) });
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
      const { app } = await launch({ env: await runnerTargetEnv(home) });
      const { hostId, key } = await connectTarget(app, folder);
      const pid = (await targetDaemonPid())!;
      // held, or the reconnect loop may be back within one poll (about 0.5 s through the ssh master) and the end goes unseen
      await cutTransport(app, hostId, { hold: true });
      await dropConnection(app, hostId);
      await expect.poll(async () => (await shellState(app)).projects.find((project) => project.key === key)?.connection).not.toBe('connected');
      expect(isAlive(pid)).toBe(true);
      await releaseTransport(app, hostId);
      await openRemoteFolder(app, hostId, folder);
      await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, folder);
      expect(await targetDaemonPid()).toBe(pid);
      await shutdownTarget(app, hostId);
    });

    test(`handOver now on ${platform} ends the daemon and leaves its terminal's shell running in the terminal host, which the next daemon adopts with the same processes`, async ({ foreground: _foreground, home, launch }) => {
      const folder = path.join(home.root, 'target-project');
      fs.mkdirSync(folder, { recursive: true });
      const { app } = await launch({ env: await runnerTargetEnv(home) });
      const { hostId } = await connectTarget(app, folder);
      const terminal = await openTerminal(app);
      const view = activeTerminal(terminal);
      const id = (await view.getAttribute('data-terminal-id'))!;
      await runInTerminal(terminal, 'echo kept-before-7c');
      await waitForOutputLine(terminal, 'kept-before-7c');
      const daemon = (await targetDaemonPid())!;
      const hosts = await terminalHostPids(os.homedir());
      expect(hosts).toHaveLength(1);
      // the host with the shell under it (Windows: the ConPTY's processes too)
      const tree = await processTree(hosts[0]!);
      expect(tree.length).toBeGreaterThan(1);

      await control(app, hostId, 'handOver', { when: 'now' });
      await expect.poll(() => isAlive(daemon), { timeout: 30_000 }).toBe(false);
      expect(tree.filter(isAlive)).toEqual(tree);

      // openRemoteFolder resolves also when the reconnect loop connected first
      await openRemoteFolder(app, hostId, folder);
      await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, folder);
      expect(await targetDaemonPid()).not.toBe(daemon);
      expect(await terminalHostPids(os.homedir())).toEqual(hosts);
      expect(tree.filter(isAlive)).toEqual(tree);
      await expect(view).toHaveAttribute('data-terminal-id', id);
      await expect(view).toHaveAttribute('data-status', 'running', { timeout: 60_000 });
      await expect.poll(async () => (await terminalText(terminal)).split('\n').filter((row) => row === 'kept-before-7c'), { timeout: 30_000 }).toHaveLength(1);
      await runInTerminal(terminal, 'echo typed-after-7c');
      await waitForOutputLine(terminal, 'typed-after-7c');
      await shutdownTarget(app, hostId);
    });

    test(`on ${platform}, Kill ends a not-responding terminal host's terminal with its process tree and End terminal host ends the host's tree, and nothing else`, async ({ foreground: _foreground, home, launch }) => {
      test.setTimeout(900_000);
      writeUserSettings(home, { 'damocles.desktop.terminal.confirmOnKill': 'never' });
      const folder = path.join(home.root, 'target-project');
      fs.mkdirSync(folder, { recursive: true });
      const { app } = await launch({ env: await runnerTargetEnv(home) });
      const { hostId, key } = await connectTarget(app, folder);
      const shell = await openTerminal(app);
      const killed = (await activeTerminal(shell).getAttribute('data-terminal-id'))!;
      const created = await shell.evaluate((project) => window.damoclesShell!.terminal.create({ profileId: null, target: { project } }), key);
      if (!created.ok) throw new Error(`no terminal: ${created.reason}`);
      const kept = created.id;
      await expect(activeTerminal(shell)).toHaveAttribute('data-terminal-id', kept);
      await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running', { timeout: 60_000 });
      const hosts = await terminalHostPids(os.homedir());
      expect(hosts).toHaveLength(1);
      const host = hosts[0]!;
      let shells = new Map<string, number>();
      await expect.poll(async () => [...(shells = await hostShellPids(host)).keys()].sort(), { timeout: 30_000 }).toEqual([killed, kept].sort());
      const killedTree = await processTree(shells.get(killed)!);
      const keptTree = await processTree(shells.get(kept)!);
      const hostTree = await processTree(host);
      expect(hostTree).toEqual(expect.arrayContaining([...killedTree, ...keptTree]));
      const daemon = (await targetDaemonPid())!;

      suspendProcess(host);
      await expect.poll(() => terminalStatus(shell, killed), { timeout: NOT_RESPONDING_MS }).toBe('notResponding');

      // Kill: the terminal's shell and its tree end, which the identity proof allows; the host and its other terminal run on
      await shell.evaluate((id) => window.damoclesShell!.terminal.kill(id), killed);
      await expect.poll(() => terminalStatus(shell, killed), { timeout: 30_000 }).toBeUndefined();
      // the host is stopped, so on darwin the killed shell stays its zombie until End terminal host
      await expect.poll(() => running(killedTree), { timeout: 30_000 }).toEqual([]);
      expect([host, ...keptTree].filter(isAlive)).toEqual([host, ...keptTree]);

      // End terminal host: the host's whole tree ends, and the daemon runs on
      const overlay = await openConnect(app);
      await overlay.getByRole('button', { name: 'Details for prod-1' }).click();
      const card = overlay.getByTestId('host-card');
      await expect(card.locator('[data-testid="host-run"][data-state="notResponding"]')).toHaveCount(1, { timeout: 30_000 });
      await card.getByTestId('host-end-terminal-host').click();
      const confirming = await readyOverlay(app);
      await expect(confirmDialog(confirming)).toContainText('End the terminal host on prod-1?');
      await confirmDialog(confirming).getByRole('button', { name: 'End terminal host' }).click();
      await expect.poll(() => running(hostTree), { timeout: 30_000 }).toEqual([]);
      await expect.poll(() => terminalStatus(shell, kept), { timeout: 30_000 }).toBe('exited');
      await expect(card.getByTestId('host-run')).toHaveCount(0, { timeout: 30_000 });
      expect(isAlive(daemon)).toBe(true);
      await overlay.keyboard.press('Escape');
      await shutdownTarget(app, hostId);
    });
  });
}

/** Each of the host's terminals with a process, by id, from the terminals file the host keeps in the run folder. */
async function hostShellPids(host: number): Promise<Map<string, number>> {
  const file = hostTerminalsFile(await localRunPaths(os.homedir()), host);
  if (!fs.existsSync(file)) return new Map();
  const { terminals } = JSON.parse(fs.readFileSync(file, 'utf8')) as { terminals: Array<{ id: string; pid: number }> };
  return new Map(terminals.filter((terminal) => terminal.pid > 0).map((terminal) => [terminal.id, terminal.pid]));
}

test.describe('win32 target', { tag: WINDOWS_TARGET_TAG }, () => {
  test(`every byte value and 16 MiB of random data cross the connection unchanged both ways (DefaultShell ${TARGET_SHELL ?? 'unknown'})`, async ({ home, launch }) => {
    test.setTimeout(600_000);
    const folder = path.join(home.root, 'target-project');
    fs.mkdirSync(folder, { recursive: true });
    const { app } = await launch({ env: await runnerTargetEnv(home) });
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

  test('damocles opens a file from a terminal that survived handOver now, through its terminal host\'s pipe and the active junction, on the next daemon', async ({ foreground: _foreground, home, launch }) => {
    const folder = path.join(home.root, 'target-project');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'survived.md'), '# Survived\n');
    const { app } = await launch({ env: await runnerTargetEnv(home) });
    const { hostId } = await connectTarget(app, folder);
    const terminal = await openTerminal(app);
    const view = activeTerminal(terminal);
    const daemon = (await targetDaemonPid())!;
    // the run folder's active link is a junction to the running package
    const paths = await localRunPaths(os.homedir());
    const active = path.join(paths.runDir, 'active');
    expect(fs.lstatSync(active).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(fs.realpathSync(active), 'server-package.json'))).toBe(true);

    await control(app, hostId, 'handOver', { when: 'now' });
    await expect.poll(() => isAlive(daemon), { timeout: 30_000 }).toBe(false);
    await openRemoteFolder(app, hostId, folder);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, folder);
    expect(await targetDaemonPid()).not.toBe(daemon);
    await expect(view).toHaveAttribute('data-status', 'running', { timeout: 60_000 });
    await runInTerminal(terminal, `damocles "${path.join(folder, 'survived.md')}"`);
    await editorShows(await shellPage(app), '# Survived');
    await shutdownTarget(app, hostId);
  });

  // The daemon draws a random pipe name each start, so the bind it makes is checked with the package's own Node.
  test('a pipe another process created first under a name makes the package Node\'s bind of that name fail, as the daemon\'s start binds its pipe', async ({ home, launch }) => {
    const folder = path.join(home.root, 'target-project');
    fs.mkdirSync(folder, { recursive: true });
    const { app } = await launch({ env: await runnerTargetEnv(home) });
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

  test('a stand-in pipe under a crashed daemon\'s name receives nothing, and the bridge starts a new daemon', async ({ home, launch }) => {
    const folder = path.join(home.root, 'target-project');
    fs.mkdirSync(folder, { recursive: true });
    const { app } = await launch({ env: await runnerTargetEnv(home) });
    const { hostId, key } = await connectTarget(app, folder);
    const old = (await targetDaemonPid())!;
    const record = JSON.parse(fs.readFileSync(await pidFileOf(), 'utf8')) as { endpoint: string };
    // a daemon that died without its cleanup leaves its pid file, naming a pipe nobody serves
    const tree = await windowsProcessTree(old);
    await run('taskkill', ['/F', '/T', '/PID', String(old)]);
    await expect.poll(() => tree.filter(isAlive), { timeout: 30_000 }).toEqual([]);
    await expect.poll(async () => (await shellState(app)).projects.find((project) => project.key === key)?.connection).not.toBe('connected');
    // the pid file names a process that has ended, so neither the bridge nor the new daemon's lock wait connects to its pipe
    let connections = 0;
    const standIn = net.createServer(() => {
      connections += 1;
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
    expect(connections).toBe(0);
    await shutdownTarget(app, hostId);
  });
});

/** The runner's daemon pid file, in the run folder its machine key names; pidIn installed the launcher the key needs. */
async function pidFileOf(): Promise<string> {
  return (await localRunPaths(os.homedir())).pidFile;
}
