import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

import { HostStore } from '../host-store';
import { RemoteConnections, type RemoteConnectionsDeps } from '../connections';
import { OVERLAY_CHANNELS, type OverlayAnswer, type OverlayRequest } from '../../../preload/overlay-channels';
import type { WslListResult } from '../wsl/wsl-list';
import { RemoteHosts, type RemoteHostsDeps } from '../remote-hosts';
import { parseSshCommand } from '../ssh';
import type { RemoteConnection } from '../connection';
import type { ContainerSide } from '../containers/container-side';
import { attachKey } from '../containers/container-key';

let userData: string;
beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-remote-hosts-container-'));
});
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

const ID = '28f4e6f33d7eb0c2fa0a1a525fdb39d5ef72c206dbca3f397ed48e8b10aa3a24';
const ID2 = 'aa00bb11cc22dd33ee44ff5566778899aa00bb11cc22dd33ee44ff5566778899';
const ran = (stdout: string) => ({ result: 'ran' as const, code: 0, stdout, stderr: '' });

// The engine on this computer: two running containers, the first with a configured user, and one devcontainer configuration.
function engineSide(): ContainerSide {
  const unused = (): never => {
    throw new Error('not used');
  };
  return {
    via: undefined,
    config: async (folder) => (folder.toLowerCase().startsWith('c:\\work\\app') ? `${folder}\\.devcontainer\\devcontainer.json` : null),
    up: unused,
    prepareData: unused,
    readConfiguration: unused,
    list: async () => ran([
      JSON.stringify({ ID, Names: 'web\u202Eapp', Image: 'node:24', Status: 'Up 1 hour', State: 'running' }),
      JSON.stringify({ ID: ID2, Names: 'web', Image: 'nginx', Status: 'Up 2 hours', State: 'running' }),
    ].join('\n')),
    inspect: async () => ran(JSON.stringify([{ Id: ID2, Name: '/web', State: { Running: true }, Config: { Image: 'nginx', User: 'www', Labels: {} } }])),
    exec: unused,
    copyPackage: unused,
  };
}

async function setup(overrides: Partial<RemoteHostsDeps> = {}, connectionOverrides: (connections: () => RemoteConnections) => Partial<RemoteConnectionsDeps> = () => ({})) {
  const store = await HostStore.open(userData, () => undefined);
  const connected = new Set<string>();
  // a transport that runs until its attempt's signal aborts, as ssh, wsl.exe and the engine's exec do
  const untilAborted = ({ signal }: { readonly signal: AbortSignal }) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  const connections: RemoteConnections = new RemoteConnections({
    host: (id) => store.host(id),
    startSsh: untilAborted,
    startWsl: untilAborted,
    startContainer: untilAborted,
    savePlatform: async () => undefined,
    installFolderSettled: async () => undefined,
    connect: (hostId) => connections.transport(hostId).then(() => undefined),
    connection: () => undefined,
    changed: () => undefined,
    log: () => undefined,
    ...connectionOverrides(() => connections),
  });
  // disconnectAuthority: the connection goes and the attempt in flight ends, settling once it did
  const disconnect = vi.fn(async (hostId: string) => {
    connected.delete(store.authorityOf(hostId)!);
    await connections.cancelHost(hostId);
  });
  const hosts = new RemoteHosts({
    store,
    connections,
    heldMemory: () => undefined,
    update: () => undefined,
    state: () => 'offline',
    connection: (authority) => (connected.has(authority) ? ({ features: [] } as unknown as RemoteConnection) : undefined),
    workspace: () => undefined,
    terminals: { canOpen: () => false, open: async () => undefined },
    projects: () => [],
    pickRoots: () => [],
    hostName: () => 'web',
    parse: (input) => parseSshCommand(input),
    sshConfigAliases: async () => [],
    validInstallFolder: () => true,
    addProject: async () => 'key',
    showLogs: async () => undefined,
    writeClipboard: vi.fn(),
    overlay: () => ({ request: async (_request: OverlayRequest) => ({ kind: 'dismissed' as const }), send: () => undefined, isOpen: () => false }),
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
    disconnect,
    openSettings: vi.fn(),
    keySetup: { folder: path.join(userData, 'ssh'), clientName: 'laptop', resolveKeygen: async () => undefined, resolveSsh: async () => undefined, run: vi.fn(), sshQuery: vi.fn(), askpass: vi.fn(), sshVersion: vi.fn(), env: {}, log: () => undefined },
    runRemovalStage: vi.fn(async () => ({ code: 0, lines: [] })),
    exitControlMaster: vi.fn(async () => undefined),
    listDistros: async () => ({ ok: false, reason: 'notWindows' }),
    setWslVersion: async () => 0,
    containerSide: () => engineSide(),
    // folder keys as Windows makes them: one folder however its drive letter is written
    cliFolderKey: async (_via, target) => target.toLowerCase(),
    containerEngine: () => 'docker',
    pickLocalFolder: async () => undefined,
    containerGate: async () => undefined,
    containerUp: async () => undefined,
    openContainerFolder: async () => '',
    ...overrides,
  });
  return { store, hosts, connected, disconnect, connections };
}

