import { describe, expect, it } from 'vitest';
import { candidate, fakeStore, fakeTunnels, forwarding, HOST } from './fake-ports';

const listeners = (count: number, from = 3000) => Array.from({ length: count }, (_, index) => candidate(from + index));

describe('the fallback to output-only detection', () => {
  it('forwards the threshold, switches the host at the next detected port, and keeps what it forwarded', async () => {
    const { tunnels, forwards } = fakeTunnels();
    const { store, ports } = fakeStore();
    const { forwarding: ports_, switched } = forwarding({ tunnels, store, fallbackThreshold: () => 20 });
    await ports_.connected(HOST);
    await ports_.candidates(HOST, listeners(25));
    expect(forwards.size).toBe(20);
    expect(switched).toEqual([20]);
    expect(ports().fallback).toBe('switched');
    const view = ports_.view(HOST);
    expect(view.autoForwardMode).toBe('outputOnly');
    expect(view.rows.filter((row) => row.state === 'forwarded')).toHaveLength(20);
    expect(view.rows.filter((row) => row.state === 'detected').map((row) => row.remotePort)).toEqual([3020, 3021, 3022, 3023, 3024]);
  });

  it('while switched, forwards a port only once output printed it', async () => {
    const { tunnels, forwards } = fakeTunnels();
    const { store } = fakeStore({ attributes: {}, restore: {}, fallback: 'switched' });
    const { forwarding: ports } = forwarding({ tunnels, store });
    await ports.connected(HOST);
    await ports.candidates(HOST, [candidate(4000)]);
    expect(forwards.size).toBe(0);
    await ports.urlSeen(HOST, 4000);
    expect([...forwards.values()].map((tunnel) => tunnel.remote.port)).toEqual([4000]);
    expect(ports.view(HOST).rows[0]).toMatchObject({ origin: 'output', state: 'forwarded' });
  });

  it('Undo forwards every listening port again and the host never switches again', async () => {
    const { tunnels, forwards } = fakeTunnels();
    const { store, ports } = fakeStore();
    const { forwarding: ports_, switched } = forwarding({ tunnels, store, fallbackThreshold: () => 20 });
    await ports_.connected(HOST);
    await ports_.candidates(HOST, listeners(25));
    await ports_.undoFallback(HOST);
    expect(ports().fallback).toBe('disabled');
    expect(forwards.size).toBe(25);
    await ports_.candidates(HOST, listeners(30));
    expect(forwards.size).toBe(30);
    expect(switched).toEqual([20]);
    expect(ports_.view(HOST).autoForwardMode).toBe('all');
  });

  it('never switches with a threshold of 0', async () => {
    const { tunnels, forwards } = fakeTunnels();
    const { store } = fakeStore();
    const { forwarding: ports, switched } = forwarding({ tunnels, store, fallbackThreshold: () => 0 });
    await ports.connected(HOST);
    await ports.candidates(HOST, listeners(25));
    expect(forwards.size).toBe(25);
    expect(switched).toEqual([]);
  });
});
