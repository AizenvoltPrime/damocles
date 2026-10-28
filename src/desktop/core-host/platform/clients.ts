import type { Disposable } from '../../../platform/disposable';
import type { ClientSnapshots, ClientTopic, RemoteHost } from '../../../platform/remote-host';
import type { PanelHost } from '../../../platform/window-service';
import { heldClientAuth, type HeldAuth } from '../../../shared/remote-user';
import type { ClientAuth, ClientPolicy, ClientUser, CoreEndpoint, CoreInit } from '../../core-protocol';
import { currentActor } from '../../core-protocol/actor';
import { agentSocketFile } from '../../core-protocol/agent-sockets';
import { Listeners } from './listeners';

/** The per-client mirrors the daemon publishes (core-routes.ts perClient and actingClient), read synchronously. */
export function createClientSnapshots(endpoint: CoreEndpoint, init: CoreInit): ClientSnapshots & Disposable {
  const auth = new Map<string, HeldAuth>(Object.entries(init.mirrors.clientAuth).map(([clientId, value]) => [clientId, heldClientAuth(value, Date.now())]));
  const user = new Map<string, ClientUser>(Object.entries(init.mirrors.clientUser));
  const policy = new Map<string, ClientPolicy>(Object.entries(init.mirrors.clientPolicy));
  // the daemon publishes clientAuth on every attach and without a value on every detach
  const attached = new Set(Object.keys(init.mirrors.clientAuth));
  let acting = init.mirrors.actingClient.clientId;
  const changed = new Listeners<[{ readonly topic: ClientTopic; readonly clientId?: string; readonly before?: unknown }]>('client snapshots');
  // keepDetached: a detach (a delta without a value) keeps the client's last value, which its pinned runs go on reading
  const track = <W, T>(topic: 'clientAuth' | 'clientUser' | 'clientPolicy', map: Map<string, T>, held: (value: W) => T, keepDetached = false) =>
    endpoint.onMirror(topic, (patch) => {
      // the daemon stamps every delta it forwards
      if (patch.clientId === undefined) return;
      if (topic === 'clientAuth') {
        if (patch.value === undefined) attached.delete(patch.clientId);
        else attached.add(patch.clientId);
      }
      const before = map.get(patch.clientId);
      if (patch.value === undefined && !keepDetached) map.delete(patch.clientId);
      else if (patch.value !== undefined) map.set(patch.clientId, held(patch.value as W));
      changed.fire({ topic, clientId: patch.clientId, before });
    });
  const subscriptions = [
    // a pin copies its client's user and policy, but reads its clientAuth live (allowance transport, key presence, account state)
    track('clientAuth', auth, (value: ClientAuth) => heldClientAuth(value, Date.now()), true),
    track('clientUser', user, (value: ClientUser) => value),
    track('clientPolicy', policy, (value: ClientPolicy) => value),
    endpoint.onMirror('actingClient', (patch) => {
      acting = patch.clientId;
      changed.fire({ topic: 'actingClient' });
    }),
  ];
  return {
    actor: currentActor,
    // a timer or watcher made inside a served request keeps its actor for life, so a detached actor is not acting
    acting: () => {
      const actor = currentActor();
      return actor !== undefined && attached.has(actor) ? actor : acting;
    },
    attached: (clientId) => attached.has(clientId),
    auth: (clientId) => auth.get(clientId),
    user: (clientId) => user.get(clientId),
    policy: (clientId) => policy.get(clientId),
    onDidChange: (cb) => changed.add(cb),
    dispose: () => {
      for (const subscription of subscriptions) subscription.dispose();
      changed.clear();
    },
  };
}

/** A daemon's core's link to its clients: the snapshots, the agent sockets, the broker's ask and spoken replies. */
export function createRemoteHost(endpoint: CoreEndpoint, init: CoreInit & { readonly remote: { readonly hostId: string; readonly agentFolder?: string } }, clients: ClientSnapshots, viewIdOf: (host: PanelHost) => string | undefined): RemoteHost & Disposable {
  let agentFolder = init.remote.agentFolder;
  const moved = endpoint.onMirror('hostSockets', (patch) => {
    agentFolder = patch.agentFolder;
  });
  return {
    hostId: init.remote.hostId,
    clients,
    agentSocket: (clientId) => (agentFolder === undefined ? undefined : agentSocketFile(agentFolder, clientId)),
    credentials: (provider, clientId) => endpoint.request('user.credentials', { provider, clientId }),
    speak: async (host, text) => {
      const viewId = viewIdOf(host);
      if (viewId === undefined) throw new Error('The chat that replied has no view');
      await endpoint.request('user.voice.speak', { viewId, text });
    },
    runProviders: (panelId, providers) => endpoint.emit('chat.providers', { panelId, providers }),
    dispose: () => moved.dispose(),
  };
}
