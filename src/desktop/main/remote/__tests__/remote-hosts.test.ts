import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

import { HostStore } from '../host-store';
import { failureOf, RemoteConnections } from '../connections';
import { permanentFailureOf } from '../reconnect';
import type { ConnectFailure } from '../../../preload/overlay-channels';
import { macPrivacyFolder, RemoteHosts, sshDestination, type RemoteHostsDeps } from '../remote-hosts';
import { parseSshCommand } from '../ssh';
import type { RemoteConnection } from '../connection';
import type { ProjectWorkspace } from '../../../workspace/project-workspace';

let userData: string;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-remote-hosts-'));
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

async function setup(overrides: Partial<RemoteHostsDeps> = {}, connect: () => Promise<void> = () => new Promise(() => undefined)) {
  const store = await HostStore.open(userData, () => undefined);
  const connections = new RemoteConnections({
    host: (id) => store.host(id),
    startSsh: () => new Promise(() => undefined),
    savePlatform: async () => undefined,
    installFolderSettled: async () => undefined,
    connect,
    connection: () => undefined,
    changed: () => undefined,
    log: () => undefined,
  });
  const writeClipboard = vi.fn();
  const renamed = vi.fn();
  const hosts = new RemoteHosts({
    store,
    connections,
    update: () => undefined,
    state: () => 'offline',
    connection: () => undefined,
    workspace: () => undefined,
    terminals: { canOpen: () => false, open: async () => undefined },
    projects: () => [],
    pickRoots: () => [],
    hostName: () => 'prod-1',
    parse: (input) => parseSshCommand(input),
    sshConfigAliases: async () => ['prod-1', 'staging'],
    validInstallFolder: (folder) => folder.startsWith('/') || folder.startsWith('~'),
    addProject: async () => 'key',
    showLogs: async () => undefined,
    writeClipboard,
    overlay: () => undefined,
    renamed,
    reconnect: () => undefined,
    latency: () => undefined,
    watchLimit: () => undefined,
    sharedHome: () => undefined,
    log: () => undefined,
    policyChanged: vi.fn(),
    reconnectFresh: vi.fn(async () => undefined),
    deleteRememberedSecrets: vi.fn(async () => undefined),
    forgetLocalData: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    openSettings: vi.fn(),
    keySetup: { folder: path.join(userData, 'ssh'), clientName: 'laptop', resolveKeygen: async () => undefined, resolveSsh: async () => undefined, run: vi.fn(), sshQuery: vi.fn(), askpass: vi.fn(), sshVersion: vi.fn(), env: {}, log: () => undefined },
    runRemovalStage: vi.fn(async () => ({ code: 0, lines: ['{"kind":"removed"}'] })),
    exitControlMaster: vi.fn(async () => undefined),
    ...overrides,
  });
  return { store, connections, hosts, writeClipboard, renamed };
}

