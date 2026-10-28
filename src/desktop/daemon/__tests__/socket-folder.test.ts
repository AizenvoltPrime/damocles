// POSIX only: Windows has no socket folder. Written to run on Linux CI and macOS.
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentSocketFile } from '../../core-protocol/agent-sockets';
import type { CoreInit } from '../../core-protocol/messages';
import type { HostStarters } from '../../workspace/host-starters';
import type { CoreAttach } from '../control-messages';
import type { ForkedChild } from '../process-starts';
import { checkSocketFolder, createSocketFolder, readPidFile, socketFolderBase } from '../token';
import { startInProcessDaemon } from './in-process-daemon';
import { connectClient } from './test-client';

const NO_HOSTS: HostStarters = {
  startPtyHost: () => { throw new Error('no pty host in this test'); },
  startFormatterHost: () => { throw new Error('no formatter host in this test'); },
};

const CORE_ATTACH: CoreAttach = {
  attach: 1,
  hostId: 'client-host',
  appInfo: { version: '0.0.0-test', host: 'desktop' },
  secretsPersistent: true,
  chatBrowserPane: true,
  mirrors: { state: { global: {}, workspace: {} }, trust: { keys: [] }, folders: { folders: [] }, editor: {}, terminal: { shown: false, shortcut: '' }, language: { language: 'en' }, clientAuth: { providers: {} }, clientUser: { settings: {}, permissionRules: [] }, clientPolicy: { voice: false, allowBypass: false, agentForwarding: true } },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the socket base on Linux with XDG_RUNTIME_DIR, which logind removes at the last logout unless the user lingers", () => {
  const runtime = { XDG_RUNTIME_DIR: '/run/user/1000' };

  it('is XDG_RUNTIME_DIR with linger', async () => {
    expect(await socketFolderBase(runtime, 'linux', async () => true)).toBe('/run/user/1000');
  });

  it('is /tmp without linger', async () => {
    expect(await socketFolderBase(runtime, 'linux', async () => false)).toBe('/tmp');
  });
});

