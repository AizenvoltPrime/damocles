import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { destinationLabel, groupsOf, HOST_STORE_FILE, HostStore, hostIdOfAuthority, hostOs, sshAuthorityKey } from '../host-store';
import { PROJECTS_FILE, ProjectList } from '../../projects';
import { TRUST_FILE, TrustStore } from '../../trust-store';
import { folderKey } from '../../../../core/workspace-folders/folder-key';

// The parsers of projects.json and trusted-folders.json as commit 6dd3c95d has them (projects.ts:11-15, trust-store.ts:21-25),
// frozen here: what an older app reads after this version wrote its stores.
function parseProjects6dd3c95d(text: string): string[] {
  const parsed = JSON.parse(text) as { version?: unknown; projects?: unknown } | null;
  if (parsed?.version !== 1 || !Array.isArray(parsed.projects)) throw new Error('unknown schema');
  return (parsed.projects as unknown[]).filter((entry): entry is string => typeof entry === 'string' && path.isAbsolute(entry));
}
function parseFolders6dd3c95d(text: string): string[] {
  const parsed = JSON.parse(text) as { version?: unknown; folders?: unknown } | null;
  if (parsed?.version !== 1 || !Array.isArray(parsed.folders)) throw new Error('unknown schema');
  return (parsed.folders as unknown[]).filter((entry): entry is string => typeof entry === 'string' && path.isAbsolute(entry));
}

const LOOPBACK = 'loopback';
let userData: string;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-hosts-'));
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

const record = (folder: string): { path: string; folderKey: string; os: 'win32' | 'linux' } => ({ path: folder, folderKey: folderKey(folder), os: process.platform === 'win32' ? 'win32' : 'linux' });
const keyOf = (folder: string): string => `loopback|${folderKey(folder)}`;

