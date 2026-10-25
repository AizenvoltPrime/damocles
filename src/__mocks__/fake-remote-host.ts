import { vi } from 'vitest';
import type { ClientSnapshots, ClientTopic, RemoteHost } from '../platform/remote-host';
import type { PanelHost } from '../platform/window-service';
import type { BrokerAnswer, ClientPolicy, ClientUser, HeldAuth } from '../shared/remote-user';

type Change = { readonly topic: ClientTopic; readonly clientId?: string; readonly before?: unknown };

/** A daemon's core's RemoteHost over in-memory per-client mirrors, as core-host/platform/clients.ts keeps them. */
export function createFakeRemoteHost(answer: (provider: string, clientId: string) => Promise<BrokerAnswer> = async () => ({ type: 'none' })) {
  let acting: string | undefined = 'client-a';
  const maps = { clientAuth: new Map<string, HeldAuth>(), clientUser: new Map<string, ClientUser>(), clientPolicy: new Map<string, ClientPolicy>() };
  const listeners = new Set<(change: Change) => void>();
  const fire = (change: Change): void => {
    for (const cb of [...listeners]) cb(change);
  };
  const clients: ClientSnapshots = {
    acting: () => acting,
    auth: (id) => maps.clientAuth.get(id),
    user: (id) => maps.clientUser.get(id),
    policy: (id) => maps.clientPolicy.get(id),
    onDidChange: (cb) => {
      listeners.add(cb);
      return { dispose: () => { listeners.delete(cb); } };
    },
  };
  // the chats a client shows; speak refuses any other, as the daemon's core does
  const viewed = new Set<PanelHost>();
  const speak = vi.fn(async (host: PanelHost) => {
    if (!viewed.has(host)) throw new Error('The chat that replied has no view');
  });
  const remote: RemoteHost = { hostId: 'host-1', clients, credentials: vi.fn(answer), speak, runProviders: vi.fn() };
  const set = <K extends keyof typeof maps>(topic: K, clientId: string, value: (typeof maps)[K] extends Map<string, infer V> ? V | undefined : never): void => {
    // a detached client's clientAuth stays, as clients.ts keeps it
    if (topic === 'clientAuth' && value === undefined) return;
    const map = maps[topic] as Map<string, unknown>;
    const before = map.get(clientId);
    if (value === undefined) map.delete(clientId);
    else map.set(clientId, value);
    fire({ topic, clientId, before });
  };
  return {
    remote,
    set,
    showView: (host: PanelHost): void => {
      viewed.add(host);
    },
    setActing: (clientId: string | undefined): void => {
      acting = clientId;
      fire({ topic: 'actingClient' });
    },
  };
}
