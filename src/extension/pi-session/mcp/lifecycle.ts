/*
 * Adapted from pi-mcp-adapter (MIT). Copyright (c) 2026 Nico Bailon. See THIRD-PARTY-NOTICES.md.
 * Periodic health checks: reconnect keep-alive servers, idle-shutdown non-keep-alive servers.
 */
import type { McpServerDefinition } from './types';
import type { McpServerManager } from './server-manager';
import { log } from '../../logger';

export class McpLifecycleManager {
  private readonly manager: McpServerManager;
  private keepAliveServers = new Map<string, McpServerDefinition>();
  private allServers = new Map<string, McpServerDefinition>();
  private serverSettings = new Map<string, { idleTimeout?: number }>();
  private globalIdleTimeout = 10 * 60 * 1000;
  private healthCheckInterval: NodeJS.Timeout | undefined;
  private checkInFlight = false;
  private onIdleShutdown?: (serverName: string) => void;
  private reconnectFn?: (name: string, definition: McpServerDefinition) => Promise<void>;

  constructor(manager: McpServerManager) {
    this.manager = manager;
  }

  /** Inject the orchestrator's reconnect (applies failure backoff + cache + descriptor rebuild). */
  setReconnectFn(fn: (name: string, definition: McpServerDefinition) => Promise<void>): void {
    this.reconnectFn = fn;
  }

  setIdleShutdownCallback(callback: (serverName: string) => void): void {
    this.onIdleShutdown = callback;
  }

  markKeepAlive(name: string, definition: McpServerDefinition): void {
    this.keepAliveServers.set(name, definition);
  }

  registerServer(name: string, definition: McpServerDefinition, settings?: { idleTimeout?: number }): void {
    this.allServers.set(name, definition);
    if (settings?.idleTimeout !== undefined) {
      this.serverSettings.set(name, settings);
    }
  }

  clearServers(): void {
    this.allServers.clear();
    this.keepAliveServers.clear();
    this.serverSettings.clear();
  }

  setGlobalIdleTimeout(minutes: number): void {
    this.globalIdleTimeout = minutes * 60 * 1000;
  }

  startHealthChecks(intervalMs = 30000): void {
    if (this.healthCheckInterval) return;
    this.healthCheckInterval = setInterval(() => {
      void this.checkConnections();
    }, intervalMs);
    this.healthCheckInterval.unref();
  }

  private async checkConnections(): Promise<void> {
    // Skip this tick if the previous pass is still running: a slow connect can outlast the interval,
    // and a second concurrent pass would fire duplicate reconnects (M4).
    if (this.checkInFlight) return;
    this.checkInFlight = true;
    try {
      await this.runConnectionChecks();
    } finally {
      this.checkInFlight = false;
    }
  }

  private async runConnectionChecks(): Promise<void> {
    for (const [name, definition] of this.keepAliveServers) {
      const connection = this.manager.getConnection(name);
      if (connection && connection.status === 'connected') continue;
      if (!this.reconnectFn) continue;
      try {
        await this.reconnectFn(name, definition);
      } catch (error) {
        log('[McpLifecycle] failed to reconnect to %s: %O', name, error);
      }
    }

    for (const [name] of this.allServers) {
      if (this.keepAliveServers.has(name)) continue;
      const timeout = this.getIdleTimeout(name);
      if (timeout > 0 && this.manager.isIdle(name, timeout)) {
        await this.manager.close(name);
        this.onIdleShutdown?.(name);
      }
    }
  }

  private getIdleTimeout(name: string): number {
    const perServer = this.serverSettings.get(name)?.idleTimeout;
    if (perServer !== undefined) return perServer * 60 * 1000;
    return this.globalIdleTimeout;
  }

  async gracefulShutdown(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
    await this.manager.closeAll();
  }
}
