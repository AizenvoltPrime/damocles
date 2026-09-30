import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HealthMonitor } from "../health";

describe("HealthMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires unhealthy after 3 consecutive missed pongs", () => {
    const events: string[] = [];
    const sentNonces: number[] = [];
    const monitor = new HealthMonitor({
      intervalMs: 100,
      missedThreshold: 3,
      sendPing: (nonce) => sentNonces.push(nonce),
      onEvent: (ev) => events.push(ev),
    });
    monitor.start();
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);
    expect(sentNonces.length).toBeGreaterThanOrEqual(3);
    expect(events).toContain("unhealthy");
    monitor.stop();
  });

  it("does not flip healthy on first stray pong while others outstanding", () => {
    const events: string[] = [];
    const sentNonces: number[] = [];
    const monitor = new HealthMonitor({
      intervalMs: 100,
      missedThreshold: 3,
      sendPing: (nonce) => sentNonces.push(nonce),
      onEvent: (ev) => events.push(ev),
    });
    monitor.start();
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);
    expect(events).toContain("unhealthy");
    // Only one of the outstanding pongs comes back. The previous
    // behavior flipped healthy here on the strength of one stray
    // pong even though earlier nonces were still missing.
    monitor.recordPong(sentNonces[0]!);
    expect(events[events.length - 1]).toBe("unhealthy");
    monitor.stop();
  });

  it("recovers to healthy only when every outstanding pong acks", () => {
    const events: string[] = [];
    const sentNonces: number[] = [];
    const monitor = new HealthMonitor({
      intervalMs: 100,
      missedThreshold: 3,
      sendPing: (nonce) => sentNonces.push(nonce),
      onEvent: (ev) => events.push(ev),
    });
    monitor.start();
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);
    expect(events).toContain("unhealthy");
    for (const nonce of sentNonces) {
      monitor.recordPong(nonce);
    }
    expect(events[events.length - 1]).toBe("healthy");
    monitor.stop();
  });
});
