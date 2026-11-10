import type { PortCandidate } from '../../../../daemon/ports/ports-messages';
import { EMPTY_HOST_PORTS, type HostPorts } from '../../host-store';
import { PortForwarding, type PortForwardingDeps } from '../port-forwarding';
import { PortRefusedError, tunnelKey, type Tunnel, type TunnelManager, type TunnelTarget } from '../tunnels';
import { listeners } from '../../../../../remote/listeners';

export const HOST = 'host-1';
export const AUTHORITY = 'ssh+host-1';
export const PROJECT = 'ssh+host-1|/srv/app';

/** A TunnelManager that binds nothing: each forward takes its local port from `taken` and the rules of the test. */
export function fakeTunnels(taken: Set<number> = new Set()) {
  const forwards = new Map<string, Tunnel>();
  const changes = listeners<[string]>();
  const calls: Array<{ readonly remote: TunnelTarget; readonly localPort?: number }> = [];
  const tunnels: Pick<TunnelManager, 'forward' | 'stop' | 'stopAll' | 'list' | 'get' | 'changeLocalPort' | 'onDidChange'> = {
    forward: async (authority, remote, options) => {
      calls.push({ remote, ...(options?.localPort !== undefined ? { localPort: options.localPort } : {}) });
      const key = tunnelKey(remote);
      const live = forwards.get(key);
      if (live) return live;
      let port = options?.localPort ?? remote.port;
      if (taken.has(port)) {
        if (options?.requireLocalPort) throw new PortRefusedError('inUse', port);
        while (taken.has(port)) port++;
      }
      const tunnel: Tunnel = { authority, key, remote, localPort: port, localAddresses: ['127.0.0.1'], liveConnections: 0 };
      forwards.set(key, tunnel);
      changes.fire(authority);
      return tunnel;
    },
    changeLocalPort: async (authority, key, localPort) => {
      const live = forwards.get(key);
      if (!live) throw new Error('no forward');
      if (taken.has(localPort)) throw new PortRefusedError('inUse', localPort);
      const moved = { ...live, localPort };
      forwards.set(key, moved);
      changes.fire(authority);
      return moved;
    },
    stop: (authority, key) => {
      if (forwards.delete(key)) changes.fire(authority);
    },
    stopAll: (authority) => {
      forwards.clear();
      changes.fire(authority);
    },
    list: () => [...forwards.values()],
    get: (_authority, key) => forwards.get(key),
    onDidChange: changes.add,
  };
  return { tunnels, forwards, calls };
}

/** The host store's port state in memory. */
export function fakeStore(initial: HostPorts = EMPTY_HOST_PORTS) {
  let ports = initial;
  let localNetwork = false;
  return {
    store: {
      ports: () => ports,
      updatePorts: async (_hostId: string, apply: (current: HostPorts) => HostPorts) => {
        ports = apply(ports);
      },
      localNetwork: () => localNetwork,
    },
    ports: () => ports,
    setLocalNetwork: (on: boolean) => {
      localNetwork = on;
    },
  };
}

export const candidate = (port: number, extra: Partial<PortCandidate> = {}): PortCandidate => ({ port, bindAddress: '0.0.0.0', family: 4, host: '127.0.0.1', ...extra });

export function forwarding(overrides: Partial<PortForwardingDeps> & Pick<PortForwardingDeps, 'tunnels' | 'store'>) {
  const detected: Array<{ readonly action: string; readonly port: number }> = [];
  const switched: number[] = [];
  let now = 1_000_000;
  const deps: PortForwardingDeps = {
    autoForward: () => true,
    fallbackThreshold: () => 20,
    projectsOf: () => [PROJECT],
    authorityOf: (hostId) => `ssh+${hostId}`,
    viaWsl: async () => () => false,
    detected: (_hostId, action, tunnel) => detected.push({ action, port: tunnel.remote.port }),
    fallbackSwitched: (_hostId, count) => switched.push(count),
    servedPorts: () => [],
    onServedChange: () => ({ dispose: () => undefined }),
    now: () => now,
    log: () => undefined,
    ...overrides,
  };
  return { forwarding: new PortForwarding(deps), detected, switched, advance: (ms: number) => { now += ms; }, now: () => now };
}
