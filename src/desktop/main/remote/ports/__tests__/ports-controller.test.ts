import * as net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { listeners } from '../../../../../remote/listeners';
import type { RemoteConnection } from '../../connection';
import { EMPTY_HOST_PORTS, type HostStore } from '../../host-store';
import { LOOPBACK_HOST, PortsController, type PortsControllerDeps } from '../ports-controller';
import { accepts, ForwardLimitError, MAX_FORWARDS_PER_HOST, type LoopbackAddress } from '../tunnels';
import type { PortCandidate } from '../../../../daemon/ports/ports-messages';
import type { WindowsListeners } from '../../wsl/wsl-port-probe';
import { AUTHORITY, candidate, HOST, PROJECT } from './fake-ports';

const LOOPBACK_PROJECT = 'loopback|/srv/app';

function controller() {
  const notices: Array<{ readonly title: string; readonly message: string }> = [];
  const hostStore = {
    onDidChange: () => ({ dispose: () => undefined }),
    ports: () => EMPTY_HOST_PORTS,
    updatePorts: async () => undefined,
    host: (hostId: string) => (hostId === HOST ? { kind: 'ssh', settings: {} } : undefined),
    authorityOf: (hostId: string) => (hostId === HOST ? AUTHORITY : undefined),
    hostIdOf: (authority: string) => (authority === AUTHORITY ? HOST : undefined),
  } as unknown as HostStore;
  const deps = {
    hostStore,
    clientPlatform: 'win32',
    connection: () => undefined,
    autoForward: () => true,
    fallbackThreshold: () => 20,
    projectsOf: () => [PROJECT],
    isProject: (projectKey: string) => projectKey === PROJECT || projectKey === LOOPBACK_PROJECT,
    hostName: () => 'box',
    notice: async (_hostId: string, _severity: string, title: string, message: string) => {
      notices.push({ title, message });
      return undefined;
    },
    t: (message: string, ...args: string[]) => message.replace(/\{(\d+)\}/g, (_, index: string) => args[Number(index)] ?? ''),
    log: () => undefined,
  } as unknown as PortsControllerDeps;
  return { ports: new PortsController(deps), notices };
}

// a connection that serves ports, whose loss the test fires
function connection() {
  const lost = listeners<[string]>();
  const value = {
    features: ['ports'],
    ports: { onEvent: () => ({ dispose: () => undefined }), request: async () => undefined },
    onClose: () => ({ dispose: () => undefined }),
    onLost: lost.add,
  } as unknown as RemoteConnection;
  return { connection: value, lose: () => lost.fire('the transport closed') };
}

// a WSL distro whose probe found WSL forwarding loopback ports, its connection's list event fired by the test
function wslController(windowsListeners: () => WindowsListeners, accepted?: (host: LoopbackAddress, port: number) => Promise<boolean>) {
  const hostStore = {
    onDidChange: () => ({ dispose: () => undefined }),
    ports: () => EMPTY_HOST_PORTS,
    updatePorts: async () => undefined,
    host: () => ({ kind: 'wsl', distro: 'Ubuntu', settings: {} }),
    authorityOf: () => AUTHORITY,
    hostIdOf: () => HOST,
  } as unknown as HostStore;
  const deps = {
    hostStore,
    clientPlatform: 'win32',
    connection: () => undefined,
    // nothing binds: rows are only listed
    autoForward: () => false,
    fallbackThreshold: () => 20,
    projectsOf: () => [PROJECT],
    isProject: () => true,
    hostName: () => 'Ubuntu',
    notice: async () => undefined,
    probe: async () => ({ forwarded: true }),
    windowsListeners,
    ...(accepted ? { accepted } : {}),
    t: (message: string) => message,
    log: () => undefined,
  } as unknown as PortsControllerDeps;
  const ports = new PortsController(deps);
  const list = listeners<[{ readonly candidates: readonly PortCandidate[] }]>();
  const followed = {
    features: ['ports', 'control.portProbe'],
    control: { request: async () => ({ port: 40000, nonce: 'n' }) },
    ports: { onEvent: (name: string, listener: (payload: { readonly candidates: readonly PortCandidate[] }) => void) => (name === 'list' ? list.add(listener) : { dispose: () => undefined }), request: async () => undefined },
    onClose: () => ({ dispose: () => undefined }),
    onLost: () => ({ dispose: () => undefined }),
  } as unknown as RemoteConnection;
  ports.connected(HOST, followed);
  return { ports, list: (candidates: readonly PortCandidate[]) => list.fire({ candidates }) };
}

