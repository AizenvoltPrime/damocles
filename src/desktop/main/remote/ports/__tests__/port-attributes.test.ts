import { describe, expect, it } from 'vitest';
import { EMPTY_HOST_PORTS, type HostPorts } from '../../host-store';
import { attributesOf } from '../port-forwarding';
import { candidate, fakeStore, fakeTunnels, forwarding, HOST, PROJECT } from './fake-ports';

const withAttributes = (attributes: HostPorts['attributes']): HostPorts => ({ ...EMPTY_HOST_PORTS, attributes });

describe('port attributes', () => {
  it('takes an exact port over a range, and the narrowest range over a wider one', () => {
    const ports = withAttributes({ '3000-3999': { onDetect: 'silent', label: 'wide' }, '3000-3010': { onDetect: 'openBrowser', label: 'narrow' }, '3005': { onDetect: 'openPane', label: 'exact' } });
    expect(attributesOf(ports, 3005)).toEqual({ onDetect: 'openPane', label: 'exact' });
    expect(attributesOf(ports, 3006)).toEqual({ onDetect: 'openBrowser', label: 'narrow' });
    expect(attributesOf(ports, 3500)).toEqual({ onDetect: 'silent', label: 'wide' });
    expect(attributesOf(ports, 4000)).toEqual({});
  });

  it.each([
    ['notify', ['notify']],
    ['openPane', ['openPane']],
    ['openBrowser', ['openBrowser']],
    ['silent', []],
  ] as const)('runs %s once the detected port is forwarded', async (onDetect, actions) => {
    const { tunnels, forwards } = fakeTunnels();
    const { store } = fakeStore(withAttributes({ '5173': { onDetect } }));
    const { forwarding: ports, detected } = forwarding({ tunnels, store });
    await ports.connected(HOST);
    await ports.candidates(HOST, [candidate(5173)]);
    expect(forwards.size).toBe(1);
    expect(detected.map((entry) => entry.action)).toEqual(actions);
    expect(ports.view(HOST).rows[0]).toMatchObject({ onDetect, state: 'forwarded' });
  });

  it('notifies only the first forward of a port in the run, and opens a pane on each detection again', async () => {
    const { tunnels } = fakeTunnels();
    const { store } = fakeStore(withAttributes({ '8000': { onDetect: 'openPane' } }));
    const { forwarding: ports, detected } = forwarding({ tunnels, store });
    await ports.connected(HOST);
    for (let round = 0; round < 2; round++) {
      await ports.candidates(HOST, [candidate(5173), candidate(8000)]);
      await ports.candidates(HOST, []);
    }
    expect(detected).toEqual([{ action: 'notify', port: 5173 }, { action: 'openPane', port: 8000 }, { action: 'openPane', port: 8000 }]);
  });

  it('lists an ignored port without forwarding it, and Forward a Port still forwards it', async () => {
    const { tunnels, forwards } = fakeTunnels();
    const { store } = fakeStore(withAttributes({ '9229': { onDetect: 'ignore' } }));
    const { forwarding: ports, detected } = forwarding({ tunnels, store });
    await ports.connected(HOST);
    await ports.candidates(HOST, [candidate(9229)]);
    await ports.urlSeen(HOST, 9229);
    expect(forwards.size).toBe(0);
    expect(ports.view(HOST).rows).toEqual([expect.objectContaining({ remotePort: 9229, state: 'ignored', onDetect: 'ignore' })]);
    await ports.forwardRow(PROJECT, HOST, 'localhost:9229');
    expect(forwards.size).toBe(1);
    expect(ports.view(HOST).rows[0]).toMatchObject({ state: 'forwarded', origin: 'manual' });
    expect(detected).toEqual([]);
  });

  it('keeps a label per host port, shown whether or not the port is forwarded, and clears it', async () => {
    const { tunnels } = fakeTunnels();
    const { store, ports: stored } = fakeStore();
    const { forwarding: ports } = forwarding({ tunnels, store, autoForward: () => false });
    await ports.connected(HOST);
    await ports.candidates(HOST, [candidate(5173)]);
    await ports.setLabel(HOST, 5173, 'vite');
    expect(stored().attributes['5173']).toEqual({ label: 'vite' });
    expect(ports.view(HOST).rows[0]).toMatchObject({ label: 'vite', state: 'detected' });
    await ports.setOnDetect(HOST, 5173, 'silent');
    await ports.setLabel(HOST, 5173, undefined);
    expect(stored().attributes['5173']).toEqual({ onDetect: 'silent' });
  });
});
