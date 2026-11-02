import { describe, expect, it } from 'vitest';
import { EMPTY_HOST_PORTS } from '../../host-store';
import { ViaWslError } from '../port-forwarding';
import { candidate, fakeStore, fakeTunnels, forwarding, HOST, PROJECT } from './fake-ports';

const WSL_AUTHORITY = 'wsl+Ubuntu-24.04';

function setup(viaWsl: (port: number) => boolean) {
  const { tunnels, calls } = fakeTunnels();
  const { store } = fakeStore();
  const made = forwarding({ tunnels, store, authorityOf: () => WSL_AUTHORITY, viaWsl: async () => viaWsl });
  return { ...made, tunnels, calls };
}

describe('ports WSL forwards itself', () => {
  it('lists a port WSL forwards with no tunnel, on its own port number, and lets the browser reach it', async () => {
    const { forwarding: ports, calls, detected } = setup((port) => port === 5173);
    const networks: Array<readonly number[]> = [];
    ports.onClientNetwork((network) => networks.push(network.allowedPorts));
    await ports.connected(HOST);
    await ports.candidates(HOST, [candidate(5173), candidate(8080)]);
    const rows = ports.view(HOST).rows;
    expect(rows.find((row) => row.remotePort === 5173)).toMatchObject({ state: 'forwarded', localPort: 5173, viaWsl: true, liveConnections: 0 });
    expect(rows.find((row) => row.remotePort === 8080)).not.toHaveProperty('viaWsl');
    expect(calls.map((call) => call.remote.port)).toEqual([8080]);
    expect(networks.at(-1)).toEqual([5173, 8080]);
    expect(detected).toEqual([{ action: 'notify', port: 5173 }, { action: 'notify', port: 8080 }]);
  });

  it('tunnels a port a Windows program other than WSL\'s relay holds, on another local port', async () => {
    const { tunnels } = fakeTunnels(new Set([5173]));
    const { store } = fakeStore();
    const { forwarding: ports } = forwarding({ tunnels, store, authorityOf: () => WSL_AUTHORITY, viaWsl: async () => () => false });
    await ports.connected(HOST);
    await ports.candidates(HOST, [candidate(5173)]);
    expect(ports.view(HOST).rows[0]).toMatchObject({ state: 'forwarded', localPort: 5174 });
    expect(ports.view(HOST).rows[0]).not.toHaveProperty('viaWsl');
  });

  it('forwards an ignored port WSL forwards without a tunnel, which no Stop could reach, and saves no restore entry', async () => {
    const { tunnels, calls } = fakeTunnels();
    const { store, ports: stored } = fakeStore({ ...EMPTY_HOST_PORTS, attributes: { '5173': { onDetect: 'ignore' } } });
    const { forwarding: ports } = forwarding({ tunnels, store, authorityOf: () => WSL_AUTHORITY, viaWsl: async () => () => true });
    await ports.connected(HOST);
    await ports.candidates(HOST, [candidate(5173)]);
    const key = ports.view(HOST).rows[0]!.key;
    expect(ports.view(HOST).rows[0]).toMatchObject({ state: 'ignored', viaWsl: true });
    expect((await ports.forwardRow(PROJECT, HOST, key)).localPort).toBe(5173);
    expect((await ports.forwardManual(PROJECT, HOST, { port: 5173 }, 'vite')).localPort).toBe(5173);
    expect(calls).toEqual([]);
    expect(ports.view(HOST).rows[0]).toMatchObject({ state: 'forwarded', localPort: 5173, viaWsl: true, label: 'vite' });
    expect(stored().restore).toEqual({});
    // the row goes with its listener, as WSL's forward does
    await ports.candidates(HOST, []);
    expect(ports.view(HOST).rows).toEqual([]);
  });

  it('refuses Stop forwarding and Change local port on a port WSL forwards, and hands the page its own port', async () => {
    const { forwarding: ports } = setup(() => true);
    await ports.connected(HOST);
    await ports.candidates(HOST, [candidate(5173)]);
    const key = ports.view(HOST).rows[0]!.key;
    await expect(ports.stop(HOST, key)).rejects.toThrow(ViaWslError);
    await expect(ports.changeLocalPort(PROJECT, HOST, key, 6000)).rejects.toThrow(ViaWslError);
    const reached = await ports.forwardingFor(HOST).forward(WSL_AUTHORITY, { host: 'localhost', port: 5173 });
    expect(reached.localPort).toBe(5173);
    expect(ports.view(HOST).rows).toHaveLength(1);
  });
});