describe('RemoteHosts', () => {
  it('saves an ssh config alias only when the config lists it, and re-parses "+ New host" input in main', async () => {
    const { hosts, store } = await setup();
    await expect(hosts.start({ alias: 'not-in-config', name: 'x' })).rejects.toThrow();
    const saved = await hosts.start({ alias: 'prod-1', name: 'prod-1' });
    expect(saved.ok).toBe(true);
    expect(await hosts.start({ input: 'ssh -o ProxyCommand=evil deploy@10.0.0.9', name: 'billing' })).toMatchObject({ ok: false, reason: 'refused', refused: 'ProxyCommand' });
    expect(await hosts.start({ input: 'deploy@10.0.0.9', name: 'PROD-1' })).toEqual({ ok: false, reason: 'name', check: { ok: false, reason: 'taken', clashWith: 'prod-1' } });
    expect(store.hosts()).toHaveLength(1);
  });

  it('opens the dialog on a config of more than 100 hosts and a 255-character alias, and lists and accepts the same first 1000', async () => {
    const aliases = [...Array.from({ length: 1001 }, (_, index) => `host-${index}`), 'a'.repeat(255)];
    const requests: Array<{ sshConfigAliases: string[] }> = [];
    const logs: string[] = [];
    const overlay = { request: async (request: unknown) => { requests.push(request as (typeof requests)[number]); return { kind: 'dismissed' as const }; }, send: () => undefined, isOpen: () => false };
    const { hosts } = await setup({ overlay: () => overlay, sshConfigAliases: async () => [aliases[1001]!, ...aliases.slice(0, 1001)], log: (line) => logs.push(line) });
    await hosts.openConnect();
    expect(requests[0]!.sshConfigAliases).toEqual([aliases[1001], ...aliases.slice(0, 999)]);
    expect(logs).toContain('[remote] the ssh config names 1002 hosts; the Connect dialog lists the first 1000');
    await expect(hosts.start({ alias: 'host-999', name: 'last' })).rejects.toThrow('The alias is not a Host of the ssh config');
    expect((await hosts.start({ alias: 'host-998', name: 'listed' })).ok).toBe(true);
  });

  it('parses "+ New host" with a prefilled name checked against the saved hosts', async () => {
    const { hosts } = await setup();
    expect(hosts.parse('ssh -p 2222 -J bastion deploy@10.0.0.9')).toMatchObject({ ok: true, destinationLabel: 'deploy@10.0.0.9:2222', prefillName: '10.0.0.9', nameCheck: { ok: true } });
    expect(hosts.parse('ssh -F /tmp/x host')).toMatchObject({ ok: false, refused: '-F' });
  });

  it('gives the shell and the host card each host\'s reconnect phase and latency, read by its authority key', async () => {
    const reconnect = { phase: 'waiting', since: 10, retryAt: 15 } as const;
    const latency = { latencyMs: 620, slow: true, history: [40, 620], measurements: 2 };
    const asked: string[] = [];
    const { hosts, store } = await setup({ reconnect: (key) => (asked.push(key), reconnect), latency: () => latency });
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('setup');
    expect(hosts.shellHosts()[0]).toMatchObject({ reconnect, latency });
    expect(hosts.cards()[0]).toMatchObject({ reconnect, latency });
    expect(asked[0]).toBe(`ssh+${added.host.id}`);
  });

  it('pushes the open dialog only cards and steps rebuilt by the request\'s parser, and nothing past its bounds', async () => {
    const sent: Array<[string, unknown]> = [];
    const logs: string[] = [];
    const overlay = { request: async () => ({ kind: 'dismissed' as const }), send: (channel: string, payload: unknown) => void sent.push([channel, payload]), isOpen: (kind: string) => kind === 'connect' };
    let latency: unknown = { latencyMs: 38, slow: false, history: [38], measurements: 1, extra: 'dropped' };
    const { hosts, store, connections } = await setup({ overlay: () => overlay, latency: () => latency as never, log: (line) => logs.push(line) });
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('setup');
    const step = { attemptId: 'a1', hostId: added.host.id, step: 'connecting', visited: ['connecting'], notices: [], extra: 'dropped' };
    const attempt = vi.spyOn(connections, 'attempt').mockReturnValue(step as never);
    hosts.hostChanged(added.host.id);
    expect(sent.map(([channel]) => channel)).toEqual(['damocles:overlay:connect:step', 'damocles:overlay:connect:hosts']);
    expect(sent[0]![1]).toEqual({ attemptId: 'a1', hostId: added.host.id, step: 'connecting', visited: ['connecting'], notices: [] });
    expect((sent[1]![1] as Array<{ latency: unknown }>)[0]!.latency).toEqual({ latencyMs: 38, slow: false, history: [38], measurements: 1 });
    sent.length = 0;
    // a card or a step the request's bounds refuse is not pushed, and the dialog keeps what it shows
    latency = { latencyMs: 38, slow: false, history: [38], measurements: 0 };
    attempt.mockReturnValue({ ...step, prompt: { promptId: 'p1', kind: 'secret', secretKind: 'bogus', text: 'Password:' } } as never);
    hosts.hostChanged(added.host.id);
    hosts.hostsChanged();
    expect(sent.map(([channel]) => channel)).toEqual(['damocles:overlay:hosts:entries']);
    expect(logs).toEqual([
      `[remote] ${added.host.id}: the attempt's step exceeds the overlay bounds; the Connect dialog keeps the last one`,
      '[remote] the host list exceeds the overlay bounds; the Connect dialog keeps the last one',
      '[remote] the host list exceeds the overlay bounds; the Connect dialog keeps the last one',
    ]);
  });

  it('pushes Settings only saved hosts rebuilt field by field, and nothing past the bounds', async () => {
    const sent: Array<[string, unknown]> = [];
    const logs: string[] = [];
    const overlay = { request: async () => ({ kind: 'dismissed' as const }), send: (channel: string, payload: unknown) => void sent.push([channel, payload]), isOpen: (kind: string) => kind === 'settings' };
    const { hosts, store } = await setup({ overlay: () => overlay, log: (line) => logs.push(line) });
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('setup');
    const [entry] = hosts.entries();
    const entries = vi.spyOn(hosts, 'entries').mockReturnValue([{ ...entry!, extra: 'dropped', settings: { ...entry!.settings, extra: 'dropped' }, facts: { ...entry!.facts, extra: 'dropped' } } as never]);
    hosts.hostsChanged();
    expect(sent).toEqual([['damocles:overlay:hosts:entries', [entry]]]);
    sent.length = 0;
    entries.mockReturnValue([{ ...entry!, authorityKey: 'ssh+another-host' }]);
    hosts.hostsChanged();
    entries.mockReturnValue([{ ...entry!, facts: { ...entry!.facts, alwaysCredentialHosts: ['x'.repeat(10_000)] } }]);
    hosts.hostsChanged();
    expect(sent).toEqual([]);
    expect(logs).toEqual(Array(2).fill('[remote] the saved hosts exceed the overlay bounds; the overlay keeps the last list'));
  });

  it('renames through the store\'s rule and tells the shell with the previous name', async () => {
    const { hosts, store, renamed } = await setup();
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('setup');
    expect(await hosts.rename(added.host.id, 'prod\u202E1')).toEqual({ ok: false, reason: 'bidiChars' });
    expect(renamed).not.toHaveBeenCalled();
    expect(await hosts.rename(added.host.id, 'Production')).toEqual({ ok: true, name: 'Production' });
    expect(renamed).toHaveBeenCalledWith(added.host.id, 'prod-1');
    await expect(hosts.rename('unknown', 'x')).rejects.toThrow();
  });

  it('opens the dialog on a saved host\'s folders or on its card\'s rename, starting no connection, and refuses an unknown host', async () => {
    const requests: unknown[] = [];
    const overlay = { request: async (request: unknown) => { requests.push(request); return { kind: 'dismissed' as const }; }, send: () => undefined, isOpen: () => false };
    const { hosts, store, connections } = await setup({ overlay: () => overlay });
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('setup');
    await hosts.openConnect(added.host.id);
    await hosts.openConnect(added.host.id, 'rename');
    expect(requests).toMatchObject([{ kind: 'connect', hostId: added.host.id }, { kind: 'connect', hostId: added.host.id, card: 'rename' }]);
    expect(requests[0]).not.toHaveProperty('card');
    expect(connections.attempt(added.host.id)).toBeUndefined();
    await expect(hosts.openConnect('unknown')).rejects.toThrow('No saved host');
    expect(requests).toHaveLength(2);
  });

  it('opens the dialog on an attempt that met a changed host key, starting no other, but the card\'s rename without it', async () => {
    const requests: Array<{ attempt?: { attemptId: string; failure?: { code: string } } }> = [];
    const overlay = { request: async (request: unknown) => { requests.push(request as (typeof requests)[number]); return { kind: 'dismissed' as const }; }, send: () => undefined, isOpen: () => false };
    const changed = Object.assign(new Error('changed'), { code: 'hostKeyChanged', params: { host: 'prod-1' } });
    const { hosts, store, connections } = await setup({ overlay: () => overlay }, () => Promise.reject(changed));
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('setup');
    const attemptId = connections.connect(added.host.id, false);
    await vi.waitFor(() => expect(connections.attempt(added.host.id)?.step).toBe('failed'));
    await hosts.openConnect(added.host.id);
    await hosts.openConnect(added.host.id, 'rename');
    expect(requests[0]?.attempt).toMatchObject({ attemptId, failure: { code: 'hostKeyChanged' } });
    expect(requests[1]).not.toHaveProperty('attempt');
    expect(connections.attempt(added.host.id)?.attemptId).toBe(attemptId);
  });

  it('refuses an install folder the stage rule refuses, and copies the host key command only for a changed key', async () => {
    const { hosts, store, writeClipboard } = await setup();
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('setup');
    expect(await hosts.setInstallFolder(added.host.id, 'relative/path')).toEqual({ ok: false, reason: 'invalid' });
    expect(await hosts.setInstallFolder(added.host.id, '/opt/damocles')).toEqual({ ok: true });
    expect(store.host(added.host.id)?.settings.installFolder).toBe('/opt/damocles');
    await expect(hosts.copyHostKeyCommand(added.host.id)).rejects.toThrow();
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  it('browses a connected host from its home, marking folders that are projects and naming macOS privacy folders', async () => {
    const browse = vi.fn(async (folder: string) => (folder.endsWith('Documents')
      ? { ok: false as const, reason: 'failed' as const }
      : { ok: true as const, path: folder, folders: ['srv-app', 'Documents'] }));
    const facts = { os: 'darwin', homedir: '/Users/me' } as RemoteConnection['facts'];
    const { hosts, store } = await setup({
      connection: () => ({ facts } as RemoteConnection),
      workspace: () => ({ files: { browse } } as unknown as ProjectWorkspace),
      projects: () => [{ key: 'ssh+x|/Users/me/srv-app', fsPath: '/Users/me/srv-app', folderKey: '/Users/me/srv-app' }],
    });
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'mac' }, name: 'mac' });
    if (!added.ok) throw new Error('setup');
    expect(await hosts.browse(added.host.id, undefined)).toEqual({
      ok: true, path: '/Users/me', parent: '/Users', home: '/Users/me', separator: '/',
      folders: [{ name: 'Documents' }, { name: 'srv-app', projectKey: 'ssh+x|/Users/me/srv-app' }],
    });
    expect(await hosts.browse(added.host.id, '/Users/me/Documents')).toEqual({ ok: false, error: 'eperm-privacy', folder: '/Users/me/Documents' });
    expect(await hosts.browse(added.host.id, 'relative')).toEqual({ ok: false, error: 'missing' });
    expect(macPrivacyFolder('/Users/me', '/Users/me/Library/Mobile Documents/x')).toBe('/Users/me/Library/Mobile Documents');
    expect(macPrivacyFolder('/Users/me', '/Users/me/Desktopper')).toBeUndefined();
  });

  it('sends a recolor to every place that shows the host, a policy change to its attaches, and reconnects only a forwarding change', async () => {
    const policyChanged = vi.fn();
    const reconnectFresh = vi.fn(async () => undefined);
    const deleteRememberedSecrets = vi.fn(async () => undefined);
    const { hosts, store, renamed } = await setup({ policyChanged, reconnectFresh, deleteRememberedSecrets, connection: () => ({ devices: () => [] }) as unknown as RemoteConnection });
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('setup');
    const id = added.host.id;
    await store.savePlatform(id, { os: 'linux' });
    await hosts.setSetting(id, { key: 'color', value: 'danger' });
    expect(renamed).toHaveBeenCalledWith(id, 'prod-1');
    expect(hosts.cards()[0]?.color).toBe('danger');
    await hosts.setSetting(id, { key: 'allowBypass', value: true });
    await hosts.setSetting(id, { key: 'defaultPermissionMode', value: 'plan' });
    expect(policyChanged.mock.calls).toEqual([[id], [id]]);
    expect(reconnectFresh).not.toHaveBeenCalled();
    await hosts.setSetting(id, { key: 'forwardAgent', value: true });
    expect(reconnectFresh).toHaveBeenCalledWith(id);
    await hosts.setSetting(id, { key: 'rememberPassword', value: true });
    expect(deleteRememberedSecrets).not.toHaveBeenCalled();
    await hosts.setSetting(id, { key: 'rememberPassword', value: false });
    expect(deleteRememberedSecrets).toHaveBeenCalledWith(id);
    expect(hosts.entries()[0]).toMatchObject({ settings: { color: 'danger', allowBypass: true, defaultPermissionMode: 'plan', forwardAgent: true, rememberPassword: false } });
  });

  it('records linger once Allow background work turned it on, so the removal offers to undo it', async () => {
    const connection = { features: ['linger'], control: { request: vi.fn(async () => ({ result: 'enabled' })) } } as unknown as RemoteConnection;
    const { hosts, store } = await setup({ connection: () => connection });
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('setup');
    await store.savePlatform(added.host.id, { os: 'linux' });
    expect(hosts.entries()[0]?.facts.lingerEnabledByDamocles).toBe(false);
    await hosts.allowBackground(added.host.id);
    expect(store.host(added.host.id)?.lingerEnabledByDamocles).toBe(true);
    (connection.control.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ runs: [{ kind: 'chat', id: 'c1', projectKey: '', title: 'Fix it', state: 'running', providers: [] }] });
    expect(await hosts.removalInfo(added.host.id)).toEqual({ runs: [{ kind: 'chat', id: 'c1', title: 'Fix it', state: 'running' }], offerRemoveKey: false, offerDisableLinger: true });
  });

  it('records no linger the daemon found already enabled, so the removal never offers to undo an admin\'s', async () => {
    const connection = { features: ['linger'], control: { request: vi.fn(async () => ({ result: 'alreadyEnabled' })) } } as unknown as RemoteConnection;
    const dropNotice = vi.spyOn(RemoteConnections.prototype, 'dropNotice');
    const { hosts, store } = await setup({ connection: () => connection });
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('setup');
    await store.savePlatform(added.host.id, { os: 'linux' });
    expect(await hosts.allowBackground(added.host.id)).toEqual({ result: 'alreadyEnabled' });
    expect(store.host(added.host.id)?.lingerEnabledByDamocles).toBeUndefined();
    expect(hosts.entries()[0]?.facts.lingerEnabledByDamocles).toBe(false);
    expect(dropNotice).toHaveBeenCalledWith(added.host.id, 'noLinger');
    dropNotice.mockRestore();
  });

  it('removes the key and turns linger off only when checked and recorded, and forgets them once the stage removed them', async () => {
    const runRemovalStage = vi.fn(async (_hostId: string, _script: string) => ({ code: 0, lines: ['{"kind":"removed"}'] }));
    const disconnect = vi.fn();
    let ended: () => void = () => undefined;
    const connection = {
      features: ['control.shutdownForRemoval'],
      control: { request: vi.fn(async () => {
        setTimeout(() => ended(), 0);
        return { runKey: '0123456789abcdef' };
      }) },
      onClose: (listener: () => void) => { ended = listener; return { dispose: () => undefined }; },
      onLost: () => ({ dispose: () => undefined }),
    } as unknown as RemoteConnection;
    const exitControlMaster = vi.fn(async (_hostId: string) => undefined);
    const { hosts, store } = await setup({ connection: () => connection, runRemovalStage, disconnect, exitControlMaster });
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('setup');
    const id = added.host.id;
    await store.savePlatform(id, { os: 'linux' });
    const entry = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'A'.repeat(43)}`;
    await store.recordInstalledKey(id, { fingerprint: `SHA256:${'a'.repeat(43)}`, entry, file: '/home/dev/.ssh/authorized_keys' });
    await store.recordPasswordless(id, path.join(userData, 'ssh', 'id_ed25519'));
    // unchecked: the stage gets no key and no linger, and the record keeps them
    expect(await hosts.removeServer(id, { removeKey: false, disableLinger: true })).toEqual({ ok: true, notices: [] });
    expect(runRemovalStage.mock.calls[0]![1]).toContain("D_KEY=''");
    expect(runRemovalStage.mock.calls[0]![1]).toContain("D_DISABLE_LINGER='0'");
    expect(disconnect).toHaveBeenCalledWith(id);
    // Damocles' master connection ends once the stage ran, the key box checked or not
    expect(exitControlMaster.mock.calls).toEqual([[id]]);
    expect(exitControlMaster.mock.invocationCallOrder[0]).toBeGreaterThan(runRemovalStage.mock.invocationCallOrder[0]!);
    expect(store.host(id)?.installedKeyFingerprint).toBeDefined();
    await hosts.removeServer(id, { removeKey: true, disableLinger: false });
    expect(runRemovalStage.mock.calls[1]![1]).toContain(`D_KEY='${entry}'\nD_KEY_FILE='/home/dev/.ssh/authorized_keys'`);
    expect(store.host(id)?.installedKeyFingerprint).toBeUndefined();
    expect(store.host(id)?.identityFile).toBeUndefined();
  });

  it('runs the same removal stage again on Try again after daemonRunning, with no connection, and forgets the key once it removed it', async () => {
    const stages: string[] = [];
    const answers = [['{"kind":"fail","code":"daemonRunning","params":{}}'], ['{"kind":"fail","code":"daemonRunning","params":{}}'], ['{"kind":"removed"}']];
    const runRemovalStage = vi.fn(async (_hostId: string, script: string) => {
      stages.push(script);
      const lines = answers.shift()!;
      return { code: lines[0]!.includes('removed') ? 0 : 1, lines };
    });
    let ended: () => void = () => undefined;
    const request = vi.fn(async () => {
      setTimeout(() => ended(), 0);
      return { runKey: '0123456789abcdef' };
    });
    let connected = true;
    const connection = {
      features: ['control.shutdownForRemoval'],
      control: { request },
      onClose: (listener: () => void) => { ended = () => { connected = false; listener(); }; return { dispose: () => undefined }; },
      onLost: () => ({ dispose: () => undefined }),
    } as unknown as RemoteConnection;
    const exitControlMaster = vi.fn(async (_hostId: string) => undefined);
    const { hosts, store } = await setup({ connection: () => (connected ? connection : undefined), runRemovalStage, exitControlMaster });
    await expect(hosts.retryRemoval('missing')).rejects.toThrow();
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('setup');
    const id = added.host.id;
    await store.savePlatform(id, { os: 'linux' });
    await expect(hosts.retryRemoval(id)).rejects.toThrow('No removal of this host waits to be tried again');
    await store.recordInstalledKey(id, { fingerprint: `SHA256:${'a'.repeat(43)}`, entry: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'A'.repeat(43)}`, file: '/home/dev/.ssh/authorized_keys' });
    expect(await hosts.removeServer(id, { removeKey: true, disableLinger: false })).toEqual({ ok: false, code: 'daemonRunning', params: {} });
    expect(connected).toBe(false);
    expect(await hosts.retryRemoval(id)).toEqual({ ok: false, code: 'daemonRunning', params: {} });
    expect(store.host(id)?.installedKeyFingerprint).toBeDefined();
    expect(await hosts.retryRemoval(id)).toEqual({ ok: true, notices: [] });
    // one shutdown; each try ran the same script with the run key the daemon answered
    expect(request).toHaveBeenCalledTimes(1);
    expect(new Set(stages).size).toBe(1);
    expect(stages[0]).toContain("D_RUN_KEY='0123456789abcdef'");
    expect(store.host(id)?.installedKeyFingerprint).toBeUndefined();
    // every try ends Damocles' master, a refused one too
    expect(exitControlMaster).toHaveBeenCalledTimes(3);
    await expect(hosts.retryRemoval(id)).rejects.toThrow('No removal of this host waits to be tried again');
  });

  it('tells an install whose connection closed (notConnected) from one the daemon answered with an error (installFailed)', async () => {
    const folder = path.join(userData, 'ssh');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'id_ed25519'), 'private');
    fs.writeFileSync(path.join(folder, 'id_ed25519.pub'), `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'A'.repeat(43)} damocles@laptop\n`);
    const keySetup: RemoteHostsDeps['keySetup'] = {
      folder,
      clientName: 'laptop',
      resolveKeygen: async () => '/usr/bin/ssh-keygen',
      resolveSsh: async () => '/usr/bin/ssh',
      run: async () => ({ exit: { code: 0, signal: null }, stdout: Buffer.from(`256 SHA256:${'b'.repeat(43)} damocles@laptop (ED25519)\n`), stderr: Buffer.alloc(0) }),
      sshQuery: async () => ({ code: 0, stdout: 'preferredauthentications publickey\n', stderr: '' }),
      askpass: vi.fn(),
      sshVersion: vi.fn(),
      env: {},
      log: () => undefined,
    };
    const outcome = async (closes: boolean) => {
      const closeListeners = new Set<(reason: string) => void>();
      const connection = {
        features: ['ssh.installAuthorizedKey'],
        control: { request: vi.fn(async () => {
          if (!closes) throw new Error('EROFS: read-only file system');
          for (const listener of closeListeners) listener('the socket closed');
          throw new Error('the socket closed');
        }) },
        onClose: (listener: (reason: string) => void) => {
          closeListeners.add(listener);
          return { dispose: () => { closeListeners.delete(listener); } };
        },
      } as unknown as RemoteConnection;
      const { hosts, store } = await setup({ connection: () => connection, keySetup });
      const added = await store.addHost({ destination: { kind: 'alias', alias: `prod-${closes ? 'a' : 'b'}` }, name: `prod-${closes ? 'a' : 'b'}` });
      if (!added.ok) throw new Error('setup');
      const result = await hosts.setUpPasswordless(added.host.id);
      expect(closeListeners.size).toBe(0);
      return result;
    };
    expect(await outcome(true)).toEqual({ ok: false, step: 'install', code: 'notConnected', params: {} });
    expect(await outcome(false)).toEqual({ ok: false, step: 'install', code: 'installFailed', params: {} });
  });

  it('lets go of its close listeners when the daemon refuses to shut down, so a later drop is an ordinary one', async () => {
    const disconnect = vi.fn();
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    };
    const connection = {
      features: ['control.shutdownForRemoval'],
      control: { request: vi.fn(async () => { throw new Error('the request timed out'); }) },
      onClose: subscribe,
      onLost: subscribe,
    } as unknown as RemoteConnection;
    const { hosts, store } = await setup({ connection: () => connection, disconnect });
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('setup');
    await store.savePlatform(added.host.id, { os: 'linux' });
    await expect(hosts.removeServer(added.host.id, { removeKey: false, disableLinger: false })).rejects.toThrow('timed out');
    expect(listeners.size).toBe(0);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('forgets a host: disconnects it, deletes its remembered answers and local data, then its record', async () => {
    const order: string[] = [];
    const { hosts, store } = await setup({
      disconnect: () => order.push('disconnect'),
      deleteRememberedSecrets: async () => { order.push('secrets'); },
      forgetLocalData: async () => { order.push('local'); },
    });
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('setup');
    await hosts.forget(added.host.id);
    expect(order).toEqual(['disconnect', 'secrets', 'local']);
    expect(store.hosts()).toEqual([]);
  });

  it('forgets a connecting host: its attempt in flight ends and its connection state goes', async () => {
    const order: string[] = [];
    const { hosts, store, connections } = await setup({
      disconnect: () => order.push('disconnect'),
      deleteRememberedSecrets: async () => { order.push('secrets'); },
    });
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('setup');
    connections.connect(added.host.id, false);
    const forget = vi.spyOn(connections, 'forget').mockImplementation((hostId) => {
      order.push('connections');
      forget.mockRestore();
      connections.forget(hostId);
    });
    await hosts.forget(added.host.id);
    expect(order).toEqual(['disconnect', 'connections', 'secrets']);
    expect(connections.attempt(added.host.id)).toBeUndefined();
  });

  it('refuses a saved part the rules no longer accept before ssh starts, and leaves out only the options Damocles sets', () => {
    const log = vi.fn();
    expect(sshDestination({ kind: 'address', host: 'h', options: [{ name: 'Port', value: '22' }, { name: 'Compression', value: 'yes' }, { name: 'ServerAliveInterval', value: '0' }] }, log))
      .toEqual({ kind: 'address', host: 'h', port: 22, options: [{ name: 'Compression', value: 'yes' }] });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ServerAliveInterval'));
    const refusal = (destination: Parameters<typeof sshDestination>[0]): unknown => {
      try {
        sshDestination(destination, log);
      } catch (err) {
        return failureOf(err);
      }
      return undefined;
    };
    for (const [destination, setting] of [
      [{ kind: 'address', host: 'h', options: [{ name: 'ProxyCommand', value: 'evil' }] }, 'ProxyCommand'],
      [{ kind: 'address', host: 'h', options: [{ name: 'IdentityFile', value: 'key.pem' }] }, 'IdentityFile'],
      [{ kind: 'address', host: 'h', user: 'alice', options: [{ name: 'User', value: 'bob' }] }, 'User'],
      [{ kind: 'address', host: 'h', user: 'a;b', options: [] }, 'User'],
      [{ kind: 'alias', alias: '-oProxyCommand=x' }, 'alias'],
    ] as const) {
      const failure = refusal(destination) as ConnectFailure;
      expect(failure, setting).toEqual({ code: 'destinationRefused', params: { setting } });
      expect(permanentFailureOf(failure)).toBe('destination');
    }
  });

  it('shows the watch limit notice on the card of the host whose watcher ran out on this connection', async () => {
    const notice = { code: 'watchLimit', params: { project: 'app', suggested: 524288 } };
    const asked: string[] = [];
    const { hosts, store } = await setup({ watchLimit: (key) => (asked.push(key), notice) });
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('setup');
    expect(hosts.cards()[0]!.notices).toEqual([notice]);
    expect(asked[0]).toBe(`ssh+${added.host.id}`);
  });

  it('shows the shared home notice on the card of the host whose daemon named other machines on this connection', async () => {
    const notice = { code: 'sharedHome', params: { hosts: 'lab-03' } };
    const { hosts, store } = await setup({ sharedHome: (key) => (key.startsWith('ssh+') ? notice : undefined) });
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('setup');
    expect(hosts.cards()[0]!.notices).toEqual([notice]);
  });

  it('lists a host\'s terminals with whether this window can open each, and opens one through this window\'s terminals', async () => {
    const live = [{ id: 'term-1', pid: 1, cols: 80, rows: 24 }, { id: 'term-2', pid: 2, cols: 80, rows: 24 }];
    const connection = {
      control: { request: vi.fn(async () => ({ runs: [
        { kind: 'terminal', id: 'term-1', projectKey: '/srv/app', title: 'bash', state: 'running', providers: [] },
        { kind: 'terminal', id: 'term-2', projectKey: '/srv/app', title: 'zsh', state: 'running', providers: [] },
        { kind: 'terminal', id: 'term-3', projectKey: '', title: 'sh', state: 'running', providers: [] },
        { kind: 'chat', id: 'p1', projectKey: '/srv/app', title: 'chat', state: 'running', providers: [] },
      ] })) },
      workspace: { request: vi.fn(async () => live) },
    } as unknown as RemoteConnection;
    const opened: Array<[string, string]> = [];
    const { hosts, store } = await setup({
      connection: () => connection,
      projects: () => [{ key: 'ssh+x|/srv/app', fsPath: '/srv/app', folderKey: '/srv/app' }],
      terminals: {
        canOpen: (authorityKey, terminal) => authorityKey.startsWith('ssh+') && terminal.id === 'term-2',
        open: async (authorityKey, id) => { opened.push([authorityKey, id]); },
      },
    });
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('setup');
    expect(await hosts.runs(added.host.id)).toEqual([
      { id: 'term-1', title: 'bash', state: 'running', projectKey: 'ssh+x|/srv/app', canOpen: false },
      { id: 'term-2', title: 'zsh', state: 'running', projectKey: 'ssh+x|/srv/app', canOpen: true },
      // the daemon lists no such terminal any more
      { id: 'term-3', title: 'sh', state: 'running', canOpen: false },
    ]);
    await hosts.openRun(added.host.id, 'term-2');
    expect(opened).toEqual([[`ssh+${added.host.id}`, 'term-2']]);
  });
});