describe('containers in the Connect dialog', () => {
  it('lists the running containers with a name prefill each, refused characters removed and unique, and the configured user', async () => {
    const { hosts, store } = await setup();
    await store.addHost({ destination: { kind: 'alias', alias: 'box' }, name: 'web' });
    const listed = await hosts.listContainers(undefined);
    if (!listed.ok) throw new Error('list');
    // a name holding a bidi override is no container name docker gives, so its row is left out
    expect(listed.containers.map((row) => [row.id, row.name, row.prefillName, row.user])).toEqual([[ID2, 'web', 'web 2', 'www']]);
  });

  it('shows a failed list\'s engine stderr without bidi or control characters', async () => {
    const failing: ContainerSide = { ...engineSide(), list: async () => ({ result: 'ran', code: 1, stdout: '', stderr: 'permission denied\u202E on\u0007 the socket\n' }) };
    const { hosts } = await setup({ containerSide: () => failing });
    expect(await hosts.listContainers(undefined)).toEqual({ ok: false, code: 'listFailed', message: 'permission denied on the socket' });
  });

  it('shows on the card that a devcontainer has no data volume, and stops once one with the volume is recorded', async () => {
    const { hosts, store } = await setup();
    const added = await store.addContainerHost({ key: 'c'.repeat(32), engine: 'docker', origin: 'devcontainer', workspaceFolder: 'C:\\work\\app', configPath: 'C:\\work\\app\\.devcontainer\\devcontainer.json' }, 'app');
    if (!added.ok) throw new Error('add');
    const container = () => hosts.cards().find((entry) => entry.hostId === added.host.id)!.container!;
    expect(container()).not.toHaveProperty('withoutDataVolume');
    await store.recordContainer(added.host.id, { containerId: ID, withoutDataVolume: true });
    expect(container().withoutDataVolume).toBe(true);
    await store.recordContainer(added.host.id, { containerId: ID2 });
    expect(container()).not.toHaveProperty('withoutDataVolume');
  });

  it('turns a connected container\'s agent forwarding on and off through its policy alone, never a reconnect, and shows it on its card', async () => {
    const policyChanged = vi.fn();
    const reconnectFresh = vi.fn(async () => undefined);
    // connected all along
    const { hosts, store } = await setup({ policyChanged, reconnectFresh, connection: () => ({ features: [], devices: () => [] }) as unknown as RemoteConnection });
    const started = await hosts.start({ attach: ID2, user: 'configured', name: 'web' });
    if (!started.ok) throw new Error('start');
    const card = () => hosts.cards().find((entry) => entry.hostId === started.hostId)!;
    expect(card().agentForwarding).toBe(false);
    expect(hosts.entries()[0]?.settings.forwardAgent).toBe(false);
    await hosts.setSetting(started.hostId, { key: 'forwardAgent', value: true });
    expect(card().agentForwarding).toBe(true);
    await hosts.setSetting(started.hostId, { key: 'forwardAgent', value: false });
    expect(policyChanged.mock.calls).toEqual([[started.hostId], [started.hostId]]);
    expect(reconnectFresh).not.toHaveBeenCalled();
    expect(card().agentForwarding).toBe(false);
    // a WSL distro's card names no forwarding, which never reaches it
    const wsl = await store.addWslHost('Ubuntu', 'Ubuntu');
    if (!wsl.ok) throw new Error('add');
    expect(hosts.cards().find((entry) => entry.hostId === wsl.host.id)).not.toHaveProperty('agentForwarding');
  });

  it('records an attach under its name\'s key with the chosen user, and a second attach switches the user, ending a connection as the other one', async () => {
    const { hosts, store, connected, disconnect } = await setup();
    const first = await hosts.start({ attach: ID2, user: 'configured', name: 'web' });
    if (!first.ok) throw new Error('start');
    const record = store.host(first.hostId)!;
    expect(record).toMatchObject({ kind: 'container', key: attachKey(undefined, 'web'), origin: 'attach', containerName: 'web', user: 'configured', engine: 'docker' });
    connected.add(store.authorityOf(first.hostId)!);
    const again = await hosts.start({ attach: ID2, user: 'configured', name: 'ignored' });
    expect(again).toMatchObject({ ok: true, hostId: first.hostId });
    expect(disconnect).not.toHaveBeenCalled();
    const root = await hosts.start({ attach: ID2, user: 'root', name: 'ignored' });
    expect(root).toMatchObject({ ok: true, hostId: first.hostId });
    expect(store.host(first.hostId)).toMatchObject({ user: 'root', name: 'web' });
    expect(disconnect).toHaveBeenCalledWith(first.hostId);
    await expect(hosts.start({ attach: 'ff'.repeat(32), user: 'root', name: 'x' })).rejects.toThrow('no such running container');
  });

  it('keys a devcontainer by its folder keys, so one folder spelled two ways is one record, and refuses a folder without a configuration', async () => {
    const { hosts, store } = await setup();
    const upper = await hosts.devcontainerHost('C:\\work\\app', undefined);
    const lower = await hosts.devcontainerHost('c:\\work\\app', undefined);
    if (!upper.ok || !lower.ok) throw new Error('record');
    expect(lower.host.id).toBe(upper.host.id);
    expect(store.hosts().filter((record) => record.kind === 'container')).toHaveLength(1);
    expect(await hosts.pickContainerFolder()).toBeNull();
    await expect(hosts.devcontainerHost('D:\\other', undefined)).rejects.toThrow('has no devcontainer configuration');
  });
});

