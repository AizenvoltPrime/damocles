import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

import { HostStore } from '../host-store';
import { RemoteConnections } from '../connections';
import { OVERLAY_CHANNELS, type HostOperations, type OverlayRequest, type WslDistroInfo } from '../../../preload/overlay-channels';
import { RemoteHosts, type RemoteHostsDeps } from '../remote-hosts';
import { parseSshCommand } from '../ssh';
import type { RemoteConnection } from '../connection';
import type { WslListResult } from '../wsl/wsl-list';

let userData: string;
beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-remote-hosts-wsl-'));
});
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

const UBUNTU: WslDistroInfo = { distro: 'Ubuntu-24.04', state: 'running', version: 2, isDefault: false };
const OLD: WslDistroInfo = { distro: 'damocles-e2e-wsl1', state: 'stopped', version: 1, isDefault: false };

async function setup(overrides: Partial<RemoteHostsDeps> = {}, connect: () => Promise<void> = async () => undefined) {
  const store = await HostStore.open(userData, () => undefined);
  let listed: WslListResult = { ok: true, distros: [UBUNTU, OLD] };
  const order: string[] = [];
  const started: string[] = [];
  const connections = new RemoteConnections({
    host: (id) => store.host(id),
    startSsh: () => new Promise(() => undefined),
    startWsl: () => new Promise(() => undefined),
    startContainer: () => new Promise(() => undefined),
    savePlatform: async () => undefined,
    installFolderSettled: async () => undefined,
    connect: async () => {
      started.push('connect');
      order.push('reconnect');
      await connect();
    },
    connection: () => undefined,
    changed: () => undefined,
    log: () => undefined,
  });
  const sent: Array<[string, unknown]> = [];
  const open = new Set<string>(['connect']);
  const hosts = new RemoteHosts({
    store,
    connections,
    heldMemory: () => undefined,
    update: () => undefined,
    state: () => 'connected',
    connection: () => undefined,
    workspace: () => undefined,
    terminals: { canOpen: () => false, open: async () => undefined },
    projects: () => [],
    pickRoots: () => [],
    hostName: () => 'Ubuntu-24.04',
    parse: (input) => parseSshCommand(input),
    sshConfigAliases: async () => [],
    validInstallFolder: () => true,
    addProject: async () => 'key',
    showLogs: async () => undefined,
    writeClipboard: vi.fn(),
    overlay: () => ({ request: async (_request: OverlayRequest) => ({ kind: 'dismissed' as const }), send: (channel, payload) => void sent.push([channel, payload]), isOpen: (kind) => open.has(kind) }),
    renamed: vi.fn(),
    reconnect: () => undefined,
    latency: () => undefined,
    watchLimit: () => undefined,
    sharedHome: () => undefined,
    log: () => undefined,
    policyChanged: vi.fn(),
    reconnectFresh: vi.fn(async () => undefined),
    deleteRememberedSecrets: vi.fn(async () => undefined),
    forgetLocalData: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => void order.push('disconnect')),
    openSettings: vi.fn(),
    keySetup: { folder: path.join(userData, 'ssh'), clientName: 'laptop', resolveKeygen: async () => undefined, resolveSsh: async () => undefined, run: vi.fn(), sshQuery: vi.fn(), askpass: vi.fn(), sshVersion: vi.fn(), env: {}, log: () => undefined },
    runRemovalStage: vi.fn(async () => ({ code: 0, lines: [] })),
    exitControlMaster: vi.fn(async () => undefined),
    listDistros: async () => listed,
    setWslVersion: async (_distro, line) => {
      order.push('convert');
      line('The operation completed successfully.');
      return 0;
    },
    containerSide: () => {
      throw new Error('no containers in this test');
    },
    cliFolderKey: async (_via, target) => target,
    containerEngine: () => 'docker',
    pickLocalFolder: async () => undefined,
    containerGate: async () => undefined,
    containerUp: async () => undefined,
    openContainerFolder: async () => '',
    ...overrides,
  });
  return { store, hosts, connections, sent, order, started, setList: (next: WslListResult) => { listed = next; } };
}

