import { afterEach, describe, expect, it } from 'vitest';
import { candidatePorts, isPrivileged, PRIVILEGED_FALLBACK_FROM, refusalOf } from '../reserved-ports';
import { TunnelManager } from '../tunnels';

const created: TunnelManager[] = [];
afterEach(() => {
  for (const tunnels of created.splice(0)) tunnels.stopAll('ssh+h');
});

describe('a privileged remote port on a POSIX client', () => {
  it.each(['linux', 'darwin'] as const)('maps below 1024 to the next free port at or above 4000 on %s', (platform) => {
    expect(isPrivileged(80, platform)).toBe(true);
    expect(isPrivileged(1024, platform)).toBe(false);
    expect(candidatePorts(80, new Set(), platform).next().value).toBe(PRIVILEGED_FALLBACK_FROM);
    expect(candidatePorts(1023, new Set([4000]), platform).next().value).toBe(4001);
    expect(refusalOf(443, new Set(), platform)).toBe('privileged');
  });

  it('keeps its own number on a Windows client, which binds it without elevation', () => {
    expect(isPrivileged(80, 'win32')).toBe(false);
    expect(candidatePorts(80, new Set(), 'win32').next().value).toBe(80);
    expect(refusalOf(80, new Set(), 'win32')).toBeUndefined();
  });

  it('a forward from a POSIX client listens at or above 4000 and is refused a privileged local port', async () => {
    const tunnels = new TunnelManager({ opener: () => undefined, reserved: new Set(), clientPlatform: 'linux', log: () => undefined });
    created.push(tunnels);
    const tunnel = await tunnels.forward('ssh+h', { host: '127.0.0.1', port: 80 });
    expect(tunnel.localPort).toBeGreaterThanOrEqual(PRIVILEGED_FALLBACK_FROM);
    await expect(tunnels.changeLocalPort('ssh+h', tunnel.key, 81)).rejects.toMatchObject({ code: 'privileged', port: 81 });
    expect(tunnels.get('ssh+h', tunnel.key)?.localPort).toBe(tunnel.localPort);
  });
});
