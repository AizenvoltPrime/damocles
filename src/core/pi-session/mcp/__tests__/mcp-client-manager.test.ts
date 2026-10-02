import { describe, it, expect, vi, afterEach } from 'vitest';
import { McpClientManager, isSupervised } from '../mcp-client-manager';
import type { McpServerManager, ServerConnection, McpServerManagerOptions } from '../server-manager';
import type { McpTool, McpResource, McpElicitationHandler, McpServerDefinition, McpServerSpec } from '../types';
import type { McpServerConfig } from '../../../../shared/types/mcp';
import { McpServerConnectError } from '../connect-failure';
import { authenticateMcpServer, revokeAndRemoveAuth, shutdownOAuth } from '../mcp-auth-flow';
import { installLogSink } from '../../../logger';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';

// The reauthenticate/signOut methods call module-level fns that touch real OAuth/SecretStorage.
// Stub those; PRESERVE the real `supportsOAuth` (pure config logic the methods branch on).
vi.mock('../mcp-auth-flow', async (orig) => ({
  ...(await orig<typeof import('../mcp-auth-flow')>()),
  removeAuth: vi.fn(async () => {}),
  revokeAndRemoveAuth: vi.fn(async () => {}),
  authenticateMcpServer: vi.fn(async () => ({ ok: true })),
  shutdownOAuth: vi.fn(async () => {}),
}));

/** Every config as a trusted user-scope pi-format spec, the shape the host feeds a manager. */
function specs(configs: Record<string, McpServerConfig>): Record<string, McpServerSpec> {
  return Object.fromEntries(
    Object.entries(configs).map(([name, config]) => [name, { config, valueFormat: 'pi', folderScoped: false, trusted: true }]),
  );
}

/** Let the serialized op chain drain (a couple of microtask + macrotask turns settle enqueued reconnects). */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

interface FakeServer {
  tools?: McpTool[];
  resources?: McpResource[];
  fail?: boolean;
  needsAuth?: boolean;
}

