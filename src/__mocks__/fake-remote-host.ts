import { vi } from 'vitest';
import type { ActiveEditorContext } from '../platform/editor-service';
import type { ClientSnapshots, ClientTopic, RemoteHost } from '../platform/remote-host';
import type { PanelHost, TerminalToggle } from '../platform/window-service';
import type { BrokerAnswer, ClientPolicy, ClientUser, HeldAuth } from '../shared/remote-user';

type Change = { readonly topic: ClientTopic; readonly clientId?: string; readonly before?: unknown; readonly detached?: true };

/** A daemon's core's RemoteHost over in-memory per-client mirrors, as core-host/platform/clients.ts keeps them. */
export function createFakeRemoteHost(answer: (provider: string, clientId: string) => Promise<BrokerAnswer> = async () => ({ type: 'none' })) {
  // the acting client is attached with no sign-in, as clients.ts seeds it from core's init
  let acting: string | undefined = 'client-a';
  const maps = {
    clientAuth: new Map<string, HeldAuth>([['client-a', { providers: {} }]]),
    clientUser: new Map<string, ClientUser>(),
    clientPolicy: new Map<string, ClientPolicy>(),
    clientEditor: new Map<string, { readonly context?: ActiveEditorContext }>(),
    clientTerminal: new Map<string, TerminalToggle>(),
    clientLanguage: new Map<string, { readonly language: 'en' | 'el' }>(),
  };
  const listeners = new Set<(change: Change) => void>();
  const attached = new Set<string>(['client-a']);
  let actor: string | undefined;
  const fire = (change: Change): void => {
    for (const cb of [...listeners]) cb(change);
  };
  const clients: ClientSnapshots = {
    actor: () => actor,
    acting: () => (actor !== undefined && attached.has(actor) ? actor : acting),
    attached: (id) => attached.has(id),
    auth: (id) => maps.clientAuth.get(id),
    user: (id) => maps.clientUser.get(id),
    policy: (id) => maps.clientPolicy.get(id),
    editor: (id) => maps.clientEditor.get(id)?.context,
    terminal: (id) => maps.clientTerminal.get(id),
    language: (id) => maps.clientLanguage.get(id)?.language,
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
  // a target with no agent proxy until setAgentFolder names one
  let agentFolder: string | undefined;
  const remote: RemoteHost = { hostId: 'host-1', clients, agentSocket: (clientId) => (agentFolder === undefined ? undefined : `${agentFolder}/agent-of-${clientId}.sock`), credentials: vi.fn(answer), speak, runProviders: vi.fn() };
  const set = <K extends keyof typeof maps>(topic: K, clientId: string, value: (typeof maps)[K] extends Map<string, infer V> ? V | undefined : never): void => {
    const map = maps[topic] as Map<string, unknown>;
    const before = map.get(clientId);
    if (topic === 'clientAuth') {
      if (value === undefined) attached.delete(clientId);
      else attached.add(clientId);
    }
    // a detached client's clientAuth stays, as clients.ts keeps it
    if (value !== undefined) map.set(clientId, value);
    else if (topic !== 'clientAuth') map.delete(clientId);
    fire({ topic, clientId, before, ...(value === undefined ? { detached: true as const } : {}) });
  };
  return {
    remote,
    set,
    showView: (host: PanelHost): void => {
      viewed.add(host);
    },
    // the client a served request or panel message came from, as the daemon stamps it
    setActor: (clientId: string | undefined): void => {
      actor = clientId;
    },
    setActing: (clientId: string | undefined): void => {
      acting = clientId;
      fire({ topic: 'actingClient' });
    },
    setAgentFolder: (folder: string | undefined): void => {
      agentFolder = folder;
    },
  };
}