describe('WSL distros as hosts', () => {
  it('records a distro on its first connect under the name the user gave, keyed wsl+<distro>, and lists it with its host id', async () => {
    const { hosts, store, started } = await setup();
    await hosts.refreshDistros();
    expect(hosts.distroInfos()).toEqual([UBUNTU, OLD]);
    const result = await hosts.start({ distro: 'Ubuntu-24.04', name: 'Ubuntu-24.04' });
    if (!result.ok) throw new Error('start');
    expect(store.authorityOf(result.hostId)).toBe('wsl+Ubuntu-24.04');
    expect(store.hostIdOf('wsl+Ubuntu-24.04')).toBe(result.hostId);
    expect(hosts.distroInfos()[0]).toEqual({ ...UBUNTU, hostId: result.hostId });
    expect(hosts.cards()[0]).toMatchObject({ hostId: result.hostId, kind: 'wsl', destinationLabel: 'Ubuntu-24.04', wsl: { distro: 'Ubuntu-24.04', version: 2, state: 'running', isDefault: false }, passwordless: false });
    expect(hosts.entries()[0]).toMatchObject({ kind: 'wsl', authorityKey: 'wsl+Ubuntu-24.04', destinationLabel: 'Ubuntu-24.04' });
    expect(started).toEqual(['connect']);
    // the same distro again connects its record; the name is checked like any host's
    const again = await hosts.start({ distro: 'Ubuntu-24.04', name: 'other' });
    expect(again).toMatchObject({ ok: true, hostId: result.hostId });
    expect(await hosts.start({ distro: 'damocles-e2e-wsl1', name: 'ubuntu-24.04' })).toEqual({ ok: false, reason: 'name', check: { ok: false, reason: 'taken', clashWith: 'Ubuntu-24.04' } });
  });

  it('refuses a distro wsl.exe does not list, and a WSL host an ssh-only action', async () => {
    const { hosts } = await setup();
    await expect(hosts.start({ distro: 'Debian', name: 'Debian' })).rejects.toThrow('lists no such distro');
    const result = await hosts.start({ distro: 'Ubuntu-24.04', name: 'Ubuntu-24.04' });
    if (!result.ok) throw new Error('start');
    expect(await hosts.setUpPasswordless(result.hostId)).toMatchObject({ ok: false, code: 'unsupported' });
    expect(await hosts.removeServer(result.hostId, { removeKey: false, disableLinger: false })).toEqual({ ok: false, code: 'unsupported', params: {} });
  });

  it('pushes the distros with the host cards to an open Connect dialog', async () => {
    const { hosts, sent } = await setup();
    await hosts.refreshDistros();
    hosts.hostsChanged();
    expect(sent.map(([channel]) => channel)).toEqual([OVERLAY_CHANNELS.connectHosts, OVERLAY_CHANNELS.connectDistros, OVERLAY_CHANNELS.hostsEntries]);
    expect(sent[1]![1]).toEqual([UBUNTU, OLD]);
  });

  it('shares the loopback of this computer only with a distro the list shows on WSL 1', async () => {
    const { hosts, store } = await setup();
    await store.addWslHost('damocles-e2e-wsl1', 'old');
    await store.addWslHost('Ubuntu-24.04', 'Ubuntu-24.04');
    await hosts.refreshDistros();
    expect(hosts.sharesClientLoopback('wsl+damocles-e2e-wsl1')).toBe(true);
    expect(hosts.sharesClientLoopback('wsl+Ubuntu-24.04')).toBe(false);
    expect(hosts.sharesClientLoopback('loopback')).toBe(false);
  });

  it('finds a distro for Reopen in WSL regardless of case, as Windows resolves a \\\\wsl.localhost path, under the list\'s spelling', async () => {
    const { hosts, store } = await setup();
    const typed = await hosts.distroHost('ubuntu-24.04');
    expect(typed).toMatchObject({ kind: 'wsl', distro: 'Ubuntu-24.04' });
    expect(store.authorityOf(typed!.id)).toBe('wsl+Ubuntu-24.04');
    expect((await hosts.distroHost('UBUNTU-24.04'))?.id).toBe(typed!.id);
    expect(await hosts.distroHost('Debian')).toBeUndefined();
  });

  it('says whether wsl.exe lists a distro now, telling a failed list apart from a distro that is gone', async () => {
    const { hosts } = await setup();
    expect(await hosts.distroListing('Ubuntu-24.04')).toBe('listed');
    expect(await hosts.distroListing('Debian')).toBe('notListed');
    const failing = await setup({ listDistros: async () => ({ ok: false, reason: 'wsl.exe --list did not answer in time' }) });
    expect(await failing.hosts.distroListing('Ubuntu-24.04')).toBe('listFailed');
  });

  it('logs a failed list and shows no distros', async () => {
    const logs: string[] = [];
    const { hosts } = await setup({ listDistros: async () => ({ ok: false, reason: 'wsl.exe did not start: ENOENT' }), log: (line) => logs.push(line) });
    expect(await hosts.refreshDistros()).toEqual([]);
    expect(logs).toEqual(['[remote] listing the WSL distros failed: wsl.exe did not start: ENOENT']);
  });
});

