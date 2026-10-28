// Connection quality, VS Code's measurer (remoteAgentService.ts, MIT): docs/invariants.md "Remote daemon and wire", latency.
import type { Disposable } from '../../../platform/disposable';
import type { HostLatency } from '../../../shared/host-connection';

export type { HostLatency } from '../../../shared/host-connection';

export const PINGS = 5;
export const PING_GAP_MS = 2000;
export const FIRST_MEASUREMENT_MS = 10_000;
export const MEASUREMENT_INTERVAL_MS = 60_000;
// VS Code's highLatencyMaxThreshold, highLatencyMinThreshold and highLatencyMultiple
export const HIGH_LATENCY_MAX_MS = 1500;
export const HIGH_LATENCY_MIN_MS = 500;
export const HIGH_LATENCY_MULTIPLE = 2;
export const BASELINE_MEASUREMENTS = 3;
export const HISTORY_LENGTH = 10;

/** One measurement's latency: the smallest round trip, halved. */
export function measuredLatency(roundTrips: readonly number[]): number {
  return Math.min(...roundTrips) / 2;
}

/** Slow: above the maximum, or above the minimum and more than the multiple of the baseline (the first measurements' mean). */
export function isSlow(latencyMs: number, baselineMs: number): boolean {
  return latencyMs > HIGH_LATENCY_MAX_MS || (latencyMs > HIGH_LATENCY_MIN_MS && latencyMs > HIGH_LATENCY_MULTIPLE * baselineMs);
}

export interface LatencyMeterDeps {
  // control.ping on the authority's usable connection; rejects once it is gone
  readonly ping: (authorityKey: string) => Promise<void>;
  readonly changed: (authorityKey: string) => void;
  readonly log: (line: string) => void;
  // a monotonic clock in ms
  readonly now?: () => number;
}

// What the meter reads of a connection; RemoteConnection matches it.
export interface MeasuredConnection {
  onClose(listener: (reason: string) => void): Disposable;
}

interface Host {
  // the measurements run over this connection; undefined while the authority has none usable
  connection: MeasuredConnection | undefined;
  closed?: Disposable | undefined;
  dueAt: number;
  timer?: NodeJS.Timeout | undefined;
  measuring: boolean;
  readonly history: number[];
  readonly baseline: number[];
  measurements: number;
  latest?: HostLatency;
}

export class LatencyMeter {
  private readonly deps: LatencyMeterDeps;
  private readonly hosts = new Map<string, Host>();
  private visible = new Set<string>();
  private disposed = false;

  constructor(deps: LatencyMeterDeps) {
    this.deps = deps;
  }

  latency(authorityKey: string): HostLatency | undefined {
    return this.hosts.get(authorityKey)?.latest;
  }

  /**
   * A usable connection that serves control.ping: its first measurement is due FIRST_MEASUREMENT_MS from now; its close stops
   * measuring.
   */
  connected(authorityKey: string, connection: MeasuredConnection): void {
    if (this.disposed) return;
    const host = this.hostOf(authorityKey);
    if (host.connection === connection) return;
    host.closed?.dispose();
    host.connection = connection;
    host.closed = connection.onClose(() => {
      if (host.connection === connection) this.disconnected(authorityKey);
    });
    host.dueAt = this.now() + FIRST_MEASUREMENT_MS;
    this.arm(authorityKey, host);
  }

  /** No usable connection: measuring stops, and what was measured stays. */
  disconnected(authorityKey: string): void {
    const host = this.hosts.get(authorityKey);
    if (!host) return;
    host.closed?.dispose();
    host.closed = undefined;
    host.connection = undefined;
    clearTimeout(host.timer);
    host.timer = undefined;
  }

  /** The authorities whose project a visible, non-minimized window shows; only they are measured. */
  setVisibleAuthorities(authorityKeys: readonly string[]): void {
    this.visible = new Set(authorityKeys);
    for (const [key, host] of this.hosts) this.arm(key, host);
  }

  dispose(): void {
    this.disposed = true;
    for (const host of this.hosts.values()) {
      clearTimeout(host.timer);
      host.closed?.dispose();
    }
    this.hosts.clear();
  }

  private now(): number {
    return (this.deps.now ?? (() => performance.now()))();
  }

  private hostOf(authorityKey: string): Host {
    let host = this.hosts.get(authorityKey);
    if (!host) {
      host = { connection: undefined, dueAt: 0, measuring: false, history: [], baseline: [], measurements: 0 };
      this.hosts.set(authorityKey, host);
    }
    return host;
  }

  private arm(authorityKey: string, host: Host): void {
    clearTimeout(host.timer);
    host.timer = undefined;
    if (this.disposed || host.measuring || host.connection === undefined || !this.visible.has(authorityKey)) return;
    host.timer = setTimeout(() => {
      host.timer = undefined;
      void this.measure(authorityKey, host);
    }, Math.max(0, host.dueAt - this.now()));
  }

  private async measure(authorityKey: string, host: Host): Promise<void> {
    const connection = host.connection;
    const live = (): boolean => !this.disposed && host.connection === connection && this.visible.has(authorityKey);
    if (!live()) return;
    host.measuring = true;
    const roundTrips: number[] = [];
    try {
      for (let ping = 0; ping < PINGS; ping++) {
        if (ping > 0) await new Promise((resolve) => setTimeout(resolve, PING_GAP_MS));
        // a hidden window or a lost connection ends the measurement unpublished
        if (!live()) return;
        const sent = this.now();
        await this.deps.ping(authorityKey);
        roundTrips.push(this.now() - sent);
      }
    } catch (err) {
      this.deps.log(`[remote] measuring the latency to ${authorityKey} stopped: ${err instanceof Error ? err.message : String(err)}`);
      return;
    } finally {
      host.measuring = false;
      host.dueAt = this.now() + MEASUREMENT_INTERVAL_MS;
      if (host.connection === connection) this.arm(authorityKey, host);
    }
    // hidden or gone during the last ping
    if (!live()) return;
    const latencyMs = Math.round(measuredLatency(roundTrips));
    if (host.baseline.length < BASELINE_MEASUREMENTS) host.baseline.push(latencyMs);
    host.history.push(latencyMs);
    if (host.history.length > HISTORY_LENGTH) host.history.shift();
    const baselineMs = host.baseline.reduce((sum, value) => sum + value, 0) / host.baseline.length;
    host.measurements++;
    host.latest = { latencyMs, slow: isSlow(latencyMs, baselineMs), history: [...host.history], measurements: host.measurements };
    this.deps.changed(authorityKey);
  }
}
