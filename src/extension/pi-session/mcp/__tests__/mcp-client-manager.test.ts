import { describe, it, expect, vi, afterEach } from 'vitest';
import { McpClientManager } from '../mcp-client-manager';
import type { McpServerManager, ServerConnection, McpServerManagerOptions } from '../server-manager';
import type { McpTool, McpResource, McpElicitationHandler } from '../types';

interface FakeServer {
  tools?: McpTool[];
  resources?: McpResource[];
  fail?: boolean;
  needsAuth?: boolean;
}

function buildFake(servers: Record<string, FakeServer>) {
  const connections = new Map<string, ServerConnection>();
  let onListChanged: ((name: string) => void) | undefined;
  let elicitationHandler: McpElicitationHandler | undefined;
  const connect = vi.fn(async (name: string) => {
    const spec = servers[name] ?? {};
    if (spec.fail) throw new Error(`boom:${name}`);
    const status: ServerConnection['status'] = spec.needsAuth ? 'needs-auth' : 'connected';
    const conn = {
      tools: spec.tools ?? [],
      resources: spec.resources ?? [],
      status,
      serverInfo: { name, version: '9.9.9' },
      inFlight: 0,
      lastUsedAt: 0,
    } as unknown as ServerConnection;
    connections.set(name, conn);
    return conn;
  });
  const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }));
  const readResource = vi.fn(async () => ({ contents: [{ uri: 'file://a', text: 'hello' }] }));
  const fake = {
    connect,
    callTool,
    readResource,
    getConnection: (n: string) => connections.get(n),
    getAllConnections: () => new Map(connections),
    close: vi.fn(async (n: string) => {
      connections.delete(n);
    }),
    closeAll: vi.fn(async () => connections.clear()),
    isIdle: () => false,
    setElicitationHandler: vi.fn((h: McpElicitationHandler | undefined) => {
      elicitationHandler = h;
    }),
    touch: vi.fn(),
    incrementInFlight: vi.fn(),
    decrementInFlight: vi.fn(),
  };
  const factory = (opts: McpServerManagerOptions): McpServerManager => {
    onListChanged = opts.onListChanged;
    return fake as unknown as McpServerManager;
  };
  return {
    fake,
    factory,
    fireListChanged: (n: string) => onListChanged?.(n),
    getElicitation: () => elicitationHandler,
    connections,
  };
}

let manager: McpClientManager | undefined;
afterEach(async () => {
  await manager?.dispose();
  manager = undefined;
});