describe('Convert to WSL 2 as a host operation', () => {
  it('lists the running work, then shuts the daemon down, converts and reconnects; a second call joins the run', async () => {
    const control = vi.fn(async (command: string) => (command === 'listRuns' ? { runs: [{ kind: 'terminal', id: 't1', projectKey: '', title: 'bash', state: 'running', providers: [] }] } : {}));
    const handlers: Array<() => void> = [];
    const holder: { connection?: RemoteConnection } = {};
    const made = await setup({ connection: () => holder.connection });
    const { hosts, store, order, sent } = made;
    holder.connection = {
      features: [],
      devices: () => [],
      control: { request: vi.fn(async (command: string) => {
        const answer = await control(command);
        if (command === 'shutdownNow') {
          order.push('shut down');
          queueMicrotask(() => handlers.forEach((handler) => handler()));
        }
        return answer;
      }) },
      onClose: (handler: () => void) => { handlers.push(handler); return { dispose: () => undefined }; },
      onLost: () => ({ dispose: () => undefined }),
    } as unknown as RemoteConnection;
    const added = await store.addWslHost('damocles-e2e-wsl1', 'old');
    if (!added.ok) throw new Error('setup');
    const id = added.host.id;
    expect(await hosts.conversionInfo(id)).toEqual({ runs: [{ kind: 'terminal', id: 't1', title: 'bash', state: 'running' }] });
    const first = hosts.convertToWsl2(id);
    const second = hosts.convertToWsl2(id);
    await Promise.all([first, second]);
    expect(order).toEqual(['shut down', 'disconnect', 'convert', 'reconnect']);
    const snapshots = sent.filter(([channel]) => channel === OVERLAY_CHANNELS.hostsOperationsChanged).map(([, payload]) => payload as HostOperations);
    expect(snapshots.at(-1)?.conversion).toEqual({ steps: { stopping: 'done', converting: 'done', reconnecting: 'done' }, output: ['The operation completed successfully.'], result: { ok: true } });
    expect(hosts.operations(id).conversion?.result).toEqual({ ok: true });
  });

  it('refuses a distro the list shows on WSL 2, and an SSH host', async () => {
    const { hosts, store } = await setup();
    const added = await store.addWslHost('Ubuntu-24.04', 'Ubuntu-24.04');
    if (!added.ok) throw new Error('setup');
    await expect(hosts.convertToWsl2(added.host.id)).rejects.toThrow('is not a WSL 1 distro');
    const ssh = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!ssh.ok) throw new Error('setup');
    await expect(hosts.conversionInfo(ssh.host.id)).rejects.toThrow('is no WSL distro');
  });
});
