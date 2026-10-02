/*
 * Adapted from pi-mcp-adapter (MIT). Copyright (c) 2026 Nico Bailon. See THIRD-PARTY-NOTICES.md.
 * Periodic health checks: ping supervised servers and reconnect them when down (persistent — they
 * stay connected and self-heal), idle-shutdown the rest (lazy / explicit-idleTimeout — connect-on-use).
 */
import type { McpServerSpec } from './types';
import type { McpServerManager } from './server-manager';
import { failureForLog } from './connect-failure';
import { log } from '../../logger';

export class McpLifecycleManager {
  private readonly manager: McpServerManager;
  /** Servers meant to stay connected: the health check reconnects them when down and never idle-shuts
   *  them down. Covers default/eager + keep-alive (anything not lazy / explicit-idleTimeout). */
  private supervisedServers = new Map<string, McpServerSpec>();
  private allServers = new Map<string, McpServerSpec>();
  private serverSettings = new Map<string, { idleTimeout?: number }>();
  private globalIdleTimeout = 10 * 60 * 1000;
  private healthCheckInterval: NodeJS.Timeout | undefined;
  private checkInFlight = false;
  private onIdleShutdown?: (serverName: string) => void;
  private reconnectFn?: (name: string, spec: McpServerSpec) => Promise<void>;

  constructor(manager: McpServerManager) {
    this.manager = manager;
  }

  /** Inject the orchestrator's reconnect (applies failure backoff + cache + descriptor rebuild). */
  setReconnectFn(fn: (name: string, spec: McpServerSpec) => Promise<void>): void {
    this.reconnectFn = fn;
  }

  setIdleShutdownCallback(callback: (serverName: string) => void): void {
    this.onIdleShutdown = callback;
  }

  /** Mark a server as supervised: kept connected (auto-reconnect when down) and never idle-shut-down. */
  markSupervised(name: string, spec: McpServerSpec): void {
    this.supervisedServers.set(name, spec);
  }

  registerServer(name: string, spec: McpServerSpec, settings?: { idleTimeout?: number }): void {
    this.allServers.set(name, spec);
    if (settings?.idleTimeout !== undefined) {
      this.serverSettings.set(name, settings);
    }
  }

  clearServers(): void {
    this.allServers.clear();
    this.supervisedServers.clear();
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
    for (const [name, spec] of this.supervisedServers) {
      const connection = this.manager.getConnection(name);
      if (connection && connection.status === 'connected') {
        // A server busy with a call may not answer until it ends, and closing it would kill that call.
        if (connection.inFlight > 0) continue;
        if (await this.manager.answersPing(name)) continue;
        await this.manager.close(name);
      }
      if (!this.reconnectFn) continue;
      try {
        await this.reconnectFn(name, spec);
      } catch (error) {
        log('[McpLifecycle] failed to reconnect to %s: %s', name, failureForLog(error));
      }
    }

    for (const [name] of this.allServers) {
      if (this.supervisedServers.has(name)) continue;
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
