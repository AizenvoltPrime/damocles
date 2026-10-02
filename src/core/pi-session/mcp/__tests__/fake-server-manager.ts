import { vi } from 'vitest';
import { McpClientManager } from '../mcp-client-manager';
import type { McpServerManager, McpServerManagerOptions, ServerConnection } from '../server-manager';
import type { McpServerSpec, McpTool } from '../types';
import type { McpServerConfig } from '../../../../shared/types/mcp';

/** A config as the trusted, user-scope, pi-format spec the host feeds a manager. */
export function specOf(config: McpServerConfig, over: Partial<McpServerSpec> = {}): McpServerSpec {
  return { config, valueFormat: 'pi', folderScoped: false, trusted: true, ...over };
}

/** A connection pool that never spawns: `connect` answers with the tools listed per server name. */
export function fakeServerManager(toolsByServer: Record<string, McpTool[]>) {
  const connections = new Map<string, ServerConnection>();
  const connect = vi.fn(async (name: string) => {
    const conn = {
      tools: toolsByServer[name] ?? [],
      resources: [],
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
  const fake = {
    connect,
    close,
    callTool,
    readResource: vi.fn(async () => ({ contents: [] })),
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
export function managerWithFake(toolsByServer: Record<string, McpTool[]>, reservedToolNames?: () => ReadonlySet<string>) {
  const pool = fakeServerManager(toolsByServer);
  const manager = new McpClientManager({
    clientVersion: 'test',
    serverManagerFactory: pool.factory,
    ...(reservedToolNames ? { reservedToolNames } : {}),
  });
  return { manager, ...pool };
}