describe('Forget host of an SSH host with containers', () => {
  it('forgets each container reached through it the same way, so no record names a host that is gone', async () => {
    const forgetLocalData = vi.fn(async (_hostId: string) => undefined);
    const deleteRememberedSecrets = vi.fn(async (_hostId: string) => undefined);
    const { store, hosts, disconnect } = await setup({ forgetLocalData, deleteRememberedSecrets });
    const ssh = await store.addHost({ destination: { kind: 'alias', alias: 'prod' }, name: 'prod' });
    if (!ssh.ok) throw new Error('add ssh');
    const via = await store.addContainerHost({ key: 'c'.repeat(32), via: ssh.host.id, engine: 'docker', origin: 'attach', containerName: 'web', user: 'configured' }, 'web');
    const local = await store.addContainerHost({ key: 'd'.repeat(32), engine: 'docker', origin: 'attach', containerName: 'db', user: 'configured' }, 'db');
    if (!via.ok || !local.ok) throw new Error('add containers');
    const authority = `container+${'c'.repeat(32)}`;
    await store.addProject(authority, { path: '/srv/web', folderKey: '/srv/web', os: 'linux' }, `${authority}|/srv/web`, () => []);
    await store.grantTrust(authority, '/srv/web');
    await store.setContainerTrustHash(via.host.id, 'ab'.repeat(32));
    await hosts.forget(ssh.host.id);
    expect(forgetLocalData.mock.calls.map(([id]) => id)).toEqual([via.host.id, ssh.host.id]);
    expect(deleteRememberedSecrets.mock.calls.map(([id]) => id)).toEqual([via.host.id, ssh.host.id]);
    expect(disconnect.mock.calls.map(([id]) => id)).toEqual([via.host.id, ssh.host.id]);
    const reread = await HostStore.open(userData, () => undefined);
    // a container on this computer is no dependent of the SSH host
    expect(reread.hosts().map((record) => record.id)).toEqual([local.host.id]);
    expect(reread.isTrusted(authority, '/srv/web')).toBe(false);
    expect(reread.projects()).toEqual([]);
  });
});

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// The overlay page: a request stays open until the test closes it or main withdraws it; shown runs when the test says so.
function overlayPage() {
  const opened: Array<{ readonly request: OverlayRequest; readonly shown: (() => void) | undefined; readonly signal: AbortSignal | undefined; close(): void }> = [];
  const sent: Array<readonly [string, unknown]> = [];
  let open = 0;
  const overlay = {
    request: (request: OverlayRequest, shown?: () => void, signal?: AbortSignal) => new Promise<OverlayAnswer>((resolve) => {
      open += 1;
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        open -= 1;
        resolve({ kind: 'dismissed' });
      };
      signal?.addEventListener('abort', close, { once: true });
      opened.push({ request, shown, signal, close });
    }),
    send: (channel: string, payload: unknown) => void sent.push([channel, payload]),
    isOpen: (kind: 'connect' | 'settings') => kind === 'connect' && open > 0,
  };
  return { overlay: () => overlay, opened, sent };
}

