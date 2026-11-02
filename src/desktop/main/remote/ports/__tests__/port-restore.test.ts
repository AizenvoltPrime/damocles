import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_HOST_PORTS, HostStore, RESTORE_EXPIRY_MS } from '../../host-store';
import { AUTHORITY, candidate, fakeStore, fakeTunnels, forwarding, HOST, PROJECT } from './fake-ports';

const OTHER_PROJECT = 'ssh+host-1|/srv/other';
const DAY = 24 * 60 * 60 * 1000;

describe('restored forwards', () => {
  it('stores a manual forward, its label and a changed local port per host and project', async () => {
    const { tunnels } = fakeTunnels();
    const { store, ports } = fakeStore();
    const { forwarding: forward, now } = forwarding({ tunnels, store });
    await forward.connected(HOST);
    await forward.forwardManual(PROJECT, HOST, { port: 9000 }, 'api');
    await forward.changeLocalPort(PROJECT, HOST, 'localhost:9000', 9100);
    expect(ports().restore).toEqual({ [PROJECT]: { 'localhost:9000': { host: 'localhost', port: 9000, localPort: 9100, manual: true, lastUsed: now() } } });
    expect(ports().attributes['9000']).toEqual({ label: 'api' });
  });

  it('remembers the changed local port of an automatic forward without restoring it as a manual one', async () => {
    const { tunnels, forwards, calls } = fakeTunnels();
    const { store, ports } = fakeStore();
    const { forwarding: forward } = forwarding({ tunnels, store });
    await forward.connected(HOST);
    await forward.candidates(HOST, [candidate(5173)]);
    await forward.changeLocalPort(PROJECT, HOST, 'localhost:5173', 5200);
    expect(ports().restore[PROJECT]?.['localhost:5173']).toMatchObject({ localPort: 5200, manual: false });
    forward.disconnected(HOST);
    await forward.connected(HOST);
    expect(forwards.size).toBe(0);
    await forward.candidates(HOST, [candidate(5173)]);
    expect(calls.at(-1)).toEqual({ remote: { host: '127.0.0.1', port: 5173 }, localPort: 5200 });
  });

  it('restores every project of the host on connect, and drops an entry not used for two weeks', async () => {
    const { tunnels, forwards } = fakeTunnels();
    const start = 1_000_000_000;
    const { store, ports } = fakeStore({
      ...EMPTY_HOST_PORTS,
      restore: {
        [PROJECT]: { 'localhost:9000': { host: 'localhost', port: 9000, localPort: 9100, manual: true, lastUsed: start - RESTORE_EXPIRY_MS + DAY } },
        [OTHER_PROJECT]: { 'db:5432': { host: 'db', port: 5432, manual: true, lastUsed: start - RESTORE_EXPIRY_MS - DAY } },
      },
    });
    const { forwarding: forward } = forwarding({ tunnels, store, projectsOf: () => [PROJECT, OTHER_PROJECT], now: () => start });
    await forward.connected(HOST);
    expect([...forwards.values()].map((tunnel) => [tunnel.key, tunnel.localPort])).toEqual([['localhost:9000', 9100]]);
    expect(forward.view(HOST).rows).toEqual([expect.objectContaining({ key: 'localhost:9000', localPort: 9100, origin: 'manual', state: 'forwarded' })]);
    expect(ports().restore).toEqual({ [PROJECT]: { 'localhost:9000': { host: 'localhost', port: 9000, localPort: 9100, manual: true, lastUsed: start } } });
  });

  it('Stop forwarding drops the entry, so the forward does not come back', async () => {
    const { tunnels, forwards } = fakeTunnels();
    const { store, ports } = fakeStore();
    const { forwarding: forward } = forwarding({ tunnels, store });
    await forward.connected(HOST);
    await forward.forwardManual(PROJECT, HOST, { host: 'db', port: 5432 }, undefined);
    await forward.stop(HOST, 'db:5432');
    expect(ports().restore).toEqual({});
    forward.disconnected(HOST);
    await forward.connected(HOST);
    expect(forwards.size).toBe(0);
  });
});

describe('the host store record', () => {
  let folder: string | undefined;
  afterEach(async () => {
    if (folder) await fs.rm(folder, { recursive: true, force: true });
    folder = undefined;
  });

  it('keeps the port state across a relaunch, and Forget host removes the attributes and restore entries', async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'damocles-ports-'));
    const store = await HostStore.open(folder, () => undefined);
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('the host was not added');
    const hostId = added.host.id;
    const project = `ssh+${hostId}|/srv/app`;
    await store.updatePorts(hostId, () => ({
      attributes: { '5173': { label: 'vite', onDetect: 'openPane' }, '3000-3010': { onDetect: 'ignore' } },
      fallback: 'disabled',
      restore: { [project]: { 'localhost:9000': { host: 'localhost', port: 9000, localPort: 9100, manual: true, lastUsed: 42 } } },
    }));
    const reopened = await HostStore.open(folder, () => undefined);
    expect(reopened.ports(hostId)).toEqual({
      attributes: { '5173': { label: 'vite', onDetect: 'openPane' }, '3000-3010': { onDetect: 'ignore' } },
      fallback: 'disabled',
      restore: { [project]: { 'localhost:9000': { host: 'localhost', port: 9000, localPort: 9100, manual: true, lastUsed: 42 } } },
    });
    await reopened.forgetHost(hostId);
    const after = await HostStore.open(folder, () => undefined);
    expect(after.ports(hostId)).toEqual(EMPTY_HOST_PORTS);
    expect(await fs.readFile(path.join(folder, 'remote-hosts.json'), 'utf8')).not.toContain('5173');
  });

  it('drops a restore entry of another host\'s project and attributes that name no port', async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'damocles-ports-'));
    const store = await HostStore.open(folder, () => undefined);
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('the host was not added');
    const hostId = added.host.id;
    await store.updatePorts(hostId, () => ({
      attributes: { '0': { label: 'zero' }, 'x-y': { label: 'x' }, '70000': { label: 'big' }, '22': { label: 'ssh' } },
      restore: { [`${AUTHORITY}|/srv/elsewhere`]: { 'localhost:1': { host: 'localhost', port: 1, manual: true, lastUsed: 1 } } },
    }));
    const reopened = await HostStore.open(folder, () => undefined);
    expect(reopened.ports(hostId)).toEqual({ attributes: { '22': { label: 'ssh' } }, restore: {} });
  });

  // the daemon's ports.connect refuses an option-like host, so restoring one would end the connection at its first use
  it('drops a restore entry whose host starts with "-"', async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'damocles-ports-'));
    const store = await HostStore.open(folder, () => undefined);
    const added = await store.addHost({ destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1' });
    if (!added.ok) throw new Error('the host was not added');
    const hostId = added.host.id;
    const project = `ssh+${hostId}|/srv/app`;
    const db = { host: 'db', port: 5432, manual: true, lastUsed: 1 };
    await store.updatePorts(hostId, () => ({ attributes: {}, restore: { [project]: { 'db:5432': db, '-db:5432': { ...db, host: '-db' } } } }));
    const reopened = await HostStore.open(folder, () => undefined);
    expect(reopened.ports(hostId).restore).toEqual({ [project]: { 'db:5432': db } });
  });
});
