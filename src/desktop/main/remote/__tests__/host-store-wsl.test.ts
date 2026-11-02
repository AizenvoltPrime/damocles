import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_STORE_FILE, HostStore } from '../host-store';
import { RemoteConnections, type WslStartRequest } from '../connections';

let userData: string;
beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-hosts-wsl-'));
});
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('a WSL distro in the host store', () => {
  it('gets a random host id on its first connect, its projects under wsl+<distro>, and reads back as a distro', async () => {
    const store = await HostStore.open(userData, () => undefined);
    const added = await store.addWslHost('Ubuntu-24.04', 'Ubuntu-24.04');
    if (!added.ok) throw new Error('add');
    expect(added.host).toMatchObject({ kind: 'wsl', distro: 'Ubuntu-24.04', name: 'Ubuntu-24.04' });
    expect(added.host.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(store.authorityOf(added.host.id)).toBe('wsl+Ubuntu-24.04');
    expect(store.hostIdOf('wsl+Ubuntu-24.04')).toBe(added.host.id);
    expect(store.hostIdOf('wsl+Debian')).toBeUndefined();
    expect(store.sshHost(added.host.id)).toBeUndefined();
    await store.addProject('wsl+Ubuntu-24.04', { path: '/home/me/app', folderKey: '/home/me/app', os: 'linux' }, 'wsl+Ubuntu-24.04|/home/me/app', () => []);
    await store.grantTrust('wsl+Ubuntu-24.04', '/home/me/app');
    const reread = await HostStore.open(userData, () => undefined);
    expect(reread.wslHost('Ubuntu-24.04')?.id).toBe(added.host.id);
    expect(reread.isTrusted('wsl+Ubuntu-24.04', '/home/me/app')).toBe(true);
    await expect(store.addWslHost('-d', 'x')).rejects.toThrow('Not a WSL distro name');
    await store.forgetHost(added.host.id);
    expect(store.projects()).toEqual([]);
    expect(store.isTrusted('wsl+Ubuntu-24.04', '/home/me/app')).toBe(false);
  });

  // two first connects at once (a double-clicked Reopen in WSL, a click beside the damocles command) each look the record up first
  it('gives a distro recorded meanwhile, in any case, its existing record and writes no second one', async () => {
    const store = await HostStore.open(userData, () => undefined);
    const [first, second] = await Promise.all([store.addWslHost('Ubuntu-24.04', 'Ubuntu-24.04'), store.addWslHost('ubuntu-24.04', 'other name')]);
    if (!first.ok || !second.ok) throw new Error('add');
    expect(second.host).toEqual(first.host);
    expect(store.hosts()).toEqual([first.host]);
    expect((await HostStore.open(userData, () => undefined)).hosts().map((record) => record.id)).toEqual([first.host.id]);
  });

  it('checks a distro\'s name like any host\'s, and makes a prefill unique', async () => {
    const store = await HostStore.open(userData, () => undefined);
    await store.addHost({ destination: { kind: 'alias', alias: 'Ubuntu' }, name: 'box' });
    expect(await store.addWslHost('Ubuntu', 'Ubuntu')).toEqual({ ok: false, check: { ok: false, reason: 'taken', clashWith: 'Ubuntu' } });
    expect(store.uniqueName('Ubuntu')).toBe('Ubuntu 2');
  });

  it('drops a hand-edited record naming a distro another record holds, or no valid distro', async () => {
    const logs: string[] = [];
    fs.writeFileSync(path.join(userData, HOST_STORE_FILE), JSON.stringify({
      version: 1,
      authorities: {},
      hosts: {
        first: { kind: 'wsl', distro: 'Alpine', name: 'Alpine', recentFolders: [], settings: {} },
        second: { kind: 'wsl', distro: 'Alpine', name: 'Other', recentFolders: [], settings: {} },
        third: { kind: 'wsl', distro: 'bad name', name: 'Bad', recentFolders: [], settings: {} },
        fourth: { kind: 'wsl', distro: 'Debian', recentFolders: [], settings: {} },
      },
    }));
    const store = await HostStore.open(userData, (line) => logs.push(line));
    expect(store.hosts().map((record) => [record.id, record.name])).toEqual([['first', 'Alpine'], ['fourth', 'Debian']]);
    expect(logs).toContain('[hosts] dropping the host record second: another record holds the distro Alpine');
  });

  it('remembers a dismissed Reopen in WSL notice per project, and forgets it with the project', async () => {
    const store = await HostStore.open(userData, () => undefined);
    await store.dismissWslNotice('C:\\proj');
    expect((await HostStore.open(userData, () => undefined)).isWslNoticeDismissed('C:\\proj')).toBe(true);
    await store.removeFromOrder('C:\\proj');
    expect(store.isWslNoticeDismissed('C:\\proj')).toBe(false);
  });
});

describe('a WSL distro\'s connection attempt', () => {
  it('starts wsl.exe through startWsl, reports transport wsl and never asks', async () => {
    const store = await HostStore.open(userData, () => undefined);
    const added = await store.addWslHost('Ubuntu-24.04', 'Ubuntu-24.04');
    if (!added.ok) throw new Error('add');
    const requests: WslStartRequest[] = [];
    const startSsh = vi.fn();
    const connections: RemoteConnections = new RemoteConnections({
      host: (id) => store.host(id),
      startSsh,
      startWsl: async (request) => {
        requests.push(request);
        request.hooks.step('checking');
        return { stream: new PassThrough(), stderrTail: () => '', dispose: () => undefined };
      },
      startContainer: () => Promise.reject(new Error('no containers in this test')),
      savePlatform: async () => undefined,
      installFolderSettled: async () => undefined,
      connect: async (hostId) => {
        await connections.transport(hostId);
      },
      connection: () => undefined,
      changed: () => undefined,
      log: () => undefined,
    });
    const attemptId = connections.connect(added.host.id, true);
    expect(connections.attempt(added.host.id)).toMatchObject({ transport: 'wsl' });
    await connections.outcome(attemptId);
    expect(startSsh).not.toHaveBeenCalled();
    expect(requests[0]?.host.distro).toBe('Ubuntu-24.04');
    expect(connections.attempt(added.host.id)).toMatchObject({ transport: 'wsl', step: 'connected', visited: ['connecting', 'checking'] });
    await expect(connections.withPrompts(added.host.id, async () => undefined)).rejects.toThrow('reached over no ssh');
  });
});