const RELAY = 'C:\\Program Files\\WSL\\wslrelay.exe';

// this computer's listeners as the test sets them, each read counted
function table(initial: ReadonlyArray<{ readonly port: number; readonly pid: number }>, images: Record<number, string>) {
  let rows = initial;
  const reads = { tables: 0, images: [] as number[] };
  const listeners: WindowsListeners = {
    rows: () => {
      reads.tables++;
      return rows as never;
    },
    imagePath: (pid) => {
      reads.images.push(pid);
      return images[pid];
    },
  };
  return { listeners: () => listeners, reads, set: (next: typeof initial) => void (rows = next) };
}

// a port nothing on this computer listens on now
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// connects the test answers one at a time
function connects() {
  const calls: Array<{ readonly host: LoopbackAddress; readonly port: number; readonly answer: (accepted: boolean) => void }> = [];
  const accepted = (host: LoopbackAddress, port: number): Promise<boolean> => new Promise((answer) => calls.push({ host, port, answer }));
  return { accepted, calls };
}

describe('ports WSL forwards, read from this computer\'s listeners', () => {
  it('reads the listener table once per list when every port is held, and each owner\'s image once', async () => {
    const { listeners, reads } = table([{ port: 3000, pid: 7 }, { port: 3001, pid: 7 }, { port: 3002, pid: 8 }], { 7: RELAY, 8: 'C:\\Program Files\\other.exe' });
    const { accepted, calls } = connects();
    const { ports, list } = wslController(listeners, accepted);
    list([candidate(3000), candidate(3001), candidate(3002)]);
    await vi.waitFor(() => expect(ports.forwarding.view(HOST).rows).toHaveLength(3));
    expect(reads.tables).toBe(1);
    expect(reads.images).toEqual([7, 8]);
    expect(calls).toEqual([]);
    expect(ports.forwarding.view(HOST).rows.map((row) => row.viaWsl === true)).toEqual([true, true, false]);
    ports.dispose();
  });

  // WSL's relay takes a new listener's port up to about 1 s after it listens, and a daemon scan in between lists it first
  it('lists a port no Windows process holds yet only once this computer reaches it, then via WSL', async () => {
    const { listeners, reads, set } = table([], { 7: RELAY });
    const { accepted, calls } = connects();
    const { ports, list } = wslController(listeners, accepted);
    list([candidate(5173)]);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ host: '127.0.0.1', port: 5173 });
    expect(ports.forwarding.view(HOST).rows).toEqual([]);
    set([{ port: 5173, pid: 7 }]);
    calls[0]!.answer(true);
    await vi.waitFor(() => expect(ports.forwarding.view(HOST).rows).toHaveLength(1));
    expect(ports.forwarding.view(HOST).rows[0]).toMatchObject({ remotePort: 5173, localPort: 5173, viaWsl: true });
    expect(reads.tables).toBe(2);
    ports.dispose();
  });

  it('tunnels a port that never answers on this computer, and one another program took meanwhile', async () => {
    const { listeners, set } = table([], { 7: RELAY, 8: 'C:\\Program Files\\other.exe' });
    const { accepted, calls } = connects();
    const { ports, list } = wslController(listeners, accepted);
    list([candidate(5173), candidate(5174, { family: 6, bindAddress: '::1', host: '::1' })]);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map(({ host, port }) => [host, port])).toEqual([['127.0.0.1', 5173], ['::1', 5174]]);
    set([{ port: 5174, pid: 8 }]);
    calls[0]!.answer(false);
    calls[1]!.answer(true);
    await vi.waitFor(() => expect(ports.forwarding.view(HOST).rows).toHaveLength(2));
    expect(ports.forwarding.view(HOST).rows.some((row) => row.viaWsl === true)).toBe(false);
    ports.dispose();
  });

  it('tunnels a port no Windows process holds when nothing can connect to it', async () => {
    const { listeners } = table([], {});
    const { ports, list } = wslController(listeners);
    list([candidate(5173)]);
    await vi.waitFor(() => expect(ports.forwarding.view(HOST).rows).toHaveLength(1));
    expect(ports.forwarding.view(HOST).rows[0]).not.toHaveProperty('viaWsl');
    ports.dispose();
  });

  it('tunnels every port when the table reader cannot load, and does not load it again', async () => {
    let loads = 0;
    const { ports, list } = wslController(() => {
      loads++;
      throw new Error('koffi failed to load');
    });
    list([candidate(3000)]);
    await vi.waitFor(() => expect(ports.forwarding.view(HOST).rows).toHaveLength(1));
    list([candidate(3000), candidate(3001)]);
    await vi.waitFor(() => expect(ports.forwarding.view(HOST).rows).toHaveLength(2));
    expect(ports.forwarding.view(HOST).rows.some((row) => row.viaWsl === true)).toBe(false);
    expect(loads).toBe(1);
    ports.dispose();
  });
});