function buildFake(servers: Record<string, FakeServer>) {
  const connections = new Map<string, ServerConnection>();
  let onListChanged: ((name: string) => void) | undefined;
  let onConnectionLost: ((name: string) => void) | undefined;
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
    onConnectionLost = opts.onConnectionLost;
    return fake as unknown as McpServerManager;
  };
  return {
    fake,
    factory,
    fireListChanged: (n: string) => onListChanged?.(n),
    // Simulate a spontaneous drop the way McpServerManager.onclose does: delete the live connection,
    // then notify the orchestrator.
    fireConnectionLost: (n: string) => {
      connections.delete(n);
      onConnectionLost?.(n);
    },
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
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory });
    manager.initialize(specs({ git: { command: 'git-mcp' } }));
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
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory });
    manager.initialize(specs({ evil: { command: 'evil-mcp' } }));
    await manager.whenReady();

    expect(manager.isMcpReadOnly('mcp__evil__safe')).toBe(true);
    expect(manager.isMcpReadOnly('mcp__evil__destructive')).toBe(false);
    expect(manager.isMcpReadOnly('mcp__evil__openworld')).toBe(false);
  });

  it('exposes resources as read-only get_* tools', async () => {
    const { factory } = buildFake({
      docs: { resources: [{ uri: 'file://readme', name: 'Read Me' }] },
    });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory });
    manager.initialize(specs({ docs: { command: 'docs-mcp' } }));
    await manager.whenReady();

    expect(manager.allToolNames()).toContain('mcp__docs__get_read_me');
    expect(manager.isMcpReadOnly('mcp__docs__get_read_me')).toBe(true);
  });

  it('routes a tool call to the server and forwards the abort signal + timeout', async () => {
    const { factory, fake } = buildFake({ git: { tools: [{ name: 'status' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory, callTimeoutMs: 5000 });
    manager.initialize(specs({ git: { command: 'git-mcp' } }));
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
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory });
    manager.initialize(specs({ docs: { command: 'docs-mcp' } }));
    await manager.whenReady();

    const result = await manager.callTool('mcp__docs__get_a', {}, {});
    expect(fake.readResource).toHaveBeenCalledWith('docs', 'file://a', expect.anything());
    expect(result.content[0]?.type).toBe('text');
    expect(result.content[0]?.text).toContain('hello');
  });

  it('re-registers tools on a list_changed notification', async () => {
    const fakes = buildFake({ git: { tools: [{ name: 'status' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: fakes.factory });
    const changed = vi.fn();
    manager.onToolsChanged(changed);
    manager.initialize(specs({ git: { command: 'git-mcp' } }));
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
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory });
    manager.initialize(specs({ broken: { command: 'nope' } }));
    await manager.whenReady();

    expect(manager.getServerStatus('broken')?.status).toBe('failed');
    expect(fake.connect).toHaveBeenCalledTimes(1);

    // A reconcile within the 60s backoff window must not retry the failing server.
    await manager.reconcile(specs({ broken: { command: 'nope' } }));
    expect(fake.connect).toHaveBeenCalledTimes(1);
  });

  it('replaces the connection of a server whose spec was edited under the same name', async () => {
    const { factory, fake } = buildFake({ git: { tools: [{ name: 'status' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory });
    manager.initialize(specs({ git: { command: 'git-mcp' } }));
    await manager.whenReady();

    await manager.reconcile(specs({ git: { command: 'git-mcp', args: ['--repo', 'other'] } }));

    expect(fake.close).toHaveBeenCalledWith('git');
    expect(fake.connect).toHaveBeenCalledTimes(2);
    expect((fake.connect.mock.calls[1] as unknown[] | undefined)?.[1]).toMatchObject({ config: { args: ['--repo', 'other'] } });
    expect(manager.getServerStatus('git')?.status).toBe('connected');
  });

  it('connects a server right after its folder is trusted, inside the failure backoff', async () => {
    const { factory, fake } = buildFake({ local: { tools: [{ name: 'go' }] } });
    fake.connect.mockRejectedValueOnce(
      new McpServerConnectError('MCP config env.T: commands do not run from an untrusted folder', {
        errorInfo: { code: 'commandUntrusted', params: { field: 'env.T' } },
      }),
    );
    const untrusted: McpServerSpec = { config: { command: 'local-mcp', env: { T: '!pass show t' } }, valueFormat: 'pi', folderScoped: true, trusted: false };
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory });
    manager.initialize({ local: untrusted });
    await manager.whenReady();
    expect(manager.getServerStatus('local')).toMatchObject({ status: 'failed', errorInfo: { code: 'commandUntrusted' } });

    await manager.reconcile({ local: { ...untrusted, trusted: true } });

    expect(fake.connect).toHaveBeenCalledTimes(2);
    expect(manager.getServerStatus('local')?.status).toBe('connected');
    expect(manager.getServerStatus('local')?.errorInfo).toBeUndefined();
  });

  it('reports needs-auth for a server that returns the needs-auth status', async () => {
    const { factory } = buildFake({ remote: { needsAuth: true } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory });
    manager.initialize(specs({ remote: { url: 'https://x', type: 'http' } }));
    await manager.whenReady();
    expect(manager.getServerStatus('remote')?.status).toBe('needs-auth');
  });

  it('does not connect lazy servers eagerly but still lists cached-less tools as empty', async () => {
    const { factory, fake } = buildFake({ lazy: { tools: [{ name: 'x' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory });
    manager.initialize(specs({ lazy: { command: 'lazy-mcp', lifecycle: 'lazy' } }));
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
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: fakes.factory });
    manager.initialize(specs({ git: { command: 'git-mcp' } }));
    await manager.whenReady();

    await manager.callTool('mcp__git__status', {}, { elicitationUi: ui });
    expect(ui.select).toHaveBeenCalledTimes(1);
  });

  it('declines an elicitation that arrives outside any active tool call (H2)', async () => {
    const fakes = buildFake({ git: { tools: [{ name: 'status' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: fakes.factory });
    manager.initialize(specs({ git: { command: 'git-mcp' } }));
    await manager.whenReady();

    const result = await fakes.getElicitation()?.({ message: 'hi', requestedSchema: { properties: {} } }, 'git');
    expect(result).toEqual({ action: 'decline' });
  });

  it('skips a redundant reconcile when the enabled set is unchanged (M8)', async () => {
    const { factory, fake } = buildFake({ git: { tools: [{ name: 'status' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory });
    manager.initialize(specs({ git: { command: 'git-mcp' } }));
    await manager.whenReady();
    expect(fake.connect).toHaveBeenCalledTimes(1);

    // Same set fed again (e.g. a second panel's feed) must not re-run doReconcile.
    await manager.reconcile(specs({ git: { command: 'git-mcp' } }));
    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(fake.close).not.toHaveBeenCalled();

    // A genuinely changed set still reconciles.
    await manager.reconcile(specs({ git: { command: 'git-mcp' }, docs: { command: 'docs-mcp' } }));
    expect(fake.connect.mock.calls.length).toBeGreaterThan(1);
  });

  it('auto-reconnects a default/eager server that dropped its connection (self-heal)', async () => {
    const fakes = buildFake({ git: { tools: [{ name: 'status' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: fakes.factory });
    manager.initialize(specs({ git: { command: 'git-mcp' } }));
    await manager.whenReady();
    expect(fakes.fake.connect).toHaveBeenCalledTimes(1);
    expect(manager.getServerStatus('git')?.status).toBe('connected');

    // The server process crashes / transport drops on its own.
    fakes.fireConnectionLost('git');
    // The orchestrator force-reconnects through the serialized op chain; let it settle.
    await manager.whenReady();
    await flush();

    expect(fakes.fake.connect.mock.calls.length).toBeGreaterThan(1);
    expect(manager.getServerStatus('git')?.status).toBe('connected');
  });

  it('does not auto-reconnect a lazy server that dropped (it reconnects on next use)', async () => {
    const fakes = buildFake({ lazy: { tools: [{ name: 'x' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: fakes.factory });
    manager.initialize(specs({ lazy: { command: 'lazy-mcp', lifecycle: 'lazy' } }));
    await manager.whenReady();
    // Lazy never eager-connects, so force a live connection first (as a tool call would).
    fakes.connections.set('lazy', { status: 'connected', tools: [], resources: [] } as unknown as ServerConnection);

    fakes.fireConnectionLost('lazy');
    await flush();

    // No forced reconnect for a lazy server.
    expect(fakes.fake.connect).not.toHaveBeenCalled();
    expect(manager.getServerStatus('lazy')?.status).toBe('idle');
  });

  it('throttles a crash loop: a re-drop within the backoff window is not immediately respawned (H1)', async () => {
    const fakes = buildFake({ git: { tools: [{ name: 'status' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: fakes.factory });
    manager.initialize(specs({ git: { command: 'git-mcp' } }));
    await manager.whenReady();
    expect(fakes.fake.connect).toHaveBeenCalledTimes(1); // initial eager connect

    // First drop → one immediate reconnect (handshake succeeds, clearing failureAt).
    fakes.fireConnectionLost('git');
    await flush();
    expect(fakes.fake.connect).toHaveBeenCalledTimes(2);

    // It crashes again right away. Because the prior handshake succeeded, failureAt is clear — only the
    // drop-throttle prevents an unbounded immediate respawn loop. No further connect this tick.
    fakes.fireConnectionLost('git');
    await flush();
    expect(fakes.fake.connect).toHaveBeenCalledTimes(2);
    // The server shows as reconnecting (pending), to be recovered by the 30s health check.
    expect(manager.getServerStatus('git')?.status).toBe('pending');
  });

  it('does not resurrect a server removed by a reconcile before the queued reconnect runs (H2)', async () => {
    const fakes = buildFake({ git: { tools: [{ name: 'status' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: fakes.factory });
    manager.initialize(specs({ git: { command: 'git-mcp' } }));
    await manager.whenReady();
    const connectsBefore = fakes.fake.connect.mock.calls.length;

    // Enqueue the removal FIRST (don't await — its doReconcile is now queued but hasn't run, so `servers`
    // still contains git), THEN fire the drop so the reconnect enqueues behind the removal. The op chain
    // runs [doReconcile, reconnect]: removal closes+drops git, then the reconnect re-reads `servers`,
    // finds git gone, and skips — proving the inside-closure re-validation prevents an orphan child.
    const reconcilePromise = manager.reconcile(specs({}));
    fakes.fireConnectionLost('git');
    await reconcilePromise;
    await flush();

    expect(fakes.fake.connect.mock.calls.length).toBe(connectsBefore);
    expect(manager.getServerStatus('git')).toBeUndefined();
  });

  it('surfaces supportsOAuth on a connected OAuth server but not on a stdio server', async () => {
    const { factory } = buildFake({
      remote: { tools: [{ name: 'ping' }] },
      git: { tools: [{ name: 'status' }] },
    });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory });
    manager.initialize(specs({
      remote: { url: 'https://x', type: 'http' },
      git: { command: 'git-mcp' },
    }));
    await manager.whenReady();

    // getServerStatuses stays synchronous — assert the array directly (no Promise).
    const statuses = manager.getServerStatuses();
    expect(Array.isArray(statuses)).toBe(true);

    expect(manager.getServerStatus('remote')?.status).toBe('connected');
    expect(manager.getServerStatus('remote')?.supportsOAuth).toBe(true);
    expect(manager.getServerStatus('git')?.supportsOAuth).toBeUndefined();
  });

  it('signOut clears creds, disconnects to needs-auth, and evicts the stale tool cache', async () => {
    vi.mocked(revokeAndRemoveAuth).mockClear();
    vi.mocked(authenticateMcpServer).mockClear();
    const fakes = buildFake({ remote: { tools: [{ name: 'ping' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: fakes.factory });
    manager.initialize(specs({ remote: { url: 'https://x', type: 'http' } }));
    await manager.whenReady();
    expect(manager.getServerStatus('remote')?.status).toBe('connected');
    expect(manager.allToolNames()).toContain('mcp__remote__ping');

    await manager.signOut('remote');
    await flush();

    expect(revokeAndRemoveAuth).toHaveBeenCalledTimes(1);
    expect(fakes.fake.close).toHaveBeenCalledWith('remote');
    expect(manager.getServerStatus('remote')?.status).toBe('needs-auth');
    // Cache evicted: the agent no longer sees the signed-out server's tool.
    expect(manager.allToolNames()).not.toContain('mcp__remote__ping');
  });

  it('reauthenticate clears creds, runs the interactive flow, and reconnects to connected', async () => {
    vi.mocked(revokeAndRemoveAuth).mockClear();
    vi.mocked(authenticateMcpServer).mockClear();
    const fakes = buildFake({ remote: { tools: [{ name: 'ping' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: fakes.factory });
    manager.initialize(specs({ remote: { url: 'https://x', type: 'http' } }));
    await manager.whenReady();
    expect(manager.getServerStatus('remote')?.status).toBe('connected');

    const connected = await manager.reauthenticate('remote');
    await flush();

    expect(revokeAndRemoveAuth).toHaveBeenCalledTimes(1);
    expect(authenticateMcpServer).toHaveBeenCalledTimes(1);
    expect(connected).toBe(true);
    expect(manager.getServerStatus('remote')?.status).toBe('connected');
    // A successful reconnect re-populates the live tool set.
    expect(manager.allToolNames()).toContain('mcp__remote__ping');
  });

  it('reauthenticate on a non-OAuth server returns false without touching creds', async () => {
    vi.mocked(revokeAndRemoveAuth).mockClear();
    vi.mocked(authenticateMcpServer).mockClear();
    const { factory } = buildFake({ git: { tools: [{ name: 'status' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory });
    manager.initialize(specs({ git: { command: 'git-mcp' } }));
    await manager.whenReady();

    const result = await manager.reauthenticate('git');

    expect(result).toBe(false);
    expect(revokeAndRemoveAuth).not.toHaveBeenCalled();
    expect(authenticateMcpServer).not.toHaveBeenCalled();
  });

  it('signOut on a non-OAuth server no-ops without revoking creds and stays connected (N1)', async () => {
    const fakes = buildFake({ git: { tools: [{ name: 'status' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: fakes.factory });
    manager.initialize(specs({ git: { command: 'git-mcp' } }));
    await manager.whenReady();
    expect(manager.getServerStatus('git')?.status).toBe('connected');
    vi.mocked(revokeAndRemoveAuth).mockClear();

    await manager.signOut('git');
    await flush();

    expect(revokeAndRemoveAuth).not.toHaveBeenCalled();
    expect(manager.getServerStatus('git')?.status).toBe('connected');
  });

  it('reauthenticate returns false when the interactive flow fails, after clearing creds (N2)', async () => {
    vi.mocked(revokeAndRemoveAuth).mockClear();
    vi.mocked(authenticateMcpServer).mockClear();
    vi.mocked(authenticateMcpServer).mockResolvedValueOnce({ ok: false, error: 'denied' });
    const fakes = buildFake({ remote: { tools: [{ name: 'ping' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: fakes.factory });
    manager.initialize(specs({ remote: { url: 'https://x', type: 'http' } }));
    await manager.whenReady();
    expect(manager.getServerStatus('remote')?.status).toBe('connected');

    const connected = await manager.reauthenticate('remote');
    await flush();

    expect(connected).toBe(false);
    expect(revokeAndRemoveAuth).toHaveBeenCalledTimes(1);
    expect(authenticateMcpServer).toHaveBeenCalledTimes(1);
    expect(manager.getServerStatus('remote')?.status).not.toBe('connected');
  });

  it('logs a failed reconnect by message only, never the stderr tail', async () => {
    const lines: string[] = [];
    installLogSink({ appendLine: (line) => lines.push(line), show: () => {}, dispose: () => {} });
    const fakes = buildFake({ git: { tools: [{ name: 'status' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: fakes.factory });
    manager.initialize(specs({ git: { command: 'git-mcp' } }));
    await manager.whenReady();
    const failure = () => new McpServerConnectError('git-mcp exited with code 3', { stderrTail: 'token=SECRET-TAIL' });

    fakes.fake.connect.mockRejectedValueOnce(failure());
    await manager.reconnectLive('git');
    fakes.fake.connect.mockRejectedValueOnce(failure());
    fakes.fireConnectionLost('git');
    await flush();

    expect(lines.filter((line) => line.includes('git-mcp exited with code 3'))).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('SECRET-TAIL');
  });

  it('logs an HTTP connect failure by its status on every path, never the response body', async () => {
    const lines: string[] = [];
    installLogSink({ appendLine: (line) => lines.push(line), show: () => {}, dispose: () => {} });
    const fakes = buildFake({ remote: { tools: [{ name: 'q' }] } });
    // As McpServerManager builds it from pi-mcp's McpHttpError, whose message quotes the response body.
    const failure = () =>
      new McpServerConnectError('MCP HTTP request failed with status 502: upstream said api_key=BODY-SECRET', { logText: 'McpHttpError: HTTP status 502' });
    fakes.fake.connect.mockRejectedValueOnce(failure());
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: fakes.factory });
    await manager.reconcile(specs({ remote: { type: 'http', url: 'https://x.test/mcp' } }));
    fakes.fake.connect.mockRejectedValueOnce(failure());
    await manager.reconnectLive('remote');
    await manager.reconnectLive('remote');
    fakes.fake.connect.mockRejectedValueOnce(failure());
    fakes.fireConnectionLost('remote');
    await flush();

    expect(lines.filter((line) => line.includes('McpHttpError: HTTP status 502'))).toHaveLength(3);
    expect(lines.join('\n')).not.toContain('BODY-SECRET');
    expect(manager.getServerStatus('remote')?.error).toContain('BODY-SECRET');
  });

  it('does not reconnect after dispose() even if a drop was already queued', async () => {
    const fakes = buildFake({ git: { tools: [{ name: 'status' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: fakes.factory });
    manager.initialize(specs({ git: { command: 'git-mcp' } }));
    await manager.whenReady();
    const connectsBefore = fakes.fake.connect.mock.calls.length;

    fakes.fireConnectionLost('git');
    await manager.dispose();
    await flush();

    expect(fakes.fake.connect.mock.calls.length).toBe(connectsBefore);
    manager = undefined; // already disposed
  });
});

describe('McpClientManager tool names (pi createMcpToolName)', () => {
  it('gives tools with characters outside [A-Za-z0-9_] pi-style names and keeps the raw name on the descriptor', async () => {
    const { factory, fake } = buildFake({ context7: { tools: [{ name: 'resolve-library-id' }, { name: 'get_docs' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory });
    await manager.reconcile(specs({ context7: { command: 'x' } }));

    expect(manager.allToolNames().sort()).toEqual(['mcp__context7__get_docs', 'mcp__context7__resolve_library_id']);
    expect(manager.getToolDescriptor('mcp__context7__resolve_library_id')).toMatchObject({
      serverName: 'context7',
      rawToolName: 'resolve-library-id',
      kind: 'tool',
    });
    await manager.callTool('mcp__context7__resolve_library_id', {}, {});
    expect(fake.callTool).toHaveBeenCalledWith('context7', 'resolve-library-id', {}, expect.anything());
  });

  it('suffixes both tools of a server whose names collide after sanitizing', async () => {
    const { factory } = buildFake({ docs: { tools: [{ name: 'a-b' }, { name: 'a_b' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory });
    await manager.reconcile(specs({ docs: { command: 'x' } }));
    expect(manager.allToolNames().sort()).toEqual(['mcp__docs__a_b_4f33a9a2', 'mcp__docs__a_b_63617bb9']);
  });

  it('names resource tools with the same rule and the server name as written', async () => {
    const { factory } = buildFake({ 'my-docs': { resources: [{ uri: 'file://readme', name: 'Read Me' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory });
    await manager.reconcile(specs({ 'my-docs': { command: 'x' } }));
    expect(manager.getToolDescriptor('mcp__my_docs__get_read_me')).toMatchObject({ serverName: 'my-docs', kind: 'resource' });
  });

  it('suffixes a name another manager already holds', async () => {
    const { factory } = buildFake({ 'my-server': { tools: [{ name: 'go' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory, reservedToolNames: () => new Set(['mcp__my_server__go']) });
    await manager.reconcile(specs({ 'my-server': { command: 'x' } }));
    expect(manager.allToolNames()).toEqual([expect.stringMatching(/^mcp__my_server__go_[0-9a-f]{8}$/)]);
  });

  it('refreshReservedToolNames renames and emits only when a name moves, keeping the connection', async () => {
    const { factory, fake } = buildFake({ 'my-server': { tools: [{ name: 'go' }] } });
    let reserved = new Set<string>();
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory, reservedToolNames: () => reserved });
    await manager.reconcile(specs({ 'my-server': { command: 'x' } }));
    const changed = vi.fn();
    manager.onToolsChanged(changed);

    expect(manager.refreshReservedToolNames()).toBe(false);
    expect(changed).not.toHaveBeenCalled();

    reserved = new Set(['mcp__my_server__go']);
    expect(manager.refreshReservedToolNames()).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(manager.allToolNames()).not.toContain('mcp__my_server__go');
    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(fake.close).not.toHaveBeenCalled();
  });

  it('lists every known tool under both names for the rule migration', async () => {
    const { factory } = buildFake({ context7: { tools: [{ name: 'resolve-library-id' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory });
    await manager.reconcile(specs({ context7: { command: 'x' } }));
    expect(manager.toolNameEntries()).toEqual([
      { serverName: 'context7', rawToolName: 'resolve-library-id', piName: 'mcp__context7__resolve_library_id' },
    ]);
  });
});

describe('McpClientManager status rows', () => {
  it('uses the config description as the server line, sanitized and capped at 120 characters', async () => {
    const { factory } = buildFake({ docs: { tools: [{ name: 'q' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory });
    await manager.reconcile(specs({ docs: { command: 'x', description: `Docs\u0007 ${'d'.repeat(200)}` } }));

    const description = manager.getServerStatus('docs')?.description ?? '';
    expect(description.length).toBeLessThanOrEqual(120);
    expect([...description].every((char) => char.charCodeAt(0) >= 0x20)).toBe(true);
    expect(manager.getToolDescriptor('mcp__docs__q')?.serverDescription).toBe(description);
  });

  it('cuts a long description on a character boundary and drops bidi controls', async () => {
    const { factory } = buildFake({ astral: { tools: [] }, bidi: { tools: [] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory });
    await manager.reconcile(
      specs({
        astral: { command: 'x', description: `${'a'.repeat(116)}\u{1F600}${'b'.repeat(20)}` },
        bidi: { command: 'y', description: 'report\u202Efdp.exe' },
      }),
    );

    expect(manager.getServerStatus('astral')?.description).toBe(`${'a'.repeat(116)}\u{1F600}...`);
    expect(manager.getServerStatus('bidi')?.description).toBe('reportfdp.exe');
  });

  it('falls back to the first non-blank line of the server instructions', async () => {
    const fakes = buildFake({ docs: { tools: [{ name: 'q' }] } });
    fakes.fake.connect.mockImplementationOnce(async (name: string) => {
      const conn = { tools: [{ name: 'q' }], resources: [], status: 'connected', instructions: '\n  Search the handbook.\nMore.', inFlight: 0, lastUsedAt: 0 } as unknown as ServerConnection;
      fakes.connections.set(name, conn);
      return conn;
    });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: fakes.factory });
    await manager.reconcile(specs({ docs: { command: 'x' } }));
    expect(manager.getServerStatus('docs')?.description).toBe('Search the handbook.');
  });

  it('carries a connect failure’s errorInfo and stderr tail to the failed row', async () => {
    const fakes = buildFake({});
    fakes.fake.connect.mockRejectedValueOnce(
      new McpServerConnectError('MCP config env.KEY: environment variable KEY is not set', {
        errorInfo: { code: 'missingVariable', params: { variable: 'KEY', field: 'env.KEY' } },
        stderrTail: 'boom',
      }),
    );
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: fakes.factory });
    await manager.reconcile(specs({ broken: { command: 'x' } }));

    expect(manager.getServerStatus('broken')).toMatchObject({
      status: 'failed',
      error: 'MCP config env.KEY: environment variable KEY is not set',
      errorInfo: { code: 'missingVariable', params: { variable: 'KEY', field: 'env.KEY' } },
      stderrTail: 'boom',
    });
  });

  it('shows a step-up challenge as needs-auth with insufficientScope', async () => {
    const fakes = buildFake({});
    fakes.fake.connect.mockImplementationOnce(async (name: string) => {
      const conn = { tools: [], resources: [], status: 'needs-auth', errorInfo: { code: 'insufficientScope' }, inFlight: 0, lastUsedAt: 0 } as unknown as ServerConnection;
      fakes.connections.set(name, conn);
      return conn;
    });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: fakes.factory });
    await manager.reconcile(specs({ remote: { type: 'http', url: 'https://x.test/mcp' } }));
    expect(manager.getServerStatus('remote')).toMatchObject({ status: 'needs-auth', errorInfo: { code: 'insufficientScope' } });
  });

  it('shows the step-up hint of a needs-auth result even after an earlier failure', async () => {
    const fakes = buildFake({ remote: { tools: [{ name: 'status' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: fakes.factory });
    await manager.reconcile(specs({ remote: { type: 'http', url: 'https://x.test/mcp' } }));
    fakes.fake.connect.mockRejectedValueOnce(new McpServerConnectError('fetch failed'));
    fakes.fireConnectionLost('remote');
    await flush();
    expect(manager.getServerStatus('remote')).toMatchObject({ status: 'failed', error: 'fetch failed' });
    fakes.fake.connect.mockImplementationOnce(async (name: string) => {
      const conn = { tools: [], resources: [], status: 'needs-auth', errorInfo: { code: 'insufficientScope' }, inFlight: 0, lastUsedAt: 0 } as unknown as ServerConnection;
      fakes.connections.set(name, conn);
      return conn;
    });

    await manager.callTool('mcp__remote__status', {}, {});

    const status = manager.getServerStatus('remote');
    expect(status).toMatchObject({ status: 'needs-auth', errorInfo: { code: 'insufficientScope' } });
    expect(status?.error).toBeUndefined();
  });

  it('applies the configured timeout in seconds to calls', async () => {
    const { factory, fake } = buildFake({ git: { tools: [{ name: 'status' }] } });
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory });
    await manager.reconcile(specs({ git: { command: 'x', timeout: 7 } }));
    await manager.callTool('mcp__git__status', {}, {});
    expect(fake.callTool).toHaveBeenCalledWith('git', 'status', {}, { timeoutMs: 7000 });
  });
});

describe('McpClientManager connecting state', () => {
  it('shows every server failed, not connecting, when pi-mcp cannot load', async () => {
    vi.resetModules();
    vi.doMock('../mcp-client-loader', () => ({ loadMcpClient: async () => null }));
    try {
      (await import('../../../platform-host')).installPlatform(createFakePlatform());
      const { McpClientManager: Isolated } = await import('../mcp-client-manager');
      const isolated = new Isolated({ clientVersion: 'test' });
      isolated.initialize(specs({ ctx: { command: 'ctx-mcp', exposure: 'direct' } }));
      await isolated.whenReady();

      expect(isolated.getServerStatus('ctx')).toMatchObject({
        status: 'failed',
        error: 'The MCP client library failed to load, so no MCP server can connect.',
      });
      expect(isolated.connectingServerNames()).toEqual([]);
      expect(isolated.pendingDirectServers()).toEqual([]);
      await isolated.dispose();
    } finally {
      vi.doUnmock('../mcp-client-loader');
      vi.resetModules();
    }
  });

  it('shows a server shut down for idleness as idle, not connecting', async () => {
    const fakes = buildFake({ docs: { tools: [{ name: 'q' }] } });
    fakes.fake.isIdle = () => true;
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: fakes.factory, healthCheckMs: 10 });
    await manager.reconcile(specs({ docs: { command: 'x', idleTimeout: 1, exposure: 'direct' } }));
    expect(manager.getServerStatus('docs')?.status).toBe('connected');

    await vi.waitFor(() => expect(fakes.fake.close).toHaveBeenCalledWith('docs'));

    expect(manager.getServerStatus('docs')?.status).toBe('idle');
    expect(manager.connectingServerNames()).toEqual([]);
    expect(manager.pendingDirectServers()).toEqual([]);
  });
});

describe('McpClientManager lifetime', () => {
  it('dispose leaves process-global OAuth state to its owner, since other managers may still use it', async () => {
    const { factory } = buildFake({});
    manager = new McpClientManager({ clientVersion: 'test', serverManagerFactory: factory });
    await manager.reconcile(specs({}));
    await manager.dispose();
    manager = undefined;

    expect(shutdownOAuth).not.toHaveBeenCalled();
  });
});

describe('isSupervised (lifecycle supervision predicate)', () => {
  const def = (over: Partial<McpServerDefinition>): McpServerDefinition => ({ command: 'x', ...over });

  it('supervises default/eager servers (kept connected, never idle-shutdown)', () => {
    expect(isSupervised(def({}))).toBe(true);
    expect(isSupervised(def({ lifecycle: 'eager' }))).toBe(true);
  });

  it('always supervises keep-alive — even with an explicit idleTimeout (M3 regression guard)', () => {
    expect(isSupervised(def({ lifecycle: 'keep-alive' }))).toBe(true);
    expect(isSupervised(def({ lifecycle: 'keep-alive', idleTimeout: 5 }))).toBe(true);
  });

  it('does not supervise lazy, or default/eager that opts into idle-shutdown via idleTimeout', () => {
    expect(isSupervised(def({ lifecycle: 'lazy' }))).toBe(false);
    expect(isSupervised(def({ idleTimeout: 5 }))).toBe(false);
    expect(isSupervised(def({ lifecycle: 'eager', idleTimeout: 5 }))).toBe(false);
  });
});
