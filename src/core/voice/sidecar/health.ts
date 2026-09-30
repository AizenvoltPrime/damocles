export type HealthEvent = "healthy" | "unhealthy";

export type HealthMonitorOptions = {
  intervalMs?: number;
  missedThreshold?: number;
  sendPing: (nonce: number) => void;
  onEvent: (event: HealthEvent) => void;
};

export class HealthMonitor {
  private readonly intervalMs: number;
  private readonly missedThreshold: number;
  private readonly sendPing: (nonce: number) => void;
  private readonly onEvent: (event: HealthEvent) => void;
  private timer: NodeJS.Timeout | null = null;
  private nonce = 0;
  private outstanding = new Set<number>();
  private state: HealthEvent = "healthy";

  constructor(opts: HealthMonitorOptions) {
    this.intervalMs = opts.intervalMs ?? 2000;
    this.missedThreshold = opts.missedThreshold ?? 3;
    this.sendPing = opts.sendPing;
    this.onEvent = opts.onEvent;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.outstanding.clear();
  }

  recordPong(nonce: number): void {
    this.outstanding.delete(nonce);
    // Only return to "healthy" once every outstanding ping has been
    // acknowledged. The previous flip on first pong could fire while
    // older nonces (from before the unhealthy flip) were still in
    // flight; if those never came back the manager would already
    // have started restarting on the strength of one stray pong.
    if (this.state === "unhealthy" && this.outstanding.size === 0) {
      this.state = "healthy";
      this.onEvent("healthy");
    }
  }

  private tick(): void {
    if (this.outstanding.size >= this.missedThreshold) {
      if (this.state === "healthy") {
        this.state = "unhealthy";
        this.onEvent("unhealthy");
      }
      return;
    }
    this.nonce += 1;
    this.outstanding.add(this.nonce);
    this.sendPing(this.nonce);
  }
}