async function addDevcontainer(store: HostStore, key = 'c'.repeat(32)) {
  const added = await store.addContainerHost({ key, engine: 'docker', origin: 'devcontainer', workspaceFolder: 'C:\\work\\app', configPath: 'C:\\work\\app\\.devcontainer\\devcontainer.json' }, `app ${key.slice(0, 1)}`);
  if (!added.ok) throw new Error('add');
  return added.host;
}

// The Authorities.connect each host's attempt waits on, which the test settles.
function heldConnects() {
  const pending = new Map<string, { resolve(): void; reject(err: Error): void }>();
  return {
    deps: (): Partial<RemoteConnectionsDeps> => ({
      connect: (hostId) => new Promise<void>((resolve, reject) => void pending.set(hostId, { resolve, reject })),
      connection: () => 'usable',
    }),
    connect: (hostId: string) => pending.get(hostId)!.resolve(),
    fail: (hostId: string) => pending.get(hostId)!.reject(new Error('the handshake failed')),
  };
}

describe('a saved devcontainer started from the Connect dialog', () => {
  it('opens its folder once the start connected and closes the dialog showing it: the saved card, a picked folder with a record and the banner\'s Retry', async () => {
    const page = overlayPage();
    const openContainerFolder = vi.fn(async (_hostId: string) => 'container+key|/workspaces/app');
    const held = heldConnects();
    const { hosts, store } = await setup({ overlay: page.overlay, openContainerFolder }, held.deps);
    const record = await addDevcontainer(store);
    const dialog = hosts.openConnect(record.id);
    await flush();
    page.opened[0]!.shown?.();
    const started = await hosts.start({ hostId: record.id });
    expect(started).toMatchObject({ ok: true, hostId: record.id });
    await flush();
    expect(openContainerFolder).not.toHaveBeenCalled();
    held.connect(record.id);
    await expect(dialog).resolves.toEqual({ shown: true, opened: 'container+key|/workspaces/app' });
    expect(openContainerFolder.mock.calls).toEqual([[record.id]]);
  });

  it('shows a folder that did not open on the connected attempt with the dialog left open, and a start again opens it', async () => {
    const page = overlayPage();
    const logs: string[] = [];
    const openContainerFolder = vi.fn<(hostId: string) => Promise<string>>().mockRejectedValueOnce(new Error('The container names no workspace folder')).mockResolvedValueOnce('key');
    const { hosts, store, connections } = await setup({ overlay: page.overlay, openContainerFolder, log: (line) => logs.push(line) }, () => ({ connect: async () => undefined, connection: () => 'usable' }));
    const record = await addDevcontainer(store);
    const dialog = hosts.openConnect(record.id);
    await flush();
    page.opened[0]!.shown?.();
    const first = await hosts.start({ hostId: record.id });
    if (!first.ok) throw new Error('start');
    await flush();
    expect(connections.attempt(record.id)).toMatchObject({ attemptId: first.attemptId, step: 'connected', folderFailure: { code: 'containerFolderFailed', params: {} } });
    expect(page.opened[0]!.signal?.aborted).toBe(false);
    expect(logs).toContain(`[remote] ${record.id}: opening the container's folder failed: The container names no workspace folder`);
    // Retry joins the connected attempt and opens the folder again
    const again = await hosts.start({ hostId: record.id });
    expect(again).toMatchObject({ ok: true, attemptId: first.attemptId });
    await expect(dialog).resolves.toEqual({ shown: true, opened: 'key' });
    expect(connections.attempt(record.id)).not.toHaveProperty('folderFailure');
  });

  it('closes only the dialog that shows the container, not one the user moved on to another host in', async () => {
    const page = overlayPage();
    const openContainerFolder = vi.fn(async (_hostId: string) => 'key');
    const held = heldConnects();
    const { hosts, store } = await setup({ overlay: page.overlay, openContainerFolder }, held.deps);
    const record = await addDevcontainer(store);
    const other = await store.addHost({ destination: { kind: 'alias', alias: 'prod' }, name: 'prod' });
    if (!other.ok) throw new Error('add');
    const dialog = hosts.openConnect(record.id);
    await flush();
    page.opened[0]!.shown?.();
    await hosts.start({ hostId: record.id });
    await hosts.start({ hostId: other.host.id });
    held.connect(record.id);
    await flush();
    expect(openContainerFolder.mock.calls).toEqual([[record.id]]);
    expect(page.opened[0]!.signal?.aborted).toBe(false);
    page.opened[0]!.close();
    await expect(dialog).resolves.toEqual({ shown: true });
  });

  it('ends Reopen in Container once its dialog closed: cancelled when that was before it was on screen, else the project its folder opened as', async () => {
    const page = overlayPage();
    const held = heldConnects();
    const { hosts, store, connections } = await setup({ overlay: page.overlay, openContainerFolder: async () => 'key' }, held.deps);
    const record = await addDevcontainer(store);
    // an earlier attempt's failure is no answer for a dialog that never showed
    connections.connect(record.id, false);
    held.fail(record.id);
    await flush();
    expect(connections.failure(record.id)?.code).toBe('handshakeFailed');
    const unshown = hosts.reopenInContainer(record.id);
    await flush();
    page.opened[0]!.close();
    await expect(unshown).resolves.toEqual({ ok: false, code: 'cancelled' });
    const reopened = hosts.reopenInContainer(record.id);
    await flush();
    page.opened[1]!.shown?.();
    await hosts.start({ hostId: record.id });
    held.connect(record.id);
    await expect(reopened).resolves.toEqual({ ok: true, projectKey: 'key' });
  });

  // the dialog cannot tell Reopen in Container from Open Another Folder, whose connected host shows its folder browser
  it('opens a connected record\'s folder on Reopen in Container, the dialog showing its connected attempt meanwhile', async () => {
    const page = overlayPage();
    const openContainerFolder = vi.fn(async (_hostId: string) => 'key');
    const { hosts, store, connections } = await setup({ overlay: page.overlay, openContainerFolder, state: () => 'connected' }, () => ({ connect: async () => undefined, connection: () => 'usable' }));
    const record = await addDevcontainer(store);
    const attemptId = connections.connect(record.id, false);
    await flush();
    const reopened = hosts.reopenInContainer(record.id);
    await flush();
    expect(page.opened[0]!.request).toMatchObject({ kind: 'connect', hostId: record.id, attempt: { attemptId, step: 'connected' } });
    page.opened[0]!.shown?.();
    await expect(reopened).resolves.toEqual({ ok: true, projectKey: 'key' });
    expect(openContainerFolder.mock.calls).toEqual([[record.id]]);
    // Open Another Folder on the same connected host opens its folder browser and nothing else
    const another = hosts.openConnect(record.id);
    await flush();
    expect(page.opened[1]!.request).not.toHaveProperty('attempt');
    page.opened[1]!.close();
    await another;
    expect(openContainerFolder).toHaveBeenCalledTimes(1);
  });
});