describe('McpClientManager', () => {
  it('eager-connects enabled servers and builds mcp__ descriptors with read-only flags', async () => {
    const { factory } = buildFake({
      git: { tools: [{ name: 'status', annotations: { readOnlyHint: true } }, { name: 'commit' }] },
    });
    manager = new McpClientManager({ serverManagerFactory: factory });
    manager.initialize({ git: { command: 'git-mcp' } });
    await manager.whenReady();

    const names = manager.allToolNames().sort();
    expect(names).toContain('mcp__git__status');
    expect(names).toContain('mcp__git__commit');
    expect(manager.isMcpReadOnly('mcp__git__status')).toBe(true);
    expect(manager.isMcpReadOnly('mcp__git__commit')).toBe(false);

    const status = manager.getServerStatus('git');
    expect(status?.status).toBe('connected');
    expect(status?.serverInfo?.version).toBe('9.9.9');
  });

  it('does not treat a destructive/open-world tool as read-only even if it claims readOnlyHint (H1)', async () => {
    const { factory } = buildFake({
      evil: {
        tools: [
          { name: 'safe', annotations: { readOnlyHint: true } },
          { name: 'destructive', annotations: { readOnlyHint: true, destructiveHint: true } },
          { name: 'openworld', annotations: { readOnlyHint: true, openWorldHint: true } },
        ],
      },
    });
    manager = new McpClientManager({ serverManagerFactory: factory });
    manager.initialize({ evil: { command: 'evil-mcp' } });
    await manager.whenReady();

    expect(manager.isMcpReadOnly('mcp__evil__safe')).toBe(true);
    expect(manager.isMcpReadOnly('mcp__evil__destructive')).toBe(false);
    expect(manager.isMcpReadOnly('mcp__evil__openworld')).toBe(false);
  });

  it('exposes resources as read-only get_* tools', async () => {
    const { factory } = buildFake({
      docs: { resources: [{ uri: 'file://readme', name: 'Read Me' }] },
    });
    manager = new McpClientManager({ serverManagerFactory: factory });
    manager.initialize({ docs: { command: 'docs-mcp' } });
    await manager.whenReady();

    expect(manager.allToolNames()).toContain('mcp__docs__get_read_me');
    expect(manager.isMcpReadOnly('mcp__docs__get_read_me')).toBe(true);
  });

  it('routes a tool call to the server and forwards the abort signal + timeout', async () => {
    const { factory, fake } = buildFake({ git: { tools: [{ name: 'status' }] } });
    manager = new McpClientManager({ serverManagerFactory: factory, callTimeoutMs: 5000 });
    manager.initialize({ git: { command: 'git-mcp' } });
    await manager.whenReady();

    const controller = new AbortController();
    const result = await manager.callTool('mcp__git__status', { a: 1 }, { signal: controller.signal });
    expect(result.isError).toBe(false);
    expect(fake.callTool).toHaveBeenCalledWith('git', 'status', { a: 1 }, {
      timeoutMs: 5000,
      signal: controller.signal,
    });
  });

  it('reads a resource via resources/read and converts contents to text', async () => {
    const { factory, fake } = buildFake({ docs: { resources: [{ uri: 'file://a', name: 'A' }] } });
    manager = new McpClientManager({ serverManagerFactory: factory });
    manager.initialize({ docs: { command: 'docs-mcp' } });
    await manager.whenReady();

    const result = await manager.callTool('mcp__docs__get_a', {}, {});
    expect(fake.readResource).toHaveBeenCalledWith('docs', 'file://a', expect.anything());
    expect(result.content[0]?.type).toBe('text');
    expect(result.content[0]?.text).toContain('hello');
  });

  it('re-registers tools on a list_changed notification', async () => {
    const fakes = buildFake({ git: { tools: [{ name: 'status' }] } });
    manager = new McpClientManager({ serverManagerFactory: fakes.factory });
    const changed = vi.fn();
    manager.onToolsChanged(changed);
    manager.initialize({ git: { command: 'git-mcp' } });
    await manager.whenReady();

    const before = changed.mock.calls.length;
    const conn = fakes.connections.get('git');
    if (conn) conn.tools = [{ name: 'status' }, { name: 'log' }] as McpTool[];
    fakes.fireListChanged('git');

    expect(manager.allToolNames()).toContain('mcp__git__log');
    expect(changed.mock.calls.length).toBeGreaterThan(before);
  });

  it('marks a failed server failed and backs off repeat connects', async () => {
    const { factory, fake } = buildFake({ broken: { fail: true } });
    manager = new McpClientManager({ serverManagerFactory: factory });
    manager.initialize({ broken: { command: 'nope' } });
    await manager.whenReady();

    expect(manager.getServerStatus('broken')?.status).toBe('failed');
    expect(fake.connect).toHaveBeenCalledTimes(1);

    // A reconcile within the 60s backoff window must not retry the failing server.
    await manager.reconcile({ broken: { command: 'nope' } });
    expect(fake.connect).toHaveBeenCalledTimes(1);
  });

  it('reports needs-auth for a server that returns the needs-auth status', async () => {
    const { factory } = buildFake({ remote: { needsAuth: true } });
    manager = new McpClientManager({ serverManagerFactory: factory });
    manager.initialize({ remote: { url: 'https://x', type: 'http' } });
    await manager.whenReady();
    expect(manager.getServerStatus('remote')?.status).toBe('needs-auth');
  });

  it('does not connect lazy servers eagerly but still lists cached-less tools as empty', async () => {
    const { factory, fake } = buildFake({ lazy: { tools: [{ name: 'x' }] } });
    manager = new McpClientManager({ serverManagerFactory: factory });
    manager.initialize({ lazy: { command: 'lazy-mcp', lifecycle: 'lazy' } });
    await manager.whenReady();
    expect(fake.connect).not.toHaveBeenCalled();
    expect(manager.getServerStatus('lazy')?.status).toBe('idle');
  });

  it('routes a server elicitation to the in-flight tool call\'s panel UI (H2)', async () => {
    const fakes = buildFake({ git: { tools: [{ name: 'status' }] } });
    const ui = { select: vi.fn(async () => 'Decline'), input: vi.fn(), notify: vi.fn() };
    // The server elicits while the tool call is running; the manager must route it to this call's UI.
    fakes.fake.callTool.mockImplementationOnce(async () => {
      await fakes.getElicitation()?.({ message: 'hi', requestedSchema: { properties: {} } }, 'git');
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    });
    manager = new McpClientManager({ serverManagerFactory: fakes.factory });
    manager.initialize({ git: { command: 'git-mcp' } });
    await manager.whenReady();

    await manager.callTool('mcp__git__status', {}, { elicitationUi: ui });
    expect(ui.select).toHaveBeenCalledTimes(1);
  });

  it('declines an elicitation that arrives outside any active tool call (H2)', async () => {
    const fakes = buildFake({ git: { tools: [{ name: 'status' }] } });
    manager = new McpClientManager({ serverManagerFactory: fakes.factory });
    manager.initialize({ git: { command: 'git-mcp' } });
    await manager.whenReady();

    const result = await fakes.getElicitation()?.({ message: 'hi', requestedSchema: { properties: {} } }, 'git');
    expect(result).toEqual({ action: 'decline' });
  });

  it('skips a redundant reconcile when the enabled set is unchanged (M8)', async () => {
    const { factory, fake } = buildFake({ git: { tools: [{ name: 'status' }] } });
    manager = new McpClientManager({ serverManagerFactory: factory });
    manager.initialize({ git: { command: 'git-mcp' } });
    await manager.whenReady();
    expect(fake.connect).toHaveBeenCalledTimes(1);

    // Same set fed again (e.g. a second panel's feed) must not re-run doReconcile.
    await manager.reconcile({ git: { command: 'git-mcp' } });
    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(fake.close).not.toHaveBeenCalled();

    // A genuinely changed set still reconciles.
    await manager.reconcile({ git: { command: 'git-mcp' }, docs: { command: 'docs-mcp' } });
    expect(fake.connect.mock.calls.length).toBeGreaterThan(1);
  });
});
