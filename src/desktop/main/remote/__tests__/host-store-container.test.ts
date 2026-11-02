import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canForwardAgent, forwardsAgent, HOST_STORE_FILE, HostStore, offersAgentForwarding, type NewContainerHost } from '../host-store';
import { devcontainerKey } from '../containers/container-key';

const OLD = 'aa'.repeat(32);
const NEW = 'bb'.repeat(32);
const HASH = 'cd'.repeat(32);

let userData: string;
beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-hosts-container-'));
});
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

const KEY = devcontainerKey(undefined, 'c:\\work\\app', 'c:\\work\\app\\.devcontainer\\devcontainer.json');
const devcontainer: NewContainerHost = { key: KEY, engine: 'docker', origin: 'devcontainer', workspaceFolder: 'C:\\work\\app', configPath: 'C:\\work\\app\\.devcontainer\\devcontainer.json' };

describe('a container in the host store', () => {
  it('gets a random host id on its first connect, its projects under container+<key>, and keeps its key while a rebuild replaces the container id', async () => {
    const store = await HostStore.open(userData, () => undefined);
    const added = await store.addContainerHost(devcontainer, 'app');
    if (!added.ok) throw new Error('add');
    expect(added.host).toMatchObject({ kind: 'container', key: KEY, origin: 'devcontainer', name: 'app' });
    expect(added.host.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    const authority = `container+${KEY}`;
    expect(store.authorityOf(added.host.id)).toBe(authority);
    expect(store.hostIdOf(authority)).toBe(added.host.id);
    expect(store.hostIdOf(`container+${'0'.repeat(32)}`)).toBeUndefined();
    await store.recordContainer(added.host.id, { containerId: OLD, image: 'vsc-app', remoteUser: 'node', remoteWorkspaceFolder: '/workspaces/app' });
    await store.setContainerTrustHash(added.host.id, HASH);
    await store.addProject(authority, { path: '/workspaces/app', folderKey: '/workspaces/app', os: 'linux' }, `${authority}|/workspaces/app`, () => []);
    await store.grantTrust(authority, '/workspaces/app');
    // a rebuild: a new container under the same key, the trust, the project and the confirmed hash untouched
    await store.recordContainer(added.host.id, { containerId: NEW, remoteUser: 'node', remoteWorkspaceFolder: '/workspaces/app' });
    const reread = await HostStore.open(userData, () => undefined);
    expect(reread.containerHost(KEY)).toMatchObject({ id: added.host.id, containerId: NEW, image: 'vsc-app', trustHash: HASH });
    expect(reread.authorityOf(added.host.id)).toBe(authority);
    expect(reread.isTrusted(authority, '/workspaces/app')).toBe(true);
    expect(reread.projects().map(({ authorityKey }) => authorityKey)).toEqual([authority]);
  });

  // two first connects at once (a double-clicked Reopen in Container, a click beside the damocles command) each look the key up first
  it('gives a key recorded meanwhile its existing record and writes no second one', async () => {
    const store = await HostStore.open(userData, () => undefined);
    const [first, second] = await Promise.all([store.addContainerHost(devcontainer, 'app'), store.addContainerHost(devcontainer, 'again')]);
    if (!first.ok || !second.ok) throw new Error('add');
    expect(second.host).toEqual(first.host);
    expect(store.hosts()).toEqual([first.host]);
  });

  it('checks the SSH host a container runs on inside the write, so a Forget host landing first leaves no record naming it', async () => {
    const store = await HostStore.open(userData, () => undefined);
    const via = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!via.ok) throw new Error('add');
    const forgot = store.forgetHost(via.host.id);
    await expect(store.addContainerHost({ ...devcontainer, key: '3'.repeat(32), via: via.host.id, workspaceFolder: '/srv/app', configPath: '/srv/app/.devcontainer.json' }, 'app')).rejects.toThrow(`The SSH host ${via.host.id} is not saved`);
    await forgot;
    expect(store.hosts()).toEqual([]);
  });

  it('drops a container record whose SSH host the file no longer holds, and names one read without a name after its folder', async () => {
    const logs: string[] = [];
    fs.writeFileSync(path.join(userData, HOST_STORE_FILE), JSON.stringify({
      version: 1,
      authorities: {},
      hosts: {
        orphan: { kind: 'container', key: '8'.repeat(32), via: 'goneHost', engine: 'docker', origin: 'attach', containerName: 'db', user: 'root', name: 'db', recentFolders: [], settings: {} },
        onWsl: { kind: 'container', key: '9'.repeat(32), via: 'distro', engine: 'docker', origin: 'attach', containerName: 'web', user: 'root', name: 'web', recentFolders: [], settings: {} },
        distro: { kind: 'wsl', distro: 'Ubuntu', name: 'Ubuntu', recentFolders: [], settings: {} },
        prod: { kind: 'ssh', destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1', recentFolders: [], settings: {} },
        unnamed: { kind: 'container', key: 'a'.repeat(32), via: 'prod', engine: 'docker', origin: 'devcontainer', workspaceFolder: '/srv/my-app', configPath: '/srv/my-app/.devcontainer/devcontainer.json', recentFolders: [], settings: {} },
      },
    }));
    const reread = await HostStore.open(userData, (line) => logs.push(line));
    expect(reread.hosts().map((record) => record.id)).toEqual(['distro', 'prod', 'unnamed']);
    expect(logs).toContain('[hosts] dropping the container record orphan: its SSH host goneHost is not saved');
    expect(logs).toContain('[hosts] dropping the container record onWsl: its SSH host distro is not saved');
    expect(reread.host('unnamed')?.name).toBe('my-app');
  });

  it('keeps that the current container has no data volume and which container was told, until an up gives one with the volume', async () => {
    const store = await HostStore.open(userData, () => undefined);
    const added = await store.addContainerHost(devcontainer, 'app');
    if (!added.ok) throw new Error('add');
    await store.recordContainer(added.host.id, { containerId: OLD, remoteUser: 'node', remoteWorkspaceFolder: '/workspaces/app', withoutDataVolume: true, dataNoticeShown: OLD });
    expect((await HostStore.open(userData, () => undefined)).host(added.host.id)).toMatchObject({ containerId: OLD, withoutDataVolume: true, dataNoticeShown: OLD });
    // a Damocles Rebuild gives a container with the volume
    await store.recordContainer(added.host.id, { containerId: NEW, remoteUser: 'node', remoteWorkspaceFolder: '/workspaces/app' });
    const reread = (await HostStore.open(userData, () => undefined)).host(added.host.id);
    expect(reread).toMatchObject({ containerId: NEW, dataNoticeShown: OLD });
    expect(reread).not.toHaveProperty('withoutDataVolume');
    await expect(store.recordContainer(added.host.id, { dataNoticeShown: '--x' })).rejects.toThrow('Not a container id');
    const attached = await store.addContainerHost({ key: '1'.repeat(32), engine: 'docker', origin: 'attach', containerName: 'web', user: 'root' }, 'web');
    if (!attached.ok) throw new Error('add');
    await expect(store.recordContainer(attached.host.id, { containerId: NEW, withoutDataVolume: true })).rejects.toThrow('no devcontainer');
  });

  it('forwards this computer\'s SSH agent only once its own switch is on, which is off by default, and offers the switch until then', async () => {
    const store = await HostStore.open(userData, () => undefined);
    const added = await store.addContainerHost(devcontainer, 'app');
    const wsl = await store.addWslHost('Ubuntu', 'Ubuntu');
    const ssh = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok || !wsl.ok || !ssh.ok) throw new Error('add');
    const record = (id: string) => store.host(id)!;
    expect(record(added.host.id).settings.forwardAgent).toBeUndefined();
    expect(canForwardAgent(record(added.host.id))).toBe(true);
    expect(forwardsAgent(record(added.host.id))).toBe(false);
    expect(offersAgentForwarding(record(added.host.id))).toBe(true);
    await store.setHostSetting(added.host.id, { key: 'forwardAgent', value: true });
    const reread = await HostStore.open(userData, () => undefined);
    expect(forwardsAgent(reread.host(added.host.id)!)).toBe(true);
    expect(offersAgentForwarding(reread.host(added.host.id)!)).toBe(false);
    // a WSL distro never gets the agent, so it is never offered; an SSH host only once it is known to be POSIX
    await store.setHostSetting(wsl.host.id, { key: 'forwardAgent', value: true });
    expect(forwardsAgent(record(wsl.host.id))).toBe(false);
    expect(offersAgentForwarding(record(wsl.host.id))).toBe(false);
    expect(offersAgentForwarding(record(ssh.host.id))).toBe(false);
    await store.savePlatform(ssh.host.id, { os: 'linux' });
    expect(offersAgentForwarding(record(ssh.host.id))).toBe(true);
    await store.savePlatform(ssh.host.id, { os: 'win32', windowsShell: 'cmd' });
    expect(canForwardAgent(record(ssh.host.id))).toBe(false);
  });

  it('refuses what could reach a command line as something else', async () => {
    const store = await HostStore.open(userData, () => undefined);
    const added = await store.addContainerHost(devcontainer, 'app');
    if (!added.ok) throw new Error('add');
    await expect(store.recordContainer(added.host.id, { containerId: '--privileged' })).rejects.toThrow('Not a container id');
    await expect(store.recordContainer(added.host.id, { remoteUser: '-u0' })).rejects.toThrow('Not a container id');
    await expect(store.recordContainer(added.host.id, { remoteWorkspaceFolder: '/w/../etc' })).rejects.toThrow('Not a container id');
    await expect(store.setContainerTrustHash(added.host.id, 'abc')).rejects.toThrow('Not a SHA-256');
    await expect(store.addContainerHost({ ...devcontainer, key: 'x' }, 'x')).rejects.toThrow('Not a container key');
    await expect(store.addContainerHost({ ...devcontainer, key: '1'.repeat(32), workspaceFolder: 'relative' }, 'x')).rejects.toThrow('Not a devcontainer or attach record');
    await expect(store.addContainerHost({ key: '2'.repeat(32), engine: 'docker', origin: 'attach', containerName: '-name', user: 'root' }, 'x')).rejects.toThrow('Not a devcontainer or attach record');
    await expect(store.addContainerHost({ ...devcontainer, key: '3'.repeat(32), via: 'nosuchhost' }, 'x')).rejects.toThrow('The SSH host nosuchhost is not saved');
  });

  it('keeps an attached container\'s user as the latest attach chose it, and only for an attached one', async () => {
    const store = await HostStore.open(userData, () => undefined);
    const attached = await store.addContainerHost({ key: '4'.repeat(32), engine: 'podman', origin: 'attach', containerName: 'web', user: 'configured' }, 'web');
    const built = await store.addContainerHost(devcontainer, 'app');
    if (!attached.ok || !built.ok) throw new Error('add');
    await store.setContainerUser(attached.host.id, 'root');
    expect((await HostStore.open(userData, () => undefined)).host(attached.host.id)).toMatchObject({ user: 'root', engine: 'podman', containerName: 'web' });
    await expect(store.setContainerUser(built.host.id, 'root')).rejects.toThrow('no attached container');
  });

  it('names a container like any host, and drops a hand-edited record whose key another holds or whose fields fail', async () => {
    const store = await HostStore.open(userData, () => undefined);
    await store.addHost({ destination: { kind: 'alias', alias: 'web' }, name: 'box' });
    expect(await store.addContainerHost({ key: '5'.repeat(32), engine: 'docker', origin: 'attach', containerName: 'web', user: 'root' }, 'web')).toEqual({ ok: false, check: { ok: false, reason: 'taken', clashWith: 'web' } });
    const logs: string[] = [];
    fs.writeFileSync(path.join(userData, HOST_STORE_FILE), JSON.stringify({
      version: 1,
      authorities: {},
      hosts: {
        first: { kind: 'container', key: KEY, engine: 'docker', origin: 'devcontainer', workspaceFolder: '/srv/app', configPath: '/srv/app/.devcontainer.json', name: 'app', recentFolders: [], settings: {} },
        second: { kind: 'container', key: KEY, engine: 'docker', origin: 'devcontainer', workspaceFolder: '/srv/app', configPath: '/srv/app/.devcontainer.json', name: 'other', recentFolders: [], settings: {} },
        third: { kind: 'container', key: '6'.repeat(32), engine: 'lxc', origin: 'attach', containerName: 'x', user: 'root', name: 'x', recentFolders: [], settings: {} },
        fourth: { kind: 'container', key: '7'.repeat(32), engine: 'docker', origin: 'attach', containerName: 'db', user: 'root', containerId: 'nothex', name: 'db', recentFolders: [], settings: {} },
      },
    }));
    const reread = await HostStore.open(userData, (line) => logs.push(line));
    expect(reread.hosts().map((record) => record.id)).toEqual(['first', 'fourth']);
    // a container id that fails its check is dropped, never kept for an exec
    expect(reread.host('fourth')).not.toHaveProperty('containerId');
    expect(logs).toContain(`[hosts] dropping the host record second: another record holds the container key ${KEY}`);
  });
});