describe('the Connect dialog opening', () => {
  it('goes out with the distros and container states last listed, and pushes the fresh ones once both lists and the dialog are on screen', async () => {
    const page = overlayPage();
    let list!: (result: WslListResult) => void;
    const { hosts, store } = await setup({ overlay: page.overlay, listDistros: () => new Promise((resolve) => (list = resolve)) });
    await addDevcontainer(store);
    const dialog = hosts.openConnect();
    await flush();
    expect(page.opened.map((open) => open.request)).toMatchObject([{ kind: 'connect', distros: [], hosts: [{ container: { state: 'unknown' } }] }]);
    list({ ok: true, distros: [{ distro: 'Ubuntu', state: 'stopped', version: 2, isDefault: true }] });
    await flush();
    // the overlay page may not hold the request yet, and drops a push made before
    expect(page.sent).toEqual([]);
    page.opened[0]!.shown?.();
    await flush();
    expect(page.sent.map(([channel]) => channel)).toEqual([OVERLAY_CHANNELS.connectHosts, OVERLAY_CHANNELS.connectDistros]);
    expect(page.sent[0]![1]).toMatchObject([{ container: { state: 'missing' } }]);
    expect(page.sent[1]![1]).toEqual([{ distro: 'Ubuntu', state: 'stopped', version: 2, isDefault: true }]);
    page.opened[0]!.close();
    await dialog;
  });

  it('pushes nothing to a dialog closed before its lists came, and logs a list that failed', async () => {
    const page = overlayPage();
    const logs: string[] = [];
    let list!: (err: Error) => void;
    const { hosts } = await setup({ overlay: page.overlay, log: (line) => logs.push(line), listDistros: () => new Promise((_resolve, reject) => (list = reject)) });
    const dialog = hosts.openConnect();
    await flush();
    page.opened[0]!.shown?.();
    page.opened[0]!.close();
    await expect(dialog).resolves.toEqual({ shown: true });
    list(new Error('wsl.exe did not start'));
    await flush();
    expect(page.sent).toEqual([]);
    expect(logs).toContain('[remote] listing the distros and containers for the Connect dialog failed: wsl.exe did not start');
  });
});