describe('the Ports controller', () => {
  it('watches the host\'s ports even when restoring its forwards failed', async () => {
    const { ports } = controller();
    vi.spyOn(ports.forwarding, 'connected').mockRejectedValue(new Error('the store could not be written'));
    const { connection: followed } = connection();
    const watch = vi.spyOn(followed.ports, 'request');
    ports.connected(HOST, followed);
    await vi.waitFor(() => expect(watch).toHaveBeenCalledWith('watch', {}));
    ports.dispose();
  });

  it('resets the host\'s forwarded connections when its connection is lost', () => {
    const { ports } = controller();
    const reset = vi.spyOn(ports.tunnels, 'resetConnections');
    const { connection: followed, lose } = connection();
    ports.connected(HOST, followed);
    lose();
    expect(reset).toHaveBeenCalledWith(AUTHORITY);
    ports.dispose();
  });

  // the loopback daemon is a dev and e2e host with no host record; its links, browser and chip need its forwards
  it("forwards the loopback daemon's ports like a saved host's, keeping their state for the run, and its browser reaches them", async () => {
    const { ports } = controller();
    const { connection: followed } = connection();
    ports.connected(LOOPBACK_HOST, followed);
    const port = await freePort();
    const tunnel = await ports.forwarding.forwardingFor(LOOPBACK_HOST).forward(LOOPBACK_HOST, { host: 'localhost', port });
    expect(tunnel).toMatchObject({ authority: LOOPBACK_HOST, remote: { port } });
    expect(ports.clientNetworks()[LOOPBACK_HOST]).toEqual({ allowedPorts: [tunnel.localPort], allowLocalNetwork: false });
    await ports.forwarding.setLabel(LOOPBACK_HOST, port, 'dev server');
    expect(ports.forwarding.view(LOOPBACK_HOST).rows).toEqual([expect.objectContaining({ remotePort: port, localPort: tunnel.localPort, label: 'dev server' })]);
    // the palette's port commands act on a loopback project too
    await ports.actions.stop({ projectKey: LOOPBACK_PROJECT, key: `localhost:${port}` });
    expect(ports.tunnels.list(LOOPBACK_HOST)).toEqual([]);
    ports.dispose();
  });

  it("closes every forward's listeners when it is disposed, connected or not", async () => {
    const { ports } = controller();
    const { connection: followed } = connection();
    ports.connected(HOST, followed);
    const tunnel = await ports.forwarding.forwardingFor(HOST).forward(AUTHORITY, { host: 'localhost', port: await freePort() });
    expect(await accepts('127.0.0.1', tunnel.localPort)).toBe(true);
    ports.dispose();
    expect(ports.tunnels.list(AUTHORITY)).toEqual([]);
    await vi.waitFor(async () => expect(await accepts('127.0.0.1', tunnel.localPort)).toBe(false));
  });

  it('tells the user in a notice when their own forward is refused at the forward limit', async () => {
    const { ports, notices } = controller();
    vi.spyOn(ports.forwarding, 'forwardRow').mockRejectedValue(new ForwardLimitError(AUTHORITY));
    await ports.actions.forwardDetected({ projectKey: PROJECT, key: 'localhost:3000' });
    expect(notices).toEqual([{ title: 'Port not forwarded', message: `box already has ${MAX_FORWARDS_PER_HOST} forwarded ports, the most Damocles keeps for one host. Stop forwarding one to forward another.` }]);
    ports.dispose();
  });
});
