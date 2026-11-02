import { describe, expect, it, vi } from 'vitest';
import { EMPTY_HOST_PORTS, type HostPorts } from '../../host-store';
import { candidate, fakeStore, fakeTunnels, forwarding, HOST, PROJECT } from './fake-ports';

// fakeTunnels whose binds wait while held, as a listener that takes a while to start
function heldTunnels() {
  const made = fakeTunnels();
  const waiting: Array<() => void> = [];
  let held = false;
  const bind = made.tunnels.forward;
  made.tunnels.forward = async (authority, remote, options) => {
    if (held) await new Promise<void>((resolve) => waiting.push(resolve));
    return bind(authority, remote, options);
  };
  return {
    ...made,
    hold: () => { held = true; },
    release: () => {
      held = false;
      for (const resolve of waiting.splice(0)) resolve();
    },
    binding: () => waiting.length,
  };
}

const manual = (port: number) => ({ host: 'localhost', port, manual: true, lastUsed: 1_000_000 });

describe('one host\'s port work, in order', () => {
  it('applies two lists one after the other, so a port the newer list dropped leaves no forward behind', async () => {
    const { tunnels, forwards, hold, release, binding } = heldTunnels();
    const { store } = fakeStore();
    const { forwarding: ports } = forwarding({ tunnels, store });
    await ports.connected(HOST);
    hold();
    const older = ports.candidates(HOST, [candidate(5173)]);
    const newer = ports.candidates(HOST, []);
    await vi.waitFor(() => expect(binding()).toBe(1));
    release();
    await Promise.all([older, newer]);
    expect([...forwards.keys()]).toEqual([]);
    expect(ports.view(HOST).rows).toEqual([]);
  });

  it('runs a detected port\'s action once when its URL is printed while the list is forwarding it', async () => {
    const { tunnels, calls, hold, release, binding } = heldTunnels();
    const { store } = fakeStore({ ...EMPTY_HOST_PORTS, attributes: { '5173': { onDetect: 'openPane' } } });
    const { forwarding: ports, detected } = forwarding({ tunnels, store });
    await ports.connected(HOST);
    hold();
    const listed = ports.candidates(HOST, [candidate(5173)]);
    await vi.waitFor(() => expect(binding()).toBe(1));
    const printed = ports.urlSeen(HOST, 5173);
    release();
    await Promise.all([listed, printed]);
    expect(calls).toHaveLength(1);
    expect(detected).toEqual([{ action: 'openPane', port: 5173 }]);
  });

  it('stops a restored forward that bound after the host disconnected, and restores nothing more', async () => {
    const { tunnels, forwards, calls, hold, release, binding } = heldTunnels();
    const { store } = fakeStore({ ...EMPTY_HOST_PORTS, restore: { [PROJECT]: { 'localhost:9000': manual(9000), 'localhost:9001': manual(9001) } } });
    const { forwarding: ports } = forwarding({ tunnels, store });
    hold();
    const connecting = ports.connected(HOST);
    await vi.waitFor(() => expect(binding()).toBe(1));
    ports.disconnected(HOST);
    release();
    await connecting;
    expect(calls.map((call) => call.remote.port)).toEqual([9000]);
    expect([...forwards.keys()]).toEqual([]);
    expect(ports.view(HOST).rows).toEqual([]);
  });

  it('restores nothing once the host disconnected while the restore entries were being saved', async () => {
    const { tunnels, calls } = fakeTunnels();
    const memory = fakeStore({ ...EMPTY_HOST_PORTS, restore: { [PROJECT]: { 'localhost:9000': manual(9000) } } });
    let saved!: () => void;
    const store = {
      ...memory.store,
      updatePorts: async (hostId: string, apply: (current: HostPorts) => HostPorts) => {
        await new Promise<void>((resolve) => { saved = resolve; });
        await memory.store.updatePorts(hostId, apply);
      },
    };
    const { forwarding: ports } = forwarding({ tunnels, store });
    const connecting = ports.connected(HOST);
    await vi.waitFor(() => expect(saved).toBeDefined());
    ports.disconnected(HOST);
    saved();
    await connecting;
    expect(calls).toEqual([]);
  });

  it('stops Undo\'s forwards once the host disconnected mid-way', async () => {
    const { tunnels, forwards, calls, hold, release, binding } = heldTunnels();
    const { store } = fakeStore({ ...EMPTY_HOST_PORTS, fallback: 'switched' });
    const { forwarding: ports } = forwarding({ tunnels, store });
    await ports.connected(HOST);
    await ports.candidates(HOST, [candidate(5173), candidate(5174)]);
    expect(calls).toEqual([]);
    hold();
    const undoing = ports.undoFallback(HOST);
    await vi.waitFor(() => expect(binding()).toBe(1));
    ports.disconnected(HOST);
    release();
    await undoing;
    expect(calls.map((call) => call.remote.port)).toEqual([5173]);
    expect([...forwards.keys()]).toEqual([]);
  });

  it('stops a list\'s forwards once the host disconnected mid-list', async () => {
    const { tunnels, forwards, calls, hold, release, binding } = heldTunnels();
    const { store } = fakeStore();
    const { forwarding: ports, detected } = forwarding({ tunnels, store });
    await ports.connected(HOST);
    hold();
    const listed = ports.candidates(HOST, [candidate(5173), candidate(5174)]);
    await vi.waitFor(() => expect(binding()).toBe(1));
    ports.disconnected(HOST);
    release();
    await listed;
    expect(calls.map((call) => call.remote.port)).toEqual([5173]);
    expect([...forwards.keys()]).toEqual([]);
    expect(detected).toEqual([]);
    expect(ports.view(HOST).rows).toEqual([]);
  });

  it('refuses the user\'s and the browser\'s forwards that waited behind a list the host disconnected during', async () => {
    const { tunnels, forwards, hold, release, binding } = heldTunnels();
    const { store } = fakeStore();
    const { forwarding: ports } = forwarding({ tunnels, store });
    await ports.connected(HOST);
    hold();
    const listed = ports.candidates(HOST, [candidate(5173)]);
    await vi.waitFor(() => expect(binding()).toBe(1));
    const manualForward = ports.forwardManual(PROJECT, HOST, { port: 9000 }, undefined);
    const browserForward = ports.forwardingFor(HOST).forward('ssh+host-1', { host: 'localhost', port: 8080 });
    ports.disconnected(HOST);
    release();
    await listed;
    await expect(manualForward).rejects.toThrow('host-1 is not connected');
    await expect(browserForward).rejects.toThrow('host-1 is not connected');
    expect([...forwards.keys()]).toEqual([]);
  });

  it('restores the forwards after one that fails', async () => {
    const { tunnels, forwards } = fakeTunnels();
    const bind = tunnels.forward;
    tunnels.forward = async (authority, remote, options) => {
      if (remote.port === 9000) throw Object.assign(new Error('listen EPERM'), { code: 'EPERM' });
      return bind(authority, remote, options);
    };
    const { store } = fakeStore({ ...EMPTY_HOST_PORTS, restore: { [PROJECT]: { 'localhost:9000': manual(9000), 'localhost:9001': manual(9001) } } });
    const lines: string[] = [];
    const { forwarding: ports } = forwarding({ tunnels, store, log: (line) => lines.push(line) });
    await ports.connected(HOST);
    expect([...forwards.keys()]).toEqual(['localhost:9001']);
    expect(lines).toContain('[ports] host-1: restoring the forward of localhost:9000 failed: listen EPERM');
  });
});
