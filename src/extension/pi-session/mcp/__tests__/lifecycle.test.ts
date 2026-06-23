import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpLifecycleManager } from '../lifecycle';
import type { McpServerManager, ServerConnection } from '../server-manager';
import type { McpServerDefinition } from '../types';

function fakeManager() {
  const connections = new Map<string, { status: ServerConnection['status'] }>();
  return {
    connections,
    getConnection: (n: string) => connections.get(n),
    connect: vi.fn(async (n: string) => {
      const c = { status: 'connected' as const };
      connections.set(n, c);
      return c;
    }),
    isIdle: vi.fn(() => false),
    close: vi.fn(async (n: string) => {
      connections.delete(n);
    }),
    closeAll: vi.fn(async () => connections.clear()),
  };
}

const def: McpServerDefinition = { command: 'x' };

describe('McpLifecycleManager', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('idle-shuts-down an unsupervised (lazy / explicit-idleTimeout) server that reports idle', async () => {
    const fake = fakeManager();
    fake.connections.set('s', { status: 'connected' });
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
    fake.connections.set('k', { status: 'connected' });
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
    fake.connections.set('s', { status: 'connected' });
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