describe('two first uses at once', () => {
  it('give one record to two attaches, two devcontainer opens, and two connects of a distro, whatever case it is named in', async () => {
    const { hosts, store } = await setup({ listDistros: async () => ({ ok: true, distros: [{ distro: 'Ubuntu', state: 'stopped', version: 2, isDefault: true }] }) });
    const attaches = await Promise.all([hosts.start({ attach: ID2, user: 'configured', name: 'web' }), hosts.start({ attach: ID2, user: 'configured', name: 'web' })]);
    expect(attaches.map((started) => started.ok && started.hostId)).toEqual([expect.any(String), attaches[0].ok && attaches[0].hostId]);
    const opens = await Promise.all([hosts.devcontainerHost('C:\\work\\app', undefined), hosts.devcontainerHost('c:\\work\\app', undefined)]);
    expect(opens.map((made) => made.ok && made.host.id)).toEqual([expect.any(String), opens[0].ok && opens[0].host.id]);
    const distros = await Promise.all([hosts.distroHost('Ubuntu'), hosts.distroHost('ubuntu'), hosts.start({ distro: 'Ubuntu', name: 'Ubuntu' })]);
    const distroId = distros[0]?.id;
    expect([distros[1]?.id, distros[2].ok && distros[2].hostId]).toEqual([distroId, distroId]);
    expect(store.hosts().map((record) => record.kind)).toEqual(['container', 'container', 'wsl']);
  });
});

describe('switching the user of an attached container', () => {
  it('starts the new attach only once the attempt as the other user ended, so it never ends cancelled with it', async () => {
    const { hosts, store, connected, connections, disconnect } = await setup();
    const first = await hosts.start({ attach: ID2, user: 'configured', name: 'web' });
    if (!first.ok) throw new Error('start');
    connected.add(store.authorityOf(first.hostId)!);

    const switched = await hosts.start({ attach: ID2, user: 'root', name: 'web' });
    if (!switched.ok) throw new Error('start');
    expect(disconnect).toHaveBeenCalledWith(first.hostId);
    expect(switched.attemptId).not.toBe(first.attemptId);
    await flush();
    expect(connections.attempt(first.hostId)).toMatchObject({ attemptId: switched.attemptId, step: 'connecting' });
  });
});
