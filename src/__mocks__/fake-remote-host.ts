import { vi } from 'vitest';
import type { ActiveEditorContext } from '../platform/editor-service';
import type { ClientSnapshots, ClientTopic, RemoteHost } from '../platform/remote-host';
import type { PanelHost, TerminalToggle } from '../platform/window-service';
import type { BrokerAnswer, ClientPending, ClientPolicy, ClientUser, HeldAuth, RelayedMcpServer } from '../shared/remote-user';
import type { ClientForges } from '../shared/git-credential';

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
    clientMcp: new Map<string, readonly RelayedMcpServer[]>(),
    clientForges: new Map<string, ClientForges>(),
  };
  const mcpPending = new Map<string, ClientPending>();
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
    anyAttached: () => attached.size > 0,
    attachedClients: () => [...attached],
    auth: (id) => maps.clientAuth.get(id),
    user: (id) => maps.clientUser.get(id),
    policy: (id) => maps.clientPolicy.get(id),
    editor: (id) => maps.clientEditor.get(id)?.context,
    terminal: (id) => maps.clientTerminal.get(id),
    language: (id) => maps.clientLanguage.get(id)?.language,
    mcp: (id) => maps.clientMcp.get(id),
    mcpPending: (id) => mcpPending.get(id),
    mcpClients: () => [...maps.clientMcp.keys()],
    forges: (id) => maps.clientForges.get(id),
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
  const remote: RemoteHost = {
    hostId: 'host-1',
    clients,
    agentSocket: (clientId) => (agentFolder === undefined ? undefined : `${agentFolder}/agent-of-${clientId}.sock`),
    credentials: vi.fn(answer),
    speak,
    runProviders: vi.fn(),
    browserTool: vi.fn(async () => ({ content: [] })),
    browserRelease: vi.fn(async () => {}),
    browserDiscard: vi.fn(async () => {}),
    shellOutput: () => ({ write: () => undefined, end: () => undefined }),
    memorySearch: vi.fn(async () => []),
    memoryProfile: vi.fn(async () => ({ profile: { static: '', dynamic: '' }, pinned: [], preferences: [] })),
    memoryResolve: vi.fn(async () => []),
    memoryApply: vi.fn(async (_clientId: string, entries: readonly { readonly end: number; readonly write: { readonly uuid: string } }[]) => ({ through: entries.at(-1)?.end ?? 0, ids: entries.map((entry) => entry.write.uuid) })),
    memoryList: vi.fn(async () => ({ rows: [] })),
    heldMemoryChanged: vi.fn(),
    mcpCall: vi.fn(async () => ({ content: [] })),
    forgeTool: vi.fn(async () => ({ text: '' })),
    forgeDescribe: vi.fn(async () => ({ ok: true as const, project: '', target: { serverId: '', repoPath: '', accountId: '' } })),
    mcpResources: vi.fn(async () => ({ resources: [] })),
    mcpReadResource: vi.fn(async () => ({ contents: [] })),
  };
  const set = <K extends keyof typeof maps>(topic: K, clientId: string, value: (typeof maps)[K] extends Map<string, infer V> ? V | undefined : never): void => {
    const map = maps[topic] as Map<string, unknown>;
    const before = map.get(clientId);
    if (topic === 'clientAuth') {
      if (value === undefined) attached.delete(clientId);
      else attached.add(clientId);
    }
    // a detached client's clientAuth and clientMcp stay, as clients.ts keeps them
    if (topic === 'clientMcp' && value !== undefined) mcpPending.delete(clientId);
    if (value !== undefined) map.set(clientId, value);
    else if (topic !== 'clientAuth' && topic !== 'clientMcp') map.delete(clientId);
    fire({ topic, clientId, before, ...(value === undefined ? { detached: true as const } : {}) });
  };
  return {
    remote,
    set,
    // a clientMcp marked not read yet, which holds no servers
    setMcpPending: (clientId: string, reason: ClientPending): void => {
      const before = maps.clientMcp.get(clientId);
      maps.clientMcp.set(clientId, []);
      mcpPending.set(clientId, reason);
      fire({ topic: 'clientMcp', clientId, before });
    },
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