describe('HostStore', () => {
  it('keeps each authority\'s projects and trust, and reads them back', async () => {
    const app = path.join(userData, 'app');
    const store = await HostStore.open(userData, () => undefined);
    const changed = vi.fn();
    store.onDidChange(changed);
    expect(await store.addProject(LOOPBACK, record(app), keyOf(app), () => [])).toBe(true);
    expect(await store.addProject(LOOPBACK, record(app), keyOf(app), () => [keyOf(app)])).toBe(false);
    await store.grantTrust(LOOPBACK, folderKey(app));
    expect(changed).toHaveBeenCalledTimes(2);
    const reread = await HostStore.open(userData, () => undefined);
    expect(reread.projects()).toEqual([{ authorityKey: LOOPBACK, project: record(app) }]);
    expect(reread.isTrusted(LOOPBACK, folderKey(app))).toBe(true);
    expect(reread.isTrusted('ssh+x', folderKey(app))).toBe(false);
    await reread.removeProject(LOOPBACK, folderKey(app), keyOf(app));
    expect((await HostStore.open(userData, () => undefined)).projects()).toEqual([]);
  });

  it('reconciles the sidebar order with the listed projects: drops gone keys and appends unlisted ones', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map((name) => folderKey(path.join(userData, name)));
    const remote = path.join(userData, 'remote');
    const store = await HostStore.open(userData, () => undefined);
    expect(store.order([a!, b!])).toEqual([a, b]);
    // the remote project joins after the local projects shown when it was added
    await store.addProject(LOOPBACK, record(remote), keyOf(remote), () => [a!, b!]);
    expect(store.order([a!, b!, keyOf(remote)])).toEqual([a, b, keyOf(remote)]);
    // an older version removed b from projects.json and added c
    expect(store.order([a!, c!, keyOf(remote)])).toEqual([a, keyOf(remote), c]);
  });

  it('changes nothing in memory when the write fails', async () => {
    const app = path.join(userData, 'app');
    const store = await HostStore.open(userData, () => undefined);
    fs.mkdirSync(path.join(userData, HOST_STORE_FILE));
    const changed = vi.fn();
    store.onDidChange(changed);
    await expect(store.addProject(LOOPBACK, record(app), keyOf(app), () => [])).rejects.toThrow();
    await expect(store.grantTrust(LOOPBACK, folderKey(app))).rejects.toThrow();
    expect(store.projects()).toEqual([]);
    expect(store.isTrusted(LOOPBACK, folderKey(app))).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });

  it('settles flush once the queued writes landed', async () => {
    const store = await HostStore.open(userData, () => undefined);
    const app = path.join(userData, 'app');
    void store.addProject(LOOPBACK, record(app), keyOf(app), () => []);
    void store.grantTrust(LOOPBACK, folderKey(app));
    await store.flush();
    const text = fs.readFileSync(path.join(userData, HOST_STORE_FILE), 'utf8');
    expect(JSON.parse(text)).toEqual({ version: 1, authorities: { loopback: { projects: [record(app)], trusted: [folderKey(app)] } }, order: [keyOf(app)], hosts: {}, groupOrder: [], collapsedGroups: [] });
  });

  it('ignores an unreadable file and drops invalid entries', async () => {
    const log = vi.fn();
    fs.writeFileSync(path.join(userData, HOST_STORE_FILE), '{ nope');
    expect((await HostStore.open(userData, log)).projects()).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('refusing every write'));
    const app = path.join(userData, 'app');
    fs.writeFileSync(path.join(userData, HOST_STORE_FILE), JSON.stringify({
      version: 1,
      authorities: { local: { projects: [record(app)] }, loopback: { projects: [record(app), record(app), { path: 3 }, { ...record(path.join(userData, 'other')), os: 'aix' }], trusted: ['', 7, 'k'] } },
      order: ['x', 'x', 5],
    }));
    const store = await HostStore.open(userData, () => undefined);
    expect(store.projects()).toEqual([{ authorityKey: LOOPBACK, project: record(app) }]);
    expect(store.isTrusted(LOOPBACK, 'k')).toBe(true);
    expect(store.order(['x'])).toEqual(['x']);
  });

  // the file holds every saved host and what Remove Damocles server may undo; a typo or a downgrade must not cost them
  it('refuses every write while the file does not parse or names another schema, leaving it as it was', async () => {
    const app = path.join(userData, 'app');
    for (const text of ['{ "version": 1, "hosts": { oops', JSON.stringify({ version: 2, authorities: {}, hosts: { h1: {} } })]) {
      fs.writeFileSync(path.join(userData, HOST_STORE_FILE), text);
      const store = await HostStore.open(userData, () => undefined);
      expect(store.unreadable()).toBeDefined();
      expect(store.projects()).toEqual([]);
      await expect(store.addProject(LOOPBACK, record(app), keyOf(app), () => [])).rejects.toThrow('could not be read');
      await expect(store.setOrder([], () => [])).rejects.toThrow('could not be read');
      expect(fs.readFileSync(path.join(userData, HOST_STORE_FILE), 'utf8')).toBe(text);
    }
    fs.writeFileSync(path.join(userData, HOST_STORE_FILE), JSON.stringify({ version: 1, authorities: {}, order: [] }));
    expect((await HostStore.open(userData, () => undefined)).unreadable()).toBeUndefined();
  });

  it('reads a __proto__ authority key as a plain key and never an inherited member', async () => {
    fs.writeFileSync(path.join(userData, HOST_STORE_FILE), '{"version":1,"authorities":{"__proto__":{"projects":[],"trusted":["k"]}},"order":[]}');
    const store = await HostStore.open(userData, () => undefined);
    expect(store.isTrusted('__proto__', 'k')).toBe(true);
    expect(store.isTrusted('constructor', 'k')).toBe(false);
    expect(store.isTrusted('toString', 'k')).toBe(false);
    await store.grantTrust('constructor', 'k');
    expect(store.isTrusted('constructor', 'k')).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(userData, HOST_STORE_FILE), 'utf8')).authorities.__proto__).toEqual({ projects: [], trusted: ['k'] });
  });

  it('leaves projects.json and trusted-folders.json as 6dd3c95d reads them, listing the same local entries', async () => {
    const local = [path.join(userData, 'one'), path.join(userData, 'two')];
    const projects = new ProjectList(userData, () => undefined);
    const trust = new TrustStore(userData, () => Promise.resolve(undefined), (message) => message, () => undefined);
    for (const folder of local) {
      await projects.add(folder);
      await trust.grant(folder);
    }
    const projectsBefore = fs.readFileSync(path.join(userData, PROJECTS_FILE), 'utf8');
    const trustBefore = fs.readFileSync(path.join(userData, TRUST_FILE), 'utf8');
    const store = await HostStore.open(userData, () => undefined);
    const remote = path.join(userData, 'one');
    await store.addProject(LOOPBACK, record(remote), keyOf(remote), () => local.map(folderKey));
    await store.grantTrust(LOOPBACK, folderKey(remote));
    await Promise.all([projects.flush(), trust.flush(), store.flush()]);
    const projectsText = fs.readFileSync(path.join(userData, PROJECTS_FILE), 'utf8');
    const trustText = fs.readFileSync(path.join(userData, TRUST_FILE), 'utf8');
    expect(projectsText).toBe(projectsBefore);
    expect(trustText).toBe(trustBefore);
    expect(parseProjects6dd3c95d(projectsText)).toEqual(local);
    expect(parseFolders6dd3c95d(trustText)).toEqual(local);
    // the same folder opened through the daemon is a project of its own, beside the local one
    expect(new ProjectList(userData, () => undefined).folders().map((folder) => folder.fsPath)).toEqual(local);
    expect(store.order([...local.map(folderKey), keyOf(remote)])).toEqual([...local.map(folderKey), keyOf(remote)]);
  });

  it('keeps SSH host records by id, with their platform cache, recent folders and lastUsed, and reads them back', async () => {
    const store = await HostStore.open(userData, () => undefined);
    const added = await store.addHost({ destination: { kind: 'address', host: '10.0.0.9', user: 'deploy', port: 2222, options: [{ name: 'IdentityFile', value: '~/.ssh/id_deploy' }] }, name: 'billing-prod' });
    if (!added.ok) throw new Error('setup');
    const id = added.host.id;
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(sshAuthorityKey(id)).toBe(`ssh+${id}`);
    expect(hostIdOfAuthority(`ssh+${id}`)).toBe(id);
    expect(hostIdOfAuthority('loopback')).toBeUndefined();
    await store.savePlatform(id, { os: 'win32', windowsShell: 'powershell' });
    await store.touchHost(id, '/srv/app');
    await store.touchHost(id, '/srv/billing');
    await store.touchHost(id, '/srv/app');
    const reread = await HostStore.open(userData, () => undefined);
    const host = reread.host(id)!;
    expect(host.destination).toEqual({ kind: 'address', host: '10.0.0.9', user: 'deploy', port: 2222, options: [{ name: 'IdentityFile', value: '~/.ssh/id_deploy' }] });
    expect(destinationLabel(host.destination)).toBe('deploy@10.0.0.9:2222');
    // an IPv6 host is bracketed, so the label reads back as the same address and port
    expect(destinationLabel({ kind: 'address', host: 'fe80::1', user: 'dev', port: 22, options: [] })).toBe('dev@[fe80::1]:22');
    expect(destinationLabel({ kind: 'address', host: 'fe80::1', options: [] })).toBe('[fe80::1]');
    expect(host.platform).toEqual({ os: 'win32', windowsShell: 'powershell' });
    expect(hostOs(host)).toBe('win32');
    expect(hostOs({ ...host, osOverride: 'linux' })).toBe('linux');
    expect(host.recentFolders).toEqual(['/srv/app', '/srv/billing']);
    expect(host.lastUsed).toBeGreaterThan(0);
  });

  it('keeps the previous install folder until an install in the new one settled', async () => {
    const store = await HostStore.open(userData, () => undefined);
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('setup');
    const id = added.host.id;
    await store.setInstallFolder(id, '/opt/damocles');
    expect(store.host(id)).toMatchObject({ settings: { installFolder: '/opt/damocles' }, previousInstallFolder: null });
    // a second change before any install keeps the folder that still holds the installed versions
    await store.setInstallFolder(id, '/opt/tools');
    expect(store.host(id)).toMatchObject({ settings: { installFolder: '/opt/tools' }, previousInstallFolder: null });
    await store.installFolderSettled(id);
    expect(store.host(id)?.previousInstallFolder).toBeUndefined();
    await store.setInstallFolder(id, null);
    const reread = await HostStore.open(userData, () => undefined);
    expect(reread.host(id)).toMatchObject({ settings: {}, previousInstallFolder: '/opt/tools' });
  });

  it('keeps each host setting and what Damocles changed on it, and reads them back', async () => {
    const store = await HostStore.open(userData, () => undefined);
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('setup');
    const id = added.host.id;
    await store.setHostSetting(id, { key: 'color', value: 'danger' });
    await store.setHostSetting(id, { key: 'defaultPermissionMode', value: 'plan' });
    await store.setHostSetting(id, { key: 'allowBypass', value: true });
    await store.setHostSetting(id, { key: 'forwardAgent', value: true });
    await store.setHostSetting(id, { key: 'rememberPassword', value: true });
    await store.setInstallFolder(id, '/opt/damocles');
    await store.recordInstalledKey(id, { fingerprint: `SHA256:${'a'.repeat(43)}`, entry: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'A'.repeat(43)}`, file: '/home/dev/.ssh/authorized_keys' });
    await store.recordPasswordless(id, path.join(userData, 'ssh', 'id_ed25519'));
    await store.recordLingerEnabled(id);
    await store.addAlwaysCredentialHost(id, 'github.com');
    await store.addAlwaysCredentialHost(id, 'git.example.com:8443');
    await store.revokeCredentialHost(id, 'github.com');
    const host = (await HostStore.open(userData, () => undefined)).host(id)!;
    expect(host).toMatchObject({
      color: 'danger',
      settings: { defaultPermissionMode: 'plan', allowBypass: true, forwardAgent: true, rememberPassword: true, installFolder: '/opt/damocles' },
      identityFile: path.join(userData, 'ssh', 'id_ed25519'),
      installedKeyFingerprint: `SHA256:${'a'.repeat(43)}`,
      installedKeyFile: '/home/dev/.ssh/authorized_keys',
      lingerEnabledByDamocles: true,
      alwaysCredentialHosts: ['git.example.com:8443'],
    });
    await store.setHostSetting(id, { key: 'allowBypass', value: false });
    await store.setHostSetting(id, { key: 'color', value: null });
    await store.clearInstalledKey(id);
    await store.clearLingerEnabled(id);
    const cleared = store.host(id)!;
    expect(cleared.color).toBeUndefined();
    expect(cleared.settings).toEqual({ defaultPermissionMode: 'plan', forwardAgent: true, rememberPassword: true, installFolder: '/opt/damocles' });
    expect([cleared.identityFile, cleared.installedKeyFingerprint, cleared.installedKeyEntry, cleared.lingerEnabledByDamocles]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('refuses a color that is no palette tone, an earlier #rrggbb included, at the file boundary', async () => {
    const log = vi.fn();
    fs.writeFileSync(path.join(userData, HOST_STORE_FILE), JSON.stringify({
      version: 1,
      authorities: {},
      hosts: {
        a: { kind: 'ssh', destination: { kind: 'alias', alias: 'a' }, name: 'a', color: '#ff0000', recentFolders: [], settings: { allowBypass: 'yes', defaultPermissionMode: 'bypassPermissions' } },
        b: { kind: 'ssh', destination: { kind: 'alias', alias: 'b' }, name: 'b', color: 'success', recentFolders: [], settings: {}, alwaysCredentialHosts: ['github.com', 'evil/host'] },
      },
    }));
    const store = await HostStore.open(userData, log);
    expect(store.host('a')?.color).toBeUndefined();
    expect(store.host('a')?.settings).toEqual({});
    expect(store.host('b')?.color).toBe('success');
    expect(store.host('b')?.alwaysCredentialHosts).toEqual(['github.com']);
    expect(log).toHaveBeenCalledWith('[hosts] dropping the color of a: not a palette tone');
  });

  it('forgets a host with its projects, trust and every order entry, leaving the others', async () => {
    const store = await HostStore.open(userData, () => undefined);
    const prod = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    const dev = await store.addHost({ destination: { kind: 'alias', alias: 'dev-1' }, name: 'dev-1' });
    if (!prod.ok || !dev.ok) throw new Error('setup');
    const prodKey = sshAuthorityKey(prod.host.id);
    const devKey = sshAuthorityKey(dev.host.id);
    await store.addProject(prodKey, { path: '/srv/app', folderKey: '/srv/app', os: 'linux' }, `${prodKey}|/srv/app`, () => []);
    await store.addProject(devKey, { path: '/srv/app', folderKey: '/srv/app', os: 'linux' }, `${devKey}|/srv/app`, () => [`${prodKey}|/srv/app`]);
    await store.grantTrust(prodKey, '/srv/app');
    await store.setGroupCollapsed(prodKey, true, () => [prodKey, devKey]);
    await store.forgetHost(prod.host.id);
    const reread = await HostStore.open(userData, () => undefined);
    expect(reread.hosts().map((host) => host.id)).toEqual([dev.host.id]);
    expect(reread.projects()).toEqual([{ authorityKey: devKey, project: { path: '/srv/app', folderKey: '/srv/app', os: 'linux' } }]);
    expect(reread.isTrusted(prodKey, '/srv/app')).toBe(false);
    expect(reread.order([])).toEqual([]);
    expect(reread.order([`${devKey}|/srv/app`])).toEqual([`${devKey}|/srv/app`]);
    expect(reread.collapsedGroups()).toEqual([]);
  });

  it('stores groupOrder and keeps it across writes', async () => {
    fs.writeFileSync(path.join(userData, HOST_STORE_FILE), JSON.stringify({ version: 1, authorities: {}, order: [], hosts: {}, groupOrder: ['abc', 'local', 'abc', 3] }));
    const store = await HostStore.open(userData, () => undefined);
    expect(store.groupOrder()).toEqual(['abc', 'local']);
    await store.addHost({ destination: { kind: 'alias', alias: 'x' }, name: 'x' });
    expect(JSON.parse(fs.readFileSync(path.join(userData, HOST_STORE_FILE), 'utf8')).groupOrder).toEqual(['abc', 'local']);
  });

  describe('sidebar order', () => {
    const fileText = (): string => fs.readFileSync(path.join(userData, HOST_STORE_FILE), 'utf8');

    it('writes a permutation of the listed keys, and refuses a missing, extra or repeated key without writing', async () => {
      const store = await HostStore.open(userData, () => undefined);
      expect(await store.setOrder(['b', 'a', 'c'], () => ['a', 'b', 'c'])).toBe(true);
      expect(JSON.parse(fileText()).order).toEqual(['b', 'a', 'c']);
      const before = fileText();
      const changed = vi.fn();
      store.onDidChange(changed);
      for (const order of [['a', 'b'], ['a', 'b', 'c', 'd'], ['a', 'a', 'b'], ['a', 'b', 'x']]) {
        expect(await store.setOrder(order, () => ['a', 'b', 'c'])).toBe(false);
      }
      expect(fileText()).toBe(before);
      expect(changed).not.toHaveBeenCalled();
      expect(store.order(['a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
    });

    it('checks against the keys listed when the write runs, not when it was asked', async () => {
      const store = await HostStore.open(userData, () => undefined);
      let listed = ['a', 'b'];
      const first = store.setOrder(['b', 'a'], () => listed);
      const stale = store.setOrder(['a', 'b'], () => listed);
      listed = ['a', 'b', 'c'];
      expect(await first).toBe(false);
      expect(await stale).toBe(false);
      expect(store.order(listed)).toEqual(['a', 'b', 'c']);
    });

    it('keeps the slots of stored keys that are not listed, as the remote gate hides them', async () => {
      const store = await HostStore.open(userData, () => undefined);
      await store.setOrder(['a', 'ssh+h|/srv', 'b'], () => ['a', 'ssh+h|/srv', 'b']);
      expect(await store.setOrder(['b', 'a'], () => ['a', 'b'])).toBe(true);
      expect(JSON.parse(fileText()).order).toEqual(['b', 'ssh+h|/srv', 'a']);
      expect(store.order(['a', 'ssh+h|/srv', 'b'])).toEqual(['b', 'ssh+h|/srv', 'a']);
    });

    it('lands on disk by the time an immediate flush settles, as a quit right after a reorder awaits it', async () => {
      const store = await HostStore.open(userData, () => undefined);
      void store.setOrder(['c', 'b', 'a'], () => ['a', 'b', 'c']);
      void store.setGroupOrder(['ssh+h', 'local'], () => ['local', 'ssh+h']);
      await store.flush();
      const reread = await HostStore.open(userData, () => undefined);
      expect(reread.order(['a', 'b', 'c'])).toEqual(['c', 'b', 'a']);
      expect(reread.groups(['local', 'ssh+h'])).toEqual(['ssh+h', 'local']);
    });

    it('adds a project right after its source key, or last without one', async () => {
      const store = await HostStore.open(userData, () => undefined);
      const [app, billing, api] = ['app', 'billing', 'api'].map((name) => path.join(userData, name));
      await store.addProject(LOOPBACK, record(app!), keyOf(app!), () => ['l1', 'l2']);
      expect(store.order(['l1', 'l2', keyOf(app!)])).toEqual(['l1', 'l2', keyOf(app!)]);
      await store.addProject(LOOPBACK, record(billing!), keyOf(billing!), () => ['l1', 'l2', keyOf(app!)], 'l1');
      expect(store.order(['l1', 'l2', keyOf(app!), keyOf(billing!)])).toEqual(['l1', keyOf(billing!), 'l2', keyOf(app!)]);
      // a source no longer listed places it last
      await store.addProject(LOOPBACK, record(api!), keyOf(api!), () => ['l2', keyOf(app!), keyOf(billing!)], 'gone');
      expect(store.order(['l2', keyOf(app!), keyOf(billing!), keyOf(api!)])).toEqual([keyOf(billing!), 'l2', keyOf(app!), keyOf(api!)]);
    });

    it('drops a removed local project\'s key, so a folder added again comes last', async () => {
      const store = await HostStore.open(userData, () => undefined);
      await store.setOrder(['b', 'a', 'c'], () => ['a', 'b', 'c']);
      await store.removeFromOrder('a');
      expect(JSON.parse(fileText()).order).toEqual(['b', 'c']);
      expect(store.order(['b', 'c', 'a'])).toEqual(['b', 'c', 'a']);
    });

    it('places a key right after another before the key is listed, so it shows there once listed', async () => {
      const store = await HostStore.open(userData, () => undefined);
      await store.placeAfter('new', 'a', () => ['a', 'b']);
      expect(store.order(['a', 'b'])).toEqual(['a', 'b']);
      expect(store.order(['a', 'b', 'new'])).toEqual(['a', 'new', 'b']);
    });
  });

  describe('project groups', () => {
    it('reads groups by authority key in first-appearance order, this computer always', () => {
      expect(groupsOf(['C:\\a', 'ssh+h|/srv', 'loopback|C:\\b', 'ssh+h|/x'])).toEqual(['local', 'ssh+h', 'loopback']);
      expect(groupsOf(['ssh+h|/srv'])).toEqual(['local', 'ssh+h']);
      expect(groupsOf([])).toEqual(['local']);
    });

    it('writes a permutation of the listed groups and refuses anything else, keeping hidden groups\' slots', async () => {
      const store = await HostStore.open(userData, () => undefined);
      expect(await store.setGroupOrder(['ssh+h', 'local', 'ssh+g'], () => ['local', 'ssh+h', 'ssh+g'])).toBe(true);
      for (const order of [['local'], ['local', 'ssh+h', 'ssh+g', 'x'], ['local', 'local', 'ssh+h']]) {
        expect(await store.setGroupOrder(order, () => ['local', 'ssh+h', 'ssh+g'])).toBe(false);
      }
      expect(store.groups(['local', 'ssh+h', 'ssh+g'])).toEqual(['ssh+h', 'local', 'ssh+g']);
      // ssh+h hidden: local and ssh+g swap around its slot
      expect(await store.setGroupOrder(['ssh+g', 'local'], () => ['local', 'ssh+g'])).toBe(true);
      expect(store.groups(['local', 'ssh+h', 'ssh+g'])).toEqual(['ssh+h', 'ssh+g', 'local']);
      expect(store.groups(['local', 'ssh+n'])).toEqual(['local', 'ssh+n']);
    });

    it('keeps collapsed groups across a relaunch, refuses an unlisted group and reads them defensively', async () => {
      const store = await HostStore.open(userData, () => undefined);
      await store.setGroupCollapsed('ssh+h', true, () => ['local', 'ssh+h']);
      await store.setGroupCollapsed('local', true, () => ['local', 'ssh+h']);
      await store.setGroupCollapsed('local', false, () => ['local', 'ssh+h']);
      await expect(store.setGroupCollapsed('ssh+x', true, () => ['local', 'ssh+h'])).rejects.toThrow('No project group');
      expect((await HostStore.open(userData, () => undefined)).collapsedGroups()).toEqual(['ssh+h']);
      fs.writeFileSync(path.join(userData, HOST_STORE_FILE), JSON.stringify({ version: 1, authorities: {}, order: [], collapsedGroups: ['ssh+h', 4, '', 'ssh+h'] }));
      expect((await HostStore.open(userData, () => undefined)).collapsedGroups()).toEqual(['ssh+h']);
      fs.writeFileSync(path.join(userData, HOST_STORE_FILE), JSON.stringify({ version: 1, authorities: {}, order: [], collapsedGroups: 'local' }));
      expect((await HostStore.open(userData, () => undefined)).collapsedGroups()).toEqual([]);
    });
  });

  it('drops a host record whose destination could reach ssh as an option or a second line', async () => {
    const log = vi.fn();
    const host = (destination: unknown): unknown => ({ kind: 'ssh', destination, name: 'n', recentFolders: [], settings: {} });
    fs.writeFileSync(path.join(userData, HOST_STORE_FILE), JSON.stringify({
      version: 1, authorities: {}, order: [],
      hosts: {
        a: host({ kind: 'alias', alias: '-oProxyCommand=x' }),
        b: host({ kind: 'address', host: 'h\nx', options: [] }),
        c: host({ kind: 'address', host: 'h', port: 70000, options: [] }),
        d: host({ kind: 'address', host: 'h', options: [{ name: '-F', value: 'x' }] }),
        'bad id!': host({ kind: 'alias', alias: 'ok' }),
        e: host({ kind: 'alias', alias: 'fine' }),
      },
    }));
    const store = await HostStore.open(userData, log);
    expect(store.hosts().map((record) => record.id)).toEqual(['e']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('malformed host record'));
  });
});

