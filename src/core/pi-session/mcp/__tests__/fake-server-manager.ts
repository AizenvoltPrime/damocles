import { vi } from 'vitest';
import type { ReadResourceResult, Resource, ResourceTemplate } from '@earendil-works/pi-mcp';
import { McpClientManager } from '../mcp-client-manager';
import type { McpServerManager, McpServerManagerOptions, ServerConnection } from '../server-manager';
import type { McpServerSpec, McpTool } from '../types';
import type { McpServerConfig } from '../../../../shared/types/mcp';

/** A config as the trusted, user-scope, pi-format spec the host feeds a manager. */
export function specOf(config: McpServerConfig, over: Partial<McpServerSpec> = {}): McpServerSpec {
  return { config, valueFormat: 'pi', folderScoped: false, trusted: true, ...over };
}

/** What a fake server with the `resources` capability offers; `pageSize` splits its lists into cursor pages. */
export interface FakeResources {
  resources?: Resource[];
  templates?: ResourceTemplate[];
  pageSize?: number;
  /** `resources/read` answers by URI; an unknown URI reads as empty. */
  contents?: Record<string, ReadResourceResult['contents']>;
  /** `completion/complete` answers by argument name, filtered by prefix; absent answers no values. */
  completions?: Record<string, string[]>;
}

function pageOf<T>(items: readonly T[], cursor: string | undefined, pageSize: number | undefined): { items: T[]; nextCursor?: string } {
  const start = cursor === undefined ? 0 : Number(cursor);
  const end = pageSize === undefined ? items.length : start + pageSize;
  return { items: items.slice(start, end), ...(end < items.length ? { nextCursor: String(end) } : {}) };
}

/** A connection pool that never spawns: `connect` answers with the tools listed per server name. */
export function fakeServerManager(toolsByServer: Record<string, McpTool[]>, resourcesByServer: Record<string, FakeResources> = {}) {
  const connections = new Map<string, ServerConnection>();
  const connect = vi.fn(async (name: string) => {
    const conn = {
      tools: toolsByServer[name] ?? [],
      hasResources: Object.hasOwn(resourcesByServer, name),
      status: 'connected',
      serverInfo: { name, version: '1.0.0' },
      inFlight: 0,
      lastUsedAt: 0,
    } as unknown as ServerConnection;
    connections.set(name, conn);
    return conn;
  });
  const close = vi.fn(async (name: string) => {
    connections.delete(name);
  });
  const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }));
  const offered = (name: string): FakeResources => resourcesByServer[name] ?? {};
  const fake = {
    connect,
    close,
    callTool,
    listResourcesPage: vi.fn(async (name: string, cursor: string | undefined) => {
      const { items, nextCursor } = pageOf(offered(name).resources ?? [], cursor, offered(name).pageSize);
      return { resources: items, ...(nextCursor ? { nextCursor } : {}) };
    }),
    listResources: vi.fn(async (name: string) => [...(offered(name).resources ?? [])]),
    listResourceTemplatesPage: vi.fn(async (name: string, cursor: string | undefined) => {
      const { items, nextCursor } = pageOf(offered(name).templates ?? [], cursor, offered(name).pageSize);
      return { resourceTemplates: items, ...(nextCursor ? { nextCursor } : {}) };
    }),
    listResourceTemplates: vi.fn(async (name: string) => [...(offered(name).templates ?? [])]),
    readResource: vi.fn(async (name: string, uri: string): Promise<ReadResourceResult> => ({ contents: offered(name).contents?.[uri] ?? [] })),
    completeResourceArgument: vi.fn(async (name: string, params: { argument: string; value: string }) =>
      (offered(name).completions?.[params.argument] ?? []).filter((value) => value.startsWith(params.value))),
    getConnection: (name: string) => connections.get(name),
    getAllConnections: () => new Map(connections),
    closeAll: vi.fn(async () => connections.clear()),
    isIdle: () => false,
    setElicitationHandler: vi.fn(),
    touch: vi.fn(),
    incrementInFlight: vi.fn(),
    decrementInFlight: vi.fn(),
  };
  const factory = (_opts: McpServerManagerOptions): McpServerManager => fake as unknown as McpServerManager;
  /** Server names in the order `connect` was called for them. */
  const connected = (): string[] => connect.mock.calls.map(([name]) => name);
  return { fake, factory, connected };
}

/** A real manager over a fake pool, so naming, reconcile dedup and descriptors are the shipped code. */
export function managerWithFake(
  toolsByServer: Record<string, McpTool[]>,
  reservedToolNames?: () => ReadonlySet<string>,
  resourcesByServer?: Record<string, FakeResources>,
) {
  const pool = fakeServerManager(toolsByServer, resourcesByServer);
  const manager = new McpClientManager({
    clientVersion: 'test',
    serverManagerFactory: pool.factory,
    ...(reservedToolNames ? { reservedToolNames } : {}),
  });
  return { manager, ...pool };
}
