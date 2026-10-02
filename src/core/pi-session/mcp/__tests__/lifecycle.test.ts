import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpLifecycleManager } from '../lifecycle';
import type { McpServerManager, ServerConnection } from '../server-manager';
import { McpServerConnectError } from '../connect-failure';
import { installLogSink } from '../../../logger';
import type { McpServerSpec } from '../types';

function fakeManager() {
  const connections = new Map<string, Pick<ServerConnection, 'status' | 'inFlight'>>();
  return {
    connections,
    getConnection: (n: string) => connections.get(n),
    connect: vi.fn(async (n: string) => {
      const c = { status: 'connected' as const, inFlight: 0 };
      connections.set(n, c);
      return c;
    }),
    isIdle: vi.fn(() => false),
    answersPing: vi.fn(async (_name: string) => true),
    close: vi.fn(async (n: string) => {
      connections.delete(n);
    }),
    closeAll: vi.fn(async () => connections.clear()),
  };
}

const def: McpServerSpec = { config: { command: 'x' }, valueFormat: 'pi', folderScoped: false, trusted: true };

describe('McpLifecycleManager', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('idle-shuts-down an unsupervised (lazy / explicit-idleTimeout) server that reports idle', async () => {
    const fake = fakeManager();
    fake.connections.set('s', { status: 'connected', inFlight: 0 });
    fake.isIdle.mockReturnValue(true);
    const onIdle = vi.fn();

    const lifecycle = new McpLifecycleManager(fake as unknown as McpServerManager);
    lifecycle.registerServer('s', def);
    lifecycle.setIdleShutdownCallback(onIdle);
    lifecycle.startHealthChecks(1000);

    await vi.advanceTimersByTimeAsync(1000);

    expect(fake.close).toHaveBeenCalledWith('s');
    expect(onIdle).toHaveBeenCalledWith('s');
  });

  it('reconnects a dead supervised server through the injected reconnectFn', async () => {
    const fake = fakeManager();
    const reconnectFn = vi.fn(async () => {});

    const lifecycle = new McpLifecycleManager(fake as unknown as McpServerManager);
    lifecycle.registerServer('k', def);
    lifecycle.markSupervised('k', def);
    lifecycle.setReconnectFn(reconnectFn);
    lifecycle.startHealthChecks(1000);

    await vi.advanceTimersByTimeAsync(1000);

    expect(reconnectFn).toHaveBeenCalledWith('k', def);
    // supervised servers are never idle-shut-down
    expect(fake.close).not.toHaveBeenCalled();
  });

  it('never idle-shuts-down a supervised server even when it reports idle', async () => {
    const fake = fakeManager();
    fake.connections.set('k', { status: 'connected', inFlight: 0 });
    fake.isIdle.mockReturnValue(true);
    const onIdle = vi.fn();

    const lifecycle = new McpLifecycleManager(fake as unknown as McpServerManager);
    lifecycle.registerServer('k', def);
    lifecycle.markSupervised('k', def);
    lifecycle.setReconnectFn(vi.fn(async () => {}));
    lifecycle.setIdleShutdownCallback(onIdle);
    lifecycle.startHealthChecks(1000);

    await vi.advanceTimersByTimeAsync(1000);

    expect(fake.close).not.toHaveBeenCalled();
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('does not idle-shutdown when isIdle is false', async () => {
    const fake = fakeManager();
    fake.connections.set('s', { status: 'connected', inFlight: 0 });
    const lifecycle = new McpLifecycleManager(fake as unknown as McpServerManager);
    lifecycle.registerServer('s', def);
    lifecycle.startHealthChecks(1000);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.close).not.toHaveBeenCalled();
  });

  it('skips an overlapping health-check tick while the previous pass is still running (M4)', async () => {
    const fake = fakeManager();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const reconnectFn = vi.fn(async () => {
      await gate;
    });

    const lifecycle = new McpLifecycleManager(fake as unknown as McpServerManager);
    lifecycle.registerServer('k', def);
    lifecycle.markSupervised('k', def);
    lifecycle.setReconnectFn(reconnectFn);
    lifecycle.startHealthChecks(1000);

    await vi.advanceTimersByTimeAsync(1000); // tick 1: starts, blocks on gate
    await vi.advanceTimersByTimeAsync(1000); // tick 2: guarded out while tick 1 in flight
    expect(reconnectFn).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(0); // let the in-flight pass settle, clearing the guard
    await vi.advanceTimersByTimeAsync(1000); // tick 3: runs again
    expect(reconnectFn).toHaveBeenCalledTimes(2);
  });

  it('pings a connected supervised server and leaves it alone when it answers', async () => {
    const fake = fakeManager();
    fake.connections.set('k', { status: 'connected', inFlight: 0 });
    const reconnectFn = vi.fn(async () => {});
    const lifecycle = new McpLifecycleManager(fake as unknown as McpServerManager);
    lifecycle.registerServer('k', def);
    lifecycle.markSupervised('k', def);
    lifecycle.setReconnectFn(reconnectFn);
    lifecycle.startHealthChecks(1000);

    await vi.advanceTimersByTimeAsync(1000);

    expect(fake.answersPing).toHaveBeenCalledWith('k');
    expect(fake.close).not.toHaveBeenCalled();
    expect(reconnectFn).not.toHaveBeenCalled();
  });

  it('sends no ping to a supervised server with a call in flight, and leaves it connected', async () => {
    const fake = fakeManager();
    fake.connections.set('k', { status: 'connected', inFlight: 1 });
    fake.answersPing.mockResolvedValue(false);
    const reconnectFn = vi.fn(async () => {});
    const lifecycle = new McpLifecycleManager(fake as unknown as McpServerManager);
    lifecycle.registerServer('k', def);
    lifecycle.markSupervised('k', def);
    lifecycle.setReconnectFn(reconnectFn);
    lifecycle.startHealthChecks(1000);

    await vi.advanceTimersByTimeAsync(1000);

    expect(fake.answersPing).not.toHaveBeenCalled();
    expect(fake.close).not.toHaveBeenCalled();
    expect(reconnectFn).not.toHaveBeenCalled();
  });

  it('closes and reconnects a connected supervised server that stopped answering ping', async () => {
    const fake = fakeManager();
    fake.connections.set('k', { status: 'connected', inFlight: 0 });
    fake.answersPing.mockResolvedValueOnce(false);
    const reconnectFn = vi.fn(async () => {});
    const lifecycle = new McpLifecycleManager(fake as unknown as McpServerManager);
    lifecycle.registerServer('k', def);
    lifecycle.markSupervised('k', def);
    lifecycle.setReconnectFn(reconnectFn);
    lifecycle.startHealthChecks(1000);

    await vi.advanceTimersByTimeAsync(1000);

    expect(fake.close).toHaveBeenCalledWith('k');
    expect(reconnectFn).toHaveBeenCalledWith('k', def);
  });

  it('logs a failed health-check reconnect over HTTP by its status, never the response body', async () => {
    const lines: string[] = [];
    installLogSink({ appendLine: (line) => lines.push(line), show: () => {}, dispose: () => {} });
    const fake = fakeManager();
    const lifecycle = new McpLifecycleManager(fake as unknown as McpServerManager);
    lifecycle.registerServer('k', def);
    lifecycle.markSupervised('k', def);
    lifecycle.setReconnectFn(async () => {
      throw new McpServerConnectError('MCP HTTP request failed with status 503: secret=BODY-SECRET', { logText: 'McpHttpError: HTTP status 503' });
    });
    lifecycle.startHealthChecks(1000);

    await vi.advanceTimersByTimeAsync(1000);

    expect(lines.some((line) => line.includes('failed to reconnect to k: McpHttpError: HTTP status 503'))).toBe(true);
    expect(lines.join('\n')).not.toContain('BODY-SECRET');
  });

  it('logs a failed health-check reconnect by message only, never the stderr tail', async () => {
    const lines: string[] = [];
    installLogSink({ appendLine: (line) => lines.push(line), show: () => {}, dispose: () => {} });
    const fake = fakeManager();
    const lifecycle = new McpLifecycleManager(fake as unknown as McpServerManager);
    lifecycle.registerServer('k', def);
    lifecycle.markSupervised('k', def);
    lifecycle.setReconnectFn(async () => {
      throw new McpServerConnectError('k exited with code 1', { stderrTail: 'password=SECRET-TAIL' });
    });
    lifecycle.startHealthChecks(1000);

    await vi.advanceTimersByTimeAsync(1000);

    expect(lines.some((line) => line.includes('k exited with code 1'))).toBe(true);
    expect(lines.join('\n')).not.toContain('SECRET-TAIL');
  });

  it('clears the health timer on graceful shutdown', async () => {
    const fake = fakeManager();
    const lifecycle = new McpLifecycleManager(fake as unknown as McpServerManager);
    lifecycle.markSupervised('k', def);
    lifecycle.setReconnectFn(vi.fn(async () => {}));
    lifecycle.startHealthChecks(1000);

    await lifecycle.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.connect).not.toHaveBeenCalled();
  });
});
