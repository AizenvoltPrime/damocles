import { describe, expect, it } from 'vitest';
import { DETECTED_ACTIONS_PER_WINDOW, DETECTED_ACTIONS_WINDOW_MS } from '../port-forwarding';
import { ForwardLimitError, tunnelKey } from '../tunnels';
import { AUTHORITY, candidate, fakeStore, fakeTunnels, forwarding, HOST } from './fake-ports';

const listeners = (count: number, from = 3000) => Array.from({ length: count }, (_, index) => candidate(from + index));

// fake tunnels that refuse a new forward once `limit` are live, as TunnelManager does at MAX_FORWARDS_PER_HOST
function limitedTunnels(limit: number) {
  const fake = fakeTunnels();
  const tunnels: typeof fake.tunnels = {
    ...fake.tunnels,
    forward: async (authority, remote, options) => {
      if (fake.forwards.size >= limit && !fake.forwards.has(tunnelKey(remote))) throw new ForwardLimitError(authority);
      return fake.tunnels.forward(authority, remote, options);
    },
  };
  return { ...fake, tunnels };
}

describe('what a target can make this computer do in bulk', () => {
  it(`runs at most ${DETECTED_ACTIONS_PER_WINDOW} detected-port notices per host in a window`, async () => {
    const { tunnels, forwards } = fakeTunnels();
    const { store } = fakeStore();
    const { forwarding: ports, detected, advance } = forwarding({ tunnels, store, fallbackThreshold: () => 0 });
    await ports.connected(HOST);
    await ports.candidates(HOST, listeners(3 * DETECTED_ACTIONS_PER_WINDOW));
    expect(forwards.size).toBe(3 * DETECTED_ACTIONS_PER_WINDOW);
    expect(detected).toHaveLength(DETECTED_ACTIONS_PER_WINDOW);
    advance(DETECTED_ACTIONS_WINDOW_MS);
    await ports.candidates(HOST, listeners(4 * DETECTED_ACTIONS_PER_WINDOW));
    expect(detected).toHaveLength(2 * DETECTED_ACTIONS_PER_WINDOW);
  });

  it('lists the ports past the forward limit as detected, goes on with the rest, and leaves no row for a refused rewrite', async () => {
    const { tunnels, forwards } = limitedTunnels(3);
    const { store } = fakeStore();
    const { forwarding: ports } = forwarding({ tunnels, store, fallbackThreshold: () => 0 });
    await ports.connected(HOST);
    await ports.candidates(HOST, listeners(5));
    expect(forwards.size).toBe(3);
    expect(ports.view(HOST).rows.map((row) => [row.remotePort, row.state])).toEqual([[3000, 'forwarded'], [3001, 'forwarded'], [3002, 'forwarded'], [3003, 'detected'], [3004, 'detected']]);
    await expect(ports.forwardingFor(HOST).forward(AUTHORITY, { host: 'localhost', port: 9000 })).rejects.toBeInstanceOf(ForwardLimitError);
    expect(ports.view(HOST).rows).toHaveLength(5);
  });
});
