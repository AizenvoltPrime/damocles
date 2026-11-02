import { describe, expect, it } from 'vitest';
import { DESKTOP_CONFIGURATION, REMOTE_AUTO_FORWARD_PORTS_FALLBACK_SETTING, REMOTE_AUTO_FORWARD_PORTS_SETTING } from '../../../../local-services/desktop-configuration';
import { candidate, fakeStore, fakeTunnels, forwarding, HOST, PROJECT } from './fake-ports';

describe('damocles.desktop.remote.autoForwardPorts', () => {
  it('is on by default, with a fallback of 20', () => {
    expect(DESKTOP_CONFIGURATION[REMOTE_AUTO_FORWARD_PORTS_SETTING]).toMatchObject({ type: 'boolean', default: true });
    expect(DESKTOP_CONFIGURATION[REMOTE_AUTO_FORWARD_PORTS_FALLBACK_SETTING]).toMatchObject({ type: 'integer', default: 20, minimum: 0 });
  });

  it('off: a new listener and a printed URL are listed with a Forward action, and nothing listens until the user forwards it', async () => {
    const { tunnels, forwards } = fakeTunnels();
    const { store } = fakeStore();
    const { forwarding: ports, detected } = forwarding({ tunnels, store, autoForward: () => false });
    await ports.connected(HOST);
    await ports.candidates(HOST, [candidate(8000, { process: { name: 'python3', command: 'python3 -m http.server 8000' } })]);
    await ports.urlSeen(HOST, 8000);
    expect(forwards.size).toBe(0);
    expect(ports.view(HOST)).toMatchObject({ autoForward: false, rows: [{ remotePort: 8000, state: 'detected', processLabel: 'python3 (python3 -m http.server 8000)', liveConnections: 0 }] });
    await ports.forwardRow(PROJECT, HOST, 'localhost:8000');
    expect([...forwards.values()].map((tunnel) => tunnel.localPort)).toEqual([8000]);
    expect(detected).toEqual([]);
  });

  it('on: the listener forwards by itself', async () => {
    const { tunnels, forwards } = fakeTunnels();
    const { store } = fakeStore();
    const { forwarding: ports } = forwarding({ tunnels, store, autoForward: () => true });
    await ports.connected(HOST);
    await ports.candidates(HOST, [candidate(8000)]);
    expect(forwards.size).toBe(1);
    expect(ports.view(HOST).rows[0]).toMatchObject({ state: 'forwarded', origin: 'auto', localPort: 8000 });
  });

  it('forwards a printed port once something listens on it within the window, and not after it', async () => {
    const { tunnels, forwards } = fakeTunnels();
    const { store } = fakeStore({ attributes: {}, restore: {}, fallback: 'switched' });
    const { forwarding: ports, advance } = forwarding({ tunnels, store });
    await ports.connected(HOST);
    await ports.urlSeen(HOST, 5173);
    await ports.urlSeen(HOST, 6000);
    await ports.candidates(HOST, [candidate(5173)]);
    expect([...forwards.values()].map((tunnel) => tunnel.remote.port)).toEqual([5173]);
    advance(10_001);
    await ports.candidates(HOST, [candidate(5173), candidate(6000)]);
    expect([...forwards.values()].map((tunnel) => tunnel.remote.port)).toEqual([5173]);
  });

  it('one remote port is one row whichever loopback socket reports it', async () => {
    const { tunnels, forwards } = fakeTunnels();
    const { store } = fakeStore();
    const { forwarding: ports } = forwarding({ tunnels, store });
    await ports.connected(HOST);
    await ports.candidates(HOST, [candidate(3000, { bindAddress: '::', family: 6, host: '::1' }), candidate(3000)]);
    expect(forwards.size).toBe(1);
    expect([...forwards.values()][0]?.remote).toEqual({ host: '127.0.0.1', port: 3000 });
    expect(ports.view(HOST).rows).toHaveLength(1);
  });

  it('stops an automatic forward whose listener went away and keeps a manual one', async () => {
    const { tunnels, forwards } = fakeTunnels();
    const { store } = fakeStore();
    const { forwarding: ports } = forwarding({ tunnels, store });
    await ports.connected(HOST);
    await ports.candidates(HOST, [candidate(3000), candidate(4000)]);
    await ports.forwardRow(PROJECT, HOST, 'localhost:4000');
    await ports.candidates(HOST, []);
    expect([...forwards.keys()]).toEqual(['127.0.0.1:4000']);
    expect(ports.view(HOST).rows.map((row) => [row.remotePort, row.state])).toEqual([[4000, 'forwarded']]);
  });

  it('publishes the host\'s forwarded local ports and its switch for the browser proxy, before the forward resolves', async () => {
    const { tunnels } = fakeTunnels(new Set([5173]));
    const { store, setLocalNetwork } = fakeStore();
    const { forwarding: ports } = forwarding({ tunnels, store });
    const published: unknown[] = [];
    ports.onClientNetwork((network) => published.push(network));
    await ports.connected(HOST);
    const forwarded = await ports.forwardingFor(HOST).forward('ssh+host-1', { host: 'localhost', port: 5173 }).then((tunnel) => ({ tunnel, network: published.at(-1) }));
    expect(forwarded.network).toEqual({ authority: 'ssh+host-1', allowedPorts: [5174], allowLocalNetwork: false });
    expect(forwarded.tunnel.localPort).toBe(5174);
    setLocalNetwork(true);
    ports.settingsChanged();
    expect(published.at(-1)).toEqual({ authority: 'ssh+host-1', allowedPorts: [5174], allowLocalNetwork: true });
  });
});