describe.skipIf(process.platform === 'win32')('the socket folder', () => {
  it('is an unpredictable 0700 folder of this user under the socket base', async () => {
    const base = await socketFolderBase();
    const folder = await createSocketFolder(base);
    expect(path.dirname(folder)).toBe(base);
    expect(path.basename(folder)).toMatch(/^damocles-.{6}$/);
    const stat = fs.lstatSync(folder);
    expect(stat.mode & 0o777).toBe(0o700);
    expect(stat.uid).toBe(process.getuid!());
    fs.rmdirSync(folder);
  });

  it('lives in TMPDIR on macOS and in /tmp on Linux without linger', async () => {
    expect(await socketFolderBase({ TMPDIR: '/private/var/folders/x/T' }, 'darwin')).toBe('/private/var/folders/x/T');
    expect(await socketFolderBase({}, 'linux')).toBe('/tmp');
  });

  it('refuses a symlinked, foreign-owned, open or network folder', async () => {
    const real = await createSocketFolder(await socketFolderBase());
    const link = path.join(os.tmpdir(), `dm-link-${process.pid}`);
    fs.symlinkSync(real, link);
    await expect(checkSocketFolder(link)).rejects.toThrow(/not a folder/);
    if (process.getuid!() !== 0) await expect(checkSocketFolder('/')).rejects.toThrow(/belongs to uid 0/);
    fs.chmodSync(real, 0o755);
    await expect(checkSocketFolder(real)).rejects.toThrow(/mode 755/);
    fs.chmodSync(real, 0o700);
    if (process.platform === 'linux') {
      vi.spyOn(fs.promises, 'statfs').mockResolvedValue({ type: 0x6969 } as fs.StatsFs);
      await expect(checkSocketFolder(real)).rejects.toThrow(/on NFS/);
    }
    fs.unlinkSync(link);
    fs.rmdirSync(real);
  });

  it('binds again with a new folder and token when the folder was removed before a touch, and keeps running', async () => {
    const lines: string[] = [];
    const daemon = await startInProcessDaemon({ starters: NO_HOSTS, touchIntervalMs: 20, log: (line) => lines.push(line) });
    let exit: string | undefined;
    void daemon.exited.then((reason) => {
      exit = reason;
    });
    const first = (await readPidFile(daemon.paths.pidFile))!;
    fs.rmSync(first.socketFolder!, { recursive: true });
    await vi.waitFor(async () => {
      const now = await readPidFile(daemon.paths.pidFile);
      expect(now?.socketFolder).not.toBe(first.socketFolder);
      expect(fs.existsSync(now!.endpoint)).toBe(true);
    }, { timeout: 5000 });
    expect(exit).toBeUndefined();
    expect(lines.filter((line) => line.includes('shutting down'))).toEqual([]);
    expect((await connectClient(await daemon.connect(), { clientId: 'a' })).outcome.kind).toBe('welcome');
    await daemon.shutdown();
  });

  it('makes the agent folder before the endpoint listens, so a core forked for the first connection is given it', async () => {
    const lines: string[] = [];
    const daemon = await startInProcessDaemon({ starters: NO_HOSTS, log: (line) => lines.push(line) });
    const made = lines.findIndex((line) => line.startsWith('[agent] made the agent folder '));
    const listening = lines.findIndex((line) => line.startsWith('[daemon] listening on '));
    expect(made).toBeGreaterThanOrEqual(0);
    expect(made).toBeLessThan(listening);
    await daemon.shutdown();
  });

  it('makes the agent and relay folders again when they were removed, listens there, and tells the running core', async () => {
    // a core that never answers, so the shutdown kills it after its close limit
    const posted: unknown[] = [];
    let exited: (exit: { code: number; signal: string | null; error: string | null }) => void = () => undefined;
    const forkCore = (): ForkedChild => ({
      pid: 4242,
      postMessage: (message) => posted.push(message),
      onMessage: () => undefined,
      onExit: (listener) => { exited = listener; },
      kill: () => exited({ code: 1, signal: null, error: null }),
    });
    const agents = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-agent-'));
    const agentSock = path.join(agents, 'agent.1');
    const agent = net.createServer((socket) => socket.end('laptop'));
    await new Promise<void>((resolve) => agent.listen(agentSock, resolve));
    const lines: string[] = [];
    const daemon = await startInProcessDaemon({ starters: NO_HOSTS, touchIntervalMs: 20, credentialRelay: true, forkCore, log: (line) => lines.push(line) });
    try {
      const client = await connectClient(await daemon.connect(agentSock), { clientId: 'laptop' });
      await client.control.request('attachCore', CORE_ATTACH);
      await daemon.daemon.agentProxy.settled();
      const agentFolder = daemon.daemon.agentProxy.folder()!;
      const relayHandle = daemon.relay!.identity().handle;
      const init = posted[0] as CoreInit;
      expect(init.remote?.agentFolder).toBe(agentFolder);
      expect(init.paths.askpass.credentialRelay?.handle).toBe(relayHandle);
      fs.rmSync(agentFolder, { recursive: true });
      fs.rmSync(path.dirname(relayHandle), { recursive: true });
      await vi.waitFor(() => {
        expect(daemon.daemon.agentProxy.folder()).not.toBe(agentFolder);
        expect(daemon.relay!.identity().handle).not.toBe(relayHandle);
        expect(posted).toContainEqual({ kind: 'mirror', topic: 'hostSockets', version: expect.any(Number) as number, patch: { agentFolder: daemon.daemon.agentProxy.folder(), relayHandle: daemon.relay!.identity().handle } });
      }, { timeout: 5000 });
      await daemon.daemon.agentProxy.settled();
      const moved = daemon.daemon.agentProxy.folder()!;
      expect(fs.statSync(moved).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.dirname(daemon.relay!.identity().handle)).mode & 0o777).toBe(0o700);
      expect(fs.lstatSync(agentSocketFile(moved, 'laptop')).isSocket()).toBe(true);
      expect(lines.filter((line) => line.includes('shutting down'))).toEqual([]);
    } finally {
      await daemon.shutdown();
      await new Promise<void>((resolve) => agent.close(() => resolve()));
      fs.rmSync(agents, { recursive: true, force: true });
    }
  }, 20_000);
});
